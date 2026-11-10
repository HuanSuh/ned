/* 설정 → 앱 (Ned.app): the menu bar app's own settings, moved out of its dropdown. They live in the app (UserDefaults /
 * SMAppService / NSOpenPanel), not config.yaml, so they apply at once — independent of the form's 저장.
 * Bridge: webkit.messageHandlers.appSettings (DashboardWindow.swift AppSettingsHandler, postMessage → Promise):
 *   {op: "get"} · {op: "set", key, value} (key ∈ APP_KEYS) · {op: "action", name} (name ∈ APP_ACTIONS)
 *   → {loginItem: {status, enabled, message?}, openAtLaunch, openAtLoginLaunch, repoPath, logPath, cancelled?}
 * A plain browser has no bridge: one hint line instead. 업데이트 확인 is the daemon's (GET /api/update-check) and works in both.
 * The section and its nav link are added here (index.html is untouched). */
import { api } from "../api.js";
import { copyText } from "../features/code-copy.js";
import { $, esc } from "../util.js";

export const APP_KEYS = ["loginItem", "openAtLaunch", "openAtLoginLaunch"];
export const APP_ACTIONS = ["chooseRepo", "revealLog", "restartDaemon"];
export const AP = { data: null, error: "", busy: "", upd: null, updBusy: false, updError: "", copied: false };

export const appBridge = (win = window) => win.webkit?.messageHandlers?.appSettings || null;

const LOGIN_LABEL = { enabled: "켜짐", requiresApproval: "꺼짐 (승인 필요)", notRegistered: "꺼짐", notFound: "꺼짐" };
const chip = (cls, label) => `<span class="stk flat ${cls}">${esc(label)}</span>`;

/** (pure) 업데이트 확인 result line. */
export function updateHtml(ap) {
  const btn = `<button type="button" class="btn small" data-appupd="1" ${ap.updBusy ? "disabled" : ""}>${ap.updBusy ? '<span class="spin"></span>확인 중…' : "업데이트 확인"}</button>`;
  const u = ap.upd;
  let res = "";
  if (ap.updError) res = `<span class="err">확인 실패: ${esc(ap.updError)}</span>`;
  else if (u && !u.latest) res = `<span class="err">확인 실패${u.error ? ` (${esc(u.error)})` : ""}</span>`;
  else if (u && u.update_available) {
    const steps = (u.steps || []).map((s) => `<code>${esc(s)}</code>`).join(" → ");
    res = `<span><b>${esc(u.current || "?")} → ${esc(u.latest)} 업데이트 있음</b> — Claude Code 에서 ${steps}</span>`
      + `<button type="button" class="btn small" data-appcopy="1">${ap.copied ? "복사했어" : "명령 복사"}</button>`;
  } else if (u) res = `<span class="hint" title="${esc(u.note || u.error || "")}">최신 버전 (${esc(u.current || u.latest)})${u.source === "marketplace" ? " · 마켓플레이스 기준" : ""}${u.error ? ` · ${esc(u.error)}` : ""}</span>`;
  return `<div class="nrow"><span class="lab">업데이트</span><div class="inl appupd" aria-live="polite">${btn}${res}</div></div>`;
}

/** (pure) The section body for AP + whether the Ned.app bridge exists. */
export function appSettingsHtml(ap, { inApp }) {
  const head = `<p class="hint appnote">이 묶음은 바꾸는 즉시 적용돼 — 아래 "저장"과 상관없어 (Ned.app 의 설정).</p>`;
  if (!inApp) return head + `<p class="hint" data-appnobridge="1">Ned.app 창에서 열면 바꿀 수 있어요.</p>` + updateHtml(ap);
  const d = ap.data;
  const err = ap.error ? `<p class="err" role="alert">${esc(ap.error)}</p>` : "";
  if (!d) return head + err + (ap.error ? "" : `<p class="hint"><span class="spin"></span>불러오는 중…</p>`) + updateHtml(ap);
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
  return head + err + rows.join("") + updateHtml(ap);
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
  AP.updBusy = true; AP.updError = ""; AP.copied = false; renderAppSettings();
  try { AP.upd = await api("/api/update-check?refresh=1"); }
  catch (e) { AP.updError = e.status === 404 ? "이 데몬은 업데이트 확인을 몰라 (업데이트 필요)" : e.message; }
  finally { AP.updBusy = false; renderAppSettings(); }
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
.appsec .appupd { flex-wrap: wrap; gap: 6px; font-size: 12px; } .appsec .appupd code { font-size: 11px; }`;

const SECTION = `<section class="card ssec appsec" id="s-app" aria-labelledby="s-app-h" aria-describedby="s-app-d">
  <div class="hd"><h2 id="s-app-h" tabindex="-1">앱 (Ned.app)</h2></div>
  <div class="bd"><p class="sdesc" id="s-app-d">메뉴 막대 앱의 설정 — 자동 실행, 실행 시 대시보드, 저장소 위치, 로그, 데몬 다시 시작, 업데이트 확인.</p>
  <div class="ntf" id="app-body" aria-live="polite"></div></div>
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
    if (e.target.closest("[data-appupd]")) { e.preventDefault(); checkUpdate(); return; }
    if (e.target.closest("[data-appcopy]")) {
      e.preventDefault();
      AP.copied = await copyText((AP.upd?.steps || []).join("\n"));
      renderAppSettings();
    }
  });
  window.nedOpenSettings = (id) => openSettingsSection(id || "s-app");
  renderAppSettings();
  if (appBridge()) loadAppSettings();
  // Back to the tab (e.g. after approving the Login Item in System Settings): read the values again.
  window.addEventListener("hashchange", () => { if (location.hash === "#settings" && appBridge()) loadAppSettings(); });
}
