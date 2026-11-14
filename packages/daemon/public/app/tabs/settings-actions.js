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

/** 세션 빠른 답 (config.dashboard.session_quick_replies): "ㄱㄱ, 승인 ,계속" → ["ㄱㄱ","승인","계속"] (빈 칸·중복 빠짐, 자르지 않음 — 검사는 아래). */
export const QUICK_MAX = 5, QUICK_LEN = 20;
export const parseQuickReplies = (s) => [...new Set(String(s ?? "").split(",").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean))];
/** = src/config.ts quickRepliesError (목록 기준): 너무 많음 / 너무 긺 → 안내, 괜찮으면 null. */
export function quickRepliesMsg(list) {
  if (list.length > QUICK_MAX) return `세션 빠른 답은 ${QUICK_MAX}개까지야`;
  const long = list.find((x) => x.length > QUICK_LEN);
  return long ? `세션 빠른 답은 버튼마다 ${QUICK_LEN}자까지야 — "${long.slice(0, 30)}"` : null;
}

const ACTION_HINT = {
  session_send: "세션 ✎ 초안 보내기, 그리고 입력을 기다리는 세션 행 · 데스크톱 펫 말풍선의 빠른 답 / 한 줄 입력 → 그 세션의 Orca 터미널에 입력 + Enter (Orca 에서 실행된 세션만)",
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
  // switches only: rules / internal_domains / review are the 보내기 규칙 group's (sendRulesHtml), not toggles
  const present = [...new Set([...Object.keys(defaults || {}), ...Object.keys(config?.actions || {}).filter((k) => typeof config.actions[k] === "boolean")])];
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

// ---------- 보내기 규칙 (config.actions.rules · internal_domains · review) → #c-sendrules ----------
/** = src/config.ts RULE_SOURCES / RULE_EFFECTS / SEND_RULES_MAX / RULE_NOTE_MAX / RULE_TARGET_MAX. */
export const RULE_SRC = [["*", "모든 소스"], ["slack", "Slack"], ["mail", "메일"], ["jira", "Jira"], ["github", "GitHub"], ["calendar", "캘린더"], ["session", "세션"]];
export const RULE_EFFECT = [["allow", "허용"], ["confirm", "확인 후"], ["block", "금지"]];
export const RULE_EXT = [["", "상대 상관없음"], ["true", "외부 상대만"], ["false", "내부 상대만"]];
export const RULES_MAX = 30, RULE_NOTE_LEN = 120, RULE_TARGET_LEN = 200;
/** What `target` is compared with, per source (send-rules.ts). */
export const RULE_TARGET_HINT = {
  "*": "대상 (비우면 전부)", slack: "채널 ID (확실) · #채널 · 사람 이름", mail: "받는 주소 · @도메인", jira: "프로젝트 키 (예: ABC)",
  github: "owner/repo", calendar: "참석자 주소 · @도메인", session: "워크트리 이름",
};
const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");

/** One rule row (pure). `i` = position, `n` = how many rows. */
export function ruleRowHtml(r, i, n) {
  const k = i + 1, src = RULE_SRC.some(([v]) => v === r.source) ? r.source : "*";
  const ext = r.external === true ? "true" : r.external === false ? "false" : "";
  return `<div class="sri sr-${esc(r.effect || "confirm")}" data-si="${i}" role="listitem" aria-label="보내기 규칙 ${k}">
    <span class="srn" aria-hidden="true">${k}</span>
    <select data-sf="source" aria-label="규칙 ${k} 소스">${opts(RULE_SRC, src)}</select>
    <input type="text" data-sf="target" maxlength="${RULE_TARGET_LEN}" value="${esc(r.target || "")}" placeholder="${esc(RULE_TARGET_HINT[src])}" spellcheck="false" aria-label="규칙 ${k} 대상 (* 와일드카드, 비우면 전부)">
    <select data-sf="external" aria-label="규칙 ${k} 외부·내부">${opts(RULE_EXT, ext)}</select>
    <select data-sf="effect" aria-label="규칙 ${k} 효과">${opts(RULE_EFFECT, r.effect || "confirm")}</select>
    <input type="text" data-sf="note" maxlength="${RULE_NOTE_LEN}" value="${esc(r.note || "")}" placeholder="메모 (확인·금지 때 보여 줌)" aria-label="규칙 ${k} 메모">
    <span class="srb"><button type="button" class="btn small" data-sup="${i}" ${i === 0 ? "disabled" : ""} aria-label="규칙 ${k} 위로" title="위로">↑</button><button type="button" class="btn small" data-sdown="${i}" ${i === n - 1 ? "disabled" : ""} aria-label="규칙 ${k} 아래로" title="아래로">↓</button><button type="button" class="btn small x" data-sdel="${i}" aria-label="규칙 ${k} 삭제" title="삭제">삭제</button></span>
  </div>`;
}

/** The rule list + add button (pure). */
export function sendRuleListHtml(rules) {
  const rows = rules.length ? rules.map((r, i) => ruleRowHtml(r, i, rules.length)).join("") : `<div class="hint">규칙이 없어 — 켜 둔 동작은 지금처럼 보내(보내기 전 한 번 더 확인은 그대로).</div>`;
  const full = rules.length >= RULES_MAX;
  return `${rows}<div class="inl"><button type="button" class="btn small" id="c-sr-add" ${full ? "disabled" : ""}>＋ 규칙 추가</button><span class="hint">${full ? `최대 ${RULES_MAX}개까지야.` : `${rules.length}/${RULES_MAX} · 위에서부터 처음 맞는 규칙 하나만 적용`}</span></div>`;
}

/** #c-sendrules innerHTML: rules, 회사 도메인, 자동 검토. */
export function sendRulesHtml(config) {
  const a = config?.actions || {};
  const rules = Array.isArray(a.rules) ? a.rules : [];
  const doms = Array.isArray(a.internal_domains) ? a.internal_domains.join(", ") : "";
  const rv = a.review === "warn" ? "warn" : "off";
  return `<div class="srlist" id="c-sr-list" role="list" aria-label="보내기 규칙 목록">${sendRuleListHtml(rules)}</div>
    <div class="srf"><label for="c-sr-domains">회사 도메인</label><input type="text" id="c-sr-domains" value="${esc(doms)}" placeholder="acme.com, acme.co.kr" spellcheck="false" aria-describedby="c-sr-domains-h"><span class="hint" id="c-sr-domains-h">받는 주소가 여기 없는 도메인이면 '외부 상대'. 비워 두면 외부·내부 규칙은 아무것도 맞추지 않아. 메일·캘린더만 판정(Slack·Jira·GitHub·세션은 주소가 없어 외부·내부 규칙이 적용 안 됨).</span></div>
    <div class="srf" id="c-sr-review" role="radiogroup" aria-labelledby="c-sr-review-l"><span class="lab" id="c-sr-review-l">보내기 전 자동 검토</span><div class="toggles">
      <label><input type="radio" name="c-sr-review" value="off" ${rv === "off" ? "checked" : ""}>끔</label>
      <label><input type="radio" name="c-sr-review" value="warn" ${rv === "warn" ? "checked" : ""}>경고 (보내기 직전 Claude 가 한 번 읽음)</label></div>
      <span class="hint">경고: 받는 이·채널이 맥락과 맞는지, 토큰·비밀번호·내부 URL, 날짜·약속, 어조를 봐. 이슈가 있으면 보내기 전 확인에 보여 주고(막지는 않음), 못 보면 '검토 못 함' 메모를 달고 그대로 보내. 세션 답하기는 검토 안 함. 보낼 때마다 Claude 호출 1번(빠른 모델, 20초 이내).</span></div>`;
}

/** One rule row → a config entry (empty target / note / 상관없음 → omitted). */
function readRule(el) {
  const f = (k) => el.querySelector(`[data-sf="${k}"]`)?.value ?? "";
  const target = f("target").trim(), note = f("note").trim(), ext = f("external");
  return { source: f("source") || "*", ...(target ? { target } : {}), ...(ext ? { external: ext === "true" } : {}), effect: f("effect") || "confirm", ...(note ? { note } : {}) };
}

/** "@Acme.com, x" → ["acme.com", "x"] (as typed, lower-case; the daemon drops what is not a domain). */
export const parseDomains = (s) => [...new Set(String(s ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@+/, "")).filter(Boolean))];
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** {rules, internal_domains, review} from #c-sendrules (no section → null: nothing to send). */
export function readSendRules(root) {
  if (!root || !root.querySelector("#c-sr-list")) return null;
  return {
    rules: [...root.querySelectorAll(".sri")].map(readRule),
    internal_domains: parseDomains(root.querySelector("#c-sr-domains")?.value),
    review: root.querySelector('input[name="c-sr-review"]:checked')?.value === "warn" ? "warn" : "off",
  };
}

/** Save guard (= src/config.ts sendRulesError + the domain filter): → message or null. */
export function sendRulesMsg(actions) {
  if (!actions || typeof actions !== "object") return null;
  if (Array.isArray(actions.rules) && actions.rules.length > RULES_MAX) return `보내기 규칙은 ${RULES_MAX}개까지야`;
  const bad = (actions.internal_domains || []).find((d) => !DOMAIN_RE.test(d));
  return bad ? `회사 도메인 "${bad.slice(0, 40)}" 은 도메인 형식이 아니야 (예: acme.com)` : null;
}

/** After an edit: placeholders follow the source, the row tint follows the effect. */
export function syncSendRules(root) {
  for (const el of root?.querySelectorAll(".sri") || []) {
    const src = el.querySelector('[data-sf="source"]').value, eff = el.querySelector('[data-sf="effect"]').value;
    el.querySelector('[data-sf="target"]').placeholder = RULE_TARGET_HINT[src] || "";
    el.className = `sri sr-${eff}`;
  }
}

/** Click on 추가 / ↑ / ↓ / 삭제 inside #c-sendrules → redraw the list; returns true when it handled the click. */
export function sendRulesClick(root, target) {
  const add = target.closest?.("#c-sr-add"), up = target.closest?.("[data-sup]"), down = target.closest?.("[data-sdown]"), del = target.closest?.("[data-sdel]");
  if (!add && !up && !down && !del) return false;
  const rules = readSendRules(root).rules;
  let focus = null;
  if (add && rules.length < RULES_MAX) { rules.push({ source: "*", effect: "confirm" }); focus = `[data-si="${rules.length - 1}"] [data-sf="source"]`; }
  const swap = (i, j) => { [rules[i], rules[j]] = [rules[j], rules[i]]; };
  if (up) { const i = Number(up.dataset.sup); if (i > 0) { swap(i, i - 1); focus = `[data-sup="${i - 1}"]`; } }
  if (down) { const i = Number(down.dataset.sdown); if (i < rules.length - 1) { swap(i, i + 1); focus = `[data-sdown="${i + 1}"]`; } }
  if (del) { rules.splice(Number(del.dataset.sdel), 1); focus = "#c-sr-add"; }
  root.querySelector("#c-sr-list").innerHTML = sendRuleListHtml(rules);
  syncSendRules(root);
  const f = focus && root.querySelector(focus);
  (f && !f.disabled ? f : root.querySelector("#c-sr-add"))?.focus();
  return true;
}

export const SEND_RULES_CSS = `.sendrules { display: flex; flex-direction: column; gap: 10px; }
.srlist { display: flex; flex-direction: column; gap: 6px; }
.sri { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; border: 1px solid var(--line); border-left-width: 3px; border-radius: 8px; background: var(--bg); }
.sri.sr-allow { border-left-color: var(--green, #3a3); } .sri.sr-confirm { border-left-color: var(--amber, #c90); } .sri.sr-block { border-left-color: var(--red, #c33); }
.sri .srn { font-size: 11px; color: var(--dim); min-width: 16px; text-align: right; }
.sri select, .sri input { background: var(--bg); color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 13px; }
.sri input[data-sf="target"] { flex: 1 1 160px; min-width: 120px; } .sri input[data-sf="note"] { flex: 2 1 180px; min-width: 140px; }
.sri .srb { display: inline-flex; gap: 4px; margin-left: auto; }
.sendrules .srf { display: flex; flex-direction: column; gap: 4px; }
.sendrules .srf input[type=text] { max-width: 460px; }
.sendrules .inl { display: flex; gap: 8px; align-items: center; }`;

/** reply_tone_by_source from the inputs: blank → null (= 기본 말투). */
export function readToneBySource(root) {
  const out = { slack: null, email: null, session: null };
  for (const el of root.querySelectorAll("[data-tone-src]")) out[el.dataset.toneSrc] = el.value.trim().slice(0, 200) || null;
  return out;
}
