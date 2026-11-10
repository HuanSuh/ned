/* 설정 → 앱 (Ned.app): the menu bar app's own settings, moved out of its dropdown. They live in the app (UserDefaults /
 * SMAppService / NSOpenPanel), not config.yaml, so they apply at once — independent of the form's 저장.
 * Bridge: webkit.messageHandlers.appSettings (DashboardWindow.swift AppSettingsHandler, postMessage → Promise):
 *   {op: "get"} · {op: "set", key, value} (key ∈ APP_KEYS) · {op: "action", name} (name ∈ APP_ACTIONS)
 *   → {loginItem: {status, enabled, message?}, openAtLaunch, openAtLoginLaunch, repoPath, logPath, cancelled?}
 * A plain browser has no bridge: one hint line instead.
 * "업데이트" sub-group (#app-upd) is the daemon's and works in both: config.updates.* (auto_check · check_hours · auto_install)
 * save with the form's 저장 (readUpdates / renderUpdates, called from settings.js), 지금 확인 = GET /api/update-check?refresh=1,
 * 지금 업데이트 = POST /api/update/install (inline confirm step), status = GET /api/update/status.
 * The section and its nav link are added here (index.html is untouched). */
import { api } from "../api.js";
import { copyText } from "../features/code-copy.js";
import { $, esc } from "../util.js";

export const APP_KEYS = ["loginItem", "openAtLaunch", "openAtLoginLaunch"];
export const APP_ACTIONS = ["chooseRepo", "revealLog", "restartDaemon"];
export const AP = { data: null, error: "", busy: "", upd: null, updBusy: false, updError: "", copied: false, status: null, confirm: false, installBusy: false, installMsg: "" };

export const appBridge = (win = window) => win.webkit?.messageHandlers?.appSettings || null;

const LOGIN_LABEL = { enabled: "켜짐", requiresApproval: "꺼짐 (승인 필요)", notRegistered: "꺼짐", notFound: "꺼짐" };
const chip = (cls, label) => `<span class="stk flat ${cls}">${esc(label)}</span>`;

const when = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** (pure) The 업데이트 status line: 지금 확인 + result, 지금 업데이트 (+ inline confirm), last attempt, next automatic check. */
export function updateHtml(ap) {
  const btn = `<button type="button" class="btn small" data-appupd="1" ${ap.updBusy ? "disabled" : ""}>${ap.updBusy ? '<span class="spin"></span>확인 중…' : "지금 확인"}</button>`;
  const u = ap.upd;
  const st = ap.status;
  const known = u?.update_available ? { current: u.current, latest: u.latest } : st?.update_available || null;
  let res = "";
  if (ap.updError) res = `<span class="err">확인 실패: ${esc(ap.updError)}</span>`;
  else if (u && !u.latest) res = `<span class="err">확인 실패${u.error ? ` (${esc(u.error)})` : ""}</span>`;
  else if (known) {
    const steps = (u?.steps || ["/plugin update ned", "/reload-plugins", "/ned:install"]).map((x) => `<code>${esc(x)}</code>`).join(" → ");
    res = `<span><b>${esc(known.current || "?")} → ${esc(known.latest)} 업데이트 있음</b> — Claude Code 에서 ${steps}</span>`
      + `<button type="button" class="btn small" data-appcopy="1">${ap.copied ? "복사했어" : "명령 복사"}</button>`;
  } else if (u) res = `<span class="hint" title="${esc(u.note || u.error || "")}">최신 버전 (${esc(u.current || u.latest)})${u.source === "marketplace" ? " · 마켓플레이스 기준" : ""}${u.error ? ` · ${esc(u.error)}` : ""}</span>`;
  let install = "";
  if (known && !st?.running) {
    install = ap.confirm
      ? `<span class="appconfirm">Ned 를 ${esc(known.latest)} 로 업데이트할까? 앱이 잠시 종료됐다가 다시 열려.</span><button type="button" class="btn small go" data-appinstall="go" ${ap.installBusy ? "disabled" : ""}>업데이트 확인</button><button type="button" class="btn small" data-appinstall="cancel">취소</button>`
      : `<button type="button" class="btn small" data-appinstall="ask">지금 업데이트</button>`;
  }
  const lines = [`<div class="inl appupd" aria-live="polite">${btn}${res}${install}</div>`];
  if (ap.installMsg) lines.push(`<span class="hint" role="status">${esc(ap.installMsg)}</span>`);
  if (st?.running) lines.push(`<span class="hint">업데이트 중… (로그 <code>${esc(st.attempt?.log || "~/.ned/logs/self-update.log")}</code>)</span>`);
  else if (st?.attempt?.result === "fail") lines.push(`<span class="err" title="${esc(st.attempt.log || "")}">마지막 자동 설치 실패 (${esc(when(st.attempt.at))}${st.attempt.to ? ` → ${esc(st.attempt.to)}` : ""}): ${esc(st.attempt.fail_line || "")} — 기존 설치 유지</span>`);
  else if (st?.attempt?.result === "ok") lines.push(`<span class="hint">마지막 업데이트: ${esc(when(st.attempt.at))} ${esc(st.attempt.from || "?")} → ${esc(st.attempt.to || "?")}</span>`);
  if (st) lines.push(`<span class="hint">${st.auto?.auto_check ? `마지막 확인 ${st.last_check_at ? esc(when(st.last_check_at)) : "아직"} · 다음 확인 ${st.next_check_at ? esc(when(st.next_check_at)) : "곧"}` : "자동 확인 꺼짐"}</span>`);
  return lines.join("");
}

/** (pure) The 업데이트 sub-group's fixed part (config.updates inputs — saved with 저장, so never re-rendered by the bridge). */
export const UPDATES_HTML = `<div class="ntf appupdgrp" id="app-upd" role="group" aria-labelledby="app-upd-h">
  <h3 id="app-upd-h">업데이트</h3>
  <p class="hint">아래 세 항목은 하단 <b>"저장"</b>으로 저장돼 (config.yaml <code>updates.*</code>) — 위 앱 항목과 달리 즉시 적용 아님.</p>
  <div class="nrow"><span class="lab">자동 확인</span><div class="inl"><label class="ck"><input type="checkbox" id="c-upd-check"> 새 버전 자동 확인</label>
    <label class="ck">매 <input type="number" id="c-upd-hours" min="1" max="720" step="1" style="width:64px" aria-label="확인 주기(시간)"> 시간마다</label></div></div>
  <div class="nrow"><span class="lab">자동 설치</span><div class="inl"><label class="ck"><input type="checkbox" id="c-upd-install"> 새 버전을 자동으로 설치</label>
    <span class="hint">조용한 시간이나 유휴일 때, 실행 중·입력 대기 세션이 없을 때만. 실패하면 24시간 뒤 다시.</span></div></div>
  <div class="nrow"><span class="lab">상태</span><div class="archst" id="app-upd-st"></div></div>
</div>`;

export function renderUpdates(c) {
  const u = c?.updates || {};
  if (!$("c-upd-check")) return;
  $("c-upd-check").checked = u.auto_check !== false;
  $("c-upd-hours").value = u.check_hours ?? 24;
  $("c-upd-install").checked = u.auto_install === true;
  $("c-upd-hours").disabled = !$("c-upd-check").checked;
}
/** PUT /api/config { updates } part (settings.js readBody). Absent sub-group (old page) → undefined = untouched. */
export function readUpdates() {
  if (!$("c-upd-check")) return undefined;
  const h = Math.trunc(Number($("c-upd-hours").value));
  return { auto_check: $("c-upd-check").checked, check_hours: Number.isFinite(h) && h >= 1 ? Math.min(720, h) : 24, auto_install: $("c-upd-install").checked };
}
export function renderUpdateStatus() {
  const box = $("app-upd-st");
  if (box) box.innerHTML = updateHtml(AP);
}
export async function loadUpdateStatus() {
  try { AP.status = await api("/api/update/status"); } catch { AP.status = null; }
  renderUpdateStatus();
}

/** (pure) The section body for AP + whether the Ned.app bridge exists. */
export function appSettingsHtml(ap, { inApp }) {
  const head = `<p class="hint appnote">여기 앱 항목은 바꾸는 즉시 적용돼 — 아래 "저장"과 상관없어 (Ned.app 의 설정).</p>`;
  if (!inApp) return head + `<p class="hint" data-appnobridge="1">Ned.app 창에서 열면 바꿀 수 있어요.</p>`;
  const d = ap.data;
  const err = ap.error ? `<p class="err" role="alert">${esc(ap.error)}</p>` : "";
  if (!d) return head + err + (ap.error ? "" : `<p class="hint"><span class="spin"></span>불러오는 중…</p>`);
  const li = d.loginItem || {};
  const busy = !!ap.busy;
  const dis = busy ? "disabled" : "";
  const st = li.status;
  const rows = [
    `<div class="nrow"><span class="lab">자동 실행</span><div class="inl"><label class="ck"><input type="checkbox" data-appkey="loginItem" ${li.enabled ? "checked" : ""} ${dis}> 로그인할 때 Ned 실행 (Login Items)</label>${st ? chip(st === "enabled" ? "g" : "a", `자동 시작: ${LOGIN_LABEL[st] || st}`) : ""}</div></div>`,
    li.message ? `<div class="nrow"><span class="lab"></span><span class="hint">${esc(li.message)}</span></div>` : "",
    `<div class="nrow"><span class="lab">대시보드</span><div class="inl"><label class="ck"><input type="checkbox" data-appkey="openAtLaunch" ${d.openAtLaunch ? "checked" : ""} ${dis}> 실행 시 대시보드 열기</label>`
      + `<label class="ck"><input type="checkbox" data-appkey="openAtLoginLaunch" ${d.openAtLoginLaunch ? "checked" : ""} ${busy || !d.openAtLaunch ? "disabled" : ""}> 자동 시작 시에도 열기</label></div></div>`,
    `<div class="nrow"><span class="lab"></span><span class="hint">자동 시작(로그인 직후)엔 기본으로 메뉴 막대만 — 켜면 그때도 대시보드를 열어.</span></div>`,
    `<div class="nrow"><span class="lab">저장소 위치</span><div class="inl"><code class="apppath" title="${esc(d.repoPath || "")}">${esc(d.repoPath || "미지정")}</code><button type="button" class="btn small" data-appact="chooseRepo" ${dis}>변경…</button></div></div>`,
    `<div class="nrow"><span class="lab">로그</span><div class="inl"><code class="apppath" title="${esc(d.logPath || "")}">${esc(d.logPath || "")}</code><button type="button" class="btn small" data-appact="revealLog" ${dis}>Finder 에서 보기</button></div></div>`,
    `<div class="nrow"><span class="lab">데몬</span><div class="inl"><button type="button" class="btn small" data-appact="restartDaemon" ${dis}>${ap.busy === "restartDaemon" ? "다시 시작하는 중…" : "데몬 다시 시작"}</button><span class="hint">대시보드가 잠깐 끊겼다가 다시 붙어.</span></div></div>`,
  ];
  return head + err + rows.join("");
}

export function renderAppSettings() {
  const box = $("app-body");
  if (box) box.innerHTML = appSettingsHtml(AP, { inApp: !!appBridge() });
}

/** One bridge round trip; the reply (current values) replaces AP.data. A rejected reply → AP.error. */
export async function appCall(msg) {
  const h = appBridge();
  if (!h) return;
  AP.busy = msg.op === "get" ? "" : msg.name || msg.key;
  if (msg.op !== "get") renderAppSettings();
  try {
    const r = await h.postMessage(msg);
    if (r && typeof r === "object") AP.data = r;
    AP.error = "";
  } catch (e) {
    AP.error = `${msg.op === "get" ? "불러오기" : "적용"} 실패: ${e?.message || e}`;
  } finally {
    AP.busy = "";
    renderAppSettings();
  }
}
export const loadAppSettings = () => appCall({ op: "get" });

export async function checkUpdate() {
  AP.updBusy = true; AP.updError = ""; AP.copied = false; AP.installMsg = ""; renderUpdateStatus();
  try { AP.upd = await api("/api/update-check?refresh=1"); if (AP.upd?.status) AP.status = { ...AP.upd.status, update_available: AP.upd.update_available ? { current: AP.upd.current, latest: AP.upd.latest } : null }; }
  catch (e) { AP.updError = e.status === 404 ? "이 데몬은 업데이트 확인을 몰라 (업데이트 필요)" : e.message; }
  finally { AP.updBusy = false; renderUpdateStatus(); }
}

/** 지금 업데이트 → (inline confirm) → POST /api/update/install. 202 = started (the app quits and comes back), 409 = why not. */
export async function installUpdate() {
  AP.installBusy = true; renderUpdateStatus();
  try {
    const r = await api("/api/update/install", { method: "POST" });
    AP.installMsg = `업데이트 시작 (${r.reason}) — Ned 가 잠시 종료됐다가 다시 열려. 끝나면 알림으로 알려 줄게.`;
    AP.status = r.status || AP.status;
  } catch (e) {
    AP.installMsg = `시작 안 함: ${e.data?.reason || e.message}`;
    if (e.data?.status) AP.status = e.data.status;
  } finally { AP.installBusy = false; AP.confirm = false; renderUpdateStatus(); }
}

/** Ned.app's 설정… (menu) runs `nedOpenSettings("s-app")` in the dashboard window: settings tab, scrolled to the section. */
export function openSettingsSection(id = "s-app", win = window) {
  if (win.location.hash !== "#settings") win.location.hash = "#settings";
  const go = () => {
    const sec = $(id); if (!sec) return;
    sec.scrollIntoView?.({ block: "start" });
    sec.querySelector("h2")?.focus({ preventScroll: true });
  };
  (win.requestAnimationFrame || ((f) => setTimeout(f, 0)))(() => setTimeout(go, 0));
  if (id === "s-app") loadAppSettings();
}

export const APP_CSS = `.appsec .appnote { margin: 0 0 6px; } .appsec .err { color: var(--red); overflow-wrap: anywhere; font-size: 12px; margin: 4px 0; }
.appsec .apppath { font-size: 11px; max-width: min(100%, 420px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; }
.appsec .appupd { flex-wrap: wrap; gap: 6px; font-size: 12px; } .appsec .appupd code { font-size: 11px; }
.appsec .appupdgrp { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line, rgba(127,127,127,.25)); } .appsec .appupdgrp h3 { font-size: 13px; margin: 0 0 4px; }
.appsec .appconfirm { font-size: 12px; font-weight: 600; }`;

const SECTION = `<section class="card ssec appsec" id="s-app" aria-labelledby="s-app-h" aria-describedby="s-app-d">
  <div class="hd"><h2 id="s-app-h" tabindex="-1">앱 (Ned.app)</h2></div>
  <div class="bd"><p class="sdesc" id="s-app-d">메뉴 막대 앱의 설정 — 자동 실행, 실행 시 대시보드, 저장소 위치, 로그, 데몬 다시 시작, 업데이트 확인.</p>
  <div class="ntf" id="app-body" aria-live="polite"></div>
  ${UPDATES_HTML}</div>
</section>`;

/** Adds the nav link + section (after the last section, before the save bar) and the listeners. Called from settings.js init. */
export function initAppSettings() {
  const nav = $("s-nav"), form = $("cfg");
  if (!nav || !form || $("s-app")) return;
  const st = document.createElement("style"); st.textContent = APP_CSS; document.head.appendChild(st);
  nav.insertAdjacentHTML("beforeend", `<a href="#settings" data-sjump="s-app">앱</a>`);
  const bar = form.querySelector(".sbar");
  if (bar) bar.insertAdjacentHTML("beforebegin", SECTION); else form.insertAdjacentHTML("beforeend", SECTION);
  const box = $("app-body");
  box.addEventListener("change", (e) => {
    const key = e.target.dataset?.appkey; if (!key || !APP_KEYS.includes(key)) return;
    e.stopPropagation(); // not part of the form: no dirty mark
    appCall({ op: "set", key, value: e.target.checked });
  });
  box.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-appact]")?.dataset.appact;
    if (act && APP_ACTIONS.includes(act)) { e.preventDefault(); appCall({ op: "action", name: act }); return; }
  });
  const upd = $("app-upd");
  upd.addEventListener("change", (e) => { if (e.target.id === "c-upd-check") $("c-upd-hours").disabled = !e.target.checked; });
  upd.addEventListener("click", async (e) => {
    if (e.target.closest("[data-appupd]")) { e.preventDefault(); checkUpdate(); return; }
    const ins = e.target.closest("[data-appinstall]")?.dataset.appinstall;
    if (ins) {
      e.preventDefault();
      if (ins === "ask") { AP.confirm = true; renderUpdateStatus(); }
      else if (ins === "cancel") { AP.confirm = false; renderUpdateStatus(); }
      else if (ins === "go") installUpdate();
      return;
    }
    if (e.target.closest("[data-appcopy]")) {
      e.preventDefault();
      AP.copied = await copyText((AP.upd?.steps || ["/plugin update ned", "/reload-plugins", "/ned:install"]).join("\n"));
      renderUpdateStatus();
    }
  });
  window.nedOpenSettings = (id) => openSettingsSection(id || "s-app");
  renderAppSettings();
  renderUpdateStatus();
  loadUpdateStatus();
  if (appBridge()) loadAppSettings();
  // Back to the tab (e.g. after approving the Login Item in System Settings): read the values again.
  window.addEventListener("hashchange", () => {
    if (location.hash !== "#settings") return;
    loadUpdateStatus();
    if (appBridge()) loadAppSettings();
  });
}
