import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig, saveConfig, type NedConfig } from "./config.js";
import { readRecentEvents } from "./events.js";
import { dismissAttention, heartbeat, listBriefings } from "./heartbeat.js";
import { log } from "./paths.js";
import { readState } from "./state.js";

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
  app.get("/api/config", (c) => c.json(getConfig()));
  app.put("/api/config", async (c) => {
    const body = (await c.req.json()) as Partial<NedConfig>;
    const merged = { ...loadConfig(), ...body };
    saveConfig(merged);
    return c.json(merged);
  });
  app.post("/api/heartbeat", async (c) => {
    const daily = c.req.query("daily") === "1";
    const b = await heartbeat(getConfig(), { force: true, daily });
    return c.json(b ?? { status: "skipped" });
  });
  app.post("/api/attention/:id/dismiss", (c) => {
    dismissAttention(c.req.param("id"));
    return c.json({ ok: true });
  });

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
