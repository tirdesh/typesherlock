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
    expect(inferFromSamples(["550e8400-e29b-41d4-a716-446655440000"])).toMatchObject({
      format: "uuid",
    });
    expect(inferFromSamples(["ada@example.com"])).toMatchObject({ format: "email" });
    expect(inferFromSamples(["https://example.com/x"])).toMatchObject({ format: "url" });
    expect(inferFromSamples(["plain text"])).not.toHaveProperty("format");
  });

  it("treats a field with 2+ distinct values across separate samples as enum evidence", () => {
    const type = inferFromSamples([{ status: "active" }, { status: "pending" }]);
    expect(type).toMatchObject({
      fields: {
        status: { type: { values: expect.arrayContaining(["active", "pending"]) } },
      },
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

  it("hoists nested objects into named interfaces, preferring the short field name", () => {
    const type = inferFromSamples([{ address: { city: "Boston" } }]);
    const { typescript } = generateTypeScript(type, { rootName: "User" });
    expect(typescript).toContain("export interface User {");
    expect(typescript).toContain("address: Address;");
    expect(typescript).toContain("export interface Address {");
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
    // "user-name" and "user_name" both pascal-case to the same short name
    // ("UserName") but have different fields — they must not collapse into
    // one interface and drop data. The first one to be visited claims the
    // short name; the second falls back to its fully path-qualified name.
    const type = inferFromSamples([{ "user-name": { a: 1 }, user_name: { b: "s" } }]);
    const { typescript } = generateTypeScript(type, { rootName: "Root" });
    expect(typescript).toContain("export interface UserName {");
    expect(typescript).toContain("a: number;");
    expect(typescript).toContain("export interface RootUserName {");
    expect(typescript).toContain("b: string;");
  });

  it("gives identically-shaped objects under different field names their own distinct interfaces", () => {
    const type = inferFromSamples([{ a: { x: 1 }, b: { x: 1 } }]);
    const { typescript } = generateTypeScript(type, { rootName: "Root" });
    // Same shape ({x: number}), but "a" and "b" are different fields/concepts —
    // each gets its own short name rather than being merged into one interface.
    expect(typescript).toContain("export interface A {");
    expect(typescript).toContain("export interface B {");
  });

  it("avoids overly long path-qualified names for deeply nested fields (PokeAPI-style)", () => {
    // Regression test for real output like "PokemonAbilitiesItemAbility" —
    // the nested "ability" field should get its own short "Ability" interface,
    // not a name compounding every ancestor's name along the way.
    const type = inferFromSamples([
      { abilities: [{ ability: { name: "static", url: "https://x" } }] },
    ]);
    const { typescript } = generateTypeScript(type, { rootName: "Pokemon" });
    expect(typescript).toContain("export interface Ability {");
    expect(typescript).not.toContain("PokemonAbilitiesItemAbility");
  });

  it("falls back to the qualified name only when the short name is taken by a different shape", () => {
    const type = inferFromSamples([
      { author: { id: 1 }, book: { author: { name: "Ada" } } },
    ]);
    const { typescript } = generateTypeScript(type, { rootName: "Root" });
    // Top-level "author" claims the short name "Author" first.
    expect(typescript).toContain("export interface Author {");
    expect(typescript).toContain("id: number;");
    // The nested "book.author" has a different shape, so it can't reuse
    // "Author" — it falls back to the qualified "BookAuthor".
    expect(typescript).toContain("export interface BookAuthor {");
    expect(typescript).toContain("name: string;");
  });

  it("renders a closed-set field as a string literal union", () => {
    const type = inferFromSamples([{ status: "active" }, { status: "pending" }]);
    const { typescript } = generateTypeScript(type, { rootName: "Resp" });
    expect(typescript).toMatch(
      /status: "active" \| "pending"|status: "pending" \| "active";/
    );
  });

  it("adds a format comment for detected date/uuid/email/url fields", () => {
    const type = inferFromSamples([{ createdAt: "2024-01-15T10:30:00Z" }]);
    const { typescript } = generateTypeScript(type, { rootName: "Resp" });
    expect(typescript).toContain("createdAt: string; // ISO 8601 date-time");
  });

  it("flags integers beyond Number.MAX_SAFE_INTEGER with a warning comment", () => {
    // eslint-disable-next-line no-loss-of-precision -- the precision loss is exactly what's under test
    const type = inferFromSamples([{ id: 123456789012345678901234, safe: 42 }]);
    const { typescript } = generateTypeScript(type, { rootName: "Resp" });
    expect(typescript).toContain("id: number; // WARNING:");
    expect(typescript).not.toContain("safe: number; //");
  });

  it("renders a recursive structure as a self-referential type, not unknown[]", () => {
    // The one sample runs out of data at depth 2 (replies: []), but the shape
    // at depth 1 already matches the root — should reuse Comment, not invent
    // a dead-end CommentRepliesItem with replies: unknown[].
    const type = inferFromSamples([{ id: 1, replies: [{ id: 2, replies: [] }] }]);
    const { typescript } = generateTypeScript(type, { rootName: "Comment" });
    expect(typescript).toContain("replies: Comment[];");
    expect(typescript).not.toContain("unknown");
    expect(typescript).not.toContain("CommentRepliesItem");
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
    expect(typescript).toMatch(
      /status: z\.enum\(\["active", "pending"\]|status: z\.enum\(\["pending", "active"\]/
    );
  });

  it("renders detected formats as the matching zod validator", () => {
    const type = inferFromSamples([
      { createdAt: "2024-01-15T10:30:00Z", id: "550e8400-e29b-41d4-a716-446655440000" },
    ]);
    const { typescript } = generateZodSchema(type, { rootName: "Resp" });
    expect(typescript).toContain("createdAt: z.string().datetime(),");
    expect(typescript).toContain("id: z.string().uuid(),");
  });

  it("renders a recursive structure using z.lazy(), and it actually parses at runtime", async () => {
    const type = inferFromSamples([{ id: 1, replies: [{ id: 2, replies: [] }] }]);
    const { typescript } = generateZodSchema(type, { rootName: "Comment" });
    expect(typescript).toContain("replies: z.array(z.lazy(() => CommentSchema)),");

    // z.object({ ...replies: z.array(CommentSchema)... }) would throw a
    // ReferenceError at module init (self-reference before the const is
    // assigned) — z.lazy() defers evaluation, so this must actually work,
    // not just look right as a string.
    const { z } = await import("zod");
    // `new Function` bodies aren't modules and aren't TypeScript, so strip the
    // `export` keywords and the `: z.ZodTypeAny` annotation that recursive
    // schemas carry (see registerZodSchema — tsc needs it, plain JS can't
    // parse it). The import line was already stripped.
    const body = typescript
      .replace(/^import .*;\n\n/, "")
      .replace(/export /g, "")
      .replace(/: z\.ZodTypeAny/g, "");
    const schema = new Function("z", `${body}\nreturn CommentSchema;`)(z);
    const result = schema.safeParse({
      id: 1,
      replies: [{ id: 2, replies: [{ id: 3, replies: [] }] }],
    });
    expect(result.success).toBe(true);
  });
});
