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

export function startServer(getConfig: () => NedConfig): void {
  const app = new Hono();

  app.get("/", (c) => c.html(fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")));
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

  const port = getConfig().port;
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  log(`dashboard on http://127.0.0.1:${port}`);
}
