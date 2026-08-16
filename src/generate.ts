import {
  ENUM_MAX_VALUES,
  looksRecursive,
  typesEqual,
  type InferredType,
  type StringFormat,
} from "./infer.js";

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const FORMAT_LABELS: Record<StringFormat, string> = {
  "date-time": "ISO 8601 date-time",
  uuid: "UUID",
  email: "email address",
  url: "URL",
};

/** A string type qualifies as a closed-set enum once it has 2+ distinct
 * observed values (1 value is just "this is what one sample happened to be",
 * not evidence of a closed set) and isn't so many that it's clearly free text. */
function enumValues(type: InferredType): string[] | undefined {
  if (type.kind !== "string" || !type.values) return undefined;
  return type.values.length >= 2 && type.values.length <= ENUM_MAX_VALUES
    ? type.values
    : undefined;
}

function fieldComment(type: InferredType): string {
  if (type.kind === "string" && type.format) return ` // ${FORMAT_LABELS[type.format]}`;
  if (type.kind === "number" && type.lossy) {
    return " // WARNING: integer beyond Number.MAX_SAFE_INTEGER — JSON parsing may lose precision";
  }
  return "";
}

function keyLiteral(key: string): string {
  return VALID_IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/**
 * A generated type name has to be a valid TypeScript identifier, which a JSON
 * key is not obliged to be. Keys that begin with a digit are common enough in
 * real payloads ("2fa_enabled", "3d_model", or a year key like "2024" in
 * analytics/time-series responses) and would otherwise emit
 * `export interface 3d {}`, which doesn't parse. Prefix those with "_".
 */
function ensureIdentifier(name: string): string {
  if (!name) return "Root";
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

function pascalCase(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return ensureIdentifier(cleaned);
}

const TS_RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "any",
  "boolean",
  "number",
  "string",
  "symbol",
  "never",
  "object",
  "undefined",
]);

/**
 * Sanitize a caller-supplied root name (CLI `--name`, MCP `name`). Unlike
 * generated names this isn't re-cased — the caller's intent is preserved —
 * but it still can't be allowed to produce uncompilable output.
 */
function rootIdentifier(name: string): string {
  const cleaned = ensureIdentifier(name.replace(/[^A-Za-z0-9_$]/g, ""));
  // `--name class` produced `export interface class {}` (TS2427). Generated
  // (non-root) names escape this because pascalCase capitalizes them.
  return TS_RESERVED.has(cleaned) ? `_${cleaned}` : cleaned;
}

interface GenContext {
  /** name -> rendered TS interface body, collected as nested objects are visited */
  interfaces: Map<string, string>;
  /** name -> the object shape currently occupying that name, so collisions between
   * differently-shaped objects that pascal-case to the same name can be detected
   * instead of silently merged into one (dropping whichever fields don't match). */
  shapesByName: Map<string, InferredType>;
  /** Object shapes currently being generated, outermost first — used to detect
   * recursive structures (see looksRecursive's doc comment). */
  ancestors: { name: string; shape: InferredType & { kind: "object" } }[];
  /** Schema names that ended up referring to themselves (see registerZodSchema). */
  selfReferential: Set<string>;
  rootName: string;
}

/** If `shape` matches an ancestor currently being generated, return that
 * ancestor's name instead of minting a new type for it. */
function findRecursiveAncestor(
  shape: InferredType & { kind: "object" },
  ctx: GenContext
): string | undefined {
  for (let i = ctx.ancestors.length - 1; i >= 0; i--) {
    if (looksRecursive(shape, ctx.ancestors[i].shape)) {
      return ctx.ancestors[i].name;
    }
  }
  return undefined;
}

/**
 * Resolve a name for `shape`, trying each of `candidates` in order — reusing
 * one if it's free or already holds an identical shape — before falling back
 * to numeric suffixes (2, 3, ...) off the last candidate. `candidates` is
 * typically [shortName, fullyQualifiedName]: prefer the short, readable name
 * (e.g. "Ability") and only fall back to the verbose path-qualified one
 * (e.g. "PokemonAbilitiesItemAbility") if the short name is already taken by
 * a differently-shaped object.
 */
function resolveName(
  candidates: string[],
  shape: InferredType,
  ctx: GenContext
): { name: string; isNew: boolean } {
  for (const candidate of candidates) {
    if (!ctx.shapesByName.has(candidate)) {
      ctx.shapesByName.set(candidate, shape);
      return { name: candidate, isNew: true };
    }
    if (typesEqual(ctx.shapesByName.get(candidate)!, shape)) {
      return { name: candidate, isNew: false };
    }
  }
  const base = candidates[candidates.length - 1];
  let suffix = 2;
  let candidate = `${base}${suffix}`;
  while (ctx.shapesByName.has(candidate)) {
    if (typesEqual(ctx.shapesByName.get(candidate)!, shape)) {
      return { name: candidate, isNew: false };
    }
    candidate = `${base}${++suffix}`;
  }
  ctx.shapesByName.set(candidate, shape);
  return { name: candidate, isNew: true };
}

/** Short name (just the immediate field/item name, e.g. "Ability") tried
 * before the fully path-qualified fallback (e.g. "PokemonAbilitiesItemAbility"). */
function nameCandidates(path: string[]): string[] {
  const qualified = pascalCase(path.join(" "));
  const short = pascalCase(path[path.length - 1]);
  return short === qualified ? [qualified] : [short, qualified];
}

function tsTypeOf(type: InferredType, path: string[], ctx: GenContext): string {
  switch (type.kind) {
    case "string": {
      const values = enumValues(type);
      return values ? values.map((v) => JSON.stringify(v)).join(" | ") : "string";
    }
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "unknown":
      return "unknown";
    case "array": {
      // `A | B` + `[]` parses as `A | (B[])`, not `(A | B)[]` — so a
      // heterogeneous array (`[item, null]` is everywhere in real payloads)
      // silently produced a type its own input doesn't satisfy.
      const item = tsTypeOf(type.items, [...path, "Item"], ctx);
      return item.includes("|") ? `(${item})[]` : `${item}[]`;
    }
    case "union":
      return type.options.map((o) => tsTypeOf(o, path, ctx)).join(" | ");
    case "object": {
      const recursive = findRecursiveAncestor(type, ctx);
      if (recursive) return recursive;
      return registerInterface(nameCandidates(path), type, ctx);
    }
  }
}

function registerInterface(
  candidates: string[],
  shape: InferredType & { kind: "object" },
  ctx: GenContext
): string {
  const { name, isNew } = resolveName(candidates, shape, ctx);
  if (!isNew) return name;
  // Reserve the name before recursing so self-referential shapes don't loop.
  ctx.interfaces.set(name, "");
  ctx.ancestors.push({ name, shape });
  const fields = shape.fields;
  const lines = Object.entries(fields).map(([key, field]) => {
    const tsType = tsTypeOf(field.type, [name, key], ctx);
    const optionalMark = field.optional ? "?" : "";
    const comment = fieldComment(field.type);
    return `  ${keyLiteral(key)}${optionalMark}: ${tsType};${comment}`;
  });
  ctx.ancestors.pop();
  const body = lines.length > 0 ? `\n${lines.join("\n")}\n` : "";
  ctx.interfaces.set(name, `export interface ${name} {${body}}`);
  return name;
}

export interface GenerateOptions {
  /** Name for the top-level type. Defaults to "Root". */
  rootName?: string;
}

export interface GenerateResult {
  typescript: string;
  rootName: string;
}

/** Render an inferred type tree into one or more exported TypeScript interfaces. */
export function generateTypeScript(
  type: InferredType,
  options: GenerateOptions = {}
): GenerateResult {
  const rootName = rootIdentifier(options.rootName ?? "Root");
  const ctx: GenContext = {
    interfaces: new Map(),
    shapesByName: new Map(),
    ancestors: [],
    selfReferential: new Set(),
    rootName,
  };

  if (type.kind === "object") {
    registerInterface([rootName], type, ctx);
  } else {
    // Claim the root name first. Without this, a nested object could be
    // assigned `rootName` and then have its interface overwritten by the
    // alias written below, destroying it.
    ctx.shapesByName.set(rootName, type);
    const aliasType = tsTypeOf(type, [rootName], ctx);
    ctx.interfaces.set(rootName, `export type ${rootName} = ${aliasType};`);
  }

  const typescript = [...ctx.interfaces.values()].filter(Boolean).join("\n\n") + "\n";
  return { typescript, rootName };
}

const ZOD_FORMAT_METHODS: Record<StringFormat, string> = {
  "date-time": "z.string().datetime()",
  uuid: "z.string().uuid()",
  email: "z.string().email()",
  url: "z.string().url()",
};

function zodExprOf(type: InferredType, path: string[], ctx: GenContext): string {
  switch (type.kind) {
    case "string": {
      const values = enumValues(type);
      if (values) return `z.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`;
      return type.format ? ZOD_FORMAT_METHODS[type.format] : "z.string()";
    }
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "unknown":
      return "z.unknown()";
    case "array":
      return `z.array(${zodExprOf(type.items, [...path, "Item"], ctx)})`;
    case "union":
      return `z.union([${type.options.map((o) => zodExprOf(o, path, ctx)).join(", ")}])`;
    case "object": {
      const recursive = findRecursiveAncestor(type, ctx);
      // A hit here means this schema refers back to one still being built, so
      // its `const` needs an explicit type annotation (see registerZodSchema).
      if (recursive) ctx.selfReferential.add(recursive);
      const name = recursive ?? registerZodSchema(nameCandidates(path), type, ctx);
      // Always wrapped in z.lazy(), not just for detected recursive cases:
      // registerZodSchema reserves the *position* of the outer schema's own
      // `const` before recursing into its fields (needed so a genuinely
      // self-referential shape can find its own name already reserved), which
      // means an outer schema's declaration always ends up ahead of nested
      // schemas it references — a `const` before its own dependency is
      // defined throws (temporal dead zone) unless evaluation is deferred.
      return `z.lazy(() => ${name}Schema)`;
    }
  }
}

function registerZodSchema(
  candidates: string[],
  shape: InferredType & { kind: "object" },
  ctx: GenContext
): string {
  const { name, isNew } = resolveName(candidates, shape, ctx);
  const schemaName = `${name}Schema`;
  if (!isNew) return name;
  ctx.interfaces.set(schemaName, "");
  ctx.ancestors.push({ name, shape });
  const fields = shape.fields;
  const lines = Object.entries(fields).map(([key, field]) => {
    let expr = zodExprOf(field.type, [name, key], ctx);
    if (field.optional) expr += ".optional()";
    // `{ __proto__: x }` and `{ "__proto__": x }` both invoke the prototype
    // setter rather than defining a property, so z.object() would never see
    // the field. Only a computed key defines it.
    const label = key === "__proto__" ? `["__proto__"]` : keyLiteral(key);
    return `  ${label}: ${expr},`;
  });
  ctx.ancestors.pop();
  // A self-referential const needs an explicit annotation, or tsc under
  // `noImplicitAny` (i.e. `strict`, the default for new projects) rejects the
  // emitted schema with TS7022 "implicitly has type 'any' because it does not
  // have a type annotation and is referenced ... in its own initializer".
  const annotation = ctx.selfReferential.has(name) ? ": z.ZodTypeAny" : "";
  ctx.interfaces.set(
    schemaName,
    `export const ${schemaName}${annotation} = z.object({\n${lines.join("\n")}\n});`
  );
  return name;
}

/** Render an inferred type tree into one or more exported Zod schemas. */
export function generateZodSchema(
  type: InferredType,
  options: GenerateOptions = {}
): GenerateResult {
  const rootName = rootIdentifier(options.rootName ?? "Root");
  const ctx: GenContext = {
    interfaces: new Map(),
    shapesByName: new Map(),
    ancestors: [],
    selfReferential: new Set(),
    rootName,
  };

  if (type.kind === "object") {
    registerZodSchema([rootName], type, ctx);
  } else {
    ctx.shapesByName.set(rootName, type);
    const expr = zodExprOf(type, [rootName], ctx);
    ctx.interfaces.set(`${rootName}Schema`, `export const ${rootName}Schema = ${expr};`);
  }

  const body = [...ctx.interfaces.values()].filter(Boolean).join("\n\n");
  const typescript = `import { z } from "zod";\n\n${body}\n`;
  return { typescript, rootName };
}
