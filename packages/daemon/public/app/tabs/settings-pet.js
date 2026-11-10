/* 설정 → 외형 → 데스크톱 펫 (config.pet.enabled · pet.messages.<kind>). Saves with the form (readPet → PUT /api/config { pet });
 * Ned.app follows state.json / GET /api/feed and shows or hides the pet right away. Kind checkboxes dim while the pet is off
 * (values kept); Sentry dims while 소스 → Sentry is off. 위치 초기화 only inside Ned.app (webkit messageHandlers.pet). */
import { toast } from "../ui/toast.js";
import { $, esc } from "../util.js";

/** = src/config.ts PET_MESSAGE_KINDS, in the same order. */
export const PET_MESSAGE_KINDS = ["greeting", "session", "slack", "mail", "jira", "github", "sentry", "calendar", "briefing"];
export const PET_KIND_KO = {
  greeting: ["인사", "하루 한 번, 그날 처음 켤 때 페르소나 인사"],
  session: ["작업", "세션 입력 기다림 · 오류"],
  slack: ["Slack", "멘션 · DM · 따라가는 스레드의 새 답글"],
  mail: ["메일", "답할 메일"],
  jira: ["Jira", "내 이슈 · 리뷰 요청"],
  github: ["GitHub", "PR 리뷰 요청 · 코멘트"],
  sentry: ["Sentry", "새 오류"],
  calendar: ["캘린더", "곧 시작하는 회의"],
  briefing: ["브리핑", "아침 브리핑 · 순찰 새 소식"],
};

export function petHtml() {
  return PET_MESSAGE_KINDS.map((k) => `<label title="${esc(PET_KIND_KO[k][1])}"><input type="checkbox" data-petmsg="${k}">${esc(PET_KIND_KO[k][0])}</label>`).join("");
}

export function renderPet(c) {
  const p = c?.pet || {};
  if (!$("c-pet-msgs").children.length) $("c-pet-msgs").innerHTML = petHtml();
  $("c-pet-on").checked = p.enabled === true;
  for (const cb of document.querySelectorAll("[data-petmsg]")) cb.checked = p.messages?.[cb.dataset.petmsg] !== false;
  $("c-pet-reset").hidden = !window.webkit?.messageHandlers?.pet;
  syncPet();
}

export function readPet() {
  const messages = Object.fromEntries(PET_MESSAGE_KINDS.map((k) => [k, true]));
  for (const cb of document.querySelectorAll("[data-petmsg]")) messages[cb.dataset.petmsg] = cb.checked;
  return { enabled: $("c-pet-on").checked, messages };
}

/** Pet off → the kind list dims (values kept and saved). Sentry source off → its box dims too. */
export function syncPet() {
  const on = $("c-pet-on").checked, box = $("c-pet-msgs");
  box.classList.toggle("off", !on);
  const sentrySrc = document.querySelector('[data-src="sentry"]');
  for (const cb of box.querySelectorAll("input")) {
    const srcOff = cb.dataset.petmsg === "sentry" && !!sentrySrc && !sentrySrc.checked;
    cb.disabled = !on || srcOff;
    cb.closest("label").title = srcOff ? "소스 → Sentry 가 꺼져 있어 — 값은 그대로 보존돼" : PET_KIND_KO[cb.dataset.petmsg][1];
  }
}

export function initPet() {
  $("c-pet-on").addEventListener("change", syncPet);
  $("c-sources").addEventListener("change", (e) => { if (e.target.dataset?.src === "sentry") syncPet(); });
  $("c-pet-reset").addEventListener("click", (e) => {
    e.preventDefault();
    const h = window.webkit?.messageHandlers?.pet;
    if (!h) return;
    h.postMessage({ op: "resetPosition" });
    toast("펫을 기본 위치(화면 오른쪽 아래)로 옮겼어.");
  });
}
