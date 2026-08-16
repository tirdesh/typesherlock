# typesherlock

[![CI](https://github.com/tirdesh/typesherlock/actions/workflows/ci.yml/badge.svg)](https://github.com/tirdesh/typesherlock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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

For APIs with no OpenAPI/Swagger spec — internal services, partner APIs,
scraped/reverse-engineered endpoints, or anything mid-development —
`typesherlock` replaces hand-writing an interface from a JSON blob with one
piped command.

## Install

> **Not yet published to npm.** Until then: clone this repo, run
> `npm install && npm run build`, then use `node dist/cli.js` in place of
> `typesherlock` below (or `npm link` for the real command locally).

```bash
npm install -g typesherlock
# or, without installing:
curl -s <api> | npx typesherlock
```

## Usage

```
curl <api> | typesherlock [options]
cat response.json | typesherlock [options]

Options:
  --name <Name>    Name for the root type (default: Root)
  --zod            Also emit a Zod schema alongside the TS interface
  -o, --out <file> Write output to a file instead of stdout
  --cache <file>   Merge with (and update) a saved type from previous runs
  -h, --help       Show this help
```

### Multiple samples (success + error shapes)

Pipe a JSON array where every element is an object to merge them into one
type — fields missing from some samples become optional, fields with
different types across samples become a union:

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

(A bare array of non-objects, e.g. `[1, 2, 3]`, is treated as one array-typed
sample, not multiple samples.)

### `fetch` subcommand — gather real samples in one command

```bash
typesherlock fetch "https://api.example.com/users/{}" 1 2 999 --name User --zod
# or full URLs:
typesherlock fetch https://api.example.com/a https://api.example.com/b --name X
# with an auth header:
typesherlock fetch https://api.example.com/users/1 --header "Authorization: Bearer $TOKEN"
```

Uses Node's built-in `fetch` — no `curl` dependency. This is the only part
of typesherlock that makes network calls; the default stdin mode never does.
Run `typesherlock fetch --help` for the full option list.

### `--cache` — accumulate evidence across separate runs

```bash
typesherlock fetch https://api.example.com/users/1 --name User --cache .ts-cache.json
typesherlock fetch https://api.example.com/users/2 --name User --cache .ts-cache.json
# second run's output reflects both calls combined
```

Saves the inferred type to a local file and merges it with each new run, so
accuracy improves across ordinary everyday use without manually assembling a
sample array. Works with stdin mode too.

## What it detects

No AI, no API key, ever — everything below is deterministic regex/structural/
statistical inference:

- nested object shapes (hoisted into named interfaces), array element types
- optional fields, and unions for fields whose type varies across samples
- string formats via regex: ISO 8601 date-times, UUIDs, emails, URLs — tagged
  with a doc comment and the matching Zod validator
- closed-set string fields via statistics (2+ distinct values across
  _separate_ samples) → TS string literal union / `z.enum([...])`
- recursive structures (e.g. nested `replies`) → self-referential type
  (`replies: Comment[]`, `z.lazy(() => CommentSchema)` in Zod)
- integers beyond `Number.MAX_SAFE_INTEGER` flagged with a warning comment
  instead of silently mistyped

## Development

```bash
npm install
npm run build   # compile src/ -> dist/
npm test        # vitest
echo '{"id":1}' | npm run dev -- --name User   # run the CLI from source via tsx
```

`src/infer.ts` + `src/generate.ts` are the pure core (no I/O); `src/cli.ts` is
the stdin/stdout wrapper.

## Roadmap

- [ ] MCP tool exposing the same core engine to coding agents
- [ ] AI layer for genuinely ambiguous cases only (off by default)
- [ ] Drift detection / watch mode
- [ ] Editor integration

## License

MIT
