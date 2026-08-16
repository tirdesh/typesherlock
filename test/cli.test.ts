import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
      JSON.stringify([
        { ok: true, data: 1 },
        { ok: false, error: "x" },
      ]),
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

describe("CLI --cache", () => {
  let dir: string;
  let cacheFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "typesherlock-test-"));
    cacheFile = path.join(dir, "cache.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accumulates evidence across separate invocations", () => {
    const out1 = runCli(JSON.stringify({ status: "active" }), [
      "--name",
      "Resp",
      "--cache",
      cacheFile,
    ]);
    expect(out1).toContain("status: string;");

    const out2 = runCli(JSON.stringify({ status: "pending" }), [
      "--name",
      "Resp",
      "--cache",
      cacheFile,
    ]);
    expect(out2).toContain('status: "active" | "pending";');
  });

  it("continues (with a warning) instead of crashing on a corrupt cache file", () => {
    writeFileSync(cacheFile, "not json");
    const out = runCli(JSON.stringify({ id: 1 }), ["--name", "X", "--cache", cacheFile]);
    expect(out).toContain("export interface X {");
  });
});
