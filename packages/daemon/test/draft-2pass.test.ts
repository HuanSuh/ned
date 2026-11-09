/**
 * 답장 초안 2-pass 골든 테스트: runClaude 를 모킹해 Pass 1(추출) 출력을 고정하고, 데몬의 구획·asks 보정·Pass 2 프롬프트·
 * DraftResult 를 검증한다. 실 claude 호출 없음 (claude.js 의 runClaude 만 가짜, llmDisabled false).
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agenda } from "../src/agenda.js";
import type { ClaudeRunOptions, ClaudeRunResult } from "../src/claude.js";
import { DEFAULT_CONFIG, type NedConfig } from "../src/config.js";

const FAIL = "__FAIL__";
const QUEUE = Symbol.for("queue");
const queue = (...xs: unknown[]) => Object.assign(xs, { [QUEUE]: true });
type Call = { prompt: string; opts: ClaudeRunOptions };
const calls: Call[] = [];
const replies: { pass1?: unknown; pass2?: unknown; legacy?: unknown } = {};

vi.mock("../src/claude.js", async (orig) => {
  const m = await orig<typeof import("../src/claude.js")>();
  return {
    ...m,
    llmDisabled: () => false,
    runClaude: async (prompt: string, opts: ClaudeRunOptions): Promise<ClaudeRunResult> => {
      calls.push({ prompt, opts });
      const which = prompt.includes("1단계: 추출") ? "pass1" : prompt.includes("2단계: 작성") ? "pass2" : "legacy";
      // A reply may be a queue (array tagged with QUEUE) consumed one per call; FAIL = the run itself failed (ok: false).
      let r = replies[which];
      if (Array.isArray(r) && (r as unknown as { [QUEUE]?: boolean })[QUEUE]) r = (r as unknown[]).length > 1 ? (r as unknown[]).shift() : (r as unknown[])[0];
      const cost = which === "pass1" ? 0.02 : 0.01;
      if (r === FAIL) return { ok: false, text: "", cost_usd: cost, num_turns: 0, duration_ms: 5, error: "timeout after 240s" };
      const text = typeof r === "string" ? r : JSON.stringify(r ?? {});
      return { ok: true, text, cost_usd: cost, num_turns: 1, duration_ms: 5 };
    },
  };
});

const { generateDraft } = await import("../src/drafts.js");
const { AGENDA_PATH } = await import("../src/paths.js");

const cfg: NedConfig = { ...DEFAULT_CONFIG, draft_context_max_age_minutes: 180 };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const slackTs = (minAgo: number) => `${Math.floor(Date.now() / 1000 - minAgo * 60)}.000100`;
const URL_FAST = "https://x.slack.com/archives/C111/p1700000000000100";

function agendaWith(messages: { from: string; ts: string; text: string }[], extra: Record<string, unknown> = {}): Agenda {
  return {
    updated_at: Date.now(), cost_usd: 0, calendar: [], jira: [], github: [],
    slack: { summary: "", items: [{ channel: "dev", from: "kim", text: "x", url: URL_FAST, ts: minsAgo(5), reason: "mention", context: { participants: [...new Set(messages.map((m) => m.from))], messages, collected_at: minsAgo(3), ...extra } }], all: [], watch: [] },
    mail: { summary: "", unread: 0, unread_capped: false, items: [], all: [] },
  } as Agenda;
}
const writeAgenda = (a: Agenda) => fs.writeFileSync(AGENDA_PATH, JSON.stringify(a));
const pass = (n: 1 | 2) => calls.filter((c) => c.prompt.includes(n === 1 ? "1단계: 추출" : "2단계: 작성"));
const section = (prompt: string, head: string) => {
  const i = prompt.indexOf(head);
  if (i < 0) return "";
  const rest = prompt.slice(i + head.length);
  const j = rest.search(/\n### |\n## /);
  return j < 0 ? rest : rest.slice(0, j);
};
const drafts3 = (covers: number[], text = "답") => ["짧게", "보통", "정중하게"].map((label) => ({ label, text: `${text} ${label}`, covers }));

beforeEach(() => {
  calls.length = 0;
  delete replies.pass1; delete replies.pass2; delete replies.legacy;
  writeAgenda(agendaWith([]));
});

describe("2-pass golden", () => {
  it("(a) 내가 이미 답한 질문 → answered, [답할 대상] 에 없음", async () => {
    const q = minsAgo(60), mine = minsAgo(50), r = minsAgo(40);
    writeAgenda(agendaWith([{ from: "kim", ts: q, text: "배포 언제 해요?" }, { from: "나", ts: mine, text: "금요일에 합니다" }, { from: "kim", ts: r, text: "👍" }]));
    replies.pass1 = { transcript: [], asks: [{ who: "kim", what: "배포 일정", due: "", status: "answered", answered_in: mine, asked_in: [q] }], participants: [{ name: "kim" }] };
    replies.pass2 = { summary: "확인 반응", excerpt: "", mentions: [], drafts: drafts3([]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.mode).toBe("fast");
    expect(res.meta.mode).toBe("2pass");
    expect(res.asks).toEqual([{ who: "kim", what: "배포 일정", due: "", status: "answered", answered_in: mine }]);
    const p2 = pass(2)[0].prompt;
    const target = section(p2, "### [답할 대상]");
    expect(target).not.toContain("배포 언제 해요?");
    expect(target).toContain("(짧은 반응)");
    expect(section(p2, "### [맥락]")).toContain("배포 언제 해요?");
    expect(p2).toContain("이미 답한 것");
    expect(p2).toContain("답할 질문·요청이 없다");
    // fast path: both passes no tools, isolated, fast model, 1 turn
    for (const c of calls) expect(c.opts).toMatchObject({ tools: [], allowedTools: [], maxTurns: 1, isolated: true, model: "sonnet", job: "draft" });
    expect(res.cost_usd).toBeCloseTo(0.03);
  });

  it("(b) 내 마지막 답글 이후 질문 2개 → open 2, 1·2번, covers [1,2]", async () => {
    const t0 = minsAgo(90), t1 = minsAgo(80), t2 = minsAgo(30), t3 = minsAgo(20);
    writeAgenda(agendaWith([{ from: "kim", ts: t0, text: "초안 봤어요?" }, { from: "나", ts: t1, text: "네 봤습니다" }, { from: "kim", ts: t2, text: "리뷰는 언제 끝나요?" }, { from: "lee", ts: t3, text: "문서 링크 주실 수 있나요?" }]));
    replies.pass1 = {
      transcript: [],
      asks: [
        { who: "kim", what: "초안 확인 여부", status: "answered", answered_in: t1, asked_in: [t0] },
        { who: "kim", what: "리뷰 완료 시점", status: "open", answered_in: "", asked_in: [t2] },
        { who: "lee", what: "문서 링크 요청", status: "open", answered_in: "", asked_in: [t3] },
      ],
      participants: [],
    };
    replies.pass2 = { summary: "리뷰 시점·문서 링크", excerpt: "", mentions: [], drafts: drafts3([2, 1, 1]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.asks.filter((a) => a.status === "open").map((a) => a.what)).toEqual(["리뷰 완료 시점", "문서 링크 요청"]);
    const p2 = pass(2)[0].prompt;
    expect(p2).toContain("1. kim — 리뷰 완료 시점");
    expect(p2).toContain("2. lee — 문서 링크 요청");
    expect(p2).toContain("covers = [1,2]");
    expect(section(p2, "### [답할 대상]")).toContain("리뷰는 언제 끝나요?");
    expect(section(p2, "### [답할 대상]")).not.toContain("초안 봤어요?");
    expect(res.drafts.map((d) => d.covers)).toEqual([[1, 2], [1, 2], [1, 2]]);
    expect(res.context.excerpt).toBe("문서 링크 주실 수 있나요?");
  });

  it("(c) 질문 없는 잡담 → open 0, 리액션형 지시, (짧은 반응) 축약", async () => {
    const t1 = minsAgo(60);
    writeAgenda(agendaWith([{ from: "나", ts: t1, text: "자료 공유드립니다" }, { from: "kim", ts: minsAgo(50), text: "ㅋㅋ" }, { from: "lee", ts: minsAgo(45), text: "👍🙏" }, { from: "park", ts: minsAgo(40), text: "감사합니다" }]));
    replies.pass1 = { transcript: [], asks: [], participants: [] };
    replies.pass2 = { summary: "감사 반응", excerpt: "", mentions: [], drafts: drafts3([]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.asks).toEqual([]);
    const p2 = pass(2)[0].prompt;
    expect(p2).toContain("답할 질문·요청이 없다 — 짧은 리액션/확인형");
    const target = section(p2, "### [답할 대상]");
    expect(target).toContain("kim: (짧은 반응)");
    expect(target).toContain("lee: (짧은 반응)");
    expect(target).toContain("park: 감사합니다");
    expect(res.drafts.every((d) => d.covers?.length === 0)).toBe(true);
  });

  it("(d) A2 서빙 실험 종료·후속 일정: 원글 질문 3 → 내 답 2개 → 재확인 → open 2, answered 2 (full 경로)", async () => {
    const root = "1762300800.000100", mine = "1762390800.000200", recheck = "1762560000.000300"; // 11/5 · 11/6 · 11/8 무렵
    replies.pass1 = {
      transcript: [
        { ts: root, from: "박서연", mine: false, user_id: "U0PARK", text: "A2 서빙 실험 이번 주 종료합니다. 1) 종료 후 트래픽 원복은 누가 하나요? 2) 결과 리포트는 어디에 올리나요? 3) 후속 B 실험은 언제 시작할 수 있을까요?" },
        { ts: mine, from: "나", mine: true, text: "원복은 제가 금요일 오전에 합니다. 리포트는 실험 위키에 올릴게요." },
        { ts: recheck, from: "박서연", mine: false, user_id: "U0PARK", text: "원복 일정 금요일 오전 맞는지 재확인 부탁드려요. 주간회의 전에 공유해야 해서요." },
      ],
      asks: [
        { who: "박서연", what: "트래픽 원복 담당", status: "answered", answered_in: mine, asked_in: [root] },
        { who: "박서연", what: "결과 리포트 위치", status: "answered", answered_in: mine, asked_in: [root] },
        { who: "박서연", what: "후속 B 실험 시작 시점", status: "open", answered_in: "", asked_in: [root] },
        { who: "박서연", what: "원복 일정(금 오전) 재확인", due: "주간회의 전", status: "open", answered_in: "", asked_in: [recheck] },
      ],
      participants: [{ name: "박서연", user_id: "U0PARK" }],
    };
    replies.pass2 = { summary: "후속 일정·원복 재확인", excerpt: "원복 일정 금요일 오전 맞는지 재확인 부탁드려요.", mentions: [], drafts: drafts3([1, 2]) };
    const res = await generateDraft({ source: "slack", ref: { channel: "C222", ts: root, thread_ts: root }, force: true }, cfg);
    expect(res.mode).toBe("full");
    expect(res.asks.map((a) => a.status)).toEqual(["answered", "answered", "open", "open"]);
    expect(res.asks.map((a) => !!a.before_reply)).toEqual([false, false, true, false]); // 미답 원글 질문 = 이전, 재확인 = 이후
    const p1 = pass(1)[0];
    expect(p1.opts).toMatchObject({ allowedTools: expect.arrayContaining(["mcp__claude_ai_Slack__slack_read_thread"]), maxTurns: 8 });
    expect(p1.prompt).toContain(`message_ts=\`${root}\``);
    const p2 = pass(2)[0];
    expect(p2.opts).toMatchObject({ tools: [], maxTurns: 1, isolated: true });
    expect(p2.prompt).toContain("1. 박서연 — 후속 B 실험 시작 시점");
    expect(p2.prompt).toContain("2. 박서연 — 원복 일정(금 오전) 재확인 (마감: 주간회의 전)");
    expect(section(p2.prompt, "### [답할 대상]")).toContain("재확인 부탁드려요");
    expect(section(p2.prompt, "### [답할 대상]")).not.toContain("1) 종료 후 트래픽");
    expect(section(p2.prompt, "### [맥락]")).toContain("1) 종료 후 트래픽");
    expect(res.drafts[0].covers).toEqual([1, 2]);
  });

  it("(e) Ned 소개 스레드: 내 원글 → 상대 질문 미답 → open 1, 맥락에 내 원글", async () => {
    const t0 = minsAgo(300), t1 = minsAgo(100);
    writeAgenda(agendaWith([{ from: "나", ts: t0, text: "Ned 를 소개합니다. 세션·Slack·메일을 한 화면에 모아 줍니다." }, { from: "정우", ts: t1, text: "이 다음 동작은 뭐에요??" }]));
    replies.pass1 = { transcript: [], asks: [{ who: "정우", what: "다음 동작이 무엇인지", status: "open", answered_in: "", asked_in: [t1] }], participants: [{ name: "정우" }] };
    replies.pass2 = { summary: "다음 동작 질문", excerpt: "", mentions: [], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.asks.filter((a) => a.status === "open")).toHaveLength(1);
    const p2 = pass(2)[0].prompt;
    expect(section(p2, "### [맥락]")).toContain("나: Ned 를 소개합니다");
    expect(section(p2, "### [답할 대상]")).toContain("정우: 이 다음 동작은 뭐에요??");
    expect(p2).toContain("1. 정우 — 다음 동작이 무엇인지");
  });

  it("my_last_ts (팔로업 스레드) 가 발췌보다 앞이면 그 이후만 [답할 대상]", async () => {
    const t0 = minsAgo(60), t1 = minsAgo(30);
    writeAgenda(agendaWith([{ from: "kim", ts: t0, text: "어제 건은요?" }, { from: "kim", ts: t1, text: "오늘 배포 되나요?" }], { my_last_ts: slackTs(45) }));
    replies.pass1 = { transcript: [], asks: [{ who: "kim", what: "어제 건", status: "open", answered_in: "", asked_in: [t0] }, { who: "kim", what: "오늘 배포 여부", status: "open", answered_in: "", asked_in: [t1] }], participants: [] };
    replies.pass2 = { summary: "", excerpt: "", mentions: [], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    // No daemon demotion: the model's open stays open; the one from before my reply is flagged before_reply.
    expect(res.asks.map((a) => [a.status, !!a.before_reply])).toEqual([["open", true], ["open", false]]);
    expect(section(pass(2)[0].prompt, "### [답할 대상]")).not.toContain("어제 건은요?");
    expect(pass(2)[0].prompt).toContain("1. kim — 어제 건 [내 마지막 답글 이전 질문 — 아직 답 안 됨]");
  });

  it("(M2) 대기성 답글: 질문 → 내 '확인해 볼게요' → 상대 '넵' → open 1 유지, before_reply", async () => {
    const q = minsAgo(90), hold = minsAgo(80), ok = minsAgo(70);
    writeAgenda(agendaWith([{ from: "kim", ts: q, text: "이번 주 배포 가능할까요?" }, { from: "나", ts: hold, text: "확인해 볼게요" }, { from: "kim", ts: ok, text: "넵" }]));
    replies.pass1 = { transcript: [], asks: [{ who: "kim", what: "이번 주 배포 가능 여부", status: "open", answered_in: "", asked_in: [q] }], participants: [] };
    replies.pass2 = { summary: "배포 가능 여부", excerpt: "", mentions: [], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.asks).toEqual([{ who: "kim", what: "이번 주 배포 가능 여부", due: "", status: "open", answered_in: "", before_reply: true }]);
    const p2 = pass(2)[0].prompt;
    expect(p2).toContain("답할 것이 1개다");
    expect(p2).not.toContain("짧은 리액션/확인형");
    expect(pass(1)[0].prompt).toContain("나중에 답하겠다는");
  });

  it("(M3) 내가 마지막 + 힌트 → 리액션 '만' 문구 없음, 독촉/후속 + 힌트 우선", async () => {
    writeAgenda(agendaWith([{ from: "kim", ts: minsAgo(90), text: "자료 주세요" }, { from: "나", ts: minsAgo(60), text: "공유드렸습니다. 확인 부탁드려요" }]));
    replies.pass1 = { transcript: [], asks: [{ who: "kim", what: "자료", status: "answered", answered_in: minsAgo(60), asked_in: [minsAgo(90)] }], participants: [] };
    replies.pass2 = { summary: "", excerpt: "", mentions: [], drafts: drafts3([]) };
    await generateDraft({ source: "slack", ref: { url: URL_FAST }, hint: "확인했는지 다시 물어봐 줘", force: true }, cfg);
    const p2 = pass(2)[0].prompt;
    expect(p2).not.toContain("으로만 쓴다");
    expect(p2).toContain("후속 확인(정중한 독촉)");
    expect(p2).toContain("힌트를 우선한다");
  });

  it("(M3) Jira open 0 (다른 사람 메시지는 있음) → 진행 상황 공유", async () => {
    replies.pass1 = { transcript: [{ ts: "2026-11-01T00:00:00Z", from: "나", mine: true, text: "작업 시작" }, { ts: "2026-11-02T00:00:00Z", from: "qa", mine: false, text: "고생하세요" }], asks: [], participants: [] };
    replies.pass2 = { summary: "", excerpt: "", mentions: [], drafts: drafts3([]) };
    await generateDraft({ source: "jira", ref: { url: "https://acme.atlassian.net/browse/ABC-13" }, force: true }, cfg);
    expect(pass(2)[0].prompt).toContain("진행 상황 공유(무엇을 했고 다음에 무엇을 할지)를 짧게 쓴다");
    expect(pass(2)[0].prompt).not.toContain("짧은 리액션/확인형");
  });

  it("(f) 메일: 내 주소(SENT) 메시지 = mine, reply_meta 로 회신 주소", async () => {
    replies.pass1 = {
      transcript: [
        { ts: "2026-11-02T01:00:00Z", from: "boss@acme.com", mine: false, text: "예산안 검토 부탁해요. 수요일까지 의견 주세요." },
        { ts: "2026-11-03T01:00:00Z", from: "나", mine: true, text: "검토 중입니다. 수요일 오전에 드릴게요." },
        { ts: "2026-11-05T01:00:00Z", from: "boss@acme.com", mine: false, text: "혹시 인건비 항목만 먼저 볼 수 있을까요?" },
      ],
      asks: [
        { who: "boss", what: "예산안 의견", due: "수요일", status: "answered", answered_in: "2026-11-03T01:00:00Z", asked_in: ["2026-11-02T01:00:00Z"] },
        { who: "boss", what: "인건비 항목 먼저 공유", status: "open", answered_in: "", asked_in: ["2026-11-05T01:00:00Z"] },
      ],
      participants: [{ name: "boss@acme.com" }],
      reply_meta: { message_id: "msg-3", reply_to: "boss@acme.com", subject: "Re: 예산안" },
    };
    replies.pass2 = { summary: "인건비 항목 선공유 요청", excerpt: "", mentions: ["<@U1>"], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "email", ref: { thread_id: "th-mail", title: "예산안" }, force: true }, cfg);
    expect(res.meta).toMatchObject({ thread_id: "th-mail", message_id: "msg-3", reply_to: "boss@acme.com", subject: "Re: 예산안", mode: "2pass" });
    expect(res.asks.map((a) => a.status)).toEqual(["answered", "open"]);
    expect(res.mentions).toEqual([]); // email never mentions
    expect(pass(1)[0].prompt).toContain("SENT");
    const p2 = pass(2)[0].prompt;
    expect(section(p2, "### [답할 대상]")).toContain("인건비 항목");
    expect(section(p2, "### [맥락]")).toContain("나: 검토 중입니다");
    expect(p2).toContain("메일: 인사");
  });

  it("(f) Jira: currentUser 코멘트 = mine, atlassianUserInfo 도구", async () => {
    replies.pass1 = {
      transcript: [
        { ts: "2026-11-01T00:00:00Z", from: "reporter", mine: false, text: "로그인 오류 재현됨" },
        { ts: "2026-11-02T00:00:00Z", from: "나", mine: true, text: "원인 파악 중입니다." },
        { ts: "2026-11-04T00:00:00Z", from: "qa", mine: false, text: "수정 배포 예정일 알려주세요." },
      ],
      asks: [{ who: "qa", what: "수정 배포 예정일", status: "open", answered_in: "", asked_in: ["2026-11-04T00:00:00Z"] }],
      participants: [{ name: "reporter" }, { name: "qa" }],
    };
    replies.pass2 = { summary: "배포 예정일 문의", excerpt: "", mentions: [], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "jira", ref: { url: "https://acme.atlassian.net/browse/ABC-12" }, force: true }, cfg);
    expect(res.meta).toMatchObject({ issue_key: "ABC-12", cloud_id: "acme.atlassian.net", mode: "2pass" });
    expect(pass(1)[0].opts.allowedTools).toContain("mcp__claude_ai_Atlassian__atlassianUserInfo");
    expect(pass(1)[0].prompt).toContain("atlassianUserInfo");
    expect(section(pass(2)[0].prompt, "### [맥락]")).toContain("나: 원인 파악 중입니다.");
    expect(pass(2)[0].prompt).toContain("Jira 코멘트: 평문");
  });

  it("(f) 참여자 2명 이상 → mentions 제안 (알려진 <@U…> 만)", async () => {
    replies.pass1 = {
      transcript: [
        { ts: "1762300800.000100", from: "kim", mine: false, user_id: "U0KIM", text: "QA 일정 어떻게 돼요?" },
        { ts: "1762300900.000100", from: "lee", mine: false, user_id: "U0LEE", text: "저는 다음 주 괜찮아요" },
      ],
      asks: [{ who: "kim", what: "QA 일정", status: "open", answered_in: "", asked_in: ["1762300800.000100"] }],
      participants: [{ name: "kim", user_id: "U0KIM" }, { name: "lee", user_id: "U0LEE" }],
    };
    replies.pass2 = { summary: "QA 일정", excerpt: "", mentions: ["<@U0KIM>", "<@UFAKE>"], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "slack", ref: { channel: "C333", ts: "1762300800.000100" }, force: true }, cfg);
    expect(res.mentions).toEqual([{ id: "<@U0KIM>", name: "kim" }]);
    expect(pass(2)[0].prompt).toContain("참여자: kim(<@U0KIM>), lee(<@U0LEE>)");
  });

  it("(M5) fast 경로: Pass 1 이 지어낸 user_id 는 버림 → 멘션 제안 없음", async () => {
    writeAgenda(agendaWith([{ from: "kim", ts: minsAgo(30), text: "QA 일정은요?" }, { from: "lee", ts: minsAgo(20), text: "저도 궁금" }]));
    replies.pass1 = { transcript: [], asks: [{ who: "kim", what: "QA 일정", status: "open", answered_in: "", asked_in: [] }], participants: [{ name: "kim", user_id: "U0FAKE" }, { name: "lee", user_id: "U0FAKE2" }] };
    replies.pass2 = { summary: "", excerpt: "", mentions: ["<@U0FAKE>"], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.mentions).toEqual([]);
    expect(pass(2)[0].prompt).not.toContain("U0FAKE");
  });

  it("(L1) 메시지 본문에 {{ASKS}} 가 있어도 섹션이 안 바뀜", async () => {
    writeAgenda(agendaWith([{ from: "kim", ts: minsAgo(30), text: "템플릿 {{ASKS}} {{TONE}} 문자열 어때요?" }]));
    replies.pass1 = { transcript: [], asks: [{ who: "kim", what: "템플릿 의견", status: "open", answered_in: "", asked_in: [] }], participants: [] };
    replies.pass2 = { summary: "", excerpt: "", mentions: [], drafts: drafts3([1]) };
    await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    const p2 = pass(2)[0].prompt;
    expect(p2).toContain("템플릿 {{ASKS}} {{TONE}} 문자열");
    expect(p2.match(/1\. kim — 템플릿 의견/g)).toHaveLength(1);
  });

  it("(f) Pass 1 JSON 파싱 실패 → legacy 단일 패스 1회, meta.mode legacy, 비용 합산", async () => {
    replies.pass1 = "죄송합니다, 스레드를 읽지 못했습니다.";
    replies.legacy = { summary: "s", excerpt: "e", reply_meta: {}, drafts: drafts3([]).map(({ label, text }) => ({ label, text })) };
    const res = await generateDraft({ source: "slack", ref: { channel: "C444", ts: "1762300800.000100" }, force: true }, cfg);
    expect(res.meta.mode).toBe("legacy");
    expect(res.asks).toEqual([]);
    expect(res.mentions).toEqual([]);
    expect(pass(2)).toHaveLength(0);
    expect(calls.filter((c) => c.prompt.startsWith("# Ned reply draft\n"))).toHaveLength(1);
    expect(res.cost_usd).toBeCloseTo(0.03);
    expect(res.drafts).toHaveLength(3);
  });

  it("(L7) full Pass 2 실패 → Pass 2 만 1회 재시도, 그래도 실패면 502 (Pass 1 은 한 번)", async () => {
    replies.pass1 = { transcript: [], asks: [], participants: [] };
    replies.pass2 = "not json";
    await expect(generateDraft({ source: "slack", ref: { channel: "C555", ts: "1762300800.000100" }, force: true }, cfg)).rejects.toMatchObject({ status: 502 });
    expect(pass(1)).toHaveLength(1);
    expect(pass(2)).toHaveLength(2);
  });

  it("(L7) full Pass 2 재시도 성공 → 결과, 비용 = pass1 + pass2×2", async () => {
    replies.pass1 = { transcript: [], asks: [], participants: [] };
    replies.pass2 = queue("not json", { summary: "", excerpt: "", mentions: [], drafts: drafts3([]) });
    const res = await generateDraft({ source: "slack", ref: { channel: "C556", ts: "1762300800.000100" }, force: true }, cfg);
    expect(res.drafts).toHaveLength(3);
    expect(res.cost_usd).toBeCloseTo(0.04);
  });

  it("(M1) Pass 1 ok:false (full) → legacy 호출 없이 바로 502, 원래 오류 메시지", async () => {
    replies.pass1 = FAIL;
    replies.legacy = { summary: "s", excerpt: "", reply_meta: {}, drafts: drafts3([]).map(({ label, text }) => ({ label, text })) };
    await expect(generateDraft({ source: "slack", ref: { channel: "C557", ts: "1762300800.000100" }, force: true }, cfg)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("timeout after 240s") });
    expect(calls.filter((c) => c.prompt.startsWith("# Ned reply draft\n"))).toHaveLength(0);
    expect(pass(2)).toHaveLength(0);
  });

  it("(M1) Pass 1 ok:false (fast) → full 2-pass 로 1회, legacy 없음, 비용 합산", async () => {
    writeAgenda(agendaWith([{ from: "kim", ts: minsAgo(30), text: "리뷰 언제?" }]));
    replies.pass1 = queue(FAIL, { transcript: [{ ts: "1762300800.000100", from: "kim", mine: false, text: "리뷰 언제?" }], asks: [{ who: "kim", what: "리뷰 시점", status: "open", answered_in: "", asked_in: ["1762300800.000100"] }], participants: [] });
    replies.pass2 = { summary: "", excerpt: "", mentions: [], drafts: drafts3([1]) };
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.mode).toBe("full");
    expect(res.meta.mode).toBe("2pass");
    expect(pass(1).map((c) => c.opts.maxTurns)).toEqual([1, 8]);
    expect(calls.filter((c) => c.prompt.startsWith("# Ned reply draft\n"))).toHaveLength(0);
    expect(res.cost_usd).toBeCloseTo(0.05); // fast pass1 0.02 + full pass1 0.02 + pass2 0.01
  });

  it("(테스트 공백 1·L4) fast Pass 2 실패 → full 2-pass 폴백, 비용 합산이 캐시 파일에도", async () => {
    writeAgenda(agendaWith([{ from: "kim", ts: minsAgo(30), text: "리뷰 언제?" }]));
    replies.pass1 = { transcript: [{ ts: "1762300800.000100", from: "kim", mine: false, text: "리뷰 언제?" }], asks: [{ who: "kim", what: "리뷰 시점", status: "open", answered_in: "", asked_in: [] }], participants: [] };
    replies.pass2 = queue("not json", { summary: "", excerpt: "", mentions: [], drafts: drafts3([1]) });
    const res = await generateDraft({ source: "slack", ref: { url: URL_FAST }, force: true }, cfg);
    expect(res.mode).toBe("full");
    expect(res.cost_usd).toBeCloseTo(0.06); // fast (0.02 + 0.01) + full (0.02 + 0.01)
    const { DRAFTS_DIR } = await import("../src/drafts.js");
    expect(JSON.parse(fs.readFileSync(`${DRAFTS_DIR}/${res.id}.json`, "utf8")).cost_usd).toBeCloseTo(0.06);
  });

  it("(L6) full 경로도 팔로업 스레드의 my_last_ts 로 구획 (내 답글이 Pass 1 의 25개 밖)", async () => {
    const root = "1762300800.000100";
    // agenda excerpt is stale (→ full path) but the followed-thread read knows my last reply ts.
    const a = agendaWith([{ from: "kim", ts: minsAgo(600), text: "x" }], { my_last_ts: "1762300900.000100" });
    a.slack!.items[0].url = `https://x.slack.com/archives/C777/p1762300800000100`;
    a.slack!.items[0].context!.collected_at = minsAgo(600);
    writeAgenda(a);
    replies.pass1 = {
      transcript: [{ ts: "1762300850.000100", from: "kim", mine: false, text: "옛 질문?" }, { ts: "1762301000.000100", from: "kim", mine: false, text: "새 질문?" }],
      asks: [], participants: [],
    };
    replies.pass2 = { summary: "", excerpt: "", mentions: [], drafts: drafts3([]) };
    const res = await generateDraft({ source: "slack", ref: { channel: "C777", ts: root }, force: true }, cfg);
    expect(res.mode).toBe("full");
    const target = section(pass(2)[0].prompt, "### [답할 대상]");
    expect(target).toContain("새 질문?");
    expect(target).not.toContain("옛 질문?");
  });

  it("session / github 은 legacy 그대로", async () => {
    replies.legacy = { summary: "s", excerpt: "", reply_meta: {}, drafts: drafts3([]).map(({ label, text }) => ({ label, text })) };
    const res = await generateDraft({ source: "session", ref: { session_id: "sess-x" }, force: true }, cfg);
    expect(res.meta.mode).toBe("legacy");
    expect(pass(1)).toHaveLength(0);
  });

  it("캐시된 옛 포맷(asks·mentions·meta.mode 없음) 도 기본값으로 돌려줌", async () => {
    const { DRAFTS_DIR, draftIdOf, refKey } = await import("../src/drafts.js");
    const ref = { channel: "C666", ts: "1762300800.000100" };
    const id = draftIdOf(refKey("slack", ref));
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    fs.writeFileSync(`${DRAFTS_DIR}/${id}.json`, JSON.stringify({ id, source: "slack", context: { summary: "old", excerpt: "" }, drafts: [{ id: `${id}-0`, label: "짧게", text: "옛 초안" }], cost_usd: 0.01, cached: false, created_at: Date.now(), hint: "", tone: DEFAULT_CONFIG.reply_tone, meta: { channel_id: "C666" } }));
    const res = await generateDraft({ source: "slack", ref }, cfg);
    expect(res).toMatchObject({ cached: true, mode: "full", asks: [], mentions: [] });
    expect(res.meta.mode).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
