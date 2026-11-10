/**
 * 메시지 피드 (GET /api/feed) — what arrived, for the desktop pet (Ned.app). The same inputs and the same rules as the
 * 통신기 "메시지" tab (public/app/features/chat-core.js buildFeed): open attention items, briefing UPDATE headlines of the
 * last 24 h, followed Slack threads with replies after mine. Browser-only chat notes (localStorage) are not here.
 * test/feed-shared.test.ts runs both on one fixture and checks the same key · kind list in the same order.
 *
 * On top of buildFeed each item carries `pet_kind` (the config.pet.messages toggle it falls under — PET_KIND_OF) and
 * `deep` (the app deep link per 설정 → 링크 열기, src/links.ts — what the dashboard's openLink would hand to Ned.app).
 */
import { linkCtxOf, toDeepLink, type LinkPrefs } from "./links.js";
import type { PetMessageKind } from "./config.js";

export const DAY_MS = 24 * 3600_000;

/** Feed kind (attention kind | briefing | thread) → the pet's message toggle. `null` = no toggle (always shown). */
export const PET_KIND_OF: Record<string, PetMessageKind | null> = {
  session: "session",
  email: "mail",
  slack: "slack",
  thread: "slack",
  jira: "jira",
  github: "github",
  sentry: "sentry",
  calendar: "calendar",
  briefing: "briefing",
  other: null,
};
export const petKindOf = (kind: string): PetMessageKind | null => (kind in PET_KIND_OF ? PET_KIND_OF[kind] : null);

export interface FeedItem {
  key: string;
  kind: string;
  pet_kind: PetMessageKind | null;
  title: string;
  detail: string;
  url: string | null;
  deep: string | null;
  ts: number;
}

interface FeedAttention { id: string; kind?: string; title?: string; detail?: string; url?: string; ts?: number; reviewed_at?: number }
interface FeedBriefing { id: string; ts?: number; type?: string; status?: string; headline?: string; action_items?: unknown[] }
interface FeedThread { key?: string; channel?: string; url?: string; new_since_me?: number; last_reply_ts?: string; last_reply_at?: string; last_reply_from?: string; last_reply_text?: string; thread_summary?: string }
export interface FeedInput {
  state?: { attention?: FeedAttention[] } | null;
  briefings?: FeedBriefing[];
  agenda?: { slack?: { threads?: FeedThread[] } | null } | null;
}

// Same helpers as public/app/util.js safeUrl and chat-core.js clip.
const safeUrl = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Newest first. `links` = config.dashboard (링크 열기 toggles + Slack team) for `deep`; omitted → no deep links. */
export function buildFeed({ state, briefings = [], agenda = null }: FeedInput = {}, now = Date.now(), links?: (LinkPrefs & { slack_team_id?: unknown; slack_team_domain?: unknown }) | null): FeedItem[] {
  const out: Omit<FeedItem, "pet_kind" | "deep">[] = [];
  const urls = new Set<string>();
  for (const a of state?.attention || []) {
    if (a.reviewed_at) continue;
    out.push({ key: `att:${a.id}`, kind: a.kind || "other", title: clip(a.title, 120), detail: clip(a.detail, 120), url: safeUrl(a.url), ts: a.ts || 0 });
    if (a.url) urls.add(a.url);
  }
  for (const b of briefings || []) {
    if (b.status !== "UPDATE" || !b.headline || now - (b.ts || 0) > DAY_MS) continue;
    out.push({ key: `brief:${b.id}`, kind: "briefing", title: clip(b.headline, 120), detail: `${b.type === "daily" ? "아침 브리핑" : "순찰"} · ${(b.action_items || []).length}건`, url: null, ts: b.ts || 0 });
  }
  for (const t of agenda?.slack?.threads || []) {
    if (!((t.new_since_me ?? 0) > 0) || (t.url && urls.has(t.url))) continue;
    out.push({ key: `thr:${t.key}@${t.last_reply_ts || ""}`, kind: "thread", title: clip(`${t.channel || "Slack"} · 내 답 이후 새 답글 ${t.new_since_me}건`, 120), detail: clip(`${t.last_reply_from ? t.last_reply_from + ": " : ""}${t.last_reply_text || t.thread_summary || ""}`, 120), url: safeUrl(t.url), ts: Date.parse(t.last_reply_at || "") || 0 });
  }
  out.sort((x, y) => y.ts - x.ts);
  const ctx = linkCtxOf(links);
  return out.map((x) => ({ ...x, pet_kind: petKindOf(x.kind), deep: links && x.url ? toDeepLink(x.url, links, ctx) : null }));
}
