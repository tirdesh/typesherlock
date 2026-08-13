import { describe, expect, it } from "vitest";
import { inferFromSamples } from "../src/infer.js";
import { generateTypeScript, generateZodSchema } from "../src/generate.js";

describe("inferFromSamples", () => {
  it("infers primitives", () => {
    expect(inferFromSamples(["hi"])).toEqual({ kind: "string" });
    expect(inferFromSamples([42])).toEqual({ kind: "number" });
    expect(inferFromSamples([true])).toEqual({ kind: "boolean" });
    expect(inferFromSamples([null])).toEqual({ kind: "null" });
  });

  it("infers nested objects and arrays", () => {
    const type = inferFromSamples([{ id: 1, tags: ["a", "b"] }]);
    expect(type).toEqual({
      kind: "object",
      fields: {
        id: { type: { kind: "number" }, optional: false },
        tags: {
          type: { kind: "array", items: { kind: "string" } },
          optional: false,
        },
      },
    });
  });

  it("marks fields optional when missing across samples", () => {
    const type = inferFromSamples([{ ok: true, data: 1 }, { ok: false }]);
    expect(type).toEqual({
      kind: "object",
      fields: {
        ok: { type: { kind: "boolean" }, optional: false },
        data: { type: { kind: "number" }, optional: true },
      },
    });
  });

  it("unions incompatible types for the same field", () => {
    const type = inferFromSamples([{ code: 1 }, { code: "ERR" }]);
    expect(type).toEqual({
      kind: "object",
      fields: {
        code: {
          type: { kind: "union", options: [{ kind: "number" }, { kind: "string" }] },
          optional: false,
        },
      },
    });
  });

  it("dedupes identical array element shapes", () => {
    const type = inferFromSamples([{ items: [{ id: 1 }, { id: 2 }] }]);
    expect(type).toEqual({
      kind: "object",
      fields: {
        items: {
          type: {
            kind: "array",
            items: {
              kind: "object",
              fields: { id: { type: { kind: "number" }, optional: false } },
            },
          },
          optional: false,
        },
      },
    });
  });

  it("returns unknown for empty sample sets", () => {
    expect(inferFromSamples([])).toEqual({ kind: "unknown" });
  });
});

describe("generateTypeScript", () => {
  it("renders a flat interface", () => {
    const type = inferFromSamples([{ id: 1, name: "Ada" }]);
    const { typescript } = generateTypeScript(type, { rootName: "User" });
    expect(typescript).toContain("export interface User {");
    expect(typescript).toContain("id: number;");
    expect(typescript).toContain("name: string;");
  });

  it("hoists nested objects into named interfaces", () => {
    const type = inferFromSamples([{ address: { city: "Boston" } }]);
    const { typescript } = generateTypeScript(type, { rootName: "User" });
    expect(typescript).toContain("export interface User {");
    expect(typescript).toContain("address: UserAddress;");
    expect(typescript).toContain("export interface UserAddress {");
    expect(typescript).toContain("city: string;");
  });

  it("marks merged-optional fields with a ?", () => {
    const type = inferFromSamples([{ ok: true, data: 1 }, { ok: false }]);
    const { typescript } = generateTypeScript(type, { rootName: "Resp" });
    expect(typescript).toContain("data?: number;");
  });

  it("quotes keys that aren't valid identifiers", () => {
    const type = inferFromSamples([{ "content-type": "json" }]);
    const { typescript } = generateTypeScript(type, { rootName: "Headers" });
    expect(typescript).toContain('"content-type": string;');
  });

  it("renders an empty object as an empty interface, not a blank line", () => {
    const type = inferFromSamples([{}]);
    const { typescript } = generateTypeScript(type, { rootName: "Empty" });
    expect(typescript.trim()).toBe("export interface Empty {}");
  });

  it("disambiguates differently-shaped nested objects that share a generated name", () => {
    // "user-name" and "user_name" both pascal-case to "RootUserName" but have
    // different fields — they must not collapse into one interface and drop data.
    const type = inferFromSamples([
      { "user-name": { a: 1 }, user_name: { b: "s" } },
    ]);
    const { typescript } = generateTypeScript(type, { rootName: "Root" });
    expect(typescript).toContain("export interface RootUserName {");
    expect(typescript).toContain("a: number;");
    expect(typescript).toContain("export interface RootUserName2 {");
    expect(typescript).toContain("b: string;");
  });

  it("reuses the same name for identically-shaped objects at the same generated name", () => {
    const type = inferFromSamples([{ a: { x: 1 }, b: { x: 1 } }]);
    const { typescript } = generateTypeScript(type, { rootName: "Root" });
    // RootA and RootB are different generated names (named by path), so both
    // should exist independently rather than being merged or renamed.
    expect(typescript).toContain("export interface RootA {");
    expect(typescript).toContain("export interface RootB {");
  });
});

describe("generateZodSchema", () => {
  it("renders a matching zod object schema", () => {
    const type = inferFromSamples([{ id: 1, tags: ["a"] }]);
    const { typescript } = generateZodSchema(type, { rootName: "User" });
    expect(typescript).toContain('import { z } from "zod";');
    expect(typescript).toContain("export const UserSchema = z.object({");
    expect(typescript).toContain("id: z.number(),");
    expect(typescript).toContain("tags: z.array(z.string()),");
  });

  it("marks optional fields with .optional()", () => {
    const type = inferFromSamples([{ ok: true, data: 1 }, { ok: false }]);
    const { typescript } = generateZodSchema(type, { rootName: "Resp" });
    expect(typescript).toContain("data: z.number().optional(),");
  });
});
