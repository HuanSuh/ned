/**
 * Settings save safety: partial PUT /api/config (deep merge, other keys untouched), if_updated_at → 409 { current },
 * config backups (rotation + restore), the per-key change log, and build_id on /api/state + /api/config.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer, mergeConfigPatch } = await import("../src/server.js");
const { CONFIG_BACKUP_KEEP, configBackupDir, configChanges, configUpdatedAt, deepMerge, listConfigBackups, loadConfig, logValue, saveConfig } = await import("../src/config.js");
const { CONFIG_PATH, LOGS_DIR } = await import("../src/paths.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (body: unknown) => request("/api/config", json("PUT", body));
const getCfg = async () => (await request("/api/config")).json();
const daemonLog = () => { try { return fs.readFileSync(path.join(LOGS_DIR, "daemon.log"), "utf8"); } catch { return ""; } };
const writeYaml = (o: unknown) => fs.writeFileSync(CONFIG_PATH, YAML.stringify(o));

beforeAll(() => {
  startServer(() => loadConfig());
});
beforeEach(() => {
  fs.rmSync(configBackupDir(), { recursive: true, force: true });
  writeYaml({ notify: "off", claude_model: "claude-opus-5-5", heartbeat_minutes: 7, reply_tone: "짧게", notifications: { enabled: true, sound: false } });
});

describe("deepMerge / configChanges (pure)", () => {
  it("objects merge per key, arrays and null replace, absent keys stay", () => {
    const base = { a: 1, o: { x: 1, y: { z: 1, w: 2 } }, arr: [1, 2], q: { start: "23:00", end: "08:00" } };
    expect(deepMerge(base, { o: { y: { z: 9 } }, arr: [3], q: null })).toEqual({ a: 1, o: { x: 1, y: { z: 9, w: 2 } }, arr: [3], q: null });
    expect(deepMerge(base, {})).toEqual(base);
    expect(deepMerge({ q: null }, { q: { start: "1" } })).toEqual({ q: { start: "1" } });
  });
  it("configChanges: leaf paths, arrays whole; logValue clamps to 200", () => {
    expect(configChanges({ a: 1, o: { x: [1], y: 2 } }, { a: 1, o: { x: [1, 2], y: 2 }, n: "new" })).toEqual([
      { key: "o.x", from: [1], to: [1, 2] },
      { key: "n", from: undefined, to: "new" },
    ]);
    expect(logValue("x".repeat(500))).toHaveLength(200);
    expect(logValue({ a: 1 })).toBe('{"a":1}');
    expect(logValue(null)).toBe("null");
  });
  it("mergeConfigPatch keeps everything the patch doesn't name", () => {
    const cur = loadConfig();
    const m = mergeConfigPatch(cur, { notifications: { kinds: { slack: false } } } as never);
    expect(m.claude_model).toBe("claude-opus-5-5");
    expect(m.notifications.kinds.slack).toBe(false);
    expect(m.notifications.kinds.email).toBe(true);
    expect(m.notifications.sound).toBe(false);
  });
});

describe("partial PUT /api/config", () => {
  it("a one-key PUT leaves every other key as it was (incl. claude_model, nested notifications)", async () => {
    const before = await getCfg();
    const r = await put({ heartbeat_minutes: 15 });
    expect(r.status).toBe(200);
    const after = await r.json();
    expect(after.heartbeat_minutes).toBe(15);
    expect(after.claude_model).toBe("claude-opus-5-5");
    expect(after.reply_tone).toBe("짧게");
    expect(after.notifications).toEqual(before.notifications);
    const { heartbeat_minutes: _a, updated_at: _b, ...restA } = before;
    const { heartbeat_minutes: _c, updated_at: _d, ...restB } = after;
    expect(restB).toEqual(restA);
    expect(YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")).claude_model).toBe("claude-opus-5-5");
  });

  it("nested sub-key PUT: sources / notifications.kinds / actions merge per key", async () => {
    const a = await (await put({ sources: { slack: false }, notifications: { kinds: { jira: false } }, actions: { slack_send: true } })).json();
    expect(a.sources).toMatchObject({ slack: false, gmail: true, jira: true });
    expect(a.notifications.kinds).toMatchObject({ jira: false, slack: true });
    expect(a.notifications.sound).toBe(false);
    expect(a.actions).toMatchObject({ slack_send: true, gmail_draft: true });
  });

  it("dashboard.slack_team_id: a valid id saves (upper-cased) without touching the layout keys; junk → 400, nothing written", async () => {
    const ok = await put({ dashboard: { slack_team_id: "t0abc1234" } });
    expect(ok.status).toBe(200);
    const a = await ok.json();
    expect(a.dashboard.slack_team_id).toBe("T0ABC1234");
    expect(a.dashboard.theme).toBe("system");
    const before = fs.readFileSync(CONFIG_PATH, "utf8");
    const bad = await put({ dashboard: { slack_team_id: "acme-workspace" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "dashboard.slack_team_id" });
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe(before);
    const cleared = await (await put({ dashboard: { slack_team_id: "" } })).json();
    expect(cleared.dashboard.slack_team_id).toBe("");
  });

  it("dashboard.slack_team_domain: saves lower-cased; junk → 400 with its field, nothing written", async () => {
    const ok = await (await put({ dashboard: { slack_team_domain: "Acme.slack.com" } })).json();
    expect(ok.dashboard.slack_team_domain).toBe("acme");
    const before = fs.readFileSync(CONFIG_PATH, "utf8");
    const bad = await put({ dashboard: { slack_team_domain: "acme corp" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "dashboard.slack_team_domain" });
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe(before);
  });

  it("GET/PUT carry updated_at (config.yaml mtime) and build_id; every save moves updated_at", async () => {
    const g = await getCfg();
    expect(g.updated_at).toBe(configUpdatedAt());
    expect(typeof g.build_id).toBe("string");
    const p1 = await (await put({ heartbeat_minutes: 11 })).json();
    const p2 = await (await put({ heartbeat_minutes: 12 })).json();
    expect(p1.updated_at).toBeGreaterThan(g.updated_at);
    expect(p2.updated_at).toBeGreaterThan(p1.updated_at);
    expect(YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")).updated_at).toBeUndefined(); // never persisted
    expect((await (await request("/api/state")).json()).build_id).toBe(g.build_id);
  });
});

describe("if_updated_at → 409", () => {
  it("matching token saves; a stale token gets 409 { current } and writes nothing", async () => {
    const g = await getCfg();
    const ok = await put({ heartbeat_minutes: 20, if_updated_at: g.updated_at });
    expect(ok.status).toBe(200);
    const saved = await ok.json();
    expect(saved.if_updated_at).toBeUndefined();
    // the old page saves with the token it rendered from
    const r = await put({ claude_model: null, if_updated_at: g.updated_at });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.current.heartbeat_minutes).toBe(20);
    expect(body.current.claude_model).toBe("claude-opus-5-5");
    expect(body.current.updated_at).toBe(saved.updated_at);
    expect(loadConfig().claude_model).toBe("claude-opus-5-5");
    // retry with the fresh token goes through
    expect((await put({ claude_model: null, if_updated_at: body.current.updated_at })).status).toBe(200);
    expect(loadConfig().claude_model).toBeNull();
  });

  it("a hand edit of config.yaml after the page loaded also counts as a conflict", async () => {
    const g = await getCfg();
    writeYaml({ notify: "off", claude_model: "hand-edited" });
    fs.utimesSync(CONFIG_PATH, new Date(g.updated_at + 5000), new Date(g.updated_at + 5000));
    const r = await put({ heartbeat_minutes: 3, if_updated_at: g.updated_at });
    expect(r.status).toBe(409);
    expect((await r.json()).current.claude_model).toBe("hand-edited");
  });

  it("no if_updated_at (older page / home layout save) → plain merge", async () => {
    await put({ heartbeat_minutes: 30 });
    expect((await put({ dashboard: { locked: true } })).status).toBe(200);
    expect(loadConfig().heartbeat_minutes).toBe(30);
  });

  it("400 on a non-object body", async () => {
    expect((await put([1, 2])).status).toBe(400);
    expect((await request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
  });
});

describe("change log", () => {
  it("one line per changed key with old → new; arrays / objects as JSON; long values clamped", async () => {
    const mark = daemonLog().length;
    await put({ heartbeat_minutes: 9, claude_model: null, filters: { slack: { exclude_channels: ["#rand"] } }, reply_tone: "y".repeat(300) });
    const lines = daemonLog().slice(mark).split("\n").filter((l) => l.includes(" config: "));
    expect(lines.some((l) => l.endsWith("config: heartbeat_minutes 7 → 9"))).toBe(true);
    expect(lines.some((l) => l.endsWith("config: claude_model claude-opus-5-5 → null"))).toBe(true);
    expect(lines.some((l) => l.endsWith('config: filters.slack.exclude_channels [] → ["rand"]'))).toBe(true);
    const tone = lines.find((l) => l.includes("config: reply_tone "))!;
    expect(tone.split(" → ")[1]).toHaveLength(200);
    expect(lines.some((l) => l.includes("config: notifications"))).toBe(false); // untouched keys aren't logged
  });
  it("a no-op PUT logs nothing", async () => {
    const mark = daemonLog().length;
    await put({ heartbeat_minutes: 7 });
    expect(daemonLog().slice(mark)).not.toContain("config: heartbeat_minutes");
  });
});

describe("backups + restore", () => {
  it("each save copies the previous file; only the newest CONFIG_BACKUP_KEEP are kept, newest first", async () => {
    for (let i = 1; i <= CONFIG_BACKUP_KEEP + 3; i++) saveConfig({ ...loadConfig(), heartbeat_minutes: 100 + i });
    const list = listConfigBackups();
    expect(list).toHaveLength(CONFIG_BACKUP_KEEP);
    expect(fs.readdirSync(configBackupDir())).toHaveLength(CONFIG_BACKUP_KEEP);
    for (const b of list) expect(b.name).toMatch(/^config-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?\.yaml$/);
    // newest backup holds the state right before the last save (heartbeat 100 + KEEP + 2)
    const newest = YAML.parse(fs.readFileSync(path.join(configBackupDir(), list[0].name), "utf8"));
    expect(newest.heartbeat_minutes).toBe(100 + CONFIG_BACKUP_KEEP + 2);
    const oldest = YAML.parse(fs.readFileSync(path.join(configBackupDir(), list.at(-1)!.name), "utf8"));
    expect(oldest.heartbeat_minutes).toBe(100 + 3);
  });

  it("GET /api/config/backups lists them; POST /api/config/restore brings one back (current one backed up first)", async () => {
    await put({ claude_model: null, heartbeat_minutes: 44 });
    const list = await (await request("/api/config/backups")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: expect.any(String), at: expect.any(Number), size: expect.any(Number) });
    const r = await request("/api/config/restore", json("POST", { name: list[0].name }));
    expect(r.status).toBe(200);
    const restored = await r.json();
    expect(restored.claude_model).toBe("claude-opus-5-5");
    expect(restored.heartbeat_minutes).toBe(7);
    expect(typeof restored.updated_at).toBe("number");
    expect(loadConfig().claude_model).toBe("claude-opus-5-5");
    const after = listConfigBackups();
    expect(after).toHaveLength(2);
    expect(YAML.parse(fs.readFileSync(path.join(configBackupDir(), after[0].name), "utf8")).heartbeat_minutes).toBe(44);
    expect(daemonLog()).toContain(`config: restored ${list[0].name}`);
  });

  it("restore rejects traversal / unknown names", async () => {
    expect((await request("/api/config/restore", json("POST", { name: "../config.yaml" }))).status).toBe(400);
    expect((await request("/api/config/restore", json("POST", { name: "config-2020-01-01T00-00-00-000Z.yaml" }))).status).toBe(404);
    expect((await request("/api/config/restore", json("POST", {}))).status).toBe(400);
  });
});

describe("prototype pollution", () => {
  it('a {"__proto__": …} / constructor PUT is ignored and Object.prototype stays clean', async () => {
    const body = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},"notifications":{"__proto__":{"polluted":3}},"heartbeat_minutes":13}';
    const r = await request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.heartbeat_minutes).toBe(13);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(Object.keys(j)).not.toContain("constructor");
    expect(YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8"))).not.toHaveProperty("polluted");
    const m = deepMerge({ a: 1 }, JSON.parse('{"__proto__":{"polluted":4},"prototype":{"x":1}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
    expect(m).toEqual({ a: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("first save with no config.yaml yet", () => {
  it("PUT without a prior GET doesn't 409 on the file loadConfig creates", async () => {
    fs.rmSync(CONFIG_PATH, { force: true });
    const r = await put({ heartbeat_minutes: 21 });
    expect(r.status).toBe(200);
    expect(loadConfig().heartbeat_minutes).toBe(21);
  });
});
