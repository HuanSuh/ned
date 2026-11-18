// @vitest-environment jsdom
/**
 * ⌘K 검색 키 — the palette (public/search.js) and GET /api/search (src/search.ts) over the same agenda: same hits for the
 * same query (keys + words), plus the palette DOM — chips, chip ✕, autocomplete open / pick, and the result keys
 * (↑↓ / Tab / Ctrl+N/P / ⏎) going to the autocomplete list only while it is open. Fake names only.
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AGENDA_PATH, REVIEWED_PATH, TODOS_PATH } from "../src/paths.js";
import { search } from "../src/search.js";

const now = Date.now();
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const slackTs = (ms: number) => `${Math.floor(ms / 1000)}.000100`;
const link = (ch: string, ms: number) => `https://x.slack.com/archives/${ch}/p${slackTs(ms).replace(".", "")}`;

const T1 = now - 1 * H, T2 = now - 2 * H, T3 = now - 50 * H, T4 = now - 5 * H;
const slackRow = (channel: string, from: string, text: string, ms: number, ch: string) => ({ channel, from, text, url: link(ch, ms), ts: iso(ms), reason: "mention" });
const AGENDA = {
  updated_at: now, cost_usd: 0, calendar: [],
  jira: [{ key: "APP-1", title: "매출 대시보드", status: "To Do", priority: "High", due: null, url: "https://jira.example.com/browse/APP-1", updated: iso(now - 30 * H) }],
  github: [
    { repo: "acme/web", number: 7, title: "fix revenue chart", url: "https://github.com/acme/web/pull/7", author: "seo-jisu", updated: iso(now - 40 * H), reason: "review_requested" },
    { repo: "acme/web", number: 8, title: "my change", url: "https://github.com/acme/web/pull/8", author: "dev-me", updated: iso(now - 60 * H), reason: "my_pr_approved" },
  ],
  mail: { summary: "", unread: 1, unread_capped: false, items: [{ id: "th1", from: "서 지수 <jisu@example.com>", subject: "매출 정산", snippet: "", received: iso(T4), url: "https://mail.google.com/mail/u/0/#inbox/th1", reason: "reply", why: "" }], all: [] },
  slack: {
    summary: "",
    items: [
      slackRow("#팀-매출", "서지수/팀X", "매출 리포트 확인 부탁", T1, "C0TEST001"),
      slackRow("#general", "사람B", "서지수 님이 매출 얘기함", T2, "C0TEST002"),
      slackRow("#팀-매출", "사람A", "배포 일정 공유", T3, "C0TEST001"),
      slackRow("#팀-매출", "서지수", "정산 마감 공유", now - 7 * H, "C0TEST001"), // exact "서지수" next to 서지수/팀X
      slackRow("#test", "<b>사람D</b>", "굵게 <img src=x onerror=1> 테스트", now - 8 * H, "C0TEST004"),
    ],
    all: [], watch: [],
  },
};
// ✓ on the 사람A message (mark after its last change → is:done).
const MARKS = { [`slack:C0TEST001:${slackTs(T3)}`]: now };
const TODOS = [{ id: "t1", title: "매출 보고서", done: false, created_at: now - 3 * H, done_at: null, due: null, note: null }, { id: "t2", title: "정리", done: true, created_at: now - 4 * H, done_at: now, due: null, note: null }];

const openSpy = vi.fn();
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const $ = (id: string) => document.getElementById(id)!;
const input = () => $("nsp-q") as HTMLInputElement;
const keys = () => [...document.querySelectorAll<HTMLElement>("#nsp-res .it[data-key]")].map((el) => el.dataset.key!).sort();
const selIdx = () => document.querySelector<HTMLElement>("#nsp-res .it.sel")?.dataset.i;
const key = (init: KeyboardEventInit) => input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
const type = (v: string) => {
  input().value = v;
  input().setSelectionRange(v.length, v.length);
  input().dispatchEvent(new Event("input", { bubbles: true }));
};

beforeAll(async () => {
  fs.writeFileSync(AGENDA_PATH, JSON.stringify(AGENDA));
  fs.writeFileSync(TODOS_PATH, JSON.stringify(TODOS));
  fs.writeFileSync(REVIEWED_PATH, JSON.stringify(MARKS));
  const cfg = loadConfig();
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    const p = String(u);
    if (p.startsWith("/api/state")) return json({ attention: [], sessions: [] });
    if (p.startsWith("/api/agenda")) return json({ ...AGENDA, reviewed: MARKS });
    if (p.startsWith("/api/todos")) return json(TODOS);
    if (p.startsWith("/api/config")) return json(cfg);
    return json([]); // briefings, events, /api/search (local hits only — compared with the server below)
  }));
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.open = openSpy as unknown as typeof window.open; // ⏎ on a hit with a url (no NED.openLink here)
  window.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0)) as typeof window.requestAnimationFrame;
  await import("../public/search.js");
  (window as any).NedSearch.open("");
  await (window as any).NedSearch.refresh();
});

describe("palette and GET /api/search agree", () => {
  const QUERIES = [
    "from:서지수", "from:ㅅㅈㅅ", "from:\"서 지수\"", "source:슬랙 from:서지수 매출", "#팀-매출", "channel:팀 is:done", "is:open", "is:done",
    "is:mine", "days:1", "매출", "source:할일 is:open", "in:gh", "source:지라", "foo:bar 매출",
  ];
  it.each(QUERIES)("%s", (q) => {
    type(q);
    const server = search(q).map((h) => `${h.type}:${h.id}`).sort();
    expect(keys()).toEqual(server);
    expect(server.length, "fixture should hit something").toBeGreaterThan(q === "foo:bar 매출" ? -1 : 0);
  });

  it("from: excludes a message that only mentions the name", () => {
    const hits = search("from:서지수").map((h) => h.title);
    expect(hits).toContain("매출 리포트 확인 부탁");
    expect(hits).toContain("매출 정산");
    expect(hits).not.toContain("서지수 님이 매출 얘기함");
  });

  it("keys only → newest first on the server; limit kept", () => {
    const ts = search("source:슬랙").map((h) => h.ts ?? 0);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
    expect(search("source:슬랙", 1)).toHaveLength(1);
  });
});

describe("palette DOM", () => {
  it("empty input shows the 검색 키 hint line", () => {
    type("");
    expect($("nsp-hint").textContent).toContain("from:이름");
    expect($("nsp-chips").children).toHaveLength(0);
  });

  it("chips for recognized keys, grey for unknown; ✕ removes that condition", () => {
    type("from:서지수 source:슬랙 foo:bar 매출");
    const chips = [...$("nsp-chips").querySelectorAll<HTMLElement>(".qc")];
    expect(chips.map((c) => c.textContent!.replace("✕", ""))).toEqual(["보낸 사람: 서지수", "출처: Slack", "foo:bar · 인식 못 함"]);
    expect(chips.map((c) => c.classList.contains("off"))).toEqual([false, false, true]);
    chips[1].querySelector<HTMLElement>("[data-chip-x]")!.click();
    expect(input().value).toBe("from:서지수 foo:bar 매출");
    expect($("nsp-chips").querySelectorAll(".qc")).toHaveLength(2);
    $("nsp-chips").querySelectorAll<HTMLElement>("[data-chip-x]")[1].click();
    expect(input().value).toBe("from:서지수 매출");
    expect(keys()).toEqual(search("from:서지수 매출").map((h) => `${h.type}:${h.id}`).sort());
  });

  it("autocomplete opens for from:, takes ↑↓/Tab/Ctrl+N while open, ⏎ fills the value; result selection untouched", () => {
    type("매출");
    key({ key: "ArrowDown" });
    const before = selIdx();
    expect(before).toBe("1");
    type("매출 from:서");
    const ac = $("nsp-ac");
    expect(ac.hidden).toBe(false);
    const labels = [...ac.querySelectorAll(".aci span:first-child")].map((x) => x.textContent);
    expect(labels.sort()).toEqual(["서 지수 <jisu@example.com>", "서지수", "서지수/팀X"]);
    const sel0 = selIdx();
    const acSel = () => ac.querySelector<HTMLElement>(".aci.sel")!.dataset.ai;
    key({ key: "ArrowDown" });
    expect(acSel()).toBe("1");
    key({ key: "Tab" });
    expect(acSel()).toBe("2");
    key({ key: "n", ctrlKey: true });
    expect(acSel()).toBe("0"); // 3 items: wraps
    key({ key: "p", ctrlKey: true });
    key({ key: "Tab", shiftKey: true });
    expect(acSel()).toBe("1");
    key({ key: "ArrowUp" });
    expect(acSel()).toBe("0");
    expect(selIdx()).toBe(sel0); // results didn't move
    const pick = ac.querySelector(".aci.sel span")!.textContent!;
    key({ key: "Enter" });
    expect(input().value).toBe(`매출 from:${/\s/.test(pick) ? `"${pick}"` : pick} `);
    expect(ac.hidden).toBe(true);
    expect($("nsp").classList.contains("open")).toBe(true); // ⏎ filled, didn't open a result
    key({ key: "ArrowDown" }); // list closed → ↓ goes to the results, the list stays shut
    expect(ac.hidden).toBe(true);
    type("매출 is:open ");
    expect(ac.hidden).toBe(true);
    const s = selIdx();
    key({ key: "ArrowDown" });
    expect(selIdx()).not.toBe(s);
  });

  it("source: and # suggestions; Esc closes only the list", () => {
    type("source:슬");
    expect([...$("nsp-ac").querySelectorAll(".aci span:first-child")].map((x) => x.textContent)).toEqual(["Slack"]);
    key({ key: "Escape" });
    expect($("nsp-ac").hidden).toBe(true);
    expect(input().value).toBe("source:슬");
    expect($("nsp").classList.contains("open")).toBe(true);
    type("#팀");
    expect([...$("nsp-ac").querySelectorAll(".aci span:first-child")].map((x) => x.textContent)).toEqual(["#팀-매출"]);
    $("nsp-ac").querySelector<HTMLElement>(".aci")!.click();
    expect(input().value).toBe("#팀-매출 ");
    expect([...$("nsp-chips").querySelectorAll(".qc")].map((c) => c.textContent!.replace("✕", ""))).toEqual(["채널: #팀-매출"]);
  });

  it("chips, suggestions and rows escape HTML (query value and names)", () => {
    type("from:\"<img src=x onerror=1>\" foo:<b>x</b>");
    expect($("nsp-chips").querySelector("img, b")).toBeNull();
    expect($("nsp-chips").textContent).toContain("보낸 사람: <img src=x onerror=1>");
    expect($("nsp-chips").textContent).toContain("foo:<b>x</b> · 인식 못 함");
    type("from:사람");
    expect($("nsp-ac").hidden).toBe(false);
    expect($("nsp-ac").querySelector("b, img")).toBeNull();
    expect([...$("nsp-ac").querySelectorAll(".aci span:first-child")].map((x) => x.textContent)).toContain("<b>사람D</b>");
    type("굵게");
    expect(keys()).toHaveLength(1);
    expect($("nsp-res").querySelector(".it b, .it img")).toBeNull();
    expect($("nsp-res").textContent).toContain("<b>사람D</b>");
  });
});

describe("palette: a complete key value doesn't hold ⏎ / ↓ (list stays shut)", () => {
  const reopen = () => (window as any).NedSearch.open("");
  const firstUrl = () => {
    const r = document.querySelector<HTMLElement>("#nsp-res .it.sel")!;
    return search(input().value).find((h) => `${h.type}:${h.id}` === r.dataset.key)!.url;
  };

  it("from:서지수 (exact, though 서지수/팀X is offered too) → list shut, one ⏎ opens the result", () => {
    reopen();
    type("from:서지수");
    expect($("nsp-ac").hidden).toBe(true);
    const url = firstUrl();
    openSpy.mockClear();
    key({ key: "Enter" });
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener");
    expect($("nsp").classList.contains("open")).toBe(false);
  });

  it("source:slack (alias of 슬랙) → list shut, one ⏎ opens the result", () => {
    reopen();
    type("source:slack");
    expect($("nsp-ac").hidden).toBe(true);
    const url = firstUrl();
    openSpy.mockClear();
    key({ key: "Enter" });
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener");
  });

  it("⏎ fills from the list, the next ⏎ opens the result", () => {
    reopen();
    type("from:서지");
    expect($("nsp-ac").hidden).toBe(false);
    openSpy.mockClear();
    key({ key: "Enter" });
    expect(openSpy).not.toHaveBeenCalled();
    expect(input().value).toMatch(/^from:\S.* $/);
    expect($("nsp-ac").hidden).toBe(true);
    const url = firstUrl();
    key({ key: "Enter" });
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener");
  });

  it("list open: ⌘⏎ is the results' new tab (palette stays), not a fill", () => {
    reopen();
    type("from:서");
    expect($("nsp-ac").hidden).toBe(false);
    const url = firstUrl();
    openSpy.mockClear();
    key({ key: "Enter", metaKey: true });
    expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener");
    expect(input().value).toBe("from:서");
    expect($("nsp").classList.contains("open")).toBe(true);
    expect($("nsp-ac").hidden).toBe(true);
  });

  it("list open: ⇧⏎ is the results' 대시보드에서 보기 (not on this page → the palette's detail view)", async () => {
    reopen();
    type("from:서");
    expect($("nsp-ac").hidden).toBe(false);
    const title = document.querySelector("#nsp-res .it.sel .tt")!.textContent;
    openSpy.mockClear();
    key({ key: "Enter", shiftKey: true });
    expect(input().value).toBe("from:서");
    expect($("nsp").classList.contains("open")).toBe(false); // navigate() closed it
    await vi.waitFor(() => expect(document.querySelector("#nsp .dv h2")?.textContent).toBe(title), { timeout: 4000, interval: 50 });
    expect(openSpy).not.toHaveBeenCalled();
    (window as any).NedSearch.close();
  });
});
