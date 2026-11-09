// @vitest-environment jsdom
/**
 * Regression (review H1): the inbox row ↗ icon (`<a class="ib ib-open" target=_blank>` from icons.js openIcon) sits
 * under `#items .row .ib`, whose clicks reviewed.js stops in the document CAPTURE phase. The link delegate must still
 * see them (openlink.js init = capture listener, registered first like main.js does), while the row itself keeps not
 * receiving icon clicks (no row select) and ✓ keeps working.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
const api = vi.fn();
vi.mock("../public/app/ui/toast.js", () => ({ toast }));
vi.mock("../public/app/api.js", () => ({ api }));
vi.mock("../public/app/main.js", () => ({ loadState: vi.fn(), renderAll: vi.fn() }));
vi.mock("../public/app/features/sendjob.js", () => ({ waitJob: vi.fn() }));

// @ts-expect-error — plain browser ES module (public/app), no types
const { init: initOpenLink } = await import("../public/app/features/openlink.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { init: initReviewed } = await import("../public/app/features/reviewed.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { openIcon, reviewIcon } = await import("../public/app/ui/icons.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { S } = await import("../public/app/state.js");

const T = "T0ABC1234";
const SLACK = "https://acme.slack.com/archives/C0123ABCD/p1794193614524359";
const post = vi.fn();
const rowClick = vi.fn();

beforeAll(() => { initOpenLink(document); initReviewed(); }); // main.js order: openlink first
beforeEach(() => {
  post.mockReset(); rowClick.mockReset(); api.mockReset();
  S.config = { dashboard: { open_links_in_app: true, slack_team_id: T } };
  S.agenda = { reviewed: {} };
  S.state = { attention: [{ id: "a1" }] };
  document.body.innerHTML = `<ul id="items"><li class="row">항목 ${openIcon(SLACK)} ${reviewIcon({ id: "a1" })}</li></ul>`;
  document.querySelector(".row")!.addEventListener("click", rowClick);
  (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { openLink: { postMessage: post } } };
});
afterEach(() => { delete (window as unknown as { webkit?: unknown }).webkit; });

describe("inbox row ↗ (a.ib inside #items .row)", () => {
  it("goes through openLink (Ned.app postMessage) and the default action is cancelled; the row is not selected", () => {
    const a = document.querySelector("#items .row a.ib") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(SLACK);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith({ deep: `slack://channel?team=${T}&id=C0123ABCD&message=1794193614.524359`, web: SLACK });
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("⌘-click passes through untouched (web), still not reaching the row", () => {
    const a = document.querySelector("#items .row a.ib") as HTMLAnchorElement;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("✓ (button.ib) keeps its own handling: no openLink, no row click", () => {
    api.mockResolvedValue({});
    const b = document.querySelector("#items .row button.ib") as HTMLButtonElement;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(post).not.toHaveBeenCalled();
    expect(rowClick).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalled();
  });
});
