/* Reply-draft modal's "답할 것" list + 멘션 제안 toggle — pure (no DOM at import), so node tests can render it.
 * Shown only for 2-pass results (meta.mode "2pass"); legacy and pre-2-pass cache results render nothing here. */
import { esc } from "../util.js";

/** The draft response came from the 2-pass pipeline (asks / mentions are meaningful). */
export const isTwoPass = (r) => !!r && r.meta?.mode === "2pass" && Array.isArray(r.asks);

/** `<@U0KIM>` → `@U0KIM` for display. */
export const mentionLabel = (m) => String(m || "").replace(/^<@([^>]+)>$/, "@$1");

/**
 * "답할 것" list html: open asks `☐ n 누가 · 무엇 · (마감)`, answered ones dimmed `✓ 이미 답함`, "답할 질문 없음 — 가벼운
 * 확인 답" when nothing is open, and the 멘션 제안 chips + toggle when the response suggests mentions.
 */
export function asksHtml(r, { mentionOn = false } = {}) {
  if (!isTwoPass(r)) return "";
  const open = r.asks.filter((a) => a.status === "open");
  const done = r.asks.filter((a) => a.status !== "open");
  const who = (a) => (a.who ? `<span class="who">${esc(a.who)}</span> · ` : "");
  const rows = [
    ...open.map((a, i) => `<li class="dask open"><span class="bx" aria-hidden="true">☐</span><span class="n">${i + 1}</span>${who(a)}<span class="what">${esc(a.what)}</span>${a.due ? ` <span class="due">(${esc(a.due)})</span>` : ""}</li>`),
    ...done.map((a) => `<li class="dask done"><span class="bx" aria-hidden="true">✓</span><span class="st">이미 답함</span> · ${who(a)}<span class="what">${esc(a.what)}</span></li>`),
  ];
  const none = open.length ? "" : `<div class="dask-none">답할 질문 없음 — 가벼운 확인 답</div>`;
  const list = rows.length ? `<ul class="dasks">${rows.join("")}</ul>` : "";
  const ms = Array.isArray(r.mentions) ? r.mentions.filter(Boolean) : [];
  const mention = ms.length
    ? `<div class="dmention">멘션 제안: ${ms.map((m) => `<span class="chip">${esc(mentionLabel(m))}</span>`).join(" ")} <button type="button" class="chip tog${mentionOn ? " on" : ""}" data-dmention="1" aria-pressed="${mentionOn}" title="켜면 초안 첫머리에 멘션을 넣어">${mentionOn ? "멘션 넣음" : "멘션 넣기"}</button></div>`
    : "";
  return `<div class="dask-box" role="group" aria-label="답할 것"><div class="dask-h">답할 것${open.length ? ` ${open.length}` : ""}</div>${none}${list}${mention}</div>`;
}

/**
 * Draft text with the suggested mentions at the front (`on`) or without them (`!on`). On: only the mentions the text
 * doesn't already contain are prepended (an edited text never gets a duplicate). Off: strips a leading run of them.
 */
export function applyMentions(text, mentions, on) {
  const t = String(text ?? "");
  const ms = (Array.isArray(mentions) ? mentions : []).filter(Boolean);
  if (!ms.length) return t;
  if (on) {
    const missing = ms.filter((m) => !t.includes(m));
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
