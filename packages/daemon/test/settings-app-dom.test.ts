// @vitest-environment jsdom
/**
 * 설정 → 앱 (public/app/tabs/settings-app.js): the section + nav link are added into the real settings markup; inside
 * Ned.app the inputs go through webkit.messageHandlers.appSettings ({op:get} / {op:set,key,value} / {op:action,name}),
 * a rejected reply shows an error, and a plain browser gets the one-line hint. 업데이트 확인 = GET /api/update-check.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("../public/app/api.js", () => ({ api, postJson: vi.fn() }));
const copyText = vi.fn(async () => true);
vi.mock("../public/app/features/code-copy.js", () => ({ copyText }));

// @ts-expect-error — plain browser ES module (public/app), no types
const app = await import("../public/app/tabs/settings-app.js");

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
const settingsHtml = /<main class="view page" id="v-settings"[\s\S]*?<\/main>/.exec(html)![0];

const flush = () => new Promise((r) => setTimeout(r, 0));
const VALUES = (over: Record<string, unknown> = {}) => ({
  loginItem: { status: "notRegistered", enabled: false }, openAtLaunch: true, openAtLoginLaunch: false,
  repoPath: "/Users/me/.ned/runtime", logPath: "/Users/me/.ned/logs/app-daemon.log", ...over,
});
type Msg = { op: string; key?: string; value?: unknown; name?: string };
let sent: Msg[] = [];
let reply: (m: Msg) => Promise<unknown> = async () => VALUES();
const withBridge = () => {
  (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { appSettings: { postMessage: (m: Msg) => { sent.push(m); return reply(m); } } } };
};
const body = () => document.getElementById("app-body")!;

beforeEach(() => {
  api.mockReset(); copyText.mockClear();
  sent = []; reply = async () => VALUES();
  Object.assign(app.AP, { data: null, error: "", busy: "", upd: null, updBusy: false, updError: "", copied: false });
  delete (window as unknown as { webkit?: unknown }).webkit;
  document.head.innerHTML = "";
  document.body.innerHTML = settingsHtml;
  location.hash = "";
});

describe("section", () => {
  it("adds the 앱 nav link and the section before the save bar, once", () => {
    app.initAppSettings();
    app.initAppSettings();
    expect(document.querySelectorAll('[data-sjump="s-app"]').length).toBe(1);
    const sec = document.getElementById("s-app")!;
    expect(sec.nextElementSibling?.classList.contains("sbar")).toBe(true);
    expect(sec.textContent).toContain("저장\"과 상관없어");
  });

  it("plain browser: hint line, no inputs, no bridge call; update check still offered", () => {
    app.initAppSettings();
    expect(body().querySelector("[data-appnobridge]")!.textContent).toBe("Ned.app 창에서 열면 바꿀 수 있어요.");
    expect(body().querySelector("[data-appkey]")).toBeNull();
    expect(body().querySelector("[data-appupd]")).not.toBeNull();
  });
});

describe("bridge", () => {
  it("init asks {op:get} and renders the values (disabled 자동 시작 시에도 열기 while 실행 시 열기 is off)", async () => {
    reply = async () => VALUES({ openAtLaunch: false, loginItem: { status: "requiresApproval", enabled: true, message: "시스템 설정에서 허용" } });
    withBridge();
    app.initAppSettings();
    await flush();
    expect(sent).toEqual([{ op: "get" }]);
    const login = body().querySelector<HTMLInputElement>('[data-appkey="loginItem"]')!;
    expect(login.checked).toBe(true);
    expect(body().textContent).toContain("자동 시작: 꺼짐 (승인 필요)");
    expect(body().textContent).toContain("시스템 설정에서 허용");
    expect(body().querySelector<HTMLInputElement>('[data-appkey="openAtLoginLaunch"]')!.disabled).toBe(true);
    expect(body().textContent).toContain("/Users/me/.ned/runtime");
    expect(body().textContent).toContain("app-daemon.log");
  });

  it("a toggle sends {op:set, key, value} at once and re-renders from the reply", async () => {
    withBridge();
    app.initAppSettings();
    await flush();
    reply = async (m) => VALUES({ openAtLoginLaunch: m.value });
    const cb = body().querySelector<HTMLInputElement>('[data-appkey="openAtLoginLaunch"]')!;
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(sent[1]).toEqual({ op: "set", key: "openAtLoginLaunch", value: true });
    expect(body().querySelector<HTMLInputElement>('[data-appkey="openAtLoginLaunch"]')!.checked).toBe(true);
  });

  it("buttons send {op:action, name} for chooseRepo / revealLog / restartDaemon", async () => {
    withBridge();
    app.initAppSettings();
    await flush();
    for (const name of ["chooseRepo", "revealLog", "restartDaemon"]) {
      body().querySelector<HTMLButtonElement>(`[data-appact="${name}"]`)!.click();
      await flush();
    }
    expect(sent.slice(1)).toEqual([{ op: "action", name: "chooseRepo" }, { op: "action", name: "revealLog" }, { op: "action", name: "restartDaemon" }]);
  });

  it("a rejected reply shows the error and keeps the last values", async () => {
    withBridge();
    app.initAppSettings();
    await flush();
    reply = async () => { throw new Error("unknown key"); };
    body().querySelector<HTMLInputElement>('[data-appkey="loginItem"]')!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const err = body().querySelector('[role="alert"]')!;
    expect(err.textContent).toBe("적용 실패: unknown key");
    expect(body().querySelector('[data-appkey="loginItem"]')).not.toBeNull();
  });

  it("a failed get shows 불러오기 실패", async () => {
    reply = async () => { throw new Error("not allowed"); };
    withBridge();
    app.initAppSettings();
    await flush();
    expect(body().querySelector('[role="alert"]')!.textContent).toBe("불러오기 실패: not allowed");
  });

  it("nedOpenSettings (menu 설정…) switches to #settings and reloads the values", async () => {
    withBridge();
    app.initAppSettings();
    await flush();
    const scrolled = vi.fn();
    (document.getElementById("s-app") as unknown as { scrollIntoView: unknown }).scrollIntoView = scrolled;
    (window as unknown as { nedOpenSettings: (id?: string) => void }).nedOpenSettings();
    await new Promise((r) => setTimeout(r, 30));
    expect(location.hash).toBe("#settings");
    expect(scrolled).toHaveBeenCalledWith({ block: "start" });
    expect(sent.filter((m) => m.op === "get").length).toBeGreaterThanOrEqual(2);
  });
});

describe("업데이트 확인", () => {
  it("update available: X → Y, the Claude Code steps and 명령 복사 (copies all steps)", async () => {
    api.mockResolvedValue({ current: "0.2.0", latest: "0.3.0", source: "github", update_available: true, steps: ["/plugin update ned", "/reload-plugins", "/ned:install"] });
    app.initAppSettings();
    body().querySelector<HTMLButtonElement>("[data-appupd]")!.click();
    await flush();
    expect(api).toHaveBeenCalledWith("/api/update-check?refresh=1");
    expect(body().textContent).toContain("0.2.0 → 0.3.0 업데이트 있음");
    expect(body().textContent).toContain("/plugin update ned");
    body().querySelector<HTMLButtonElement>("[data-appcopy]")!.click();
    await flush();
    expect(copyText).toHaveBeenCalledWith("/plugin update ned\n/reload-plugins\n/ned:install");
    expect(body().querySelector("[data-appcopy]")!.textContent).toBe("복사했어");
  });

  it("up to date / failure lines", () => {
    expect(app.updateHtml({ ...app.AP, upd: { current: "0.3.0", latest: "0.3.0", update_available: false, source: "github" } })).toContain("최신 버전 (0.3.0)");
    expect(app.updateHtml({ ...app.AP, upd: { current: "0.3.0", latest: null, update_available: false, error: "gh: 설치 안 됨" } })).toContain("확인 실패 (gh: 설치 안 됨)");
    expect(app.updateHtml({ ...app.AP, updError: "boom" })).toContain("확인 실패: boom");
  });
});
