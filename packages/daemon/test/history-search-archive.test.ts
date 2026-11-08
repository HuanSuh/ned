/**
 * 수집 이력 in ⌘K search (records not already in agenda.json, same id scheme, the card anchor) and in the archive's daily
 * report ("## 📥 들어온 것", per source first_seen that day, max INCOMING_MAX lines +N, archive.include.history).
 * Temp NED_HOME (test/setup.ts).
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { INCOMING_MAX, collectDay, mergeReport, renderSections } from "../src/archive.js";
import { DEFAULT_ARCHIVE, HISTORY_SOURCES } from "../src/config.js";
import { HISTORY_META_PATH, historyFile, writeHistory } from "../src/history.js";
import { AGENDA_PATH, CONFIG_PATH, localDay, writeJsonAtomic } from "../src/paths.js";
import { search } from "../src/search.js";

const H = 3600_000, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const rec = (source: string, key: string, t: number, state: Record<string, unknown>, item: Record<string, unknown>, firstSeen = t) => ({ key, source, first_seen: firstSeen, last_seen: t, ts: iso(t), state, item });

beforeEach(() => {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
  fs.rmSync(HISTORY_META_PATH, { force: true });
  fs.rmSync(AGENDA_PATH, { force: true });
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
});

describe("search over the history", () => {
  it("finds a record outside the display window; skips one agenda.json already shows (no duplicate hit)", () => {
    const now = Date.now();
    const old = "https://x.slack.com/archives/C1/p1700000000000100", shown = "https://x.slack.com/archives/C1/p1700000000000200";
    writeHistory("slack", [
      rec("slack", "x.slack.com/archives/C1/p1700000000000100", now - 5 * D, { reason: "mention", need: false, answered: true, acked: false, count: 1 }, { channel: "#dev", from: "kim", text: "지난주 배포 회고 링크", url: old }),
      rec("slack", "x.slack.com/archives/C1/p1700000000000200", now - H, { reason: "mention", need: true, answered: false, acked: false, count: 1 }, { channel: "#dev", from: "lee", text: "배포 회고 오늘", url: shown }),
    ]);
    writeHistory("jira", [rec("jira", "OLD-7", now - 9 * D, { open: false }, { key: "OLD-7", title: "회고 정리", url: "https://x.atlassian.net/browse/OLD-7" })]);
    writeJsonAtomic(AGENDA_PATH, { updated_at: now, cost_usd: 0, calendar: [], jira: [], github: [], mail: null, slack: { summary: "", items: [{ channel: "#dev", from: "lee", text: "배포 회고 오늘", url: shown, ts: iso(now - H), reason: "mention" }], all: [], watch: [] } });
    const hits = search("회고");
    const slack = hits.filter((h) => h.type === "slack");
    expect(slack.map((h) => h.id).sort()).toEqual([old, shown].sort()); // the shown one once (agenda), the old one from history
    const h = slack.find((x) => x.id === old)!;
    expect(h).toMatchObject({ tab: "home", anchor: "card:slack", kind: "slack", url: old });
    expect(h.detail).toMatch(/^이력 · \d+\/\d+ · #dev · kim$/);
    expect(hits.find((x) => x.type === "jira")).toMatchObject({ id: "OLD-7", anchor: "card:jira", tab: "home" });
  });
  it("history off → no history hits", () => {
    writeHistory("jira", [rec("jira", "OLD-7", Date.now() - D, { open: false }, { key: "OLD-7", title: "회고 정리", url: "" })]);
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", history: { enabled: false } }));
    expect(search("회고").filter((x) => x.type === "jira")).toEqual([]);
  });
});

describe("archive 📥 들어온 것", () => {
  const day = localDay(new Date());
  const today = new Date(`${day}T09:00:00`).getTime();
  it("per source, first seen that day only, one line each with link, +N over the cap, marker block", () => {
    const slack = Array.from({ length: INCOMING_MAX + 2 }, (_, i) => rec("slack", `s${i}`, today + i * 60_000, { reason: "mention" }, { channel: "#dev", from: `p${i}`, text: `질문 ${i}`, url: `https://x.slack.com/archives/C1/p17000000000${String(i).padStart(5, "0")}` }));
    writeHistory("slack", [...slack, rec("slack", "old", today - 3 * D, { reason: "dm" }, { channel: "DM", from: "x", text: "어제 것", url: "" }, today - 3 * D)]);
    writeHistory("mail", [rec("mail", "t1", today, { unread: true, needs_action: true }, { id: "t1", from: "재무팀", subject: "법인카드 결재", url: "https://mail.google.com/mail/u/0/#all/t1" })]);
    writeHistory("jira", [rec("jira", "A-1", today, { open: true }, { key: "A-1", title: "정산 배치", url: "https://x.atlassian.net/browse/A-1" })]);
    writeHistory("github", [rec("github", "https://github.com/o/r/pull/7", today, { open: true }, { repo: "o/r", number: 7, title: "fix login", url: "https://github.com/o/r/pull/7" })]);
    writeHistory("calendar", [rec("calendar", "e1", today + 5 * H, { rsvp: "needsAction" }, { id: "e1", title: "분기 계획", all_day: false, url: "https://cal/e1" }, today)]);
    const secs = renderSections(collectDay(day, { session_stale_minutes: 180 }), DEFAULT_ARCHIVE.include);
    const body = secs.find((s) => s.name === "history")!.body;
    expect(body.startsWith("## 📥 들어온 것")).toBe(true);
    expect(body).toContain(`**Slack** ${INCOMING_MAX + 2}`);
    expect(body).toContain("- 09:00 #dev · p0 — [질문 0](https://x.slack.com/archives/C1/p1700000000000000)");
    expect(body).toContain("- … 외 2건");
    expect(body).not.toContain("어제 것");
    expect(body).toContain("- 09:00 재무팀 — [법인카드 결재](https://mail.google.com/mail/u/0/#all/t1)");
    expect(body).toContain("- [A-1](https://x.atlassian.net/browse/A-1) 정산 배치");
    expect(body).toContain("- o/r#7 [fix login](https://github.com/o/r/pull/7)");
    expect(body).toMatch(/- \d+\/\d+ 14:00 \[분기 계획\]\(https:\/\/cal\/e1\)/);
    expect(secs.map((s) => s.name)).toEqual(["briefing", "patrol", "sent", "outputs", "sessions", "history", "today"]);
    const md = mergeReport(null, day, secs);
    expect(md).toContain("<!-- ned:history -->");
    expect(md).toContain("<!-- ned:/history -->");
  });
  it("nothing new → a quiet line; include.history off → no section", () => {
    const secs = renderSections(collectDay(day, { session_stale_minutes: 180 }), DEFAULT_ARCHIVE.include);
    expect(secs.find((s) => s.name === "history")!.body).toContain("_(오늘 새로 들어온 것 없음)_");
    const off = renderSections(collectDay(day, { session_stale_minutes: 180 }), { ...DEFAULT_ARCHIVE.include, history: false });
    expect(off.find((s) => s.name === "history")!.body).toBe("");
  });
});
