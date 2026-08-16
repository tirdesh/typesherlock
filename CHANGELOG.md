# Changelog

All notable changes to this project are documented in this file. Format based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

Initial release.

### Added

- Deterministic structural inference from one or more JSON samples: nested
  object shapes, array element types, optional fields, and unions for fields
  whose type varies across samples.
- Regex-based string format detection (ISO 8601 date-times, UUIDs, emails,
  URLs) rendered as doc comments and matching Zod validators.
- Statistical closed-set enum detection (2+ distinct values across separate
  samples) rendered as a TS string literal union and `z.enum([...])`.
- Recursive structure detection, rendered as a genuine self-referential type
  in both TS and Zod (`z.lazy(...)`).
- Integers beyond `Number.MAX_SAFE_INTEGER` flagged with a warning comment.
- CLI: stdin mode, `--name`, `--zod`, `-o/--out`, `--cache`.
- `fetch` subcommand: gather real samples directly by URL (with `{}`
  templating and `--header` support), using Node's built-in `fetch`.
- `--cache`: persist and merge the inferred type across separate invocations.
- MCP server (`typesherlock-mcp`) exposing a `generate_types` tool backed by
  the same core engine, for coding agents to call directly.
