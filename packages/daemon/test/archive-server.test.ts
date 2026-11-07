/**
 * 설정 → 아카이브 over HTTP: PUT /api/config { archive } validation (bad / ~/.ned / repo vaults refused), GET
 * /api/archive/status (badge + last error), POST /api/archive/flush. Temp vault only; no port is bound.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { loadConfig } = await import("../src/config.js");
const { CONFIG_PATH, NED_HOME, localDay } = await import("../src/paths.js");
const { ARCHIVE_STATE_PATH, REPO_ROOT } = await import("../src/vault.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const put = (body: unknown) => request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ned-vault-srv-"));
const V = path.join(tmpRoot, "vault");
afterAll(() => {
  if (tmpRoot.startsWith(path.join(os.tmpdir(), "ned-vault-srv-"))) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeAll(() => {
  startServer(() => loadConfig());
});
beforeEach(() => {
  fs.mkdirSync(path.join(V, ".obsidian"), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
  fs.rmSync(ARCHIVE_STATE_PATH, { force: true });
});

describe("PUT /api/config { archive }", () => {
  it("defaults are in GET /api/config", async () => {
    const c = await (await request("/api/config")).json();
    expect(c.archive).toMatchObject({ enabled: false, vault: "", folder: "Ned", daily_embed: false });
  });

  it("refuses a missing folder, ~/.ned, the repo, and enabling without a vault (400, nothing saved)", async () => {
    for (const vault of [path.join(tmpRoot, "nope"), NED_HOME, path.join(REPO_ROOT, "docs"), "relative/dir"]) {
      const r = await put({ archive: { vault } });
      expect(r.status, vault).toBe(400);
      expect((await r.json()).field).toBe("archive.vault");
    }
    expect((await put({ archive: { enabled: true } })).status).toBe(400);
    expect(loadConfig().archive.vault).toBe("");
  });

  it("accepts a real vault (partial patch keeps the rest) and an unchanged vault is not re-checked", async () => {
    const r = await put({ archive: { enabled: true, vault: V, include: { sessions: true } } });
    expect(r.status).toBe(200);
    const a = loadConfig().archive;
    expect(a).toMatchObject({ enabled: true, vault: V, folder: "Ned", include: { briefings: true, sessions: true } });
    expect((await put({ archive: { folder: "Log/Ned" } })).status).toBe(200);
    expect(loadConfig().archive.folder).toBe("Log/Ned");
  });
});

describe("GET /api/archive/status · POST /api/archive/flush", () => {
  it("off → flush 409", async () => {
    const r = await request("/api/archive/flush", { method: "POST" });
    expect(r.status).toBe(409);
  });

  it("status shows the vault badge; flush writes today's report and links it", async () => {
    await put({ archive: { enabled: true, vault: V } });
    let s = await (await request("/api/archive/status")).json();
    expect(s.check).toMatchObject({ ok: true, obsidian: true });
    expect(s.today_url).toBeNull();
    const r = await request("/api/archive/flush", { method: "POST" });
    expect(r.status).toBe(200);
    const day = localDay();
    expect(fs.existsSync(path.join(V, "Ned", "Daily", day.slice(0, 7), `${day}.md`))).toBe(true);
    s = (await r.json()).status;
    expect(s.last_write_at).toBeTypeOf("number");
    expect(s.today_url).toBe(`obsidian://open?vault=vault&file=${encodeURIComponent(`Ned/Daily/${day.slice(0, 7)}/${day}`)}`);
  });

  it("a vault that went away → flush 500 with the error in status.last_error", async () => {
    await put({ archive: { enabled: true, vault: V } });
    fs.rmSync(V, { recursive: true, force: true });
    const r = await request("/api/archive/flush", { method: "POST" });
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.status.last_error).toMatch(/볼트 확인 실패/);
    expect(j.status.check.ok).toBe(false);
  });
});
