/* Followed Slack threads on HOME rows (agenda slack.threads → row.thread, see src/slack-threads.ts):
 * line 1 = channel · opening message (short) + "+N 새 답글", line 2 = Ned's thread summary, line 3 = latest reply
 * (from · time · one line). Shrunk card preview: summary + latest reply. Expanded rows: up to 3 recent replies.
 * No summary yet (before phase 2) → latest reply only; never read → the caller's old markup. */
import { esc, ext, lsGet, lsSet, rel, safeUrl, toMs } from "../util.js";

const tsMs = (ts) => (/^\d{9,11}(\.\d+)?$/.test(String(ts || "")) ? Number(ts) * 1000 : toMs(ts));
/** The row's followed thread, once phase 2 has read it (else null). */
export const readThread = (x) => (x?.thread?.last_reply_ts ? x.thread : null);
/** Replies by others after my last message that I haven't marked seen. */
export function newReplies(x) {
  const t = x?.thread;
  if (!t || !(t.new_since_me > 0)) return 0;
  // Same as slack-threads.ts hasNewSinceMe: seen_reply_ts = the ✓ mark time; only a reply after it (last reply or
  // phase 1's newest hit) counts — the same instant the ✓ rule (revkeys.js) compares.
  return t.seen_reply_ts && tsMs(t.seen_reply_ts) >= Math.max(tsMs(t.last_reply_ts), tsMs(t.search_latest_ts)) ? 0 : t.new_since_me;
}
export const newChip = (x) => { const n = newReplies(x); return n ? `<span class="chipx today" title="내 마지막 답 이후 다른 사람이 쓴 답글">+${n} 새 답글</span>` : ""; };
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const reply = (m) => `<div class="trep"><span class="from">${esc(m.from || "?")}</span><span class="tw">${m.at || m.ts ? rel(tsMs(m.ts || m.at)) : ""}</span><span class="tx">${esc(m.text || "")}</span></div>`;
const latestOf = (t) => ({ from: t.last_reply_from, ts: t.last_reply_ts, text: t.last_reply_text });

/**
 * Inner html of a row's `.mn` for a read thread, or "" (→ caller keeps its markup).
 * `chips`: the row's own chips (reason / 답 필요 / 답함 …), shown on line 1 after the title.
 */
export function threadMain(x, url, chips = "") {
  const t = readThread(x);
  if (!t) return "";
  const title = clip(t.root_text || x.text || "(내용 없음)", 60);
  const line1 = `<div class="tl1"><span class="key" style="color:var(--dim)">${esc(x.channel || "")}</span><span class="tt">${url ? ext(url, esc(title)) : esc(title)}</span>${newChip(x)}${chips}</div>`;
  const sum = t.thread_summary ? `<div class="tsum">${esc(t.thread_summary)}</div>` : "";
  // Expanded list: the last 3 messages (the latest is the last one); fewer known → just the latest.
  const recent = (t.recent || []).length ? t.recent.slice(-3) : [latestOf(t)];
  return line1 + sum + recent.map(reply).join("");
}

/** Lines under a row whose own title stays (팔로업 highlight rows): Ned's thread summary + the latest reply, or "". */
export function threadTail(x) {
  const t = readThread(x);
  if (!t) return "";
  return (t.thread_summary ? `<div class="tsum">${esc(t.thread_summary)}</div>` : "") + reply(latestOf(t));
}

// ---------- history panel: a row's kept messages (thread.recent / DM dm.recent, ≤10, oldest first) ----------
// A "▸ 이력 N" chip on the row toggles an inline panel under it; open state per history key (thread key / dm:<channel>)
// in memory + localStorage (ned.hist.open), so a re-render keeps it. Not indexed by search (noise).
const OPEN_KEY = "ned.hist.open", OPEN_MAX = 100;
let openSet = null;
const opened = () => {
  if (!openSet) { try { const v = JSON.parse(lsGet(OPEN_KEY) || "[]"); openSet = new Set(Array.isArray(v) ? v.filter((k) => typeof k === "string") : []); } catch { openSet = new Set(); } }
  return openSet;
};
/** The row's history: DM rows → their conversation, else the followed thread. {key, msgs} or null. */
export function historyOf(x) {
  const h = x?.reason === "dm" && x.dm?.recent?.length ? x.dm : x?.thread?.recent?.length ? x.thread : null;
  return h ? { key: h.key, msgs: h.recent } : null;
}
/** Toggle chip, shown when there is more history than the row's own line(s). */
export function histToggle(x) {
  const h = historyOf(x);
  if (!h || h.msgs.length < 2) return "";
  const on = opened().has(h.key);
  return `<button type="button" class="chipx more hist-tg" data-hist="${esc(h.key)}" aria-expanded="${on}" title="이 대화의 최근 메시지 ${h.msgs.length}개 펼치기">${on ? "▾" : "▸"} 이력 ${h.msgs.length}</button>`;
}
const histLine = (m) => {
  const me = m.from === "나";
  return `<div class="trep${me ? " me" : ""}"><span class="from">${esc(m.from || "?")}</span><span class="tw">${m.ts || m.at ? rel(tsMs(m.ts || m.at)) : ""}</span><span class="tx">${esc(m.text || "")}</span></div>`;
};
/** The inline panel (hidden unless opened), or "" when there is no history to unfold. */
export function histPanel(x) {
  const h = historyOf(x);
  if (!h || h.msgs.length < 2) return "";
  const msgs = [...h.msgs].sort((a, b) => tsMs(a.ts || a.at) - tsMs(b.ts || b.at));
  return `<div class="hist" data-hist-panel="${esc(h.key)}"${opened().has(h.key) ? "" : " hidden"}>${msgs.map(histLine).join("")}</div>`;
}
function toggleHist(key) {
  const s = opened(), on = !s.has(key);
  if (on) s.add(key); else s.delete(key);
  lsSet(OPEN_KEY, JSON.stringify([...s].slice(-OPEN_MAX)));
  // The same conversation can sit in several cards / lists: keep them all in step.
  for (const p of document.querySelectorAll(`[data-hist-panel="${CSS.escape(key)}"]`)) p.hidden = !on;
  for (const b of document.querySelectorAll(`[data-hist="${CSS.escape(key)}"]`)) { b.setAttribute("aria-expanded", String(on)); b.textContent = b.textContent.replace(/^[▸▾]/, on ? "▾" : "▸"); }
}

/** 팔로업 card "최근 대화": the channel's newest messages (from · time · text · ↗), skipping urls already shown.
 *  `act(m)`: extra html after the ↗ (watchrow.js: the ✎). */
export function recentHtml(recent, skipUrls = new Set(), act = null) {
  const rows = (recent || []).filter((m) => m && (m.text || m.url) && !(m.url && skipUrls.has(m.url)));
  if (!rows.length) return "";
  return `<div class="wrec"><div class="wrech">최근 대화</div>` + rows.map((m) => {
    const u = safeUrl(m.url);
    return `<div class="trep"><span class="from">${esc(m.from || "?")}</span><span class="tw">${m.ts ? rel(tsMs(m.ts)) : ""}</span><span class="tx">${esc(m.text || "")}</span>${u ? ext(u, "↗", "wlk") : ""}${act ? act(m) : ""}</div>`;
  }).join("") + `</div>`;
}

export function init() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-hist]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    toggleHist(b.dataset.hist);
  });
}

/** Shrunk-card preview for the first row: summary + latest reply (2 lines), or "" when the thread wasn't read yet. */
export function threadPreview(x, url, icon) {
  const t = readThread(x);
  if (!t) return "";
  const top = t.thread_summary || clip(t.root_text || x.text || "", 80);
  return `<span class="ic">${icon}</span><div class="pv2"><span class="tt">${url ? ext(url, esc(top)) : esc(top)}</span>${reply(latestOf(t))}</div>${newChip(x)}<span class="chipx">${esc(x.channel || "")}</span>`;
}
