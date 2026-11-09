/* Reply-draft modal's "답할 것" list + 멘션 제안 toggle — pure (no DOM at import), so node tests can render it and step
 * the toggle's state. Shown only for 2-pass results (meta.mode "2pass"); legacy and pre-2-pass cache results render nothing. */
import { esc } from "../util.js";

/** The draft response came from the 2-pass pipeline (asks / mentions are meaningful). */
export const isTwoPass = (r) => !!r && r.meta?.mode === "2pass" && Array.isArray(r.asks);

/** A mention as the response carries it: `{id: "<@U…>", name}`, or a plain `"<@U…>"` string (older cache files). */
export const mentionId = (m) => (m && typeof m === "object" ? String(m.id || "") : String(m || ""));
/** Chip label: `이름 (@U…)`, or `@U…` when the name is unknown. */
export function mentionLabel(m) {
  const at = mentionId(m).replace(/^<@([^>]+)>$/, "@$1");
  const name = m && typeof m === "object" ? String(m.name || "").trim() : "";
  return name ? `${name} (${at})` : at;
}
/** The `<@U…>` ids of a response's mentions (what the toggle inserts). */
export const mentionIds = (r) => (Array.isArray(r?.mentions) ? r.mentions.map(mentionId).filter(Boolean) : []);

/**
 * "답할 것" list html: open asks `☐ n 누가 · 무엇 · (마감)` (+ small "이전" chip when asked before my last reply),
 * answered ones dimmed `✓ 이미 답함`, "답할 질문 없음 — 가벼운 확인 답" when nothing is open, and the 멘션 제안 chips +
 * toggle when the response suggests mentions.
 */
export function asksHtml(r, { mentionOn = false } = {}) {
  if (!isTwoPass(r)) return "";
  const open = r.asks.filter((a) => a.status === "open");
  const done = r.asks.filter((a) => a.status !== "open");
  const who = (a) => (a.who ? `<span class="who">${esc(a.who)}</span> · ` : "");
  const prev = (a) => (a.before_reply ? ` <span class="prev" title="내 마지막 답글 전에 나온 질문 — 아직 답 안 됨">이전</span>` : "");
  const rows = [
    ...open.map((a, i) => `<li class="dask open"><span class="bx" aria-hidden="true">☐</span><span class="n">${i + 1}</span>${who(a)}<span class="what">${esc(a.what)}</span>${a.due ? ` <span class="due">(${esc(a.due)})</span>` : ""}${prev(a)}</li>`),
    ...done.map((a) => `<li class="dask done"><span class="bx" aria-hidden="true">✓</span><span class="st">이미 답함</span> · ${who(a)}<span class="what">${esc(a.what)}</span></li>`),
  ];
  const none = open.length ? "" : `<div class="dask-none">답할 질문 없음 — 가벼운 확인 답</div>`;
  const list = rows.length ? `<ul class="dasks">${rows.join("")}</ul>` : "";
  const ms = (Array.isArray(r.mentions) ? r.mentions : []).filter((m) => mentionId(m));
  const mention = ms.length
    ? `<div class="dmention">멘션 제안: ${ms.map((m) => `<span class="chip">${esc(mentionLabel(m))}</span>`).join(" ")} <button type="button" class="chip tog${mentionOn ? " on" : ""}" data-dmention="1" aria-pressed="${mentionOn}" title="켜면 초안 첫머리에 멘션을 넣어">${mentionOn ? "멘션 넣음" : "멘션 넣기"}</button></div>`
    : "";
  return `<div class="dask-box" role="group" aria-label="답할 것"><div class="dask-h">답할 것${open.length ? ` ${open.length}` : ""}</div>${none}${list}${mention}</div>`;
}

/** The mentions the text doesn't contain yet (= what applyMentions(…, true) would prepend). */
export const missingMentions = (text, ids) => (Array.isArray(ids) ? ids : []).filter((m) => m && !String(text ?? "").includes(m));

/**
 * Text with mentions at the front (`on`) or without them (`!on`). On: only the ids the text doesn't already contain are
 * prepended (never a duplicate). Off: strips a leading run of the given ids — callers pass only the ones the toggle added.
 */
export function applyMentions(text, ids, on) {
  const t = String(text ?? "");
  const ms = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!ms.length) return t;
  if (on) {
    const missing = missingMentions(t, ms);
    return missing.length ? `${missing.join(" ")} ${t.replace(/^\s+/, "")}` : t;
  }
  let out = t;
  for (;;) {
    const m = ms.find((x) => out.startsWith(x));
    if (!m) break;
    out = out.slice(m.length).replace(/^\s+/, "");
  }
  return out;
}

/**
 * Toggle state: `{on, edits: {tab: text}, added: {tab: [ids the toggle put there]}}`. Unedited tabs show
 * `shownText` (the model's text, plus the mentions only while on — a mention the model wrote itself is never stripped).
 */
export const shownText = (base, ids, on) => (on ? applyMentions(base, ids, true) : String(base ?? ""));

/** Flip the toggle: edited tabs get the missing ids (recorded as added) or lose exactly what the toggle added. */
export function toggleMentions(st, ids) {
  const on = !st.on, edits = { ...st.edits }, added = { ...st.added };
  for (const k of Object.keys(edits)) {
    if (on) { added[k] = missingMentions(edits[k], ids); edits[k] = applyMentions(edits[k], ids, true); }
    else { edits[k] = applyMentions(edits[k], added[k] || [], false); delete added[k]; }
  }
  return { on, edits, added };
}

/**
 * The user typed into tab `tab` (`value` = new text, `base` = the model's text). On the first edit of a tab while the
 * toggle is on, the mentions shown were the toggle's — record them so turning it off removes them.
 */
export function editMentions(st, tab, value, base, ids) {
  const added = { ...st.added };
  if (st.on && !(tab in st.edits)) added[tab] = missingMentions(base, ids);
  return { on: st.on, edits: { ...st.edits, [tab]: value }, added };
}
