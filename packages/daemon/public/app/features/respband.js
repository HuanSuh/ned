/* 홈 "맡긴 일" 띠: config.responsibilities (켜진 것만) × state.json responsibilities (순찰의 평가) — 책임마다 상태 점 · 제목 ·
 * note 한 줄 · 갱신 시각 · 근거 링크. 책임이 없으면 띠 자체가 없다(그리드 패널 아님, .htop 아래 얇은 줄).
 * Links are plain external anchors — features/openlink.js routes their clicks (앱 딥링크 / 웹) like every other link. */
import { S } from "../state.js";
import { $, esc, ext, mdhm, rel, safeUrl } from "../util.js";

/** Status → [led class (base.css: g 정상 / a 주의 / r 오류), label]. */
export const RESP_STATUS = { on_track: ["g", "순조"], watch: ["a", "주의"], blocked: ["r", "막힘"] };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The band's HTML (pure): "" when no responsibility is switched on. Ended ones (past until) stay, dimmed, as 끝남. */
export function respBandHtml(responsibilities, ratings, now = Date.now()) {
  const list = (Array.isArray(responsibilities) ? responsibilities : []).filter((r) => r && r.enabled !== false && r.title);
  if (!list.length) return "";
  const today = ymd(new Date(now));
  const rows = list.map((r) => {
    const ended = !!r.until && r.until < today;
    const st = ratings?.[r.id];
    const [led, label] = ended ? ["", "끝남"] : st && RESP_STATUS[st.status] ? RESP_STATUS[st.status] : ["", "평가 전"];
    const note = ended ? `${r.until} 까지였어 — 순찰에서 뺐어.` : st ? st.note || "" : "다음 순찰 때 살펴볼게.";
    const ok = !ended && st ? (st.urls || []).map(safeUrl).filter(Boolean).slice(0, 3) : [];
    const links = ok.map((u, i) => ext(u, `↗${ok.length > 1 ? i + 1 : ""}`, "rbl")).join(""); // numbered over the links shown
    const when = !ended && st?.updated_at ? `<span class="rbt" title="${esc(mdhm(st.updated_at))} 순찰">${esc(rel(st.updated_at))}</span>` : "";
    return `<div class="rbi${ended ? " ended" : ""}" data-resp="${esc(r.id)}" data-status="${esc(ended ? "ended" : st?.status || "none")}" role="listitem">`
      + `<span class="led ${led}" title="${esc(label)}" aria-label="${esc(label)}"></span><b class="rbn" title="${esc(r.goal || r.title)}">${esc(r.title)}</b>`
      + `<span class="rbs">${esc(label)}</span><span class="rbd" title="${esc(note)}">${esc(note)}</span>${links}${when}</div>`;
  });
  return `<div class="rbh">맡긴 일</div><div class="rbl-list" role="list" aria-label="맡긴 일">${rows.join("")}</div>`;
}

export const RESP_BAND_CSS = `.respband { flex: none; display: flex; gap: 6px 12px; align-items: flex-start; margin: -4px 0 12px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--pane); font-size: 12.5px; }
.respband .rbh { flex: none; font-weight: 600; color: var(--dim); padding-top: 2px; white-space: nowrap; }
.respband .rbl-list { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.respband .rbi { display: flex; gap: 8px; align-items: center; min-width: 0; line-height: 1.6; }
.respband .rbi .led { flex: none; margin: 0; }
.respband .rbn { flex: none; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.respband .rbs { flex: none; font-size: 11px; color: var(--dim); }
.respband .rbi[data-status=blocked] .rbs { color: var(--red); }
.respband .rbi[data-status=watch] .rbs { color: var(--amber); }
.respband .rbd { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); }
.respband .rbl { flex: none; text-decoration: none; color: var(--info); }
.respband .rbt { flex: none; color: var(--faint); font-size: 11px; }
.respband .rbi.ended { opacity: .55; }
@media (max-width: 640px) { .respband { flex-direction: column; } .respband .rbn { max-width: 45%; } }`;

/** Draw (or remove) the band under the home greeting from S.config + S.state. */
export function renderRespBand() {
  const top = document.querySelector("#v-home .htop");
  if (!top) return;
  const html = respBandHtml(S.config?.responsibilities, S.state?.responsibilities);
  let band = $("resp-band");
  if (!html) { band?.remove(); return; }
  if (!band) {
    top.insertAdjacentHTML("afterend", `<section class="respband" id="resp-band" aria-label="맡긴 일"></section>`);
    band = $("resp-band");
  }
  if (band.innerHTML !== html) band.innerHTML = html;
}

/** One-time: the band's styles (home.js init calls it). */
export function init() {
  const st = document.createElement("style"); st.textContent = RESP_BAND_CSS; document.head.appendChild(st);
}
