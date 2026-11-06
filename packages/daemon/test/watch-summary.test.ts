import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { matchHighlight, summaryHtml, summaryLines } from "../public/app/features/watchsum.js";

const P = (n: number) => `https://x.slack.com/archives/C0123ABCD/p17300000000000${n}`;
const hls = [
  { from: "김철수", text: "MNT-1234 배포 일정 내일 오전으로 변경됨", url: P(1), needs_me: false },
  { from: "이영희", text: "결제 모듈 리팩터링 리뷰 부탁드려요 @나", url: P(2), needs_me: true },
  { from: "박민수", text: "스테이징 서버 디스크 경고 확인 중", url: P(3), needs_me: false },
];

describe("summaryLines", () => {
  it("splits on newlines and strips bullets", () => {
    expect(summaryLines("- 배포 일정 변경\n• 리뷰 요청\n\n3) 서버 경고")).toEqual(["배포 일정 변경", "리뷰 요청", "서버 경고"]);
  });
  it("falls back to sentence breaks for one long paragraph, keeps short ones whole", () => {
    expect(summaryLines("MNT-1234 배포가 내일 오전으로 바뀌었다. 결제 모듈 리팩터링 리뷰를 나에게 요청했다. 스테이징 디스크 경고가 떴다.")).toHaveLength(3);
    expect(summaryLines("v1.2 배포 완료.")).toEqual(["v1.2 배포 완료."]);
    expect(summaryLines("")).toEqual([]);
  });
});

describe("matchHighlight", () => {
  it("matches a shared issue key", () => {
    expect(matchHighlight("MNT-1234 일정이 밀림", hls)?.url).toBe(P(1));
  });
  it("matches clearly overlapping words (with Korean particles stripped)", () => {
    expect(matchHighlight("이영희가 결제 모듈 리팩터링 리뷰를 요청", hls)?.url).toBe(P(2));
    expect(matchHighlight("스테이징 서버에 디스크 경고", hls)?.url).toBe(P(3));
  });
  it("leaves ambiguous / unrelated lines unlinked", () => {
    expect(matchHighlight("오늘 전반적으로 조용함", hls)).toBeNull();
    expect(matchHighlight("배포", hls)).toBeNull(); // one word is not enough
    const twin = [...hls, { from: "c", text: "MNT-1234 롤백 논의", url: P(4) }];
    expect(matchHighlight("MNT-1234 진행 상황", twin)).toBeNull(); // key shared by two highlights
    const tie = [{ from: "a", text: "로그인 오류 재현", url: P(5) }, { from: "b", text: "로그인 오류 수정", url: P(6) }];
    expect(matchHighlight("로그인 오류 계속", tie)).toBeNull(); // tie → no link
  });
  it("ignores highlights without a usable url", () => {
    expect(matchHighlight("MNT-1234 일정", [{ from: "a", text: "MNT-1234", url: "javascript:alert(1)" }])).toBeNull();
  });
});

describe("summaryHtml", () => {
  it("renders one escaped <li> per line with ↗ only on matched lines", () => {
    const html = summaryHtml("MNT-1234 배포 내일 오전으로 변경\n<b>오늘은 조용</b>", hls);
    const lis = html.match(/<li>.*?<\/li>/g)!;
    expect(lis).toHaveLength(2);
    expect(lis[0]).toContain(`href="${P(1)}"`);
    expect(lis[0]).toContain("↗");
    expect(lis[1]).toBe("<li>&lt;b&gt;오늘은 조용&lt;/b&gt;</li>");
  });
});
