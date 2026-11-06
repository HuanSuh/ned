# Ned 대시보드 (`public/index.html`)

daemon(`src/server.ts`) 이 `http://127.0.0.1:<port>/` 에서 그대로 서빙하는 **단일 파일** 로컬 대시보드.
빌드 단계·프레임워크·CDN 의존성 없음 (오프라인 동작). 시스템 폰트, `prefers-color-scheme` 라이트/다크.

## 섹션
| 섹션 | 데이터 | 비고 |
|---|---|---|
| 홈 (기본 탭, `#home`) | `GET /api/agenda` · `GET/POST/PATCH/DELETE /api/todos` · `state.attention` | 위: 데이터로 만든 Ned 한 줄 인사(회의·Jira·리뷰·메일·Slack) + agenda `updated_at`·비용·`새로고침`(`POST /api/agenda/refresh`, 1~2분 busy, 409 면 "이미 가져오는 중"). 왼쪽 **오늘 일정**(최대 400px 열): 08–20시 기본(일정에 맞춰 늘어남) 하루 타임라인, 지금 선, 종일 일정 상단 고정, 겹치는 일정 나란히, RSVP 배지(`needsAction` 강조), 다음 일정 "N분 후", 장소·Meet 링크. 오른쪽 위 **할 일** 카드(항상 펼침): Ned 액션 아이템(`attention` 중 `source !== "sessions"`, 닫기=dismiss) · 개인 할 일(위 입력=POST, 체크=PATCH done, 호버 ✕=DELETE, 완료는 `완료 N` 아래로 접힘). 헤더 총계는 모든 묶음 합. 그 아래 **소스 카드** 그리드(데스크톱 2열, 1020px 이하·폰 1열): 메일 · Jira · Slack · GitHub. 카드마다 두 상태 — shrink(헤더+개수 배지+계산된 요약 문장+가장 급한 항목 한 줄) / expanded(모델 한 줄 요약(메일·Slack) + 전체 목록, 최대 460px 스크롤). 헤더는 `<button>` 이라 클릭·Enter·Space 로 토글, 상태는 `localStorage` `ned.card.<mail|jira|slack|gh>` = `1`/`0` 로 카드별 기억, 기억이 없으면 항목 있으면 expanded / 0건이면 shrink. 요약 문장: 메일 `결재 N · 마감 N · 답장 N · 확인 N · 안 읽은 N(+)`, Jira `마감 지난 N건, 오늘 N건, 진행 중 N건`(없으면 `열린 이슈 N건`), Slack `멘션 N, DM N, 스레드 N 답 필요`, GitHub `리뷰 요청 N, 변경 요청 N, 승인됨 N`(0 인 항목은 뺌). `mail_enabled`/`slack_enabled === false` 면 그 카드 숨김, `mail`/`slack === null` 이면 "다음 새로고침 때 … 가져올게.". 라우트가 404 면 빈 상태 + "연결 안 됨" 으로 그린다 |
| 헤더 | `GET /api/state` | daemon 생존 표시(`updated_at` 20분 이내), 마지막/다음 점검, 조용한 시간 배지, `지금 점검`(`POST /api/heartbeat`) · `아침 브리핑 생성`(`POST /api/heartbeat?daily=1`) — 1~3분 걸리므로 busy 상태 표시 |
| 지금 봐야 할 것 | `state.attention` | kind 아이콘(session/email/slack/jira/github/sentry/calendar/other), 링크, 닫기(`POST /api/attention/:id/dismiss`) |
| 에이전트 세션 | `state.sessions` | 워크트리·상태(색상)·마지막 요약/프롬프트·서브에이전트 수·상대 시간 |
| 브리핑 히스토리 | `GET /api/briefings?limit=30` | 최신순, 펼치면 headline/action_items/updates/fyi/sessions/cost/raw. `NED_OK` 는 접힘·흐리게 |
| 타임라인 | `GET /api/events?days=2` + 브리핑 | ts 로 병합, 이벤트 유형·워크트리 칩 필터 |
| 설정 | `GET/PUT /api/config` | heartbeat/신호 간격, 브리핑 시각, 조용한 시간, 소스 토글(`config.sources` 키에서 자동 생성), claude_model, claude_max_turns |

## 갱신 주기
- `/api/state` 10초 폴링(탭이 다시 보이면 즉시). `/api/agenda`·`/api/todos` 60초 폴링.
- 이벤트·브리핑·설정은 로드 시 + 각 섹션의 새로 고침 버튼 + 점검 완료 후.

## 키보드
`h` 홈 · `i` 인박스 · `r` 지금 점검 · 홈에서 `n` 할 일 입력. 인박스에서 `j/k` 이동, `e` 완료, `⏎` 열기, `1/2/3` 탭(홈에서 누르면 인박스 그 탭으로).

## 로컬 확인
daemon 을 `NED_HOME=/some/fixture` 로 띄우거나, 같은 라우트를 흉내내는 간단한 http 서버로 이 파일을 서빙하면 된다.
