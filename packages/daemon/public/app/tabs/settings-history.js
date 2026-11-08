/* 설정 → 수집·보관 (config.history, src/history.ts): 이력 기록 켜기, 표시 구간(Slack 시간 · 메일 일), 소스별 보관 기간.
 * Fields save with the form (readHistorySettings → PUT /api/config { history }); the status line reads
 * GET /api/history/status (소스별 건수 · 일수 · 크기, 마지막 증분/전체 수집, 다음 수집 창). */
import { api } from "../api.js";
import { $, esc, mdhm } from "../util.js";

export const KEEP_SRC = [["slack", "Slack"], ["mail", "메일"], ["jira", "Jira"], ["github", "GitHub"], ["calendar", "캘린더"]];
const HS = { status: null, error: "" };

export function renderHistorySettings(c) {
  const h = c?.history || {};
  $("c-hist-on").checked = h.enabled !== false;
  $("c-hist-slack-h").value = h.display?.slack_hours ?? 24;
  $("c-hist-mail-d").value = h.display?.mail_days ?? 3;
  for (const [k] of KEEP_SRC) $(`c-keep-${k}`).value = h.keep_days?.[k] ?? "";
  syncHistoryEnabled();
  loadHistoryStatus();
}

const num = (id) => ($(id).value === "" ? null : Number($(id).value));
export function readHistorySettings() {
  return {
    enabled: $("c-hist-on").checked,
    display: { slack_hours: num("c-hist-slack-h"), mail_days: num("c-hist-mail-d") },
    keep_days: Object.fromEntries(KEEP_SRC.map(([k]) => [k, num(`c-keep-${k}`)])),
  };
}

export function syncHistoryEnabled() { $("c-hist").classList.toggle("off", !$("c-hist-on").checked); }

export async function loadHistoryStatus() {
  try { HS.status = await api("/api/history/status"); HS.error = ""; } catch (e) { HS.error = e.status === 404 ? "이 데몬은 수집 이력을 몰라 (업데이트 필요)" : e.message; }
  renderHistoryStatus();
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(0, Math.round(n / 1024))}KB`);
/** One status block (pure — tests). */
export function historyStatusHtml(s) {
  if (!s) return `<span class="hint">불러오는 중…</span>`;
  const parts = [];
  if (!s.enabled) parts.push(`<span class="hint">꺼져 있어 — 기록하지 않고 카드는 마지막 목록만 보여 줘.</span>`);
  parts.push(`<span class="hint">${KEEP_SRC.map(([k, label]) => { const x = s.sources?.[k]; return x ? `${esc(label)} ${x.recording ? `${x.count}건 · ${x.days}일 · ${kb(x.bytes)}` : "기록 안 함"}` : ""; }).filter(Boolean).join(" · ")}</span>`);
  const col = (k, label) => {
    const c = s.collect?.[k]; if (!c) return "";
    const last = c.last_ok_at ? `마지막 수집 ${esc(mdhm(c.last_ok_at))}` : "아직 수집 안 함";
    const full = c.last_full_at ? ` · 마지막 전체 재검색 ${esc(mdhm(c.last_full_at))}` : "";
    const next = c.next ? ` · 다음: ${c.next.full ? "전체" : `증분 (${esc(mdhm(c.next.since))} 이후)`}` : "";
    return `<span class="hint">${esc(label)}: ${last}${full}${next}</span>`;
  };
  parts.push(col("slack", "Slack"), col("mail", "메일"));
  if (s.last_prune_day) parts.push(`<span class="hint">마지막 정리: ${esc(s.last_prune_day)}</span>`);
  parts.push(`<span class="inl"><button type="button" class="btn small" id="c-hist-reload">상태 새로고침</button></span>`);
  return parts.filter(Boolean).join("");
}

export function renderHistoryStatus() {
  const box = $("c-hist-status");
  if (!box) return;
  box.innerHTML = HS.error ? `<span class="hint">${esc(HS.error)}</span>` : historyStatusHtml(HS.status);
}

export const HIST_SET_CSS = `.hist .archst { display: flex; flex-direction: column; gap: 4px; font-size: 12px; } .hist.off > :not(:first-child) { opacity: .45; }
.hist .inl label { font-size: 12px; color: var(--dim); }`;

export function initHistorySettings() {
  const st = document.createElement("style"); st.textContent = HIST_SET_CSS; document.head.appendChild(st);
  $("c-hist-on").addEventListener("change", syncHistoryEnabled);
  $("c-hist-status").addEventListener("click", (e) => { if (e.target.closest("button")?.id === "c-hist-reload") { e.preventDefault(); loadHistoryStatus(); } });
}
