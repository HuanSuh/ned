/**
 * Ned Net 대화창 쓰기 제안 (config.actions.chat_write). The chat model stays read-only: when the user wants something
 * written it ends its answer with ONE ```ned-action block (a proposal). The dashboard shows it as a 확인 카드 and, on
 * [실행], asks POST /api/chat/actions/validate to check it and build the request for an EXISTING endpoint
 * (/api/send, /api/calendar/events, /api/todos) — there is no chat-only execution path. Only the text is editable;
 * the target (channel, recipient, issue, PR, event, session) must be an item Ned already knows (agenda / state).
 * Slack (WU-07) also takes a thread the user pasted a permalink of, or one the model really read this conversation
 * (seen_slack saved from its Slack tool results) — and resolves the block's `mentions` into `<@U…>` / `<!subteam^S…>`
 * with an ID whitelist (slack-mentions.ts).
 */
import { createHash } from "node:crypto";
import { RSVP_STATUSES, onSendResult, queryActionLog, type ActionRef, type SendRequest } from "./actions.js";
import { slackDirectory } from "./send-rules.js";
import type { Agenda } from "./agenda.js";
import { parseCalendarCreate } from "./calendar-create.js";
import type { Chat } from "./chat.js";
import type { NedActions, NedConfig } from "./config.js";
import { localDay } from "./paths.js";
import type { NedState } from "./state.js";
import { MAX_PROMPT, PLAN_FIRST, knownRepoPaths, parseSessionCreate, sessionLogRef } from "./session-create.js";
import {
  agendaSlackUsers,
  groupDirectory,
  knownGroupIds,
  parseMentions,
  parseSlackPermalink,
  permalinksIn,
  rawIdTokens,
  readUsersCache,
  resolveMentions,
  sameTarget,
  seenHas,
  updateUsersCache,
  type MentionReport,
  type MentionSpec,
  type SeenSlack,
  type SeenUser,
  type SlackUsersCache,
} from "./slack-mentions.js";

export const CHAT_ACTION_KINDS = ["todo_add", "slack_send", "gmail_draft", "gmail_send", "jira_comment", "jira_transition", "github_review", "calendar_create", "calendar_rsvp", "session_send", "session_create"] as const;
export type ChatActionKind = (typeof CHAT_ACTION_KINDS)[number];

/** The config.actions switch each kind also needs (todo_add is local — chat_write alone). */
export const CHAT_KIND_GATE: Record<ChatActionKind, keyof NedActions | null> = {
  todo_add: null,
  slack_send: "slack_send",
  gmail_draft: "gmail_draft",
  gmail_send: "gmail_send",
  jira_comment: "jira_comment",
  jira_transition: "jira_transition",
  github_review: "github_review",
  calendar_create: "calendar_create",
  calendar_rsvp: "calendar_rsvp",
  session_send: "session_send",
  session_create: "chat_session_create",
};

export const CHAT_KIND_KO: Record<ChatActionKind, string> = {
  todo_add: "할 일 추가",
  slack_send: "Slack 보내기",
  gmail_draft: "Gmail 답장 초안 저장",
  gmail_send: "메일 답장 보내기",
  jira_comment: "Jira 코멘트",
  jira_transition: "Jira 상태 변경",
  github_review: "GitHub PR 리뷰·코멘트",
  calendar_create: "캘린더 일정 만들기",
  calendar_rsvp: "캘린더 참석 응답",
  session_send: "세션에 보내기",
  session_create: "새 에이전트 세션 만들기",
};

/** One line per kind for the prompt: what `target` holds and what `text` is. */
const KIND_SPEC: Record<ChatActionKind, string> = {
  todo_add: '`target`: {"due": "YYYY-MM-DD"(선택)} · `text`: 할 일 제목',
  slack_send:
    '`target`: {"url": "<Slack 메시지 permalink>", "channel_external": true|false(채널이 외부 공유면 true, 모르면 생략)} · `target_excerpt`: 대상 스레드 첫 글 발췌(200자 이내) · `mentions`: [{"text": "@이름", "candidates": [{"id": "U…", "name": "표시 이름", "real_name": "", "title": "", "external": false}]}] · `text`: 보낼 메시지(그 메시지의 스레드에 답글)',
  gmail_draft: '`target`: {"url": "<맥락의 메일 url>"} · `text`: 답장 본문',
  gmail_send: '`target`: {"url": "<맥락의 메일 url>"} · `text`: 답장 본문',
  jira_comment: '`target`: {"url": "<맥락의 Jira 이슈 url>"} · `text`: 코멘트',
  jira_transition: '`target`: {"url": "<맥락의 Jira 이슈 url>"} · `text`: 옮길 상태 이름(예: "진행 중")',
  github_review: '`target`: {"url": "<맥락의 PR url>", "event": "comment"|"review_comment"|"approve"|"request_changes"} · `text`: 코멘트 본문(approve 는 비워도 됨)',
  calendar_create: '`target`: {"date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "all_day": false, "location": "", "attendees": ["메일 주소"], "meet": false} · `text`: 일정 제목',
  calendar_rsvp: '`target`: {"event_id": "<맥락의 event_id>", "response": "accepted"|"declined"|"tentative"} · `text`: 응답 코멘트(선택)',
  session_send: '`target`: {"session_id": "<맥락의 session_id>"} · `text`: 세션 터미널에 입력할 말',
  session_create: `\`target\`: {"repo": "<아래 등록 레포 경로 그대로>", "worktree": {"mode": "new"|"existing", "name": "<새 워크트리 이름(영문·숫자·._-) 또는 기존 워크트리 이름>"}, "model": "opus"|"sonnet"(기본 opus)} · \`text\`: 새 Claude 세션에 보낼 첫 프롬프트 **전문**(맥락·할 일·완료 조건까지 자기완결적으로). 반드시 "${PLAN_FIRST}" 로 시작`,
};

export const isChatKind = (k: unknown): k is ChatActionKind => typeof k === "string" && (CHAT_ACTION_KINDS as readonly string[]).includes(k);

/** Kinds the chat may propose right now: [] unless actions.chat_write, then those whose own switch is on. */
export function allowedChatKinds(cfg: Pick<NedConfig, "actions">): ChatActionKind[] {
  if (cfg.actions.chat_write !== true) return [];
  return CHAT_ACTION_KINDS.filter((k) => {
    const g = CHAT_KIND_GATE[k];
    return g === null || cfg.actions[g] === true;
  });
}

/** The system-prompt section listing ONLY the allowed kinds ("" when chat_write is off or nothing is allowed). */
export function chatWriteBlock(cfg: Pick<NedConfig, "actions">): string {
  const kinds = allowedChatKinds(cfg);
  if (!kinds.length) return "";
  return [
    "## 대화창 쓰기 제안 (ned-action)",
    "",
    "사용자가 보내기·만들기·추가를 원하면 **직접 하지 말고**(쓰기 도구는 없다) 답변 맨 끝에 아래 형식의 코드블록 **하나만** 붙여 제안한다. 대시보드가 이걸 확인 카드로 보여 주고, 사용자가 텍스트를 고친 뒤 [실행] 해야 실제로 실행된다.",
    "",
    "```ned-action",
    '{"kind": "<아래 목록 중 하나>", "target": { ... }, "text": "<보낼 글>", "summary": "<한 줄 요약>"}',
    "```",
    "",
    "- 지금 허용된 kind 는 이것뿐이다 (목록에 없는 동작은 제안하지 말고 \"설정 → 쓰기 액션에서 켜야 해\" 라고 안내):",
    ...kinds.map((k) => `  - \`${k}\` (${CHAT_KIND_KO[k]}): ${KIND_SPEC[k]}`),
    ...(kinds.includes("session_create") ? [sessionCreateRepoLine()] : []),
    ...(kinds.includes("slack_send") ? SLACK_SEND_RULES : []),
    "- `target` 의 url·event_id·session_id 는 아래 \"Ned 가 아는 것\" 에 있는 값만 그대로 쓴다(Slack 은 아래 예외). 지어내거나 고치지 않는다. 맥락에 없는 대상이면 제안하지 말고 대시보드에서 하라고 안내한다.",
    "- JSON 은 유효해야 한다(따옴표·쉼표). 블록 밖 답변은 평소처럼 짧게 — 무엇을 제안했는지 한 줄. 블록은 한 답변에 하나만.",
    "- 사용자가 확인 없이 바로 하라고 해도 블록으로 제안만 한다.",
  ].join("\n");
}

/** slack_send: which threads may be targeted + how to write mentions (the server re-checks both). */
const SLACK_SEND_RULES = [
  "- `slack_send` 대상 스레드: (1) \"Ned 가 아는 것\" 의 Slack url, (2) 사용자가 이 대화에 붙인 Slack 링크, (3) 네가 이 대화에서 Slack 읽기 도구(검색·채널/스레드 읽기)로 **실제로 읽은** 메시지의 permalink — 이 셋만. permalink 는 도구 결과에 나온 그대로 쓰고 지어내지 않는다. 못 찾았으면 제안하지 말고 링크를 달라고 한다. 대상 스레드 첫 글을 `target_excerpt` 에 짧게 넣는다.",
  "- `slack_send` 멘션: 본문엔 `@이름` 을 그대로 쓰고 `<@U…>` 같은 ID 는 넣지 않는다. 멘션한 사람마다 `mentions` 에 {text, candidates} 를 넣는다. 해석 순서: 대상 스레드 참여자 → 최근 대화 상대 → slack_search_users / slack_read_user_profile. 추측 금지 — 확실한 사람만 후보로, 동명이인이면 후보를 모두, 못 찾으면 candidates 는 빈 배열. 다른 회사(외부) 사용자면 external: true. 후보 id 는 이 대화에서 slack_search_users / slack_read_user_profile 결과에 나온 그대로만 쓴다 — Ned 가 그 결과로 id 를 확인하고, 확인 안 된 id 는 보내지 않는다.",
  "- `slack_send` 그룹 멘션(@mobile-dev 같은 유저그룹): `mentions` 에 {\"text\": \"@핸들\", \"group\": true, \"candidates\": []} — 그룹 ID 는 Ned 가 설정에서 채운다(모르면 글자로 감). `@here`·`@channel`·`@everyone` 같은 전체 알림은 쓰지 않는다(보낼 수 없다).",
];

/** session_create: the repos the proposal may name (Orca 등록 레포 — cached, refreshed in the background). */
function sessionCreateRepoLine(): string {
  const repos = knownRepoPaths();
  return repos.length
    ? `- \`session_create\` 의 repo 는 이 Orca 등록 레포 경로 중 하나만: ${repos.map((r) => `\`${r}\``).join(", ")}. 어느 레포인지 애매하면 제안 전에 물어본다. 세션은 대화창 출처로 동시에 2개까지.`
    : "- `session_create` 의 repo 는 Orca 에 등록된 레포의 절대 경로만 된다(목록을 아직 못 읽었으니 사용자에게 경로를 물어본다). 세션은 대화창 출처로 동시에 2개까지.";
}

// ---------- validate ----------

export interface ChatActionBlock {
  kind: ChatActionKind;
  target: Record<string, unknown>;
  text: string;
  summary: string;
  /** slack_send: people / groups to mention (model candidates — slack-mentions.ts). */
  mentions: MentionSpec[];
  /** slack_send: the thread's first message, as the model read it (card only, ≤ 200 chars). */
  target_excerpt: string;
  /** slack_send: the channel is shared with another company (model's read of the channel info); undefined = unknown. */
  channel_external?: boolean;
}

/** slack_send extras for the 확인 카드 (also on a 400 / 409 so the card can show the mention dropdowns / why). */
export interface SlackCardInfo {
  /** known = Ned 가 아는 항목 · pasted = 사용자가 붙인 링크 · found = 모델이 이 대화에서 읽은 메시지 (확인 필요). */
  target_source: "known" | "pasted" | "found";
  channel: string;
  /** "#name" from Ned's own Slack data (agenda) — never the model's; "" = unknown (the card shows the id + "채널 이름 확인 안 됨"). */
  channel_name: string;
  /** Where the reply goes (thread root ts); "" = a DM's top level. Same rule as the real send (actions.ts). */
  thread_ts: string;
  /** The model's excerpt of the thread's first message (shown as the model's, unverified). */
  target_excerpt: string;
  /**
   * "external" (anyone — the model included — says the channel is shared or a mentioned person is external) · "unknown"
   * (회색 배지). Never "internal": a model's `external: false` is a claim, and Ned has no trusted internal record.
   */
  external: "external" | "unknown";
  /** The text with resolved mentions (what gets sent). */
  preview_text: string;
  mentions: Pick<MentionReport, "resolved" | "unresolved" | "missing" | "broadcast">;
  /** dashboard.slack_team_domain is not set: a pasted / found link of any workspace is accepted (the card says so). */
  workspace_unset?: boolean;
}

/**
 * What the card showed, bound to what will be sent: sha256 of {final text, where it goes} (first 32 hex). [실행] must
 * send back the digest of the preview it rendered (`ack_digest`); a different one → 409 need_review + the new preview.
 * /api/send checks the same digest for origin "chat" Slack sends.
 */
export function previewDigest(text: string, ref: Pick<ActionRef, "url" | "channel" | "thread_ts">): string {
  return createHash("sha256").update(JSON.stringify({ t: text, r: [ref.url ?? "", ref.channel ?? "", ref.thread_ts ?? ""] })).digest("hex").slice(0, 32);
}

/** What validate needs beyond the switches + agenda: the conversation, the mention cache / groups, choices, today's count. */
export interface ChatValidateCtx {
  /** dashboard.slack_team_domain ("" = any workspace). */
  team_domain: string;
  /** The conversation's user messages (permalinks the user pasted). */
  user_texts: string[];
  /** Slack messages the model read in this conversation (its answers' seen_slack). */
  seen: SeenSlack[];
  cache: SlackUsersCache;
  groups: { dir: Map<string, string>; ids: Set<string>; handles: string[] };
  /** "@이름" → the user id the user picked on the card (동명이인). */
  choices: Record<string, unknown>;
  /** actions.chat_write_daily_limit reached → the 429 body. */
  over?: ChatLimitBody | null;
  /** Users this conversation's Slack user lookups returned (id → name) — mention ids must be these or cached. */
  seen_users?: Record<string, SeenUser>;
  /** [실행] (intent "run"): the digest of the preview the card rendered — must equal the one computed now. */
  run?: { ack_digest: string };
}
const EMPTY_CTX: ChatValidateCtx = { team_domain: "", user_texts: [], seen: [], cache: { users: {} }, groups: { dir: new Map(), ids: new Set(), handles: [] }, choices: {} };

export interface ChatLimitBody {
  ok: false;
  error: string;
  limit: number;
  used: number;
}
/** origin "chat" writes that really went out today (local midnight): ok, not a dry run, not a Jira transitions lookup. */
export function chatSentToday(now = new Date()): number {
  return queryActionLog({ since: localDay(now) }, Number.MAX_SAFE_INTEGER).filter((e) => e.origin === "chat" && e.ok && !String(e.action).startsWith("dry_run:") && e.mode !== "transitions").length;
}
/** Chat sends admitted but not finished yet (reserveChatSend) — counted as used so concurrent requests can't overshoot. */
let chatReserved = 0;
/** The 429 body when actions.chat_write_daily_limit (> 0) is reached (sent today + running), else null. */
export function chatLimitReached(cfg: Pick<NedConfig, "actions">, now = new Date()): ChatLimitBody | null {
  const limit = cfg.actions.chat_write_daily_limit ?? 0;
  if (!(limit > 0)) return null;
  const used = chatSentToday(now) + chatReserved;
  return used >= limit ? { ok: false, error: `오늘 대화창 전송 상한(${limit}) 도달 — 설정 → 쓰기 액션 → 대화창에서 바꿀 수 있어`, limit, used } : null;
}
/**
 * Check the cap and hold one slot, synchronously (no await between the two). `release` (idempotent) when the send is
 * over — finished, or not started (joined a twin, already sent, held for confirm). → {over} when the cap is reached.
 */
export function reserveChatSend(cfg: Pick<NedConfig, "actions">): { over: ChatLimitBody } | { release: () => void } {
  const over = chatLimitReached(cfg);
  if (over) return { over };
  chatReserved++;
  let done = false;
  return { release: () => { if (!done) { done = true; chatReserved = Math.max(0, chatReserved - 1); } } };
}
/** Tests. */
export const _resetChatReserved = () => { chatReserved = 0; };

// ---------- 멘션 캐시: written only after a real send (never from a card preview) ----------
/** payload text → the people it mentions (set by validate, read when that exact text was really sent). 10 min, ≤ 100. */
const pendingMentions = new Map<string, { users: { id: string; name: string; external?: boolean }[]; at: number }>();
function rememberMentions(text: string, users: { id: string; name: string; external?: boolean }[]): void {
  const now = Date.now();
  for (const [k, v] of pendingMentions) if (now - v.at > 10 * 60_000) pendingMentions.delete(k);
  if (pendingMentions.size >= 100) pendingMentions.delete(pendingMentions.keys().next().value!);
  if (users.length) pendingMentions.set(text, { users, at: now });
}
/** actions.ts onSendResult: a chat Slack send that succeeded → cache its resolved people (names never overwritten). */
export function recordSentMentions(req: Pick<SendRequest, "source" | "origin" | "text">, ok: boolean): void {
  if (!ok || req.origin !== "chat" || req.source !== "slack") return;
  const p = pendingMentions.get(req.text);
  if (!p) return;
  pendingMentions.delete(req.text);
  updateUsersCache(p.users.map((u) => ({ id: u.id, name: u.name, ...(u.external ? { external: true } : {}) })));
}
onSendResult(recordSentMentions);

/** POST /api/chat/actions/validate body + the conversation → ChatValidateCtx (cache refreshed with agenda users). */
export function chatValidateContext(cfg: Pick<NedConfig, "actions"> & Partial<Pick<NedConfig, "dashboard" | "filters">>, agenda: Agenda, body: Record<string, unknown>, chat: Chat | null): ChatValidateCtx {
  const msgs = chat?.messages ?? [];
  const fromAgenda = agendaSlackUsers(agenda.slack);
  const cache = fromAgenda.length ? updateUsersCache(fromAgenda, { trusted: true }) : readUsersCache();
  const sl = cfg.filters?.slack;
  const gopts = { group_mentions: sl?.group_mentions ?? [], group_ids: sl?.group_ids ?? {} };
  const choices = body.mention_choices && typeof body.mention_choices === "object" && !Array.isArray(body.mention_choices) ? (body.mention_choices as Record<string, unknown>) : {};
  return {
    team_domain: cfg.dashboard?.slack_team_domain ?? "",
    user_texts: msgs.filter((m) => m.role === "user").map((m) => m.text),
    seen: msgs.flatMap((m) => (m.role === "ned" && Array.isArray(m.seen_slack) ? m.seen_slack : [])),
    seen_users: Object.fromEntries(msgs.flatMap((m) => (m.role === "ned" && Array.isArray(m.seen_users) ? m.seen_users : [])).map((u) => [u.id, u])),
    ...(body.intent === "run" ? { run: { ack_digest: typeof body.ack_digest === "string" ? body.ack_digest : "" } } : {}),
    cache,
    groups: { dir: groupDirectory(gopts), ids: knownGroupIds(gopts), handles: (sl?.group_mentions ?? []).filter((g) => !/^S[A-Z0-9]{6,}$/.test(g)) },
    choices,
    over: chatLimitReached(cfg),
  };
}

export type ChatEndpoint = "/api/send" | "/api/calendar/events" | "/api/todos" | "/api/sessions/create";

export interface ChatActionOk {
  ok: true;
  kind: ChatActionKind;
  /** Existing endpoint to POST `payload` to (it carries origin "chat"). */
  endpoint: ChatEndpoint;
  payload: Record<string, unknown>;
  /** "Slack 보내기" … */
  label: string;
  summary: string;
  /** Read-only target line for the card. */
  target_label: string;
  text: string;
  /** Whether `text` may be empty. */
  text_optional: boolean;
  /** jira_transition: list transitions with this payload first, then match `text` against name / to. */
  lookup?: Record<string, unknown>;
  /** Job routes other than /api/send: {source, mode, ref, text} of the action-log line (reload / restart fallback). */
  match?: Record<string, unknown>;
  /** Longest the card waits for the job (ms) — session_create runs up to a few minutes. */
  max_wait_ms?: number;
  /** slack_send: target source / excerpt / external badge / mentions for the card. */
  slack?: SlackCardInfo;
  /** slack_send: previewDigest of this answer — the card sends it back as ack_digest on [실행]. */
  preview_digest?: string;
}
export interface ChatActionErr {
  ok: false;
  /** 400 malformed / unknown mention id · 403 not allowed (switch off) · 409 target not among the known items / 멘션 선택 필요 · 429 하루 상한. */
  status: 400 | 403 | 409 | 429;
  error: string;
  kind?: ChatActionKind;
  slack?: SlackCardInfo;
  /** 409 멘션 선택 필요 */
  need_choice?: boolean;
  /** 409 [실행] with a stale / missing preview digest: the card shows the new preview (`slack`) and asks again. */
  need_review?: boolean;
  preview_digest?: string;
  /** 429 */
  limit?: number;
  used?: number;
}

const s = (v: unknown, n = 500) => (typeof v === "string" ? v.trim().slice(0, n) : typeof v === "number" ? String(v) : "");
const clip = (v: unknown, n: number) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const MAX_TEXT = 4000;
const err = (status: ChatActionErr["status"], error: string, kind?: ChatActionKind, extra: Partial<ChatActionErr> = {}): ChatActionErr => ({ ok: false, status, error, ...(kind ? { kind } : {}), ...extra });

/** A raw block (object or its JSON text) → ChatActionBlock, or an error string. */
export function parseChatActionBlock(raw: unknown): ChatActionBlock | string {
  let b = raw;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return "ned-action 블록이 JSON 이 아니야";
    }
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return "ned-action 블록이 객체가 아니야";
  const o = b as Record<string, unknown>;
  if (!isChatKind(o.kind)) return `알 수 없는 kind: ${clip(o.kind, 40)} (${CHAT_ACTION_KINDS.join(" | ")})`;
  let target = o.target && typeof o.target === "object" && !Array.isArray(o.target) ? (o.target as Record<string, unknown>) : {};
  let text = typeof o.text === "string" ? o.text.trim() : "";
  if (o.kind === "session_create") {
    // also the flat form {repo, worktree, model, prompt}
    target = { ...Object.fromEntries(["repo", "worktree", "model"].filter((k) => o[k] !== undefined).map((k) => [k, o[k]])), ...target };
    if (!text && typeof o.prompt === "string") text = o.prompt.trim();
  }
  const ext = typeof o.channel_external === "boolean" ? o.channel_external : typeof target.channel_external === "boolean" ? target.channel_external : undefined;
  return {
    kind: o.kind,
    target,
    text,
    summary: clip(o.summary, 200),
    mentions: parseMentions(o.mentions),
    target_excerpt: clip(o.target_excerpt ?? target.target_excerpt, 200),
    ...(ext !== undefined ? { channel_external: ext } : {}),
  };
}

/** Normalised URL key: no trailing slash / fragment-insensitive for Slack-style query strings kept. */
const urlKey = (u: unknown) => s(u, 1000).replace(/\/+$/, "");
const sameUrl = (a: unknown, b: unknown) => !!urlKey(a) && urlKey(a) === urlKey(b);

export interface KnownItems {
  agenda: Agenda;
  state: NedState;
}

function findSlack(k: KnownItems, url: string): { url: string; title: string } | null {
  const sl = k.agenda.slack;
  if (sl) {
    for (const x of [...sl.items, ...(sl.all ?? [])]) if (sameUrl(x.url, url)) return { url: x.url, title: [x.channel, x.from].filter(Boolean).join(" · ") };
    for (const t of [...(sl.threads ?? []), ...(sl.dms ?? [])]) if (sameUrl(t.url, url)) return { url: t.url, title: t.channel || "Slack 스레드" };
    for (const w of sl.watch ?? []) for (const h of [...(w.highlights ?? []), ...(w.recent ?? [])]) if (sameUrl(h.url, url)) return { url: h.url, title: [w.channel, h.from].filter(Boolean).join(" · ") };
  }
  const a = (k.state.attention ?? []).find((x) => x.kind === "slack" && sameUrl(x.url, url));
  return a ? { url: a.url!, title: a.title } : null;
}

const TARGET_SOURCE_KO = { known: "Ned 가 아는 항목", pasted: "붙인 링크", found: "Ned 가 찾은 대상" } as const;

/**
 * slack_send target: (a) an agenda item → as before; else the url must be a Slack permalink of this workspace and
 * (b) the user pasted it in this conversation, or (c) the model read that message / thread in this conversation — and
 * "it" means the same channel AND the same place the reply really goes (sameTarget: the link's thread_ts must be that
 * message or its thread root, so a pasted / read message can't lend its trust to another thread of the channel).
 * The reply goes to the thread root (thread_ts), else to the message's own thread; a DM single-message link → the DM.
 * The channel name on the card comes from Ned's own Slack data only (never the model's words).
 */
function slackSendTarget(
  known: KnownItems,
  url: string,
  ctx: ChatValidateCtx,
): { source: SlackCardInfo["target_source"]; ref: ActionRef; label: string; channel: string; channel_name: string; thread_ts: string } | string {
  const hit = findSlack(known, url);
  if (hit) {
    const p = parseSlackPermalink(hit.url);
    const pp = typeof p === "string" ? null : p;
    const name = pp ? knownChannelName(pp.channel) || (hit.title.split(" · ")[0].startsWith("#") ? hit.title.split(" · ")[0] : "") : "";
    return { source: "known", ref: { url: hit.url, title: hit.title }, label: `Slack · ${hit.title}`, channel: pp?.channel ?? "", channel_name: name, thread_ts: pp?.reply_to ?? "" };
  }
  if (!url) return "Slack 대상 url 이 없어";
  const p = parseSlackPermalink(url, ctx.team_domain);
  if (typeof p === "string") return `그 Slack 대상은 쓸 수 없어 — ${p}`;
  const source: SlackCardInfo["target_source"] | null = ctx.user_texts.some((t) => permalinksIn(t).some((x) => sameTarget(x, p))) ? "pasted" : seenHas(ctx.seen, p) ? "found" : null;
  if (!source) return "그 Slack 스레드는 Ned 가 아는 항목도, 이 대화에 붙인 링크도, Ned 가 이 대화에서 읽은 메시지도 아니야(같은 채널의 다른 스레드도 안 됨) — 스레드 링크를 붙여 줘";
  const name = knownChannelName(p.channel);
  const title = `${name ? `${name} (${p.channel})` : `${p.channel} (채널 이름 확인 안 됨)`} · ${p.reply_to ? "스레드" : "DM"}`;
  return {
    source,
    ref: { url: p.url, channel: p.channel, ts: p.ts, ...(p.reply_to ? { thread_ts: p.reply_to } : {}), title },
    label: `Slack · ${title} (${TARGET_SOURCE_KO[source]})`,
    channel: p.channel,
    channel_name: name,
    thread_ts: p.reply_to ?? "",
  };
}

/** "#name" Ned's own Slack data ties to this channel id (send-rules.ts directory), else "". */
function knownChannelName(channel: string): string {
  const n = [...(slackDirectory().get(channel)?.names ?? [])][0];
  return n ? `#${n}` : "";
}

function findMail(k: KnownItems, url: string): { url: string; thread_id?: string; message_id?: string; title: string } | null {
  const m = k.agenda.mail;
  const hit = m?.items.find((x) => sameUrl(x.url, url));
  if (hit) return { url: hit.url, thread_id: hit.id, message_id: hit.context?.message_id, title: [hit.subject, hit.from].filter(Boolean).join(" — ") };
  const all = m?.all?.find((x) => sameUrl(x.url, url));
  if (all) return { url: all.url, thread_id: all.id, title: [all.subject, all.from].filter(Boolean).join(" — ") };
  return null;
}

function findJira(k: KnownItems, t: Record<string, unknown>): { url: string; key: string; title: string } | null {
  const url = s(t.url), key = s(t.key).toUpperCase();
  const hit = (k.agenda.jira ?? []).find((x) => (url && sameUrl(x.url, url)) || (key && x.key.toUpperCase() === key));
  if (hit) return { url: hit.url, key: hit.key, title: `${hit.key} ${hit.title}` };
  const a = url ? (k.state.attention ?? []).find((x) => x.kind === "jira" && sameUrl(x.url, url)) : undefined;
  const m = a?.url?.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i);
  return a && m ? { url: a.url!, key: m[1].toUpperCase(), title: a.title } : null;
}

function findPr(k: KnownItems, url: string): { url: string; repo: string; number: string; title: string } | null {
  const hit = (k.agenda.github ?? []).find((x) => sameUrl(x.url, url));
  if (hit) return { url: hit.url, repo: hit.repo, number: String(hit.number), title: `${hit.repo}#${hit.number} ${hit.title}` };
  const a = (k.state.attention ?? []).find((x) => x.kind === "github" && sameUrl(x.url, url));
  const m = a?.url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  return a && m ? { url: a.url!, repo: m[1], number: m[2], title: a.title } : null;
}

const GH_EVENTS = { comment: "comment", review_comment: "review_comment", approve: "approve", request_changes: "request_changes" } as const;
const GH_EVENT_KO: Record<keyof typeof GH_EVENTS, string> = { comment: "PR 코멘트", review_comment: "리뷰 코멘트", approve: "승인", request_changes: "변경 요청" };
const RSVP_KO: Record<string, string> = { accepted: "수락", declined: "거절", tentative: "미정" };

/**
 * Check a proposal against the switches and the known items; build the request for the existing endpoint.
 * `textOverride` = the card's edited text (only the text is editable).
 */
export function validateChatAction(cfg: Pick<NedConfig, "actions">, raw: unknown, known: KnownItems, textOverride?: unknown, ctx: ChatValidateCtx = EMPTY_CTX): ChatActionOk | ChatActionErr {
  const b = parseChatActionBlock(raw);
  if (typeof b === "string") return err(400, b);
  const kind = b.kind;
  if (cfg.actions.chat_write !== true) return err(403, "대화창 쓰기가 꺼져 있어 — 설정 → 쓰기 액션 → 대화창 → '대화창에서 쓰기 허용'(actions.chat_write)", kind);
  const g = CHAT_KIND_GATE[kind];
  if (g && cfg.actions[g] !== true) return err(403, `'${CHAT_KIND_KO[kind]}' 이 꺼져 있어 — 설정 → 쓰기 액션에서 actions.${g} 를 켜야 해`, kind);
  // 하루 상한: the endpoints refuse too (429) — said here first so the card shows it before [실행]. Sessions have their own cap.
  if (ctx.over && kind !== "session_create") return err(429, ctx.over.error, kind, { limit: ctx.over.limit, used: ctx.over.used });
  const text = typeof textOverride === "string" ? textOverride.trim() : b.text;
  const maxText = kind === "session_create" ? MAX_PROMPT : MAX_TEXT;
  if (text.length > maxText) return err(400, `텍스트는 ${maxText}자까지야 (지금 ${text.length}자)`, kind);
  const t = b.target;
  const label = CHAT_KIND_KO[kind];
  const base = { ok: true as const, kind, label, summary: b.summary || label, text };
  const send = (source: string, mode: string, ref: ActionRef, target_label: string, text_optional = false): ChatActionOk => ({
    ...base,
    endpoint: "/api/send" as const,
    payload: { source, mode, ref, text, origin: "chat" },
    target_label,
    text_optional,
  });

  switch (kind) {
    case "todo_add": {
      if (!text) return err(400, "텍스트가 비어 있어", kind);
      if (text.length > 200) return err(400, "할 일 제목은 200자까지야", kind);
      const due = s(t.due, 10);
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return err(400, "due 는 YYYY-MM-DD", kind);
      const note = s(t.note, 500);
      return { ...base, endpoint: "/api/todos" as const, payload: { title: text, ...(due ? { due } : {}), ...(note ? { note } : {}), origin: "chat" }, target_label: due ? `개인 할 일 · 마감 ${due}` : "개인 할 일", text_optional: false };
    }
    case "slack_send": {
      if (!text) return err(400, "텍스트가 비어 있어", kind);
      const tg = slackSendTarget(known, s(t.url, 1000) || s(t.permalink, 1000), ctx);
      if (typeof tg === "string") return err(409, tg, kind);
      const rep = resolveMentions(text, b.mentions, ctx.cache, ctx.groups, ctx.choices, ctx.seen_users ?? {});
      // The model must write `@이름`, never ids: an id token it wrote that is still in the text is refused (the
      // whitelist below would let a cached id through otherwise). Ids the user types in by hand follow the whitelist.
      const modelIds = rawIdTokens(b.text).filter((tok) => text.includes(tok));
      // A model's word may only raise the badge to "external", never lower it.
      const external = b.channel_external === true || b.mentions.some((m) => m.candidates.some((c) => c.external)) || rep.resolved.some((r) => r.external) ? "external" : "unknown";
      const slack: SlackCardInfo = {
        ...(ctx.team_domain || tg.source === "known" ? {} : { workspace_unset: true }),
        target_source: tg.source,
        channel: tg.channel,
        channel_name: tg.channel_name,
        thread_ts: tg.thread_ts,
        target_excerpt: b.target_excerpt,
        external,
        preview_text: rep.text,
        mentions: { resolved: rep.resolved, unresolved: rep.unresolved, missing: rep.missing, broadcast: rep.broadcast },
      };
      if (rep.broadcast.length) return err(400, `전체 알림 멘션은 대화창에서 보낼 수 없음 — Slack 에서 직접 (${rep.broadcast.join(", ")})`, kind, { slack });
      if (modelIds.length) return err(400, `모델이 ID 를 직접 넣음(${modelIds.join(", ")}) — 본문엔 @이름 만 쓸 수 있어. 지우거나 대화로 다시 요청해 줘`, kind, { slack });
      if (rep.bad_ids.length) return err(400, `멘션할 수 없는 ID: ${rep.bad_ids.join(", ")} — 이 제안의 후보나 Ned 가 확인한 사람·그룹만 멘션할 수 있어`, kind, { slack });
      if (rep.unverified_ids.length) return err(400, `Ned 가 확인하지 못한 사용자 ID: ${rep.unverified_ids.join(", ")} — 이 대화에서 Ned 가 사용자 검색으로 본 사람이나 전에 보낸 적 있는 사람만 멘션할 수 있어`, kind, { slack });
      if (rep.unresolved.length) return err(409, `멘션 선택 필요: ${rep.unresolved.map((u) => u.text).join(", ")} — 카드에서 누구인지 골라 줘`, kind, { slack, need_choice: true });
      const digest = previewDigest(rep.text, tg.ref);
      // [실행] after an edit (or any change since the preview the card drew): show the new preview first, never send blind.
      if (ctx.run && ctx.run.ack_digest !== digest)
        return err(409, "보낼 모양이 바뀌었어 — 새 미리보기(알림 받는 사람)를 확인하고 다시 실행해 줘", kind, { slack, need_review: true, preview_digest: digest });
      const out = send("slack", "send", tg.ref, tg.label);
      out.payload.text = rep.text;
      out.payload.ack_digest = digest;
      out.preview_digest = digest;
      // the people of THIS text go to the mention cache only if it is really sent (recordSentMentions)
      rememberMentions(rep.text, rep.resolved.filter((r) => r.kind === "user" && r.name !== r.id).map((r) => ({ id: r.id, name: r.name, ...(r.external ? { external: true } : {}) })));
      return { ...out, slack };
    }
    case "gmail_draft":
    case "gmail_send": {
      if (!text) return err(400, "텍스트가 비어 있어", kind);
      const hit = findMail(known, s(t.url, 1000));
      if (!hit) return err(409, "그 메일은 Ned 가 아는 항목이 아니야 (대상 url 이 최근 agenda 에 없음)", kind);
      if (!hit.message_id) return err(409, "이 메일의 답장 주소(message_id)를 아직 몰라 — 대시보드 메일 카드의 ✎ 초안으로 보내 줘", kind);
      const ref: ActionRef = { url: hit.url, message_id: hit.message_id, title: hit.title, ...(hit.thread_id ? { thread_id: hit.thread_id } : {}) };
      return send("email", kind === "gmail_draft" ? "gmail_draft" : "send", ref, `메일 답장 · ${hit.title}`);
    }
    case "jira_comment":
    case "jira_transition": {
      if (!text) return err(400, "텍스트가 비어 있어", kind);
      const hit = findJira(known, t);
      if (!hit) return err(409, "그 Jira 이슈는 Ned 가 아는 항목이 아니야 (대상이 최근 agenda 에 없음)", kind);
      const ref: ActionRef = { url: hit.url, key: hit.key, title: hit.title };
      if (kind === "jira_comment") return send("jira", "comment", ref, `Jira · ${hit.title}`);
      const out = send("jira", "transition", { ...ref, transition_name: text.slice(0, 80) }, `Jira 상태 변경 · ${hit.title}`);
      out.payload.text = "";
      return { ...out, lookup: { source: "jira", mode: "transitions", ref, text: "", origin: "chat" } };
    }
    case "github_review": {
      const ev = (s(t.event, 30) || "comment") as keyof typeof GH_EVENTS;
      if (!(ev in GH_EVENTS)) return err(400, `event 는 ${Object.keys(GH_EVENTS).join(" | ")}`, kind);
      if (ev !== "approve" && !text) return err(400, "텍스트가 비어 있어", kind);
      const hit = findPr(known, s(t.url, 1000));
      if (!hit) return err(409, "그 PR 은 Ned 가 아는 항목이 아니야 (대상 url 이 최근 agenda 에 없음)", kind);
      return send("github", GH_EVENTS[ev], { url: hit.url, repo: hit.repo, number: hit.number, title: hit.title }, `GitHub ${GH_EVENT_KO[ev]} · ${hit.title}`, ev === "approve");
    }
    case "calendar_rsvp": {
      const resp = s(t.response, 20);
      if (!(RSVP_STATUSES as readonly string[]).includes(resp)) return err(400, `response 는 ${RSVP_STATUSES.join(" | ")}`, kind);
      const id = s(t.event_id, 200), url = s(t.url, 1000);
      const ev = (known.agenda.calendar ?? []).find((e) => (id && e.id === id) || (url && sameUrl(e.url, url)));
      if (!ev) return err(409, "그 일정은 Ned 가 아는 항목이 아니야 (event_id 가 최근 agenda 에 없음)", kind);
      if (ev.rsvp === "organizer") return err(409, "내가 주최한 일정엔 참석 응답을 할 수 없어", kind);
      return send("calendar", "rsvp", { event_id: ev.id, response: resp, title: ev.title }, `캘린더 ${RSVP_KO[resp]} · ${ev.title}`, true);
    }
    case "calendar_create": {
      if (!text) return err(400, "텍스트가 비어 있어", kind);
      const body: Record<string, unknown> = { ...t, title: text };
      delete body.calendar_id; // primary only from the chat
      const ev = parseCalendarCreate(body);
      if (typeof ev === "string") return err(400, `일정 정보가 이상해: ${ev}`, kind);
      const when = ev.all_day ? (ev.start === ev.end ? `${ev.start} 종일` : `${ev.start} ~ ${ev.end} 종일`) : `${ev.start.replace("T", " ")} – ${ev.end.slice(0, 10) === ev.start.slice(0, 10) ? ev.end.slice(11) : ev.end.replace("T", " ")}`;
      // Everything the event will carry is on the card (attendees, description too) — the user confirms what gets sent.
      const extra = [ev.location && `장소 ${ev.location}`, ev.attendees.length && `참석자 ${ev.attendees.join(", ")}`, ev.meet && "Meet", ev.description && `설명 "${clip(ev.description, 300)}"`].filter(Boolean).join(" · ");
      const payload: Record<string, unknown> = {
        title: text,
        date: ev.start.slice(0, 10),
        end_date: ev.end.slice(0, 10),
        all_day: ev.all_day,
        ...(ev.all_day ? {} : { start_time: ev.start.slice(11), end_time: ev.end.slice(11) }),
        location: ev.location,
        description: ev.description,
        attendees: ev.attendees,
        meet: ev.meet,
        origin: "chat",
      };
      return { ...base, endpoint: "/api/calendar/events" as const, payload, target_label: `새 일정 · ${when}${extra ? ` · ${extra}` : ""}`, text_optional: false };
    }
    case "session_create": {
      if (!text) return err(400, "첫 프롬프트가 비어 있어", kind);
      const w = t.worktree && typeof t.worktree === "object" ? (t.worktree as Record<string, unknown>) : {};
      const input = parseSessionCreate({ repo: t.repo, worktree: { mode: w.mode, name: w.name }, model: t.model, prompt: text });
      if (typeof input === "string") return err(400, `세션 정보가 이상해: ${input}`, kind);
      const name = input.repo.split("/").pop() || input.repo;
      const added = input.prompt !== text ? " · 첫 문장 '먼저 계획을 제시하고 승인받은 뒤 구현한다.' 자동 포함" : "";
      const target_label = `레포 ${name} (${input.repo}) · ${input.worktree.mode === "new" ? "새 워크트리" : "기존 워크트리"} ${input.worktree.name} · 모델 ${input.model}${added}`;
      const payload = { repo: input.repo, worktree: input.worktree, model: input.model, prompt: input.prompt, origin: "chat" };
      return { ...base, endpoint: "/api/sessions/create" as const, payload, target_label, text_optional: false, match: { source: "session", mode: "create", ref: sessionLogRef(input), text: input.prompt }, max_wait_ms: 8 * 60_000 };
    }
    case "session_send": {
      if (!text) return err(400, "텍스트가 비어 있어", kind);
      const id = s(t.session_id, 200);
      const sess = (known.state.sessions ?? []).find((x) => x.status !== "ended" && id && x.id === id);
      if (!sess) return err(409, "그 세션은 지금 열린 세션이 아니야 (session_id 가 state 에 없음)", kind);
      const name = sess.worktree || sess.cwd.split("/").pop() || sess.id.slice(0, 8);
      return send("session", "session", { session_id: sess.id, title: name }, `세션 · ${name}`);
    }
  }
}
