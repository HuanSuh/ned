/* Settings tab: config form, persona picker, exclusions, notifications, write actions. */
import { api } from "../api.js";
import { readCardLayout, renderCardLayout } from "../features/cardlayout.js";
import { ACTION_DEFAULTS, ACTION_KO } from "../features/drafts.js";
import { PERSONA_IDS, VOICE, applyPersona, markSvg, persona } from "../features/personas.js";
import { loadAgenda } from "../main.js";
import { S } from "../state.js";
import { KIND_ICON, KIND_KO, SOURCE_LABEL } from "../ui/icons.js";
import { $, esc } from "../util.js";

// ---------- settings ----------
// ---------- tracking exclusions (settings) ----------
export const excl = { slack: [], jira: [], watch: [], ack: [] }; // watch = 팔로업 채널 (filters.slack.watch_channels), ack = 답 필요 해제 이모지 (filters.slack.ack_reactions), same chip UI
const ACK_SUGGEST = ["white_check_mark", "eyes", "+1", "heavy_check_mark", "ok_hand", "raised_hands", "pray", "done"];
export const normX = {
  slack: (v) => v.trim().replace(/^#+/, "").replace(/\s+/g, ""),
  watch: (v) => v.trim().replace(/^#+/, "").replace(/\s+/g, ""),
  jira: (v) => v.trim().toUpperCase().replace(/-\d*$/, ""), // "MNT-123" → "MNT"
  ack: (v) => v.trim().replace(/^:+|:+$/g, "").toLowerCase(), // ":Eyes:" → "eyes"
};
export const validX = { slack: (v) => v.length > 0 && v.length <= 80, watch: (v) => v.length > 0 && v.length <= 80, jira: (v) => /^[A-Z][A-Z0-9_]{0,19}$/.test(v), ack: (v) => /^[\p{Ll}\p{Lo}\p{N}_+'.-]{1,64}$/u.test(v) };
export const showX = { slack: (v) => `#${v}`, watch: (v) => `#${v}`, jira: (v) => v, ack: (v) => `:${v}:` };
export function renderExcl() {
  for (const k of ["slack", "jira", "watch", "ack"]) {
    $("x-" + k).innerHTML = excl[k].map((v, i) => `<span class="xchip"${k === "watch" && excl.slack.some((x) => x.toLowerCase() === v.toLowerCase()) ? ` style="opacity:.5" title="트래킹 제외에도 있어서 건너뛰어"` : ""}>${esc(showX[k](v))}<button type="button" data-xdel="${k}:${i}" aria-label="${esc(showX[k](v))} 빼기" title="빼기">✕</button></span>`).join("");
  }
  // Candidates: channels / project keys seen so far in agenda.json and briefings (client-side, no new API).
  const ch = new Set(), pj = new Set();
  const ag = S.agenda;
  for (const x of [...(ag?.slack?.items || []), ...(ag?.slack?.all || []), ...(ag?.slack?.watch || [])]) if (x.channel?.startsWith("#")) ch.add(x.channel.slice(1));
  for (const j of ag?.jira || []) { const m = /^([A-Z][A-Z0-9_]*)-\d+/.exec(j.key || ""); if (m) pj.add(m[1]); }
  for (const b of S.briefings || []) for (const it of [...(b.action_items || []), ...(b.updates || []), ...(b.fyi || [])]) {
    const text = `${it.title || ""} ${it.detail || ""} ${it.url || ""}`;
    // Korean particles glued to an ASCII name ("#foo으로") aren't part of it; Hangul names ("#cell_수익화랩") are kept.
    if (it.kind === "slack") for (const m of text.matchAll(/#([\p{L}\p{N}_.-]{2,80})/gu)) ch.add(m[1].replace(/(?<=[A-Za-z0-9_.-])(으로|에서|에게|까지|부터|이랑|랑|로|에|의|은|는|이|가|을|를|와|과|도|만)$/u, ""));
    if (it.kind === "jira" || /atlassian\.net\/browse\//.test(text)) for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{1,19})-\d+\b/g)) pj.add(m[1]);
  }
  $("dl-slack").innerHTML = [...ch].filter((v) => !excl.slack.includes(v)).sort().map((v) => `<option value="#${esc(v)}">`).join("");
  $("dl-watch").innerHTML = [...ch].filter((v) => !excl.watch.includes(v) && !excl.slack.includes(v)).sort().map((v) => `<option value="#${esc(v)}">`).join("");
  $("dl-ack").innerHTML = ACK_SUGGEST.filter((v) => !excl.ack.includes(v)).map((v) => `<option value=":${esc(v)}:">`).join("");
  $("dl-jira").innerHTML = [...pj].filter((v) => !excl.jira.includes(v)).sort().map((v) => `<option value="${esc(v)}">`).join("");
}
export function addExcl(k, raw) {
  let added = 0, bad = [];
  for (const part of String(raw).split(/[,\s]+/)) {
    if (!part.trim()) continue;
    const v = normX[k](part);
    if (!validX[k](v)) { bad.push(part.trim()); continue; }
    if (k === "ack" && excl.ack.length >= 8 && !excl.ack.includes(v)) { bad.push(`${part.trim()} (최대 8개)`); continue; }
    if (!excl[k].includes(v)) { excl[k].push(v); added++; }
  }
  $(k === "watch" ? "w-msg" : k === "ack" ? "a-msg" : "x-msg").textContent = bad.length ? `${k === "jira" ? "프로젝트 키는 영문 대문자로 시작하는 영숫자만 돼" : k === "ack" ? "이모지 이름에 공백·기호는 안 돼 (영문·한글·숫자·_+-.' 만)" : "채널 이름이 비었거나 너무 길어"}: ${bad.join(", ")}` : added ? "추가했어. 저장을 눌러야 적용돼." : "";
  renderExcl();
}

export function renderPersonaPicker(cur) {
  const box = $("c-persona");
  if (!box.children.length) {
    box.innerHTML = PERSONA_IDS.map((id) => { const v = VOICE[id]; return `<label class="pcard" data-persona="${id}">
        <input type="radio" name="persona" value="${id}">
        <div class="ptop"><span data-mark="${id}">${markSvg(id, false)}</span><b class="pn">${esc(v.name)}</b><span class="pk">${id}</span></div>
        <div class="sw" aria-hidden="true"><i style="background:var(--bg)"></i><i style="background:var(--pane)"></i><i style="background:var(--hero)"></i><i style="background:var(--info)"></i><i style="background:var(--mint)"></i></div>
        <div class="ph">${esc(v.sample)}</div><div class="pt">${esc(v.tagline)}</div></label>`; }).join("");
  }
  for (const r of box.querySelectorAll("input[name=persona]")) r.checked = r.value === cur;
}

export const NOTIFY_KINDS = ["session", "email", "slack", "jira", "github", "sentry", "calendar"];
export function renderNotifications(n) {
  n = n || {};
  $("n-on").checked = n.enabled !== false;
  $("n-kinds").innerHTML = NOTIFY_KINDS.map((k) => `<label><input type="checkbox" data-nk="${k}" ${n.kinds?.[k] !== false ? "checked" : ""}>${KIND_ICON[k]} ${esc(KIND_KO[k])}</label>`).join("");
  $("n-brief").checked = n.briefing !== false;
  $("n-sound").checked = n.sound !== false;
  $("n-th").value = n.summary_threshold ?? 3;
  for (const r of document.querySelectorAll("input[name=n-quiet]")) r.checked = r.value === (n.quiet_delivery || "skip");
  syncNotifyEnabled();
}
export function syncNotifyEnabled() {
  const on = $("n-on").checked, box = $("n-on").closest(".ntf");
  box.classList.toggle("off", !on);
  for (const el of box.querySelectorAll("input")) if (el.id !== "n-on") el.disabled = !on;
}
export const readNotifications = () => ({
  enabled: $("n-on").checked,
  kinds: Object.fromEntries([...document.querySelectorAll("[data-nk]")].map((c) => [c.dataset.nk, c.checked])),
  briefing: $("n-brief").checked,
  summary_threshold: Math.max(0, Math.min(50, Math.trunc(Number($("n-th").value) || 0))),
  quiet_delivery: document.querySelector("input[name=n-quiet]:checked")?.value || "skip",
  sound: $("n-sound").checked,
});

// ---------- 쓰기 액션: hints + '오늘 한 액션' (GET /api/actions, filtered here) ----------
const ACTION_HINT = {
  jira_comment: "Jira 항목 ⋯ → 코멘트 초안 → 확인 후 코멘트 등록",
  jira_transition: "Jira 항목 ⋯ → 상태 변경 (가능한 전환을 먼저 읽어 옴) → 확인 후 전환",
  github_review: "PR 항목 ⋯ → 리뷰 초안 / 승인 / 변경 요청 / 코멘트 (gh pr review · gh pr comment)",
  calendar_rsvp: "일정 ⋯ → 수락 / 미정 / 거절",
};
const SRC_KO = { slack: "Slack", email: "메일", session: "세션", jira: "Jira", github: "GitHub", calendar: "캘린더" };
const OUTCOME_KO = { ok: ["성공", "ok"], refused: ["거절(꺼짐)", ""], dry_run: ["dry-run", ""], failed: ["실패", "today"] };
export const outcomeOf = (e) => (e.ok ? "ok" : e.action === "refused" ? "refused" : String(e.action || "").startsWith("dry_run:") ? "dry_run" : "failed");
export const AL = { list: null, error: "", source: "", result: "", reads: false };
const localYmd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export async function loadActionLog() {
  try { AL.list = await api("/api/actions"); AL.error = ""; } catch (e) { AL.error = e.message; }
  renderActionLog();
}
export function renderActionLog() {
  let box = $("c-actlog");
  if (!box) {
    $("c-actions").insertAdjacentHTML("afterend", `<div class="actlog" id="c-actlog" role="region" aria-label="오늘 한 액션"></div>`);
    box = $("c-actlog");
  }
  const today = localYmd(Date.now());
  const all = (AL.list || []).filter((e) => localYmd(e.ts) === today);
  const rows = all.filter((e) => (!AL.source || e.source === AL.source) && (!AL.result || outcomeOf(e) === AL.result) && (AL.reads || e.mode !== "transitions"));
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  box.innerHTML = `<div class="alh"><b>오늘 한 액션</b><span class="hint">${all.length}건 · ~/.ned/sent-actions.log (최근 50건 중 오늘)</span><span class="sp"></span>
      <select data-alf="source" aria-label="소스">${opt("", "모든 소스", AL.source)}${Object.keys(SRC_KO).map((k) => opt(k, SRC_KO[k], AL.source)).join("")}</select>
      <select data-alf="result" aria-label="결과">${opt("", "모든 결과", AL.result)}${Object.keys(OUTCOME_KO).map((k) => opt(k, OUTCOME_KO[k][0], AL.result)).join("")}</select>
      <label class="ck" title="Jira 상태 전환 목록 읽기(쓰기 아님)도 보기"><input type="checkbox" data-alf="reads" ${AL.reads ? "checked" : ""}> 읽기 포함</label>
      <button type="button" class="btn small" data-alrefresh="1">새로고침</button></div>
    ${AL.error ? `<div class="hint" style="color:var(--red)">불러오지 못했어: ${esc(AL.error)}</div>` : AL.list === null ? `<div class="hint">불러오는 중…</div>`
      : rows.length ? `<table class="altab"><thead><tr><th>시각</th><th>소스</th><th>동작</th><th>결과</th><th>내용</th></tr></thead><tbody>${rows.map((e) => {
        const o = OUTCOME_KO[outcomeOf(e)], d = new Date(e.ts);
        const what = e.ref?.title || e.ref?.key || (e.ref?.repo ? `${e.ref.repo}#${e.ref.number}` : "") || e.ref?.url || "";
        return `<tr title="${esc(e.result || "")}"><td>${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</td><td>${esc(SRC_KO[e.source] || e.source)}</td><td><code>${esc(e.action === "refused" ? `${e.mode} (refused)` : String(e.action).replace(/^dry_run:/, ""))}</code></td>
          <td><span class="chipx ${o[1]}">${esc(o[0])}</span></td><td class="alw">${esc(what)}${e.text ? ` <span class="hint">“${esc(e.text.slice(0, 60))}”</span>` : ""}</td></tr>`;
      }).join("")}</tbody></table>` : `<div class="hint">${all.length ? "필터에 맞는 액션 없음." : "오늘은 아직 한 액션 없음."}</div>`}`;
}
const ACTLOG_CSS = `.actlog { margin-top: 10px; padding: 10px; border: 1px solid var(--line, #8884); border-radius: 8px; }
.actlog .alh { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
.actlog .alh .sp { flex: 1; }
.actlog select { font: inherit; font-size: 12px; }
.actlog .altab { width: 100%; border-collapse: collapse; font-size: 12px; }
.actlog .altab th { text-align: left; color: var(--dim); font-weight: 500; padding: 3px 6px; border-bottom: 1px solid var(--line, #8884); }
.actlog .altab td { padding: 4px 6px; vertical-align: top; border-bottom: 1px solid color-mix(in srgb, var(--line, #8884) 50%, transparent); }
.actlog .altab code { font-size: 11px; }
.actlog .alw { overflow-wrap: anywhere; }`;

export function renderConfig() {
  const c = S.config; if (!c) return;
  renderNotifications(c.notifications);
  const acts = { ...ACTION_DEFAULTS, ...(c.actions || {}) };
  $("c-actions").innerHTML = Object.keys(ACTION_DEFAULTS).map((k) => `<label${ACTION_HINT[k] ? ` title="${esc(ACTION_HINT[k])}"` : ""}><input type="checkbox" data-act="${k}" ${acts[k] ? "checked" : ""}>${esc(ACTION_KO[k])}</label>`).join("");
  renderActionLog(); loadActionLog();
  $("c-tone").value = c.reply_tone || "";
  renderPersonaPicker(c.persona || "ned");
  renderCardLayout(c.dashboard ?? null);
  excl.slack = [...(c.filters?.slack?.exclude_channels || [])];
  excl.jira = [...(c.filters?.jira?.exclude_projects || [])];
  excl.watch = [...(c.filters?.slack?.watch_channels || [])];
  excl.ack = [...(c.filters?.slack?.ack_reactions || [])];
  $("x-msg").textContent = $("w-msg").textContent = $("a-msg").textContent = "";
  renderExcl();
  $("cfg-port").textContent = c.port ? `port ${c.port}` : "";
  $("c-hb").value = c.heartbeat_minutes ?? "";
  $("c-sig").value = c.signal_check_minutes ?? "";
  $("c-bt").value = c.briefing_time ?? "";
  $("c-qon").checked = !!c.quiet_hours;
  $("c-qs").value = c.quiet_hours?.start ?? "23:00";
  $("c-qe").value = c.quiet_hours?.end ?? "08:00";
  $("c-qs").disabled = $("c-qe").disabled = !c.quiet_hours;
  // Toggles come from config.sources keys, so new sources appear without touching this page.
  const keys = Object.keys(c.sources || {});
  $("c-sources").innerHTML = keys.length ? keys.map((k) => `<label><input type="checkbox" data-src="${esc(k)}" ${c.sources[k] ? "checked" : ""}>${esc(SOURCE_LABEL[k] || k)}</label>`).join("") : `<span class="hint">소스 없음</span>`;
  $("c-model").value = c.claude_model ?? "";
  $("c-turns").value = c.claude_max_turns ?? "";
  $("c-budget").value = c.agenda_daily_budget_usd ?? "";
  $("c-msg").textContent = ""; $("c-msg").className = "msg";
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  const st = document.createElement("style"); st.textContent = ACTLOG_CSS; document.head.appendChild(st);
  $("cfg").addEventListener("change", (e) => {
    const f = e.target.closest("[data-alf]"); if (!f) return;
    AL[f.dataset.alf] = f.type === "checkbox" ? f.checked : f.value; renderActionLog();
  });
  $("cfg").addEventListener("click", (e) => { if (e.target.closest("[data-alrefresh]")) { e.preventDefault(); loadActionLog(); } });
  for (const k of ["slack", "jira", "watch", "ack"]) {
    const input = $(`x-${k}-in`);
    input.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === ",") && !e.isComposing) { e.preventDefault(); if (input.value.trim()) { addExcl(k, input.value); input.value = ""; } }
      else if (e.key === "Backspace" && !input.value && excl[k].length) { excl[k].pop(); renderExcl(); }
    });
    // Picking a datalist option fires "input" with the full value; add it right away.
    input.addEventListener("input", (e) => { if (e.inputType === "insertReplacementText" || e.inputType == null) { const o = [...$(`dl-${k}`).options].some((x) => x.value === input.value); if (o) { addExcl(k, input.value); input.value = ""; } } });
  }
  $("cfg").addEventListener("focusin", (e) => { if (e.target.dataset?.x) renderExcl(); }); // refresh candidates as data arrives
  $("cfg").addEventListener("click", (e) => {
    const box = e.target.closest("[data-xbox]");
    if (box && !e.target.closest("button, input")) $(`x-${box.dataset.xbox}-in`).focus();
    const b = e.target.closest("[data-xdel]"); if (!b) return;
    e.preventDefault();
    const [k, i] = b.dataset.xdel.split(":");
    excl[k].splice(Number(i), 1); renderExcl(); $(`x-${k}-in`).focus();
  });
  $("n-on").addEventListener("change", syncNotifyEnabled);
  $("c-qon").addEventListener("change", (e) => { $("c-qs").disabled = $("c-qe").disabled = !e.target.checked; });
  $("cfg").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("c-msg"), btn = $("c-save");
    const sources = {};
    for (const cb of document.querySelectorAll("[data-src]")) sources[cb.dataset.src] = cb.checked;
    const body = {
      heartbeat_minutes: Number($("c-hb").value),
      signal_check_minutes: Number($("c-sig").value),
      briefing_time: $("c-bt").value,
      quiet_hours: $("c-qon").checked ? { start: $("c-qs").value || "23:00", end: $("c-qe").value || "08:00" } : null,
      sources,
      persona: document.querySelector("#c-persona input[name=persona]:checked")?.value || S.config?.persona || "ned",
      filters: { slack: { exclude_channels: [...excl.slack], watch_channels: [...excl.watch], ack_reactions: [...excl.ack] }, jira: { exclude_projects: [...excl.jira] } },
      dashboard: readCardLayout(),
      notifications: readNotifications(),
      actions: Object.fromEntries([...document.querySelectorAll("[data-act]")].map((c) => [c.dataset.act, c.checked])),
      reply_tone: $("c-tone").value.trim(),
      claude_model: $("c-model").value.trim() || null,
      claude_max_turns: Number($("c-turns").value),
      agenda_daily_budget_usd: Number($("c-budget").value),
    };
    btn.disabled = true; msg.className = "msg"; msg.textContent = "저장 중…";
    try {
      S.config = await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
      await applyPersona(S.config.persona); // look + voice switch now; prompts use it from the next run
      loadAgenda(); // sources switched off disappear from home now
      renderConfig(); msg.className = "msg ok"; msg.textContent = persona === "ned" ? "저장했어. 다음 순찰부터 적용." : persona === "alfred" ? "저장했습니다. 다음 순찰부터 적용됩니다." : persona === "oracle" ? "저장 완료. 다음 순찰부터 적용." : "저장했어요. 다음 순찰부터 반영됩니다.";
    } catch (err) {
      console.warn(err); msg.className = "msg err"; msg.textContent = `저장 실패: ${err.message}`;
    } finally { btn.disabled = false; }
  });
}
