/**
 * Never the real ~/.ned under test: src/paths.ts throws at import when NED_HOME resolves to <homedir>/.ned while
 * VITEST / NODE_ENV=test / NED_NO_LLM=1 is set (a vitest run without test/setup.ts once overwrote the user's config).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const { assertSafeNedHome, NED_HOME } = await import("../src/paths.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("assertSafeNedHome", () => {
  const home = "/Users/someone";
  it("throws for <homedir>/.ned under vitest, NODE_ENV=test or NED_NO_LLM=1", () => {
    for (const env of [{ VITEST: "true" }, { NODE_ENV: "test" }, { NED_NO_LLM: "1" }]) {
      expect(() => assertSafeNedHome(`${home}/.ned`, env, home)).toThrow(/refusing to use the real/);
      expect(() => assertSafeNedHome(`${home}/.ned/`, env, home)).toThrow();
      expect(() => assertSafeNedHome(`${home}/x/../.ned`, env, home)).toThrow();
      expect(() => assertSafeNedHome(undefined, env, home)).toThrow(/set NED_HOME to a temp dir/); // not set at all
      expect(() => assertSafeNedHome("", env, home)).toThrow();
      expect(() => assertSafeNedHome("/tmp/ned-test-x", env, home)).not.toThrow(); // temp NED_HOME passes
    }
  });
  it("allows the real home outside tests", () => {
    expect(() => assertSafeNedHome("/tmp/ned-test-x", { VITEST: "true" }, home)).not.toThrow();
    expect(() => assertSafeNedHome(`${home}/.ned`, {}, home)).not.toThrow(); // Ned.app: explicit real home, no NED_NO_LLM
    expect(() => assertSafeNedHome(undefined, {}, home)).not.toThrow(); // `ned run` from a shell
    expect(() => assertSafeNedHome(`${home}/.ned`, { NED_NO_LLM: "0" }, home)).not.toThrow();
  });
  it("this run's NED_HOME is the temp one from test/setup.ts", () => {
    expect(NED_HOME).not.toBe(path.join(os.homedir(), ".ned"));
    expect(NED_HOME.startsWith(os.tmpdir())).toBe(true);
  });
  it("importing src/paths.ts with no NED_HOME under VITEST fails before touching anything (fake HOME)", () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "ned-guard-"));
    try {
      fs.mkdirSync(path.join(fake, ".ned"));
      const env = { ...process.env, HOME: fake, VITEST: "true" } as NodeJS.ProcessEnv;
      delete env.NED_HOME;
      const r = spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./src/paths.ts'); console.log('imported')"], { cwd: root, env, encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("refusing to use the real ~/.ned in a test/stub run");
      expect(r.stdout).not.toContain("imported");
      expect(fs.readdirSync(path.join(fake, ".ned"))).toEqual([]);
    } finally {
      if (fake.startsWith(os.tmpdir())) fs.rmSync(fake, { recursive: true, force: true });
    }
  });
});
