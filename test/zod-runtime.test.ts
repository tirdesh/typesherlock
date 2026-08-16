import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inferFromSamples } from "../src/infer.js";
import { generateZodSchema } from "../src/generate.js";

/**
 * Regression coverage for a real bug: generated Zod code that *looked*
 * correct as a string still threw `ReferenceError: Cannot access 'X' before
 * initialization` at runtime, because the outer schema's `const` was always
 * emitted before the nested schemas it references (registerZodSchema reserves
 * the outer schema's position before recursing into fields, to support
 * genuine self-reference). String assertions never caught this — only
 * actually importing and running the generated code does.
 */
const tempDirs: string[] = [];

async function loadGeneratedSchema(typescript: string, schemaExport: string) {
  const dir = mkdtempSync(join(tmpdir(), "typesherlock-zod-runtime-"));
  tempDirs.push(dir);
  const file = join(dir, "schema.mjs");
  // generateZodSchema's output is already plain JS plus a `zod` import — no
  // TS-only syntax to strip.
  writeFileSync(file, typescript, "utf8");
  const mod = await import(pathToFileURL(file).href);
  return mod[schemaExport];
}

describe("generated Zod schemas actually run (not just look right as strings)", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("parses a sample with one level of nesting", async () => {
    const type = inferFromSamples([{ address: { city: "Boston" } }]);
    const { typescript } = generateZodSchema(type, { rootName: "User" });
    const schema = await loadGeneratedSchema(typescript, "UserSchema");
    const result = schema.safeParse({ address: { city: "Boston" } });
    expect(result.success).toBe(true);
  });

  it("parses a sample with several levels of nesting and arrays", async () => {
    const type = inferFromSamples([
      { user: { address: { city: "Boston" }, tags: [{ name: "x" }] } },
    ]);
    const { typescript } = generateZodSchema(type, { rootName: "Root" });
    const schema = await loadGeneratedSchema(typescript, "RootSchema");
    const result = schema.safeParse({
      user: { address: { city: "Boston" }, tags: [{ name: "x" }] },
    });
    expect(result.success).toBe(true);
  });

  it("parses a genuinely recursive sample", async () => {
    const type = inferFromSamples([
      { id: 1, replies: [{ id: 2, replies: [{ id: 3, replies: [] }] }] },
    ]);
    const { typescript } = generateZodSchema(type, { rootName: "Comment" });
    const schema = await loadGeneratedSchema(typescript, "CommentSchema");
    const result = schema.safeParse({
      id: 1,
      replies: [{ id: 2, replies: [{ id: 3, replies: [] }] }],
    });
    expect(result.success).toBe(true);
  });
});
