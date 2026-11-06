import { execFile } from "node:child_process";

/** macOS banner via osascript. Fails silently elsewhere. */
export function notify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
}
