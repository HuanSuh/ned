/* Settings › 쓰기 액션: allowed write actions grouped by source, plus a per-source 답장 말투 (Slack / Gmail / 세션).
 * Pure HTML builders (no DOM at import) so the layout is unit-tested; settings.js mounts them into #wa-groups.
 * Toggles keep their old ids (data-act="<key>") so readBody / PUT /api/config are unchanged. */
import { KIND_ICON } from "../ui/icons.js";
import { esc } from "../util.js";

/** Fixed order. `src` = config.sources key that dims the group when off (session has none); `tone` = reply_tone_by_source key. */
export const WA_GROUPS = [
  { id: "slack", label: "Slack", icon: KIND_ICON.slack, src: "slack", tone: "slack", keys: ["slack_send"] },
  { id: "gmail", label: "Gmail", icon: KIND_ICON.email, src: "gmail", tone: "email", keys: ["gmail_draft", "gmail_send", "gmail_mark_read"] },
  { id: "session", label: "세션", icon: KIND_ICON.session, src: null, tone: "session", keys: ["session_send", "chat_session_create"] },
  { id: "jira", label: "Jira", icon: KIND_ICON.jira, src: "jira", tone: null, keys: ["jira_comment", "jira_transition"] },
  { id: "github", label: "GitHub", icon: KIND_ICON.github, src: "github", tone: null, keys: ["github_review"] },
  { id: "calendar", label: "캘린더", icon: KIND_ICON.calendar, src: "calendar", tone: null, keys: ["calendar_rsvp", "calendar_create"] },
  { id: "chat", label: "대화창", icon: "🗨", src: null, tone: null, keys: ["chat_write"] },
];
export const TONE_SOURCES = ["slack", "email", "session"];

const ACTION_HINT = {
  jira_comment: "Jira 항목 ⋯ → 코멘트 초안 → 확인 후 코멘트 등록",
  jira_transition: "Jira 항목 ⋯ → 상태 변경 (가능한 전환을 먼저 읽어 옴) → 확인 후 전환",
  github_review: "PR 항목 ⋯ → 리뷰 초안 / 승인 / 변경 요청 / 코멘트 (gh pr review · gh pr comment)",
  calendar_rsvp: "일정 ⋯ → 수락 / 미정 / 거절",
  gmail_mark_read: "메일 카드의 ✓(확인 완료)를 누르면 Gmail 에서도 그 스레드를 읽음 처리 (백그라운드, 실패해도 확인 완료는 유지). 확인을 취소해도 안 읽음으로 되돌리지 않아",
  chat_write: "Ned Net 대화창이 쓰기(보내기·만들기·할 일 추가)를 제안하면 확인 카드로 보여 줌 → 텍스트만 고쳐 [실행]. 각 동작은 위 스위치도 켜져 있어야 해",
  chat_session_create: "Ned 대화창이 새 에이전트 세션(레포·워크트리·모델·첫 프롬프트)을 제안하면 확인 카드에서 [실행] → Orca 워크트리 + Claude 시작 후 첫 프롬프트 전송. 대화창 출처로 살아 있는 세션은 2개까지",
  calendar_create: "일정 카드 ＋ / 주 보기 드래그 / 일 보기 빈 시간 클릭 → 새 일정 팝업 → 확인 후 Google Calendar 에 생성",
};

/** Groups to show: known keys present in defaults/config go to their source; unknown keys land in "기타" so new ones never vanish. */
export function writeActionGroups(config, defaults) {
  const present = [...new Set([...Object.keys(defaults || {}), ...Object.keys(config?.actions || {})])];
  const known = new Set(WA_GROUPS.flatMap((g) => g.keys));
  const groups = WA_GROUPS.map((g) => ({ ...g, keys: g.keys.filter((k) => present.includes(k)) })).filter((g) => g.keys.length);
  const other = present.filter((k) => !known.has(k));
  if (other.length) groups.push({ id: "other", label: "기타", icon: KIND_ICON.other, src: null, tone: null, keys: other });
  return groups;
}

const toggle = (k, on, ko) => `<label${ACTION_HINT[k] ? ` title="${esc(ACTION_HINT[k])}"` : ""}><input type="checkbox" data-act="${esc(k)}" ${on ? "checked" : ""}>${esc(ko[k] || k)}</label>`;

/** Mode switches shown as a 2-way radio instead of a toggle: only the "on" radio carries data-act, so readBody's
 *  `[data-act].checked` still yields the boolean. */
const RADIO = { gmail_mark_read: { q: "메일 확인 시", off: "확인 완료만" } };
const radio = (k, on, ko) => {
  const r = RADIO[k], name = `wa-${esc(k)}`;
  return `<div class="waradio" role="radiogroup" aria-label="${esc(r.q)}"${ACTION_HINT[k] ? ` title="${esc(ACTION_HINT[k])}"` : ""}><span class="waq">${esc(r.q)}:</span><div class="toggles">`
    + `<label><input type="radio" name="${name}" value="off" ${on ? "" : "checked"}>${esc(r.off)}</label>`
    + `<label><input type="radio" name="${name}" value="on" data-act="${esc(k)}" ${on ? "checked" : ""}>${esc(ko[k] || k)}까지</label></div></div>`;
};

/** #wa-groups innerHTML. */
export function writeActionsHtml(config, defaults, ko) {
  const acts = { ...(defaults || {}), ...(config?.actions || {}) };
  const tones = config?.reply_tone_by_source && typeof config.reply_tone_by_source === "object" ? config.reply_tone_by_source : {};
  return writeActionGroups(config, defaults).map((g) => {
    const off = !!g.src && config?.sources?.[g.src] === false;
    const tone = g.tone ? `<div class="watone"><label for="c-tone-${g.tone}">답장 말투</label><input type="text" id="c-tone-${g.tone}" data-tone-src="${g.tone}" placeholder="기본 말투 사용" maxlength="200" value="${esc(tones[g.tone] || "")}"></div>` : "";
    return `<div class="wagrp${off ? " off" : ""}" data-wagrp="${g.id}"${g.src ? ` data-wasrc="${g.src}"` : ""} role="group" aria-labelledby="wa-h-${g.id}">
      <div class="wah"><span class="waic" aria-hidden="true">${g.icon}</span><h3 id="wa-h-${g.id}">${esc(g.label)}</h3><span class="offnote"${off ? "" : " hidden"}>소스가 꺼져 있어 — 설정은 그대로 보존돼</span></div>
      <div class="wab"><div class="toggles">${g.keys.filter((k) => !RADIO[k]).map((k) => toggle(k, acts[k], ko || {})).join("")}</div>${g.keys.filter((k) => RADIO[k]).map((k) => radio(k, acts[k], ko || {})).join("")}${tone}</div></div>`;
  }).join("");
}

/** Dim a group whose source is off (values kept, still editable and saved). `isOn(src)` reads the 소스 toggles. */
export function syncWriteActionGroups(root, isOn) {
  for (const g of root.querySelectorAll("[data-wasrc]")) {
    const off = !isOn(g.dataset.wasrc);
    g.classList.toggle("off", off);
    g.querySelector(".offnote").hidden = !off;
  }
}

/** reply_tone_by_source from the inputs: blank → null (= 기본 말투). */
export function readToneBySource(root) {
  const out = { slack: null, email: null, session: null };
  for (const el of root.querySelectorAll("[data-tone-src]")) out[el.dataset.toneSrc] = el.value.trim().slice(0, 200) || null;
  return out;
}
