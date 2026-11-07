import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { readAgenda } from "./agenda.js";
import { loadConfig } from "./config.js";
import { readRecentEvents, type NedEvent } from "./events.js";
import { listBriefings } from "./heartbeat.js";
import { NED_HOME, TODOS_PATH, readJson } from "./paths.js";
import { briefingOk, readState, type AttentionItem, type BriefingSection } from "./state.js";
import type { Todo } from "./todos.js";

/**
 * GET /api/search?q=&limit=50 — one ranked list over everything Ned keeps on disk: state (attention, sessions),
 * every briefing file, the last 30 days of events, todos, agenda.json and drafts (if a drafts store exists).
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

// ---------- matching (mirrors public/search.js) ----------

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const norm = (s: unknown): string => String(s ?? "").normalize("NFC").toLowerCase();
/** Hangul syllables → their initial consonant (초성); everything else unchanged. */
function chosung(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}
const isCho = (t: string) => /^[ㄱ-ㅎ]+$/.test(t);
const WORD_SEP = /[\s\-_/#@:.,()[\]<>"'·|]/;

/** 6 = field starts with token, 4 = a word starts with it, 2 = substring, 1.5 = 초성 match, 0 = none. */
function tokenScore(text: string, tok: string): number {
  if (!text) return 0;
  if (text.startsWith(tok)) return 6;
  let i = text.indexOf(tok);
  if (i >= 0) {
    for (; i >= 0; i = text.indexOf(tok, i + 1)) if (WORD_SEP.test(text[i - 1] ?? " ")) return 4;
    return 2;
  }
  if (isCho(tok) && chosung(text).includes(tok)) return 1.5;
  return 0;
}

export function tokenize(q: string): string[] {
  return norm(q).split(/\s+/).filter(Boolean).slice(0, 8);
}

/** Fields: [text, weight]. Every token must match some field (AND); score = Σ best weight×tokenScore + recency. */
export function scoreFields(fields: Array<[unknown, number]>, toks: string[], ts: number | null, now = Date.now()): number {
  if (!toks.length) return 0;
  const f = fields.map(([t, w]) => [norm(t), w] as const).filter(([t]) => t);
  let total = 0;
  for (const tok of toks) {
    let best = 0;
    for (const [t, w] of f) best = Math.max(best, tokenScore(t, tok) * w);
    if (!best) return 0;
    total += best;
  }
  if (ts) {
    const days = Math.abs(now - ts) / 86_400_000;
    total += days < 1 ? 2 : days < 7 ? 1 : 0;
  }
  return total;
}

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

type Cand = Omit<SearchHit, "score"> & { fields: Array<[unknown, number]> };

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
        fields: [[title, 3], [to, 2], [body, 1]],
      };
    });
}

function candidates(): Cand[] {
  const out: Cand[] = [];
  const cfg = loadConfig();
  const st = readState();

  const att = (a: AttentionItem): Cand => ({
    type: "attention", id: a.id, title: a.title, detail: a.detail ?? "", ts: a.ts, url: url(a.url), kind: a.kind, tab: "inbox", anchor: `row:${a.id}`,
    fields: [[a.title, 3], [a.kind, 2], [a.detail, 1]],
  });
  out.push(...st.attention.map(att));

  for (const s of st.sessions) {
    out.push({
      type: "session", id: s.id, title: s.worktree, detail: s.last_summary ?? s.last_prompt ?? s.status, ts: s.last_event_ts, url: null, kind: "session", tab: "inbox", anchor: `session:${s.id}`,
      fields: [[s.worktree, 3], [s.status, 2], [s.cwd, 1], [s.last_prompt, 1], [s.last_summary, 1]],
    });
  }

  const a = readAgenda();
  if (cfg.sources.calendar) for (const c of a.calendar) {
    out.push({
      type: "calendar", id: c.id, title: c.title, detail: [c.all_day ? "종일" : hm(isoTs(c.start)), c.location].filter(Boolean).join(" · "), ts: isoTs(c.start), url: url(c.url) ?? url(c.meet_url), kind: "calendar", tab: "home", anchor: "card:cal",
      fields: [[c.title, 3], [c.location, 1]],
    });
  }
  if (cfg.sources.jira) for (const j of a.jira) {
    out.push({
      type: "jira", id: j.key, title: j.title, detail: [j.key, j.status, j.priority, j.due ? `마감 ${j.due}` : ""].filter(Boolean).join(" · "), ts: isoTs(j.updated), url: url(j.url), kind: "jira", tab: "home", anchor: "card:jira",
      fields: [[j.title, 3], [j.key, 3], [j.status, 1], [j.priority, 1]],
    });
  }
  if (cfg.sources.github) for (const g of a.github) {
    out.push({
      type: "github", id: `${g.repo}#${g.number}`, title: g.title, detail: `${g.repo}#${g.number} · @${g.author}`, ts: isoTs(g.updated), url: url(g.url), kind: "github", tab: "home", anchor: "card:gh",
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
        fields: [[h.text, 3], [w.channel, 2], [h.from, 2], [w.summary, 1]],
      });
    }
  }

  const todos = readJson<Todo[]>(TODOS_PATH, []);
  if (Array.isArray(todos)) for (const t of todos) {
    out.push({
      type: "todo", id: t.id, title: t.title, detail: [t.done ? "완료" : "", t.due ? `마감 ${t.due}` : "", t.note ?? ""].filter(Boolean).join(" · "), ts: t.created_at, url: null, kind: "me", tab: "home", anchor: "card:todo",
      fields: [[t.title, 3], [t.note, 1]],
    });
  }

  for (const b of listBriefings(100_000)) {
    const items: BriefingSection[] = [...(b.action_items ?? []), ...(b.updates ?? []), ...(b.fyi ?? []), ...(b.sessions ?? [])];
    const label = `${b.type === "daily" ? "아침 브리핑" : "점검"}${briefingOk(b) ? "" : " (실패)"}`;
    out.push({
      type: "briefing", id: b.id, title: b.headline || `${label} · ${!briefingOk(b) ? "Claude 실패" : b.status === "NED_OK" ? "이상 무" : `${items.length}건`}`, detail: items.map((x) => x.title).slice(0, 3).join(" · ") || label, ts: b.ts, url: null, kind: "briefing", tab: "inbox", anchor: `briefing:${b.id}`,
      items: (["action_items", "updates", "fyi", "sessions"] as const).flatMap((sec) => (b[sec] ?? []).map((x) => ({ section: sec, title: x.title, detail: x.detail, url: url(x.url) ?? undefined, kind: x.kind }))),
      fields: [[b.headline, 3], [label, 1], [b.status, 1], ...items.flatMap((x): Array<[unknown, number]> => [[x.title, 2], [x.detail, 1], [x.kind, 1]])],
    });
  }

  for (const e of readRecentEvents(30)) {
    const msg = e.prompt ?? e.message ?? e.reason ?? (e.agent_type ? `agent ${e.agent_type}` : "");
    const wt = e.orca_worktree ? base(String(e.orca_worktree).split("::").pop()) : base(e.cwd);
    const label = EVENT_KO[e.event] ?? e.event;
    out.push({
      type: "event", id: eventId(e), title: msg ? String(msg).replace(/\s+/g, " ").slice(0, 160) : label, detail: [label, wt].filter(Boolean).join(" · "), ts: e.ts, url: null, kind: "event", tab: "timeline", anchor: `day:${localDay(e.ts)}`, body: msg ? String(msg).slice(0, 2000) : undefined,
      fields: [[msg, 3], [wt, 2], [label, 1], [e.event, 1], [e.notification_type, 1]],
    });
  }

  out.push(...drafts());
  return out;
}

export function search(q: string, limit = 50): SearchHit[] {
  const toks = tokenize(q);
  if (!toks.length) return [];
  const now = Date.now();
  const hits: SearchHit[] = [];
  for (const { fields, ...c } of candidates()) {
    const score = scoreFields(fields, toks, c.ts, now);
    if (score > 0) hits.push({ ...c, score: Math.round(score * 10) / 10 });
  }
  return hits.sort((a, b) => b.score - a.score || (b.ts ?? 0) - (a.ts ?? 0)).slice(0, limit);
}

export function registerSearch(app: Hono): void {
  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(c.req.query("limit") ?? 50)) || 50));
    return c.json(search(q.slice(0, 200), limit));
  });
}
