import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildClaudeArgs, extractJson, llmDisabled, runClaude, type ClaudeRunOptions } from "./claude.js";
import type { NedConfig } from "./config.js";
import { readDraft, sessionEvents, slackTarget, type DraftMeta, type DraftRef, type DraftSource } from "./drafts.js";
import { NED_HOME, log } from "./paths.js";

/** Append-only JSONL: one line per send attempt (allowed or not). */
export const SENT_ACTIONS_LOG = path.join(NED_HOME, "sent-actions.log");

export type SendMode = "send" | "gmail_draft" | "session";

export interface SendRequest {
  draft_id?: string;
  source: DraftSource;
  ref: DraftRef;
  text: string;
  mode: SendMode;
}

export interface SendResult {
  ok: boolean;
  action: string;
  detail: string;
  logged_at: string;
  /** HTTP status for the route (200 ok; 400 bad request; 403 disabled; 409 no target; 502 tool failed). */
  status: 200 | 400 | 403 | 409 | 502;
}

export interface ActionLogEntry {
  ts: string;
  source: string;
  mode: string;
  action: string;
  ref: DraftRef;
  draft_id?: string;
  text: string;
  ok: boolean;
  result: string;
  /** The exact `claude` argv for connector actions (audit: proves the single-tool allowlist). */
  claude_args?: string[];
}

const MAX_TEXT = 4000;
const SLACK_SEND = "mcp__claude_ai_Slack__slack_send_message";
const GMAIL_DRAFT = "mcp__claude_ai_Gmail__create_draft";
const GMAIL_REPLY = "mcp__claude_ai_Gmail__reply";

function appendLog(e: ActionLogEntry): void {
  try {
    fs.mkdirSync(NED_HOME, { recursive: true });
    fs.appendFileSync(SENT_ACTIONS_LOG, JSON.stringify(e) + "\n");
  } catch (err) {
    log(`actions: could not write ${SENT_ACTIONS_LOG}: ${String(err)}`);
  }
}

/** Last `limit` log entries, newest first. */
export function readActionLog(limit = 50): ActionLogEntry[] {
  try {
    const lines = fs.readFileSync(SENT_ACTIONS_LOG, "utf8").split("\n").filter(Boolean);
    const out: ActionLogEntry[] = [];
    for (const l of lines.slice(-limit).reverse()) {
      try {
        out.push(JSON.parse(l) as ActionLogEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Coerce a POST /api/send body; returns an error string for a 400. */
export function parseSendRequest(body: Record<string, unknown>): SendRequest | string {
  const source = body.source as DraftSource;
  const mode = body.mode as SendMode;
  if (!["slack", "email", "session"].includes(source)) return "source must be slack | email | session";
  const okMode = source === "slack" ? mode === "send" : source === "email" ? mode === "send" || mode === "gmail_draft" : mode === "session";
  if (!okMode) return `mode ${String(mode)} is not valid for source ${source} (slack: send · email: gmail_draft | send · session: session)`;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return "text required";
  if (text.length > MAX_TEXT) return `text longer than ${MAX_TEXT} chars`;
  const r = (body.ref && typeof body.ref === "object" ? body.ref : {}) as Record<string, unknown>;
  const ref: DraftRef = {};
  for (const k of ["url", "channel", "ts", "thread_ts", "thread_id", "message_id", "session_id", "title", "text"] as const) if (typeof r[k] === "string" && (r[k] as string).trim()) ref[k] = (r[k] as string).trim().slice(0, 500);
  return { source, mode, text, ref, draft_id: typeof body.draft_id === "string" ? body.draft_id.slice(0, 40) : undefined };
}

/** Which config.actions switch gates this (source, mode). */
function gate(req: SendRequest, cfg: NedConfig): { key: keyof NedConfig["actions"]; on: boolean } {
  const key = req.source === "slack" ? "slack_send" : req.source === "session" ? "session_send" : req.mode === "gmail_draft" ? "gmail_draft" : "gmail_send";
  return { key, on: cfg.actions[key] === true };
}

/** Run options for a connector action: dontAsk + ONLY ToolSearch and the one write tool; no other built-ins. */
export function actionRunOptions(tool: string, cfg: NedConfig): ClaudeRunOptions {
  return { allowedTools: ["ToolSearch", tool], tools: ["ToolSearch"], permissionMode: "dontAsk", maxTurns: 4, model: cfg.claude_model, timeoutMs: 2 * 60_000 };
}

/** The prompt + tool for a Slack / Gmail action, or an error string (missing address). */
export function buildActionPrompt(req: SendRequest, meta: DraftMeta): { tool: string; prompt: string; action: string } | string {
  const body = JSON.stringify(req.text);
  const rules =
    "규칙: 이 도구 하나만, 한 번만 호출한다. 텍스트는 글자 하나 바꾸지 말고 그대로 보낸다(아래 JSON 문자열을 디코드한 값). 다른 도구·다른 대상·추가 메시지 금지. 실패하면 재시도하지 말고 실패를 보고한다.";
  if (req.source === "slack") {
    const t = slackTarget(req.ref);
    const channel = t.channel_id ?? meta.channel_id;
    if (!channel) return "slack target unknown: ref.url (permalink) or ref.channel (channel id) required";
    const thread = req.ref.thread_ts ?? t.thread_ts ?? meta.thread_ts ?? (channel.startsWith("D") ? undefined : t.ts);
    const where = thread ? `channel_id=\`${channel}\`, thread_ts=\`${thread}\` (스레드 답글, reply_broadcast 없음)` : `channel_id=\`${channel}\` (채널 메시지)`;
    return {
      tool: SLACK_SEND,
      action: thread ? `slack_thread_reply ${channel}/${thread}` : `slack_message ${channel}`,
      prompt: [
        `send exactly this text to Slack ${where} and reply with the message permalink.`,
        `먼저 ToolSearch 로 \`select:${SLACK_SEND}\` 를 로드한 뒤 ${SLACK_SEND} 를 ${where} 로 호출한다.`,
        rules,
        `message (JSON string): ${body}`,
        `출력은 JSON 하나만: 성공 {"ok":true,"permalink":"https://…slack.com/archives/…"} / 실패 {"ok":false,"error":"이유"}`,
      ].join("\n"),
    };
  }
  // email
  const messageId = req.ref.message_id ?? meta.message_id;
  if (!messageId) return "email target unknown: ref.message_id required (POST /api/draft fills it — pass draft_id)";
  if (req.mode === "gmail_draft") {
    const fields = [`replyToMessageId=\`${messageId}\``, meta.reply_to && `to=[\`${meta.reply_to}\`]`, meta.subject && `subject=${JSON.stringify(meta.subject)}`, "body=<아래 텍스트>"].filter(Boolean).join(", ");
    return {
      tool: GMAIL_DRAFT,
      action: `gmail_reply_draft ${messageId}`,
      prompt: [
        `create a Gmail reply DRAFT (do not send) with exactly this body and reply with the draft id.`,
        `먼저 ToolSearch 로 \`select:${GMAIL_DRAFT}\` 를 로드한 뒤 ${GMAIL_DRAFT} 를 ${fields} 로 호출한다.`,
        rules,
        `body (JSON string): ${body}`,
        `출력은 JSON 하나만: 성공 {"ok":true,"id":"<draft id>","url":"<viewUrl>"} / 실패 {"ok":false,"error":"이유"}`,
      ].join("\n"),
    };
  }
  return {
    tool: GMAIL_REPLY,
    action: `gmail_reply ${messageId}`,
    prompt: [
      `send exactly this text as a Gmail reply and reply with the sent message id.`,
      `먼저 ToolSearch 로 \`select:${GMAIL_REPLY}\` 를 로드한 뒤 ${GMAIL_REPLY} 를 messageId=\`${messageId}\`, body=<아래 텍스트> 로 호출한다 (replyAll 없음).`,
      rules,
      `body (JSON string): ${body}`,
      `출력은 JSON 하나만: 성공 {"ok":true,"id":"<message id>"} / 실패 {"ok":false,"error":"이유"}`,
    ].join("\n"),
  };
}

/** Did the model's report prove the action happened? Slack needs a permalink; Gmail an id. */
export function verifyActionOutput(source: DraftSource, text: string): { ok: boolean; detail: string } {
  const j = extractJson<{ ok?: boolean; permalink?: string; id?: string; url?: string; error?: string }>(text);
  if (!j) return { ok: false, detail: `unverified: no JSON in model output: ${text.slice(0, 200)}` };
  if (j.ok !== true) return { ok: false, detail: `failed: ${String(j.error ?? "ok != true").slice(0, 300)}` };
  if (source === "slack") {
    const link = typeof j.permalink === "string" && /^https:\/\/[^\s"]*slack\.com\/archives\/[A-Z0-9]+\/p\d+/.test(j.permalink) ? j.permalink : null;
    return link ? { ok: true, detail: link } : { ok: false, detail: `unverified: no permalink in ${JSON.stringify(j).slice(0, 200)}` };
  }
  return typeof j.id === "string" && j.id.trim() ? { ok: true, detail: j.url ? `${j.id} ${j.url}` : j.id } : { ok: false, detail: `unverified: no id in ${JSON.stringify(j).slice(0, 200)}` };
}

// ---------------------------------------------------------------------------------------------- session → Orca

const ORCA_FALLBACK = "/Applications/Orca.app/Contents/Resources/bin/orca";

function orcaBin(): string {
  const onPath = (process.env.PATH ?? "").split(":").map((d) => path.join(d, "orca")).find((p) => fs.existsSync(p));
  return onPath ?? (fs.existsSync(ORCA_FALLBACK) ? ORCA_FALLBACK : "orca");
}

function orca(args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; json: unknown; err: string }> {
  return new Promise((resolve) => {
    execFile(orcaBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* not json */
      }
      resolve({ ok: !error, json, err: (stderr || error?.message || "").slice(0, 400) });
    });
  });
}

interface OrcaTerminal {
  handle: string;
  tabId?: string;
  leafId?: string;
  worktreePath?: string;
  connected?: boolean;
  writable?: boolean;
  title?: string;
}

/** The session's Orca pane from its hook events: orca_pane = "<tabId>:<leafId>", orca_tab = tabId. */
export function sessionPane(sessionId: string): { tab?: string; leaf?: string } | null {
  const ev = [...sessionEvents(sessionId)].reverse().find((e) => e.orca_pane || e.orca_tab);
  if (!ev) return null;
  const [tab, leaf] = String(ev.orca_pane ?? "").split(":");
  return { tab: (ev.orca_tab as string | undefined) ?? (tab || undefined), leaf: leaf || undefined };
}

/** Map a pane to a live terminal handle: exact leaf match first, then a tab with a single terminal. */
export function matchTerminal(terms: OrcaTerminal[], pane: { tab?: string; leaf?: string }): OrcaTerminal | null {
  const live = terms.filter((t) => t.connected !== false && t.writable !== false);
  if (pane.leaf) {
    const byLeaf = live.find((t) => t.leafId === pane.leaf && (!pane.tab || t.tabId === pane.tab));
    if (byLeaf) return byLeaf;
  }
  if (pane.tab) {
    const inTab = live.filter((t) => t.tabId === pane.tab);
    if (inTab.length === 1) return inTab[0];
  }
  return null;
}

async function sendToSession(req: SendRequest): Promise<{ status: 200 | 400 | 409 | 502; ok: boolean; action: string; detail: string }> {
  const sid = req.ref.session_id;
  if (!sid) return { status: 400, ok: false, action: "session_send", detail: "ref.session_id required" };
  const pane = sessionPane(sid);
  if (!pane) return { status: 409, ok: false, action: "session_send", detail: `세션 ${sid.slice(0, 8)} 은 Orca 터미널에서 실행된 기록이 없어 보낼 곳이 없다 (orca_pane 이벤트 없음). 터미널에서 직접 입력해줘.` };
  const list = await orca(["terminal", "list", "--json"]);
  const terms = ((list.json as { result?: { terminals?: OrcaTerminal[] } })?.result?.terminals ?? []) as OrcaTerminal[];
  if (!list.ok && !terms.length) return { status: 502, ok: false, action: "session_send", detail: `orca terminal list 실패: ${list.err}` };
  const t = matchTerminal(terms, pane);
  if (!t) return { status: 409, ok: false, action: "session_send", detail: `세션 ${sid.slice(0, 8)} 의 Orca 터미널(tab ${pane.tab?.slice(0, 8) ?? "?"} / pane ${pane.leaf?.slice(0, 8) ?? "?"})이 지금 열려 있지 않다. 닫혔거나 다른 창으로 옮겨졌다.` };
  const sent = await orca(["terminal", "send", "--terminal", t.handle, "--text", req.text, "--enter", "--json"]);
  const ok = sent.ok && (sent.json as { ok?: boolean } | null)?.ok !== false;
  return {
    status: ok ? 200 : 502,
    ok,
    action: `orca_terminal_send ${t.handle}`,
    detail: ok ? `sent to ${t.title ?? t.handle} (${t.worktreePath ?? ""})` : `orca terminal send 실패: ${sent.err || JSON.stringify(sent.json).slice(0, 300)}`,
  };
}

// ---------------------------------------------------------------------------------------------- entry point

/**
 * The one place Ned writes anywhere. Gated per source/mode by config.actions; every attempt — allowed,
 * refused or failed — is appended to ~/.ned/sent-actions.log. Connector actions run `claude -p` in dontAsk mode
 * with ONLY ToolSearch + the single write tool allowed. `NED_NO_LLM=1` or `NED_SEND_DRY_RUN=1` builds and logs
 * the exact argv but does not spawn claude (returns ok:false, action "dry_run:…").
 */
export async function performSend(req: SendRequest, cfg: NedConfig): Promise<SendResult> {
  const logged_at = new Date().toISOString();
  const entry: ActionLogEntry = { ts: logged_at, source: req.source, mode: req.mode, action: "", ref: req.ref, draft_id: req.draft_id, text: req.text.slice(0, 120), ok: false, result: "" };
  const finish = (status: SendResult["status"], ok: boolean, action: string, detail: string): SendResult => {
    appendLog({ ...entry, action, ok, result: detail });
    log(`send: ${req.source}/${req.mode} ${action} → ${ok ? "ok" : action.startsWith("dry_run:") ? "dry-run" : `FAIL(${status})`} ${detail.slice(0, 160)}`);
    return { ok, action, detail, logged_at, status };
  };

  const g = gate(req, cfg);
  if (!g.on) return finish(403, false, "refused", `config.actions.${g.key} is off — turn it on in settings to allow this`);

  if (req.source === "session") {
    const r = await sendToSession(req);
    return finish(r.status, r.ok, r.action, r.detail);
  }

  const meta: DraftMeta = req.draft_id ? (readDraft(req.draft_id)?.meta ?? {}) : {};
  const built = buildActionPrompt(req, meta);
  if (typeof built === "string") return finish(400, false, "invalid", built);
  const opts = actionRunOptions(built.tool, cfg);
  entry.claude_args = ["claude", ...buildClaudeArgs(opts)];
  if (llmDisabled() || process.env.NED_SEND_DRY_RUN === "1") {
    log(`send: dry run — ${JSON.stringify(entry.claude_args)}\n--- prompt ---\n${built.prompt}\n---`);
    return finish(200, false, `dry_run:${built.action}`, `not executed (${llmDisabled() ? "NED_NO_LLM=1" : "NED_SEND_DRY_RUN=1"}); argv logged`);
  }

  const res = await runClaude(built.prompt, opts);
  if (!res.ok) return finish(502, false, built.action, `claude failed: ${(res.error ?? res.text).slice(0, 300)}`);
  const v = verifyActionOutput(req.source, res.text);
  return finish(v.ok ? 200 : 502, v.ok, built.action, `${v.detail} ($${res.cost_usd.toFixed(3)})`);
}
