/**
 * docs/FEATURES.md coverage: every config key, settings-tab input and /api route must appear in the guide (요약 or 상세)
 * as a literal string. The guide's 요약 is what the Ned Net chat knows about Ned itself (src/chat.ts), so a feature that
 * isn't written down is one the chat can't explain. Intentionally undocumented items go in ALLOWLIST with a reason.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

/** Items deliberately left out of docs/FEATURES.md — `item` exactly as the check names it, plus why. */
const ALLOWLIST: { item: string; reason: string }[] = [
  { item: "/api/send/:job_id", reason: "보내기 작업 폴링 — 대시보드 내부(sendjob.js), 사용자 기능 아님" },
  { item: "/api/calendar/events/:job_id", reason: "일정 만들기 작업 폴링 — 대시보드 내부(calcreate.js)" },
  { item: "/api/draft/status", reason: "초안 미리 생성 진단용 — 화면에 노출 안 됨" },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const read = (p: string) => fs.readFileSync(path.resolve(pkg, p), "utf8");
const DOC = read("../../docs/FEATURES.md");
const allowed = new Set(ALLOWLIST.map((a) => a.item));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Literal occurrence, not as part of a longer identifier/key/path (`notify` ≠ `notifications`, `actions` ok in `actions.x`). */
const inDoc = (item: string) => new RegExp(`(?<![\\w.\\-/])${esc(item)}(?![\\w\\-])`).test(DOC);

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sub = (prefix: string): string[] => {
  let v: unknown = DEFAULT_CONFIG;
  for (const k of prefix.split(".")) v = isPlain(v) ? v[k] : undefined;
  return isPlain(v) ? Object.keys(v).map((k) => `${prefix}.${k}`) : [];
};

/** (a) config keys: every top-level key + the nested ones users actually toggle. */
function configKeys(): string[] {
  return [
    ...Object.keys(DEFAULT_CONFIG),
    ...sub("actions"),
    ...sub("notifications.kinds"),
    ...sub("filters.slack"),
    ...sub("filters.jira"),
    ...["dashboard.theme", "dashboard.watch_cards", "dashboard.locked", "dashboard.open_links_in_app", "dashboard.slack_team_id", "dashboard.slack_team_domain", "dashboard.session_quick_replies"],
    ...sub("dashboard.open_links_in_app_by_service"),
    ...sub("quiet_schedule"),
    ...sub("idle_schedule"),
    ...sub("agenda_source_minutes"),
    ...sub("archive"),
    ...sub("archive.include"),
    ...sub("history"),
    ...sub("history.display"),
    ...sub("history.keep_days"),
    ...sub("history.collect"),
    ...sub("pet"),
    ...sub("pet.messages"),
  ];
}

/** (b) settings-tab inputs in index.html (`c-*`, `n-*`, `x-*-in` on input/select/textarea or a control group) + data-act keys. */
function settingsInputs(): string[] {
  const html = read("public/index.html");
  const start = html.indexOf('id="v-settings"');
  const end = html.indexOf("<main", start + 1);
  const view = html.slice(start, end < 0 ? undefined : end);
  const ids = new Set<string>();
  for (const m of view.matchAll(/<(input|select|textarea|div)\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (!id || !/^(c-.+|n-.+|x-.+-in)$/.test(id)) continue;
    if (m[1] === "div" && !/\brole="(group|radiogroup|list)"/.test(tag)) continue;
    ids.add(id);
  }
  // data-act toggles are rendered from settings-actions.js (WA_GROUPS keys) → actions.<key>
  const acts = read("public/app/tabs/settings-actions.js");
  for (const m of acts.matchAll(/keys:\s*\[([^\]]*)\]/g)) for (const k of m[1].matchAll(/"([a-z_]+)"/g)) ids.add(`actions.${k[1]}`);
  for (const m of view.matchAll(/data-act="([a-z_]+)"/g)) ids.add(`actions.${m[1]}`);
  return [...ids];
}

/** (c) /api routes registered in server.ts (and search.ts, mounted by it). */
function apiRoutes(): string[] {
  const src = read("src/server.ts") + read("src/search.ts");
  return [...new Set([...src.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*"(\/api\/[^"]+)"/g)].map((m) => m[1]))];
}

const missing = (items: string[]) => [...new Set(items)].filter((i) => !allowed.has(i) && !inDoc(i));
const fail = (items: string[]) => `docs/FEATURES.md 에 없음: ${items.join(", ")} — 기능을 추가/변경했으면 요약과 해당 항목을 갱신하세요`;

describe("docs/FEATURES.md covers every feature surface", () => {
  it("inventories are non-trivial (the extractors still find things)", () => {
    expect(configKeys().length).toBeGreaterThan(50);
    expect(settingsInputs()).toEqual(expect.arrayContaining(["c-theme", "n-on", "x-watch-in", "actions.gmail_mark_read"]));
    expect(apiRoutes()).toEqual(expect.arrayContaining(["/api/chat", "/api/config", "/api/search"]));
  });

  it("(a) config keys", () => {
    const m = missing(configKeys());
    expect(m, fail(m)).toEqual([]);
  });

  it("(b) settings-tab inputs and write-action toggles", () => {
    const m = missing(settingsInputs());
    expect(m, fail(m)).toEqual([]);
  });

  it("(c) /api routes", () => {
    const m = missing(apiRoutes());
    expect(m, fail(m)).toEqual([]);
  });

  it("ALLOWLIST entries have a reason and still exist (no stale exemptions)", () => {
    const all = new Set([...configKeys(), ...settingsInputs(), ...apiRoutes()]);
    for (const a of ALLOWLIST) {
      expect(a.reason.trim(), a.item).not.toBe("");
      expect(all.has(a.item), `ALLOWLIST 의 ${a.item} 는 더 이상 없음 — 빼 주세요`).toBe(true);
    }
  });
});
