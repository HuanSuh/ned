// @vitest-environment jsdom
/**
 * 시작하기 modal (public/app/features/onboarding.js): opens by itself only while not dismissed and incomplete, Esc closes
 * and records the dismissal, Slack 팀 ID saves via PUT /api/config, 자동 실행 goes through the Ned.app bridge
 * (webkit.messageHandlers.loginItem) and a plain browser gets the menu hint. Markup comes from the real index.html.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
const postJson = vi.fn();
const renderConfig = vi.fn();
vi.mock("../public/app/api.js", () => ({ api, postJson }));
vi.mock("../public/app/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("../public/app/tabs/settings.js", () => ({ renderConfig, isDirty: () => false }));

// @ts-expect-error — plain browser ES module (public/app), no types
const ob = await import("../public/app/features/onboarding.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { S } = await import("../public/app/state.js");

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
const modalHtml = /<div class="modal" id="ob-modal"[\s\S]*?\n<\/div>\n/.exec(html)![0];

const SETUP = (over: Record<string, unknown> = {}) => ({
  checked_at: 1, complete: false, onboarding: { dismissed_at: null },
  sources: [
    { key: "slack", label: "Slack", via: "connector", status: "connected" },
    { key: "gmail", label: "Gmail", via: "connector", status: "needs-auth", fix: { text: "claude.ai → 설정 → 커넥터에서 다시 인증", url: "https://claude.ai/settings/connectors" } },
    { key: "github", label: "GitHub", via: "gh", status: "needs-auth", fix: { text: "터미널에서 gh 로그인", command: "gh auth login" } },
  ],
  slack_team_id: { status: "missing", value: "" },
  signing: { status: "missing", identity: "Ned Local Signing", command: "bash /x/scripts/make-signing-cert.sh" },
  ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const modal = () => document.getElementById("ob-modal")!;

beforeEach(() => {
  api.mockReset(); postJson.mockReset(); renderConfig.mockReset();
  postJson.mockResolvedValue({ ok: true, data: { onboarding: { dismissed_at: 5 } } });
  if (ob.OB.open) ob.closeOnboarding();
  document.body.innerHTML = `<button data-onboard="1">시작하기</button>` + modalHtml;
  delete (window as unknown as { webkit?: unknown }).webkit;
  S.config = { updated_at: 7, dashboard: {} };
});
const start = async (setup: unknown) => {
  api.mockImplementation(async (p: string) => (p.startsWith("/api/setup") ? setup : null));
  ob.init(); // every test: the body (and so the modal's own listeners) is rebuilt in beforeEach
  await flush(); await flush();
};

describe("onboardingHtml (pure)", () => {
  it("connector rows link to claude.ai, gh shows the command, signing shows its command", () => {
    const h = ob.onboardingHtml({ data: SETUP(), loading: false, login: null, teamMsg: "" }, { inApp: false });
    expect(h).toContain('href="https://claude.ai/settings/connectors"');
    expect(h).toContain("<code>gh auth login</code>");
    expect(h).toContain("bash /x/scripts/make-signing-cert.sh");
    expect(h).toContain("다음 설치부터");
    expect(h).toContain("Login Items 에 등록"); // browser: menu hint, no toggle
    expect(h).not.toContain('id="ob-login"');
    // connected rows have no 다시 확인; broken rows do
    expect((h.match(/data-obrefresh/g) || []).length).toBe(3); // header + gmail + github
  });

  it("inside Ned.app the 자동 실행 row is a toggle reflecting the bridge status; no team row when Slack is off", () => {
    const h = ob.onboardingHtml({ data: SETUP({ slack_team_id: { status: "n/a", value: "" } }), loading: false, login: { status: "requiresApproval" }, teamMsg: "" }, { inApp: true });
    expect(h).toMatch(/id="ob-login" checked/);
    expect(h).toContain("승인 필요");
    expect(h).not.toContain('id="ob-team"');
  });
});

describe("modal behaviour", () => {
  it("opens by itself while incomplete and not dismissed; Esc closes and records the dismissal", async () => {
    await start(SETUP());
    expect(modal().hidden).toBe(false);
    expect(document.getElementById("ob-body")!.textContent).toContain("Gmail");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal().hidden).toBe(true);
    expect(postJson).toHaveBeenCalledWith("/api/setup/dismiss", { dismissed: true });
  });

  it("stays closed once dismissed (or when complete); 설정 → 시작하기 reopens it", async () => {
    await start(SETUP({ onboarding: { dismissed_at: 3 } }));
    expect(modal().hidden).toBe(true);
    (document.querySelector("[data-onboard]") as HTMLButtonElement).click();
    await flush();
    expect(modal().hidden).toBe(false);
  });

  it("Slack 팀 ID: a bad id is not sent; a good one goes to PUT /api/config { dashboard } with the version token", async () => {
    await start(SETUP());
    const input = () => document.getElementById("ob-team") as HTMLInputElement;
    input().value = "nope";
    (document.getElementById("ob-team-save") as HTMLButtonElement).click();
    await flush();
    expect(api.mock.calls.some((c) => c[0] === "/api/config")).toBe(false);
    expect(document.getElementById("ob-team-msg")!.textContent).toMatch(/T 로 시작/);
    api.mockImplementation(async (p: string) => (p === "/api/config" ? { updated_at: 8, dashboard: { slack_team_id: "T0ABC1234" } } : SETUP({ slack_team_id: { status: "ok", value: "T0ABC1234" } })));
    input().value = "t0abc1234";
    (document.getElementById("ob-team-save") as HTMLButtonElement).click();
    await flush(); await flush();
    const put = api.mock.calls.find((c) => c[0] === "/api/config")!;
    expect(JSON.parse(put[1].body)).toEqual({ dashboard: { slack_team_id: "T0ABC1234" }, if_updated_at: 7 });
    expect(renderConfig).toHaveBeenCalled();
    expect(api.mock.calls.some((c) => c[0] === "/api/setup?refresh=1")).toBe(true);
  });

  it("자동 실행 toggle posts to the Ned.app bridge", async () => {
    const postMessage = vi.fn(async (m: { op: string; enabled?: boolean }) => ({ status: m.op === "set" && m.enabled ? "enabled" : "notRegistered" }));
    (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { loginItem: { postMessage } } };
    await start(SETUP());
    await flush();
    expect(postMessage).toHaveBeenCalledWith({ op: "get" });
    const cb = document.getElementById("ob-login") as HTMLInputElement;
    expect(cb.checked).toBe(false);
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(); await flush();
    expect(postMessage).toHaveBeenCalledWith({ op: "set", enabled: true });
    expect((document.getElementById("ob-login") as HTMLInputElement).checked).toBe(true);
  });
});
