/**
 * 보내기 규칙 (src/send-rules.ts · config.ts normalizers), the confirm token + guard (src/send-guard.ts), the review parser /
 * runner (src/send-review.ts, injected reviewer — never a real claude) and performSend's own rule checks.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SENT_ACTIONS_LOG, performSend, readActionLog, type SendRequest } from "../src/actions.js";
import { DEFAULT_ACTIONS, DEFAULT_CONFIG, normalizeActions, normalizeInternalDomains, normalizeSendRules, sendRulesError, type NedConfig, type SendRule } from "../src/config.js";
import { EVENTS_DIR, localDay } from "../src/paths.js";
import { CONFIRM_TTL_MS, checkConfirmToken, guardSend, issueConfirmToken, needConfirmSummary } from "../src/send-guard.js";
import { _setSendReviewer, buildReviewPrompt, parseReview, reviewInput, wantsReview, type SendReviewer } from "../src/send-review.js";
import { isExternal, matchSendRule, sendTargetOf, targetMatches } from "../src/send-rules.js";

const ALL_ON = { ...DEFAULT_ACTIONS, slack_send: true, gmail_send: true, jira_comment: true, github_review: true, calendar_create: true, calendar_rsvp: true, session_send: true };
const cfgWith = (rules: SendRule[], over: Partial<NedConfig["actions"]> = {}): NedConfig => ({ ...DEFAULT_CONFIG, actions: { ...ALL_ON, rules, ...over } });

const slack = (over: Partial<SendRequest> = {}): SendRequest => ({ source: "slack", mode: "send", text: "hi", ref: { url: "https://acme.slack.com/archives/C0GEN/p1700000000000100", title: "#General · 김철수" }, ...over });
const mail = (to: string, over: Partial<SendRequest> = {}): SendRequest => ({ source: "email", mode: "send", text: "hello", ref: { message_id: "m1", title: `회의 — 홍길동 <${to}>` }, ...over });
const jira = (key = "ABC-12"): SendRequest => ({ source: "jira", mode: "comment", text: "done", ref: { url: `https://acme.atlassian.net/browse/${key}` } });
const github = (repo = "acme/web"): SendRequest => ({ source: "github", mode: "comment", text: "lgtm", ref: { url: `https://github.com/${repo}/pull/7` } });
const calendar = (attendees: string[]): SendRequest => ({ source: "calendar", mode: "create", text: "", ref: { title: "sync" }, event: { title: "sync", all_day: false, start: "2026-11-20T10:00", end: "2026-11-20T10:30", location: "", description: "", attendees, meet: false, calendar_id: "primary" } });
const session = (sid = "sess-r1", title?: string): SendRequest => ({ source: "session", mode: "session", text: "ㄱㄱ", ref: { session_id: sid, ...(title ? { title } : {}) } });

beforeEach(() => {
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  _setSendReviewer();
});
afterEach(() => _setSendReviewer());

describe("config: actions.rules / internal_domains / review", () => {
  it("defaults: no rules, no domains, review off — today's behaviour", () => {
    expect(DEFAULT_ACTIONS.rules).toEqual([]);
    expect(DEFAULT_ACTIONS.internal_domains).toEqual([]);
    expect(DEFAULT_ACTIONS.review).toBe("off");
  });

  it("normalizeSendRules: drops junk, trims / cuts text, keeps external booleans only, caps 30", () => {
    const rules = normalizeSendRules([
      { source: "Slack", target: "  #general ", effect: "CONFIRM", note: "  공지  채널 " },
      { source: "fax", effect: "block" },
      { source: "mail", effect: "maybe" },
      { source: "*", effect: "block", external: "yes", note: "x".repeat(200) },
      "nope",
      { source: "mail", effect: "allow", external: false },
    ]);
    expect(rules).toEqual([
      { source: "slack", target: "#general", effect: "confirm", note: "공지 채널" },
      { source: "*", effect: "block", note: "x".repeat(120) },
      { source: "mail", external: false, effect: "allow" },
    ]);
    expect(normalizeSendRules(Array.from({ length: 40 }, () => ({ source: "*", effect: "allow" })))).toHaveLength(30);
    expect(normalizeSendRules("x")).toEqual([]);
  });

  it("sendRulesError: not a list / > 30 / bad entry / long note → message; absent or fine → null", () => {
    expect(sendRulesError({})).toBeNull();
    expect(sendRulesError({ rules: [{ source: "mail", effect: "block" }] })).toBeNull();
    expect(sendRulesError({ rules: "x" })).toMatch(/목록/);
    expect(sendRulesError({ rules: Array.from({ length: 31 }, () => ({ source: "*", effect: "allow" })) })).toMatch(/30개/);
    expect(sendRulesError({ rules: [{ source: "mail", effect: "allow" }, { source: "fax", effect: "allow" }] })).toMatch(/규칙 2/);
    expect(sendRulesError({ rules: [{ source: "mail", effect: "allow", note: "가".repeat(121) }] })).toMatch(/120자/);
  });

  it("internal_domains: lower, '@' dropped, junk out, deduped; string accepted", () => {
    expect(normalizeInternalDomains(["@Acme.com", "acme.com", "not a domain", "corp.acme.co.kr", 3])).toEqual(["acme.com", "corp.acme.co.kr"]);
    expect(normalizeInternalDomains("a.com, @b.io")).toEqual(["a.com", "b.io"]);
  });

  it("normalizeActions: switches take booleans; rules / domains / review normalized, absent keeps base", () => {
    const base = normalizeActions({ rules: [{ source: "mail", effect: "block" }], internal_domains: ["acme.com"], review: "warn" });
    expect(base.rules).toEqual([{ source: "mail", effect: "block" }]);
    const next = normalizeActions({ slack_send: true, review: "loud" }, base);
    expect(next).toMatchObject({ slack_send: true, rules: [{ source: "mail", effect: "block" }], internal_domains: ["acme.com"], review: "warn" });
    expect(normalizeActions({ rules: [] }, base).rules).toEqual([]);
  });
});

describe("rule matching", () => {
  it("targetMatches: case-insensitive, '*' only (no regex), '#' ignored, '@domain' = any address there", () => {
    expect(targetMatches("#General", "general")).toBe(true);
    expect(targetMatches("gen*", "general")).toBe(true);
    expect(targetMatches("gen", "general")).toBe(false);
    expect(targetMatches("g.n.ral", "general")).toBe(false); // '.' is literal
    expect(targetMatches("@acme.com", "kim@acme.com")).toBe(true);
    expect(targetMatches("@acme.com", "kim@notacme.com")).toBe(false);
    expect(targetMatches("*@acme.com", "kim@corp.acme.com")).toBe(false);
    expect(targetMatches("", "x")).toBe(false);
  });

  it("slack: channel name / channel id / person name", () => {
    expect(sendTargetOf(slack()).names).toEqual(["c0gen", "general", "김철수"]);
    const m = (t: string) => matchSendRule(slack(), cfgWith([{ source: "slack", target: t, effect: "confirm" }]));
    expect(m("#GENERAL")).not.toBeNull();
    expect(m("C0GEN")).not.toBeNull();
    expect(m("김*")).not.toBeNull();
    expect(m("#random")).toBeNull();
    // a DM: no channel name, the person still matches
    expect(sendTargetOf(slack({ ref: { channel: "D0DM", title: "DM · 이영희" } })).names).toEqual(["d0dm", "이영희"]);
  });

  it("mail: recipient address or @domain (draft meta reply_to first, else the ref title)", () => {
    expect(sendTargetOf(mail("Kim@Partner.io")).addresses).toEqual(["kim@partner.io"]);
    expect(sendTargetOf(mail("x@a.com"), { reply_to: "boss@acme.com" }).addresses).toEqual(["boss@acme.com"]);
    expect(matchSendRule(mail("kim@partner.io"), cfgWith([{ source: "mail", target: "@partner.io", effect: "block" }]))?.index).toBe(0);
    expect(matchSendRule(mail("kim@acme.com"), cfgWith([{ source: "mail", target: "@partner.io", effect: "block" }]))).toBeNull();
  });

  it("jira project key · github owner/repo · calendar attendees · session worktree", () => {
    expect(matchSendRule(jira("abc-12"), cfgWith([{ source: "jira", target: "ABC", effect: "block" }]))).not.toBeNull();
    expect(matchSendRule(jira("OPS-1"), cfgWith([{ source: "jira", target: "ABC", effect: "block" }]))).toBeNull();
    expect(matchSendRule(github("Acme/Web"), cfgWith([{ source: "github", target: "acme/*", effect: "block" }]))).not.toBeNull();
    expect(matchSendRule(github("other/web"), cfgWith([{ source: "github", target: "acme/*", effect: "block" }]))).toBeNull();
    expect(matchSendRule(calendar(["a@acme.com", "b@client.com"]), cfgWith([{ source: "calendar", target: "@client.com", effect: "confirm" }]))).not.toBeNull();
    fs.writeFileSync(path.join(EVENTS_DIR, `${localDay(new Date())}.jsonl`), JSON.stringify({ event: "SessionStart", ts: Date.now() - 1000, session_id: "sess-r1", cwd: "/w/release-0-5" }) + "\n");
    expect(sendTargetOf(session()).names).toEqual(["release-0-5"]);
    expect(matchSendRule(session(), cfgWith([{ source: "session", target: "release-*", effect: "confirm" }]))).not.toBeNull();
    // no events → the ref title the dashboard sent
    expect(sendTargetOf(session("nope", "wt-x")).names).toEqual(["wt-x"]);
  });

  it("external: by internal_domains (subdomains inside); empty domains or address-less sources → never", () => {
    const tgt = sendTargetOf(mail("kim@partner.io"));
    expect(isExternal(tgt, "mail", ["acme.com"])).toBe(true);
    expect(isExternal(sendTargetOf(mail("kim@corp.acme.com")), "mail", ["acme.com"])).toBe(false);
    expect(isExternal(tgt, "mail", [])).toBeNull();
    expect(isExternal(sendTargetOf(slack()), "slack", ["acme.com"])).toBeNull();
    const ext: SendRule[] = [{ source: "*", external: true, effect: "confirm", note: "외부" }];
    expect(matchSendRule(mail("kim@partner.io"), cfgWith(ext, { internal_domains: ["acme.com"] }))).not.toBeNull();
    expect(matchSendRule(mail("kim@acme.com"), cfgWith(ext, { internal_domains: ["acme.com"] }))).toBeNull();
    expect(matchSendRule(mail("kim@partner.io"), cfgWith(ext))).toBeNull(); // no domains → external rules match nothing
    expect(matchSendRule(slack(), cfgWith(ext, { internal_domains: ["acme.com"] }))).toBeNull(); // Slack: not judged
    expect(matchSendRule(mail("kim@acme.com"), cfgWith([{ source: "mail", external: false, effect: "allow" }], { internal_domains: ["acme.com"] }))).not.toBeNull();
  });

  it("first match wins (top-down); '*' source; no target = every target; read-only modes never ruled", () => {
    const rules: SendRule[] = [
      { source: "slack", target: "#general", effect: "allow" },
      { source: "slack", effect: "block", note: "Slack 금지" },
      { source: "*", effect: "confirm" },
    ];
    expect(matchSendRule(slack(), cfgWith(rules))?.index).toBe(0);
    expect(matchSendRule(slack({ ref: { channel: "C9", title: "#random · x" } }), cfgWith(rules))?.index).toBe(1);
    expect(matchSendRule(jira(), cfgWith(rules))?.index).toBe(2);
    expect(matchSendRule({ ...jira(), mode: "transitions" }, cfgWith(rules))).toBeNull();
    expect(matchSendRule({ source: "email", mode: "mark_read", text: "", ref: { thread_id: "t1" } }, cfgWith(rules))).toBeNull();
  });
});

describe("performSend: switch first, then block / confirm", () => {
  it("a switched-off action is refused by the switch even when a rule would allow it", async () => {
    const cfg = cfgWith([{ source: "slack", effect: "allow" }], { slack_send: false });
    const r = await performSend(slack(), cfg);
    expect(r).toMatchObject({ status: 403, action: "refused" });
    expect(r.detail).toMatch(/config\.actions\.slack_send is off/);
  });

  it("block → 403 with the rule's note, logged as refused with the rule", async () => {
    const r = await performSend(slack(), cfgWith([{ source: "slack", target: "#general", effect: "block", note: "공지 채널엔 쓰지 않기" }]));
    expect(r).toMatchObject({ status: 403, ok: false, action: "refused" });
    expect(r.detail).toContain("공지 채널엔 쓰지 않기");
    expect(readActionLog(1)[0]).toMatchObject({ action: "refused", rule: { index: 0, effect: "block", note: "공지 채널엔 쓰지 않기" } });
  });

  it("confirm without a confirmed guard → 409 need_confirm (no caller can skip the step); confirmed → goes on", async () => {
    const cfg = cfgWith([{ source: "slack", effect: "confirm", note: "한 번 더" }]);
    const r = await performSend(slack(), cfg);
    expect(r).toMatchObject({ status: 409, action: "need_confirm" });
    const ok = await performSend({ ...slack(), guard: { confirmed: true } }, cfg);
    expect(ok.action).toMatch(/^dry_run:/);
    expect(readActionLog(1)[0]).toMatchObject({ confirmed: true, rule: { effect: "confirm" } });
  });

  it("a failed review rides on the result: '검토 못 함' note, still sent", async () => {
    const r = await performSend({ ...slack(), guard: { review: { status: "failed", issues: [], note: "검토 못 함: timeout" } } }, cfgWith([]));
    expect(r.action).toMatch(/^dry_run:/);
    expect(r.detail).toContain("검토 못 함: timeout");
    expect(readActionLog(1)[0].review).toMatchObject({ status: "failed" });
  });
});

describe("confirm token", () => {
  it("valid for the same request for 5 min; expired after; another text / target → mismatch; junk → invalid", () => {
    const now = 1_800_000_000_000;
    const { token } = issueConfirmToken(slack(), now);
    expect(checkConfirmToken(token, slack(), now + 60_000)).toBe("ok");
    expect(checkConfirmToken(token, { ...slack(), origin: "chat" }, now)).toBe("ok"); // origin is not content
    expect(checkConfirmToken(token, slack(), now + CONFIRM_TTL_MS + 1)).toBe("expired");
    expect(checkConfirmToken(token, slack({ text: "hi!" }), now)).toBe("mismatch");
    expect(checkConfirmToken(token, slack({ ref: { channel: "C2" } }), now)).toBe("mismatch");
    expect(checkConfirmToken(undefined, slack(), now)).toBe("missing");
    expect(checkConfirmToken("nope", slack(), now)).toBe("invalid");
    // a forged expiry does not verify
    const [, sig] = token.split(".");
    expect(checkConfirmToken(`${(now + 10 * CONFIRM_TTL_MS).toString(36)}.${sig}`, slack(), now + CONFIRM_TTL_MS + 1)).toBe("mismatch");
  });
});

describe("review", () => {
  it("wantsReview: warn only, never sessions or read-only modes, needs text or an event", () => {
    const warn = cfgWith([], { review: "warn" });
    expect(wantsReview(slack(), cfgWith([]))).toBe(false);
    expect(wantsReview(slack(), warn)).toBe(true);
    expect(wantsReview(session(), warn)).toBe(false);
    expect(wantsReview({ ...github(), mode: "approve", text: "" }, warn)).toBe(false);
    expect(wantsReview(calendar(["a@b.com"]), warn)).toBe(true);
  });

  it("parseReview: issues cleaned (unknown kind → other, blank dropped, ≤ 6); not JSON → null", () => {
    expect(parseReview('{"ok":true,"issues":[]}')).toEqual({ status: "ok", issues: [] });
    const r = parseReview('```json\n{"ok":false,"issues":[{"kind":"secret","detail":"토큰 노출"},{"kind":"weird","detail":"x"},{"kind":"tone","detail":"  "}]}\n```');
    expect(r).toEqual({ status: "issues", issues: [{ kind: "secret", detail: "토큰 노출" }, { kind: "other", detail: "x" }] });
    expect(parseReview("sorry")).toBeNull();
  });

  it("the prompt carries the draft, the recipient and the original request", () => {
    const p = buildReviewPrompt(reviewInput(slack({ text: "내일 3시까지 드릴게요", ref: { channel: "C1", title: "#ops · 박", text: "언제 돼요?" } }), sendTargetOf(slack({ ref: { channel: "C1", title: "#ops · 박" } }))));
    expect(p).toContain("내일 3시까지 드릴게요");
    expect(p).toContain("#ops · 박");
    expect(p).toContain("언제 돼요?");
    expect(p).not.toMatch(/\{\{\w+\}\}/);
  });

  it("guardSend: issues → confirm with a token; none → go; timeout → go with '검토 못 함'; the stub flags secrets offline", async () => {
    const warn = cfgWith([], { review: "warn" });
    _setSendReviewer(async () => ({ status: "issues", issues: [{ kind: "recipient", detail: "다른 프로젝트 채널" }] }));
    const d1 = await guardSend(slack(), warn);
    expect(d1.kind).toBe("confirm");
    if (d1.kind === "confirm") {
      expect(d1.need.review?.issues).toHaveLength(1);
      expect(checkConfirmToken(d1.need.confirm_token, slack())).toBe("ok");
      expect(needConfirmSummary(d1.need)).toContain("검토(recipient)");
    }
    _setSendReviewer(async () => ({ status: "ok", issues: [] }));
    expect(await guardSend(slack(), warn)).toMatchObject({ kind: "go", guard: { review: { status: "ok" } } });
    const never: SendReviewer = () => new Promise(() => {});
    _setSendReviewer(never, 30);
    const d3 = await guardSend(slack(), warn);
    expect(d3).toMatchObject({ kind: "go", guard: { review: { status: "failed" } } });
    expect(d3.guard.review?.note).toMatch(/검토 못 함/);
    _setSendReviewer(async () => { throw new Error("boom"); });
    expect((await guardSend(slack(), warn)).guard.review?.status).toBe("failed");
    _setSendReviewer(); // NED_NO_LLM (test setup): the offline stub
    expect((await guardSend(slack({ text: "토큰 xoxb-1234567890-abcdefghij 여기" }), warn)).kind).toBe("confirm");
    expect((await guardSend(slack(), warn)).kind).toBe("go");
  });

  it("guardSend: a valid token skips the review; sessions are never reviewed", async () => {
    let calls = 0;
    _setSendReviewer(async () => { calls++; return { status: "issues", issues: [{ kind: "tone", detail: "x" }] }; });
    const warn = cfgWith([], { review: "warn" });
    const { token } = issueConfirmToken(slack());
    expect(await guardSend({ ...slack(), confirm_token: token }, warn)).toMatchObject({ kind: "go", guard: { confirmed: true } });
    expect(await guardSend(session(), warn)).toMatchObject({ kind: "go" });
    expect(calls).toBe(0);
  });
});
