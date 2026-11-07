/**
 * 대화창에서 세션 만들기 — POST /api/sessions/create (config.actions.chat_session_create, default off).
 *
 * Ned 대화창(Ned Net)이 `session_create` 제안 블록을 내면 확인 카드에서 사용자가 [실행] → 여기.
 *   1. 검증(동기, 거절은 즉시 응답 + sent-actions.log): 토글 on · repo 가 Orca 등록 레포 · 대화창 출처로 시작해
 *      아직 살아 있는 세션 < CHAT_SESSION_CAP(2).
 *   2. 백그라운드 job(send-jobs 의 startTaskJob — 202 + GET 폴링, stage 표시):
 *      new      → `orca worktree create --name <n> --repo path:<repo> --parent-worktree path:<repo> --agent claude --model <m> --surface terminal`
 *      existing → `orca agent launch --agent claude --worktree path:<wt> --model <m> --surface terminal`
 *      `--prompt` 는 쓰지 않는다(초안으로만 남고 제출되지 않는 버그) → 에이전트가 뜨기를 기다렸다가
 *      (`orca terminal read --screen` 에 입력줄/상태줄, 최대 90초) `orca terminal send --enter --wait-submit 15` 로 보낸다.
 *   3. 제출 확인: draft 가 비어 있고, 첫 활동(스피너·도구 줄 / receipt 의 turn_started)이 보이면 성공.
 *      실패는 단계(stage)별 사유로.
 * 생성된 세션은 ~/.ned/chat-sessions.json 에 기록 → refreshSessions 가 cwd(=워크트리 경로)로 이어 붙여
 * state.json sessions[].origin = "chat" (장비실 "대화창에서 시작" 배지). 모든 시도는 sent-actions.log 에
 * source "session", mode "create", action "session_create", origin "chat".
 *
 * Orca 호출은 모두 deps.orca 를 거친다(테스트는 모킹 — 실제 워크트리 생성 금지). NED_SEND_DRY_RUN=1 이면
 * 실제 orca 로는 쓰기 명령을 하지 않는다(검증까지만, dry_run:session_create).
 */
import path from "node:path";
import { appendActionLog, orca as realOrca, type ActionLogEntry, type OrcaExec, type SendRequest, type SendResult } from "./actions.js";
import type { NedConfig } from "./config.js";
import { NED_HOME, log, readJson, writeJsonAtomic } from "./paths.js";
import { runningJobs, startTaskJob, type SendJob } from "./send-jobs.js";
import type { SessionView } from "./sessions.js";

export const CHAT_SESSIONS_PATH = path.join(NED_HOME, "chat-sessions.json");
/** 대화창 출처로 시작해 아직 살아 있는 세션 상한. */
export const CHAT_SESSION_CAP = 2;
/** 첫 프롬프트는 반드시 이 문장으로 시작한다(빠져 있으면 서버가 앞에 붙인다). */
export const PLAN_FIRST = "먼저 계획을 제시하고 승인받은 뒤 구현한다.";
export const SESSION_MODELS = ["opus", "sonnet"] as const;
export type SessionModel = (typeof SESSION_MODELS)[number];
export const MAX_PROMPT = 8000;
const NEW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const EXISTING_NAME = /^[\w.\/-]{1,120}$/;
const JOB_PREFIX = "session_create|";

export interface SessionCreateInput {
  /** Orca 등록 레포의 절대 경로. */
  repo: string;
  worktree: { mode: "new" | "existing"; name: string };
  model: SessionModel;
  /** 첫 프롬프트 전문(PLAN_FIRST 로 시작). */
  prompt: string;
}

/** One session started from the chat (chat-sessions.json). */
export interface ChatSessionRecord {
  job_id: string;
  created_at: number;
  repo: string;
  mode: "new" | "existing";
  name: string;
  model: string;
  worktree_path?: string;
  worktree_id?: string;
  handle?: string;
  /** Final outcome; undefined while the job runs. */
  ok?: boolean;
  stage?: string;
}

export interface SessionCreateDeps {
  orca: OrcaExec;
  sleep: (ms: number) => Promise<void>;
  /** Agent boot wait (spec: 90s). */
  bootTimeoutMs: number;
  /** After the send: how long to look for the first activity. */
  activityTimeoutMs: number;
  pollMs: number;
  /** false under NED_SEND_DRY_RUN with the real orca: no worktree / launch / send. */
  allowWrites: boolean;
}

export const defaultSessionCreateDeps = (): SessionCreateDeps => ({
  orca: realOrca,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  bootTimeoutMs: 90_000,
  activityTimeoutMs: 30_000,
  pollMs: 2_000,
  allowWrites: process.env.NED_SEND_DRY_RUN !== "1",
});

let depsOverride: Partial<SessionCreateDeps> | null = null;
/** Test hook: the server route uses these deps (merged over the defaults) until reset with null. */
export function _setSessionCreateDeps(d: Partial<SessionCreateDeps> | null): void {
  depsOverride = d;
}
export const sessionCreateDeps = (): SessionCreateDeps => ({ ...defaultSessionCreateDeps(), ...(depsOverride ?? {}) });

// ---------------------------------------------------------------------------------------------- parse

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** PLAN_FIRST 로 시작하지 않으면 앞에 붙인다. */
export function ensurePlanFirst(prompt: string): string {
  const p = prompt.trim();
  const head = PLAN_FIRST.replace(/\.$/, "");
  return p.startsWith(head) ? p : `${PLAN_FIRST}\n\n${p}`;
}

/** Coerce a POST /api/sessions/create body (the `session_create` 제안 블록). Error string → 400. */
export function parseSessionCreate(body: Record<string, unknown>): SessionCreateInput | string {
  const repoRaw = str(body.repo);
  if (!repoRaw) return "repo required (Orca 에 등록된 레포 경로)";
  if (!path.isAbsolute(repoRaw)) return "repo must be an absolute path";
  const repo = path.resolve(repoRaw);
  const w = (body.worktree && typeof body.worktree === "object" ? body.worktree : {}) as Record<string, unknown>;
  const mode = w.mode === "existing" ? "existing" : w.mode === "new" || w.mode === undefined ? "new" : null;
  if (!mode) return 'worktree.mode must be "new" | "existing"';
  const name = str(w.name);
  if (!name) return "worktree.name required";
  if (mode === "new" && !NEW_NAME.test(name)) return "worktree.name: 영문·숫자·. _ - 만, 60자 이내 (새 워크트리 이름)";
  if (mode === "existing" && !EXISTING_NAME.test(name)) return "worktree.name: 기존 워크트리 이름/브랜치/경로 끝부분";
  const model = body.model === undefined || body.model === "" ? "opus" : body.model;
  if (!SESSION_MODELS.includes(model as SessionModel)) return `model must be ${SESSION_MODELS.join(" | ")}`;
  const prompt = str(body.prompt);
  if (!prompt) return "prompt required (첫 프롬프트 전문)";
  const full = ensurePlanFirst(prompt);
  if (full.length > MAX_PROMPT) return `prompt longer than ${MAX_PROMPT} chars`;
  return { repo, worktree: { mode, name }, model: model as SessionModel, prompt: full };
}

// ---------------------------------------------------------------------------------------------- orca reads

interface OrcaRepo {
  id: string;
  path: string;
  displayName?: string;
  kind?: string;
}
interface OrcaWorktree {
  id: string;
  repoId?: string;
  path: string;
  branch?: string;
  displayName?: string;
  isMainWorktree?: boolean;
  isArchived?: boolean;
}
interface OrcaTerm {
  handle: string;
  connected?: boolean;
  status?: string;
  worktreePath?: string;
}

const resultOf = (json: unknown): Record<string, unknown> => ((json as { result?: Record<string, unknown> } | null)?.result ?? {}) as Record<string, unknown>;
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const norm = (p: string) => path.resolve(p).replace(/\/+$/, "");

/** 허용 목록: `orca repo list` 의 git 레포 (실패하면 `orca worktree list` 의 메인 워크트리). */
export async function allowedRepos(o: OrcaExec): Promise<{ repos: OrcaRepo[]; error?: string }> {
  const r = await o(["repo", "list", "--json"]);
  const repos = arr<OrcaRepo>(resultOf(r.json).repos).filter((x) => typeof x?.path === "string" && (!x.kind || x.kind === "git"));
  if (repos.length) return { repos };
  const w = await o(["worktree", "list", "--json"]);
  const res = resultOf(w.json);
  const wts = arr<OrcaWorktree>(Array.isArray(res) ? res : res.worktrees).filter((x) => x?.isMainWorktree && typeof x.path === "string");
  if (wts.length) return { repos: wts.map((x) => ({ id: x.repoId ?? "", path: x.path })) };
  return { repos: [], error: `orca repo list 실패: ${r.err || w.err || "no repos"}` };
}

async function listWorktrees(o: OrcaExec): Promise<OrcaWorktree[]> {
  const w = await o(["worktree", "list", "--json"]);
  const res = resultOf(w.json);
  return arr<OrcaWorktree>(Array.isArray(res) ? res : res.worktrees);
}

/** The existing worktree `name` of `repo`: display name, directory name, branch (refs/heads/… or bare) or path. */
export function findExistingWorktree(wts: OrcaWorktree[], repo: OrcaRepo, name: string): OrcaWorktree | null {
  const mine = wts.filter((w) => !w.isArchived && typeof w.path === "string" && ((repo.id && w.repoId === repo.id) || norm(w.path) === norm(repo.path) || w.id?.startsWith(`${repo.id}::`)));
  const branch = (b?: string) => (b ?? "").replace(/^refs\/heads\//, "");
  return (
    mine.find((w) => norm(w.path) === (path.isAbsolute(name) ? norm(name) : "")) ??
    mine.find((w) => w.displayName === name) ??
    mine.find((w) => path.basename(w.path) === name) ??
    mine.find((w) => branch(w.branch) === name || branch(w.branch).endsWith(`/${name}`)) ??
    null
  );
}

// ---------------------------------------------------------------------------------------------- records + cap

export const readChatSessions = (): ChatSessionRecord[] => {
  const v = readJson<unknown>(CHAT_SESSIONS_PATH, []);
  return Array.isArray(v) ? (v as ChatSessionRecord[]) : [];
};
const KEEP_RECORDS_MS = 14 * 24 * 60 * 60_000;
function upsertRecord(rec: ChatSessionRecord, now = Date.now()): void {
  const all = readChatSessions().filter((r) => r.job_id !== rec.job_id && now - r.created_at < KEEP_RECORDS_MS);
  all.push(rec);
  writeJsonAtomic(CHAT_SESSIONS_PATH, all.slice(-100));
}

/** True when `p` is `root` or inside it. */
const within = (p: string | null | undefined, root: string) => {
  if (!p) return false;
  const a = norm(p), r = norm(root);
  return a === r || a.startsWith(r + path.sep);
};

/** The chat record a session belongs to (its cwd or Orca worktree path is the record's worktree). */
export function chatRecordFor(s: Pick<SessionView, "cwd" | "orca_worktree">, records: ChatSessionRecord[]): ChatSessionRecord | null {
  const orcaPath = s.orca_worktree?.split("::")[1];
  return records.find((r) => r.worktree_path && (within(s.cwd, r.worktree_path) || within(orcaPath, r.worktree_path))) ?? null;
}

/** state.json 세션 메타: 대화창에서 시작한 세션에 origin "chat" + 그 터미널 handle. */
export function annotateChatOrigin(sessions: SessionView[], records = readChatSessions()): SessionView[] {
  if (!records.length) return sessions;
  for (const s of sessions) {
    const r = chatRecordFor(s, records);
    if (r) {
      s.origin = "chat";
      if (r.handle) s.origin_terminal = r.handle;
    } else {
      delete s.origin;
      delete s.origin_terminal;
    }
  }
  return sessions;
}

/**
 * 대화창 출처로 시작해 아직 살아 있는 세션 수: 실행 중인 job(아직 handle 기록 전) + 기록된 handle 중 Orca 터미널이
 * 아직 붙어 있는 것. `orca terminal list` 가 실패하면 state 의 세션(cwd 가 그 워크트리, 종료 안 됨)으로 판단.
 */
export async function liveChatSessions(o: OrcaExec, sessions: Pick<SessionView, "cwd" | "orca_worktree" | "status">[] = [], records = readChatSessions()): Promise<{ count: number; live: ChatSessionRecord[] }> {
  const recorded = new Set(records.filter((r) => r.handle).map((r) => r.job_id));
  const pending = runningJobs(JOB_PREFIX).filter((j) => !recorded.has(j.id)).length;
  const withHandle = records.filter((r) => r.handle);
  if (!withHandle.length) return { count: pending, live: [] };
  const list = await o(["terminal", "list", "--json"]);
  const terms = arr<OrcaTerm>(resultOf(list.json).terminals);
  let live: ChatSessionRecord[];
  if (list.ok || terms.length) {
    const alive = new Set(terms.filter((t) => t.connected !== false && t.status !== "exited").map((t) => t.handle));
    live = withHandle.filter((r) => alive.has(r.handle!));
  } else {
    live = withHandle.filter((r) => sessions.some((s) => s.status !== "ended" && chatRecordFor(s, [r])));
  }
  return { count: pending + live.length, live };
}

// ---------------------------------------------------------------------------------------------- screen heuristics

/** Rendered screen text + composer draft from `orca terminal read --screen --json`. */
export function screenOf(json: unknown): { text: string; draft: string; status?: string } {
  const t = (resultOf(json).terminal ?? {}) as { tail?: unknown; draft?: unknown; status?: unknown };
  const tail = arr<unknown>(t.tail).map(String);
  return { text: tail.join("\n"), draft: typeof t.draft === "string" ? t.draft : "", status: typeof t.status === "string" ? t.status : undefined };
}

const TRUST = /Do you trust the files|trust this folder|Yes, proceed|Quick safety check/i;
/** Claude Code is up: its input line (❯ / │ >) or a footer hint / status line. */
const READY = /^\s*(?:│\s*)?[❯>](?:\s|$)|\? for shortcuts|shift\+tab to cycle|bypass permissions|accept edits on|auto mode on|plan mode on/m;
/** Claude is working on the prompt: spinner line, interrupt hint, or a tool-call bullet. */
const ACTIVITY = /esc to interrupt|^\s*[⏺●]\s|^\s*[✻✶✳✢✽·*]\s+\S+…|\(\d+s\s*·/m;

export type BootState = "ready" | "trust" | "booting" | "exited";
export function bootState(screen: { text: string; status?: string }): BootState {
  if (screen.status === "exited") return "exited";
  if (TRUST.test(screen.text)) return "trust";
  return READY.test(screen.text) ? "ready" : "booting";
}
export const hasActivity = (text: string) => ACTIVITY.test(text);
/** The send receipt proves the agent's turn started. */
export const receiptTurnStarted = (json: unknown) => /turn_started/.test(JSON.stringify(json ?? ""));

/** Terminal handle from `worktree create --json` / `agent launch --json` (launch.outcome.handle, legacy agentTerminalHandle). */
export function pickHandle(json: unknown): { handle?: string; kind?: string } {
  const r = resultOf(json) as { launch?: { outcome?: { handle?: string; kind?: string } }; outcome?: { handle?: string; kind?: string }; agentTerminalHandle?: string; handle?: string };
  const o = r.launch?.outcome ?? r.outcome;
  const handle = o?.handle ?? r.agentTerminalHandle ?? (typeof r.handle === "string" ? r.handle : undefined);
  if (handle) return { handle, kind: o?.kind };
  // Unknown shape: first string `handle` / `agentTerminalHandle` anywhere.
  let found: string | undefined;
  const walk = (v: unknown, d = 0) => {
    if (found || !v || typeof v !== "object" || d > 6) return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "handle" || k === "agentTerminalHandle") && typeof x === "string" && x.startsWith("term_")) {
        found = x;
        return;
      }
      walk(x, d + 1);
    }
  };
  walk(r);
  return { handle: found, kind: o?.kind };
}

/** The new worktree's path + id from `worktree create --json`. */
export function pickWorktree(json: unknown): { path?: string; id?: string } {
  const r = resultOf(json) as { worktree?: { path?: string; id?: string }; path?: string; id?: string };
  const id = r.worktree?.id ?? r.id;
  const p = r.worktree?.path ?? r.path ?? (typeof id === "string" && id.includes("::") ? id.split("::")[1] : undefined);
  return { path: typeof p === "string" ? p : undefined, id: typeof id === "string" ? id : undefined };
}

// ---------------------------------------------------------------------------------------------- validate + run

export interface Refusal {
  status: 400 | 403 | 409 | 502;
  action: string;
  detail: string;
}

const STAGE_KO: Record<string, string> = {
  validate: "검증",
  worktree_create: "워크트리 만들기",
  agent_launch: "에이전트 시작",
  agent_boot: "에이전트 기동 대기",
  prompt_send: "첫 프롬프트 전송",
  submit_confirm: "제출 확인",
};

function logEntry(input: SessionCreateInput, action: string, ok: boolean, result: string, extra: Partial<ChatSessionRecord> = {}): ActionLogEntry {
  return {
    ts: new Date().toISOString(),
    source: "session",
    mode: "create",
    action,
    origin: "chat",
    ref: { title: `${path.basename(input.repo)} · ${input.worktree.mode === "new" ? "새" : "기존"} ${input.worktree.name}`, repo: input.repo },
    text: input.prompt.slice(0, 120),
    ok,
    result,
    session_create: { repo: input.repo, worktree_mode: input.worktree.mode, worktree_name: input.worktree.name, model: input.model, worktree_path: extra.worktree_path, handle: extra.handle, stage: extra.stage },
  };
}

/**
 * Checks before any write (also the 확인 카드 사전 검증): toggle, repo allow-list, existing worktree, the cap.
 * Returns the matched repo (and existing worktree), or a refusal.
 */
export async function validateSessionCreate(
  input: SessionCreateInput,
  cfg: NedConfig,
  deps: Pick<SessionCreateDeps, "orca">,
  sessions: SessionView[] = [],
): Promise<{ ok: true; repo: OrcaRepo; existing?: OrcaWorktree; live: number } | ({ ok: false } & Refusal)> {
  if (cfg.actions.chat_session_create !== true) return { ok: false, status: 403, action: "refused", detail: "config.actions.chat_session_create is off — 설정 → 쓰기 액션 → 세션 → '대화창에서 세션 만들기' 를 켜야 해" };
  const { repos, error } = await allowedRepos(deps.orca);
  if (!repos.length) return { ok: false, status: 502, action: "session_create", detail: error ?? "Orca 등록 레포를 읽지 못했어" };
  const repo = repos.find((r) => norm(r.path) === norm(input.repo));
  if (!repo) return { ok: false, status: 400, action: "invalid", detail: `${input.repo} 는 Orca 에 등록된 레포가 아니야 (허용: ${repos.map((r) => path.basename(r.path)).join(", ")})` };
  let existing: OrcaWorktree | undefined;
  if (input.worktree.mode === "existing") {
    existing = findExistingWorktree(await listWorktrees(deps.orca), repo, input.worktree.name) ?? undefined;
    if (!existing) return { ok: false, status: 400, action: "invalid", detail: `${path.basename(repo.path)} 에 '${input.worktree.name}' 워크트리가 없어` };
  }
  const { count } = await liveChatSessions(deps.orca, sessions);
  if (count >= CHAT_SESSION_CAP) return { ok: false, status: 409, action: "refused_cap", detail: `대화창에서 시작해 아직 살아 있는 세션이 ${count}개야 (최대 ${CHAT_SESSION_CAP}). 하나를 끝내거나 닫은 뒤 다시 해줘` };
  return { ok: true, repo, existing, live: count };
}

/** Steps 2–4 (in the job): start the agent, wait for it, send the prompt, confirm the submission. */
export async function runSessionCreate(input: SessionCreateInput, repo: OrcaRepo, existing: OrcaWorktree | undefined, deps: SessionCreateDeps, job: Pick<SendJob, "id"> & { stage?: string }): Promise<SendResult> {
  const rec: ChatSessionRecord = { job_id: job.id, created_at: Date.now(), repo: repo.path, mode: input.worktree.mode, name: input.worktree.name, model: input.model };
  const finish = (status: SendResult["status"], ok: boolean, action: string, stage: string, detail: string): SendResult => {
    const full = ok || action.startsWith("dry_run:") ? detail : `[${STAGE_KO[stage] ?? stage}] ${detail}`;
    if (rec.handle || rec.worktree_path) upsertRecord({ ...rec, ok, stage });
    appendActionLog(logEntry(input, action, ok, full, { ...rec, stage }));
    log(`session_create: ${action} ${ok ? "ok" : `FAIL(${status}) @${stage}`} ${full.slice(0, 200)}`);
    return { ok, action, detail: full, logged_at: new Date().toISOString(), status, session: { worktree_path: rec.worktree_path, worktree_id: rec.worktree_id, handle: rec.handle, stage } };
  };
  const stage = (s: string) => {
    job.stage = s;
  };

  const startArgs =
    input.worktree.mode === "new"
      ? ["worktree", "create", "--name", input.worktree.name, "--repo", `path:${repo.path}`, "--parent-worktree", `path:${repo.path}`, "--agent", "claude", "--model", input.model, "--surface", "terminal", "--json"]
      : ["agent", "launch", "--agent", "claude", "--worktree", `path:${existing!.path}`, "--model", input.model, "--surface", "terminal", "--json"];
  if (!deps.allowWrites) {
    log(`session_create: dry run — orca ${JSON.stringify(startArgs)}; then terminal send ${JSON.stringify(input.prompt.slice(0, 200))}`);
    return finish(200, false, "dry_run:session_create", "validate", `not executed (NED_SEND_DRY_RUN=1); orca ${startArgs.join(" ")}`);
  }

  // 1) worktree + agent
  const st = input.worktree.mode === "new" ? "worktree_create" : "agent_launch";
  stage(st);
  const made = await deps.orca(startArgs, 180_000);
  const { handle, kind } = pickHandle(made.json);
  if (input.worktree.mode === "new") {
    const wt = pickWorktree(made.json);
    rec.worktree_path = wt.path;
    rec.worktree_id = wt.id;
  } else {
    rec.worktree_path = existing!.path;
    rec.worktree_id = existing!.id;
  }
  if (!made.ok || (made.json as { ok?: boolean } | null)?.ok === false) return finish(502, false, "session_create", st, `orca ${startArgs.slice(0, 2).join(" ")} 실패: ${made.err || JSON.stringify(made.json).slice(0, 300)}`);
  if (kind === "structured") return finish(502, false, "session_create", st, "에이전트가 터미널이 아니라 채팅으로 열렸어 — 첫 프롬프트를 보낼 터미널이 없어. Orca 에서 직접 입력해줘");
  if (!handle) return finish(502, false, "session_create", st, `에이전트 터미널 handle 을 못 찾았어: ${JSON.stringify(made.json).slice(0, 300)}`);
  rec.handle = handle;
  upsertRecord(rec); // counts toward the cap from here on, even if a later step fails

  // 2) wait for Claude Code to come up
  stage("agent_boot");
  const deadline = Date.now() + deps.bootTimeoutMs;
  let boot: BootState = "booting";
  let lastScreen = "";
  for (;;) {
    const r = await deps.orca(["terminal", "read", "--terminal", handle, "--screen", "--json"]);
    const sc = screenOf(r.json);
    lastScreen = sc.text;
    boot = bootState(sc);
    if (boot !== "booting") break;
    if (Date.now() >= deadline) break;
    await deps.sleep(deps.pollMs);
  }
  const tailOf = (t: string) => t.split("\n").filter((l) => l.trim()).slice(-3).join(" ⏎ ").slice(0, 200);
  if (boot === "exited") return finish(502, false, "session_create", "agent_boot", `에이전트 터미널이 종료됐어: ${tailOf(lastScreen)}`);
  if (boot === "trust") return finish(409, false, "session_create", "agent_boot", "Claude 가 폴더 신뢰 확인을 기다리고 있어 — Orca 에서 확인해준 뒤 첫 프롬프트를 직접 보내줘");
  if (boot !== "ready") return finish(502, false, "session_create", "agent_boot", `${Math.round(deps.bootTimeoutMs / 1000)}초 안에 에이전트가 뜨지 않았어: ${tailOf(lastScreen)}`);

  // 3) the prompt (no --prompt: it leaves a draft that never submits)
  stage("prompt_send");
  const sent = await deps.orca(["terminal", "send", "--terminal", handle, "--enter", "--wait-submit", "15", "--text", input.prompt, "--json"], 60_000);
  const sj = sent.json as { ok?: boolean; error?: { code?: string; message?: string } } | null;
  if (!sent.ok || sj?.ok === false) {
    const blocked = /agent_prompt_blocked/.test(JSON.stringify(sent.json ?? "") + sent.err);
    return finish(502, false, "session_create", "prompt_send", blocked ? "에이전트가 권한/신뢰 메뉴를 띄우고 있어 프롬프트가 막혔어 — Orca 에서 메뉴를 처리한 뒤 직접 보내줘" : `orca terminal send 실패: ${sent.err || JSON.stringify(sent.json).slice(0, 300)}`);
  }
  const turnStarted = receiptTurnStarted(sent.json);

  // 4) submitted: the composer draft is empty and Claude shows activity
  stage("submit_confirm");
  const until = Date.now() + deps.activityTimeoutMs;
  let draft = "";
  let active = false;
  for (;;) {
    const r = await deps.orca(["terminal", "read", "--terminal", handle, "--screen", "--json"]);
    const sc = screenOf(r.json);
    draft = sc.draft.trim();
    active = hasActivity(sc.text);
    lastScreen = sc.text;
    if (!draft && active) break;
    if (Date.now() >= until) break;
    await deps.sleep(deps.pollMs);
  }
  const where = `${rec.worktree_path ?? input.worktree.name} (${handle})`;
  if (draft) return finish(502, false, "session_create", "submit_confirm", `프롬프트가 입력창에 초안으로 남아 있어(제출 안 됨) — ${where} 에서 Enter 를 눌러줘`);
  if (!active && !turnStarted) return finish(502, false, "session_create", "submit_confirm", `제출은 됐지만 에이전트 활동이 안 보여: ${tailOf(lastScreen)} — ${where} 를 확인해줘`);
  return finish(200, true, "session_create", "done", `started ${where} · ${input.model}${active ? "" : " (turn_started)"}`);
}

export type SessionCreateOutcome = { kind: "refused"; result: SendResult } | { kind: "job"; job: SendJob; reused: boolean };

/** POST /api/sessions/create: validate synchronously (refusals logged), then start (or join) the job. */
/**
 * validate → startTaskJob runs one request at a time. Without this, two POSTs (different worktrees) could both pass
 * the cap check across validate's awaits and start 3 sessions. startTaskJob registers the running job synchronously,
 * so the next request's liveChatSessions already counts it.
 */
let createLock: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = createLock.then(fn, fn);
  createLock = run.catch(() => undefined);
  return run;
}

export function startSessionCreate(input: SessionCreateInput, cfg: NedConfig, sessions: SessionView[] = [], deps = sessionCreateDeps()): Promise<SessionCreateOutcome> {
  return serialized(() => startSessionCreateLocked(input, cfg, sessions, deps));
}

async function startSessionCreateLocked(input: SessionCreateInput, cfg: NedConfig, sessions: SessionView[], deps: SessionCreateDeps): Promise<SessionCreateOutcome> {
  const key = `${JOB_PREFIX}${norm(input.repo)}|${input.worktree.mode}|${input.worktree.name}`;
  const joined = runningJobs(key).find((j) => j.key === key);
  if (joined) return { kind: "job", job: joined, reused: true };
  const v = await validateSessionCreate(input, cfg, deps, sessions);
  if (!v.ok) {
    const logged_at = new Date().toISOString();
    appendActionLog(logEntry(input, v.action, false, v.detail, { stage: "validate" }));
    log(`session_create: ${v.action} (${v.status}) ${v.detail.slice(0, 200)}`);
    return { kind: "refused", result: { ok: false, action: v.action, detail: v.detail, logged_at, status: v.status, session: { stage: "validate" } } };
  }
  const req: SendRequest = { source: "session", mode: "create", text: input.prompt, ref: { repo: input.repo, title: input.worktree.name } };
  const { job, reused } = startTaskJob(key, req, (j) => runSessionCreate(input, v.repo, v.existing, deps, j));
  return { kind: "job", job, reused };
}
