/* DOM + formatting helpers shared by every module (no state, no imports). */
export const $ = (id) => document.getElementById(id);
export const ALIVE_MS = 20 * 60 * 1000, POLL_MS = 10 * 1000;

// ---------- utils ----------
export function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
export const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
export const pad = (n) => String(n).padStart(2, "0");
export const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const mdhm = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ts)}`; };
export const basename = (p) => (p ? String(p).replace(/\/+$/, "").split("/").pop() : "");
export function dayLabel(ts) {
  const d = new Date(ts), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "오늘";
  if (d.toDateString() === y.toDateString()) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
export function rel(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts, s = Math.round(Math.abs(diff) / 1000), f = (x) => (diff >= 0 ? `${x} 전` : `${x} 후`);
  if (s < 45) return diff >= 0 ? "방금" : f(`${s}초`);
  const m = Math.round(s / 60); if (m < 60) return f(`${m}분`);
  const h = Math.round(m / 60); if (h < 36) return f(`${h}시간`);
  return f(`${Math.round(h / 24)}일`);
}
export const WEEK = "일월화수목금토";
export const ymdOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const toMs = (v) => (typeof v === "number" ? v : Date.parse(v) || 0);
export const ext = (u, label, cls = "") => (u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : "");
/** 'YYYY-MM-DD' (or ISO) due → { cls, label, days } relative to today. */
export function dueInfo(due) {
  if (!due) return null;
  const [y, m, d] = String(due).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  const days = Math.round((new Date(y, m - 1, d).getTime() - midnight()) / 86400000);
  const label = days < 0 ? `${-days}일 지남` : days === 0 ? "오늘 마감" : days === 1 ? "내일" : `${m}/${d}${days < 7 ? ` (${WEEK[new Date(y, m - 1, d).getDay()]})` : ""}`;
  return { cls: days < 0 ? "over" : days === 0 ? "today" : "", label, days };
}
export const dueChip = (due) => { const x = dueInfo(due); return x ? `<span class="chipx ${x.cls}">${esc(x.label)}</span>` : ""; };
