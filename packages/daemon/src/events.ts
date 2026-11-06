import fs from "node:fs";
import path from "node:path";
import { CURSOR_PATH, EVENTS_DIR, readJson, writeJsonAtomic } from "./paths.js";

export interface NedEvent {
  ts: number;
  event: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  message?: string;
  notification_type?: string;
  source?: string;
  reason?: string;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
  orca_worktree?: string;
  orca_pane?: string;
  [k: string]: unknown;
}

function dayFile(d: Date): string {
  return path.join(EVENTS_DIR, `${d.toISOString().slice(0, 10)}.jsonl`);
}

function parseLines(text: string): NedEvent[] {
  const out: NedEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NedEvent);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** All events from the last `days` days (default: today + yesterday), oldest first. */
export function readRecentEvents(days = 2): NedEvent[] {
  const events: NedEvent[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const f = dayFile(d);
    if (fs.existsSync(f)) events.push(...parseLines(fs.readFileSync(f, "utf8")));
  }
  return events.sort((a, b) => a.ts - b.ts);
}

interface Cursor {
  last_ts: number;
}

/** Events newer than the cursor. Call `commitCursor` after processing. */
export function readUnprocessedEvents(): { events: NedEvent[]; commit: () => void } {
  const cursor = readJson<Cursor>(CURSOR_PATH, { last_ts: 0 });
  const all = readRecentEvents(2);
  const events = all.filter((e) => e.ts > cursor.last_ts);
  const maxTs = events.length ? events[events.length - 1].ts : cursor.last_ts;
  return { events, commit: () => writeJsonAtomic(CURSOR_PATH, { last_ts: maxTs }) };
}

/** Last assistant text in a Claude Code transcript (jsonl), trimmed. */
export function lastAssistantText(transcriptPath: string | undefined, maxLen = 240): string | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, "r");
    const size = Math.min(stat.size, 256 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const rec = JSON.parse(line);
        const content = rec?.message?.content;
        if (!Array.isArray(content)) continue;
        const text = content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
      } catch {
        /* partial line */
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}
