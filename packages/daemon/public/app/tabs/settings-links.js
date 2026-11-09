/* 설정 → 외형 → 링크 열기 (config.dashboard.open_links_in_app · open_links_in_app_by_service.* · slack_team_id).
 * Fields save with the form (readLinkPrefs → PUT /api/config { dashboard }); features/openlink.js reads the saved values
 * from S.config.dashboard. Service checkboxes dim while the master toggle is off (values kept and still saved). */
import { $ } from "../util.js";
import { LINK_SERVICES, SLACK_TEAM_ID_RE } from "../features/links.js";

export function renderLinkPrefs(d) {
  d = d || {};
  $("c-openapp").checked = d.open_links_in_app !== false;
  for (const cb of document.querySelectorAll("[data-olsvc]")) cb.checked = d.open_links_in_app_by_service?.[cb.dataset.olsvc] !== false;
  $("c-slack-team").value = typeof d.slack_team_id === "string" ? d.slack_team_id : "";
  $("c-slack-team-msg").textContent = "";
  syncLinkPrefs();
}

/** The dashboard keys this section owns (team id upper-cased as typed; the server checks the shape). */
export function readLinkPrefs() {
  const by = {};
  for (const cb of document.querySelectorAll("[data-olsvc]")) by[cb.dataset.olsvc] = cb.checked;
  for (const s of LINK_SERVICES) if (!(s in by)) by[s] = true;
  return { open_links_in_app: $("c-openapp").checked, open_links_in_app_by_service: by, slack_team_id: $("c-slack-team").value.trim().toUpperCase() };
}

/** "" or a T… id → null, else the message to show (also what the server answers with a 400). */
export const teamIdError = (v) => (!v || SLACK_TEAM_ID_RE.test(v) ? null : "Slack 팀 ID 는 T 로 시작하는 영문 대문자·숫자(7자 이상)야 — 예: T0ABC1234");

export function syncLinkPrefs() {
  const on = $("c-openapp").checked, box = $("c-openapp-svc");
  box.classList.toggle("off", !on);
  for (const cb of box.querySelectorAll("input")) cb.disabled = !on;
  const err = teamIdError($("c-slack-team").value.trim().toUpperCase());
  $("c-slack-team-msg").textContent = err || "";
  $("c-slack-team-msg").style.color = err ? "var(--red)" : "";
}

export function initLinkPrefs() {
  $("c-openapp").addEventListener("change", syncLinkPrefs);
  $("c-slack-team").addEventListener("input", syncLinkPrefs);
}
