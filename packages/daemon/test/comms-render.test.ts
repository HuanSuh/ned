/** Ned 통신기 (public/app/features/chat-core.js): markdown-lite, feed, ticker and panel HTML snapshots. */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { COMMS_HELLO, COMMS_SIZE, COMMS_VOICE, buildFeed, helloLine, clampSize, commsVoice, feedHtml, mdLite, messagesHtml, readSize, shellHtml, tickerOf } from "../public/app/features/chat-core.js";

const MARK = "<svg class=\"mark\"></svg>";
const NOW = Date.UTC(2026, 10, 7, 3, 0, 0);

describe("mdLite", () => {
  it("escapes html; renders line breaks, links, code, fences, bold", () => {
    expect(mdLite("<b>x</b>\n두 번째 `a<b` **굵게**")).toBe("&lt;b&gt;x&lt;/b&gt;<br>두 번째 <code>a&lt;b</code> <b>굵게</b>");
    expect(mdLite("[PR](https://gh/1) 와 https://x.y/z.")).toBe('<a href="https://gh/1" target="_blank" rel="noopener">PR</a> 와 <a href="https://x.y/z" target="_blank" rel="noopener">https://x.y/z</a>.');
    expect(mdLite("[bad](javascript:alert(1))")).toBe("[bad](javascript:alert(1))");
    expect(mdLite("앞\n```sh\ngh pr list <x>\n```\n뒤")).toBe("앞<br><pre><code>gh pr list &lt;x&gt;</code></pre>뒤");
  });
});

describe("feed", () => {
  const state = { attention: [{ id: "a1", kind: "slack", title: "kim: 배포 언제?", url: "https://slack/1", ts: NOW - 60_000, source: "b1" }, { id: "a2", kind: "jira", title: "done", ts: NOW, source: "b1", reviewed_at: NOW }] };
  const briefings = [{ id: "b9", ts: NOW - 120_000, type: "heartbeat", status: "UPDATE", headline: "결재 2건 기다려", action_items: [{}, {}] }, { id: "old", ts: NOW - 2 * 86400_000, type: "heartbeat", status: "UPDATE", headline: "옛날" }];
  const agenda = { slack: { threads: [{ key: "C1:1", channel: "#dev", url: "https://slack/t", new_since_me: 2, last_reply_ts: "9", last_reply_at: new Date(NOW - 30_000).toISOString(), last_reply_from: "lee", last_reply_text: "확인했어요" }, { key: "C1:2", new_since_me: 0 }] } };

  it("open attention + 24h briefings + threads with new replies, newest first; reviewed / old / quiet dropped", () => {
    const f = buildFeed({ state, briefings, agenda }, new Set(["att:a1"]), NOW);
    expect(f.map((x: { key: string; unread: boolean }) => [x.key, x.unread])).toEqual([["thr:C1:1@9", true], ["att:a1", false], ["brief:b9", true]]);
    expect(tickerOf(f, COMMS_VOICE.ned)).toEqual({ status: "Ned: 새 메시지 2건", line: "#dev · 내 답 이후 새 답글 2건", n: 2, led: "rx" });
    expect(tickerOf([], COMMS_VOICE.alfred).status).toBe("대기 중");
    expect(tickerOf(f, COMMS_VOICE.oracle, { conn: false }).status).toBe("NO SIGNAL");
    expect(commsVoice("nope")).toBe(COMMS_VOICE.ned);
  });

  it("feed rows (snapshot)", () => {
    const f = buildFeed({ state, briefings: [], agenda: null }, new Set(), NOW);
    expect(feedHtml(f, COMMS_VOICE.ned, () => "1분 전")).toMatchInlineSnapshot(`
      "<button type="button" class="cm-it new" data-fi="0" title="열기 (새 탭) · 읽음 처리">
        <span class="ic" aria-hidden="true">💬</span><span class="tt">kim: 배포 언제?</span><span class="tm">1분 전</span><span class="dot" aria-label="안 읽음"></span>
      </button>"
    `);
    expect(feedHtml([], COMMS_VOICE.jarvis)).toBe('<div class="cm-none">새 알림이 없어요.</div>');
  });
});

describe("panel", () => {
  it("messages: user / ned (cost, error, stopped) / live (snapshot)", () => {
    const msgs = [
      { role: "user", text: "오늘 <일정>?", ts: 1 },
      { role: "ned", text: "3시 미팅.\n[링크](https://cal/1)", ts: 2, cost_usd: 0.0312 },
      { role: "ned", text: "", ts: 3, error: "타임아웃" },
      { role: "ned", text: "반쯤", ts: 4, stopped: true },
    ];
    expect(messagesHtml(msgs, COMMS_VOICE.ned, { text: "찾는 중", tool: "Slack · slack_read_thread" }, (ts: number) => `t${ts}`)).toMatchInlineSnapshot(`"<div class="cm-msg me"><div class="bb">오늘 &lt;일정&gt;?</div><div class="mm">t1</div></div><div class="cm-msg ned"><div class="bb">3시 미팅.<br><a href="https://cal/1" target="_blank" rel="noopener">링크</a></div><div class="mm">t2 · $0.03</div></div><div class="cm-msg ned err"><div class="bb"><div class="cm-err">⚠ 타임아웃</div></div><div class="mm">t3</div></div><div class="cm-msg ned"><div class="bb">반쯤</div><div class="mm">t4 · 중단됨</div></div><div class="cm-msg ned live"><div class="bb">찾는 중<div class="cm-think"><span class="spin"></span>찾아보는 중… Slack · slack_read_thread</div></div></div>"`);
    expect(messagesHtml([], COMMS_VOICE.oracle)).toBe('<div class="cm-empty">질의 대기. 일정 · 답할 것 · PR 상태 즉시 응답.</div>');
  });

  it("shell: dock + panel with 대화 / 메시지 tabs (snapshot)", () => {
    expect(shellHtml(COMMS_VOICE.ned, MARK, "⌘")).toMatchSnapshot();
    const alfred = shellHtml(COMMS_VOICE.alfred, MARK, "Ctrl+");
    expect(alfred).toContain('aria-label="인터폰 열기 (Ctrl+J)"');
    expect(alfred).toContain('placeholder="말씀하십시오…"');
  });
});

describe("panel size", () => {
  it("clampSize: min 360×420, max viewport − 32; minimum wins on a tiny viewport", () => {
    expect(COMMS_SIZE).toMatchObject({ minW: 360, minH: 420, defW: 420, defH: 620 });
    expect(clampSize({ w: 500, h: 700 }, 1440, 900)).toEqual({ w: 500, h: 700 });
    expect(clampSize({ w: 100, h: 100 }, 1440, 900)).toEqual({ w: 360, h: 420 });
    expect(clampSize({ w: 5000, h: 5000 }, 1440, 900)).toEqual({ w: 1408, h: 868 });
    expect(clampSize({ w: 999, h: 999 }, 300, 300)).toEqual({ w: 360, h: 420 });
    expect(clampSize({ w: 512.6, h: 600.4 }, 1440, 900)).toEqual({ w: 513, h: 600 });
  });
  it("readSize: restores + clamps a saved size; null (= default) for missing / malformed", () => {
    expect(readSize(JSON.stringify({ w: 640, h: 800 }), 1440, 900)).toEqual({ w: 640, h: 800 });
    expect(readSize(JSON.stringify({ w: 640, h: 2000 }), 1440, 900)).toEqual({ w: 640, h: 868 });
    expect(readSize({ w: 10, h: 10 }, 1440, 900)).toEqual({ w: 360, h: 420 });
    for (const bad of [null, "", "not json", "null", "{}", JSON.stringify({ w: "x", h: 500 }), JSON.stringify({ w: null, h: 500 })]) expect(readSize(bad, 1440, 900)).toBeNull();
  });
  it("shell carries the persona tag and the three resize handles", () => {
    const html = shellHtml(COMMS_VOICE.oracle, MARK);
    expect(html).toContain('<i class="cm-tag" id="cm-tag">ORACLE · LINK</i>');
    expect([...html.matchAll(/data-rs="(\w+)"/g)].map((m) => m[1])).toEqual(["w", "n", "nw"]);
    for (const v of Object.values(COMMS_VOICE)) expect((v as { tag: string }).tag).toMatch(/ · /);
  });
});

describe("greeting", () => {
  it("helloLine: time-of-day bucket per persona, seed varies the line, unknown persona → ned", () => {
    expect(helloLine("ned", 9, 0)).toBe(COMMS_HELLO.ned[1][0]);
    expect(helloLine("ned", 9, 1)).toBe(COMMS_HELLO.ned[1][1]);
    expect(helloLine("alfred", 3, 0)).toBe(COMMS_HELLO.alfred[0][0]);
    expect(helloLine("oracle", 14, 7)).toBe(COMMS_HELLO.oracle[2][7 % COMMS_HELLO.oracle[2].length]);
    expect(helloLine("jarvis", 21, 2)).toBe(COMMS_HELLO.jarvis[3][2]);
    expect(helloLine("nope", 9, 0)).toBe(COMMS_HELLO.ned[1][0]);
    for (const p of Object.keys(COMMS_VOICE)) expect(COMMS_HELLO[p as keyof typeof COMMS_HELLO].every((b: string[]) => b.length >= 2)).toBe(true);
  });
  it("empty chat renders Ned's greeting bubble (escaped) + the hint", () => {
    expect(messagesHtml([], COMMS_VOICE.ned, null, () => "", "좋은 <아침>!")).toBe('<div class="cm-msg ned hello"><div class="bb"><b class="hi">좋은 &lt;아침&gt;!</b><span class="hint">뭐든 물어봐. 오늘 일정, 답할 거, PR 상태 — 아는 건 바로, 모르는 건 찾아볼게.</span></div></div>');
  });
});
