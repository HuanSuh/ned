/* 팔로업 rows shared by both placements — separate cards (config.dashboard.watch_cards on, watchcards.js) and the Slack
 * card's '채널 팔로업' fold (off, cards.js renderSlackWatch): highlight rows, 최근 대화, summary lines, each with a ✎.
 * Pure (no DOM at import) so test/watch-drafts.test.ts renders them in node.
 * Every ✎ here: origin "watch", and the message's own ts becomes thread_ts (a reply goes into its thread, not the channel). */
import { draftBtn, draftFor, slackRef } from "./draftref.js";
import { isOpenSrc, revCls, srcCheck, srcKey } from "./revkeys.js";
import { histPanel, histToggle, newChip, recentHtml, threadTail } from "./slackthread.js";
import { summaryHtml } from "./watchsum.js";
import { openIcon } from "../ui/icons.js";
import { esc, ext, rel, safeUrl, toMs } from "../util.js";

export const WATCH_DRAFT = { origin: "watch", thread: true };
export const RECENT_NOTE = "요약 줄에 딱 맞는 메시지를 못 찾아서, 이 채널의 가장 최근 메시지 기준으로 써.";
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** ✎ for one 팔로업 message (highlight / 최근 대화). `soft`: dimmed until hover — rows that don't need me. */
export const watchDraft = (channel, m, extra = {}) => draftFor("slack", { ...m, channel }, srcKey("slack", m), { ...WATCH_DRAFT, ...extra });

/** One highlight row. needs_me rows get the accent bar + a full-strength ✎; the others a dimmed one (hover shows it).
 *  A followed thread (row.thread, slack-threads.ts) adds "+N 새 답글" and its summary + latest reply under the row. */
export function watchRow(channel, h) {
  const u = safeUrl(h.url), rv = revCls("slack", h), text = h.text || "(내용 없음)";
  return `<div class="ti${h.needs_me && !rv ? " need" : ""}${rv}"><span class="ic">${h.needs_me ? "❗" : "·"}</span><div class="mn"><span class="tt">${u ? ext(u, esc(text)) : esc(text)}</span>
      <div class="sb"><span class="from">${esc(h.from)}</span>${h.needs_me ? `<span class="chipx today">나한테</span>` : ""}${newChip(h)}${histToggle(h)}${h.reason ? `<span class="d">${esc(h.reason)}</span>` : ""}${h.ts ? `<span>${rel(toMs(h.ts))}</span>` : ""}</div>${threadTail(h)}${histPanel(h)}</div>
      <div class="ra">${watchDraft(channel, h, { soft: !h.needs_me })}${openIcon(u)}${srcCheck("slack", h)}</div></div>`;
}

/** The ✎ at the end of a summary line, for watchsum.js summaryTarget(): one message / pick among several / newest. */
export function summaryAct(channel) {
  return (t) => {
    if (t.kind === "one") return watchDraft(channel, t.h, { soft: true, title: `이 줄의 메시지에 답장 초안 — ${t.h.from || ""}: ${clip(t.h.text, 40)}` });
    if (t.kind === "recent") return watchDraft(channel, t.h, { soft: true, note: RECENT_NOTE, title: "답장 초안 — 맞는 메시지가 없어 채널의 가장 최근 메시지 기준" });
    const pick = t.list.map((h) => ({ source: "slack", ref: slackRef({ ...h, channel }, WATCH_DRAFT), from: h.from || "", label: clip(h.text, 120), att: srcKey("slack", h) }));
    return draftBtn("slack", pick[0].ref, "", { ...WATCH_DRAFT, soft: true, pick });
  };
}

/** Summary `<li>`s of one watch entry (↗ + ✎ per line), "" without a summary. */
export const watchSummary = (w) => summaryHtml(w?.summary, w?.highlights || [], { recent: w?.recent, act: summaryAct(w?.channel || "") });
/** 최근 대화 rows of one watch entry with a ✎ each (dimmed), skipping urls already listed. */
export const watchRecent = (w, skip = new Set()) => recentHtml(w?.recent, skip, (m) => (safeUrl(m.url) ? watchDraft(w.channel, m, { soft: true }) : ""));

/** The Slack card's '채널 팔로업' fold (watch_cards off): per channel summary (↗ + ✎), highlight rows, else 최근 대화. */
export function watchFoldHtml(watch, needN = 0, open = false) {
  if (!watch?.length) return "";
  return `<details class="swatch" ${open ? "open" : ""}><summary>채널 팔로업 ${watch.length}${needN ? `<span class="chipx today">나한테 ${needN}</span>` : ""}</summary>` +
    watch.map((w) => {
      const hls = w.highlights || [], n = hls.filter((h) => h.needs_me && isOpenSrc("slack")(h)).length, sum = watchSummary(w);
      return `<div class="swch"><div class="swh">${esc(w.channel)}${n ? `<span class="chipx today">${n}</span>` : ""}</div>` +
        (sum ? `<ul class="wsum sws">${sum}</ul>` : (!hls.length && watchRecent(w)) || `<div class="gnone">표시 구간에 눈에 띄는 대화 없음.</div>`) +
        hls.map((h) => watchRow(w.channel, h)).join("") + `</div>`;
    }).join("") + `</details>`;
}
