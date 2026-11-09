/** 답장 초안 입력 구획 (src/draft-thread.ts): transcript 정규화·segment·축약·상한·renderSegments·asks 보정. */
import { describe, expect, it } from "vitest";
import {
  DRAFT_CTX_MAX_CHARS,
  DRAFT_CTX_MAX_MSGS,
  REACTION_LABEL,
  fillTemplate,
  filterMentions,
  isReaction,
  normalizeCovers,
  normalizeExtract,
  normalizeTranscript,
  reconcileAsks,
  renderAsks,
  renderSegments,
  segment,
  type DraftAsk,
} from "../src/draft-thread.js";

const m = (ts: string, from: string, text: string, mine = false) => ({ ts, from, text, mine });

describe("isReaction", () => {
  it("emoji / shortcodes / +1 / ㅇㅇ / ㅋㅋ / empty → reaction; real text → not", () => {
    for (const t of ["", "👍", "🙏🏻", ":+1:", ":thumbsup: :tada:", "+1", "ㅇㅇ", "ㅋㅋㅋ", "ㅎㅎ!", "ok", "LGTM", "👍👍 ㅋㅋ"]) expect(isReaction(t), t).toBe(true);
    for (const t of ["감사합니다", "배포 언제 해요?", "ㅋㅋ 그건 좀", "네 내일 볼게요"]) expect(isReaction(t), t).toBe(false);
  });
});

describe("normalizeTranscript", () => {
  it("sorts by ts (Slack ts and ISO), `나` → mine, keeps U-ids, drops junk", () => {
    const t = normalizeTranscript([
      { ts: "1700000200.000100", from: "kim", text: "b", user_id: "U1" },
      { ts: "1700000100.000100", from: "나", text: "a" },
      null,
      { ts: "2023-11-14T22:20:00.000Z", from: "lee", text: "  c  \n d", user_id: "bogus" },
    ]);
    expect(t.map((x) => x.text)).toEqual(["a", "b", "c d"]);
    expect(t[0].mine).toBe(true);
    expect(t[1].user_id).toBe("U1");
    expect(t[2].user_id).toBeUndefined();
  });
});

describe("segment", () => {
  it("cuts at my last message; none of mine → all target", () => {
    const t = normalizeTranscript([m("1700000001.0", "kim", "q1?"), m("1700000002.0", "나", "a1", true), m("1700000003.0", "kim", "q2?"), m("1700000004.0", "lee", "👍")]);
    const s = segment(t);
    expect(s.context.map((x) => x.text)).toEqual(["q1?", "a1"]);
    expect(s.target.map((x) => x.text)).toEqual(["q2?", "👍"]);
    expect(s.target[1].reaction).toBe(true);
    expect(s.my_last_ts).toBe("1700000002.0");
    const none = segment(normalizeTranscript([m("1", "kim", "x"), m("2", "lee", "y")]));
    expect(none.context).toEqual([]);
    expect(none.target).toHaveLength(2);
    expect(none.my_last_ts).toBe("");
  });

  it("mine message without ts + myLastTs: cut stays at my message, my_last_ts = the newer known time", () => {
    // myLastTs older than my (ts-less) message → keep my message as the cut; its time ≥ the newest known ts before it.
    const t = normalizeTranscript([m("1700000001.0", "kim", "q1?"), m("1700000003.0", "kim", "q2?"), m("", "나", "a", true), m("1700000006.0", "kim", "q3?")]);
    const s = segment(t, { myLastTs: "1700000002.0" });
    expect(s.target.map((x) => x.text)).toEqual(["q3?"]);
    expect(s.my_last_ts).toBe("1700000003.0");
    // myLastTs newer than everything up to my ts-less message → it moves the cut forward and is the boundary.
    const s2 = segment(t, { myLastTs: "1700000007.0" });
    expect(s2.target).toEqual([]);
    expect(s2.my_last_ts).toBe("1700000007.0");
  });

  it("myLastTs newer than the transcript's own mine moves the cut; older than the excerpt → all target", () => {
    const t = normalizeTranscript([m("1700000001.0", "kim", "q1?"), m("1700000003.0", "kim", "q2?"), m("1700000005.0", "kim", "q3?")]);
    const s = segment(t, { myLastTs: "1700000004.0" });
    expect(s.context.map((x) => x.text)).toEqual(["q1?", "q2?"]);
    expect(s.target.map((x) => x.text)).toEqual(["q3?"]);
    const old = segment(t, { myLastTs: "1600000000.0" });
    expect(old.target).toHaveLength(3);
    expect(old.my_last_ts).toBe("1600000000.0");
  });

  it("context caps: newest DRAFT_CTX_MAX_MSGS, then chars, with an omitted count", () => {
    const many = Array.from({ length: 30 }, (_, i) => m(`${1700000000 + i}.0`, "kim", `msg ${i}`));
    many.push(m("1700000100.0", "나", "mine", true));
    const s = segment(normalizeTranscript(many));
    expect(s.context).toHaveLength(DRAFT_CTX_MAX_MSGS);
    expect(s.omitted).toBe(31 - DRAFT_CTX_MAX_MSGS);
    const long = Array.from({ length: 10 }, (_, i) => m(`${1700000000 + i}.0`, "kim", "가".repeat(900)));
    long.push(m("1700000100.0", "나", "mine", true));
    const s2 = segment(normalizeTranscript(long));
    expect(s2.context.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(DRAFT_CTX_MAX_CHARS);
    expect(s2.omitted).toBeGreaterThan(0);
    expect(renderSegments(s2)).toContain(`…앞 ${s2.omitted}개 생략`);
  });
});

describe("renderSegments", () => {
  it("headers, `나`, local MM/DD HH:mm, reaction label, participants with ids", () => {
    const s = segment(normalizeTranscript([m("1700000001.0", "kim", "q1?"), m("1700000002.0", "나", "a1", true), m("1700000003.0", "lee", "ㅋㅋ")]));
    const out = renderSegments(s, [{ name: "kim", user_id: "U1" }, { name: "lee" }, { name: "나" }]);
    expect(out).toContain("참여자: kim(<@U1>), lee");
    expect(out).toContain("### [맥락] — 참고만, 요약하지 않는다");
    expect(out).toMatch(/### \[답할 대상\] — 내 마지막 답글\(\d\d\/\d\d \d\d:\d\d\) 이후/);
    expect(out).toMatch(/\[\d\d\/\d\d \d\d:\d\d\] 나: a1/);
    expect(out).toContain(`lee: ${REACTION_LABEL}`);
  });
});

describe("reconcileAsks / renderAsks", () => {
  const ask = (what: string, asked_in: string[], status: "open" | "answered" = "open"): DraftAsk => ({ who: "kim", what, due: "", status, answered_in: "", asked_in });
  it("model status kept; open asked only before my last reply → before_reply; asked again after / no ts → no flag", () => {
    const r = reconcileAsks([ask("A", ["1700000001.0"]), ask("B", ["1700000001.0", "1700000009.0"]), ask("C", []), ask("D", ["1700000001.0"], "answered")], { my_last_ts: "1700000005.0" });
    expect(r.map((a) => a.status)).toEqual(["open", "open", "open", "answered"]);
    expect(r.map((a) => !!a.before_reply)).toEqual([true, false, false, false]);
    expect(reconcileAsks([ask("A", ["1"])], { my_last_ts: "" })[0].before_reply).toBeUndefined();
  });
  it("ts compared as numbers: ISO asked_in vs Slack-ts cut, and '9.0' vs '10.0' (string order would be wrong)", () => {
    const iso = new Date(1700000001 * 1000).toISOString();
    expect(reconcileAsks([ask("A", [iso])], { my_last_ts: "1700000005.000100" })[0].before_reply).toBe(true);
    expect(reconcileAsks([ask("A", ["1700000009.0"])], { my_last_ts: "1700000010.0" })[0].before_reply).toBe(true);
  });
  it("renderAsks marks before_reply asks for Pass 2 (still to answer)", () => {
    expect(renderAsks([{ ...ask("A", ["1"]), before_reply: true }])).toContain("1. kim — A [내 마지막 답글 이전 질문 — 아직 답 안 됨]");
  });
  it("renderAsks numbers open ones and lists answered as don't-repeat", () => {
    const out = renderAsks([ask("A", [], "answered"), ask("B", []), { ...ask("C", []), due: "금요일" }]);
    expect(out).toContain("1. kim — B");
    expect(out).toContain("2. kim — C (마감: 금요일)");
    expect(out).toContain("이미 답한 것");
    expect(renderAsks([])).toContain("(없음");
  });
});

describe("fillTemplate / whitespace", () => {
  it("one pass: a value containing {{ASKS}} is not expanded again; unknown keys stay", () => {
    expect(fillTemplate("A={{A}} B={{B}} X={{X}}", { A: "{{B}}", B: "b" })).toBe("A={{B}} B=b X={{X}}");
  });
  it("from / who / due collapse whitespace", () => {
    expect(normalizeTranscript([{ ts: "1", from: " kim \n lee ", text: "x" }])[0].from).toBe("kim lee");
    expect(normalizeExtract({ asks: [{ who: "a \n b", what: "w", due: " 금 \t 요일 " }] })!.asks[0]).toMatchObject({ who: "a b", due: "금 요일" });
  });
});

describe("normalizeExtract / mentions / covers", () => {
  it("rejects non-JSON-ish output, normalizes participants and reply_meta", () => {
    expect(normalizeExtract(null)).toBeNull();
    expect(normalizeExtract({ foo: 1 })).toBeNull();
    const e = normalizeExtract({ transcript: [], asks: [{ who: "kim", what: "x?", status: "weird", asked_in: "1700000001.0" }], participants: ["lee", { name: "kim", user_id: "U1" }], reply_meta: { message_id: "m1", subject: "" } })!;
    expect(e.asks[0]).toMatchObject({ status: "open", asked_in: ["1700000001.0"] });
    expect(e.participants).toEqual([{ name: "lee" }, { name: "kim", user_id: "U1" }]);
    expect(e.reply_meta).toEqual({ message_id: "m1" });
  });
  it("filterMentions: slack only, ≥2 participants, known ids only", () => {
    const parts = [{ name: "kim", user_id: "U1" }, { name: "lee", user_id: "U2" }];
    expect(filterMentions(["<@U1>", "<@U9>", "@lee", "<@U1>", { id: "<@U2>" }], parts, "slack")).toEqual([{ id: "<@U1>", name: "kim" }, { id: "<@U2>", name: "lee" }]);
    expect(filterMentions(["<@U1>"], parts.slice(0, 1), "slack")).toEqual([]);
    expect(filterMentions(["<@U1>"], parts, "email")).toEqual([]);
  });
  it("normalizeCovers keeps 1..n unique ascending", () => {
    expect(normalizeCovers([2, "1", 2, 9, 0], 3)).toEqual([1, 2]);
    expect(normalizeCovers("x", 3)).toEqual([]);
  });
});
