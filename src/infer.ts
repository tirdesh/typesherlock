// Structural type inference from JSON values. No AI involved here — this is
// the deterministic layer: given one or more sample JSON payloads, deduce a
// shape that describes all of them.

export type InferredType =
  | { kind: "string" }
  | { kind: "number" }
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

function typeOfValue(value: unknown): InferredType {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    return { kind: "array", items: mergeAll(value.map(typeOfValue)) };
  }
  switch (typeof value) {
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: "number" };
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

/** Merge two inferred types into one that describes both (union if incompatible). */
export function mergeTypes(a: InferredType, b: InferredType): InferredType {
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (typesEqual(a, b)) return a;

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
