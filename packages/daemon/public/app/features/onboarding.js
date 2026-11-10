/* 시작하기 (first-run checklist) — modal over any view. Data: GET /api/setup (src/setup-check.ts: per-source connector /
 * gh status, Slack 팀 ID, code signing; ?refresh=1 = 다시 확인). Opens by itself on load while not dismissed
 * (onboarding.dismissed_at) and something is incomplete; closing it = POST /api/setup/dismiss. 설정 → 시작하기 reopens it.
 * Slack 팀 ID saves through PUT /api/config { dashboard: { slack_team_id } } (the settings form's path).
 * 자동 실행 (Login Item) only inside Ned.app: webkit.messageHandlers.loginItem (DashboardWindow.swift LoginItemHandler,
 * postMessage → Promise) — a plain browser gets the menu hint. */
import { api, postJson } from "../api.js";
import { S } from "../state.js";
import { renderConfig, isDirty } from "../tabs/settings.js";
import { teamIdError } from "../tabs/settings-links.js";
import { hideModal, showModal, trapTab } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { $, esc } from "../util.js";

export const OB = { open: false, data: null, loading: false, error: "", login: null, loginBusy: false, teamMsg: "" };

const CHIP = { connected: ["g", "연결됨"], "needs-auth": ["a", "인증 필요"], "not-connected": ["r", "연결 안 됨"], pending: ["", "연결 중"], error: ["r", "확인 실패"] };
const chip = ([cls, label]) => `<span class="stk flat ${cls}">${esc(label)}</span>`;
const loginBridge = (win = window) => win.webkit?.messageHandlers?.loginItem || null;

/** (pure) One source row. */
export function sourceRow(s, busy) {
  const fix = s.fix
    ? s.fix.url ? `<a class="btn small" href="${esc(s.fix.url)}" target="_blank" rel="noopener">claude.ai 에서 연결</a>`
      : `<code>${esc(s.fix.command || "")}</code>`
    : "";
  const again = s.status === "connected" ? "" : `<button type="button" class="btn small" data-obrefresh="1" ${busy ? "disabled" : ""}>다시 확인</button>`;
  return `<div class="obrow" data-obsrc="${esc(s.key)}"><b>${esc(s.label)}</b>${chip(CHIP[s.status] || ["", s.status])}`
    + `<span class="obd" title="${esc(s.detail || "")}">${esc(s.status === "error" && s.detail ? `${s.detail} — ${s.fix?.text || ""}` : s.fix?.text || s.detail || "")}</span><span class="sp"></span>${fix}${again}</div>`;
}

const LOGIN_LABEL = { enabled: "켜짐", requiresApproval: "꺼짐 (승인 필요)", notRegistered: "꺼짐", notFound: "꺼짐" };

/** (pure) The whole body from OB + whether the Ned.app bridge exists. */
export function onboardingHtml(ob, { inApp }) {
  const d = ob.data;
  const head = `<div class="obh"><h4>소스 연결</h4><span class="hint">설정 → 소스에서 켠 것만. 커넥터는 본인 claude.ai 계정에 연결해야 Ned 가 읽을 수 있어.</span><span class="sp"></span>`
    + `<button type="button" class="btn small" data-obrefresh="1" ${ob.loading ? "disabled" : ""}>${ob.loading ? '<span class="spin"></span>확인 중…' : "다시 확인"}</button></div>`;
  if (!d) return head + `<p class="hint">${ob.error ? `확인 실패: ${esc(ob.error)}` : '<span class="spin"></span>확인 중… (claude 를 한 번 띄워 커넥터 상태를 읽어 — 토큰은 안 써)'}</p>`;
  const rows = d.sources.length ? d.sources.map((s) => sourceRow(s, ob.loading)).join("") : `<p class="hint">켜진 소스가 없어.</p>`;
  let team = "";
  if (d.slack_team_id.status !== "n/a") {
    team = `<div class="obh"><h4>Slack 팀 ID</h4>${chip(d.slack_team_id.status === "ok" ? ["g", "설정됨"] : ["a", "없음"])}</div>`
      + `<div class="obrow"><input id="ob-team" type="text" placeholder="T0ABC1234" spellcheck="false" autocapitalize="characters" value="${esc(d.slack_team_id.value)}" aria-label="Slack 팀 ID">`
      + `<button type="button" class="btn small" id="ob-team-save">저장</button><span class="obd" id="ob-team-msg" role="status">${esc(ob.teamMsg)}</span></div>`
      + `<p class="hint">Slack 링크를 앱으로 열 때 필요해. Slack 앱 → 워크스페이스 이름 → 워크스페이스 설정 URL 또는 about 의 T… ID.</p>`;
  }
  let login;
  if (!inApp) login = `<div class="obh"><h4>자동 실행</h4></div><p class="hint">Ned.app 창에서만 바꿀 수 있어 — 대시보드 <b>설정 → 앱(Ned.app)</b> 에서.</p>`;
  else {
    const st = ob.login?.status;
    const on = st === "enabled" || st === "requiresApproval";
    login = `<div class="obh"><h4>자동 실행</h4>${st ? chip(st === "enabled" ? ["g", "켜짐"] : ["a", LOGIN_LABEL[st] || st]) : ""}</div>`
      + `<label class="ck"><input type="checkbox" id="ob-login" ${on ? "checked" : ""} ${ob.loginBusy || !st ? "disabled" : ""}> 로그인할 때 Ned 실행 (Login Items)</label>`
      + (ob.login?.message ? `<p class="hint">${esc(ob.login.message)}</p>` : "");
  }
  const sg = d.signing;
  const sign = `<div class="obh"><h4>코드 서명</h4>${chip(sg.status === "ok" ? ["g", sg.identity] : sg.status === "untrusted" ? ["a", "신뢰 안 됨"] : sg.status === "missing" ? ["a", "없음 (ad-hoc)"] : ["r", "확인 실패"])}</div>`
    + (sg.status === "ok" ? `<p class="hint">재설치해도 macOS 가 권한을 다시 묻지 않아.</p>`
      : `<p class="hint">없으면 설치할 때마다 macOS 가 권한을 다시 물어. 터미널에서 한 번 실행하고(키체인·암호 대화상자 승인) <code>/ned:install</code> 을 다시 하면 <b>다음 설치부터</b> 적용돼.</p><div class="obrow"><code class="obcmd">${esc(sg.command)}</code></div>`);
  return head + rows + team + login + sign;
}

function render() {
  if (!OB.open) return;
  $("ob-body").innerHTML = onboardingHtml(OB, { inApp: !!loginBridge() });
  $("ob-sub").textContent = OB.data ? (OB.data.complete ? "모두 준비됐어" : "준비 안 된 항목이 있어") : "";
}

async function load(refresh = false) {
  OB.loading = true; OB.error = ""; render();
  try { OB.data = await api(`/api/setup${refresh ? "?refresh=1" : ""}`); }
  catch (e) { OB.error = e.data?.error || e.message; }
  finally { OB.loading = false; render(); }
}

async function loadLogin(op = { op: "get" }) {
  const h = loginBridge(); if (!h) return;
  OB.loginBusy = true; render();
  try { OB.login = await h.postMessage(op); }
  catch (e) { OB.login = { ...(OB.login || {}), message: `로그인 항목 확인 실패: ${e.message || e}` }; }
  finally { OB.loginBusy = false; render(); }
}

export function openOnboarding() {
  OB.open = true; OB.teamMsg = "";
  showModal($("ob-modal"));
  render();
  load(false);
  loadLogin();
  setTimeout(() => $("ob-modal").querySelector("[data-obclose]")?.focus(), 0);
}

export function closeOnboarding() {
  if (!OB.open) return;
  OB.open = false;
  hideModal($("ob-modal"));
  if (!OB.data?.onboarding?.dismissed_at) postJson("/api/setup/dismiss", { dismissed: true }).then((r) => { if (r.ok && OB.data) OB.data.onboarding = r.data.onboarding; });
}

async function saveTeam() {
  const v = $("ob-team").value.trim().toUpperCase();
  const err = teamIdError(v);
  if (err) { OB.teamMsg = err; render(); $("ob-team").focus(); return; }
  try {
    const body = { dashboard: { slack_team_id: v }, ...(S.config?.updated_at != null ? { if_updated_at: S.config.updated_at } : {}) };
    const dirty = isDirty();
    S.config = await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
    if (!dirty) renderConfig(); // an unsaved settings form keeps its edits (its next save diffs against its own baseline)
    OB.teamMsg = v ? "저장했어." : "비웠어.";
    await load(true);
  } catch (e) {
    OB.teamMsg = e.status === 409 ? "다른 곳에서 설정이 바뀌었어 — 설정을 다시 불러온 뒤 저장해 줘." : `저장 실패: ${e.data?.error || e.message}`;
    render();
  }
}

/** First load: open by itself while not dismissed and something is incomplete (Login Item aside — the daemon can't see it). */
async function autoOpen() {
  try {
    const d = await api("/api/setup");
    if (d.onboarding?.dismissed_at || d.complete) return;
    OB.data = d;
    openOnboarding();
  } catch (e) { if (e.status !== 404) console.warn("setup", e.message); }
}

export function init() {
  const m = $("ob-modal");
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.closest("[data-obclose]")) { closeOnboarding(); return; }
    if (e.target.closest("[data-obrefresh]")) { load(true); return; }
    if (e.target.closest("#ob-team-save")) saveTeam();
  });
  m.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "ob-team" && !e.isComposing) { e.preventDefault(); saveTeam(); } });
  m.addEventListener("change", (e) => {
    if (e.target.id !== "ob-login") return;
    loadLogin({ op: "set", enabled: e.target.checked }).then(() => { if (OB.login?.status === "requiresApproval") toast("시스템 설정 > 일반 > 로그인 항목에서 Ned 를 허용해 줘", 6000); });
  });
  // Modal keys win over page shortcuts (same as the draft modal).
  document.addEventListener("keydown", (e) => {
    if (!OB.open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeOnboarding(); return; }
    trapTab(m, e);
  }, true);
  for (const b of document.querySelectorAll("[data-onboard]")) b.addEventListener("click", (e) => { e.preventDefault(); openOnboarding(); });
  autoOpen();
}
