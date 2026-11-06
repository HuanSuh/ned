/* Followed Slack threads on HOME rows (agenda slack.threads → row.thread, see src/slack-threads.ts):
 * line 1 = channel · opening message (short) + "+N 새 답글", line 2 = Ned's thread summary, line 3 = latest reply
 * (from · time · one line). Shrunk card preview: summary + latest reply. Expanded rows: up to 3 recent replies.
 * No summary yet (before phase 2) → latest reply only; never read → the caller's old markup. */
import { esc, ext, rel, toMs } from "../util.js";

const tsMs = (ts) => (/^\d{9,11}(\.\d+)?$/.test(String(ts || "")) ? Number(ts) * 1000 : toMs(ts));
/** The row's followed thread, once phase 2 has read it (else null). */
export const readThread = (x) => (x?.thread?.last_reply_ts ? x.thread : null);
/** Replies by others after my last message that I haven't marked seen. */
export function newReplies(x) {
  const t = x?.thread;
  if (!t || !(t.new_since_me > 0)) return 0;
  return t.seen_reply_ts && tsMs(t.seen_reply_ts) >= tsMs(t.last_reply_ts) ? 0 : t.new_since_me;
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

/** Shrunk-card preview for the first row: summary + latest reply (2 lines), or "" when the thread wasn't read yet. */
export function threadPreview(x, url, icon) {
  const t = readThread(x);
  if (!t) return "";
  const top = t.thread_summary || clip(t.root_text || x.text || "", 80);
  return `<span class="ic">${icon}</span><div class="pv2"><span class="tt">${url ? ext(url, esc(top)) : esc(top)}</span>${reply(latestOf(t))}</div>${newChip(x)}<span class="chipx">${esc(x.channel || "")}</span>`;
}
