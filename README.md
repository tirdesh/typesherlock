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

> **Not yet published to npm.** Until then, clone this repo and run
> `npm install && npm run build`, then use `node dist/cli.js` in place of
> `typesherlock` below (or `npm link` to install the `typesherlock` command
> locally). The instructions below will work as written once it's published.

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

There's also a `fetch` subcommand that calls URLs directly instead of reading
stdin — see [Gathering multiple real samples](#gathering-multiple-real-samples-in-one-command)
below.

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
is tedious. The `fetch` subcommand does the calling for you, in one command,
using Node's built-in `fetch` — no separate script, no `curl` dependency:

If only one part of the URL varies (e.g. an ID), pass a template with a `{}`
placeholder and the values to substitute — no need to retype the base URL:

```bash
typesherlock fetch "https://api.example.com/users/{}" 1 2 999 --name User --zod
```

Or spell out full, unrelated URLs if they don't share a common pattern:

```bash
typesherlock fetch \
  https://api.example.com/users/1 \
  https://api.example.com/other-endpoint \
  --name User --zod
```

Either way, this is the same result as calling `curl` for each one and
hand-assembling the array — just one command instead of several. Extra
request headers (e.g. an auth token) can be passed with `--header`, repeatable:

```bash
typesherlock fetch https://api.example.com/users/1 https://api.example.com/users/999 \
  --header "Authorization: Bearer $TOKEN" --name User
```

Every fetched response is merged as a separate sample, exactly like piping a
JSON array into the default stdin mode — including optional-field, union, and
enum detection from real evidence across the calls. Run `typesherlock fetch
--help` for the full option list. This subcommand is the only part of
typesherlock that makes network calls; the default stdin mode never does.

#### Accumulating evidence across separate runs with `--cache`

Multi-sample evidence doesn't have to come from one command. `--cache <file>`
saves the inferred type to a local file and merges it with each new run's
sample — so if you happen to call `typesherlock` (or `typesherlock fetch`)
against the same endpoint a few times over the course of normal use, accuracy
(optional fields, unions, enums) improves for free, without ever manually
assembling a sample array:

```bash
typesherlock fetch https://api.example.com/users/1 --name User --cache .typesherlock-cache.json
# ...later, a separate run against a different ID...
typesherlock fetch https://api.example.com/users/2 --name User --cache .typesherlock-cache.json
# the second run's output reflects everything seen in both calls combined
```

Works with the default stdin mode too. A missing or unreadable cache file is
treated as "nothing cached yet" (with a warning if it existed but was
corrupt) rather than an error — the cache is a bonus, not a requirement.

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
- **recursive structures** (e.g. a comment with nested `replies` of the same
  shape): detected even when your sample runs out of data a level or two
  deep, and rendered as a genuine self-referential type (`replies: Comment[]`
  in TS, `z.lazy(() => CommentSchema)` in Zod — recursive Zod schemas need
  `z.lazy()` since a `const` can't reference itself during its own init)
- **integers beyond `Number.MAX_SAFE_INTEGER`** are flagged with a warning
  comment rather than silently mistyped — `JSON.parse` itself already loses
  precision on these before any tool sees them, so the original exact value
  can't be recovered, but at least the risk is visible instead of silent

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
