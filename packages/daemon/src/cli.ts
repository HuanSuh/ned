#!/usr/bin/env node
import fs from "node:fs";
import { archiveTick } from "./archive.js";
import { buildPrompt, enabledSources, readAgenda, refreshAgenda, runningSources } from "./agenda.js";
import { loadConfig, type NedConfig } from "./config.js";
import { WAKE_GAP_MS, createScheduler, eventsActivityAt, hidIdleMs } from "./scheduler.js";
import { createOnlineCheck } from "./online.js";
import { todayCost } from "./costs.js";
import { buildHeartbeatPrompt, hadGoodDailyOn, heartbeat, heartbeatWatchKey, pendingSessionNews, refreshSessions } from "./heartbeat.js";
import { readUnprocessedEvents } from "./events.js";
import { EVENTS_DIR, STATE_PATH, ensureDirs, localDay, log } from "./paths.js";
import { startServer } from "./server.js";
import { readState, writeState } from "./state.js";
import { formatSetupCheck, runSetupCheck } from "./setup-check.js";

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

      // Don't repeat today's daily briefing after a restart: look at the briefing files,
      // not state.last_briefing (a later heartbeat overwrites that). Only a *successful* daily counts —
      // a failed one (claude error / unparsable) runs again on the first tick past briefing_time.
      const hadDailyToday = hadGoodDailyOn(localDay());
      // Hard stop for *automatic* runs once today's spend reaches agenda_daily_budget_usd
      // (manual buttons / POST endpoints are not gated — the user asked for them explicitly).
      let budgetWarnedAt = 0;
      const overBudget = (c: NedConfig, job: string): boolean => {
        const spent = todayCost();
        if (spent < c.agenda_daily_budget_usd) return false;
        if (Date.now() - budgetWarnedAt > 60 * 60_000) {
          budgetWarnedAt = Date.now();
          log(`${job}: skipped — today's spend $${spent.toFixed(2)} ≥ budget $${c.agenda_daily_budget_usd} (config.agenda_daily_budget_usd)`);
        }
        return true;
      };
      // One 1-minute tick for heartbeat + per-source agenda (src/scheduler.ts): intervals stretch / pause during
      // quiet hours (config.quiet_schedule) and while idle (config.idle_schedule). The first tick refreshes every
      // enabled source and runs a heartbeat. refreshAgenda() has its own per-source guard shared with the POST endpoints.
      const sched = createScheduler({
        loadConfig: () => (cfg = loadConfig()),
        overBudget,
        enabledSources,
        runningSources,
        sourcesStatus: () => readAgenda().sources_status,
        refreshAgenda: (c, sources) => refreshAgenda(c, { sources }),
        heartbeat: (c, o) => heartbeat(c, o),
        pendingEvents: pendingSessionNews,
        heartbeatWatchKey: (c) => heartbeatWatchKey(c),
        activityAt: async () => {
          const hid = await hidIdleMs();
          return Math.max(eventsActivityAt(), hid == null ? 0 : Date.now() - hid);
        },
        dailyDoneToday: hadDailyToday,
        // Automatic runs only: skip the tick when api.anthropic.com doesn't resolve, and the first tick after sleep.
        online: createOnlineCheck(),
        wakeGapMs: WAKE_GAP_MS,
        onDailyFailed: (at) => {
          const s = readState();
          s.daily_failed_at = at;
          writeState(s);
        },
        onHeartbeat: (nextAt) => {
          const s = readState();
          s.next_heartbeat_at = nextAt;
          fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
        },
        log,
      });
      await sched.tick();
      setInterval(() => {
        void sched.tick();
        archiveTick(loadConfig()); // fresh read (a busy scheduler tick skips its own reload) — Obsidian 아카이브: flush changed days (src/archive.ts) — no claude, cheap file writes
      }, 60_000);
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
    case "setup-check": {
      // 시작하기 checks (/ned:install runs this after installing): connectors, gh, Slack 팀 ID, code signing.
      const r = await runSetupCheck(loadConfig());
      console.log(flag("--json") ? JSON.stringify(r, null, 2) : formatSetupCheck(r));
      break;
    }
    default:
      console.log(`usage: ned <run|heartbeat [--daily]|state|agenda|prompt <heartbeat|briefing|agenda>|setup-check [--json]>`);
      process.exit(1);
  }
}

main().catch((e) => {
  log(`fatal: ${String(e)}`);
  process.exit(1);
});
