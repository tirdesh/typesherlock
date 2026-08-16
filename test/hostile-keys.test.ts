import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { inferFromSamples, mergeTypes, toSamples } from "../src/infer.js";
import { generateTypeScript, generateZodSchema } from "../src/generate.js";

/**
 * JSON keys are arbitrary strings; TypeScript identifiers are not. These are
 * regression tests for three real bugs found by throwing hostile-but-plausible
 * keys at the generator:
 *
 *   1. a key starting with a digit ("3d", "2fa_enabled", a year like "2024")
 *      emitted `export interface 3d {}`, which does not parse;
 *   2. a "__proto__" key was silently dropped from the output entirely,
 *      because the field map was a plain `{}` and assigning to it hit the
 *      prototype setter;
 *   3. merging a cached type against a sample containing a "toString" key
 *      crashed, because `key in fields` matched Object.prototype.
 */

const scratchRoot = fileURLToPath(new URL("../.test-tmp/", import.meta.url));

/** Compile a generated .ts source string and return any syntactic/semantic errors. */
function compileErrors(source: string): string[] {
  mkdirSync(scratchRoot, { recursive: true });
  const file = join(scratchRoot, `compile-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source, "utf8");
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  rmSync(file, { force: true });
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

const HOSTILE_PAYLOADS: [label: string, json: string][] = [
  ["leading-digit key", '{"3d":{"x":1}}'],
  ["all-digit key", '{"123":{"x":1}}'],
  ["year key (time-series APIs)", '{"2024":{"rev":5},"2025":{"rev":6}}'],
  ["digit-prefixed word keys", '{"2fa_enabled":true,"3d_model":{"v":1}}'],
  ["reserved words", '{"class":{"a":1},"function":{"b":2},"default":{"c":3}}'],
  ["prototype keys", '{"__proto__":{"x":1},"constructor":{"y":2},"toString":{"z":3}}'],
  ["empty key", '{"":{"x":1}}'],
  ["punctuation-only keys", '{"---":{"x":1},"___":{"y":2}}'],
  ["non-ascii keys", '{"名前":{"x":1},"日本":{"y":2}}'],
  ["keys differing only by separator", '{"a-b":{"x":1},"a_b":{"x":2}}'],
  [
    "nested arrays and deep nesting",
    '{"items":[[{"id":1}]],"m":{"n":{"o":{"p":{"q":1}}}}}',
  ],
  ["recursive shape", '{"id":1,"replies":[{"id":2,"replies":[]}]}'],
  ["heterogeneous array", '{"mixed":[1,"a",{"x":1},null,true]}'],
];

describe("hostile JSON keys always produce compilable output", () => {
  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it.each(HOSTILE_PAYLOADS)("%s -> valid TypeScript", (_label, json) => {
    const type = inferFromSamples(toSamples(JSON.parse(json)));
    const { typescript } = generateTypeScript(type, { rootName: "Root" });
    expect(compileErrors(typescript)).toEqual([]);
  });

  it("sanitizes a caller-supplied root name that isn't a valid identifier", () => {
    const type = inferFromSamples([{ x: 1 }]);
    const { typescript } = generateTypeScript(type, { rootName: "3d" });
    expect(compileErrors(typescript)).toEqual([]);
    expect(typescript).not.toMatch(/interface 3d\b/);
  });
});

describe("keys that collide with Object.prototype", () => {
  // NB: these must go through JSON.parse rather than a JS object literal —
  // `{ __proto__: "x" }` in source sets the prototype instead of creating a
  // property, so a literal would silently not test what it claims to.
  it("keeps a __proto__ field instead of silently dropping it", () => {
    const type = inferFromSamples(
      toSamples(JSON.parse('{"__proto__":"hello","keep":1}'))
    );
    const { typescript } = generateTypeScript(type, { rootName: "Root" });
    expect(typescript).toContain("__proto__");
    expect(typescript).toContain("keep: number;");
  });

  it("does not invent fields inherited from Object.prototype", () => {
    const type = inferFromSamples([{ keep: 1 }]);
    // "toString"/"valueOf" exist on Object.prototype but were never in the sample.
    expect(Object.keys((type as { fields: object }).fields)).toEqual(["keep"]);
  });

  it("merges a revived (JSON round-tripped) type against a toString key without crashing", () => {
    // Exactly reproduces the --cache crash: the cached side comes back from
    // JSON.parse with a normal prototype, so `"toString" in fields` was true.
    const cached = JSON.parse(JSON.stringify(inferFromSamples([{ keep: 1 }])));
    const incoming = inferFromSamples([{ toString: "hi" }]);
    const merged = mergeTypes(cached, incoming);
    const { typescript } = generateTypeScript(merged, { rootName: "R" });
    expect(typescript).toContain("keep?: number;");
    expect(typescript).toContain("toString?: string;");
    expect(compileErrors(typescript)).toEqual([]);
  });

  it("generates a valid Zod schema for prototype-colliding keys", () => {
    const type = inferFromSamples(toSamples(JSON.parse('{"__proto__":"s","keep":1}')));
    const { typescript } = generateZodSchema(type, { rootName: "Root" });
    expect(typescript).toContain("__proto__");
  });
});
