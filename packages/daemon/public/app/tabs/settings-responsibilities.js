/* 설정 → 맡긴 일 (config.responsibilities, ≤ 5): 책임마다 켜기 · 제목 · 챙길 것 · 볼 곳(sources) · 키워드 · 언제까지(until).
 * The section (#s-resp) + its nav link are added by initResponsibilities() (index.html untouched), right after 소스.
 * Saves with the form: readResponsibilities() → PUT /api/config { responsibilities } (the array replaces as a whole; the
 * daemon keeps ids and gives new rows one — src/config.ts normalizeResponsibilities). Past `until` → "끝남" chip (kept). */
import { $, esc } from "../util.js";

/** = src/config.ts RESPONSIBILITIES_MAX / RESP_SOURCES (same order) / length limits. */
export const RESP_MAX = 5;
export const RESP_SRC = [["slack", "Slack"], ["mail", "메일"], ["jira", "Jira"], ["github", "GitHub"], ["calendar", "캘린더"], ["sessions", "세션"]];
export const RESP_TITLE_LEN = 60;
export const RESP_GOAL_LEN = 300;
export const RESP_KEYWORDS_MAX = 10;
export const RESP_KEYWORD_LEN = 40;

const pad = (n) => String(n).padStart(2, "0");
export const todayYmd = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
/** Past its until (local day, inclusive) — the patrol leaves it out. */
export const respEnded = (r, now = new Date()) => !!r?.until && r.until < todayYmd(now);

/** One editable row (pure). `i` = position; `r` = a config.responsibilities entry ({} for a new one). */
export function respRowHtml(r, i, now = new Date()) {
  const all = !Array.isArray(r.sources) || !r.sources.length;
  const ended = respEnded(r, now);
  const n = i + 1;
  return `<div class="respi${r.enabled === false ? " off" : ""}${ended ? " ended" : ""}" data-ri="${i}"${r.id ? ` data-rid="${esc(r.id)}"` : ""} role="group" aria-label="맡긴 일 ${n}">
    <div class="resph">
      <label class="ck" title="끄면 순찰이 보지 않아 — 내용은 그대로"><input type="checkbox" data-rf="enabled" ${r.enabled === false ? "" : "checked"} aria-label="맡긴 일 ${n} 켜기"> 켜기</label>
      <input type="text" data-rf="title" maxlength="${RESP_TITLE_LEN}" value="${esc(r.title || "")}" placeholder="예: 이번 주 0.5 릴리스 막히는 것 챙기기" aria-label="맡긴 일 ${n} 제목">
      ${ended ? `<span class="chipx" title="언제까지 날짜가 지나 순찰에서 빠졌어 — 날짜를 바꾸면 다시 봐">끝남</span>` : ""}
      <button type="button" class="btn small x" data-rdel="${i}" aria-label="맡긴 일 ${n} 삭제" title="삭제">삭제</button>
    </div>
    <textarea data-rf="goal" rows="2" maxlength="${RESP_GOAL_LEN}" placeholder="무엇을 챙기면 되는지 — 예: 0.5 를 막는 이슈·리뷰·빌드 실패, 누가 답을 기다리는지" aria-label="맡긴 일 ${n} 챙길 것">${esc(r.goal || "")}</textarea>
    <div class="toggles" data-rf="sources" role="group" aria-label="맡긴 일 ${n} 볼 곳">${RESP_SRC.map(([k, label]) => `<label><input type="checkbox" data-rsrc="${k}" ${all || r.sources.includes(k) ? "checked" : ""}>${esc(label)}</label>`).join("")}</div>
    <div class="inl">
      <label class="lab">키워드 <input type="text" data-rf="keywords" value="${esc((r.keywords || []).join(", "))}" placeholder="0.5, 릴리스" aria-label="맡긴 일 ${n} 키워드 (쉼표로, 최대 ${RESP_KEYWORDS_MAX}개)"></label>
      <label class="lab">언제까지 <input type="date" data-rf="until" value="${esc(r.until || "")}" aria-label="맡긴 일 ${n} 언제까지"></label>
    </div>
  </div>`;
}

/** The list + add button (pure). */
export function respListHtml(list, now = new Date()) {
  const rows = list.length ? list.map((r, i) => respRowHtml(r, i, now)).join("") : `<div class="hint">아직 맡긴 일이 없어. "맡긴 일 추가" 로 챙겨 줄 일을 적어 줘.</div>`;
  const full = list.length >= RESP_MAX;
  return `${rows}<div class="inl"><button type="button" class="btn small" id="c-resp-add" ${full ? "disabled" : ""}>＋ 맡긴 일 추가</button><span class="hint">${full ? `최대 ${RESP_MAX}개까지야.` : `${list.length}/${RESP_MAX}`}</span></div>`;
}

/** One row → a config entry. Sources: all (or none) ticked → omitted (= 전부); empty keywords / until → omitted. */
function readRow(el) {
  const f = (k) => el.querySelector(`[data-rf="${k}"]`);
  const src = [...el.querySelectorAll("[data-rsrc]")].filter((c) => c.checked).map((c) => c.dataset.rsrc);
  const kw = [...new Set(f("keywords").value.split(",").map((k) => k.replace(/\s+/g, " ").trim().slice(0, RESP_KEYWORD_LEN)).filter(Boolean))]; // = server's 40-char cut
  const until = f("until").value;
  return {
    ...(el.dataset.rid ? { id: el.dataset.rid } : {}),
    title: f("title").value.trim(),
    goal: f("goal").value.trim(),
    ...(src.length && src.length < RESP_SRC.length ? { sources: src } : {}),
    ...(kw.length ? { keywords: kw } : {}),
    ...(until ? { until } : {}),
    enabled: f("enabled").checked,
  };
}

/** The form's responsibilities, in row order (no section yet → null: nothing to send). */
export function readResponsibilities() {
  const box = $("c-resp");
  return box ? [...box.querySelectorAll(".respi")].map(readRow) : null;
}

/** Save guard (the daemon would drop / cut these): a row without a title, too many keywords, more than 5. → message or null. */
export function responsibilitiesMsg(list) {
  if (!Array.isArray(list)) return null;
  if (list.length > RESP_MAX) return `맡긴 일은 ${RESP_MAX}개까지야`;
  const i = list.findIndex((r) => !r.title);
  if (i >= 0) return `맡긴 일 ${i + 1} 에 제목을 적어 줘`;
  const k = list.findIndex((r) => (r.keywords?.length || 0) > RESP_KEYWORDS_MAX);
  if (k >= 0) return `맡긴 일 ${k + 1} 의 키워드는 ${RESP_KEYWORDS_MAX}개까지야`;
  return null;
}

function draw(list) {
  $("c-resp").innerHTML = respListHtml(list);
  syncResponsibilities();
}
export function renderResponsibilities(c) {
  if (!$("c-resp")) return;
  draw(Array.isArray(c?.responsibilities) ? c.responsibilities : []);
}

/** 켜기 off → that row dims (values kept); the message line follows the save guard. */
export function syncResponsibilities() {
  for (const el of document.querySelectorAll("#c-resp .respi")) el.classList.toggle("off", !el.querySelector('[data-rf="enabled"]').checked);
  const msg = $("c-resp-msg");
  if (msg) msg.textContent = responsibilitiesMsg(readResponsibilities()) || "";
}

const SECTION = `<section class="card ssec" id="s-resp" aria-labelledby="s-resp-h" aria-describedby="s-resp-d">
  <div class="hd"><h2 id="s-resp-h" tabindex="-1">맡긴 일</h2></div>
  <div class="bd">
    <p class="sdesc" id="s-resp-d">챙겨 달라고 맡긴 책임(최대 ${RESP_MAX}개). 순찰이 업무 목록에서 관련 항목을 찾아 책임마다 순조·주의·막힘을 매기고 홈 위 "맡긴 일" 띠에 보여 줘. 막혀서 내가 움직여야 하면 할 일에도 올려. 따로 Claude 를 부르지 않아 — 순찰 한 번에 같이 봐.</p>
    <div class="resp" id="c-resp" role="list" aria-label="맡긴 일 목록"></div>
    <span class="hint">볼 곳을 다 켜 두면(또는 다 끄면) 전부 봐. 키워드는 쉼표로(최대 ${RESP_KEYWORDS_MAX}개, 하나에 ${RESP_KEYWORD_LEN}자까지) — 업무 목록 항목을 고르는 힌트. 언제까지가 지나면 순찰에서 빠지고 "끝남"으로 남아(지우지 않음).</span>
    <span class="hint" id="c-resp-msg" role="status" style="color:var(--red)"></span>
  </div>
</section>`;

export const RESP_SET_CSS = `.resp { display: flex; flex-direction: column; gap: 10px; }
.respi { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
.respi.off > :not(.resph), .respi.off .resph input[type=text] { opacity: .5; }
.respi.ended { border-style: dashed; }
.respi .resph { display: flex; gap: 8px; align-items: center; }
.respi .resph input[type=text] { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font: inherit; }
.respi textarea { width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: 13px; background: var(--bg); color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
.respi .inl { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.respi .inl .lab { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--dim); }
.respi .inl input { background: var(--bg); color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 13px; }
.respi .inl input[type=text] { width: 220px; max-width: 60vw; }
#s-resp > .bd > .inl, .resp > .inl { display: flex; gap: 8px; align-items: center; }`;

/** Section + nav link (after 소스) + listeners. Every edit bubbles to #cfg, so the dirty mark follows on its own. */
export function initResponsibilities() {
  const nav = $("s-nav"), src = $("s-sources");
  if (!nav || !src || $("s-resp")) return;
  const st = document.createElement("style"); st.textContent = RESP_SET_CSS; document.head.appendChild(st);
  src.insertAdjacentHTML("afterend", SECTION);
  const link = nav.querySelector('[data-sjump="s-sources"]');
  const a = `<a href="#settings" data-sjump="s-resp">맡긴 일</a>`;
  if (link) link.insertAdjacentHTML("afterend", a); else nav.insertAdjacentHTML("beforeend", a);
  const box = $("c-resp");
  box.addEventListener("click", (e) => {
    const del = e.target.closest("[data-rdel]");
    const add = e.target.closest("#c-resp-add");
    if (!del && !add) return;
    e.preventDefault();
    const list = readResponsibilities();
    if (del) list.splice(Number(del.dataset.rdel), 1);
    else if (list.length < RESP_MAX) list.push({ title: "", goal: "", enabled: true });
    draw(list);
    if (add) [...box.querySelectorAll('[data-rf="title"]')].pop()?.focus();
    else (box.querySelector("[data-rdel]") || $("c-resp-add"))?.focus();
  });
  box.addEventListener("input", syncResponsibilities);
  box.addEventListener("change", syncResponsibilities);
}
