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
| 설정 | `GET/PUT /api/config` | **페르소나** 라디오 4개 + 미리보기 카드(마크·색 견본·예시 헤드라인, 카드마다 그 페르소나 토큰으로 그림). 저장하면 즉시 `<html data-persona>` 가 바뀐다. heartbeat/신호 간격, 브리핑 시각, 조용한 시간, 소스 토글(`config.sources` 키에서 자동 생성), **트래킹 제외**(Slack 채널 / Jira 프로젝트 칩 입력: 엔터·쉼표로 추가, ✕·빈 입력에서 Backspace 로 빼기, `MNT-123` 은 `MNT` 로, 잘못된 키는 안내만. 자동완성 후보는 `/api/agenda` 의 slack 채널·jira 키 접두어와 `/api/briefings` 의 slack·jira 항목에서 클라이언트가 모은 datalist. 저장 = `PUT /api/config` 의 `filters`), claude_model, claude_max_turns |

## 갱신 주기
- `/api/state` 10초 폴링(탭이 다시 보이면 즉시). `/api/agenda`·`/api/todos` 60초 폴링.
- 이벤트·브리핑·설정은 로드 시 + 각 섹션의 새로 고침 버튼 + 점검 완료 후.

## 키보드
`h` 홈 · `i` 인박스 · `r` 지금 점검 · 홈에서 `n` 할 일 입력. 인박스에서 `j/k` 이동, `e` 완료, `⏎` 열기, `1/2/3` 탭(홈에서 누르면 인박스 그 탭으로).

## 로컬 확인
daemon 을 `NED_HOME=/some/fixture` 로 띄우거나, 같은 라우트를 흉내내는 간단한 http 서버로 이 파일을 서빙하면 된다.

## 페르소나 (`data-persona`)

`state.persona`(없으면 `config.persona`)를 `<html data-persona>` 로 건다. 마지막 값은 `localStorage` `ned.persona` 에 두고 `<head>` 의 한 줄 스크립트가 먼저 적용해 깜빡임이 없다.
- 토큰: `:root, [data-persona="ned"]` 와 `[data-persona="alfred|oracle|jarvis"]` 블록(다크/라이트)이 배경·면·글자·포인트(`--hero`, `--hero-fill`, `--hero-text`, `--info`, `--blue2`)·마크 색(`--mk-frame|glint|fill`)·패턴 투명도(`--web-a`)·폰트(`--sans`, `--head`, `--head-w`, `--num`)를 바꾼다. `:root` 가 아니라 속성 선택자라 설정 미리보기 카드도 자기 페르소나 색으로 그려진다.
- 원형별 질감(`:root[data-persona=…]`): ned 헤더 하단 빨강→파랑 라인·카드 웹 코너·파란 선택 테두리 / alfred 금색 하나·세리프 제목·고딕 격자·헤더 스포트라이트·카드 금색 상단선 / oracle 모노·그리드·스캔라인·모니터 타일(베젤 + 상단 LED 바) / jarvis HUD 동심원·시안 글로우·디지털 숫자(Share Tech Mono)·금색/핫로드 레드는 배지·경고에만. 글자 대비는 4.5:1 이상(글자로 쓰기 어두운 포인트는 테두리·채움에만).
- 마크: `marks/<id>.svg` 를 받아 인라인으로 넣는다(클래스 `lens/frame/glint/sweep/bang/moon` 로 기존 상태 연출 유지, jarvis 는 `.core` 가 2.6초 주기로 맥동 — `prefers-reduced-motion` 이면 멈춤).
- 문구: 헤더 이름·탭 제목·말풍선 발화자·상태 문구·홈 인사말·NED_OK 접힘 줄·설정 안내가 JS 의 `VOICE` 표를 따른다. 그 밖의 빈 상태 문구 등은 아직 Ned 기본 말투.
- Google Fonts 에서 Noto Serif KR(alfred)·Share Tech Mono(jarvis)를 불러온다. 오프라인이면 시스템 세리프/모노로 떨어진다.

## 넓은 화면 레이아웃

폰트 크기는 그대로, 밀도만 폭에 맞춘다. 페이지 컨테이너(`.hwrap` 홈, `.pwrap` 타임라인·설정)는 최대 2560px, 좌우 24px(≥1600 에서 32px).
- 홈: <900 1열 · 900~1600 2열(일정 | 할 일 + 소스 카드, 카드는 ≤1100 에서 1열) · ≥1600 3열(일정 | 소스 카드 2열 | Ned 액션 + 개인 할 일 — `.hcol` 이 `display: contents` 로 풀려 grid-area 로 배치) · ≥2000 소스 카드 3열.
- 일정 타임라인: 폭은 `clamp(360px, 22~26vw, 440px)` 로 고정, 시간당 높이(PPH)만 창 높이에 따라 52~72px.
- 인박스: 목록 390px, ≥1600 480px. 상세 본문 max 72ch. 세션 레일은 ≥1800 에서 항상 펼침(접기 버튼 숨김, `ned.railOff` 무시).
- 설정 폼은 2열 그리드(≤760 에서 1열).
