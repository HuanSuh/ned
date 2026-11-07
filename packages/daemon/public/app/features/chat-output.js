/* Ned Net 정리 결과물 (```ned-output, src/outputs.ts). The model ends a 회의·문서·메일 정리 answer with ONE
 * ```ned-output {"kind","title","markdown"} block; the daemon saves it (~/.ned/outputs, + the Obsidian vault with
 * config.archive) and puts `output` (or `output_error`) on the message. Here: hide the fence, show a 저장 카드 —
 * kind · title, where it was saved, [Obsidian 에서 열기] [Finder 에서 보기], and the note itself under "내용 보기".
 * DOM-free at import (tests import it directly). */
import { esc } from "../util.js";

export const OUTPUT_FENCE = "ned-output";
export const OUTPUT_KIND_KO = { meeting: "회의", document: "문서", mail: "메일", other: "정리" };
const FENCE_RE = /```ned-output[^\n]*\n([\s\S]*?)\n?```(?!`)/g;

/**
 * Split an answer into the visible text and its ned-output block. Every complete fence is removed; an unterminated one
 * (still streaming) is cut off and reported as `pending`. → { text, block: {kind, title, markdown} | null, pending }
 */
export function parseOutputBlock(answer) {
  const src = String(answer ?? "");
  const all = [...src.matchAll(FENCE_RE)];
  let text = all.length ? src.replace(FENCE_RE, "") : src;
  const open = text.indexOf("```" + OUTPUT_FENCE);
  const pending = open >= 0;
  if (pending) text = text.slice(0, open);
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  let block = null;
  if (all.length) {
    try {
      const j = JSON.parse(all[all.length - 1][1]);
      if (j && typeof j === "object" && typeof j.markdown === "string") block = { kind: OUTPUT_KIND_KO[j.kind] ? j.kind : "other", title: String(j.title || "").trim(), markdown: j.markdown };
    } catch { /* the server reports output_error */ }
  }
  return { text, block, pending };
}

const obsidianHref = (u) => (typeof u === "string" && /^obsidian:\/\/open\?/.test(u) ? u : "");

/**
 * The 저장 카드. `out` = message.output ({id, kind, title, vault_rel?, obsidian_url?, vault_error?}) or null (not saved
 * yet — e.g. an older daemon); `err` = message.output_error; `block` = the parsed fence (preview); `md` renders markdown.
 */
export function renderOutputCard({ out = null, err = "", block = null }, md = (s) => esc(s)) {
  if (!out && err) return `<div class="cm-out bad">⚠ ${esc(err)}</div>`;
  if (!out && !block) return "";
  const kind = OUTPUT_KIND_KO[out?.kind || block?.kind] || "정리";
  const title = out?.title || block?.title || "";
  const href = obsidianHref(out?.obsidian_url);
  const where = !out ? "저장 정보 없음 (데몬이 이 기능을 모름)"
    : out.vault_rel ? `볼트: ${out.vault_rel}`
    : out.vault_error ? `Ned 에만 저장 — ${out.vault_error}`
    : "Ned 에 저장 (Obsidian 아카이브 꺼짐 — 설정 → 아카이브)";
  return `<div class="cm-out${out?.vault_error ? " warn" : ""}" ${out ? `data-out="${esc(out.id)}"` : ""}>
  <div class="co-h"><span class="co-k">📎 ${esc(kind)} 정리 저장됨</span>${title ? ` <b>${esc(title)}</b>` : ""}</div>
  <div class="co-w">${esc(where)}</div>
  ${out ? `<div class="co-b">${href ? `<a class="btn small" href="${esc(href)}">Obsidian 에서 열기</a>` : ""}<button type="button" class="btn small" data-out-reveal="${esc(out.id)}">Finder 에서 보기</button></div>` : ""}
  ${block ? `<details class="co-d"><summary>내용 보기</summary><div class="co-md">${md(block.markdown)}</div></details>` : ""}
</div>`;
}

export const OUTPUT_CSS = `.cm-out { margin-top: 8px; padding: 8px 10px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--cm-accent, var(--hero)) 45%, var(--line)); background: color-mix(in srgb, var(--cm-accent, var(--hero)) 6%, var(--raise, var(--bg))); display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; }
.cm-out .co-k { font-weight: 600; font-size: 12px; color: var(--cm-accent, var(--hero)); }
.cm-out .co-w { color: var(--dim); font-size: 11.5px; overflow-wrap: anywhere; }
.cm-out.warn .co-w, .cm-out.bad { color: var(--red); }
.cm-out .co-b { display: flex; gap: 6px; flex-wrap: wrap; }
.cm-out .co-d summary { cursor: pointer; color: var(--dim); font-size: 11.5px; }
.cm-out .co-md { margin-top: 6px; max-height: 320px; overflow: auto; }`;

/** Delegated click: [Finder 에서 보기] → POST /api/outputs/:id/reveal. `deps.postJson`, `deps.toast`. */
export function wireOutputCards(root, deps) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-out-reveal]"); if (!b || !root.contains(b)) return;
    e.preventDefault();
    const r = await deps.postJson(`/api/outputs/${encodeURIComponent(b.dataset.outReveal)}/reveal`, {}).catch(() => null);
    if (!r?.ok) deps.toast(`Finder 에서 못 열었어${r?.data?.error ? `: ${r.data.error}` : ""}`);
  });
}
