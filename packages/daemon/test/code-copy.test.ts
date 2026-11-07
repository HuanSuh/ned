// @vitest-environment jsdom
/** Copy button on mdLite code blocks (chat-core.js codeBlockHtml + features/code-copy.js delegated handler). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { mdLite } from "../public/app/features/chat-core.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { COPIED_MS, bindCodeCopy, codeOf, copyText, legacyCopy } from "../public/app/features/code-copy.js";

const SRC = "설명\n```ts\nconst a = 1 < 2 && \"x\";\n  indented `tick`\n```\n끝 `inline`";
const ORIGINAL = "const a = 1 < 2 && \"x\";\n  indented `tick`";
const flush = () => new Promise((r) => setTimeout(r, 0));

function setClipboard(v: unknown) {
  Object.defineProperty(window.navigator, "clipboard", { value: v, configurable: true });
}

describe("code block copy button", () => {
  beforeEach(() => { document.body.innerHTML = `<div class="bb">${mdLite(SRC)}</div>`; bindCodeCopy(document); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setClipboard(undefined); });

  it("one focusable button per fenced block, none for inline code; aria", () => {
    const btns = document.querySelectorAll("button.cm-copy");
    expect(btns).toHaveLength(1);
    const b = btns[0] as HTMLButtonElement;
    expect(b.type).toBe("button");
    expect(b.getAttribute("aria-label")).toBe("복사");
    expect(b.tabIndex).toBe(0);
    b.focus();
    expect(document.activeElement).toBe(b);
    // inline `code` stays plain
    const inline = [...document.querySelectorAll("code")].find((c) => !c.closest("pre"))!;
    expect(inline.textContent).toBe("inline");
    expect(inline.closest(".cm-code")).toBeNull();
    expect(document.querySelectorAll(".cm-code")).toHaveLength(1);
    expect(b.nextElementSibling!.matches("pre")).toBe(true);
    // the svg icons are hidden from AT
    for (const s of b.querySelectorAll("svg")) expect(s.getAttribute("aria-hidden")).toBe("true");
  });

  it("copies the unescaped original text without the ```lang line; ✓ for 1.5s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const b = document.querySelector<HTMLButtonElement>(".cm-copy")!;
    expect(codeOf(b)).toBe(ORIGINAL);
    b.click();
    await vi.waitFor(() => expect(b.classList.contains("ok")).toBe(true));
    expect(writeText).toHaveBeenCalledWith(ORIGINAL);
    expect(writeText.mock.calls[0][0]).not.toContain("ts\n");
    expect(b.getAttribute("aria-label")).toBe("복사됨");
    vi.advanceTimersByTime(COPIED_MS);
    expect(b.classList.contains("ok")).toBe(false);
    expect(b.getAttribute("aria-label")).toBe("복사");
  });

  it("falls back to hidden textarea + execCommand when clipboard API rejects or is missing", async () => {
    let copied: string | null = null;
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn((cmd: string) => {
      if (cmd !== "copy") return false;
      const ta = document.activeElement as HTMLTextAreaElement;
      copied = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      return true;
    });
    setClipboard({ writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) });
    const b = document.querySelector<HTMLButtonElement>(".cm-copy")!;
    b.click();
    await vi.waitFor(() => expect(b.classList.contains("ok")).toBe(true));
    expect(copied).toBe(ORIGINAL);
    expect(document.querySelector("textarea")).toBeNull(); // cleaned up

    copied = null;
    setClipboard(undefined);
    expect(await copyText("abc")).toBe(true);
    expect(copied).toBe("abc");
  });

  it("reports failure (no ✓) when every path fails", async () => {
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => false);
    setClipboard(undefined);
    expect(legacyCopy("x")).toBe(false);
    const b = document.querySelector<HTMLButtonElement>(".cm-copy")!;
    b.click();
    await flush();
    expect(b.classList.contains("ok")).toBe(false);
  });

  it("clicks elsewhere are ignored; binding twice keeps one listener", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    bindCodeCopy(document);
    document.querySelector<HTMLElement>("pre")!.click();
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>(".cm-copy")!.click();
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
