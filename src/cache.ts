import { readFileSync, writeFileSync } from "node:fs";
import { isInferredType, type InferredType } from "./infer.js";

/**
 * The cache is stored in a tagged envelope rather than as a bare InferredType,
 * for two reasons that both come down to not destroying the user's data:
 *
 *   - `--cache` takes a path, and a path typo (`--cache` where `-o` was meant,
 *     or just the wrong filename) used to overwrite whatever was there — a
 *     source file, someone's `important.json` — with no warning at all. The
 *     tag lets us refuse to write over a file we didn't create.
 *   - a file that is valid JSON but not a valid type tree used to be merged in
 *     anyway, producing uncompilable output *and* being written back, so the
 *     cache stayed poisoned for every later run. Now it's rejected up front.
 */
const CACHE_TAG = "typesherlock-cache";
const CACHE_VERSION = 1;

interface CacheEnvelope {
  format: typeof CACHE_TAG;
  version: number;
  type: InferredType;
}

export type CacheRead =
  /** No cache file yet (or an empty one) — safe to create. */
  | { status: "empty" }
  | { status: "ok"; type: InferredType }
  /** The path holds something that isn't ours. Never overwrite this. */
  | { status: "foreign"; reason: string };

export function readCache(path: string): CacheRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "empty" };
    return { status: "foreign", reason: (err as Error).message };
  }

  if (!raw.trim()) return { status: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "foreign", reason: "not valid JSON" };
  }

  const envelope = parsed as Partial<CacheEnvelope> | null;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.format !== CACHE_TAG
  ) {
    return { status: "foreign", reason: "not a typesherlock cache file" };
  }
  if (envelope.version !== CACHE_VERSION) {
    return {
      status: "foreign",
      reason: `cache format v${String(envelope.version)}, this build understands v${CACHE_VERSION}`,
    };
  }
  if (!isInferredType(envelope.type)) {
    return { status: "foreign", reason: "cache contents are corrupt" };
  }
  return { status: "ok", type: envelope.type };
}

export function writeCache(path: string, type: InferredType): void {
  const envelope: CacheEnvelope = { format: CACHE_TAG, version: CACHE_VERSION, type };
  writeFileSync(path, JSON.stringify(envelope), "utf8");
}
