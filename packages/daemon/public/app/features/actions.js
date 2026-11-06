/* Item actions menu (⋯) for Jira / GitHub / calendar rows: comment & review drafts, Jira status change, PR approve, RSVP.
 * Every write goes through POST /api/send (gated by config.actions, logged to ~/.ned/sent-actions.log) and always asks once
 * more in the menu before sending. Rows rendered by other modules get the ⋯ button injected (see `inject`), so home.js /
 * calendar.js don't need to know about it; they can call `axBtn(kind, item)` directly instead. */
import { sendAndWait } from "./sendjob.js";
import { ACTION_KO, actionsOn, clean, openDraft } from "./drafts.js";
import { S } from "../state.js";
import { errSummary } from "../ui/popover.js";
import { toast } from "../ui/toast.js";
import { esc } from "../util.js";

// ---------- refs ----------
export const jiraRef = (x) => clean({ url: x.url, key: x.key || /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i.exec(x.url || "")?.[1], title: [x.key, x.title].filter(Boolean).join(" ") || x.title, text: x.status ? `상태: ${x.status}` : x.detail });
export function githubRef(x) {
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(x.url || "");
  return clean({ url: x.url, repo: x.repo || m?.[1], number: x.number != null ? String(x.number) : m?.[2], title: x.title, text: x.detail });
}
/** Google Calendar `eid` = base64("<eventId> <calendarId>") → both ids. */
export function decodeEid(url) {
  const eid = /[?&]eid=([^&#]+)/.exec(url || "")?.[1];
  if (!eid) return {};
  try {
    const b64 = decodeURIComponent(eid).replace(/-/g, "+").replace(/_/g, "/");
    const [event_id, calendar_id] = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)).split(" ");
    return { event_id, calendar_id: calendar_id && calendar_id !== "primary" ? calendar_id.replace(/@m$/, "") : undefined };
  } catch { return {}; }
}
export const calRef = (e) => { const d = decodeEid(e.url); return clean({ url: e.url, event_id: e.id || d.event_id, calendar_id: d.calendar_id, title: e.title, rsvp: e.rsvp }); };
export const REF_OF = { jira: jiraRef, github: githubRef, calendar: calRef };

/** The ⋯ button for one item. `kind` = jira | github | calendar. */
export function axBtn(kind, item) {
  const ref = REF_OF[kind]?.(item);
  if (!ref || (kind === "calendar" && (!ref.event_id || item.rsvp === "organizer"))) return "";
  return `<button type="button" class="ib axb" data-axm="${esc(JSON.stringify({ kind, ref }))}" title="액션 — ${kind === "jira" ? "코멘트·상태 변경" : kind === "github" ? "리뷰·승인" : "참석 응답"}" aria-label="액션 메뉴" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/></svg></button>`;
}

// ---------- menu model ----------
const RSVP_KO = { accepted: "수락", tentative: "미정", declined: "거절" };
/** Items for a kind: { id, label, gate, draft? (opens the draft modal), send? ({mode, ref extra}), confirm, sub? (loads more) } */
export function menuItems(kind, ref) {
  if (kind === "jira") return [
    { id: "jira_comment", label: "코멘트 초안 쓰기…", gate: "jira_comment", draft: "jira", hint: "Ned 가 이슈를 읽고 코멘트 3안을 써 줘 — 보내기 전 한 번 더 확인" },
    { id: "jira_transitions", label: "상태 변경…", gate: "jira_transition", sub: "transitions", hint: "가능한 전환을 먼저 읽어 와 (읽기만)" },
  ];
  if (kind === "github") return [
    { id: "github_draft", label: "리뷰 초안 쓰기…", gate: "github_review", draft: "github", hint: "PR 설명·diff --stat 을 읽고 리뷰 코멘트 3안 — 승인/변경 요청/코멘트는 팝업에서 골라" },
    { id: "github_approve", label: "바로 승인 (코멘트 없이)", gate: "github_review", send: { mode: "approve" }, confirm: true },
  ];
  if (kind === "calendar") return ["accepted", "tentative", "declined"].map((r) => ({ id: `rsvp_${r}`, label: `${RSVP_KO[r]}${ref.rsvp === r ? " (현재)" : ""}`, gate: "calendar_rsvp", send: { mode: "rsvp", ref: { response: r } }, confirm: true }));
  return [];
}
export function confirmText(kind, ref, it) {
  const t = ref.title || ref.key || "";
  if (it.send?.mode === "approve") return `PR ${ref.repo}#${ref.number} 을(를) 승인(Approve)해. GitHub 에 바로 남아.`;
  if (it.send?.mode === "transition") return `Jira ${ref.key} 상태를 '${it.label}' 로 바꿔.`;
  if (it.send?.mode === "rsvp") return `일정 '${t}' 에 '${RSVP_KO[it.send.ref.response]}' 로 응답해. 주최자에게 알림이 가.`;
  return `${t} — ${it.label}`;
}

// ---------- menu state + render ----------
export let AX = { open: false };
let pop = null;
function popEl() {
  if (pop) return pop;
  pop = document.createElement("div");
  pop.id = "axpop"; pop.className = "axpop"; pop.hidden = true; pop.setAttribute("role", "menu");
  document.body.appendChild(pop);
  return pop;
}
export function openMenu(btn, kind, ref) {
  closeMenu(false);
  AX = { open: true, btn, kind, ref, items: menuItems(kind, ref), confirm: null, busy: null, error: "", transitions: null, loadingSub: false };
  btn.setAttribute("aria-expanded", "true");
  renderMenu(); place();
  pop.querySelector("button:not([disabled])")?.focus();
}
export function closeMenu(refocus = true) {
  if (!AX.open) return;
  AX.btn?.setAttribute("aria-expanded", "false");
  const back = AX.btn; AX = { open: false };
  if (pop) pop.hidden = true;
  if (refocus) back?.focus?.();
}
function place() {
  const p = popEl(), b = AX.btn; if (!b?.isConnected) return;
  const r = b.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  p.style.top = `${r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
}
export function renderMenu() {
  const p = popEl(); if (!AX.open) { p.hidden = true; return; }
  const on = actionsOn(), { kind, ref } = AX;
  const head = kind === "jira" ? `Jira ${ref.key || ""}` : kind === "github" ? `${ref.repo || ""}#${ref.number || ""}` : "참석 응답";
  const row = (it) => {
    const off = !on[it.gate];
    const tip = off ? `설정 → 쓰기 액션에서 '${ACTION_KO[it.gate]}' 을 켜야 써` : it.hint || (it.confirm ? "누르면 한 번 더 확인해" : "");
    return `<button type="button" role="menuitem" class="axi${off ? " dis" : ""}" data-axi="${esc(it.id)}" aria-disabled="${off}" title="${esc(tip)}" ${AX.busy ? "disabled" : ""}>${esc(it.label)}${AX.busy === it.id ? ` <span class="spin"></span>` : ""}${off ? `<span class="axoff">꺼짐</span>` : ""}</button>`;
  };
  let body = AX.items.map(row).join("");
  if (AX.loadingSub) body += `<div class="axnote"><span class="spin"></span>가능한 상태 전환 읽는 중… (읽기만)</div>`;
  if (AX.transitions) body += `<div class="axsub" role="group" aria-label="상태 전환">${AX.transitions.length ? AX.transitions.map((t) => row(t)).join("") : `<div class="axnote">가능한 전환 없음.</div>`}</div>`;
  const c = AX.confirm && [...AX.items, ...(AX.transitions || [])].find((x) => x.id === AX.confirm);
  if (c) body += `<div class="axconf" role="alertdialog" aria-label="확인"><div class="tgt">⚠️ ${esc(confirmText(kind, ref, c))}</div>
      <div class="axbtns"><button type="button" class="btn small go" data-axgo="1">확인 — ${esc(c.label)}</button><button type="button" class="btn small" data-axcancel="1">취소</button></div></div>`;
  if (AX.error) body += `<div class="axerr" role="alert">${esc(AX.error)}</div>`;
  p.innerHTML = `<div class="axh">${esc(head)}${ref.title && kind !== "jira" ? `<span>${esc(ref.title)}</span>` : ""}</div>${body}`;
  p.hidden = false;
}

async function send(it) {
  const { kind, ref } = AX;
  AX.busy = it.id; AX.confirm = null; AX.error = ""; renderMenu();
  const body = { source: kind, mode: it.send.mode, ref: { ...ref, ...(it.send.ref || {}) }, text: it.send.text || "" };
  const r = await sendAndWait(body, { label: it.label }); // a daemon job: 202 → poll (features/sendjob.js)
  if (!AX.open) return r;
  AX.busy = null;
  return r;
}
async function loadTransitions() {
  AX.loadingSub = true; AX.error = ""; renderMenu(); place();
  const r = await sendAndWait({ source: "jira", mode: "transitions", ref: AX.ref }, { label: "Jira 전환 목록" });
  if (!AX.open) return;
  AX.loadingSub = false;
  const list = r.data?.transitions;
  if (Array.isArray(list)) AX.transitions = list.map((t) => ({ id: `tr_${t.id}`, label: t.to && t.to !== t.name ? `${t.name} → ${t.to}` : t.name, gate: "jira_transition", confirm: true, send: { mode: "transition", ref: { transition_id: t.id, transition_name: t.name } } }));
  else AX.error = r.status === 403 ? "'Jira 상태 변경' 이 설정에서 꺼져 있어 (HTTP 403)." : `전환 목록을 못 읽었어: ${errSummary(r.data?.detail || r.data?.error || `HTTP ${r.status}`)}`;
  renderMenu(); place();
}
export async function pick(id) {
  const it = [...AX.items, ...(AX.transitions || [])].find((x) => x.id === id); if (!it) return;
  if (!actionsOn()[it.gate]) { toast(`설정 → 쓰기 액션에서 '${ACTION_KO[it.gate]}' 을 켜야 해.`); return; }
  if (it.draft) { const { ref } = AX; closeMenu(false); openDraft(it.draft, ref); return; }
  if (it.sub === "transitions") { if (!AX.transitions) loadTransitions(); return; }
  if (it.confirm && AX.confirm !== it.id) { AX.confirm = it.id; renderMenu(); place(); pop.querySelector("[data-axgo]")?.focus(); return; }
  const r = await send(it);
  if (!AX.open) { // menu closed while the job ran — still say how it ended
    if (r.ok && r.data?.ok !== false) toast(`${it.label} 완료 — ${r.data?.detail || ""}`, 6000);
    else toast(`${it.label} ${r.unknown ? "결과 확인 못 함" : "실패"} — ${errSummary(r.data?.detail || r.data?.error || `HTTP ${r.status || "network"}`)}`, 9000);
    return;
  }
  if (r.ok && r.data?.ok !== false) { toast(r.data?.detail || `${it.label} 완료.`, 5000); closeMenu(); return; }
  AX.error = r.status === 403 ? `'${ACTION_KO[it.gate]}' 은 설정에서 꺼져 있어 (daemon 이 거절함, HTTP 403).`
    : String(r.data?.action || "").startsWith("dry_run:") ? `dry-run — 실행하지 않았어 (${r.data.detail}).`
    : r.status === 409 && r.data?.already_sent ? `이미 했어 — ${r.data.detail}`
    : `${it.label} ${r.unknown ? "결과 확인 못 함" : "실패"}: ${errSummary(r.data?.detail || r.data?.error || `HTTP ${r.status || "network"}`)}`;
  renderMenu(); place();
}

// ---------- inject ⋯ into rows other modules render ----------
const JIRA_RE = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9_]*-\d+/i, GH_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const CAL_RE = /^https:\/\/(www\.)?(google\.com\/calendar|calendar\.google\.com)\/.*[?&]eid=/;
/** Calendar events Ned knows (agenda window + fetched ranges), by url. */
function calByUrl() {
  const m = new Map();
  for (const e of [...(S.agenda?.calendar || []), ...Object.values(S.calRanges || {}).flatMap((r) => r.cal || [])]) if (e?.url) m.set(e.url, e);
  return m;
}
export function inject(root = document) {
  let cal = null;
  // Jira / GitHub rows: `.ti` with a `.ra` actions cell and a title link.
  for (const ti of root.querySelectorAll(".ti")) {
    const ra = ti.querySelector(":scope > .ra"); if (!ra || ra.querySelector(".axb")) continue;
    const href = ti.querySelector(".mn a[href]")?.getAttribute("href") || "";
    const kind = JIRA_RE.test(href) ? "jira" : GH_RE.test(href) ? "github" : CAL_RE.test(href) ? "calendar" : null;
    if (!kind) continue;
    const key = ti.querySelector(".key")?.textContent || "";
    const item = kind === "jira" ? (S.agenda?.jira || []).find((j) => j.url === href) || { url: href, key: /^[A-Z]/.test(key) ? key : undefined, title: ti.querySelector(".tt")?.textContent }
      : kind === "github" ? (S.agenda?.github || []).find((g) => g.url === href) || { url: href, title: ti.querySelector(".tt")?.textContent }
      : (cal ||= calByUrl()).get(href) || { url: href, title: ti.querySelector(".tt")?.textContent };
    const b = axBtn(kind, item); if (b) ra.insertAdjacentHTML("afterbegin", b);
  }
  // Calendar day view: all-day rows and timed blocks' first line.
  for (const row of root.querySelectorAll(".allday .ad, .cev .t1")) {
    if (row.querySelector(".axb")) continue;
    const href = row.querySelector(".tt a[href]")?.getAttribute("href") || "";
    if (!CAL_RE.test(href)) continue;
    const e = (cal ||= calByUrl()).get(href) || { url: href, title: row.querySelector(".tt")?.textContent };
    const b = axBtn("calendar", e); if (b) row.insertAdjacentHTML("beforeend", b);
  }
}

const CSS = `
.axb { margin-left: 2px; }
.ad .axb, .t1 .axb { width: 20px; height: 18px; margin-left: auto; flex: none; }
.cev .t1 { display: flex; align-items: center; gap: 4px; }
.axpop { position: fixed; z-index: 60; min-width: 220px; max-width: 340px; padding: 6px; border: 1px solid var(--line, #8884); border-radius: 10px; background: var(--pane, #fff); color: var(--text, inherit); box-shadow: 0 8px 28px #0003; font-size: 13px; }
.axpop .axh { padding: 4px 8px 6px; font-weight: 600; font-size: 12px; color: var(--dim); display: flex; flex-direction: column; gap: 2px; }
.axpop .axh span { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.axpop .axi { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.axpop .axi:hover:not([disabled]), .axpop .axi:focus-visible { background: color-mix(in srgb, var(--hero, #48f) 12%, transparent); outline: none; }
.axpop .axi.dis { opacity: .5; cursor: not-allowed; }
.axpop .axoff { margin-left: auto; font-size: 11px; color: var(--dim); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
.axpop .axsub { margin: 4px 0 2px 10px; padding-left: 6px; border-left: 2px solid color-mix(in srgb, var(--hero, #48f) 40%, transparent); }
.axpop .axnote { padding: 6px 8px; color: var(--dim); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.axpop .axconf { margin-top: 6px; padding: 8px; border: 1px solid var(--hero, #48f); border-radius: 8px; background: color-mix(in srgb, var(--hero, #48f) 10%, var(--pane, #fff)); }
.axpop .axconf .tgt { font-weight: 600; margin-bottom: 6px; }
.axpop .axbtns { display: flex; gap: 6px; }
.axpop .axerr { margin-top: 6px; padding: 6px 8px; border-radius: 6px; color: var(--red, #c33); background: color-mix(in srgb, var(--red, #c33) 10%, transparent); font-size: 12px; }
`;

/** Called once from drafts.js init (main.js's init list isn't this module's to edit). */
export function init() {
  const st = document.createElement("style"); st.id = "ax-css"; st.textContent = CSS; document.head.appendChild(st);
  popEl();
  let queued = false;
  const run = () => { queued = false; inject(); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(document.body, { childList: true, subtree: true });
  inject();
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".axb[data-axm]");
    if (b) {
      e.preventDefault(); e.stopPropagation();
      if (AX.open && AX.btn === b) return closeMenu();
      try { const { kind, ref } = JSON.parse(b.dataset.axm); openMenu(b, kind, ref); } catch (err) { console.warn("ax ref", err); }
      return;
    }
    if (!AX.open) return;
    if (!e.target.closest("#axpop")) return closeMenu(false);
    const i = e.target.closest("[data-axi]"); if (i) return pick(i.dataset.axi);
    if (e.target.closest("[data-axgo]")) return pick(AX.confirm);
    if (e.target.closest("[data-axcancel]")) { AX.confirm = null; renderMenu(); }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!AX.open || e.key !== "Escape") return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (AX.confirm) { AX.confirm = null; renderMenu(); } else closeMenu();
  }, true);
  window.addEventListener("resize", () => AX.open && place());
  document.addEventListener("scroll", () => AX.open && place(), true);
}
