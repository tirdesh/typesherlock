import {
  ENUM_MAX_VALUES,
  compatibleWithWildcard,
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

function pascalCase(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("") || "Root";
}

interface GenContext {
  /** name -> rendered TS interface body, collected as nested objects are visited */
  interfaces: Map<string, string>;
  /** name -> the object shape currently occupying that name, so collisions between
   * differently-shaped objects that pascal-case to the same name can be detected
   * instead of silently merged into one (dropping whichever fields don't match). */
  shapesByName: Map<string, InferredType>;
  /** Object shapes currently being generated, outermost first — used to detect
   * recursive structures (see compatibleWithWildcard's doc comment). */
  ancestors: { name: string; shape: InferredType & { kind: "object" } }[];
  rootName: string;
}

/** If `shape` matches an ancestor currently being generated, return that
 * ancestor's name instead of minting a new type for it. */
function findRecursiveAncestor(
  shape: InferredType & { kind: "object" },
  ctx: GenContext
): string | undefined {
  for (let i = ctx.ancestors.length - 1; i >= 0; i--) {
    if (compatibleWithWildcard(shape, ctx.ancestors[i].shape)) {
      return ctx.ancestors[i].name;
    }
  }
  return undefined;
}

/**
 * Resolve a name for `shape`, reusing `baseName` if it's free or already holds an
 * identical shape, otherwise appending a numeric suffix (2, 3, ...) until one does.
 */
function resolveName(
  baseName: string,
  shape: InferredType,
  ctx: GenContext
): { name: string; isNew: boolean } {
  let candidate = baseName;
  let suffix = 2;
  while (ctx.shapesByName.has(candidate)) {
    if (typesEqual(ctx.shapesByName.get(candidate)!, shape)) {
      return { name: candidate, isNew: false };
    }
    candidate = `${baseName}${suffix++}`;
  }
  ctx.shapesByName.set(candidate, shape);
  return { name: candidate, isNew: true };
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
    case "array":
      return `${tsTypeOf(type.items, [...path, "Item"], ctx)}[]`;
    case "union":
      return type.options.map((o) => tsTypeOf(o, path, ctx)).join(" | ");
    case "object": {
      const recursive = findRecursiveAncestor(type, ctx);
      if (recursive) return recursive;
      const baseName = pascalCase(path.join(" "));
      return registerInterface(baseName, type, ctx);
    }
  }
}

function registerInterface(
  baseName: string,
  shape: InferredType & { kind: "object" },
  ctx: GenContext
): string {
  const { name, isNew } = resolveName(baseName, shape, ctx);
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
  const rootName = options.rootName ?? "Root";
  const ctx: GenContext = { interfaces: new Map(), shapesByName: new Map(), ancestors: [], rootName };

  if (type.kind === "object") {
    registerInterface(rootName, type, ctx);
  } else {
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
      return `z.union([${type.options
        .map((o) => zodExprOf(o, path, ctx))
        .join(", ")}])`;
    case "object": {
      const recursive = findRecursiveAncestor(type, ctx);
      if (recursive) {
        // A recursive schema can't reference itself directly in its own
        // initializer (the const isn't defined yet at that point) — z.lazy()
        // defers evaluation until the schema is actually used.
        return `z.lazy(() => ${recursive}Schema)`;
      }
      const baseName = pascalCase(path.join(" "));
      const name = registerZodSchema(baseName, type, ctx);
      return `${name}Schema`;
    }
  }
}

function registerZodSchema(
  baseName: string,
  shape: InferredType & { kind: "object" },
  ctx: GenContext
): string {
  const { name, isNew } = resolveName(baseName, shape, ctx);
  const schemaName = `${name}Schema`;
  if (!isNew) return name;
  ctx.interfaces.set(schemaName, "");
  ctx.ancestors.push({ name, shape });
  const fields = shape.fields;
  const lines = Object.entries(fields).map(([key, field]) => {
    let expr = zodExprOf(field.type, [name, key], ctx);
    if (field.optional) expr += ".optional()";
    return `  ${keyLiteral(key)}: ${expr},`;
  });
  ctx.ancestors.pop();
  ctx.interfaces.set(
    schemaName,
    `export const ${schemaName} = z.object({\n${lines.join("\n")}\n});`
  );
  return name;
}

/** Render an inferred type tree into one or more exported Zod schemas. */
export function generateZodSchema(
  type: InferredType,
  options: GenerateOptions = {}
): GenerateResult {
  const rootName = options.rootName ?? "Root";
  const ctx: GenContext = { interfaces: new Map(), shapesByName: new Map(), ancestors: [], rootName };

  if (type.kind === "object") {
    registerZodSchema(rootName, type, ctx);
  } else {
    const expr = zodExprOf(type, [rootName], ctx);
    ctx.interfaces.set(`${rootName}Schema`, `export const ${rootName}Schema = ${expr};`);
  }

  const body = [...ctx.interfaces.values()].filter(Boolean).join("\n\n");
  const typescript = `import { z } from "zod";\n\n${body}\n`;
  return { typescript, rootName };
}
