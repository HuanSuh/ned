/**
 * 보내기 규칙 / 자동 검토 through the routes (serve mocked, no port; NED_SEND_DRY_RUN=1 — nothing is really sent):
 * POST /api/send confirm → 409 need_confirm → same body + confirm_token → 202 → done; expired / changed body → asked
 * again; block → 403 with the note; review warn (injected) issues / none / timeout; sessions not reviewed; every
 * attempt in sent-actions.log; /api/calendar/events too; PUT /api/config validates actions.rules.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const { CONFIG_PATH, EVENTS_DIR, localDay } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG, _setSessionOrca, readActionLog } = await import("../src/actions.js");
const { _resetSendJobs } = await import("../src/send-jobs.js");
const { _setSendReviewer } = await import("../src/send-review.js");
const { CONFIRM_TTL_MS } = await import("../src/send-guard.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = async (p: string, body: unknown) => {
  const r = await request(p, json("POST", body));
  return { status: r.status, data: await r.json() };
};
async function waitJob(id: string, route = "/api/send") {
  for (let i = 0; i < 100; i++) {
    const j = await (await request(`${route}/${id}`)).json();
    if (j.state === "done") return j;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`job ${id} never finished`);
}
const writeConfig = (actions: Record<string, unknown>) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions: { slack_send: true, gmail_send: true, session_send: true, calendar_create: true, ...actions } }));

const slackBody = (over: Record<string, unknown> = {}) => ({ source: "slack", mode: "send", text: "배포 끝났어요", ref: { url: "https://acme.slack.com/archives/C0GEN/p1700000000000100", title: "#general · 김철수" }, origin: "card", ...over });

beforeAll(() => {
  startServer(() => loadConfig());
});
beforeEach(() => {
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  _resetSendJobs();
  _setSendReviewer();
  _setSessionOrca();
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/send — confirm rule", () => {
  it("409 need_confirm (reasons, token) → the same body + confirm_token → 202 → done; every step logged", async () => {
    writeConfig({ rules: [{ source: "slack", target: "#general", effect: "confirm", note: "전체 채널 — 한 번 더" }] });
    const first = await post("/api/send", slackBody());
    expect(first.status).toBe(409);
    expect(first.data).toMatchObject({ ok: false, need_confirm: true, reasons: [expect.stringContaining("전체 채널 — 한 번 더")] });
    expect(typeof first.data.confirm_token).toBe("string");
    expect(readActionLog(1)[0]).toMatchObject({ action: "need_confirm", ok: false, rule: { index: 0, effect: "confirm" } });

    const second = await post("/api/send", { ...slackBody(), confirm_token: first.data.confirm_token });
    expect(second.status).toBe(202);
    const done = await waitJob(second.data.job_id);
    expect(done.result.action).toMatch(/^dry_run:slack/);
    const log = readActionLog(2);
    expect(log[0]).toMatchObject({ confirmed: true, rule: { effect: "confirm" }, origin: "card" });
    expect(log[1].action).toBe("need_confirm");
  });

  it("a changed text after confirming → asked again (token mismatch), nothing sent", async () => {
    writeConfig({ rules: [{ source: "slack", effect: "confirm" }] });
    const first = await post("/api/send", slackBody());
    const again = await post("/api/send", { ...slackBody({ text: "배포 끝났어요!!" }), confirm_token: first.data.confirm_token });
    expect(again.status).toBe(409);
    expect(again.data).toMatchObject({ need_confirm: true, token_problem: "mismatch" });
    expect(readActionLog(5).every((e) => e.action === "need_confirm")).toBe(true);
  });

  it("an expired token (> 5 min) → asked again", async () => {
    writeConfig({ rules: [{ source: "slack", effect: "confirm" }] });
    const first = await post("/api/send", slackBody());
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + CONFIRM_TTL_MS + 5_000);
    const late = await post("/api/send", { ...slackBody(), confirm_token: first.data.confirm_token });
    expect(late.status).toBe(409);
    expect(late.data.token_problem).toBe("expired");
  });

  it("no rule, review off → 202 at once (today's behaviour, no confirm)", async () => {
    writeConfig({});
    const r = await post("/api/send", slackBody());
    expect(r.status).toBe(202);
  });
});

describe("block rule and switch order", () => {
  it("block → 403 with the rule's note, logged as refused", async () => {
    writeConfig({ rules: [{ source: "mail", target: "@partner.io", effect: "block", note: "파트너사엔 Ned 로 안 보냄" }] });
    const r = await post("/api/send", { source: "email", mode: "send", text: "안녕하세요", ref: { message_id: "m1", title: "견적 — 김 <kim@partner.io>" } });
    expect(r.status).toBe(403);
    expect(r.data.error).toContain("파트너사엔 Ned 로 안 보냄");
    expect(readActionLog(1)[0]).toMatchObject({ action: "refused", rule: { effect: "block" } });
  });

  it("the switch comes first: off → refused by the switch even with an allow rule", async () => {
    writeConfig({ slack_send: false, rules: [{ source: "*", effect: "allow" }] });
    const r = await post("/api/send", slackBody());
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/slack_send is off/);
  });

  it("external rule: outside internal_domains → confirm; inside → straight through", async () => {
    writeConfig({ internal_domains: ["acme.com"], rules: [{ source: "mail", external: true, effect: "confirm", note: "회사 밖" }] });
    const out = await post("/api/send", { source: "email", mode: "send", text: "hi", ref: { message_id: "m2", title: "x — <kim@partner.io>" } });
    expect(out.status).toBe(409);
    const inside = await post("/api/send", { source: "email", mode: "send", text: "hi", ref: { message_id: "m3", title: "x — <lee@acme.com>" } });
    expect(inside.status).toBe(202);
  });
});

describe("review warn (injected reviewer — no claude)", () => {
  it("issues → 409 with review.issues; then the token sends without reviewing again", async () => {
    writeConfig({ review: "warn" });
    let calls = 0;
    _setSendReviewer(async () => { calls++; return { status: "issues", issues: [{ kind: "commitment", detail: "\"내일까지\" 약속" }] }; });
    const first = await post("/api/send", slackBody({ text: "내일까지 드릴게요" }));
    expect(first.status).toBe(409);
    expect(first.data.reasons).toEqual([]);
    expect(first.data.review.issues).toEqual([{ kind: "commitment", detail: "\"내일까지\" 약속" }]);
    expect(readActionLog(1)[0]).toMatchObject({ action: "need_confirm", review: { status: "issues" } });
    const second = await post("/api/send", { ...slackBody({ text: "내일까지 드릴게요" }), confirm_token: first.data.confirm_token });
    expect(second.status).toBe(202);
    await waitJob(second.data.job_id);
    expect(calls).toBe(1);
  });

  it("no issues → 202, the review result is logged with the send", async () => {
    writeConfig({ review: "warn" });
    _setSendReviewer(async () => ({ status: "ok", issues: [] }));
    const r = await post("/api/send", slackBody());
    expect(r.status).toBe(202);
    await waitJob(r.data.job_id);
    expect(readActionLog(1)[0].review).toEqual({ status: "ok", issues: [] });
  });

  it("timeout → sent anyway with '검토 못 함'", async () => {
    writeConfig({ review: "warn" });
    _setSendReviewer(() => new Promise(() => {}), 30);
    const r = await post("/api/send", slackBody());
    expect(r.status).toBe(202);
    const done = await waitJob(r.data.job_id);
    expect(done.result.detail).toContain("검토 못 함");
    expect(readActionLog(1)[0].review).toMatchObject({ status: "failed" });
  });

  it("session replies are not reviewed (rules still apply)", async () => {
    writeConfig({ review: "warn" });
    let calls = 0;
    _setSendReviewer(async () => { calls++; return { status: "issues", issues: [{ kind: "tone", detail: "x" }] }; });
    fs.writeFileSync(path.join(EVENTS_DIR, `${localDay(new Date())}.jsonl`), JSON.stringify({ event: "SessionStart", ts: Date.now() - 1000, session_id: "sess-9", cwd: "/w/hotfix-1", orca_pane: "tab1:leaf1" }) + "\n");
    const calls2: string[][] = [];
    _setSessionOrca(async (args) => {
      calls2.push(args);
      return args[1] === "list" ? { ok: true, json: { result: { terminals: [{ handle: "term_1", tabId: "tab1", leafId: "leaf1" }] } }, err: "" } : { ok: true, json: { ok: true }, err: "" };
    });
    const r = await post("/api/send", { source: "session", mode: "session", text: "ㄱㄱ", ref: { session_id: "sess-9" }, origin: "session" });
    expect(r.status).toBe(202);
    expect((await waitJob(r.data.job_id)).result.ok).toBe(true);
    expect(calls).toBe(0);
    // …but a confirm rule on that worktree holds it
    writeConfig({ rules: [{ source: "session", target: "hotfix-*", effect: "confirm", note: "핫픽스 세션" }] });
    _resetSendJobs();
    const held = await post("/api/send", { source: "session", mode: "session", text: "계속", ref: { session_id: "sess-9" }, origin: "session" });
    expect(held.status).toBe(409);
    expect(held.data.reasons[0]).toContain("핫픽스 세션");
  });
});

describe("POST /api/calendar/events and PUT /api/config", () => {
  it("calendar create: a confirm rule on attendees → 409, then token → 202", async () => {
    writeConfig({ rules: [{ source: "calendar", target: "@client.com", effect: "confirm" }] });
    const body = { title: "킥오프", date: "2026-11-20", start_time: "10:00", end_time: "10:30", attendees: ["a@client.com"] };
    const first = await post("/api/calendar/events", body);
    expect(first.status).toBe(409);
    const second = await post("/api/calendar/events", { ...body, confirm_token: first.data.confirm_token });
    expect(second.status).toBe(202);
  });

  it("PUT /api/config: bad actions.rules → 400; good ones saved normalized", async () => {
    writeConfig({});
    const cur = await (await request("/api/config")).json();
    const bad = await request("/api/config", json("PUT", { actions: { rules: [{ source: "fax", effect: "block" }] }, if_updated_at: cur.updated_at }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe("actions.rules");
    const ok = await request("/api/config", json("PUT", { actions: { rules: [{ source: "slack", target: " #general ", effect: "confirm" }], internal_domains: ["@Acme.com"], review: "warn" }, if_updated_at: cur.updated_at }));
    expect(ok.status).toBe(200);
    const saved = await ok.json();
    expect(saved.actions).toMatchObject({ slack_send: true, rules: [{ source: "slack", target: "#general", effect: "confirm" }], internal_domains: ["acme.com"], review: "warn" });
  });
});
