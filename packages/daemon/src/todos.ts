import { randomUUID } from "node:crypto";
import { TODOS_PATH, readJson, writeJsonAtomic } from "./paths.js";

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  created_at: number;
  done_at: number | null;
  due: string | null;
  note: string | null;
}

export type TodoPatch = Partial<Pick<Todo, "title" | "done" | "due" | "note">>;

const KEEP_DONE_MS = 7 * 24 * 60 * 60_000;

/** Load todos, pruning items that were completed more than 7 days ago. */
export function listTodos(now = Date.now()): Todo[] {
  const all = readJson<Todo[]>(TODOS_PATH, []);
  const kept = Array.isArray(all) ? all.filter((t) => !(t.done && t.done_at && now - t.done_at > KEEP_DONE_MS)) : [];
  if (Array.isArray(all) && kept.length !== all.length) writeJsonAtomic(TODOS_PATH, kept);
  return kept;
}

const optStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function addTodo(input: { title?: unknown; due?: unknown; note?: unknown }): Todo | null {
  const title = optStr(input.title);
  if (!title) return null;
  const todo: Todo = { id: randomUUID().slice(0, 8), title, done: false, created_at: Date.now(), done_at: null, due: optStr(input.due), note: optStr(input.note) };
  writeJsonAtomic(TODOS_PATH, [...listTodos(), todo]);
  return todo;
}

/** Returns the updated todo, null if not found, or "invalid" for an empty title. */
export function updateTodo(id: string, patch: Record<string, unknown>): Todo | null | "invalid" {
  const todos = listTodos();
  const t = todos.find((x) => x.id === id);
  if (!t) return null;
  if ("title" in patch) {
    const title = optStr(patch.title);
    if (!title) return "invalid";
    t.title = title;
  }
  if ("due" in patch) t.due = optStr(patch.due);
  if ("note" in patch) t.note = optStr(patch.note);
  if ("done" in patch && typeof patch.done === "boolean" && patch.done !== t.done) {
    t.done = patch.done;
    t.done_at = patch.done ? Date.now() : null;
  }
  writeJsonAtomic(TODOS_PATH, todos);
  return t;
}

export function deleteTodo(id: string): boolean {
  const todos = listTodos();
  const next = todos.filter((t) => t.id !== id);
  if (next.length === todos.length) return false;
  writeJsonAtomic(TODOS_PATH, next);
  return true;
}
