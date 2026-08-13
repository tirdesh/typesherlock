import type { FieldType, InferredType } from "./infer.js";

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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
  rootName: string;
}

function tsTypeOf(type: InferredType, path: string[], ctx: GenContext): string {
  switch (type.kind) {
    case "string":
      return "string";
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
      const name = pascalCase(path.join(" "));
      registerInterface(name, type.fields, ctx);
      return name;
    }
  }
}

function registerInterface(
  name: string,
  fields: Record<string, FieldType>,
  ctx: GenContext
): void {
  if (ctx.interfaces.has(name)) return;
  // Reserve the name before recursing so self-referential shapes don't loop.
  ctx.interfaces.set(name, "");
  const lines = Object.entries(fields).map(([key, field]) => {
    const tsType = tsTypeOf(field.type, [name, key], ctx);
    const optionalMark = field.optional ? "?" : "";
    return `  ${keyLiteral(key)}${optionalMark}: ${tsType};`;
  });
  ctx.interfaces.set(name, `export interface ${name} {\n${lines.join("\n")}\n}`);
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
  const ctx: GenContext = { interfaces: new Map(), rootName };

  if (type.kind === "object") {
    registerInterface(rootName, type.fields, ctx);
  } else {
    const aliasType = tsTypeOf(type, [rootName], ctx);
    ctx.interfaces.set(rootName, `export type ${rootName} = ${aliasType};`);
  }

  const typescript = [...ctx.interfaces.values()].filter(Boolean).join("\n\n") + "\n";
  return { typescript, rootName };
}

function zodExprOf(type: InferredType, path: string[], ctx: GenContext): string {
  switch (type.kind) {
    case "string":
      return "z.string()";
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
      const name = pascalCase(path.join(" "));
      registerZodSchema(name, type.fields, ctx);
      return `${name}Schema`;
    }
  }
}

function registerZodSchema(
  name: string,
  fields: Record<string, FieldType>,
  ctx: GenContext
): void {
  const schemaName = `${name}Schema`;
  if (ctx.interfaces.has(schemaName)) return;
  ctx.interfaces.set(schemaName, "");
  const lines = Object.entries(fields).map(([key, field]) => {
    let expr = zodExprOf(field.type, [name, key], ctx);
    if (field.optional) expr += ".optional()";
    return `  ${keyLiteral(key)}: ${expr},`;
  });
  ctx.interfaces.set(
    schemaName,
    `export const ${schemaName} = z.object({\n${lines.join("\n")}\n});`
  );
}

/** Render an inferred type tree into one or more exported Zod schemas. */
export function generateZodSchema(
  type: InferredType,
  options: GenerateOptions = {}
): GenerateResult {
  const rootName = options.rootName ?? "Root";
  const ctx: GenContext = { interfaces: new Map(), rootName };

  if (type.kind === "object") {
    registerZodSchema(rootName, type.fields, ctx);
  } else {
    const expr = zodExprOf(type, [rootName], ctx);
    ctx.interfaces.set(`${rootName}Schema`, `export const ${rootName}Schema = ${expr};`);
  }

  const body = [...ctx.interfaces.values()].filter(Boolean).join("\n\n");
  const typescript = `import { z } from "zod";\n\n${body}\n`;
  return { typescript, rootName };
}
