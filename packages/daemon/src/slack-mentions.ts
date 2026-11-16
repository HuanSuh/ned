/**
 * 대화창 쓰기 보강 (WU-07) — Slack 대상 스레드 · 사람/그룹 멘션 (pure functions + the small users cache).
 *
 * Trust model: the chat model (and anything it read — a message body can carry a prompt injection) is NOT trusted.
 * Everything here narrows what a proposal may do; the user still confirms every send on the card.
 *
 * - parseSlackPermalink: a message permalink → {channel, ts, thread_ts, reply_to}; another workspace
 *   (dashboard.slack_team_domain) → refused. reply_to follows actions.ts: the thread root (thread_ts), else the message's
 *   own thread — except a DM (D…) single-message link, which posts to the DM itself (reply_to undefined).
 * - seen extraction: while a chat turn runs, only the *message fields* of Slack message-tool results are read — the
 *   Permalink / Channel / ts fields of each result, never the message body (a URL or "channel: … ts: …" inside a body is
 *   ignored). A read_thread / read_channel call counts its own input only when its result really has that ts. Results in
 *   a shape we cannot read with confidence add nothing (fail closed). Saved on the answer as `seen_slack` (≤ SEEN_MAX, newest kept).
 * - targetAllowed: a target must equal a pasted / seen message by channel AND by where the reply really goes (reply_to).
 * - resolveMentions: the block's `mentions` (model candidates) → `<@U…>` / `<!subteam^S…>`. The model may not write ids
 *   itself; ids in the final text must belong to a mention still in the text (or, typed by the user, the cache); broadcast
 *   mentions (@here / @channel / @everyone) are refused.
 * - cache ~/.ned/slack-users.json (TTL 24h, ≤ 2,000 users): written only after a real chat send succeeded (the resolved
 *   people of that send) or from the agenda — never from a card preview; a cached name is never overwritten by a model value.
 */
import { SLACK_USERS_PATH, readJson, writeJsonAtomic } from "./paths.js";

// ---------------------------------------------------------------- permalinks
export interface SlackPermalink {
  /** Workspace subdomain ("acme" of acme.slack.com). */
  domain: string;
  channel: string;
  /** The message's own ts ("1700000000.000100"). */
  ts: string;
  /** Present when the link points at a reply (…?thread_ts=<root>). */
  thread_ts?: string;
  /** Where a reply goes: the thread root (thread_ts), else this message's own thread; undefined = a DM's top level. */
  reply_to?: string;
  /** Canonical link (no cid). */
  url: string;
}

const PERMALINK_SRC = /https:\/\/([a-z0-9-]+)(?:\.enterprise)?\.slack\.com\/archives\/([CDG][A-Z0-9]{2,})\/p(\d{10})(\d{6})(\?[^\s"'<>)\]]*)?/.source;
/** Global copy for scanning text (matchAll clones it — always from index 0); the anchored one for a single link. */
const PERMALINK_RE = new RegExp(PERMALINK_SRC, "g");
const PERMALINK_ONE = new RegExp(`^${PERMALINK_SRC}`);

/** Where a reply to (channel, ts, thread_ts?) goes — same rule as actions.ts buildActionPrompt. */
export const replyTarget = (channel: string, ts: string | undefined, thread_ts?: string): string | undefined => thread_ts ?? (channel.startsWith("D") ? undefined : ts);

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
  const reply_to = replyTarget(channel, ts, thread_ts);
  return { domain: domain.toLowerCase(), channel, ts, ...(thread_ts ? { thread_ts } : {}), ...(reply_to ? { reply_to } : {}), url: `https://${domain}.slack.com/archives/${channel}/p${sec}${micro}${thread_ts ? `?thread_ts=${thread_ts}` : ""}` };
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

// ---------------------------------------------------------------- seen (message fields of Slack tool results)
export interface SeenSlack {
  channel: string;
  ts: string;
  thread_ts?: string;
  permalink?: string;
}
export const SEEN_MAX = 200;

const TS_RE = /^\d{10}\.\d{6}$/;
const CHANNEL_ID_RE = /\b([CDG][A-Z0-9]{6,})\b/;
const str = (v: unknown, n = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** One message as its result fields describe it (no body). */
interface ResultMessage {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  permalink?: SlackPermalink;
}

/** A JSON result: the top-level message objects only (an array, or {messages|results|matches: [...]}, or one message). */
function jsonMessages(text: string): ResultMessage[] | null {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return null;
  }
  const o = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  const containerChannel = o ? chanOf(o.channel ?? o.channel_id) : undefined;
  const list = Array.isArray(j) ? j : o ? ((["messages", "results", "matches"].map((k) => o[k]).find(Array.isArray) as unknown[] | undefined) ?? [o]) : [];
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)).map((x) => {
    const pl = typeof x.permalink === "string" ? parseSlackPermalink(x.permalink) : null;
    const ts = [x.ts, x.message_ts].find((v) => typeof v === "string" && TS_RE.test(v)) as string | undefined;
    const thread_ts = typeof x.thread_ts === "string" && TS_RE.test(x.thread_ts) ? x.thread_ts : undefined;
    return { channel: chanOf(x.channel ?? x.channel_id) ?? containerChannel, ts, thread_ts, ...(pl && typeof pl !== "string" ? { permalink: pl } : {}) };
  });
}
function chanOf(v: unknown): string | undefined {
  if (typeof v === "string") return CHANNEL_ID_RE.exec(v)?.[1];
  if (v && typeof v === "object") return chanOf((v as { id?: unknown }).id);
  return undefined;
}

/** "Permalink: …", "Channel: #x (C…)", "Message_ts: …" — a field line of a text result (optionally "- " / "**"). */
const FIELD_RE = /^\s*(?:[-*]\s+)?\**\s*(permalink|link|channel(?:[ _]id)?|(?:message[ _])?ts|thread[ _]ts|timestamp)\s*\**\s*:\s*\**\s*(.*)$/i;
/** A label that starts the message body — everything after it in the block is someone's text, not a field. */
const BODY_RE = /^\s*(?:[-*]\s+)?\**\s*(text|message|content|body|messages?\s*text)\s*\**\s*:/i;
/** A new result block: a markdown heading or a horizontal rule. */
const BLOCK_RE = /^\s*(#{1,6}\s|-{3,}\s*$|={3,}\s*$)/;

/**
 * A text result split into result blocks; in each block only the field lines BEFORE the body label count, and only the
 * first value of each field. (A body may contain "Permalink: …" or a heading — the body itself is never read.)
 */
function textMessages(text: string): ResultMessage[] {
  const out: ResultMessage[] = [];
  let cur: ResultMessage | null = null;
  let inBody = false;
  const flush = () => {
    if (cur && (cur.permalink || cur.ts)) out.push(cur);
    cur = null;
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (BLOCK_RE.test(line)) {
      flush();
      inBody = false;
      continue;
    }
    if (inBody) continue;
    if (BODY_RE.test(line)) {
      inBody = true;
      continue;
    }
    const f = FIELD_RE.exec(line);
    if (!f) continue;
    cur ??= {};
    const key = f[1].toLowerCase().replace(/[ _]/g, "");
    const val = f[2];
    if ((key === "permalink" || key === "link") && !cur.permalink) {
      const url = /https:\/\/[^\s)\]>"']+/.exec(val)?.[0];
      const p = url ? parseSlackPermalink(url) : null;
      if (p && typeof p !== "string") cur.permalink = p;
    } else if (key.startsWith("channel") && !cur.channel) cur.channel = CHANNEL_ID_RE.exec(val)?.[1];
    else if ((key === "ts" || key === "messagets" || key === "timestamp") && !cur.ts) cur.ts = /\d{10}\.\d{6}/.exec(val)?.[0];
    else if (key === "threadts" && !cur.thread_ts) cur.thread_ts = /\d{10}\.\d{6}/.exec(val)?.[0];
  }
  flush();
  return out;
}

/** The messages a Slack tool result describes (fields only): JSON if it is JSON, else the text block format. */
export function resultMessages(text: unknown): ResultMessage[] {
  const s = String(text ?? "");
  return jsonMessages(s) ?? textMessages(s);
}

/** Seen entries of one result: a message's permalink (if any), else its channel field + ts (channel defaults to `inputChannel`). */
export function extractSeenSlack(text: unknown, inputChannel?: string): SeenSlack[] {
  const out: SeenSlack[] = [];
  for (const m of resultMessages(text)) {
    if (m.permalink) {
      // a permalink that contradicts the block's own channel / ts fields is not trusted
      if ((m.channel && m.channel !== m.permalink.channel) || (m.ts && m.ts !== m.permalink.ts)) continue;
      out.push({ channel: m.permalink.channel, ts: m.permalink.ts, ...(m.permalink.thread_ts ? { thread_ts: m.permalink.thread_ts } : {}), permalink: m.permalink.url });
    } else {
      const channel = m.channel ?? inputChannel;
      if (channel && m.ts) out.push({ channel, ts: m.ts, ...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}) });
    }
  }
  return out;
}

const seenKey = (x: SeenSlack) => `${x.channel}:${x.ts}:${x.thread_ts ?? ""}`;
/** Dedupe (a permalink fills in later) and keep the newest SEEN_MAX. */
export function mergeSeen(list: SeenSlack[], add: SeenSlack[]): SeenSlack[] {
  const by = new Map(list.map((x) => [seenKey(x), x]));
  for (const x of add) {
    const k = seenKey(x);
    const cur = by.get(k);
    if (cur) by.delete(k); // re-seen → move to the end (newest)
    by.set(k, cur && !x.permalink ? cur : { ...cur, ...x });
  }
  return [...by.values()].slice(-SEEN_MAX);
}

/** Slack tools whose results describe messages (canvases, profiles, channel / user search are not targets). */
const MESSAGE_TOOLS = /^mcp__claude_ai_Slack__slack_(search_public_and_private|search_public|read_thread|read_channel)$/;
const flatText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("\n") : "";

/**
 * Stream-json collector for one chat turn: Slack message-tool calls (assistant tool_use) and their results (user
 * tool_result). read_thread / read_channel: the call's channel_id is the default channel of the result's messages, and
 * its message_ts counts only when a result message has that very ts.
 */
export function createSeenCollector() {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  let seen: SeenSlack[] = [];
  return {
    onEvent(j: Record<string, unknown>): void {
      const content = (j.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      if (j.type === "assistant") {
        for (const c of content as { type?: string; id?: string; name?: string; input?: unknown }[])
          if (c?.type === "tool_use" && c.id && c.name && MESSAGE_TOOLS.test(c.name)) calls.set(c.id, { name: c.name, input: c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {} });
      } else if (j.type === "user") {
        for (const c of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (c?.type !== "tool_result" || !c.tool_use_id) continue;
          const call = calls.get(c.tool_use_id);
          if (!call || c.is_error) continue;
          const text = flatText(c.content);
          const reader = /read_(thread|channel)$/.test(call.name);
          const ch = reader && typeof call.input.channel_id === "string" && /^[CDG][A-Z0-9]{2,}$/.test(call.input.channel_id) ? call.input.channel_id : undefined;
          const add = extractSeenSlack(text, ch);
          const ts = [call.input.message_ts, call.input.thread_ts, call.input.ts].find((v) => typeof v === "string" && TS_RE.test(v)) as string | undefined;
          // the thread root that was asked for — only if the result really contains it
          if (ch && ts && add.some((x) => x.channel === ch && x.ts === ts) === false && resultMessages(text).some((m) => m.ts === ts || m.permalink?.ts === ts)) add.unshift({ channel: ch, ts });
          seen = mergeSeen(seen, add);
        }
      }
    },
    result(): { seen: SeenSlack[] } {
      return { seen };
    },
  };
}

/**
 * Is target `t` the same message / thread as `x` (a pasted link or a seen message)? Same channel, and the place the
 * reply really goes (t.reply_to — from the link's thread_ts) must be x's ts or x's thread root. A DM top-level target
 * (no reply_to) must be x itself.
 */
export function sameTarget(x: Pick<SeenSlack, "channel" | "ts" | "thread_ts">, t: Pick<SlackPermalink, "channel" | "ts" | "reply_to">): boolean {
  if (x.channel !== t.channel) return false;
  if (!t.reply_to) return x.ts === t.ts;
  return t.reply_to === x.ts || (!!x.thread_ts && t.reply_to === x.thread_ts);
}
export const seenHas = (seen: SeenSlack[], t: Pick<SlackPermalink, "channel" | "ts" | "reply_to">): boolean => seen.some((x) => sameTarget(x, t));

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
export interface SlackUsersCache {
  users: Record<string, SlackUser>;
}

export const USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;
export const GROUP_ID_RE = /^S[A-Z0-9]{6,}$/;

/** The cache, expired entries dropped. */
export function readUsersCache(now = Date.now(), file = SLACK_USERS_PATH): SlackUsersCache {
  const raw = readJson<Partial<SlackUsersCache> | null>(file, null);
  const users: Record<string, SlackUser> = {};
  for (const [id, u] of Object.entries(raw?.users ?? {})) if (USER_ID_RE.test(id) && u && typeof u.name === "string" && now - Number(u.at) < USERS_TTL_MS) users[id] = { ...u, id };
  return { users };
}

/**
 * Add / refresh users (newest kept when over USERS_MAX). `trusted` (agenda data) may set a name; otherwise (a model's
 * candidate, after a real send) an id already cached only gets its time refreshed — its name is never overwritten.
 */
export function updateUsersCache(add: Omit<SlackUser, "at">[], { trusted = false, now = Date.now(), file = SLACK_USERS_PATH }: { trusted?: boolean; now?: number; file?: string } = {}): SlackUsersCache {
  const c = readUsersCache(now, file);
  let changed = false;
  for (const u of add) {
    if (!USER_ID_RE.test(u.id) || !str(u.name)) continue;
    const old = c.users[u.id];
    c.users[u.id] = old && !trusted
      ? { ...old, at: now }
      : { id: u.id, name: str(u.name, 80), ...(str(u.real_name) ? { real_name: str(u.real_name, 80) } : {}), ...(str(u.title) ? { title: str(u.title, 80) } : {}), ...(u.external ? { external: true } : {}), at: now };
    changed = true;
  }
  if (!changed) return c;
  const users = Object.values(c.users).sort((a, b) => b.at - a.at).slice(0, USERS_MAX);
  const out = { users: Object.fromEntries(users.map((u) => [u.id, u])) };
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
  /** "@사람A" as written in the text. */
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
  /** The user must pick: several candidates, or a cache match by name (`via_cache`, even a single one). */
  unresolved: { text: string; candidates: MentionCandidate[]; via_cache?: boolean }[];
  /** Kept as text (the card shows a yellow chip): nobody / no group id found, or a name glued to other letters. */
  missing: { text: string; kind: "user" | "group"; reason?: string }[];
  /** IDs in the final text that are not allowed (→ 400). */
  bad_ids: string[];
  /** @here / @channel / @everyone (either form) in the final text (→ 400). */
  broadcast: string[];
}

/** handle (lower, no "@") → group id — only from the settings (filters.slack.group_ids). */
export function groupDirectory(opts: { group_ids?: Record<string, string> }): Map<string, string> {
  const dir = new Map<string, string>();
  for (const [h, id] of Object.entries(opts.group_ids ?? {})) if (GROUP_ID_RE.test(id)) dir.set(h.toLowerCase(), id);
  return dir;
}
/** Every group id the settings name (allowed in `<!subteam^…>`): group_ids values + ID-shaped group_mentions. */
export function knownGroupIds(opts: { group_mentions?: string[]; group_ids?: Record<string, string> }): Set<string> {
  const ids = new Set<string>();
  for (const g of opts.group_mentions ?? []) if (GROUP_ID_RE.test(g)) ids.add(g);
  for (const id of Object.values(opts.group_ids ?? {})) if (GROUP_ID_RE.test(id)) ids.add(id);
  return ids;
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Korean particles that may follow a name (@사람A님, @사람A에게) — any other Hangul right after the name is a different word. */
export const NAME_PARTICLES = "님|씨|께|에게|한테|이랑|랑|이|가|은|는|을|를|도|과|와|의";
/** `@name` as a whole mention: not followed by an ASCII handle char, and Hangul only as particles. */
const mentionRe = (at: string, flags = "g") => new RegExp(`${reEsc(at)}(?![A-Za-z0-9._-])(?=$|[^가-힣]|(?:${NAME_PARTICLES})+(?![가-힣]))`, flags);
/** `@name` anywhere it could be meant (not inside a longer ASCII handle) — to notice one glued to other letters. */
const looseRe = (at: string) => new RegExp(`${reEsc(at)}(?![A-Za-z0-9._-])`);

const USER_TOKEN = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
const GROUP_TOKEN = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;
const BROADCAST = /<!(channel|here|everyone)(?:\|[^>]*)?>|(?<![\w@])@(channel|here|everyone)(?![\w-])/gi;
/** `<@…>` / `<!subteam^…>` / `<!…>` tokens in a text (what the model may not write itself). */
export const rawIdTokens = (text: string): string[] => [...text.matchAll(/<[@!][^>\s]{1,80}>/g)].map((m) => m[0]);

/**
 * Resolve the block's mentions in `text` (the card's possibly edited text). A mention whose `@text` is not in the text
 * is ignored. 1 candidate → `<@U…>`; several → `choices[text]` when it is one of them, else unresolved; 0 → a single
 * cache match by exact name is offered as a choice (via_cache), else missing. A group → `<!subteam^S…>` when the
 * settings map its handle, else missing.
 * Whitelist on the FINAL text: `<@U…>` must be a candidate of a mention that was in the text, or (typed by the user) a
 * cached user; `<!subteam^S…>` a group id from the settings; no broadcast mentions at all.
 */
export function resolveMentions(
  text: string,
  mentions: MentionSpec[],
  cache: SlackUsersCache,
  groups: { dir: Map<string, string>; ids: Set<string>; handles?: string[] },
  choices: Record<string, unknown> = {},
): MentionReport {
  const rep: MentionReport = { text, resolved: [], unresolved: [], missing: [], bad_ids: [], broadcast: [] };
  const allowed = new Set<string>(Object.keys(cache.users));
  const handles = new Set((groups.handles ?? []).map((h) => h.toLowerCase()));
  const present = mentions.filter((m) => looseRe(m.text).test(text));
  for (const m of present) for (const c of m.candidates) allowed.add(c.id);
  const warnGlued = (m: MentionSpec, kind: "user" | "group") => {
    if (looseRe(m.text).test(rep.text)) rep.missing.push({ text: m.text, kind, reason: "뒤에 글자가 붙어 이름 경계를 알 수 없음 — 띄어 쓰거나 조사만 붙여 줘" });
  };
  // longest first so "@사람A준" is not eaten by "@사람A"
  for (const m of [...present].sort((a, b) => b.text.length - a.text.length)) {
    if (!mentionRe(m.text, "").test(rep.text)) {
      rep.missing.push({ text: m.text, kind: m.group ? "group" : "user", reason: "뒤에 글자가 붙어 이름 경계를 알 수 없음 — 띄어 쓰거나 조사만 붙여 줘" });
      continue;
    }
    const handle = m.text.slice(1).toLowerCase();
    const gid = groups.dir.get(handle);
    if (gid) {
      rep.text = rep.text.replace(mentionRe(m.text), `<!subteam^${gid}>`);
      rep.resolved.push({ text: m.text, kind: "group", id: gid, name: m.text });
      warnGlued(m, "group");
      continue;
    }
    if (m.group || (!m.candidates.length && handles.has(handle))) {
      rep.missing.push({ text: m.text, kind: "group" });
      continue;
    }
    const want = typeof choices[m.text] === "string" ? String(choices[m.text]).toUpperCase() : "";
    let pick: MentionCandidate | undefined;
    if (m.candidates.length === 1) pick = m.candidates[0];
    else if (m.candidates.length > 1) {
      pick = m.candidates.find((c) => c.id === want);
      if (!pick) {
        rep.unresolved.push({ text: m.text, candidates: m.candidates });
        continue;
      }
    } else {
      const hits = Object.values(cache.users).filter((u) => [u.name, u.real_name].some((n) => n && n.toLowerCase() === handle));
      if (hits.length === 1) {
        const h = hits[0];
        const cand = { id: h.id, name: h.name, ...(h.title ? { title: h.title } : {}), ...(h.external ? { external: true } : {}) };
        if (want !== h.id) {
          rep.unresolved.push({ text: m.text, candidates: [cand], via_cache: true });
          continue;
        }
        pick = cand;
      }
    }
    if (!pick) {
      rep.missing.push({ text: m.text, kind: "user" });
      continue;
    }
    rep.text = rep.text.replace(mentionRe(m.text), `<@${pick.id}>`);
    rep.resolved.push({ text: m.text, kind: "user", id: pick.id, name: pick.name, ...(pick.external ? { external: true } : {}) });
    warnGlued(m, "user");
  }
  for (const mm of rep.text.matchAll(USER_TOKEN)) if (!allowed.has(mm[1])) rep.bad_ids.push(mm[1]);
  for (const mm of rep.text.matchAll(GROUP_TOKEN)) if (!groups.ids.has(mm[1])) rep.bad_ids.push(mm[1]);
  for (const mm of rep.text.matchAll(BROADCAST)) rep.broadcast.push(mm[0]);
  // ids typed in by the user that ARE allowed still show on the card
  const shown = new Set(rep.resolved.map((r) => r.id));
  for (const mm of rep.text.matchAll(USER_TOKEN)) {
    const id = mm[1];
    if (shown.has(id) || !allowed.has(id)) continue;
    shown.add(id);
    const c = present.flatMap((m) => m.candidates).find((x) => x.id === id) ?? cache.users[id];
    rep.resolved.push({ text: `<@${id}>`, kind: "user", id, name: c?.name ?? id, ...(c?.external ? { external: true } : {}) });
  }
  rep.bad_ids = [...new Set(rep.bad_ids)];
  rep.broadcast = [...new Set(rep.broadcast)];
  return rep;
}
