// @vitest-environment jsdom
/** GFM tables in mdLite (chat-core.js tableHtml / textHtml) + their copy buttons (code-copy.js). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { mdLite, messagesHtml, COMMS_VOICE, splitRow, tableAligns, tableTsv, plainInline } from "../public/app/features/chat-core.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { bindCodeCopy, codeOf } from "../public/app/features/code-copy.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { renderOutputCard } from "../public/app/features/chat-output.js";

const BASIC = "| 이름 | 상태 |\n| --- | --- |\n| 샘플 계획 | 진행 |\n| 사람A | 대기 |";
const dom = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
const cells = (el: Element, sel = "td") => [...el.querySelectorAll(sel)].map((c) => c.textContent);
/** Every open tag has its close tag, in order — the HTML string itself is balanced (not just what the parser repairs). */
function balanced(html: string) {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)(table|thead|tbody|tr|th|td|div|span|button|pre|code|a|b)\b[^>]*>/g)) {
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

describe("mdLite tables", () => {
  it("basic: header + delimiter + rows → <table> in a scroll wrapper with a copy button", () => {
    const d = dom(mdLite(BASIC));
    const t = d.querySelector(".cm-code.cm-tablewrap > .cm-tbl > table")!;
    expect(t).not.toBeNull();
    expect(cells(t, "th")).toEqual(["이름", "상태"]);
    expect(cells(t)).toEqual(["샘플 계획", "진행", "사람A", "대기"]);
    expect(t.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(d.querySelectorAll(".cm-tablewrap > button.cm-copy")).toHaveLength(1);
    expect(d.querySelector(".cm-copy-alt")!.textContent).toBe("TSV 복사");
    expect(d.innerHTML).not.toContain("<br>");
    expect(d.textContent).not.toContain("---");
  });

  it("alignment from the delimiter row", () => {
    expect(tableAligns("|:---|:---:|---:|---|")).toEqual(["left", "center", "right", ""]);
    expect(tableAligns("| a | b |")).toBeNull();
    const t = dom(mdLite("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |")).querySelector("table")!;
    expect([...t.querySelectorAll("td")].map((c) => (c as HTMLElement).style.textAlign)).toEqual(["left", "center", "right", ""]);
    expect((t.querySelector("th") as HTMLElement).style.textAlign).toBe("left");
  });

  it("cells keep inline markdown: link, code, bold; \\| is a literal pipe", () => {
    const d = dom(mdLite("| 링크 | 코드 |\n|---|---|\n| [PR](https://example.com/pr/1) | `a \\| b` **굵게** |"));
    const a = d.querySelector("td a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/pr/1");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(d.querySelector("td code")!.textContent).toBe("a | b");
    expect(d.querySelector("td b")!.textContent).toBe("굵게");
    expect(d.querySelectorAll("td")).toHaveLength(2);
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("empty cells and ragged rows are filled / cut to the header width", () => {
    const t = dom(mdLite("| a | b | c |\n|---|---|---|\n| 1 |  | 3 |\n| x |\n| p | q | r | s |")).querySelector("table")!;
    expect([...t.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent))).toEqual([["1", "", "3"], ["x", "", ""], ["p", "q", "r"]]);
  });

  it("paragraphs before / after stay text; a blank or pipe-less line ends the table", () => {
    const html = mdLite(`앞 문단\n${BASIC}\n뒤 문단\n둘째 줄`);
    expect(html.startsWith("앞 문단<div class=\"cm-code cm-tablewrap\"")).toBe(true);
    expect(html.endsWith("</table></div></div>뒤 문단<br>둘째 줄")).toBe(true);
    const d = dom(mdLite(`${BASIC}\n\n| 표 | 밖 |`));
    expect(d.querySelectorAll("table")).toHaveLength(1);
    expect(d.textContent).toContain("| 표 | 밖 |");
  });

  it("pipes inside a fence are never a table", () => {
    const d = dom(mdLite(`설명\n\`\`\`md\n${BASIC}\n\`\`\`\n끝`));
    expect(d.querySelector("table")).toBeNull();
    expect(d.querySelector("pre code")!.textContent).toBe(BASIC);
  });

  it("pipe lines without a delimiter row (or a mismatched one) stay as written", () => {
    expect(mdLite("| a | b |\n| 1 | 2 |")).toBe("| a | b |<br>| 1 | 2 |");
    expect(mdLite("a | b")).toBe("a | b");
    expect(dom(mdLite("| a | b |\n|---|\n| 1 | 2 |")).querySelector("table")).toBeNull();
    expect(dom(mdLite("| a | b |\n|-x-|---|")).querySelector("table")).toBeNull();
  });

  it("escapes <script> and refuses javascript: links inside cells", () => {
    const html = mdLite("| x | y |\n|---|---|\n| <script>alert(1)</script> | [bad](javascript:alert(1)) |\n| <img src=x onerror=alert(1)> | \"'&\" |");
    const d = dom(html);
    expect(d.querySelector("script, img")).toBeNull();
    expect(d.querySelector("a")).toBeNull();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(cells(d)[1]).toBe("[bad](javascript:alert(1))");
    // the raw markdown in data-md / data-alt is attribute-escaped too
    expect(d.querySelectorAll("[onerror]")).toHaveLength(0);
    expect((d.querySelector(".cm-tablewrap") as HTMLElement).dataset.md).toContain("<script>alert(1)</script>");
    expect(balanced(html)).toBe(true);
  });

  it("streaming: an unfinished table stays text and the HTML is always balanced", () => {
    const full = `앞\n${BASIC}\n뒤`;
    for (let n = 1; n <= full.length; n++) {
      const html = mdLite(full.slice(0, n), { live: true });
      expect(balanced(html), full.slice(0, n)).toBe(true);
    }
    // header only / half a delimiter → text
    expect(mdLite("| 이름 | 상태 |", { live: true })).toBe("| 이름 | 상태 |");
    expect(mdLite("| 이름 | 상태 |\n| --- | -", { live: true })).not.toContain("<table");
    // a complete delimiter line at the end, but no newline yet → still text (it may grow another column)
    expect(mdLite("| 이름 | 상태 |\n| --- | --- |", { live: true })).not.toContain("<table");
    // delimiter done → a table of the finished rows; the row being typed shows as text after it
    const mid = dom(mdLite("| 이름 | 상태 |\n| --- | --- |\n| 샘플 계획 | 진행 |\n| 사람A | 대", { live: true }));
    expect(cells(mid)).toEqual(["샘플 계획", "진행"]);
    expect(mid.lastChild!.textContent).toBe("| 사람A | 대");
    // once the line ends, it joins
    expect(cells(dom(mdLite("| 이름 | 상태 |\n| --- | --- |\n| 사람A | 대기 |\n", { live: true })))).toEqual(["사람A", "대기"]);
    // a finished answer (not live) renders the last row
    expect(cells(dom(mdLite(BASIC)))).toHaveLength(4);
  });

  it("messagesHtml live bubble uses the open-tail rule; finished messages don't", () => {
    const live = messagesHtml([], COMMS_VOICE.ned, { text: "| a | b |\n|---|---|\n| 1 | 2" });
    expect(cells(dom(live))).toEqual([]);
    expect(dom(live).querySelector("table")).not.toBeNull(); // header-only table so far
    const done = messagesHtml([{ role: "ned", text: "| a | b |\n|---|---|\n| 1 | 2", ts: 1 }], COMMS_VOICE.ned);
    expect(cells(dom(done))).toEqual(["1", "2"]);
  });

  it("output card (renderOutputCard with mdLite) renders tables too", () => {
    const html = renderOutputCard({ block: { kind: "note", title: "샘플 계획", markdown: BASIC } }, mdLite);
    expect(dom(html).querySelector(".co-md .cm-tbl table")).not.toBeNull();
  });
});

describe("table copy", () => {
  afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true }); });

  it("TSV: inline marks → plain text, tabs / newlines → spaces, ragged rows padded", () => {
    expect(plainInline("[PR](https://example.com/1) `x` **b** https://example.com/y")).toBe("PR x b https://example.com/y");
    expect(tableTsv([["a", "b"], ["1\t2", "x\ny"]])).toBe("a\tb\n1 2\tx y");
    const d = dom(mdLite("| 이름 | 링크 |\n|:--|--:|\n| **사람A** | [PR](https://example.com/1) |\n| `코드` |"));
    expect((d.querySelector(".cm-copy-alt") as HTMLElement).dataset.alt).toBe("이름\t링크\n사람A\tPR\n코드\t");
  });

  it("main button copies the markdown source, the alt copies TSV (delegated handler)", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    document.body.innerHTML = `<div class="bb">${mdLite(`앞\n${BASIC}\n뒤`)}</div>`;
    bindCodeCopy(document);
    const btn = document.querySelector<HTMLButtonElement>(".cm-tablewrap .cm-copy")!;
    expect(btn.getAttribute("aria-label")).toBe("표 복사 (마크다운)");
    expect(codeOf(btn)).toBe(BASIC);
    btn.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(BASIC));
    document.querySelector<HTMLButtonElement>(".cm-tablewrap .cm-copy-alt")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("이름\t상태\n샘플 계획\t진행\n사람A\t대기"));
  });

  it("narrow panel: only the table scrolls sideways (CSS rule), the bubble keeps wrapping", () => {
    const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/css/comms.css"), "utf8");
    const rule = css.match(/\.cm-tbl\s*\{([^}]*)\}/)![1];
    expect(rule).toMatch(/overflow-x:\s*auto/);
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(css).toMatch(/\.cm-tbl table\s*\{[^}]*overflow-wrap:\s*normal/);
    // no hard-coded colors in the table rules — theme tokens only
    const tbl = css.split("\n").filter((l) => l.includes(".cm-tbl")).join("\n");
    expect(tbl).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    // the wrapper class is what the rule targets
    expect(dom(mdLite(BASIC)).querySelector(".cm-tbl")).not.toBeNull();
  });
});
