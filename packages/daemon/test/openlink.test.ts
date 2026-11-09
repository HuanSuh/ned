// @vitest-environment jsdom
/**
 * 링크 열기 (public/app/features/openlink.js): Ned.app message handler → postMessage, otherwise (plain browser) the web
 * URL straight away; and the one delegated click handler that routes plain left clicks on external anchors through openLink.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { init, isExternalUrl, onLinkClick, openLink } from "../public/app/features/openlink.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { S } from "../public/app/state.js";

const T = "T0ABC1234";
const SLACK = "https://acme.slack.com/archives/C0123ABCD/p1794193614524359?thread_ts=1794193470.379259&cid=C0123ABCD";
const SLACK_DEEP = `slack://channel?team=${T}&id=C0123ABCD&message=1794193614.524359&thread_ts=1794193470.379259`;
const FIG = "https://www.figma.com/design/AbC123/File?node-id=1-2";
const ON = { open_links_in_app: true, open_links_in_app_by_service: { slack: true, figma: true, notion: true }, slack_team_id: T };

/** A fake window: open spy, optional webkit handler, a location that must never change. */
function fakeWin({ handler = false } = {}) {
  const post = vi.fn();
  const win = {
    open: vi.fn(),
    location: { href: "http://127.0.0.1:7777/" },
    setTimeout: vi.fn(),
    ...(handler ? { webkit: { messageHandlers: { openLink: { postMessage: post } } } } : {}),
  };
  return { win, post };
}

beforeEach(() => { S.config = { dashboard: ON }; });

describe("openLink", () => {
  it("Ned.app (message handler present) → postMessage({ deep, web }), no window.open, no navigation", () => {
    const { win, post } = fakeWin({ handler: true });
    expect(openLink(SLACK, { win })).toBe("app");
    expect(post).toHaveBeenCalledWith({ deep: SLACK_DEEP, web: SLACK });
    expect(win.open).not.toHaveBeenCalled();
    expect(win.location.href).toBe("http://127.0.0.1:7777/");
  });

  it("reads toggles + team id from S.config.dashboard; off / no team → window.open(web) even inside Ned.app", () => {
    const { win, post } = fakeWin({ handler: true });
    S.config = { dashboard: { ...ON, open_links_in_app: false } };
    expect(openLink(FIG, { win })).toBe("web");
    S.config = { dashboard: { ...ON, open_links_in_app_by_service: { figma: false } } };
    expect(openLink(FIG, { win })).toBe("web");
    S.config = { dashboard: { ...ON, slack_team_id: "" } };
    expect(openLink(SLACK, { win })).toBe("web");
    expect(post).not.toHaveBeenCalled();
    expect(win.open.mock.calls).toEqual([[FIG, "_blank", "noopener"], [FIG, "_blank", "noopener"], [SLACK, "_blank", "noopener"]]);
  });

  it("plain browser (no handler) → window.open(web) at once, even for a convertible link: no deep attempt, no timer", () => {
    const { win, post } = fakeWin();
    for (const u of [FIG, SLACK]) expect(openLink(u, { win })).toBe("web");
    expect(win.open.mock.calls).toEqual([[FIG, "_blank", "noopener"], [SLACK, "_blank", "noopener"]]);
    expect(win.location.href).toBe("http://127.0.0.1:7777/");
    expect(win.setTimeout).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("empty url does nothing", () => {
    const { win } = fakeWin({ handler: true });
    expect(openLink("", { win })).toBe("web");
    expect(win.open).not.toHaveBeenCalled();
  });
});

describe("click delegation", () => {
  const open = vi.fn();
  const click = (el: Element, init: MouseEventInit = {}) => {
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    const took = onLinkClick(Object.defineProperty(ev, "target", { value: el }), open);
    return { ev, took };
  };
  beforeEach(() => {
    open.mockReset();
    document.body.innerHTML = `
      <a id="ext" href="${FIG}" target="_blank" rel="noopener"><span id="inner">파일</span></a>
      <a id="local" href="http://127.0.0.1:7777/#inbox" target="_blank">local</a>
      <a id="lh" href="http://localhost:7777/x">lh</a>
      <a id="hash" href="#settings">hash</a>
      <a id="dl" href="https://example.com/f.zip" download>dl</a>`;
  });

  it("plain left click on an external anchor (or inside it) → preventDefault + openLink(href)", () => {
    const { ev, took } = click(document.getElementById("inner")!);
    expect(took).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(FIG);
  });

  it("⌘ / Ctrl / ⇧ / ⌥ clicks, middle click, already-cancelled clicks pass through", () => {
    const a = document.getElementById("ext")!;
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const { ev, took } = click(a, init);
      expect(took).toBe(false);
      expect(ev.defaultPrevented).toBe(false);
    }
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    ev.preventDefault();
    expect(onLinkClick(Object.defineProperty(ev, "target", { value: a }), open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("dashboard links (127.0.0.1 / localhost / #) and download links pass through", () => {
    for (const id of ["local", "lh", "hash", "dl"]) {
      const { ev, took } = click(document.getElementById(id)!);
      expect(took, id).toBe(false);
      expect(ev.defaultPrevented, id).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("isExternalUrl", () => {
    expect(isExternalUrl("https://github.com/x", { host: "127.0.0.1:7777" })).toBe(true);
    expect(isExternalUrl("http://127.0.0.1:7777/a", { host: "127.0.0.1:7777" })).toBe(false);
    expect(isExternalUrl("http://ned.test/a", { host: "ned.test" })).toBe(false);
    expect(isExternalUrl("mailto:a@b.c")).toBe(false);
    expect(isExternalUrl("#x")).toBe(false);
    expect(isExternalUrl("https://")).toBe(false);
  });

  it("init: the document listener runs openLink for a real click (no webkit → window.open for a non-deep link)", () => {
    init(document);
    document.body.innerHTML = `<a id="gh" href="https://github.com/o/r/pull/1" target="_blank" rel="noopener">PR</a>`;
    const spy = vi.spyOn(window, "open").mockImplementation(() => null);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    document.getElementById("gh")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(spy).toHaveBeenCalledWith("https://github.com/o/r/pull/1", "_blank", "noopener");
    spy.mockRestore();
  });
});
