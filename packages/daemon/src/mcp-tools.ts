/**
 * MCP 도구 (src/mcp.ts 가 /mcp 에 등록) — 어떤 Claude Code 세션에서도 Ned 가 모은 "확인할 것·세션·브리핑·이력·피드" 를
 * 읽고, 확인 완료(✓) 하나만 쓸 수 있게 한다. 핸들러는 디스크를 읽지 않는 순수 함수(ToolCtx 를 받는다) — 단,
 * ned_history 는 history/*.json 을 읽는 queryHistory 를, ned_mark_reviewed 는 POST /api/attention/:id/review 와 같은
 * reviewItem(src/review.ts)을 부른다. HTTP 자기 호출은 없다.
 *
 * 결과 크기 상한: 목록은 limit(기본 작게, 최대 MAX_*), 문자열은 clip — 한 번의 호출이 토큰을 폭주시키지 않게.
 * 각 핸들러는 { summary: 사람이 읽을 한 줄, data: 구조화된 JSON } 을 돌려주고, mcp.ts 가 텍스트 블록 두 개로 싼다.
 */
import { z } from "zod";
import type { Agenda } from "./agenda.js";
import { HISTORY_SOURCES, type HistorySource, type NedConfig } from "./config.js";
import { buildFeed } from "./feed.js";
import { queryHistory } from "./history.js";
import { reviewItem } from "./review.js";
import { activityMs, reviewedAt, srcKey } from "./review-keys.js";
import type { Briefing, BriefingSection, NedState, Reviewed } from "./state.js";

export interface ToolCtx {
  cfg: NedConfig;
  state: NedState;
  agenda: Agenda;
  /** reviewed.json (readReviewed) — ✓ marks of source items. */
  marks: Reviewed;
  /** Newest first (listBriefings). */
  briefings: Briefing[];
  now: number;
}

export interface ToolOut<T = unknown> {
  summary: string;
  data: T;
  /** A refused call (bad input / not found) — the MCP result gets isError. */
  error?: boolean;
}

export const MAX_ATTENTION = 100;
export const MAX_SESSIONS = 50;
export const MAX_BRIEFINGS = 5;
export const MAX_SECTION_ITEMS = 15;
export const MAX_HISTORY = 100;
export const MAX_FEED = 50;

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const iso = (ms: number | null | undefined): string | null => (ms && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const bound = (v: unknown, def: number, max: number): number => Math.max(1, Math.min(max, Math.trunc(Number(v)) || def));

// ---------- ned_attention ----------

export const ATTENTION_SOURCES = ["slack", "mail", "jira", "github", "calendar", "session", "sentry", "other"] as const;
export type AttentionSource = (typeof ATTENTION_SOURCES)[number];

export const attentionInput = {
  source: z.enum(ATTENTION_SOURCES).optional().describe("이 소스만 / only this source (slack|mail|jira|github|calendar|session|sentry|other)"),
  limit: z.number().int().min(1).max(MAX_ATTENTION).optional().describe(`최대 항목 수(기본 20) / max items (default 20, ≤${MAX_ATTENTION})`),
  include_reviewed: z.boolean().optional().describe("✓ 한 항목도 포함 / include items already marked reviewed (default false)"),
};

export interface AttentionRow {
  /** ✓ key for ned_mark_reviewed (attention id or mail:/slack:/jira:/github: key); null = can't be marked (calendar). */
  review_key: string | null;
  source: AttentionSource;
  title: string;
  detail: string;
  url: string | null;
  ts: string | null;
  open: boolean;
  reviewed_at: string | null;
  /** attention = Ned 의 판단(브리핑·세션), agenda = 소스 카드(메일·Slack·Jira·GitHub·일정). */
  from: "attention" | "agenda";
}

const KIND_SOURCE: Record<string, AttentionSource> = { email: "mail", slack: "slack", jira: "jira", github: "github", calendar: "calendar", session: "session", sentry: "sentry" };
const safeUrl = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

/** Every "확인할 것": attention items (state.json) + the source cards' items (agenda.json, source switched on), deduped by URL. */
export function attentionRows(ctx: ToolCtx): AttentionRow[] {
  const { state, agenda: a, cfg, marks, now } = ctx;
  const rows: AttentionRow[] = [];
  const urls = new Set<string>();
  for (const it of state.attention ?? []) {
    const url = safeUrl(it.url);
    if (url) urls.add(url);
    rows.push({ review_key: it.id, source: KIND_SOURCE[it.kind] ?? "other", title: clip(it.title, 200), detail: clip(it.detail, 300), url, ts: iso(it.ts), open: !it.reviewed_at, reviewed_at: iso(it.reviewed_at), from: "attention" });
  }
  const push = (kind: "email" | "slack" | "jira" | "github", source: AttentionSource, x: Parameters<typeof srcKey>[1], title: string, detail: string, url: string, tsMs: number) => {
    const u = safeUrl(url);
    if (u && urls.has(u)) return;
    if (u) urls.add(u);
    const key = srcKey(kind, x);
    const at = reviewedAt(marks, key, activityMs(kind, x));
    rows.push({ review_key: key || null, source, title: clip(title, 200), detail: clip(detail, 300), url: u, ts: iso(tsMs), open: !at, reviewed_at: iso(at), from: "agenda" });
  };
  if (cfg.sources.gmail) for (const m of a.mail?.items ?? []) push("email", "mail", m, m.subject, [m.from, m.why].filter(Boolean).join(" · "), m.url, Date.parse(m.received) || 0);
  if (cfg.sources.slack) for (const s of a.slack?.items ?? []) push("slack", "slack", s, s.text, [s.channel, s.from].filter(Boolean).join(" · "), s.url, Date.parse(s.ts) || 0);
  if (cfg.sources.jira) for (const j of a.jira) push("jira", "jira", j, `${j.key} ${j.title}`, [j.status, j.priority, j.due ? `마감 ${j.due}` : ""].filter(Boolean).join(" · "), j.url, Date.parse(j.updated) || 0);
  if (cfg.sources.github) for (const g of a.github) push("github", "github", g, `${g.repo}#${g.number} ${g.title}`, [g.reason, g.author ? `@${g.author}` : ""].filter(Boolean).join(" · "), g.url, Date.parse(g.updated) || 0);
  // 일정: 응답(RSVP)이 필요한, 아직 끝나지 않은 일정만 — ✓ 키는 없다.
  if (cfg.sources.calendar) for (const e of a.calendar) {
    const end = Date.parse(e.end) || Date.parse(e.start) || 0;
    if (e.rsvp !== "needsAction" || end < now) continue;
    const u = safeUrl(e.url);
    if (u && urls.has(u)) continue;
    rows.push({ review_key: null, source: "calendar", title: clip(e.title, 200), detail: clip(["응답 필요", e.all_day ? "종일" : e.start, e.location].filter(Boolean).join(" · "), 300), url: u, ts: iso(Date.parse(e.start) || 0), open: true, reviewed_at: null, from: "agenda" });
  }
  return rows.sort((x, y) => (Date.parse(y.ts ?? "") || 0) - (Date.parse(x.ts ?? "") || 0));
}

export function toolAttention(input: { source?: AttentionSource; limit?: number; include_reviewed?: boolean }, ctx: ToolCtx): ToolOut {
  const limit = bound(input.limit, 20, MAX_ATTENTION);
  const all = attentionRows(ctx).filter((r) => !input.source || r.source === input.source);
  const open = all.filter((r) => r.open).length;
  const pick = input.include_reviewed ? all : all.filter((r) => r.open);
  const items = pick.slice(0, limit);
  const by = Object.entries(items.reduce<Record<string, number>>((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(", ");
  const scope = input.source ? `${input.source} ` : "";
  return {
    summary: `${scope}확인할 것 ${open}건 열림${all.length > open ? ` (✓ ${all.length - open}건)` : ""} — ${items.length}건 반환${by ? ` (${by})` : ""}${pick.length > items.length ? `, ${pick.length - items.length}건 더 있음(limit)` : ""}`,
    data: { total: all.length, open, returned: items.length, items },
  };
}

// ---------- ned_sessions ----------

export const SESSION_STATUSES = ["running", "waiting", "done", "error"] as const;
export const sessionsInput = {
  status: z.enum(SESSION_STATUSES).optional().describe("이 상태만 / only this status (running|waiting|done|error)"),
  include_workers: z.boolean().optional().describe("Orca 워커 세션 포함 / include Orca worker sessions (default true)"),
  limit: z.number().int().min(1).max(MAX_SESSIONS).optional().describe(`최대 세션 수(기본 20) / max sessions (default 20, ≤${MAX_SESSIONS})`),
};

export function toolSessions(input: { status?: (typeof SESSION_STATUSES)[number]; include_workers?: boolean; limit?: number }, ctx: ToolCtx): ToolOut {
  const limit = bound(input.limit, 20, MAX_SESSIONS);
  const all = (ctx.state.sessions ?? []).filter((s) => (input.include_workers ?? true) || !s.is_worker).filter((s) => !input.status || s.status === input.status);
  const sessions = all.slice(0, limit).map((s) => ({
    id: s.id.slice(0, 8),
    worktree: s.worktree,
    cwd: s.cwd,
    status: s.status,
    waiting_for_input: s.status === "waiting",
    since: iso(s.since),
    last_event: iso(s.last_event_ts),
    last_prompt: s.last_prompt ? clip(s.last_prompt, 200) : null,
    last_summary: s.last_summary ? clip(s.last_summary, 300) : null,
    subagents_active: s.subagents_active,
    is_worker: s.is_worker,
    ...(s.origin ? { origin: s.origin } : {}),
  }));
  const count = (st: string) => all.filter((s) => s.status === st).length;
  return {
    summary: `세션 ${all.length}개 — 입력 대기 ${count("waiting")}, 실행 중 ${count("running")}, 완료 ${count("done")}, 오류 ${count("error")}${all.length > sessions.length ? ` (${sessions.length}개만 반환)` : ""}`,
    data: { total: all.length, returned: sessions.length, sessions },
  };
}

// ---------- ned_briefing ----------

export const briefingInput = {
  since: z.string().max(40).optional().describe("이 시각 이후 브리핑들(ISO 날짜/시각) — 없으면 최신 1개 / briefings after this ISO time; omitted = the latest one"),
  limit: z.number().int().min(1).max(MAX_BRIEFINGS).optional().describe(`since 와 함께 최대 개수(기본 3) / max briefings with since (default 3, ≤${MAX_BRIEFINGS})`),
};

const sections = (list: BriefingSection[] | undefined) =>
  (list ?? []).slice(0, MAX_SECTION_ITEMS).map((s) => ({ title: clip(s.title, 200), ...(s.detail ? { detail: clip(s.detail, 400) } : {}), ...(safeUrl(s.url) ? { url: s.url } : {}), ...(s.kind ? { kind: s.kind } : {}) }));

export function briefingView(b: Briefing) {
  const ok = b.ok ?? b.raw === undefined;
  return {
    id: b.id,
    type: b.type,
    status: b.status,
    ok,
    ts: iso(b.ts),
    headline: b.headline ? clip(b.headline, 300) : null,
    action_items: sections(b.action_items),
    updates: sections(b.updates),
    fyi: sections(b.fyi),
    sessions: sections(b.sessions),
    ...(!ok && b.raw ? { raw: clip(b.raw, 500) } : {}),
  };
}

export function toolBriefing(input: { since?: string; limit?: number }, ctx: ToolCtx): ToolOut {
  let list: Briefing[];
  if (input.since) {
    const lo = Date.parse(input.since);
    if (!Number.isFinite(lo)) return { summary: `since 를 읽을 수 없어: ${clip(input.since, 40)} (ISO 날짜/시각)`, data: { error: "bad since" }, error: true };
    list = ctx.briefings.filter((b) => b.ts > lo).slice(0, bound(input.limit, 3, MAX_BRIEFINGS));
  } else list = ctx.briefings.slice(0, 1);
  if (!list.length) return { summary: input.since ? "그 이후 브리핑 없음" : "브리핑 없음 (아직 순찰 전)", data: { briefings: [] } };
  const b = list[0];
  const head = `${b.type === "daily" ? "아침 브리핑" : "순찰"} ${iso(b.ts)} · ${b.status}${b.headline ? ` — ${clip(b.headline, 120)}` : ""} · 할 일 ${(b.action_items ?? []).length}건`;
  return { summary: list.length > 1 ? `브리핑 ${list.length}개, 최신: ${head}` : head, data: { briefings: list.map(briefingView) } };
}

// ---------- ned_history ----------

export const historyInput = {
  source: z.enum(HISTORY_SOURCES).describe("소스 / source (slack|mail|jira|github|calendar)"),
  days: z.number().int().min(1).max(90).optional().describe("지난 N일(기본 1) / last N days (default 1, ≤90)"),
  q: z.string().max(200).optional().describe("제목·내용 검색어(모든 토큰 포함) / search tokens, all must match"),
  channel: z.string().max(100).optional().describe("slack: 이 채널만 / slack: only this channel (#ops or ops)"),
  limit: z.number().int().min(1).max(MAX_HISTORY).optional().describe(`최대 항목 수(기본 20) / max items (default 20, ≤${MAX_HISTORY})`),
};

export function toolHistory(input: { source: HistorySource; days?: number; q?: string; channel?: string; limit?: number }, ctx: ToolCtx): ToolOut {
  if (!HISTORY_SOURCES.includes(input.source)) return { summary: `source must be one of ${HISTORY_SOURCES.join("|")}`, data: { error: "bad source" }, error: true };
  const limit = bound(input.limit, 20, MAX_HISTORY);
  const r = queryHistory(ctx.cfg, ctx.agenda, { source: input.source, days: input.days ?? 1, q: (input.q ?? "").slice(0, 200), channel: input.channel, limit }, ctx.now);
  const items = r.items.map((x) => ({ key: x.key, ts: x.ts, title: clip(x.title, 200), detail: clip(x.detail, 300), url: safeUrl(x.url), ...(x.channel ? { channel: x.channel } : {}), current: x.current }));
  return {
    summary: `${input.source} 이력 지난 ${r.days}일 ${r.total}건${r.total > items.length ? ` (${items.length}건 반환)` : ""}`,
    data: { source: r.source, days: r.days, total: r.total, returned: items.length, items },
  };
}

// ---------- ned_feed ----------

export const feedInput = {
  limit: z.number().int().min(1).max(MAX_FEED).optional().describe(`최대 항목 수(기본 10) / max items (default 10, ≤${MAX_FEED})`),
};

export function toolFeed(input: { limit?: number }, ctx: ToolCtx): ToolOut {
  const limit = bound(input.limit, 10, MAX_FEED);
  const all = buildFeed({ state: ctx.state, briefings: ctx.briefings, agenda: { slack: ctx.cfg.sources.slack ? ctx.agenda.slack : null } }, ctx.now);
  const items = all.slice(0, limit).map((f) => ({ key: f.key, kind: f.kind, title: f.title, detail: f.detail, url: f.url, ts: iso(f.ts) }));
  return { summary: `피드 ${all.length}건${all.length > items.length ? ` (최근 ${items.length}건 반환)` : ""}${items[0] ? ` — 최신: ${items[0].title}` : ""}`, data: { total: all.length, returned: items.length, items } };
}

// ---------- ned_mark_reviewed (the only write) ----------

export const markReviewedInput = {
  review_key: z.string().min(1).max(300).describe("ned_attention 의 review_key (예: jira:AB-12, slack:C1:1730000000.000100, session:…) / the review_key from ned_attention"),
  reviewed: z.boolean().optional().describe("true = ✓ 확인 완료(기본), false = 해제 / true = mark reviewed (default), false = unmark"),
};

export async function toolMarkReviewed(input: { review_key: string; reviewed?: boolean }): Promise<ToolOut> {
  const reviewed = input.reviewed ?? true;
  const r = await reviewItem(String(input.review_key ?? ""), reviewed);
  if (r.status !== 200) return { summary: `${r.status} ${r.body.error}: ${clip(input.review_key, 80)}`, data: { status: r.status, ...r.body }, error: true };
  return { summary: `${reviewed ? "✓ 확인 완료" : "✓ 해제"}: ${r.body.id} — 열린 attention ${r.body.attention_open_count}건`, data: r.body };
}
