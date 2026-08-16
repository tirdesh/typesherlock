import { describe, expect, it } from "vitest";
import { inferFromSamples, toSamples } from "../src/infer.js";
import { generateTypeScript, generateZodSchema } from "../src/generate.js";

/**
 * Soundness regressions. The unifying rule these all protect: the generated
 * type must describe the JSON it was generated from. Every case below once
 * produced a type or schema that its own input didn't satisfy.
 */

function tsOf(json: string, rootName = "Root"): string {
  return generateTypeScript(inferFromSamples(toSamples(JSON.parse(json))), { rootName })
    .typescript;
}

function zodOf(json: string, rootName = "Root"): string {
  return generateZodSchema(inferFromSamples(toSamples(JSON.parse(json))), { rootName })
    .typescript;
}

describe("arrays of unions are parenthesized", () => {
  it("renders a heterogeneous array as (A | B)[], not A | B[]", () => {
    // `number | string[]` parses as `number | (string[])`, so `[1, "x"]` —
    // the very input it came from — does not typecheck against it.
    expect(tsOf('{"a": [1, "x"]}')).toContain("a: (number | string)[];");
  });

  it("parenthesizes the extremely common [item, null] shape", () => {
    expect(tsOf('{"b": [{"z":1}, null]}')).toContain("b: (Item | null)[];");
  });

  it("leaves single-type arrays unparenthesized", () => {
    expect(tsOf('{"c": [1, 2]}')).toContain("c: number[];");
  });
});

describe("union merging is order-independent", () => {
  const values = ["active", "banned", "pending", "deleted"];
  const orderings = [
    '[{"status":null},{"status":"active"},{"status":"banned"},{"status":"pending"},{"status":"deleted"}]',
    '[{"status":"active"},{"status":"banned"},{"status":null},{"status":"pending"},{"status":"deleted"}]',
    '[{"status":"active"},{"status":"banned"},{"status":"pending"},{"status":"deleted"},{"status":null}]',
  ];

  it.each(orderings)(
    "keeps every enum value regardless of where null lands: %s",
    (json) => {
      // A null arriving mid-stream used to freeze the string member of the
      // union, silently discarding every value seen afterwards.
      const ts = tsOf(json, "R");
      for (const v of values) expect(ts).toContain(`"${v}"`);
      expect(ts).toContain("null");
    }
  );

  it("emits a z.enum that accepts all observed values", () => {
    const zod = zodOf(orderings[1], "R");
    for (const v of values) expect(zod).toContain(`"${v}"`);
  });

  it("folds string formats across a union rather than dropping members", () => {
    // uuid-then-number-then-plain-string used to leave z.string().uuid() in
    // the union, which then rejected "hello".
    const zod = zodOf(
      '[{"id":"550e8400-e29b-41d4-a716-446655440000"},{"id":42},{"id":"hello"}]'
    );
    expect(zod).not.toContain("uuid()");
  });
});

describe("distinct shapes keep distinct interfaces", () => {
  it("does not merge same-keyed objects that carry different enum evidence", () => {
    const json =
      '[{"user":{"detail":{"kind":"admin"}},"post":{"detail":{"kind":"text"}}},' +
      '{"user":{"detail":{"kind":"guest"}},"post":{"detail":{"kind":"video"}}}]';
    const ts = tsOf(json);
    expect(ts).toContain('kind: "admin" | "guest";');
    expect(ts).toContain('kind: "text" | "video";');
  });
});

describe("recursion detection", () => {
  it("still collapses a genuine self-referential shape", () => {
    expect(tsOf('{"id":1,"replies":[{"id":2,"replies":[]}]}', "Comment")).toContain(
      "replies: Comment[];"
    );
  });

  it("collapses a string-keyed tree (metadata differs between levels)", () => {
    expect(
      tsOf('{"name":"a","children":[{"name":"b","children":[]}]}', "Node")
    ).toContain("children: Node[];");
  });

  it("does not invent recursion when the match is driven only by empty arrays", () => {
    // Every field here lines up only because of `[]` -> unknown. Collapsing
    // it deleted the {id, label, score} interface outright.
    const ts = tsOf(
      '{"rows": [], "groups": [{"rows": [{"id":1,"label":"a","score":9.5}], "groups": []}]}',
      "Report"
    );
    expect(ts).toContain("id: number;");
    expect(ts).toContain("label: string;");
    expect(ts).toContain("score: number;");
    expect(ts).not.toContain("groups: Report[];");
  });

  it("annotates a self-referential zod schema so it compiles under noImplicitAny", () => {
    const zod = zodOf('{"name":"a","children":[{"name":"b","children":[]}]}', "Node");
    expect(zod).toContain("export const NodeSchema: z.ZodTypeAny =");
  });
});

describe("root name is never clobbered", () => {
  it("keeps a nested interface when the root is not an object", () => {
    // The nested {z:number} interface used to be overwritten by the root alias.
    const ts = tsOf('[1, {"z": 2}]', "Item");
    expect(ts).toContain("z: number;");
    expect(ts).toMatch(/export type Item =/);
  });
});

describe("caller-supplied root names", () => {
  it("does not emit a TypeScript reserved word as an interface name", () => {
    expect(tsOf('{"a":1}', "class")).not.toMatch(/interface class\b/);
  });
});

describe("zod object keys", () => {
  it("defines __proto__ with a computed key so it is a real field", () => {
    // `{ __proto__: x }` (quoted or not) invokes the prototype setter, so
    // z.object() never saw the field and silently accepted anything for it.
    expect(zodOf('{"id":1,"__proto__":{"admin":true}}')).toContain('["__proto__"]:');
  });
});
