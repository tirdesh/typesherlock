import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// Must be async (not execFileSync): a synchronous child-process call would
// block this process's event loop, which is also where the local test
// server below needs to run to answer the child's request — a same-process
// deadlock (confirmed while first writing this test).
async function runCli(args: string[]): Promise<{ stdout: string; status: number }> {
  try {
    const { stdout } = await execFileAsync("node", [CLI, ...args]);
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", status: e.code ?? 1 };
  }
}

describe("CLI fetch subcommand", () => {
  let server: Server;
  let baseUrl: string;
  // /characters/1 and /characters/2 return different `status` values so the
  // real evidence-based enum detection has something genuine to work with.
  const responses: Record<string, unknown> = {
    "/characters/1": { id: 1, status: "Alive" },
    "/characters/2": { id: 2, status: "Dead" },
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = responses[req.url ?? ""];
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches full URLs and merges them into one type", async () => {
    const { stdout, status } = await runCli([
      "fetch",
      `${baseUrl}/characters/1`,
      `${baseUrl}/characters/2`,
      "--name",
      "Character",
      "--zod",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('status: "Alive" | "Dead";');
    expect(stdout).toContain('z.enum(["Alive", "Dead"])');
  });

  it("supports a {} template with substituted values", async () => {
    const { stdout, status } = await runCli([
      "fetch",
      `${baseUrl}/characters/{}`,
      "1",
      "2",
      "--name",
      "Character",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('status: "Alive" | "Dead";');
  });

  it("errors cleanly on a non-2xx response instead of silently continuing", async () => {
    const { status } = await runCli([
      "fetch",
      `${baseUrl}/characters/999`,
      "--name",
      "X",
    ]);
    expect(status).not.toBe(0);
  });

  it("errors cleanly when no URLs are given", async () => {
    const { status } = await runCli(["fetch", "--name", "X"]);
    expect(status).not.toBe(0);
  });

  it("errors cleanly when a template has no substitution values", async () => {
    const { status } = await runCli(["fetch", `${baseUrl}/characters/{}`, "--name", "X"]);
    expect(status).not.toBe(0);
  });
});
