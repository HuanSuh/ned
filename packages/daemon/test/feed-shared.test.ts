/**
 * 메시지 피드 — one rule set on both sides. src/feed.ts (GET /api/feed, the desktop pet) and public/app/features/chat-core.js
 * buildFeed (통신기 "메시지" tab) run on the same fixture → the same key · kind list in the same order, same title / detail /
 * url. The browser side also takes `chatNotes` (its own localStorage) — the daemon has none, so the fixture leaves them out.
 * Then: the pet kind mapping, deep links, the route itself and config.pet (defaults · validation · PUT · state mirror).
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import * as daemon from "../src/feed.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import * as client from "../public/app/features/chat-core.js";

const NOW = Date.parse("2026-11-11T09:00:00Z");
const H = 3600_000;
const FIXTURE = {
  state: {
    attention: [
      { id: "session:s1", kind: "session", title: "ned-daemon: 입력 대기", detail: "테스트 돌릴까요?", ts: NOW - 5 * 60_000, source: "sessions" },
      { id: "a-mail", kind: "email", title: "CFO: 정산 자료 요청", detail: "금요일까지", url: "https://mail.google.com/mail/u/0/#inbox/abc", ts: NOW - 30 * 60_000, source: "b1" },
      { id: "a-slack", kind: "slack", title: "#mobile 멘션", url: "https://acme.slack.com/archives/C0123ABCD/p1794193614524359", ts: NOW - 10 * 60_000, source: "b1" },
      { id: "a-jira", kind: "jira", title: "MNT-12 리뷰 요청", ts: NOW - 2 * H, source: "b1" },
      { id: "a-gh", kind: "github", title: "PR #42 리뷰 요청", url: "https://github.com/acme/app/pull/42", ts: NOW - 3 * H, source: "b1" },
      { id: "a-sentry", kind: "sentry", title: "TypeError in checkout", ts: NOW - 4 * H, source: "b1" },
      { id: "a-cal", kind: "calendar", title: "10:00 주간 회의", ts: NOW - 1 * H, source: "b1" },
      { id: "a-other", kind: "other", title: "기타 알림", ts: NOW - 6 * H, source: "b1" },
      { id: "a-done", kind: "slack", title: "이미 확인", ts: NOW - 60_000, source: "b1", reviewed_at: NOW },
      { id: "a-javascript", kind: "email", title: "bad url", url: "javascript:alert(1)", ts: NOW - 7 * H, source: "b1" },
    ],
  },
  briefings: [
    { id: "b-daily", ts: NOW - 20 * 60_000, type: "daily", status: "UPDATE", headline: "오늘 회의 3개, 답할 메일 2통", action_items: [{}, {}] },
    { id: "b-ok", ts: NOW - 15 * 60_000, type: "heartbeat", status: "NED_OK", headline: "조용함" },
    { id: "b-old", ts: NOW - 30 * H, type: "heartbeat", status: "UPDATE", headline: "어제 것" },
    { id: "b-patrol", ts: NOW - 50 * 60_000, type: "heartbeat", status: "UPDATE", headline: "PR 리뷰 요청 1건" },
  ],
  agenda: {
    slack: {
      threads: [
        { key: "C1:111", channel: "#dev", url: "https://acme.slack.com/archives/C0999/p1794193614000001", new_since_me: 2, last_reply_ts: "222", last_reply_at: new Date(NOW - 8 * 60_000).toISOString(), last_reply_from: "kim", last_reply_text: "확인 부탁해요" },
        { key: "C1:333", channel: "#dev", new_since_me: 0, last_reply_at: new Date(NOW).toISOString() },
        // Same url as an open attention item → not twice.
        { key: "C1:444", channel: "#mobile", url: "https://acme.slack.com/archives/C0123ABCD/p1794193614524359", new_since_me: 1, last_reply_at: new Date(NOW).toISOString() },
      ],
    },
  },
};

describe("GET /api/feed rules = 통신기 buildFeed", () => {
  const d = daemon.buildFeed(FIXTURE, NOW);
  const c = client.buildFeed(FIXTURE, new Set(), NOW) as { key: string; kind: string; title: string; detail: string; url: string | null; ts: number }[];

  it("same key · kind list, same order", () => {
    expect(d.map((x) => [x.key, x.kind])).toEqual(c.map((x) => [x.key, x.kind]));
    expect(d.length).toBe(12);
  });
  it("same title · detail · url · ts", () => {
    expect(d.map(({ key, title, detail, url, ts }) => ({ key, title, detail, url, ts }))).toEqual(c.map(({ key, title, detail, url, ts }) => ({ key, title, detail, url, ts })));
  });
  it("drops reviewed, NED_OK, >24h briefings, threads without new replies or duplicating an attention url", () => {
    const keys = d.map((x) => x.key);
    expect(keys).not.toContain("att:a-done");
    expect(keys).not.toContain("brief:b-ok");
    expect(keys).not.toContain("brief:b-old");
    expect(keys.filter((k) => k.startsWith("thr:"))).toEqual(["thr:C1:111@222"]);
    expect(d.find((x) => x.key === "att:a-javascript")?.url).toBeNull();
  });
  it("empty input → []", () => {
    expect(daemon.buildFeed({}, NOW)).toEqual([]);
    expect(client.buildFeed({}, new Set(), NOW)).toEqual([]);
  });
});

describe("pet kind mapping", () => {
  it("attention kind / briefing / thread → pet.messages toggle; other → none (always shown)", () => {
    const m = Object.fromEntries(daemon.buildFeed(FIXTURE, NOW).map((x) => [x.kind, x.pet_kind]));
    expect(m).toEqual({ session: "session", email: "mail", slack: "slack", thread: "slack", jira: "jira", github: "github", sentry: "sentry", calendar: "calendar", briefing: "briefing", other: null });
    expect(daemon.petKindOf("something-new")).toBeNull();
  });
  it("deep = the 링크 열기 rules (config.dashboard)", () => {
    const on = { open_links_in_app: true, open_links_in_app_by_service: { slack: true, figma: true, notion: true }, slack_team_id: "T0ABC1234" };
    const d = daemon.buildFeed(FIXTURE, NOW, on);
    expect(d.find((x) => x.key === "att:a-slack")?.deep).toBe("slack://channel?team=T0ABC1234&id=C0123ABCD&message=1794193614.524359");
    expect(d.find((x) => x.key === "att:a-gh")?.deep).toBeNull();
    expect(daemon.buildFeed(FIXTURE, NOW, { ...on, open_links_in_app: false }).find((x) => x.key === "att:a-slack")?.deep).toBeNull();
    expect(daemon.buildFeed(FIXTURE, NOW).every((x) => x.deep === null)).toBe(true);
  });
});

// ---------- route + config ----------
const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));
const { startServer } = await import("../src/server.js");
const { DEFAULT_PET, PET_MESSAGE_KINDS, loadConfig, normalizePet } = await import("../src/config.js");
const { AGENDA_PATH, BRIEFINGS_DIR, CONFIG_PATH, STATE_PATH } = await import("../src/paths.js");
const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const put = (body: unknown) => request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => { startServer(() => loadConfig()); });

describe("config.pet", () => {
  it("defaults: off, every message kind on; 9 kinds", () => {
    expect(PET_MESSAGE_KINDS).toEqual(["greeting", "session", "slack", "mail", "jira", "github", "sentry", "calendar", "briefing"]);
    expect(DEFAULT_PET.enabled).toBe(false);
    expect(Object.values(DEFAULT_PET.messages).every(Boolean)).toBe(true);
  });
  it("normalizePet: booleans only, unknown kinds dropped, partial patch over base", () => {
    expect(normalizePet({ enabled: "yes", messages: { slack: 0, bogus: false } })).toEqual(DEFAULT_PET);
    const p = normalizePet({ enabled: true, messages: { mail: false } });
    expect(p.enabled).toBe(true);
    expect(p.messages.mail).toBe(false);
    expect(normalizePet({ messages: { slack: false } }, p)).toEqual({ enabled: true, messages: { ...p.messages, slack: false } });
    expect(Object.keys(normalizePet(null).messages)).toEqual([...PET_MESSAGE_KINDS]);
  });
  it("config.yaml without pet → defaults; a hand-written partial pet is filled in", () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
    expect(loadConfig().pet).toEqual(DEFAULT_PET);
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", pet: { enabled: true, messages: { greeting: false } } }));
    expect(loadConfig().pet).toEqual({ enabled: true, messages: { ...DEFAULT_PET.messages, greeting: false } });
  });
  it("PUT /api/config {pet} saves (merged), mirrors into state.json, and GET /api/feed returns it", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
    let r = await put({ pet: { enabled: true } });
    expect(r.status).toBe(200);
    expect((await r.json()).pet).toEqual({ ...DEFAULT_PET, enabled: true });
    r = await put({ pet: { messages: { slack: false, nope: true } } });
    const body = await r.json();
    expect(body.pet).toEqual({ enabled: true, messages: { ...DEFAULT_PET.messages, slack: false } });
    expect(YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")).pet.messages.slack).toBe(false);
    expect(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")).pet).toEqual(body.pet);
    // The pet's 숨기기: only pet.enabled, with the if_updated_at rule.
    r = await put({ pet: { enabled: false }, if_updated_at: body.updated_at });
    expect(r.status).toBe(200);
    expect((await r.json()).pet.messages.slack).toBe(false);
    expect((await put({ pet: { enabled: true }, if_updated_at: body.updated_at })).status).toBe(409);
    const f = await (await request("/api/feed")).json();
    expect(f.pet).toEqual({ enabled: false, messages: { ...DEFAULT_PET.messages, slack: false } });
  });
});

describe("GET /api/feed", () => {
  it("items from state.json · briefings · agenda (slack off → no threads), with pet_kind and quiet", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", dashboard: { slack_team_id: "T0ABC1234" } }));
    const now = Date.now();
    const shift = (ts: number) => ts - NOW + now;
    const st = { ...FIXTURE.state, attention: FIXTURE.state.attention.map((a) => ({ ...a, ts: shift(a.ts), ...(a.reviewed_at ? { reviewed_at: now } : {}) })), sessions: [], quiet: true, updated_at: now };
    fs.writeFileSync(STATE_PATH, JSON.stringify(st));
    fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });
    for (const f of fs.readdirSync(BRIEFINGS_DIR)) if (f.endsWith(".json")) fs.rmSync(path.join(BRIEFINGS_DIR, f));
    for (const b of FIXTURE.briefings) fs.writeFileSync(path.join(BRIEFINGS_DIR, `${b.id}.json`), JSON.stringify({ ...b, ts: shift(b.ts), updates: [], fyi: [], action_items: b.action_items ?? [] }));
    const agenda = { slack: { ...FIXTURE.agenda.slack, threads: FIXTURE.agenda.slack.threads.map((t) => ({ ...t, last_reply_at: new Date(shift(Date.parse(t.last_reply_at))).toISOString() })) } };
    fs.writeFileSync(AGENDA_PATH, JSON.stringify(agenda));

    const r = await request("/api/feed");
    expect(r.status).toBe(200);
    const f = await r.json();
    expect(f.quiet).toBe(true);
    expect(f.persona).toBe("ned");
    const want = client.buildFeed({ state: st, briefings: FIXTURE.briefings.map((b) => ({ ...b, ts: shift(b.ts) })), agenda }, new Set(), now) as { key: string; kind: string }[];
    expect(f.items.map((x: { key: string; kind: string }) => [x.key, x.kind])).toEqual(want.map((x) => [x.key, x.kind]));
    expect(f.items.find((x: { key: string }) => x.key === "att:a-slack").deep).toMatch(/^slack:\/\/channel\?team=T0ABC1234/);
    expect(f.items.find((x: { key: string }) => x.key === "att:a-other").pet_kind).toBeNull();

    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { slack: false } }));
    const off = await (await request("/api/feed")).json();
    expect(off.items.some((x: { kind: string }) => x.kind === "thread")).toBe(false);
  });
});
