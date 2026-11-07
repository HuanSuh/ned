import { describe, expect, it } from "vitest";
import {
  ackCheckEmojis,
  ackedSet,
  buildListsPrompt,
  collapseDMs,
  isEmptyPayload,
  normalize,
  normalizeCalendar,
  normalizeMailContext,
  normalizeSlackContext,
  pickSections,
  slackConvKey,
  slackUrlKey,
  sourceSignature,
  supersetMail,
  supersetSlack,
  type AgendaPayload,
  type MailItem,
  type SlackItem,
} from "../src/agenda.js";
import { DEFAULT_CONFIG, normalizeFilters, type NedConfig } from "../src/config.js";

const AT = "2026-11-06T01:00:00.000Z";
const cfg = (over: Partial<NedConfig> = {}): NedConfig => ({ ...DEFAULT_CONFIG, ...over });
const slackUrl = (ch: string, p: string) => `https://x.slack.com/archives/${ch}/p${p}`;

describe("normalizeSlackContext", () => {
  it("undefined for non-objects and contexts with no text messages", () => {
    expect(normalizeSlackContext(null, AT)).toBeUndefined();
    expect(normalizeSlackContext({ messages: [{ from: "a", text: "   " }] }, AT)).toBeUndefined();
  });
  it("keeps the last 5 messages, trims text to 300, converts epoch ts, merges participants", () => {
    const messages = Array.from({ length: 7 }, (_, i) => ({ from: `u${i}`, ts: "1730860000.123456", text: `m${i} ` + "y".repeat(400) }));
    const c = normalizeSlackContext({ messages, participants: ["boss"] }, AT)!;
    expect(c.messages).toHaveLength(5);
    expect(c.messages[0].from).toBe("u2");
    expect(c.messages[0].text.length).toBe(300);
    expect(c.messages[0].ts).toBe(new Date(1730860000123.456).toISOString());
    expect(c.participants).toEqual(["boss", "u2", "u3", "u4", "u5", "u6"]);
    expect(c.collected_at).toBe(AT);
  });
  it("keeps a valid model collected_at, replaces an invalid one", () => {
    expect(normalizeSlackContext({ messages: [{ from: "a", text: "hi" }], collected_at: "2026-01-01T00:00:00Z" }, AT)!.collected_at).toBe("2026-01-01T00:00:00Z");
    expect(normalizeSlackContext({ messages: [{ from: "a", text: "hi" }], collected_at: "yesterday" }, AT)!.collected_at).toBe(AT);
  });
});

describe("normalizeMailContext", () => {
  it("undefined without a body", () => {
    expect(normalizeMailContext({ from: "a" }, AT)).toBeUndefined();
  });
  it("limits body and attachments, includes ids only when present", () => {
    const c = normalizeMailContext({ from: "a@x", subject: "s", body_excerpt: "b".repeat(2000), attachments: Array.from({ length: 12 }, (_, i) => `f${i}.pdf`), message_id: " <m1> " }, AT)!;
    expect(c.body_excerpt).toHaveLength(1500);
    expect(c.attachments).toHaveLength(10);
    expect(c.message_id).toBe("<m1>");
    expect("reply_to" in c).toBe(false);
  });
});

describe("normalizeCalendar", () => {
  it("coerces fields, defaults rsvp, puts all-day first then by start", () => {
    const out = normalizeCalendar([
      { id: "b", title: "B", start: "2026-11-06T10:00:00+09:00", rsvp: "maybe" },
      { id: "a", title: "A", start: "2026-11-06T09:00:00+09:00", rsvp: "accepted", attendees: "3" },
      { id: "d", title: "Day", start: "2026-11-06", all_day: true },
      "junk",
    ]);
    expect(out.map((e) => e.id)).toEqual(["d", "a", "b"]);
    expect(out[2].rsvp).toBe("needsAction");
    expect(out[1].attendees).toBe(3);
  });
});

describe("slack helpers", () => {
  it("slackConvKey uses the permalink channel, else channel|from", () => {
    expect(slackConvKey({ url: slackUrl("D123", "1700000000000001"), channel: "x", from: "y" })).toBe("D123");
    expect(slackConvKey({ url: "", channel: "dm", from: "kim" })).toBe("dm|kim");
  });
  it("collapseDMs keeps the newest row per DM and sums counts; mentions pass through", () => {
    const rows = [
      { reason: "dm" as const, ts: "2026-11-06T01:00:00Z", url: slackUrl("D1", "1"), channel: "dm", from: "kim" },
      { reason: "mention" as const, ts: "2026-11-06T01:30:00Z", url: slackUrl("C1", "2"), channel: "dev", from: "lee" },
      { reason: "dm" as const, ts: "2026-11-06T02:00:00Z", url: slackUrl("D1", "3"), channel: "dm", from: "kim", count: 2 },
    ];
    const out = collapseDMs(rows);
    expect(out).toHaveLength(2);
    expect(out[0].reason).toBe("mention");
    expect(out[1]).toMatchObject({ url: slackUrl("D1", "3"), count: 3 });
  });
});

describe("superset merges (all ⊇ items)", () => {
  it("supersetSlack adds missing items as unanswered, newest first, and is identity when complete", () => {
    const items = [{ channel: "c", from: "f", text: "t", url: "u1", ts: "2026-11-06T03:00:00Z", reason: "mention" }] as SlackItem[];
    const all = [{ channel: "c", from: "f", text: "o", url: "u0", ts: "2026-11-06T01:00:00Z", reason: "mention", answered: true }] as never[];
    const out = supersetSlack(items, all);
    expect(out.map((x) => x.url)).toEqual(["u1", "u0"]);
    expect(out[0].answered).toBe(false);
    expect(supersetSlack(items, out)).toBe(out);
  });
  it("supersetMail adds missing threads with unread=false", () => {
    const items = [{ id: "t2", from: "a", subject: "s", snippet: "", received: "2026-11-06T05:00:00Z", url: "u", reason: "reply", why: "" }] as MailItem[];
    const out = supersetMail(items, [{ id: "t1", from: "b", subject: "x", ts: "2026-11-06T01:00:00Z", url: "", unread: true }]);
    expect(out.map((x) => x.id)).toEqual(["t2", "t1"]);
    expect(out[0].unread).toBe(false);
  });
});

describe("normalize (agenda payload contract)", () => {
  const raw = {
    calendar: [{ id: "e1", title: "Standup", start: "2026-11-06T09:00:00+09:00" }],
    jira: [{ key: "MNT-1", title: "excluded" }, { key: "APP-7", title: "kept", due: "2026-11-07" }],
    github: [{ repo: "o/r", number: "12", reason: "review_requested" }, { repo: "o/r", number: 13, reason: "unknown" }],
    mail: {
      summary: "s",
      unread: 77,
      items: [{ id: "th1", subject: "Approve?", reason: "approval", context: { body_excerpt: "please approve", from: "boss" } }, { id: "th2", reason: "weird" }],
      all: [{ id: "th0", ts: "2026-11-06T00:00:00Z", unread: false }],
    },
    slack: {
      items: [{ channel: "#random", reason: "mention", url: slackUrl("C9", "1"), text: "x" }, { channel: "dev", reason: "mention", url: slackUrl("C1", "1700000000000001"), ts: "1700000000.000001", text: "hi", context: { messages: [{ from: "a", text: "ctx" }] } }, { channel: "dev", reason: "nope" }],
      all: [{ channel: "dev", url: slackUrl("C1", "1700000000000001"), ts: "1700000000.000001", text: "hi" }],
    },
  };
  const c = cfg({ filters: normalizeFilters({ slack: { exclude_channels: ["random"] }, jira: { exclude_projects: ["MNT"] } }) });

  it("drops excluded Jira projects / Slack channels and bad reasons", () => {
    const p = normalize(raw, c, AT);
    expect(p.jira.map((j) => j.key)).toEqual(["APP-7"]);
    expect(p.github).toHaveLength(1);
    expect(p.github[0].number).toBe(12);
    expect(p.slack!.items.map((x) => x.channel)).toEqual(["dev"]);
  });

  it("caps mail unread at 50 and flags it, defaults unknown reason to request, builds Gmail url", () => {
    const p = normalize(raw, c, AT);
    expect(p.mail!.unread).toBe(50);
    expect(p.mail!.unread_capped).toBe(true);
    expect(p.mail!.items[1].reason).toBe("request");
    expect(p.mail!.items[1].url).toContain("mail.google.com");
    expect(p.mail!.items[0].context?.body_excerpt).toBe("please approve");
  });

  it("mail.all ⊇ mail.items; slack.all ⊇ slack.items and shares context by permalink", () => {
    const p = normalize(raw, c, AT);
    expect(new Set(p.mail!.all.map((x) => x.id))).toEqual(new Set(["th0", "th1", "th2"]));
    for (const it of p.slack!.items) expect(p.slack!.all.some((a) => a.url === it.url)).toBe(true);
    expect(p.slack!.all[0].context?.messages[0].text).toBe("ctx");
  });

  it("disabled sources become [] / null", () => {
    const p = normalize(raw, cfg({ sources: { ...DEFAULT_CONFIG.sources, gmail: false, slack: false, jira: false } }), AT);
    expect(p.mail).toBeNull();
    expect(p.slack).toBeNull();
    expect(p.jira).toEqual([]);
    expect(p.calendar).toHaveLength(1);
  });

  it("isEmptyPayload: summaries alone don't count, any item does", () => {
    const empty: AgendaPayload = { calendar: [], jira: [], github: [], mail: { summary: "hi", unread: 3, unread_capped: false, items: [], all: [] }, slack: null };
    expect(isEmptyPayload(empty)).toBe(true);
    expect(isEmptyPayload(normalize(raw, c, AT))).toBe(false);
    expect(isEmptyPayload({ ...empty, mail: { ...empty.mail!, all: [{ id: "x", from: "", subject: "", ts: "", url: "", unread: true }] } })).toBe(false);
  });
});

describe("sourceSignature / pickSections", () => {
  it("signature ignores ordering, changes when the set changes", () => {
    const a = { jira: [{ key: "A-1", status: "To Do", due: null }, { key: "A-2", status: "Done", due: null }] } as never;
    const b = { jira: [{ key: "A-2", status: "Done", due: null }, { key: "A-1", status: "To Do", due: null }] } as never;
    const c = { jira: [{ key: "A-1", status: "In Progress", due: null }] } as never;
    expect(sourceSignature("jira", a)).toBe(sourceSignature("jira", b));
    expect(sourceSignature("jira", a)).not.toBe(sourceSignature("jira", c));
  });
  it("pickSections keeps only requested sections", () => {
    const t = "head\n<!--@slack-->\nS\n<!--@/slack--><!--@mail-->\nM\n<!--@/mail-->tail";
    expect(pickSections(t, new Set(["mail"]))).toBe("head\nM\ntail");
  });
});

describe("slack.watch recent (normalizeWatch)", () => {
  const c = cfg({ filters: normalizeFilters({ slack: { watch_channels: ["ops", "infra"] } }) });
  it("keeps the newest 3 messages, one line ≤120 chars, epoch ts → ISO; missing → []", () => {
    const m = (i: number, text = `msg ${i}`) => ({ from: ` u${i} `, text, ts: `17623900${String(i).padStart(2, "0")}.000100`, url: slackUrl("C9", `17623900${String(i).padStart(2, "0")}000100`) });
    const p = normalize({ slack: { items: [], all: [], watch: [
      { channel: "#ops", summary: "", highlights: [], recent: [m(1), m(4, "a\n  b " + "x".repeat(200)), m(2), m(3), "junk", { from: "x" }] },
      { channel: "infra", summary: "s", highlights: [] },
    ] } }, c, AT);
    const [ops, infra] = p.slack!.watch;
    expect(ops.recent.map((r) => r.from)).toEqual(["u4", "u3", "u2"]);
    expect(ops.recent[0].text).toHaveLength(120);
    expect(ops.recent[0].text.startsWith("a b x")).toBe(true);
    expect(ops.recent[0].ts).toBe(new Date(1762390004000.1).toISOString());
    expect(ops.recent[0].url).toBe(m(4).url);
    expect(infra.recent).toEqual([]);
  });
  it("the list prompt asks for recent alongside highlights", () => {
    const pr = buildListsPrompt(c, ["slack"]);
    expect(pr).toContain("`recent`");
    expect(pr).toContain('"recent":[{"from":"","text":"","ts":"ISO","url":""}]');
  });
});

describe("slack ack reactions (filters.slack.ack_reactions)", () => {
  const u1 = slackUrl("C1", "1762390000000100"), u2 = slackUrl("C2", "1762390000000200"), u3 = slackUrl("C3", "1762390000000300");
  const raw = {
    slack: {
      items: [
        { channel: "#dev", reason: "mention", url: u1, ts: "1762390000.000100", text: "봐줘" },
        { channel: "#ops", reason: "thread", url: u2, ts: "1762390000.000200", text: "확인?" },
      ],
      all: [
        { channel: "#dev", reason: "mention", url: u1, ts: "1762390000.000100", text: "봐줘" },
        { channel: "#ops", reason: "thread", url: u2, ts: "1762390000.000200", text: "확인?" },
      ],
      watch: [{ channel: "#ops", summary: "s", highlights: [{ from: "a", text: "t", ts: "1762390000.000300", url: u3, needs_me: true, reason: "r" }] }],
      // thread permalink variant: query string must not matter
      acked_urls: [`${u2}?thread_ts=1762380000.000001&cid=C2`, u3, 42],
    },
  };
  const c = cfg({ filters: normalizeFilters({ slack: { watch_channels: ["ops"] } }) });

  it("acked urls leave items, mark all[] answered, clear watch needs_me", () => {
    const p = normalize(raw, c, AT);
    expect(p.slack!.items.map((x) => x.url)).toEqual([u1]);
    expect(p.slack!.all.find((x) => x.url === u2)!.answered).toBe(true);
    expect(p.slack!.all.find((x) => x.url === u1)!.answered).toBe(false);
    expect(p.slack!.watch[0].highlights[0].needs_me).toBe(false);
  });

  it("no acked_urls → unchanged", () => {
    const p = normalize({ slack: { ...raw.slack, acked_urls: undefined } }, c, AT);
    expect(p.slack!.items).toHaveLength(2);
    expect(p.slack!.watch[0].highlights[0].needs_me).toBe(true);
  });

  it("an acked DM closes older asks in the same conversation, not newer ones", () => {
    const d = (p: string, ts: string) => ({ channel: "DM", from: "kim", reason: "dm", url: slackUrl("D9", p), ts, text: "q" });
    const p = normalize({ slack: { items: [d("1762390000000100", "1762390000.000100"), d("1762390100000000", "1762390100.000000")], all: [], acked_urls: [slackUrl("D9", "1762390050000000")] } }, c, AT);
    expect(p.slack!.items.map((x) => x.url)).toEqual([slackUrl("D9", "1762390100000000")]);
  });

  it("slackUrlKey / ackedSet ignore query, hash, host case, non-strings", () => {
    expect(slackUrlKey("https://X.slack.com/archives/C1/p1?thread_ts=1&cid=C1#x")).toBe("x.slack.com/archives/C1/p1");
    expect([...ackedSet(["https://x.slack.com/archives/C1/p1", null, ""])]).toEqual(["x.slack.com/archives/C1/p1"]);
    expect(ackedSet("nope").size).toBe(0);
  });

  it("prompt adds one hasmy search per emoji (concise, no context) and the acked_urls key; none when the list is empty", () => {
    const on = buildListsPrompt(cfg({ filters: normalizeFilters({ slack: { ack_reactions: ["eyes", "+1"] } }) }), ["slack"]);
    expect(on).toContain("hasmy::eyes:");
    expect(on).toContain(":eyes: :+1:");
    expect(on).toContain('`response_format: "concise"`');
    expect(on).toContain("`include_context: false`");
    expect(on).toContain('"acked_urls":[]');
    const off = buildListsPrompt(cfg({ filters: normalizeFilters({ slack: { ack_reactions: [] } }) }), ["slack"]);
    expect(off).not.toContain("hasmy");
    expect(off).not.toContain("acked_urls");
    expect(off).not.toContain("{{");
  });

  it("ack search is conditional (only with candidates) and capped at filters.slack.ack_check_max from the front", () => {
    const six = ["white_check_mark", "eyes", "+1", "heavy_check_mark", "ok_hand", "done"];
    const p = buildListsPrompt(cfg({ filters: normalizeFilters({ slack: { ack_reactions: six } }) }), ["slack"]);
    expect(p).toContain(":white_check_mark: :eyes: :+1:");
    expect(p).not.toContain(":heavy_check_mark:");
    expect(p).not.toContain(":ok_hand:");
    expect(p).toContain("하나라도 있을 때만");
    expect(p).toContain("건너뛰고");
    expect(p).not.toContain("{{");
    const all = buildListsPrompt(cfg({ filters: normalizeFilters({ slack: { ack_reactions: six, ack_check_max: 8 } }) }), ["slack"]);
    expect(all).toContain(":ok_hand: :done:");
    expect(ackCheckEmojis(cfg({ filters: normalizeFilters({ slack: { ack_reactions: six, ack_check_max: 1 } }) }))).toEqual(["white_check_mark"]);
    // With followed channels, needs_me highlights count as candidates too.
    const w = buildListsPrompt(cfg({ filters: normalizeFilters({ slack: { watch_channels: ["ops"] } }) }), ["slack"]);
    expect(w).toContain("`needs_me` 하이라이트 후보");
  });
});
