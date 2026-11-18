/* 항목 포커스 · 원문 바로가기 · 출처 줄 — the DOM-free half (node tests import it directly).
 * - Hash: `#item=<encodeURIComponent id>[&tab=priority|other|history][&at=<section>.<n>]` (main.js setView → inbox.js
 *   focusItem). Every value is checked against an allow-list here; anything else is dropped, so the DOM side may build
 *   selectors / HTML from what parseFocusHash returns.
 * - resolveFocus: a target (inbox key / attention id / source review key) → which inbox tab, which row, whether it is
 *   확인 완료, and the briefing-detail anchor. A dismissed attention item falls back to its briefing's detail block.
 * - sourceParts: the 출처 줄 ("Slack · #채널 · 보낸 사람") from fields the item or the agenda already has — no new calls.
 * - originalOf: where `o` / the 출처 button goes — the safe web URL, else the session to show. */
import { KIND_ICON, KIND_KO } from "../ui/icons.js";
import { esc, safeUrl } from "../util.js";
import { srcKey } from "./revkeys.js";

export const FOCUS_TABS = ["priority", "other", "history"];
export const ITEM_ID_RE = /^[A-Za-z0-9._:@#/+=-]{1,200}$/;
export const ANCHOR_RE = /^(action_items|updates|fyi|sessions)\.\d{1,3}$/;
const SECTIONS = { updates: "other", fyi: "other" };

/** `#item=…&tab=…&at=…` → { item, tab?, at? }, or null when it is not a focus hash / the id fails the allow-list. */
export function parseFocusHash(hash) {
  const h = String(hash ?? "").replace(/^#/, "");
  if (!h.startsWith("item=")) return null;
  const out = {};
  for (const part of h.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i);
    let v;
    try { v = decodeURIComponent(part.slice(i + 1)); } catch { if (k === "item") return null; continue; }
    if (k === "item") { if (!ITEM_ID_RE.test(v)) return null; out.item = v; }
    else if (k === "tab" && FOCUS_TABS.includes(v)) out.tab = v;
    else if (k === "at" && ANCHOR_RE.test(v)) out.at = v;
  }
  return out.item ? out : null;
}

/** The inverse — null when the id would not survive parseFocusHash. */
export function focusHash({ item, tab, at } = {}) {
  if (typeof item !== "string" || !ITEM_ID_RE.test(item)) return null;
  let h = `#item=${encodeURIComponent(item)}`;
  if (FOCUS_TABS.includes(tab)) h += `&tab=${tab}`;
  if (typeof at === "string" && ANCHOR_RE.test(at)) h += `&at=${at}`;
  return h;
}

const isRev = (it) => !!(it.att ? it.att.reviewed_at : it.rat);

/**
 * target { item, tab?, at? } + the inbox model (tabs/inbox.js model()) →
 *   { tab, key, reviewed, at? }  the row to select ·  { missing: true, tab }  gone (deleted / expired).
 * `item` may be an inbox row key (attention id, `<briefing>:<sec>:<i>`, `bf:<id>`), a briefing id, or a source review key
 * (`slack:…` / `mail:…` — matched against the 기타 rows' keys).
 */
export function resolveFocus(target, m) {
  const id = target?.item;
  const fallTab = FOCUS_TABS.includes(target?.tab) ? target.tab : "priority";
  if (!id || !m) return { missing: true, tab: fallTab };
  const at = ANCHOR_RE.test(target.at || "") ? target.at : undefined;
  const hit = (tab, it) => ({ tab, key: it.key, reviewed: isRev(it), ...(at ? { at } : {}) });
  let it = m.pri.find((x) => x.key === id);
  if (it) return hit("priority", it);
  it = m.other.find((x) => x.key === id) || (/^(mail|slack|jira|github):/.test(id) ? m.other.find((x) => x.rk === id) : null);
  if (it) return hit("other", it);
  const bid = id.startsWith("bf:") ? id.slice(3) : id;
  it = m.hist.find((x) => x.key === `bf:${bid}` || (x.okrun && x.okrun.some((b) => b.id === bid)));
  if (it) return hit("history", it);
  // A dismissed attention item `<briefing id>:<n>` → that briefing's 행동 필요 block, if the briefing is still kept.
  const am = /^(.+):(\d{1,3})$/.exec(id);
  if (am) {
    it = m.hist.find((x) => x.key === `bf:${am[1]}`);
    if (it) return { tab: "history", key: it.key, reviewed: false, at: `action_items.${am[2]}` };
    // `<briefing>:<sec>:<i>` from a briefing no longer kept → gone. (An updates/fyi key of a kept one matched above.)
  }
  const sm = /^(.+):(updates|fyi):\d+$/.exec(id);
  return { missing: true, tab: sm ? SECTIONS[sm[2]] : fallTab };
}

// ---------- 출처 줄 ----------
const toMs = (v) => (typeof v === "number" ? v : Date.parse(String(v ?? "")) || 0);
/** Every agenda row we can name a source from, keyed by its review key (the same key the ✓ uses). */
export function agendaIndex(agenda) {
  const idx = new Map();
  const put = (k, v) => { if (k && !idx.has(k)) idx.set(k, v); };
  const sl = agenda?.slack;
  for (const x of [...(sl?.items || []), ...(sl?.all || [])]) put(srcKey("slack", x), { kind: "slack", channel: x.channel, from: x.from, ts: toMs(x.ts) });
  for (const w of sl?.watch || []) for (const h of w.highlights || []) put(srcKey("slack", h), { kind: "slack", channel: w.channel, from: h.from, ts: toMs(h.ts) });
  for (const t of [...(sl?.threads || []), ...(sl?.dms || [])]) put(srcKey("slack", t), { kind: "slack", channel: t.channel, from: t.last_reply_from, ts: toMs(t.last_reply_at) });
  const ml = agenda?.mail;
  for (const x of [...(ml?.items || []), ...(ml?.all || [])]) put(srcKey("email", x), { kind: "email", from: x.from, subject: x.subject, ts: toMs(x.received || x.ts) });
  for (const x of agenda?.jira || []) put(srcKey("jira", x), { kind: "jira", key: x.key, status: x.status });
  for (const x of agenda?.github || []) put(srcKey("github", x), { kind: "github", key: `${x.repo}#${x.number}`, from: x.author });
  return idx;
}

/**
 * 출처 줄 parts (plain strings, not escaped): kind label, then what the data already says —
 *   Slack: #채널 · 보낸 사람 · (full) 시각 · 메일: 보낸 사람 · (full) 제목 · Jira: KEY · 상태 · GitHub: repo#n · 작성자 · 세션: worktree.
 * `short` (통신기 메시지): no time / subject. `fmt` formats a ms time.
 */
export function sourceParts(item, { agenda = null, index = null, sess = null, short = false, fmt = null } = {}) {
  const kind = item?.kind || "other";
  const parts = [KIND_KO[kind] || "기타"];
  if (kind === "session" || sess) {
    if (sess?.worktree) parts.push(sess.worktree);
    return parts;
  }
  // By URL only: an attention / briefing item's own `id` is not a source id (srcKey("email") would read it as a thread).
  const meta = (index || agendaIndex(agenda)).get(srcKey(kind, { url: item?.url }));
  if (!meta) return parts;
  if (meta.channel) parts.push(meta.channel);
  if (meta.key) parts.push(meta.key);
  if (meta.from) parts.push(meta.from);
  if (meta.status) parts.push(meta.status);
  if (!short && meta.subject && kind === "email") parts.push(meta.subject);
  if (!short && fmt && meta.ts && kind === "slack") parts.push(fmt(meta.ts));
  return parts.map((p) => String(p ?? "").trim()).filter(Boolean);
}
export const sourceLineHtml = (parts, cls = "srcline") => (parts.length ? `<div class="${cls}">${parts.map(esc).join(" · ")}</div>` : "");

// ---------- 원문 바로가기 ----------
const SRC_NAME = { slack: "Slack", email: "메일", jira: "Jira", github: "GitHub", sentry: "Sentry", calendar: "캘린더", session: "세션", other: "원문" };
/** Where `o` / the 출처 button goes: { url } (http(s) only) · { session } (no URL: show the session) · null. */
export function originalOf(item) {
  const url = safeUrl(item?.url);
  if (url) return { url };
  const sess = item?.sess || null;
  if (sess) return { session: sess };
  return null;
}
/** The per-source "원문 열기" anchor (icon = the kind's glyph). Opening goes through openlink.js's delegated click
 *  (external http(s) anchor → openLink → app deep link in Ned.app) — no other path. "" without a safe URL. */
export function srcBtn(kind, url, cls = "ib ib-src") {
  const u = safeUrl(url);
  if (!u) return "";
  const label = `${SRC_NAME[kind] || "원문"}에서 원문 열기`;
  return `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener" data-src="${esc(kind || "other")}" title="${esc(label)}" aria-label="${esc(label)}"><span aria-hidden="true">${KIND_ICON[kind] || "↗"}</span></a>`;
}

// ---------- keys ----------
/** Typing somewhere (input / textarea / select / contenteditable): page shortcuts stay off. */
export const isTypingTarget = (t) => !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "")));
