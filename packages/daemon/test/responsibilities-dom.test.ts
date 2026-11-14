// @vitest-environment jsdom
/**
 * 맡긴 일 in the dashboard: 설정 → 맡긴 일 (public/app/tabs/settings-responsibilities.js — section + nav link added after
 * 소스, list · 추가 · 편집 · 삭제 · 켜기 · until 끝남 · sources · keywords, saved with the form's PUT /api/config) and the
 * home band (public/app/features/respband.js — only when a responsibility is on, status dot + title + note + links).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../public/app/main.js", () => ({ loadAgenda: () => {}, loadState: async () => {}, renderAll: () => {} }));

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const { mergePatch } = await import("../public/app/features/config-diff.js");
const band = await import("../public/app/features/respband.js");
const resp = await import("../public/app/tabs/settings-responsibilities.js");

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const yesterday = ymd(new Date(Date.now() - 86_400_000));
const tomorrow = ymd(new Date(Date.now() + 86_400_000));

type Cfg = Record<string, unknown> & { updated_at: number; build_id: string; responsibilities?: unknown[] };
const baseCfg = (): Cfg => ({
  port: 7805, heartbeat_minutes: 10, signal_check_minutes: 60, briefing_time: "09:00", agenda_refresh_minutes: 60,
  agenda_source_minutes: { slack: null, mail: null, calendar: null, jira: null, github: null },
  quiet_hours: { start: "23:00", end: "08:00" }, sources: { slack: true, gmail: true },
  filters: { slack: { exclude_channels: [], watch_channels: [], ack_reactions: ["eyes"] }, jira: { exclude_projects: [] } },
  dashboard: { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 }, layout: null, locked: false, watch_cards: true, theme: "system" },
  notifications: { enabled: true, kinds: { session: true, email: true, slack: true, jira: true, github: true, sentry: true, calendar: true }, briefing: true, summary_threshold: 3, quiet_delivery: "skip", sound: true },
  actions: { slack_send: false, gmail_draft: true }, reply_tone: "짧게", reply_tone_by_source: { slack: null, email: null, session: null },
  claude_model: null, claude_max_turns: 25, agenda_daily_budget_usd: 15,
  responsibilities: [
    { id: "rel-05-ab12", title: "0.5 릴리스 막히는 것", goal: "릴리스를 막는 이슈", sources: ["jira", "github"], keywords: ["0.5"], until: tomorrow, enabled: true },
    { id: "old-1", title: "지난 분기 정리", goal: "", until: yesterday, enabled: true },
  ],
  updated_at: 1000, build_id: "b1",
});

describe("respBandHtml (pure)", () => {
  const now = Date.now();
  it("no responsibility switched on → no band", () => {
    expect(band.respBandHtml([], {})).toBe("");
    expect(band.respBandHtml(undefined, undefined)).toBe("");
    expect(band.respBandHtml([{ id: "a", title: "t", enabled: false }], {})).toBe("");
  });

  it("dot + label per status, note, links (http only, ≤ 3), time; unrated → 평가 전; past until → 끝남", () => {
    const html = band.respBandHtml([
      { id: "a", title: "릴리스", goal: "g", enabled: true },
      { id: "b", title: "고객 A", goal: "", enabled: true },
      { id: "c", title: "새 일", goal: "", enabled: true },
      { id: "d", title: "끝난 일", until: yesterday, enabled: true },
      { id: "e", title: "<script>", goal: "", enabled: true },
    ], {
      a: { status: "blocked", note: "REL-9 빌드가 깨졌어.", urls: ["https://x.example/REL-9", "javascript:alert(1)", "https://x.example/2", "https://x.example/3", "https://x.example/4"], updated_at: now - 5 * 60_000 },
      b: { status: "watch", note: "답이 늦어.", urls: [], updated_at: now },
      d: { status: "on_track", note: "옛 평가", urls: ["https://x.example/old"], updated_at: now },
      e: { status: "on_track", note: "<b>ok</b>", urls: [], updated_at: now },
    }, now);
    document.body.innerHTML = `<div>${html}</div>`;
    const row = (id: string) => document.querySelector(`[data-resp="${id}"]`)!;
    expect(row("a").querySelector(".led")!.className).toBe("led r");
    expect(row("a").textContent).toContain("막힘");
    expect(row("a").textContent).toContain("REL-9 빌드가 깨졌어.");
    expect([...row("a").querySelectorAll("a")].map((x) => x.getAttribute("href"))).toEqual(["https://x.example/REL-9", "https://x.example/2", "https://x.example/3"]);
    expect(row("a").querySelector(".rbt")!.textContent).toBe("5분 전");
    expect(row("b").querySelector(".led")!.className).toBe("led a");
    expect(row("c").getAttribute("data-status")).toBe("none");
    expect(row("c").textContent).toContain("평가 전");
    expect(row("d").classList.contains("ended")).toBe(true);
    expect(row("d").textContent).toContain("끝남");
    expect(row("d").querySelectorAll("a")).toHaveLength(0);
    expect(row("e").querySelector(".rbn")!.textContent).toBe("<script>"); // escaped
    expect(row("e").querySelector("b.rbn b")).toBeNull();
  });

  it("link numbers count only the links shown", () => {
    const html = (urls: string[]) => band.respBandHtml([{ id: "a", title: "t", enabled: true }], { a: { status: "watch", note: "", urls, updated_at: now } }, now);
    const labels = (h: string) => { document.body.innerHTML = h; return [...document.querySelectorAll(".rbl")].map((x) => x.textContent); };
    expect(labels(html(["javascript:alert(1)", "https://a.example", "https://b.example"]))).toEqual(["↗1", "↗2"]);
    expect(labels(html(["javascript:alert(1)", "https://a.example"]))).toEqual(["↗"]);
  });
});

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const settled = () => new Promise((r) => setTimeout(r, 0));
let server: Cfg;
const puts: Array<Record<string, unknown>> = [];
let settings: typeof import("../public/app/tabs/settings.js");
let S: { config: Cfg | null; state: Record<string, unknown> | null };
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const rows = () => [...document.querySelectorAll<HTMLElement>("#c-resp .respi")];
const field = (i: number, k: string) => rows()[i].querySelector(`[data-rf="${k}"]`) as HTMLInputElement;
const submit = () => $("cfg").dispatchEvent(new Event("submit", { cancelable: true }));
const typeIn = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };

describe("설정 → 맡긴 일", () => {
  beforeAll(async () => {
    document.body.innerHTML = indexHtml.slice(indexHtml.indexOf("<body"), indexHtml.lastIndexOf("</body>")).replace(/^<body[^>]*>/, "");
    $("v-settings").hidden = false; // jsdom won't focus inside [hidden]
    window.HTMLElement.prototype.scrollIntoView ??= () => {};
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    server = baseCfg();
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/config" && opts?.method === "PUT") {
        const body = JSON.parse(String(opts.body));
        puts.push(body);
        const { if_updated_at: _i, ...patch } = body;
        // the daemon gives new rows an id (src/config.ts normalizeResponsibilities)
        if (Array.isArray(patch.responsibilities)) patch.responsibilities = patch.responsibilities.map((r: { id?: string }, i: number) => ({ id: r.id || `new-${i}`, ...r }));
        server = { ...(mergePatch(server, patch) as Cfg), updated_at: server.updated_at + 1 };
        return res(200, server);
      }
      return res(200, url === "/api/actions" ? [] : {});
    }));
    ({ S } = (await import("../public/app/state.js")) as unknown as { S: typeof S });
    settings = await import("../public/app/tabs/settings.js");
    settings.init();
    S.config = structuredClone(server);
    settings.renderConfig();
  });
  beforeEach(() => { puts.length = 0; });

  it("section + nav link right after 소스; rows from config; past until shows 끝남", () => {
    expect($("s-sources").nextElementSibling!.id).toBe("s-resp");
    const links = [...document.querySelectorAll<HTMLElement>("#s-nav [data-sjump]")].map((a) => a.dataset.sjump);
    expect(links.slice(1, 3)).toEqual(["s-sources", "s-resp"]);
    expect(rows()).toHaveLength(2);
    expect(field(0, "title").value).toBe("0.5 릴리스 막히는 것");
    expect(field(0, "keywords").value).toBe("0.5");
    expect(field(0, "until").value).toBe(tomorrow);
    expect([...rows()[0].querySelectorAll<HTMLInputElement>("[data-rsrc]")].filter((c) => c.checked).map((c) => c.dataset.rsrc)).toEqual(["jira", "github"]);
    expect([...rows()[1].querySelectorAll<HTMLInputElement>("[data-rsrc]")].every((c) => c.checked)).toBe(true); // omitted = all
    expect(rows()[1].classList.contains("ended")).toBe(true);
    expect(rows()[1].textContent).toContain("끝남");
    expect(rows()[0].textContent).not.toContain("끝남");
    expect(settings.isDirty()).toBe(false);
    expect(resp.readResponsibilities()).toEqual(server.responsibilities); // read back = what was rendered
  });

  it("add (up to 5) → a title is required before saving; then PUT sends the whole list", async () => {
    $("c-resp-add").click();
    expect(rows()).toHaveLength(3);
    expect(document.activeElement).toBe(field(2, "title"));
    expect(settings.isDirty()).toBe(true);
    submit(); await settled();
    expect(puts).toHaveLength(0);
    expect($("c-msg").textContent).toContain("맡긴 일 3 에 제목");
    typeIn(field(2, "title"), "고객 A 문의 후속");
    typeIn(field(2, "goal"), "답이 늦지 않게");
    typeIn(field(2, "keywords"), "고객 A, 문의, 고객 A");
    (rows()[2].querySelector('[data-rsrc="mail"]') as HTMLInputElement).click(); // untick mail → explicit list
    submit();
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    const sent = puts[0].responsibilities as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual(baseCfg().responsibilities![0]);
    expect(sent[2]).toEqual({ title: "고객 A 문의 후속", goal: "답이 늦지 않게", sources: ["slack", "jira", "github", "calendar", "sessions"], keywords: ["고객 A", "문의"], enabled: true });
    expect(puts[0].if_updated_at).toBe(1000);
    await vi.waitFor(() => expect(settings.isDirty()).toBe(false));
    expect(rows()[2].dataset.rid).toBe("new-2"); // re-rendered with the daemon's id
    for (let i = 0; i < 2; i++) $("c-resp-add").click();
    expect(rows()).toHaveLength(5);
    expect($("c-resp-add").disabled).toBe(true);
  });

  it("delete a row, switch one off (dims), clear until → saved as such", async () => {
    // back to the three saved rows
    settings.renderConfig();
    expect(rows()).toHaveLength(3);
    (rows()[1].querySelector("[data-rdel]") as HTMLButtonElement).click();
    expect(rows().map((r) => r.dataset.rid)).toEqual(["rel-05-ab12", "new-2"]);
    field(0, "enabled").click();
    expect(rows()[0].classList.contains("off")).toBe(true);
    typeIn(field(0, "until"), "");
    submit();
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    const sent = puts[0].responsibilities as Array<Record<string, unknown>>;
    expect(sent.map((r) => r.id)).toEqual(["rel-05-ab12", "new-2"]);
    expect(sent[0]).toEqual({ id: "rel-05-ab12", title: "0.5 릴리스 막히는 것", goal: "릴리스를 막는 이슈", sources: ["jira", "github"], keywords: ["0.5"], enabled: false });
  });

  it("keywords are cut at 40 chars each, like the daemon", () => {
    typeIn(field(0, "keywords"), `${"가".repeat(50)}, 짧은 것`);
    expect(resp.readResponsibilities()![0].keywords).toEqual(["가".repeat(40), "짧은 것"]);
    settings.renderConfig();
  });

  it("home band follows S.config × S.state and disappears when nothing is on", async () => {
    const home = await import("../public/app/tabs/home.js");
    void home;
    S.config = { ...baseCfg(), responsibilities: [{ id: "rel", title: "0.5 릴리스", goal: "", enabled: true }] };
    S.state = { responsibilities: { rel: { status: "watch", note: "PR 리뷰 대기 중", urls: ["https://github.com/acme/app/pull/42"], updated_at: Date.now() } } };
    band.renderRespBand();
    const el = $("resp-band");
    expect(el).not.toBeNull();
    expect(el.previousElementSibling!.classList.contains("htop")).toBe(true);
    expect(el.querySelector(".led")!.className).toBe("led a");
    expect(el.textContent).toContain("PR 리뷰 대기 중");
    expect(el.querySelector("a")!.getAttribute("target")).toBe("_blank"); // openlink.js's capture listener routes it
    S.config = { ...baseCfg(), responsibilities: [] };
    band.renderRespBand();
    expect($("resp-band")).toBeNull();
  });
});

describe("responsibilitiesMsg (pure)", () => {
  it("title required, ≤ 5, keywords ≤ 10", () => {
    expect(resp.responsibilitiesMsg(undefined)).toBeNull();
    expect(resp.responsibilitiesMsg([{ title: "a" }])).toBeNull();
    expect(resp.responsibilitiesMsg(Array.from({ length: 6 }, () => ({ title: "a" })))).toMatch(/5개/);
    expect(resp.responsibilitiesMsg([{ title: "a" }, { title: "" }])).toMatch(/맡긴 일 2/);
    expect(resp.responsibilitiesMsg([{ title: "a", keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }])).toMatch(/키워드/);
  });
});
