#!/usr/bin/env node
import fs from "node:fs";
import { buildPrompt, enabledSources, readAgenda, refreshAgenda, runningSources } from "./agenda.js";
import { loadConfig, sourceRefreshMinutes } from "./config.js";
import { dueSources, lastRuns, type SourceTimes } from "./schedule.js";
import { todayCost } from "./costs.js";
import { buildHeartbeatPrompt, heartbeat, listBriefings, refreshSessions } from "./heartbeat.js";
import { readUnprocessedEvents } from "./events.js";
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
          if (overBudget(cfg, "heartbeat")) return;
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
      // Agenda (dashboard HOME): at start, then every agenda_refresh_minutes. Runs alongside heartbeats;
      // refreshAgenda() has its own busy guard shared with POST /api/agenda/refresh.
      // Hard stop for *automatic* runs once today's spend reaches agenda_daily_budget_usd
      // (manual buttons / POST endpoints are not gated — the user asked for them explicitly).
      let budgetWarnedAt = 0;
      const overBudget = (c: ReturnType<typeof loadConfig>, job: string): boolean => {
        const spent = todayCost();
        if (spent < c.agenda_daily_budget_usd) return false;
        if (Date.now() - budgetWarnedAt > 60 * 60_000) {
          budgetWarnedAt = Date.now();
          log(`${job}: skipped — today's spend $${spent.toFixed(2)} ≥ budget $${c.agenda_daily_budget_usd} (config.agenda_daily_budget_usd)`);
        }
        return true;
      };
      // Per-source schedule: tick every minute, refresh the sources whose interval
      // (agenda_source_minutes[k] ?? agenda_refresh_minutes) has passed since their last run, all due ones in one call.
      // The first tick (daemon start) refreshes every enabled source.
      const scheduled: SourceTimes = {};
      let firstAgenda = true;
      const agendaTick = () => {
        try {
          const c = loadConfig();
          if (overBudget(c, "agenda")) return;
          const now = Date.now();
          const enabled = enabledSources(c);
          const live = runningSources();
          const last = lastRuns(scheduled, readAgenda().sources_status, enabled);
          const due = firstAgenda ? enabled.filter((k) => !live.includes(k)) : dueSources(c, enabled, last, now, live);
          if (!due.length) return;
          const why = firstAgenda ? "startup" : `due: ${due.map((k) => `${k} ${sourceRefreshMinutes(c, k)}m`).join(", ")}`;
          firstAgenda = false;
          for (const k of due) scheduled[k] = now;
          log(`agenda: scheduled refresh [${due.join(",")}] (${why})`);
          refreshAgenda(c, { sources: due }).catch((e) => log(`agenda failed: ${String(e)}`));
        } catch (e) {
          log(`agenda tick failed: ${String(e)}`);
        }
      };
      agendaTick();
      setInterval(agendaTick, 60_000);

      await tick();
      setInterval(tick, cfg.heartbeat_minutes * 60_000);
      break;
    }
    case "agenda": {
      const a = await refreshAgenda(loadConfig());
      console.log(JSON.stringify(a, null, 2));
      break;
    }
    case "prompt": {
      // Dry run: print the rendered prompt (no claude call, nothing committed).
      const which = rest[0] ?? "heartbeat";
      const cfg = loadConfig();
      if (which === "agenda") console.log(buildPrompt(cfg));
      else if (which === "heartbeat" || which === "briefing") console.log(buildHeartbeatPrompt(cfg, which === "briefing", readState(), readUnprocessedEvents().events));
      else throw new Error(`unknown prompt: ${which} (heartbeat | briefing | agenda)`);
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
      console.log(`usage: ned <run|heartbeat [--daily]|state|agenda|prompt <heartbeat|briefing|agenda>>`);
      process.exit(1);
  }
}

main().catch((e) => {
  log(`fatal: ${String(e)}`);
  process.exit(1);
});
