/**
 * 시작하기 (src/setup-check.ts): the claude `system/init` line → per-source status, gh / signing / Slack 팀 ID, the
 * one-minute cache, and GET /api/setup · POST /api/setup/dismiss. Probes are stubbed — no claude, gh or security runs.
 */
import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { DEFAULT_CONFIG, loadConfig } = await import("../src/config.js");
const { CONFIG_PATH } = await import("../src/paths.js");
const sc = await import("../src/setup-check.js");
type Deps = import("../src/setup-check.js").SetupDeps;
type Server = import("../src/setup-check.js").McpServer;

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));

// A real init line (trimmed) as `claude -p --output-format stream-json --verbose` prints it.
const INIT = JSON.stringify({
  type: "system", subtype: "init", session_id: "s1", tools: ["Bash"],
  mcp_servers: [
    { name: "plugin:oh-my-claudecode:t", status: "connected", source: "plugin" },
    { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai" },
    { name: "claude.ai Google Calendar", status: "connected", source: "claudeai" },
    { name: "claude.ai slack", status: "connected", source: "claudeai" },
    { name: "claude.ai Atlassian", status: "failed", source: "claudeai" },
  ],
});
const servers = (): Server[] => sc.parseInitLine(INIT)!;

const cfg = (over: Partial<typeof DEFAULT_CONFIG["sources"]> = {}, team = "") => ({
  ...DEFAULT_CONFIG,
  sources: { ...DEFAULT_CONFIG.sources, ...over },
  dashboard: { ...DEFAULT_CONFIG.dashboard, slack_team_id: team },
});
const VALID = '  1) ABC "Ned Local Signing"\n     1 valid identities found\n';
const stub = (o: Partial<Deps> = {}): Deps => ({
  probeMcp: async () => servers(),
  ghAuth: async () => true,
  identities: async () => VALID,
  sleep: async () => {},
  ...o,
});

describe("parseInitLine / serverStatus", () => {
  it("reads the MCP server list only from a system/init line", () => {
    expect(servers().map((s) => s.name)).toContain("claude.ai Gmail");
    expect(sc.parseInitLine(JSON.stringify({ type: "system", subtype: "hook_started" }))).toBeNull();
    expect(sc.parseInitLine("not json")).toBeNull();
    expect(sc.parseInitLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
  });

  it("maps connected / needs-auth / pending / other / absent (names case-insensitive)", () => {
    const s: Server[] = [...servers(), { name: "claude.ai Pending", status: "pending" }];
    expect(sc.serverStatus(s, "claude.ai Slack").status).toBe("connected");
    expect(sc.serverStatus(s, "claude.ai Gmail").status).toBe("needs-auth");
    expect(sc.serverStatus(s, "claude.ai Pending").status).toBe("pending");
    expect(sc.serverStatus(s, "claude.ai Atlassian")).toEqual({ status: "error", detail: "failed" });
    expect(sc.serverStatus(s, "Sentry").status).toBe("not-connected");
    // A longer name that starts with the table's name + " " still matches; a mere prefix of a word does not.
    expect(sc.serverStatus([{ name: "claude.ai Atlassian Rovo", status: "connected" }], "claude.ai Atlassian").status).toBe("connected");
    expect(sc.serverStatus([{ name: "claude.ai Gmailx", status: "connected" }], "claude.ai Gmail").status).toBe("not-connected");
  });

  it("one table covers every config.sources key", () => {
    expect(sc.SETUP_SOURCES.map((s) => s.key).sort()).toEqual(Object.keys(DEFAULT_CONFIG.sources).sort());
  });
});

describe("runSetupCheck", () => {
  it("checks only enabled sources, with a fix per broken one", async () => {
    const r = await sc.runSetupCheck(cfg({ sentry: false }, "T0ABC1234"), stub());
    expect(r.sources.map((s) => [s.key, s.status])).toEqual([
      ["slack", "connected"], ["gmail", "needs-auth"], ["calendar", "connected"], ["jira", "error"], ["github", "connected"],
    ]);
    expect(r.sources.find((s) => s.key === "gmail")?.fix?.url).toBe(sc.CONNECTORS_URL);
    expect(r.sources.find((s) => s.key === "slack")?.fix).toBeUndefined();
    expect(r.slack_team_id).toEqual({ status: "ok", value: "T0ABC1234" });
    expect(r.signing.status).toBe("ok");
    expect(r.signing.command).toMatch(/scripts\/make-signing-cert\.sh$/);
    expect(r.complete).toBe(false);
  });

  it("complete when everything enabled is fine; no probe at all when only GitHub is on", async () => {
    const probeMcp = vi.fn(async () => servers());
    const r = await sc.runSetupCheck(cfg({ slack: false, gmail: false, calendar: false, jira: false, sentry: false }), stub({ probeMcp }));
    expect(probeMcp).not.toHaveBeenCalled();
    expect(r.slack_team_id.status).toBe("n/a");
    expect(r.complete).toBe(true);
  });

  it("re-probes once when a wanted connector is still pending", async () => {
    let n = 0;
    const sleep = vi.fn(async () => {});
    const probeMcp = vi.fn(async (): Promise<Server[]> => (n++ === 0 ? [{ name: "claude.ai Gmail", status: "pending" }] : [{ name: "claude.ai Gmail", status: "connected" }]));
    const r = await sc.runSetupCheck(cfg({ slack: false, calendar: false, jira: false, github: false, sentry: false }), stub({ probeMcp, sleep }));
    expect(sleep).toHaveBeenCalledOnce();
    expect(r.sources).toEqual([expect.objectContaining({ key: "gmail", status: "connected" })]);
  });

  it("still pending after the second look → pending", async () => {
    const probeMcp = async (): Promise<Server[]> => [{ name: "claude.ai Gmail", status: "pending" }];
    const r = await sc.runSetupCheck(cfg({ slack: false, calendar: false, jira: false, github: false, sentry: false }), stub({ probeMcp }));
    expect(r.sources[0].status).toBe("pending");
  });

  it("a fast start-up without any claude.ai server falls back to the full args", async () => {
    const probeMcp = vi.fn(async (fast: boolean): Promise<Server[]> => (fast ? [] : servers()));
    const r = await sc.runSetupCheck(cfg({ sentry: false }), stub({ probeMcp }));
    expect(probeMcp.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(r.sources.find((s) => s.key === "slack")?.status).toBe("connected");
  });

  it("probe failure → error with the reason; gh missing / logged out; signing untrusted / missing", async () => {
    const r = await sc.runSetupCheck(cfg(), stub({
      probeMcp: async () => { throw new Error("spawn claude: ENOENT"); },
      ghAuth: async () => null,
      identities: async (valid) => (valid ? "0 valid identities found" : VALID),
    }));
    expect(r.sources.find((s) => s.key === "gmail")).toMatchObject({ status: "error", detail: "spawn claude: ENOENT" });
    expect(r.sources.find((s) => s.key === "github")).toMatchObject({ status: "not-connected", fix: { command: "gh auth login" } });
    expect(r.signing.status).toBe("untrusted");
    const r2 = await sc.runSetupCheck(cfg(), stub({ ghAuth: async () => false, identities: async () => "" }));
    expect(r2.sources.find((s) => s.key === "github")?.status).toBe("needs-auth");
    expect(r2.signing.status).toBe("missing");
    expect(r2.slack_team_id.status).toBe("missing");
  });

  it("formatSetupCheck prints one line per item", async () => {
    const out = sc.formatSetupCheck(await sc.runSetupCheck(cfg(), stub({ identities: async () => "" })));
    expect(out).toMatch(/✗ Gmail\s+인증 필요 → .*claude\.ai\/settings\/connectors/);
    expect(out).toMatch(/✓ Slack\s+연결됨/);
    expect(out).toMatch(/✗ Slack 팀 ID/);
    expect(out).toMatch(/✗ 코드 서명 .*make-signing-cert\.sh/);
  });
});

describe("GET /api/setup · POST /api/setup/dismiss", () => {
  let probeMcp: ReturnType<typeof vi.fn>;
  beforeAll(() => { startServer(() => loadConfig()); });
  beforeEach(() => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { sentry: false } }));
    fs.rmSync(sc.ONBOARDING_PATH, { force: true });
    probeMcp = vi.fn(async () => servers());
    sc.setSetupDeps(stub({ probeMcp }));
  });

  it("answers the checklist + onboarding state, cached until ?refresh=1", async () => {
    const r = await request("/api/setup");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.sources.map((s: { key: string }) => s.key)).toEqual(["slack", "gmail", "calendar", "jira", "github"]);
    expect(j.onboarding).toEqual({ dismissed_at: null });
    await request("/api/setup");
    expect(probeMcp).toHaveBeenCalledTimes(1);
    await request("/api/setup?refresh=1");
    expect(probeMcp).toHaveBeenCalledTimes(2);
  });

  it("a config change (team id saved) is not served from the stale cache", async () => {
    expect((await (await request("/api/setup")).json()).slack_team_id.status).toBe("missing");
    const put = await request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ dashboard: { slack_team_id: "T0ABC1234" } }) });
    expect(put.status).toBe(200);
    expect((await (await request("/api/setup")).json()).slack_team_id).toEqual({ status: "ok", value: "T0ABC1234" });
  });

  it("dismiss persists under NED_HOME (not config.yaml) and can be undone", async () => {
    const d = await (await request("/api/setup/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    expect(typeof d.onboarding.dismissed_at).toBe("number");
    expect(fs.existsSync(sc.ONBOARDING_PATH)).toBe(true);
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).not.toMatch(/dismiss/);
    expect((await (await request("/api/setup")).json()).onboarding.dismissed_at).toBe(d.onboarding.dismissed_at);
    const u = await (await request("/api/setup/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dismissed: false }) })).json();
    expect(u.onboarding).toEqual({ dismissed_at: null });
    expect(fs.existsSync(sc.ONBOARDING_PATH)).toBe(false);
  });
});
