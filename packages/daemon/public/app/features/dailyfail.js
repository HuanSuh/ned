/* Failed briefings: a run whose claude call failed or whose answer didn't parse (daemon: state.ts briefingOk).
 * Older files have no `ok` — the failed ones are those that kept `raw`. Pure, no DOM (test/daily-retry.test.ts). */

/** True when this briefing didn't actually judge. */
export const bfFailed = (b) => !!b && (b.ok === false || (b.ok == null && b.raw != null));

/** "아침" / "점검", with " 실패" for a failed run. */
export const bfKind = (b) => `${b?.type === "daily" ? "아침" : "점검"}${bfFailed(b) ? " 실패" : ""}`;

const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };

/** Home one-liner when today's automatic morning briefing gave up after its retries (state.daily_failed_at), else "". */
export function dailyFailedLine(state, now = Date.now()) {
  const at = state?.daily_failed_at;
  if (!at || !sameDay(at, now)) return "";
  return "오늘 아침 브리핑 실패 — 위 '아침 브리핑' 이나 '지금 점검' 으로 다시";
}
