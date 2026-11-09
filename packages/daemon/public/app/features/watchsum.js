/* 팔로업 card summary (agenda slack.watch[].summary, 2~3 lines): one <li> per line, and a ↗ to the highlight that line
 * talks about — only when the match is clear (same issue key, or clearly more shared words than any other highlight).
 * Pure (no DOM / state) so test/watch-summary.test.ts can run it in node. */
import { esc, ext, safeUrl } from "../util.js";

const BULLET_RE = /^\s*(?:[-*•·▸▹►‣–—]|\d{1,2}[.)])\s*/;
/** Summary → lines. Newlines first; a single long line falls back to sentence / " · " / "; " breaks. */
export function summaryLines(summary) {
  const s = String(summary || "").trim();
  if (!s) return [];
  let lines = s.split(/\r?\n+/);
  if (lines.length === 1 && s.length > 60) lines = s.split(/(?<=[.!?。])\s+(?=\S)|\s+[·|]\s+|;\s+/);
  return lines.map((l) => l.replace(BULLET_RE, "").trim()).filter(Boolean);
}

const KEY_RE = /\b[A-Z][A-Z0-9_]{1,19}-\d+\b/g;
const keysOf = (s) => new Set(String(s || "").match(KEY_RE) || []);
// Trailing Korean particles / endings, so "배포는" and "배포" meet. Longest first.
const PARTICLE_RE = /(에서는|에서도|으로는|에게서|까지는|부터는|에서|에게|으로|까지|부터|처럼|보다|이랑|하고|이고|이며|입니다|합니다|했음|했다|된다|됨|함|은|는|이|가|을|를|에|의|도|로|와|과|랑|만)$/;
const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "확인", "요청", "관련", "공유", "논의", "내용", "오늘", "현재", "진행", "이번", "그리고", "있음", "없음"]);
function tokensOf(s) {
  const out = new Set();
  for (const raw of String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const w = /[가-힣]/.test(raw) && raw.length > 2 ? raw.replace(PARTICLE_RE, "") : raw;
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return out;
}

/**
 * The highlight a summary line is about, or null when unclear. Issue key shared with exactly one highlight wins;
 * otherwise ≥2 shared words, covering ≥30% of the line's words, and strictly more than the runner-up.
 */
export function matchHighlight(line, hls) {
  const cands = (hls || []).filter((h) => safeUrl(h.url));
  if (!cands.length) return null;
  const lk = keysOf(line);
  if (lk.size) {
    const hit = cands.filter((h) => [...keysOf(`${h.text} ${h.reason || ""}`)].some((k) => lk.has(k)));
    const urls = new Set(hit.map((h) => h.url));
    if (urls.size === 1) return hit[0];
    if (urls.size > 1) return null; // several highlights share the key → ambiguous
  }
  const lt = tokensOf(line);
  if (lt.size < 2) return null;
  const scored = cands.map((h) => { const ht = tokensOf(h.text); let n = 0; for (const w of lt) if (ht.has(w)) n++; return { h, n }; })
    .sort((a, b) => b.n - a.n);
  const [best, second] = scored;
  if (!best || best.n < 2 || best.n / lt.size < 0.3) return null;
  if (second && second.n >= best.n && second.h.url !== best.h.url) return null;
  return best.h;
}

/**
 * Highlights a summary line could be about when matchHighlight can't pick one: several share its issue key, or several
 * pass the word test (≥2 shared words, ≥30% of the line) — best first, max 5. [] when nothing comes close.
 */
export function matchCandidates(line, hls) {
  const cands = (hls || []).filter((h) => safeUrl(h.url));
  const uniq = (list) => { const seen = new Set(); return list.filter((h) => !seen.has(h.url) && seen.add(h.url)); };
  const lk = keysOf(line);
  if (lk.size) {
    const hit = uniq(cands.filter((h) => [...keysOf(`${h.text} ${h.reason || ""}`)].some((k) => lk.has(k))));
    if (hit.length) return hit.slice(0, 5);
  }
  const lt = tokensOf(line);
  if (lt.size < 2) return [];
  return uniq(cands.map((h) => { const ht = tokensOf(h.text); let n = 0; for (const w of lt) if (ht.has(w)) n++; return { h, n }; })
    .filter((x) => x.n >= 2 && x.n / lt.size >= 0.3).sort((a, b) => b.n - a.n).map((x) => x.h)).slice(0, 5);
}

/**
 * Which message a summary line's ✎ drafts a reply to:
 * - {kind: "one", h}     — matchHighlight is sure (the same message the ↗ opens);
 * - {kind: "many", list} — several highlights fit → the draft modal asks which one first;
 * - {kind: "recent", h}  — nothing fits → the channel's newest message (recent[0], else the newest highlight), with a
 *   "가장 최근 메시지 기준" note in the modal;
 * - null                 — the channel has no message with a permalink at all.
 */
export function summaryTarget(line, hls, recent) {
  const h = matchHighlight(line, hls);
  if (h) return { kind: "one", h };
  const list = matchCandidates(line, hls);
  if (list.length > 1) return { kind: "many", list };
  if (list.length === 1) return { kind: "one", h: list[0] };
  const newest = (recent || []).find((m) => m && safeUrl(m.url)) || [...(hls || [])].filter((x) => safeUrl(x.url)).sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")))[0];
  return newest ? { kind: "recent", h: newest } : null;
}

/**
 * `<li>` per summary line, a ↗ permalink on lines that clearly match a highlight. "" when there's no summary.
 * `opts.act(target, line)` (watchrow.js): extra html at the end of the line — the ✎ for summaryTarget(line, hls, opts.recent).
 */
export function summaryHtml(summary, hls, opts = {}) {
  return summaryLines(summary).map((l) => {
    const h = matchHighlight(l, hls), u = h && safeUrl(h.url);
    const link = u ? " " + ext(u, "↗", "wlk").replace("<a ", `<a title="${esc(`메시지 열기 — ${h.from || ""}: ${String(h.text || "").slice(0, 60)}`)}" aria-label="관련 메시지 열기" `) : "";
    const t = opts.act ? summaryTarget(l, hls, opts.recent) : null;
    return `<li>${esc(l)}${link}${t ? opts.act(t, l) : ""}</li>`;
  }).join("");
}
