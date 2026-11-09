/** 초안 모달 "답할 것" 목록·멘션 제안 토글 (public/app/features/draftasks.js, 순수 — node 에서 렌더). */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { applyMentions, asksHtml, isTwoPass, mentionLabel } from "../public/app/features/draftasks.js";

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
});
