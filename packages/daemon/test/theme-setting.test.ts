// @vitest-environment jsdom
/**
 * 설정 → 외형 → 테마 (config.dashboard.theme → <html data-theme>):
 * - the <head> script applies the localStorage cache before any stylesheet (no flash);
 * - /api/config then wins (syncTheme), a radio pick previews without saving, 저장 writes config + cache;
 * - css/theme.css loads after comms.css; tokens.css keeps every light block both forced and OS-driven.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// settings.js → main.js boots the whole dashboard on import. Not needed here.
vi.mock("../public/app/main.js", () => ({ loadAgenda: () => {}, loadState: async () => {}, renderAll: () => {} }));

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const head = indexHtml.slice(indexHtml.indexOf("<head>"), indexHtml.indexOf("</head>"));
const themeScript = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("ned.theme"))!;
const runHead = () => window.eval(themeScript);
const html = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  delete html.dataset.theme;
});

describe("<head> theme script", () => {
  it("runs before any stylesheet and applies the cached theme (absent / junk → system)", () => {
    expect(themeScript).toBeTruthy();
    expect(head.indexOf(themeScript)).toBeLessThan(head.indexOf('<link rel="stylesheet"'));
    runHead();
    expect(html.dataset.theme).toBe("system");
    localStorage.setItem("ned.theme", "dark");
    runHead();
    expect(html.dataset.theme).toBe("dark");
    localStorage.setItem("ned.theme", "neon");
    runHead();
    expect(html.dataset.theme).toBe("system");
  });

  it("theme.css loads right after comms.css", () => {
    const links = [...head.matchAll(/<link rel="stylesheet" href="\/css\/([^"]+)"/g)].map((m) => m[1]);
    expect(links.indexOf("theme.css")).toBe(links.indexOf("comms.css") + 1);
  });
});

describe("theme.js", () => {
  it("themeHtml: three radios, the current one checked (snapshot)", async () => {
    const { themeHtml } = await import("../public/app/features/theme.js");
    expect(themeHtml("light")).toMatchInlineSnapshot(`"<label><input type="radio" name="c-theme" value="system"><span class="thic" aria-hidden="true">🖥️</span>시스템</label><label><input type="radio" name="c-theme" value="light" checked><span class="thic" aria-hidden="true">☀️</span>라이트</label><label><input type="radio" name="c-theme" value="dark"><span class="thic" aria-hidden="true">🌙</span>다크</label>"`);
    expect([...themeHtml(undefined).matchAll(/value="(\w+)" checked/g)].map((m) => m[1])).toEqual(["system"]);
    expect([...themeHtml("bogus").matchAll(/value="(\w+)" checked/g)].map((m) => m[1])).toEqual(["system"]);
  });

  it("order: cache first, then the server value wins and is cached; an older daemon (no theme) keeps the cache", async () => {
    const { syncTheme, applyTheme } = await import("../public/app/features/theme.js");
    localStorage.setItem("ned.theme", "dark");
    runHead();
    expect(html.dataset.theme).toBe("dark");
    syncTheme({ theme: "light" });
    expect(html.dataset.theme).toBe("light");
    expect(localStorage.getItem("ned.theme")).toBe("light");
    syncTheme({ card_order: [] });
    expect(html.dataset.theme).toBe("light");
    applyTheme("dark"); // preview: no cache write
    expect(html.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ned.theme")).toBe("light");
  });
});

describe("settings → 외형 → 테마", () => {
  it("renders the server value, previews a pick (dirty, not cached), saves config + cache", async () => {
    document.body.innerHTML = indexHtml.slice(indexHtml.indexOf("<body"), indexHtml.lastIndexOf("</body>")).replace(/^<body[^>]*>/, "");
    window.HTMLElement.prototype.scrollIntoView ??= () => {};
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    let server = { port: 7796, sources: { slack: true }, dashboard: { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 }, layout: null, locked: false, watch_cards: true, theme: "dark" } };
    const puts: Array<{ dashboard: { theme: string } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/config" && opts?.method === "PUT") {
        const body = JSON.parse(String(opts.body));
        puts.push(body);
        server = { ...server, dashboard: { ...server.dashboard, theme: body.dashboard.theme } };
        return new Response(JSON.stringify(server), { status: 200 });
      }
      return new Response(url === "/api/actions" ? "[]" : "{}", { status: 200 });
    }));
    const { S } = await import("../public/app/state.js");
    const settings = await import("../public/app/tabs/settings.js");
    settings.init();
    localStorage.setItem("ned.theme", "light");
    runHead();
    expect(html.dataset.theme).toBe("light"); // cache, before config arrives

    S.config = structuredClone(server);
    settings.renderConfig();
    const checked = () => (document.querySelector("input[name=c-theme]:checked") as HTMLInputElement | null)?.value;
    expect(html.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ned.theme")).toBe("dark");
    expect(checked()).toBe("dark");
    expect(document.querySelectorAll("#c-theme input[type=radio]").length).toBe(3);
    expect(settings.isDirty()).toBe(false);

    // pick 라이트 → applied right away, 저장 안 된 변경 shows, cache untouched
    const light = document.querySelector('input[name=c-theme][value="light"]') as HTMLInputElement;
    light.click();
    await Promise.resolve();
    expect(html.dataset.theme).toBe("light");
    expect(localStorage.getItem("ned.theme")).toBe("dark");
    expect(settings.isDirty()).toBe(true);
    expect(document.getElementById("c-dirty")!.hidden).toBe(false);
    expect(settings.readBody().dashboard.theme).toBe("light");

    // a config reload drops the unsaved preview
    settings.renderConfig();
    expect(html.dataset.theme).toBe("dark");
    expect(checked()).toBe("dark");

    // pick again and 저장 → PUT carries it, cache follows the server's answer
    (document.querySelector('input[name=c-theme][value="light"]') as HTMLInputElement).click();
    document.getElementById("cfg")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(localStorage.getItem("ned.theme")).toBe("light"));
    expect(puts.at(-1)!.dashboard.theme).toBe("light");
    expect(html.dataset.theme).toBe("light");
    expect(checked()).toBe("light");
    expect(settings.isDirty()).toBe(false);
  });
});

describe("tokens.css", () => {
  const css = fs.readFileSync(path.join(pub, "css/tokens.css"), "utf8");
  it("every light block exists forced (data-theme=light) and OS-driven (unless data-theme=dark), with :where() specificity", () => {
    for (const p of ["ned", "alfred", "oracle", "jarvis"]) {
      expect(css).toContain(`:where([data-theme="light"]) [data-persona="${p}"], [data-persona="${p}"]:where(:root[data-theme="light"])`);
      expect(css).toContain(`:where(:root:not([data-theme="dark"])) [data-persona="${p}"], [data-persona="${p}"]:where(:root:not([data-theme="dark"]))`);
    }
    expect(css.match(/@media \(prefers-color-scheme: light\)/g)).toHaveLength(4);
    expect(css).toContain(':root[data-theme="light"] { color-scheme: light; }');
    expect(css).toContain(':root[data-theme="dark"] { color-scheme: dark; }');
  });
});
