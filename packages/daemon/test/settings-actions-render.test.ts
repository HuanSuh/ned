import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { WA_GROUPS, readToneBySource, writeActionGroups, writeActionsHtml } from "../public/app/tabs/settings-actions.js";

// Mirrors public/app/features/drafts.js (that module touches the DOM at import).
const DEFAULTS = { slack_send: false, gmail_draft: true, gmail_send: false, session_send: true, jira_comment: false, jira_transition: false, github_review: false, calendar_rsvp: false };
const KO = { slack_send: "Slack 전송", gmail_draft: "Gmail 초안 저장", gmail_send: "메일 보내기", session_send: "세션에 보내기", jira_comment: "Jira 코멘트", jira_transition: "Jira 상태 변경", github_review: "GitHub 리뷰·코멘트", calendar_rsvp: "캘린더 참석 응답" };
const SOURCES = { gmail: true, slack: true, jira: true, github: true, sentry: true, calendar: true };

const acts = (html: string) => [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
const groups = (html: string) => [...html.matchAll(/data-wagrp="([^"]+)"/g)].map((m) => m[1]);

describe("쓰기 액션 by source", () => {
  it("gmail_mark_read renders as a 확인 완료만 / 읽음 표시까지 radio; only the 'on' radio carries data-act", () => {
    const d = { ...DEFAULTS, gmail_mark_read: false };
    const ko = { ...KO, gmail_mark_read: "Gmail 읽음 표시" };
    const html = writeActionsHtml({ sources: SOURCES, actions: d }, d, ko);
    expect(acts(html)).toContain("gmail_mark_read");
    expect(html).toContain('role="radiogroup" aria-label="메일 확인 시"');
    expect(html).toContain('<label><input type="radio" name="wa-gmail_mark_read" value="off" checked>확인 완료만</label>');
    expect(html).toContain('<label><input type="radio" name="wa-gmail_mark_read" value="on" data-act="gmail_mark_read" >Gmail 읽음 표시까지</label>');
    const onHtml = writeActionsHtml({ sources: SOURCES, actions: { gmail_mark_read: true } }, d, ko);
    expect(onHtml).toContain('value="on" data-act="gmail_mark_read" checked>');
    expect(onHtml).toContain('value="off" >확인 완료만');
    expect(writeActionGroups({ actions: {} }, d).find((g: { id: string }) => g.id === "gmail").keys).toEqual(["gmail_draft", "gmail_send", "gmail_mark_read"]);
  });

  it("group order and toggle ids are stable", () => {
    const html = writeActionsHtml({ sources: SOURCES, actions: DEFAULTS }, DEFAULTS, KO);
    expect(groups(html)).toEqual(["slack", "gmail", "session", "jira", "github", "calendar"]);
    expect(acts(html)).toEqual(["slack_send", "gmail_draft", "gmail_send", "session_send", "jira_comment", "jira_transition", "github_review", "calendar_rsvp"]);
    expect(html).not.toContain('class="wagrp off"');
  });

  it("renders the Slack group with its tone input (snapshot)", () => {
    const html = writeActionsHtml({ sources: SOURCES, actions: { slack_send: true }, reply_tone_by_source: { slack: "반말 <짧게>", email: null } }, DEFAULTS, KO);
    const slack = html.split('<div class="wagrp')[1];
    expect(`<div class="wagrp${slack}`.trim()).toMatchInlineSnapshot(`
      "<div class="wagrp" data-wagrp="slack" data-wasrc="slack" role="group" aria-labelledby="wa-h-slack">
            <div class="wah"><span class="waic" aria-hidden="true">💬</span><h3 id="wa-h-slack">Slack</h3><span class="offnote" hidden>소스가 꺼져 있어 — 설정은 그대로 보존돼</span></div>
            <div class="wab"><div class="toggles"><label><input type="checkbox" data-act="slack_send" checked>Slack 전송</label></div><div class="watone"><label for="c-tone-slack">답장 말투</label><input type="text" id="c-tone-slack" data-tone-src="slack" placeholder="기본 말투 사용" maxlength="200" value="반말 &lt;짧게&gt;"></div></div></div>"
    `);
  });

  it("only Slack / Gmail / 세션 get a tone input", () => {
    const html = writeActionsHtml({ sources: SOURCES }, DEFAULTS, KO);
    expect([...html.matchAll(/data-tone-src="([^"]+)"/g)].map((m) => m[1])).toEqual(["slack", "email", "session"]);
  });

  it("a source switched off dims its group; session never dims", () => {
    const html = writeActionsHtml({ sources: { ...SOURCES, gmail: false, jira: false } }, DEFAULTS, KO);
    expect(html).toContain('<div class="wagrp off" data-wagrp="gmail"');
    expect(html).toContain('<div class="wagrp off" data-wagrp="jira"');
    expect(html).toContain('<div class="wagrp" data-wagrp="session" role="group"');
  });

  it("calendar_create joins 캘린더 when the key exists; unknown keys go to 기타", () => {
    const g = writeActionGroups({ actions: { calendar_create: false, sentry_resolve: true } }, DEFAULTS);
    expect(g.find((x: { id: string }) => x.id === "calendar").keys).toEqual(["calendar_rsvp", "calendar_create"]);
    expect(g.at(-1)).toMatchObject({ id: "other", label: "기타", keys: ["sentry_resolve"] });
    const html = writeActionsHtml({ actions: { sentry_resolve: true } }, DEFAULTS, KO);
    expect(html).toContain('data-act="sentry_resolve" checked>sentry_resolve</label>');
    expect(writeActionGroups({}, DEFAULTS).find((x: { id: string }) => x.id === "calendar").keys).toEqual(["calendar_rsvp"]);
    expect(WA_GROUPS.map((x: { id: string }) => x.id)).toEqual(["slack", "gmail", "session", "jira", "github", "calendar"]);
  });

  it("readToneBySource: blank → null", () => {
    const el = (src: string, value: string) => ({ dataset: { toneSrc: src }, value });
    const root = { querySelectorAll: () => [el("slack", "  짧게 "), el("email", "   "), el("session", "x")] };
    expect(readToneBySource(root)).toEqual({ slack: "짧게", email: null, session: "x" });
  });
});
