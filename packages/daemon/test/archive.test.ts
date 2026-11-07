/**
 * Obsidian 아카이브 (src/archive.ts + src/vault.ts) against a temp vault: vault checks, path traversal, marker blocks
 * (user text outside them survives), the daily report sections, the midnight boundary, tick flushing, the daily-note embed
 * (only into an existing note) and write failures (recorded, never thrown). Never the user's real vault.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

const { CONFIG_PATH, BRIEFINGS_DIR, NED_HOME, localDay } = await import("../src/paths.js");
const { loadConfig, normalizeArchive, normalizeArchiveFolder, DEFAULT_ARCHIVE } = await import("../src/config.js");
const { SENT_ACTIONS_LOG, appendActionLog } = await import("../src/actions.js");
const vault = await import("../src/vault.js");
const archive = await import("../src/archive.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ned-vault-test-"));
afterAll(() => {
  if (tmpRoot.startsWith(path.join(os.tmpdir(), "ned-vault-test-"))) fs.rmSync(tmpRoot, { recursive: true, force: true });
});
let V = "";
let n = 0;
const newVault = (obsidian = true) => {
  const v = path.join(tmpRoot, `v${++n}`);
  fs.mkdirSync(v, { recursive: true });
  if (obsidian) fs.mkdirSync(path.join(v, ".obsidian"));
  return v;
};
const setConfig = (archiveCfg: Record<string, unknown>) =>
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", archive: { enabled: true, vault: V, ...archiveCfg } }));
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const briefingFile = (b: Record<string, unknown> & { ts: number }) => {
  const id = new Date(b.ts).toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(BRIEFINGS_DIR, `${id}.json`), JSON.stringify({ id, action_items: [], updates: [], fyi: [], ...b }));
};
const report = (day: string, folder = "Ned") => path.join(V, folder, "Daily", day.slice(0, 7), `${day}.md`);

beforeEach(() => {
  V = newVault();
  for (const f of fs.readdirSync(BRIEFINGS_DIR)) fs.rmSync(path.join(BRIEFINGS_DIR, f), { force: true });
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  fs.rmSync(vault.ARCHIVE_STATE_PATH, { force: true });
  setConfig({});
});

describe("config.archive", () => {
  it("defaults off, folder Ned, sessions off", () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
    expect(loadConfig().archive).toEqual(DEFAULT_ARCHIVE);
    expect(DEFAULT_ARCHIVE).toMatchObject({ enabled: false, vault: "", folder: "Ned", daily_embed: false, include: { briefings: true, updates: true, actions: true, outputs: true, sessions: false } });
  });
  it("normalizes: ~ expansion, partial patches keep base, bad folders fall back", () => {
    const a = normalizeArchive({ vault: "~/Notes/", include: { sessions: true } });
    expect(a.vault).toBe(path.join(os.homedir(), "Notes"));
    expect(a.include).toEqual({ ...DEFAULT_ARCHIVE.include, sessions: true });
    expect(normalizeArchive({ enabled: "yes" }, { ...DEFAULT_ARCHIVE, enabled: true }).enabled).toBe(true);
    expect(normalizeArchiveFolder("/Ned/Log/")).toBe("Ned/Log");
    expect(normalizeArchiveFolder("../x", "Ned")).toBe("Ned");
    expect(normalizeArchiveFolder(".obsidian", "Ned")).toBe("Ned");
    expect(normalizeArchiveFolder("", "X")).toBe("Ned");
  });
});

describe("vault checks + path safety", () => {
  it("checkVault: ok / no .obsidian (warning only) / missing / relative / a file / inside ~/.ned or the repo", () => {
    expect(vault.checkVault(V)).toMatchObject({ ok: true, obsidian: true });
    expect(vault.checkVault(newVault(false))).toMatchObject({ ok: true, obsidian: false });
    expect(vault.checkVault(path.join(tmpRoot, "nope")).ok).toBe(false);
    expect(vault.checkVault("rel/path").ok).toBe(false);
    const f = path.join(tmpRoot, "file.txt");
    fs.writeFileSync(f, "x");
    expect(vault.checkVault(f).ok).toBe(false);
    fs.mkdirSync(path.join(NED_HOME, "vault"), { recursive: true });
    expect(vault.checkVault(path.join(NED_HOME, "vault")).error).toMatch(/~\/\.ned/);
    expect(vault.checkVault(vault.REPO_ROOT).error).toMatch(/레포/);
    expect(vault.checkVault(path.join(vault.REPO_ROOT, "docs")).ok).toBe(false);
    expect(vault.checkVault(path.dirname(NED_HOME)).ok).toBe(false); // a parent of ~/.ned too
  });

  it("resolveInVault refuses traversal, absolute paths and symlink escapes", () => {
    expect(vault.resolveInVault(V, "Ned/Daily/x.md")).toBe(path.join(V, "Ned/Daily/x.md"));
    expect(() => vault.resolveInVault(V, "../out.md")).toThrow(/escapes/);
    expect(() => vault.resolveInVault(V, "Ned/../../out.md")).toThrow(/escapes/);
    expect(() => vault.resolveInVault(V, "/etc/passwd")).toThrow();
    expect(() => vault.resolveInVault(V, "")).toThrow();
    const outside = path.join(tmpRoot, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(V, "link"));
    expect(() => vault.resolveInVault(V, "link/x.md")).toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe("marker blocks", () => {
  const blocks = (a: string, b: string) => [{ name: "a", body: a }, { name: "b", body: b }];

  it("replaces only inside the markers; user text around them is kept byte-for-byte", () => {
    const first = vault.replaceBlocks("# head\n", blocks("A1", "B1"));
    expect(first).toBe("# head\n\n<!-- ned:a -->\nA1\n<!-- ned:/a -->\n\n<!-- ned:b -->\nB1\n<!-- ned:/b -->\n");
    const edited = first.replace("# head\n", "# head\nmy note  \n").replace("<!-- ned:/a -->\n", "<!-- ned:/a -->\nbetween — 메모\n") + "tail ✍️\n";
    const second = vault.replaceBlocks(edited, blocks("A2", "B2"));
    expect(second).toBe(edited.replace("A1", "A2").replace("B1", "B2"));
  });

  it("a deleted marker → that section is appended as a new block; no user text is eaten, then or later", () => {
    const first = vault.replaceBlocks("", blocks("A1", "B1"));
    const broken = first.replace("<!-- ned:/a -->", "").replace("A1", "A1 user kept this");
    const second = vault.replaceBlocks(broken, blocks("A2", "B2"));
    expect(second).toContain("A1 user kept this");
    expect(second.trimEnd().endsWith("<!-- ned:a -->\nA2\n<!-- ned:/a -->")).toBe(true);
    const third = vault.replaceBlocks(second, blocks("A3", "B3"));
    expect(third).toContain("A1 user kept this");
    expect(third).toContain("A3");
    expect(third).not.toContain("A2");
    // an orphan closing marker before the block
    const orphanClose = "<!-- ned:/a -->\nmine\n" + vault.replaceBlocks("", blocks("A1", "B1"));
    const r = vault.replaceBlocks(orphanClose, blocks("A9", "B9"));
    expect(r.startsWith("<!-- ned:/a -->\nmine\n")).toBe(true);
    expect(r).toContain("A9");
  });

  it("generated text can't forge a marker", () => {
    expect(vault.defang("x <!-- ned:/a --> y")).not.toContain("<!--");
  });
});

describe("daily report", () => {
  const day = "2026-11-06";
  const seed = () => {
    briefingFile({ ts: at(2026, 11, 6, 9, 0), type: "daily", status: "UPDATE", headline: "오늘 회의 3개", action_items: [{ title: "결재 메일", url: "https://mail.example/1", kind: "email" }], updates: [{ title: "PR 머지됨", kind: "github" }], fyi: [{ title: "공지" }] });
    briefingFile({ ts: at(2026, 11, 6, 10, 0), type: "heartbeat", status: "UPDATE", action_items: [{ title: "Slack 질문", url: "https://slack.example/p1", kind: "slack" }] });
    briefingFile({ ts: at(2026, 11, 6, 11, 0), type: "heartbeat", status: "UPDATE", action_items: [{ title: "Slack 질문 (다시)", url: "https://slack.example/p1", kind: "slack" }, { title: "Jira 마감", kind: "jira" }] });
    briefingFile({ ts: at(2026, 11, 6, 12, 0), type: "heartbeat", status: "NED_OK" });
    briefingFile({ ts: at(2026, 11, 7, 0, 30), type: "heartbeat", status: "UPDATE", action_items: [{ title: "다음날 것", kind: "slack" }] });
    fs.appendFileSync(SENT_ACTIONS_LOG, [
      { ts: new Date(at(2026, 11, 6, 10, 5)).toISOString(), source: "slack", mode: "send", action: "slack_send", ref: { channel: "#dev", url: "https://slack.example/p1" }, text: "확인했어요", ok: true, result: "sent https://slack.example/p2" },
      { ts: new Date(at(2026, 11, 6, 10, 6)).toISOString(), source: "slack", mode: "send", action: "refused", ref: {}, text: "x", ok: false, result: "off" },
      { ts: new Date(at(2026, 11, 6, 10, 7)).toISOString(), source: "email", mode: "send", action: "dry_run:gmail", ref: {}, text: "x", ok: false, result: "" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  };

  it("creates the file with frontmatter and every enabled section; dedupes 순찰 items by url", () => {
    seed();
    const file = archive.writeDailyReport(loadConfig(), day);
    expect(file).toBe(report(day));
    const md = fs.readFileSync(file, "utf8");
    expect(md).toMatch(/^---\ncreated: 2026-11-06\ntags:\n  - ned\n  - daily\nned_version: /);
    for (const h of ["## 🌅 브리핑", "## 🔔 순찰", "## ✉️ 보낸 것", "## 📎 정리 결과물", "## 📊 오늘"]) expect(md).toContain(h);
    expect(md).not.toContain("## 🤖 세션"); // include.sessions defaults off
    expect(md).toContain("**오늘 회의 3개**");
    expect(md).toContain("[결재 메일](https://mail.example/1)");
    expect(md.match(/slack\.example\/p1\)/g)?.length).toBe(1 + 0); // 순찰 once (sent line links p2)
    expect(md).toContain("Jira 마감");
    expect(md).not.toContain("다음날 것"); // 00:30 next day belongs to the next file
    expect(md).toContain("Slack 보냄 · [#dev](https://slack.example/p2) — “확인했어요”");
    expect(md).not.toContain("refused");
    expect(md).toContain("- 순찰 3회 (알림 2회) · 아침 브리핑 ✓");
  });

  it("a second 아침 브리핑 (items already sent → empty) doesn't hide the first one's items", () => {
    seed();
    briefingFile({ ts: at(2026, 11, 6, 9, 30), type: "daily", status: "UPDATE", headline: "다시 돌림", action_items: [{ title: "결재 메일", url: "https://mail.example/1", kind: "email" }, { title: "새 항목", kind: "jira" }] });
    const md = fs.readFileSync(archive.writeDailyReport(loadConfig(), day), "utf8");
    expect(md).toContain("09:00 — **오늘 회의 3개**\n09:30 — **다시 돌림**");
    expect(md.match(/결재 메일/g)?.length).toBe(1);
    expect(md).toContain("새 항목");
  });

  it("rewrites only the Ned blocks; the user's memo (outside markers) survives, edits inside are replaced", () => {
    seed();
    const cfg = loadConfig();
    const file = archive.writeDailyReport(cfg, day);
    const mine = fs.readFileSync(file, "utf8").replace("<!-- ned:/patrol -->\n", "<!-- ned:/patrol -->\n\n> 내 메모: 오후에 다시 보기\n").replace("Jira 마감", "Jira 마감 (내가 고침)") + "\n## 회고\n- 좋았던 점\n";
    fs.writeFileSync(file, mine);
    briefingFile({ ts: at(2026, 11, 6, 15, 0), type: "heartbeat", status: "UPDATE", updates: [{ title: "새 업데이트", kind: "github" }] });
    archive.writeDailyReport(cfg, day);
    const md = fs.readFileSync(file, "utf8");
    expect(md).toContain("> 내 메모: 오후에 다시 보기");
    expect(md).toContain("## 회고\n- 좋았던 점\n");
    expect(md).toContain("새 업데이트");
    expect(md).not.toContain("(내가 고침)");
    expect(md.indexOf("> 내 메모")).toBeGreaterThan(md.indexOf("<!-- ned:/patrol -->"));
    expect(md.indexOf("> 내 메모")).toBeLessThan(md.indexOf("<!-- ned:sent -->"));
  });

  it("include switches: an off section is not added; turning it off later empties its block", () => {
    seed();
    setConfig({ include: { actions: false, sessions: true } });
    const md = fs.readFileSync(archive.writeDailyReport(loadConfig(), day), "utf8");
    expect(md).not.toContain("✉️ 보낸 것");
    expect(md).toContain("## 🤖 세션");
    setConfig({ include: { actions: false, sessions: false } });
    const md2 = fs.readFileSync(archive.writeDailyReport(loadConfig(), day), "utf8");
    expect(md2).toContain("<!-- ned:sessions -->\n\n<!-- ned:/sessions -->");
    expect(md2).not.toContain("## 🤖 세션");
  });

  it("custom folder", () => {
    setConfig({ folder: "Inbox/Ned" });
    archive.writeDailyReport(loadConfig(), day);
    expect(fs.existsSync(report(day, "Inbox/Ned"))).toBe(true);
  });
});

describe("triggers, tick and the midnight boundary", () => {
  it("archive off → touch writes nothing", () => {
    setConfig({ enabled: false });
    archive.archiveTouch(Date.now(), { immediate: true });
    expect(fs.existsSync(path.join(V, "Ned"))).toBe(false);
    expect(fs.existsSync(vault.ARCHIVE_STATE_PATH)).toBe(false);
  });

  it("a change at 23:59 lands in that day's file even when written after midnight; the past day is then left alone", () => {
    const yday = at(2026, 11, 6, 23, 59), after = at(2026, 11, 7, 0, 1);
    briefingFile({ ts: yday, type: "heartbeat", status: "UPDATE", action_items: [{ title: "막차 알림", kind: "slack" }] });
    archive.archiveTouch(yday, { immediate: true, now: after });
    const y = report("2026-11-06");
    expect(fs.readFileSync(y, "utf8")).toContain("막차 알림");
    expect(fs.existsSync(report("2026-11-07"))).toBe(false);
    const before = fs.readFileSync(y, "utf8");
    // Later: more data that would belong to 11-06 shows up, but nothing touches that day → its file is never rewritten.
    briefingFile({ ts: at(2026, 11, 6, 23, 0), type: "heartbeat", status: "UPDATE", action_items: [{ title: "늦게 발견", kind: "jira" }] });
    archive.archiveTouch(at(2026, 11, 7, 9, 0), { now: at(2026, 11, 7, 9, 0) });
    archive.archiveTick(loadConfig(), at(2026, 11, 7, 9, 10));
    expect(fs.readFileSync(y, "utf8")).toBe(before);
    expect(fs.existsSync(report("2026-11-07"))).toBe(true);
  });

  it("tick flushes a changed day only after 5 minutes since its last write", () => {
    const t0 = at(2026, 11, 7, 10, 0);
    archive.archiveTouch(t0, { immediate: true, now: t0 });
    const f = report("2026-11-07");
    const w0 = fs.readFileSync(f, "utf8");
    briefingFile({ ts: t0 + 60_000, type: "heartbeat", status: "NED_OK" });
    archive.archiveTouch(t0 + 60_000, { now: t0 + 60_000 }); // not immediate
    archive.archiveTick(loadConfig(), t0 + 2 * 60_000);
    expect(fs.readFileSync(f, "utf8")).toBe(w0);
    archive.archiveTick(loadConfig(), t0 + archive.ARCHIVE_FLUSH_MS + 1);
    expect(fs.readFileSync(f, "utf8")).toContain("순찰 1회");
    expect(vault.readArchiveState().dirty).toEqual({});
  });

  it("tick counts finished agenda refreshes per source (not the ones present when it started)", async () => {
    const { AGENDA_PATH } = await import("../src/paths.js");
    const t = at(2026, 11, 7, 10, 0);
    fs.writeFileSync(AGENDA_PATH, JSON.stringify({ sources_status: { slack: { status: "done", updated_at: t - 1000 } } }));
    archive.archiveTick(loadConfig(), t);
    fs.writeFileSync(AGENDA_PATH, JSON.stringify({ sources_status: { slack: { status: "done", updated_at: t + 1000 }, mail: { status: "running", updated_at: t + 1000 } } }));
    archive.archiveTick(loadConfig(), t + 2000);
    expect(vault.readArchiveState().src_counts["2026-11-07"]).toEqual({ slack: 1 });
    fs.rmSync(AGENDA_PATH, { force: true });
  });

  it("a successful action triggers an immediate write (sent-actions.log hook)", () => {
    appendActionLog({ ts: new Date().toISOString(), source: "todo", mode: "add", action: "todo_add", ref: { title: "우유 사기" }, text: "우유 사기", ok: true, result: "todo t1" });
    expect(fs.readFileSync(report(localDay()), "utf8")).toContain("할 일 추가 · 우유 사기");
  });

  it("write failure (permission) is recorded, not thrown; the daemon keeps going", () => {
    if (process.getuid?.() === 0) return; // root ignores modes
    fs.mkdirSync(path.join(V, "Ned"), { recursive: true });
    fs.chmodSync(path.join(V, "Ned"), 0o500);
    try {
      expect(() => archive.archiveTouch(Date.now(), { immediate: true })).not.toThrow();
      const st = vault.readArchiveState();
      expect(st.last_error).toMatch(/데일리 리포트 쓰기 실패/);
      expect(st.last_error).toMatch(/권한 거부/);
      expect(Object.keys(st.dirty)).toEqual([localDay()]); // still pending → retried by the tick
    } finally {
      fs.chmodSync(path.join(V, "Ned"), 0o755);
    }
  });

  it("a vault that disappeared → error recorded", () => {
    fs.rmSync(V, { recursive: true, force: true });
    archive.archiveTouch(Date.now(), { immediate: true });
    expect(vault.readArchiveState().last_error).toMatch(/볼트 확인 실패/);
  });
});

describe("daily note embed", () => {
  const day = "2026-11-07";
  const notePath = () => path.join(V, "daily/Daily/2026-11/2026-11-07.md");
  const TEMPLATE = "---\ncreated: 2026-11-07\ntags: [daily]\n---\n## 🎯 Today's Tasks\n- [ ] 일 #task\n\n## 📝 Notes & Logs\n- 메모 하나\n\n## 🔄 회고\n";
  const conf = (o: Record<string, unknown>) => fs.writeFileSync(path.join(V, ".obsidian", "daily-notes.json"), JSON.stringify(o));

  it("formatDay handles the moment subset", () => {
    expect(archive.formatDay("YYYY-MM/YYYY-MM-DD", day)).toBe("2026-11/2026-11-07");
    expect(archive.formatDay("[Day] D.M.YY", day)).toBe("Day 7.11.26");
    expect(archive.formatDay("dddd", day)).toBeNull();
  });

  it("no daily-notes.json → skipped", () => {
    expect(archive.ensureEmbed(loadConfig().archive, day)).toBe("no_config");
  });

  it("note missing → never created", () => {
    conf({ folder: "daily/Daily", format: "YYYY-MM/YYYY-MM-DD" });
    expect(archive.ensureEmbed(loadConfig().archive, day)).toBe("no_note");
    expect(fs.existsSync(notePath())).toBe(false);
    expect(fs.existsSync(path.join(V, "daily"))).toBe(false);
  });

  it("existing note → one line under Notes & Logs, every other line untouched; second time → present", () => {
    conf({ folder: "daily/Daily", format: "YYYY-MM/YYYY-MM-DD" });
    fs.mkdirSync(path.dirname(notePath()), { recursive: true });
    fs.writeFileSync(notePath(), TEMPLATE);
    expect(archive.ensureEmbed(loadConfig().archive, day)).toBe("inserted");
    const after = fs.readFileSync(notePath(), "utf8");
    expect(after).toBe(TEMPLATE.replace("## 📝 Notes & Logs\n", "## 📝 Notes & Logs\n<!-- ned:embed -->![[Ned/Daily/2026-11/2026-11-07]]<!-- ned:/embed -->\n"));
    expect(archive.ensureEmbed(loadConfig().archive, day)).toBe("present");
    expect(fs.readFileSync(notePath(), "utf8")).toBe(after);
  });

  it("no format in daily-notes.json → tries folder/DAY.md and folder/YYYY-MM/DAY.md; no heading → left alone", () => {
    conf({ folder: "daily/Daily" });
    fs.mkdirSync(path.dirname(notePath()), { recursive: true });
    fs.writeFileSync(notePath(), "# 메모만\n");
    expect(archive.ensureEmbed(loadConfig().archive, day)).toBe("no_heading");
    expect(fs.readFileSync(notePath(), "utf8")).toBe("# 메모만\n");
  });

  it("daily_embed runs with the report write; off → the note is not touched", () => {
    conf({ folder: "daily/Daily", format: "YYYY-MM/YYYY-MM-DD" });
    fs.mkdirSync(path.dirname(notePath()), { recursive: true });
    fs.writeFileSync(notePath(), TEMPLATE);
    archive.flushDay(loadConfig(), day);
    expect(fs.readFileSync(notePath(), "utf8")).toBe(TEMPLATE);
    setConfig({ daily_embed: true });
    archive.flushDay(loadConfig(), day);
    expect(fs.readFileSync(notePath(), "utf8")).toContain("![[Ned/Daily/2026-11/2026-11-07]]");
    expect(vault.readArchiveState().last_embed).toMatchObject({ day, result: "inserted" });
  });

  it("a traversal folder in daily-notes.json is refused", () => {
    conf({ folder: "../../escape", format: "YYYY-MM-DD" });
    expect(() => archive.ensureEmbed(loadConfig().archive, day)).toThrow(/escapes/);
  });
});
