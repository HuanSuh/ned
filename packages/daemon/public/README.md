# Ned 대시보드 (`public/index.html`)

daemon(`src/server.ts`) 이 `http://127.0.0.1:<port>/` 에서 그대로 서빙하는 로컬 대시보드. `index.html` 은 껍데기(head·헤더·탭 컨테이너)이고
화면 로직은 `app/**` 의 ES 모듈, 스타일은 `css/*.css` — 아래 **모듈 맵**.
빌드 단계·프레임워크·CDN 의존성 없음 (오프라인 동작). 시스템 폰트, `prefers-color-scheme` 라이트/다크.

## 모듈 맵

`index.html` → `<link>` 8개(순서 = cascade 순서) + `<script type="module" src="/app/main.js">` + `<script defer src="/search.js">`(⌘K 검색, 독립 파일).

| 파일 | 맡는 것 |
|---|---|
| `app/main.js` | 부팅: 헤더(daemon LED·점검 버튼), 로더(`loadState/Agenda/Todos/…`)·폴링(10s/60s), `renderAll`, 해시 라우팅(`setView`), 전역 키보드 맵, `window.NED`, 각 모듈 `init()` 호출 |
| `app/state.js` | 공유 상태 `S`(서버 데이터) · `ui`(화면 상태) + pub/sub(`subscribe`/`emit`, `renderAll` 뒤에 `"render"`) · `store` |
| `app/api.js` | `api(path, opts)`(JSON, 실패 시 `status` 달린 Error) · `postJson` |
| `app/util.js` | `$`, `esc`, `safeUrl`, 시간 포맷(`hhmm`/`rel`/`dayLabel`…), `lsGet`/`lsSet`, 마감 칩 — 상태 없음, import 없음 |
| `app/ui/icons.js` | kind 아이콘·라벨 표, `iconBtn`(24px 항목 아이콘) |
| `app/ui/chips.js` | 소스 pill 줄(`pillRow`, `PF`, `ned.pf.*`), 소스 on/off(`srcOn`) |
| `app/ui/popover.js` | `errBadge` + 오류 팝오버 |
| `app/ui/modal.js` | 모달 열기/닫기(`body.modal-open`)·Tab 포커스 트랩 |
| `app/ui/toast.js` | `toast()` |
| `app/tabs/home.js` · `inbox.js` · `timeline.js` · `settings.js` | 탭별 렌더와 그 탭 안 이벤트 |
| `app/features/calendar.js` | 일정 패널(일/주, `/api/calendar` 범위, `ned.cal`) |
| `app/features/cards.js` | 소스 카드(메일·Jira·Slack·GitHub), `packCards` |
| `app/features/drafts.js` | 답장 초안 모달 |
| `app/features/reviewed.js` | 확인 완료(attention·소스 항목) |
| `app/features/personas.js` | `VOICE`, 마크, `applyPersona`, 말풍선 `say`, mood·opener |
| `css/tokens.css` → `base` → `inbox` → `timeline` → `settings` → `home` → `components` → `responsive` | 토큰·페르소나 / 셸·카드·칩 / 탭별 / 오류 배지·모달·아이콘 / 모든 미디어쿼리(마지막이어야 함) |

규칙
- 모듈은 필요한 이름만 `import` 한다. 순환 import 는 허용(함수 안에서만 쓰는 이름) — **모듈 최상위에서 다른 모듈의 `const` 를 실행 시점에 읽지 말 것**(TDZ). 최상위 부수효과(리스너 등록 등)는 `export function init()` 안에 두고 `main.js` 의 init 목록에 넣는다. 목록 순서 = document 리스너 순서(예: 오류 팝오버의 Esc 가 페이지 키보다 먼저).
- 다른 모듈의 `let` 을 대입하지 않는다(ES import 는 읽기 전용) — 상태는 `S`/`ui` 속성으로.
- id·class·`localStorage` 키(`ned.*`)는 `search.js` 와 사용자 저장 상태가 기대므로 바꾸지 않는다. `window.NED = { store, api, nav }` (`nav.go(view)`, `nav.tab(t)`, `nav.view()`); `data` 키는 일부러 없다 — `search.js` 는 자체 30초 캐시로 API 를 읽는다.
- 한 모듈 ~600줄 이하.

새 탭 추가: `index.html` 에 `<main class="view page" id="v-<name>" hidden>` + `nav#views` 에 `<a href="#<name>" data-v="<name>">` → `app/tabs/<name>.js` 에 `render<Name>()`(+필요하면 `init()`) → `main.js` 의 `VIEWS` 에 이름, `renderAll` 에 `if (ui.view === "<name>") render<Name>();`, init 목록에 추가 → 스타일은 `css/<name>.css` 를 `responsive.css` 앞에 링크.
새 기능 추가: `app/features/<name>.js` 에 렌더 함수 + `init()`; 탭 쪽에서 import 해 부르거나 `subscribe("render", …)` 로 붙는다. 데이터는 `api()` 로 받아 `S.<key>` 에 둔다.

회귀 확인(헤드리스, GUI 없음): `node scripts/dash-capture.mjs capture --out <dir>` (픽스처 `NED_HOME=/tmp/ned-mods`, 포트 7790, `NED_NO_LLM=1`, 시계 고정) → `compare <before> <after>` 가 탭별 스크린샷(다크/라이트 × 1600/390)·DOM/계산 스타일 해시·인터랙션 단계(j/k/e, ⌘K, 페르소나, 확인 완료, 초안, 설정 PUT, 주간 이동)·콘솔 에러를 비교. 이전 커밋과 비교하려면 그 커밋의 `packages/daemon` 을 `git worktree` 로 꺼내 `--daemon <dir>` 로 찍는다.

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

## 일정 패널 (일 / 주)

헤더의 `[일|주]` 토글과 `[◀ 오늘 ▶]`. 일 뷰는 하루 타임라인(지금 선·"N분 후"는 오늘만), 주 뷰는 월~일 7열(오늘 열 강조, 종일 행 상단, 기본 08–20시·이벤트에 맞춰 확장, 지금 선은 오늘 열에만). 주 뷰일 때 일정 칸이 540~760px 로 넓어지고 소스 카드 열 수가 줄어든다. 패널에 포커스가 있으면 ←/→ 이동(일 1일·주 7일), t 오늘, d/w 전환. 상태는 `localStorage` `ned.cal`(다른 날에 열면 날짜는 오늘로). 데이터: `agenda.calendar_range` 안은 agenda 의 calendar, 밖의 날짜 구간만 `/api/calendar` 로 받아 합친다(받는 동안 위에 "가져오는 중" 표시, 실패 시 "다시").

## 카드 높이

홈 그리드는 `align-items: stretch`. 소스 카드는 `packCards()` 가 `--cols` 개의 열에 (가장 짧은 열부터) 채워 넣고 열마다 마지막 카드를 늘려 모든 열이 행 바닥에서 끝난다(남는 공간은 비움). ≥1600 3열에서는 할 일 열이 `contain: size` 로 행 높이를 정하지 않고 안에서 스크롤한다.

## 소스 pill 필터

홈 '할 일' 카드 헤더 바로 아래와 인박스 탭 아래에 타임라인과 같은 chip(`.chips` / `.lbl` / `.chip` / `.chip.on`)으로 `소스` 줄: 전체 · 세션 · 메일 · Slack · Jira · GitHub · Sentry · 캘린더 · 개인(홈만). 각 chip 에 kind 아이콘과 개수(필터 전 기준; 홈은 할 일 카드 안의 개수), 0건은 흐리게. 클릭으로 다중 토글, '전체' 로 초기화. 상태는 `localStorage` `ned.pf.home` / `ned.pf.inbox`.
- 홈: **할 일 카드 안만** 거른다 — Ned 액션 아이템은 kind 로, 개인 할 일은 '개인' 을 고를 때만. 개수·헤더 'N건' 도 이 카드 기준. 소스 카드와 인사말 카운트는 필터와 무관하게 그대로.
- 인박스: 우선·기타는 항목 kind, 기록은 브리핑에 그 kind 항목이 있을 때만. j/k·Enter·선택은 걸러진 목록 기준.
- 설정에서 꺼진 소스는 카드·pill·인사말 카운트에서 바로 빠진다(`/api/config` 의 `sources`; `GET /api/agenda` 도 꺼진 소스를 비워서 준다).
- 폰 폭에서는 줄바꿈 없이 가로 스크롤.

## 세로 채우기

앱 루트(`.shell`)는 `100dvh` flex column(헤더 자연 높이 + 활성 뷰 `flex: 1`). ≥900px 홈은 페이지 스크롤 없이 그리드 행이 남은 높이를 나눠 갖고(하단 24px 여백), 일정 본문·카드 영역·할 일 목록이 각자 얇은 스크롤바로 안에서 스크롤한다. 2열(900~1600)에서는 오른쪽 열(pill·할 일·카드)이 한 덩어리로 스크롤. 일정 타임라인의 시간당 높이는 패널 본문 높이에 08–20 이 들어가게 맞춘다(40~72px). 인박스 목록·상세·레일, 타임라인·설정은 원래대로 각 영역 안에서 스크롤. <900px 은 자연 스크롤.

## 알림 설정 · 메일/Slack 전체 보기

- 설정 → 알림: 마스터 스위치, 소스별 토글 그리드, 아침 브리핑·소리, 묶음 기준(숫자), 조용한 시간 처리(보내지 않음 / 소리 없이). 마스터를 끄면 나머지는 비활성. 저장 = `PUT /api/config` 의 `notifications`.
- 메일·Slack 카드 헤더 오른쪽 `확인 필요 | 전체` (카드별 `localStorage` `ned.cardmode.<mail|slack>`). 전체는 `mail.all` / `slack.all`, 그중 확인 필요 항목은 왼쪽 포인트색 바, Slack 에서 이미 답한 건 흐리게 + '답함'. '전체' 를 고르면 접힌 카드는 펼친다. 배지 숫자는 확인 필요 개수 그대로.
- 카드 안 리스트도 카드 높이를 채운다(≥900): 소스 카드는 헤더·요약 auto, 리스트 영역(`.sl`)이 나머지를 차지하고 왼쪽 색 구분선이 바닥까지 이어진다 — 열의 마지막 카드가 남는 높이를 받고(최소 220px) 긴 리스트는 그 안에서 스크롤, 다른 카드는 460px 에서 스크롤. 할 일 카드는 Ned 액션 / 개인 할 일 두 섹션이 내용 크기 비율로 높이를 나누고 각자 안에서 스크롤. 일정 패널 본문도 바닥까지(안에서 스크롤).
- Slack DM 은 대화당 최신 1건만(같은 채널 ID 기준, 안전망으로 클라이언트에서도 묶음). 묶인 메시지가 더 있으면 `+N` 배지(N = count − 1). 카드 배지·요약·인사말 개수도 묶은 뒤 기준.

## 답장 초안 팝업

Slack·메일 항목(소스 카드 행, Ned 액션 아이템, 인박스 상세)과 세션(레일·인박스 상세)에 `✍ 답장 초안` 버튼. 누르면 모달: `POST /api/draft {source, ref, hint?, tone?}` (ref 는 permalink 에서 채널 id·ts·thread_ts, 메일은 thread id, 세션은 session_id 를 뽑아 보냄; tone = `config.reply_tone`) → 맥락 요약·발췌, 초안 탭 3개(짧게/보통/정중하게, 탭마다 편집 유지), 편집 가능한 textarea, `다시 생성`(힌트). 하단: 복사 · Slack/Gmail 에서 열기 · Slack 전송 · Gmail 초안 저장 · 메일 보내기 · 세션에 보내기 — `config.actions` (`slack_send` / `gmail_draft` / `gmail_send` / `session_send`, 화면 기본값: Slack 전송·메일 보내기 꺼짐)에 따라 꺼진 건 `aria-disabled` + "설정에서 허용" 툴팁·토스트. 보내는 동작(Slack 전송·메일 보내기·세션에 보내기)은 대상을 보여 주는 확인 단계를 거친다. `POST /api/send {draft_id, source, ref, text, mode}` 결과는 토스트, 403·실패는 모달 안 메시지 + 토스트. 초안을 받는 동안 헤더 안경은 '스캔 중'. 키: Esc 닫기(확인 단계에선 확인만 취소), ⌘⏎/Ctrl⏎ 주 액션(확인 단계에선 확인), Tab 은 모달 안에서 순환. 설정 → '쓰기 액션' 에 토글 4개 + 답장 말투.

## 항목 아이콘 · 확인 완료

항목 동작은 한 컴포넌트(`iconBtn`, 24px, 인라인 SVG, `title`/`aria-label` 이 라벨, hover 는 페르소나 포인트색): 초안(연필) · 열기(외부 링크) · 확인(체크) · 닫기(×). 홈 할 일·소스 카드·인박스 목록/상세·세션 레일에서 같은 모양. 체크를 누르거나 그 항목으로 초안을 만들면 확인 완료(`reviewed_at`) — 홈 Ned 액션은 그룹 아래 `확인 완료 N` 접힘 섹션으로, 인박스 '우선' 은 목록 끝 접힘 줄 아래로 간다(흐리게, 체크 켜짐; 다시 누르면 되돌림). 인사말·pill·배지·헤더 attn·탭 제목 카운트는 열린 항목만. 인박스 j/k 는 접힘을 펼쳤을 때만 확인 완료 항목까지 간다.

## 오류 표시

에러 문자열은 화면에 그대로 늘어놓지 않는다. `errBadge()` 가 경고색 ⚠ 아이콘만 그리고(`title` = 어디서 + 짧은 요약 — `API Error: 400 {…}` 은 JSON 안의 `message` 를 꺼내 요약), 누르면 팝오버에 전체 메시지 · 발생 시각 · `다시 시도`(해당 잡 재실행) · `로그 복사` · 닫기(Esc/바깥 클릭). 쓰는 곳: 홈 상단 agenda 갱신 실패(다시 시도 = agenda 새로고침), 헤더 daemon 상태(연결 실패 / state.json 이 멈춤 / 대시보드에서 실행한 점검 실패), 답장 초안 모달(초안 생성·전송 실패), 캘린더 범위 조회 실패. 토스트도 짧은 요약만.
- 메일·Slack·Jira·GitHub 카드 항목(전체 보기 포함)과 인박스 '기타' 의 같은 소스 항목에도 체크가 있다(소스별 안정 키, 위 daemon README). 체크하거나 그 행에서 초안을 만들면 카드 아래 `확인 완료 N` 으로 접히고, 카드 배지·요약·미리보기·인사말 카운트는 미확인만 센다.
