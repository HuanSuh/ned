// @vitest-environment jsdom
/**
 * Settings tab save, client side: diffConfig / mergePatch (pure), the PUT carries only changed keys + if_updated_at,
 * a 409 re-renders the latest config with the user's own edits kept, a daemon build change locks the save,
 * and 이전 설정으로 되돌리기 lists backups → confirm → restore → re-render.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../public/app/main.js", () => ({ loadAgenda: () => {}, loadState: async () => {}, renderAll: () => {} }));

const { diffConfig, mergePatch, isEmptyPatch } = await import("../public/app/features/config-diff.js");

describe("diffConfig / mergePatch (pure)", () => {
  it("only changed keys; nested objects at sub-key level; arrays whole; unchanged → {}", () => {
    const saved = { a: 1, b: "x", n: { enabled: true, kinds: { slack: true, jira: true } }, f: { slack: { exclude_channels: ["a"], watch_channels: [] } }, q: null };
    const now = { a: 1, b: "y", n: { enabled: true, kinds: { slack: false, jira: true } }, f: { slack: { exclude_channels: ["a", "b"], watch_channels: [] } }, q: { start: "23:00", end: "08:00" } };
    expect(diffConfig(saved, now)).toEqual({ b: "y", n: { kinds: { slack: false } }, f: { slack: { exclude_channels: ["a", "b"] } }, q: { start: "23:00", end: "08:00" } });
    expect(diffConfig(saved, structuredClone(saved))).toEqual({});
    expect(isEmptyPatch(diffConfig(saved, saved))).toBe(true);
    expect(diffConfig({ m: "opus" }, { m: null })).toEqual({ m: null });
    expect(diffConfig({ q: { start: "1" } }, { q: null })).toEqual({ q: null });
    expect(diffConfig({ a: 1, gone: 2 }, { a: 1 })).toEqual({}); // missing in now → not sent (server keeps it)
    expect(diffConfig(null, { a: 1 })).toEqual({ a: 1 });
    expect(diffConfig({ a: 1 }, { a: 1, fresh: { x: 1 } })).toEqual({ fresh: { x: 1 } });
  });
  it("mergePatch lays a diff back over a config", () => {
    const cur = { a: 1, n: { kinds: { slack: true, jira: true }, sound: true }, arr: [1] };
    expect(mergePatch(cur, { n: { kinds: { slack: false } }, arr: [2, 3] })).toEqual({ a: 1, n: { kinds: { slack: false, jira: true }, sound: true }, arr: [2, 3] });
    expect(mergePatch(cur, {})).toEqual(cur);
  });
});

// ---------------------------------------------------------------- the settings form against a fake daemon
const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");

type Cfg = Record<string, unknown> & { updated_at: number; build_id: string };
const baseCfg = (): Cfg => ({
  port: 7797, heartbeat_minutes: 10, signal_check_minutes: 60, briefing_time: "09:00", agenda_refresh_minutes: 60,
  agenda_source_minutes: { slack: null, mail: null, calendar: null, jira: null, github: null },
  quiet_hours: { start: "23:00", end: "08:00" }, sources: { slack: true, gmail: true },
  filters: { slack: { exclude_channels: [], watch_channels: [], ack_reactions: ["eyes"] }, jira: { exclude_projects: [] } },
  dashboard: { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 }, layout: null, locked: false, watch_cards: true, theme: "system" },
  notifications: { enabled: true, kinds: { session: true, email: true, slack: true, jira: true, github: true, sentry: true, calendar: true }, briefing: true, summary_threshold: 3, quiet_delivery: "skip", sound: true },
  actions: { slack_send: false, gmail_draft: true }, reply_tone: "짧게", reply_tone_by_source: { slack: null, email: null, session: null },
  claude_model: "claude-opus-5-5", claude_max_turns: 25, agenda_daily_budget_usd: 15,
  updated_at: 1000, build_id: "b1",
});
let server: Cfg;
const puts: Array<Record<string, unknown>> = [];
const backups = [{ name: "config-2026-11-07T01-02-03-004Z.yaml", at: Date.parse("2026-11-07T01:02:03.004Z"), size: 100 }];
let restoreCalls: unknown[] = [];

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const settled = () => new Promise((r) => setTimeout(r, 0));

let settings: typeof import("../public/app/tabs/settings.js");
let S: { config: Cfg | null };
let build: typeof import("../public/app/features/build.js");
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const submit = () => $("cfg").dispatchEvent(new Event("submit", { cancelable: true }));
const typeInto = (id: string, v: string) => { $(id).value = v; $(id).dispatchEvent(new Event("input", { bubbles: true })); };

beforeAll(async () => {
  document.body.innerHTML = indexHtml.slice(indexHtml.indexOf("<body"), indexHtml.lastIndexOf("</body>")).replace(/^<body[^>]*>/, "");
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  server = baseCfg();
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => {
    if (url === "/api/config" && opts?.method === "PUT") {
      const body = JSON.parse(String(opts.body));
      puts.push(body);
      if (body.if_updated_at != null && body.if_updated_at !== server.updated_at) return res(409, { error: "conflict", current: server });
      const { if_updated_at: _i, ...patch } = body;
      server = { ...(mergePatch(server, patch) as Cfg), updated_at: server.updated_at + 1 };
      return res(200, server);
    }
    if (url === "/api/config/backups") return res(200, backups);
    if (url === "/api/config/restore") {
      restoreCalls.push(JSON.parse(String(opts!.body)));
      server = { ...baseCfg(), claude_model: "restored-model", updated_at: server.updated_at + 1 };
      return res(200, server);
    }
    return res(200, url === "/api/actions" ? [] : {});
  }));
  ({ S } = (await import("../public/app/state.js")) as unknown as { S: { config: Cfg | null } });
  settings = await import("../public/app/tabs/settings.js");
  build = await import("../public/app/features/build.js");
  settings.init();
  S.config = structuredClone(server);
  settings.renderConfig();
});

describe("settings save", () => {
  it("nothing edited → no PUT", async () => {
    submit(); await settled();
    expect(puts).toHaveLength(0);
    expect($("c-msg").textContent).toContain("바뀐 항목이 없어");
  });

  it("PUT carries only the edited keys (sub-key level) + if_updated_at", async () => {
    typeInto("c-hb", "15");
    (document.querySelector('[data-nk="slack"]') as HTMLInputElement).click();
    expect(settings.isDirty()).toBe(true);
    submit();
    await vi.waitFor(() => expect(settings.isDirty()).toBe(false));
    expect(puts.at(-1)).toEqual({ heartbeat_minutes: 15, notifications: { kinds: { slack: false } }, if_updated_at: 1000 });
    expect(server.claude_model).toBe("claude-opus-5-5"); // untouched keys were never sent
    expect(S.config!.updated_at).toBe(1001);
  });

  it("409: re-renders the latest config, keeps only the user's edited field, then saves with the new token", async () => {
    // someone else changed claude_model + the theme meanwhile
    server = { ...server, claude_model: "elsewhere", reply_tone: "다른 탭", updated_at: 2000 };
    typeInto("c-turns", "40");
    submit();
    await vi.waitFor(() => expect($("c-msg").textContent).toContain("다른 곳에서 설정이 바뀌어"));
    expect(puts.at(-1)).toEqual({ claude_max_turns: 40, if_updated_at: 1001 });
    expect($("c-model").value).toBe("elsewhere"); // latest value shown
    expect(($("c-tone") as unknown as HTMLTextAreaElement).value).toBe("다른 탭");
    expect($("c-turns").value).toBe("40"); // my edit kept…
    expect(settings.isDirty()).toBe(true); // …and still pending
    expect($("c-save").disabled).toBe(false);
    expect(document.getElementById("toast")!.textContent).toContain("수정한 항목은 유지됨");
    submit();
    await vi.waitFor(() => expect(settings.isDirty()).toBe(false));
    expect(puts.at(-1)).toEqual({ claude_max_turns: 40, if_updated_at: 2000 });
    expect(server).toMatchObject({ claude_max_turns: 40, claude_model: "elsewhere", reply_tone: "다른 탭" });
  });
});

describe("외형 → 링크 열기 (dashboard.open_links_in_app · _by_service · slack_team_id)", () => {
  it("renders defaults (older config without the keys → on, empty team id); master off dims the services", () => {
    expect($("c-openapp").checked).toBe(true);
    expect([...document.querySelectorAll<HTMLInputElement>("[data-olsvc]")].map((c) => [c.dataset.olsvc, c.checked])).toEqual([["slack", true], ["figma", true], ["notion", true]]);
    expect($("c-slack-team").value).toBe("");
    $("c-openapp").click();
    expect(settings.isDirty()).toBe(true);
    expect((document.querySelector('[data-olsvc="figma"]') as HTMLInputElement).disabled).toBe(true);
    $("c-openapp").click();
    expect((document.querySelector('[data-olsvc="figma"]') as HTMLInputElement).disabled).toBe(false);
    expect(settings.isDirty()).toBe(false);
  });

  it("a bad team id is not sent (inline message); a good one + a service toggle go out as one dashboard sub-patch", async () => {
    const n = puts.length;
    typeInto("c-slack-team", "acme");
    expect($("c-slack-team-msg").textContent).toContain("T 로 시작");
    expect(settings.isDirty()).toBe(true);
    submit(); await settled();
    expect(puts).toHaveLength(n);
    expect($("c-msg").textContent).toContain("저장 안 함");
    typeInto("c-slack-team", " t0abc1234 ");
    expect($("c-slack-team-msg").textContent).toBe("");
    (document.querySelector('[data-olsvc="notion"]') as HTMLInputElement).click();
    const token = S.config!.updated_at;
    submit();
    await vi.waitFor(() => expect(settings.isDirty()).toBe(false));
    expect(puts.at(-1)).toEqual({ dashboard: { open_links_in_app_by_service: { notion: false }, slack_team_id: "T0ABC1234" }, if_updated_at: token });
    expect($("c-slack-team").value).toBe("T0ABC1234");
    expect((document.querySelector('[data-olsvc="notion"]') as HTMLInputElement).checked).toBe(false);
  });
});

describe("이전 설정으로 되돌리기", () => {
  it("lists backups, asks to confirm, restores and re-renders", async () => {
    const box = document.getElementById("c-restore") as HTMLDetailsElement;
    expect(box).toBeTruthy();
    expect(box.previousElementSibling?.id).toBe("cfg"); // below the form; form markup untouched
    box.open = true; box.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(box.querySelector("#c-rb-pick")).toBeTruthy());
    const sel = box.querySelector("#c-rb-pick") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", backups[0].name]);
    sel.value = backups[0].name; sel.dispatchEvent(new Event("change", { bubbles: true }));
    (box.querySelector("#c-rb-go") as HTMLButtonElement).click();
    expect(box.querySelector(".rbconfirm")?.textContent).toContain("되돌릴까");
    expect(restoreCalls).toHaveLength(0); // nothing until confirmed
    (box.querySelector("#c-rb-yes") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("c-model").value).toBe("restored-model"));
    expect(restoreCalls).toEqual([{ name: backups[0].name }]);
    expect(settings.isDirty()).toBe(false);
  });
});

describe("daemon build change", () => {
  it("first build_id is the baseline; a different one shows the banner and locks 저장 until reload", async () => {
    expect(build.noteBuild("b1")).toBe(false);
    expect(build.noteBuild(undefined)).toBe(false); // older daemon: nothing to compare
    expect(document.getElementById("build-banner")).toBeNull();
    expect(build.noteBuild("b2")).toBe(true);
    expect(document.getElementById("build-banner")!.textContent).toContain("새로고침");
    expect($("c-save").disabled).toBe(true);
    expect($("c-msg").textContent).toContain("새로고침한 뒤");
    typeInto("c-hb", "33");
    const n = puts.length;
    submit(); await settled();
    expect(puts).toHaveLength(n); // blocked
    settings.renderConfig(); // a re-render doesn't unlock it
    expect($("c-save").disabled).toBe(true);
  });
});
