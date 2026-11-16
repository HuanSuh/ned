/**
 * 대화창 쓰기 보강 (WU-07) — Slack 대상 스레드 · 사람/그룹 멘션 (pure functions + the small users cache).
 *
 * - parseSlackPermalink: a message permalink → {channel, ts, thread_ts, reply_to}; another workspace (dashboard.slack_team_domain) → refused.
 * - seen extraction: while a chat turn runs, the Slack read tools' results are scanned for permalinks / (channel, ts) pairs
 *   and `<!subteam^S…|@handle>` tokens only — never the text itself — and saved on the answer (`seen_slack`, ≤ SEEN_MAX).
 *   A 확인 카드 may then target a thread the model really read (not one it made up).
 * - resolveMentions: the block's `mentions` (model candidates) → `<@U…>` / `<!subteam^S…>` in the text, with an ID whitelist:
 *   every `<@U…>` in the final text must be one of this action's candidates or in the cache; every `<!subteam^S…>` a known group.
 * - cache ~/.ned/slack-users.json (TTL 24h, ≤ 2,000 users): confirmed model candidates + agenda users with ids + seen groups.
 */
import { SLACK_USERS_PATH, readJson, writeJsonAtomic } from "./paths.js";

// ---------------------------------------------------------------- permalinks
export interface SlackPermalink {
  /** Workspace subdomain ("acme" of acme.slack.com). */
  domain: string;
  channel: string;
  /** The message's own ts ("1794277961.148039"). */
  ts: string;
  /** Present when the link points at a reply (…?thread_ts=<root>). */
  thread_ts?: string;
  /** Where a reply goes: the thread root (thread_ts), else this message (its own thread). */
  reply_to: string;
  /** Canonical link (no cid). */
  url: string;
}

const PERMALINK_SRC = /https:\/\/([a-z0-9-]+)(?:\.enterprise)?\.slack\.com\/archives\/([CDG][A-Z0-9]{2,})\/p(\d{10})(\d{6})(\?[^\s"'<>)\]]*)?/.source;
/** Global copy for scanning text (matchAll clones it — always from index 0); the anchored one for a single link. */
const PERMALINK_RE = new RegExp(PERMALINK_SRC, "g");
const PERMALINK_ONE = new RegExp(`^${PERMALINK_SRC}`);

/**
 * `https://<ws>.slack.com/archives/<C|D|G…>/p<10><6>[?thread_ts=<x>&cid=…]` → the parts, or a string (why not).
 * `teamDomain` (dashboard.slack_team_domain): when set, a link to another workspace is refused.
 */
export function parseSlackPermalink(url: unknown, teamDomain = ""): SlackPermalink | string {
  const u = typeof url === "string" ? url.trim() : "";
  const m = PERMALINK_ONE.exec(u);
  if (!m) return "Slack 메시지 링크(https://<워크스페이스>.slack.com/archives/<채널>/p…) 가 아니야";
  const [, domain, channel, sec, micro, query] = m;
  if (teamDomain && domain.toLowerCase() !== teamDomain.toLowerCase()) return `다른 워크스페이스(${domain}.slack.com) 링크야 — 설정된 워크스페이스는 ${teamDomain}.slack.com`;
  const ts = `${sec}.${micro}`;
  const tt = query ? /[?&]thread_ts=(\d{10}\.\d{6})/.exec(query)?.[1] : undefined;
  const thread_ts = tt && tt !== ts ? tt : undefined;
  return { domain: domain.toLowerCase(), channel, ts, ...(thread_ts ? { thread_ts } : {}), reply_to: thread_ts ?? ts, url: `https://${domain}.slack.com/archives/${channel}/p${sec}${micro}${thread_ts ? `?thread_ts=${thread_ts}` : ""}` };
}

/** Every Slack permalink in a free text (a user message). */
export function permalinksIn(text: unknown): SlackPermalink[] {
  const out: SlackPermalink[] = [];
  for (const m of String(text ?? "").matchAll(PERMALINK_RE)) {
    const p = parseSlackPermalink(m[0]);
    if (typeof p !== "string") out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- seen (tool results of the chat turn)
export interface SeenSlack {
  channel: string;
  ts: string;
  thread_ts?: string;
  permalink?: string;
}
export interface SeenGroup {
  id: string;
  handle?: string;
}
export const SEEN_MAX = 200;

const SUBTEAM_RE = /<!subteam\^(S[A-Z0-9]{6,})(?:\|@?([a-z0-9._-]+))?>/gi;
/** "channel": "C…" … "ts": "1794277961.148039" within the same few hundred chars (JSON-ish tool output). */
const PAIR_RE = /\bchannel(?:_id)?["']?\s*[:=]\s*["']?([CDG][A-Z0-9]{6,})["']?[\s\S]{0,300}?\b(?:message_)?ts["']?\s*[:=]\s*["']?(\d{10}\.\d{6})/g;

/** Permalinks and (channel, ts) pairs in a tool result text — ids only. */
export function extractSeenSlack(text: unknown): SeenSlack[] {
  const s = String(text ?? "");
  const out: SeenSlack[] = [];
  for (const p of permalinksIn(s)) out.push({ channel: p.channel, ts: p.ts, ...(p.thread_ts ? { thread_ts: p.thread_ts } : {}), permalink: p.url });
  for (const m of s.matchAll(PAIR_RE)) out.push({ channel: m[1], ts: m[2] });
  return out;
}

/** `<!subteam^S…|@handle>` tokens in a tool result text. */
export function extractSeenGroups(text: unknown): SeenGroup[] {
  const out: SeenGroup[] = [];
  for (const m of String(text ?? "").matchAll(SUBTEAM_RE)) out.push({ id: m[1].toUpperCase(), ...(m[2] ? { handle: m[2].toLowerCase() } : {}) });
  return out;
}

const seenKey = (x: SeenSlack) => `${x.channel}:${x.ts}:${x.thread_ts ?? ""}`;
/** Dedupe (first wins, a permalink fills in later) and cap at SEEN_MAX. */
export function mergeSeen(list: SeenSlack[], add: SeenSlack[]): SeenSlack[] {
  const by = new Map(list.map((x) => [seenKey(x), x]));
  for (const x of add) {
    const k = seenKey(x);
    const cur = by.get(k);
    if (!cur) by.set(k, x);
    else if (!cur.permalink && x.permalink) by.set(k, { ...cur, permalink: x.permalink });
  }
  return [...by.values()].slice(0, SEEN_MAX);
}

const SLACK_TOOL = /^mcp__claude_ai_Slack__/;
const flatText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("\n") : "";

/**
 * Stream-json collector for one chat turn: Slack read tool calls (assistant tool_use) and their results (user tool_result).
 * A successful slack_read_thread / slack_read_channel call also counts its own input (channel_id + message_ts / thread_ts).
 */
export function createSeenCollector() {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  let seen: SeenSlack[] = [];
  let groups: SeenGroup[] = [];
  return {
    onEvent(j: Record<string, unknown>): void {
      const content = (j.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      if (j.type === "assistant") {
        for (const c of content as { type?: string; id?: string; name?: string; input?: unknown }[])
          if (c?.type === "tool_use" && c.id && c.name && SLACK_TOOL.test(c.name)) calls.set(c.id, { name: c.name, input: c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {} });
      } else if (j.type === "user") {
        for (const c of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (c?.type !== "tool_result" || !c.tool_use_id) continue;
          const call = calls.get(c.tool_use_id);
          if (!call || c.is_error) continue;
          const text = flatText(c.content);
          const add = extractSeenSlack(text);
          const ch = typeof call.input.channel_id === "string" ? call.input.channel_id : "";
          const ts = [call.input.message_ts, call.input.thread_ts, call.input.ts].find((v) => typeof v === "string" && /^\d{10}\.\d{6}$/.test(v)) as string | undefined;
          if (/read_thread$/.test(call.name) && /^[CDG][A-Z0-9]{2,}$/.test(ch) && ts) add.unshift({ channel: ch, ts });
          seen = mergeSeen(seen, add);
          for (const g of extractSeenGroups(text)) if (!groups.some((x) => x.id === g.id)) groups.push(g);
        }
      }
    },
    result(): { seen: SeenSlack[]; groups: SeenGroup[] } {
      return { seen, groups: groups.slice(0, 50) };
    },
  };
}

/** Is `t` (a parsed target) a message / thread in `seen`? Same channel and the message itself or its thread root. */
export function seenHas(seen: SeenSlack[], t: Pick<SlackPermalink, "channel" | "ts" | "thread_ts">): boolean {
  return seen.some((x) => x.channel === t.channel && (x.ts === t.ts || (!!t.thread_ts && (x.ts === t.thread_ts || x.thread_ts === t.thread_ts)) || x.thread_ts === t.ts));
}

// ---------------------------------------------------------------- users cache
export { SLACK_USERS_PATH };
export const USERS_TTL_MS = 24 * 3600_000;
export const USERS_MAX = 2000;

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  title?: string;
  external?: boolean;
  /** ms — last time Ned saw / confirmed it. */
  at: number;
}
export interface SlackGroupEntry {
  id: string;
  handle?: string;
  at: number;
}
export interface SlackUsersCache {
  users: Record<string, SlackUser>;
  groups: Record<string, SlackGroupEntry>;
}

export const USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;
export const GROUP_ID_RE = /^S[A-Z0-9]{6,}$/;

const str = (v: unknown, n = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** The cache, expired entries dropped. */
export function readUsersCache(now = Date.now(), file = SLACK_USERS_PATH): SlackUsersCache {
  const raw = readJson<Partial<SlackUsersCache> | null>(file, null);
  const users: Record<string, SlackUser> = {};
  const groups: Record<string, SlackGroupEntry> = {};
  for (const [id, u] of Object.entries(raw?.users ?? {})) if (USER_ID_RE.test(id) && u && now - Number(u.at) < USERS_TTL_MS) users[id] = { ...u, id };
  for (const [id, g] of Object.entries(raw?.groups ?? {})) if (GROUP_ID_RE.test(id) && g && now - Number(g.at) < USERS_TTL_MS) groups[id] = { ...g, id };
  return { users, groups };
}

/** Add / refresh users and groups (newest kept when over USERS_MAX). Returns the saved cache. */
export function updateUsersCache(add: { users?: Omit<SlackUser, "at">[]; groups?: Omit<SlackGroupEntry, "at">[] }, now = Date.now(), file = SLACK_USERS_PATH): SlackUsersCache {
  const c = readUsersCache(now, file);
  let changed = false;
  for (const u of add.users ?? []) {
    if (!USER_ID_RE.test(u.id) || !str(u.name)) continue;
    c.users[u.id] = { id: u.id, name: str(u.name, 80), ...(str(u.real_name) ? { real_name: str(u.real_name, 80) } : {}), ...(str(u.title) ? { title: str(u.title, 80) } : {}), ...(u.external ? { external: true } : {}), at: now };
    changed = true;
  }
  for (const g of add.groups ?? []) {
    if (!GROUP_ID_RE.test(g.id)) continue;
    const handle = str(g.handle, 80).replace(/^@+/, "").toLowerCase();
    c.groups[g.id] = { id: g.id, ...(handle ? { handle } : c.groups[g.id]?.handle ? { handle: c.groups[g.id].handle } : {}), at: now };
    changed = true;
  }
  if (!changed) return c;
  const users = Object.values(c.users).sort((a, b) => b.at - a.at).slice(0, USERS_MAX);
  const out = { users: Object.fromEntries(users.map((u) => [u.id, u])), groups: c.groups };
  try {
    writeJsonAtomic(file, out);
  } catch {
    /* best-effort */
  }
  return out;
}

/** Users the agenda's Slack block names with an id (objects carrying user / user_id / from_id = U… and a name). */
export function agendaSlackUsers(slack: unknown): Omit<SlackUser, "at">[] {
  const out = new Map<string, Omit<SlackUser, "at">>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const id = [o.user_id, o.from_id, o.user].find((v) => typeof v === "string" && USER_ID_RE.test(v)) as string | undefined;
    const name = str(o.from_name) || str(o.user_name) || str(o.from);
    if (id && name) out.set(id, { id, name });
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  walk(slack, 0);
  return [...out.values()];
}

// ---------------------------------------------------------------- mentions
export interface MentionCandidate {
  id: string;
  name: string;
  real_name?: string;
  title?: string;
  external?: boolean;
}
export interface MentionSpec {
  /** "@병호" as written in the text. */
  text: string;
  candidates: MentionCandidate[];
  /** The model said it is a user group (@mobile-dev). */
  group?: boolean;
}

export const MENTIONS_MAX = 20;

/** The block's `mentions` → clean specs (bad entries dropped, ≤ MENTIONS_MAX, ≤ 10 candidates each). */
export function parseMentions(raw: unknown): MentionSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: MentionSpec[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    let text = str(o.text, 80);
    if (!text) continue;
    if (!text.startsWith("@")) text = `@${text}`;
    const cands = (Array.isArray(o.candidates) ? o.candidates : [])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({ id: str(c.id, 20).toUpperCase(), name: str(c.name, 80), real_name: str(c.real_name, 80), title: str(c.title, 80), external: c.external === true }))
      .filter((c) => USER_ID_RE.test(c.id))
      .map((c) => ({ id: c.id, name: c.name || c.real_name || c.id, ...(c.real_name ? { real_name: c.real_name } : {}), ...(c.title ? { title: c.title } : {}), ...(c.external ? { external: true } : {}) }))
      .slice(0, 10);
    if (out.some((x) => x.text === text)) continue;
    out.push({ text, candidates: cands, ...(o.group === true ? { group: true } : {}) });
  }
  return out.slice(0, MENTIONS_MAX);
}

export interface MentionResolved {
  text: string;
  kind: "user" | "group";
  id: string;
  name: string;
  external?: boolean;
}
export interface MentionReport {
  /** The text to send: resolved mentions replaced. */
  text: string;
  resolved: MentionResolved[];
  /** More than one candidate and no choice yet — the card shows a dropdown; sending is refused until chosen. */
  unresolved: { text: string; candidates: MentionCandidate[] }[];
  /** Nobody / no group id found — sent as plain text (the card shows a yellow chip). */
  missing: { text: string; kind: "user" | "group" }[];
  /** IDs in the final text that are not allowed (→ 400). */
  bad_ids: string[];
  /** User ids the final text may carry (this action's candidates + the cache). */
  allowed_users: string[];
}

/** handle (lower, no "@") → group id, from every source (config ids, the group_ids map, seen tokens). */
export function groupDirectory(opts: { group_mentions?: string[]; group_ids?: Record<string, string>; cache?: SlackUsersCache["groups"] }): Map<string, string> {
  const dir = new Map<string, string>();
  for (const g of Object.values(opts.cache ?? {})) if (g.handle) dir.set(g.handle, g.id);
  for (const [h, id] of Object.entries(opts.group_ids ?? {})) if (GROUP_ID_RE.test(id)) dir.set(h.toLowerCase(), id);
  return dir;
}
/** Every group id Ned knows (allowed in `<!subteam^…>`). */
export function knownGroupIds(opts: { group_mentions?: string[]; group_ids?: Record<string, string>; cache?: SlackUsersCache["groups"] }): Set<string> {
  const ids = new Set<string>();
  for (const g of opts.group_mentions ?? []) if (GROUP_ID_RE.test(g)) ids.add(g);
  for (const id of Object.values(opts.group_ids ?? {})) if (GROUP_ID_RE.test(id)) ids.add(id);
  for (const id of Object.keys(opts.cache ?? {})) ids.add(id);
  return ids;
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replace `@name` (not inside a longer ASCII handle like @name.x / @name_2). Korean particles (@병호님) still match. */
const replaceMention = (text: string, at: string, to: string) => text.replace(new RegExp(`${reEsc(at)}(?![A-Za-z0-9._-])`, "g"), to);

/**
 * Resolve the block's mentions in `text`. 1 candidate → `<@U…>`; several → `choices[text]` when it is one of them, else
 * unresolved; 0 → the cache by exact name (one hit), else missing (kept as text). A group (`group: true`, a handle in the
 * group directory, or a configured handle) → `<!subteam^S…>` when its id is known, else missing.
 * Then the whitelist: every `<@U…>` must be a candidate of this action or a cached user; every `<!subteam^S…>` a known group.
 */
export function resolveMentions(
  text: string,
  mentions: MentionSpec[],
  cache: SlackUsersCache,
  groups: { dir: Map<string, string>; ids: Set<string>; handles?: string[] },
  choices: Record<string, unknown> = {},
): MentionReport {
  const rep: MentionReport = { text, resolved: [], unresolved: [], missing: [], bad_ids: [], allowed_users: [] };
  const allowed = new Set<string>(Object.keys(cache.users));
  for (const m of mentions) for (const c of m.candidates) allowed.add(c.id);
  const handles = new Set((groups.handles ?? []).map((h) => h.toLowerCase()));
  // longest first so "@병호준" is not eaten by "@병호"
  for (const m of [...mentions].sort((a, b) => b.text.length - a.text.length)) {
    // the user may have edited the mention out of the card text — then it neither needs a choice nor shows
    if (!new RegExp(`${reEsc(m.text)}(?![A-Za-z0-9._-])`).test(rep.text)) continue;
    const handle = m.text.slice(1).toLowerCase();
    const gid = groups.dir.get(handle);
    if (gid) {
      rep.text = replaceMention(rep.text, m.text, `<!subteam^${gid}>`);
      rep.resolved.push({ text: m.text, kind: "group", id: gid, name: m.text });
      continue;
    }
    if (m.group || (!m.candidates.length && handles.has(handle))) {
      rep.missing.push({ text: m.text, kind: "group" });
      continue;
    }
    let pick: MentionCandidate | undefined;
    if (m.candidates.length === 1) pick = m.candidates[0];
    else if (m.candidates.length > 1) {
      const want = typeof choices[m.text] === "string" ? String(choices[m.text]).toUpperCase() : "";
      pick = m.candidates.find((c) => c.id === want);
      if (!pick) {
        rep.unresolved.push({ text: m.text, candidates: m.candidates });
        continue;
      }
    } else {
      const name = handle;
      const hits = Object.values(cache.users).filter((u) => [u.name, u.real_name].some((n) => n && n.toLowerCase() === name));
      if (hits.length === 1) pick = { id: hits[0].id, name: hits[0].name, ...(hits[0].external ? { external: true } : {}) };
    }
    if (!pick) {
      rep.missing.push({ text: m.text, kind: "user" });
      continue;
    }
    rep.text = replaceMention(rep.text, m.text, `<@${pick.id}>`);
    rep.resolved.push({ text: m.text, kind: "user", id: pick.id, name: pick.name, ...(pick.external ? { external: true } : {}) });
  }
  // whitelist over the FINAL text (the user may have typed ids in by hand)
  for (const mm of rep.text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) if (!allowed.has(mm[1])) rep.bad_ids.push(mm[1]);
  for (const mm of rep.text.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g)) if (!groups.ids.has(mm[1])) rep.bad_ids.push(mm[1]);
  // ids typed in by hand that ARE allowed still show on the card
  const shown = new Set(rep.resolved.map((r) => r.id));
  for (const mm of rep.text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    const id = mm[1];
    if (shown.has(id) || !allowed.has(id)) continue;
    shown.add(id);
    const c = mentions.flatMap((m) => m.candidates).find((x) => x.id === id) ?? cache.users[id];
    rep.resolved.push({ text: `<@${id}>`, kind: "user", id, name: c?.name ?? id, ...(c?.external ? { external: true } : {}) });
  }
  rep.bad_ids = [...new Set(rep.bad_ids)];
  rep.allowed_users = [...allowed];
  return rep;
}
