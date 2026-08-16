#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { inferFromSamples, mergeTypes, toSamples, type InferredType } from "./infer.js";
import { generateTypeScript, generateZodSchema } from "./generate.js";

/**
 * Exposes typesherlock's core engine (no CLI/stdin coupling) to MCP clients
 * (Claude Code, etc.) as a tool call, so an agent that hits an undocumented
 * JSON API can get accurate types directly — deterministic, cached across
 * calls, zero tokens spent reasoning out a shape by hand — instead of
 * pasting raw JSON into its own context to work out types inline.
 */

const server = new McpServer({ name: "typesherlock", version: "0.1.0" });

function readCache(cacheFile: string): InferredType | null {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8")) as InferredType;
  } catch {
    return null;
  }
}

server.registerTool(
  "generate_types",
  {
    title: "Generate TypeScript types from JSON",
    description:
      "Deterministically generate a TypeScript interface (and optionally a Zod " +
      "schema) from one or more real JSON samples — no AI, no guessing. Pass a " +
      "JSON array of sample objects (e.g. a success response and an error " +
      "response) instead of a single object to get accurate optional-field, " +
      "union, and closed-set-enum detection from real cross-sample evidence.",
    inputSchema: {
      json: z
        .string()
        .describe(
          "Raw JSON to infer types from: a single object/array, or a JSON " +
            "array of sample objects to merge for richer detection"
        ),
      name: z.string().optional().describe('Name for the root type (default: "Root")'),
      zod: z
        .boolean()
        .optional()
        .describe("Also emit a Zod schema alongside the TS interface"),
      cacheFile: z
        .string()
        .optional()
        .describe(
          "Path to a local file to merge this call's evidence with (and update) " +
            "— accuracy accumulates across separate calls against the same endpoint"
        ),
    },
  },
  async ({ json, name, zod, cacheFile }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Input is not valid JSON: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }

    const newType = inferFromSamples(toSamples(parsed));
    const cached = cacheFile ? readCache(cacheFile) : null;
    const inferred = cached ? mergeTypes(cached, newType) : newType;
    if (cacheFile) {
      try {
        writeFileSync(cacheFile, JSON.stringify(inferred), "utf8");
      } catch {
        // Cache is a bonus, not a requirement — an unwritable path shouldn't fail the call.
      }
    }

    const rootName = name ?? "Root";
    const parts = [generateTypeScript(inferred, { rootName }).typescript.trimEnd()];
    if (zod) {
      parts.push(generateZodSchema(inferred, { rootName }).typescript.trimEnd());
    }

    return { content: [{ type: "text", text: parts.join("\n\n") + "\n" }] };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`typesherlock-mcp: ${err?.message ?? err}\n`);
  process.exit(1);
});
