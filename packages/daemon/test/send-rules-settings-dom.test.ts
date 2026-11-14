// @vitest-environment jsdom
/**
 * 설정 → 쓰기 액션 → 보내기 규칙 inside the real settings form (index.html + public/app/tabs/settings.js): renders from
 * config without a false "unsaved" mark, edits mark it dirty, and the form's PUT /api/config carries actions.rules /
 * internal_domains / review (sub-key diff — the switches untouched stay out). A bad domain stops the save.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../public/app/main.js", () => ({ loadAgenda: () => {}, loadState: async () => {}, renderAll: () => {} }));

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
// @ts-expect-error — plain browser ES module (public/app), no types
const { mergePatch } = await import("../public/app/features/config-diff.js");

type Cfg = Record<string, unknown> & { updated_at: number; actions: Record<string, unknown> };
const baseCfg = (): Cfg => ({
  port: 7806, heartbeat_minutes: 10, signal_check_minutes: 60, briefing_time: "09:00", agenda_refresh_minutes: 60,
  agenda_source_minutes: { slack: null, mail: null, calendar: null, jira: null, github: null },
  quiet_hours: { start: "23:00", end: "08:00" }, sources: { slack: true, gmail: true },
  filters: { slack: { exclude_channels: [], watch_channels: [], ack_reactions: ["eyes"] }, jira: { exclude_projects: [] } },
  dashboard: { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 }, layout: null, locked: false, watch_cards: true, theme: "system" },
  notifications: { enabled: true, kinds: { session: true, email: true, slack: true, jira: true, github: true, sentry: true, calendar: true }, briefing: true, summary_threshold: 3, quiet_delivery: "skip", sound: true },
  actions: { slack_send: true, gmail_draft: true, rules: [{ source: "slack", target: "#general", effect: "confirm", note: "전체 채널" }], internal_domains: ["acme.com"], review: "off" },
  reply_tone: "짧게", reply_tone_by_source: { slack: null, email: null, session: null },
  claude_model: null, claude_max_turns: 25, agenda_daily_budget_usd: 15, responsibilities: [],
  updated_at: 1000, build_id: "b1",
});

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let server: Cfg;
const puts: Array<Record<string, unknown>> = [];
let settings: typeof import("../public/app/tabs/settings.js");
let S: { config: Cfg | null };
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const submit = () => $("cfg").dispatchEvent(new Event("submit", { cancelable: true }));
const rows = () => [...document.querySelectorAll<HTMLElement>("#c-sendrules .sri")];

describe("설정 → 보내기 규칙 (form)", () => {
  beforeAll(async () => {
    document.body.innerHTML = indexHtml.slice(indexHtml.indexOf("<body"), indexHtml.lastIndexOf("</body>")).replace(/^<body[^>]*>/, "");
    $("v-settings").hidden = false;
    window.HTMLElement.prototype.scrollIntoView ??= () => {};
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    server = baseCfg();
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/config" && opts?.method === "PUT") {
        const body = JSON.parse(String(opts.body));
        puts.push(body);
        const { if_updated_at: _i, ...patch } = body;
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

  it("renders under 쓰기 액션 from config, not dirty, no stray switch for rules / review", () => {
    expect($("c-sendrules").closest("#s-actions")).not.toBeNull();
    expect(rows()).toHaveLength(1);
    expect($("c-sr-domains").value).toBe("acme.com");
    expect((document.querySelector('input[name="c-sr-review"]:checked') as HTMLInputElement).value).toBe("off");
    expect(document.querySelector('[data-act="rules"], [data-act="review"], [data-act="internal_domains"]')).toBeNull();
    expect(settings.isDirty()).toBe(false);
  });

  it("add a rule + switch review on → dirty → PUT carries actions.rules / review only", async () => {
    $("c-sr-add").click();
    expect(rows()).toHaveLength(2);
    const r1 = rows()[1];
    (r1.querySelector('[data-sf="source"]') as HTMLSelectElement).value = "mail";
    (r1.querySelector('[data-sf="external"]') as HTMLSelectElement).value = "true";
    (r1.querySelector('[data-sf="effect"]') as HTMLSelectElement).value = "block";
    (r1.querySelector('[data-sf="note"]') as HTMLInputElement).value = "회사 밖 메일은 Ned 로 안 보냄";
    (document.querySelector('input[name="c-sr-review"][value="warn"]') as HTMLInputElement).click();
    $("c-sendrules").dispatchEvent(new Event("change", { bubbles: true }));
    expect(settings.isDirty()).toBe(true);
    expect(rows()[1].className).toBe("sri sr-block");
    submit();
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].actions).toEqual({
      rules: [{ source: "slack", target: "#general", effect: "confirm", note: "전체 채널" }, { source: "mail", external: true, effect: "block", note: "회사 밖 메일은 Ned 로 안 보냄" }],
      review: "warn",
    });
    await vi.waitFor(() => expect(settings.isDirty()).toBe(false));
  });

  it("move a rule up → order saved; a bad domain stops the save with a message", async () => {
    (rows()[1].querySelector("[data-sup]") as HTMLButtonElement).click();
    expect((rows()[0].querySelector('[data-sf="source"]') as HTMLSelectElement).value).toBe("mail");
    $("c-sr-domains").value = "acme.com, 회사";
    $("c-sr-domains").dispatchEvent(new Event("input", { bubbles: true }));
    submit();
    await new Promise((r) => setTimeout(r, 0));
    expect(puts).toHaveLength(0);
    expect($("c-msg").textContent).toContain("도메인 형식");
    $("c-sr-domains").value = "acme.com, acme.co.kr";
    submit();
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    const a = puts[0].actions as { rules: { source: string }[]; internal_domains: string[] };
    expect(a.rules.map((r) => r.source)).toEqual(["mail", "slack"]);
    expect(a.internal_domains).toEqual(["acme.com", "acme.co.kr"]);
  });
});
