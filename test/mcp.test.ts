import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MCP_SERVER = fileURLToPath(new URL("../dist/mcp.js", import.meta.url));

describe("MCP server (real client, real subprocess, real stdio transport)", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({ command: "node", args: [MCP_SERVER] });
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists the generate_types tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("generate_types");
  });

  it("generates a TS interface from a single JSON sample", async () => {
    const result = await client.callTool({
      name: "generate_types",
      arguments: { json: JSON.stringify({ id: 1, name: "Ada" }), name: "User" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("export interface User {");
    expect(text).toContain("id: number;");
  });

  it("detects an enum from multiple samples, matching CLI behavior", async () => {
    const result = await client.callTool({
      name: "generate_types",
      arguments: {
        json: JSON.stringify([{ status: "active" }, { status: "pending" }]),
        name: "Resp",
        zod: true,
      },
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/status: "active" \| "pending"|status: "pending" \| "active"/);
    expect(text).toContain("z.enum([");
  });

  it("returns an error result for invalid JSON instead of throwing", async () => {
    const result = await client.callTool({
      name: "generate_types",
      arguments: { json: "not json" },
    });
    expect(result.isError).toBe(true);
  });
});
