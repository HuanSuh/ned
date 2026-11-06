import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import { normalizeReplyTone, type NedConfig } from "./config.js";
import { readRecentEvents, type NedEvent } from "./events.js";
import { NED_HOME, log, readJson, writeJsonAtomic } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(here, "../../../prompts");

/** ~/.ned/drafts/<id>.json — one cached draft set per (source, ref key). */
export const DRAFTS_DIR = path.join(NED_HOME, "drafts");
const CACHE_MS = 60 * 60_000;

export type DraftSource = "slack" | "email" | "session";
export const DRAFT_SOURCES: DraftSource[] = ["slack", "email", "session"];
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
}

export interface DraftRequest {
  source: DraftSource;
  ref: DraftRef;
  hint?: string;
  tone?: string;
  /** Skip the 1h cache. */
  force?: boolean;
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
}

export interface DraftResult {
  id: string;
  source: DraftSource;
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
  if (!DRAFT_SOURCES.includes(source)) throw new DraftError("source must be slack | email | session", 400);
  const r = (body.ref && typeof body.ref === "object" ? body.ref : {}) as Record<string, unknown>;
  const ref: DraftRef = {};
  for (const k of ["url", "channel", "ts", "thread_ts", "thread_id", "message_id", "session_id", "title", "text"] as const) {
    const v = str(r[k], k === "text" ? 2000 : 500);
    if (v) ref[k] = v;
  }
  return { source, ref, hint: str(body.hint, 500), tone: str(body.tone, 200), force: body.force === true };
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
  return [];
}

function sourceGuide(req: DraftRequest): { guide: string; ref: string; context: string; meta: DraftMeta } {
  const { ref } = req;
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

export function buildDraftPrompt(req: DraftRequest, cfg: NedConfig): { prompt: string; meta: DraftMeta } {
  const template = fs.readFileSync(path.join(PROMPTS_DIR, "draft.md"), "utf8");
  const s = sourceGuide(req);
  const tone = normalizeReplyTone(req.tone, cfg.reply_tone);
  const prompt = template
    .replace("{{NOW}}", () => new Date().toLocaleString("ko-KR"))
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

/**
 * Reply drafts for one Slack thread / Gmail thread / agent session.
 * Cached 1h per (source, ref key) unless hint/tone changed or `force`; concurrent calls for one key share a run.
 */
export function generateDraft(req: DraftRequest, cfg: NedConfig): Promise<DraftResult> {
  if (req.source === "session" && !req.ref.session_id) return Promise.reject(new DraftError("ref.session_id required", 400));
  if (req.source === "slack" && !slackTarget(req.ref).channel_id && !req.ref.text) return Promise.reject(new DraftError("ref.url / ref.channel or ref.text required", 400));
  if (req.source === "email" && !req.ref.thread_id && !req.ref.message_id && !req.ref.text && !req.ref.title) return Promise.reject(new DraftError("ref.thread_id or ref.title / ref.text required", 400));
  const key = refKey(req.source, req.ref);
  const id = draftIdOf(key);
  const tone = normalizeReplyTone(req.tone, cfg.reply_tone);
  const hint = req.hint ?? "";

  if (!req.force && !llmDisabled()) {
    const c = readJson<DraftResult | null>(draftFile(id), null);
    if (c && Date.now() - c.created_at < CACHE_MS && c.hint === hint && c.tone === tone && c.drafts.length) return Promise.resolve({ ...c, cached: true });
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = runDraft(req, cfg, id, tone, hint).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function runDraft(req: DraftRequest, cfg: NedConfig, id: string, tone: string, hint: string): Promise<DraftResult> {
  const { prompt, meta } = buildDraftPrompt(req, cfg);
  if (llmDisabled()) {
    log(`draft: NED_NO_LLM=1 — stub for ${req.source} ${id}`);
    return {
      id,
      source: req.source,
      context: { summary: "(NED_NO_LLM stub)", excerpt: req.ref.text ?? req.ref.title ?? "" },
      drafts: DRAFT_LABELS.map((label, i) => ({ id: `${id}-${i}`, label, text: `[stub ${label}] ${hint || "확인했습니다. 곧 회신드리겠습니다."}` })),
      cost_usd: 0,
      cached: false,
      created_at: Date.now(),
      hint,
      tone,
      meta,
    };
  }
  const tools = draftTools(req.source);
  log(`draft: asking claude (${req.source} ${id}, tools=${tools.join(",") || "none"})`);
  // Read-only: plan mode + read tools only; built-ins narrowed to ToolSearch (or none for sessions).
  const res = await runClaude(prompt, { allowedTools: tools, tools: tools.length ? ["ToolSearch"] : [], maxTurns: 8, model: cfg.claude_model, timeoutMs: 4 * 60_000 });
  const parsed = res.ok ? extractJson<LlmDraft>(res.text) : null;
  const drafts = parsed ? normalizeDrafts(id, parsed.drafts) : [];
  if (!drafts.length) {
    log(`draft: failed ${req.source} ${id} — ${(res.error ?? res.text).slice(0, 300)}`);
    throw new DraftError(`draft failed: ${(res.error ?? "unparseable model output").slice(0, 300)}`, 502);
  }
  const rm = parsed?.reply_meta ?? {};
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const result: DraftResult = {
    id,
    source: req.source,
    context: { summary: String(parsed?.summary ?? "").slice(0, 200), excerpt: String(parsed?.excerpt ?? "").slice(0, 600) },
    drafts,
    cost_usd: res.cost_usd,
    cached: false,
    created_at: Date.now(),
    hint,
    tone,
    meta: req.source === "email" ? { ...meta, message_id: meta.message_id ?? s(rm.message_id), reply_to: s(rm.reply_to), subject: s(rm.subject) } : meta,
  };
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(draftFile(id), result);
  log(`draft: ${req.source} ${id} — ${drafts.length} drafts, $${res.cost_usd.toFixed(3)}, ${res.num_turns} turns`);
  return result;
}
