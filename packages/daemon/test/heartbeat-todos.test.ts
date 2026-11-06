import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { heartbeat, keyOf, markSent, refreshSessions, sentKeys } from "../src/heartbeat.js";
import { CONFIG_PATH, EVENTS_DIR, SENT_LOG, STATE_PATH, TODOS_PATH, localDay } from "../src/paths.js";
import { readState } from "../src/state.js";
import { addTodo, deleteTodo, listTodos, updateTodo } from "../src/todos.js";

describe("heartbeat sent-key dedupe helpers", () => {
  beforeEach(() => fs.rmSync(SENT_LOG, { force: true }));

  it("keyOf prefers url, else title; trimmed + lower-cased", () => {
    expect(keyOf({ title: "T", url: " HTTPS://X/Y " } as never)).toBe("https://x/y");
    expect(keyOf({ title: "  Deploy FAILED " } as never)).toBe("deploy failed");
  });

  it("markSent appends and sentKeys reads back a set; empty input writes nothing", () => {
    expect(sentKeys().size).toBe(0);
    markSent([]);
    expect(fs.existsSync(SENT_LOG)).toBe(false);
    markSent(["a", "b"]);
    markSent(["b", "c"]);
    expect([...sentKeys()].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("heartbeat (NED_NO_LLM, end-to-end on temp NED_HOME)", () => {
  beforeEach(() => {
    fs.rmSync(SENT_LOG, { force: true });
    fs.rmSync(STATE_PATH, { force: true });
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", quiet_hours: null }));
  });
  afterEach(() => {
    delete process.env.NED_NO_LLM_RESULT;
  });

  it("an UPDATE briefing surfaces items once; a repeat of the same items is deduped to NED_OK", async () => {
    process.env.NED_NO_LLM_RESULT = JSON.stringify({ status: "UPDATE", headline: "h", action_items: [{ kind: "jira", title: "Review APP-1", url: "https://jira/APP-1" }], updates: [{ title: "Deploy done" }] });
    const b1 = (await heartbeat(loadConfig(), { force: true }))!;
    expect(b1.status).toBe("UPDATE");
    expect(b1.action_items).toHaveLength(1);
    expect(sentKeys().has("https://jira/apP-1".toLowerCase())).toBe(true);
    expect(readState().attention.some((a) => a.title === "Review APP-1")).toBe(true);

    const b2 = (await heartbeat(loadConfig(), { force: true }))!;
    expect(b2.action_items).toEqual([]);
    expect(b2.updates).toEqual([]);
    expect(b2.status).toBe("NED_OK");
  });

  it("without force and nothing new it stays silent (returns null)", async () => {
    await heartbeat(loadConfig(), { force: true });
    expect(await heartbeat(loadConfig())).toBeNull();
  });

  it("refreshSessions turns a waiting session into a session attention item", () => {
    const now = Date.now();
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVENTS_DIR, `${localDay()}.jsonl`), [{ ts: now - 1000, event: "SessionStart", session_id: "sx", cwd: "/w/wt-x" }, { ts: now, event: "Notification", session_id: "sx", message: "permission?" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    refreshSessions(loadConfig());
    const st = readState();
    expect(st.sessions[0]).toMatchObject({ id: "sx", status: "waiting" });
    expect(st.attention.find((a) => a.id === "session:sx")).toMatchObject({ kind: "session", source: "sessions", detail: "permission?" });
    expect(st.attention_open_count).toBeGreaterThan(0);
    fs.rmSync(path.join(EVENTS_DIR, `${localDay()}.jsonl`), { force: true });
  });
});

describe("todos CRUD", () => {
  beforeEach(() => fs.rmSync(TODOS_PATH, { force: true }));

  it("add requires a non-empty title and trims fields", () => {
    expect(addTodo({ title: "   " })).toBeNull();
    expect(addTodo({})).toBeNull();
    const t = addTodo({ title: "  write tests ", due: "2026-11-07", note: "" })!;
    expect(t).toMatchObject({ title: "write tests", done: false, due: "2026-11-07", note: null, done_at: null });
    expect(listTodos()).toHaveLength(1);
  });

  it("update: done toggles done_at, empty title is invalid, unknown id is null", () => {
    const t = addTodo({ title: "a" })!;
    const done = updateTodo(t.id, { done: true }) as { done: boolean; done_at: number };
    expect(done.done).toBe(true);
    expect(done.done_at).toBeGreaterThan(0);
    expect((updateTodo(t.id, { done: false }) as { done_at: number | null }).done_at).toBeNull();
    expect(updateTodo(t.id, { title: "" })).toBe("invalid");
    expect(updateTodo("nope", { title: "x" })).toBeNull();
    expect((updateTodo(t.id, { note: " n ", due: null }) as { note: string; due: null }).note).toBe("n");
  });

  it("delete removes once, then reports not found", () => {
    const t = addTodo({ title: "a" })!;
    addTodo({ title: "b" });
    expect(deleteTodo(t.id)).toBe(true);
    expect(deleteTodo(t.id)).toBe(false);
    expect(listTodos().map((x) => x.title)).toEqual(["b"]);
  });

  it("listTodos prunes items done more than 7 days ago and persists the prune", () => {
    const now = Date.now();
    const old = { id: "old", title: "old", done: true, created_at: 0, done_at: now - 8 * 86_400_000, due: null, note: null };
    const recent = { id: "new", title: "new", done: true, created_at: 0, done_at: now - 86_400_000, due: null, note: null };
    fs.writeFileSync(TODOS_PATH, JSON.stringify([old, recent]));
    expect(listTodos(now).map((t) => t.id)).toEqual(["new"]);
    expect(JSON.parse(fs.readFileSync(TODOS_PATH, "utf8"))).toHaveLength(1);
  });

  it("a corrupt todos.json reads as empty", () => {
    fs.writeFileSync(TODOS_PATH, "{oops");
    expect(listTodos()).toEqual([]);
    fs.writeFileSync(TODOS_PATH, JSON.stringify({ not: "array" }));
    expect(listTodos()).toEqual([]);
  });
});

describe("known bugs (see test/BUGS.md) — it.fails passes while the bug exists", () => {
  beforeEach(() => {
    fs.rmSync(SENT_LOG, { force: true });
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", quiet_hours: null }));
  });
  afterEach(() => {
    delete process.env.NED_NO_LLM_RESULT;
  });

  it.fails("BUG-2: an item with url \"\" is never deduped (keyOf uses ?? so the key is empty and sent.log drops it)", async () => {
    process.env.NED_NO_LLM_RESULT = JSON.stringify({ status: "UPDATE", action_items: [{ title: "Same thing again", url: "" }] });
    await heartbeat(loadConfig(), { force: true });
    const b2 = (await heartbeat(loadConfig(), { force: true }))!;
    expect(b2.action_items).toEqual([]);
  });
});
