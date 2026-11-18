/**
 * ⌘K 검색 키 — one parser / filter / ranking on both sides. src/search-query.ts is the definition,
 * public/app/features/searchq.js a copy: every case here runs through both and must give the same answer.
 * Fake names only.
 */
import { describe, expect, it } from "vitest";
import * as server from "../src/search-query.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import * as client from "../public/app/features/searchq.js";

const SIDES = [["server", server], ["client", client]] as const;
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime(); // 2026-11-18 12:00 local
const H = 3_600_000, D = 24 * H;
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

type C = server.FilterFields & { id: string; fields: Array<[unknown, number]> };
const CANDS: C[] = [
  { id: "s1", type: "slack", src: "slack", people: ["서지수/팀X"], channel: "#팀-매출", ts: NOW - 1 * H, done: false, fields: [["매출 리포트 확인 부탁", 3], ["#팀-매출", 2], ["서지수/팀X", 2]] },
  { id: "s2", type: "slack", src: "slack", people: ["사람B"], channel: "#general", ts: NOW - 2 * H, done: false, fields: [["서지수 님이 매출 얘기함", 3], ["#general", 2], ["사람B", 2]] },
  { id: "s3", type: "slack", src: "slack", people: ["사람A"], channel: "#팀-매출", ts: NOW - 3 * D, done: true, fields: [["배포 일정 공유", 3], ["#팀-매출", 2], ["사람A", 2]] },
  { id: "s4", type: "slack", src: "slack", people: ["나"], channel: "#팀-매출", ts: NOW - 5 * H, done: false, mine: true, fields: [["매출 숫자 올렸어요", 3]] },
  { id: "m1", type: "mail", src: "mail", people: ["서 지수 <jisu@example.com>"], ts: NOW - 5 * H, done: false, fields: [["매출 정산", 3], ["서 지수", 2]] },
  { id: "m2", type: "mail", src: "mail", people: ["사람C"], ts: NOW - 10 * D, done: true, fields: [["회의록", 3], ["사람C", 2]] },
  { id: "j1", type: "jira", src: "jira", people: [], ts: NOW - 1 * D - H, done: false, fields: [["매출 대시보드", 3], ["APP-1", 3]] },
  { id: "g1", type: "github", src: "github", people: ["seo-jisu"], ts: NOW - 2 * D, done: false, fields: [["fix revenue chart", 3], ["seo-jisu", 2]] },
  { id: "g2", type: "github", src: "github", people: ["dev-me"], ts: NOW - 4 * D, done: false, mine: true, fields: [["my pr", 3]] },
  { id: "a1", type: "attention", src: "slack", ts: NOW - 30 * 60_000, done: true, fields: [["매출 질문 답 필요", 3]] },
  { id: "t1", type: "todo", src: "todo", ts: NOW - 6 * D, done: false, fields: [["매출 보고서", 3]] },
  { id: "e1", type: "event", src: "event", ts: NOW - 20 * D, fields: [["세션 시작", 3]] },
  { id: "x1", type: "settings", src: "settings", ts: null, fields: [["알림", 3], ["notifications", 2]] },
];
const ids = (side: typeof server, q: string) => side.runQuery(CANDS, q, NOW).map((h: { id: string }) => h.id);

describe.each(SIDES)("parseQuery (%s)", (_n, s) => {
  const p = (q: string) => s.parseQuery(q, NOW);

  it("source: / in: aliases, Korean values, case-insensitive key, repeat = OR", () => {
    expect(p("source:슬랙").filters.sources).toEqual(["slack"]);
    expect(p("in:Slack").filters.sources).toEqual(["slack"]);
    expect(p("SOURCE:메일 Source:gmail in:mail").filters.sources).toEqual(["mail"]);
    expect(p("source:지라 source:깃허브 in:gh").filters.sources).toEqual(["jira", "github"]);
    for (const [v, k] of [["일정", "calendar"], ["캘린더", "calendar"], ["세션", "session"], ["브리핑", "briefing"], ["할일", "todo"], ["초안", "draft"], ["이벤트", "event"], ["타임라인", "event"], ["설정", "settings"], ["\"할 일\"", "todo"]])
      expect(p(`source:${v}`).filters.sources, v).toEqual([k]);
    expect(p("source:슬랙").chips[0]).toMatchObject({ key: "source", ok: true, label: "출처: Slack", start: 0, end: 9 });
  });

  it("from: — quoted values, @, repeats", () => {
    const q = p("from:\"서 지수\" from:@seo-jisu 매출");
    expect(q.filters.from).toEqual(["서지수", "seo-jisu"]);
    expect(q.terms).toEqual(["매출"]);
    expect(q.chips.map((c: server.QueryChip) => c.label)).toEqual(["보낸 사람: 서 지수", "보낸 사람: @seo-jisu"]);
    expect(p("FROM:사람A").filters.from).toEqual(["사람a"]);
  });

  it("channel: and #채널 (digits-only # stays a word)", () => {
    expect(p("channel:#팀-매출").filters.channel).toEqual(["팀-매출"]);
    expect(p("#General #팀").filters.channel).toEqual(["general", "팀"]);
    expect(p("#12").filters.channel).toEqual([]);
    expect(p("#12").terms).toEqual(["#12"]);
    expect(p("#").terms).toEqual(["#"]);
    expect(p("\"#foo\"")).toMatchObject({ terms: ["#foo"], chips: [], active: false }); // quoted → plain word
  });

  it("days / after / before — local dates, no year → this year unless > 60 days ahead (then last year)", () => {
    expect(p("days:7").filters.after).toBe(NOW - 7 * D);
    expect(p("after:2026-11-01").filters.after).toBe(day(2026, 11, 1));
    expect(p("after:11/1").filters.after).toBe(day(2026, 11, 1));
    expect(p("before:03/05").filters.before).toBe(day(2026, 3, 5));
    expect(p("after:11/18").filters.after).toBe(day(2026, 11, 18));
    // near future stays this year
    expect(p("before:11/19").filters.before).toBe(day(2026, 11, 19));
    expect(p("source:일정 after:12/1").filters.after).toBe(day(2026, 12, 1));
    expect(p("after:12/25").filters.after).toBe(day(2026, 12, 25)); // 37 days ahead
    // typed in January: a date far ahead this year means last year's
    const JAN = new Date(2026, 0, 10, 9, 0, 0).getTime();
    expect(s.parseQuery("after:12/31", JAN).filters.after).toBe(day(2025, 12, 31));
    expect(s.parseQuery("after:12/31", JAN).chips[0].label).toBe("2025-12-31 이후");
    expect(s.parseQuery("before:3/1", JAN).filters.before).toBe(day(2026, 3, 1)); // 50 days ahead
    expect(s.parseQuery("before:3/15", JAN).filters.before).toBe(day(2025, 3, 15)); // 64 days ahead
    expect(s.parseQuery("after:2026-12-31", JAN).filters.after).toBe(day(2026, 12, 31)); // explicit year: as typed
    expect(p("after:11/1 after:11/10").filters.after).toBe(day(2026, 11, 10)); // tighter wins
    expect(p("after:11/1").chips[0].label).toBe("11/1 이후");
    expect(p("after:2025-12-25").chips[0].label).toBe("2025-12-25 이후");
  });

  it("is:open / is:done / is:mine (+ Korean)", () => {
    expect(p("is:open").filters).toMatchObject({ open: true, done: false, mine: false });
    expect(p("is:완료").filters).toMatchObject({ open: false, done: true });
    expect(p("IS:Mine").filters.mine).toBe(true);
  });

  it("unknown key / bad value → plain word + grey chip; empty value ignored", () => {
    for (const [q, term] of [["foo:bar", "foo:bar"], ["source:없는것", "source:없는것"], ["after:2026-13-45", "after:2026-13-45"], ["after:2/30", "after:2/30"], ["days:abc", "days:abc"], ["days:0", "days:0"], ["is:maybe", "is:maybe"]]) {
      const r = p(q);
      expect(r.terms, q).toEqual([term]);
      expect(r.active, q).toBe(false);
      expect(r.chips, q).toHaveLength(1);
      expect(r.chips[0].ok, q).toBe(false);
      expect(r.chips[0].label, q).toContain("인식 못 함");
    }
    expect(p("from:")).toMatchObject({ terms: [], chips: [], active: false });
    expect(p("re: 회의").terms).toEqual(["re:", "회의"]);
    expect(p("https://x.example.com/a").chips).toEqual([]);
  });

  it("words keep the old tokenize behaviour (lower-case, max 8)", () => {
    expect(p("  Foo   BAR ").terms).toEqual(["foo", "bar"]);
    expect(p("a b c d e f g h i j").terms).toHaveLength(8);
    expect(p("\"two words\" x").terms).toEqual(["two", "words", "x"]); // quotes only group key values
  });

  it("parseDay validation", () => {
    expect(s.parseDay("2026-02-29", NOW)).toBeNull();
    expect(s.parseDay("2024-02-29", NOW)).toBe(day(2024, 2, 29));
    expect(s.parseDay("13/1", NOW)).toBeNull();
    expect(s.parseDay("nov 1", NOW)).toBeNull();
  });
});

describe.each(SIDES)("runQuery filters (%s)", (_n, s) => {
  it("from: looks at people only — a message that mentions the name in its body doesn't match", () => {
    expect(ids(s, "from:서지수").sort()).toEqual(["m1", "s1"]);
    expect(ids(s, "from:지수")).not.toContain("s2");
    expect(ids(s, "서지수")).toContain("s2"); // as a plain word it does
  });

  it("from: — 초성, '성 이름/팀' name part, quoted, case-insensitive, OR", () => {
    expect(ids(s, "from:ㅅㅈㅅ").sort()).toEqual(["m1", "s1"]);
    expect(ids(s, "from:\"서 지수\"").sort()).toEqual(["m1", "s1"]);
    expect(ids(s, "from:SEO-JISU")).toEqual(["g1"]);
    expect(ids(s, "from:사람a from:사람c").sort()).toEqual(["m2", "s3"]);
  });

  it("source + from + word", () => {
    expect(ids(s, "source:슬랙 from:서지수 매출")).toEqual(["s1"]);
    expect(ids(s, "in:메일 from:서지수 매출")).toEqual(["m1"]);
    expect(ids(s, "source:슬랙 source:메일 from:서지수").sort()).toEqual(["m1", "s1"]);
  });

  it("source: matches an attention item by its kind and by 'attention'", () => {
    expect(ids(s, "source:슬랙 is:done").sort()).toEqual(["a1", "s3"]);
    expect(ids(s, "source:주의")).toEqual(["a1"]);
  });

  it("#채널 / channel:", () => {
    expect(ids(s, "#팀-매출")).toEqual(["s1", "s4", "s3"]); // keys only → newest first
    expect(ids(s, "channel:GENERAL")).toEqual(["s2"]);
    expect(ids(s, "#팀 배포")).toEqual(["s3"]);
  });

  it("is:done / is:open (things without a done state are neither) / is:mine", () => {
    expect(ids(s, "is:done").sort()).toEqual(["a1", "m2", "s3"]);
    expect(ids(s, "is:open")).not.toContain("e1");
    expect(ids(s, "is:open")).not.toContain("x1");
    expect(ids(s, "is:open")).toContain("t1");
    expect(ids(s, "is:open is:done")).toHaveLength(CANDS.filter((c) => c.ts != null).length + 1); // both = no constraint
    expect(ids(s, "is:mine").sort()).toEqual(["g2", "s4"]);
    expect(ids(s, "source:gh is:mine")).toEqual(["g2"]);
  });

  it("days / after / before boundaries", () => {
    expect(ids(s, "days:1")).toEqual(["a1", "s1", "s2", "s4", "m1"]);
    expect(ids(s, "days:1")).not.toContain("j1"); // 25h ago
    const edge = [{ ...CANDS[0], id: "edge", ts: day(2026, 11, 10) }, { ...CANDS[0], id: "before", ts: day(2026, 11, 10) - 1 }];
    expect(s.runQuery(edge, "after:11/10", NOW).map((h: C) => h.id)).toEqual(["edge"]);
    expect(s.runQuery(edge, "before:11/10", NOW).map((h: C) => h.id)).toEqual(["before"]);
    expect(s.runQuery(edge, "after:11/9 before:2026-11-11", NOW)).toHaveLength(2);
    expect(ids(s, "after:11/1")).not.toContain("x1"); // no ts → out of any date filter
  });

  it("keys only → newest first; no words and no keys → nothing; unknown key → word (no sudden 0 on a match)", () => {
    expect(ids(s, "source:깃허브")).toEqual(["g1", "g2"]);
    expect(ids(s, "")).toEqual([]);
    expect(ids(s, "from:")).toEqual([]);
    const withColon = [{ ...CANDS[0], id: "c", fields: [["re:project update", 3]] as Array<[unknown, number]> }];
    expect(s.runQuery(withColon, "re:project", NOW).map((h: C) => h.id)).toEqual(["c"]);
    expect(ids(s, "foo:bar")).toEqual([]);
  });

  it("words still rank by score (unchanged scoring)", () => {
    const hits = s.runQuery(CANDS, "매출", NOW);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    expect(s.scoreFields([["deploy failed", 1]], ["deploy"], null, NOW)).toBe(6);
    expect(s.scoreFields([["배포 실패", 1]], ["ㅂㅍ"], null, NOW)).toBe(1.5);
  });
});

describe.each(SIDES)("autocomplete (%s)", (_n, s) => {
  it("acContext: from: / source: / in: / channel: / #, caret-aware", () => {
    expect(s.acContext("매출 from:서", 9)).toMatchObject({ kind: "from", key: "from", prefix: "서", start: 3, end: 9 });
    expect(s.acContext("매출 from:서", 2)).toBeNull();
    expect(s.acContext("from:\"서 지", 9)).toMatchObject({ kind: "from", prefix: "서 지" });
    expect(s.acContext("in:슬", 4)).toMatchObject({ kind: "source", key: "in" });
    expect(s.acContext("#팀", 2)).toMatchObject({ kind: "channel", hash: true, prefix: "팀" });
    expect(s.acContext("days:3", 6)).toBeNull();
    expect(s.acContext("from:서 ", 7)).toBeNull(); // past the token
  });

  it("acSuggest: people by frequency (max 8), channels, sources", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ type: "slack", ts: 0, people: [`사람${String.fromCharCode(65 + i)}`] }));
    many.push({ type: "slack", ts: 0, people: ["사람C"] }, { type: "slack", ts: 0, people: ["사람C"] });
    const ppl = s.acSuggest({ kind: "from", key: "from", prefix: "", start: 0, end: 5, hash: false }, many);
    expect(ppl).toHaveLength(8);
    expect(ppl[0]).toMatchObject({ value: "사람C", count: 3 });
    expect(s.acSuggest({ kind: "from", key: "from", prefix: "ㅅㅈ", start: 0, end: 7, hash: false }, CANDS).map((x: { value: string }) => x.value).sort()).toEqual(["서 지수 <jisu@example.com>", "서지수/팀X"]);
    expect(s.acSuggest({ kind: "channel", key: "#", prefix: "팀", start: 0, end: 2, hash: true }, CANDS)).toEqual([{ value: "팀-매출", label: "#팀-매출", count: 3 }]);
    expect(s.acSuggest({ kind: "source", key: "source", prefix: "슬", start: 0, end: 8, hash: false }, [])).toEqual([{ value: "슬랙", label: "Slack", count: 0 }]);
    expect(s.acSuggest({ kind: "source", key: "source", prefix: "", start: 0, end: 7, hash: false }, []).length).toBe(8);
  });

  it("acSettled: a complete value keeps the list shut (alias, or exactly one suggestion even with longer ones)", () => {
    const ctx = (q: string) => s.acContext(q, q.length)!;
    const people = [...CANDS, { type: "slack", ts: 0, people: ["서지수"] }];
    const settled = (q: string, cands: unknown[] = people) => s.acSettled(ctx(q), s.acSuggest(ctx(q), cands));
    expect(settled("from:서지수")).toBe(true); // 서지수/팀X also offered
    expect(settled("from:서지")).toBe(false);
    expect(settled("from:\"서 지수")).toBe(true); // spaces ignored, like the filter
    expect(settled("from:@SEO-JISU")).toBe(true);
    expect(settled("source:slack")).toBe(true); // = 슬랙
    expect(settled("in:GH")).toBe(true);
    expect(settled("source:슬")).toBe(false);
    expect(settled("#팀-매출")).toBe(true);
    expect(settled("channel:#팀-매출")).toBe(true);
    expect(settled("#팀")).toBe(false);
    expect(settled("from:")).toBe(false);
  });

  it("acApply quotes values with spaces; removeChip drops one token", () => {
    const q = "매출 from:서 #x";
    const ctx = s.acContext(q, 9)!;
    expect(s.acApply(q, ctx, "서 지수/팀X")).toEqual({ q: "매출 from:\"서 지수/팀X\" #x", caret: "매출 from:\"서 지수/팀X\" ".length });
    expect(s.acApply("#팀", s.acContext("#팀", 2)!, "팀-매출")).toEqual({ q: "#팀-매출 ", caret: 6 });
    const pq = s.parseQuery("from:사람A source:슬랙 매출", NOW);
    expect(s.removeChip("from:사람A source:슬랙 매출", pq.chips[1])).toBe("from:사람A 매출");
    expect(s.removeChip("from:사람A source:슬랙 매출", pq.chips[0])).toBe("source:슬랙 매출");
  });
});

describe("server and client agree on the whole case table", () => {
  const QUERIES = [
    "from:서지수", "from:ㅅㅈㅅ", "from:\"서 지수\"", "source:슬랙 from:서지수 매출", "#팀-매출", "channel:팀 is:done", "is:open", "is:done",
    "is:mine", "days:2", "after:11/15", "before:11/1", "매출", "ㅁㅊ", "foo:bar", "source:없는것 매출", "in:gh", "source:할일 is:open", "#12",
    "after:12/1", "before:11/19", "\"#팀-매출\"",
  ];
  it.each(QUERIES)("%s", (q) => {
    expect(client.parseQuery(q, NOW)).toEqual(server.parseQuery(q, NOW));
    expect(client.runQuery(CANDS, q, NOW)).toEqual(server.runQuery(CANDS, q, NOW));
  });
  it("same exports", () => {
    expect(Object.keys(client).sort()).toEqual(Object.keys(server).sort());
  });
});
