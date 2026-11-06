/* Shared store: S (server data), ui (view state) + a tiny pub/sub. Every module reads/writes these objects. */
import { ALIVE_MS, lsGet, lsSet } from "./util.js";

export const S = { agenda: undefined, todos: undefined, agBusy: null, state: null, events: [], briefings: [], config: null, conn: null, busy: null, filterType: new Set(), filterWt: new Set() };
export const ui = { view: "home", tab: "priority", selKey: null, sel: 0, read: loadRead(), railOff: lsGet("ned.railOff") === "1", detailSig: "" };
export function loadRead() { try { return new Set(JSON.parse(lsGet("ned.read") || "[]")); } catch { return new Set(); } }
export function saveRead() { lsSet("ned.read", JSON.stringify([...ui.read].slice(-400))); }

// ---------- pub/sub: main.js emits "render" (detail = ui.view) after every renderAll(); modules may subscribe
// instead of importing each other's render functions.
const subs = new Map();
export function subscribe(event, fn) { if (!subs.has(event)) subs.set(event, new Set()); subs.get(event).add(fn); return () => subs.get(event).delete(fn); }
export function emit(event, detail) { for (const fn of subs.get(event) || []) fn(detail); }
export const store = { S, ui, subscribe, emit };

export const alive = () => S.conn !== false && !!S.state?.updated_at && Date.now() - S.state.updated_at < ALIVE_MS;
