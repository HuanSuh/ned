import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { agendaBusy, readAgenda, refreshAgenda } from "./agenda.js";
import { checkRange, fetchCalendarRange } from "./calendar.js";
import { PERSONAS, loadConfig, mergeFilters, normalizePersona, saveConfig, type NedConfig, type PersonaId } from "./config.js";
import { readRecentEvents } from "./events.js";
import { dismissAttention, heartbeat, listBriefings } from "./heartbeat.js";
import { log } from "./paths.js";
import { readState, writeState } from "./state.js";
import { addTodo, deleteTodo, listTodos, updateTodo } from "./todos.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, "../public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Map a URL path to a regular file inside PUBLIC_DIR, or null. Rejects traversal, dotfiles and symlink escapes. */
function resolvePublic(urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes("\0") || rel.split(/[\\/]/).some((seg) => seg.startsWith("."))) return null;
  let file = path.resolve(PUBLIC_DIR, "." + path.posix.normalize("/" + rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const real = fs.realpathSync(file);
    const root = fs.realpathSync(PUBLIC_DIR);
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Routes read config.yaml fresh (loadConfig) instead of the daemon's cached copy, so a PUT /api/config is
 * visible right away (settings reload, agenda refresh) rather than after the next heartbeat tick.
 */
export function startServer(getConfig: () => NedConfig): void {
  const app = new Hono();

  app.get("/", (c) => {
    const index = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(index)) return c.html(fs.readFileSync(index, "utf8"));
    return c.html("<!doctype html><title>Ned</title><p>Ned daemon is running. API: /api/state, /api/events, /api/briefings, /api/config</p>");
  });
  app.get("/api/state", (c) => c.json(readState()));
  app.get("/api/events", (c) => c.json(readRecentEvents(Number(c.req.query("days") ?? 2))));
  app.get("/api/briefings", (c) => c.json(listBriefings(Number(c.req.query("limit") ?? 30))));
  app.get("/api/config", (c) => c.json(loadConfig()));
  app.put("/api/config", async (c) => {
    const body = (await c.req.json()) as Partial<NedConfig>;
    const cur = loadConfig();
    // filters is nested: merge it per source so a PUT carrying only filters.slack keeps filters.jira.
    // An unknown persona value keeps the current one.
    const merged = { ...cur, ...body, persona: PERSONAS.includes(body.persona as PersonaId) ? normalizePersona(body.persona) : cur.persona, filters: mergeFilters(cur.filters, body.filters) };
    saveConfig(merged);
    // Mirror the persona into state.json right away so the dashboard / menu-bar app switch without waiting a tick.
    const st = readState();
    if (st.persona !== merged.persona) { st.persona = merged.persona; writeState(st); }
    return c.json(merged);
  });
  app.post("/api/heartbeat", async (c) => {
    const daily = c.req.query("daily") === "1";
    const b = await heartbeat(loadConfig(), { force: true, daily });
    return c.json(b ?? { status: "skipped" });
  });
  app.post("/api/attention/:id/dismiss", (c) => {
    dismissAttention(c.req.param("id"));
    return c.json({ ok: true });
  });

  // HOME tab: agenda (calendar / jira / github), refreshed by a cheap structured claude -p job.
  // mail_enabled / slack_enabled (= sources.gmail / sources.slack) let HOME hide those cards even if agenda.json still has old data.
  app.get("/api/agenda", (c) => {
    const { sources } = loadConfig();
    return c.json({ ...readAgenda(), busy: agendaBusy(), mail_enabled: sources.gmail, slack_enabled: sources.slack });
  });
  app.post("/api/agenda/refresh", async (c) => {
    // Concurrent refreshes share the in-flight run instead of spawning another claude -p.
    const cfg = loadConfig();
    const a = await refreshAgenda(cfg);
    return c.json({ ...a, mail_enabled: cfg.sources.gmail, slack_enabled: cfg.sources.slack });
  });

  // HOME tab: calendar ranges outside agenda.calendar_range (week view navigation). Cached 6 h; one claude -p at a time.
  app.get("/api/calendar", async (c) => {
    const from = c.req.query("from"), to = c.req.query("to");
    const bad = checkRange(from, to);
    if (bad) return c.json({ error: bad }, 400);
    return c.json(await fetchCalendarRange(loadConfig(), from as string, to as string));
  });

  // HOME tab: personal todos.
  const readBody = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  app.get("/api/todos", (c) => c.json(listTodos()));
  app.post("/api/todos", async (c) => {
    const t = addTodo(await readBody(c));
    return t ? c.json(t, 201) : c.json({ error: "title required" }, 400);
  });
  app.patch("/api/todos/:id", async (c) => {
    const t = updateTodo(c.req.param("id"), await readBody(c));
    if (t === "invalid") return c.json({ error: "title must be non-empty" }, 400);
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/todos/:id", (c) => (deleteTodo(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  // Static files under public/ (proposals, svg mark, ...). Registered last so /api/* wins.
  app.get("/*", (c) => {
    const file = resolvePublic(c.req.path);
    if (!file) return c.text("Not found", 404);
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return c.body(fs.readFileSync(file), 200, { "content-type": type, "cache-control": "no-cache" });
  });

  const port = getConfig().port;
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  log(`dashboard on http://127.0.0.1:${port}`);
}
