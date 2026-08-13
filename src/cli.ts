#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { inferFromSamples } from "./infer.js";
import { generateTypeScript, generateZodSchema } from "./generate.js";

class CliArgError extends Error {}

interface OutputOptions {
  rootName: string;
  outFile: string | null;
  zod: boolean;
}

/** Render samples into TS (+ optional Zod) and write to stdout or a file. Shared
 * by both the stdin path and the `fetch` subcommand. */
function emitTypes(samples: unknown[], opts: OutputOptions): number {
  const inferred = inferFromSamples(samples);
  const { typescript: tsOut } = generateTypeScript(inferred, { rootName: opts.rootName });
  const parts = [tsOut.trimEnd()];

  if (opts.zod) {
    const { typescript: zodOut } = generateZodSchema(inferred, { rootName: opts.rootName });
    parts.push(zodOut.trimEnd());
  }

  const output = parts.join("\n\n") + "\n";

  if (opts.outFile) {
    try {
      writeFileSync(opts.outFile, output, "utf8");
    } catch (err) {
      process.stderr.write(
        `typesherlock: couldn't write to ${opts.outFile} (${(err as Error).message})\n`
      );
      return 1;
    }
    process.stderr.write(`typesherlock: wrote ${opts.outFile}\n`);
  } else {
    process.stdout.write(output);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Default mode: read one JSON payload (or array of samples) from stdin.
// ---------------------------------------------------------------------------

interface StdinOptions extends OutputOptions {
  help: boolean;
}

function parseStdinArgs(argv: string[]): StdinOptions {
  const opts: StdinOptions = { rootName: "Root", outFile: null, zod: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--name") {
      if (i + 1 >= argv.length) throw new CliArgError(`${arg} requires a value`);
      opts.rootName = argv[++i];
    } else if (arg === "-o" || arg === "--out") {
      if (i + 1 >= argv.length) throw new CliArgError(`${arg} requires a value`);
      opts.outFile = argv[++i];
    } else if (arg === "--zod") {
      opts.zod = true;
    } else {
      throw new CliArgError(`unrecognized option '${arg}' (see --help)`);
    }
  }
  return opts;
}

const HELP = `typesherlock — pipe a JSON API response in, get TypeScript out.

Usage:
  curl <api> | typesherlock [options]
  cat response.json | typesherlock [options]
  typesherlock fetch <url> [url...] [options]   (see: typesherlock fetch --help)

Options:
  --name <Name>   Name for the root type (default: Root)
  --zod           Also emit a Zod schema alongside the TS interface
  -o, --out <file> Write output to a file instead of stdout
  -h, --help      Show this help

Multiple samples:
  Pipe a JSON array of sample responses (e.g. [successResponse, errorResponse])
  to merge them into one type with optional fields where they differ.
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toSamples(parsed: unknown): unknown[] {
  // A bare JSON array is ambiguous: it could be *the* payload (e.g. a list
  // of users) or a set of samples to merge. Only treat it as "multiple
  // samples" when every element is itself an object — the common case for
  // hand-assembled sample sets — otherwise treat the array as one sample.
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((el) => typeof el === "object" && el !== null && !Array.isArray(el))
  ) {
    return parsed;
  }
  return [parsed];
}

async function runStdin(argv: string[]): Promise<void> {
  let opts: StdinOptions;
  try {
    opts = parseStdinArgs(argv);
  } catch (err) {
    if (err instanceof CliArgError) {
      process.stderr.write(`typesherlock: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write("typesherlock: no input on stdin. Try: curl <api> | typesherlock\n");
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`typesherlock: input is not valid JSON (${(err as Error).message})\n`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = emitTypes(toSamples(parsed), opts);
}

// ---------------------------------------------------------------------------
// `fetch` subcommand: gather real samples from live URLs, no separate script
// or curl dependency required — uses Node's built-in fetch.
// ---------------------------------------------------------------------------

interface FetchOptions extends OutputOptions {
  help: boolean;
  urls: string[];
  headers: string[];
}

const FETCH_HELP = `typesherlock fetch — call one or more URLs and generate types from the responses.

Usage:
  typesherlock fetch <url> [url...] [options]
  typesherlock fetch "<template-with-{}>" <value> [value...] [options]

Examples:
  typesherlock fetch https://api.example.com/users/1 https://api.example.com/users/2 --name User
  typesherlock fetch "https://api.example.com/users/{}" 1 2 999 --name User --zod

Options:
  --name <Name>     Name for the root type (default: Root)
  --zod             Also emit a Zod schema alongside the TS interface
  -o, --out <file>  Write output to a file instead of stdout
  --header <H>      Extra request header, e.g. --header "Authorization: Bearer xyz"
                     (repeatable)
  -h, --help        Show this help

Every fetched response is treated as a separate sample and merged, exactly
like piping a JSON array of samples into the default stdin mode.
`;

function parseFetchArgs(argv: string[]): FetchOptions {
  const opts: FetchOptions = {
    rootName: "Root",
    outFile: null,
    zod: false,
    help: false,
    urls: [],
    headers: [],
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--name") {
      if (i + 1 >= argv.length) throw new CliArgError(`${arg} requires a value`);
      opts.rootName = argv[++i];
    } else if (arg === "-o" || arg === "--out") {
      if (i + 1 >= argv.length) throw new CliArgError(`${arg} requires a value`);
      opts.outFile = argv[++i];
    } else if (arg === "--zod") {
      opts.zod = true;
    } else if (arg === "--header") {
      if (i + 1 >= argv.length) throw new CliArgError(`${arg} requires a value`);
      opts.headers.push(argv[++i]);
    } else if (arg.startsWith("-")) {
      throw new CliArgError(`unrecognized option '${arg}' (see fetch --help)`);
    } else {
      positionals.push(arg);
    }
  }

  if (!opts.help) {
    if (positionals.length === 0) {
      throw new CliArgError("fetch requires at least one URL (see fetch --help)");
    }
    if (positionals[0].includes("{}")) {
      const [template, ...values] = positionals;
      if (values.length === 0) {
        throw new CliArgError("template given but no values to substitute into it");
      }
      opts.urls = values.map((v) => template.split("{}").join(v));
    } else {
      opts.urls = positionals;
    }
  }
  return opts;
}

function parseHeader(raw: string): [string, string] {
  const idx = raw.indexOf(":");
  if (idx === -1) {
    throw new CliArgError(`--header value must look like "Key: Value", got '${raw}'`);
  }
  return [raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()];
}

async function fetchSamples(urls: string[], rawHeaders: string[]): Promise<unknown[]> {
  const headers = Object.fromEntries(rawHeaders.map(parseHeader));
  const samples: unknown[] = [];
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      throw new CliArgError(`couldn't reach ${url} (${(err as Error).message})`);
    }
    if (!res.ok) {
      throw new CliArgError(`${url} returned HTTP ${res.status}`);
    }
    try {
      samples.push(await res.json());
    } catch {
      throw new CliArgError(`${url} did not return valid JSON`);
    }
  }
  return samples;
}

async function runFetch(argv: string[]): Promise<void> {
  let opts: FetchOptions;
  try {
    opts = parseFetchArgs(argv);
  } catch (err) {
    if (err instanceof CliArgError) {
      process.stderr.write(`typesherlock fetch: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (opts.help) {
    process.stdout.write(FETCH_HELP);
    return;
  }

  let samples: unknown[];
  try {
    samples = await fetchSamples(opts.urls, opts.headers);
  } catch (err) {
    if (err instanceof CliArgError) {
      process.stderr.write(`typesherlock fetch: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  process.exitCode = emitTypes(samples, opts);
}

// ---------------------------------------------------------------------------

export async function run(argv: string[]): Promise<void> {
  if (argv[0] === "fetch") {
    await runFetch(argv.slice(1));
  } else {
    await runStdin(argv);
  }
}

run(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`typesherlock: unexpected error: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
