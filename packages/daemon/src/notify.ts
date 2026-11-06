import { execFile } from "node:child_process";
import { log } from "./paths.js";

/**
 * Who shows briefing banners.
 * - `auto` (default): Ned.app when it spawned this daemon (`NED_NOTIFY=app`), else osascript.
 * - `osascript`: always osascript (banners appear as "Script Editor").
 * - `off`: no banners from the daemon.
 */
export type NotifyMode = "auto" | "osascript" | "off";

/** Resolves `config.notify` + `NED_NOTIFY` into what the daemon itself should do. */
export function notifyBackend(mode: NotifyMode = "auto", env = process.env): "osascript" | "app" | "off" {
  if (mode === "off") return "off";
  if (mode === "osascript") return "osascript";
  return env.NED_NOTIFY === "app" ? "app" : "osascript";
}

/** Banner for a briefing. Ned.app notifies from state.json itself, so under it this only logs. */
export function notify(title: string, body: string, mode: NotifyMode = "auto"): void {
  const backend = notifyBackend(mode);
  if (backend !== "osascript") {
    log(`notify: ${backend === "app" ? "delegated to Ned.app (NED_NOTIFY=app)" : "off (config.notify)"} — no osascript: ${body.slice(0, 80)}`);
    return;
  }
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
  log(`notify: osascript — ${body.slice(0, 80)}`);
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
}
