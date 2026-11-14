/**
 * 업데이트 확인 (src/update-check.ts): installed runtime version vs gh (GitHub main) → marketplace clone fallback, semver
 * compare, the 10-minute cache and GET /api/update-check (?refresh=1). File reads and gh are injected — no real gh / network.
 */
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const uc = await import("../src/update-check.js");
const { NED_HOME } = await import("../src/paths.js");
const { loadConfig } = await import("../src/config.js");
type Deps = import("../src/update-check.js").UpdateDeps;

const request = (p: string) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`)));

const RUNTIME = "/rt";
const CLAUDE = "/cc";
const ENV = { NED_RUNTIME_DIR: RUNTIME, CLAUDE_CONFIG_DIR: CLAUDE } as NodeJS.ProcessEnv;
const manifest = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "ned", version, repository: "https://github.com/HuanSuh/ned", ...extra });
const RUNTIME_PLUGIN = path.join(RUNTIME, ".claude-plugin", "plugin.json");
const RUNTIME_MARKET = path.join(RUNTIME, ".claude-plugin", "marketplace.json");
const MARKET_PLUGIN = path.join(CLAUDE, "plugins", "marketplaces", "ned", ".claude-plugin", "plugin.json");

/** raw.githubusercontent.com unreachable (the default here, so the gh / marketplace cases below stay as they were). */
const RAW_DOWN: Deps["fetchText"] = async () => ({ status: 0, text: "", err: "getaddrinfo ENOTFOUND raw.githubusercontent.com" });
const RAW_URL = "https://raw.githubusercontent.com/HuanSuh/ned/main/.claude-plugin/plugin.json";

/** Files keyed by absolute path; gh answers with `gh`, raw with `raw`. Records every gh / fetch call. */
function deps(files: Record<string, string>, gh: Deps["gh"] = async () => ({ code: 0, out: manifest("0.3.0"), err: "", missing: false }), raw: Deps["fetchText"] = RAW_DOWN) {
  const calls: string[][] = [];
  const fetches: { url: string; timeoutMs: number }[] = [];
  const d: Deps = {
    readFile: (p) => files[p] ?? null,
    fetchText: async (url, timeoutMs) => { fetches.push({ url, timeoutMs }); return raw(url, timeoutMs); },
    gh: async (args) => { calls.push(args); return gh(args); },
  };
  return { d, calls, fetches };
}
const installed = (v = "0.2.0") => ({ [RUNTIME_PLUGIN]: manifest(v), [RUNTIME_MARKET]: JSON.stringify({ name: "ned" }) });

describe("compareSemver (pure)", () => {
  it("orders by major, minor, patch numerically", () => {
    expect(uc.compareSemver("0.10.0", "0.9.9")).toBe(1);
    expect(uc.compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(uc.compareSemver("1.2.3", "1.3.0")).toBe(-1);
    expect(uc.compareSemver("v2.0.0", "1.99.99")).toBe(1);
  });
  it("a pre-release sorts before its release; numeric identifiers compare as numbers", () => {
    expect(uc.compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(uc.compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(uc.compareSemver("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(uc.compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(uc.compareSemver("1.0.0+build.5", "1.0.0")).toBe(0);
  });
  it("not semver → null", () => {
    expect(uc.compareSemver("0.2", "0.2.0")).toBeNull();
    expect(uc.compareSemver("latest", "0.2.0")).toBeNull();
  });
});

describe("repoSlug (pure)", () => {
  it("reads repository (string or {url}) or homepage on github.com", () => {
    expect(uc.repoSlug({ repository: "https://github.com/HuanSuh/ned" })).toBe("HuanSuh/ned");
    expect(uc.repoSlug({ repository: { url: "git@github.com:acme/tool.git" } })).toBe("acme/tool");
    expect(uc.repoSlug({ homepage: "https://github.com/a/b/" })).toBe("a/b");
    expect(uc.repoSlug({ repository: "https://gitlab.com/a/b" })).toBeNull();
    expect(uc.repoSlug(null)).toBeNull();
  });
});

describe("runUpdateCheck", () => {
  it("raw.githubusercontent.com answers → source raw, gh never called, 5 s timeout, no note", async () => {
    const { d, calls, fetches } = deps(installed("0.2.0"), undefined, async () => ({ status: 200, text: manifest("0.4.0") }));
    const r = await uc.runUpdateCheck(d, ENV);
    expect(r).toMatchObject({ current: "0.2.0", latest: "0.4.0", source: "raw", update_available: true, repo: "HuanSuh/ned" });
    expect(r.error).toBeUndefined();
    expect(r.note).toBeUndefined();
    expect(fetches).toEqual([{ url: RAW_URL, timeoutMs: 5_000 }]);
    expect(calls).toHaveLength(0);
  });

  it("raw fails (HTTP 404 / no version / throws) → gh, raw's reason kept as a note", async () => {
    for (const raw of [
      async () => ({ status: 404, text: "" }),
      async () => ({ status: 200, text: "<html>captive portal</html>" }),
      async () => { throw new Error("boom"); },
    ] as Deps["fetchText"][]) {
      const { d, calls } = deps(installed("0.2.0"), undefined, raw);
      const r = await uc.runUpdateCheck(d, ENV);
      expect(r).toMatchObject({ latest: "0.3.0", source: "github", update_available: true });
      expect(r.error).toBeUndefined();
      expect(r.note).toMatch(/^raw: /);
      expect(calls).toHaveLength(1);
    }
  });

  it("raw down → gh answers → source github, update available, repo slug from plugin.json in the gh path", async () => {
    const { d, calls } = deps(installed("0.2.0"));
    const r = await uc.runUpdateCheck(d, ENV);
    expect(r).toMatchObject({ current: "0.2.0", latest: "0.3.0", source: "github", update_available: true, repo: "HuanSuh/ned" });
    expect(r.error).toBeUndefined();
    expect(r.note).toContain("ENOTFOUND");
    expect(r.steps).toEqual(["/plugin update ned", "/reload-plugins", "/ned:install"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("repos/HuanSuh/ned/contents/.claude-plugin/plugin.json?ref=main");
  });

  it("raw and gh both fail → local marketplace clone, both reasons in the note", async () => {
    const { d } = deps({ ...installed("0.2.0"), [MARKET_PLUGIN]: manifest("0.2.5") },
      async () => ({ code: 1, out: "", err: "", missing: true }), async () => ({ status: 0, text: "", err: "timeout 5s" }));
    const r = await uc.runUpdateCheck(d, ENV);
    expect(r).toMatchObject({ latest: "0.2.5", source: "marketplace", update_available: true });
    expect(r.error).toBeUndefined();
    expect(r.note).toBe("raw: timeout 5s · gh: 설치 안 됨 (brew install gh)");
  });

  it("same version → no update", async () => {
    const { d } = deps(installed("0.3.0"));
    expect(await uc.runUpdateCheck(d, ENV)).toMatchObject({ current: "0.3.0", latest: "0.3.0", update_available: false });
  });

  it("installed newer than main (dev build) → no update", async () => {
    const { d } = deps(installed("0.4.0-rc.1"));
    expect((await uc.runUpdateCheck(d, ENV)).update_available).toBe(false);
  });

  it("gh fails (not logged in) → marketplace clone fallback, gh's reason kept as a note", async () => {
    const { d } = deps({ ...installed("0.2.0"), [MARKET_PLUGIN]: manifest("0.2.1") },
      async () => ({ code: 1, out: "", err: "gh: Not Found (HTTP 404)", missing: false }));
    const r = await uc.runUpdateCheck(d, ENV);
    expect(r).toMatchObject({ latest: "0.2.1", source: "marketplace", update_available: true });
    expect(r.error).toBeUndefined();
    expect(r.note).toMatch(/404.*gh auth login/);
  });

  it("gh not installed → marketplace fallback too", async () => {
    const { d } = deps({ ...installed(), [MARKET_PLUGIN]: manifest("0.2.0") }, async () => ({ code: 1, out: "", err: "", missing: true }));
    expect(await uc.runUpdateCheck(d, ENV)).toMatchObject({ source: "marketplace", update_available: false });
  });

  it("both fail → latest null, error names both reasons, no update", async () => {
    const { d } = deps(installed(), async () => ({ code: 4, out: "", err: "To get started with GitHub CLI, please run:  gh auth login", missing: false }));
    const r = await uc.runUpdateCheck(d, ENV);
    expect(r).toMatchObject({ current: "0.2.0", latest: null, source: null, update_available: false });
    expect(r.error).toContain("raw:");
    expect(r.error).toContain("gh:");
    expect(r.error).toContain("마켓플레이스:");
    expect(r.error).toContain(MARKET_PLUGIN);
  });

  it("no GitHub repository in plugin.json → gh is not called, marketplace still tried", async () => {
    const { d, calls } = deps({ [RUNTIME_PLUGIN]: JSON.stringify({ name: "ned", version: "0.2.0" }), [MARKET_PLUGIN]: manifest("0.2.0") });
    const r = await uc.runUpdateCheck(d, ENV);
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ source: "marketplace", repo: null });
  });

  it("marketplace dir follows marketplace.json name", async () => {
    const other = path.join(CLAUDE, "plugins", "marketplaces", "acme-market", ".claude-plugin", "plugin.json");
    const { d } = deps({ [RUNTIME_PLUGIN]: manifest("0.2.0"), [RUNTIME_MARKET]: JSON.stringify({ name: "acme-market" }), [other]: manifest("0.5.0") },
      async () => ({ code: 1, out: "", err: "boom", missing: false }));
    expect(await uc.runUpdateCheck(d, ENV)).toMatchObject({ latest: "0.5.0", source: "marketplace" });
  });

  it("no installed runtime → error about the installed version (latest still read)", async () => {
    const { d } = deps({});
    const r = await uc.runUpdateCheck(d, { ...ENV, NED_RUNTIME_DIR: "/nowhere" });
    // REPO_ROOT (the checkout the daemon runs from) is the fallback — not in the fake fs either.
    expect(r.current).toBeNull();
    expect(r.update_available).toBe(false);
    expect(r.error).toContain("설치된 버전을 못 읽음");
  });

  it("non-semver latest → error, no update", async () => {
    const { d } = deps(installed(), async () => ({ code: 0, out: manifest("next"), err: "", missing: false }));
    const r = await uc.runUpdateCheck(d, ENV);
    expect(r.update_available).toBe(false);
    expect(r.error).toContain("semver");
  });

  it("runtimeDir: NED_RUNTIME_DIR, else $NED_HOME/runtime", () => {
    expect(uc.runtimeDir({ NED_RUNTIME_DIR: "/x" } as NodeJS.ProcessEnv)).toBe("/x");
    expect(uc.runtimeDir({} as NodeJS.ProcessEnv)).toBe(path.join(NED_HOME, "runtime"));
  });
});

describe("GET /api/update-check (cache)", () => {
  beforeAll(() => { startServer(() => loadConfig()); });
  let ghCalls = 0; // counts raw fetches (the first source) — gh must not be reached
  let version = "0.3.0";
  beforeEach(() => {
    ghCalls = 0; version = "0.3.0";
    const rt = uc.runtimeDir();
    uc.setUpdateDeps({
      readFile: (p) => (p === path.join(rt, ".claude-plugin", "plugin.json") ? manifest("0.2.0") : null),
      fetchText: async () => { ghCalls++; return { status: 200, text: manifest(version) }; },
      gh: async () => { throw new Error("gh must not run when raw answers"); },
    });
  });
  afterEach(() => uc.setUpdateDeps(null));

  it("answers the check, then serves the cache for 10 minutes; ?refresh=1 looks again", async () => {
    const r1 = await (await request("/api/update-check")).json();
    expect(r1).toMatchObject({ current: "0.2.0", latest: "0.3.0", source: "raw", update_available: true });
    version = "0.4.0";
    const r2 = await (await request("/api/update-check")).json();
    expect(r2.latest).toBe("0.3.0");
    expect(ghCalls).toBe(1);
    const r3 = await (await request("/api/update-check?refresh=1")).json();
    expect(r3.latest).toBe("0.4.0");
    expect(ghCalls).toBe(2);
  });

  it("the cache expires after UPDATE_CACHE_MS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await request("/api/update-check");
      vi.setSystemTime(Date.now() + uc.UPDATE_CACHE_MS + 1);
      await request("/api/update-check");
      expect(ghCalls).toBe(2);
    } finally { vi.useRealTimers(); }
  });
});
