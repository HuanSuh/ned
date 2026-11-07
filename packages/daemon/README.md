# @ned/daemon

Ned 의 코어 데몬. Claude Code 훅이 남긴 세션 이벤트를 집계하고, 주기적으로 `claude -p` 를 호출해
업무 신호(Gmail/Slack/Jira/Sentry/GitHub/Google Calendar, claude.ai 커넥터 경유)를 브리핑으로 정리하며,
menu bar 앱과 로컬 대시보드가 읽는 `state.json` 을 유지한다. 읽기 전용: 어떤 쓰기 액션도 하지 않는다 — 단 하나의 예외는
사용자가 켠 경우의 `POST /api/send` (아래 "답장 초안 · 보내기" — Slack/Gmail/세션, Jira 코멘트·상태 변경, GitHub 리뷰·코멘트, 캘린더 참석 응답).

> 사용자 기능 가이드(탭·카드·버튼·단축키·설정 키): [`docs/FEATURES.md`](../../docs/FEATURES.md) — 맨 위 "요약" 은 Ned 대화창 프롬프트에도 들어간다.

## Build

```sh
pnpm install            # 모노레포 루트에서 한 번
pnpm --filter @ned/daemon build   # tsc → dist/
```

## Commands

```sh
node dist/cli.js run                 # 데몬: 대시보드(127.0.0.1:7777) + 이벤트 감시 + heartbeat 스케줄러
node dist/cli.js heartbeat [--daily] # heartbeat 1회 강제 실행 (claude -p 호출, 결과 JSON 을 stdout 에 출력)
node dist/cli.js state               # events → sessions 를 다시 계산해 state.json 을 갱신하고 출력
node dist/cli.js agenda              # agenda 잡 1회 실행 (calendar/jira/github/gmail/slack → agenda.json, 결과를 stdout 에 출력)
node dist/cli.js prompt agenda       # dry-run: heartbeat | briefing | agenda 프롬프트를 치환된 그대로 출력 (claude 호출·이벤트 커서 커밋 없음)
```

`run` 은 시작 직후 heartbeat 를 한 번 돌린다. 이후 `heartbeat_minutes` 마다 tick 하며,
새 세션 이벤트도 없고 `signal_check_minutes` 가 지나지 않았으면 LLM 을 부르지 않고 침묵한다.
`briefing_time` 이 지난 첫 tick 은 `prompts/briefing.md` 로 아침 브리핑을 만든다 (하루 1회).

**heartbeat = agenda 재사용** (`src/heartbeat.ts`, `prompts/heartbeat.md` · `briefing.md`): heartbeat 는 Gmail·Slack·Jira·GitHub·캘린더를
직접 읽지 않는다. 흐름 — (a) `agenda.json` 이 `signal_check_minutes` 보다 오래됐으면 agenda 1단계(`refreshAgenda`)를 돌리고 기다린다
(이미 돌고 있으면 그 실행에 합류; 실패하면 이전 목록으로 진행) → (b) 프롬프트 `{{AGENDA}}` 에 agenda 목록을 압축한 텍스트를 넣는다:
캘린더(heartbeat: 앞으로 2시간 + 응답 안 한 초대 / 아침: 오늘 일정 전체), Slack `items` + 답 안 한 `all` + 팔로업 채널 요약·하이라이트(`[나 필요]`),
메일 `items` + 안 읽은 수, Jira, GitHub. heartbeat 는 `sent.log` 에 이미 있는 url 의 항목을 미리 뺀다(아침 브리핑은 그대로) →
(c) `claude -p` 를 커넥터 없이 부른다: `sources.sentry` 가 켜져 있으면 `--tools ToolSearch` + `mcp__Sentry__search_issues`/`get_issue_details` 만,
`--max-turns 6` (Sentry 는 agenda 가 안 다루는 유일한 소스); 꺼져 있으면 도구 없이 isolated(설정·MCP 생략, 1턴). 모델은 `claude_model`.
`claude_max_turns` 는 더 이상 heartbeat 에 쓰지 않는다. NED_OK·`sent.log` 중복 억제·알림·attention 은 전과 같다. `{{SESSIONS}}`/`{{EVENTS}}` 는
`is_worker === true` 인 세션(Orca 워커)을 뺀다(필드가 있을 때). 측정(2026-11-06, Sentry 꺼짐, `claude-fable-5-1`, 신선한 agenda):
$0.36 · 1턴 · 46초 — 이전(커넥터 직접 조회) $2.09–2.34 · 12–15턴 · 107초–7분.
로그 한 줄에 `agenda reused (Nm old)` / `refreshed in Ns, $x` / `joined running refresh`, `judge Ns`, `total Ns` 가 찍힌다.

**지금 점검** (`POST /api/check`): agenda 1단계를 **항상** 새로 돌린 뒤 heartbeat(강제). 동시에 여러 번 불러도 한 번만 돈다.
`GET /api/check` → `{running, phase: "agenda"|"judge"|null, daily, started_at, phase_started_at}` — 스케줄된 heartbeat·아침 브리핑도 같은 상태를 낸다.
`POST /api/heartbeat` 는 호환용으로 남는다(agenda 는 오래됐을 때만 갱신).

**확인 완료** (`reviewed_at`): attention 항목은 그대로 두고 `~/.ned/reviewed.json`(id → ms, 7일 보관)에 표시만 한다.
`writeState` 가 매번 `reviewed_at` 을 덧입히므로 refreshSessions / heartbeat 가 attention 을 새로 만들어도 유지되고, 표시 뒤에
항목이 바뀌면(`ts` 가 더 늦음 — 예: 세션의 새 알림) 다시 열린 상태가 된다. `POST /api/attention/:id/review {reviewed: boolean}`
(본문 없으면 표시, 없는 id 는 404) → `{ok, id, reviewed_at, attention_open_count}`. `state.json.attention_open_count` 는
확인 완료를 뺀 개수(메뉴바 배지용). 대시보드는 초안 생성(`POST /api/draft`) 성공 후 그 항목에 이 API 를 부른다.
attention id 가 없는 소스 항목도 같은 저장소·엔드포인트를 쓴다 — 키는 네임스페이스로: `mail:<thread id>`,
`slack:<채널 id>:<ts>`(permalink 에서; 못 뽑으면 링크), `jira:<KEY>`, `github:<repo>#<n>` (id 는 URL 인코딩, 없는 attention 이어도
이 형식이면 받는다). 30일 보관. `GET /api/agenda` 의 `reviewed` 에 이 키들만 실어 보내고, agenda 가 같은 항목을 다시 가져와도
키가 같아 유지된다(항목이 표시 뒤에 갱신되면 — received / ts / updated 가 더 늦으면 — 다시 열림).

**알림 설정** (`config.notifications`): `{enabled, kinds:{session,email,slack,jira,github,sentry,calendar}, briefing,
summary_threshold (기본 3), quiet_delivery: skip|silent (기본 skip), sound}`. 읽을 때·`PUT /api/config` 모두 깊게 머지하고
타입을 맞춘다(잘못된 값은 이전 값). `state.json.notifications` 에 그대로 노출 — Ned.app 이 읽어 배너를 결정한다. 데몬의
osascript 폴백도 같은 규칙: 꺼져 있으면 안 보냄, 켜진 kind 의 액션만, 개수가 threshold 이하면 항목별·초과면 묶음 1건, 아침
브리핑은 `briefing`, 조용한 시간엔 skip(안 보냄)/silent(소리 없이), `sound` 면 소리.

**메일·Slack 전체 목록**: agenda 출력의 `mail.all[]`(최근 2일 안 읽은 메일, 최신 `agenda_all_limit`(기본 20)개: id, from, subject, ts, url, unread)과
`slack.all[]`(최근 24h 나를 멘션·DM 한 것, 최대 `agenda_all_limit`개: channel, from, text, url, ts, reason, answered). Slack DM 은 같은 대화(permalink 의 채널 ID, 없으면 channel+보낸 사람)당 최신 1건만 남기고 답 안 한 개수를 `count` 에 — 프롬프트가 그렇게 만들고, 정규화(`collapseDMs`)와 대시보드가 한 번 더 묶는다. 멘션·스레드는 그대로. 선별(`items`)과 같은
검색 결과로 같은 호출에서 만든다. **`all` 은 항상 `items` 의 상위집합**: 프롬프트가 요구하고, 정규화(`supersetSlack`/`supersetMail`)가 빠진
`items` 행을 permalink / thread id 기준으로 `all` 에 더한다(Slack `answered: false`, 메일 `unread: false`, 최신순 재정렬 — 이 때문에 `all` 이 한도보다 최대 10개 길 수 있다).

**캘린더 범위**: agenda 잡은 캘린더를 오늘이 아니라 로컬 날짜 **어제 ~ +13일**(2주)로 받아 `agenda.json` 에
`calendar_range: {from, to}` 를 남긴다. 홈 인사말·"다음 미팅" 같은 오늘 기준 계산은 오늘 날짜로 걸러 쓴다.
그 밖의 날짜는 `GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`(최대 42일): `~/.ned/calendar/<from>_<to>.json` 캐시가
6시간 안이면 그대로, 아니면 캘린더 도구만 허용한 `claude -p`(`prompts/calendar.md`, maxTurns 6)로 받아 캐시한다. 같은 범위는
실행 하나를 공유하고 다른 범위는 줄 세워 하나씩. `NED_NO_LLM=1` 이면 빈 배열(캐시 안 함).

**페르소나 — 미제공 기능** (`config.persona`: `ned` | `alfred` | `oracle` | `jarvis`, 기본 `ned`; 모르는 값은 PUT 에서 무시, 읽을 때 `ned`; 기존 값은 그대로 존중).
현재 UI 미제공 — 대시보드·메뉴바 어디에도 선택 진입점이 없고, config.yaml 의 `persona:` 로만 바꾼다.
기능·데이터는 그대로 두고 말투 + 대시보드 테마 + 마크만 바꾼다. heartbeat.md · briefing.md · agenda-lists.md 의 `{{PERSONA}}` 는
`prompts/personas/<id>.md`(이름, 말투 규칙 5줄, 헤드라인 예시 3개, NED_OK 멘트 예시 3개, 금지사항)로 치환된다. 상태값
`NED_OK` / `UPDATE` 와 JSON 키는 페르소나와 무관하게 그대로. `state.json.persona` 에 같은 값을 미러링한다(세션 갱신마다,
`PUT /api/config` 직후) — 대시보드와 메뉴바 앱이 이걸 읽는다. 캐릭터 이름만 표기하고 로고·실제 대사·이미지는 쓰지 않는다.

**홈 카드 배치** (`config.dashboard`): `{ card_order: ("slack"|"mail"|"jira"|"github")[], card_span: { <id>: 1|2 } }`, 기본
Slack(2) → 메일(1)·Jira(1) → GitHub(2). 읽을 때·`PUT /api/config`(보낸 경우만) 모두 `normalizeDashboard` — 모르는 id·중복은 버리고 빠진 카드는
뒤에 붙이고, 폭이 1|2 가 아니면 이전 값. 대시보드 화면만 쓴다(`public/README.md` "카드 높이").

**트래킹 제외** (`config.filters`): `slack.exclude_channels`(채널명, `#` 없이) · `jira.exclude_projects`(프로젝트 키, 대문자 영숫자만 —
JQL 에 그대로 들어가므로 그 밖의 값은 버린다). heartbeat.md · briefing.md · agenda-lists.md 의 `{{FILTERS}}` 가
`제외 채널: #a, #b / 제외 Jira 프로젝트: KEY1, KEY2 — 이들에 속한 항목은 조회·보고하지 말 것` + Jira JQL 에 넣을
`AND project NOT IN (...)` + Slack 결과에서 버리라는 지시로 바뀐다(비면 `(없음)`). agenda 는 JQL 에 그 절을 직접 넣고
(`{{JQL_EXCLUDE}}`), 정규화 단계에서 제외 프로젝트 이슈·제외 채널 Slack 항목을 한 번 더 걸러낸다. `PUT /api/config` 는
`filters` 를 소스별로 깊게 머지한다 (`filters.slack` 만 보내도 `filters.jira` 유지). API 라우트는 config.yaml 을 매번 새로 읽는다.

**팔로업 채널** (`config.filters.slack.watch_channels`, 기본 `[]`, 최대 20): 멘션·태그가 없어도 따라가 볼 Slack 채널(채널명, `#` 없이).
`exclude_channels` 에도 있으면 제외가 이긴다. 비어 있지 않으면 agenda-lists.md 의 `<!--@watch-->` 섹션이 Slack 호출에 들어가
채널마다 `slack_search_public_and_private`(`filters: "in:#채널"`, 최근 24h, 20개)를 다른 검색과 같은 턴에 병렬로 부르고
(`maxTurns` +2), `slack.watch[]` = `{channel:"#채널", summary(2~3줄: 정해진 것·물은 것), highlights:[{from, text(≤200), ts, url,
needs_me, reason}](채널당 최대 5)}` 를 돌려준다. `needs_me` = 나를 향한 듯한 질문·요청, 내 일에 영향 주는 결정, 마감.
heartbeat / briefing 의 `{{FILTERS}}` 에도 팔로업 목록이 붙어 needs_me 는 `action_items`(kind slack), 채널 결정은 `updates` 로 간다.
대시보드: 설정 → "팔로업 채널" 칩 입력, 홈 Slack 카드의 "채널 팔로업" 접힘 섹션(needs_me 는 강조 바), 카드·소스 pill·인사말 카운트에 needs_me 포함.

**답 필요 해제 이모지** (`config.filters.slack.ack_reactions`, 기본 `["white_check_mark","eyes","+1","heavy_check_mark"]`, 최대 8, `[]` 면 끔):
멘션·DM·참여 스레드에서 **내 답글이 보이거나 내가 이 이모지 중 하나로 리액션하면 확인 완료**다. Slack 검색 결과엔 리액션 목록이 없고
스레드 읽기에도 누가 달았는지는 안 나오므로, agenda-lists.md 의 `<!--@ack-->` 섹션이 이모지마다
`slack_search_public_and_private`(`filters: "hasmy::<이모지>:"`, 최근 24h, 20개, `response_format: "concise"`, `include_context: false`)를 한 번씩 부른다
(`has`/`hasmy` 는 반복하면 AND 라 이모지마다 따로; `hasmy:reaction` 같은 "아무 이모지" 필터는 Slack 이 무시한다).
비용 절감: (1) **조건부** — 모델은 먼저 멘션·DM·스레드(·팔로업) 검색만 한 턴에 하고, 그 결과에 답 필요 후보(`items` 후보, 팔로업 `needs_me` 후보)가
하나라도 있을 때만 다음 턴에 이모지 검색을 병렬로 한다. 후보 0개면 건너뛰고 `acked_urls: []`. (2) **상한** — `filters.slack.ack_check_max`(기본 3, 1~8)개,
`ack_reactions` 앞에서부터만 검색한다(`ackCheckEmojis`). 측정 전 기준 Slack 1단계 13턴·조회 12회 중 이모지 6회가 절반이었다.
(2단계로 옮기는 안은 버렸다 — `slack_read_thread`/`slack_read_channel` 결과에 누가 리액션했는지가 없어 `hasmy` 검색 말고는 확인할 방법이 없다.) 그 permalink 들 = `acked` →
`items` 에서 빼고, `all` 은 `answered: true`, `watch` 하이라이트는 `needs_me: false`. 모델은 `slack.acked_urls[]` 도 내고, 정규화(`normalize`)가
permalink(쿼리·해시 무시)로 같은 처리를 한 번 더 한다 — 확인한 DM 은 그 대화의 그 이전 메시지까지 닫는다. 이름은 콜론 제거·소문자, 한글 커스텀 이모지 가능.
설정 → "답 필요 해제 이모지" 칩 입력(쉼표·엔터로 추가).

**Agenda 잡** (`src/agenda.ts`, `src/agenda-context.ts`, `prompts/agenda-lists.md`, `prompts/agenda-context.md`): 대시보드 HOME 탭용
구조화 데이터. 시작 직후 1회(전 소스), 이후 1분마다 틱을 돌며 **소스별 주기**(`agenda_source_minutes.<slack|mail|calendar|jira|github>`,
null 이면 `agenda_refresh_minutes`(기본 60), 1..1440)가 지난 소스만 모아 한 번에 갱신한다(`src/schedule.ts`; 마지막 실행 =
스케줄러가 돌린 시각과 `sources_status.started_at` 중 늦은 것이라 카드 ↻ 수동 갱신도 다음 자동 갱신을 미룬다; 일일 예산 hard stop 은 그대로).
그리고 `POST /api/agenda/refresh` 때 돈다. 소스별 동시성 — 같은 소스는 한 번에 하나, 다른 소스는 나란히. 로그: `agenda: scheduled refresh [slack] (due: slack 15m)` / `(startup)` / `agenda: manual refresh [mail]`. 두 단계다 —
"메시지 목록 먼저, 맥락은 백그라운드".

- **1단계 — 목록 (소스별 병렬, 먼저 끝난 소스부터 반영)**: 소스마다 따로 `claude -p` 를 **동시에** 띄우고(시작 순서 = 우선순위:
  Slack → 메일 → Jira → 캘린더), 각 호출이 끝나는 즉시 그 소스 키만 `agenda.json` 에 병합 저장한다(원자적 read-modify-write).
  GitHub 는 LLM 없이 데몬이 `gh search prs` 3개를 직접 병렬 실행(~1s)하고, `gh` 가 실패할 때만 Jira 호출에 섞인다.
  호출마다 `prompts/agenda-lists.md` 에서 그 소스 섹션만 골라 쓰고(`<!--@slack-->…` 마커), 허용 도구는 `ToolSearch` + 그 소스의 목록 도구
  하나뿐(Slack `slack_search_public_and_private`, Gmail `search_threads`, Calendar `list_events`, Jira `searchJiraIssuesUsingJql`;
  github 폴백 시 `Bash(gh search prs:*)`), `--tools ToolSearch`, `--max-turns 6`, 모델 `agenda_light_model`(기본 `sonnet`, null 이면
  `claude_model`). 스레드·본문은 열지 않는다(맥락 없음). 시작하면 켜진 소스 전부 `sources_status.<key>.status = "running"` 이 되고,
  끝나면 `done`(또는 `error` — 이때 이전 목록 유지) + `updated_at`/`duration_ms`/`cost_usd`/`signature`/`unchanged`. 결과가 비면
  20초 뒤 한 번 더 묻고(커넥터가 늦게 붙는 경우), 두 번째도 비면 빈 목록으로 받아들인다. 실패·빈 응답 원문은 `agenda.raw.txt`.
- **2단계 — 답장 맥락 (백그라운드)**: Slack(그다음 메일) 목록이 병합되는 순간 시작한다. 대상은 답장이 필요한 항목 — slack `items`,
  `slack.watch[].highlights` 중 `needs_me`, mail `items` 중 reason `reply|approval|request` — 가운데 `draft_context_max_age_minutes` 안의
  `context` 가 없는 것. `agenda_context_batch`(기본 5)개씩 `prompts/agenda-context.md` 로 묶어 읽는다: Slack 은 `slack_read_thread`/
  `slack_read_channel`, 메일은 `get_thread`(PLAIN_TEXT)만 허용, `--max-turns 6`, 모델 `agenda_light_model`. 결과는 배치마다 즉시
  permalink / thread id 로 항목에 병합한다(`items`·`all`·watch 의 같은 행 모두). 맥락 모양은 그대로(`SlackContext`/`MailContext`)라
  `drafts.ts` fast path 는 변경 없음(watch highlight 의 맥락도 찾도록만 넓힘). 진행은 `context_status { pending, done, failed, running,
  updated_at, cost_usd, stopped, skipped }`. 끝나면(`drafts_pregenerate` 가 켜져 있으면) 초안 미리 생성.
  - **변경 없는 소스 건너뛰기**: 소스별 서명(정렬된 permalink / thread id 등의 sha1 12자)을 `sources_status.<key>.signature` 에 남기고,
    맥락 수집이 깨끗이 끝난 서명을 `context_sigs` 에 기록한다. 다음 실행의 서명이 같으면 그 소스의 2단계를 통째로 건너뛴다
    (`?force=1` 이면 무시). 목록이 새로 와도 기존 맥락은 항목 단위로 이월된다(Slack 은 같은 permalink, 메일은 같은 thread 이고 맥락을
    읽은 시각이 마지막 메시지보다 뒤일 때).
  - **일일 예산**: 배치 직전마다 오늘(로컬 날짜) 총 `claude -p` 비용(`~/.ned/costs.json`, agenda·agenda_context·heartbeat·draft·calendar·
    action 합산)이 `agenda_daily_budget_usd`(기본 15) 이상이면 멈추고 `context_status.stopped = "budget"`. 1단계 목록은 예산과 무관하게 돈다.
- 동시에 여러 번 요청돼도 실행 중인 1단계 한 번을 공유한다(busy guard). 2단계는 워커 하나가 소스 큐(Slack 우선)를 순서대로 처리한다.
  `NED_NO_LLM=1` 이면 claude 없이: 1단계는 `NED_NO_LLM_AGENDA`(모델 출력 모양의 JSON 파일) 또는 빈 목록, 2단계는 항목 텍스트로 만든
  스텁 맥락(비용 `NED_NO_LLM_COST`, 지연 `NED_NO_LLM_DELAY_MS`).

실측 (2026-11-06, 같은 계정·같은 날, 팔로업 채널 없음):

| 실행 | 1단계 소스별 병합 시각 (+초) | 1단계 | 2단계 | 합계 |
|---|---|---|---|---|
| 이전: 단일 `claude -p` (목록+맥락+all 50) | — (전부 한 번에) | >300s | (포함) | ~$4.6 |
| 콜드 (맥락 없음) | github +1 · jira +41 · slack +49 · calendar +83 · mail +83 | 83s, $1.03 | slack 1건 40s $0.13 · mail 1건 24s $0.10 | $1.25 |
| 재실행 (목록 변화 없음) | github +1 · jira +48 · mail +48 · slack +88 · calendar +88 | 88s, $1.03 | 전 소스 skip, $0 | $1.03 |

호출별 편차가 크다(같은 Slack 호출이 49~88s). 기동(사용자 settings·플러그인·커넥터 로드)만 ~18-20s 이고, 커넥터가 사용자 settings 를
필요로 해서 `--setting-sources ""` 로 줄일 수 없다(그러면 ToolSearch 가 커넥터를 못 찾음). 캘린더는 2주치(29개) JSON 출력(~9K 토큰)이
지배적이라 단독 호출로 분리했다.

### HTTP API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/state` | `state.json` (sessions, attention, last_briefing, …) |
| GET | `/api/events?days=2` | 최근 N일의 훅 이벤트 (오래된 것부터) |
| GET | `/api/briefings?limit=30` | 브리핑 히스토리 (최신 먼저) |
| GET / PUT | `/api/config` | `config.yaml` 조회 / 부분 갱신 |
| POST | `/api/heartbeat?daily=1` | heartbeat 강제 실행 (agenda 는 오래됐을 때만 갱신 — 호환용) |
| POST | `/api/check?daily=1` | 대시보드 '지금 점검': agenda 1단계 새로 고침 → heartbeat. 결과 브리핑(또는 `{status:"skipped"}`) 반환, 동시 호출은 한 실행을 공유 |
| GET | `/api/check` | 진행 중인 점검 단계 `{running, phase: "agenda"\|"judge"\|null, daily, started_at, phase_started_at}` |
| POST | `/api/attention/:id/dismiss` | attention 항목 제거. 세션 항목은 `dismissed.json` 에 기억돼 같은 알림으로는 다시 안 뜬다 |
| GET | `/api/agenda` | `agenda.json` (+ `busy`, `sources_status`, `context_status`). 없으면 빈 배열과 `updated_at: 0`. 실행 중이 아닌데 `running` 으로 남은 소스(데몬이 도중에 죽음)는 `error: "interrupted"` 로 보여 준다 |
| POST | `/api/agenda/refresh` | body `{ sources?: ["slack", …] }`(없으면 켜진 전 소스). 요청 소스가 **모두** 이미 갱신 중이면 409 `{ busy }`; 일부만이면 나머지만 시작하고 갱신 중인 것은 기다린다. 1단계(목록)가 끝나면 `started`·`busy` 와 함께 반환. 2단계는 백그라운드로 계속 — 응답의 `context_status.running` |
| POST | `/api/agenda/context?force=1` | 2단계(답장 맥락)를 지금 백그라운드로 시작하고 `{context_status}` 를 바로 반환. `force=1` 은 "목록 변화 없음" 건너뛰기를 무시 (신선한 맥락이 있는 항목은 여전히 건너뜀) |
| GET | `/api/costs?days=14` | `{ today, today_usd, budget_usd, over_budget, days: [{day, total_usd, runs, jobs: {<job>: {usd, runs}}}] }` — `~/.ned/costs.json` |
| GET | `/api/todos` | 개인 할 일 목록 |
| POST | `/api/todos` | `{title, due?, note?}` → 생성된 항목 (201). title 이 비면 400 |
| PATCH | `/api/todos/:id` | `{title?, done?, due?, note?}` 부분 갱신. 없으면 404 |
| DELETE | `/api/todos/:id` | 삭제. 없으면 404 |
| POST | `/api/draft` | 답장·코멘트 초안 3개 (Slack / 메일 / 에이전트 세션 / Jira 코멘트 / GitHub 리뷰). 읽기 전용 `claude -p`. 아래 참고 |
| GET | `/api/draft/status` | 초안 미리 생성 마지막 실행 `{ pregenerated, skipped_cached, failed, cost_usd, last_run_ts, running }` |
| POST | `/api/chat` | Ned 채팅 한 턴 `{ conversation_id?, text ≤2000자 }` → `text/event-stream`: `start{conversation_id,title}` → `delta{text}`* (`turn` = 새 응답 시작, `tool{name,label}`) → `done{text,stopped,cost_usd,chat_cost_usd,today_usd}` \| `error{error}`. 400 빈/긴 입력, 404 모르는 대화, 409 다른 턴 진행 중, 429 일일 예산 초과(`chat_ignore_budget: true` 면 예외). 읽기 도구만(`--tools ToolSearch,Bash`, 커넥터 읽기 + `gh` 읽기·`orca status`), plan 모드, `--resume <session_id>` 로 이어감, 비용 job `chat`. 저장: `~/.ned/chats/<id>.json` (최근 20개) |
| GET | `/api/chats` | `{ chats: [{id,title,updated_at,messages,cost_usd}], active, input_max }` 최신순 |
| GET | `/api/chat/:id` | 저장된 대화 `{ id, title, session_id, cost_usd, messages: [{role: user\|ned, text, ts, cost_usd?, error?, stopped?}], running }` |
| POST | `/api/chat/:id/stop` | 진행 중인 턴에 SIGTERM (없으면 404). 지금까지 흐른 텍스트가 `stopped: true` 로 저장됨 |
| POST | `/api/chat/actions/validate` | 확인 카드 검증 `{ block: <ned-action JSON>, text?: 고친 텍스트 }` → 200 `{ ok, kind, endpoint: /api/send\|/api/calendar/events\|/api/todos, payload (origin "chat"), label, summary, target_label, text, text_optional, lookup? }` · 400 형식 · 403 `actions.chat_write`/해당 스위치 꺼짐 · 409 대상이 최근 agenda/state 에 없음. 실행은 안 함 (`src/chat-actions.ts`) |
| POST | `/api/chat/:id/action` | 카드 상태 저장 `{ ts (ned 메시지), state: running\|executed\|failed\|cancelled, text?, result? }` → 메시지의 `action`. (없음\|failed)→running\|cancelled, running→나머지; executed·cancelled 는 최종(409) |
| POST | `/api/send` | 초안 보내기 — `config.actions` 로 켠 것만. 꺼져 있으면 403 |
| GET | `/api/actions` | `sent-actions.log` 최근 50건 (최신 먼저) |
| POST | `/api/sessions/create` | 대화창에서 세션 만들기 (`actions.chat_session_create`, 기본 off) `{repo, worktree:{mode:"new"\|"existing", name}, model:"opus"\|"sonnet"(기본 opus), prompt}`. 400 입력/미등록 레포/없는 기존 워크트리, 403 꺼짐, 409 대화창 출처로 살아 있는 세션 2개(상한), 202 `{job_id}` — 아래 "세션 만들기" |
| GET | `/api/sessions/create/:job_id` | 세션 만들기 작업 `{state, stage, elapsed_ms, result?{ok, detail, session:{worktree_path, handle, stage}}}` (`stage`: worktree_create\|agent_launch → agent_boot → prompt_send → submit_confirm) |

Agenda 응답 형태:

```json
{
  "updated_at": 0, "cost_usd": 0, "error": "(실패한 소스가 있을 때만: \"slack: …\")",
  "sources_status": {"slack": {"status": "running|done|error", "updated_at": 0, "started_at": 0, "duration_ms": 0, "cost_usd": 0, "signature": "", "unchanged": false, "error": "?"}, "mail": {}, "calendar": {}, "jira": {}, "github": {}},
  "context_status": {"pending": 0, "done": 0, "failed": 0, "running": false, "updated_at": 0, "cost_usd": 0, "stopped": "budget|null", "skipped": ["slack"]},
  "context_sigs": {"slack": "", "mail": ""},
  "calendar": [{"id":"","title":"","start":"ISO","end":"ISO","all_day":false,"location":"","url":"","meet_url":"","rsvp":"accepted|needsAction|declined|tentative|organizer","attendees":0}],
  "jira":     [{"key":"","title":"","status":"","priority":"","due":"YYYY-MM-DD|null","url":"","updated":"ISO"}],
  "github":   [{"repo":"owner/name","number":0,"title":"","url":"","author":"","updated":"ISO","reason":"review_requested|my_pr_changes_requested|my_pr_approved"}],
  "mail":     null | {"summary":"한 줄 요약 | \"\"","unread":0,"unread_capped":false,"items":[{"id":"thread id","from":"","subject":"","snippet":"","received":"ISO","url":"","reason":"reply|approval|deadline|request","why":"한 줄"}]},
  "slack":    null | {"summary":"한 줄 요약 | \"\"","items":[{"channel":"#채널|DM|그룹 DM","from":"","text":"한 줄","url":"permalink","ts":"ISO","reason":"mention|dm|thread"}]}
}
```

- calendar: 오늘(로컬 날짜) 일정, 종일 일정 먼저 그다음 시작 시각 순
- jira: `assignee = currentUser() AND statusCategory != Done`, 마감 오름차순 → 갱신 내림차순, 최대 25
- github: 내 리뷰 요청 PR + 변경 요청/승인된 내 열린 PR, 최대 20
- mail: `unread` 는 최근 2일 안 읽은 받은편지함 스레드 수(최대 50, 50 에 닿으면 `unread_capped: true` → 홈은 "50+통"), `items` 는 최근 3일 중 사람이 보낸 업무 메일로 내 행동이 필요한 것(최대 10, 급한 순). 선별은 검색 결과의 발신자·제목·스니펫으로 한다(1단계는 스레드를 열지 않음). 답장 초안용 `context: { from, to, subject, body_excerpt(인용 제거, ≤1500자), attachments[], message_id, reply_to, collected_at }` 는 2단계가 reason `reply|approval|request` 항목만 `get_thread`(PLAIN_TEXT)로 읽어 채운다. 읽음 처리 등 쓰기는 하지 않는다. `mail: null` 은 아직 안 가져옴(mail 도입 전 agenda.json) 또는 gmail 소스 꺼짐. `GET /api/agenda`·`POST /api/agenda/refresh` 응답에는 `mail_enabled`(= `sources.gmail`)가 붙고, false 면 홈은 메일 묶음을 숨긴다
- slack: 최근 24시간, 나를 멘션했거나 DM/스레드에서 질문·요청했고 내가 아직 답하지 않은 것(최대 10, 급한 순). 1단계는 검색 3번(멘션 `<@me>` / `is:dm` / `is:thread with:<@me>`)뿐이고 스레드를 열지 않는다(답했는지는 검색 context 로 판단, 애매하면 넣음; 해제 이모지로 내가 리액션한 메시지도 답한 것 — 위 "답 필요 해제 이모지"). Slack epoch ts 는 ISO 로 바꾼다. `items[]` 와 `watch` 의 `needs_me` 하이라이트에는 2단계가 `slack_read_thread`/`slack_read_channel` 로 읽은 `context: { participants[], messages[{from,ts,text}](최근 5개, 각 ≤300자), collected_at }` 가 붙는다(같은 permalink 의 `all[]` 행에도 같이). 응답에는 `slack_enabled`(= `sources.slack`)가 붙고, false 면 홈은 Slack 카드를 숨긴다

### 답장 초안 · 보내기 (`src/drafts.ts`, `src/actions.ts`, `prompts/draft.md`)

**초안** `POST /api/draft`

```jsonc
// 요청
{ "source": "slack" | "email" | "session" | "jira" | "github",
  "ref": { "url?": "", "channel?": "C…", "ts?": "", "thread_ts?": "", "thread_id?": "", "message_id?": "", "session_id?": "", "title?": "", "text?": "",
           "key?": "ABC-123", "repo?": "owner/name", "number?": "92" },
  "hint?": "내일 오전 가능하다고", "tone?": "반말", "force?": false }
// 응답 200
{ "id": "16hex", "source": "slack",
  "context": { "summary": "상대가 원하는 것 한 줄", "excerpt": "원문 발췌" },
  "drafts": [ { "id": "<id>-0", "label": "짧게", "text": "" }, { "id": "<id>-1", "label": "보통", "text": "" }, { "id": "<id>-2", "label": "정중하게", "text": "" } ],
  "cost_usd": 0.12, "cached": false,
  "meta": { "channel_id?": "", "thread_ts?": "", "thread_id?": "", "message_id?": "", "reply_to?": "", "subject?": "", "session_id?": "" } }
// 400 {error} (source/ref 부족) · 502 {error} (claude 실패·출력 깨짐)
```

- 필요한 ref: slack 은 `url`(permalink — channel/ts/thread_ts 를 파싱) 또는 `channel`(+`ts`/`thread_ts`), 없으면 `text` 만으로 씀.
  email 은 `thread_id`(agenda `mail.items[].id`) 권장, 없으면 `title`/`text` 로 1회 검색. session 은 `session_id` 필수.
  jira 는 `url`(`https://<site>.atlassian.net/browse/KEY-1` — 사이트 호스트가 cloudId) 필수(+`key`). github 는 `repo`+`number` 또는 PR `url`.
- **jira** (코멘트 초안, full 경로): plan 모드 + `--tools ToolSearch` + `mcp__claude_ai_Atlassian__getJiraIssue` 하나만(summary·description·status·comment).
  최근 코멘트의 질문이 있으면 답, 없으면 진행 상황 공유. `meta: {issue_key, cloud_id}`.
- **github** (리뷰 코멘트 초안, fast 경로·도구 없음): Ned 가 직접 읽기 전용 `gh pr view <n> --repo <r> --json title,body,author,…,files`
  (= 파일별 ±, `gh pr diff` 에는 `--stat` 플래그가 없어 이걸로 대신)와 `gh pr diff` 앞 6000자를 프롬프트에 넣는다. `meta: {repo, number}`.
  승인/변경 요청 여부는 초안이 아니라 보내기 단계에서 사용자가 고른다.
- 응답에 `mode: "fast" | "full"` 와 `context_age_minutes` 가 붙는다.
  - **fast** (목표 ≤10s): ref 가 agenda 항목(slack `items`/`all` 은 permalink 또는 channel+ts, mail `items` 는 thread id)과 맞고 그 항목의
    `context` 가 `config.draft_context_max_age_minutes`(기본 180) 안이면, 그 맥락만으로 프롬프트를 만들고
    `claude -p --tools "" --max-turns 1 --permission-mode plan --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands`
    `--effort low --model <draft_fast_model>`(기본 `sonnet`, null 이면 `claude_model`) 로 돌린다(사용자 hooks·플러그인·MCP 를 띄우지 않아
    기동 ~40s → ~3s). 지연의 대부분은 출력 토큰이라 모델은 `excerpt`/`reply_meta` 를 비워 두고 Ned 가 맥락(마지막 상대 메시지,
    메일 `message_id`·`reply_to`·`Re: 제목`)으로 채운다. hint·재생성도 같은 맥락을 쓴다. 실패하면 full 로 한 번 넘어간다.
    session 은 항상 fast(`context_age_minutes: 0`) — `~/.ned/events` 에서 그 세션의 `transcript_path` 를 찾아 최근 user/assistant 텍스트
    12개(최대 6000자)와 마지막 Notification/Stop 을 프롬프트에 넣는다. 도구 없음.
  - **full**: 맥락이 없거나 오래됐을 때. plan 모드 + `--tools ToolSearch` + 소스별 읽기 도구만: slack `slack_read_thread`/`slack_read_channel`,
    email `get_thread`/`search_threads`. `--max-turns 8`. `context_age_minutes: null`.
- 미리 생성(선택): `config.drafts_pregenerate: true`(기본 false)면 agenda 실행 뒤 백그라운드에서 답장이 필요한 항목(slack `items` +
  mail `items` 중 reason `reply|approval|request`, 맥락이 신선한 것)을 순서대로 최대 6개 fast 경로로 생성해 캐시한다(모달이 바로 열림).
  `GET /api/draft/status` → `{ pregenerated, skipped_cached, failed, cost_usd, last_run_ts, running }` (마지막 실행 기준, 로그에 총 비용).
- 초안은 **사용자 본인 목소리**: `{{PERSONA}}` 를 쓰지 않고 요청 `tone` → `config.reply_tone_by_source[source]`(slack/email/session, null 이면 건너뜀) → `config.reply_tone`(기본 말투, 기본 `간결하고 정중한 존댓말, 핵심 먼저`) 순으로 고른다 (`draftTone`). 대시보드는 `tone` 을 보내지 않고 서버가 정한다.
- 캐시: `~/.ned/drafts/<id>.json`, id = sha1(source + ref 키) 앞 16자. 1시간 안이고 hint·tone 이 같으면 `cached: true` 로 그대로
  (session 은 마지막 이벤트 ts 도 키에 들어가 세션이 진행되면 새로 쓴다). `force: true` 면 무시. 같은 키 동시 요청은 실행 하나를 공유.
- `meta` 는 보내기에 쓸 주소: slack 은 channel_id/thread_ts, email 은 모델이 스레드에서 찾은 `message_id`(답장할 마지막 메시지)·
  `reply_to`·`subject`. `POST /api/send` 에 `draft_id` 를 넘기면 이 meta 를 캐시에서 읽어 쓴다.
- `NED_NO_LLM=1` 이면 `[stub 짧게] …` 스텁 3개(비용 0, 캐시 안 함).

**보내기** `POST /api/send` `{ draft_id?, source, ref, text, mode }` → `200 { ok, action, detail, logged_at }`,
그 외 `{ ok:false, action, detail, logged_at, error }` + 400(잘못된 요청·주소 없음) / 403(꺼짐) / 409(세션 터미널 없음) / 502(실패·검증 안 됨).

| source | mode | 스위치 (`config.actions`, 기본) | 동작 |
|---|---|---|---|
| slack | `send` | `slack_send` (false) | `claude -p --permission-mode dontAsk --tools ToolSearch --allowedTools ToolSearch mcp__claude_ai_Slack__slack_send_message --max-turns 4`. `thread_ts` 가 있으면(ref·permalink·draft meta) 스레드 답글, DM(`D…`)이 아니면 `ts` 스레드에 답글, 아니면 채널 메시지. 모델이 `{"ok":true,"permalink":"https://…slack.com/archives/…"}` 를 돌려줘야 성공 |
| email | `gmail_draft` | `gmail_draft` (true) | 같은 패턴, 도구는 `mcp__claude_ai_Gmail__create_draft` 하나 (`replyToMessageId` = message_id, `to`/`subject` = draft meta). 보내지 않고 Gmail 임시보관함에 회신 초안만 만든다. `{"ok":true,"id":…}` 여야 성공 |
| email | `send` | `gmail_send` (false) | 같은 패턴, 도구는 `mcp__claude_ai_Gmail__reply` 하나 (`messageId`, replyAll 없음) |
| session | `session` | `session_send` (true — 로컬·되돌릴 수 있음) | 세션 이벤트의 `orca_pane`(`<tabId>:<leafId>`)/`orca_tab` → `orca terminal list --json` 의 `leafId`/`tabId` 로 핸들을 찾아 `orca terminal send --terminal <handle> --text <text> --enter`. 이벤트에 Orca 정보가 없거나 터미널이 닫혔으면 409 |
| jira | `comment` | `jira_comment` (false) | 같은 패턴, 도구는 `mcp__claude_ai_Atlassian__addCommentToJiraIssue` 하나 (cloudId = URL 의 사이트 호스트, `contentFormat: markdown`, 새 코멘트만). `{"ok":true,"id":…}` 여야 성공 |
| jira | `transitions` | `jira_transition` (false) | **읽기만**: 도구는 `getTransitionsForJiraIssue` 하나. 응답에 `transitions: [{id, name, to?}]` — 대시보드가 이 목록을 먼저 보여 준다. 로그에도 남는다(mode `transitions`) |
| jira | `transition` | `jira_transition` (false) | 도구는 `transitionJiraIssue` 하나, `ref.transition_id`(숫자, 위 목록의 id) 필수, `ref.transition_name` 은 로그용. 모델이 같은 id 로 `{"ok":true,"id":"<id>"}` 를 돌려줘야 성공 |
| github | `approve` · `request_changes` · `review_comment` | `github_review` (false) | `claude -p --permission-mode dontAsk --tools Bash --allowedTools "Bash(gh pr review:*)" --max-turns 3`. Ned 가 명령(`gh pr review <n> --repo <r> --approve\|--request-changes\|--comment [--body-file <파일>]`)을 직접 만들고, 본문은 `~/.ned/tmp/gh-body-*.md`(0600, 실행 뒤 삭제)로 넘겨 모델이 셸 인용을 하지 않는다. `approve` 만 본문 생략 가능. `gh pr review` 는 TTY 가 아니면 아무것도 출력하지 않으므로, 성공 판정은 실행 뒤 Ned 가 읽기 전용 `gh pr view --json reviews` + `gh api user` 로 **내 리뷰가 그 상태로 방금 달렸는지** 확인한다 |
| github | `comment` | `github_review` (false) | 같은 패턴, 허용은 `Bash(gh pr comment:*)` 하나 (`gh pr comment <n> --repo <r> --body-file <파일>`). 출력에 `github.com/<r>/pull/<n>#issuecomment-…` 가 있어야 성공 |
| calendar | `rsvp` | `calendar_rsvp` (false) | 도구는 `mcp__claude_ai_Google_Calendar__respond_to_event` 하나. `ref.event_id`(+`calendar_id`), `ref.response` = `accepted\|declined\|tentative`, `text` 는 선택(responseComment). `{"ok":true,"status":"<response>"}` 여야 성공 |

- Slack 반응(이모지 reaction)은 **없음**: claude.ai Slack 커넥터에 reaction 도구가 없다(send/schedule/draft/canvas/읽기만). 도구가 생기면 같은 패턴으로 추가.
- `text` 필수: slack·email·session·jira `comment`·github `request_changes`/`review_comment`/`comment`. 그 밖(`approve`, `transition(s)`, `rsvp`)은 선택.

- email 은 `message_id` 가 필요하다(ref 또는 `draft_id` 의 meta). 없으면 400 — 보내기 단계에서는 읽기 도구를 허용하지 않는다.
- 텍스트는 JSON 문자열로 프롬프트에 넣고 "글자 하나 바꾸지 말고 그대로, 도구 한 번만" 지시. 최대 4000자.
- 모든 시도(거절·실패·dry-run 포함)는 `~/.ned/sent-actions.log` 에 JSONL 한 줄:
  `{ts, source, mode, action, ref, draft_id, text(앞 120자), ok, result, claude_args?, origin?}` — `claude_args` 는 실제 spawn 한 argv.
- `NED_NO_LLM=1` 또는 `NED_SEND_DRY_RUN=1` 이면 커넥터·gh 액션(Slack/Gmail/Jira/GitHub/Calendar)은 argv 와 프롬프트를 로그에 남기고 실행하지 않는다
  (`ok:false`, `action: "dry_run:…"`, gh 본문 파일도 만들지 않음). 세션 보내기는 로컬이라 그대로 실행한다. `NED_NO_LLM=1` 의 jira `transitions` 는
  화면 테스트용 `(stub)` 전환 2개를 돌려준다.
- 대시보드: Jira·GitHub·캘린더 항목의 **⋯ 메뉴**(`public/app/features/actions.js`) — Jira: 코멘트 초안 쓰기… / 상태 변경…(전환 목록을 먼저 읽음),
  GitHub: 리뷰 초안 쓰기…(팝업에서 리뷰 코멘트·변경 요청·승인+코멘트·PR 코멘트) / 바로 승인, 캘린더: 수락·미정·거절(주최한 일정엔 없음).
  꺼진 스위치는 '꺼짐' 으로 비활성, 쓰기는 모두 메뉴/팝업 안에서 한 번 더 확인. 설정 → 쓰기 액션 아래 **오늘 한 액션** 표(`GET /api/actions` 를 오늘·소스·결과로 거름).
- **대화창 쓰기**(`actions.chat_write`, 기본 꺼짐): 통신기 대화 모델은 그대로 읽기 전용이고, 쓰기 요청엔 답 끝에 ```` ```ned-action ```` 블록
  `{kind, target, text, summary}` 로 **제안만** 한다(프롬프트엔 지금 허용된 kind 만 — `chatWriteBlock`). 대시보드가 확인 카드
  (`public/app/features/chat-action.js` — `renderActionCard`·`wireActionCards`, 다른 화면에서 재사용 가능)로 보여 주고, [실행] 때
  `POST /api/chat/actions/validate` 가 만든 요청을 **기존** `/api/send`·`/api/calendar/events`·`/api/todos` 로 보낸다(`origin: "chat"`).
  `origin: "chat"` 요청은 각 스위치에 더해 `actions.chat_write` 도 켜져 있어야 하고(꺼지면 403 refused), 로그 줄에 `origin` 이 붙는다(할 일 추가도
  `source: "todo"` 줄로 남음) → 설정 → 오늘 한 액션의 "대화창" 배지. Jira 상태 변경은 카드 텍스트(상태 이름)로 전환 목록에서 id 를 찾아 실행.
- **세션 만들기**(`src/session-create.ts`): 검증(토글·`orca repo list` 허용 목록·상한 2 — `~/.ned/chat-sessions.json` 의 handle 이 `orca terminal list` 에 살아 있는 것 + 진행 중 작업) 후 작업에서
  `orca worktree create --name <n> --repo path:<repo> --parent-worktree path:<repo> --agent claude --model <m> --surface terminal`(기존이면 `orca agent launch --worktree path:<wt>`) —
  `--prompt` 는 쓰지 않는다(초안으로만 남는 버그) → `orca terminal read --screen` 에 Claude 입력줄/상태줄이 보일 때까지(최대 90초, 신뢰 확인 화면이면 409)
  → `orca terminal send --enter --wait-submit 15 --text <prompt>` → draft 가 비고 첫 활동(스피너·도구 줄, 또는 receipt `turn_started`)이면 성공. 실패는 `[단계] 사유`.
  첫 프롬프트는 "먼저 계획을 제시하고 승인받은 뒤 구현한다." 로 시작(없으면 붙임). 로그: `source:"session", mode:"create", action:"session_create", origin:"chat", session_create:{…}`.
  대화창: ned-action kind `session_create`(`actions.chat_write` + `actions.chat_session_create` 일 때만 프롬프트에, Orca 등록 레포 목록 10분 캐시 포함) →
  `/api/chat/actions/validate` 가 `/api/sessions/create` 페이로드(`origin:"chat"`)를 만들고 읽기 전용 Orca 검사(등록 레포·기존 워크트리·상한)까지 →
  카드(`chat-action.js`)는 레포·워크트리·모델 읽기 전용, 첫 프롬프트(8000자)만 편집, `sendAndWait(…, {endpoint, match, maxWaitMs: 8분})` 로 폴링하며 `stage` 표시.
  `origin:"chat"` 요청은 `actions.chat_write` 도 켜져 있어야 한다(403). 세션(handle)이 생긴 뒤의 실패는 카드에서 다시 실행 불가(중복 생성 방지).
  `refreshSessions` 가 cwd(또는 Orca 워크트리 경로)가 기록된 워크트리인 세션에 `origin:"chat"`, `origin_terminal` 을 단다(장비실 배지). `NED_SEND_DRY_RUN=1` 이면 검증까지만.
- `actions.ts` 의 `queryActionLog({since, source, result}, limit)` 는 서버 쪽 필터용으로 준비돼 있다(`GET /api/actions` 는 아직 최근 50건 그대로).

Todo 항목: `{id, title, done, created_at, done_at|null, due|null, note|null}` (ms 타임스탬프).

## Environment variables

| 변수 | 기본 | 설명 |
|---|---|---|
| `NED_HOME` | `~/.ned` | 데이터 루트. 테스트 시 `/tmp/ned-test` 같은 경로로 격리 |
| `NED_PORT` | (unset) | 설정 시 `config.yaml` 의 `port` 대신 이 포트로 listen (저장되지 않음). Ned.app 이 띄울 때 넘기고, 테스트 격리에 쓴다 |
| `NED_NO_LLM` | (unset) | `1` 이면 heartbeat 가 `claude -p` 를 호출하지 않고 `NED_OK` 를 기록하며, agenda 1단계는 `NED_NO_LLM_AGENDA` 파일(없으면 빈 목록), 2단계는 스텁 맥락을 쓴다 (비용 0, 테스트용) |
| `NED_NO_LLM_RESULT` | (unset) | `NED_NO_LLM=1` 일 때 heartbeat 가 받을 브리핑 JSON (예: `{"status":"UPDATE","headline":"…","action_items":[…]}`). UPDATE 경로 테스트용 |
| `NED_NO_LLM_AGENDA` | (unset) | `NED_NO_LLM=1` 일 때 agenda 1단계가 쓸 모델 출력 모양 JSON 파일 경로 (`{"slack":{…},"mail":{…},"calendar":[…],…}`). 소스별 호출은 자기 키만 가져간다 |
| `NED_NO_LLM_DELAY_MS` | (unset) | `NED_NO_LLM=1` 일 때 agenda 소스별 스텁 호출 지연 (우선순위 n번째 = n×값) 과 2단계 배치 지연, heartbeat 스텁 판단 단계 지연(1×값) — 순서·진행 상태 테스트용 |
| `NED_NO_LLM_COST` | (unset) | `NED_NO_LLM=1` 일 때 2단계 스텁 배치 하나의 비용(USD) — `costs.json` 에 기록되어 일일 예산 중단 경로를 테스트할 수 있다 |
| `NED_SEND_DRY_RUN` | (unset) | `1` 이면 `POST /api/send` 의 커넥터·gh 액션(Slack/Gmail/Jira/GitHub/Calendar)이 `claude` argv·프롬프트만 로그에 남기고 실행하지 않는다 |
| `NED_NOTIFY` | (unset) | Ned.app 이 데몬을 띄울 때 `app` 으로 설정한다. `config.notify: auto` 이면 이때 osascript 배너를 띄우지 않는다 (알림은 Ned.app 이 `state.json` 을 보고 직접 보낸다) |
| `NED_CHILD` | — | 데몬이 띄운 `claude -p` 자식에 `1` 로 설정됨 (훅이 자기 자신을 관찰하지 않도록 쓸 수 있음) |

`claude` 바이너리는 `PATH` 에서 찾는다. 보통은 Ned.app 이 데몬을 자식 프로세스로 띄우며 `node`/`claude` 위치를 로그인 셸에서 찾아 `PATH` 에 넣는다 (`apps/menubar/README.md`).

## `claude -p` 빠른 시작 (`config.claude_fast_startup`, 기본 켬)

커넥터를 쓰는 `claude -p` 는 사용자 훅(Stop 훅 하나가 ~10s)·플러그인 때문에 호출마다 ~18-20s 가 고정으로 붙었다. 이제
`isolated` 가 아닌 모든 호출에 `--settings $NED_HOME/claude-settings.json --disable-slash-commands` 를 붙인다 — 그 파일은
`{"disableAllHooks": true, "enabledPlugins": {<사용자가 켠 플러그인>: false}}` 이고 `src/claude.ts` 가 `~/.claude/settings*.json` 을
읽어 내용이 바뀔 때만 다시 쓴다 (`~/.claude` 는 쓰지 않음). 사용자 settings 의 model/effort 와 claude.ai 커넥터·Sentry 는 그대로.
측정: overhead(총 − API) 18.9s → 3.2s, 실제 캘린더 호출 26.1s → 13.5s — 표와 근거는 `docs/claude-startup.md`.

- 출력 형식은 `--output-format stream-json --verbose` (`result` 줄을 파싱). `allowedTools` 에 `mcp__claude_ai_*` 가 있는 호출이
  `system/init` 에서 claude.ai 서버를 하나도 못 보면 즉시 kill → 기존 argv 로 재실행하고, 그 데몬 프로세스는 이후 기존 argv 를 쓴다
  (로그 `fast start-up came up without claude.ai connectors`).
- 끄기: `config.yaml` 에 `claude_fast_startup: false` (다음 호출부터 적용). 호출별로는 `ClaudeRunOptions.fastStartup`.

## 알림 (`config.notify`)

| 값 | 동작 |
|---|---|
| `auto` (기본) | `NED_NOTIFY=app` (Ned.app 이 띄운 데몬)이면 데몬은 배너를 띄우지 않고 Ned.app 이 네이티브 알림을 보낸다. 그 외(단독 실행·개발)에는 osascript `display notification` 으로 fallback |
| `osascript` | 항상 osascript (배너가 "Script Editor" 로 표시됨) |
| `off` | 데몬은 배너를 띄우지 않는다 |

어느 경우든 데몬 로그에 `notify: …` 한 줄이 남는다. quiet hours 에는 데몬이 배너를 보내지 않는다.

## Data layout (`$NED_HOME`, 기본 `~/.ned`)

```
~/.ned/
  config.yaml            설정 (없으면 기본값으로 생성). heartbeat_minutes, signal_check_minutes,
                         briefing_time, quiet_hours, sources.{gmail,slack,jira,github,sentry,calendar},
                         persona (ned|alfred|oracle|jarvis), filters.{slack.exclude_channels, slack.watch_channels, slack.ack_reactions, slack.ack_check_max, jira.exclude_projects} (트래킹 제외 / 팔로업 채널 / 답 필요 해제 이모지 / 한 run 에 검색할 이모지 수(3), ack_reactions·ack_check_max 외 기본 []),
                         port, claude_model, claude_max_turns, session_stale_minutes, agenda_refresh_minutes, notify,
                         actions.{slack_send=false, gmail_draft=true, gmail_send=false, session_send=true,
                                  jira_comment=false, jira_transition=false, github_review=false, calendar_rsvp=false} (POST /api/send 허용),
                         reply_tone (답장 초안 말투, 기본 "간결하고 정중한 존댓말, 핵심 먼저"), reply_tone_by_source ({slack,email,session}: 소스별 말투, null = reply_tone),
                         draft_context_max_age_minutes=180 (agenda 맥락 → fast 초안), draft_fast_model="sonnet", drafts_pregenerate=false,
                         agenda_all_limit=20 (mail/slack all[] 상한), agenda_context_batch=5 (2단계 배치 크기),
                         agenda_daily_budget_usd=15 (2단계 일일 예산), agenda_light_model="sonnet" (agenda 전 호출 모델, null = claude_model)
  state.json             menu bar / 대시보드가 읽는 단일 뷰 (sessions, attention, last_briefing, quiet …)
  cursor.json            heartbeat 가 처리한 마지막 이벤트 ts
  events/YYYY-MM-DD.jsonl  훅(packages/hook/ned-hook.sh)이 append 하는 이벤트. 로컬 날짜 기준
  briefings/<iso-ts>.json  heartbeat / daily 브리핑 결과 (status, action_items, updates, fyi, sessions, cost_usd)
  briefings/sent.log     이미 알린 항목 키 (title 또는 url) — 중복 억제
  agenda.json            HOME 탭 agenda: {updated_at, cost_usd, error?, sources_status, context_status, context_sigs, calendar, jira, github, mail, slack}
  agenda.raw.txt         마지막으로 빈/깨진 agenda 호출의 모델 원문 (디버깅)
  costs.json             claude -p 비용 원장: {days: {YYYY-MM-DD: {total_usd, runs, jobs: {agenda, agenda_context, heartbeat, draft, calendar, action}}}} (30일)
  drafts/<id>.json       답장 초안 캐시 (1시간): {id, source, mode, context_age_minutes, context, drafts, cost_usd, created_at, hint, tone, meta}
  drafts/_pregenerate.json  마지막 미리 생성 실행 결과 (GET /api/draft/status)
  sent-actions.log       POST /api/send 시도 기록 JSONL (거절·실패 포함)
  chat-sessions.json     대화창에서 만든 세션: [{job_id, created_at, repo, mode, name, model, worktree_path, worktree_id, handle, ok, stage}] (14일)
  todos.json             개인 할 일. 완료 후 7일 지난 항목은 로드할 때 정리된다
  dismissed.json         dismiss 한 세션 attention: {id: {alert_ts, at}} (7일 보관)
  logs/daemon.log        데몬 로그
  hook.err               훅 파이썬 단계의 stderr (정상이면 비어 있음)
```

세션 상태 머신 (`src/sessions.ts`): `UserPromptSubmit/SessionStart → running`, `Notification → waiting`,
`Stop → done`, `StopFailure → error`, `SessionEnd → 목록에서 제거`. 마지막 이벤트가
`session_stale_minutes` 보다 오래된 세션도 제거된다 (`0` 이면 비활성화).
`waiting`/`error` 세션은 매 tick `attention` 에 다시 올라온다. 단, 사용자가 dismiss 한 경우
그 알림(`alert_ts` = 마지막 `Notification`/`StopFailure` 시각)이 바뀌기 전까지는 올리지 않는다.

## Testing (vitest)

```sh
pnpm test                          # 루트: @ned/daemon 의 vitest 실행 (= pnpm --filter @ned/daemon test)
pnpm --filter @ned/daemon test:watch
```

- 위치: `test/*.test.ts`, 설정 `test/vitest.config.ts`, 공통 준비 `test/setup.ts`.
- 격리: `setup.ts` 가 **테스트 파일마다** 새 임시 `NED_HOME`(`$TMPDIR/ned-test-*`, 끝나면 삭제)을 만들고 `NED_NO_LLM=1`,
  `NED_SEND_DRY_RUN=1`, `NED_NOTIFY=app`(osascript 배너 없음), `NED_PORT=7791` 을 건다. `paths.ts` 가 import 시점에 `NED_HOME` 을
  읽으므로 파일 단위 격리(`isolate: true`, forks)가 필요하다. `claude` 는 절대 spawn 되지 않고 `~/.ned` 는 건드리지 않는다.
- **실제 `~/.ned` 보호(워커·개발 검증 공통)**: `VITEST`·`NODE_ENV=test`·`NED_NO_LLM=1` 중 하나라도 켜진 실행에서 `NED_HOME` 이 비어 있거나
  `~/.ned` 로 해석되면 `paths.ts` 가 import 즉시 throw 한다("refusing to use the real ~/.ned in a test/stub run"). vitest 는 항상
  `pnpm test`(또는 `--config test/vitest.config.ts`; `packages/daemon/vitest.config.ts` 가 같은 설정을 다시 내보내 맨 `vitest run` 도
  setup 을 탄다)로, 데몬 스모크는 `NED_HOME=$(mktemp -d) NED_PORT=779x NED_NO_LLM=1` 로 — 시작 전에 `echo $NED_HOME` 확인.
- HTTP 라우트(`test/server.test.ts`): `@hono/node-server` 의 `serve` 를 `vi.mock` 으로 바꿔 `startServer` 가 넘기는 Hono `fetch` 를
  받아 `Request` 를 직접 넣는다 — 포트를 열지 않는다.
- 다루는 것: sessions 상태 머신 · events(parseLines, lastAssistantText) · claude(extractJson, argv) · notify · config(loadConfig 병합,
  정규화, quiet hours) · agenda normalize*(calendar/mail/slack context, all⊇items, isEmptyPayload, signature) · heartbeat(sent 키
  dedupe, NED_NO_LLM 종단) · todos CRUD · search 점수 · drafts fast/full 결정 · `/api/send` 게이팅(403) 외 라우트.
- 알려진 버그는 `test/BUGS.md` 에 적고 `it.fails` 로 고정한다(버그가 고쳐지면 빨개진다 → `it` 으로 바꾼다).
- 순수 함수를 테스트하려고 `export` 만 붙인 것: `events.parseLines`, `agenda.normalize`, `heartbeat.sentKeys/markSent/keyOf`.

## Smoke test (LLM 호출 없이)

```sh
export NED_HOME=$(mktemp -d) NED_PORT=7797 NED_NO_LLM=1   # never ~/.ned or 7777 — paths.ts refuses ~/.ned with NED_NO_LLM=1
echo '{"hook_event_name":"Notification","session_id":"s1","cwd":"/x/wt","message":"needs permission"}' \
  | sh ../hook/ned-hook.sh                       # prints {} and appends to $NED_HOME/events/<today>.jsonl
node dist/cli.js state                            # sessions[0].status == "waiting"
node dist/cli.js run &  curl 127.0.0.1:$NED_PORT/api/state;  kill %1
```
