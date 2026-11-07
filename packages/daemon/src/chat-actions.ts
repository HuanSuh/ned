/**
 * Ned Net 대화창 쓰기 제안 (config.actions.chat_write). The chat model stays read-only: when the user wants something
 * written it ends its answer with ONE ```ned-action block (a proposal). The dashboard shows it as a 확인 카드 and, on
 * [실행], asks POST /api/chat/actions/validate to check it and build the request for an EXISTING endpoint
 * (/api/send, /api/calendar/events, /api/todos) — there is no chat-only execution path. Only the text is editable;
 * the target (channel, recipient, issue, PR, event, session) must be an item Ned already knows (agenda / state).
 */
import { RSVP_STATUSES, type ActionRef } from "./actions.js";
import type { Agenda } from "./agenda.js";
import { parseCalendarCreate } from "./calendar-create.js";
import type { NedActions, NedConfig } from "./config.js";
import type { NedState } from "./state.js";

export const CHAT_ACTION_KINDS = ["todo_add", "slack_send", "gmail_draft", "gmail_send", "jira_comment", "jira_transition", "github_review", "calendar_create", "calendar_rsvp", "session_send"] as const;
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
};

/** One line per kind for the prompt: what `target` holds and what `text` is. */
const KIND_SPEC: Record<ChatActionKind, string> = {
  todo_add: '`target`: {"due": "YYYY-MM-DD"(선택)} · `text`: 할 일 제목',
  slack_send: '`target`: {"url": "<맥락의 Slack 항목 url>"} · `text`: 보낼 메시지(그 메시지의 스레드에 답글)',
  gmail_draft: '`target`: {"url": "<맥락의 메일 url>"} · `text`: 답장 본문',
  gmail_send: '`target`: {"url": "<맥락의 메일 url>"} · `text`: 답장 본문',
  jira_comment: '`target`: {"url": "<맥락의 Jira 이슈 url>"} · `text`: 코멘트',
  jira_transition: '`target`: {"url": "<맥락의 Jira 이슈 url>"} · `text`: 옮길 상태 이름(예: "진행 중")',
  github_review: '`target`: {"url": "<맥락의 PR url>", "event": "comment"|"review_comment"|"approve"|"request_changes"} · `text`: 코멘트 본문(approve 는 비워도 됨)',
  calendar_create: '`target`: {"date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "all_day": false, "location": "", "attendees": ["메일 주소"], "meet": false} · `text`: 일정 제목',
  calendar_rsvp: '`target`: {"event_id": "<맥락의 event_id>", "response": "accepted"|"declined"|"tentative"} · `text`: 응답 코멘트(선택)',
  session_send: '`target`: {"session_id": "<맥락의 session_id>"} · `text`: 세션 터미널에 입력할 말',
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
    "- `target` 의 url·event_id·session_id 는 아래 \"Ned 가 아는 것\" 에 있는 값만 그대로 쓴다. 지어내거나 고치지 않는다. 맥락에 없는 대상이면 제안하지 말고 대시보드에서 하라고 안내한다.",
    "- JSON 은 유효해야 한다(따옴표·쉼표). 블록 밖 답변은 평소처럼 짧게 — 무엇을 제안했는지 한 줄. 블록은 한 답변에 하나만.",
    "- 사용자가 확인 없이 바로 하라고 해도 블록으로 제안만 한다.",
  ].join("\n");
}

// ---------- validate ----------

export interface ChatActionBlock {
  kind: ChatActionKind;
  target: Record<string, unknown>;
  text: string;
  summary: string;
}

export type ChatEndpoint = "/api/send" | "/api/calendar/events" | "/api/todos";

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
}
export interface ChatActionErr {
  ok: false;
  /** 400 malformed · 403 not allowed (switch off) · 409 target not among the known items. */
  status: 400 | 403 | 409;
  error: string;
  kind?: ChatActionKind;
}

const s = (v: unknown, n = 500) => (typeof v === "string" ? v.trim().slice(0, n) : typeof v === "number" ? String(v) : "");
const clip = (v: unknown, n: number) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const MAX_TEXT = 4000;
const err = (status: ChatActionErr["status"], error: string, kind?: ChatActionKind): ChatActionErr => ({ ok: false, status, error, ...(kind ? { kind } : {}) });

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
  const target = o.target && typeof o.target === "object" && !Array.isArray(o.target) ? (o.target as Record<string, unknown>) : {};
  const text = typeof o.text === "string" ? o.text.trim() : "";
  return { kind: o.kind, target, text, summary: clip(o.summary, 200) };
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
export function validateChatAction(cfg: Pick<NedConfig, "actions">, raw: unknown, known: KnownItems, textOverride?: unknown): ChatActionOk | ChatActionErr {
  const b = parseChatActionBlock(raw);
  if (typeof b === "string") return err(400, b);
  const kind = b.kind;
  if (cfg.actions.chat_write !== true) return err(403, "대화창 쓰기가 꺼져 있어 — 설정 → 쓰기 액션 → 대화창 → '대화창에서 쓰기 허용'(actions.chat_write)", kind);
  const g = CHAT_KIND_GATE[kind];
  if (g && cfg.actions[g] !== true) return err(403, `'${CHAT_KIND_KO[kind]}' 이 꺼져 있어 — 설정 → 쓰기 액션에서 actions.${g} 를 켜야 해`, kind);
  const text = typeof textOverride === "string" ? textOverride.trim() : b.text;
  if (text.length > MAX_TEXT) return err(400, `텍스트는 ${MAX_TEXT}자까지야 (지금 ${text.length}자)`, kind);
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
      const hit = findSlack(known, s(t.url, 1000));
      if (!hit) return err(409, "그 Slack 메시지는 Ned 가 아는 항목이 아니야 (대상 url 이 최근 agenda 에 없음)", kind);
      return send("slack", "send", { url: hit.url, title: hit.title }, `Slack · ${hit.title}`);
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
