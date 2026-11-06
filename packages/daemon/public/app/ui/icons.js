/* Kind icons / labels and the 24px item action icon button (iconBtn). */
import { esc } from "../util.js";

export const KIND_ICON = { session: "🖥", email: "✉️", slack: "💬", jira: "📋", github: "🐙", sentry: "🐞", calendar: "📅", other: "🔔" };
export const KIND_KO = { session: "세션", email: "메일", slack: "Slack", jira: "Jira", github: "GitHub", sentry: "Sentry", calendar: "캘린더", other: "기타" };
export const SOURCE_LABEL = { gmail: "Gmail", slack: "Slack", jira: "Jira", github: "GitHub", sentry: "Sentry", calendar: "캘린더" };
export const STATUS_KO = { running: "실행 중", waiting: "입력 대기", done: "완료", error: "오류", ended: "종료" };
export const STATUS_LED = { running: "b", waiting: "a", error: "r", done: "g" };
export const EVENT_KO = { SessionStart: "세션 시작", SessionEnd: "세션 종료", UserPromptSubmit: "프롬프트", SubagentStart: "서브에이전트 시작", SubagentStop: "서브에이전트 종료", Notification: "알림", Stop: "응답 완료", StopFailure: "오류", PreCompact: "컨텍스트 압축" };
export const MOOD_KO = { scanning: "스캔 중", offline: "자리 비움", headsup: "헤이, 이거 봐", quiet: "조용한 시간", idle: "지켜보는 중" };

// ---------- item action icons (one component everywhere: home, source cards, inbox list / detail, session rail) ----------
export const ICONS = {
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  draft: '<path d="M4 20l4.2-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20zM14.5 6.5l3 3"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
/** 24px icon button; the label is the tooltip + accessible name. `href` makes it an external link. */
export function iconBtn(kind, label, { href = "", attrs = "", on = false, cls = "" } = {}) {
  const svg = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`, c = `ib ib-${kind}${on ? " on" : ""}${cls ? " " + cls : ""}`;
  return href ? `<a class="${c}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}>${svg}</a>`
    : `<button type="button" class="${c}" title="${esc(label)}" aria-label="${esc(label)}"${kind === "check" ? ` aria-pressed="${on}"` : ""} ${attrs}>${svg}</button>`;
}
export const openIcon = (u) => (u ? iconBtn("open", "열기 (새 탭)", { href: u }) : "");
export const reviewIcon = (a) => iconBtn("check", a.reviewed_at ? "확인 완료 — 눌러서 되돌리기" : "확인 (확인 완료로 표시)", { attrs: `data-review="${esc(a.id)}"`, on: !!a.reviewed_at });
export const closeIcon = (a, attrs = "") => iconBtn("close", "닫기 — 처리 완료로 치우기", { attrs: `data-dismiss="${esc(a.id)}" ${attrs}` });
