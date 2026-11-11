/* Inbox tab: model (attention + briefings), tabs, list rows, detail pane, session rail. */
import { api } from "../api.js";
import { draftBtn, mailRef, sessionRef, slackRef } from "../features/drafts.js";
import { bfFailed, bfKind } from "../features/dailyfail.js";
import { V, opener, quip, say } from "../features/personas.js";
import { openAtt, srcKey } from "../features/reviewed.js";
import { canReply, inDialog, keepFocus, replyBox, replyMenu, replyOn, replySig } from "../features/sessreply.js";
import { loadState, renderHeader } from "../main.js";
import { S, alive, saveRead, subscribe, ui } from "../state.js";
import { PF, PILL_KINDS, pillRow, srcOn } from "../ui/chips.js";
import { EVENT_KO, KIND_ICON, KIND_KO, STATUS_KO, STATUS_LED, iconBtn, openIcon, reviewIcon } from "../ui/icons.js";
import { toast } from "../ui/toast.js";
import { $, dayLabel, esc, hhmm, lsSet, mdhm, rel, safeUrl } from "../util.js";

// ---------- inbox model ----------
export function model() {
  const s = S.state || { attention: [], sessions: [] };
  const sessBy = Object.fromEntries(s.sessions.map((x) => [x.id, x]));
  const pri = s.attention.map((a) => {
    const sess = a.source === "sessions" ? sessBy[a.id.replace(/^session:/, "")] : null;
    return { key: a.id, att: a, kind: a.kind, title: a.title, detail: a.detail, url: safeUrl(a.url), ts: a.ts, led: sess ? STATUS_LED[sess.status] : "a", sess, briefing: S.briefings.find((b) => b.id === a.source) };
  });
  const other = [];
  for (const b of S.briefings) {
    if (b.status !== "UPDATE") continue;
    for (const [sec, label] of [["updates", "업데이트"], ["fyi", "참고"]]) (b[sec] || []).forEach((x, i) =>
      other.push({ key: `${b.id}:${sec}:${i}`, kind: x.kind || "other", title: x.title, detail: x.detail, url: safeUrl(x.url), ts: b.ts, label, briefing: b, rk: srcKey(x.kind, { url: x.url }) }));
  }
  other.sort((a, b) => b.ts - a.ts);
  // History: UPDATE briefings one per row; consecutive NED_OK runs fold into one row. A failed run (claude error /
  // unparsable answer) is not "이상 무": it gets its own row.
  const hist = [];
  for (const b of [...S.briefings].sort((a, z) => z.ts - a.ts)) {
    const last = hist[hist.length - 1];
    const quiet = b.status === "NED_OK" && !bfFailed(b);
    if (quiet && last && last.okrun) { last.okrun.push(b); continue; }
    if (quiet) hist.push({ key: `ok:${b.id}`, okrun: [b], ts: b.ts });
    else hist.push({ key: `bf:${b.id}`, brief: b, ts: b.ts });
  }
  const ok = S.briefings.filter((b) => b.status === "NED_OK" && !bfFailed(b));
  const priOpen = pri.filter((x) => !x.att.reviewed_at), priRev = pri.filter((x) => x.att.reviewed_at);
  for (const x of other) x.rat = x.rk ? (S.agenda?.reviewed || {})[x.rk] || 0 : 0; // source items: same marks as the cards
  const otherOpen = other.filter((x) => !x.rat), otherRev = other.filter((x) => x.rat);
  return { pri, priOpen, priRev, other, otherOpen, otherRev, hist, ok };
}
// 우선: open items first; 확인 완료 ones only when their fold is open (so j/k walks the open ones).
export const isRevRow = (it) => !!(it.att ? it.att.reviewed_at : it.rat);
export const tabRaw = (m) => (ui.tab === "priority" ? [...m.priOpen, ...(ui.revOpenInbox ? m.priRev : [])] : ui.tab === "other" ? [...m.otherOpen, ...(ui.revOpenOther ? m.otherRev : [])] : m.hist);
export const briefKinds = (b) => new Set([...(b.action_items || []), ...(b.updates || []), ...(b.fyi || [])].map((x) => x.kind).filter(Boolean));
export const rowKinds = (it) => (it.okrun ? [] : it.brief ? [...briefKinds(it.brief)] : [it.kind]);
/** The current tab's rows after the inbox source pills — j/k, Enter and selection all use this list. */
export const listOf = (m) => { const raw = tabRaw(m); return PF.inbox.size ? raw.filter((it) => rowKinds(it).some((k) => PF.inbox.has(k))) : raw; };

export function renderTabs(m) {
  const t = (id, label, n, hot) => `<button class="tab ${ui.tab === id ? "on" : ""}" role="tab" aria-selected="${ui.tab === id}" data-t="${id}">${label}<span class="n ${hot ? "hot" : ""}">${n}</span></button>`;
  $("tabs").innerHTML = t("priority", "우선", m.priOpen.length, m.priOpen.length > 0) + t("other", "기타", m.other.length) + t("history", "기록", S.briefings.length);
  for (const b of $("tabs").children) b.onclick = () => setTab(b.dataset.t);
}
export function setTab(t) { ui.tab = t; ui.sel = 0; ui.selKey = null; renderInbox(); }

export function rowHtml(it, i) {
  const sel = i === ui.sel ? "sel" : "";
  if (it.okrun) {
    const r = it.okrun, first = r[r.length - 1];
    return `<div class="row okr ${sel}" data-i="${i}"><span class="ic">✓</span><span class="tt"><span class="stk g flat">ned_ok ×${r.length}</span>&nbsp; 이상 무</span><span class="tm">${hhmm(it.ts)}</span><span class="sb">${r.length > 1 ? `${hhmm(first.ts)}–${hhmm(it.ts)} 순찰 ${r.length}번, 전부 조용` : "순찰 한 번, 조용"}</span></div>`;
  }
  if (it.brief) {
    const b = it.brief, n = (b.action_items?.length || 0), u = (b.updates?.length || 0), f = (b.fyi?.length || 0);
    return `<div class="row ${sel}" data-i="${i}"><span class="ic">📝</span><span class="tt"><span class="stk ${bfFailed(b) ? "r" : b.type === "daily" ? "b" : ""} flat">${bfKind(b)}</span>&nbsp; ${esc(b.headline || (bfFailed(b) ? "Claude 실행 실패 — raw 참고" : `${n + u + f}건`))}</span><span class="tm">${hhmm(b.ts)}</span><span class="sb">행동 ${n} · 업데이트 ${u} · 참고 ${f}${b.cost_usd != null ? ` · $${Number(b.cost_usd).toFixed(2)}` : ""}</span></div>`;
  }
  const acts = it.att ? `${openIcon(it.url)}${reviewIcon(it.att)}` : `${openIcon(it.url)}${it.rk ? reviewIcon({ id: it.rk, reviewed_at: it.rat }) : ""}`;
  return `<div class="row ${sel} ${!it.att && ui.read.has(it.key) ? "read" : ""}${isRevRow(it) ? " reviewed" : ""}${acts ? " has-acts" : ""}" data-i="${i}">
      <span class="ic">${KIND_ICON[it.kind] || "·"}</span>
      <span class="tt">${it.led ? `<span class="led ${it.led}"></span>` : ""}${esc(it.title)}</span>
      <span class="tm">${rel(it.ts)}</span>
      <span class="sb">${esc(it.label ? it.label + " · " : "")}${esc(it.detail || KIND_KO[it.kind] || "")}</span>${acts ? `<span class="racts">${acts}</span>` : ""}</div>`;
}

export function renderInbox() {
  const m = model(), list = listOf(m);
  renderTabs(m);
  const cnt = {};
  for (const it of tabRaw(m)) for (const k of rowKinds(it)) cnt[k] = (cnt[k] || 0) + 1;
  $("pf-inbox").innerHTML = pillRow("inbox", cnt, PILL_KINDS.filter((k) => k !== "me" && srcOn(k)));
  if (ui.selKey) { const i = list.findIndex((x) => x.key === ui.selKey); if (i >= 0) ui.sel = i; }
  ui.sel = Math.max(0, Math.min(ui.sel, list.length - 1));
  ui.selKey = list[ui.sel]?.key ?? null;

  let html = "", lastDay = "";
  const revList = ui.tab === "priority" ? m.priRev : ui.tab === "other" ? m.otherRev : [], foldOpen = ui.tab === "other" ? !!ui.revOpenOther : !!ui.revOpenInbox;
  const revN = (PF.inbox.size ? revList.filter((it) => rowKinds(it).some((k) => PF.inbox.has(k))) : revList).length;
  const fold = `<button type="button" class="revfold-row" id="revfold" aria-expanded="${foldOpen}">${foldOpen ? "▾" : "▸"} 확인 완료 ${revN}</button>`;
  let folded = false;
  list.forEach((it, i) => {
    if (revN && !folded && isRevRow(it)) { html += fold; folded = true; lastDay = ""; }
    const day = dayLabel(it.ts);
    if (day !== lastDay) { html += `<div class="grp">${esc(day)}</div>`; lastDay = day; }
    html += rowHtml(it, i);
  });
  if (revN && !folded) html += fold;
  if (!list.length && !revN) html += `<div class="none">${PF.inbox.size ? "선택한 소스엔 없음." : ui.tab === "priority" ? "결정할 것 없음." : ui.tab === "other" ? "읽을 것 없음." : "아직 순찰 기록이 없어."}</div>`;
  if (ui.tab !== "history" && m.ok.length) html += `<button class="okrun" id="okrun">${esc(V().okRun(m.ok.length, rel(m.ok[0].ts)))}</button>`;
  const box = $("items");
  box.innerHTML = html;
  for (const r of box.querySelectorAll(".row")) r.onclick = () => { select(+r.dataset.i); openDetail(); };
  const ok = $("okrun"); if (ok) ok.onclick = () => setTab("history");
  const rf = $("revfold"); if (rf) rf.onclick = () => { if (ui.tab === "other") ui.revOpenOther = !ui.revOpenOther; else ui.revOpenInbox = !ui.revOpenInbox; renderInbox(); };
  box.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  renderDetail(list[ui.sel], m);
  renderSessions();
}

export function select(i) {
  const list = listOf(model());
  ui.sel = Math.max(0, Math.min(i, list.length - 1));
  ui.selKey = list[ui.sel]?.key ?? null;
  renderInbox();
}
export function openDetail() { $("detail").classList.add("open"); }
export function closeDetail() { $("detail").classList.remove("open"); }

// ---------- detail ----------
export function sectionList(title, xs) {
  if (!xs || !xs.length) return "";
  return `<h3>${esc(title)}</h3><ul>${xs.map((x) => {
      const u = safeUrl(x.url);
      return `<li>${KIND_ICON[x.kind] ? KIND_ICON[x.kind] + " " : ""}${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}${x.detail ? `<div class="d">${esc(x.detail)}</div>` : ""}</li>`;
    }).join("")}</ul>`;
}
export const bfLabel = (b) => `${b.type === "daily" ? "아침 브리핑" : "점검"}${bfFailed(b) ? " 실패" : ""} · ${dayLabel(b.ts)} ${hhmm(b.ts)}`;
export const costLine = (b) => `<dl class="kv"><dt>id</dt><dd class="mono">${esc(b.id)}</dd>${b.cost_usd != null ? `<dt>비용</dt><dd class="mono">$${Number(b.cost_usd).toFixed(3)}</dd>` : ""}</dl>${b.raw ? `<h3>raw</h3><pre class="raw">${esc(b.raw)}</pre>` : ""}`;

export function briefingSay(b) {
  if (bfFailed(b)) return say(`ned · ${esc(bfLabel(b))} · <span class="stk r flat">실패</span>`, esc("Claude 실행이 실패했거나 답을 못 읽었어. 아래 raw 참고."));
  const ok = b.status === "NED_OK";
  const lead = b.headline || (ok ? quip(b.ts) : "몇 가지 챙겨 왔어.");
  return say(`ned · ${esc(bfLabel(b))} · <span class="stk ${ok ? "g" : "a"} flat">${ok ? "ned_ok" : "update"}</span>`, esc(lead));
}

export function renderDetail(it, m) {
  const box = $("detail");
  const back = `<button class="btn small back" id="back">← 목록</button>`;
  let sig, html;
  if (!it) {
    const o = opener();
    sig = `zero:${ui.tab}:${o.lead}:${o.sub}:${m.ok.length}`;
    const lead = ui.tab === "priority" ? (openAtt().length === 0 && alive() ? `처리할 거 없어. ${quip(S.state?.last_heartbeat_at)}` : o.lead) : ui.tab === "other" ? "읽을 거 없어. 조용한 하루." : "아직 순찰 기록이 없어.";
    html = `<div class="zero">${say("ned", esc(lead), `다음 순찰 ${esc(rel(S.state?.next_heartbeat_at))} · NED_OK ${m.ok.length}회`)}</div>`;
    if (sig !== ui.detailSig) { box.innerHTML = html; ui.detailSig = sig; }
    closeDetail();
    return;
  }
  if (it.okrun) {
    const r = it.okrun;
    sig = `ok:${r.map((b) => b.id).join(",")}`;
    html = `<div class="dwrap">${back}
        <div class="crumb"><span class="stk g">ned_ok ×${r.length}</span><span>${esc(dayLabel(it.ts))} ${hhmm(r[r.length - 1].ts)}–${hhmm(it.ts)}</span></div>
        <h2>조용한 순찰 ${r.length}번</h2>
        <div class="ctx">${say(`ned · ${hhmm(it.ts)}`, esc(quip(it.ts)), "변화 없는 순찰은 한 줄로 접어 둬.")}
        <h3>순찰</h3><div class="tlx">${r.map((b) => `<div><span class="h">${hhmm(b.ts)}</span>${b.type === "daily" ? "아침 브리핑" : "점검"} · $${Number(b.cost_usd || 0).toFixed(3)}${b.raw ? " · raw 있음" : ""}</div>`).join("")}</div>
        ${r.some((b) => b.raw) ? `<h3>raw</h3>${r.filter((b) => b.raw).map((b) => `<pre class="raw">${esc(b.raw)}</pre>`).join("")}` : ""}</div></div>`;
  } else if (it.brief) {
    const b = it.brief;
    sig = `bf:${b.id}`;
    html = `<div class="dwrap">${back}
        <div class="crumb"><span class="stk ${b.type === "daily" ? "b" : ""}">${b.type === "daily" ? "아침" : "점검"}</span>${bfFailed(b) ? `<span class="stk r">실패</span>` : `<span class="stk a">update</span>`}<span>${esc(dayLabel(b.ts))} ${hhmm(b.ts)} · ${rel(b.ts)}</span></div>
        <div class="ctx">${briefingSay(b)}
        ${sectionList("행동 필요", b.action_items)}${sectionList("업데이트", b.updates)}${sectionList("참고", b.fyi)}${sectionList("세션", b.sessions)}
        <h3>메타</h3>${costLine(b)}</div></div>`;
  } else {
    if (!it.att && !ui.read.has(it.key)) { ui.read.add(it.key); saveRead(); }
    let ctx = "";
    if (it.sess) {
      const x = it.sess;
      const evs = S.events.filter((e) => e.session_id === x.id).slice(-10).reverse();
      ctx = say(`ned · ${hhmm(it.ts)}`, esc(x.status === "waiting" ? `${x.worktree} 가 네 허락을 기다리는 중.` : x.status === "error" ? `${x.worktree} 가 넘어졌어.` : `${x.worktree} 상태 바뀜.`), esc(x.status === "waiting" ? (replyOn() && canReply(x) && !inDialog(x) ? "위에서 바로 답하거나 터미널에서 답해 주면 이어서 갈 거야." : "터미널로 가서 답해 주면 바로 이어서 갈 거야.") : x.status === "error" ? "다시 돌릴지 봐 줘." : ""))
        + `<h3>세션 · ${esc(x.worktree)}</h3><dl class="kv"><dt>상태</dt><dd><span class="led ${STATUS_LED[x.status] || ""}"></span>${esc(STATUS_KO[x.status] || x.status)}</dd><dt>시작</dt><dd>${rel(x.since)} (${mdhm(x.since)})</dd>${x.origin === "chat" ? `<dt>출처</dt><dd>${chatOriginBadge(x)}</dd>` : ""}<dt>서브에이전트</dt><dd>${x.subagents_active}</dd><dt>경로</dt><dd class="mono" style="font-size:12px">${esc(x.cwd)}</dd>${x.last_prompt ? `<dt>프롬프트</dt><dd>» ${esc(x.last_prompt)}</dd>` : ""}</dl>
          <h3>최근 이벤트</h3>${evs.length ? `<div class="tlx">${evs.map((e) => `<div class="${e.event === "Notification" ? "hot" : e.event === "StopFailure" ? "err" : ""}"><span class="h">${hhmm(e.ts)}</span>${esc(EVENT_KO[e.event] || e.event)}${e.message || e.prompt ? ` — ${esc(String(e.message || e.prompt).slice(0, 140))}` : e.agent_type ? ` — ${esc(e.agent_type)}` : ""}</div>`).join("")}</div>` : `<div class="body" style="font-size:13px">이벤트 없음</div>`}`;
    } else if (it.briefing) {
      const b = it.briefing, rest = [...(b.action_items || []), ...(b.updates || []), ...(b.fyi || [])].filter((x) => x.title !== it.title);
      ctx = `<h3>출처 · ${esc(bfLabel(b))}</h3>${briefingSay(b)}
          ${rest.length ? `<h3>같은 브리핑의 다른 항목</h3><ul>${rest.map((x) => `<li>${KIND_ICON[x.kind] || ""} ${esc(x.title)}</li>`).join("")}</ul>` : ""}
          <h3>메타</h3>${costLine(b)}`;
    } else if (it.att) {
      ctx = `<h3>출처</h3><div class="body" style="font-size:13px">${esc(it.att.source)}</div>`;
    }
    sig = `it:${it.key}:${it.title}:${it.detail}:${S.events.length}:${it.sess ? it.sess.status + it.sess.last_event_ts + replySig(it.sess) : ""}:${it.att?.reviewed_at || it.rat || 0}`;
    html = `<div class="dwrap">${back}
        <div class="crumb"><span class="stk ${it.att ? "a" : it.label === "참고" ? "" : "b"}">${it.att ? "행동 필요" : esc(it.label)}</span><span>${KIND_ICON[it.kind] || ""} ${esc(KIND_KO[it.kind] || it.kind)}</span><span>· ${rel(it.ts)}</span></div>
        <h2>${esc(it.title)}</h2>
        ${it.detail ? `<div class="body">${esc(it.detail)}</div>` : ""}
        <div class="dacts">
          ${it.sess ? draftBtn("session", sessionRef(it.sess), it.att?.id) : it.kind === "slack" ? draftBtn("slack", slackRef(it), it.att?.id) : it.kind === "email" ? draftBtn("email", mailRef(it), it.att?.id) : ""}
          ${openIcon(it.url)}${it.att ? reviewIcon(it.att) + iconBtn("close", "닫기 — 처리 완료로 치우기 (e)", { attrs: 'id="done"' }) : it.rk ? reviewIcon({ id: it.rk, reviewed_at: it.rat }) : ""}
          <span class="dkeys">${it.url ? "<kbd>⏎</kbd> 열기 · " : ""}${it.att ? "<kbd>e</kbd> 닫기" : ""}</span>
        </div>
        ${it.sess ? replyBox(it.sess, "detail") : ""}
        <div class="ctx">${ctx}</div></div>`;
  }
  if (sig === ui.detailSig) return;
  ui.detailSig = sig;
  keepFocus(() => { box.innerHTML = html; });
  box.scrollTop = 0;
  $("done")?.addEventListener("click", dismissSelected);
  $("back")?.addEventListener("click", closeDetail);
}

export async function dismissSelected() {
  const it = listOf(model())[ui.sel];
  if (!it?.att) return;
  const id = it.att.id;
  S.state.attention = S.state.attention.filter((a) => a.id !== id); // optimistic
  renderInbox(); renderHeader();
  try {
    await api(`/api/attention/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
    toast(it.att.source === "sessions" ? "닫았어. 세션이 또 부르면 다시 올라올 거야." : "처리 완료로 표시했어.");
  } catch (e) { console.warn(e); toast(`닫기 실패: ${e.message}`); }
  await loadState();
}

// ---------- sessions (rail + phone drawer) ----------
/** 대화창(Ned Net)에서 만든 세션 (state sessions[].origin === "chat", src/session-create.ts). */
export const chatOriginBadge = (x) => (x?.origin === "chat" ? ` <span class="origin-chat" title="Ned 대화창에서 시작한 세션${x.origin_terminal ? ` · ${esc(x.origin_terminal)}` : ""}">대화창에서 시작</span>` : "");
/** One session unit: status, name, last summary / prompt (= what it is asking), ✎, and 세션에 답하기 (features/sessreply.js). */
export const unitHtml = (x, where) => `<div class="unit${x.status === "waiting" ? " waiting" : ""}" title="${esc(x.cwd)}"><span class="led ${STATUS_LED[x.status] || ""}"></span><span class="nm">${esc(x.worktree)}${x.subagents_active ? ` <span class="sa">+${x.subagents_active}</span>` : ""}${chatOriginBadge(x)}</span><span class="r">${rel(x.last_event_ts)}${replyMenu(x, where)}</span><span class="s">${esc(x.last_summary || (x.last_prompt ? "» " + x.last_prompt : ""))}</span>${draftBtn("session", sessionRef(x), (S.state?.attention || []).some((a) => a.id === `session:${x.id}`) ? `session:${x.id}` : "")}${replyBox(x, where)}</div>`;
export function renderSessions() {
  const ss = S.state?.sessions ?? [];
  const units = ss.map((x) => unitHtml(x, "rail")).join("");
  const rack = units ? `<div class="rack">${units}</div>` : `<div class="none">출동 중인 에이전트 없음.</div>`;
  const tape = [...S.briefings].sort((a, b) => b.ts - a.ts).slice(0, 8).map((b) => `<div class="tr ${b.status === "NED_OK" ? "ok" : ""}"><span class="h">${dayLabel(b.ts) === "오늘" ? "" : esc(dayLabel(b.ts)) + " "}${hhmm(b.ts)}</span><span>${b.status === "NED_OK" ? "· 이상 무" : `▲ ${esc(b.headline || "업데이트")}`}</span></div>`).join("");
  keepFocus(() => {
    $("rail").innerHTML = `<h3>장비실 · 세션 <span class="n">${ss.length}</span><button class="btn small" id="rail-toggle" title="세션 패널 접기">접기</button></h3>${rack}<h3>순찰 기록 <span class="n">${S.briefings.length}</span></h3>${tape ? `<div class="tape">${tape}</div>` : `<div class="none">아직 기록 없음.</div>`}`;
    $("msess-rack").innerHTML = ss.map((x) => unitHtml(x, "drawer")).join("") || `<div class="none">출동 중인 에이전트 없음.</div>`;
  });
  $("rail-toggle").onclick = () => setRail(true);
  const waiting = ss.filter((x) => x.status === "waiting" || x.status === "error").length;
  $("msess-sum").innerHTML = `▸ 장비실 · 세션 ${ss.length}${waiting ? ` &nbsp;<span class="stk a flat">대기 ${waiting}</span>` : ""}`;
  syncRailButton();
}
// 세션에 답하기: 보내는 중 / 보냄 / ⋯ 메뉴가 바뀌면 rail · 서랍 · 상세를 다시 그린다 (상세는 sig 로).
subscribe("sessreply", () => { if (!$("rail")) return; renderSessions(); if ($("detail") && $("items")) { const m = model(); renderDetail(listOf(m)[ui.sel], m); } });
export function setRail(off) { ui.railOff = off; lsSet("ned.railOff", off ? "1" : "0"); $("inbox").classList.toggle("rail-off", off); syncRailButton(); }
export function syncRailButton() {
  let b = $("rail-open");
  if (ui.railOff && ui.view === "inbox") {
    if (!b) { b = document.createElement("button"); b.id = "rail-open"; b.className = "btn small"; b.onclick = () => setRail(false); $("leds").after(b); }
    b.textContent = `세션 ${S.state?.sessions.length ?? 0}`;
    b.hidden = window.matchMedia("(max-width: 1180px), (min-width: 1800px)").matches;
  } else if (b) b.remove();
}
