# @ned/daemon

Ned 의 코어 데몬. Claude Code 훅이 남긴 세션 이벤트를 집계하고, 주기적으로 `claude -p` 를 호출해
업무 신호(Gmail/Slack/Jira/Sentry/GitHub/Google Calendar, claude.ai 커넥터 경유)를 브리핑으로 정리하며,
menu bar 앱과 로컬 대시보드가 읽는 `state.json` 을 유지한다. 읽기 전용: 어떤 쓰기 액션도 하지 않는다 — 단 하나의 예외는
사용자가 켠 경우의 `POST /api/send` (아래 "답장 초안 · 보내기").

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

**메일·Slack 전체 목록**: agenda 출력의 `mail.all[]`(최근 2일 안 읽은 메일 전부 최대 50: id, from, subject, ts, url, unread)과
`slack.all[]`(최근 24h 나를 멘션·DM 한 것 전부 최대 50: channel, from, text, url, ts, reason, answered). Slack DM 은 같은 대화(permalink 의 채널 ID, 없으면 channel+보낸 사람)당 최신 1건만 남기고 답 안 한 개수를 `count` 에 — 프롬프트가 그렇게 만들고, 정규화(`collapseDMs`)와 대시보드가 한 번 더 묶는다. 멘션·스레드는 그대로. 선별(`items`)과 같은
검색 결과로 같은 턴에 만든다(`--max-turns 20`). 실측: 메일 35 · Slack 22, $1.97 / 258s.

**캘린더 범위**: agenda 잡은 캘린더를 오늘이 아니라 로컬 날짜 **어제 ~ +13일**(2주)로 받아 `agenda.json` 에
`calendar_range: {from, to}` 를 남긴다. 홈 인사말·"다음 미팅" 같은 오늘 기준 계산은 오늘 날짜로 걸러 쓴다.
그 밖의 날짜는 `GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`(최대 42일): `~/.ned/calendar/<from>_<to>.json` 캐시가
6시간 안이면 그대로, 아니면 캘린더 도구만 허용한 `claude -p`(`prompts/calendar.md`, maxTurns 6)로 받아 캐시한다. 같은 범위는
실행 하나를 공유하고 다른 범위는 줄 세워 하나씩. `NED_NO_LLM=1` 이면 빈 배열(캐시 안 함).

**페르소나** (`config.persona`: `ned` | `alfred` | `oracle` | `jarvis`, 기본 `ned`; 모르는 값은 PUT 에서 무시, 읽을 때 `ned`):
기능·데이터는 그대로 두고 말투 + 대시보드 테마 + 마크만 바꾼다. heartbeat.md · briefing.md · agenda.md 의 `{{PERSONA}}` 는
`prompts/personas/<id>.md`(이름, 말투 규칙 5줄, 헤드라인 예시 3개, NED_OK 멘트 예시 3개, 금지사항)로 치환된다. 상태값
`NED_OK` / `UPDATE` 와 JSON 키는 페르소나와 무관하게 그대로. `state.json.persona` 에 같은 값을 미러링한다(세션 갱신마다,
`PUT /api/config` 직후) — 대시보드와 메뉴바 앱이 이걸 읽는다. 캐릭터 이름만 표기하고 로고·실제 대사·이미지는 쓰지 않는다.

**트래킹 제외** (`config.filters`): `slack.exclude_channels`(채널명, `#` 없이) · `jira.exclude_projects`(프로젝트 키, 대문자 영숫자만 —
JQL 에 그대로 들어가므로 그 밖의 값은 버린다). heartbeat.md · briefing.md · agenda.md 의 `{{FILTERS}}` 가
`제외 채널: #a, #b / 제외 Jira 프로젝트: KEY1, KEY2 — 이들에 속한 항목은 조회·보고하지 말 것` + Jira JQL 에 넣을
`AND project NOT IN (...)` + Slack 결과에서 버리라는 지시로 바뀐다(비면 `(없음)`). agenda 는 JQL 에 그 절을 직접 넣고
(`{{JQL_EXCLUDE}}`), 정규화 단계에서 제외 프로젝트 이슈·제외 채널 Slack 항목을 한 번 더 걸러낸다. `PUT /api/config` 는
`filters` 를 소스별로 깊게 머지한다 (`filters.slack` 만 보내도 `filters.jira` 유지). API 라우트는 config.yaml 을 매번 새로 읽는다.

**Agenda 잡** (`src/agenda.ts`, `prompts/agenda.md`): 대시보드 HOME 탭용 구조화 데이터. 시작 직후 1회,
이후 `agenda_refresh_minutes`(기본 60) 마다, 그리고 `POST /api/agenda/refresh` 때 `claude -p` 를 돌린다.
허용 도구는 `ToolSearch`, Calendar `list_events`/`search_events`, Jira `searchJiraIssuesUsingJql`,
`Bash(gh search prs:*)`/`Bash(gh pr list:*)`/`Bash(gh api:*)`, Gmail `search_threads`, Slack `slack_search_public_and_private`/`slack_read_thread` 뿐이고 `--max-turns 16`. `sources.*` 가 꺼진 블록은
조회하지 않고 `[]` (mail·slack 은 `null`). 동시에 여러 번 요청돼도 실행 중인 한 번을 공유한다 (busy guard). 모델 출력이 깨지면
이전 목록을 유지하고 `error` 를 채운다. `NED_NO_LLM=1` 이면 claude 없이 빈 agenda 를 쓴다.

### HTTP API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/state` | `state.json` (sessions, attention, last_briefing, …) |
| GET | `/api/events?days=2` | 최근 N일의 훅 이벤트 (오래된 것부터) |
| GET | `/api/briefings?limit=30` | 브리핑 히스토리 (최신 먼저) |
| GET / PUT | `/api/config` | `config.yaml` 조회 / 부분 갱신 |
| POST | `/api/heartbeat?daily=1` | heartbeat 강제 실행 |
| POST | `/api/attention/:id/dismiss` | attention 항목 제거. 세션 항목은 `dismissed.json` 에 기억돼 같은 알림으로는 다시 안 뜬다 |
| GET | `/api/agenda` | `agenda.json` (+ `busy`). 없으면 빈 배열과 `updated_at: 0` |
| POST | `/api/agenda/refresh` | agenda 잡 실행 후 새 payload 반환 (실행 중이면 그 결과를 기다려 반환) |
| GET | `/api/todos` | 개인 할 일 목록 |
| POST | `/api/todos` | `{title, due?, note?}` → 생성된 항목 (201). title 이 비면 400 |
| PATCH | `/api/todos/:id` | `{title?, done?, due?, note?}` 부분 갱신. 없으면 404 |
| DELETE | `/api/todos/:id` | 삭제. 없으면 404 |
| POST | `/api/draft` | 답장 초안 3개 (Slack / 메일 / 에이전트 세션). 읽기 전용 `claude -p`. 아래 참고 |
| POST | `/api/send` | 초안 보내기 — `config.actions` 로 켠 것만. 꺼져 있으면 403 |
| GET | `/api/actions` | `sent-actions.log` 최근 50건 (최신 먼저) |

Agenda 응답 형태:

```json
{
  "updated_at": 0, "cost_usd": 0, "error": "(실패 시에만)",
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
- mail: `unread` 는 최근 2일 안 읽은 받은편지함 스레드 수(최대 50, 50 에 닿으면 `unread_capped: true` → 홈은 "50+통"), `items` 는 최근 3일 중 사람이 보낸 업무 메일로 내 행동이 필요한 것(최대 10, 급한 순). 본문은 열지 않고 검색 결과의 발신자·제목·스니펫만 본다. 읽음 처리 등 쓰기는 하지 않는다. `mail: null` 은 아직 안 가져옴(mail 도입 전 agenda.json) 또는 gmail 소스 꺼짐. `GET /api/agenda`·`POST /api/agenda/refresh` 응답에는 `mail_enabled`(= `sources.gmail`)가 붙고, false 면 홈은 메일 묶음을 숨긴다
- slack: 최근 24시간, 나를 멘션했거나 DM/스레드에서 질문·요청했고 내가 아직 답하지 않은 것(최대 10, 급한 순). 검색 3번(멘션 `<@me>` / `is:dm` / `is:thread with:<@me>`)과 필요할 때만 `slack_read_thread` 최대 3개. Slack epoch ts 는 ISO 로 바꾼다. 응답에는 `slack_enabled`(= `sources.slack`)가 붙고, false 면 홈은 Slack 카드를 숨긴다

### 답장 초안 · 보내기 (`src/drafts.ts`, `src/actions.ts`, `prompts/draft.md`)

**초안** `POST /api/draft`

```jsonc
// 요청
{ "source": "slack" | "email" | "session",
  "ref": { "url?": "", "channel?": "C…", "ts?": "", "thread_ts?": "", "thread_id?": "", "message_id?": "", "session_id?": "", "title?": "", "text?": "" },
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
- `claude -p` 는 plan 모드 + `--tools ToolSearch` + 소스별 읽기 도구만: slack `slack_read_thread`/`slack_read_channel`, email
  `get_thread`/`search_threads`, session 은 도구 없음(`--tools ""`) — `~/.ned/events` 에서 그 세션의 `transcript_path` 를 찾아
  최근 user/assistant 텍스트 12개(최대 6000자)와 마지막 Notification/Stop 을 프롬프트에 넣는다. `--max-turns 8`.
- 초안은 **사용자 본인 목소리**: `{{PERSONA}}` 를 쓰지 않고 `tone` → `config.reply_tone`(기본 `간결하고 정중한 존댓말, 핵심 먼저`)을 따른다.
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

- email 은 `message_id` 가 필요하다(ref 또는 `draft_id` 의 meta). 없으면 400 — 보내기 단계에서는 읽기 도구를 허용하지 않는다.
- 텍스트는 JSON 문자열로 프롬프트에 넣고 "글자 하나 바꾸지 말고 그대로, 도구 한 번만" 지시. 최대 4000자.
- 모든 시도(거절·실패·dry-run 포함)는 `~/.ned/sent-actions.log` 에 JSONL 한 줄:
  `{ts, source, mode, action, ref, draft_id, text(앞 120자), ok, result, claude_args?}` — `claude_args` 는 실제 spawn 한 argv.
- `NED_NO_LLM=1` 또는 `NED_SEND_DRY_RUN=1` 이면 Slack/Gmail 은 argv 와 프롬프트를 로그에 남기고 실행하지 않는다
  (`ok:false`, `action: "dry_run:…"`). 세션 보내기는 로컬이라 그대로 실행한다.

Todo 항목: `{id, title, done, created_at, done_at|null, due|null, note|null}` (ms 타임스탬프).

## Environment variables

| 변수 | 기본 | 설명 |
|---|---|---|
| `NED_HOME` | `~/.ned` | 데이터 루트. 테스트 시 `/tmp/ned-test` 같은 경로로 격리 |
| `NED_PORT` | (unset) | 설정 시 `config.yaml` 의 `port` 대신 이 포트로 listen (저장되지 않음). Ned.app 이 띄울 때 넘기고, 테스트 격리에 쓴다 |
| `NED_NO_LLM` | (unset) | `1` 이면 heartbeat 가 `claude -p` 를 호출하지 않고 `NED_OK` 를 기록하며, agenda 잡은 빈 agenda 를 쓴다 (비용 0, 테스트용) |
| `NED_NO_LLM_RESULT` | (unset) | `NED_NO_LLM=1` 일 때 heartbeat 가 받을 브리핑 JSON (예: `{"status":"UPDATE","headline":"…","action_items":[…]}`). UPDATE 경로 테스트용 |
| `NED_SEND_DRY_RUN` | (unset) | `1` 이면 `POST /api/send` 의 Slack/Gmail 액션이 `claude` argv·프롬프트만 로그에 남기고 실행하지 않는다 |
| `NED_NOTIFY` | (unset) | Ned.app 이 데몬을 띄울 때 `app` 으로 설정한다. `config.notify: auto` 이면 이때 osascript 배너를 띄우지 않는다 (알림은 Ned.app 이 `state.json` 을 보고 직접 보낸다) |
| `NED_CHILD` | — | 데몬이 띄운 `claude -p` 자식에 `1` 로 설정됨 (훅이 자기 자신을 관찰하지 않도록 쓸 수 있음) |

`claude` 바이너리는 `PATH` 에서 찾는다. 보통은 Ned.app 이 데몬을 자식 프로세스로 띄우며 `node`/`claude` 위치를 로그인 셸에서 찾아 `PATH` 에 넣는다 (`apps/menubar/README.md`).

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
                         persona (ned|alfred|oracle|jarvis), filters.{slack.exclude_channels, jira.exclude_projects} (트래킹 제외, 기본 []),
                         port, claude_model, claude_max_turns, session_stale_minutes, agenda_refresh_minutes, notify,
                         actions.{slack_send=false, gmail_draft=true, gmail_send=false, session_send=true} (POST /api/send 허용),
                         reply_tone (답장 초안 말투, 기본 "간결하고 정중한 존댓말, 핵심 먼저")
  state.json             menu bar / 대시보드가 읽는 단일 뷰 (sessions, attention, last_briefing, quiet …)
  cursor.json            heartbeat 가 처리한 마지막 이벤트 ts
  events/YYYY-MM-DD.jsonl  훅(packages/hook/ned-hook.sh)이 append 하는 이벤트. 로컬 날짜 기준
  briefings/<iso-ts>.json  heartbeat / daily 브리핑 결과 (status, action_items, updates, fyi, sessions, cost_usd)
  briefings/sent.log     이미 알린 항목 키 (title 또는 url) — 중복 억제
  agenda.json            HOME 탭 agenda: {updated_at, cost_usd, error?, calendar, jira, github, mail, slack}
  drafts/<id>.json       답장 초안 캐시 (1시간): {id, source, context, drafts, cost_usd, created_at, hint, tone, meta}
  sent-actions.log       POST /api/send 시도 기록 JSONL (거절·실패 포함)
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

## Smoke test (LLM 호출 없이)

```sh
export NED_HOME=/tmp/ned-test NED_NO_LLM=1
echo '{"hook_event_name":"Notification","session_id":"s1","cwd":"/x/wt","message":"needs permission"}' \
  | sh ../hook/ned-hook.sh                       # prints {} and appends to $NED_HOME/events/<today>.jsonl
node dist/cli.js state                            # sessions[0].status == "waiting"
node dist/cli.js run &  curl 127.0.0.1:7777/api/state;  kill %1
```
