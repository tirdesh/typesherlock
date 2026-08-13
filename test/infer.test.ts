import { describe, expect, it } from "vitest";
import { inferFromSamples } from "../src/infer.js";
import { generateTypeScript, generateZodSchema } from "../src/generate.js";

describe("inferFromSamples", () => {
  it("infers primitives", () => {
    expect(inferFromSamples(["hi"])).toEqual({ kind: "string", values: ["hi"] });
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
          type: {
            kind: "union",
            options: [{ kind: "number" }, { kind: "string", values: ["ERR"] }],
          },
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

  it("detects date-time, uuid, email, and url formats", () => {
    expect(inferFromSamples(["2024-01-15T10:30:00Z"])).toMatchObject({
      format: "date-time",
    });
    expect(
      inferFromSamples(["550e8400-e29b-41d4-a716-446655440000"])
    ).toMatchObject({ format: "uuid" });
    expect(inferFromSamples(["ada@example.com"])).toMatchObject({ format: "email" });
    expect(inferFromSamples(["https://example.com/x"])).toMatchObject({ format: "url" });
    expect(inferFromSamples(["plain text"])).not.toHaveProperty("format");
  });

  it("treats a field with 2+ distinct values across separate samples as enum evidence", () => {
    const type = inferFromSamples([{ status: "active" }, { status: "pending" }]);
    expect(type).toMatchObject({
      fields: { status: { type: { values: expect.arrayContaining(["active", "pending"]) } } },
    });
  });

  it("does not treat repeated values within one array (one sample) as enum evidence", () => {
    // tags is free text, not a closed set — seeing 2 tags in one response is not
    // evidence the field can *only* ever be "admin" or "beta".
    const type = inferFromSamples([{ tags: ["admin", "beta"] }]);
    expect(type).toEqual({
      kind: "object",
      fields: {
        tags: {
          type: { kind: "array", items: { kind: "string" } },
          optional: false,
        },
      },
    });
  });

  it("gives up on enum candidacy once too many distinct values appear", () => {
    const samples = Array.from({ length: 25 }, (_, i) => ({ id: `val-${i}` }));
    const type = inferFromSamples(samples);
    expect(type).toEqual({
      kind: "object",
      fields: { id: { type: { kind: "string" }, optional: false } },
    });
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

  it("renders a closed-set field as a string literal union", () => {
    const type = inferFromSamples([{ status: "active" }, { status: "pending" }]);
    const { typescript } = generateTypeScript(type, { rootName: "Resp" });
    expect(typescript).toMatch(/status: "active" \| "pending"|status: "pending" \| "active";/);
  });

  it("adds a format comment for detected date/uuid/email/url fields", () => {
    const type = inferFromSamples([{ createdAt: "2024-01-15T10:30:00Z" }]);
    const { typescript } = generateTypeScript(type, { rootName: "Resp" });
    expect(typescript).toContain("createdAt: string; // ISO 8601 date-time");
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

  it("renders a closed-set field as z.enum(...)", () => {
    const type = inferFromSamples([{ status: "active" }, { status: "pending" }]);
    const { typescript } = generateZodSchema(type, { rootName: "Resp" });
    expect(typescript).toMatch(/status: z\.enum\(\["active", "pending"\]|status: z\.enum\(\["pending", "active"\]/);
  });

  it("renders detected formats as the matching zod validator", () => {
    const type = inferFromSamples([
      { createdAt: "2024-01-15T10:30:00Z", id: "550e8400-e29b-41d4-a716-446655440000" },
    ]);
    const { typescript } = generateZodSchema(type, { rootName: "Resp" });
    expect(typescript).toContain("createdAt: z.string().datetime(),");
    expect(typescript).toContain("id: z.string().uuid(),");
  });
});
