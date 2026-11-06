/* Home tab: greeting line, todo card (Ned actions + personal todos), agenda refresh. */
import { api } from "../api.js";
import { meetings, renderAgenda, todayEvents } from "../features/calendar.js";
import { GH_REASON, MAIL_REASON, PRIO_LED, SLACK_REASON, card, cardMode, collapseDMs, counts, group, moreBadge, packCards, preview, renderSlackWatch, unionAll, watchNeeds } from "../features/cards.js";
import { draftFor } from "../features/drafts.js";
import { V, greet, say } from "../features/personas.js";
import { isOpenSrc, openAtt, revAt, revCls, srcCheck, srcKey, withFold } from "../features/reviewed.js";
import { loadAgenda, loadState, loadTodos, renderAll, renderHeader } from "../main.js";
import { S, ui } from "../state.js";
import { PF, PILL_KINDS, pfOn, pillRow, srcOn } from "../ui/chips.js";
import { KIND_ICON, closeIcon, openIcon, reviewIcon } from "../ui/icons.js";
import { errBadge, errSummary } from "../ui/popover.js";
import { toast } from "../ui/toast.js";
import { $, dueChip, dueInfo, esc, ext, hhmm, mdhm, rel, safeUrl, toMs } from "../util.js";
export const byDue = (a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || String(a.due || "").localeCompare(String(b.due || ""));

export function renderTodoGroups() {
  const s = S.state, ag = S.agenda;
  const nedAll = (s?.attention || []).filter((a) => a.source !== "sessions" && srcOn(a.kind)), nedF = nedAll.filter((a) => pfOn("home", a.kind));
  const ned = nedF.filter((a) => !a.reviewed_at), nedRev = nedF.filter((a) => a.reviewed_at);
  const nedRow = (a) => {
    const u = safeUrl(a.url);
    return `<div class="ti${a.reviewed_at ? " reviewed" : ""}"><span class="ic">${KIND_ICON[a.kind] || "🔔"}</span><div class="mn"><span class="tt">${u ? ext(u, esc(a.title)) : esc(a.title)}</span>${a.detail ? `<div class="sb"><span class="d">${esc(a.detail)}</span></div>` : ""}</div>
        <div class="ra">${draftFor(a.kind, a, a.id)}${openIcon(u)}${reviewIcon(a)}${closeIcon(a)}</div></div>`;
  };
  const nedRows = ned.map(nedRow).join("") + (nedRev.length
    ? `${ned.length ? "" : `<div class="gnone">열린 액션 아이템 없음.</div>`}<details class="rvfold" data-rv="home" ${ui.revOpenHome ? "open" : ""}><summary>확인 완료 ${nedRev.length}</summary>${nedRev.map(nedRow).join("")}</details>` : "");
  group("ned", ned.length, ned.length, nedRows, !s ? "불러오는 중…" : PF.home.size ? "선택한 소스엔 액션 아이템 없음." : "내가 챙겨 둔 거 없어.");

  const unavailable = ag === null ? "agenda 연결 안 됨." : ag === undefined ? "불러오는 중…" : "";
  // Gmail/Slack source off → hide the card; mail/slack === null → agenda.json predates the block (not fetched yet).
  const mailOn = srcOn("email") && ag?.mail_enabled !== false, mail = mailOn ? ag?.mail : null, miAll = mail?.items || [], mi = miAll.filter(isOpenSrc("email"));
  const unreadN = `${Number(mail?.unread) || 0}${mail?.unread_capped ? "+" : ""}`;
  $("mail-sum").innerHTML = mail?.summary ? `<span>${esc(mail.summary)}</span>` : "";
  const mr = (k) => mi.filter((x) => (MAIL_REASON[x.reason] ? x.reason : "request") === k).length;
  const mailRow = (x) => MAIL_REASON[x.reason] || MAIL_REASON.request;
  // 전체 = all ∪ items by thread id, so a 확인 필요 mail older than / missing from `all` still shows (with the bar).
  const mailU = unionAll("email", miAll, mail?.all || [], (x) => x.ts || x.received);
  const mailAllRows = withFold("mail-all", "email", mailU.list, (x) => {
    const u = safeUrl(x.url), need = mailU.isNeed(x), ts = x.ts || x.received;
    // an item-only row has no unread flag: show its reason icon instead of a read/unread dot
    const ic = "unread" in x ? `<span class="ic" title="${x.unread ? "안 읽음" : "읽음"}">${x.unread ? "●" : "○"}</span>` : `<span class="ic">${mailRow(x)[2]}</span>`;
    return `<div class="ti${need ? " need" : ""}${revCls("email", x)}">${ic}<div class="mn"><span class="tt">${u ? ext(u, esc(x.subject || "(제목 없음)")) : esc(x.subject || "(제목 없음)")}</span>
        <div class="sb"><span class="from">${esc(x.from)}</span>${need ? `<span class="chipx today">확인 필요</span>` : ""}${ts ? `<span>${rel(toMs(ts))}</span>` : ""}</div></div>
        <div class="ra">${draftFor("email", x, srcKey("email", x))}${openIcon(u)}${srcCheck("email", x)}</div></div>`;
  });
  card("mail", {
    hidden: !mailOn, n: mi.length, hot: mi.some((x) => x.reason === "deadline" || x.reason === "approval"),
    mode: cardMode("mail"), allRows: mailAllRows, allEmpty: mail ? "최근 2일 안 읽은 메일 목록 없음 (다음 새로고침 때 채워져)." : "다음 새로고침 때 메일도 가져올게.",
    rows: withFold("mail", "email", miAll, (x) => {
      const u = safeUrl(x.url), r = mailRow(x);
      return `<div class="ti${revCls("email", x)}"><span class="ic">${r[2]}</span><div class="mn"><span class="tt">${u ? ext(u, esc(x.subject || "(제목 없음)")) : esc(x.subject || "(제목 없음)")}</span>
          <div class="sb"><span class="from">${esc(x.from)}</span><span class="chipx ${r[0]}">${r[1]}</span>${x.why ? `<span class="d">${esc(x.why)}</span>` : ""}${x.received ? `<span>${rel(toMs(x.received))}</span>` : ""}</div></div>
          <div class="ra">${draftFor("email", x, srcKey("email", x))}${openIcon(u)}${srcCheck("email", x)}</div></div>`;
    }),
    empty: unavailable || (mail ? "확인할 메일 없음." : "다음 새로고침 때 메일도 가져올게."),
    sum: mail ? esc([counts([["결재", mr("approval")], ["마감", mr("deadline")], ["답장", mr("reply")], ["확인", mr("request")]], " · "), `안 읽은 ${unreadN}`].filter(Boolean).join(" · ")) : "",
    pv: mi[0] && preview(mailRow(mi[0])[2], mi[0].subject || "(제목 없음)", safeUrl(mi[0].url), `<span class="chipx ${mailRow(mi[0])[0]}">${mailRow(mi[0])[1]}</span>`),
  });

  const jiraAll = [...(ag?.jira || [])].sort((a, b) => byDue(a, b) || toMs(b.updated) - toMs(a.updated)), jira = jiraAll.filter(isOpenSrc("jira"));
  const jDays = (j) => dueInfo(j.due)?.days;
  card("jira", {
    n: jira.length, hot: jira.some((j) => (jDays(j) ?? 1) <= 0),
    rows: withFold("jira", "jira", jiraAll, (j) => {
      const u = safeUrl(j.url);
      return `<div class="ti${revCls("jira", j)}"><span class="ic" title="${esc(j.priority || "")}"><span class="led ${PRIO_LED[String(j.priority || "").toLowerCase()] || ""}" style="margin:0"></span></span><div class="mn"><span class="tt">${u ? ext(u, esc(j.title)) : esc(j.title)}</span>
          <div class="sb"><span class="key">${esc(j.key)}</span><span class="chipx">${esc(j.status || "—")}</span>${dueChip(j.due)}</div></div>
          <div class="ra">${openIcon(u)}${srcCheck("jira", j)}</div></div>`;
    }),
    empty: unavailable || "배정된 이슈 없음.",
    sum: jira.length ? esc(counts([["마감 지난", jira.filter((j) => jDays(j) < 0).length], ["오늘", jira.filter((j) => jDays(j) === 0).length], ["진행 중", jira.filter((j) => /진행|progress/i.test(j.status || "")).length]]).replace(/ (\d+)/g, " $1건") || `열린 이슈 ${jira.length}건`) : "",
    pv: jira[0] && preview(`<span class="key">${esc(jira[0].key)}</span>`, jira[0].title, safeUrl(jira[0].url), dueChip(jira[0].due) || `<span class="chipx">${esc(jira[0].status || "—")}</span>`),
  });

  const slackOn = srcOn("slack") && ag?.slack_enabled !== false, slack = slackOn ? ag?.slack : null, siAll = collapseDMs(slack?.items || []), si = siAll.filter(isOpenSrc("slack"));
  $("slack-sum").innerHTML = slack?.summary ? `<span>${esc(slack.summary)}</span>` : "";
  const slRow = (x) => SLACK_REASON[x.reason] || SLACK_REASON.thread;
  const slackNeed = new Set(siAll.map((x) => x.url).filter(Boolean));
  const watch = slack?.watch || [], wNeed = watchNeeds(slack).filter((h) => !slackNeed.has(h.url));
  renderSlackWatch(watch, wNeed.length);
  // 전체 = all ∪ items by channel id + ts (a thread ask is often missing from `all`, and its link carries ?thread_ts).
  const slackU = unionAll("slack", siAll, slack?.all || [], (x) => x.ts);
  const slackAllRows = withFold("slack-all", "slack", collapseDMs(slackU.list), (x) => {
    const u = safeUrl(x.url), r = slRow(x), need = slackU.isNeed(x);
    return `<div class="ti${need ? " need" : ""}${x.answered && !need ? " answered" : ""}${revCls("slack", x)}"><span class="ic">${r[2]}</span><div class="mn"><span class="tt">${u ? ext(u, esc(x.text || "(내용 없음)")) : esc(x.text || "(내용 없음)")}</span>
        <div class="sb"><span class="key" style="color:var(--dim)">${esc(x.channel)}</span><span class="from">${esc(x.from)}</span>${need ? `<span class="chipx today">답 필요</span>` : x.answered ? `<span class="chipx ok">답함</span>` : `<span class="chipx ${r[0]}">${r[1]}</span>`}${moreBadge(x)}${x.ts ? `<span>${rel(toMs(x.ts))}</span>` : ""}</div></div>
        <div class="ra">${draftFor("slack", x, srcKey("slack", x))}${openIcon(u)}${srcCheck("slack", x)}</div></div>`;
  });
  card("slack", {
    hidden: !slackOn, n: si.length + wNeed.length, hot: si.some((x) => x.reason === "dm" || x.reason === "mention") || wNeed.length > 0,
    mode: cardMode("slack"), allRows: slackAllRows, allEmpty: slack ? "최근 24시간 멘션·DM 목록 없음 (다음 새로고침 때 채워져)." : "다음 새로고침 때 Slack 도 가져올게.",
    rows: withFold("slack", "slack", siAll, (x) => {
      const u = safeUrl(x.url), r = slRow(x);
      return `<div class="ti${revCls("slack", x)}"><span class="ic">${r[2]}</span><div class="mn"><span class="tt">${u ? ext(u, esc(x.text || "(내용 없음)")) : esc(x.text || "(내용 없음)")}</span>
          <div class="sb"><span class="key" style="color:var(--dim)">${esc(x.channel)}</span><span class="from">${esc(x.from)}</span><span class="chipx ${r[0]}">${r[1]}</span>${moreBadge(x)}${x.ts ? `<span>${rel(toMs(x.ts))}</span>` : ""}</div></div>
          <div class="ra">${draftFor("slack", x, srcKey("slack", x))}${openIcon(u)}${srcCheck("slack", x)}</div></div>`;
    }),
    empty: unavailable || (slack ? "답할 Slack 없음." : "다음 새로고침 때 Slack 도 가져올게."),
    sum: si.length || wNeed.length ? esc([si.length ? `${counts([["멘션", si.filter((x) => x.reason === "mention").length], ["DM", si.filter((x) => x.reason === "dm").length], ["스레드", si.filter((x) => x.reason === "thread").length]])} 답 필요` : "", wNeed.length ? `팔로업 채널 ${wNeed.length}건 확인` : ""].filter(Boolean).join(" · ")) : "",
    pv: si[0] && preview(slRow(si[0])[2], si[0].text || "(내용 없음)", safeUrl(si[0].url), `<span class="chipx">${esc(si[0].channel)}</span>`),
  });

  const ghAll = [...(ag?.github || [])].sort((a, b) => (a.reason === "review_requested" ? 0 : 1) - (b.reason === "review_requested" ? 0 : 1) || toMs(b.updated) - toMs(a.updated)), gh = ghAll.filter(isOpenSrc("github"));
  const ghR = (x) => GH_REASON[x.reason] || ["", x.reason || "", "🐙"];
  card("gh", {
    n: gh.length, hot: gh.some((x) => x.reason === "review_requested"),
    rows: withFold("gh", "github", ghAll, (x) => {
      const u = safeUrl(x.url), r = ghR(x);
      return `<div class="ti${revCls("github", x)}"><span class="ic">${r[2]}</span><div class="mn"><span class="tt">${u ? ext(u, esc(x.title)) : esc(x.title)}</span>
          <div class="sb"><span class="key" style="color:var(--dim)">${esc(x.repo)}#${esc(x.number)}</span><span class="chipx ${r[0]}">${esc(r[1])}</span>${x.author ? `<span>@${esc(x.author)}</span>` : ""}${x.updated ? `<span>${rel(toMs(x.updated))}</span>` : ""}</div></div>
          <div class="ra">${openIcon(u)}${srcCheck("github", x)}</div></div>`;
    }),
    empty: unavailable || "기다리는 리뷰 없음.",
    sum: esc(counts(Object.keys(GH_REASON).map((k) => [GH_REASON[k][1], gh.filter((x) => x.reason === k).length]))),
    pv: gh[0] && preview(ghR(gh[0])[2], gh[0].title, safeUrl(gh[0].url), `<span class="chipx ${ghR(gh[0])[0]}">${esc(ghR(gh[0])[1])}</span>`),
  });

  const todos = S.todos || [];
  const open = todos.filter((t) => !t.done).sort((a, b) => byDue(a, b) || toMs(a.created_at) - toMs(b.created_at));
  const done = todos.filter((t) => t.done).sort((a, b) => toMs(b.done_at) - toMs(a.done_at));
  const row = (t) => `<div class="ti ${t.done ? "done" : ""}"><span class="ic"><input type="checkbox" data-tid="${esc(t.id)}" ${t.done ? "checked" : ""} ${t.pending ? "disabled" : ""} aria-label="완료"></span>
      <div class="mn"><span class="tt">${esc(t.title)}</span>${(!t.done && t.due) || t.note ? `<div class="sb">${t.done ? "" : dueChip(t.due)}${t.note ? `<span class="d">${esc(t.note)}</span>` : ""}</div>` : ""}</div>
      <div class="ra"><button class="btn small x" data-del="${esc(t.id)}" title="삭제" aria-label="삭제" ${t.pending ? "disabled" : ""}>✕</button></div></div>`;
  let rows = open.map(row).join("");
  if (!open.length) rows = `<div class="gnone">${S.todos === null ? "할 일 API 가 아직 없어." : S.todos === undefined ? "불러오는 중…" : done.length ? "다 했네. 오늘 몫은 끝." : "적어 둔 할 일 없음. 위에 한 줄 써 봐."}</div>`;
  if (done.length) rows += `<details class="tdone" ${ui.doneOpen ? "open" : ""}><summary>완료 ${done.length}</summary>${done.map(row).join("")}</details>`;
  group("me", open.length, open.some((t) => (dueInfo(t.due)?.days ?? 1) <= 0), rows, "");
  for (const el of $("tadd").elements) el.disabled = S.todos === null;
  $("grp-me").hidden = !pfOn("home", "me");
  $("todo-count").textContent = `${ned.length + (pfOn("home", "me") ? open.length : 0)}건`; // what this card shows
  // pill counts cover this card only (Ned action items by kind + personal todos), before filtering
  const cnt = { me: open.length };
  for (const a of nedAll) if (!a.reviewed_at) cnt[a.kind] = (cnt[a.kind] || 0) + 1; // open only
  if (srcOn("slack") && ag?.slack_enabled !== false) { // + 채널 팔로업 needs_me not already surfaced as an action item
    const attUrls = new Set(nedAll.map((a) => a.url).filter(Boolean)), wn = watchNeeds(ag?.slack).filter((h) => !attUrls.has(h.url)).length;
    if (wn) cnt.slack = (cnt.slack || 0) + wn;
  }
  $("pf-home").innerHTML = pillRow("home", cnt, PILL_KINDS.filter(srcOn));
}

/** Ned's one line for the day, built from agenda + todos + attention. */
export function homeLine() {
  const now = Date.now(), ag = S.agenda;
  if (ag === undefined && S.todos === undefined) return { lead: "오늘 하루 펼치는 중…", sub: "" };
  const mt = meetings(todayEvents().timed);
  const left = mt.filter((e) => e.en > now), cur = mt.find((e) => e.s <= now && now < e.en), next = mt.find((e) => e.s > now);
  const bits = [];
  if (ag) {
    const v = V();
    if (!mt.length) bits.push(v.noMeet);
    else if (!left.length) bits.push(v.allDone(mt.length));
    else bits.push(v.meet({ left: left.length, cur: cur?.title, next: next ? hhmm(next.s) : "", first: next === mt[0] }));
    // 확인 완료 items don't count
    const jira = srcOn("jira") ? (ag.jira || []).filter(isOpenSrc("jira")).length : 0, rv = srcOn("github") ? (ag.github || []).filter((g) => g.reason === "review_requested" && !revAt("github", g)).length : 0;
    const mails = srcOn("email") && ag.mail_enabled !== false ? (ag.mail?.items || []).filter(isOpenSrc("email")).length : 0;
    const slackItems = collapseDMs(ag.slack?.items || []), slackUrls = new Set(slackItems.map((x) => x.url).filter(Boolean));
    const slacks = srcOn("slack") && ag.slack_enabled !== false ? slackItems.filter(isOpenSrc("slack")).length + watchNeeds(ag.slack).filter((h) => !slackUrls.has(h.url)).length : 0; // one per DM conversation, like the card; + open 팔로업 needs_me
    const c = V().count;
    const w = [jira ? c("Jira", jira, "건") : "", rv ? c("리뷰", rv, "건") : "", mails ? c("메일", mails, "통") : "", slacks ? c("Slack", slacks, "건") : ""].filter(Boolean);
    if (w.length) bits.push(V().wait(w));
  }
  const sub = [];
  const ned = openAtt().filter((a) => a.source !== "sessions").length;
  const open = (S.todos || []).filter((t) => !t.done), over = open.filter((t) => (dueInfo(t.due)?.days ?? 1) < 0).length;
  const ask = mt.filter((e) => e.rsvp === "needsAction" && e.en > now).length;
  if (ask) sub.push(V().ask(ask));
  if (ned) sub.push(V().held(ned));
  if (open.length) sub.push(V().todo(open.length, over));
  if (!bits.length) bits.push(ag === null ? V().noAgenda : V().noMeet);
  return { lead: `${greet()} ${bits.join(" ")}`, sub: sub.join(" · ") };
}

export function renderHome() {
  const o = homeLine();
  $("say-home").innerHTML = say(`ned · ${hhmm(Date.now())}`, esc(o.lead), esc(o.sub));
  const ag = S.agenda;
  $("ag-meta").innerHTML = ag === null ? errBadge("agenda-conn", { where: "agenda 연결", message: "GET /api/agenda 가 실패했어. daemon 이 꺼졌거나 이 버전에 agenda API 가 없어.", retry: () => loadAgenda() })
    : ag ? [ag.updated_at ? `<span title="${esc(mdhm(ag.updated_at))}">일정 갱신 ${esc(rel(ag.updated_at))}</span>` : "", ag.cost_usd != null ? `<span>$${Number(ag.cost_usd).toFixed(2)}</span>` : "",
      ag.error ? errBadge("agenda", { where: "일정·이슈 갱신 (agenda 잡)", message: ag.error, at: ag.updated_at || Date.now(), retry: () => refreshAgenda() }) : ""].filter(Boolean).join(" · ") : "";
  renderAgenda();
  renderTodoGroups();
  packCards();
  setAgBusy();
}

// agenda refresh (POST, 30–90s)
export let agTick = 0;
export function setAgBusy() {
  const b = $("ag-refresh");
  b.disabled = !!S.agBusy;
  b.innerHTML = S.agBusy ? `<span class="spin"></span>가져오는 중 ${Math.round((Date.now() - S.agBusy.t0) / 1000)}초` : "새로고침";
}
export async function refreshAgenda() {
  if (S.agBusy) return;
  S.agBusy = { t0: Date.now() };
  setAgBusy(); renderHeader();
  agTick = setInterval(setAgBusy, 1000);
  try {
    const a = await api("/api/agenda/refresh", { method: "POST" });
    if (a) S.agenda = a;
    toast(a?.error ? `일부는 못 가져왔어 — ${errSummary(a.error)} (⚠ 를 눌러 자세히)` : "일정이랑 이슈 새로 가져왔어.");
  } catch (e) {
    if (e.status === 409) toast("이미 가져오는 중이야. 조금만 기다려.");
    else if (e.status === 404) toast("아직 agenda API 가 없어.");
    else { console.warn(e); toast(`새로고침 실패: ${e.message}`, 6000); }
  } finally {
    clearInterval(agTick);
    S.agBusy = null;
    renderAll();
  }
}

// personal todos (optimistic, then reload)
export async function todoOp(fn, failMsg) {
  renderAll();
  try { await fn(); } catch (e) { console.warn(e); toast(`${failMsg}: ${e.message}`); }
  await loadTodos();
}
export function addTodo(title, due) {
  S.todos = [...(S.todos || []), { id: `tmp-${Date.now()}`, title, done: false, created_at: Date.now(), done_at: null, due: due || null, note: null, pending: true }];
  return todoOp(() => api("/api/todos", { method: "POST", body: JSON.stringify(due ? { title, due } : { title }) }), "추가 실패");
}
export function patchTodo(id, patch) {
  const t = (S.todos || []).find((x) => x.id === id); if (!t) return;
  Object.assign(t, patch, "done" in patch ? { done_at: patch.done ? Date.now() : null } : {});
  return todoOp(() => api(`/api/todos/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }), "저장 실패");
}
export function deleteTodo(id) {
  S.todos = (S.todos || []).filter((x) => x.id !== id);
  return todoOp(() => api(`/api/todos/${encodeURIComponent(id)}`, { method: "DELETE" }), "삭제 실패");
}
export async function dismissAttention(id) {
  if (!S.state) return;
  const a = S.state.attention.find((x) => x.id === id);
  S.state.attention = S.state.attention.filter((x) => x.id !== id); // optimistic
  renderAll();
  try { await api(`/api/attention/${encodeURIComponent(id)}/dismiss`, { method: "POST" }); toast(a?.source === "sessions" ? "닫았어." : "처리 완료로 표시했어."); }
  catch (e) { console.warn(e); toast(`닫기 실패: ${e.message}`); }
  await loadState();
}
export const homeCard = $("todo-card");

/** Listeners + one-time setup; main.js calls every module's init() once, in the old file's order. */
export function init() {
  $("ag-refresh").addEventListener("click", refreshAgenda);
  $("tadd").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("tadd-t"), d = $("tadd-d"), title = t.value.trim();
    if (!title) { t.focus(); return; }
    addTodo(title, d.value || null);
    t.value = ""; d.value = ""; t.focus();
  });
  $("tadd-t").addEventListener("keydown", (e) => { if (e.key === "Escape") e.target.blur(); });
  homeCard.addEventListener("click", (e) => {
    const dis = e.target.closest("[data-dismiss]"), del = e.target.closest("[data-del]");
    if (dis) dismissAttention(dis.dataset.dismiss);
    else if (del) deleteTodo(del.dataset.del);
  });
  homeCard.addEventListener("change", (e) => { const c = e.target.closest("[data-tid]"); if (c) patchTodo(c.dataset.tid, { done: c.checked }); });
  homeCard.addEventListener("toggle", (e) => {
    if (e.target.classList?.contains("tdone")) ui.doneOpen = e.target.open;
    if (e.target.classList?.contains("rvfold")) ui.revOpenHome = e.target.open;
  }, true);
}
