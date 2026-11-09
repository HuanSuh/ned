import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrigin, type ActionOrigin } from "./origin.js";
import { readAgenda, type Agenda, type MailContext, type SlackContext } from "./agenda.js";
import { extractJson, llmDisabled, runClaude, type ClaudeRunResult } from "./claude.js";
import {
  filterMentions,
  mergeParticipants,
  normalizeCovers,
  normalizeExtract,
  normalizeTranscript,
  openAsks,
  reconcileAsks,
  renderAsks,
  renderSegments,
  segment,
  type AskStatus,
  type DraftAsk,
  type Participant,
  type Segments,
  type TranscriptMsg,
} from "./draft-thread.js";
import { normalizeReplyTone, type NedConfig, type ReplyToneSource } from "./config.js";
import { readRecentEvents, type NedEvent } from "./events.js";
import { NED_HOME, log, readJson, writeJsonAtomic } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(here, "../../../prompts");

/** ~/.ned/drafts/<id>.json — one cached draft set per (source, ref key). */
export const DRAFTS_DIR = path.join(NED_HOME, "drafts");
const CACHE_MS = 60 * 60_000;

export type DraftSource = "slack" | "email" | "session" | "jira" | "github";
export const DRAFT_SOURCES: DraftSource[] = ["slack", "email", "session", "jira", "github"];
export const DRAFT_LABELS = ["짧게", "보통", "정중하게"] as const;
export type DraftLabel = (typeof DRAFT_LABELS)[number];

export interface DraftRef {
  url?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  thread_id?: string;
  message_id?: string;
  session_id?: string;
  title?: string;
  text?: string;
  /** jira: issue key (`ABC-123`); the site comes from `url` (`https://<site>.atlassian.net/browse/ABC-123`). */
  key?: string;
  /** github: `owner/name` + PR number (string), or a PR `url`. */
  repo?: string;
  number?: string;
}

export const REF_FIELDS = ["url", "channel", "ts", "thread_ts", "thread_id", "message_id", "session_id", "title", "text", "key", "repo", "number"] as const;

export interface DraftRequest {
  source: DraftSource;
  ref: DraftRef;
  hint?: string;
  tone?: string;
  /** Skip the 1h cache. */
  force?: boolean;
  /** Which dashboard list asked (card / history / watch, chat) — logged only; the send carries it into the action log. */
  origin?: ActionOrigin;
}

/** What a later POST /api/send needs to address the reply without re-reading anything. */
export interface DraftMeta {
  /** slack */
  channel_id?: string;
  thread_ts?: string;
  /** email */
  thread_id?: string;
  message_id?: string;
  reply_to?: string;
  subject?: string;
  /** session */
  session_id?: string;
  /** jira: issue key + cloudId (site host, e.g. `acme.atlassian.net`) */
  issue_key?: string;
  cloud_id?: string;
  /** github */
  repo?: string;
  number?: string;
  /** How the drafts were made: `2pass` (extract asks → answer them, Slack / 메일 / Jira) or `legacy` (one prompt, prompts/draft.md). Absent in older cache files. */
  mode?: DraftPipeline;
}

/** `fast` = no-tool run on context Ned already has (agenda excerpt / local transcript); `full` = claude reads the thread with tools. */
export type DraftMode = "fast" | "full";
/** `2pass` = Pass 1 extract (prompts/draft-extract.md) + Pass 2 write (prompts/draft-write.md); `legacy` = prompts/draft.md alone. */
export type DraftPipeline = "2pass" | "legacy";
/** Sources drafted with the 2-pass pipeline; session / github stay single-pass. */
export const TWO_PASS_SOURCES: ReadonlySet<DraftSource> = new Set<DraftSource>(["slack", "email", "jira"]);

/** One question / request to answer, as the modal lists it ("답할 것"). Open ones are numbered in order (Pass 2's `covers`). */
export interface DraftAskView {
  who: string;
  what: string;
  due: string;
  status: AskStatus;
  answered_in: string;
}

export interface DraftResult {
  id: string;
  source: DraftSource;
  mode: DraftMode;
  /** Age of the agenda-collected context the fast path used (0 for sessions: read live); null on the full path. */
  context_age_minutes: number | null;
  context: { summary: string; excerpt: string };
  /** `covers` (2-pass): the open-ask numbers (1-based) this draft answers. */
  drafts: { id: string; label: DraftLabel; text: string; covers?: number[] }[];
  /** 2-pass: asks after the daemon's correction (asks_final); [] for legacy and older cache files. */
  asks: DraftAskView[];
  /** 2-pass Slack: suggested `<@U…>` mentions (≥2 participants, a specific `who`); the modal's toggle prepends them. */
  mentions: string[];
  cost_usd: number;
  cached: boolean;
  created_at: number;
  hint: string;
  tone: string;
  meta: DraftMeta;
}

export class DraftError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502,
  ) {
    super(message);
  }
}

const str = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Coerce a request body into a DraftRequest, or throw DraftError(400). */
export function parseDraftRequest(body: Record<string, unknown>): DraftRequest {
  const source = body.source as DraftSource;
  if (!DRAFT_SOURCES.includes(source)) throw new DraftError(`source must be ${DRAFT_SOURCES.join(" | ")}`, 400);
  const r = (body.ref && typeof body.ref === "object" ? body.ref : {}) as Record<string, unknown>;
  const ref: DraftRef = {};
  for (const k of REF_FIELDS) {
    const v = str(typeof r[k] === "number" ? String(r[k]) : r[k], k === "text" ? 2000 : 500);
    if (v) ref[k] = v;
  }
  const origin = parseOrigin(body.origin);
  return { source, ref, hint: str(body.hint, 500), tone: str(body.tone, 200), force: body.force === true, ...(origin ? { origin } : {}) };
}

/** Slack permalink → channel / ts / thread_ts. `p1700000000123456` → `1700000000.123456`. */
export function parseSlackUrl(url: string | undefined): { channel?: string; ts?: string; thread_ts?: string } {
  if (!url) return {};
  const m = url.match(/\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/);
  if (!m) return {};
  const out: { channel?: string; ts?: string; thread_ts?: string } = { channel: m[1] };
  if (m[2]) out.ts = `${m[2]}.${m[3]}`;
  const tt = url.match(/[?&]thread_ts=(\d+\.\d+)/);
  if (tt) out.thread_ts = tt[1];
  return out;
}

/** Slack addressing: explicit ref fields win over what the permalink says. */
export function slackTarget(ref: DraftRef): { channel_id?: string; ts?: string; thread_ts?: string } {
  const u = parseSlackUrl(ref.url);
  return { channel_id: ref.channel && /^[A-Z0-9]+$/.test(ref.channel) ? ref.channel : u.channel, ts: ref.ts ?? u.ts, thread_ts: ref.thread_ts ?? u.thread_ts };
}

/** Jira addressing: issue key (ref.key, else the `/browse/KEY` in the URL) + cloudId = the site host from the URL. */
export function jiraTarget(ref: DraftRef): { key?: string; cloud_id?: string } {
  const m = (ref.url ?? "").match(/^https:\/\/([a-z0-9-]+\.atlassian\.net)\/browse\/([A-Z][A-Z0-9_]*-\d+)/i);
  const key = ref.key && /^[A-Z][A-Z0-9_]*-\d+$/i.test(ref.key) ? ref.key.toUpperCase() : m?.[2]?.toUpperCase();
  return { key, cloud_id: m?.[1]?.toLowerCase() };
}

/** GitHub PR addressing: ref.repo + ref.number, else parsed from `https://github.com/<owner>/<repo>/pull/<n>`. */
export function githubTarget(ref: DraftRef): { repo?: string; number?: string } {
  const m = (ref.url ?? "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  const repo = ref.repo && /^[\w.-]+\/[\w.-]+$/.test(ref.repo) ? ref.repo : m?.[1];
  const number = ref.number && /^\d+$/.test(ref.number) ? ref.number : m?.[2];
  return { repo, number };
}

/** Read-only PR context for a review draft: `gh pr view --json` (title/body/files ±) + the head of `gh pr diff`. */
export function githubContext(repo: string, number: string): Promise<string> {
  const gh = (args: string[]) =>
    new Promise<string>((resolve) => execFile("gh", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, se) => resolve(err ? `(gh ${args.slice(0, 2).join(" ")} 실패: ${(se || err.message).slice(0, 200)})` : out)));
  return Promise.all([
    gh(["pr", "view", number, "--repo", repo, "--json", "title,body,author,state,baseRefName,headRefName,additions,deletions,changedFiles,files,reviewDecision"]),
    gh(["pr", "diff", number, "--repo", repo]),
  ]).then(([view, diff]) => {
    let head = view.slice(0, 3000);
    try {
      const j = JSON.parse(view) as { title: string; body: string; author?: { login: string }; state: string; baseRefName: string; headRefName: string; additions: number; deletions: number; changedFiles: number; reviewDecision: string; files?: { path: string; additions: number; deletions: number }[] };
      const stat = (j.files ?? []).slice(0, 40).map((f) => ` ${f.path} | +${f.additions} -${f.deletions}`);
      head = [
        `PR: ${repo}#${number} — ${j.title}`,
        `작성자: @${j.author?.login ?? "?"} · ${j.headRefName} → ${j.baseRefName} · ${j.state} · reviewDecision=${j.reviewDecision || "-"}`,
        `변경 (diff --stat): ${j.changedFiles} files, +${j.additions} -${j.deletions}`,
        ...stat,
        (j.files?.length ?? 0) > 40 ? ` … 외 ${(j.files?.length ?? 0) - 40}개` : "",
        "설명:",
        (j.body || "(없음)").slice(0, 2500),
      ].filter(Boolean).join("\n");
    } catch {
      /* gh failed: keep its message */
    }
    const d = diff.length > 6000 ? diff.slice(0, 6000) + "\n… (diff 잘림)" : diff;
    return `${head}\n\ndiff (앞부분):\n${d}`;
  });
}

/** Latest hook events of one session (any of the last 7 days), oldest first. */
export function sessionEvents(sessionId: string): NedEvent[] {
  return readRecentEvents(7).filter((e) => e.session_id === sessionId);
}

/** Readable tail of a Claude Code transcript: the last ~maxMsgs user/assistant texts, capped at maxChars. */
export function transcriptTail(transcriptPath: string | undefined, maxMsgs = 12, maxChars = 6000): string | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    const size = Math.min(stat.size, 512 * 1024);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(transcriptPath, "r");
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const msgs: string[] = [];
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      if (msgs.length >= maxMsgs) break;
      if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
      try {
        const rec = JSON.parse(line);
        const role = rec?.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = rec.message.content;
        const text = (typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ") : "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text || text.startsWith("<")) continue; // tool results / system reminders
        msgs.push(`[${role === "user" ? "나" : "에이전트"}] ${text.slice(0, 1200)}`);
      } catch {
        /* partial line */
      }
    }
    const out = msgs.reverse().join("\n");
    return out.length > maxChars ? "…" + out.slice(out.length - maxChars) : out;
  } catch {
    return null;
  }
}

/**
 * Stable cache key for a (source, ref). Sessions also key on their latest event so a moved-on session redrafts.
 * Slack: thread_ts defaults to the message's own ts outside DMs — the send does the same (a reply goes into that
 * thread) — so a 팔로업 ✎ (thread_ts = ts spelled out) and a card / 이력 ✎ (none) share one draft id: same 1h cache,
 * same pregenerated draft, same 10-min already-sent guard.
 */
export function refKey(source: DraftSource, ref: DraftRef): string {
  if (source === "slack") {
    const t = slackTarget(ref);
    const thread = t.thread_ts ?? (t.channel_id?.startsWith("D") ? undefined : t.ts);
    return `slack:${t.channel_id ?? ""}:${thread ?? ""}:${t.ts ?? ""}:${t.channel_id ? "" : ref.url ?? ref.text ?? ""}`;
  }
  if (source === "email") return `email:${ref.thread_id ?? ""}:${ref.message_id ?? ""}:${ref.thread_id || ref.message_id ? "" : ref.url ?? ref.text ?? ""}`;
  if (source === "jira") return `jira:${jiraTarget(ref).key ?? ""}`;
  if (source === "github") { const g = githubTarget(ref); return `github:${g.repo ?? ""}#${g.number ?? ""}`; }
  const evs = ref.session_id ? sessionEvents(ref.session_id) : [];
  return `session:${ref.session_id ?? ""}:${evs.length ? evs[evs.length - 1].ts : 0}`;
}

export const draftIdOf = (key: string) => crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
const draftFile = (id: string) => path.join(DRAFTS_DIR, `${id}.json`);

/** A cached draft set by its id (or a draft item id `<id>-<n>`), regardless of age. */
export function readDraft(idOrDraftId: string): DraftResult | null {
  const id = idOrDraftId.split("-")[0];
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  return readJson<DraftResult | null>(draftFile(id), null);
}

/** Read-only tools for each source. Connector tools are deferred, so ToolSearch must be allowed to load them. */
export function draftTools(source: DraftSource): string[] {
  if (source === "slack") return ["ToolSearch", "mcp__claude_ai_Slack__slack_read_thread", "mcp__claude_ai_Slack__slack_read_channel"];
  if (source === "email") return ["ToolSearch", "mcp__claude_ai_Gmail__get_thread", "mcp__claude_ai_Gmail__search_threads"];
  // atlassianUserInfo: who "I" am, so Pass 1 can mark my comments (read-only).
  if (source === "jira") return ["ToolSearch", "mcp__claude_ai_Atlassian__getJiraIssue", "mcp__claude_ai_Atlassian__atlassianUserInfo"];
  return []; // session / github: context is inlined (transcript tail / gh read-only output)
}

/** Agenda-collected context for a Slack / mail ref, with its age in minutes. */
export type AgendaCtx = { kind: "slack"; ctx: SlackContext; age: number } | { kind: "email"; ctx: MailContext; age: number };

/** Find the agenda item this ref points at (Slack: same channel + ts or permalink; mail: same thread id) and return its context. */
export function agendaContext(req: Pick<DraftRequest, "source" | "ref">, agenda: Agenda = readAgenda(), now = Date.now()): AgendaCtx | null {
  const age = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (req.source === "slack" && agenda.slack) {
    const t = slackTarget(req.ref);
    const watched = (agenda.slack.watch ?? []).flatMap((w) => w.highlights.map((h) => ({ url: h.url, context: h.context })));
    const hit = [...agenda.slack.items, ...agenda.slack.all, ...watched].find((x) => {
      if (!x.context) return false;
      if (req.ref.url && x.url === req.ref.url) return true;
      const u = parseSlackUrl(x.url);
      if (!!t.channel_id && !!t.ts && u.channel === t.channel_id && u.ts === t.ts) return true;
      // Same thread (ref.thread_ts from the followed thread): its rows carry the latest thread excerpt.
      return !!t.channel_id && !!t.thread_ts && u.channel === t.channel_id && (u.thread_ts ?? u.ts) === t.thread_ts;
    });
    return hit?.context && !Number.isNaN(Date.parse(hit.context.collected_at)) ? { kind: "slack", ctx: hit.context, age: age(hit.context.collected_at) } : null;
  }
  if (req.source === "email" && agenda.mail && req.ref.thread_id) {
    const hit = agenda.mail.items.find((x) => x.context && x.id === req.ref.thread_id);
    return hit?.context && !Number.isNaN(Date.parse(hit.context.collected_at)) ? { kind: "email", ctx: hit.context, age: age(hit.context.collected_at) } : null;
  }
  return null;
}

/** Fresh enough agenda context for the fast path, else null (→ full tool path). */
export function fastContext(req: Pick<DraftRequest, "source" | "ref">, cfg: NedConfig): AgendaCtx | null {
  if (req.source === "session") return null;
  const c = agendaContext(req);
  return c && c.age <= cfg.draft_context_max_age_minutes ? c : null;
}

/**
 * Slack full path: a collected excerpt older than this (or none at all) can't be trusted for an old / long thread,
 * so the prompt makes the model read the whole thread first (CONTEXT_RULE). Younger excerpts keep today's prompt.
 */
export const DRAFT_CTX_FRESH_HOURS = 6;
const THREAD_READ_LIMIT = 50;

/**
 * The forced "read the thread first" rule for a Slack full-path draft, or "" (fast path, other sources, fresh excerpt).
 * `ctx` = the agenda excerpt for the ref (agendaContext), null when there is none.
 */
export function contextRule(req: Pick<DraftRequest, "source" | "ref">, fast: AgendaCtx | null, ctx: AgendaCtx | null): string {
  if (fast || req.source !== "slack") return "";
  if (ctx && ctx.age <= DRAFT_CTX_FRESH_HOURS * 60) return "";
  const t = slackTarget(req.ref);
  if (!t.channel_id) return "";
  const why = ctx ? `수집된 발췌가 ${Math.floor(ctx.age / 60)}시간 전 것이라 낡았다` : "수집된 발췌가 없다";
  const parent = t.thread_ts ?? t.ts;
  const read = t.channel_id.startsWith("D") && !t.thread_ts
    ? `\`mcp__claude_ai_Slack__slack_read_channel\` 로 channel_id=\`${t.channel_id}\`, limit=${THREAD_READ_LIMIT} (DM 대화)`
    : parent
      ? `\`mcp__claude_ai_Slack__slack_read_thread\` 로 channel_id=\`${t.channel_id}\`, message_ts=\`${parent}\`, limit=${THREAD_READ_LIMIT} (스레드 전체)`
      : `\`mcp__claude_ai_Slack__slack_read_channel\` 로 channel_id=\`${t.channel_id}\`, limit=${THREAD_READ_LIMIT}`;
  return `\n- **먼저 맥락을 읽는다** (${why}): 초안을 쓰기 전에 ${read} 를 읽고, 그 맥락으로 쓴다. 미리보기만 보고 쓰지 않는다. 오래된 대화면 그 뒤에 결론이 났는지도 확인한다.`;
}

function formatContext(c: AgendaCtx): string {
  if (c.kind === "slack") {
    return [
      `참여자: ${c.ctx.participants.join(", ") || "(모름)"}`,
      "대화 (오래된 순, 마지막이 답할 대상 근처):",
      ...c.ctx.messages.map((m) => `- [${m.ts}] ${m.from}: ${m.text}`),
    ].join("\n");
  }
  return [
    `보낸 사람: ${c.ctx.from}`,
    c.ctx.to && `받는 사람: ${c.ctx.to}`,
    `제목: ${c.ctx.subject}`,
    c.ctx.attachments.length ? `첨부: ${c.ctx.attachments.join(", ")}` : "",
    "본문 (인용 제거):",
    c.ctx.body_excerpt,
  ]
    .filter(Boolean)
    .join("\n");
}

function sourceGuide(req: DraftRequest, fast: AgendaCtx | null = null, prefetched?: string): { guide: string; ref: string; context: string; meta: DraftMeta } {
  const { ref } = req;
  if (fast) {
    const preview = [ref.title && `제목: ${ref.title}`, ref.text && `미리보기: ${ref.text}`].filter(Boolean).join("\n");
    const context = `${formatContext(fast)}${preview ? `\n\n(목록 미리보기)\n${preview}` : ""}`;
    if (fast.kind === "slack") {
      const t = slackTarget(ref);
      const guide = [
        "Slack 메시지에 대한 답장. 도구는 없다 — 아래 수집된 대화만 보고 쓴다.",
        "- 답할 대상은 대화의 마지막 질문·요청이다 (`나` 가 이미 답한 부분은 반복하지 않는다).",
        "- `reply_meta` 는 빈 문자열로 둔다.",
      ].join("\n");
      return { guide, ref: JSON.stringify({ url: ref.url, ...t }), context, meta: { channel_id: t.channel_id, thread_ts: t.thread_ts ?? (t.channel_id?.startsWith("D") ? undefined : t.ts) } };
    }
    const guide = [
      "Gmail 메일에 대한 회신. 도구는 없다 — 아래 수집된 메일만 보고 쓴다.",
      "- 답할 대상은 아래 메일(스레드의 마지막 다른 사람 메시지)이다. `reply_meta` 는 빈 문자열로 둔다 (Ned 가 채운다).",
      "- 메일 초안은 인사(\"안녕하세요, ○○님.\")로 시작해도 되지만 서명은 넣지 않는다.",
    ].join("\n");
    const subject = fast.ctx.subject ? (/^re:/i.test(fast.ctx.subject) ? fast.ctx.subject : `Re: ${fast.ctx.subject}`) : undefined;
    return {
      guide,
      ref: JSON.stringify({ url: ref.url, thread_id: ref.thread_id }),
      context,
      meta: { thread_id: ref.thread_id, message_id: ref.message_id ?? fast.ctx.message_id, reply_to: fast.ctx.reply_to, subject },
    };
  }
  const preview = [ref.title && `제목: ${ref.title}`, ref.text && `미리보기: ${ref.text}`].filter(Boolean).join("\n") || "(없음)";
  if (req.source === "slack") {
    const t = slackTarget(ref);
    // A DM message with no thread: the conversation is the channel itself (same choice as contextRule).
    const dm = !!t.channel_id?.startsWith("D") && !t.thread_ts;
    const parent = dm ? undefined : t.thread_ts ?? t.ts;
    const guide = [
      "Slack 메시지에 대한 답장.",
      parent && t.channel_id
        ? `- \`mcp__claude_ai_Slack__slack_read_thread\` 로 channel_id=\`${t.channel_id}\`, message_ts=\`${parent}\` 스레드를 읽는다 (response_format: concise).`
        : t.channel_id
          ? `- \`mcp__claude_ai_Slack__slack_read_channel\` 로 channel_id=\`${t.channel_id}\` 최근 메시지 ${dm ? THREAD_READ_LIMIT : 20}개만 읽고 답할 메시지를 찾는다.`
          : "- 채널 정보가 없다. 도구를 쓰지 말고 미리보기만으로 쓴다.",
      "- 답할 대상은 스레드의 마지막 질문·요청이다 (내가 이미 답한 부분은 반복하지 않는다).",
      "- `reply_meta` 는 빈 문자열로 둔다.",
    ].join("\n");
    return { guide, ref: JSON.stringify({ url: ref.url, ...t }), context: preview, meta: { channel_id: t.channel_id, thread_ts: t.thread_ts ?? (t.channel_id?.startsWith("D") ? undefined : t.ts) } };
  }
  if (req.source === "email") {
    const guide = [
      "Gmail 메일에 대한 회신.",
      ref.thread_id
        ? `- \`mcp__claude_ai_Gmail__get_thread\` 로 threadId=\`${ref.thread_id}\` 를 messageFormat=PLAIN_TEXT 로 읽는다.`
        : "- thread id 가 없다. 제목·미리보기로 `mcp__claude_ai_Gmail__search_threads` 를 1회만 써서 스레드를 찾고, 찾으면 `get_thread`(PLAIN_TEXT)로 읽는다.",
      "- 답할 대상은 스레드의 마지막 **다른 사람이 보낸** 메시지다. `reply_meta.message_id` 에 그 메시지 id, `reply_to` 에 그 발신자 주소, `subject` 에 `Re: <원제목>` 을 넣는다.",
      "- 메일 초안은 인사(\"안녕하세요, ○○님.\")로 시작해도 되지만 서명은 넣지 않는다.",
    ].join("\n");
    return { guide, ref: JSON.stringify({ url: ref.url, thread_id: ref.thread_id, message_id: ref.message_id }), context: preview, meta: { thread_id: ref.thread_id, message_id: ref.message_id } };
  }
  if (req.source === "jira") {
    const t = jiraTarget(ref);
    const guide = [
      "Jira 이슈에 사용자가 남길 **코멘트** 초안.",
      `- \`mcp__claude_ai_Atlassian__getJiraIssue\` 로 cloudId=\`${t.cloud_id ?? "(URL 없음)"}\`, issueIdOrKey=\`${t.key}\`, fields=["summary","description","status","assignee","reporter","comment"], responseContentFormat="markdown" 로 1회 읽는다.`,
      "- 최근 코멘트에서 사용자에게 온 질문·요청이 있으면 그에 대한 답을, 없으면 진행 상황 공유(무엇을 했고 다음에 무엇을 할지)를 쓴다.",
      "- 코멘트는 평문. 다른 사람 언급이 필요하면 이름만 쓴다(멘션 문법 금지). `reply_meta` 는 빈 문자열로 둔다.",
    ].join("\n");
    return { guide, ref: JSON.stringify({ url: ref.url, ...t }), context: preview, meta: { issue_key: t.key, cloud_id: t.cloud_id } };
  }
  if (req.source === "github") {
    const g = githubTarget(ref);
    const guide = [
      "GitHub Pull Request 에 사용자가 남길 **리뷰 코멘트** 초안 (승인/변경 요청 여부는 사용자가 따로 고른다).",
      "- 도구는 없다. 아래 PR 설명과 변경 파일 목록(diff --stat), diff 앞부분만 보고 쓴다. 보지 못한 코드에 대해 단정하지 않는다.",
      "- 구체적으로: 확인한 점, 질문, 개선 제안을 파일명과 함께 짧게. `짧게` 는 한 줄 총평, `정중하게` 는 감사 + 항목별 코멘트.",
      "- GitHub 마크다운의 `코드` 표기와 목록(-)은 써도 된다. `reply_meta` 는 빈 문자열로 둔다.",
    ].join("\n");
    return { guide, ref: JSON.stringify({ url: ref.url, ...g }), context: `${prefetched ?? "(PR 정보를 못 읽음)"}\n\n(목록 미리보기)\n${preview}`, meta: { repo: g.repo, number: g.number } };
  }
  // session: no tools — the transcript tail is inlined.
  const evs = ref.session_id ? sessionEvents(ref.session_id) : [];
  const transcript = [...evs].reverse().find((e) => e.transcript_path)?.transcript_path;
  const last = [...evs].reverse().find((e) => e.event === "Notification" || e.event === "StopFailure" || e.event === "Stop");
  const tail = transcriptTail(transcript);
  const cwd = [...evs].reverse().find((e) => e.cwd)?.cwd;
  const guide = [
    "Claude Code 에이전트 세션에 사용자가 터미널로 입력할 다음 지시(답장).",
    "- 도구는 없다. 아래 대화 기록만 보고 쓴다.",
    "- 에이전트가 질문·허락·선택을 기다리면 그에 대한 답을, 작업을 끝냈으면 다음 지시(검증, 커밋, 다음 단계)를 쓴다.",
    "- 초안은 에이전트에게 주는 지시문이다: 존댓말 불필요, 짧고 명확하게. `정중하게` 는 맥락·이유를 덧붙인 버전으로 쓴다.",
    "- `reply_meta` 는 빈 문자열로 둔다.",
  ].join("\n");
  const context = [
    cwd && `작업 폴더: ${cwd}`,
    last && `마지막 이벤트: ${last.event}${last.message ? ` — ${String(last.message).slice(0, 300)}` : ""}`,
    tail ? `대화 기록(최근):\n${tail}` : `대화 기록 없음. ${preview}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { guide, ref: JSON.stringify({ session_id: ref.session_id }), context, meta: { session_id: ref.session_id } };
}

const TOOL_RULES = [
  "- 커넥터 도구는 지연 로드된다. 필요한 도구는 먼저 `ToolSearch` 로 `select:<도구명>` 해서 로드한 뒤 쓴다.",
  '- 조회는 2~3회 안에 끝낸다. 원문을 못 읽으면 아래 "참고 미리보기"만으로 쓰고, `summary` 에 그 사실을 짧게 적는다.',
].join("\n");
const NO_TOOL_RULES = "- 도구는 없다. 아래 맥락만으로 **한 번에** JSON 을 출력한다. 맥락이 모자라면 `[확인 필요: …]` 를 남긴다.";
// Output tokens dominate fast-path latency (~100 tok/s): Ned fills excerpt / reply_meta from the agenda context itself.
const FAST_OUTPUT_RULE = '- 출력에서 `excerpt` 는 `""`, `reply_meta` 는 `{}` 로 둔다 (Ned 가 채운다). JSON 은 공백·줄바꿈 없이 한 줄로.';

/** The message the reply answers, from agenda context (fast path; the model is told not to repeat it). */
function contextExcerpt(fast: AgendaCtx): string {
  if (fast.kind === "email") return fast.ctx.body_excerpt.slice(0, 300);
  const msgs = fast.ctx.messages;
  return ([...msgs].reverse().find((m) => m.from !== "나") ?? msgs[msgs.length - 1])?.text ?? "";
}

/**
 * The voice for this draft: an explicit request tone wins, else the per-source setting
 * (config.reply_tone_by_source — slack / email / session), else the 기본 말투 (config.reply_tone).
 */
export function draftTone(req: Pick<DraftRequest, "source" | "tone">, cfg: Pick<NedConfig, "reply_tone" | "reply_tone_by_source">): string {
  const per = cfg.reply_tone_by_source?.[req.source as ReplyToneSource];
  return normalizeReplyTone(req.tone, normalizeReplyTone(per, normalizeReplyTone(cfg.reply_tone)));
}

/**
 * `fast` (or a session) → no-tool prompt built from context Ned already has. `ctx` = the agenda excerpt for the ref
 * (default: looked up; only Slack full-path drafts use it — no / stale excerpt → CONTEXT_RULE makes the model read the thread).
 */
export function buildDraftPrompt(req: DraftRequest, cfg: NedConfig, fast: AgendaCtx | null = null, prefetched?: string, ctx?: AgendaCtx | null): { prompt: string; meta: DraftMeta } {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "draft.md"), "utf8");
  const s = sourceGuide(req, fast, prefetched);
  const rule = !fast && req.source === "slack" ? contextRule(req, fast, ctx === undefined ? agendaContext(req) : ctx) : "";
  const tone = draftTone(req, cfg);
  const prompt = template
    .replace("{{NOW}}", () => new Date().toLocaleString("ko-KR"))
    .replace("{{TOOL_RULES}}", () => (fast ? `${NO_TOOL_RULES}\n${FAST_OUTPUT_RULE}` : req.source === "session" || req.source === "github" ? NO_TOOL_RULES : TOOL_RULES))
    .replace("{{CONTEXT_RULE}}", () => rule)
    .replace("{{TONE}}", () => tone)
    .replace("{{HINT}}", () => req.hint ?? "(없음)")
    .replace("{{SOURCE_GUIDE}}", () => s.guide)
    .replace("{{REF}}", () => s.ref)
    .replace("{{CONTEXT}}", () => s.context);
  return { prompt, meta: s.meta };
}

interface LlmDraft {
  summary?: string;
  excerpt?: string;
  reply_meta?: { message_id?: string; reply_to?: string; subject?: string };
  drafts?: { label?: string; text?: string }[];
}

/** The model's drafts → the 3 labelled drafts; `asks` = open-ask count (2-pass: keep each draft's `covers`). */
function normalizeDrafts(id: string, raw: LlmDraft["drafts"], asks?: number): DraftResult["drafts"] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DraftResult["drafts"] = [];
  DRAFT_LABELS.forEach((label, i) => {
    const d = list.find((x) => x?.label === label) ?? list[i];
    const text = typeof d?.text === "string" ? d.text.trim() : "";
    if (text) out.push(asks === undefined ? { id: `${id}-${i}`, label, text } : { id: `${id}-${i}`, label, text, covers: normalizeCovers((d as { covers?: unknown }).covers, asks) });
  });
  return out;
}

// ---------- 2-pass: Pass 1 extract (transcript + asks) → daemon segment / correction → Pass 2 write ----------

/** The conversation Ned already has for a fast-path ref (agenda excerpt), and my last reply ts when the thread read knew it. */
export function fastTranscript(fast: AgendaCtx): { transcript: TranscriptMsg[]; myLastTs?: string } {
  if (fast.kind === "slack") {
    const transcript = normalizeTranscript(fast.ctx.messages.map((m) => ({ ts: m.ts, from: m.from, mine: m.from === "나", text: m.text })));
    return fast.ctx.my_last_ts ? { transcript, myLastTs: fast.ctx.my_last_ts } : { transcript };
  }
  return { transcript: normalizeTranscript([{ ts: "", from: fast.ctx.from || "?", mine: false, text: fast.ctx.body_excerpt }]) };
}

/**
 * Pass 1 tools = the draft read tools (Jira includes atlassianUserInfo). Slack's "who am I" comes from loading the
 * search tool's schema through ToolSearch (its description names my user_id) — that tool is not allowed, so it never runs.
 */
export function extractTools(source: DraftSource): string[] {
  return draftTools(source);
}

const EXTRACT_FULL_TRANSCRIPT = "읽은 대화의 메시지를 **오래된 순으로 모두**(최대 40개, 넘으면 최근 40개) 옮긴다. `text` 는 원문 그대로 최대 500자(요약·번역 금지), 내 메시지는 `from` `나` + `mine: true`.";

/** Pass 1 source guide (what to read, who "I" am, how to fill transcript) for the 2-pass sources. */
function extractGuide(req: DraftRequest, fast: AgendaCtx | null): { guide: string; ref: string; context: string; me: string; transcript: string; extra: string; meta: DraftMeta } {
  const base = sourceGuide(req, fast);
  const { ref } = req;
  const preview = [ref.title && `제목: ${ref.title}`, ref.text && `미리보기: ${ref.text}`].filter(Boolean).join("\n");
  if (fast) {
    const { transcript, myLastTs } = fastTranscript(fast);
    const lines = fast.kind === "slack"
      ? [
          `참여자: ${fast.ctx.participants.join(", ") || "(모름)"}`,
          myLastTs ? `내 마지막 메시지 ts: ${myLastTs} (아래 발췌보다 앞일 수 있다 — 그 이전 질문은 이미 답한 것으로 본다)` : "",
          "대화 (오래된 순, `ts | 보낸 사람 | 원문`):",
          ...transcript.map((m) => `- ${m.ts || "?"} | ${m.from} | ${m.text}`),
        ]
      : [`보낸 사람: ${fast.ctx.from}`, `제목: ${fast.ctx.subject}`, "본문 (스레드의 마지막 다른 사람 메시지, 인용 제거, ts 모름 → asked_in 은 []):", fast.ctx.body_excerpt];
    return {
      guide: `${fast.kind === "slack" ? "Slack 대화" : "Gmail 메일"} — 도구는 없다. 아래 수집된 대화만 보고 정리한다.`,
      ref: base.ref,
      context: `${lines.filter(Boolean).join("\n")}${preview ? `\n\n(목록 미리보기)\n${preview}` : ""}`,
      me: fast.kind === "slack" ? "아래 대화에서 `나` 로 표시된 메시지가 내 것이다." : "아래 메일은 다른 사람이 보낸 것이다.",
      transcript: "`[]` 로 둔다 (Ned 가 위 발췌를 이미 갖고 있다). `asked_in` 에는 위 대화의 ts 를 **그대로** 쓴다.",
      extra: "",
      meta: base.meta,
    };
  }
  if (req.source === "slack") {
    const t = slackTarget(ref);
    const dm = !!t.channel_id?.startsWith("D") && !t.thread_ts;
    const parent = dm ? undefined : t.thread_ts ?? t.ts;
    const read = parent && t.channel_id
      ? `\`mcp__claude_ai_Slack__slack_read_thread\` 로 channel_id=\`${t.channel_id}\`, message_ts=\`${parent}\`, limit=${THREAD_READ_LIMIT} (스레드 전체, response_format: concise)`
      : t.channel_id
        ? `\`mcp__claude_ai_Slack__slack_read_channel\` 로 channel_id=\`${t.channel_id}\`, limit=${dm ? THREAD_READ_LIMIT : 20}${dm ? " (DM 대화)" : ""}`
        : "";
    return {
      guide: ["Slack 대화.", read ? `- ${read} 를 **한 번** 읽는다. 미리보기만 보고 정리하지 않는다.` : "- 채널 정보가 없다. 도구를 쓰지 말고 미리보기만으로 정리한다."].join("\n"),
      ref: base.ref,
      context: preview || "(없음)",
      me: "내 Slack user_id 는 `ToolSearch` 로 `select:mcp__claude_ai_Slack__slack_search_public_and_private` 를 불러오면 그 도구 설명의 `Current logged in user's user_id is U…` 에 있다 (그 도구는 **호출하지 않는다** — 설명만 본다). 그 user_id 가 쓴 메시지가 내 것이다.",
      transcript: `${EXTRACT_FULL_TRANSCRIPT} \`ts\` 는 Slack 원본 ts 문자열(예 \`"1730860000.123456"\`), \`user_id\` 는 보낸 사람 \`U…\`.`,
      extra: "",
      meta: base.meta,
    };
  }
  if (req.source === "email") {
    return {
      guide: [
        "Gmail 메일 스레드.",
        ref.thread_id
          ? `- \`mcp__claude_ai_Gmail__get_thread\` 로 threadId=\`${ref.thread_id}\` 를 messageFormat=PLAIN_TEXT 로 읽는다.`
          : "- thread id 가 없다. 제목·미리보기로 `mcp__claude_ai_Gmail__search_threads` 를 1회만 써서 스레드를 찾고, 찾으면 `get_thread`(PLAIN_TEXT)로 읽는다.",
        "- `reply_meta`: `message_id` = 스레드의 마지막 **다른 사람이 보낸** 메시지 id, `reply_to` = 그 발신자 주소, `subject` = `Re: <원제목>`.",
      ].join("\n"),
      ref: base.ref,
      context: preview || "(없음)",
      me: "내 메시지 = `SENT` 라벨이 붙었거나 발신자가 이 계정 주소인 메시지.",
      transcript: `${EXTRACT_FULL_TRANSCRIPT} \`ts\` 는 메시지 날짜(ISO-8601), \`text\` 는 인용(> …, "On … wrote:") 을 뺀 본문.`,
      extra: ',"reply_meta":{"message_id":"","reply_to":"","subject":""}',
      meta: base.meta,
    };
  }
  // jira
  const t = jiraTarget(ref);
  return {
    guide: [
      "Jira 이슈의 코멘트 대화.",
      "- `mcp__claude_ai_Atlassian__atlassianUserInfo` 로 현재 사용자(나)를 확인한다.",
      `- \`mcp__claude_ai_Atlassian__getJiraIssue\` 로 cloudId=\`${t.cloud_id ?? "(URL 없음)"}\`, issueIdOrKey=\`${t.key}\`, fields=["summary","description","status","assignee","reporter","comment"], responseContentFormat="markdown" 로 1회 읽는다.`,
      "- 질문·요청이 없으면 `asks` 는 `[]` (다음 단계가 진행 상황 공유를 쓴다).",
    ].join("\n"),
    ref: base.ref,
    context: preview || "(없음)",
    me: "현재 사용자(atlassianUserInfo 의 accountId)가 쓴 코멘트·설명이 내 것이다.",
    transcript: `이슈 설명을 첫 메시지(보낸 사람 = reporter, ts = 생성 시각)로, 이어서 코멘트를 오래된 순으로. ${EXTRACT_FULL_TRANSCRIPT} \`ts\` 는 코멘트 작성 시각(ISO-8601).`,
    extra: "",
    meta: base.meta,
  };
}

/** Pass 1 prompt (prompts/draft-extract.md). */
export function buildExtractPrompt(req: DraftRequest, fast: AgendaCtx | null = null): { prompt: string; meta: DraftMeta } {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "draft-extract.md"), "utf8");
  const g = extractGuide(req, fast);
  const prompt = template
    .replace("{{NOW}}", () => new Date().toLocaleString("ko-KR"))
    .replace("{{TOOL_RULES}}", () => (fast ? "- 도구는 없다. 아래 대화만으로 **한 번에** JSON 을 출력한다." : TOOL_RULES))
    .replace("{{ME_RULE}}", () => g.me)
    .replace("{{TRANSCRIPT_RULE}}", () => g.transcript)
    .replace("{{SOURCE_GUIDE}}", () => g.guide)
    .replace("{{REF}}", () => g.ref)
    .replace("{{CONTEXT}}", () => g.context)
    .replace("{{SCHEMA_EXTRA}}", () => g.extra);
  return { prompt, meta: g.meta };
}

const WRITE_SOURCE_RULES: Partial<Record<DraftSource, string>> = {
  slack: "- Slack: 초안 본문에 멘션을 넣지 않는다 (Ned 가 토글로 붙인다). `mentions` 에는 참여자(나 제외)가 2명 이상이고 특정 항목의 `who` 에게 답해야 할 때만, 위 참여자 목록에 있는 `<@U…>` 를 넣는다. 아니면 `[]`.",
  email: "- 메일: 인사(\"안녕하세요, ○○님.\")로 시작해도 되지만 서명은 넣지 않는다. `mentions` 는 `[]`.",
  jira: "- Jira 코멘트: 평문. 다른 사람 언급은 이름만(멘션 문법 금지). 답할 것이 없으면 진행 상황 공유(무엇을 했고 다음에 무엇을 할지)를 짧게. `mentions` 는 `[]`.",
};

/** Pass 2 prompt (prompts/draft-write.md): segments + numbered open asks, no tools. */
export function buildWritePrompt(req: DraftRequest, cfg: NedConfig, seg: Segments, participants: Participant[], asks: DraftAsk[]): string {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "draft-write.md"), "utf8");
  const n = openAsks(asks).length;
  const openRule = n
    ? `답할 것이 ${n}개다 — 각 초안은 1번부터 ${n}번까지 **모두** 답한다 (covers = [${Array.from({ length: n }, (_, i) => i + 1).join(",")}]).`
    : `답할 질문·요청이 없다 — 짧은 리액션/확인형으로만 쓴다(예: "확인했어요, 감사합니다"). 세 초안 모두 1~2문장, covers 는 [].`;
  return template
    .replace("{{NOW}}", () => new Date().toLocaleString("ko-KR"))
    .replace("{{OPEN_RULE}}", () => openRule)
    .replace("{{TONE}}", () => draftTone(req, cfg))
    .replace("{{HINT}}", () => req.hint ?? "(없음)")
    .replace("{{SOURCE_RULES}}", () => WRITE_SOURCE_RULES[req.source] ?? "")
    .replace("{{SEGMENTS}}", () => renderSegments(seg, participants))
    .replace("{{ASKS}}", () => renderAsks(asks));
}

interface LlmWrite {
  summary?: string;
  excerpt?: string;
  mentions?: unknown;
  drafts?: { label?: string; text?: string; covers?: unknown }[];
}

/** The latest message to answer: last non-reaction message in [답할 대상] (else the last one at all). */
function targetExcerpt(seg: Segments): string {
  const t = seg.target.filter((m) => !m.mine);
  return ((([...t].reverse().find((m) => !m.reaction) ?? t[t.length - 1])?.text) ?? "").slice(0, 300);
}

const askView = (a: DraftAsk): DraftAskView => ({ who: a.who, what: a.what, due: a.due, status: a.status, answered_in: a.answered_in });

/** NED_NO_LLM: asks guessed from [답할 대상] (a `?` or a request ending), so the modal's list is exercised without claude. */
const STUB_ASK_RE = /[?？]|부탁|요청|주세요|줘요|해줘|될까|할까|인가요|나요|까요/;
function stubAsks(seg: Segments): DraftAsk[] {
  return seg.target.filter((m) => !m.mine && !m.reaction && STUB_ASK_RE.test(m.text)).map((m) => ({ who: m.from, what: m.text.slice(0, 80), due: "", status: "open", answered_in: "", asked_in: m.ts ? [m.ts] : [] }));
}

const inflight = new Map<string, Promise<DraftResult>>();

/** Draft generation is running for this key (UI can show a spinner on a second click). */
export function draftBusy(source: DraftSource, ref: DraftRef): boolean {
  return inflight.has(refKey(source, ref));
}

function validate(req: DraftRequest): DraftError | null {
  if (req.source === "session" && !req.ref.session_id) return new DraftError("ref.session_id required", 400);
  if (req.source === "slack" && !slackTarget(req.ref).channel_id && !req.ref.text) return new DraftError("ref.url / ref.channel or ref.text required", 400);
  if (req.source === "email" && !req.ref.thread_id && !req.ref.message_id && !req.ref.text && !req.ref.title) return new DraftError("ref.thread_id or ref.title / ref.text required", 400);
  if (req.source === "jira") {
    const t = jiraTarget(req.ref);
    if (!t.key || !t.cloud_id) return new DraftError("ref.url (https://<site>.atlassian.net/browse/KEY-1) required", 400);
  }
  if (req.source === "github") {
    const g = githubTarget(req.ref);
    if (!g.repo || !g.number) return new DraftError("ref.repo + ref.number or a PR ref.url required", 400);
  }
  return null;
}

/** A cached draft set for this exact request (same key, hint, tone, < 1h), or null. */
function cachedDraft(req: DraftRequest, cfg: NedConfig): DraftResult | null {
  const c = readJson<DraftResult | null>(draftFile(draftIdOf(refKey(req.source, req.ref))), null);
  const tone = draftTone(req, cfg);
  // pre-fast-path cache files lack mode; pre-2-pass ones lack asks / mentions (meta.mode absent → the modal shows no list)
  if (c && Date.now() - c.created_at < CACHE_MS && c.hint === (req.hint ?? "") && c.tone === tone && c.drafts.length) return { ...c, mode: c.mode ?? "full", context_age_minutes: c.context_age_minutes ?? null, asks: c.asks ?? [], mentions: c.mentions ?? [], cached: true };
  return null;
}

/**
 * Reply drafts for one Slack thread / Gmail thread / agent session.
 * Fast path (no tools, 1 turn, isolated claude -p) when the agenda already collected fresh context for the ref, and for sessions;
 * otherwise the full path reads the thread with tools. hint / regenerate reuse the same agenda context.
 * Cached 1h per (source, ref key) unless hint/tone changed or `force`; concurrent calls for one key share a run.
 */
export function generateDraft(req: DraftRequest, cfg: NedConfig, opts: { fastOnly?: boolean } = {}): Promise<DraftResult> {
  const bad = validate(req);
  if (bad) return Promise.reject(bad);
  const key = refKey(req.source, req.ref);
  const id = draftIdOf(key);
  const tone = draftTone(req, cfg);
  const hint = req.hint ?? "";

  if (!req.force && !llmDisabled()) {
    const c = cachedDraft(req, cfg);
    if (c) return Promise.resolve(c);
  }
  const running = inflight.get(key);
  if (running) return running;
  const fast = fastContext(req, cfg);
  if (opts.fastOnly && !fast && req.source !== "session") return Promise.reject(new DraftError("no fresh agenda context", 404));
  const p = runDraft(req, cfg, id, tone, hint, fast, !opts.fastOnly).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function runDraft(req: DraftRequest, cfg: NedConfig, id: string, tone: string, hint: string, fast: AgendaCtx | null, fallback = true): Promise<DraftResult> {
  return TWO_PASS_SOURCES.has(req.source) ? runTwoPass(req, cfg, id, tone, hint, fast, fallback) : runLegacy(req, cfg, id, tone, hint, fast, fallback);
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * 2-pass draft (Slack / 메일 / Jira). Pass 1 extracts transcript + asks (fast: no tools on the agenda excerpt, fast model,
 * 1 turn; full: the read tools, maxTurns 8); the daemon re-segments at my last message and corrects the asks; Pass 2
 * (no tools, fast model, 1 turn) answers the open asks 1:1. Pass 1 unparseable → one legacy single-pass run (meta.mode
 * "legacy"). Pass 2 failure: fast → the full 2-pass path once (like legacy), else DraftError 502.
 */
async function runTwoPass(req: DraftRequest, cfg: NedConfig, id: string, tone: string, hint: string, fast: AgendaCtx | null, fallback: boolean): Promise<DraftResult> {
  const mode: DraftMode = fast ? "fast" : "full";
  const context_age_minutes = fast ? fast.age : null;
  const p1 = buildExtractPrompt(req, fast);
  const fastOpts = { allowedTools: [], tools: [], maxTurns: 1, isolated: true, effort: "low" as const, model: cfg.draft_fast_model ?? cfg.claude_model, timeoutMs: 90_000, job: "draft" as const };
  const started = Date.now();
  let r1: ClaudeRunResult;
  let extracted;
  if (llmDisabled()) {
    log(`draft: NED_NO_LLM=1 — 2pass stub for ${req.source} ${id} (${mode})`);
    r1 = { ok: true, text: "", cost_usd: 0, num_turns: 0, duration_ms: 0 };
    extracted = { transcript: [] as TranscriptMsg[], asks: [] as DraftAsk[], participants: [] as Participant[], reply_meta: {} };
  } else {
    log(`draft: pass 1 extract (${req.source} ${id}, ${mode}${fast ? `, context ${fast.age}m old` : `, tools=${extractTools(req.source).join(",")}`}${req.origin ? `, from ${req.origin}` : ""})`);
    r1 = fast
      ? await runClaude(p1.prompt, fastOpts)
      : await runClaude(p1.prompt, { allowedTools: extractTools(req.source), tools: ["ToolSearch"], maxTurns: 8, model: cfg.claude_model, timeoutMs: 4 * 60_000, job: "draft" });
    extracted = r1.ok ? normalizeExtract(extractJson(r1.text)) : null;
    if (!extracted) {
      log(`draft: pass 1 failed ${req.source} ${id} (${mode}, $${r1.cost_usd.toFixed(3)}, ${secs(Date.now() - started)}) — ${(r1.error ?? r1.text).slice(0, 300)} → legacy single pass`);
      const r = await runLegacy(req, cfg, id, tone, hint, fast, fallback);
      return { ...r, cost_usd: r.cost_usd + r1.cost_usd };
    }
  }
  const t1 = Date.now() - started;
  // Transcript: fast = the excerpt Ned has (+ the thread's my_last_reply_ts); full = what Pass 1 read; nothing → the list preview.
  const own = fast ? fastTranscript(fast) : { transcript: extracted.transcript };
  let transcript = own.transcript;
  if (!transcript.length && (req.ref.text || req.ref.title)) transcript = normalizeTranscript([{ ts: req.ref.ts ?? "", from: "?", mine: false, text: req.ref.text ?? req.ref.title }]);
  const seg = segment(transcript, { myLastTs: "myLastTs" in own ? own.myLastTs : undefined });
  const participants = mergeParticipants(transcript, extracted.participants);
  const asks = reconcileAsks(llmDisabled() ? stubAsks(seg) : extracted.asks, seg);
  const open = openAsks(asks).length;
  const prompt2 = buildWritePrompt(req, cfg, seg, participants, asks);

  let r2: ClaudeRunResult;
  let parsed: LlmWrite | null;
  if (llmDisabled()) {
    r2 = { ok: true, text: "", cost_usd: 0, num_turns: 0, duration_ms: 0 };
    const covers = Array.from({ length: open }, (_, i) => i + 1);
    parsed = { summary: "(NED_NO_LLM stub)", excerpt: "", mentions: [], drafts: DRAFT_LABELS.map((label) => ({ label, text: `[stub ${label}] ${hint || (open ? "확인했습니다. 곧 회신드리겠습니다." : "확인했어요, 감사합니다.")}`, covers })) };
  } else {
    log(`draft: pass 2 write (${req.source} ${id}, ${open} open / ${asks.length} asks, context ${seg.context.length}+${seg.omitted} / target ${seg.target.length})`);
    r2 = await runClaude(prompt2, fastOpts);
    parsed = r2.ok ? extractJson<LlmWrite>(r2.text) : null;
  }
  const drafts = parsed ? normalizeDrafts(id, parsed.drafts, open) : [];
  if (!drafts.length) {
    log(`draft: pass 2 failed ${req.source} ${id} (${mode}) — ${(r2.error ?? r2.text).slice(0, 300)}`);
    if (fast && fallback) {
      log(`draft: ${req.source} ${id} — fast path failed, falling back to full`);
      const r = await runTwoPass(req, cfg, id, tone, hint, null, false);
      return { ...r, cost_usd: r.cost_usd + r1.cost_usd + r2.cost_usd };
    }
    throw new DraftError(`draft failed: ${(r2.error ?? "unparseable model output").slice(0, 300)}`, 502);
  }
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const rm = extracted.reply_meta;
  const meta: DraftMeta = req.source === "email"
    ? { ...p1.meta, message_id: p1.meta.message_id ?? s(rm.message_id), reply_to: p1.meta.reply_to ?? s(rm.reply_to), subject: p1.meta.subject ?? s(rm.subject), mode: "2pass" }
    : { ...p1.meta, mode: "2pass" };
  const cost = r1.cost_usd + r2.cost_usd;
  const result: DraftResult = {
    id,
    source: req.source,
    mode,
    context_age_minutes,
    context: { summary: String(parsed?.summary ?? "").slice(0, 200), excerpt: String(parsed?.excerpt || targetExcerpt(seg) || (fast ? contextExcerpt(fast) : req.ref.text ?? "")).slice(0, 600) },
    drafts,
    asks: asks.map(askView),
    mentions: filterMentions(parsed?.mentions, participants, req.source),
    cost_usd: cost,
    cached: false,
    created_at: Date.now(),
    hint,
    tone,
    meta,
  };
  if (!llmDisabled()) {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    writeJsonAtomic(draftFile(id), result);
  }
  const total = Date.now() - started;
  log(`draft: ${req.source} ${id} (${mode}, 2pass) — ${drafts.length} drafts, ${open} open asks; pass 1 $${r1.cost_usd.toFixed(3)} ${secs(t1)} · pass 2 $${r2.cost_usd.toFixed(3)} ${secs(total - t1)} · total $${cost.toFixed(3)} ${secs(total)}`);
  return result;
}

async function runLegacy(req: DraftRequest, cfg: NedConfig, id: string, tone: string, hint: string, fast: AgendaCtx | null, fallback = true): Promise<DraftResult> {
  const noTools = !!fast || req.source === "session" || req.source === "github";
  const mode: DraftMode = noTools ? "fast" : "full";
  const context_age_minutes = fast ? fast.age : req.source === "session" || req.source === "github" ? 0 : null;
  // github: Ned itself reads the PR read-only (gh pr view --json / gh pr diff) and inlines it; the model gets no tools.
  const g = req.source === "github" ? githubTarget(req.ref) : null;
  const prefetched = g?.repo && g.number && !llmDisabled() ? await githubContext(g.repo, g.number) : undefined;
  const { prompt, meta } = buildDraftPrompt(req, cfg, fast, prefetched);
  if (llmDisabled()) {
    log(`draft: NED_NO_LLM=1 — stub for ${req.source} ${id} (${mode})`);
    const excerpt = fast ? contextExcerpt(fast) : req.ref.text ?? req.ref.title ?? "";
    return {
      id,
      source: req.source,
      mode,
      context_age_minutes,
      context: { summary: "(NED_NO_LLM stub)", excerpt },
      drafts: DRAFT_LABELS.map((label, i) => ({ id: `${id}-${i}`, label, text: `[stub ${label}] ${hint || "확인했습니다. 곧 회신드리겠습니다."}` })),
      asks: [],
      mentions: [],
      cost_usd: 0,
      cached: false,
      created_at: Date.now(),
      hint,
      tone,
      meta: { ...meta, mode: "legacy" },
    };
  }
  const started = Date.now();
  let res;
  if (noTools) {
    // Everything is in the prompt: no tools, one turn, and none of the user's hooks / plugins / MCP servers (start-up ~4s instead of ~40s).
    log(`draft: asking claude (${req.source} ${id}, fast${fast ? `, context ${fast.age}m old` : ""}${req.origin ? `, from ${req.origin}` : ""})`);
    res = await runClaude(prompt, { allowedTools: [], tools: [], maxTurns: 1, isolated: true, effort: "low", model: cfg.draft_fast_model ?? cfg.claude_model, timeoutMs: 90_000, job: "draft" });
  } else {
    const tools = draftTools(req.source);
    log(`draft: asking claude (${req.source} ${id}, full, tools=${tools.join(",")}${req.origin ? `, from ${req.origin}` : ""})`);
    // Read-only: plan mode + read tools only; built-ins narrowed to ToolSearch.
    res = await runClaude(prompt, { allowedTools: tools, tools: ["ToolSearch"], maxTurns: 8, model: cfg.claude_model, timeoutMs: 4 * 60_000, job: "draft" });
  }
  const parsed = res.ok ? extractJson<LlmDraft>(res.text) : null;
  const drafts = parsed ? normalizeDrafts(id, parsed.drafts) : [];
  if (!drafts.length) {
    log(`draft: failed ${req.source} ${id} (${mode}) — ${(res.error ?? res.text).slice(0, 300)}`);
    if (fast && fallback) {
      log(`draft: ${req.source} ${id} — fast path failed, falling back to full`);
      const r = await runLegacy(req, cfg, id, tone, hint, null, false);
      return { ...r, cost_usd: r.cost_usd + res.cost_usd };
    }
    throw new DraftError(`draft failed: ${(res.error ?? "unparseable model output").slice(0, 300)}`, 502);
  }
  const rawMeta = parsed?.reply_meta ?? {};
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const result: DraftResult = {
    id,
    source: req.source,
    mode,
    context_age_minutes,
    context: { summary: String(parsed?.summary ?? "").slice(0, 200), excerpt: String(parsed?.excerpt || (fast ? contextExcerpt(fast) : "")).slice(0, 600) },
    drafts,
    asks: [],
    mentions: [],
    cost_usd: res.cost_usd,
    cached: false,
    created_at: Date.now(),
    hint,
    tone,
    meta: req.source === "email" ? { ...meta, message_id: meta.message_id ?? s(rawMeta.message_id), reply_to: meta.reply_to ?? s(rawMeta.reply_to), subject: meta.subject ?? s(rawMeta.subject), mode: "legacy" } : { ...meta, mode: "legacy" },
  };
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(draftFile(id), result);
  log(`draft: ${req.source} ${id} (${mode}) — ${drafts.length} drafts, $${res.cost_usd.toFixed(3)}, ${res.num_turns} turns, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
}

// ---------- optional pre-generation after each agenda run (config.drafts_pregenerate) ----------

export const PREGEN_MAX = 6;
const PREGEN_MAIL_REASONS = new Set(["reply", "approval", "request"]);
const PREGEN_FILE = path.join(DRAFTS_DIR, "_pregenerate.json");

export interface PregenStatus {
  /** Drafts generated by the last finished run (cache hits not counted). */
  pregenerated: number;
  /** Candidates the last run found already cached. */
  skipped_cached: number;
  failed: number;
  cost_usd: number;
  /** ms epoch the last run finished, 0 = never. */
  last_run_ts: number;
  running: boolean;
}

let pregenRunning = false;

export function pregenStatus(): PregenStatus {
  const s = readJson<Partial<PregenStatus>>(PREGEN_FILE, {});
  return { pregenerated: s.pregenerated ?? 0, skipped_cached: s.skipped_cached ?? 0, failed: s.failed ?? 0, cost_usd: s.cost_usd ?? 0, last_run_ts: s.last_run_ts ?? 0, running: pregenRunning };
}

/** The refs the dashboard would send for agenda items that need a reply (same refKey → the modal hits this cache). */
export function pregenCandidates(agenda: Agenda): DraftRequest[] {
  const slack: DraftRequest[] = (agenda.slack?.items ?? [])
    .filter((x) => x.context && x.url)
    .map((x) => ({ source: "slack", ref: { url: x.url, title: [x.channel, x.from].filter(Boolean).join(" · "), text: x.text } }));
  const mail: DraftRequest[] = (agenda.mail?.items ?? [])
    .filter((x) => x.context && x.id && PREGEN_MAIL_REASONS.has(x.reason))
    .map((x) => ({ source: "email", ref: { url: x.url, thread_id: x.id, title: [x.subject, x.from].filter(Boolean).join(" — "), text: x.why || x.snippet } }));
  // Alternate so both sources get a share of the cap; each list is already most-urgent first.
  const out: DraftRequest[] = [];
  for (let i = 0; out.length < PREGEN_MAX && (i < slack.length || i < mail.length); i++) {
    if (slack[i]) out.push(slack[i]);
    if (mail[i] && out.length < PREGEN_MAX) out.push(mail[i]);
  }
  return out;
}

/** Sequentially pre-generate fast-path drafts (max PREGEN_MAX) for the agenda's reply-needing items. Never overlaps itself. */
export async function pregenerateDrafts(agenda: Agenda, cfg: NedConfig): Promise<PregenStatus> {
  if (pregenRunning) return pregenStatus();
  pregenRunning = true;
  const started = Date.now();
  let n = 0, cached = 0, failed = 0, cost = 0;
  try {
    const list = pregenCandidates(agenda);
    log(`pregenerate: ${list.length} candidates`);
    for (const req of list) {
      if (!fastContext(req, cfg)) continue; // stale context: the modal will take the full path
      if (!llmDisabled() && cachedDraft(req, cfg)) { cached++; continue; }
      try {
        const r = await generateDraft(req, cfg, { fastOnly: true });
        if (r.cached) cached++;
        else { n++; cost += r.cost_usd; }
      } catch (e) {
        failed++;
        log(`pregenerate: ${req.source} failed — ${String(e).slice(0, 200)}`);
      }
    }
  } finally {
    pregenRunning = false;
  }
  const status: PregenStatus = { pregenerated: n, skipped_cached: cached, failed, cost_usd: Math.round(cost * 10000) / 10000, last_run_ts: Date.now(), running: false };
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(PREGEN_FILE, status);
  log(`pregenerate: ${n} drafts (${cached} cached, ${failed} failed), total $${cost.toFixed(3)}, ${Math.round((Date.now() - started) / 1000)}s`);
  return status;
}
