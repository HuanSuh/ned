// @vitest-environment jsdom
/**
 * Inbox / briefing detail text through mdLite (tabs/inbox.js mdBody, sectionList): tables + inline markdown in the
 * multi-line detail, plain text unchanged, everything model / read-message supplied stays escaped. List rows stay esc().
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../public/app/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("../public/app/api.js", () => ({ api: vi.fn() }));
vi.mock("../public/app/main.js", () => ({ loadState: vi.fn(), renderAll: vi.fn(), renderHeader: vi.fn() }));
vi.mock("../public/app/features/sendjob.js", () => ({ waitJob: vi.fn() }));

// @ts-expect-error — plain browser ES module (public/app), no types
const { mdBody, sectionList } = await import("../public/app/tabs/inbox.js");

const TABLE = "| 항목 | 상태 |\n|---|:-:|\n| 샘플 계획 | 진행 |\n| 사람A 리뷰 | 대기 |";
const dom = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d; };

describe("detail body (mdBody)", () => {
  it("plain multi-line text: same lines, escaped — only \\n becomes <br>", () => {
    const d = dom(mdBody("첫 줄 <b>굵게 아님</b>\n  둘째 줄 & 셋"));
    const body = d.querySelector(".body.md-lite")!;
    expect(body.querySelector("b")).toBeNull();
    expect(body.innerHTML).toBe("첫 줄 &lt;b&gt;굵게 아님&lt;/b&gt;<br>  둘째 줄 &amp; 셋");
    expect(body.textContent).toBe("첫 줄 <b>굵게 아님</b>  둘째 줄 & 셋");
  });

  it("a table in the detail renders as a table (scroll wrapper + copy buttons)", () => {
    const d = dom(mdBody(`요약 문단\n${TABLE}\n끝`));
    const t = d.querySelector(".body .cm-code.cm-tablewrap > .cm-tbl > table")!;
    expect([...t.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["항목", "상태"]);
    expect([...t.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["샘플 계획", "진행", "사람A 리뷰", "대기"]);
    expect(d.querySelector(".cm-tablewrap .cm-copy")).not.toBeNull();
    expect((d.querySelector(".cm-copy-alt") as HTMLElement).dataset.alt).toBe("항목\t상태\n샘플 계획\t진행\n사람A 리뷰\t대기");
  });

  it("links: https → anchor (opens via the openlink delegate); javascript: stays text", () => {
    const d = dom(mdBody("[PR](https://example.com/pr/1) 그리고 [bad](javascript:alert(1))"));
    const as = d.querySelectorAll("a");
    expect(as).toHaveLength(1);
    expect(as[0].getAttribute("href")).toBe("https://example.com/pr/1");
    expect(as[0].getAttribute("target")).toBe("_blank");
    expect(d.textContent).toContain("[bad](javascript:alert(1))");
  });

  it("XSS: <script> / onerror in body and in table cells stay text", () => {
    const src = "<script>alert(1)</script>\n| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n<svg onload=alert(1)>";
    const d = dom(mdBody(src));
    expect(d.querySelector("script, img, svg:not(.ic-copy):not(.ic-ok)")).toBeNull();
    expect(d.querySelectorAll("[onerror], [onload]")).toHaveLength(0);
    expect(d.querySelectorAll("a")).toHaveLength(0);
    expect(d.querySelector("td")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("briefing section items (sectionList)", () => {
  it("title stays a plain link / text; the item detail goes through mdLite", () => {
    const html = sectionList("업데이트", [
      { kind: "jira", title: "샘플 계획 **진행**", url: "https://example.com/i/1", detail: `세부\n${TABLE}` },
      { kind: "slack", title: "<b>제목</b>", detail: "`코드` 와 **굵게**" },
    ]);
    const d = dom(html);
    const li = d.querySelectorAll("li");
    expect(li[0].querySelector("a")!.textContent).toBe("샘플 계획 **진행**"); // title not markdown-rendered
    expect(li[0].querySelector(".d.md-lite table")).not.toBeNull();
    expect(li[1].querySelector("b")!.textContent).toBe("굵게");
    expect(li[1].querySelector(".d code")!.textContent).toBe("코드");
    expect(li[1].textContent).toContain("<b>제목</b>"); // escaped title
    expect(sectionList("x", [])).toBe("");
  });

  it("inbox.css styles the md-lite widgets with theme tokens (no hard-coded colors)", () => {
    const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/css/inbox.css"), "utf8");
    const rules = css.split("\n").filter((l) => l.includes(".md-lite")).join("\n");
    expect(rules).toMatch(/\.md-lite \.cm-code\s*\{[^}]*white-space:\s*normal/);
    expect(rules).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
