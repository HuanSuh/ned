import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readAgenda, type Agenda } from "./agenda.js";
import { allowedChatKinds, chatWriteBlock } from "./chat-actions.js";
import { llmDisabled, runClaude, type ClaudeRunResult } from "./claude.js";
import type { NedConfig } from "./config.js";
import { recordCost, todayCost } from "./costs.js";
import { listBriefings } from "./heartbeat.js";
import { NED_HOME, log, readJson, writeJsonAtomic } from "./paths.js";
import { personaPrompt } from "./persona.js";
import { readState, type Briefing, type NedState } from "./state.js";
import { listTodos, type Todo } from "./todos.js";

/**
 * Ned 채팅 (dashboard PDA → 대화 탭). One `claude -p` per turn, continued with `--resume <session_id>`:
 * read-only tools only (connector reads, `gh` / `orca status` reads), persona voice + a compact digest of what the daemon
 * already knows (≤ CHAT_CONTEXT_MAX chars) in `--append-system-prompt`, refreshed every turn. Streamed to the browser as SSE.
 */
export const CHATS_DIR = path.join(NED_HOME, "chats");
export const CHAT_KEEP = 20;
export const CHAT_INPUT_MAX = 2000;
export const CHAT_CONTEXT_MAX = 6000;
export const CHAT_MAX_TURNS = 12;

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(here, "../../../prompts/chat.md");

export interface ChatMessage {
  role: "user" | "ned";
  text: string;
  ts: number;
  cost_usd?: number;
  /** The run failed; `text` is what streamed before (may be ""). */
  error?: string;
  /** Stopped by the user (POST /api/chat/:id/stop). */
  stopped?: boolean;
  /** The 확인 카드 for this answer's ```ned-action block (POST /api/chat/:id/action). Absent = not acted on yet. */
  action?: ChatActionState;
}

export const CHAT_ACTION_STATES = ["running", "executed", "failed", "cancelled"] as const;
export type ChatActionStatus = (typeof CHAT_ACTION_STATES)[number];
export interface ChatActionState {
  state: ChatActionStatus;
  /** The (possibly edited) text that was / is being run. */
  text?: string;
  result?: { ok: boolean; detail: string; link?: string };
  at: number;
}

export interface Chat {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /** claude session to `--resume`; null until the first answer (or after a failed resume). */
  session_id: string | null;
  cost_usd: number;
  messages: ChatMessage[];
}

const ID_RE = /^c-[a-z0-9]{4,40}$/;
export const isChatId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);
const chatPath = (id: string) => path.join(CHATS_DIR, `${id}.json`);
const round = (n: number) => Math.round(n * 10000) / 10000;
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function newChat(now = Date.now()): Chat {
  return { id: `c-${now.toString(36)}${randomBytes(3).toString("hex")}`, title: "", created_at: now, updated_at: now, session_id: null, cost_usd: 0, messages: [] };
}

export function readChat(id: string): Chat | null {
  if (!isChatId(id)) return null;
  const c = readJson<Chat | null>(chatPath(id), null);
  if (!c || typeof c !== "object" || c.id !== id || !Array.isArray(c.messages)) return null;
  return { ...c, session_id: typeof c.session_id === "string" && c.session_id ? c.session_id : null, cost_usd: Number(c.cost_usd) || 0 };
}

/** Write the chat and keep only the CHAT_KEEP most recently updated ones. */
export function saveChat(c: Chat): void {
  writeJsonAtomic(chatPath(c.id), c);
  pruneChats();
}

export interface ChatSummary {
  id: string;
  title: string;
  updated_at: number;
  messages: number;
  cost_usd: number;
}

function allChats(): Chat[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => readChat(f.slice(0, -5)))
    .filter((c): c is Chat => !!c)
    .sort((a, b) => b.updated_at - a.updated_at);
}

export function listChats(): ChatSummary[] {
  return allChats().map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, messages: c.messages.length, cost_usd: c.cost_usd }));
}

export function pruneChats(keep = CHAT_KEEP): void {
  for (const c of allChats().slice(keep)) {
    if (active?.id === c.id) continue;
    try {
      fs.rmSync(chatPath(c.id), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Record a 확인 카드's state on the ned message with timestamp `ts`. Allowed moves: (none|failed) → running | cancelled,
 * running → executed | failed | cancelled (a lost run). executed / cancelled are final — a second run is refused (409).
 */
export function setChatActionState(id: string, ts: unknown, body: Record<string, unknown>, now = Date.now()): { ok: true; action: ChatActionState } | { ok: false; status: 400 | 404 | 409; error: string } {
  const c = readChat(id);
  if (!c) return { ok: false, status: 404, error: "unknown conversation" };
  const m = c.messages.find((x) => x.role === "ned" && x.ts === Number(ts));
  if (!m) return { ok: false, status: 404, error: "unknown message" };
  const next = body.state as ChatActionStatus;
  if (!CHAT_ACTION_STATES.includes(next)) return { ok: false, status: 400, error: `state must be ${CHAT_ACTION_STATES.join(" | ")}` };
  const cur = m.action?.state;
  const can = cur === undefined || cur === "failed" ? next === "running" || next === "cancelled" : cur === "running" ? next !== "running" : false;
  if (!can) return { ok: false, status: 409, error: cur === "executed" ? "이미 실행한 카드야" : cur === "cancelled" ? "취소한 카드야" : `이 카드는 지금 ${cur} 상태야` };
  const action: ChatActionState = { state: next, at: now };
  const text = typeof body.text === "string" ? body.text.slice(0, 4000) : m.action?.text;
  if (text !== undefined) action.text = text;
  const r = body.result as Record<string, unknown> | undefined;
  if (r && typeof r === "object") action.result = { ok: r.ok === true, detail: clip(r.detail, 500), ...(typeof r.link === "string" && /^https:\/\//.test(r.link) ? { link: r.link.slice(0, 500) } : {}) };
  m.action = action;
  saveChat(c);
  return { ok: true, action };
}

// ---------- context digest ----------

const hm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export interface ChatContextInput {
  cfg: Pick<NedConfig, "sources">;
  agenda: Agenda;
  state: NedState;
  briefings: Briefing[];
  todos: Todo[];
  now?: number;
}

/**
 * What the daemon already knows, as short lines (titles + urls), never the raw JSON. Sections are added in priority
 * order and the whole is cut at `max` chars (a section that doesn't fit is truncated, later ones dropped).
 */
export function buildChatContext(inp: ChatContextInput, max = CHAT_CONTEXT_MAX): string {
  const { cfg, agenda: a, state: st, briefings, todos } = inp;
  const now = inp.now ?? Date.now();
  const sections: [string, string[]][] = [];

  const open = (st.attention ?? []).filter((x) => !x.reviewed_at).sort((x, y) => y.ts - x.ts);
  sections.push([`확인 필요 (${open.length}건)`, open.slice(0, 12).map((x) => `- [${x.kind}] ${clip(x.title, 110)}${x.url ? ` ${x.url}` : ""}`)]);

  if (cfg.sources.calendar) {
    const today = new Date(now).toDateString();
    const ev = (a.calendar ?? []).filter((e) => e.rsvp !== "declined" && new Date(Date.parse(e.start)).toDateString() === today).sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    sections.push(["오늘 일정", ev.slice(0, 12).map((e) => `- ${e.all_day ? "종일" : `${hm(Date.parse(e.start))}–${hm(Date.parse(e.end))}`} ${clip(e.title, 80)}${e.rsvp === "needsAction" ? " (RSVP 안 함)" : ""}${e.url ? ` ${e.url}` : ""}${e.id ? ` event_id=${e.id}` : ""}`)]);
  }
  if (cfg.sources.slack && a.slack) {
    const lines = a.slack.items.slice(0, 8).map((x) => `- [${x.reason}] ${x.channel} ${x.from}: ${clip(x.text, 100)} ${x.url}`);
    for (const t of (a.slack.threads ?? []).filter((t) => t.new_since_me > 0).slice(0, 5)) lines.push(`- 스레드 ${t.channel} 내 답 이후 새 답글 ${t.new_since_me}건: ${clip(t.thread_summary || t.last_reply_text, 90)} ${t.url}`);
    sections.push([`Slack 답할 것${a.slack.summary ? ` — ${clip(a.slack.summary, 100)}` : ""}`, lines]);
  }
  if (cfg.sources.gmail && a.mail) sections.push([`메일 (안 읽음 ${a.mail.unread}${a.mail.unread_capped ? "+" : ""})`, a.mail.items.slice(0, 6).map((x) => `- ${clip(x.from, 30)} — ${clip(x.subject, 80)} · ${clip(x.why, 50)} ${x.url}`)]);
  if (cfg.sources.jira) sections.push(["Jira 내 이슈", (a.jira ?? []).slice(0, 8).map((x) => `- ${x.key} [${x.status}] ${clip(x.title, 80)}${x.due ? ` · 마감 ${x.due}` : ""} ${x.url}`)]);
  if (cfg.sources.github) sections.push(["GitHub PR", (a.github ?? []).slice(0, 8).map((x) => `- [${x.reason}] ${x.repo}#${x.number} ${clip(x.title, 80)} ${x.url}`)]);

  const sess = (st.sessions ?? []).filter((s) => s.status !== "ended");
  sections.push(["열린 에이전트 세션", sess.slice(0, 8).map((s) => `- ${s.worktree || path.basename(s.cwd)} · ${s.status}${s.is_worker ? " (워커)" : ""}${s.last_prompt ? ` · ${clip(s.last_prompt, 70)}` : ""} session_id=${s.id}`)]);

  const heads = briefings.filter((b) => b.headline).slice(0, 3);
  sections.push(["최근 브리핑", heads.map((b) => `- ${new Date(b.ts).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ${clip(b.headline, 120)}`)]);

  const td = todos.filter((t) => !t.done);
  sections.push(["할 일", td.slice(0, 10).map((t) => `- ${clip(t.title, 80)}${t.due ? ` (마감 ${t.due})` : ""}`)]);

  const out: string[] = [a.updated_at ? `agenda 갱신 ${Math.round((now - a.updated_at) / 60_000)}분 전` : "agenda 아직 없음"];
  let len = out[0].length;
  for (const [title, lines] of sections) {
    const block = [`\n### ${title}`, ...(lines.length ? lines : ["(없음)"])];
    for (const line of block) {
      if (len + line.length + 1 > max - 12) {
        out.push("…(이하 생략)");
        return out.join("\n");
      }
      out.push(line);
      len += line.length + 1;
    }
  }
  return out.join("\n");
}

/** The fresh digest from disk (agenda.json, state.json, briefings, todos). */
export function liveChatContext(cfg: NedConfig): string {
  return buildChatContext({ cfg, agenda: readAgenda(), state: readState(), briefings: listBriefings(5), todos: listTodos() });
}

// ---------- feature guide (docs/FEATURES.md → "요약") ----------

export const FEATURES_PATH = path.resolve(here, "../../../docs/FEATURES.md");
/** Separate from CHAT_CONTEXT_MAX: the feature summary has its own cap. */
export const FEATURES_SUMMARY_MAX = 3000;

/**
 * The body of the first `## 요약` heading (any level, "요약" optionally followed by text like "(…)"), up to the next
 * heading of the same or a higher level. Trimmed and cut at `max` chars. null when there is no such section / it's empty.
 */
export function extractFeaturesSummary(md: string, max = FEATURES_SUMMARY_MAX): string | null {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  let level = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+요약(?:\s|\(|$)/.exec(lines[i]);
    if (m) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  fence = false;
  for (let i = start; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join("\n").trim();
  if (!body) return null;
  if (body.length <= max) return body;
  // Cut at a line boundary so the last line survives whole; one long line falls back to a char cut. ≤ max incl. "…".
  const cut = body.lastIndexOf("\n", max - 1);
  return `${(cut > 0 ? body.slice(0, cut) : body.slice(0, max - 1)).trimEnd()}…`;
}

let featuresWarned = "";
/** The summary from docs/FEATURES.md, or null (missing file / unreadable / no section) — logged once per reason. */
export function readFeaturesSummary(file = FEATURES_PATH, max = FEATURES_SUMMARY_MAX): string | null {
  let reason: string;
  try {
    const s = extractFeaturesSummary(fs.readFileSync(file, "utf8"), max);
    if (s) return s;
    reason = "no 요약 section";
  } catch (e) {
    reason = (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `unreadable (${clip(e, 80)})`;
  }
  const key = `${file}:${reason}`;
  if (featuresWarned !== key) {
    featuresWarned = key;
    log(`chat: feature guide ${file} ${reason} — "Ned 기능 안내" omitted`);
  }
  return null;
}

/** The "## Ned 기능 안내" block for the system prompt ("" when there is no summary). */
export function featuresBlock(summary: string | null): string {
  return summary ? `## Ned 기능 안내 (docs/FEATURES.md 요약)\n\n${summary}` : "";
}

/** Rule 3's follow-up line: propose via a ned-action block (chat_write on) or point at the dashboard buttons. */
export function writeRule(cfg: Pick<NedConfig, "actions">): string {
  return allowedChatKinds(cfg).length
    ? "사용자가 보내기·만들기·추가를 원하면 아래 \"대화창 쓰기 제안\" 형식(```ned-action 블록)으로 **제안만** 한다. 실행은 사용자가 확인 카드에서 한다. 허용 목록에 없는 동작은 대시보드 버튼으로 안내한다."
    : "사용자가 보내기/만들기를 원하면: 할 말(초안 문구)은 대화에 적어 주되, 실제 전송은 \"대시보드의 **답장 초안** 버튼(항목 카드의 ✎)\" 이나 \"**일정 만들기**\" 버튼으로 하라고 안내한다.";
}

export function buildChatSystemPrompt(cfg: NedConfig, context: string, now = new Date(), features: string | null = readFeaturesSummary()): string {
  let tpl: string;
  try {
    tpl = fs.readFileSync(PROMPT_PATH, "utf8");
  } catch {
    tpl = "{{PERSONA}}\n\n너는 Ned 데몬이 모은 맥락을 아는 조력자다. 쓰기 도구는 절대 쓰지 않는다. {{WRITE_RULE}} 짧게, 한국어로.\n\n{{FEATURES}}\n\n{{WRITE}}\n\n{{CONTEXT}}";
  }
  return tpl
    .replaceAll("{{PERSONA}}", personaPrompt(cfg.persona))
    .replaceAll("{{NOW}}", now.toLocaleString("ko-KR", { dateStyle: "full", timeStyle: "short" }))
    .replaceAll("{{FEATURES}}", featuresBlock(features))
    .replaceAll("{{WRITE_RULE}}", writeRule(cfg))
    .replaceAll("{{WRITE}}", chatWriteBlock(cfg))
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll("{{CONTEXT}}", context);
}

// ---------- tools ----------

/** Read-only connector tools per source (the agenda listTools pattern, wider: a person may ask anything). */
const READ_TOOLS: Record<"slack" | "gmail" | "calendar" | "jira" | "sentry", string[]> = {
  slack: ["slack_search_public_and_private", "slack_read_channel", "slack_read_thread", "slack_search_channels", "slack_search_users", "slack_read_user_profile", "slack_read_canvas"].map((t) => `mcp__claude_ai_Slack__${t}`),
  gmail: ["search_threads", "get_thread", "get_message", "list_labels"].map((t) => `mcp__claude_ai_Gmail__${t}`),
  calendar: ["list_events", "get_event", "search_events", "list_calendars", "suggest_time"].map((t) => `mcp__claude_ai_Google_Calendar__${t}`),
  jira: ["searchJiraIssuesUsingJql", "getJiraIssue", "getVisibleJiraProjects", "search", "fetch", "getConfluencePage", "searchConfluenceUsingCql"].map((t) => `mcp__claude_ai_Atlassian__${t}`),
  sentry: ["mcp__Sentry__search_issues", "mcp__Sentry__get_issue_details"],
};
/** `gh` read subcommands + `orca status`. Nothing that can write (no `gh api`, no `gh pr merge/comment`). */
export const CHAT_BASH_READS = ["gh pr view", "gh pr list", "gh pr status", "gh pr checks", "gh pr diff", "gh issue view", "gh issue list", "gh search", "gh run list", "gh run view", "orca status"].map((c) => `Bash(${c}:*)`);

export function chatTools(cfg: Pick<NedConfig, "sources">): string[] {
  const t = ["ToolSearch"];
  for (const k of Object.keys(READ_TOOLS) as (keyof typeof READ_TOOLS)[]) if (cfg.sources[k]) t.push(...READ_TOOLS[k]);
  return [...t, ...CHAT_BASH_READS];
}

/** Every option of a chat turn's `claude -p` (exported for tests: read-only by construction). */
export function chatRunOptions(cfg: NedConfig, system: string, resume: string | null) {
  return {
    allowedTools: chatTools(cfg),
    tools: ["ToolSearch", "Bash"], // built-ins: no Edit / Write / Read / WebFetch
    permissionMode: "plan" as const,
    maxTurns: CHAT_MAX_TURNS,
    model: cfg.claude_model,
    timeoutMs: 5 * 60_000,
    job: "chat" as const,
    appendSystemPrompt: system,
    includePartial: true,
    ...(resume ? { resume } : {}),
  };
}

// ---------- turns ----------

export type ChatEmit = (event: "start" | "delta" | "turn" | "tool" | "done" | "error", data: Record<string, unknown>) => void;

let active: { id: string; ctl: AbortController } | null = null;
export const activeChat = () => (active ? active.id : null);

export type ChatPrep = { ok: true; cfg: NedConfig; chat: Chat; text: string } | { ok: false; status: 400 | 404 | 409 | 429; error: string; budget?: boolean; conversation_id?: string };

/** Validate a POST /api/chat body and claim the single run slot (released by runChatTurn). */
export function prepareChatTurn(cfg: NedConfig, body: Record<string, unknown>): ChatPrep {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return { ok: false, status: 400, error: "text required" };
  if (text.length > CHAT_INPUT_MAX) return { ok: false, status: 400, error: `질문은 ${CHAT_INPUT_MAX}자까지야 (지금 ${text.length}자)` };
  let chat: Chat;
  if (body.conversation_id != null && body.conversation_id !== "") {
    const c = readChat(String(body.conversation_id));
    if (!c) return { ok: false, status: 404, error: "unknown conversation" };
    chat = c;
  } else chat = newChat();
  if (active) return { ok: false, status: 409, error: "다른 대화가 아직 진행 중이야 — 끝나거나 멈춘 뒤에 보내 줘", conversation_id: active.id };
  const spent = todayCost();
  if (!cfg.chat_ignore_budget && spent >= cfg.agenda_daily_budget_usd)
    return { ok: false, status: 429, budget: true, error: `오늘 사용량 $${spent.toFixed(2)} 가 하루 상한 $${cfg.agenda_daily_budget_usd} 에 닿았어. 설정 → Claude 에서 상한을 올리거나 config.yaml 의 chat_ignore_budget: true 로 대화만 예외로 둘 수 있어.` };
  active = { id: chat.id, ctl: new AbortController() };
  return { ok: true, cfg, chat, text };
}

/** POST /api/chat/:id/stop → SIGTERM the running turn. */
export function stopChat(id: string): boolean {
  if (!active || active.id !== id) return false;
  active.ctl.abort();
  return true;
}

/** Short tool label for the "찾아보는 중" line. */
export function toolLabel(name: string): string {
  const m = name.match(/^mcp__(?:claude_ai_)?([^_]+(?:_[A-Z][a-z]+)?)__(.+)$/);
  if (m) return `${m[1].replace(/_/g, " ")} · ${m[2]}`;
  return name;
}

/** NED_NO_LLM: stream a canned answer (NED_NO_LLM_CHAT, else an echo) in a few chunks; honours stop. */
async function stubTurn(chat: Chat, text: string, emit: ChatEmit, signal: AbortSignal): Promise<ClaudeRunResult> {
  const answer = process.env.NED_NO_LLM_CHAT || `(NED_NO_LLM) "${clip(text, 60)}" 잘 받았어.`;
  const delay = Number(process.env.NED_NO_LLM_DELAY_MS) || 0;
  const parts = answer.match(/[\s\S]{1,8}/g) ?? [answer];
  let sent = "";
  for (const p of parts) {
    if (signal.aborted) break;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (signal.aborted) break;
    sent += p;
    emit("delta", { text: p });
  }
  const cost = Number(process.env.NED_NO_LLM_COST) || 0;
  if (cost > 0) recordCost("chat", cost);
  if (signal.aborted) return { ok: false, text: sent, cost_usd: cost, num_turns: 1, duration_ms: 0, error: "aborted", aborted: true, session_id: chat.session_id ?? `stub-${chat.id}` };
  return { ok: true, text: answer, cost_usd: cost, num_turns: 1, duration_ms: 0, session_id: chat.session_id ?? `stub-${chat.id}` };
}

/** Recent transcript for a fresh session when `--resume` is gone (claude cleaned the session up). */
function transcriptPreamble(chat: Chat): string {
  const prev = chat.messages.slice(0, -1).slice(-8);
  if (!prev.length) return "";
  return `(이전 대화 — 이어서 답해)\n${prev.map((m) => `${m.role === "user" ? "나" : "Ned"}: ${clip(m.text, 400)}`).join("\n")}\n\n(새 질문)\n`;
}

/**
 * One turn: persist the question, stream the answer through `emit`, persist the answer (+ session id, cost).
 * Always releases the run slot and always ends with exactly one "done" or "error".
 */
export async function runChatTurn(prep: Extract<ChatPrep, { ok: true }>, emit: ChatEmit): Promise<void> {
  const { cfg, chat, text } = prep;
  const ctl = active?.id === chat.id ? active.ctl : new AbortController();
  const started = Date.now();
  try {
    if (!chat.title) chat.title = clip(text, 40);
    chat.messages.push({ role: "user", text, ts: started });
    chat.updated_at = started;
    saveChat(chat);
    emit("start", { conversation_id: chat.id, title: chat.title });

    let streamed = "";
    const onEvent = (j: Record<string, unknown>) => {
      if (j.type === "stream_event") {
        const ev = j.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (ev?.type === "message_start") {
          if (streamed) emit("turn", {});
          streamed = "";
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          streamed += ev.delta.text;
          emit("delta", { text: ev.delta.text });
        }
      } else if (j.type === "assistant") {
        const content = (j.message as { content?: { type?: string; name?: string }[] } | undefined)?.content ?? [];
        for (const c of content) if (c.type === "tool_use" && c.name && c.name !== "ToolSearch") emit("tool", { name: c.name, label: toolLabel(c.name) });
      }
    };

    let res: ClaudeRunResult;
    if (llmDisabled()) res = await stubTurn(chat, text, emit, ctl.signal);
    else {
      const system = buildChatSystemPrompt(cfg, liveChatContext(cfg));
      res = await runClaude(text, chatRunOptions(cfg, system, chat.session_id), { onEvent, signal: ctl.signal });
      if (!res.ok && !res.aborted && chat.session_id && /no conversation found|session/i.test(res.error ?? "")) {
        log(`chat ${chat.id}: resume ${chat.session_id} failed (${clip(res.error, 120)}) — new session with the transcript`);
        emit("turn", {});
        streamed = "";
        const first = res.cost_usd;
        res = await runClaude(transcriptPreamble(chat) + text, chatRunOptions(cfg, system, null), { onEvent, signal: ctl.signal });
        res.cost_usd += first;
      }
    }

    const cost = round(res.cost_usd || 0);
    if (res.session_id && !res.aborted) chat.session_id = res.session_id;
    else if (res.session_id && !chat.session_id) chat.session_id = res.session_id;
    chat.cost_usd = round(chat.cost_usd + cost);
    const answer = (res.ok ? res.text : res.text || streamed).trim();
    // A 확인 카드 may have been run/cancelled (POST /api/chat/:id/action) while this turn was going — keep those states.
    const disk = readChat(chat.id);
    for (const dm of disk?.messages ?? []) {
      const mm = dm.action && chat.messages.find((x) => x.role === dm.role && x.ts === dm.ts);
      if (mm) mm.action = dm.action;
    }
    const msg: ChatMessage = { role: "ned", text: answer, ts: Date.now(), cost_usd: cost };
    if (res.aborted) msg.stopped = true;
    else if (!res.ok) msg.error = clip(res.error || "실패", 300);
    chat.messages.push(msg);
    chat.updated_at = msg.ts;
    saveChat(chat);
    log(`chat ${chat.id}: ${res.aborted ? "stopped" : res.ok ? "ok" : `error ${clip(res.error, 120)}`} $${cost.toFixed(4)} ${res.num_turns} turns ${Date.now() - started}ms`);
    if (!res.ok && !res.aborted) emit("error", { conversation_id: chat.id, ts: msg.ts, error: msg.error, text: answer, cost_usd: cost, chat_cost_usd: chat.cost_usd, today_usd: todayCost() });
    else emit("done", { conversation_id: chat.id, ts: msg.ts, text: answer, stopped: !!res.aborted, cost_usd: cost, chat_cost_usd: chat.cost_usd, today_usd: todayCost() });
  } catch (e) {
    log(`chat ${chat.id}: unexpected ${String(e)}`);
    emit("error", { conversation_id: chat.id, error: String(e) });
  } finally {
    if (active?.id === chat.id) active = null;
  }
}

/** One SSE frame (data is single-line JSON). */
export const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
