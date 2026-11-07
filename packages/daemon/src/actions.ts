import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { archiveTouch } from "./archive.js";
import { buildClaudeArgs, extractJson, llmDisabled, runClaude, type ClaudeRunOptions } from "./claude.js";
import type { NedConfig } from "./config.js";
import { invalidateCalendarRanges } from "./calendar.js";
import { buildCalendarCreate, eventKey, type CalendarEventInput, type CreatedEvent } from "./calendar-create.js";
import { REF_FIELDS, githubTarget, jiraTarget, readDraft, sessionEvents, slackTarget, type DraftMeta, type DraftRef, type DraftSource } from "./drafts.js";
import { NED_HOME, log } from "./paths.js";

/** Append-only JSONL: one line per send attempt (allowed or not). */
export const SENT_ACTIONS_LOG = path.join(NED_HOME, "sent-actions.log");

export type SendSource = DraftSource | "calendar";
export type SendMode =
  | "send"
  | "gmail_draft"
  /** email: remove the UNREAD label from a thread (확인 완료 + config.actions.gmail_mark_read — see mail-read.ts). */
  | "mark_read"
  | "session"
  /** jira */
  | "comment"
  | "transitions"
  | "transition"
  /** github (+ "comment") */
  | "approve"
  | "request_changes"
  | "review_comment"
  /** calendar */
  | "rsvp"
  | "create";

/** Which modes each source takes, and whether `text` is required for it. */
export const SEND_MODES: Record<SendSource, Partial<Record<SendMode, { text: boolean }>>> = {
  slack: { send: { text: true } },
  email: { gmail_draft: { text: true }, send: { text: true }, mark_read: { text: false } },
  session: { session: { text: true } },
  jira: { comment: { text: true }, transitions: { text: false }, transition: { text: false } },
  github: { approve: { text: false }, request_changes: { text: true }, review_comment: { text: true }, comment: { text: true } },
  calendar: { rsvp: { text: false }, create: { text: false } },
};

export const RSVP_STATUSES = ["accepted", "declined", "tentative"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** DraftRef + the extra addressing wave-2 actions need. */
export interface ActionRef extends DraftRef {
  /** calendar */
  event_id?: string;
  calendar_id?: string;
  response?: string;
  /** jira transition */
  transition_id?: string;
  transition_name?: string;
}
const ACTION_REF_FIELDS = [...REF_FIELDS, "event_id", "calendar_id", "response", "transition_id", "transition_name"] as const;

export interface SendRequest {
  draft_id?: string;
  source: SendSource;
  ref: ActionRef;
  text: string;
  mode: SendMode;
  /** calendar `create` only (POST /api/calendar/events builds it — see calendar-create.ts). */
  event?: CalendarEventInput;
  /** "chat" = run from a Ned Net 확인 카드 (needs config.actions.chat_write too); absent = dashboard buttons. */
  origin?: ActionOrigin;
}

export type ActionOrigin = "chat";
/** `body.origin` → "chat" or undefined (anything else is ignored). */
export const parseOrigin = (v: unknown): ActionOrigin | undefined => (v === "chat" ? "chat" : undefined);

export interface SendResult {
  ok: boolean;
  action: string;
  detail: string;
  logged_at: string;
  /** HTTP status for the route (200 ok; 400 bad request; 403 disabled; 409 no target; 502 tool failed). */
  status: 200 | 400 | 403 | 409 | 502;
  /** jira `transitions` (read-only): the issue's available transitions. */
  transitions?: JiraTransition[];
  /** calendar `create`: the new event's id + htmlLink. */
  event?: CreatedEvent;
  /** session `create`: the new agent's worktree + terminal handle, and the stage that failed (if any). */
  session?: { worktree_path?: string; worktree_id?: string; handle?: string; stage?: string };
}

export interface JiraTransition {
  id: string;
  name: string;
  to?: string;
}

export interface ActionLogEntry {
  ts: string;
  source: string;
  mode: string;
  action: string;
  ref: ActionRef;
  draft_id?: string;
  text: string;
  ok: boolean;
  result: string;
  /** The exact `claude` argv for connector actions (audit: proves the single-tool allowlist). */
  claude_args?: string[];
  /** calendar `create`: the event identity (calendar|D/T|start|end|title) — 409 dedupe survives a restart. */
  event_key?: string;
  /** calendar `create` ok: the new event. */
  event?: CreatedEvent;
  /** "chat" when the Ned Net 확인 카드 ran it (설정 → 오늘 한 액션 shows a 대화창 badge). */
  origin?: ActionOrigin;
  /** session `create` (대화창에서 세션 만들기): what was started — see session-create.ts. */
  session_create?: { repo: string; worktree_mode: string; worktree_name: string; model: string; worktree_path?: string; handle?: string; stage?: string };
}

const MAX_TEXT = 4000;
const SLACK_SEND = "mcp__claude_ai_Slack__slack_send_message";
const GMAIL_DRAFT = "mcp__claude_ai_Gmail__create_draft";
const GMAIL_REPLY = "mcp__claude_ai_Gmail__reply";
export const GMAIL_UNLABEL_THREAD = "mcp__claude_ai_Gmail__unlabel_thread";
const JIRA_COMMENT = "mcp__claude_ai_Atlassian__addCommentToJiraIssue";
const JIRA_TRANSITIONS = "mcp__claude_ai_Atlassian__getTransitionsForJiraIssue";
const JIRA_TRANSITION = "mcp__claude_ai_Atlassian__transitionJiraIssue";
const CAL_RSVP = "mcp__claude_ai_Google_Calendar__respond_to_event";
/** Bash permission rules for the GitHub actions — the only Bash the child may run. */
const GH_REVIEW = "Bash(gh pr review:*)";
const GH_COMMENT = "Bash(gh pr comment:*)";
/** Review / comment bodies go through a file so the model never has to shell-quote user text. */
const ACTION_TMP = path.join(NED_HOME, "tmp");

export function appendActionLog(e: ActionLogEntry): void {
  try {
    fs.mkdirSync(NED_HOME, { recursive: true });
    fs.appendFileSync(SENT_ACTIONS_LOG, JSON.stringify(e) + "\n");
  } catch (err) {
    log(`actions: could not write ${SENT_ACTIONS_LOG}: ${String(err)}`);
  }
  if (e.ok && !e.action.startsWith("dry_run:") && e.mode !== "transitions") archiveTouch(Date.parse(e.ts), { immediate: true }); // Obsidian 아카이브 "보낸 것"
}

export interface ActionLogFilter {
  /** Only entries on/after this local date (YYYY-MM-DD) — "today" in the dashboard. */
  since?: string;
  source?: string;
  /** ok | refused | failed | dry_run */
  result?: string;
}

/** Outcome bucket for one log line (the dashboard's result filter). */
export function entryOutcome(e: Pick<ActionLogEntry, "ok" | "action">): "ok" | "refused" | "dry_run" | "failed" {
  return e.ok ? "ok" : e.action === "refused" ? "refused" : e.action.startsWith("dry_run:") ? "dry_run" : "failed";
}

/** Log entries matching `f`, newest first, at most `limit` (scans the whole file — it is small, one line per click). */
export function queryActionLog(f: ActionLogFilter = {}, limit = 200): ActionLogEntry[] {
  const since = f.since && /^\d{4}-\d{2}-\d{2}$/.test(f.since) ? new Date(`${f.since}T00:00:00`).getTime() : 0;
  return readActionLog(Number.MAX_SAFE_INTEGER)
    .filter((e) => (!since || Date.parse(e.ts) >= since) && (!f.source || e.source === f.source) && (!f.result || entryOutcome(e) === f.result))
    .slice(0, limit);
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
  const source = body.source as SendSource;
  const mode = body.mode as SendMode;
  const sources = Object.keys(SEND_MODES) as SendSource[];
  if (!sources.includes(source)) return `source must be ${sources.join(" | ")}`;
  const spec = SEND_MODES[source][mode];
  if (!spec) return `mode ${String(mode)} is not valid for source ${source} (${sources.map((s) => `${s}: ${Object.keys(SEND_MODES[s]).join(" | ")}`).join(" · ")})`;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (spec.text && !text) return "text required";
  if (text.length > MAX_TEXT) return `text longer than ${MAX_TEXT} chars`;
  const r = (body.ref && typeof body.ref === "object" ? body.ref : {}) as Record<string, unknown>;
  const ref: ActionRef = {};
  for (const k of ACTION_REF_FIELDS) {
    const v = typeof r[k] === "number" ? String(r[k]) : r[k];
    if (typeof v === "string" && v.trim()) ref[k] = v.trim().slice(0, 500);
  }
  const origin = parseOrigin(body.origin);
  return { source, mode, text, ref, draft_id: typeof body.draft_id === "string" ? body.draft_id.slice(0, 40) : undefined, ...(origin ? { origin } : {}) };
}

/** Which config.actions switch gates this (source, mode). */
export function gateKey(req: Pick<SendRequest, "source" | "mode">): keyof NedConfig["actions"] {
  switch (req.source) {
    case "slack":
      return "slack_send";
    case "session":
      return "session_send";
    case "email":
      return req.mode === "gmail_draft" ? "gmail_draft" : req.mode === "mark_read" ? "gmail_mark_read" : "gmail_send";
    case "jira":
      return req.mode === "comment" ? "jira_comment" : "jira_transition"; // listing transitions is only for the transition flow
    case "github":
      return "github_review";
    case "calendar":
      return req.mode === "create" ? "calendar_create" : "calendar_rsvp";
  }
}
/** The switch that refuses `req` (its own gate, then chat_write for origin "chat"), or on:true. */
export function gate(req: Pick<SendRequest, "source" | "mode" | "origin">, cfg: NedConfig): { key: keyof NedConfig["actions"]; on: boolean } {
  const key = gateKey(req);
  if (cfg.actions[key] !== true) return { key, on: false };
  if (req.origin === "chat" && cfg.actions.chat_write !== true) return { key: "chat_write", on: false };
  return { key, on: true };
}

/** Run options for a connector action: dontAsk + ONLY ToolSearch and the one write tool; no other built-ins. */
export function actionRunOptions(tool: string, cfg: NedConfig): ClaudeRunOptions {
  return { allowedTools: ["ToolSearch", tool], tools: ["ToolSearch"], permissionMode: "dontAsk", maxTurns: 4, model: cfg.claude_model, timeoutMs: 2 * 60_000, job: "action" };
}

/** Run options for a `gh` action: dontAsk + the Bash tool only, allowed for ONE command prefix (e.g. `Bash(gh pr review:*)`). */
export function bashActionRunOptions(rule: string, cfg: NedConfig): ClaudeRunOptions {
  return { allowedTools: [rule], tools: ["Bash"], permissionMode: "dontAsk", maxTurns: 3, model: cfg.claude_model, timeoutMs: 2 * 60_000, job: "action" };
}

type Verify = (text: string) => { ok: boolean; detail: string; transitions?: JiraTransition[]; event?: CreatedEvent };
export interface BuiltAction {
  tool: string;
  prompt: string;
  action: string;
  /** Overrides actionRunOptions(tool) — the gh actions run Bash. */
  opts?: (cfg: NedConfig) => ClaudeRunOptions;
  verify?: Verify;
  /** A read-only check after `verify` passed (gh review: did my review land on the PR?). */
  postVerify?: () => Promise<{ ok: boolean; detail: string }>;
  /** A file to delete after the run (gh body file). */
  cleanup?: string;
}

function gh(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => execFile("gh", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (e, out, se) => resolve({ ok: !e, out, err: (se || e?.message || "").slice(0, 300) })));
}

/** Read-only: is there a review by me on repo#num in `state`, submitted after `sinceMs`? */
export async function myLatestReview(repo: string, num: string, state: string, sinceMs: number): Promise<{ ok: boolean; detail: string }> {
  const [me, pr] = await Promise.all([gh(["api", "user", "--jq", ".login"]), gh(["pr", "view", num, "--repo", repo, "--json", "reviews,url"])]);
  if (!me.ok || !pr.ok) return { ok: false, detail: `unverified: gh read-back failed: ${me.err || pr.err}` };
  try {
    const j = JSON.parse(pr.out) as { url: string; reviews: { author?: { login: string }; state: string; submittedAt: string; id?: string }[] };
    const login = me.out.trim();
    const hit = j.reviews.filter((r) => r.author?.login === login && r.state === state && Date.parse(r.submittedAt) >= sinceMs).pop();
    return hit ? { ok: true, detail: `${state} by @${login} at ${hit.submittedAt} — ${j.url}` } : { ok: false, detail: `unverified: no ${state} review by @${login} on ${repo}#${num} since ${new Date(sinceMs).toISOString()}` };
  } catch (e) {
    return { ok: false, detail: `unverified: ${String(e).slice(0, 200)}` };
  }
}

const RULES =
  "규칙: 이 도구 하나만, 한 번만 호출한다. 텍스트는 글자 하나 바꾸지 말고 그대로 보낸다(아래 JSON 문자열을 디코드한 값). 다른 도구·다른 대상·추가 메시지 금지. 실패하면 재시도하지 말고 실패를 보고한다.";

const parsed = (text: string) => extractJson<{ ok?: boolean; error?: string } & Record<string, unknown>>(text);
/** ok:true JSON whose `field` satisfies `test`, else a failed / unverified detail. */
function verifyField(text: string, field: string, test: (v: unknown) => boolean, show: (j: Record<string, unknown>) => string): { ok: boolean; detail: string } {
  const j = parsed(text);
  if (!j) return { ok: false, detail: `unverified: no JSON in model output: ${text.slice(0, 200)}` };
  if (j.ok !== true) return { ok: false, detail: `failed: ${String(j.error ?? "ok != true").slice(0, 300)}` };
  return test(j[field]) ? { ok: true, detail: show(j) } : { ok: false, detail: `unverified: no ${field} in ${JSON.stringify(j).slice(0, 200)}` };
}
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Jira / GitHub / Calendar actions (wave 2). */
export function buildWave2Action(req: SendRequest, meta: DraftMeta, now = Date.now()): BuiltAction | string {
  const body = JSON.stringify(req.text);
  if (req.source === "jira") {
    const t = jiraTarget(req.ref);
    const key = t.key ?? meta.issue_key, cloud = t.cloud_id ?? meta.cloud_id;
    if (!key || !cloud) return "jira target unknown: ref.url (https://<site>.atlassian.net/browse/KEY-1) required";
    const addr = `cloudId=\`${cloud}\`, issueIdOrKey=\`${key}\``;
    if (req.mode === "comment") {
      return {
        tool: JIRA_COMMENT,
        action: `jira_comment ${key}`,
        prompt: [
          `add exactly this comment to Jira issue ${key} and reply with the new comment id.`,
          `먼저 ToolSearch 로 \`select:${JIRA_COMMENT}\` 를 로드한 뒤 ${JIRA_COMMENT} 를 ${addr}, contentFormat="markdown", commentBody=<아래 텍스트> 로 호출한다 (commentId 없음 — 새 코멘트).`,
          RULES,
          `commentBody (JSON string): ${body}`,
          `출력은 JSON 하나만: 성공 {"ok":true,"id":"<comment id>"} / 실패 {"ok":false,"error":"이유"}`,
        ].join("\n"),
        verify: (x) => verifyField(x, "id", nonEmpty, (j) => `comment ${String(j.id)} on ${key}`),
      };
    }
    if (req.mode === "transitions") {
      return {
        tool: JIRA_TRANSITIONS,
        action: `jira_transitions ${key}`,
        prompt: [
          `list the available status transitions of Jira issue ${key} (read only).`,
          `먼저 ToolSearch 로 \`select:${JIRA_TRANSITIONS}\` 를 로드한 뒤 ${JIRA_TRANSITIONS} 를 ${addr} 로 한 번 호출한다. 이 도구 말고는 아무것도 호출하지 않는다.`,
          `출력은 JSON 하나만: 성공 {"ok":true,"transitions":[{"id":"<transition id>","name":"<transition 이름>","to":"<도착 상태 이름>"}]} / 실패 {"ok":false,"error":"이유"}`,
        ].join("\n"),
        verify: (x) => {
          const j = parsed(x);
          if (!j) return { ok: false, detail: `unverified: no JSON in model output: ${x.slice(0, 200)}` };
          if (j.ok !== true || !Array.isArray(j.transitions)) return { ok: false, detail: `failed: ${String(j.error ?? "no transitions").slice(0, 300)}` };
          const transitions = (j.transitions as Record<string, unknown>[])
            .filter((t) => t && /^\d+$/.test(String(t.id ?? "")) && nonEmpty(t.name))
            .map((t) => ({ id: String(t.id), name: String(t.name).slice(0, 80), to: nonEmpty(t.to) ? String(t.to).slice(0, 80) : undefined }));
          return { ok: true, detail: `${transitions.length} transitions: ${transitions.map((t) => t.name).join(", ")}`.slice(0, 300), transitions };
        },
      };
    }
    // transition
    const tid = req.ref.transition_id;
    if (!tid || !/^\d+$/.test(tid)) return "ref.transition_id (numeric, from mode=transitions) required";
    const label = req.ref.transition_name ? ` (${req.ref.transition_name.slice(0, 80)})` : "";
    return {
      tool: JIRA_TRANSITION,
      action: `jira_transition ${key} → ${tid}${label}`,
      prompt: [
        `move Jira issue ${key} through transition id ${tid}${label} and reply with the result.`,
        `먼저 ToolSearch 로 \`select:${JIRA_TRANSITION}\` 를 로드한 뒤 ${JIRA_TRANSITION} 를 ${addr}, transition={"id":"${tid}"} 로 호출한다 (fields / update 없음).`,
        RULES,
        `출력은 JSON 하나만: 성공 {"ok":true,"id":"${tid}"} / 실패 {"ok":false,"error":"이유"}`,
      ].join("\n"),
      verify: (x) => verifyField(x, "id", (v) => String(v) === tid, () => `${key} → transition ${tid}${label}`),
    };
  }

  if (req.source === "github") {
    const g = githubTarget(req.ref);
    const repo = g.repo ?? meta.repo, num = g.number ?? meta.number;
    if (!repo || !num) return "github target unknown: ref.repo + ref.number or a PR ref.url required";
    const bodyFile = req.text ? path.join(ACTION_TMP, `gh-body-${now}-${Math.random().toString(36).slice(2, 8)}.md`) : undefined;
    const flag = req.mode === "approve" ? "--approve" : req.mode === "request_changes" ? "--request-changes" : "--comment";
    const isComment = req.mode === "comment";
    const cmd = isComment
      ? `gh pr comment ${num} --repo ${repo} --body-file ${shq(bodyFile!)}`
      : `gh pr review ${num} --repo ${repo} ${flag}${bodyFile ? ` --body-file ${shq(bodyFile)}` : ""}`;
    const rule = isComment ? GH_COMMENT : GH_REVIEW;
    const okRe = new RegExp(`github\\.com/${repo.replace(/[.]/g, "\\.")}/pull/${num}#issuecomment-\\d+`);
    const state = req.mode === "approve" ? "APPROVED" : req.mode === "request_changes" ? "CHANGES_REQUESTED" : "COMMENTED";
    return {
      tool: rule,
      action: `github_${req.mode} ${repo}#${num}`,
      cleanup: bodyFile,
      prompt: [
        `run exactly this one shell command once and report its output.`,
        "```",
        cmd,
        "```",
        "규칙: 위 명령을 글자 하나 바꾸지 말고 Bash 로 한 번만 실행한다. 다른 명령·파일 읽기·재시도 금지. 본문은 이미 파일에 있다.",
        `출력은 JSON 하나만: {"ok":<종료 코드 0 이면 true>,"output":"<stdout+stderr 그대로, 500자 이내>"} / 실행 못 했으면 {"ok":false,"error":"이유"}`,
      ].join("\n"),
      opts: (cfg) => bashActionRunOptions(rule, cfg),
      // `gh pr comment` prints the comment URL; `gh pr review` prints nothing off a TTY, so Ned reads the PR's reviews back (read-only).
      verify: isComment
        ? (x) => verifyField(x, "output", (v) => typeof v === "string" && okRe.test(v), (j) => String(j.output).match(okRe)?.[0] ?? "")
        : (x) => verifyField(x, "ok", (v) => v === true, () => "gh exited 0"),
      postVerify: isComment ? undefined : () => myLatestReview(repo, num, state, now - 60_000),
    };
  }

  if (req.mode === "create") return buildCalendarCreate(req);
  // calendar rsvp
  const ev = req.ref.event_id;
  const resp = req.ref.response as RsvpStatus | undefined;
  if (!ev || !/^[\w@.-]{3,200}$/.test(ev)) return "ref.event_id required";
  if (!resp || !RSVP_STATUSES.includes(resp)) return `ref.response must be ${RSVP_STATUSES.join(" | ")}`;
  const cal = req.ref.calendar_id && /^[\w@.+-]{3,200}$/.test(req.ref.calendar_id) ? req.ref.calendar_id : undefined;
  const fields = [`eventId=\`${ev}\``, cal && `calendarId=\`${cal}\``, `responseStatus="${resp}"`, req.text && "responseComment=<아래 텍스트>"].filter(Boolean).join(", ");
  return {
    tool: CAL_RSVP,
    action: `calendar_rsvp ${resp} ${ev}`,
    prompt: [
      `respond "${resp}" to Google Calendar event ${ev} and report the result.`,
      `먼저 ToolSearch 로 \`select:${CAL_RSVP}\` 를 로드한 뒤 ${CAL_RSVP} 를 ${fields} 로 호출한다.`,
      RULES,
      req.text ? `responseComment (JSON string): ${body}` : "",
      `출력은 JSON 하나만: 성공 {"ok":true,"status":"${resp}"} / 실패 {"ok":false,"error":"이유"}`,
    ].filter(Boolean).join("\n"),
    verify: (x) => verifyField(x, "status", (v) => v === resp, () => `${ev} → ${resp}${req.ref.title ? ` (${req.ref.title.slice(0, 80)})` : ""}`),
  };
}

/** The prompt + tool for a connector action, or an error string (missing address). */
export function buildActionPrompt(req: SendRequest, meta: DraftMeta): BuiltAction | string {
  if (req.source === "jira" || req.source === "github" || req.source === "calendar") return buildWave2Action(req, meta);
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
  if (req.mode === "mark_read") return buildMarkRead(req);
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

/** Gmail thread ids: hex (API) or the web UI's `thread-f:<n>` form; nothing that could smuggle text into the prompt. */
export const GMAIL_THREAD_ID = /^[\w:.-]{1,200}$/;

/** email mark_read: unlabel_thread(threadId, UNREAD) — the one tool, dontAsk, maxTurns 3. Never touches other labels. */
export function buildMarkRead(req: SendRequest): BuiltAction | string {
  const tid = req.ref.thread_id;
  if (!tid || !GMAIL_THREAD_ID.test(tid)) return "ref.thread_id (Gmail thread id) required";
  return {
    tool: GMAIL_UNLABEL_THREAD,
    action: `gmail_mark_read ${tid}`,
    prompt: [
      `mark Gmail thread ${tid} as read by removing ONLY its UNREAD label, then report the result.`,
      `먼저 ToolSearch 로 \`select:${GMAIL_UNLABEL_THREAD}\` 를 로드한 뒤 ${GMAIL_UNLABEL_THREAD} 를 스레드 id \`${tid}\`, 제거할 라벨 ["UNREAD"] 로 한 번 호출한다.`,
      "규칙: 이 도구 하나만, 한 번만 호출한다. UNREAD 외 다른 라벨·다른 스레드는 건드리지 않는다. 메일 내용 읽기·보내기·삭제 금지. 실패하면 재시도하지 말고 실패를 보고한다.",
      `출력은 JSON 하나만: 성공 {"ok":true,"id":"${tid}"} / 실패 {"ok":false,"error":"이유"}`,
    ].join("\n"),
    opts: (cfg) => ({ ...actionRunOptions(GMAIL_UNLABEL_THREAD, cfg), maxTurns: 3 }),
    verify: (x) => verifyField(x, "id", nonEmpty, () => `thread ${tid} → read (UNREAD removed)`),
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

export interface OrcaResult {
  ok: boolean;
  json: unknown;
  err: string;
}
/** `orca <args>` (JSON stdout parsed when it is JSON). Injectable wherever Orca writes happen (see session-create.ts). */
export type OrcaExec = (args: string[], timeoutMs?: number) => Promise<OrcaResult>;

export const orca: OrcaExec = (args, timeoutMs = 20_000) => {
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
};

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
  const entry: ActionLogEntry = { ts: logged_at, source: req.source, mode: req.mode, action: "", ref: req.ref, draft_id: req.draft_id, text: req.text.slice(0, 120), ok: false, result: "", ...(req.origin ? { origin: req.origin } : {}) };
  if (req.event) entry.event_key = eventKey(req.event);
  const finish = (status: SendResult["status"], ok: boolean, action: string, detail: string, event?: CreatedEvent): SendResult => {
    appendActionLog({ ...entry, action, ok, result: detail, ...(event ? { event } : {}) });
    log(`send: ${req.source}/${req.mode} ${action} → ${ok ? "ok" : action.startsWith("dry_run:") ? "dry-run" : `FAIL(${status})`} ${detail.slice(0, 160)}`);
    return { ok, action, detail, logged_at, status, ...(event ? { event } : {}) };
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
  const opts = built.opts ? built.opts(cfg) : actionRunOptions(built.tool, cfg);
  entry.claude_args = ["claude", ...buildClaudeArgs(opts)];
  if (llmDisabled() || process.env.NED_SEND_DRY_RUN === "1") {
    log(`send: dry run — ${JSON.stringify(entry.claude_args)}\n--- prompt ---\n${built.prompt}\n---`);
    const out = finish(200, false, `dry_run:${built.action}`, `not executed (${llmDisabled() ? "NED_NO_LLM=1" : "NED_SEND_DRY_RUN=1"}); argv logged`);
    // NED_NO_LLM: stub transitions so the dashboard's transition picker can be exercised offline (clearly marked).
    return req.mode === "transitions" && llmDisabled() ? { ...out, transitions: [{ id: "11", name: "(stub) 진행 중", to: "In Progress" }, { id: "21", name: "(stub) 완료", to: "Done" }] } : out;
  }

  if (built.cleanup) {
    fs.mkdirSync(path.dirname(built.cleanup), { recursive: true });
    fs.writeFileSync(built.cleanup, req.text, { mode: 0o600 });
  }
  try {
    const res = await runClaude(built.prompt, opts);
    if (!res.ok) return finish(502, false, built.action, `claude failed: ${(res.error ?? res.text).slice(0, 300)}`);
    let v: { ok: boolean; detail: string; transitions?: JiraTransition[]; event?: CreatedEvent } = built.verify ? built.verify(res.text) : verifyActionOutput(req.source as DraftSource, res.text);
    if (v.ok && built.postVerify) v = await built.postVerify();
    if (v.ok && req.event) invalidateCalendarRanges(req.event.start.slice(0, 10), req.event.end.slice(0, 10));
    const out = finish(v.ok ? 200 : 502, v.ok, built.action, `${v.detail} ($${res.cost_usd.toFixed(3)})`, v.ok ? v.event : undefined);
    return v.transitions ? { ...out, transitions: v.transitions } : out;
  } finally {
    if (built.cleanup) fs.rmSync(built.cleanup, { force: true });
  }
}
