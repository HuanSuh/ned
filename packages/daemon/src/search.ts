import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { readAgenda } from "./agenda.js";
import { HISTORY_SOURCES, loadConfig, type HistorySource, type NedConfig } from "./config.js";
import { currentKeys, describeRecord, excludedSlack, readHistory, recording, type HistRecord } from "./history.js";
import type { Agenda } from "./agenda.js";
import { readRecentEvents, type NedEvent } from "./events.js";
import { listBriefings } from "./heartbeat.js";
import { NED_HOME, TODOS_PATH, readJson } from "./paths.js";
import { briefingOk, readSourceReviewed, readState, type AttentionItem, type BriefingSection } from "./state.js";
import type { Todo } from "./todos.js";
import { activityMs, reviewedAt, srcKey, type Marks } from "./review-keys.js";
import { parseQuery, runQuery, type FilterFields } from "./search-query.js";

/**
 * GET /api/search?q=&limit=50 — one ranked list over everything Ned keeps on disk: state (attention, sessions),
 * every briefing file, the last 30 days of events, todos, agenda.json, the 수집 이력 (src/history.ts — records not already
 * shown by agenda.json, so a hit appears once) and drafts (if a drafts store exists).
 * The dashboard's ⌘K palette searches what it already loaded locally and merges these hits (deduped on type+id)
 * for older briefings / events. Read-only: nothing here writes (listTodos would prune, so todos are read raw).
 */

export type SearchType = "attention" | "session" | "calendar" | "jira" | "github" | "mail" | "slack" | "todo" | "briefing" | "event" | "draft";
export type SearchTab = "home" | "inbox" | "timeline" | "settings";

export interface SearchHit {
  type: SearchType;
  id: string;
  title: string;
  detail: string;
  ts: number | null;
  url: string | null;
  /** AttentionKind-ish icon key (email / slack / jira / github / session / calendar / other …). */
  kind: string;
  /** Dashboard tab the item lives on. */
  tab: SearchTab;
  /** Where in that tab: "row:<attention id>", "briefing:<id>", "card:<mail|jira|slack|gh|todo|cal>", "card:watch:<channel>", "day:YYYY-MM-DD", "session:<id>". */
  anchor: string;
  score: number;
  /** briefing hits: its items, so the palette can show a briefing the page hasn't loaded. */
  items?: Array<BriefingSection & { section: string }>;
  /** event / draft hits: the full text (title is clipped). */
  body?: string;
}

// ---------- matching + 검색 키: src/search-query.ts (shared with public/app/features/searchq.js) ----------

export { scoreFields, tokenize } from "./search-query.js";

// ---------- sources ----------

const isoTs = (s: unknown): number | null => {
  const t = typeof s === "string" || typeof s === "number" ? new Date(s).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
const url = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const base = (p: unknown) => (p ? String(p).replace(/\/+$/, "").split("/").pop() ?? "" : "");
const two = (n: number) => String(n).padStart(2, "0");
const hm = (ts: number | null) => (ts == null ? "" : `${two(new Date(ts).getHours())}:${two(new Date(ts).getMinutes())}`);
const localDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

const EVENT_KO: Record<string, string> = { SessionStart: "세션 시작", SessionEnd: "세션 종료", UserPromptSubmit: "프롬프트", SubagentStart: "서브에이전트 시작", SubagentStop: "서브에이전트 종료", Notification: "알림", Stop: "응답 완료", StopFailure: "오류", PreCompact: "컨텍스트 압축" };

/** Event identity shared with the client: ts + event + session. */
export const eventId = (e: Pick<NedEvent, "ts" | "event" | "session_id">) => `${e.ts}:${e.event}:${e.session_id ?? ""}`;

/** Text fields (weighted, scored) + structured fields for the 검색 키 filters (src / people / channel / ts / done / mine). */
type Cand = Omit<SearchHit, "score"> & Omit<FilterFields, "type" | "ts"> & { fields: Array<[unknown, number]> };

const ATT_SRC: Record<string, string> = { email: "mail", slack: "slack", jira: "jira", github: "github", calendar: "calendar", session: "session" };
/** ✓ 처리: a 확인 완료 mark that still covers the item (same key / rule as the cards — src/review-keys.ts). */
const revDone = (marks: Marks, kind: string, x: Parameters<typeof srcKey>[1]) => reviewedAt(marks, srcKey(kind, x), activityMs(kind, x)) > 0;
const MY_PR = /^my_pr/;
/** How the agenda writes my own Slack messages (DM / 팔로업 recent rows). */
const ME = "나";

function drafts(): Cand[] {
  // Drafts store isn't settled yet: accept NED_HOME/drafts.json (array or {drafts: []}) or NED_HOME/drafts/*.json.
  const rows: Record<string, unknown>[] = [];
  const file = path.join(NED_HOME, "drafts.json");
  const j = readJson<unknown>(file, null);
  if (Array.isArray(j)) rows.push(...j);
  else if (j && typeof j === "object" && Array.isArray((j as { drafts?: unknown }).drafts)) rows.push(...((j as { drafts: Record<string, unknown>[] }).drafts));
  const dir = path.join(NED_HOME, "drafts");
  try {
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) {
      const d = readJson<unknown>(path.join(dir, f), null);
      if (d && typeof d === "object" && !Array.isArray(d)) rows.push({ id: f.replace(/\.json$/, ""), ...(d as Record<string, unknown>) });
    }
  } catch {
    /* no drafts dir */
  }
  return rows
    .filter((d) => d && typeof d === "object")
    .map((d, i) => {
      const title = String(d.title ?? d.subject ?? d.summary ?? "(초안)");
      const body = String(d.body ?? d.text ?? d.content ?? "");
      const to = String(d.to ?? d.channel ?? d.target ?? "");
      return {
        type: "draft" as const,
        id: String(d.id ?? i),
        title,
        detail: [to, body.replace(/\s+/g, " ").slice(0, 140)].filter(Boolean).join(" · "),
        ts: isoTs(d.updated_at ?? d.created_at ?? d.ts),
        url: url(d.url),
        kind: String(d.kind ?? d.source ?? "other"),
        tab: "inbox" as const,
        anchor: `draft:${String(d.id ?? i)}`,
        body: body.slice(0, 2000) || undefined,
        src: "draft",
        fields: [[title, 3], [to, 2], [body, 1]],
      };
    });
}

function candidates(): Cand[] {
  const out: Cand[] = [];
  const cfg = loadConfig();
  const st = readState();
  const marks = readSourceReviewed();

  const att = (a: AttentionItem): Cand => ({
    type: "attention", id: a.id, title: a.title, detail: a.detail ?? "", ts: a.ts, url: url(a.url), kind: a.kind, tab: "inbox", anchor: `row:${a.id}`,
    src: ATT_SRC[a.kind] ?? "attention", done: !!a.reviewed_at,
    fields: [[a.title, 3], [a.kind, 2], [a.detail, 1]],
  });
  out.push(...st.attention.map(att));

  for (const s of st.sessions) {
    out.push({
      type: "session", id: s.id, title: s.worktree, detail: s.last_summary ?? s.last_prompt ?? s.status, ts: s.last_event_ts, url: null, kind: "session", tab: "inbox", anchor: `session:${s.id}`, src: "session",
      fields: [[s.worktree, 3], [s.status, 2], [s.cwd, 1], [s.last_prompt, 1], [s.last_summary, 1]],
    });
  }

  const a = readAgenda();
  if (cfg.sources.calendar) for (const c of a.calendar) {
    out.push({
      type: "calendar", id: c.id, title: c.title, detail: [c.all_day ? "종일" : hm(isoTs(c.start)), c.location].filter(Boolean).join(" · "), ts: isoTs(c.start), url: url(c.url) ?? url(c.meet_url), kind: "calendar", tab: "home", anchor: "card:cal", src: "calendar",
      fields: [[c.title, 3], [c.location, 1]],
    });
  }
  if (cfg.sources.jira) for (const j of a.jira) {
    out.push({
      type: "jira", id: j.key, title: j.title, detail: [j.key, j.status, j.priority, j.due ? `마감 ${j.due}` : ""].filter(Boolean).join(" · "), ts: isoTs(j.updated), url: url(j.url), kind: "jira", tab: "home", anchor: "card:jira",
      // Jira 는 agenda 데이터에 사람 필드(담당자·보고자)가 없어 from: 대상 아님 (people 없음).
      src: "jira", done: revDone(marks, "jira", j),
      fields: [[j.title, 3], [j.key, 3], [j.status, 1], [j.priority, 1]],
    });
  }
  if (cfg.sources.github) for (const g of a.github) {
    out.push({
      type: "github", id: `${g.repo}#${g.number}`, title: g.title, detail: `${g.repo}#${g.number} · @${g.author}`, ts: isoTs(g.updated), url: url(g.url), kind: "github", tab: "home", anchor: "card:gh",
      src: "github", people: g.author ? [g.author] : [], done: revDone(marks, "github", g), mine: MY_PR.test(g.reason ?? "") || undefined,
      fields: [[g.title, 3], [`${g.repo}#${g.number}`, 2], [g.author, 2], [g.reason, 1]],
    });
  }
  if (cfg.sources.gmail && a.mail) {
    const seen = new Set<string>();
    for (const m of [...a.mail.items.map((x) => ({ id: x.id, from: x.from, subject: x.subject, snippet: x.why || x.snippet, ts: x.received, url: x.url })), ...a.mail.all.map((x) => ({ id: x.id, from: x.from, subject: x.subject, snippet: "", ts: x.ts, url: x.url }))]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({
        type: "mail", id: m.id, title: m.subject || "(제목 없음)", detail: [m.from, m.snippet].filter(Boolean).join(" · "), ts: isoTs(m.ts), url: url(m.url), kind: "email", tab: "home", anchor: "card:mail",
        src: "mail", people: m.from ? [m.from] : [], done: revDone(marks, "email", m),
        fields: [[m.subject, 3], [m.from, 2], [m.snippet, 1]],
      });
    }
  }
  if (cfg.sources.slack && a.slack) {
    const seen = new Set<string>();
    for (const x of [...a.slack.items, ...a.slack.all]) {
      const id = x.url || `${x.channel}:${x.ts}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        type: "slack", id, title: x.text || "(내용 없음)", detail: [`${x.channel} · ${x.from}`, x.thread?.thread_summary].filter(Boolean).join(" — "), ts: isoTs(x.ts), url: url(x.url), kind: "slack", tab: "home", anchor: "card:slack",
        src: "slack", people: x.from ? [x.from] : [], channel: x.channel, done: revDone(marks, "slack", x), mine: x.from === ME || undefined,
        // Followed thread: its summary and latest reply are searchable too.
        fields: [[x.text, 3], [x.channel, 2], [x.from, 2], [x.thread?.thread_summary, 2], [x.thread?.last_reply_text, 1], [x.thread?.last_reply_from, 1]],
      });
    }
    // 팔로업 channel highlights: their own card (`card:watch:<channel>`) unless dashboard.watch_cards is off (→ the Slack card's fold).
    for (const w of a.slack.watch ?? []) for (const h of w.highlights ?? []) {
      const id = h.url || `${w.channel}:${h.ts}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        type: "slack", id, title: h.text || "(내용 없음)", detail: `${w.channel} · ${h.from}${h.needs_me ? " · 나한테" : ""}`, ts: isoTs(h.ts), url: url(h.url), kind: "slack", tab: "home",
        anchor: cfg.dashboard.watch_cards === false ? "card:slack" : `card:watch:${w.channel.replace(/^#+/, "")}`,
        src: "slack", people: h.from ? [h.from] : [], channel: w.channel, done: revDone(marks, "slack", h), mine: h.from === ME || undefined,
        fields: [[h.text, 3], [w.channel, 2], [h.from, 2], [w.summary, 1]],
      });
    }
  }

  out.push(...historyCands(cfg, a, marks));

  const todos = readJson<Todo[]>(TODOS_PATH, []);
  if (Array.isArray(todos)) for (const t of todos) {
    out.push({
      type: "todo", id: t.id, title: t.title, detail: [t.done ? "완료" : "", t.due ? `마감 ${t.due}` : "", t.note ?? ""].filter(Boolean).join(" · "), ts: t.created_at, url: null, kind: "me", tab: "home", anchor: "card:todo",
      src: "todo", done: !!t.done,
      fields: [[t.title, 3], [t.note, 1]],
    });
  }

  for (const b of listBriefings(100_000)) {
    const items: BriefingSection[] = [...(b.action_items ?? []), ...(b.updates ?? []), ...(b.fyi ?? []), ...(b.sessions ?? [])];
    const label = `${b.type === "daily" ? "아침 브리핑" : "점검"}${briefingOk(b) ? "" : " (실패)"}`;
    out.push({
      type: "briefing", id: b.id, title: b.headline || `${label} · ${!briefingOk(b) ? "Claude 실패" : b.status === "NED_OK" ? "이상 무" : `${items.length}건`}`, detail: items.map((x) => x.title).slice(0, 3).join(" · ") || label, ts: b.ts, url: null, kind: "briefing", tab: "inbox", anchor: `briefing:${b.id}`,
      items: (["action_items", "updates", "fyi", "sessions"] as const).flatMap((sec) => (b[sec] ?? []).map((x) => ({ section: sec, title: x.title, detail: x.detail, url: url(x.url) ?? undefined, kind: x.kind }))),
      src: "briefing",
      fields: [[b.headline, 3], [label, 1], [b.status, 1], ...items.flatMap((x): Array<[unknown, number]> => [[x.title, 2], [x.detail, 1], [x.kind, 1]])],
    });
  }

  for (const e of readRecentEvents(30)) {
    const msg = e.prompt ?? e.message ?? e.reason ?? (e.agent_type ? `agent ${e.agent_type}` : "");
    const wt = e.orca_worktree ? base(String(e.orca_worktree).split("::").pop()) : base(e.cwd);
    const label = EVENT_KO[e.event] ?? e.event;
    out.push({
      type: "event", id: eventId(e), title: msg ? String(msg).replace(/\s+/g, " ").slice(0, 160) : label, detail: [label, wt].filter(Boolean).join(" · "), ts: e.ts, url: null, kind: "event", tab: "timeline", anchor: `day:${localDay(e.ts)}`, body: msg ? String(msg).slice(0, 2000) : undefined,
      src: "event",
      fields: [[msg, 3], [wt, 2], [label, 1], [e.event, 1], [e.notification_type, 1]],
    });
  }

  out.push(...drafts());
  return out;
}

const HIST_TYPE: Record<HistorySource, SearchType> = { slack: "slack", mail: "mail", jira: "jira", github: "github", calendar: "calendar" };
const HIST_KIND: Record<HistorySource, string> = { slack: "slack", mail: "email", jira: "jira", github: "github", calendar: "calendar" };
const HIST_CARD: Record<HistorySource, string> = { slack: "card:slack", mail: "card:mail", jira: "card:jira", github: "card:gh", calendar: "card:cal" };
const srcOn = (cfg: NedConfig, s: HistorySource) => (s === "mail" ? cfg.sources.gmail : cfg.sources[s]) !== false;

/**
 * 수집 이력 records as hits (same type / id scheme as the agenda hits, so the palette dedupes them), minus what agenda.json
 * shows now (currentKeys — those are hits already). Detail says "이력 · M/D"; anchor = the source's card.
 */
export function historyCands(cfg: NedConfig, a: Agenda, marks: Marks = readSourceReviewed()): Cand[] {
  if (cfg.history?.enabled === false) return [];
  const cur = currentKeys(a);
  const out: Cand[] = [];
  for (const src of HISTORY_SOURCES) {
    if (!srcOn(cfg, src) || !recording(cfg, src)) continue;
    for (const r of readHistory(src)) {
      if (cur[src].has(r.key) || excludedSlack(cfg, r)) continue;
      const d = describeRecord(r), it = r.item as Record<string, any>, ts = isoTs(r.ts);
      const day = ts ? `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}` : "";
      const watchCh = src === "slack" && it.watch?.channel && !(r.state as { reason?: string }).reason ? String(it.watch.channel).replace(/^#+/, "") : "";
      out.push({
        type: HIST_TYPE[src],
        id: histId(r),
        title: d.title,
        detail: ["이력", day, d.detail].filter(Boolean).join(" · "),
        ts,
        url: url(d.url),
        kind: HIST_KIND[src],
        tab: "home",
        anchor: watchCh && cfg.dashboard.watch_cards !== false ? `card:watch:${watchCh}` : HIST_CARD[src],
        ...histFilterFields(src, it, d.channel),
        done: src === "calendar" ? undefined : revDone(marks, HIST_KIND[src], it),
        fields: [[d.title, 3], [d.detail, 2], [it.subject ?? it.key ?? it.repo, 2], [it.why ?? it.snippet ?? it.location, 1]],
      });
    }
  }
  return out;
}

/** The id an agenda hit of the same item would have (slack: permalink, mail: thread id, jira: key, github: repo#n, calendar: event id). */
function histId(r: HistRecord): string {
  const it = r.item as Record<string, any>;
  if (r.source === "slack") return String(it.url || r.key);
  if (r.source === "github" && it.repo) return `${it.repo}#${it.number}`;
  if (r.source === "calendar") return String(it.id || r.key);
  return r.key;
}

/** History record → src / people / channel / mine (only fields the record has). */
function histFilterFields(src: HistorySource, it: Record<string, any>, channel?: string): Pick<Cand, "src" | "people" | "channel" | "mine"> {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? [v] : []);
  if (src === "slack") {
    const from = it.from ?? it.watch?.from;
    return { src, people: s(from), channel: channel || undefined, mine: from === ME || undefined };
  }
  if (src === "mail") return { src, people: s(it.from) };
  if (src === "github") return { src, people: s(it.author), mine: MY_PR.test(String(it.reason ?? "")) || undefined };
  return { src }; // jira (no person fields — not a from: target), calendar
}

/**
 * Ranked hits for a ⌘K query — the same parser / filters / ranking as the palette (src/search-query.ts): words score,
 * 검색 키 (source: from: channel: #채널 days: after: before: is:) filter; keys only = newest first.
 */
export function search(q: string, limit = 50): SearchHit[] {
  const now = Date.now();
  const pq = parseQuery(q, now);
  if (!pq.terms.length && !pq.active) return [];
  // The filter fields (src / people / channel / done / mine) are internal like `fields` — not part of the hit.
  return runQuery(candidates(), pq, now)
    .slice(0, limit)
    .map(({ fields: _f, src: _s, people: _p, channel: _c, done: _d, mine: _m, ...c }) => ({ ...c, score: Math.round(c.score * 10) / 10 }));
}

export function registerSearch(app: Hono): void {
  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(c.req.query("limit") ?? 50)) || 50));
    return c.json(search(q.slice(0, 200), limit));
  });
}
