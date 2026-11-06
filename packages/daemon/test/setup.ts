/**
 * Runs before every test file (before the file's imports are evaluated), so src/paths.ts sees a fresh
 * temp NED_HOME. Never the real ~/.ned, never claude (NED_NO_LLM=1), never osascript banners, never port 7777.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ned-test-"));
process.env.NED_HOME = home;
process.env.NED_NO_LLM = "1";
process.env.NED_PORT = "7791";
process.env.NED_NOTIFY = "app"; // notify(): log only, no osascript
process.env.NED_SEND_DRY_RUN = "1";
delete process.env.NED_NO_LLM_RESULT;
delete process.env.NED_NO_LLM_AGENDA;
delete process.env.NED_NO_LLM_DELAY_MS;
delete process.env.NED_NO_LLM_COST;
for (const d of ["events", "briefings", "logs", "calendar"]) fs.mkdirSync(path.join(home, d), { recursive: true });

afterAll(() => {
  if (path.isAbsolute(home) && home.startsWith(path.join(os.tmpdir(), "ned-test-"))) fs.rmSync(home, { recursive: true, force: true });
});
