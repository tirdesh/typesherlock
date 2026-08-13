import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(input: string, args: string[] = []): string {
  return execFileSync("node", [CLI, ...args], { input, encoding: "utf8" });
}

describe("CLI end-to-end", () => {
  it("prints a TS interface for a simple object", () => {
    const out = runCli(JSON.stringify({ id: 1, name: "Ada" }), ["--name", "User"]);
    expect(out).toContain("export interface User {");
    expect(out).toContain("id: number;");
  });

  it("emits zod schema alongside TS when --zod is passed", () => {
    const out = runCli(JSON.stringify({ id: 1 }), ["--name", "User", "--zod"]);
    expect(out).toContain("export interface User {");
    expect(out).toContain("export const UserSchema = z.object({");
  });

  it("merges an array of sample objects into one type", () => {
    const out = runCli(
      JSON.stringify([{ ok: true, data: 1 }, { ok: false, error: "x" }]),
      ["--name", "Resp"]
    );
    expect(out).toContain("data?: number;");
    expect(out).toContain("error?: string;");
  });

  it("errors cleanly on invalid JSON", () => {
    expect(() => runCli("not json")).toThrow();
  });

  it("errors cleanly on an unrecognized flag instead of silently ignoring it", () => {
    expect(() => runCli(JSON.stringify({ id: 1 }), ["--bogus"])).toThrow();
  });

  it("errors cleanly when a flag that needs a value is given none", () => {
    expect(() => runCli(JSON.stringify({ id: 1 }), ["--name"])).toThrow();
  });
});
