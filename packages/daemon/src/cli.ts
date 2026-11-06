#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { heartbeat, listBriefings, refreshSessions } from "./heartbeat.js";
import { EVENTS_DIR, STATE_PATH, ensureDirs, localDay, log } from "./paths.js";
import { startServer } from "./server.js";
import { readState } from "./state.js";

const [, , cmd = "run", ...rest] = process.argv;
const flag = (f: string) => rest.includes(f);

ensureDirs();

async function main(): Promise<void> {
  switch (cmd) {
    case "run": {
      let cfg = loadConfig();
      const getConfig = () => cfg;
      log(`ned daemon starting (pid ${process.pid}, heartbeat ${cfg.heartbeat_minutes}m, signals every ${cfg.signal_check_minutes}m)`);
      startServer(getConfig);
      refreshSessions(cfg);

      // Cheap session refresh whenever an events file changes.
      fs.watch(EVENTS_DIR, { persistent: true }, () => {
        try {
          refreshSessions(cfg);
        } catch (e) {
          log(`refresh failed: ${String(e)}`);
        }
      });

      let busy = false;
      // Don't repeat today's daily briefing after a restart: look at the briefing files,
      // not state.last_briefing (a later heartbeat overwrites that).
      const hadDailyToday = listBriefings(50).some((b) => b.type === "daily" && localDay(new Date(b.ts)) === localDay());
      let lastDaily = hadDailyToday ? localDay() : "";
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          cfg = loadConfig();
          const today = localDay();
          const hhmm = new Date().toTimeString().slice(0, 5);
          const dailyDue = lastDaily !== today && hhmm >= cfg.briefing_time;
          if (dailyDue) lastDaily = today;
          await heartbeat(cfg, { daily: dailyDue });
          const s = readState();
          s.next_heartbeat_at = Date.now() + cfg.heartbeat_minutes * 60_000;
          fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
        } catch (e) {
          log(`heartbeat failed: ${String(e)}`);
        } finally {
          busy = false;
        }
      };
      await tick();
      setInterval(tick, cfg.heartbeat_minutes * 60_000);
      break;
    }
    case "heartbeat": {
      const b = await heartbeat(loadConfig(), { force: true, daily: flag("--daily") });
      console.log(JSON.stringify(b, null, 2));
      break;
    }
    case "state": {
      refreshSessions(loadConfig());
      console.log(JSON.stringify(readState(), null, 2));
      break;
    }
    default:
      console.log(`usage: ned <run|heartbeat [--daily]|state>`);
      process.exit(1);
  }
}

main().catch((e) => {
  log(`fatal: ${String(e)}`);
  process.exit(1);
});
