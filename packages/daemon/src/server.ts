import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { archiveFlushNow, archiveStatus } from "./archive.js";
import { appendActionLog, parseOrigin, parseSendRequest, readActionLog, type SendRequest } from "./actions.js";
import { parseCalendarCreate } from "./calendar-create.js";
import { getSendJob, linkOf, startSendJob, viewJob } from "./send-jobs.js";
import { knownRepoPaths, parseSessionCreate, sessionCreateDeps, startSessionCreate, validateSessionCreate } from "./session-create.js";
import { AGENDA_SOURCES, agendaBusy, enabledSources, readAgenda, runningSources, startAgendaRefresh, type AgendaSourceKey } from "./agenda.js";
import { contextStatus, requestContext } from "./agenda-context.js";
import { CHAT_INPUT_MAX, activeChat, listChats, prepareChatTurn, readChat, runChatTurn, setChatActionState, sseFrame, stopChat } from "./chat.js";
import { validateChatAction } from "./chat-actions.js";
import { costSummary } from "./costs.js";
import { checkRange, fetchCalendarRange } from "./calendar.js";
import { HISTORY_SOURCES, PERSONAS, configChanges, configUpdatedAt, deepMerge, listConfigBackups, loadConfig, logValue, mergeFilters, normalizeActions, normalizeAgendaSourceMinutes, normalizeArchive, normalizeDashboard, normalizeHistory, normalizeIdleSchedule, normalizeNotifications, normalizeQuietSchedule, normalizeReplyTone, normalizeReplyToneBySource, normalizePersona, normalizeUpdates, normalizePet, normalizeResponsibilities, quickRepliesError, responsibilitiesError, restoreConfigBackup, saveConfig, slackTeamDomainError, slackTeamIdError, sourceRefreshMinutes, watchChannels, type HistorySource, type NedConfig, type NedPet, type PersonaId } from "./config.js";
import { DraftError, generateDraft, parseDraftRequest, pregenStatus } from "./drafts.js";
import { readRecentEvents } from "./events.js";
import { historyStatus, queryHistory } from "./history.js";
import { checkStatus, dismissAttention, heartbeat, listBriefings, runCheck } from "./heartbeat.js";
import { buildFeed } from "./feed.js";
import { log } from "./paths.js";
import { listOutputs, outputFile, readOutput } from "./outputs.js";
import { checkVault } from "./vault.js";
import { readOnboarding, setOnboardingDismissed, setupCheck } from "./setup-check.js";
import { updateCheck } from "./update-check.js";
import { installNow, recordCheck, updateStatus } from "./self-update.js";
import { readSourceReviewed, readState, readUpdateBadge, writeState } from "./state.js";
import { noteActivity, schedulerStatus } from "./scheduler.js";
import { registerSearch } from "./search.js";
import { registerMcp } from "./mcp.js";
import { requestGuardMiddleware } from "./request-guard.js";
import { reviewItem } from "./review.js";
import { addTodo, deleteTodo, listTodos, updateTodo } from "./todos.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, "../public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Map a URL path to a regular file inside PUBLIC_DIR, or null. Rejects traversal, dotfiles and symlink escapes. */
function resolvePublic(urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes("\0") || rel.split(/[\\/]/).some((seg) => seg.startsWith("."))) return null;
  let file = path.resolve(PUBLIC_DIR, "." + path.posix.normalize("/" + rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const real = fs.realpathSync(file);
    const root = fs.realpathSync(PUBLIC_DIR);
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Identifies the running daemon code: dist (or src under tsx) file mtime. The dashboard compares it across polls and asks
 * for a reload once the daemon restarts on new code, so an old page never saves with a stale idea of the config.
 */
export const BUILD_ID = process.env.NED_BUILD_ID || (() => {
  try { return Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs).toString(36); } catch { return "dev"; }
})();

/** GET/PUT /api/config payload: the config plus its version token and the daemon build. */
const configView = (cfg: NedConfig) => ({ ...cfg, updated_at: configUpdatedAt(), build_id: BUILD_ID });

/**
 * A partial PUT body over the current config: only keys present in the body change. Plain objects merge key by key
 * (deepMerge), arrays / scalars replace; then the per-key normalizers run on the result. filters / dashboard keep
 * their own merge rules (dashboard.layout replaces as a whole, null clears it). An unknown persona keeps the current one.
 */
export function mergeConfigPatch(cur: NedConfig, body: Partial<NedConfig>): NedConfig {
  const { filters, dashboard, persona, ...rest } = body;
  const m = deepMerge(cur, rest);
  const merged: NedConfig = {
    ...m,
    persona: PERSONAS.includes(persona as PersonaId) ? normalizePersona(persona) : cur.persona,
    notifications: normalizeNotifications(m.notifications, cur.notifications),
    actions: normalizeActions(m.actions, cur.actions),
    reply_tone: normalizeReplyTone(m.reply_tone, cur.reply_tone),
    heartbeat_skip_unchanged: m.heartbeat_skip_unchanged !== false,
    reply_tone_by_source: normalizeReplyToneBySource(m.reply_tone_by_source, cur.reply_tone_by_source),
    filters: mergeFilters(cur.filters, filters),
    agenda_source_minutes: normalizeAgendaSourceMinutes(m.agenda_source_minutes, cur.agenda_source_minutes),
    quiet_schedule: normalizeQuietSchedule(m.quiet_schedule, cur.quiet_schedule),
    idle_schedule: normalizeIdleSchedule(m.idle_schedule, cur.idle_schedule),
    archive: normalizeArchive(m.archive, cur.archive),
    history: normalizeHistory(m.history, cur.history),
    pet: normalizePet(m.pet, cur.pet),
    updates: normalizeUpdates(m.updates, cur.updates),
    responsibilities: normalizeResponsibilities(m.responsibilities),
  };
  // Re-normalized even without a dashboard patch: a 팔로업 channel added / removed in filters adds / drops its `watch:` card.
  merged.dashboard = normalizeDashboard(dashboard ?? {}, cur.dashboard, watchChannels(merged.filters));
  return merged;
}

/**
 * Obsidian 아카이브: a vault that changed (or was just switched on) must be usable — absolute, an existing folder, not
 * inside ~/.ned or the Ned repo. A missing `.obsidian` is only a warning (GET /api/archive/status). null = fine.
 */
export function archivePatchError(cur: NedConfig, next: NedConfig): string | null {
  const a = next.archive;
  if (a.enabled && !a.vault) return "아카이브를 켜려면 볼트 경로가 필요해";
  if (!a.vault || (a.vault === cur.archive.vault && (cur.archive.enabled || !a.enabled))) return null;
  const chk = checkVault(a.vault);
  return chk.ok ? null : `볼트 경로를 쓸 수 없어: ${chk.error}`;
}

/** Mirror persona + notification settings into state.json right away (dashboard / Ned.app read them there). */
function mirrorToState(cfg: NedConfig): void {
  // pet: Ned.app watches state.json, so a 설정 → 데스크톱 펫 save shows / hides the pet right away (GET /api/feed carries it too).
  const st = readState() as ReturnType<typeof readState> & { pet?: NedPet };
  if (st.persona !== cfg.persona || JSON.stringify(st.notifications) !== JSON.stringify(cfg.notifications) || JSON.stringify(st.pet) !== JSON.stringify(cfg.pet)) {
    st.persona = cfg.persona;
    st.notifications = cfg.notifications;
    st.pet = cfg.pet;
    writeState(st);
  }
}

/**
 * Routes read config.yaml fresh (loadConfig) instead of the daemon's cached copy, so a PUT /api/config is
 * visible right away (settings reload, agenda refresh) rather than after the next heartbeat tick.
 */
export function startServer(getConfig: () => NedConfig): void {
  const app = new Hono();
  app.use("*", requestGuardMiddleware); // DNS rebinding: non-loopback Host / Origin → 403 on every route (src/request-guard.ts)

  app.get("/", (c) => {
    const index = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(index)) return c.html(fs.readFileSync(index, "utf8"));
    return c.html("<!doctype html><title>Ned</title><p>Ned daemon is running. API: /api/state, /api/events, /api/briefings, /api/config</p>");
  });
  // ?visible=1: the dashboard is visible + focused → counts as user activity (idle auto-slowdown, src/scheduler.ts).
  // state.quiet stays a boolean (Ned.app decodes it); the scheduler's view is quiet_schedule / idle.
  app.get("/api/state", (c) => {
    if (c.req.query("visible") === "1") noteActivity();
    const sch = schedulerStatus(loadConfig());
    return c.json({ ...readState(), build_id: BUILD_ID, quiet_schedule: sch.quiet, idle: sch.idle });
  });
  // Dashboard activity ping (input / focus, ≤ once a minute): ends idle mode right away.
  app.post("/api/activity", (c) => {
    noteActivity();
    return c.json({ ok: true });
  });
  app.get("/api/events", (c) => c.json(readRecentEvents(Number(c.req.query("days") ?? 2))));
  app.get("/api/briefings", (c) => c.json(listBriefings(Number(c.req.query("limit") ?? 30))));
  // 메시지 피드 for the desktop pet (src/feed.ts — the 통신기 buildFeed rules) + the pet settings and quiet flag it needs.
  app.get("/api/feed", (c) => {
    const cfg = loadConfig();
    const state = readState();
    const a = readAgenda();
    const items = buildFeed({ state, briefings: listBriefings(30), agenda: { slack: cfg.sources.slack ? a.slack : null } }, Date.now(), cfg.dashboard);
    // quick_replies + session_send: the pet bubble's 세션에 답하기 (same buttons as the dashboard's session rows).
    return c.json({ items, pet: cfg.pet, quiet: state.quiet, persona: cfg.persona, quick_replies: cfg.dashboard.session_quick_replies, session_send: cfg.actions.session_send === true });
  });
  app.get("/api/config", (c) => c.json(configView(loadConfig())));
  app.put("/api/config", async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error: "body must be an object" }, 400);
    const { if_updated_at, updated_at: _u, build_id: _b, ...body } = raw as Partial<NedConfig> & { if_updated_at?: unknown; updated_at?: unknown; build_id?: unknown };
    // Optimistic concurrency: the page sends the updated_at it rendered from; a save made elsewhere since then
    // (another tab, a hand edit of config.yaml, a daemon upgrade) → 409 with the current config instead of clobbering it.
    if (if_updated_at != null && Number(if_updated_at) !== configUpdatedAt()) return c.json({ error: "conflict", current: configView(loadConfig()) }, 409);
    const cur = loadConfig(); // may create config.yaml — so read the token after it
    const seen = configUpdatedAt();
    const teamErr = slackTeamIdError(body.dashboard);
    if (teamErr) return c.json({ error: teamErr, field: "dashboard.slack_team_id" }, 400);
    const domainErr = slackTeamDomainError(body.dashboard);
    if (domainErr) return c.json({ error: domainErr, field: "dashboard.slack_team_domain" }, 400);
    const quickErr = quickRepliesError(body.dashboard);
    if (quickErr) return c.json({ error: quickErr, field: "dashboard.session_quick_replies" }, 400);
    const respErr = responsibilitiesError(body.responsibilities);
    if (respErr) return c.json({ error: respErr, field: "responsibilities" }, 400);
    const merged = mergeConfigPatch(cur, body);
    const archErr = archivePatchError(cur, merged);
    if (archErr) return c.json({ error: archErr, field: "archive.vault" }, 400);
    // Check → save runs synchronously (no await), so no other request of this daemon can interleave. An outside
    // writer (hand edit) landing between the stat above and the write below is caught by this second look; the
    // remaining window is the few µs inside saveConfig itself — accepted (backups cover it).
    if (configUpdatedAt() !== seen || (if_updated_at != null && Number(if_updated_at) !== seen)) return c.json({ error: "conflict", current: configView(loadConfig()) }, 409);
    for (const ch of configChanges(cur, merged)) log(`config: ${ch.key} ${logValue(ch.from)} → ${logValue(ch.to)}`);
    saveConfig(merged);
    mirrorToState(merged);
    return c.json(configView(merged));
  });
  app.get("/api/config/backups", (c) => c.json(listConfigBackups()));
  app.post("/api/config/restore", async (c) => {
    const { name } = (await readBody(c)) as { name?: unknown };
    const cur = loadConfig();
    let next: NedConfig;
    try { next = restoreConfigBackup(name); } catch (e) { return c.json({ error: String((e as Error).message ?? e) }, /no such/.test(String(e)) ? 404 : 400); }
    log(`config: restored ${String(name)}`);
    for (const ch of configChanges(cur, next)) log(`config: ${ch.key} ${logValue(ch.from)} → ${logValue(ch.to)}`);
    mirrorToState(next);
    return c.json(configView(next));
  });
  app.post("/api/heartbeat", async (c) => {
    const daily = c.req.query("daily") === "1";
    const b = await heartbeat(loadConfig(), { force: true, daily });
    return c.json(b ?? { status: "skipped" });
  });
  // '지금 점검': agenda phase 1 (always) → heartbeat judging from agenda.json (+ Sentry). Concurrent calls share one run.
  // GET /api/check tells the dashboard which step it is on (phase "agenda" → "judge").
  app.post("/api/check", async (c) => {
    const b = await runCheck(loadConfig(), { daily: c.req.query("daily") === "1" });
    return c.json(b ?? { status: "skipped" });
  });
  app.get("/api/check", (c) => c.json(checkStatus()));
  // 확인 완료 toggle: body {reviewed: boolean} (default true). The item stays in attention; counts skip it.
  // Validation + Slack seen mark + Gmail mark-read live in src/review.ts (shared with the MCP tool ned_mark_reviewed).
  app.post("/api/attention/:id/review", async (c) => {
    let reviewed = true;
    try { const b = (await c.req.json()) as { reviewed?: unknown }; if (typeof b?.reviewed === "boolean") reviewed = b.reviewed; } catch { /* no body = mark */ }
    const r = await reviewItem(c.req.param("id"), reviewed);
    return c.json(r.body, r.status);
  });
  app.post("/api/attention/:id/dismiss", (c) => {
    dismissAttention(c.req.param("id"));
    return c.json({ ok: true });
  });

  // HOME tab: agenda (calendar / jira / github), refreshed by a cheap structured claude -p job.
  // mail_enabled / slack_enabled (= sources.gmail / sources.slack) let HOME hide those cards even if agenda.json still has old data.
  app.get("/api/agenda", (c) => {
    const cfg = loadConfig();
    const { sources } = cfg;
    // A source switched off disappears now, not at the next agenda run (which also stops fetching / writes it empty).
    const a = readAgenda();
    const live = runningSources();
    return c.json({
      ...a,
      calendar: sources.calendar ? a.calendar : [],
      jira: sources.jira ? a.jira : [],
      github: sources.github ? a.github : [],
      mail: sources.gmail ? a.mail : null,
      slack: sources.slack ? a.slack : null,
      busy: agendaBusy(),
      running_sources: live,
      // Effective auto-refresh interval per source (config.agenda_source_minutes ?? agenda_refresh_minutes).
      refresh_minutes: Object.fromEntries(AGENDA_SOURCES.map((k) => [k, sourceRefreshMinutes(cfg, k)])),
      // Quiet hours / idle throttling of automatic runs (HOME status chip).
      ...schedulerStatus(cfg),
      // A "running" left on disk by a daemon that died mid-run would spin forever: only trust it while that source's run is live.
      sources_status: Object.fromEntries(Object.entries(a.sources_status ?? {}).map(([k, s]) => [k, s?.status === "running" && !live.includes(k as AgendaSourceKey) ? { ...s, status: "error", error: "interrupted" } : s])),
      context_status: contextStatus(),
      reviewed: readSourceReviewed(), // 확인 완료 marks for mail / slack / jira / github items (key → ms)
      mail_enabled: sources.gmail,
      slack_enabled: sources.slack,
      sources,
    });
  });
  app.post("/api/agenda/refresh", async (c) => {
    // Phase 1 only: returns once every source's list is merged (each lands in agenda.json as soon as its own call ends).
    // Phase 2 (reply context) keeps running in the background — see context_status.
    // body { sources?: ["slack", ...] } — default every enabled source. Per-source concurrency: a requested source that is
    // already running is not restarted; if *every* requested source is running → 409 { busy }. Otherwise the free ones
    // start and the response (after phase 1) lists `started` and `busy`.
    const cfg = loadConfig();
    let body: { sources?: unknown } = {};
    try { body = ((await c.req.json()) ?? {}) as { sources?: unknown }; } catch { /* no body = all sources */ }
    let sources: AgendaSourceKey[] | undefined;
    if (body.sources !== undefined) {
      if (!Array.isArray(body.sources) || body.sources.some((s) => !AGENDA_SOURCES.includes(s as AgendaSourceKey))) return c.json({ error: `sources must be an array of ${AGENDA_SOURCES.join("|")}` }, 400);
      sources = [...new Set(body.sources as AgendaSourceKey[])];
    }
    const busyNow = runningSources();
    const want = sources ? enabledSources(cfg).filter((k) => sources!.includes(k)) : enabledSources(cfg);
    if (want.length && want.every((k) => busyNow.includes(k))) return c.json({ error: "already running", busy: want }, 409);
    const run = startAgendaRefresh(cfg, { sources });
    log(`agenda: manual refresh [${run.started.join(",") || "-"}]${run.busy.length ? ` (joined running: ${run.busy.join(",")})` : ""}`);
    const a = await run.done;
    return c.json({ ...a, started: run.started, busy: run.busy, context_status: contextStatus(), mail_enabled: cfg.sources.gmail, slack_enabled: cfg.sources.slack });
  });
  // Phase 2 on demand (background). ?force=1 re-collects even for sources whose list didn't change.
  app.post("/api/agenda/context", (c) => {
    const force = c.req.query("force") === "1";
    const cfg = loadConfig();
    return c.json({ context_status: requestContext(cfg, ["slack", "mail"], { force }) });
  });
  // 수집 이력 (src/history.ts): a card's "지난 7일 / 30일" list, and 설정 → 수집·보관's status line.
  app.get("/api/history/status", (c) => c.json(historyStatus(loadConfig())));
  app.get("/api/history", (c) => {
    const source = c.req.query("source") as HistorySource;
    if (!HISTORY_SOURCES.includes(source)) return c.json({ error: `source must be one of ${HISTORY_SOURCES.join("|")}` }, 400);
    const q = c.req.query();
    return c.json(queryHistory(loadConfig(), readAgenda(), { source, days: Number(q.days ?? 7), q: (q.q ?? "").slice(0, 200), channel: q.channel, limit: Number(q.limit ?? 200) }));
  });
  app.get("/api/costs", (c) => c.json(costSummary(loadConfig().agenda_daily_budget_usd, Number(c.req.query("days") ?? 14))));

  // HOME tab: calendar ranges outside agenda.calendar_range (week view navigation). Cached 6 h; one claude -p at a time.
  app.get("/api/calendar", async (c) => {
    const from = c.req.query("from"), to = c.req.query("to");
    const bad = checkRange(from, to);
    if (bad) return c.json({ error: bad }, 400);
    return c.json(await fetchCalendarRange(loadConfig(), from as string, to as string));
  });

  // HOME tab: personal todos.
  const readBody = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  app.get("/api/todos", (c) => c.json(listTodos()));
  app.post("/api/todos", async (c) => {
    const body = await readBody(c);
    const origin = parseOrigin(body.origin);
    if (origin !== "chat") {
      const t = addTodo(body);
      return t ? c.json(t, 201) : c.json({ error: "title required" }, 400);
    }
    // From a Ned Net 확인 카드: needs actions.chat_write, and lands in the action log like any other chat write.
    const ts = new Date().toISOString();
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const entry = { ts, source: "todo", mode: "add", ref: { title: title.slice(0, 200) }, text: title.slice(0, 120), origin };
    if (loadConfig().actions.chat_write !== true) {
      appendActionLog({ ...entry, action: "refused", ok: false, result: "config.actions.chat_write is off — turn it on in settings to allow this" });
      return c.json({ ok: false, error: "config.actions.chat_write is off — turn it on in settings to allow this" }, 403);
    }
    const t = addTodo(body);
    if (!t) return c.json({ error: "title required" }, 400);
    appendActionLog({ ...entry, action: "todo_add", ok: true, result: `todo ${t.id}${t.due ? ` (마감 ${t.due})` : ""}` });
    return c.json(t, 201);
  });
  app.patch("/api/todos/:id", async (c) => {
    const t = updateTodo(c.req.param("id"), await readBody(c));
    if (t === "invalid") return c.json({ error: "title must be non-empty" }, 400);
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/todos/:id", (c) => (deleteTodo(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  // Reply drafts (read-only claude -p, user's own voice) and the opt-in send endpoint — the only write path in Ned.
  app.post("/api/draft", async (c) => {
    try {
      const r = await generateDraft(parseDraftRequest(await readBody(c)), loadConfig());
      const { hint: _h, tone: _t, created_at: _c, ...out } = r;
      return c.json(out);
    } catch (e) {
      if (e instanceof DraftError) return c.json({ error: e.message }, e.status);
      log(`draft: unexpected error ${String(e)}`);
      return c.json({ error: String(e) }, 500);
    }
  });
  app.get("/api/draft/status", (c) => c.json(pregenStatus()));
  // Connector sends take 30~60s (claude -p) — longer than the app's WebView waits — so they run as a job:
  // 202 {job_id} now, GET /api/send/:job_id for the result. A switched-off action is still refused here (403).
  const startJob = async (c: Context, req: SendRequest) => {
    const st = await startSendJob(req, loadConfig());
    if (st.kind === "sync") {
      const { status, ...out } = st.result;
      return c.json(status === 200 ? out : { ...out, error: out.detail }, status);
    }
    if (st.kind === "already_sent") {
      const { at, detail, job_id } = st.sent;
      return c.json({ ok: false, already_sent: true, sent_at: at, detail, link: linkOf(detail), job_id, error: `이미 전송됨 (${at})` }, 409);
    }
    return c.json({ ok: true, job_id: st.job.id, reused: st.reused, started_at: new Date(st.job.started_at).toISOString() }, 202);
  };
  const jobView = (c: Context) => {
    const j = getSendJob(c.req.param("job_id") ?? "");
    return j ? c.json(viewJob(j)) : c.json({ error: "unknown job (daemon restarted?) — look in GET /api/actions" }, 404);
  };
  app.post("/api/send", async (c) => {
    const req = parseSendRequest(await readBody(c));
    if (typeof req === "string") return c.json({ ok: false, error: req }, 400);
    if (req.mode === "create") return c.json({ ok: false, error: "calendar create goes through POST /api/calendar/events" }, 400);
    return startJob(c, req);
  });
  app.get("/api/send/:job_id", jobView);
  // New Google Calendar event (config.actions.calendar_create): same job flow as /api/send — 400 bad input, 403 off,
  // 202 {job_id} (joins an identical running request), 409 already_sent when the same title + time was created in 10 min.
  app.post("/api/calendar/events", async (c) => {
    const body = await readBody(c);
    const ev = parseCalendarCreate(body);
    if (typeof ev === "string") return c.json({ ok: false, error: ev }, 400);
    const origin = parseOrigin(body.origin);
    return startJob(c, { source: "calendar", mode: "create", text: "", ref: { title: ev.title, calendar_id: ev.calendar_id }, event: ev, ...(origin ? { origin } : {}) });
  });
  app.get("/api/calendar/events/:job_id", jobView);
  app.get("/api/actions", (c) => c.json(readActionLog(50)));
  // 대화창에서 세션 만들기 (config.actions.chat_session_create): 400 bad input / repo not registered, 403 off,
  // 409 over the cap (대화창 출처 살아 있는 세션 2개), else 202 {job_id} — worktree + claude + 첫 프롬프트 (~1-2분), poll the GET.
  app.post("/api/sessions/create", async (c) => {
    const input = parseSessionCreate(await readBody(c));
    if (typeof input === "string") return c.json({ ok: false, error: input }, 400);
    const st = await startSessionCreate(input, loadConfig(), readState().sessions ?? []);
    if (st.kind === "refused") {
      const { status, ...out } = st.result;
      return c.json({ ...out, error: out.detail }, status);
    }
    return c.json({ ok: true, job_id: st.job.id, reused: st.reused, started_at: new Date(st.job.started_at).toISOString() }, 202);
  });
  app.get("/api/sessions/create/:job_id", jobView);

  // Ned 채팅 (dashboard PDA → 대화). POST answers as text/event-stream: start → delta* (turn / tool) → done | error.
  // 400 empty / > CHAT_INPUT_MAX chars, 404 unknown conversation_id, 409 another turn running, 429 over the daily budget.
  // The turn keeps running (and is saved) if the browser goes away; POST /api/chat/:id/stop SIGTERMs it.
  app.post("/api/chat", async (c) => {
    const prep = prepareChatTurn(loadConfig(), await readBody(c));
    if (!prep.ok) {
      const { ok: _o, status, ...out } = prep;
      return c.json(out, status);
    }
    const enc = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (ev: string, data: Record<string, unknown>) => {
          if (closed) return;
          try { ctrl.enqueue(enc.encode(sseFrame(ev, data))); } catch { closed = true; }
        };
        void runChatTurn(prep, send).finally(() => {
          if (closed) return;
          closed = true;
          try { ctrl.close(); } catch { /* already gone */ }
        });
      },
      cancel() { closed = true; },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  });
  app.get("/api/chats", (c) => c.json({ chats: listChats(), active: activeChat(), input_max: CHAT_INPUT_MAX }));
  app.get("/api/chat/:id", (c) => {
    const chat = readChat(c.req.param("id"));
    return chat ? c.json({ ...chat, running: activeChat() === chat.id }) : c.json({ error: "not found" }, 404);
  });
  // 확인 카드 (actions.chat_write): check a ```ned-action proposal + build the request for the existing endpoint.
  // 200 {ok, endpoint, payload, …} · 400 malformed · 403 switched off · 409 target not among the known items.
  app.post("/api/chat/actions/validate", async (c) => {
    const body = await readBody(c);
    const cfg = loadConfig();
    const state = readState();
    const r = validateChatAction(cfg, body.block, { agenda: readAgenda(), state }, body.text);
    if (!r.ok) {
      const { status, ...out } = r;
      return c.json(out, status);
    }
    if (r.kind === "session_create") {
      // The Orca checks too (등록 레포 · 기존 워크트리 · 대화창 출처 상한 2) — read-only, so the card shows a refusal before [실행].
      const input = parseSessionCreate(r.payload);
      if (typeof input === "string") return c.json({ ok: false, error: input, kind: r.kind }, 400);
      const v = await validateSessionCreate(input, cfg, sessionCreateDeps(), state.sessions ?? []);
      if (!v.ok) return c.json({ ok: false, error: v.detail, kind: r.kind }, v.status);
    }
    return c.json(r);
  });
  // The card's state on its message (running → executed | failed, or cancelled); executed / cancelled are final (409).
  app.post("/api/chat/:id/action", async (c) => {
    const body = await readBody(c);
    const r = setChatActionState(c.req.param("id"), body.ts, body);
    if (!r.ok) return c.json({ ok: false, error: r.error }, r.status);
    return c.json(r);
  });
  app.post("/api/chat/:id/stop", (c) => (stopChat(c.req.param("id")) ? c.json({ ok: true }) : c.json({ ok: false, error: "not running" }, 404)));

  // 정리 결과물 (Ned Net ```ned-output blocks, src/outputs.ts): always in ~/.ned/outputs, + the vault with config.archive.
  app.get("/api/outputs", (c) => {
    const limit = Math.max(1, Math.min(500, Number(c.req.query("limit")) || 50));
    return c.json(listOutputs({ limit }).map(({ markdown: _m, ...r }) => r));
  });
  app.get("/api/outputs/:id", (c) => {
    const r = readOutput(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });
  // "Finder 에서 보기": `open -R` on the vault note (or the ~/.ned copy). Never spawns under tests / NED_NO_LLM.
  app.post("/api/outputs/:id/reveal", (c) => {
    const r = readOutput(c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const file = outputFile(r);
    if (!fs.existsSync(file)) return c.json({ ok: false, error: "파일이 없어 (옮겼거나 지웠어?)", path: file }, 404);
    if (process.env.VITEST || process.env.NED_NO_LLM === "1") return c.json({ ok: true, dry_run: true, path: file });
    execFile("open", ["-R", file], (err) => { if (err) log(`outputs: reveal failed — ${String(err).slice(0, 200)}`); });
    return c.json({ ok: true, path: file });
  });
  // Obsidian 아카이브 (src/archive.ts): 설정 → 아카이브 상태(볼트 배지·마지막 쓰기·마지막 오류) / "지금 쓰기".
  app.get("/api/archive/status", (c) => c.json(archiveStatus(loadConfig())));
  app.post("/api/archive/flush", (c) => {
    const r = archiveFlushNow(loadConfig());
    return c.json({ ...r, status: archiveStatus(loadConfig()) }, r.ok ? 200 : /꺼져/.test(r.error ?? "") ? 409 : 500);
  });

  // 시작하기 (src/setup-check.ts): per-source connector / gh status, Slack 팀 ID, code signing — cached 1 min, ?refresh=1 forces.
  app.get("/api/setup", async (c) => {
    const r = await setupCheck(loadConfig(), { refresh: c.req.query("refresh") === "1" });
    return c.json({ ...r, onboarding: readOnboarding() });
  });
  app.post("/api/setup/dismiss", async (c) => {
    const { dismissed } = (await readBody(c)) as { dismissed?: unknown };
    return c.json({ onboarding: setOnboardingDismissed(dismissed !== false) });
  });

  // 업데이트 확인 (src/update-check.ts): installed runtime version vs GitHub main (gh) / the marketplace clone — cached 10 min, ?refresh=1 forces.
  // ?refresh=1 also records the result for 자동 업데이트 (update-state.json → state.update_available); `status` = config.updates,
  // last / next automatic check, the last install attempt (src/self-update.ts updateStatus).
  app.get("/api/update-check", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    const r = await updateCheck({ refresh });
    if (refresh) recordCheck(r, Date.now());
    return c.json({ ...r, status: updateStatus(loadConfig()) });
  });
  // 설정 → 앱 → 업데이트 status line without running a check: config.updates, last/next check, last attempt, what is known newer.
  app.get("/api/update/status", (c) => c.json({ ...updateStatus(loadConfig()), update_available: readUpdateBadge() }));
  // 설정 → 앱 "지금 업데이트": fresh check, then scripts/self-update.sh detached (409 = nothing newer / already running).
  app.post("/api/update/install", async (c) => {
    const r = await installNow();
    return c.json({ ...r, status: updateStatus(loadConfig()) }, r.started ? 202 : 409);
  });

  registerSearch(app); // GET /api/search (src/search.ts) — before the static catch-all
  registerMcp(app); // POST/GET/DELETE /mcp — MCP Streamable HTTP endpoint (src/mcp.ts)
  // Static files under public/ (proposals, svg mark, ...). Registered last so /api/* wins.
  app.get("/*", (c) => {
    const file = resolvePublic(c.req.path);
    if (!file) return c.text("Not found", 404);
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return c.body(fs.readFileSync(file), 200, { "content-type": type, "cache-control": "no-cache" });
  });

  const port = getConfig().port;
  // 대화창 세션 만들기가 켜져 있으면 첫 대화 전에 Orca 등록 레포 목록을 읽어 둔다 (chatWriteBlock 은 캐시만 본다).
  const a0 = getConfig().actions;
  if (a0.chat_write && a0.chat_session_create) knownRepoPaths();
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  log(`dashboard on http://127.0.0.1:${port}`);
}
