// @vitest-environment jsdom
/**
 * Esc with both the search palette (public/search.js) and the comms panel (public/app/features/comms.js) open:
 * the first Esc closes only the palette, the second closes the panel. Both listen on document in the capture phase;
 * search.js is registered first here (worst case — once it closes the palette, comms' "#nsp.open" guard is gone).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// comms.js → personas.js / reviewed.js import main.js, which boots the whole dashboard on import. Not needed here.
vi.mock("../public/app/main.js", () => ({ loadState: async () => {}, renderAll: () => {} }));

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

describe("Esc: palette + comms panel", () => {
  it("first Esc closes only the palette, second Esc closes the panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    window.HTMLElement.prototype.scrollIntoView ??= () => {};
    // search.js first: a classic script (IIFE), evaluated in the jsdom window.
    window.eval(fs.readFileSync(path.join(pub, "search.js"), "utf8"));
    const comms = await import("../public/app/features/comms.js");
    comms.init();
    comms.open("chat");

    const key = (target: EventTarget, init: KeyboardEventInit) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    key(document.body, { key: "k", ctrlKey: true }); // open the palette
    const nsp = document.getElementById("nsp")!;
    const panel = document.getElementById("cm-panel")!;
    expect(nsp.classList.contains("open")).toBe(true);
    expect(panel.hidden).toBe(false);

    // Esc from inside the comms panel (outside the palette): the palette's document handler closes it.
    const q = document.getElementById("cm-q")!;
    key(q, { key: "Escape" });
    expect(nsp.classList.contains("open")).toBe(false);
    expect(panel.hidden).toBe(false);

    key(q, { key: "Escape" });
    expect(panel.hidden).toBe(true);
  });
});
