# Ned 대시보드 (`public/index.html`)

daemon(`src/server.ts`) 이 `http://127.0.0.1:<port>/` 에서 그대로 서빙하는 로컬 대시보드. `index.html` 은 껍데기(head·헤더·탭 컨테이너)이고
화면 로직은 `app/**` 의 ES 모듈, 스타일은 `css/*.css` — 아래 **모듈 맵**.
빌드 단계·프레임워크·CDN 의존성 없음 (오프라인 동작). 시스템 폰트, 라이트/다크 테마 — 설정 → 외형 → 테마(`config.dashboard.theme`: system 은 `prefers-color-scheme`, light/dark 는 `<html data-theme>` 로 강제).

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
| `app/tabs/settings-archive.js` | 설정 → 아카이브(`config.archive`): 켜기·볼트 경로·Ned 폴더·담을 것·데일리 노트 embed(`readArchive` → 저장 PUT), 상태 줄(`GET /api/archive/status` — 볼트 배지·마지막 쓰기·마지막 오류, "지금 쓰기" = `POST /api/archive/flush`) |
| `app/tabs/settings-links.js` | 설정 → 외형 → 링크 열기(`config.dashboard.open_links_in_app`·`open_links_in_app_by_service.*`·`slack_team_id`): `c-openapp`·`c-openapp-svc`(`data-olsvc`, 마스터가 꺼지면 흐려짐)·`c-slack-team`(`T…` 아니면 줄 아래 안내 + 저장 안 함)·`c-slack-domain`(`slack_team_domain`, `Acme.slack.com` → `acme`, 형식이 아니면 안내 + 저장 안 함) — `readLinkPrefs` 가 `dashboard` 에 합쳐져 저장 PUT, 더티 스냅샷에도 포함 |
| `app/tabs/settings-history.js` | 설정 → 수집·보관(`config.history`): 이력 기록 켜기·표시 구간(Slack 시간·메일 일)·수집 창(Slack 전체 재검색 시간 `collect.slack_hours`, `c-hist-collect-slack-h`)·소스별 보관 기간(`readHistorySettings` → 저장 PUT), 상태 줄(`GET /api/history/status`) |
| `app/features/histview.js` | 카드의 수집 이력 토글 `표시 구간 \| 지난 7일 \| 30일`(`histBar`, `histList` — `GET /api/history`, 카드별 `ned.cardhist.<id>`, agenda `updated_at` 바뀌면 다시 받음): 메일·Slack 전체 보기, Jira·GitHub 목록 아래, 팔로업 카드(`channel=`), 일정 calnav "이력" |
| `app/features/histrows.js` | 이력 행 렌더(순수): 날짜 구분선(`dayHead` 오늘/어제/M/D (요일)), 상태 칩, "지금" 표시, 행 버튼 `histAct` — Slack·메일 ✎(origin `history`) + ✓, Jira·GitHub·캘린더 ⋯. `histTarget(row)` 가 `/api/history` 행의 `item` 을 카드 항목 모양으로(Slack url·channel·from·text·ts + 따라가는 스레드, 메일 thread id + 행 ts) 바꿔 ref·확인 키가 카드와 같게 |
| `app/features/draftref.js` | (순수) 초안·액션 ref(`slackRef(x, {thread})`·`mailRef`·`jiraRef`·`githubRef`·`calRef`), ✎ `draftBtn(source, ref, att, {origin, soft, note, pick, title})`·`draftFor(kind, item, att, opts\|origin)`, ⋯ `axBtn(kind, item, origin)`, 액션 로그 출처 칩 `originChip`. drafts.js·actions.js 가 다시 내보냄 |
| `app/features/revkeys.js` | (순수) 소스 항목 확인 키 `srcKey`·`srcRevAt`·`srcCheck`(✓; 키 없는 행은 비활성 "확인 키 없음")·`withFold`·`applyReviewMark`(낙관 갱신 + 되돌리기) — 키·판정(`activityMs`·`reviewedAt`·`foldReviewMarks`)은 `src/review-keys.ts` 복제(같은 픽스처 테스트), reviewed.js 가 다시 내보냄 |
| `app/features/links.js` | (순수) 링크를 앱으로 열기 규칙 테이블 — 웹 URL → `slack://`·`figma://`·`notion://` (`toDeepLink(url, config.dashboard, linkCtxOf(config.dashboard))`, 토글 off·Slack 팀 ID 없음·비대상 → null). `src/links.ts` 복제(`test/links-shared.test.ts` 같은 픽스처) |
| `app/features/openlink.js` | 링크 열기 공통 경로 `openLink(web)`: Ned.app(`webkit.messageHandlers.openLink` 있음)이고 딥링크가 있으면 `{deep, web}` 을 넘기고, 그 밖엔(딥링크 없음·**일반 브라우저**) `window.open(web)` — 앱 딥링크는 Ned.app 창에서만, 브라우저로 연 대시보드는 웹으로(크롬 "앱 열기?" 대화상자는 폴백 타이밍 신호가 없고 Safari 는 늦은 `window.open` 을 막아서). `init()` = document **capture** 클릭 위임 하나(main.js 에서 맨 먼저 등록 — reviewed.js 가 capture 단계에서 인박스 행 아이콘 클릭을 stopPropagation 하므로): 외부 `a[href^="http"]` 의 수정키 없는 왼쪽 클릭만 `preventDefault` + `openLink` — 그래서 링크 만드는 곳(`util.js ext`, `ui/icons.js`, `tabs/inbox.js`, `chat-core.js`, `chat-action.js`, `drafts.js`)은 `href`=웹 URL·`target=_blank` 그대로. 인박스 ⏎(main.js)·통신기 메시지(comms.js)·검색 ⏎(`window.NED.openLink`)도 이 함수 |
| `app/features/watchrow.js` | (순수) 팔로업 행 공용 — 별도 카드(watchcards.js)와 Slack 카드 접힘(cards.js `watchFoldHtml`)이 같은 것을 씀: `watchRow`(모든 하이라이트 ✎, needs_me 아니면 흐림), `watchRecent`(최근 대화 ✎), `watchSummary`/`summaryAct`(요약 줄 ✎ — watchsum.js `summaryTarget`: 1개 → 그 메시지, 여럿 → 모달 고르기 단계, 없음 → recent[0] + "가장 최근 메시지 기준" 안내). 모두 origin `watch`, 원글 ts 를 thread_ts 로 |
| `app/features/calendar.js` | 일정 패널(일/주, `/api/calendar` 범위, `ned.cal`) |
| `app/features/cards.js` | 소스 카드(메일·Jira·Slack·GitHub), `packCards`(행 배치), `unionAll`(전체 뷰) |
| `app/features/cardlayout.js` | 홈 카드 배치: `config.dashboard` 순서·폭 정규화·기본값, 설정 섹션(↑/↓, 1열/2열, 잠금, 배치 초기화, 12열 미리보기) |
| `app/features/layout.js` | 홈 자유 배치(≥1100px): 12열 그리드 모델(`settle` 밀어내기+위로 채우기, `deriveLayout`), 드래그 이동·크기 조절(pointer events), 키보드, 잠금, 디바운스 저장 |
| `app/features/drafts.js` | 답장 초안 모달 (`openDraft(source, ref, att, {origin, note, pick})` — origin 을 `/api/draft`·`/api/send` 에 실음, note = 맥락 위 안내 한 줄, pick = 후보 목록을 먼저 보여 주는 고르기 단계, Esc 닫기 그대로; `toggleMention()` = 멘션 제안 토글, `DR.mention`) |
| `app/features/draftasks.js` | (순수) 초안 모달의 "답할 것" `asksHtml(resp, {mentionOn})` — 2-pass 결과(`meta.mode "2pass"`)만: open `☐ n 누가 · 무엇 · (마감)`(+ `before_reply` 면 "이전" 칩), answered 흐리게 `✓ 이미 답함`, open 0 이면 "답할 질문 없음 — 가벼운 확인 답", `mentions`(`{id, name}` 또는 옛 `"<@U…>"`) 칩 `이름 (@U…)` + 토글 버튼(`data-dmention`). 토글 상태 전이 `toggleMentions(st, ids)`·`editMentions(st, tab, value, base, ids)`(st = `{on, edits, added}` — 끌 때 토글이 넣은 것만 제거), 비편집 탭 표시 `shownText(base, ids, on)`(꺼져 있으면 모델 글 그대로), `applyMentions`·`missingMentions`·`mentionIds`. legacy·옛 캐시 결과는 빈 문자열 |
| `app/features/chat-action.js` | Ned Net 대화창 확인 카드(`actions.chat_write`): ```` ```ned-action ```` 파서, `renderActionCard(block, state, {id})`(순수 HTML), `wireActionCards(root, {get, set, persist, deps})`(위임 이벤트, 실행 → `/api/chat/actions/validate` → 기존 API) — 다른 화면에서도 재사용 |
| `app/features/chat-output.js` | Ned Net 정리 결과물 저장 카드: ```` ```ned-output ```` 파서(`parseOutputBlock` — 펜스 숨김, 스트리밍 중엔 pending), `renderOutputCard({out, err, block}, md)`(순수 HTML — 저장 위치, Obsidian 에서 열기(`obsidian://` 만), Finder 에서 보기, 내용 보기), `wireOutputCards(root, {postJson, toast})`(→ `POST /api/outputs/:id/reveal`) |
| `app/features/reviewed.js` | 확인 완료(attention·소스 항목) |
| `app/features/dailyfail.js` | 실패한 브리핑 표시(순수): `bfFailed(b)`(`ok:false` 또는 옛 파일의 `raw`), `bfKind(b)`("아침 실패"), `dailyFailedLine(state)`(오늘 `daily_failed_at` 이면 홈 한 줄) |
| `app/features/onboarding.js` | 시작하기 모달(`#ob-modal`, `OB`): `GET /api/setup` → 소스 행(상태 칩 `.stk`, "claude.ai 에서 연결" 링크·`gh auth login`, 다시 확인 = `?refresh=1`)·Slack 팀 ID(`#ob-team` → `PUT /api/config { dashboard: { slack_team_id }, if_updated_at }`, 설정 폼이 더티가 아니면 `renderConfig`)·자동 실행(Ned.app 의 `webkit.messageHandlers.loginItem.postMessage({op: get\|set, enabled})` → Promise `{status, enabled, message?}`, 브라우저면 메뉴 안내)·코드 서명 명령. `init()` 이 첫 로드에 `onboarding.dismissed_at` 없고 `complete` 아니면 연다. 닫기(✕·닫기·Esc·바깥) = `POST /api/setup/dismiss`. 설정 상단 `[data-onboard]` 로 다시 열기. `onboardingHtml(OB, {inApp})` 순수 |
| `app/features/personas.js` | `VOICE`, 마크, `applyPersona`, 말풍선 `say`, mood·opener |
| `css/tokens.css` → `base` → `inbox` → `timeline` → `settings` → `home` → `components` → `responsive` | 토큰·페르소나 / 셸·카드·칩 / 탭별 / 오류 배지·모달·아이콘 / 모든 미디어쿼리(마지막이어야 함) |

규칙
- 모듈은 필요한 이름만 `import` 한다. 순환 import 는 허용(함수 안에서만 쓰는 이름) — **모듈 최상위에서 다른 모듈의 `const` 를 실행 시점에 읽지 말 것**(TDZ). 최상위 부수효과(리스너 등록 등)는 `export function init()` 안에 두고 `main.js` 의 init 목록에 넣는다. 목록 순서 = document 리스너 순서(예: 오류 팝오버의 Esc 가 페이지 키보다 먼저).
- 다른 모듈의 `let` 을 대입하지 않는다(ES import 는 읽기 전용) — 상태는 `S`/`ui` 속성으로.
- id·class·`localStorage` 키(`ned.*`)는 `search.js` 와 사용자 저장 상태가 기대므로 바꾸지 않는다. `window.NED = { store, api, nav, openLink }` (`nav.go(view)`, `nav.tab(t)`, `nav.view()`; `openLink(url)` = features/openlink.js); `data` 키는 일부러 없다 — `search.js` 는 자체 30초 캐시로 API 를 읽는다.
- 한 모듈 ~600줄 이하.

새 탭 추가: `index.html` 에 `<main class="view page" id="v-<name>" hidden>` + `nav#views` 에 `<a href="#<name>" data-v="<name>">` → `app/tabs/<name>.js` 에 `render<Name>()`(+필요하면 `init()`) → `main.js` 의 `VIEWS` 에 이름, `renderAll` 에 `if (ui.view === "<name>") render<Name>();`, init 목록에 추가 → 스타일은 `css/<name>.css` 를 `responsive.css` 앞에 링크.
새 기능 추가: `app/features/<name>.js` 에 렌더 함수 + `init()`; 탭 쪽에서 import 해 부르거나 `subscribe("render", …)` 로 붙는다. 데이터는 `api()` 로 받아 `S.<key>` 에 둔다.

회귀 확인(헤드리스, GUI 없음): `node scripts/dash-capture.mjs capture --out <dir>` (픽스처 `NED_HOME=/tmp/ned-mods`, 포트 7790, `NED_NO_LLM=1`, 시계 고정) → `compare <before> <after>` 가 탭별 스크린샷(다크/라이트 × 1600/390)·DOM/계산 스타일 해시·인터랙션 단계(j/k/e, ⌘K, 페르소나, 확인 완료, 초안, 설정 PUT, 주간 이동)·콘솔 에러를 비교. 이전 커밋과 비교하려면 그 커밋의 `packages/daemon` 을 `git worktree` 로 꺼내 `--daemon <dir>` 로 찍는다.

## 섹션
| 섹션 | 데이터 | 비고 |
|---|---|---|
| 홈 (기본 탭, `#home`) | `GET /api/agenda` · `GET/POST/PATCH/DELETE /api/todos` · `state.attention` | 위: 데이터로 만든 Ned 한 줄 인사(회의·Jira·리뷰·메일·Slack) + agenda `updated_at`·비용 (예전 `새로고침` 버튼은 헤더 `지금 점검` 으로 합쳐져 숨김 — 아래 '헤더'). 왼쪽 **오늘 일정**(최대 400px 열): 08–20시 기본(일정에 맞춰 늘어남) 하루 타임라인, 지금 선, 종일 일정 상단 고정, 겹치는 일정 나란히, RSVP 배지(`needsAction` 강조), 다음 일정 "N분 후", 장소·Meet 링크. 오른쪽 위 **할 일** 카드(항상 펼침): Ned 액션 아이템(`attention` 중 `source !== "sessions"`, 닫기=dismiss) · 개인 할 일(위 입력=POST, 체크=PATCH done, 호버 ✕=DELETE, 완료는 `완료 N` 아래로 접힘). 헤더 총계는 모든 묶음 합. 그 아래 **소스 카드** 그리드(데스크톱 2열, 1020px 이하·폰 1열): 메일 · Jira · Slack · GitHub. 카드마다 두 상태 — shrink(헤더+개수 배지+계산된 요약 문장+가장 급한 항목 한 줄) / expanded(모델 한 줄 요약(메일·Slack) + 전체 목록, 최대 460px 스크롤). 헤더는 `<button>` 이라 클릭·Enter·Space 로 토글, 상태는 `localStorage` `ned.card.<mail|jira|slack|gh>` = `1`/`0` 로 카드별 기억, 기억이 없으면 항목 있으면 expanded / 0건이면 shrink. 요약 문장: 메일 `결재 N · 마감 N · 답장 N · 확인 N · 안 읽은 N(+)`, Jira `마감 지난 N건, 오늘 N건, 진행 중 N건`(없으면 `열린 이슈 N건`), Slack `멘션 N, DM N, 스레드 N 답 필요`, GitHub `리뷰 요청 N, 변경 요청 N, 승인됨 N`(0 인 항목은 뺌). `mail_enabled`/`slack_enabled === false` 면 그 카드 숨김, `mail`/`slack === null` 이면 "다음 새로고침 때 … 가져올게.". 라우트가 404 면 빈 상태 + "연결 안 됨" 으로 그린다 |
| 헤더 | `GET /api/state` | daemon 생존 표시(`updated_at` 20분 이내), 마지막/다음 점검, 조용한 시간 배지, `지금 점검`(`POST /api/check` = agenda 새로 고침 → 판단; 예전 홈 `새로고침` 을 합침 — `#ag-refresh` 는 숨김, ⚠ 다시 시도는 여전히 agenda 새로고침) · `아침 브리핑`(`POST /api/heartbeat?daily=1`). busy 라벨은 2초마다 `GET /api/check` 를 읽어 두 단계로: `데이터 갱신 중… N초` → `판단 중… N초` (agenda 단계에 들어가면 카드별 '갱신 중' 도 따라 읽음). `/api/check` 가 404 인 예전 daemon 이면 `/api/heartbeat` 로 떨어지고 라벨은 `스캔 중` |
| 지금 봐야 할 것 | `state.attention` | kind 아이콘(session/email/slack/jira/github/sentry/calendar/other), 링크, 닫기(`POST /api/attention/:id/dismiss`) |
| 에이전트 세션 | `state.sessions` | 워크트리·상태(색상)·마지막 요약/프롬프트·서브에이전트 수·상대 시간 |
| 브리핑 히스토리 | `GET /api/briefings?limit=30` | 최신순, 펼치면 headline/action_items/updates/fyi/sessions/cost/raw. `NED_OK` 는 접힘·흐리게 |
| 타임라인 | `GET /api/events?days=2` + 브리핑 | ts 로 병합, 이벤트 유형·워크트리 칩 필터 |
| 설정 | `GET/PUT /api/config` | 페르소나 선택 UI 는 없음(현재 UI 미제공, config.persona 로만 — 테마는 `state.persona` 를 따름). heartbeat/신호 간격, 브리핑 시각, 조용한 시간, 소스 토글(`config.sources` 키에서 자동 생성), **트래킹 제외**(Slack 채널 / Jira 프로젝트 칩 입력: 엔터·쉼표로 추가, ✕·빈 입력에서 Backspace 로 빼기, `MNT-123` 은 `MNT` 로, 잘못된 키는 안내만. 자동완성 후보는 `/api/agenda` 의 slack 채널·jira 키 접두어와 `/api/briefings` 의 slack·jira 항목에서 클라이언트가 모은 datalist. 저장 = `PUT /api/config` 의 `filters`), claude_model, claude_max_turns |
| 시작하기 (모달) | `GET /api/setup` · `POST /api/setup/dismiss` · `PUT /api/config { dashboard }` | 처음 열 때 준비 안 된 항목이 있고 닫은 적 없으면 저절로, 설정 상단 "시작하기" 로 다시. 모달이 열려 있으면 페이지 키(r/h/i…)는 안 먹음 |
| 설정 → 아카이브 | `GET /api/archive/status` · `POST /api/archive/flush` · `PUT /api/config { archive }` | Obsidian 볼트 경로(잘못된 경로·~/.ned·레포 안이면 저장이 400 으로 막히고 "저장 실패: …"), `.obsidian` 있으면 "볼트 확인됨" 칩. 끄면 나머지는 흐려지지만 값은 저장됨 |

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
- 홈: <900 1열 · 900~1600 2열(일정 | 할 일 + 소스 카드, 카드는 ≤1100 에서 1열) · ≥1600 3열(일정 | 소스 카드 2열 | Ned 액션 + 개인 할 일 — `.hcol` 이 `display: contents` 로 풀려 grid-area 로 배치) · 소스 카드는 최대 2열(주 뷰·≤1100 에서 1열).
- 일정 타임라인: 폭은 `clamp(360px, 22~26vw, 440px)` 로 고정, 시간당 높이(PPH)만 창 높이에 따라 52~72px.
- 인박스: 목록 390px, ≥1600 480px. 상세 본문 max 72ch. 세션 레일은 ≥1800 에서 항상 펼침(접기 버튼 숨김, `ned.railOff` 무시).
- 설정 폼은 2열 그리드(≤760 에서 1열).

## 일정 패널 (일 / 주)

헤더의 `[일|주]` 토글과 `[◀ 오늘 ▶]`. 일 뷰는 하루 타임라인(지금 선·"N분 후"는 오늘만), 주 뷰는 월~일 7열(오늘 열 강조, 종일 행 상단, 기본 08–20시·이벤트에 맞춰 확장, 지금 선은 오늘 열에만). 주 뷰일 때 일정 칸이 540~760px 로 넓어지고 소스 카드 열 수가 줄어든다. 패널에 포커스가 있으면 ←/→ 이동(일 1일·주 7일), t 오늘, d/w 전환. 상태는 `localStorage` `ned.cal`(다른 날에 열면 날짜는 오늘로). 데이터: `agenda.calendar_range` 안은 agenda 의 calendar, 밖의 날짜 구간만 `/api/calendar` 로 받아 합친다(받는 동안 위에 "가져오는 중" 표시, 실패 시 "다시").

## 홈 자유 배치 (`app/features/layout.js`)

≥1100px 에서 홈의 모든 패널(일정 · Slack · 메일 · Jira · GitHub · 할 일)은 12열 그리드 위의 칸 — `config.dashboard.layout = { cal|slack|mail|jira|github|todo: { x, y, w, h } }` (x·w 는 열, y·h 는 행 단위). `#hgrid.free` 가 되고 `.hcol`·`.sgrid` 는 `display: contents` 로 풀려 패널마다 인라인 `grid-column`/`grid-row`. 행 높이 `--rowh` = 그리드 높이를 12행으로 나눈 값(최소 40px) — 12행보다 긴 배치는 그리드 안에서 스크롤. 패널은 자기 h 만큼 늘어나고 안의 목록이 스크롤.
- 기본값(`DEFAULT_LAYOUT`, `src/config.ts` 와 같음): 일정 x0 w3 h12 · Slack x3 w6 h4 · 메일 x3 w3 + Jira x6 w3 (같은 줄) · GitHub x3 w6 · 할 일 x9 w3 h12 — 예전 3열 화면과 같은 비율. `layout` 이 없으면(`null`) `card_order`/`card_span` 에서 한 번 만들어(`deriveLayout`) 저장.
- 마우스: 패널 머리(호버 시 ⠿ 그립)를 끌면 이동 — 끄는 동안 패널이 포인터를 따라가고 점선 자리표시(`.lghost`)가 놓일 칸을 보여 줌. 오른쪽 끝 = 폭, 오른쪽 아래 모서리 = 폭+높이. 칸에 맞춰 스냅, 겹치면 아래로 밀어내고 전체가 위로 채워짐(`settle`). 최소 크기: 일정 2×4, 할 일 2×3, 소스 카드 2×2. 카드 머리 클릭(펼치기)은 5px 이상 끌지 않으면 그대로.
- 키보드: 그립에 포커스 → 방향키 이동(위/아래는 실제로 자리가 바뀌는 다음 줄까지), Shift+방향키 크기, Enter 저장, Esc 취소(포커스를 떠나면 저장). 그립에서는 일정 ←/→ 같은 페이지 키가 안 먹음.
- 저장: 놓으면 바로 화면에 반영하고 400ms 뒤 `PUT /api/config { dashboard }` — 실패하면 마지막으로 서버가 확인한 배치로 되돌리고 토스트.
- 잠금: `config.dashboard.locked` — 홈 상단 오른쪽 자물쇠 아이콘(`#lay-lock`) 또는 설정 → 홈 카드 배치의 체크박스. 잠기면 그립·핸들이 사라지고 드래그가 안 됨. 설정의 `배치 초기화` 는 기본 배치로 바로 저장.
- <1100px: 예전 쌓기 흐름(아래 '카드 높이') 그대로 — 배치는 무시하고 소스 카드 순서만 배치의 위→아래(y, 그다음 x). 폰 그대로.
- 설정의 ↑/↓·1열/2열은 간단한 대안으로 남아 있어서, 바꿔서 저장하면 그 순서·폭으로 배치를 다시 짠다(`deriveLayout`).
- 팔로업 채널 카드(`app/features/watchcards.js`): `config.dashboard.watch_cards`(기본 true)면 `filters.slack.watch_channels`(제외 채널 뺀 것)마다 홈 카드 1개, id `watch:<채널>` — `card_order`·`card_span`·`layout` 에 그대로 들어감(DOM id 는 `sc-w-<채널, [A-Za-z0-9-] 밖 글자는 _hex_>`). 서버 `normalizeDashboard` 는 지금 따라가는 채널의 `watch:` id 만 남기고(설정에서 채널을 빼면 카드·배치도 사라짐), 저장된 배치에 없는 새 카드는 Slack 카드 아래 첫 빈 칸(3×4)에 놓고 한 번 저장(`freeBelow`·`keepFresh`). 접힘 = 모델 요약(≤3줄) + 열린 needs_me, 펼침 = 하이라이트 전체(확인 완료는 접힘). Slack 소스 OFF 면 모두 숨김. false 면 예전처럼 Slack 카드 안 '채널 팔로업' 접힘. needs_me 는 어느 쪽이든 할 일 알약·인사말 집계에 포함.

## 카드 높이 (<1100px)

홈 그리드는 `align-items: stretch`. 소스 카드는 **행 단위** 그리드(`--cols` 1 또는 2열): `packCards()` 가 `config.dashboard` 순서대로 놓고 카드마다 `grid-column: span 1|2`(열 수보다 크면 줄임), 현재 행에 안 들어가는 카드는 다음 행으로. 같은 행 카드는 높이를 맞추고, 마지막 행이 남는 높이를 받는다(`grid-template-rows: … minmax(auto, 1fr)`, `.last`).
기본 배치(`DEFAULT_DASHBOARD`, `src/config.ts`): Slack(2열) → 메일·Jira(1열씩, 같은 행) → GitHub(2열). 설정 → **홈 카드 배치** 에서 ↑/↓ 로 순서, `1열/2열` 로 폭을 바꾸고 오른쪽 미리보기로 행을 확인 → 저장 = `PUT /api/config` 의 `dashboard: { card_order: ['slack','mail','jira','github'], card_span: { slack, mail, jira, github: 1|2 }, layout?, locked? }` (서버가 모르는 id·중복을 버리고 빠진 카드는 뒤에 붙이며, 폭은 1|2 아니면 이전 값; `layout` 은 없으면 이전 값, `null` 이면 지움, 칸은 그리드 안으로·최소 크기로 맞춤 — `normalizeLayout`). DOM id 는 `sc-gh` 이지만 설정 id 는 `github`. ≥1600 3열에서는 할 일 열이 `contain: size` 로 행 높이를 정하지 않고 안에서 스크롤한다.

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
- 수집 이력 토글(`features/histview.js`): 메일·Slack 은 전체 보기 맨 위, Jira·GitHub 은 목록 아래, 팔로업 카드는 펼친 목록 아래, 일정은 calnav "이력". `지난 7일`/`30일` 을 고르면 그 카드 목록이 `/api/history` 결과(날짜 구분선, 지금 카드에 있는 건 왼쪽 바 + "지금")로 바뀐다. 카드별 `localStorage` `ned.cardhist.<id>`.
- 메일·Slack 카드 헤더 오른쪽 `확인 필요 | 전체` (카드별 `localStorage` `ned.cardmode.<mail|slack>`). 전체는 `items ∪ all` — 항목 키(`srcKey`: Slack 채널 id + ts, 메일 thread id; 없으면 링크)로 합쳐 한 줄씩(같으면 `all` 쪽 레코드), 최신순. 그래서 `all` 에 없는 확인 필요 항목(스레드 질문·오래된 마감 메일)도 보인다. 확인 필요 항목은 왼쪽 포인트색 바, Slack 에서 이미 답한 건 흐리게 + '답함'. '전체' 를 고르면 접힌 카드는 펼친다. 배지 숫자는 확인 필요 개수 그대로.
- 카드 안 리스트도 카드 높이를 채운다(≥900): 소스 카드는 헤더·요약 auto, 리스트 영역(`.sl`)이 나머지를 차지하고 왼쪽 색 구분선이 바닥까지 이어진다 — 마지막 행 카드가 남는 높이를 받고(최소 220px) 긴 리스트는 그 안에서 스크롤, 다른 카드는 460px 에서 스크롤. 할 일 카드는 Ned 액션 / 개인 할 일 두 섹션이 내용 크기 비율로 높이를 나누고 각자 안에서 스크롤. 일정 패널 본문도 바닥까지(안에서 스크롤).
- Slack DM 은 대화당 최신 1건만(같은 채널 ID 기준, 안전망으로 클라이언트에서도 묶음). 묶인 메시지가 더 있으면 `+N` 배지(N = count − 1). 카드 배지·요약·인사말 개수도 묶은 뒤 기준.

## 답장 초안 팝업

Slack·메일 항목(소스 카드 행, Ned 액션 아이템, 인박스 상세, 카드의 "지난 N일" 이력 행, 팔로업 카드의 모든 행·최근 대화·요약 줄)과 세션(레일·인박스 상세)에 `✍ 답장 초안` 버튼. 버튼의 `data-draft` 에 출처 `origin`(카드 행 `card`, 이력 행 `history`, 팔로업 `watch`)이 실려 `/api/draft`·`/api/send` 로 가고, 설정 → 오늘 한 액션이 출처 칩(카드 / 지난 N일 / 팔로업 / 대화창)으로 보여 준다(origin 없는 예전 줄은 칩 없음). 누르면 모달: `POST /api/draft {source, ref, hint?, tone?, origin?}` (ref 는 permalink 에서 채널 id·ts·thread_ts, 메일은 thread id, 세션은 session_id 를 뽑아 보냄; tone 은 보내지 않음 — 서버가 `config.reply_tone_by_source[source] ?? config.reply_tone` 로 고름; 1회성 말투는 힌트로) → 답할 대상 한 줄·발췌, "답할 것" 목록(Slack·메일·Jira 2-pass 결과만 — `features/draftasks.js`; 멘션 제안이 있으면 칩 + 토글, 기본 꺼짐, 켜면 각 탭 초안 첫머리에 `<@U…>`, 편집한 글엔 이미 있으면 안 넣음), 초안 탭 3개(짧게/보통/정중하게, 탭마다 편집 유지), 편집 가능한 textarea, `다시 생성`(힌트). 하단: 복사 · Slack/Gmail 에서 열기 · Slack 전송 · Gmail 초안 저장 · 메일 보내기 · 세션에 보내기 — `config.actions` (`slack_send` / `gmail_draft` / `gmail_send` / `session_send`, 화면 기본값: Slack 전송·메일 보내기 꺼짐)에 따라 꺼진 건 `aria-disabled` + "설정에서 허용" 툴팁·토스트. 보내는 동작(Slack 전송·메일 보내기·세션에 보내기)은 대상을 보여 주는 확인 단계를 거친다. `POST /api/send {draft_id, source, ref, text, mode}` 는 작업(job)으로 돈다: 꺼진 액션은 즉시 403, 나머지는 즉시 `202 {job_id}` → `GET /api/send/:job_id` (`{state: running|done, started_at, elapsed_ms, result?}`) 를 2초마다 폴링(최대 4분, 버튼에 "전송 중 34s"). 같은 초안+본문이 진행 중이면 그 job 에 합류(중복 전송 없음), 같은 초안이 10분 안에 이미 성공했으면 409 `already_sent` + 링크. 성공은 토스트 + 닫기, daemon 이 확인한 실패만 재시도 버튼; 데몬 재시작으로 job 이 404 면 `GET /api/actions` 에서 결과를 찾는다. 전송 중 Esc 로 닫아도 끝나면 토스트, 리로드 후에도 `localStorage` 의 pending job 으로 결과를 한 번 확인한다 (`features/sendjob.js`, ⋯ 메뉴 액션도 같은 경로). 초안을 받는 동안 헤더 안경은 '스캔 중'. 키: Esc 닫기(확인 단계에선 확인만 취소), ⌘⏎/Ctrl⏎ 주 액션(확인 단계에선 확인), Tab 은 모달 안에서 순환. 설정 → '쓰기 액션': 상단 기본 말투 + 소스별 그룹 카드(Slack · Gmail · 세션 · Jira · GitHub · 캘린더, 모르는 키는 '기타')에 토글, Slack/Gmail/세션 그룹엔 소스별 '답장 말투' (`tabs/settings-actions.js`, 소스가 꺼지면 그룹이 흐려짐).

## 항목 아이콘 · 확인 완료

항목 동작은 한 컴포넌트(`iconBtn`, 24px, 인라인 SVG, `title`/`aria-label` 이 라벨, hover 는 페르소나 포인트색): 초안(연필) · 열기(외부 링크) · 확인(체크) · 닫기(×). 홈 할 일·소스 카드·인박스 목록/상세·세션 레일에서 같은 모양. 체크를 누르거나 그 항목으로 초안을 만들면 확인 완료(`reviewed_at`) — 홈 Ned 액션은 그룹 아래 `확인 완료 N` 접힘 섹션으로, 인박스 '우선' 은 목록 끝 접힘 줄 아래로 간다(흐리게, 체크 켜짐; 다시 누르면 되돌림). 인사말·pill·배지·헤더 attn·탭 제목 카운트는 열린 항목만. 인박스 j/k 는 접힘을 펼쳤을 때만 확인 완료 항목까지 간다.

## agenda 진행 표시 (`app/features/agstatus.js`)

2단계 agenda(daemon README "agenda") 를 소스별로 보여 준다.
- `GET /api/agenda` 의 `sources_status.<slack|mail|calendar|jira|github>.status`: `running` → 그 카드 헤더(일정은 패널 헤더, `#st-<key>`)에 스피너 + '갱신 중', `error` → ⚠ 배지(`errBadge`, 다시 시도 = 새로고침). `error: "interrupted"` 는 "가져오던 중에 끊겼어(이전 목록 표시 중)" 로 풀어 쓴다.
- 갱신 중이 아니면 같은 자리(`#st-<key>`, 팔로업 채널 카드는 `.srcst[data-src="slack"]`)에 ↻ 버튼(`data-srefresh`) — 그 소스만 `POST /api/agenda/refresh {sources:[key]}`(`refreshSource`). 누르면 바로 '갱신 중' 으로 바뀌고 followAgenda 로 카드가 다시 그려진다. 409(이미 갱신 중)면 토스트만. title = '마지막 갱신 N분 전 · 주기 M분'(`GET /api/agenda` 의 `refresh_minutes`). ⚠ 의 다시 시도도 그 소스만.
- 새로고침(`POST /api/agenda/refresh`)은 1단계가 끝나면 응답하지만 소스마다 끝나는 시점이 달라서, 응답 뒤(그리고 어떤 로드에서든 `busy` 나 `context_status.running` 이 보이면) `busy` 가 false 가 되고 2단계가 쉴 때까지 3초마다 `GET /api/agenda` 를 다시 읽는다 — 카드는 받은 데이터대로 바로 다시 그린다.
- `context_status`(Slack·메일 공용 큐): 진행 중이면 두 카드 하단(`#ctx-slack`, `#ctx-mail`)에 '맥락 수집 done/(done+pending+failed)', `stopped === "budget"` 이면 '오늘 예산 소진' + `지금 수집`(`POST /api/agenda/context?force=1`, 이후 다시 따라 읽음).
- 홈 상단 비용: `GET /api/costs` 의 `오늘 $today_usd / $budget_usd`(툴팁에 마지막 agenda 1단계 비용), `over_budget` 이면 경고색. `/api/costs` 가 없는 daemon 이면 예전처럼 `$cost_usd`.
- `mail.all` / `slack.all` 은 daemon 이 `agenda_all_limit`(기본 20)개까지만 보낸다 — 화면은 받은 만큼 그린다.

## 오류 표시

에러 문자열은 화면에 그대로 늘어놓지 않는다. `errBadge()` 가 경고색 ⚠ 아이콘만 그리고(`title` = 어디서 + 짧은 요약 — `API Error: 400 {…}` 은 JSON 안의 `message` 를 꺼내 요약), 누르면 팝오버에 전체 메시지 · 발생 시각 · `다시 시도`(해당 잡 재실행) · `로그 복사` · 닫기(Esc/바깥 클릭). 쓰는 곳: 홈 상단 agenda 갱신 실패(다시 시도 = agenda 새로고침), 헤더 daemon 상태(연결 실패 / state.json 이 멈춤 / 대시보드에서 실행한 점검 실패), 답장 초안 모달(초안 생성·전송 실패), 캘린더 범위 조회 실패. 토스트도 짧은 요약만.
- 메일·Slack·Jira·GitHub 카드 항목(전체 보기 포함)과 인박스 '기타' 의 같은 소스 항목에도 체크가 있다(소스별 안정 키, 위 daemon README). 체크하거나 그 행에서 초안을 만들면 카드 아래 `확인 완료 N` 으로 접히고, 카드 배지·요약·미리보기·인사말 카운트는 미확인만 센다.
  Slack 은 스레드 메타와 무관한 `slack:<채널>:<ts>` 키, 다시 열림은 체크 시각보다 늦은 `max(행 ts, thread.last_reply_ts, thread.search_latest_ts)` —
  홈 카드·지난 N일 이력·팔로업(별도 카드/접힘)이 같은 키·같은 판정. 키를 못 만든 행은 ✓ 가 비활성(`aria-disabled` + `.nokey` 흐림 — `disabled` 가 아니라 클릭이 와서 `data-review-nokey` 위임 핸들러가 토스트),
  "+N 새 답글" 칩(`slackthread.js newReplies`)은 `seen_reply_ts`(= ✓ 시각) 이후 답글만 센다,
  POST 실패면 낙관 갱신을 되돌리고 토스트(`reviewed.js reviewSource`).
