/** 초안 모달 "답할 것" 목록·멘션 제안 토글 (public/app/features/draftasks.js, 순수 — node 에서 렌더). */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { applyMentions, asksHtml, editMentions, isTwoPass, mentionIds, mentionLabel, missingMentions, shownText, toggleMentions } from "../public/app/features/draftasks.js";

const base = { id: "x", source: "slack", context: { summary: "", excerpt: "" }, drafts: [{ id: "x-0", label: "짧게", text: "넵" }], meta: { mode: "2pass" }, mentions: [] };

describe("asksHtml", () => {
  it("open: ☐ 번호 누가 · 무엇 · (마감); answered: 흐리게 ✓ 이미 답함", () => {
    const html = asksHtml({ ...base, asks: [
      { who: "박서연", what: "후속 B 실험 시점", due: "", status: "open", answered_in: "" },
      { who: "박서연", what: "원복 일정 재확인", due: "주간회의 전", status: "open", answered_in: "" },
      { who: "박서연", what: "원복 담당", due: "", status: "answered", answered_in: "1.0" },
    ] });
    expect(html).toContain('<div class="dask-h">답할 것 2</div>');
    expect(html).toMatch(/class="dask open">.*☐.*<span class="n">1<\/span><span class="who">박서연<\/span> · <span class="what">후속 B 실험 시점/);
    expect(html).toContain('<span class="due">(주간회의 전)</span>');
    expect(html).toMatch(/class="dask done">.*✓.*이미 답함.*원복 담당/);
    expect(html).not.toContain("답할 질문 없음");
  });

  it("open 0 → '답할 질문 없음 — 가벼운 확인 답'", () => {
    expect(asksHtml({ ...base, asks: [] })).toContain("답할 질문 없음 — 가벼운 확인 답");
    expect(asksHtml({ ...base, asks: [{ who: "kim", what: "배포 일정", due: "", status: "answered", answered_in: "1" }] })).toContain("답할 질문 없음");
  });

  it("escapes model text", () => {
    expect(asksHtml({ ...base, asks: [{ who: "<b>", what: "<img src=x>", due: "", status: "open", answered_in: "" }] })).not.toContain("<img");
  });

  it("캐시된 옛 포맷(asks·meta.mode 없음)·legacy → 아무것도 안 그림 (깨지지 않음)", () => {
    const old = { id: "o", source: "slack", context: { summary: "s", excerpt: "e" }, drafts: [{ id: "o-0", label: "짧게", text: "t" }], meta: { channel_id: "C1" } };
    expect(isTwoPass(old)).toBe(false);
    expect(asksHtml(old)).toBe("");
    expect(asksHtml({ ...old, asks: [], meta: { mode: "legacy" } })).toBe("");
    expect(asksHtml(null)).toBe("");
    expect(applyMentions("t", undefined, true)).toBe("t");
  });

  it("멘션 제안 칩 + 토글 (기본 꺼짐)", () => {
    const r = { ...base, asks: [], mentions: ["<@U0KIM>"] };
    const off = asksHtml(r);
    expect(off).toContain("멘션 제안:");
    expect(off).toContain(">@U0KIM<");
    expect(off).toContain('data-dmention="1" aria-pressed="false"');
    expect(asksHtml(r, { mentionOn: true })).toContain('aria-pressed="true"');
    expect(asksHtml({ ...base, asks: [] })).not.toContain("멘션 제안");
    expect(mentionLabel("<@U1>")).toBe("@U1");
  });
});

describe("M2·M5 render", () => {
  it("before_reply open ask → 작은 '이전' 칩", () => {
    const html = asksHtml({ ...base, asks: [{ who: "kim", what: "배포 가능 여부", due: "", status: "open", answered_in: "", before_reply: true }, { who: "lee", what: "x", due: "", status: "open", answered_in: "" }] });
    expect(html.match(/class="prev"[^>]*>이전</g)).toHaveLength(1);
  });
  it("mentions {id, name} → '이름 (@U…)' 칩; 옛 문자열 배열도 렌더", () => {
    expect(asksHtml({ ...base, asks: [], mentions: [{ id: "<@U0KIM>", name: "김철수" }] })).toContain(">김철수 (@U0KIM)<");
    expect(asksHtml({ ...base, asks: [], mentions: ["<@U0OLD>"] })).toContain(">@U0OLD<");
    expect(mentionIds({ mentions: [{ id: "<@U1>", name: "a" }, "<@U2>", null] })).toEqual(["<@U1>", "<@U2>"]);
  });
});

describe("멘션 토글 상태 전이 (테스트 공백 5) · L5", () => {
  const ids = ["<@U0KIM>"];
  const st0 = { on: false, edits: {}, added: {} };
  it("L5 비편집 탭: 꺼져 있으면 모델이 쓴 첫머리 멘션을 지우지 않음, 켜면 없는 것만 붙임", () => {
    expect(shownText("<@U0KIM> 네", ids, false)).toBe("<@U0KIM> 네");
    expect(shownText("네", ids, true)).toBe("<@U0KIM> 네");
    expect(shownText("<@U0KIM> 네", ids, true)).toBe("<@U0KIM> 네");
  });
  it("켜기 → 편집 → 끄기: 토글이 넣은 것만 제거", () => {
    let st = toggleMentions(st0, ids); // on, no edits yet
    expect(st.on).toBe(true);
    st = editMentions(st, "t1", "<@U0KIM> 네 확인했습니다", "네", ids); // first edit while on → toggle's mention recorded
    expect(st.added.t1).toEqual(["<@U0KIM>"]);
    st = toggleMentions(st, ids);
    expect(st).toEqual({ on: false, edits: { t1: "네 확인했습니다" }, added: {} });
  });
  it("사용자가 직접 쓴 멘션은 켜기/끄기 후에도 남음", () => {
    let st = editMentions(st0, "t1", "<@U0KIM> 직접 씀", "네", ids); // edited while off
    st = toggleMentions(st, ids); // already contains → nothing added
    expect(st.edits.t1).toBe("<@U0KIM> 직접 씀");
    expect(st.added.t1).toEqual([]);
    st = toggleMentions(st, ids);
    expect(st.edits.t1).toBe("<@U0KIM> 직접 씀");
  });
  it("꺼진 채 편집한 탭을 켜면 붙고, 끄면 다시 빠짐", () => {
    let st = editMentions(st0, "t2", "확인했어요", "네", ids);
    st = toggleMentions(st, ids);
    expect(st.edits.t2).toBe("<@U0KIM> 확인했어요");
    st = toggleMentions(st, ids);
    expect(st.edits.t2).toBe("확인했어요");
  });
});

describe("applyMentions", () => {
  const ms = ["<@U0KIM>"];
  it("켜면 첫머리에 삽입, 이미 있으면 중복 삽입 안 함, 끄면 첫머리에서 제거", () => {
    expect(applyMentions("확인했어요", ms, true)).toBe("<@U0KIM> 확인했어요");
    expect(applyMentions("<@U0KIM> 확인했어요", ms, true)).toBe("<@U0KIM> 확인했어요");
    expect(applyMentions("확인 <@U0KIM> 님", ms, true)).toBe("확인 <@U0KIM> 님");
    expect(applyMentions("<@U0KIM> 확인했어요", ms, false)).toBe("확인했어요");
    expect(applyMentions("확인했어요", ms, false)).toBe("확인했어요");
    expect(applyMentions("<@U0KIM> <@U0LEE> 네", ["<@U0KIM>", "<@U0LEE>"], false)).toBe("네");
  });
  it("missingMentions: 토글이 넣을(=넣은) 것만 — 사용자가 이미 쓴 멘션은 제외라 끌 때도 안 지움", () => {
    expect(missingMentions("<@U0KIM> 네", ["<@U0KIM>", "<@U0LEE>"])).toEqual(["<@U0LEE>"]);
    const added = missingMentions("<@U0KIM> 네", ms); // user typed it → toggle added nothing
    expect(applyMentions(applyMentions("<@U0KIM> 네", ms, true), added, false)).toBe("<@U0KIM> 네");
  });
});
