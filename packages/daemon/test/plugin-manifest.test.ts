/**
 * Claude Code plugin packaging (.claude-plugin/plugin.json + marketplace.json at the repo root, hooks/hooks.json,
 * commands/*.md). `claude plugin validate .` is the authoritative check (docs/RELEASE.md runs it before a release);
 * this test keeps the shape from drifting in CI where the claude CLI isn't installed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const SEMVER = /^\d+\.\d+\.\d+$/;

describe("plugin manifests", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const market = readJson(".claude-plugin/marketplace.json");

  it("plugin.json has name ned, a semver version and metadata", () => {
    expect(plugin.name).toBe("ned");
    expect(plugin.version).toMatch(SEMVER);
    expect(typeof plugin.description).toBe("string");
    expect(plugin.author?.name).toBeTruthy();
    expect(() => new URL(plugin.homepage)).not.toThrow();
  });

  it("marketplace.json lists this repo's root as the one plugin, with no version of its own (plugin.json wins)", () => {
    expect(market.name).toBe("ned");
    expect(market.owner?.name).toBeTruthy();
    expect(market.plugins).toHaveLength(1);
    const [entry] = market.plugins;
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe("./");
    expect(entry.version).toBeUndefined();
  });
});
