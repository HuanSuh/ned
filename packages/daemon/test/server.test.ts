/**
 * HTTP routes without a network: @hono/node-server's `serve` is mocked to capture the Hono `fetch` handler,
 * so startServer never binds a port. Requests go straight into the app (same as Hono's app.request()).
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
const { loadConfig } = await import("../src/config.js");
const { CONFIG_PATH } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG } = await import("../src/actions.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Poll GET /api/send/:id until the job is done (NED_NO_LLM jobs finish within a tick or two). */
async function waitJob(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await request(`/api/send/${id}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    if (j.state === "done") return j;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`job ${id} never finished`);
}
const setActions = (actions: Record<string, boolean>) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions }));

beforeAll(() => {
  startServer(() => loadConfig());
  expect(captured.fetch).toBeTypeOf("function");
});

describe("POST /api/send gating", () => {
  beforeEach(() => fs.rmSync(SENT_ACTIONS_LOG, { force: true }));

  it("400 on a bad body", async () => {
    const r = await request("/api/send", json("POST", { source: "slack", mode: "gmail_draft", text: "hi" }));
    expect(r.status).toBe(400);
  });

  it("403 when slack_send is off (default) and logs the refusal", async () => {
    setActions({ slack_send: false });
    const r = await request("/api/send", json("POST", { source: "slack", mode: "send", text: "hello", ref: { url: "https://x.slack.com/archives/C1/p1700000000000100" } }));
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body).toMatchObject({ ok: false, action: "refused" });
    expect(body.error).toContain("slack_send");
    const log = fs.readFileSync(SENT_ACTIONS_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source: "slack", action: "refused", ok: false });
  });

  it("403 for gmail_send off and session_send off", async () => {
    setActions({ gmail_send: false, session_send: false });
    expect((await request("/api/send", json("POST", { source: "email", mode: "send", text: "x", ref: { thread_id: "t" } }))).status).toBe(403);
    expect((await request("/api/send", json("POST", { source: "session", mode: "session", text: "x", ref: { session_id: "s" } }))).status).toBe(403);
  });

  it("enabled gmail_draft passes the gate; NED_NO_LLM makes it a logged dry run (no claude spawned)", async () => {
    setActions({ gmail_draft: true });
    const r = await request("/api/send", json("POST", { source: "email", mode: "gmail_draft", text: "draft body", ref: { thread_id: "t1", message_id: "<m1@x>" } }));
    expect(r.status).toBe(202);
    const started = await r.json();
    expect(started).toMatchObject({ ok: true, reused: false });
    expect(started.job_id).toBeTypeOf("string");
    const done = await waitJob(started.job_id);
    expect(done.state).toBe("done");
    expect(done.elapsed_ms).toBeGreaterThanOrEqual(0);
    const body = done.result;
    expect(body.ok).toBe(false);
    expect(body.http_status).toBe(200);
    expect(body.action).toMatch(/^dry_run:/);
    const entry = JSON.parse(fs.readFileSync(SENT_ACTIONS_LOG, "utf8").trim());
    expect(entry.claude_args).toContain("dontAsk");
    expect(entry.claude_args).toContain("mcp__claude_ai_Gmail__create_draft");
  });

  it("session_send on but no Orca pane recorded → 409 before touching orca", async () => {
    setActions({ session_send: true });
    const r = await request("/api/send", json("POST", { source: "session", mode: "session", text: "go", ref: { session_id: "nopane" } }));
    expect(r.status).toBe(202);
    const done = await waitJob((await r.json()).job_id);
    expect(done.result).toMatchObject({ ok: false, http_status: 409, action: "session_send" });
    expect(done.result.error).toContain("orca_pane");
  });

  it("GET /api/send/:job_id → 404 for an unknown (or pre-restart) job", async () => {
    const r = await request("/api/send/nope");
    expect(r.status).toBe(404);
    expect((await r.json()).error).toContain("/api/actions");
  });

  it("an ok send of the same draft logged in the last 10 min → 409 already_sent with the link (survives a restart)", async () => {
    setActions({ slack_send: true });
    const entry = { ts: new Date().toISOString(), source: "slack", mode: "send", action: "slack_message C1", ref: { channel: "C1" }, draft_id: "d-sent", text: "hi", ok: true, result: "https://x.slack.com/archives/C1/p1700000000000200 ($0.010)" };
    fs.writeFileSync(SENT_ACTIONS_LOG, JSON.stringify(entry) + "\n");
    const r = await request("/api/send", json("POST", { draft_id: "d-sent", source: "slack", mode: "send", text: "hi again", ref: { channel: "C1" } }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, already_sent: true, link: "https://x.slack.com/archives/C1/p1700000000000200" });
    // an older send (>10 min) does not block
    fs.writeFileSync(SENT_ACTIONS_LOG, JSON.stringify({ ...entry, ts: new Date(Date.now() - 11 * 60_000).toISOString() }) + "\n");
    const again = await request("/api/send", json("POST", { draft_id: "d-sent", source: "slack", mode: "send", text: "hi again", ref: { channel: "C1" } }));
    expect(again.status).toBe(202);
    await waitJob((await again.json()).job_id);
  });

  it("GET /api/actions returns the log newest first", async () => {
    setActions({ slack_send: false });
    await request("/api/send", json("POST", { source: "slack", mode: "send", text: "one", ref: { channel: "C1" } }));
    await request("/api/send", json("POST", { source: "slack", mode: "send", text: "two", ref: { channel: "C1" } }));
    const list = await (await request("/api/actions")).json();
    expect(list.map((e: { text: string }) => e.text)).toEqual(["two", "one"]);
  });
});

describe("other routes", () => {
  it("todos CRUD over HTTP", async () => {
    expect((await request("/api/todos", json("POST", { title: "" }))).status).toBe(400);
    const created = await (await request("/api/todos", json("POST", { title: "http todo" }))).json();
    expect(created.title).toBe("http todo");
    expect((await request(`/api/todos/${created.id}`, json("PATCH", { done: true }))).status).toBe(200);
    expect((await request(`/api/todos/${created.id}`, json("PATCH", { title: " " }))).status).toBe(400);
    expect((await request(`/api/todos/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await request(`/api/todos/${created.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("PUT /api/config merges filters per source and ignores unknown persona", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", persona: "alfred", filters: { jira: { exclude_projects: ["MNT"] } } }));
    const r = await (await request("/api/config", json("PUT", { persona: "nobody", filters: { slack: { exclude_channels: ["#rand"] } } }))).json();
    expect(r.persona).toBe("alfred");
    expect(r.filters.jira.exclude_projects).toEqual(["MNT"]);
    expect(r.filters.slack.exclude_channels).toEqual(["rand"]);
  });

  it("POST /api/attention/:id/review → 404 for unknown attention, ok for a source key", async () => {
    expect((await request("/api/attention/nope/review", { method: "POST" })).status).toBe(404);
    const r = await request(`/api/attention/${encodeURIComponent("jira:APP-1")}/review`, json("POST", { reviewed: true }));
    expect(r.status).toBe(200);
    expect((await r.json()).reviewed_at).toBeTypeOf("number");
  });

  it("POST /api/draft 400 on bad source", async () => {
    expect((await request("/api/draft", json("POST", { source: "fax" }))).status).toBe(400);
  });

  it("static file traversal is rejected", async () => {
    expect((await request("/..%2f..%2fpackage.json")).status).toBe(404);
    expect((await request("/.env")).status).toBe(404);
  });
});
