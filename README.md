# typesherlock

Pipe a JSON API response in, get a TypeScript interface (and optionally a Zod
schema) out.

```bash
curl -s https://api.github.com/repos/vercel/next.js | typesherlock --name Repo
```

```ts
export interface Repo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: RepoOwner;
  // ... every field, correctly typed, in one command
}
```

## Why

If an API has an OpenAPI/Swagger spec, you don't need this — use a proper
codegen tool against the spec. This tool is for the much more common
situation where there **isn't** one: an internal service, a partner API you
don't control, a scraped or reverse-engineered endpoint, or something still
mid-development. In that situation people either hand-write the interface by
eyeballing a JSON blob (slow, and easy to miss a field that's only present in
error responses) or paste it into a chat tool and reformat the answer.
`typesherlock` turns that into one piped command with deterministic output.

## Install

```bash
npm install -g typesherlock
```

Or run it without installing:

```bash
curl -s <api> | npx typesherlock
```

## Usage

```bash
Usage:
  curl <api> | typesherlock [options]
  cat response.json | typesherlock [options]

Options:
  --name <Name>    Name for the root type (default: Root)
  --zod            Also emit a Zod schema alongside the TS interface
  -o, --out <file> Write output to a file instead of stdout
  -h, --help       Show this help
```

### Multiple samples (success + error shapes)

If you pipe in a JSON array where every element is an object, `typesherlock`
treats each element as a separate sample response and merges them into one
type — fields that don't appear in every sample become optional, and fields
with different types across samples become a union:

```bash
echo '[{"ok":true,"data":{"id":1}},{"ok":false,"error":"not found"}]' \
  | typesherlock --name ApiResponse
```

```ts
export interface ApiResponse {
  ok: boolean;
  data?: ApiResponseData;
  error?: string;
}

export interface ApiResponseData {
  id: number;
}
```

This is the practical way to get an accurate type for an endpoint that
returns different shapes depending on outcome: call it once for success, once
for a known error case, wrap both in a `[ ... ]` array, and pipe that in.

(A bare JSON array of non-object values, e.g. `[1, 2, 3]`, is treated as a
single array-typed sample, not as multiple samples — only arrays of objects
are treated as sample sets, since that's the unambiguous case.)

#### Gathering multiple real samples in one command

Building that `[sample1, sample2]` array by hand from separate `curl` calls
is tedious. `multi-fetch.sh`, bundled with this package, does the fetching
for you and prints the combined array on stdout — it's a thin wrapper around
the real system `curl` (one call per URL), not a new HTTP client:

If only one part of the URL varies (e.g. an ID), pass a template with a `{}`
placeholder and the values to substitute — no need to retype the base URL:

```bash
npx typesherlock-multi-fetch "https://api.example.com/users/{}" 1 2 999 \
  | typesherlock --name User --zod
```

Or spell out full, unrelated URLs if they don't share a common pattern:

```bash
npx typesherlock-multi-fetch \
  https://api.example.com/users/1 \
  https://api.example.com/other-endpoint \
  | typesherlock --name User --zod
```

Either way, this is the same result as calling `curl` for each one and
hand-assembling the array — just one command instead of several. Extra
`curl` flags (e.g. an auth header) can be passed via the `CURL_ARGS`
environment variable:

```bash
CURL_ARGS='-H "Authorization: Bearer $TOKEN"' \
  npx typesherlock-multi-fetch https://api.example.com/users/1 https://api.example.com/users/999
```

Note this is a convenience script, not part of the core tool: `typesherlock`
itself still makes zero network calls and only ever reads stdin — the
network access here is isolated to this one opt-in script, which just does
what you'd otherwise type by hand.

## What it does (and doesn't) do

Everything is **deterministic structural + regex/statistical inference** —
no AI, no network calls beyond reading stdin, no API key required, ever.
Given one or more JSON samples it deduces:

- nested object shapes, hoisted into their own named interfaces
- array element types
- fields that are optional (present in some samples, not others)
- fields whose type varies across samples (rendered as a union)
- **string formats**, via regex: ISO 8601 date-times, UUIDs, emails, and URLs
  are tagged with a doc comment on the TS field and the matching Zod
  validator (`z.string().datetime()` / `.uuid()` / `.email()` / `.url()`)
- **closed-set string fields**, via statistics: a field with 2+ distinct
  values seen across genuinely *separate* samples (e.g. `status: "active"`
  in one call, `"pending"` in another) is rendered as a string literal union
  in TS and `z.enum([...])` in Zod

Enum detection is deliberately scoped to cross-sample evidence only — values
repeated *within one array in a single response* (e.g. `tags: ["admin",
"beta"]`) are not treated as enum evidence, since that's the array's actual
data, not a hint about the field's whole value space. Verified against real
API responses: PokeAPI's repeated ability names correctly stay free text,
while the Rick and Morty API's `status` field correctly becomes
`z.enum(["Alive", "unknown", "Dead"])` once given three separate samples.

None of this needs an AI model — date/UUID/email/URL formats are fixed,
well-known patterns, and "does this field take only a few distinct values"
is a counting problem, not a judgment call. An AI layer remains on the
roadmap only for the genuinely ambiguous cases regex/stats can't resolve
(e.g. is `"id": "12345"` meant to be opaque, or a stringified number?).

## Architecture

```
src/infer.ts     Pure structural inference: JSON value(s) -> InferredType tree
src/generate.ts  Renders an InferredType tree into TS interfaces / Zod schemas
src/cli.ts       stdin/stdout wrapper: argument parsing, I/O, error handling
src/index.ts     Library entry point (inferFromSamples, generateTypeScript, generateZodSchema)
```

The core (`infer.ts` + `generate.ts`) has no I/O and no dependencies beyond
`zod`'s types for codegen output — it's a pure function you can also import
directly:

```ts
import { inferFromSamples, generateTypeScript } from "typesherlock";

const type = inferFromSamples([{ id: 1, name: "Ada" }]);
const { typescript } = generateTypeScript(type, { rootName: "User" });
```

This separation matters for where the project is headed next (see Roadmap):
the same core engine is meant to be reusable from a CLI, and from an agent
tool call, without duplicating logic.

## Roadmap

- [x] **Regex/statistical semantic layer.** Date/UUID/email/URL format
      detection and closed-set enum detection from cross-sample evidence —
      done, no AI involved (see above).
- [ ] **AI layer, for genuinely ambiguous cases only.** Not a default engine
      for semantic detection (regex/stats already cover the standard cases) —
      scoped narrowly to judgment calls those can't make, e.g. disambiguating
      intent behind a field's name/shape. Off by default; the deterministic
      core never requires an API key.
- [ ] **MCP tool.** Expose the same core engine as an MCP tool so coding
      agents (Claude Code, etc.) can call it directly instead of pasting raw
      JSON into their own context to reason out types inline — cheaper,
      faster, and deterministic across runs.
- [ ] **Drift detection / watch mode.** Point it at an endpoint on a
      schedule; open a PR when the inferred shape changes.
- [ ] **Editor integration.** Generate types inline from a REST client
      response (Thunder Client, `.http` files, etc).

## Development

```bash
npm install
npm run build   # compile src/ -> dist/
npm test        # vitest
echo '{"id":1}' | npm run dev -- --name User   # run the CLI from source via tsx
```

## License

MIT
