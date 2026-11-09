/**
 * Reply-draft input shaping (pure, no I/O): a normalized transcript of the conversation, split at my last message into
 * [맥락] (before — reference only) and [답할 대상] (after — what the reply answers), plus the daemon-side correction of
 * the asks Pass 1 (prompts/draft-extract.md) found. drafts.ts feeds renderSegments() + the open asks to Pass 2
 * (prompts/draft-write.md), so the draft answers the questions asked since my last reply instead of re-summarizing the thread.
 */

/** One message of the conversation. `ts` = Slack ts ("1730860000.123456"), ISO, or "" when unknown. */
export interface TranscriptMsg {
  ts: string;
  from: string;
  mine: boolean;
  text: string;
  user_id?: string;
}

/** A transcript message as rendered: `reaction` = emoji / `+1` / `ㅋㅋ` … shown as `(짧은 반응)`. */
export interface SegMsg extends TranscriptMsg {
  reaction: boolean;
}

export interface Segments {
  /** Up to and including my last message — reference only. Oldest first, capped (DRAFT_CTX_MAX_MSGS / _CHARS). */
  context: SegMsg[];
  /** After my last message — what the reply answers. Everything when I never wrote. */
  target: SegMsg[];
  /** Context messages dropped by the caps (oldest first). */
  omitted: number;
  /** ts of my last message (from the transcript, or the thread's my_last_reply_ts when newer), "" = none. */
  my_last_ts: string;
}

export interface Participant {
  name: string;
  user_id?: string;
}

export type AskStatus = "open" | "answered";

/** One question / request addressed to me. `asked_in` = ts of the message(s) it was asked (or asked again) in. */
export interface DraftAsk {
  who: string;
  what: string;
  due: string;
  status: AskStatus;
  /** ts of my message that answered it ("" = unknown / open). */
  answered_in: string;
  asked_in: string[];
  /** Open, but only asked at/before my last reply (e.g. after "확인해 볼게요") — still to answer; the modal shows "이전". */
  before_reply?: boolean;
}

/**
 * One-pass `{{KEY}}` substitution: every placeholder is replaced from `vals` in a single scan, so untrusted text
 * inserted for one key (a message containing `{{ASKS}}`) is never expanded again. Unknown keys stay as they are.
 */
export function fillTemplate(tpl: string, vals: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m));
}

const oneLine = (v: string) => v.replace(/\s+/g, " ").trim();

/** [맥락] caps: the newest DRAFT_CTX_MAX_MSGS messages, then oldest dropped until the text fits DRAFT_CTX_MAX_CHARS. */
export const DRAFT_CTX_MAX_MSGS = 20;
export const DRAFT_CTX_MAX_CHARS = 4000;
/** Per-message text cap in the transcript (Pass 1 output / agenda excerpt). */
export const DRAFT_MSG_MAX_CHARS = 1500;
export const REACTION_LABEL = "(짧은 반응)";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Seconds since epoch for a Slack ts / ISO / ms-number string; NaN when unknown. */
export function tsSec(ts: string | undefined): number {
  const t = (ts ?? "").trim();
  if (!t) return NaN;
  if (/^\d{9,11}(\.\d+)?$/.test(t)) return Number(t);
  if (/^\d{12,14}$/.test(t)) return Number(t) / 1000;
  const p = Date.parse(t);
  return Number.isNaN(p) ? NaN : p / 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** `MM/DD HH:mm` in local time, or "" when the ts is unknown. */
export function fmtTs(ts: string | undefined): string {
  const s = tsSec(ts);
  if (!Number.isFinite(s)) return "";
  const d = new Date(s * 1000);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Emoji (pictographs, skin tones, ZWJ, variation selectors, keycaps, flags), Slack `:shortcode:`s, punctuation, spaces.
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣]/gu;
const SHORTCODE_RE = /:[a-z0-9_+'-]+:/gi;
const SHORT_WORD_RE = /^(\+1|ㅇ+|ㅇㅋ+|ㅋ+|ㅎ+|ㅠ+|ㅜ+|ㄱㄱ+|ㄳ+|ok|okay|lgtm)$/i;

/** Empty, emoji / reaction only, or `+1` / `ㅇㅇ` / `ㅋㅋ` / `ㅎㅎ` / `ok` … — nothing to answer. */
export function isReaction(text: string): boolean {
  const rest = str(text).replace(SHORTCODE_RE, "").replace(EMOJI_RE, "").replace(/[\s.,!~?…·^]+/g, "");
  if (!rest) return true;
  return SHORT_WORD_RE.test(rest);
}

/** Coerce raw transcript rows (Pass 1 JSON / agenda excerpt) into TranscriptMsg[], oldest first (stable for unknown ts). */
export function normalizeTranscript(raw: unknown): TranscriptMsg[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m, i) => {
      const from = oneLine(str(m.from)).slice(0, 80);
      const uid = str(m.user_id).trim();
      const msg: TranscriptMsg = {
        ts: str(m.ts).trim(),
        from: from || (m.mine === true ? "나" : uid || "?"),
        mine: m.mine === true || from === "나",
        text: str(m.text).replace(/\s+/g, " ").trim().slice(0, DRAFT_MSG_MAX_CHARS),
      };
      if (/^[UW][A-Z0-9]+$/.test(uid)) msg.user_id = uid;
      return { msg, i };
    });
  // Unknown ts sorts by position: treat it as "right after the previous known one".
  let last = -Infinity;
  const keyed = rows.map(({ msg, i }) => {
    const s = tsSec(msg.ts);
    if (Number.isFinite(s)) last = s;
    return { msg, i, k: Number.isFinite(s) ? s : last };
  });
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  return keyed.map((x) => x.msg);
}

const seg = (m: TranscriptMsg): SegMsg => ({ ...m, reaction: isReaction(m.text) });

/**
 * Split at my last message: before (inclusive) → `context`, after → `target`. `myLastTs` (the thread's
 * my_last_reply_ts, which may be older than the excerpt) moves the cut when it is newer than my last message in the
 * transcript. No message of mine at all → everything is `target`.
 */
export function segment(transcript: TranscriptMsg[], opts: { myLastTs?: string } = {}): Segments {
  const msgs = transcript;
  let cut = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].mine) { cut = i; break; }
  let myTs = cut >= 0 ? msgs[cut].ts : "";
  const extra = tsSec(opts.myLastTs);
  if (Number.isFinite(extra) && !(tsSec(myTs) >= extra)) {
    // The thread knows a later message of mine than the transcript shows: cut after the last message at/before it.
    let j = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (tsSec(msgs[i].ts) <= extra) { j = i; break; }
    if (j >= cut) myTs = opts.myLastTs ?? myTs;
    else {
      // My transcript message (ts unknown) sits after myLastTs: its time is at least the newest known ts up to it.
      const known = msgs.slice(0, cut + 1).map((m) => m.ts).filter((t) => Number.isFinite(tsSec(t)));
      const near = known.length ? known.reduce((a, b) => (tsSec(b) > tsSec(a) ? b : a)) : "";
      myTs = tsSec(near) > extra ? near : opts.myLastTs ?? myTs;
    }
    if (j > cut) cut = j;
  }
  const before = msgs.slice(0, cut + 1).map(seg);
  const target = msgs.slice(cut + 1).map(seg);
  // Caps: newest DRAFT_CTX_MAX_MSGS, then drop the oldest until the text fits.
  let context = before.slice(-DRAFT_CTX_MAX_MSGS);
  const len = (l: SegMsg[]) => l.reduce((n, m) => n + (m.reaction ? REACTION_LABEL.length : m.text.length) + m.from.length + 16, 0);
  while (context.length > 1 && len(context) > DRAFT_CTX_MAX_CHARS) context = context.slice(1);
  return { context, target, omitted: before.length - context.length, my_last_ts: myTs };
}

function line(m: SegMsg): string {
  const at = fmtTs(m.ts);
  const who = m.mine ? "나" : m.from || "?";
  return `${at ? `[${at}] ` : ""}${who}: ${m.reaction ? REACTION_LABEL : m.text}`;
}

/** Participant list line: `kim(<@U1>), lee` — me excluded. */
export function participantsLine(parts: Participant[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const name = str(p.name).trim();
    if (!name || name === "나" || seen.has(name)) continue;
    seen.add(name);
    out.push(p.user_id && /^[UW][A-Z0-9]+$/.test(p.user_id) ? `${name}(<@${p.user_id}>)` : name);
  }
  return out.join(", ");
}

/** Prompt text for Pass 2: participants, [맥락] (reference only), [답할 대상] (after my last reply). */
export function renderSegments(s: Segments, participants: Participant[] = []): string {
  const parts = participantsLine(participants);
  const since = s.my_last_ts ? `내 마지막 답글(${fmtTs(s.my_last_ts) || "시각 모름"}) 이후` : "내 답글 없음 — 대화 전체";
  const out = [`참여자: ${parts || "(모름)"}`, "", "### [맥락] — 참고만, 요약하지 않는다"];
  if (s.omitted > 0) out.push(`…앞 ${s.omitted}개 생략`);
  out.push(...(s.context.length ? s.context.map(line) : ["(없음)"]));
  out.push("", `### [답할 대상] — ${since}`);
  out.push(...(s.target.length ? s.target.map(line) : ["(새 메시지 없음)"]));
  return out.join("\n");
}

/** Normalize Pass 1 `asks`. */
export function normalizeAsks(raw: unknown): DraftAsk[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => {
      const asked = Array.isArray(a.asked_in) ? a.asked_in.map(str) : [str(a.asked_in)];
      return {
        who: oneLine(str(a.who)).slice(0, 80),
        what: oneLine(str(a.what)).slice(0, 300),
        due: oneLine(str(a.due)).slice(0, 60),
        status: (a.status === "answered" ? "answered" : "open") as AskStatus,
        answered_in: str(a.answered_in).trim(),
        asked_in: asked.map((t) => t.trim()).filter(Boolean),
      };
    })
    .filter((a) => a.what)
    .slice(0, 12);
}

/**
 * Daemon pass over Pass 1 asks (→ asks_final). The model's `status` is kept as is — Pass 1 is told to mark `answered`
 * only when my message actually answered it, and a holding reply ("확인해 볼게요") doesn't. An `open` ask asked only
 * in messages at/before my last reply (ts compared as numbers) gets `before_reply: true` — still answered by Pass 2,
 * shown as "이전" in the modal. Asked (again) after my last reply, or no usable ts → no flag. Missed questions are not invented.
 */
export function reconcileAsks(asks: DraftAsk[], s: Pick<Segments, "my_last_ts">): DraftAsk[] {
  const cut = tsSec(s.my_last_ts);
  return asks.map((a) => {
    const { before_reply: _b, ...rest } = a;
    if (a.status !== "open" || !Number.isFinite(cut)) return rest;
    const when = a.asked_in.map(tsSec).filter(Number.isFinite);
    return when.length && when.every((t) => t <= cut) ? { ...rest, before_reply: true } : rest;
  });
}

export const openAsks = (asks: DraftAsk[]) => asks.filter((a) => a.status === "open");

/** Numbered open asks for Pass 2 (`1. kim — 배포 일정 (마감: 금)`). */
export function renderAsks(asks: DraftAsk[]): string {
  const open = openAsks(asks);
  const done = asks.filter((a) => a.status === "answered");
  const out: string[] = [];
  out.push(open.length ? open.map((a, i) => `${i + 1}. ${a.who || "?"} — ${a.what}${a.due ? ` (마감: ${a.due})` : ""}${a.before_reply ? " [내 마지막 답글 이전 질문 — 아직 답 안 됨]" : ""}`).join("\n") : "(없음 — 답할 질문·요청이 없다)");
  if (done.length) out.push("", "이미 답한 것 (다시 답하지 않는다):", ...done.map((a) => `- ${a.who || "?"} — ${a.what}`));
  return out.join("\n");
}

/** Pass 1 output, normalized. `null` = unusable (→ legacy single-pass fallback). */
export interface Extracted {
  transcript: TranscriptMsg[];
  asks: DraftAsk[];
  participants: Participant[];
  reply_meta: { message_id?: string; reply_to?: string; subject?: string };
}

export function normalizeExtract(raw: unknown): Extracted | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.asks) && !Array.isArray(o.transcript)) return null;
  const participants: Participant[] = (Array.isArray(o.participants) ? o.participants : [])
    .map((p): Participant | null => {
      if (typeof p === "string") return p.trim() ? { name: p.trim().slice(0, 80) } : null;
      if (!p || typeof p !== "object") return null;
      const r = p as Record<string, unknown>;
      const name = oneLine(str(r.name)).slice(0, 80);
      const uid = str(r.user_id).trim();
      return name ? (/^[UW][A-Z0-9]+$/.test(uid) ? { name, user_id: uid } : { name }) : null;
    })
    .filter((p): p is Participant => !!p)
    .slice(0, 30);
  const rm = o.reply_meta && typeof o.reply_meta === "object" ? (o.reply_meta as Record<string, unknown>) : {};
  const meta: Extracted["reply_meta"] = {};
  for (const k of ["message_id", "reply_to", "subject"] as const) if (str(rm[k]).trim()) meta[k] = str(rm[k]).trim().slice(0, 300);
  return { transcript: normalizeTranscript(o.transcript), asks: normalizeAsks(o.asks), participants, reply_meta: meta };
}

/** Participants from the transcript (names + user ids), merged with Pass 1's list. */
export function mergeParticipants(t: TranscriptMsg[], extra: Participant[] = []): Participant[] {
  const by = new Map<string, Participant>();
  for (const p of [...extra, ...t.filter((m) => !m.mine).map((m) => ({ name: m.from, user_id: m.user_id }))]) {
    if (!p.name || p.name === "나") continue;
    const cur = by.get(p.name);
    if (!cur) by.set(p.name, p.user_id ? { name: p.name, user_id: p.user_id } : { name: p.name });
    else if (!cur.user_id && p.user_id) cur.user_id = p.user_id;
  }
  return [...by.values()];
}

/** A suggested mention: `id` = `<@U…>` (what goes into the text), `name` = the participant's name (the chip label). */
export interface DraftMention {
  id: string;
  name: string;
}

/**
 * Pass 2's `mentions`, kept only when they can help: Slack, ≥2 other participants, and each one a `<@U…>` of a known
 * participant (no invented ids). The caller decides which participant ids count as known (fast path: transcript only).
 */
export function filterMentions(raw: unknown, participants: Participant[], source: string): DraftMention[] {
  if (source !== "slack" || !Array.isArray(raw)) return [];
  if (participants.length < 2) return [];
  const byId = new Map(participants.filter((p) => p.user_id).map((p) => [p.user_id as string, p.name]));
  const out: DraftMention[] = [];
  for (const m of raw) {
    const id = str(m && typeof m === "object" ? (m as Record<string, unknown>).id : m).match(/^<@([UW][A-Z0-9]+)>$/)?.[1];
    if (id && byId.has(id) && !out.some((x) => x.id === `<@${id}>`)) out.push({ id: `<@${id}>`, name: byId.get(id) ?? "" });
  }
  return out.slice(0, 3);
}

/** Pass 2's `covers` for one draft: ask numbers 1..n, unique, ascending. */
export function normalizeCovers(raw: unknown, n: number): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => Math.trunc(Number(x))).filter((x) => x >= 1 && x <= n))].sort((a, b) => a - b);
}
