/* Settings tab: one form, seven section cards (외형 · 소스 · 알림 · 순찰 주기 · 쓰기 액션 · 아카이브 · Claude), a jump nav and a sticky save bar.
 * Field ids and the PUT /api/config body are unchanged; only the layout moved (index.html #v-settings). */
import { api } from "../api.js";
import { BUILD, onBuildStale } from "../features/build.js";
import { diffConfig, isEmptyPatch, mergePatch } from "../features/config-diff.js";
import { readCardLayout, renderCardLayout } from "../features/cardlayout.js";
import { ACTION_DEFAULTS, ACTION_KO } from "../features/drafts.js";
import { originChip } from "../features/draftref.js";
import { parseQuickReplies, quickRepliesMsg, readToneBySource, syncWriteActionGroups, writeActionsHtml } from "./settings-actions.js";
import { initAppSettings, readUpdates, renderUpdates } from "./settings-app.js";
import { initArchive, readArchive, renderArchive } from "./settings-archive.js";
import { initHistorySettings, readHistorySettings, renderHistorySettings } from "./settings-history.js";
import { initLinkPrefs, linkPrefsError, readLinkPrefs, renderLinkPrefs } from "./settings-links.js";
import { initPet, readPet, renderPet, syncPet } from "./settings-pet.js";
import { initResponsibilities, readResponsibilities, renderResponsibilities, responsibilitiesMsg } from "./settings-responsibilities.js";
import { persona } from "../features/personas.js";
import { applyTheme, normTheme, syncTheme, themeHtml } from "../features/theme.js";
import { loadAgenda } from "../main.js";
import { readAutoSched, renderAutoSched } from "../features/autosched.js";
import { S } from "../state.js";
import { KIND_ICON, KIND_KO, SOURCE_LABEL } from "../ui/icons.js";
import { toast } from "../ui/toast.js";
import { $, esc } from "../util.js";

// ---------- settings ----------
// ---------- tracking exclusions (settings) ----------
export const excl = { slack: [], jira: [], watch: [], ack: [], group: [] }; // watch = 팔로업 채널 (filters.slack.watch_channels), ack = 답 필요 해제 이모지 (filters.slack.ack_reactions), group = 그룹 멘션 (filters.slack.group_mentions), same chip UI
const ACK_SUGGEST = ["white_check_mark", "eyes", "+1", "heavy_check_mark", "ok_hand", "raised_hands", "pray", "done"];
export const normX = {
  slack: (v) => v.trim().replace(/^#+/, "").replace(/\s+/g, ""),
  watch: (v) => v.trim().replace(/^#+/, "").replace(/\s+/g, ""),
  jira: (v) => v.trim().toUpperCase().replace(/-\d*$/, ""), // "MNT-123" → "MNT"
  ack: (v) => v.trim().replace(/^:+|:+$/g, "").toLowerCase(), // ":Eyes:" → "eyes"
  group: (v) => { const g = v.replace(/\s+/g, "").replace(/^@+/, ""); return /^s[a-z0-9]{6,}$/i.test(g) && /\d/.test(g) ? g.toUpperCase() : g.toLowerCase(); }, // "@Mobile-Dev" → "mobile-dev", "s0abc123" → "S0ABC123" (= config.normalizeGroupMentions)
};
export const validX = { slack: (v) => v.length > 0 && v.length <= 80, watch: (v) => v.length > 0 && v.length <= 80, jira: (v) => /^[A-Z][A-Z0-9_]{0,19}$/.test(v), ack: (v) => /^[\p{Ll}\p{Lo}\p{N}_+'.-]{1,64}$/u.test(v), group: (v) => /^[\p{L}\p{N}._-]{1,80}$/u.test(v) };
export const showX = { slack: (v) => `#${v}`, watch: (v) => `#${v}`, jira: (v) => v, ack: (v) => `:${v}:`, group: (v) => (/^S[A-Z0-9]{6,}$/.test(v) && /\d/.test(v) ? v : `@${v}`) };
export function renderExcl() {
  for (const k of ["slack", "jira", "watch", "ack", "group"]) {
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
const X_MSG = { slack: "x-msg", jira: "j-msg", watch: "w-msg", ack: "a-msg", group: "g-msg" }; // one status line per chip box
export function addExcl(k, raw) {
  let added = 0, bad = [];
  for (const part of String(raw).split(/[,\s]+/)) {
    if (!part.trim()) continue;
    const v = normX[k](part);
    if (!validX[k](v)) { bad.push(part.trim()); continue; }
    if ((k === "ack" || k === "group") && excl[k].length >= 8 && !excl[k].includes(v)) { bad.push(`${part.trim()} (최대 8개)`); continue; }
    if (!excl[k].includes(v)) { excl[k].push(v); added++; }
  }
  $(X_MSG[k]).textContent = bad.length ? `${k === "jira" ? "프로젝트 키는 영문 대문자로 시작하는 영숫자만 돼" : k === "ack" ? "이모지 이름에 공백·기호는 안 돼 (영문·한글·숫자·_+-.' 만)" : k === "group" ? "그룹 ID(S…)나 핸들(@이름)만 돼 (영문·한글·숫자·._- 만)" : "채널 이름이 비었거나 너무 길어"}: ${bad.join(", ")}` : added ? "추가했어. 저장을 눌러야 적용돼." : "";
  renderExcl();
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
/** 알림 off → everything else in the section dims (values kept); quiet start/end also follow 조용한 시간 '사용'. */
export function syncNotifyEnabled() {
  const on = $("n-on").checked, box = $("n-on").closest(".ntf");
  box.classList.toggle("off", !on);
  for (const el of box.querySelectorAll("input")) if (el.id !== "n-on") el.disabled = !on;
  $("c-qs").disabled = $("c-qe").disabled = !on || !$("c-qon").checked;
}

// ---------- 소스: per-source sub groups (Slack / Jira) dim while that source is off; their values still save ----------
export function syncSourceGroups() {
  for (const g of document.querySelectorAll("[data-srcgrp]")) {
    const cb = srcToggle(g.dataset.srcgrp);
    const off = !!cb && !cb.checked;
    g.classList.toggle("off", off);
    g.setAttribute("aria-disabled", String(off));
    g.querySelector(".offnote").hidden = !off;
    g.querySelector(".sgb").toggleAttribute("inert", off);
  }
  // 소스별 자동 갱신 칸: dim + disable while that source is off (value kept and still saved).
  for (const f of document.querySelectorAll("[data-intsrc]")) {
    const cb = srcToggle(f.dataset.intsrc);
    const off = !!cb && !cb.checked;
    f.classList.toggle("off", off);
    f.querySelector("input").disabled = off;
    f.title = off ? "소스가 꺼져 있어 — 값은 그대로 보존돼" : "";
  }
}

// ---------- 소스별 자동 갱신 주기: config.agenda_source_minutes { slack, mail, calendar, jira, github } (null/blank → agenda_refresh_minutes) ----------
export const INT_KEYS = ["slack", "mail", "calendar", "jira", "github"];
const posInt = (v) => { const n = Math.trunc(Number(v)); return String(v).trim() !== "" && Number.isFinite(n) && n >= 1 ? n : null; };
export function renderIntervals(c) {
  const base = c.agenda_refresh_minutes;
  $("c-agmin").value = base ?? "";
  const per = c.agenda_source_minutes && typeof c.agenda_source_minutes === "object" ? c.agenda_source_minutes : {}; // older daemon: no key → all blank
  for (const k of INT_KEYS) { const el = $(`c-int-${k}`); el.value = posInt(per[k] ?? "") ?? ""; }
  syncIntervalPlaceholders();
}
/** placeholder "기본 N분" follows the base field as it is typed. */
export function syncIntervalPlaceholders() {
  const n = posInt($("c-agmin").value);
  for (const k of INT_KEYS) $(`c-int-${k}`).placeholder = n ? `기본 ${n}분` : "기본값";
}
export const readIntervals = () => Object.fromEntries(INT_KEYS.map((k) => [k, posInt($(`c-int-${k}`).value)]));
export const readNotifications = () => ({
  enabled: $("n-on").checked,
  kinds: Object.fromEntries([...document.querySelectorAll("[data-nk]")].map((c) => [c.dataset.nk, c.checked])),
  briefing: $("n-brief").checked,
  summary_threshold: Math.max(0, Math.min(50, Math.trunc(Number($("n-th").value) || 0))),
  quiet_delivery: document.querySelector("input[name=n-quiet]:checked")?.value || "skip",
  sound: $("n-sound").checked,
});

// ---------- 쓰기 액션: hints + '오늘 한 액션' (GET /api/actions, filtered here) ----------
// 소스별 그룹 + 소스별 답장 말투: settings-actions.js (#wa-groups).
export function renderWriteActions(c) {
  $("wa-groups").innerHTML = writeActionsHtml(c, ACTION_DEFAULTS, ACTION_KO); // dims from c.sources; re-synced once 소스 toggles render
}
export const syncWriteActions = () => syncWriteActionGroups($("wa-groups"), (k) => srcToggle(k)?.checked !== false);

/** The 소스 checkbox for `key` — scoped to #c-sources: the home tab's 팔로업 cards also carry `data-src="slack"`
 *  (status spans), and an unscoped querySelector picked one of those first → "Slack 소스가 꺼져 있어" while it was on. */
const srcToggle = (key) => document.querySelector(`#c-sources input[data-src="${key}"]`);
const SRC_KO = { slack: "Slack", email: "메일", session: "세션", jira: "Jira", github: "GitHub", calendar: "캘린더", todo: "할 일" };
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
    $("wa-groups").insertAdjacentHTML("afterend", `<div class="actlog" id="c-actlog" role="region" aria-label="오늘 한 액션"></div>`);
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
        return `<tr title="${esc(e.result || "")}"><td>${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</td><td>${esc(SRC_KO[e.source] || e.source)}${originChip(e.origin)}</td><td><code>${esc(e.action === "refused" ? `${e.mode} (refused)` : String(e.action).replace(/^dry_run:/, ""))}</code></td>
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

/** Fill the form from `c` (default S.config) and take it as the saved baseline. `preview`: the theme is applied, not cached. */
export function renderConfig(c = S.config, { preview = false } = {}) {
  if (!c) return;
  renderNotifications(c.notifications);
  renderWriteActions(c);
  renderActionLog(); loadActionLog();
  $("c-tone").value = c.reply_tone || "";
  $("c-quick-replies").value = (Array.isArray(c.dashboard?.session_quick_replies) ? c.dashboard.session_quick_replies : ["ㄱㄱ", "승인", "계속"]).join(", ");
  syncQuickReplies();
  if (preview) applyTheme(normTheme(c.dashboard?.theme)); else syncTheme(c.dashboard); // server value wins over the <head> cache (and drops an unsaved preview)
  $("c-theme").innerHTML = themeHtml(c.dashboard?.theme);
  renderCardLayout(c.dashboard ?? null);
  renderLinkPrefs(c.dashboard); // 링크 열기 (앱 딥링크) · Slack 팀 ID
  renderPet(c); // 데스크톱 펫
  excl.slack = [...(c.filters?.slack?.exclude_channels || [])];
  excl.jira = [...(c.filters?.jira?.exclude_projects || [])];
  excl.watch = [...(c.filters?.slack?.watch_channels || [])];
  excl.ack = [...(c.filters?.slack?.ack_reactions || [])];
  excl.group = [...(c.filters?.slack?.group_mentions || [])];
  $("c-ackmax").value = c.filters?.slack?.ack_check_max ?? 3;
  for (const id of Object.values(X_MSG)) $(id).textContent = "";
  renderExcl();
  $("cfg-port").textContent = c.port ? `port ${c.port}` : "";
  $("c-hb").value = c.heartbeat_minutes ?? "";
  $("c-sig").value = c.signal_check_minutes ?? "";
  $("c-hbskip").checked = c.heartbeat_skip_unchanged !== false;
  $("c-bt").value = c.briefing_time ?? "";
  renderIntervals(c);
  renderAutoSched(c); // 조용한 시간 동작 / 유휴 시 동작
  $("c-qon").checked = !!c.quiet_hours;
  $("c-qs").value = c.quiet_hours?.start ?? "23:00";
  $("c-qe").value = c.quiet_hours?.end ?? "08:00";
  syncNotifyEnabled(); // quiet start/end: off unless 알림 on and 조용한 시간 사용
  // Toggles come from config.sources keys, so new sources appear without touching this page.
  const keys = Object.keys(c.sources || {});
  $("c-sources").innerHTML = keys.length ? keys.map((k) => `<label><input type="checkbox" data-src="${esc(k)}" ${c.sources[k] ? "checked" : ""}>${esc(SOURCE_LABEL[k] || k)}</label>`).join("") : `<span class="hint">소스 없음</span>`;
  syncSourceGroups(); syncWriteActions(); syncPet();
  renderResponsibilities(c); // 맡긴 일
  $("c-model").value = c.claude_model ?? "";
  $("c-turns").value = c.claude_max_turns ?? "";
  $("c-budget").value = c.agenda_daily_budget_usd ?? "";
  renderArchive(c); // 아카이브 (Obsidian)
  renderHistorySettings(c); // 수집·보관
  renderUpdates(c); // 앱 → 업데이트 (config.updates — saved with 저장, unlike the rest of 앱)
  $("c-msg").textContent = ""; $("c-msg").className = "msg";
  savedBody = readBody(); saved = snap(); syncDirty();
  syncSaveLock();
  syncNav();
}

/**
 * 409 from PUT /api/config: someone else saved since this form was rendered. Re-render from `current` (the new baseline),
 * then lay the user's own edits (`patch`, what they had changed) back on top — those fields stay dirty, nothing else does.
 */
export function applyConflict(current, patch) {
  S.config = current;
  renderConfig(current);
  const base = [savedBody, saved];
  renderConfig(mergePatch(current, patch), { preview: true });
  [savedBody, saved] = base;
  syncDirty();
}

/** 외형 → 테마 radio (none rendered yet → "system"). */
export const readTheme = () => normTheme(document.querySelector("input[name=c-theme]:checked")?.value);

/** The PUT /api/config body, read from every section of the form. */
export function readBody() {
  const sources = {};
  for (const cb of document.querySelectorAll("[data-src]")) sources[cb.dataset.src] = cb.checked;
  return {
    heartbeat_minutes: Number($("c-hb").value),
    signal_check_minutes: Number($("c-sig").value),
    heartbeat_skip_unchanged: $("c-hbskip").checked,
    briefing_time: $("c-bt").value,
    agenda_refresh_minutes: Number($("c-agmin").value),
    agenda_source_minutes: readIntervals(),
    ...readAutoSched(), // quiet_schedule, idle_schedule
    quiet_hours: $("c-qon").checked ? { start: $("c-qs").value || "23:00", end: $("c-qe").value || "08:00" } : null,
    sources,
    filters: { slack: { exclude_channels: [...excl.slack], watch_channels: [...excl.watch], ack_reactions: [...excl.ack], ack_check_max: $("c-ackmax").value === "" ? null : Number($("c-ackmax").value), group_mentions: [...excl.group] }, jira: { exclude_projects: [...excl.jira] } },
    dashboard: { ...readCardLayout(), theme: readTheme(), ...readLinkPrefs(), session_quick_replies: parseQuickReplies($("c-quick-replies").value) },
    notifications: readNotifications(),
    actions: Object.fromEntries([...document.querySelectorAll("[data-act]")].map((c) => [c.dataset.act, c.checked])),
    reply_tone: $("c-tone").value.trim(),
    reply_tone_by_source: readToneBySource($("wa-groups")),
    claude_model: $("c-model").value.trim() || null,
    claude_max_turns: Number($("c-turns").value),
    agenda_daily_budget_usd: Number($("c-budget").value),
    archive: readArchive(),
    ...(readUpdates() ? { updates: readUpdates() } : {}), // 앱 → 업데이트
    history: readHistorySettings(),
    pet: readPet(),
    ...(readResponsibilities() ? { responsibilities: readResponsibilities() } : {}), // 맡긴 일
  };
}

// ---------- 저장 안 된 변경: body as rendered vs. now ----------
// dashboard is left out of the snapshot: lock / 팔로업 카드 save on their own, and order/width edits show up as
// readCardLayout().layout (cardlayout.js re-derives the grid only when they were touched here).
// theme and the 링크 열기 keys are part of dashboard but only save with the form, so they stay in the snapshot.
let saved = "";
let savedBody = null; // readBody() right after the last render: the PUT sends only diffConfig(savedBody, readBody())
const snap = () => {
  const { dashboard: d, ...rest } = readBody();
  return JSON.stringify({ ...rest, theme: d.theme, open_links_in_app: d.open_links_in_app, open_links_in_app_by_service: d.open_links_in_app_by_service, slack_team_id: d.slack_team_id, slack_team_domain: d.slack_team_domain, session_quick_replies: d.session_quick_replies });
};
/** 세션 빠른 답: 형식 안내 줄 (저장 때도 같은 검사로 막는다). */
function syncQuickReplies() {
  const err = quickRepliesMsg(parseQuickReplies($("c-quick-replies").value));
  $("c-quick-replies-msg").textContent = err || "";
  $("c-quick-replies-msg").style.color = err ? "var(--red)" : "";
  return err;
}
export const isDirty = () => !!S.config && (snap() !== saved || !!readCardLayout().layout);
export function syncDirty() {
  const d = isDirty();
  $("c-dirty").hidden = !d;
  $("cfg").classList.toggle("dirty", d);
}

// ---------- section jump nav: click scrolls (hash stays #settings — it routes views), scroll marks the current one ----------
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
export function syncNav() {
  const page = $("v-settings"), links = [...document.querySelectorAll("[data-sjump]")];
  if (page.hidden || !links.length) return;
  const top = page.getBoundingClientRect().top + 120;
  let cur = links[0].dataset.sjump;
  for (const a of links) if ($(a.dataset.sjump).getBoundingClientRect().top <= top) cur = a.dataset.sjump;
  if (page.scrollTop + page.clientHeight >= page.scrollHeight - 4) cur = links[links.length - 1].dataset.sjump; // bottom: last section
  for (const a of links) if (a.dataset.sjump === cur) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
}
function initNav() {
  $("s-nav").addEventListener("click", (e) => {
    const a = e.target.closest("[data-sjump]"); if (!a) return;
    e.preventDefault();
    const sec = $(a.dataset.sjump);
    sec.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
    sec.querySelector("h2")?.focus({ preventScroll: true });
    for (const x of document.querySelectorAll("[data-sjump]")) if (x === a) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current");
  });
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; syncNav(); }); };
  $("v-settings").addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("hashchange", schedule); // entering the tab: mark the section in view
}

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  const st = document.createElement("style"); st.textContent = ACTLOG_CSS; document.head.appendChild(st);
  $("cfg").addEventListener("change", (e) => {
    const f = e.target.closest("[data-alf]"); if (!f) return;
    AL[f.dataset.alf] = f.type === "checkbox" ? f.checked : f.value; renderActionLog();
  });
  $("cfg").addEventListener("click", (e) => { if (e.target.closest("[data-alrefresh]")) { e.preventDefault(); loadActionLog(); } });
  for (const k of ["slack", "jira", "watch", "ack", "group"]) {
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
  $("c-theme").addEventListener("change", (e) => { if (e.target.name === "c-theme") applyTheme(e.target.value); }); // preview only; 저장 makes it stick
  $("n-on").addEventListener("change", syncNotifyEnabled);
  $("c-qon").addEventListener("change", syncNotifyEnabled);
  $("c-agmin").addEventListener("input", syncIntervalPlaceholders);
  $("c-sources").addEventListener("change", (e) => { if (e.target.dataset?.src) syncSourceGroups(); });
  $("c-sources").addEventListener("change", (e) => { if (e.target.dataset?.src) syncWriteActions(); });
  // Any edit anywhere (typing, toggles, chip add/remove, ↑/↓ in 홈 카드 배치) → re-check the dirty mark after handlers ran.
  const later = () => queueMicrotask(syncDirty);
  for (const ev of ["input", "change", "click", "keydown"]) $("cfg").addEventListener(ev, later);
  initNav();
  $("cfg").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("c-msg"), btn = $("c-save");
    if (BUILD.stale) { syncSaveLock(); return; }
    const patch = diffConfig(savedBody, readBody());
    if (isEmptyPatch(patch)) { msg.className = "msg"; msg.textContent = "바뀐 항목이 없어."; return; }
    const linkErr = linkPrefsError(patch.dashboard);
    if (linkErr) { msg.className = "msg err"; msg.textContent = `저장 안 함: ${linkErr.msg}`; $(linkErr.id).focus(); return; }
    const quickErr = patch.dashboard?.session_quick_replies ? quickRepliesMsg(patch.dashboard.session_quick_replies) : null;
    if (quickErr) { msg.className = "msg err"; msg.textContent = `저장 안 함: ${quickErr}`; $("c-quick-replies").focus(); return; }
    const respErr = responsibilitiesMsg(patch.responsibilities);
    if (respErr) { msg.className = "msg err"; msg.textContent = `저장 안 함: ${respErr}`; $("c-resp")?.querySelector('[data-rf="title"]:placeholder-shown')?.focus(); return; }
    btn.disabled = true; msg.className = "msg"; msg.textContent = "저장 중…";
    try {
      // Only the changed keys (sub-key level), plus the version this form was rendered from: a save made elsewhere since → 409.
      const body = S.config?.updated_at != null ? { ...patch, if_updated_at: S.config.updated_at } : patch;
      S.config = await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
      loadAgenda(); // sources switched off disappear from home now
      renderConfig(); msg.className = "msg ok"; msg.textContent = persona === "ned" ? "저장했어. 다음 순찰부터 적용." : persona === "alfred" ? "저장했습니다. 다음 순찰부터 적용됩니다." : persona === "oracle" ? "저장 완료. 다음 순찰부터 적용." : "저장했어요. 다음 순찰부터 반영됩니다.";
      if (RB.open) loadBackups();
    } catch (err) {
      if (err.status === 409 && err.data?.current) {
        applyConflict(err.data.current, patch);
        msg.className = "msg err"; msg.textContent = "다른 곳에서 설정이 바뀌어 최신 값을 불러왔어 — 수정한 항목은 유지됨, 다시 저장해 줘.";
        toast("다른 곳에서 설정이 바뀌어 최신 값을 불러왔어 — 수정한 항목은 유지됨, 다시 저장", 6000);
      } else {
        console.warn(err); msg.className = "msg err"; msg.textContent = `저장 실패: ${err.data?.error || err.message}`;
      }
    } finally { btn.disabled = false; syncSaveLock(); }
  });
  onBuildStale(syncSaveLock);
  initRestore();
  initArchive();
  initAppSettings(); // 앱 (Ned.app): its own section + nav link, applied at once through the app bridge (not the form)
  initHistorySettings();
  initLinkPrefs();
  $("c-quick-replies").addEventListener("input", syncQuickReplies);
  initPet();
  initResponsibilities(); // 맡긴 일: its own section after 소스 + nav link
}

// ---------- 새 버전 감지: daemon build changed since page load → 저장 잠금 (build.js shows the reload banner) ----------
export function syncSaveLock() {
  const btn = $("c-save"); if (!btn) return;
  if (!BUILD.stale) { if (btn.dataset.lock) { btn.disabled = false; delete btn.dataset.lock; btn.title = ""; } return; }
  btn.disabled = true; btn.dataset.lock = "build"; btn.title = "새 버전이 실행 중 — 새로고침한 뒤 저장";
  const msg = $("c-msg");
  msg.className = "msg err"; msg.textContent = "새 버전의 Ned 가 실행 중이라 저장을 막았어 — 새로고침한 뒤 다시 저장해 줘.";
}

// ---------- 이전 설정으로 되돌리기: GET /api/config/backups, POST /api/config/restore { name } ----------
export const RB = { open: false, list: null, error: "", pick: "", confirm: false, busy: false };
const fmtBackup = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
export async function loadBackups() {
  try { RB.list = await api("/api/config/backups"); RB.error = ""; } catch (e) { RB.error = e.message; }
  if (RB.pick && !(RB.list || []).some((b) => b.name === RB.pick)) { RB.pick = ""; RB.confirm = false; }
  renderRestore();
}
export function renderRestore() {
  const box = $("c-restore"); if (!box) return;
  const list = RB.list || [];
  const picked = list.find((b) => b.name === RB.pick);
  box.querySelector(".rbbody").innerHTML = RB.error ? `<div class="hint" style="color:var(--red)">불러오지 못했어: ${esc(RB.error)}</div>`
    : RB.list === null ? `<div class="hint">불러오는 중…</div>`
    : !list.length ? `<div class="hint">아직 백업이 없어. 설정을 저장할 때마다 직전 설정이 ~/.ned/config-backups 에 남아 (최근 10개).</div>`
    : `<div class="rbrow"><select id="c-rb-pick" aria-label="되돌릴 시점"><option value="">시점 선택…</option>${list.map((b) => `<option value="${esc(b.name)}" ${b.name === RB.pick ? "selected" : ""}>${esc(fmtBackup(b.at))} 저장 전</option>`).join("")}</select>
        <button type="button" class="btn small" id="c-rb-go" ${picked && !RB.busy ? "" : "disabled"}>되돌리기…</button></div>
      ${RB.confirm && picked ? `<div class="rbconfirm" role="alert"><span>${esc(fmtBackup(picked.at))} 의 설정으로 되돌릴까? 지금 설정은 백업되고${isDirty() ? ", 저장 안 된 변경은 사라져" : ""}.</span>
        <button type="button" class="btn small go" id="c-rb-yes" ${RB.busy ? "disabled" : ""}>되돌리기 확인</button><button type="button" class="btn small" id="c-rb-no">취소</button></div>` : ""}`;
}
async function doRestore() {
  if (!RB.pick || RB.busy) return;
  RB.busy = true; renderRestore();
  try {
    S.config = await api("/api/config/restore", { method: "POST", body: JSON.stringify({ name: RB.pick }) });
    RB.confirm = false; RB.pick = "";
    loadAgenda();
    renderConfig();
    toast("이전 설정으로 되돌렸어.");
  } catch (e) {
    toast(`되돌리기 실패: ${e.message}`);
  } finally { RB.busy = false; loadBackups(); }
}
function initRestore() {
  if ($("c-restore")) return;
  $("cfg").insertAdjacentHTML("afterend", `<details class="card ssec rbsec" id="c-restore"><summary><b>이전 설정으로 되돌리기</b> <span class="hint">저장할 때마다 직전 설정을 최근 10개까지 보관해</span></summary><div class="rbbody"></div></details>`);
  const st = document.createElement("style");
  st.textContent = `.rbsec { margin-top: 12px; padding: 10px 14px; } .rbsec summary { cursor: pointer; } .rbsec .rbbody { margin-top: 8px; }
.rbsec .rbrow, .rbsec .rbconfirm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; } .rbsec .rbconfirm { margin-top: 8px; } .rbsec select { font: inherit; font-size: 12px; }`;
  document.head.appendChild(st);
  const box = $("c-restore");
  box.addEventListener("toggle", () => { RB.open = box.open; if (box.open) loadBackups(); });
  box.addEventListener("change", (e) => { if (e.target.id === "c-rb-pick") { RB.pick = e.target.value; RB.confirm = false; renderRestore(); } });
  box.addEventListener("click", (e) => {
    const id = e.target.closest("button")?.id;
    if (id === "c-rb-go") { RB.confirm = true; renderRestore(); }
    else if (id === "c-rb-no") { RB.confirm = false; renderRestore(); }
    else if (id === "c-rb-yes") doRestore();
  });
}
