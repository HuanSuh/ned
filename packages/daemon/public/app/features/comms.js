/* Ned 통신기 (comms): a floating "guy in the chair" module on every tab — collapsed it shows what just came in (ticker,
 * unread badge, glow on arrival), expanded it is a panel with 대화 (POST /api/chat, SSE) and 메시지 (the feed).
 * Mounted once on <body>, outside main.view, so tab switches never touch it. ⌘J toggles, Esc / outside click / ▾ collapse.
 * Persona changes only swap words (COMMS_VOICE) and theme tokens (css/comms.css). Pure parts live in chat-core.js. */
import { S, alive, subscribe } from "../state.js";
import { $, esc, lsGet, lsSet, hhmm, rel } from "../util.js";
import { MINI, persona } from "./personas.js";
import { buildFeed, commsVoice, createSseParser, feedHtml, messagesHtml, shellHtml, tickerOf, usd } from "./chat-core.js";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl+";
const INPUT_MAX = 2000;
const LS = { open: "ned.comms.open", tab: "ned.comms.tab", pos: "ned.comms.pos", seen: "ned.comms.seen", notes: "ned.comms.notes", chat: "ned.chat.id" };
const readJ = (k, d) => { try { const v = JSON.parse(lsGet(k) || "null"); return v ?? d; } catch { return d; } };

const st = {
  open: false, tab: lsGet(LS.tab) === "msgs" ? "msgs" : "chat",
  chatId: lsGet(LS.chat) || null, msgs: [], cost: 0, live: null, running: false, err: "",
  seen: new Set(readJ(LS.seen, [])), seeded: lsGet(LS.seen) != null, notes: readJ(LS.notes, []),
  feed: [], prevUnread: -1, persona: null, logSig: "",
};
let root, dock, panel, log, q;

const voice = () => commsVoice(persona);
const saveSeen = () => lsSet(LS.seen, JSON.stringify([...st.seen].slice(-600)));
const saveNotes = () => lsSet(LS.notes, JSON.stringify(st.notes.slice(-10)));

// ---------- position (drag) ----------
function applyPos() {
  const p = readJ(LS.pos, null);
  const r = Math.max(8, Math.min(window.innerWidth - 80, Number(p?.r) || 18)), b = Math.max(8, Math.min(window.innerHeight - 60, Number(p?.b) || 18));
  dock.style.right = `${r}px`; dock.style.bottom = `${b}px`;
  // The panel opens on the dock's side of the screen.
  root.classList.toggle("left", r > window.innerWidth / 2);
}
function wireDrag() {
  let d = null;
  dock.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const rc = dock.getBoundingClientRect();
    d = { x: e.clientX, y: e.clientY, r: window.innerWidth - rc.right, b: window.innerHeight - rc.bottom, moved: false };
    dock.setPointerCapture?.(e.pointerId);
  });
  dock.addEventListener("pointermove", (e) => {
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true; dock.classList.add("drag");
    dock.style.right = `${Math.max(8, Math.min(window.innerWidth - dock.offsetWidth - 8, d.r - dx))}px`;
    dock.style.bottom = `${Math.max(8, Math.min(window.innerHeight - dock.offsetHeight - 8, d.b - dy))}px`;
  });
  const up = () => {
    if (!d) return;
    const moved = d.moved; d = null; dock.classList.remove("drag");
    if (moved) { lsSet(LS.pos, JSON.stringify({ r: parseInt(dock.style.right, 10), b: parseInt(dock.style.bottom, 10) })); applyPos(); }
    else toggle();
  };
  dock.addEventListener("pointerup", up);
  dock.addEventListener("pointercancel", () => { d = null; dock.classList.remove("drag"); });
  dock.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  window.addEventListener("resize", applyPos);
}

// ---------- open / close / tabs ----------
export function open(tab) {
  if (tab) setTab(tab, false);
  st.open = true; lsSet(LS.open, "1");
  panel.hidden = false; root.classList.add("open"); dock.setAttribute("aria-expanded", "true");
  render();
  if (st.tab === "chat") requestAnimationFrame(() => { q.focus(); scrollLog(true); });
}
export function close() {
  if (!st.open) return;
  st.open = false; lsSet(LS.open, "0");
  panel.hidden = true; root.classList.remove("open"); dock.setAttribute("aria-expanded", "false");
  render();
  if (panel.contains(document.activeElement) || document.activeElement === document.body) dock.focus({ preventScroll: true });
}
export const toggle = () => (st.open ? close() : open());
function setTab(t, rerender = true) {
  st.tab = t === "msgs" ? "msgs" : "chat"; lsSet(LS.tab, st.tab);
  if (st.tab === "chat" && st.notes.some((n) => !st.seen.has(n.key))) { for (const n of st.notes) st.seen.add(n.key); saveSeen(); }
  if (rerender) { render(); if (st.tab === "chat") q.focus(); }
}

// ---------- chat ----------
function scrollLog(force) {
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 80) log.scrollTop = log.scrollHeight;
}
function setChat(id) { st.chatId = id; if (id) lsSet(LS.chat, id); else try { localStorage.removeItem(LS.chat); } catch { /* ignore */ } }
async function loadChat() {
  if (!st.chatId) return;
  try {
    const r = await fetch(`/api/chat/${encodeURIComponent(st.chatId)}`, { headers: { accept: "application/json" } });
    if (r.status === 404) { setChat(null); return; }
    if (!r.ok) return;
    const c = await r.json();
    if (st.running && !c.running) return; // our own stream owns the state
    st.msgs = c.messages || []; st.cost = c.cost_usd || 0;
    if (c.running && !st.live) { st.running = true; setTimeout(loadChatWhileRunning, 2000); }
    render(); scrollLog(true);
  } catch { /* daemon down: keep what we have */ }
}
async function loadChatWhileRunning() {
  if (st.live) return; // our own stream
  try {
    const c = await (await fetch(`/api/chat/${encodeURIComponent(st.chatId)}`)).json();
    st.msgs = c.messages || []; st.cost = c.cost_usd || 0; st.running = !!c.running;
    render(); scrollLog();
    if (c.running) setTimeout(loadChatWhileRunning, 2000);
  } catch { st.running = false; render(); }
}

function landed(d, extra = {}) {
  st.msgs.push({ role: "ned", text: d.text || "", ts: Date.now(), cost_usd: d.cost_usd, ...extra });
  if (typeof d.chat_cost_usd === "number") st.cost = d.chat_cost_usd;
  if (typeof d.today_usd === "number" && S.costs) S.costs.today_usd = d.today_usd;
  st.live = null; st.running = false;
  if (!st.open || st.tab !== "chat") {
    const key = `chat:${st.chatId}:${Date.now()}`;
    st.notes.push({ key, title: `${voice().title} · 답이 왔어`, detail: d.text || extra.error || "", ts: Date.now() }); saveNotes();
  }
}

export async function ask(text) {
  text = String(text ?? "").trim();
  if (!text || st.running) return;
  if (text.length > INPUT_MAX) { st.err = `질문은 ${INPUT_MAX}자까지야 (지금 ${text.length}자)`; render(); return; }
  st.err = ""; st.msgs.push({ role: "user", text, ts: Date.now() }); st.live = { text: "", tool: "" }; st.running = true;
  render(); scrollLog(true);
  let r;
  try {
    r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ conversation_id: st.chatId, text }) });
  } catch (e) { return failed(`daemon 에 닿지 않아 (${e.message})`); }
  if (r.status === 404 && st.chatId) { setChat(null); st.msgs.pop(); st.running = false; st.live = null; return ask(text); } // conversation pruned
  if (!r.ok || !r.body) {
    let data = null; try { data = await r.json(); } catch { /* empty */ }
    return failed(data?.error || `POST /api/chat → ${r.status}`, r.status);
  }
  let finished = false;
  const parser = createSseParser((ev, d) => {
    if (ev === "start") { setChat(d.conversation_id); return; }
    if (!st.live) return;
    if (ev === "delta") st.live.text += d.text || "";
    else if (ev === "turn") st.live.text = "";
    else if (ev === "tool") st.live.tool = d.label || d.name || "";
    else if (ev === "done") { finished = true; landed(d, d.stopped ? { stopped: true } : {}); }
    else if (ev === "error") { finished = true; landed(d, { error: d.error || "실패" }); }
    render(); scrollLog();
  });
  try {
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; parser.feed(dec.decode(value, { stream: true })); }
    parser.end();
  } catch { /* connection dropped: the daemon keeps going and saves — reload below */ }
  if (!finished) { st.live = null; st.running = true; render(); setTimeout(loadChatWhileRunning, 1500); }
}
function failed(msg, status) {
  st.live = null; st.running = false;
  st.msgs.push({ role: "ned", text: "", ts: Date.now(), error: status === 429 ? `예산 초과 — ${msg}` : msg });
  render(); scrollLog(true);
}
async function stop() {
  if (!st.chatId || !st.running) return;
  try { await fetch(`/api/chat/${encodeURIComponent(st.chatId)}/stop`, { method: "POST" }); } catch { /* ignore */ }
}
function newChat() {
  if (st.running) return;
  setChat(null); st.msgs = []; st.cost = 0; st.err = ""; render(); q.focus();
}

// ---------- render ----------
function relabel() {
  const v = voice();
  st.persona = persona;
  for (const id of ["cm-mk1", "cm-mk2"]) $(id).innerHTML = MINI;
  $("cm-title").textContent = v.title;
  q.placeholder = v.placeholder;
  dock.setAttribute("aria-label", `${v.title} 열기 (${MOD}J)`);
  panel.setAttribute("aria-label", v.title);
  st.logSig = "";
}

export function render() {
  if (!root) return;
  if (st.persona !== persona) relabel();
  const v = voice();
  // Feed: seed "seen" with whatever is already there on the very first run, so only new arrivals count.
  st.feed = buildFeed({ state: S.state, briefings: S.briefings, agenda: S.agenda, chatNotes: st.notes }, st.seen);
  if (!st.seeded && S.state) { for (const x of st.feed) st.seen.add(x.key); saveSeen(); st.seeded = true; st.feed = st.feed.map((x) => ({ ...x, unread: false })); }
  const conn = S.conn !== false && (S.state ? alive() : true);
  const tk = tickerOf(st.feed, v, { conn, running: st.running });
  $("cm-st").textContent = tk.status;
  $("cm-tk").textContent = tk.line;
  const badge = $("cm-badge"); badge.hidden = !tk.n; badge.textContent = tk.n > 99 ? "99+" : String(tk.n);
  root.dataset.led = tk.led;
  if (st.prevUnread >= 0 && tk.n > st.prevUnread) { dock.classList.remove("ping"); void dock.offsetWidth; dock.classList.add("ping"); setTimeout(() => dock.classList.remove("ping"), 1900); }
  st.prevUnread = tk.n;
  if (!st.open) return;

  $("cm-sub").textContent = st.running ? v.live : conn ? v.idle : v.off;
  $("cm-cost").textContent = `대화 ${usd(st.cost)}${S.costs && typeof S.costs.today_usd === "number" ? ` · 오늘 ${usd(S.costs.today_usd)}` : ""}`;
  $("cm-cost").classList.toggle("over", !!S.costs?.over_budget);
  $("cm-new").disabled = st.running || !st.msgs.length;
  for (const b of panel.querySelectorAll("[data-cmtab]")) b.setAttribute("aria-selected", String(b.dataset.cmtab === st.tab));
  $("cm-chat").hidden = st.tab !== "chat"; $("cm-msgs").hidden = st.tab !== "msgs";
  const unread = st.feed.filter((x) => x.unread).length;
  $("cm-tn").textContent = unread ? String(unread) : "";
  $("cm-allread").hidden = st.tab !== "msgs" || !unread;

  if (st.tab === "chat") {
    const sig = JSON.stringify([st.msgs.length, st.msgs.at(-1)?.ts, st.live, st.err, st.persona]);
    if (sig !== st.logSig) {
      st.logSig = sig;
      log.innerHTML = messagesHtml(st.msgs, v, st.live, (ts) => hhmm(ts)) + (st.err ? `<div class="cm-err">⚠ ${esc(st.err)}</div>` : "");
    }
    const send = $("cm-send");
    send.textContent = st.running ? "중단" : "전송"; send.classList.toggle("go", !st.running); send.classList.toggle("stop", st.running);
    send.title = st.running ? "진행 중인 답을 멈춰" : "전송 (⏎)";
    const n = q.value.length; $("cm-len").textContent = n > INPUT_MAX * 0.8 ? ` · ${n}/${INPUT_MAX}` : "";
  } else $("cm-feed").innerHTML = feedHtml(st.feed, v, rel);
}

function onFeedClick(e) {
  const b = e.target.closest("[data-fi]"); if (!b) return;
  const x = st.feed[+b.dataset.fi]; if (!x) return;
  st.seen.add(x.key); saveSeen();
  if (x.go === "chat") { setTab("chat"); return; }
  if (x.url) window.open(x.url, "_blank", "noopener");
  else { location.hash = `#${x.go}`; close(); }
  render();
}

// ---------- mount ----------
export function init() {
  root = document.createElement("div");
  root.id = "comms"; root.className = "comms";
  root.innerHTML = shellHtml(voice(), MINI, MOD);
  document.body.appendChild(root);
  dock = $("cm-dock"); panel = $("cm-panel"); log = $("cm-log"); q = $("cm-q");
  applyPos(); wireDrag();

  $("cm-close").addEventListener("click", close);
  $("cm-new").addEventListener("click", newChat);
  for (const b of panel.querySelectorAll("[data-cmtab]")) b.addEventListener("click", () => setTab(b.dataset.cmtab));
  $("cm-feed").addEventListener("click", onFeedClick);
  $("cm-allread").addEventListener("click", () => { for (const x of st.feed) st.seen.add(x.key); saveSeen(); render(); });
  $("cm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (st.running) { stop(); return; }
    const t = q.value; if (!t.trim()) return;
    q.value = ""; ask(t);
  });
  q.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // Korean IME: let the syllable finish
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!st.running) $("cm-form").requestSubmit(); }
  });
  q.addEventListener("input", () => { const n = q.value.length; $("cm-len").textContent = n > INPUT_MAX * 0.8 ? ` · ${n}/${INPUT_MAX}` : ""; });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "j" || e.key === "J")) { e.preventDefault(); e.stopPropagation(); toggle(); return; }
    if (e.key === "Escape" && st.open && !document.querySelector("#nsp.open, .modal:not([hidden]), .errpop:not([hidden])")) { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  document.addEventListener("mousedown", (e) => {
    if (!st.open || root.contains(e.target) || e.target.closest?.("#nsp, .modal, .errpop, .pop")) return;
    close();
  }, true);

  subscribe("render", () => render());
  window.NED = window.NED || {};
  window.NED.comms = { open, close, toggle, ask: (t) => { open("chat"); return ask(t); } };
  loadChat();
  if (lsGet(LS.open) === "1") open(); else render();
}
