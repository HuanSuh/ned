/* 자동 작업 감속: config.quiet_schedule (조용한 시간 동작) / config.idle_schedule (유휴 시 동작) — src/scheduler.ts.
 * Settings → 순찰 주기 블록 render/read, HOME 상태 칩 문구, 대시보드 활동 핑(POST /api/activity).
 * Pure helpers (autoSchedChip, normQuiet, normIdle) have no DOM access, so tests load them directly. */

const clampInt = (v, min, max, fb) => {
  const n = Number(v);
  return v === "" || v == null || !Number.isFinite(n) ? fb : Math.max(min, Math.min(max, Math.round(n)));
};
/** Same rules as src/config.ts normalizeQuietSchedule / normalizeIdleSchedule (older daemon: key absent → defaults). */
export const normQuiet = (q) => ({ mode: ["normal", "slow", "pause"].includes(q?.mode) ? q.mode : "slow", slow_factor: clampInt(q?.slow_factor, 2, 24, 6) });
export const normIdle = (i) => ({
  enabled: typeof i?.enabled === "boolean" ? i.enabled : true,
  after_minutes: clampInt(i?.after_minutes, 10, 1440, 120),
  unchanged_runs: clampInt(i?.unchanged_runs, 1, 50, 6),
  mode: i?.mode === "pause" ? "pause" : "slow",
  slow_factor: clampInt(i?.slow_factor, 2, 24, 6),
});

/** HOME 상태 칩: { quiet, idle } from GET /api/agenda → text, or "" when nothing is throttled. Idle wins the label when both. */
export function autoSchedChip(s) {
  const how = (mode, factor) => (mode === "pause" ? "멈춤" : `느리게 ×${factor}`);
  if (s?.idle?.active) return `유휴 모드 · ${how(s.idle.mode, s.idle.factor)} · 활동 시 재개`;
  const q = s?.quiet;
  if (q?.active && q.mode !== "normal") return `야간 모드 · ${how(q.mode, q.factor)}${q.until ? ` · ${q.until} 재개` : ""}`;
  return "";
}

// ---------- settings ----------
const $ = (id) => document.getElementById(id);
const radio = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;
let wired = false;

/** 조용한 시간 '사용' off → 조용한 시간 동작 dims; 유휴 '사용' off → 유휴 칸 dims (values kept and still saved). */
export function syncAutoSched() {
  const qOff = !$("c-qon")?.checked;
  $("qs-blk").classList.toggle("off", qOff);
  $("qs-blk").title = qOff ? "알림의 조용한 시간이 꺼져 있어 — 값은 그대로 보존돼" : "";
  const iOff = !$("is-on").checked;
  $("is-blk").classList.toggle("off", iOff);
  for (const id of ["is-after", "is-runs", "is-factor"]) $(id).disabled = iOff;
  for (const r of document.querySelectorAll("input[name=is-mode]")) r.disabled = iOff;
}

export function renderAutoSched(c) {
  const q = normQuiet(c?.quiet_schedule), i = normIdle(c?.idle_schedule);
  for (const r of document.querySelectorAll("input[name=qs-mode]")) r.checked = r.value === q.mode;
  $("qs-factor").value = q.slow_factor;
  $("is-on").checked = i.enabled;
  $("is-after").value = i.after_minutes;
  $("is-runs").value = i.unchanged_runs;
  for (const r of document.querySelectorAll("input[name=is-mode]")) r.checked = r.value === i.mode;
  $("is-factor").value = i.slow_factor;
  if (!wired) {
    wired = true;
    document.addEventListener("change", (e) => { if (e.target?.id === "c-qon" || e.target?.id === "is-on") syncAutoSched(); });
  }
  syncAutoSched();
}

/** { quiet_schedule, idle_schedule } for the PUT /api/config body. */
export function readAutoSched() {
  return {
    quiet_schedule: normQuiet({ mode: radio("qs-mode"), slow_factor: $("qs-factor").value }),
    idle_schedule: normIdle({ enabled: $("is-on").checked, after_minutes: $("is-after").value, unchanged_runs: $("is-runs").value, mode: radio("is-mode"), slow_factor: $("is-factor").value }),
  };
}

// ---------- activity ping ----------
const PING_MS = 60_000;
let lastPing = 0;
/** Visible + focused dashboard counts as the user being around (GET /api/state?visible=1 adds the poll). */
export const dashActive = () => document.visibilityState === "visible" && document.hasFocus();
/** Input / focus → POST /api/activity at most once a minute (ends idle mode right away). */
export function initActivityPing(post = (url) => fetch(url, { method: "POST" })) {
  const ping = () => {
    if (!dashActive() || Date.now() - lastPing < PING_MS) return;
    lastPing = Date.now();
    post("/api/activity").catch(() => {});
  };
  for (const ev of ["pointerdown", "keydown", "wheel", "focus"]) window.addEventListener(ev, ping, { passive: true, capture: true });
  document.addEventListener("visibilitychange", ping);
}
