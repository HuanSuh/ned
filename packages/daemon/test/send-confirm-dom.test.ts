// @vitest-environment jsdom
/**
 * Dashboard side of 보내기 규칙 / 자동 검토:
 * - the shared confirm step (public/app/features/sendconfirm.js) — reasons + review issues, [그래도 보내기] [취소], Esc,
 *   in the open modal or as a bottom panel, never window.confirm;
 * - sendjob.js sendAndWait: 409 need_confirm → confirm → the same body + confirm_token → 202 → poll; 취소 → nothing sent;
 * - 설정 → 쓰기 액션 → 보내기 규칙 (public/app/tabs/settings-actions.js): rows, add / ↑ / ↓ / 삭제, read back, save guard,
 *   and the action-switch groups ignoring the non-boolean keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error — plain browser ES module (public/app), no types
const sc = await import("../public/app/features/sendconfirm.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { sendAndWait } = await import("../public/app/features/sendjob.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const sa = await import("../public/app/tabs/settings-actions.js");

const NEED = {
  ok: false, need_confirm: true, confirm_token: "tok-1", expires_at: "2026-11-14T00:05:00Z",
  reasons: ["규칙 1 (slack · #general): 전체 채널 <주의>"],
  review: { status: "issues", issues: [{ kind: "secret", detail: "토큰처럼 보이는 문자열" }, { kind: "commitment", detail: "\"내일까지\" 약속" }] },
};
const click = (el: Element | null) => (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(window, "confirm").mockImplementation(() => { throw new Error("window.confirm must not be used"); });
});
afterEach(() => vi.restoreAllMocks());

describe("sendConfirmHtml (pure)", () => {
  it("lists rule reasons and review issues (escaped, Korean kind labels) + the two buttons", () => {
    const html = sc.sendConfirmHtml(NEED);
    expect(html).toContain("규칙 1 (slack · #general): 전체 채널 &lt;주의&gt;");
    expect(html).toContain('<li class="scf-issue" data-kind="secret"><b>비밀 노출</b> 토큰처럼 보이는 문자열</li>');
    expect(html).toContain("<b>약속·날짜</b>");
    expect(html).toContain('data-scf="go">그래도 보내기');
    expect(html).toContain('data-scf="cancel">취소');
    expect(sc.sendConfirmHtml({ reasons: [], review: { issues: [] }, token_problem: "expired" })).toContain("5분이 지나");
    expect(sc.sendConfirmHtml({ reasons: ["r"] })).not.toContain("자동 검토");
  });

  it("needsConfirm / ruleBlockMsg", () => {
    expect(sc.needsConfirm({ status: 409, data: NEED })).toBe(true);
    expect(sc.needsConfirm({ status: 409, data: { already_sent: true } })).toBe(false);
    expect(sc.ruleBlockMsg({ status: 403, data: { detail: "보내기 규칙이 막음 — 규칙 2" } })).toBe("보내기 규칙이 막음 — 규칙 2");
    expect(sc.ruleBlockMsg({ status: 403, data: { detail: "config.actions.slack_send is off" } })).toBeNull();
  });
});

describe("askSendConfirm (DOM)", () => {
  it("no modal open → a bottom panel; [그래도 보내기] resolves true and removes it", async () => {
    const p = sc.askSendConfirm(NEED);
    const el = document.querySelector(".sendconfirm")!;
    expect(el.classList.contains("float")).toBe(true);
    expect(el.getAttribute("role")).toBe("alertdialog");
    expect(document.activeElement?.getAttribute("data-scf")).toBe("cancel"); // safe default focus
    click(el.querySelector('[data-scf="go"]'));
    await expect(p).resolves.toBe(true);
    expect(document.querySelector(".sendconfirm")).toBeNull();
  });

  it("inside the open modal's body when one is open; Esc cancels without reaching the modal", async () => {
    document.body.innerHTML = `<div class="modal" id="m"><div class="mbox"><div class="mbd" id="body"></div></div></div>`;
    const modalEsc = vi.fn();
    document.addEventListener("keydown", modalEsc, true);
    const p = sc.askSendConfirm(NEED);
    const el = document.querySelector("#body > .sendconfirm")!;
    expect(el).not.toBeNull();
    expect(el.classList.contains("float")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(p).resolves.toBe(false);
    expect(modalEsc).not.toHaveBeenCalled();
    document.removeEventListener("keydown", modalEsc, true);
  });

  it("the modal closing under it counts as 취소", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div class="modal"><div class="mbd" id="body"></div></div>`;
    const p = sc.askSendConfirm(NEED);
    document.querySelector("#body")!.innerHTML = "";
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    await expect(p).resolves.toBe(false);
  });
});

describe("sendAndWait with the confirm step", () => {
  let posts: Record<string, unknown>[] = [];
  const respond = (status: number, data: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
  beforeEach(() => {
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const b = JSON.parse(String(init.body));
        posts.push(b);
        return b.confirm_token === "tok-1" ? respond(202, { ok: true, job_id: "job-9", started_at: new Date().toISOString() }) : respond(409, NEED);
      }
      if (url === "/api/send/job-9") return respond(200, { state: "done", result: { ok: true, http_status: 200, action: "slack_message C1", detail: "https://x.slack.com/archives/C1/p1" } });
      return respond(404, {});
    }));
  });

  const body = { source: "slack", mode: "send", text: "hi", ref: { channel: "C1" } };

  it("409 need_confirm → confirm shown → [그래도 보내기] → same body + confirm_token → job result", async () => {
    const run = sendAndWait(body, { label: "Slack 전송" });
    for (let i = 0; i < 5 && !document.querySelector(".sendconfirm"); i++) await tick();
    expect(document.querySelector(".sendconfirm")?.textContent).toContain("전체 채널");
    click(document.querySelector('[data-scf="go"]'));
    const r = await run;
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(posts).toEqual([body, { ...body, confirm_token: "tok-1" }]);
  });

  it("[취소] → {cancelled}, nothing re-posted", async () => {
    const run = sendAndWait(body, { confirm: async () => false });
    const r = await run;
    expect(r).toMatchObject({ ok: false, status: 409, cancelled: true });
    expect(r.data.error).toContain("취소");
    expect(posts).toHaveLength(1);
  });
});

describe("설정 → 보내기 규칙", () => {
  const cfg = { actions: { slack_send: true, rules: [{ source: "slack", target: "#general", effect: "confirm", note: "전체 채널" }, { source: "mail", external: true, effect: "block" }], internal_domains: ["acme.com", "acme.co.kr"], review: "warn" } };
  const mount = (c: unknown = cfg) => {
    document.body.innerHTML = `<div id="c-sendrules"></div>`;
    const root = document.getElementById("c-sendrules")!;
    root.innerHTML = sa.sendRulesHtml(c);
    sa.syncSendRules(root);
    return root;
  };

  it("renders rows (source · target · 외부 · effect · note · ↑↓삭제), domains and the review radio; reads back the same", () => {
    const root = mount();
    const rows = root.querySelectorAll(".sri");
    expect(rows).toHaveLength(2);
    expect((rows[0].querySelector('[data-sf="source"]') as HTMLSelectElement).value).toBe("slack");
    expect((rows[1].querySelector('[data-sf="external"]') as HTMLSelectElement).value).toBe("true");
    expect(rows[1].className).toBe("sri sr-block");
    expect((rows[0].querySelector("[data-sup]") as HTMLButtonElement).disabled).toBe(true);
    expect((rows[1].querySelector("[data-sdown]") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#c-sr-domains") as HTMLInputElement).value).toBe("acme.com, acme.co.kr");
    expect(sa.readSendRules(root)).toEqual({ rules: cfg.actions.rules, internal_domains: ["acme.com", "acme.co.kr"], review: "warn" });
  });

  it("empty config → hint, review off; no section → null", () => {
    const root = mount({ actions: {} });
    expect(root.textContent).toContain("규칙이 없어");
    expect(sa.readSendRules(root)).toEqual({ rules: [], internal_domains: [], review: "off" });
    expect(sa.readSendRules(null)).toBeNull();
  });

  it("추가 / ↓ / ↑ / 삭제 redraw in order; the placeholder follows the source", () => {
    const root = mount();
    sa.sendRulesClick(root, root.querySelector("#c-sr-add"));
    expect(sa.readSendRules(root).rules).toHaveLength(3);
    expect(sa.readSendRules(root).rules[2]).toEqual({ source: "*", effect: "confirm" });
    sa.sendRulesClick(root, root.querySelector('[data-sdown="0"]'));
    expect(sa.readSendRules(root).rules.map((r: { source: string }) => r.source)).toEqual(["mail", "slack", "*"]);
    sa.sendRulesClick(root, root.querySelector('[data-sup="2"]'));
    expect(sa.readSendRules(root).rules.map((r: { source: string }) => r.source)).toEqual(["mail", "*", "slack"]);
    sa.sendRulesClick(root, root.querySelector('[data-sdel="0"]'));
    expect(sa.readSendRules(root).rules.map((r: { source: string }) => r.source)).toEqual(["*", "slack"]);
    const src = root.querySelector('[data-si="0"] [data-sf="source"]') as HTMLSelectElement;
    src.value = "github";
    sa.syncSendRules(root);
    expect((root.querySelector('[data-si="0"] [data-sf="target"]') as HTMLInputElement).placeholder).toBe("owner/repo");
    expect(sa.sendRulesClick(root, root)).toBe(false);
  });

  it("the add button stops at 30; save guard catches a bad domain", () => {
    const root = mount({ actions: { rules: Array.from({ length: 30 }, () => ({ source: "*", effect: "allow" })) } });
    expect((root.querySelector("#c-sr-add") as HTMLButtonElement).disabled).toBe(true);
    expect(sa.sendRulesMsg({ internal_domains: ["acme.com"] })).toBeNull();
    expect(sa.sendRulesMsg({ internal_domains: ["not a domain"] })).toMatch(/도메인 형식/);
    expect(sa.sendRulesMsg({ rules: Array.from({ length: 31 }, () => ({})) })).toMatch(/30개/);
    expect(sa.parseDomains("@Acme.com, , b.io")).toEqual(["acme.com", "b.io"]);
  });

  it("the switch groups ignore rules / internal_domains / review (no stray '기타' toggles)", () => {
    const html = sa.writeActionsHtml({ sources: {}, actions: { slack_send: true, rules: [], internal_domains: [], review: "off" } }, { slack_send: false }, { slack_send: "Slack 전송" });
    expect(html).not.toContain('data-wagrp="other"');
    expect(html).not.toContain('data-act="rules"');
  });
});
