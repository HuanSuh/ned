/* Timeline tab: events + briefings merged by ts, type / worktree chips. */
import { bfKind } from "../features/dailyfail.js";
import { S } from "../state.js";
import { EVENT_KO } from "../ui/icons.js";
import { $, basename, dayLabel, esc, hhmm } from "../util.js";

// ---------- timeline ----------
export function timelineItems() {
  const evs = S.events.map((e) => ({ ts: e.ts, type: e.event, wt: e.orca_worktree ? basename(String(e.orca_worktree).split("::").pop()) : basename(e.cwd), brief: false,
    msg: e.prompt ?? e.message ?? e.reason ?? (e.agent_type ? `agent ${e.agent_type}` : ""), raw: e }));
  const bfs = S.briefings.map((b) => ({ ts: b.ts, type: "브리핑", wt: "", brief: true, msg: `${bfKind(b)} · ${b.status}${b.headline ? " · " + b.headline : ""}`, raw: b }));
  return [...evs, ...bfs].sort((a, b) => b.ts - a.ts);
}
export function renderTimeline() {
  const all = timelineItems();
  const types = [...new Set(all.map((x) => x.type))].sort((a, b) => (a === "브리핑" ? -1 : b === "브리핑" ? 1 : a.localeCompare(b)));
  const wts = [...new Set(all.map((x) => x.wt).filter(Boolean))].sort();
  const chips = (label, set, keys, name) => `<span class="lbl">${label}</span><button class="chip ${set.size === 0 ? "on" : ""}" data-f="${name}" data-k="">전체</button>` +
    keys.map((k) => `<button class="chip ${set.has(k) ? "on" : ""}" data-f="${name}" data-k="${esc(k)}">${esc(EVENT_KO[k] || k)}</button>`).join("");
  $("chips-type").innerHTML = chips("유형", S.filterType, types, "type");
  $("chips-wt").innerHTML = chips("워크트리", S.filterWt, wts, "wt");
  $("chips-wt").hidden = !wts.length;
  for (const c of document.querySelectorAll("[data-f]")) c.onclick = () => {
    const set = c.dataset.f === "type" ? S.filterType : S.filterWt, k = c.dataset.k;
    if (!k) set.clear(); else if (set.has(k)) set.delete(k); else set.add(k);
    renderTimeline();
  };
  const rows = all.filter((x) => (!S.filterType.size || S.filterType.has(x.type)) && (!S.filterWt.size || x.brief || S.filterWt.has(x.wt))).slice(0, 300);
  $("tl-count").textContent = rows.length ? `${rows.length}건${all.length > rows.length ? ` / ${all.length}` : ""}` : "";
  if (!rows.length) { $("timeline").innerHTML = `<li class="dayh" style="letter-spacing:0;font-family:var(--sans);font-size:13px">표시할 이벤트가 없어.</li>`; return; }
  let html = "", lastDay = "";
  for (const x of rows) {
    const day = dayLabel(x.ts);
    if (day !== lastDay) { html += `<li class="dayh">${esc(day)}</li>`; lastDay = day; }
    const cls = x.brief ? "brief" : x.type === "Notification" ? "hot" : x.type === "StopFailure" ? "err" : "";
    html += `<li class="${cls}" title="${esc(new Date(x.ts).toLocaleString("ko-KR"))}"><span class="t">${hhmm(x.ts)}</span><div class="ev">
        <span class="kind">${x.brief ? "📝 브리핑" : esc(EVENT_KO[x.type] || x.type)}</span>${x.wt ? `<span class="wt">${esc(x.wt)}</span>` : ""}
        ${x.raw.notification_type ? `<span class="stk flat">${esc(x.raw.notification_type)}</span>` : ""}${x.raw.status === "NED_OK" ? `<span class="stk g flat">ned_ok</span>` : x.raw.status === "UPDATE" ? `<span class="stk a flat">update</span>` : ""}
        ${x.msg ? `<span class="msg">${esc(String(x.msg).slice(0, 300))}</span>` : ""}</div></li>`;
  }
  $("timeline").innerHTML = html;
}
