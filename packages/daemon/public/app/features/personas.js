/* Persona voice table, marks, applyPersona, Ned's speech bubble, mood and opener line. */
import { openAtt } from "./reviewed.js";
import { renderAll } from "../main.js";
import { S, alive } from "../state.js";
import { $, lsSet, rel } from "../util.js";
export const QUIPS = [
  "새 소식 없음. 모니터만 반짝이고 있어.",
  "받은편지함 평화로움. 키보드 소리만 들려.",
  "이상 무. 커피 식기 전에 하던 거 마저 해.",
  "레이더 깨끗함. 내가 계속 보고 있을게.",
];

/** Small glasses for Ned's avatar (no mood effects; the header mark carries the mood). */
// ---------- persona voice (config.persona → state.persona). Tone only: same data, same features. ----------
export const VOICE = {
  ned: {
    name: "Ned", spk: "ned", tagline: "친한 동료 반말 · 딥 네이비 + 빨강/파랑 · 거미줄·웹 코너", sample: "결재 2건이랑 리뷰 1건 기다려. 결재부터 보자.",
    mood: { scanning: "스캔 중", offline: "자리 비움", headsup: "헤이, 이거 봐", quiet: "조용한 시간", idle: "지켜보는 중" },
    greet: (h) => (h < 5 ? "늦게까지 하네." : h < 12 ? "좋은 아침." : h < 18 ? "오후 체크인." : "저녁 체크인."),
    noMeet: "오늘은 회의 없음. 딥워크 데이.", allDone: (n) => `오늘 회의 ${n}개 다 끝났어.`,
    meet: ({ left, cur, next, first }) => `회의 ${left}개${cur ? `, 지금 '${cur}' 중` : ""}${next ? `, ${first ? "첫" : "다음"} 미팅 ${next}` : ""}.`,
    count: (label, n, unit) => `${label} ${n}${unit}`, wait: (w) => `${w.join(", ")} 기다려.`,
    ask: (n) => `응답 안 한 초대 ${n}건`, held: (n) => `내가 챙겨 둔 거 ${n}건`, todo: (n, over) => `네 할 일 ${n}개${over ? ` (마감 지난 거 ${over}개)` : ""}`,
    noAgenda: "일정은 아직 못 받아 왔어.",
    okRun: (n, ago) => `✓ NED_OK ×${n} · 마지막 ${ago} — 조용한 순찰은 접어 뒀어`,
    settings: ["여기서 내 근무 시간이랑 볼 곳을 정해 줘.", "저장하면 다음 순찰부터 적용돼. 쓰기 권한은 어차피 없으니 걱정 마."],
  },
  alfred: {
    name: "Alfred", spk: "alfred", tagline: "정중한 존댓말 집사 · 블랙 + 금색 하나 · 고딕 격자·스포트라이트", sample: "결재 두 건과 리뷰 한 건이 기다리고 있습니다. 결재부터 보시지요.",
    mood: { scanning: "살피는 중", offline: "자리 비움", headsup: "확인하실 일이 있습니다", quiet: "쉬시는 시간", idle: "대기 중" },
    greet: (h) => (h < 5 ? "늦은 시간까지 수고가 많으십니다." : h < 12 ? "좋은 아침입니다." : h < 18 ? "오후 보고 올립니다." : "저녁 보고 올립니다."),
    noMeet: "오늘은 회의가 없습니다. 집중하시기 좋은 날입니다.", allDone: (n) => `오늘 회의 ${n}건은 모두 마치셨습니다.`,
    meet: ({ left, cur, next, first }) => [`남은 회의 ${left}건`, cur ? `지금 '${cur}' 진행 중` : "", next ? `${first ? "첫" : "다음"} 회의 ${next}` : ""].filter(Boolean).join(", ") + "입니다.",
    count: (label, n, unit) => `${label} ${n}${unit}`, wait: (w) => `${w.join(", ")}이 기다리고 있습니다.`,
    ask: (n) => `회신 안 하신 초대 ${n}건`, held: (n) => `제가 챙겨 둔 일 ${n}건`, todo: (n, over) => `할 일 ${n}건${over ? ` (기한 지남 ${over}건)` : ""}`,
    noAgenda: "일정은 아직 받아 오지 못했습니다.",
    okRun: (n, ago) => `✓ NED_OK ×${n} · 마지막 ${ago} — 아뢸 일 없는 순찰은 접어 두었습니다`,
    settings: ["근무 시간과 살필 곳을 정해 주십시오.", "저장하시면 다음 순찰부터 적용됩니다. 쓰기 권한은 없으니 염려 마십시오."],
  },
  oracle: {
    name: "Oracle", spk: "oracle", tagline: "간결한 관제 무전 · 블랙 + 초록/보라 모노 · 모니터 타일", sample: "[오늘] 결재 2 · 리뷰 1 대기. 결재 우선.",
    mood: { scanning: "스캔", offline: "신호 없음", headsup: "확인 요망", quiet: "무음 시간", idle: "감시 중" },
    greet: (h) => (h < 5 ? "[야간]" : h < 12 ? "[오전 보고]" : h < 18 ? "[오후 보고]" : "[야간 보고]"),
    noMeet: "회의 0. 집중 시간 확보.", allDone: (n) => `회의 ${n} 종료.`,
    meet: ({ left, cur, next, first }) => [`회의 ${left} 남음`, cur ? `진행 중 '${cur}'` : "", next ? `${first ? "첫" : "다음"} ${next}` : ""].filter(Boolean).join(" · ") + ".",
    count: (label, n) => `${label} ${n}`, wait: (w) => `대기: ${w.join(" · ")}.`,
    ask: (n) => `RSVP 대기 ${n}`, held: (n) => `보류 항목 ${n}`, todo: (n, over) => `개인 할 일 ${n}${over ? ` (기한 초과 ${over})` : ""}`,
    noAgenda: "일정 수신 없음.",
    okRun: (n, ago) => `✓ NED_OK ×${n} · 최종 ${ago} — 특이사항 없음, 접음`,
    settings: ["근무 시간 · 감시 대상 설정.", "저장 시 다음 순찰부터 적용. 쓰기 권한 없음."],
  },
  jarvis: {
    name: "Jarvis", spk: "jarvis", tagline: "매끄러운 존댓말 + 수치 보고 · 네이비 + 시안 글로우 · HUD", sample: "대기 항목 3건, 그중 결재 2건이 우선입니다. 처리하시면 대기율 0%예요.",
    mood: { scanning: "분석 중", offline: "연결 끊김", headsup: "확인 필요", quiet: "방해 금지", idle: "모니터링 중" },
    greet: (h) => (h < 5 ? "늦은 시간이네요." : h < 12 ? "좋은 아침이에요." : h < 18 ? "오후 현황입니다." : "저녁 현황입니다."),
    noMeet: "오늘 회의 0건, 집중 가능 시간 100%예요.", allDone: (n) => `오늘 회의 ${n}건 모두 완료, 진척률 100%.`,
    meet: ({ left, cur, next, first }) => [`남은 회의 ${left}건`, cur ? `현재 '${cur}' 진행 중` : "", next ? `${first ? "첫" : "다음"} 회의 ${next}` : ""].filter(Boolean).join(", ") + "이에요.",
    count: (label, n, unit) => `${label} ${n}${unit}`,
    wait: (w) => { const total = w.reduce((a, x) => a + (Number(/(\d+)/.exec(x)?.[1]) || 0), 0); return `대기 항목 ${total}건 — ${w.join(", ")}.`; },
    ask: (n) => `미응답 초대 ${n}건`, held: (n) => `제가 표시해 둔 항목 ${n}건`, todo: (n, over) => `할 일 ${n}건${over ? ` (기한 초과 ${over}건)` : ""}`,
    noAgenda: "일정 데이터가 아직 없어요.",
    okRun: (n, ago) => `✓ NED_OK ×${n} · 마지막 ${ago} — 변동 없는 순찰은 접어 뒀어요`,
    settings: ["근무 시간과 모니터링 범위를 설정해 주세요.", "저장하면 다음 순찰부터 반영돼요. 쓰기 권한은 없으니 안심하세요."],
  },
};
export const PERSONA_IDS = Object.keys(VOICE);
export let persona = PERSONA_IDS.includes(document.documentElement.dataset.persona) ? document.documentElement.dataset.persona : "ned";
export const V = () => VOICE[persona];
// Marks live in marks/<id>.svg and are inlined so CSS (mood states, tokens) reaches their parts.
export const MARK_SRC = {};
export async function loadMark(id) {
  if (MARK_SRC[id] === undefined) {
    try { const r = await fetch(`marks/${id}.svg`); MARK_SRC[id] = r.ok ? await r.text() : ""; } catch { MARK_SRC[id] = ""; }
  }
  return MARK_SRC[id];
}
/** Inline SVG string for a mark: `hd` keeps the mood parts (sweep / ! / moon); the mini copy drops them. */
export function markSvg(id, hd) {
  const src = MARK_SRC[id]; if (!src) return "";
  const svg = new DOMParser().parseFromString(src, "image/svg+xml").documentElement;
  if (svg.nodeName !== "svg") return "";
  svg.setAttribute("class", hd ? "mark hd" : "mark");
  svg.setAttribute("aria-hidden", "true");
  if (!hd) for (const el of svg.querySelectorAll("defs, .sweep, .bang, .moon, [clip-path]")) el.remove();
  for (const n of [...svg.childNodes]) if (n.nodeType === 8) n.remove(); // comments
  return svg.outerHTML;
}
export async function applyPersona(id, { save = true } = {}) {
  if (!PERSONA_IDS.includes(id)) id = "ned";
  const changed = id !== persona || !MARK_SRC[id];
  persona = id;
  document.documentElement.dataset.persona = id;
  if (save) lsSet("ned.persona", id);
  document.title = V().name;
  $("pname").textContent = V().name;
  if (!changed) return;
  await Promise.all(PERSONA_IDS.map(loadMark));
  const hd = markSvg(id, true);
  if (hd) { const old = document.querySelector(".who .mark.hd"); if (old) old.outerHTML = hd; }
  MINI = markSvg(id, false) || MINI;
  for (const el of document.querySelectorAll("[data-mark]")) el.innerHTML = markSvg(el.dataset.mark, false);
  renderAll();
}

export let MINI = `<svg class="mark" viewBox="0 14 64 40" aria-hidden="true"><circle class="frame" cx="20" cy="34" r="10"/><circle class="frame" cx="44" cy="34" r="10"/><path class="frame" d="M30 33q2-3.5 4 0M10 31 5 26M54 31l5-5"/><path class="glint" d="M14.5 30.5a6.5 6.5 0 0 1 5-4M38.5 30.5a6.5 6.5 0 0 1 5-4"/></svg>`;
/** Ned speaking: avatar + bubble. `lead` is HTML-escaped by the caller. */
export const say = (meta, leadHtml, subHtml = "") =>
  (meta = typeof meta === "string" ? meta.replace(/^ned\b/, V().spk) : meta,
  `<div class="say"><span class="av">${MINI}</span><div class="bubble">${meta ? `<div class="meta">${meta}</div>` : ""}<p class="lead">${leadHtml}</p>${subHtml ? `<div class="sub">${subHtml}</div>` : ""}</div></div>`);

// ---------- persona ----------
export function mood() {
  if (S.busy || S.agBusy || S.drafting) return "scanning";
  if (!alive()) return "offline";
  if (openAtt().length) return "headsup";
  if (S.state.quiet) return "quiet";
  return "idle";
}
export const greet = () => V().greet(new Date().getHours());
export const quip = (ts) => QUIPS[Math.floor((ts || Date.now()) / 600000) % QUIPS.length];

/** The one line Ned opens with — what needs you, in one breath. */
export function opener() {
  const s = S.state;
  if (S.busy) return { lead: S.busy.daily ? "아침 브리핑 정리하는 중. 1~3분이면 돌아올게." : "순찰 도는 중. 1~3분이면 돌아올게.", sub: "그동안 하던 거 해도 돼." };
  if (S.conn === false) return { lead: "연결이 끊겼어.", sub: "daemon 이 꺼졌는지 확인해 줘. 10초마다 다시 불러볼게." };
  if (!s) return { lead: "불러오는 중…", sub: "" };
  if (!alive()) return { lead: "나 잠깐 졸았나 봐.", sub: `마지막 갱신 ${rel(s.updated_at)}. daemon 이 멈췄을 수 있어.` };
  const open = openAtt(), sess = open.filter((a) => a.source === "sessions").length, sig = open.length - sess;
  if (open.length) {
    const bits = [];
    if (sess) bits.push(`에이전트 ${sess}명이 너를 찾아`);
    if (sig) bits.push(`챙길 신호 ${sig}건`);
    const latest = S.briefings.find((b) => b.status === "UPDATE");
    return { lead: `${greet()} ${bits.join(", ")}.`, sub: latest?.headline ? `요약하면: ${latest.headline}` : "" };
  }
  if (s.quiet) return { lead: "조용한 시간이야. 급한 것만 깨울게.", sub: `다음 순찰 ${rel(s.next_heartbeat_at)}.` };
  return { lead: `${greet()} ${quip(s.last_heartbeat_at)}`, sub: `다음 순찰 ${rel(s.next_heartbeat_at)}.` };
}
