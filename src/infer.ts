// Structural type inference from JSON values. No AI involved here — this is
// the deterministic layer: given one or more sample JSON payloads, deduce a
// shape that describes all of them. String-shape detection (dates, UUIDs,
// emails, URLs, closed-set enums) is regex/statistics only — see the comment
// above ENUM_MAX_VALUES for why enum evidence is scoped the way it is.

export type StringFormat = "date-time" | "uuid" | "email" | "url";

export type InferredType =
  | {
      kind: "string";
      /** Set when every observed value matches one regex-detectable format. */
      format?: StringFormat;
      /**
       * Distinct literal values seen so far, while the field still looks like
       * a plausible closed-set enum. Absent once the field has a format, or
       * once distinct values exceed VALUES_TRACK_CAP (clearly free text).
       */
      values?: string[];
    }
  | {
      kind: "number";
      /**
       * Set when this value is an integer beyond Number.MAX_SAFE_INTEGER.
       * JSON.parse itself already rounds such values to the nearest
       * representable double before we ever see them, so the original exact
       * digits are unrecoverable here — this only flags that the risk exists,
       * it doesn't (can't) fix the precision loss.
       */
      lossy?: boolean;
    }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "unknown" } // seen zero samples for this field
  | { kind: "array"; items: InferredType }
  | { kind: "object"; fields: Record<string, FieldType> }
  | { kind: "union"; options: InferredType[] };

export interface FieldType {
  type: InferredType;
  /** Present in every sample object that had this key at all. */
  optional: boolean;
}

/** Above this many distinct values, a field is clearly free text, not an enum. */
const VALUES_TRACK_CAP = 20;

/** At or below this many distinct values (and at least 2), render as a literal union. */
export const ENUM_MAX_VALUES = 5;

const FORMAT_PATTERNS: [StringFormat, RegExp][] = [
  ["date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/],
  ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ["url", /^https?:\/\/\S+$/],
];

function detectFormat(value: string): StringFormat | undefined {
  for (const [format, pattern] of FORMAT_PATTERNS) {
    if (pattern.test(value)) return format;
  }
  return undefined;
}

/**
 * Strip enum candidacy (but keep detected formats) from a type. Applied to
 * array item types: repeated string values *within one array in a single
 * sample* (e.g. `tags: ["admin", "beta"]`) are not evidence of a closed set
 * the way repeated values *across separately piped samples* are — an array's
 * own contents are the data, not a hint about the field's whole value space.
 */
function stripEnumCandidacy(type: InferredType): InferredType {
  switch (type.kind) {
    case "string":
      return type.values ? { kind: "string", format: type.format } : type;
    case "array":
      return { kind: "array", items: stripEnumCandidacy(type.items) };
    case "object": {
      const fields: Record<string, FieldType> = {};
      for (const [key, field] of Object.entries(type.fields)) {
        fields[key] = { type: stripEnumCandidacy(field.type), optional: field.optional };
      }
      return { kind: "object", fields };
    }
    case "union":
      return { kind: "union", options: type.options.map(stripEnumCandidacy) };
    default:
      return type;
  }
}

function typeOfValue(value: unknown): InferredType {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    return { kind: "array", items: stripEnumCandidacy(mergeAll(value.map(typeOfValue))) };
  }
  switch (typeof value) {
    case "string": {
      const format = detectFormat(value);
      return format ? { kind: "string", format } : { kind: "string", values: [value] };
    }
    case "number":
      return Number.isInteger(value) && !Number.isSafeInteger(value)
        ? { kind: "number", lossy: true }
        : { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "object":
      return typeOfObject(value as Record<string, unknown>);
    default:
      return { kind: "unknown" };
  }
}

function typeOfObject(obj: Record<string, unknown>): InferredType {
  const fields: Record<string, FieldType> = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = { type: typeOfValue(value), optional: false };
  }
  return { kind: "object", fields };
}

/** Structural equality check, used to dedupe union members and interface names. */
export function typesEqual(a: InferredType, b: InferredType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "array" && b.kind === "array") {
    return typesEqual(a.items, b.items);
  }
  if (a.kind === "object" && b.kind === "object") {
    const aKeys = Object.keys(a.fields).sort();
    const bKeys = Object.keys(b.fields).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
      return false;
    }
    return aKeys.every(
      (k) =>
        a.fields[k].optional === b.fields[k].optional &&
        typesEqual(a.fields[k].type, b.fields[k].type)
    );
  }
  if (a.kind === "union" && b.kind === "union") {
    if (a.options.length !== b.options.length) return false;
    return a.options.every((opt) => b.options.some((o) => typesEqual(opt, o)));
  }
  return true;
}

/**
 * Like typesEqual, but treats "unknown" (seen zero samples for this spot) as
 * compatible with anything. Used to detect recursive shapes: a nested object
 * three levels deep whose own nested field ran out of sample data (e.g. an
 * empty `replies: []` at the leaf of your one sample) should still be
 * recognized as "the same shape as its ancestor" rather than falling back to
 * a dead-end `unknown[]` — a human writing this by hand would just write
 * `replies: Comment[]` recursively, using their own judgment to fill the gap
 * sample data alone can't.
 */
export function compatibleWithWildcard(a: InferredType, b: InferredType): boolean {
  if (a.kind === "unknown" || b.kind === "unknown") return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "array" && b.kind === "array") {
    return compatibleWithWildcard(a.items, b.items);
  }
  if (a.kind === "object" && b.kind === "object") {
    const aKeys = Object.keys(a.fields).sort();
    const bKeys = Object.keys(b.fields).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
      return false;
    }
    return aKeys.every(
      (k) =>
        a.fields[k].optional === b.fields[k].optional &&
        compatibleWithWildcard(a.fields[k].type, b.fields[k].type)
    );
  }
  if (a.kind === "union" && b.kind === "union") {
    if (a.options.length !== b.options.length) return false;
    return a.options.every((opt) => b.options.some((o) => compatibleWithWildcard(opt, o)));
  }
  return true;
}

function mergeStringTypes(
  a: Extract<InferredType, { kind: "string" }>,
  b: Extract<InferredType, { kind: "string" }>
): InferredType {
  const format = a.format && a.format === b.format ? a.format : undefined;
  if (format) return { kind: "string", format };
  if (!a.values || !b.values) return { kind: "string" };
  const values = Array.from(new Set([...a.values, ...b.values]));
  return values.length > VALUES_TRACK_CAP ? { kind: "string" } : { kind: "string", values };
}

/** Merge two inferred types into one that describes both (union if incompatible). */
export function mergeTypes(a: InferredType, b: InferredType): InferredType {
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (a.kind === "string" && b.kind === "string") return mergeStringTypes(a, b);
  if (a.kind === "number" && b.kind === "number") {
    return a.lossy || b.lossy ? { kind: "number", lossy: true } : { kind: "number" };
  }

  // No shortcut for "already structurally equal" here: typesEqual ignores
  // string metadata (format/values) by design (see its own doc comment), so
  // short-circuiting on it would skip merging e.g. two equally-shaped objects
  // whose string fields have different enum-candidate values.
  if (a.kind === "object" && b.kind === "object") {
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    const fields: Record<string, FieldType> = {};
    for (const key of keys) {
      const inA = key in a.fields;
      const inB = key in b.fields;
      const fieldType = mergeTypes(
        inA ? a.fields[key].type : { kind: "unknown" },
        inB ? b.fields[key].type : { kind: "unknown" }
      );
      const optional =
        !inA || !inB || a.fields[key].optional || b.fields[key].optional;
      fields[key] = { type: fieldType, optional };
    }
    return { kind: "object", fields };
  }

  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", items: mergeTypes(a.items, b.items) };
  }

  const aOptions = a.kind === "union" ? a.options : [a];
  const bOptions = b.kind === "union" ? b.options : [b];
  const merged: InferredType[] = [];
  for (const opt of [...aOptions, ...bOptions]) {
    if (!merged.some((m) => typesEqual(m, opt))) merged.push(opt);
  }
  return merged.length === 1 ? merged[0] : { kind: "union", options: merged };
}

function mergeAll(types: InferredType[]): InferredType {
  return types.reduce(
    (acc, t) => mergeTypes(acc, t),
    { kind: "unknown" } as InferredType
  );
}

/**
 * Infer a single type describing every sample passed in. Multiple samples
 * (e.g. a success response and an error response) are merged into one type,
 * with fields that don't appear in every sample marked optional.
 */
export function inferFromSamples(samples: unknown[]): InferredType {
  if (samples.length === 0) return { kind: "unknown" };
  return mergeAll(samples.map(typeOfValue));
}
