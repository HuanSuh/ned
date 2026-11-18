/**
 * ⌘K 검색 키 over the 수집 이력 (historyCands): from: (people only), #채널, is:done (✓ marks), is:mine, source:, and the
 * response shape (filter fields stay internal). Temp NED_HOME (test/setup.ts). Fake names only.
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { HISTORY_SOURCES } from "../src/config.js";
import { HISTORY_META_PATH, historyFile, writeHistory } from "../src/history.js";
import { AGENDA_PATH, CONFIG_PATH, REVIEWED_PATH, writeJsonAtomic } from "../src/paths.js";
import { search } from "../src/search.js";

const H = 3600_000, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const rec = (source: string, key: string, t: number, state: Record<string, unknown>, item: Record<string, unknown>) => ({ key, source, first_seen: t, last_seen: t, ts: iso(t), state, item });
const sts = (t: number) => `${Math.floor(t / 1000)}.000100`;
const link = (ch: string, t: number) => `https://x.slack.com/archives/${ch}/p${sts(t).replace(".", "")}`;

const now = Date.now();
const T1 = now - 3 * D, T2 = now - 4 * D, T3 = now - 5 * D;
const ids = (q: string) => search(q).map((h) => `${h.type}:${h.id}`).sort();

beforeEach(() => {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
  fs.rmSync(HISTORY_META_PATH, { force: true });
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
  writeJsonAtomic(AGENDA_PATH, { updated_at: now, cost_usd: 0, calendar: [], jira: [], github: [], mail: null, slack: { summary: "", items: [], all: [], watch: [] } });
  const slackRec = (ch: string, chName: string, from: string, text: string, t: number) =>
    rec("slack", `x.slack.com/archives/${ch}/p${sts(t).replace(".", "")}`, t, { reason: "mention", need: false, answered: true, acked: false, count: 1 }, { channel: chName, from, text, url: link(ch, t), ts: iso(t) });
  writeHistory("slack", [
    slackRec("C0OPS0001", "#ops", "사람E", "로그 확인 부탁", T1),
    slackRec("C0GEN0001", "#general", "사람F", "사람E 님 로그 봤어요", T2), // mentions 사람E in the body only
    slackRec("C0OPS0001", "#ops", "서지수/팀X", "배포 끝", T3),
  ]);
  writeHistory("mail", [rec("mail", "th9", T2, { unread: false }, { id: "th9", from: "사람E <e@example.com>", subject: "로그 정리", url: "https://mail.google.com/mail/u/0/#all/th9" })]);
  writeHistory("github", [rec("github", "https://github.com/o/r/pull/3", T1, { open: true }, { repo: "o/r", number: 3, title: "fix logs", url: "https://github.com/o/r/pull/3", author: "dev-x", reason: "my_pr_approved", updated: iso(T1) })]);
  writeHistory("jira", [rec("jira", "OPS-1", T1, { open: true }, { key: "OPS-1", title: "로그 수집", url: "https://x.atlassian.net/browse/OPS-1", updated: iso(T1) })]);
  // ✓ on the 서지수 #ops record (mark after its last change)
  writeJsonAtomic(REVIEWED_PATH, { [`slack:C0OPS0001:${sts(T3)}`]: now });
});

describe("검색 키 over history records", () => {
  it("from: matches people only (Slack 보낸 이, 메일 발신자) — not a body mention", () => {
    expect(ids("from:사람E")).toEqual([`mail:th9`, `slack:${link("C0OPS0001", T1)}`].sort());
    expect(ids("사람E")).toContain(`slack:${link("C0GEN0001", T2)}`); // as a word it does
    expect(ids("from:ㅅㅈㅅ")).toEqual([`slack:${link("C0OPS0001", T3)}`]);
    expect(ids("from:dev-x")).toEqual(["github:o/r#3"]);
  });

  it("#채널 / channel: on the record's channel; source: + word", () => {
    expect(ids("#ops")).toEqual([`slack:${link("C0OPS0001", T1)}`, `slack:${link("C0OPS0001", T3)}`].sort());
    expect(ids("channel:OPS 배포")).toEqual([`slack:${link("C0OPS0001", T3)}`]);
    expect(ids("source:메일 로그")).toEqual(["mail:th9"]);
    expect(ids("source:지라")).toEqual(["jira:OPS-1"]);
  });

  it("is:done (✓ mark) / is:open / is:mine", () => {
    expect(ids("is:done")).toEqual([`slack:${link("C0OPS0001", T3)}`]);
    expect(ids("#ops is:open")).toEqual([`slack:${link("C0OPS0001", T1)}`]);
    expect(ids("is:mine")).toEqual(["github:o/r#3"]);
  });

  it("keys only → newest first; hits carry no internal filter fields", () => {
    const hits = search("source:슬랙");
    expect(hits.map((h) => h.ts)).toEqual([...hits.map((h) => h.ts)].sort((a, b) => (b ?? 0) - (a ?? 0)));
    for (const h of hits) for (const k of ["fields", "src", "people", "channel", "done", "mine"]) expect(h, k).not.toHaveProperty(k);
  });
});
