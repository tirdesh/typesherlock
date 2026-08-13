#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { inferFromSamples } from "./infer.js";
import { generateTypeScript, generateZodSchema } from "./generate.js";

interface CliOptions {
  rootName: string;
  outFile: string | null;
  zod: boolean;
  help: boolean;
}

class CliArgError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    rootName: "Root",
    outFile: null,
    zod: false,
    help: false,
  };
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

export async function run(argv: string[]): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
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

  const samples = toSamples(parsed);
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
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`typesherlock: wrote ${opts.outFile}\n`);
  } else {
    process.stdout.write(output);
  }
}

run(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`typesherlock: unexpected error: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
