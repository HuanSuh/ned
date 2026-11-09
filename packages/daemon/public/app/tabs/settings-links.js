/* 설정 → 외형 → 링크 열기 (config.dashboard.open_links_in_app · open_links_in_app_by_service.* · slack_team_id ·
 * slack_team_domain). Fields save with the form (readLinkPrefs → PUT /api/config { dashboard }); features/openlink.js
 * reads the saved values from S.config.dashboard. Service checkboxes dim while the master toggle is off (values kept). */
import { $ } from "../util.js";
import { LINK_SERVICES, SLACK_TEAM_ID_RE, normalizeSlackTeamDomain } from "../features/links.js";

export function renderLinkPrefs(d) {
  d = d || {};
  $("c-openapp").checked = d.open_links_in_app !== false;
  for (const cb of document.querySelectorAll("[data-olsvc]")) cb.checked = d.open_links_in_app_by_service?.[cb.dataset.olsvc] !== false;
  $("c-slack-team").value = typeof d.slack_team_id === "string" ? d.slack_team_id : "";
  $("c-slack-domain").value = typeof d.slack_team_domain === "string" ? d.slack_team_domain : "";
  syncLinkPrefs();
}

/** What the domain field saves: "Acme.slack.com" → "acme"; junk is sent as typed (lower-cased) so the check below / the server reject it. */
const readDomain = () => { const raw = $("c-slack-domain").value; const n = normalizeSlackTeamDomain(raw, null); return n ?? raw.trim().toLowerCase(); };

/** The dashboard keys this section owns (team id upper-cased as typed; the server checks the shape). */
export function readLinkPrefs() {
  const by = {};
  for (const cb of document.querySelectorAll("[data-olsvc]")) by[cb.dataset.olsvc] = cb.checked;
  for (const s of LINK_SERVICES) if (!(s in by)) by[s] = true;
  return { open_links_in_app: $("c-openapp").checked, open_links_in_app_by_service: by, slack_team_id: $("c-slack-team").value.trim().toUpperCase(), slack_team_domain: readDomain() };
}

/** "" or a T… id → null, else the message to show (also what the server answers with a 400). */
export const teamIdError = (v) => (!v || SLACK_TEAM_ID_RE.test(v) ? null : "Slack 팀 ID 는 T 로 시작하는 영문 대문자·숫자(7자 이상)야 — 예: T0ABC1234");
/** "" or a workspace subdomain → null, else the message (= src/config.ts slackTeamDomainError). */
export const domainError = (v) => (!v || normalizeSlackTeamDomain(v, null) !== null ? null : "Slack 워크스페이스 주소는 <이름>.slack.com 의 <이름>(영문 소문자·숫자·-)만 돼 — 예: acme");
/** First field error of this section for a dashboard patch: { id, msg } or null. */
export function linkPrefsError(dash) {
  const t = teamIdError(dash?.slack_team_id); if (t) return { id: "c-slack-team", msg: t };
  const d = domainError(dash?.slack_team_domain); if (d) return { id: "c-slack-domain", msg: d };
  return null;
}

export function syncLinkPrefs() {
  const on = $("c-openapp").checked, box = $("c-openapp-svc");
  box.classList.toggle("off", !on);
  for (const cb of box.querySelectorAll("input")) cb.disabled = !on;
  for (const [id, err] of [["c-slack-team", teamIdError($("c-slack-team").value.trim().toUpperCase())], ["c-slack-domain", domainError(readDomain())]]) {
    $(`${id}-msg`).textContent = err || "";
    $(`${id}-msg`).style.color = err ? "var(--red)" : "";
  }
}

export function initLinkPrefs() {
  $("c-openapp").addEventListener("change", syncLinkPrefs);
  $("c-slack-team").addEventListener("input", syncLinkPrefs);
  $("c-slack-domain").addEventListener("input", syncLinkPrefs);
}
