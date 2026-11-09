import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrigin, type ActionOrigin } from "./origin.js";
import { readAgenda, type Agenda, type MailContext, type SlackContext } from "./agenda.js";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
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
}

/** `fast` = no-tool run on context Ned already has (agenda excerpt / local transcript); `full` = claude reads the thread with tools. */
export type DraftMode = "fast" | "full";

export interface DraftResult {
  id: string;
  source: DraftSource;
  mode: DraftMode;
  /** Age of the agenda-collected context the fast path used (0 for sessions: read live); null on the full path. */
  context_age_minutes: number | null;
  context: { summary: string; excerpt: string };
  drafts: { id: string; label: DraftLabel; text: string }[];
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

/** Stable cache key for a (source, ref). Sessions also key on their latest event so a moved-on session redrafts. */
export function refKey(source: DraftSource, ref: DraftRef): string {
  if (source === "slack") {
    const t = slackTarget(ref);
    return `slack:${t.channel_id ?? ""}:${t.thread_ts ?? ""}:${t.ts ?? ""}:${t.channel_id ? "" : ref.url ?? ref.text ?? ""}`;
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
  if (source === "jira") return ["ToolSearch", "mcp__claude_ai_Atlassian__getJiraIssue"];
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
    const parent = t.thread_ts ?? t.ts;
    const guide = [
      "Slack 메시지에 대한 답장.",
      parent && t.channel_id
        ? `- \`mcp__claude_ai_Slack__slack_read_thread\` 로 channel_id=\`${t.channel_id}\`, message_ts=\`${parent}\` 스레드를 읽는다 (response_format: concise).`
        : t.channel_id
          ? `- \`mcp__claude_ai_Slack__slack_read_channel\` 로 channel_id=\`${t.channel_id}\` 최근 메시지 20개만 읽고 답할 메시지를 찾는다.`
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

function normalizeDrafts(id: string, raw: LlmDraft["drafts"]): DraftResult["drafts"] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DraftResult["drafts"] = [];
  DRAFT_LABELS.forEach((label, i) => {
    const d = list.find((x) => x?.label === label) ?? list[i];
    const text = typeof d?.text === "string" ? d.text.trim() : "";
    if (text) out.push({ id: `${id}-${i}`, label, text });
  });
  return out;
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
  if (c && Date.now() - c.created_at < CACHE_MS && c.hint === (req.hint ?? "") && c.tone === tone && c.drafts.length) return { ...c, mode: c.mode ?? "full", context_age_minutes: c.context_age_minutes ?? null, cached: true }; // pre-fast-path cache files lack mode
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

async function runDraft(req: DraftRequest, cfg: NedConfig, id: string, tone: string, hint: string, fast: AgendaCtx | null, fallback = true): Promise<DraftResult> {
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
      cost_usd: 0,
      cached: false,
      created_at: Date.now(),
      hint,
      tone,
      meta,
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
      return runDraft(req, cfg, id, tone, hint, null, false);
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
    cost_usd: res.cost_usd,
    cached: false,
    created_at: Date.now(),
    hint,
    tone,
    meta: req.source === "email" ? { ...meta, message_id: meta.message_id ?? s(rawMeta.message_id), reply_to: meta.reply_to ?? s(rawMeta.reply_to), subject: meta.subject ?? s(rawMeta.subject) } : meta,
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
