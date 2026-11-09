// @vitest-environment jsdom
/**
 * ✓ click handling in the browser (reviewed.js init's delegated listener): a row without a review key renders an inert
 * ✓ (aria-disabled, not `disabled` — a disabled button never gets the click) whose click shows a toast and sends
 * nothing; a failed POST rolls the optimistic mark back with a toast.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
const api = vi.fn();
vi.mock("../public/app/ui/toast.js", () => ({ toast }));
vi.mock("../public/app/api.js", () => ({ api }));
vi.mock("../public/app/main.js", () => ({ loadState: vi.fn(), renderAll: vi.fn() }));
vi.mock("../public/app/features/sendjob.js", () => ({ waitJob: vi.fn() }));

// @ts-expect-error — plain browser ES module (public/app), no types
const { init, reviewSource } = await import("../public/app/features/reviewed.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { srcCheck } = await import("../public/app/features/revkeys.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { S } = await import("../public/app/state.js");

const flush = () => new Promise((r) => setTimeout(r, 0));
beforeAll(() => init());
beforeEach(() => { toast.mockReset(); api.mockReset(); S.agenda = { reviewed: {} }; });

describe("✓ without a key", () => {
  it("is clickable (aria-disabled, no disabled attr) and the click toasts 확인 키 없음 without a POST", () => {
    document.body.innerHTML = `<div class="ra">${srcCheck("slack", { url: "", text: "x" })}</div>`;
    const b = document.querySelector("button") as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    b.click();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(toast.mock.calls[0][0])).toContain("확인 키 없음");
    expect(api).not.toHaveBeenCalled();
  });
  it("reviewSource with an empty key toasts and never POSTs", async () => {
    await reviewSource("", true);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
    expect(S.agenda.reviewed).toEqual({});
  });
});

describe("✓ POST failure", () => {
  it("rolls the optimistic mark back (set and un-set) and toasts", async () => {
    api.mockRejectedValue(new Error("offline"));
    await reviewSource("slack:C1:1700000000.000100", true);
    expect(S.agenda.reviewed).toEqual({});
    expect(String(toast.mock.calls[0][0])).toContain("확인 표시 실패");
    S.agenda.reviewed = { "slack:C1:1700000000.000100": 123 };
    await reviewSource("slack:C1:1700000000.000100", false);
    expect(S.agenda.reviewed).toEqual({ "slack:C1:1700000000.000100": 123 });
    expect(toast).toHaveBeenCalledTimes(2);
  });
  it("a keyed ✓ click POSTs its key and keeps the mark on success", async () => {
    api.mockResolvedValue({ ok: true });
    document.body.innerHTML = `<div class="ra">${srcCheck("slack", { url: "https://x.slack.com/archives/C1/p1700000000000100", ts: "2023-11-14T22:13:20Z" })}</div>`;
    (document.querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toBe(`/api/attention/${encodeURIComponent("slack:C1:1700000000.000100")}/review`);
    expect(S.agenda.reviewed["slack:C1:1700000000.000100"]).toBeTypeOf("number");
    expect(toast).not.toHaveBeenCalled();
  });
});
