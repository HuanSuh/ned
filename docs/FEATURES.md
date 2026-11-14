# Ned 기능 가이드

> 코드 기준 사용자 가이드. 맨 위 "요약"(≤2,500자)은 Ned 대화창(Ned Net) 시스템 프롬프트에 그대로 들어간다(`packages/daemon/src/chat.ts`).
> 기능을 추가/변경하면 아래 해당 항목과 **요약을 같이** 고친다. 설정 키는 `~/.ned/config.yaml` 기준 점 표기.

## 요약

Ned = 에이전트 세션·업무 신호(Slack·메일·캘린더·Jira·GitHub·Sentry)를 모으는 로컬 대시보드(탭: 홈·인박스·타임라인·설정). 전역 키: h 홈, i 인박스, r 지금 점검, ⌘K·/ 검색, ⌘J 통신기.
- **홈**: 일정(일/주, ＋·드래그로 만들기, ⋯ 응답), 할 일(NED 액션·개인, n 입력), 소스 카드(메일·Jira·Slack·GitHub — `확인 필요 | 전체`, 이력 7/30일, ↻ 소스별 갱신), 팔로업 카드(멘션 없는 채널 요약).
- **인박스**: 우선·기타·기록(브리핑) 3탭 + "장비실"(세션 상태).
- **타임라인**: 이벤트·브리핑 시간순
- **순찰/브리핑**: "지금 점검"(r) = 소스 갱신 → 판단 → 알림. 자동 순찰 `heartbeat_minutes`(무변경이면 건너뜀 `heartbeat_skip_unchanged`), 아침 브리핑 `briefing_time`(실패 시 재시도).
- **맡긴 일**(`responsibilities`, ≤5, 설정 → 맡긴 일): 책임마다 순찰이 순조·주의·막힘 + 한 줄 평가 → 홈 위 띠. 막혀서 내 몫이면 할 일에도.
- **야간·유휴 감속**: 조용한 시간·유휴(`idle_schedule`)엔 자동 실행 감속·정지(`quiet_schedule.mode` normal/slow/pause), 수동은 즉시.
- **통신기 "Ned Net"**(⌘J): "대화" 탭 = 질문(읽기 전용; `actions.chat_write` 면 쓰기 확인 카드, `actions.chat_session_create` 면 새 세션; 정리는 노트로), "메시지" 탭 = 새 알림·브리핑·새 Slack 답글.
- **답장 초안 ✎**: 초안 3개 → 복사/열기/보내기(Slack·메일·Jira 는 미답 질문별 1:1 답). 쓰기는 켠 것만(`actions.*` — gmail_draft·session_send 기본 켬, Jira·GitHub·캘린더는 ⋯). **세션에 답하기**: 대기 세션 행·펫 말풍선의 빠른 답(`dashboard.session_quick_replies`)·한 줄 입력 → Orca 터미널.
- **확인 완료 ✓**: 접음(새 변경 시 다시 열림). Slack 은 내 답글·해제 이모지(`filters.slack.ack_reactions`)면 자동 해제.
- **Gmail 읽음 표시**(`actions.gmail_mark_read`): 메일 ✓ = Gmail 읽음.
- **검색**: ⌘K
- **아카이브(Obsidian)**: 볼트 `archive.vault` + `archive.enabled` → 매일 `<archive.folder>/Daily/…/날짜.md`, `archive.daily_embed`.
- **수집 이력**: 소스별 보관(`history.keep_days.*`), 증분 수집(Slack 재검색 창 `history.collect.slack_hours`), 표시 구간(`history.display.*`).
- **링크 열기**: Slack·Figma·Notion 링크는 앱으로(`dashboard.open_links_in_app`, Slack 은 팀 ID `dashboard.slack_team_id`).
- **설치**: 플러그인 `ned@ned`→`/ned:install`(업데이트 `/plugin update ned`→`/reload-plugins`→`/ned:install`), MCP `/mcp`(도구 `ned_attention` 등).
- **Ned.app 메뉴**: 상태·대시보드·설정·업데이트·종료. 앱 설정·`updates.*`: 설정 → 앱.
- **시작하기**: 커넥터·Slack 팀 ID·자동 실행·코드 서명 점검.
- **데스크톱 펫**(외형 `pet.enabled`, 끔): 늘 떠 있는 Ned, 테두리 색 = 상태, 새 소식 말풍선(`pet.messages.*`).
- **설정**(하단 "저장"): 외형(테마 `dashboard.theme`, 카드 배치·잠금 `dashboard.locked`, 팔로업 별도 카드 `dashboard.watch_cards`, 링크 열기) · 소스(`sources.*`, Slack 팔로업·제외 채널·해제 이모지·그룹 멘션 `filters.slack.*`, Jira 제외 `filters.jira.exclude_projects`) · 알림(`notifications.*`, 조용한 시간 `quiet_hours`) · 순찰 주기(위 순찰·감속 키, `signal_check_minutes`, `agenda_refresh_minutes`, `agenda_source_minutes.*`) · 쓰기 액션(`actions.*`, 말투 `reply_tone`·`reply_tone_by_source.*`, 오늘 한 액션) · 수집·보관(`history.*`) · 아카이브(`archive.*`) · Claude(`claude_model`, `claude_max_turns`, 하루 상한 `agenda_daily_budget_usd`).

## 상세

각 항목: **보여 주는 것 / 데이터 / 언제 / 버튼·단축키·설정 키**.

### 공통 — 헤더·탭·갱신
- 보여 주는 것: 탭 홈·인박스·타임라인·설정, 데몬 생존·마지막/다음 점검·조용한 시간 배지, "지금 점검"·"아침 브리핑" 버튼, "🔍 검색 ⌘K".
- 데이터: `GET /api/state`(10초 폴링), agenda·할 일 60초 폴링(갱신 중엔 3초).
- 언제: 대시보드 첫 화면. 상태 이상(데몬 꺼짐 등)을 헤더에서 먼저 확인.
- 키: h 홈 · i 인박스 · r 지금 점검 · ⌘K 또는 / 검색 · ⌘J 통신기 (입력 중엔 무시).

### 홈 — 일정 카드
- 보여 주는 것: 오늘/주간 타임라인(지금 선, 종일 일정, 겹침 나란히), "회의 N · 종일 N", RSVP 칩(응답 필요/미정/거절/주최), "진행 중"·"N분 후", 장소·Meet 링크.
- 데이터: agenda.json `calendar`(어제~+13일). 그 밖의 날짜는 `GET /api/calendar` → `~/.ned/calendar/` 캐시(6시간).
- 언제: 오늘 회의 흐름·응답 안 한 초대 확인, 빈 시간에 일정 잡기.
- 버튼·키: 일/주, ◀ 오늘 ▶ (카드 포커스 시 ←/→, t 오늘, d/w 일/주). ⋯ → 수락/미정/거절(`actions.calendar_rsvp`, 주최 일정엔 없음). "이력" = 지난 7일/30일 동안 본 일정 목록(아래 "수집 이력").

### 홈 — 일정 만들기
- 보여 주는 것: "새 일정" 모달 — 제목·날짜·시작/끝·종일·장소·설명·참석자 이메일·"Google Meet 링크 추가"·캘린더(기본 primary).
- 데이터: Google Calendar 커넥터로 생성(`src/calendar-create.ts`), 결과는 `~/.ned/sent-actions.log`.
- 언제: 대시보드에서 바로 일정을 잡고 싶을 때.
- 버튼·키: 일정 카드 헤더 ＋, 주간 그리드 드래그(15분 단위), 빈 칸 클릭. "만들기 ⌘⏎" → 확인 → 생성, Esc 취소. 설정 키 `actions.calendar_create`(기본 꺼짐).

### 홈 — 할 일 카드
- 보여 주는 것: "NED 액션 아이템"(Ned 가 뽑은 확인 필요 항목, 확인 완료는 "확인 완료 N" 접힘) + "개인 할 일"(마감일, 완료는 "완료 N" 접힘). 소스 pill 필터.
- 데이터: `state.json` attention, `~/.ned/todos.json`(완료 7일 뒤 정리).
- 언제: 오늘 처리할 것 한 곳에서 보기, 내 메모성 할 일 관리.
- 버튼·키: n 입력 포커스, "할 일 추가… (⏎)", 체크=완료, ✕=삭제.
- 레이아웃: 위 = 확인 필요 그룹(스크롤), 아래 = 개인 할 일(입력폼 고정, 목록 스크롤, 최소 ≈180px — 항목이 적으면 내용만큼). 기본 60/40, 개인 할 일이 짧으면 남는 높이는 위로. 사이 구분선 드래그(↑↓ 키도)로 비율 조절·브라우저에 저장(`ned.todo.split`), 더블클릭 = 기본값. "개인 할 일" 헤더 클릭 = 접기/펼치기(`ned.todo.meFold`, 접히면 위가 전부; n·검색 이동 시 자동 펼침). 좁은 화면(<1100px, 자유 배치 아님)은 구분선 없이 자연 높이.

### 홈 — 소스 카드 (메일·Jira·Slack·GitHub)
- 보여 주는 것: 📬 메일 확인 필요(결재/마감/답장/확인, 안 읽은 N) · 📋 Jira 내 이슈(마감 지난/오늘/진행 중) · 💬 Slack 답할 것(DM/멘션/스레드/그룹, 답 필요/답함/새 답글) · 🐙 GitHub 리뷰 요청(리뷰 요청/변경 요청/승인됨). 접힘/펼침, 메일·Slack 은 `확인 필요 | 전체`(전체 = 표시 구간 — 메일 `history.display.mail_days`·Slack `history.display.slack_hours` — 의 스레드·멘션·DM; Slack 확인 필요는 기간 무관 — 답 안 한 요청은 답·해제 이모지·✓ 까지 남음).
- 데이터: agenda.json — 소스별 `claude -p`(커넥터 읽기) 또는 GitHub 는 `gh search prs`. 소스별 주기마다 자동, 답장 맥락은 백그라운드 수집("맥락 수집 N/M"). Slack 스레드·DM 의 최근 대화는 갱신마다 다시 읽되, 마지막으로 읽은 뒤 새 메시지가 안 보이면 건너뜀(6시간마다 한 번은 재확인).
- 언제: 답할 메시지·리뷰·마감 이슈를 소스별로 훑을 때.
- 버튼·설정: 카드 ↻(그 소스만 지금 갱신), ⚠ 오류 배지, 항목 ✎ 초안·열기·✓ 확인. **이력 `표시 구간 | 지난 7일 | 30일`**(메일·Slack 은 전체 보기 위, Jira·GitHub 은 목록 아래): 표시 구간 밖까지 Ned 가 모은 항목을 날짜 구분선과 함께 최신순(최대 200, 지금 카드에 있는 건 "지금", 상태 칩 답함/답 필요/안 읽음/목록에서 빠짐), 카드별 기억(`ned.cardhist.<카드>`). 이력 행에도 Slack·메일은 ✎ 초안 + ✓ 확인(카드와 같은 확인 키·같은 다시 열림 판정이라 어느 쪽에서 눌러도 같이 바뀜 — 아래 "확인 완료 ✓"; 아직 답이 필요한 행은 진하게, 나머지 ✎ 는 흐리게·마우스를 올리면 보임), Jira·GitHub·캘린더는 ⋯ 메뉴. `sources.*`, `agenda_source_minutes.*`, `dashboard.card_order`/`card_span`, `agenda_all_limit`.

### 홈 — 팔로업 채널 카드
- 보여 주는 것: 멘션이 없어도 따라가는 Slack 채널마다 24시간 요약 + 하이라이트. 나를 향한 것은 "나한테" 칩으로 앞에, 할 일 카드 개수에도 포함. 없으면 "지난 24시간 눈에 띄는 대화 없음."
- 데이터: agenda.json `slack.watch`(수집 이력에서 표시 구간만큼 — 하이라이트·최근 메시지, 새 메시지가 없으면 이전 요약 유지). 펼친 카드 아래 이력 `지난 7일 | 30일` = 그 채널에서 모은 메시지(`/api/history?channel=`).
- 언제: 내가 태그되진 않지만 결정·공지를 놓치면 안 되는 채널.
- 버튼: 모든 하이라이트·"최근 대화" 행에 ✎ 초안("나한테" 행은 진하게, 나머지는 흐리게·마우스를 올리면 보임), 요약 줄 끝에도 ✎ — 그 줄이 가리키는 메시지가 하나면 그 메시지로, 여럿이면 초안 팝업이 먼저 후보(보낸 사람·내용)를 보여 주고 고른 것으로, 없으면 그 채널의 가장 최근 메시지로("가장 최근 메시지 기준" 안내). 팔로업에서 만든 초안은 늘 그 메시지의 스레드 답글로 보냄. 별도 카드든 Slack 카드 안 접힘이든 같은 행·버튼, ✓ 도 Slack 카드와 같은 키(✓ 뒤 그 스레드에 새 답글이 오면 다시 열림).
- 설정: 설정 → 소스 → Slack → "팔로업 채널"(`filters.slack.watch_channels`, 최대 20). 별도 카드 대신 Slack 카드 안 "채널 팔로업 N" 으로 접으려면 설정 → 외형 → "팔로업 채널을 별도 카드로" 끄기(`dashboard.watch_cards`).

### 홈 — 배치
- 보여 주는 것: 일정·카드·할 일 패널의 자유 배치(12열 그리드).
- 언제: 화면 구성을 바꾸고 싶을 때.
- 버튼·키: 패널 헤더 ⠿ 드래그·가장자리 크기 조절, 그립에서 화살표 이동·Shift+화살표 크기·⏎ 저장·Esc 취소. 잠금 버튼 / 설정 → 외형 "홈 배치 잠금"(`dashboard.locked`), "배치 초기화".

### 외형 — 테마
- 보여 주는 것: 대시보드 색 테마 🖥️시스템(macOS 라이트/다크를 따라감) / ☀️라이트 / 🌙다크.
- 데이터: config.yaml `dashboard.theme`(기본 system). 고르면 바로 미리보기, "저장" 해야 유지.
- 언제: 대시보드만 OS 와 다른 밝기로 쓰고 싶을 때.
- 설정: 설정 → 외형 → 테마 → `dashboard.theme`(system|light|dark).

### 링크 열기 — 앱 딥링크
- 보여 주는 것: 대시보드의 Slack·Figma·Notion 링크(카드·이력 행·인박스·통신기 답·확인 카드 "열기"·초안 "열기"·검색 ⏎·인박스 ⏎·통신기 메시지)를 누르면 브라우저 대신 설치된 앱에서 바로 열림 — 크롬에 "앱에서 열기" 중간 탭이 남지 않음. 그 밖의 링크는 지금처럼 기본 브라우저.
- 변환 규칙(`src/links.ts` 원본 = `public/app/features/links.js` 복제, 새 서비스는 규칙 하나 추가):

  | 서비스 | 웹 URL | 앱 링크 |
  |---|---|---|
  | Slack | `https://<ws>.slack.com/archives/<C·D·G…>/p<ts>[?thread_ts=…]` | `slack://channel?team=<팀 ID>&id=<채널>&message=<ts>[&thread_ts=…]` (스레드 답글은 스레드로) — 팀 ID 없으면 웹 그대로 |
  | Figma | `https://(www.)figma.com/(design·file·board·proto)/<key>…[?node-id=…]` | `figma://` + 같은 경로·쿼리 (그 밖의 figma.com 경로는 웹) |
  | Notion | `https://(www.)notion.so/<…페이지 id…>[?…][#블록]` (id = 32자리 또는 8-4-4-4-12, `notion.com` 도) | `notion://www.notion.so/<같은 경로·쿼리·#블록>` — `*.notion.site`(공개 사이트)는 내 워크스페이스 페이지가 아닐 수 있어 웹 그대로 |

- 여는 방식: 링크(앵커)는 그대로 웹 URL·새 탭이라 마우스를 올리면 주소가 보이고 복사·우클릭도 같음. 일반 왼쪽 클릭만 가로챔 — ⌘/Ctrl/⇧/⌥-클릭·가운데 클릭·검색 ⌘⏎ 는 늘 웹. Ned.app 창이면 앱으로 넘기고, 그 서비스 앱이 설치돼 있지 않거나 열기에 실패하면 웹 URL 을 기본 브라우저로(앱 로그에 `open link: …` 한 줄). 앱 딥링크는 Ned.app 창에서만 — 브라우저로 연 대시보드(`http://127.0.0.1:7777`)는 늘 웹 URL 을 새 탭으로.
- 설정: 설정 → 외형 → "링크를 앱으로 열기" `dashboard.open_links_in_app`(기본 켬) · 서비스별 `dashboard.open_links_in_app_by_service.slack`·`dashboard.open_links_in_app_by_service.figma`·`dashboard.open_links_in_app_by_service.notion`(기본 모두 켬, 끄면 그 서비스는 웹) · "Slack 팀 ID" `dashboard.slack_team_id`(`T…` 대문자·숫자 7자 이상만, 기본 "" — 비우면 Slack 링크는 웹, 잘못된 값은 저장 안 됨) · "Slack 워크스페이스 주소" `dashboard.slack_team_domain`(`<이름>.slack.com` 의 `<이름>`, 영문 소문자·숫자·-, 기본 "" — 넣으면 `<이름>.slack.com`·`<이름>.enterprise.slack.com` 링크만 앱으로, 다른 워크스페이스 링크는 웹(내 팀 ID 로 열면 "채널 없음"이 되므로). 비우면 모든 `*.slack.com` 을 변환 — 워크스페이스 하나만 쓰면 비워 둬도 됨. `acme.slack.com`·`https://…` 로 넣어도 `acme` 로 저장).
- Slack 팀 ID 찾기: Slack 앱 → 왼쪽 위 워크스페이스 이름 → 워크스페이스 설정(브라우저에 열리는 주소의 `T…`) 또는 about 화면의 `T…`. Ned 는 Slack 토큰이 없고 수집 데이터에도 팀 ID 가 없어 자동으로 알아내지 못함 — 직접 입력.

### 인박스
- 보여 주는 것: "우선"(확인 필요 attention) · "기타"(브리핑의 업데이트/참고) · "기록"(브리핑 목록, 연속 NED_OK 는 "이상 무" 로 묶음). 상세: 행동 필요/업데이트/참고/세션/메타.
- 데이터: `state.json` attention, `~/.ned/briefings/`.
- 언제: Ned 가 판단한 "지금 봐야 할 것" 을 하나씩 처리할 때.
- 키·버튼: j/k(↓/↑) 이동, ⏎ 열기, e 닫기(처리 완료로 치우기), 1/2/3 탭, Esc 상세 닫기. ✎ 초안, ✓ 확인 완료, "← 목록".

### 에이전트 세션 — 장비실
- 보여 주는 것: 인박스 오른쪽 "장비실 · 세션" 패널 — 세션별 LED 상태(실행 중/입력 대기/완료/오류/종료), 워크트리, 서브에이전트 수, 마지막 요약, Ned 대화창에서 만든 세션이면 "대화창에서 시작" 배지(상세의 "출처"도) + "순찰 기록"(최근 8회). 없으면 "출동 중인 에이전트 없음."
- 데이터: Claude Code 훅 이벤트(`~/.ned/events/`) → `state.json` sessions. `session_stale_minutes`(기본 180) 동안 이벤트 없으면 사라짐.
- 언제: 여러 Claude 세션 중 입력을 기다리는 것·오류 난 것을 찾을 때.
- 버튼·설정: 세션 항목 ✎ 초안 → "세션에 보내기"(Orca 터미널로 전송, `actions.session_send` 기본 켬), "접기". 입력 대기 세션은 행 안에서 바로 답하고, 실행 중 세션은 ⋯ → "메시지 보내기"(아래 "세션에 답하기").

### 세션에 답하기 — 대기 세션에 Ned 에서 바로
- 보여 주는 것: 입력을 기다리는(waiting) 세션 행 — 인박스 장비실 · 휴대폰의 세션 서랍 · 인박스 "우선" 의 세션 상세 — 에 **빠른 버튼**(기본 `ㄱㄱ` · `승인` · `계속`) + **한 줄 입력**(⏎ 보내기, 한글 조합 중 ⏎ 는 글자 확정만, Shift+⏎ 는 아무 것도 안 함 — 한 줄). 행에는 세션이 마지막으로 남긴 것(Notification 본문·요약, 없으면 마지막 프롬프트)이 그대로 보여 무엇에 답하는지 알 수 있다. 보내는 동안 버튼·입력 비활성, 성공하면 토스트 "fb-74 에 보냄" + 행이 "보냄 — 응답 기다리는 중" 으로 바뀌고 그 세션의 다음 이벤트(보통 프롬프트 제출 → 실행 중)가 오면(최대 90초) 실제 상태로 돌아간다. 실행 중·완료 세션은 입력을 숨기고 행의 ⋯ → **"메시지 보내기"** 로 같은 입력(빠른 버튼 없음, 닫기·Esc)을 연다 — 실행 중 세션에 추가 지시.
- **데스크톱 펫**에서도: 세션 "입력 대기" 말풍선과 마우스를 올린 목록에 답하기 줄 — 헤더 "<워크트리> 에 답하기"(여러 세션이 기다리면 ‹ n/m ›, 기본은 가장 최근에 기다리기 시작한 세션), 빠른 버튼, "…" = 한 줄 입력(⏎ 보내기 · esc 닫기 · ⇧⇥/↑↓ 다른 세션). 입력·전송·결과 중엔 말풍선이 저절로 접히지 않고, 결과 한 줄("보냄 ✓" / 실패 사유)을 2.5초 보여 준 뒤 평소 흐름으로. 입력하는 동안만 펫 패널이 키보드를 받는다(비활성 패널이라 보통 앞 앱은 그대로; 안 되면 그때만 Ned 를 활성화). 입력을 닫으면(⏎ 보냄·esc) 열 때 앞에 있던 앱으로 키보드를 돌려준다. 입력 중 다른 앱을 누르거나 펫을 숨기거나 세션 보내기를 끄면 입력은 닫히고 쓰던 글은 다음 "…" 에 남는다. 펫은 Orca 워커 세션(`is_worker`)에는 답하기 줄을 띄우지 않는다(펫 상태 색과 같은 규칙 — 대시보드 장비실은 워커 행에도 답하기가 있음).
- 보낼 수 없을 때: 세션이 Orca 터미널에서 실행된 기록이 없으면(`can_reply` false — 훅 이벤트에 Orca pane 이 없음) 입력 대신 "터미널에서 직접 입력" 안내만. 기록은 있는데 그 터미널이 지금 닫혀 있으면 보낼 때 409 → "터미널이 닫혀 있어 보낼 수 없음 — 터미널에서 직접 입력"(입력한 글은 남음). 그 밖의 실패는 데몬이 준 사유 그대로. `actions.session_send` 를 끄면 답하기 UI 가 사라진다.
- **권한·선택 대화상자**: 세션이 권한 프롬프트(`notification_type` permission_prompt)나 MCP 입력 대화상자(elicitation_dialog)로 기다리면 대시보드·펫 모두 빠른 버튼·입력 대신 "권한·선택 대화상자 — 터미널에서 직접 선택 (Enter = 강조된 항목, Esc = 거절)" 안내만. 그 화면에선 보낸 글자는 무시되고 Enter 가 강조된 항목(보통 "Yes")을 확정하기 때문 — "거절" 을 보내면 허용이 될 수 있다. 데몬도 이런 세션에는 `/api/send` 를 409 로 거절한다(초안 팝업·대화창 경로 포함). 숫자 키로 항목을 고르는 동작은 Claude Code 문서에 없어 "허용" 버튼도 두지 않았다.
- 알림 중복 방지: 답을 보내 성공하면 그 세션의 지금 "입력 대기" 알림(attention)을 바로 내린다(✕ 닫기와 같은 기록) — 대시보드·Ned.app 배너·펫이 같은 알림을 다시 띄우지 않는다. 세션이 다시 물으면(새 Notification) 평소처럼 다시 뜬다.
- 데이터: `POST /api/send {source:"session", mode:"session", ref:{session_id}, text, origin:"session"|"pet"}` → 202 + 폴링 → 세션의 Orca 터미널(훅 이벤트의 `orca_pane`/`orca_tab` → `orca terminal list` 에서 같은 pane)에 `orca terminal send --text … --enter`. 글은 2,000자까지, 앞뒤 공백·끝 줄바꿈은 지움(Enter 는 한 번). 대기 아닌 세션에도 보낼 수 있다. 모든 시도는 `~/.ned/sent-actions.log` → 설정 → 쓰기 액션 "오늘 한 액션"(출처 칩 "세션 행" / "펫").
- 설정: 설정 → 쓰기 액션 → "세션 빠른 답" `dashboard.session_quick_replies`(쉼표 구분, 5개까지 · 버튼마다 20자까지, 비우면 버튼 없이 입력만 — 넘으면 저장 안 함/400) · "세션에 보내기" `actions.session_send`(기본 켬).

### 대화창에서 세션 만들기
- 보여 주는 것: Ned Net "대화" 에서 일을 맡기면 Ned 가 ned-action `session_create` 로 새 에이전트 세션을 제안 → 확인 카드(대상 줄에 레포 · 워크트리 새로/기존 · 모델 opus/sonnet — 읽기 전용, 첫 프롬프트 **전문**만 편집 가능) → [실행] / [취소]. 실행 중엔 단계(워크트리 만드는 중 → 에이전트 기동 대기 → 첫 프롬프트 전송 → 제출 확인)와 경과 초, 실패하면 단계별 사유. 워크트리·터미널이 이미 생긴 뒤의 실패는 "다시 실행" 없이 끝냄(중복 생성 방지). 카드를 미리 볼 때 등록 레포·기존 워크트리·상한도 검사해 실행 전에 거절 사유를 보여 줌.
- 데이터: `POST /api/sessions/create`(백그라운드 작업, 202 + 폴링) → 새 워크트리면 `orca worktree create --agent claude --model <m>`, 기존이면 `orca agent launch` → Claude 가 뜰 때까지 화면 확인(최대 90초) → `orca terminal send --enter --wait-submit 15` 로 첫 프롬프트 → 입력창이 비고 첫 활동이 보이면 성공. 첫 프롬프트는 항상 "먼저 계획을 제시하고 승인받은 뒤 구현한다." 로 시작(없으면 Ned 가 붙임). 레포는 Orca 에 등록된 것만. 대화창에서 시작해 아직 살아 있는 세션은 **2개까지**(넘으면 거절 사유 표시). 만든 세션은 `~/.ned/chat-sessions.json` 에 기록 → 장비실 "대화창에서 시작" 배지. 모든 시도는 `~/.ned/sent-actions.log`(action `session_create`, origin chat — "오늘 한 액션" 에 "대화창 ·" 표시).
- 언제: 대화하다 "이거 세션 하나 띄워서 해줘" 할 때 — 터미널을 열지 않고 Ned 에서 바로 시작.
- 설정: 설정 → 쓰기 액션 → 세션 → "대화창에서 세션 만들기" `actions.chat_session_create`(기본 꺼짐) **그리고** 대화창 → "대화창에서 쓰기 허용" `actions.chat_write`. 둘 다 켜져 있어야 대화 프롬프트에 이 제안이 들어가고(Orca 등록 레포 목록 포함, 10분 캐시) 실행도 됨.

### 타임라인
- 보여 주는 것: 세션 이벤트(세션 시작/종료, 프롬프트, 서브에이전트 시작/종료, 알림, 응답 완료, 오류, 컨텍스트 압축)와 📝 브리핑(아침/점검)을 최신순(최대 300).
- 데이터: `GET /api/events?days=2` + 브리핑.
- 언제: 어떤 세션에서 언제 무엇이 일어났는지 되짚을 때.
- 버튼: "유형"·"워크트리" 칩 필터(전체), "새로 고침".

### 순찰·브리핑 (지금 점검)
- 보여 주는 것: Ned 의 판단 결과 — 알림 배너, 확인 필요(attention), 인박스 기록의 브리핑(NED_OK = 이상 무 / UPDATE).
- 데이터: 자동 순찰은 `heartbeat_minutes`(기본 10)마다, 신호 판단은 `signal_check_minutes`(기본 60)가 지났거나 세션 이벤트가 있을 때만 LLM 호출. agenda.json 재사용 + Sentry 직접 조회. 아침 브리핑은 `briefing_time`(기본 09:00) 뒤 첫 순찰, 하루 1회.
- 아침 브리핑 재시도: 자동 아침 브리핑은 **성공했을 때만** 그날 완료로 친다(Claude 실패·답 해석 실패는 브리핑 파일에 `ok: false` + raw 로 남고 인박스·타임라인·검색에 "아침 실패"로 표시, 아카이브 🌅·대화 맥락엔 안 들어감). 실패하면 10분 뒤 다시(최대 3회 = 총 4번), 다 실패하면 그날은 포기하고 `state.json` 에 `daily_failed_at` → 홈 한 줄 "오늘 아침 브리핑 실패 — '아침 브리핑'이나 '지금 점검'으로 다시"(성공한 아침 브리핑이 지움). 데몬을 다시 켜면 오늘 **성공한** 아침 브리핑 파일이 있을 때만 건너뛰고, 재시도 횟수는 0부터. 설정 키 없음.
- 오프라인·잠 깬 직후: 자동 실행(소스 갱신·순찰·아침 브리핑)은 Claude 를 띄우기 전에 `api.anthropic.com` DNS 조회(3초, 결과 30초 캐시)로 온라인인지 보고, 오프라인이면 그 틱을 통째로 건너뜀(로그 `offline — …`, 비용·소스 오류 없음, 재시도 횟수도 안 씀). 앞 틱과 3분 이상 벌어진 틱(맥이 잠들었다 깸)은 아무것도 안 돌리고 다음 틱에(로그 `wake: …`). 수동 실행(지금 점검·아침 브리핑·카드 ↻)은 확인 없이 늘 즉시.
- 무변경 건너뛰기(`heartbeat_skip_unchanged`, 기본 켬): 지난번 판단한 순찰 뒤로 소스 목록(서명)·2시간 안 일정·팔로우 스레드의 새 답글·세션 알림(응답 완료/오류/입력 대기)이 하나도 안 바뀌었으면 자동 순찰은 Claude 를 부르지 않고 다음 주기로 넘김(로그 `heartbeat: skipped — unchanged`). Sentry 가 켜져 있으면 3시간마다 한 번은 실제로 돔. 아침 브리핑·지금 점검·`/api/heartbeat` 는 늘 실행.
- 언제: 방금 들어온 것까지 반영해 판단받고 싶을 때 "지금 점검".
- 버튼·키·설정: 헤더 "지금 점검"(r, 데이터 갱신 중 → 판단 중, 1~2분), "아침 브리핑". 설정 → 순찰 주기. 하루 상한(`agenda_daily_budget_usd`) 도달 시 자동 실행만 멈춤.

### 맡긴 일 — 책임 단위로 순찰
- 보여 주는 것: 홈 인사 줄 아래 얇은 **"맡긴 일" 띠** — 켜 둔 책임마다 상태 점(초록 순조 `on_track` · 주황 주의 `watch` · 빨강 테두리 막힘 `blocked`, 회색 = 아직 평가 전) · 제목 · 순찰의 한 줄 평가(페르소나 말투) · 근거 링크(↗, 최대 3개 — 업무 목록에 있던 링크만, 앱 딥링크 규칙 그대로) · 평가 시각. 언제까지(`until`)가 지난 책임은 흐리게 "끝남". 켜 둔 책임이 없으면 띠가 없다(그리드 패널 아님).
- 데이터: 원본은 `config.yaml` `responsibilities`(최대 5개) — 항목마다 `responsibilities.title`(≤60자) · `responsibilities.goal`(챙길 것, ≤300자) · `responsibilities.sources`(볼 곳 slack/mail/jira/github/calendar/sessions, 생략 = 전부) · `responsibilities.keywords`(≤10, 업무 목록 매칭 힌트) · `responsibilities.until`(YYYY-MM-DD, 그날까지) · `responsibilities.enabled` · id(자동). 순찰(heartbeat)과 아침 브리핑이 켜진·안 끝난 책임을 프롬프트의 "맡긴 일" 절로 받아 같은 호출 안에서 평가(Claude 를 따로 부르지 않음 — 책임이 없으면 프롬프트·비용이 전과 같음). 책임이 있을 땐 이미 알린 업무 목록 항목도 빼지 않고 "[이미 알림]" 표시로 남겨(다시 알리지는 않음) 막힌 근거가 다음 순찰에도 보이게 하고, 새 근거가 없으면 지난 평가를 유지(순조로 덮지 않음). 결과는 `state.json` `responsibilities.<id> = {status, note, urls, updated_at}`(`GET /api/state`) — 이상 무(NED_OK)여도 저장, 답에서 빠진 책임은 이전 평가 유지, 모르는 id·잘못된 상태·그 회차 업무 목록에 없던 링크는 버림, 설정에서 지운 책임의 평가는 매 순찰 정리. 막혀서 사용자가 움직여야 하면 기존 할 일(액션 아이템)에도 `[책임 제목] …` 으로 올라감 — 새 알림 종류는 없음. 책임을 추가·수정하면 무변경 건너뛰기(`heartbeat_skip_unchanged`)도 다음 순찰을 돌린다.
- 언제: "이번 주 0.5 릴리스 막히는 것 챙기기", "고객 A 문의 후속" 처럼 소스를 가로지르는 일을 Ned 에게 맡길 때. 대화창에서 책임을 만드는 기능은 없음 — 설정에서.
- 버튼·키·설정: 설정 → 맡긴 일 — 목록, "＋ 맡긴 일 추가"(`c-resp-add`, 5개면 비활성), 행마다 켜기 · 제목 · 챙길 것 · 볼 곳 체크(다 켜거나 다 끄면 전부) · 키워드(쉼표) · 언제까지 · 삭제. 저장은 하단 "저장"(`PUT /api/config`, 제목 없는 행이 있으면 저장 안 함).

### 수집 이력 · 수집/표시 구간
- 보여 주는 것: 데몬이 소스 목록을 가져올 때마다 항목을 `~/.ned/history/<소스>.json` 에 key 기준으로 기록(같은 항목은 갱신) — Slack(permalink)·메일(스레드 id)·Jira(이슈 키)·GitHub(PR url)·캘린더(이벤트 id). 항목마다 처음 본 때·마지막 본 때와 상태(Slack 답함·해제 이모지·답 필요, 메일 안 읽음·행동 필요, Jira/GitHub 목록에 있음 `open` — 빠지면 false·다시 보이면 true, 캘린더 RSVP).
- 데이터: Claude 호출 없음 — 데몬이 씀(임시 파일 → rename). 하루 한 번 보관 기간이 지난 항목을 지움(마지막 정리 일자 `~/.ned/history/meta.json`), 그 폴더의 Ned 파일만. 파일이 깨졌으면 `<소스>.json.corrupt-<시각>` 으로 옮기고 빈 이력·전체 창 수집으로 다시 시작. 트래킹 제외 채널은 이력 목록·검색에도 안 나옴.
- 표시 구간: Slack·메일 카드, 순찰 프롬프트, 초안·대화 맥락이 보는 `agenda.json` 의 slack/mail 블록은 이번 목록이 아니라 **이력에서 표시 구간만큼 다시 조립**(Slack `history.display.slack_hours` 기본 24시간, 메일 `history.display.mail_days` 기본 3일). 확인 필요 = 답 안 함·해제 이모지 아님·✓ 확인 완료 아님(최대 10, 목록이 매긴 급한 순) — **Slack 은 기간 무관**: 답 안 한 요청은 표시 구간이 지나도 내 답글·해제 이모지·✓ 로 해제되거나 보관 기간(`history.keep_days.slack`)이 지나 지워질 때까지 남음(메일은 구간 안만). 전체 = 구간 안 전부(`agenda_all_limit`). DM 은 대화당 한 줄, 제외 채널은 뺌. 새 것이 없는 수집 뒤에도 카드는 그대로이고 "변화 없음"(무변경 순찰 건너뛰기·2단계 건너뛰기)은 이 조립 결과로 판단. 스레드·DM 을 2단계가 다시 읽다 내 답을 보면 바로 답함 처리(읽은 결과가 원글만 남았거나 같은 ts 가 겹치면 이전 상태를 유지하고, 마지막 답글이 1단계가 본 최신 ts 보다 이르면 그 ts 로 올려 "(답글 내용 미확인)" 으로 표시 — 둘 다 로그에 경고 1줄) — 구간 밖에 남은 요청의 스레드·DM 도 계속 다시 읽음(새 메시지 없으면 6시간마다). Jira·GitHub·캘린더 카드는 지금처럼 마지막 목록(이력엔 기록만).
- 수집 구간(증분): Slack·메일 목록은 매번 전체 창을 다시 읽지 않고 **지난 성공 수집 − 30분 이후**만 검색(Slack `after`, 메일 두 번째 검색 `after:날짜`). 첫 실행·이력 파일이 없을 때·마지막 전체 검색이 6시간 넘었을 때는 전체 창(Slack `history.collect.slack_hours` 기본 24시간, 메일 3일). 새 것이 없으면 모델은 빈 목록만 내고 끝(빈 결과 재시도도 안 함). 메일 안 읽음 수는 늘 최근 2일 전체. 증분 결과에 보인 **내 메시지**(`mine`)·내가 마지막으로 보낸 메일 스레드(`replied`)로 이전 항목을 답함 처리, 해제 이모지 검색은 기억하는 가장 오래된 열린 요청까지 거슬러 봄(최대 7일, 전체 재검색 때도 — 이번 결과 밖의 기억하는 항목도 해제). 7일보다 오래된 열린 요청은 ✓ 확인 완료나 내 답글(검색에 보인 내 메시지·2단계 스레드 재확인)로만 해제. ✓ 한 요청은 열린 요청으로 세지 않음(이모지 검색·스레드 재확인 대상 아님). 증분 결과가 비었거나 응답에 그 소스가 없으면(재시작 직후 커넥터 미연결 등) 다음 수집 기준 시각을 옮기지 않아 그 구간을 다시 봄. 이력 쓰기가 실패하면 그 회차는 가져온 목록을 그대로 보여 줌. 증분 간격(30분 겹침)·전체 재검색 주기(6시간)·메일 창은 상수.
- 이름·채널명: Slack 보낸 사람은 표시 이름 → 실명 → 사용자명 → 사용자 ID 순(Slack Connect 외부 사용자도 같게), 이번 수집에서 이름이 비거나 "알 수 없음"이면 이력에 있던 이름 유지. 채널명은 채널 ID 기준으로 하나로 — 그 채널에서 가장 많이 본 이름(설정의 팔로업·제외 채널 이름과 대소문자·`#` 만 다르면 설정 표기, 설정 이름이 과반이면 그것) > 이번 응답(실행마다 철자가 흔들려도 같은 이름, 한 번 잘못 쓴 이름으로 채널이 바뀌거나 숨지 않음).
- API: `GET /api/history?source=slack|mail|jira|github|calendar&days=7&q=&channel=`(최신순 최대 200, 표시 구간 안·열린 항목은 `current: true`) · `GET /api/history/status`(소스별 건수·일수·바이트, 마지막 수집·전체 재검색 시각, 다음 수집 창, 마지막 정리).
- 설정: 설정 → 수집·보관 — `history.enabled`(기본 켬 — 끄면 기록 안 함, 예전처럼 마지막 목록만) · 보관 기간 `history.keep_days.slack`·`history.keep_days.mail`(30)·`history.keep_days.jira`·`history.keep_days.github`·`history.keep_days.calendar`(90), 0~365일, 0 = 그 소스 기록 안 함. 표시 구간 `history.display.slack_hours`(24, 1~168)·`history.display.mail_days`(3, 1~14) — 보관이 표시보다 짧으면 표시에 맞춰 늘림. 수집 창 `history.collect.slack_hours`(24, 1~168) — Slack 전체 재검색이 거슬러 보는 시간(이력에 없던 지난 멘션을 한 번 다시 모을 때 잠깐 늘렸다 되돌림). 표시 구간보다 짧으면 표시 구간으로 맞추고(증분 수집의 하한이라 짧으면 꺼져 있던 동안이 빠짐), Slack 보관 기간도 수집 창(일) 이상으로 맞춤.

### 야간 모드 · 유휴 모드 (자동 작업 감속)
- 보여 주는 것: 조용한 시간이나 유휴 상태에서 자동 순찰·홈 소스 갱신(과 그 뒤 답장 맥락 수집)을 느리게(모든 주기 × 배수) 하거나 멈춤. 홈 상단 칩 "야간 모드 · 느리게 ×6 · 08:00 재개" / "유휴 모드 · 멈춤 · 활동 시 재개"(둘 다면 유휴 표시). 감속이 없으면 칩 없음.
- 데이터: 데몬 스케줄러(`src/scheduler.ts`, 1분 틱). 유휴 = (1) `idle_schedule.after_minutes` 동안 활동 없음(대시보드 사용 핑 `POST /api/activity`, Claude Code 세션 이벤트, Mac 키보드/마우스 입력 중 최신) **그리고** (2) 최근 `unchanged_runs` 번의 자동 갱신이 모두 변화 없음. 둘이 겹치면 더 느린 쪽(멈춤 > 큰 배수). 조용한 시간/유휴가 끝나면 전 소스를 한 번에 갱신한 뒤 순찰 1회(아침 브리핑이 새 목록을 읽도록).
- 언제: 밤·자리 비움 동안 Claude 비용과 호출을 줄이고 싶을 때. 수동 실행(지금 점검·아침 브리핑·카드 ↻)은 영향 없이 늘 즉시.
- 설정: 설정 → 순찰 주기 → "조용한 시간 동작": 평소대로/느리게 ×N/멈춤 → `quiet_schedule.mode`(normal|slow|pause, 기본 slow), `quiet_schedule.slow_factor`(2~24, 기본 6). 시간대는 설정 → 알림 → 조용한 시간(`quiet_hours`, 꺼져 있으면 이 칸은 흐려짐). "유휴 시 동작": 사용 `idle_schedule.enabled`(기본 켬) · N분 활동 없고 `idle_schedule.after_minutes`(10~1440, 120) · N회 연속 변화 없으면 `idle_schedule.unchanged_runs`(1~50, 6) · 느리게 ×N/멈춤 `idle_schedule.mode`(slow|pause, 기본 slow) · `idle_schedule.slow_factor`(2~24, 6).

### 통신기 — Ned Net
- 보여 주는 것: 모든 탭에 떠 있는 패널, 제목 "Ned Net"(태그 NED · NET; 페르소나를 바꾸면 이름도 바뀜). "대화" 탭 = Ned 에게 질문(Ned 가 아는 맥락 + 읽기 도구로 답, 쓰기 안 함), "메시지" 탭 = 열린 attention·최근 24h 업데이트 브리핑·"내 답 이후 새 답글 N건" Slack 스레드·닫혀 있던 동안 온 답(안 읽음 배지).
- 데이터: 대화 = 턴마다 `claude -p`(읽기 전용, 최대 12턴, 질문 2,000자), `~/.ned/chats/`(최근 20개). 비용은 "대화 $x · 오늘 $y".
- 언제: "오늘 뭐 남았어?", "이 PR 상태는?", "이 기능 어떻게 켜?" 같은 질문.
- 코드 블록: 답의 ``` 블록마다 우상단 복사 버튼(키보드 Enter/Space 가능) — 언어 표기 줄 빼고 원문만 복사, 1.5초 ✓.
- 키·버튼·설정: ⌘J(Ctrl+J) 열고 닫기, Esc 닫기, ⏎ 전송, ⇧⏎ 줄바꿈, "중단", "새 대화", ▾ 접기, 가장자리 크기 조절. 하루 상한 도달 시 대화도 막힘 — 예외는 config.yaml `chat_ignore_budget: true`.

### 통신기 — 대화창에서 쓰기 (확인 카드)
- 보여 주는 것: "Slack 에 이렇게 답해 줘", "이거 할 일에 넣어 줘" 같은 요청에 Ned 가 답 끝에 **실행 제안 카드**를 붙인다 — 요약, 대상(읽기 전용: 채널·메일·이슈·PR·일정·세션), 텍스트(편집 가능 — 할 일 제목·보낼 글·일정 제목·Jira 옮길 상태), [실행] [취소]. 실행하면 결과(✓ 실행됨 + 링크 / ⚠ 실패 → "다시 실행")가 카드에 남고, 취소하면 "취소됨"으로 접힌다. 한 카드는 한 번만 실행된다.
- 데이터: 모델은 여전히 읽기 도구만 쓰고 ```ned-action 블록으로 **제안만** 한다(시스템 프롬프트엔 지금 허용된 동작만 들어감). [실행] → `/api/chat/actions/validate` 가 스위치와 대상(최근 agenda/state 에 있는 항목인지 url·id 로)을 확인해 요청을 만들고, 기존 `/api/send` · `/api/calendar/events` · `/api/todos` 로 실행(`origin: "chat"`). 카드 상태는 `~/.ned/chats/` 의 그 답에 저장(`/api/chat/:id/action`). 기록은 `~/.ned/sent-actions.log` → 설정 → 오늘 한 액션에 "대화창" 배지.
- 언제: 대화하다가 그 자리에서 답장·할 일·일정·리뷰까지 끝내고 싶을 때. 대상은 바꿀 수 없어 — 다른 대상이면 대화로 다시 요청.
- 설정: 설정 → 쓰기 액션 → 대화창 → "대화창에서 쓰기 허용" `actions.chat_write`(기본 꺼짐). 각 동작은 자기 스위치도 켜져 있어야 함(할 일 추가는 chat_write 만): `todo_add` · `slack_send` · `gmail_draft` · `gmail_send` · `jira_comment` · `jira_transition` · `github_review` · `calendar_create` · `calendar_rsvp` · `session_send` · `session_create`(`actions.chat_session_create`, 아래 "대화창에서 세션 만들기").

### 통신기 — 정리 결과물 (노트 저장)
- 보여 주는 것: 대화창에서 "이 회의 정리해 줘", "이 문서 요약해서 남겨 줘", "오늘 메일 정리해 줘" 하면 Ned 가 짧은 요약으로 답하고 그 아래 **저장 카드** — "📎 회의 정리 저장됨 · 제목", 저장 위치(볼트 경로 / "Ned 에만 저장"), [Obsidian 에서 열기] [Finder 에서 보기], "내용 보기"(노트 전문). 답이 흐르는 동안은 "정리 결과 저장 준비 중…".
- 형식(모델이 지킴): 회의 = 한 줄 결론 → 결정 → 액션 아이템(담당·기한, 내 것 먼저) → 미결 → 출처 / 문서 = TL;DR 3줄 → 핵심 → 나에게 요구되는 것 → 리스크 → 출처 / 메일 = 답장 필요·승인·읽기만·보관 그룹(한 줄 + 발신자 + 링크). 액션 아이템은 `- [ ] 내용 #task 📅 YYYY-MM-DD` 라 Obsidian Tasks 에 바로 잡힘.
- 데이터: 모델이 답 끝에 ```ned-output 블록(JSON `kind`·`title`·`markdown`)을 붙이면 데몬이 꺼내 저장 — 추가 Claude 호출 없음. 항상 `~/.ned/outputs/`(목록 `/api/outputs`, 하나 `/api/outputs/:id`), 아카이브가 켜져 있고 "담을 것 → 정리 결과물"(`archive.include.outputs`)이면 볼트에도 `<archive.folder>/Notes/YYYY-MM/YYYY-MM-DD.<제목>.md`(frontmatter `date`·`kind`·`source` 링크·`tags: [ned, kind]`, 같은 이름이면 " (2)"). 그날 데일리 리포트 "📎 정리 결과물"에 링크. "Finder 에서 보기" = `/api/outputs/:id/reveal`.
- 언제: 회의록·긴 문서·메일 더미를 대화로 정리하고 기록으로 남기고 싶을 때.

### 답장 초안 ✎
- 보여 주는 것: 답할 대상 한 줄·발췌 + **"답할 것" 목록**(Slack·메일·Jira: 미답 질문·요청 `☐ 번호 누가 · 무엇 · (마감)` — 내 마지막 답글 전에 나왔는데 아직 답 안 된 것(예: "확인해 볼게요" 뒤)은 작은 "이전" 칩, 이미 답한 건 흐리게 `✓ 이미 답함`, 하나도 없으면 "답할 질문 없음 — 가벼운 확인 답") + 초안 3개(짧게/보통/정중하게), 편집 가능, "다시 생성"(힌트). Slack 전체 경로에서 상대가 2명 이상이고 누구에게 답할지 특정되면 "멘션 제안: 이름 (@U…)" 칩 + 토글(기본 꺼짐, 켜면 초안 첫머리에 `<@U…>` — 편집한 글에도 이미 있으면 다시 넣지 않음, 끄면 토글이 넣은 것만 뺌). 빠른 경로 발췌엔 사용자 ID 가 없어 멘션 제안이 나오지 않음.
- 어떻게 쓰나(2단계, Slack 스레드·채널 메시지·DM / Gmail 스레드 / Jira 코멘트): ① 추출 — 대화를 메시지 목록으로 옮기고 나에게 온 질문·요청과 이미 답했는지를 뽑음(빠른 경로는 모은 발췌로 도구 없이, 전체 경로는 커넥터로 직접 읽되 메시지 최대 25개·각 250자; Slack 은 내 user_id, 메일은 보낸편지(SENT), Jira 는 현재 사용자 코멘트로 내 메시지 구분; "확인해 볼게요" 같은 대기성 답글은 답으로 치지 않음). ② Ned 가 **내 마지막 답글**(팔로업 스레드면 Ned 가 기억하는 내 마지막 답글 시각도)을 기준으로 앞은 [맥락](참고만, 최근 20개·4,000자), 뒤는 [답할 대상]으로 나누고 이모지·`+1`·`ㅋㅋ` 류는 `(짧은 반응)` 으로 줄임. 답했는지는 추출 결과를 그대로 따르고, 내 답글 전에만 나온 미답 질문엔 "이전" 표시만 붙임. ③ 작성 — 미답 질문에 번호 순서대로 1:1 로 답하고 맥락은 재요약하지 않음. 미답이 없으면: 내 메시지가 마지막이면 후속 확인(독촉)·추가 공유, Jira 면 진행 상황 공유, 그 밖엔 짧은 확인형. 힌트가 있으면 힌트 우선. 실패 시: 추출 결과가 깨지면 예전 한 번짜리 초안으로 1회, 추출 실행 자체가 실패(타임아웃 등)하면 빠른 경로는 전체 경로로 1회·전체 경로는 바로 오류, 작성이 실패하면 빠른 경로는 전체 경로로·전체 경로는 작성만 1회 더. 세션·GitHub 리뷰는 예전 방식 그대로.
- 어디서: 홈 소스 카드 행, 카드의 이력 "지난 7일/30일" 행(Slack·메일; Jira·GitHub·캘린더는 ⋯), 팔로업 채널 카드의 모든 행·최근 대화·요약 줄(위 "팔로업 채널 카드"), 인박스·장비실. 팔로업에서 연 초안은 원글 ts 를 thread_ts 로 써서 스레드 답글.
- 데이터: 백그라운드로 모은 답장 맥락(신선하면 — `draft_context_max_age_minutes` 180분 — 빠른 경로) 또는 커넥터로 스레드를 읽어 생성. **Slack 은 모은 발췌가 없거나 6시간보다 오래됐으면** 프롬프트가 먼저 `slack_read_thread`(limit 50, 스레드 없는 DM 은 `slack_read_channel`)로 대화 전체를 읽고 그 맥락으로 쓰게 함 — 오래된 스레드도 지난 결론을 놓치지 않게(6시간 이내 발췌면 지금처럼 바로). 캐시 `~/.ned/drafts/`(1시간, 2단계 이전에 만든 캐시는 "답할 것" 없이 그대로 보임). 비용: 2단계는 claude 호출이 2번(빠른 경로는 둘 다 도구 없는 `draft_fast_model` 1턴, 전체 경로는 읽기 1번 + 빠른 작성 1번) — 비용 집계엔 둘 다 "draft". 초안을 열면 항목은 확인 완료.
- 출처: 초안·보내기 요청에 어디서 열었는지(`origin` card / history / watch, 대화창은 chat)가 실려 `~/.ned/sent-actions.log` 와 설정 → 오늘 한 액션의 출처 칩(카드 / 지난 N일 / 팔로업 / 대화창)에 남음. 예전 기록(출처 없음)은 칩 없이 그대로. 인박스·장비실(세션) ✎ 는 일부러 출처 없음(칩 없음). `actions.chat_write` 는 대화창 출처에만 걸림.
- 언제: Slack·메일 답장, 세션에 지시, Jira 코멘트, PR 리뷰 문구를 빨리 쓰고 싶을 때.
- 키·설정: ⌘⏎ 주 액션, Esc 닫기. 말투 = `reply_tone`(기본 "간결하고 정중한 존댓말, 핵심 먼저") / 소스별 `reply_tone_by_source.slack|email|session`. 미리 생성 `drafts_pregenerate`(config.yaml 만 — Slack·메일 항목은 2단계라 항목당 claude 호출 2번).

### 쓰기 액션
- 보여 주는 것: 초안 팝업·⋯ 메뉴의 실제 쓰기 버튼. 꺼진 동작은 비활성("설정 → 쓰기 액션에서 'X' 을 허용해야 써"). 보내기는 대상을 보여 주는 확인 단계 후 실행.
- 데이터: 소스별 커넥터 도구 하나만 허용한 `claude -p`(GitHub 는 `gh pr review/comment`, 세션은 `orca terminal send`). 모든 시도는 `~/.ned/sent-actions.log`.
- 언제: Ned 화면에서 바로 답·처리까지 끝내고 싶을 때.
- 설정 키(설정 → 쓰기 액션 → 허용할 동작(소스별)):
  - Slack: "Slack 전송" `actions.slack_send`(꺼짐)
  - Gmail: "Gmail 초안 저장" `actions.gmail_draft`(켬) · "메일 보내기" `actions.gmail_send`(꺼짐) · "메일 확인 시: 확인 완료만 / Gmail 읽음 표시까지" `actions.gmail_mark_read`(꺼짐)
  - 세션: "세션에 보내기" `actions.session_send`(켬) · "대화창에서 세션 만들기" `actions.chat_session_create`(꺼짐)
  - Jira: "Jira 코멘트" `actions.jira_comment` · "Jira 상태 변경" `actions.jira_transition`(⋯ → 코멘트 초안 쓰기…/상태 변경…)
  - GitHub: "GitHub 리뷰·코멘트" `actions.github_review`(⋯ → 리뷰 초안 쓰기…/바로 승인; 리뷰 코멘트·변경 요청·승인+코멘트·PR 코멘트)
  - 캘린더: "캘린더 참석 응답" `actions.calendar_rsvp` · "캘린더 일정 생성" `actions.calendar_create`
  - 대화창: "대화창에서 쓰기 허용" `actions.chat_write`(꺼짐) — 통신기 대화가 확인 카드로 쓰기를 제안(위 "대화창에서 쓰기")
  - "세션 빠른 답" `dashboard.session_quick_replies`(기본 ㄱㄱ, 승인, 계속) — 위 "세션에 답하기".
  - 아래 "오늘 한 액션" 표(소스·결과 필터, "읽기 포함", 새로고침). 소스 옆 출처 칩 = 어디서 실행했는지(카드 / 지난 N일 / 팔로업 / 대화창 / 세션 행 / 펫).
- Slack 이모지 리액션 보내기는 없음(커넥터에 도구 없음).

### Gmail 읽음 표시
- 보여 주는 것: 메일 항목 ✓(확인 완료) 때 Gmail 에서도 그 스레드의 안 읽음 표시를 지움.
- 데이터: 백그라운드 작업(`src/mail-read.ts`), 같은 스레드 10분 내 중복·하루 상한 도달 시 생략. 실패해도 확인 완료는 유지, ✓ 취소해도 안 읽음으로 되돌리지 않음.
- 언제: Ned 에서 확인한 메일을 Gmail 에서도 읽음으로 맞추고 싶을 때.
- 켜는 법: 설정 → 쓰기 액션 → Gmail → "메일 확인 시:" 에서 "Gmail 읽음 표시까지" 선택 → 저장. 키 `actions.gmail_mark_read`(기본 false).

### 확인 완료 ✓ · 답 필요 해제 이모지
- 보여 주는 것: ✓ 누른 항목은 "확인 완료 N" 아래로 접힘(흐리게, 다시 누르면 되돌림). 카운트·배지는 열린 것만. 항목이 ✓ 뒤에 바뀌면 다시 열림 — 홈 카드·지난 N일 이력·팔로업 행(별도 카드/접힘)·검색에서 같은 항목은 같은 키·같은 판정이라 어디서 눌러도 같이 바뀌고, 주기 갱신에서 메타만 바뀌고 새 메시지가 없으면 접힌 채 유지.
- 확인 키: 메일 `mail:<스레드>`, Slack `slack:<채널>:<메시지 ts>`(permalink 기준 — 스레드 정보와 무관), Jira `jira:<키>`, GitHub `github:<저장소>#<번호>`. 다시 열림 = ✓ 시각보다 늦은 "마지막 변경": 메일 받은 시각, Jira·GitHub 갱신 시각, Slack 은 max(메시지 ts, 스레드 마지막 답글, 1단계가 본 스레드 최신 ts) — ✓ 전 답글로는 안 열림. 스레드의 "새 답글"(카드 "+N 새 답글" 칩·확인 필요 재등장·팔로업 "나한테"·순찰 알림)도 같은 ✓ 시각 기준: ✓ 전에 달렸지만 늦게 수집된 답글로는 켜지지 않고, ✓ 뒤 답글이면 행과 함께 켜짐(해제하면 되돌림). 예전 `slack:…@<답글 ts>` 표시는 읽을 때 기본 키로 합쳐지고(여럿이면 가장 늦은 시각) 다음 저장 때 새 형식으로만 저장.
- 키 없는 행(링크를 못 읽은 항목): ✓ 가 흐린 비활성("확인 키 없음", 누르면 이유 토스트). 저장 실패 시 ✓ 를 되돌리고 토스트.
- 데이터: `~/.ned/reviewed.json`(attention 7일, 소스 항목 30일). Slack 은 agenda 가 내 답글 / 내 리액션 이모지를 찾아 자동으로 확인 처리.
- 언제: 처리했거나 볼 필요 없는 항목을 목록에서 치울 때.
- 설정: 설정 → 소스 → Slack → "답 필요 해제 이모지"(`filters.slack.ack_reactions`, 기본 white_check_mark·eyes·+1·heavy_check_mark, 최대 8, 비우면 리액션 안 봄). 이모지 하나 = Slack 검색 한 번이라, 한 번에 앞에서부터 "한 번에 확인할 이모지"(`filters.slack.ack_check_max`, 기본 3, 1~8)개만 보고, 답 필요 후보가 하나도 없으면 이모지 검색 자체를 건너뜀.

### Slack 그룹 멘션
- 보여 주는 것: 내가 속한 Slack 유저그룹(@mobile-dev 등)을 향한 멘션도 Slack 카드에 "그룹"(👥) 칩으로. `전체` 에는 모두, `확인 필요` 에는 그룹에 구체적으로 묻거나 요청했는데 아무도(나 포함) 답하지 않은 것만(공지·공유 제외). 같은 메시지가 개인 멘션에도 걸리면 개인 멘션으로(dm > 멘션 > 스레드 > 그룹). 그룹 멘션은 스레드 팔로업 대상이 아님.
- 데이터: agenda Slack 1단계에서 그룹마다 검색 1번 추가(기존 검색과 같은 턴, 턴 수 그대로) — ID 면 `<!subteam^S…>`, 핸들이면 `"@핸들"` 로 찾음. `reason: "group"`.
- 설정: 설정 → 소스 → Slack → "그룹 멘션"(`filters.slack.group_mentions`, 기본 [], 최대 8). 그룹 ID(`S…`, Slack 그룹 프로필 ⋯ → ID 복사 — 가장 정확) 또는 핸들(`@mobile-dev`, 앞 @ 는 떼어 저장). 비우면 검색 안 함.

### 검색 ⌘K
- 보여 주는 것: 주의 항목·세션·일정·Jira·GitHub·메일·Slack·개인 할 일·브리핑·타임라인 이벤트·초안·설정 항목 통합 검색, 한글 초성 매칭.
- 데이터: `GET /api/search`(state, 브리핑 전체, 최근 30일 이벤트, 할 일, agenda.json, 수집 이력, 초안) — 읽기 전용. 수집 이력은 지금 카드에 없는 것만(같은 항목이 두 번 안 나옴) "이력 · 날짜" 로, ⇧⏎ 는 그 소스 카드로.
- 언제: "그 메일 어디 있었지", "알림 설정 어디야" 처럼 찾을 때.
- 키: ⌘K/Ctrl+K 또는 /, ↑/↓(Ctrl+N/P, Tab) 이동, ⏎ 열기, ⌘⏎ 새 탭, ⇧⏎ 대시보드에서 보기, Esc 지우기→닫기.

### 아카이브 — Obsidian
- 보여 주는 것: Obsidian 볼트 안 Ned 폴더(`archive.folder`, 기본 Ned)에 매일 **데일리 리포트** `Daily/YYYY-MM/YYYY-MM-DD.md` — 🌅 브리핑(아침 브리핑의 행동 필요/업데이트/참고, 링크) · 🔔 순찰(그날 순찰 알림 시간순, 같은 항목 한 번) · ✉️ 보낸 것(답장·일정 생성·읽음 처리·할 일 추가 등 성공한 쓰기, 시각·대상·요약) · 📎 정리 결과물(결과물 노트 링크) · 🤖 세션(켜면) · 📥 들어온 것(수집 이력에서 그날 처음 본 항목, 소스별 최대 30줄 +N — Slack 채널·보낸이·한 줄·링크 / 메일 보낸이·제목 / Jira 키·제목 / GitHub 레포·PR 제목 / 캘린더 시각·제목) · 📊 오늘(순찰 횟수, 소스별 갱신 수, 비용). frontmatter `created`·`tags: [ned, daily]`·`ned_version`. Ned 데일리 리포트는 내 데일리 노트와 별도 파일.
- 데이터: 이미 있는 것(`~/.ned/briefings/`, `~/.ned/sent-actions.log`, `~/.ned/outputs/`, 세션 이벤트, `~/.ned/costs.json`, agenda 갱신)으로 데몬이 마크다운을 씀 — Claude 호출 없음, 비용 0. 섹션마다 `<!-- ned:섹션 -->` … `<!-- ned:/섹션 -->` 사이만 다시 쓰고 **마커 밖에 적은 메모는 그대로**(마커를 지우면 그 섹션은 파일 끝에 새로 붙음). 임시 파일 → rename 으로 원자적 쓰기, 볼트 밖 경로(.. · 심링크)는 거부. 상태는 `~/.ned/archive.json`.
- 언제 쓰나: 아침 브리핑·순찰 알림·쓰기 성공·결과물 저장 직후 바로, 그 밖의 변화(순찰 횟수·소스 갱신)는 1분 틱에서 마지막 쓰기 후 5분 지나면. 자정 넘어 끝난 순찰은 그 순찰이 시작된 날 파일로, 지난 날 파일은 그 뒤로 안 건드림.
- 내 데일리 노트 embed(`archive.daily_embed`, 기본 꺼짐): 켜면 그날 내 데일리 노트가 **이미 있을 때만**(없으면 만들지 않음) "## 📝 Notes & Logs" 바로 아래에 `<!-- ned:embed -->![[Ned/Daily/YYYY-MM/YYYY-MM-DD]]<!-- ned:/embed -->` 한 줄. 다른 줄은 손대지 않음. 데일리 노트 위치는 `<볼트>/.obsidian/daily-notes.json` 의 folder·format(없으면 건너뜀).
- 설정: 설정 → 아카이브 — "아카이브 켜기" `archive.enabled`(기본 꺼짐) · "볼트 경로" `archive.vault`(절대 경로, 있는 폴더여야 하고 ~/.ned·Ned 레포 안은 거부 — `.obsidian` 이 있으면 "볼트 확인됨" 배지, 없으면 경고만) · "Ned 폴더" `archive.folder` · "담을 것" `archive.include.briefings`·`archive.include.updates`·`archive.include.actions`·`archive.include.outputs`·`archive.include.history`(📥 들어온 것, 기본 켬)·`archive.include.sessions`(기본 꺼짐) · "내 데일리 노트에 embed" `archive.daily_embed`. 상태 줄: 오늘 리포트 경로("Obsidian 에서 열기"), 마지막 쓰기, 대기 중인 날, 마지막 오류(권한 거부면 macOS 파일 접근 허용 안내), "지금 쓰기"(`/api/archive/flush`), 상태는 `/api/archive/status`. 쓰기가 실패해도 데몬은 계속 돌고 다음 틱에 다시 시도(쓰는 중 파일이 계속 바뀌면 4번까지 다시 합친 뒤 다음 틱으로, 7일 넘게 못 쓴 날은 경고 후 포기).

### 설치·업데이트 — Claude Code 플러그인
- 보여 주는 것: Ned 는 Claude Code 플러그인 `ned@ned`(마켓플레이스 = 이 레포 `HuanSuh/ned`, 기본 브랜치 main 이 설치본). 플러그인이 주는 것: 세션 훅 8개(`hooks/hooks.json` — SessionStart·UserPromptSubmit·Stop·StopFailure·Notification·SubagentStart·SubagentStop·SessionEnd → `$NED_HOME/events/`)와 명령 `/ned:install`·`/ned:status`·`/ned:uninstall`.
- 설치: `/plugin marketplace add HuanSuh/ned` → `/plugin install ned@ned` → `/reload-plugins` → `/ned:install`. 사전 조건 node 22+·pnpm·Xcode 명령줄 도구·claude CLI(없으면 설치 안내 후 멈춤). Ned.app 은 공증이 없어 내려받지 않고 각 Mac 에서 빌드. 세션 훅은 새 세션(또는 `/reload-plugins`)부터 기록.
- 데이터: 플러그인 캐시(`~/.claude/plugins/cache/ned/ned/<버전>/`)는 업데이트마다 경로가 바뀌므로, `/ned:install` 이 소스를 고정 경로 `~/.ned/runtime/` 로 동기화해 거기서 빌드하고 Ned.app 의 `nedRepoPath` 를 그곳으로 둔다. `~/.claude/settings.json` 에 예전 방식(절대 경로) Ned 훅이 남아 있으면 지운다(이벤트 이중 기록 방지, 백업 `settings.json.ned-backup`).
- 언제: 업데이트 = `/plugin update ned` → `/reload-plugins`(또는 새 세션) → `/ned:install`(같은 명령, 멱등). reload 를 빼면 이 세션은 업데이트 전 버전을 쓰고 있어 `/ned:install` 이 "다시 로드 후 실행" 으로 멈춘다(옛 버전 재설치 방지). 새 빌드는 `~/.ned/runtime.next` 에서 끝까지 만든 뒤에만 교체하므로 실패해도 기존 설치가 유지되고, 로그는 `~/.ned/logs/install.log`. `/ned:status` 는 읽기만 — 데몬·앱·런타임 vs 플러그인 버전("업데이트 필요")·최근 로그·옛 훅 잔존. `/ned:uninstall` 은 확인 후 앱·런타임 삭제(데이터 `~/.ned` 유지), 이어서 `/plugin uninstall ned`.
- 설치 중 점검(`/ned:install`): 빌드 **전에** 코드 서명 인증서("Ned Local Signing")가 없으면 지금 만들지 묻는다(`scripts/make-signing-cert.sh`, macOS 대화상자 승인 — 없으면 ad-hoc 서명이라 재설치마다 권한을 다시 물음). 설치 뒤 `ned setup-check`(아래 "시작하기")로 소스별 연결 상태와 할 일을 표로 보여 주고, 처음 설치면 로그인할 때 자동 실행할지 묻는다(예 → `Ned --login-item-register`).
- 처음 한 번: claude.ai 커넥터(Slack·Gmail·Calendar·Jira)를 본인 계정으로 연결, GitHub 은 `gh auth login` — Ned 는 토큰을 갖지 않는다. Slack 팀 ID 입력. 모두 대시보드 **시작하기** 창에서 확인·입력할 수 있다.
- 레포에서 직접 설치(개발용): `scripts/install.sh` — 체크아웃에서 빌드하고 `settings.json` 에 훅 등록. 플러그인과 같이 쓰지 말 것. 릴리스 절차는 `docs/RELEASE.md`.
- MCP: 플러그인 루트 `.mcp.json` 이 데몬의 `/mcp` 를 `ned` MCP 서버로 등록한다(아래 "MCP 서버") — 설치 뒤 Claude Code 에서 `/mcp` 로 확인.

### MCP 서버 — 어느 Claude Code 세션에서나 Ned 읽기
- 보여 주는 것: 플러그인을 설치한 모든 Claude Code 세션에 `ned` MCP 서버(도구 이름 `mcp__plugin_ned_ned__<도구>`). "지금 봐야 할 것", 세션 상태, 최근 브리핑을 대화 중에 도구로 읽는다.
- 엔드포인트: 데몬의 `POST /mcp`(MCP Streamable HTTP, `http://127.0.0.1:7777/mcp`). stateless(세션 ID 없음)·JSON 응답 — 요청마다 서버를 새로 만든다. `GET /mcp`·`DELETE /mcp` 는 405(SSE 스트림·세션 없음). 코드 `src/mcp.ts`(트랜스포트)·`src/mcp-tools.ts`(도구).
- 도구:

  | 도구 | 하는 일 | 인자 |
  | --- | --- | --- |
  | `ned_attention` | 열린 "확인할 것" — attention(브리핑·세션) + 소스 카드 항목(메일·Slack·Jira·GitHub, 응답 필요 일정), URL 중복 제거. 응답 필요 일정(시작 시각이 미래)이 맨 앞, 나머지는 최신순. 항목마다 `review_key`·`open`·`reviewed_at` | `source?`(slack·mail·jira·github·calendar·session·sentry·other), `limit?`(20, ≤100), `include_reviewed?` |
  | `ned_sessions` | 세션 목록 — id 앞 8자·워크트리·상태·`waiting_for_input`·시작/마지막 시각·마지막 프롬프트/요약 | `status?`, `include_workers?`(true), `limit?`(20, ≤50) |
  | `ned_briefing` | 최신 브리핑(또는 `since` 이후 브리핑들) — 헤드라인·할 일·업데이트·참고·상태 | `since?`(ISO), `limit?`(3, ≤5) |
  | `ned_history` | 한 소스의 지난 N일 수집 이력(`/api/history` 와 같은 조건) | `source`, `days?`(1), `q?`, `channel?`, `limit?`(20, ≤100) |
  | `ned_feed` | 메시지 피드(펫·통신기 "메시지"와 같은 규칙) 최근 n개 | `limit?`(10, ≤50) |
  | `ned_mark_reviewed` | **유일한 쓰기** — `review_key` 로 확인 완료 ✓ / 해제(`reviewed:false`). `/api/attention/:id/review` 와 같은 검증(잘못된 키 400, 없는 attention 404)·부수효과(Slack 스레드 읽음 기준, `actions.gmail_mark_read` 면 Gmail 읽음) | `review_key`, `reviewed?`(true) |

  결과: 요약 한 줄 + JSON(텍스트 블록 두 개). 목록은 limit, 문자열은 잘라서(제목 200자·본문 300~400자) 한 번에 토큰이 폭주하지 않게. 리소스: `ned://briefing/latest`(최신 브리핑 JSON), `ned://features`(이 문서 요약).
- 보안: 데몬은 `127.0.0.1` 에만 열린다. DNS rebinding·같은 Mac 의 다른 포트 웹페이지 방지로 Host 가 loopback(127.0.0.1·localhost·[::1]) + 데몬 포트가 아니거나(포트 생략도 거부), Origin 헤더가 있는데 `http(s)://loopback:데몬 포트` 가 아니면 403, 브라우저의 `Sec-Fetch-Site` 가 `same-origin`·`none` 이 아니면(다른 사이트·다른 포트 페이지의 `<img>` GET 등) 403(로그 `request-guard: refused`) — 단 Slack·Notion 등에 걸린 대시보드 링크 같은 최상위 페이지 이동(GET, navigate·document)은 `/api`·`/mcp` 밖이면 허용. 이 헤더들이 없으면(CLI) 허용. 인증은 없다 — `/api`·`/mcp`(그리고 대시보드 정적 파일) 모두 같은 가드(`src/request-guard.ts`). 쓰기는 ✓ 하나뿐(메일 ✓ 는 `actions.gmail_mark_read` 면 Gmail 읽음 처리도 하므로 `openWorldHint: true`).
- 설치·확인: 플러그인 `.mcp.json` = `{"mcpServers":{"ned":{"type":"http","url":"http://127.0.0.1:7777/mcp"}}}` — 포트 7777 고정. `port` 를 바꿨다면 `claude mcp add --transport http ned <데몬 주소>/mcp` 로 직접 등록하고 `/mcp` 에서 플러그인 쪽 `ned` 를 끈다. `/ned:status` 의 "MCP" 줄이 `/mcp` 응답 여부(초기화 요청 1회)를 보여 주고, 이 세션에 로드됐는지는 `/mcp` 로 본다. Ned.app(데몬)이 꺼져 있으면 Claude Code 가 연결을 몇 번 재시도한 뒤 `/mcp`·`claude mcp list` 에 연결 실패(✘ Failed to connect)로 표시하고 도구가 없다 — 데몬을 켠 뒤 `/mcp` 에서 다시 연결.
- 후속(이번에 없음): 보내기(`/api/send`)·초안·세션 만들기 같은 쓰기 도구, 서버→클라이언트 알림(SSE), 다른 포트 자동 반영.

### 시작하기 — 첫 실행 점검
- 보여 주는 것: "시작하기" 창 — 소스 연결(설정에서 켠 소스만: Slack·Gmail·Google Calendar·Jira(Atlassian) 커넥터, GitHub `gh`, Sentry MCP) 상태 칩 연결됨/인증 필요/연결 안 됨/연결 중/확인 실패 + 할 일("claude.ai 에서 연결" → https://claude.ai/settings/connectors, `gh auth login`), Slack 팀 ID 입력·저장(`dashboard.slack_team_id`, Slack 소스가 켜졌을 때), 자동 실행(Login Item) 토글, 코드 서명 상태 + 실행할 명령(`bash …/scripts/make-signing-cert.sh` — 다음 `/ned:install` 부터 적용).
- 데이터: `GET /api/setup`(1분 캐시, "다시 확인" = `?refresh=1`) — claude 를 한 번 띄워 시작 줄(system/init)의 커넥터 상태만 읽고 바로 끈다(모델 호출·비용 없음; `claude mcp list` 는 인증 필요를 연결됨으로 보여서 안 씀). GitHub 은 `gh auth status`, 서명은 `security find-identity -v -p codesigning`. 닫음은 `POST /api/setup/dismiss` → `~/.ned/onboarding.json`(설정 아님). 자동 실행은 Ned.app 만 알 수 있어 앱 창에서만 토글(브라우저로 연 대시보드는 "Ned.app 창의 대시보드 설정 → 앱(Ned.app) 에서" 안내). CLI: `node dist/cli.js setup-check [--json]`.
- 언제: 대시보드를 처음 열 때 준비 안 된 항목이 있고 아직 닫은 적이 없으면 저절로 뜬다. 닫으면(✕·닫기·Esc) 다시 안 뜨고, 설정 상단 "시작하기" 버튼으로 언제든 다시 연다.

### Ned.app 메뉴 막대 · 설정 → 앱
- 보여 주는 것: 메뉴 막대 아이콘을 누르면 짧은 메뉴 — 상태 한 줄(데몬 점: 정상 = 페르소나 LED 색·시작 중 = 노랑·꺼짐 = 빨강, + "마지막 점검 N분 전"/"아직 점검 전", 시작 중엔 "시작 중 n/4 · 단계", 꺼지면 "꺼져 있음" + [다시 시작]; 확인할 것이 있으면 줄 끝에 숫자 배지, 목록은 대시보드에서) + **대시보드 열기** · **설정…**(대시보드 설정 탭의 "앱" 묶음으로) · **업데이트 확인** · **종료**. 마우스를 올리면 데몬 pid·저장소 경로·state.json 읽기 실패가 툴팁으로.
- 설정 → **앱 (Ned.app)** 묶음: 자동 실행(로그인할 때 Ned 실행, Login Items + "자동 시작: 켜짐/꺼짐(승인 필요)") · 실행 시 대시보드 열기 · 자동 시작 시에도 열기 · 저장소 위치(경로 + "변경…" → 앱의 폴더 선택 창) · 로그(`~/.ned/logs/app-daemon.log`, "Finder 에서 보기") · 데몬 다시 시작 · 업데이트 확인. 앱 쪽 설정(UserDefaults·SMAppService)이라 config.yaml 키가 없고 하단 "저장"과 무관하게 **바꾸는 즉시 적용**. Ned.app 창에서만 바꿀 수 있고(앱 브리지 `appSettings`), 브라우저로 연 대시보드는 "Ned.app 창에서 열면 바꿀 수 있어요" 한 줄 + 업데이트 확인만.
- 업데이트 확인: `GET /api/update-check`(10분 캐시, 버튼은 `?refresh=1`) — 설치된 런타임(`~/.ned/runtime/.claude-plugin/plugin.json`)의 버전과 최신 버전을 semver 로 비교. 최신 버전은 GitHub main 의 plugin.json 을 `raw.githubusercontent.com` 에서 바로(공개 레포 — gh·로그인 불필요, 5초 제한), 안 되면 `gh api`, 그것도 안 되면 로컬 마켓플레이스 사본(`~/.claude/plugins/marketplaces/ned/`), 셋 다 안 되면 "확인 실패(사유)". 응답 `source` = `raw`·`github`·`marketplace`. 결과: "최신 버전 (X.Y.Z)" 또는 "X → Y 업데이트 있음 — Claude Code 에서 `/plugin update ned` → `/reload-plugins` → `/ned:install`" + [명령 복사]. 앱이 직접 설치하지 않는다(위 "설치·업데이트").
- **자동 업데이트**(설정 → 앱 → "업데이트" 소묶음 — 이 세 키는 하단 **"저장"**으로 저장, 브라우저에서도 보임): `updates.auto_check`(새 버전 자동 확인, 기본 켬) · `updates.check_hours`(확인 주기 시간, 기본 24, 최소 1) · `updates.auto_install`(자동 설치, 기본 끔). 데몬 스케줄러가 주기마다 위와 같은 확인을 하고, 새 버전이면 **알림 한 번**(같은 버전은 다시 안 알림, 조용한 시간이면 끝난 뒤 — `notifications.quiet_delivery` silent 면 바로) + 메뉴 상태 줄 아래 "업데이트 있음 X.Y.Z"(누르면 설정 → 앱) + 설정 묶음 상태 줄. 기록은 `~/.ned/update-state.json`(마지막 확인·알린 버전·마지막 설치 시도).
  - 자동 설치(`updates.auto_install`)는 새 버전이 있고 + 조용한 시간이거나 유휴 + 실행 중·입력 대기 세션이 없고(Orca 워커 포함) + 마지막 실패 뒤 24시간이 지났을 때만. 버튼 **"지금 확인"**(`GET /api/update-check?refresh=1`) · 새 버전이 있으면 **"지금 업데이트"**(한 번 더 확인 → `POST /api/update/install`, 위 조건은 건너뜀).
  - 설치: 데몬이 `scripts/self-update.sh` 를 분리된 프로세스로 띄운다 — `claude plugin marketplace update ned` → `claude plugin update ned@ned` → 새 버전의 `scripts/install.sh`(`/ned:install` 과 같은 설치, 앱·데몬이 잠시 내려갔다 다시 뜸). 한 번에 하나(`~/.ned/self-update.lock`), 로그 `~/.ned/logs/self-update.log`. 앱이 다시 뜨면 알림 한 번: "Ned X.Y.Z 로 업데이트됨 — 열린 Claude Code 세션은 /reload-plugins" 또는 "업데이트 실패 — 기존 설치 유지, 로그 …". 상태 조회 `GET /api/update/status`.
- 점검: `Ned --menu-snapshot <dir>`(상태별 메뉴 PNG, 라이트/다크) · `Ned --appsettings-selftest`(브리지 키 화이트리스트·출처 거부).

### 데스크톱 펫 — 화면에 늘 떠 있는 Ned (Ned.app)
- 보여 주는 것: 대시보드를 열지 않아도 화면 구석(기본 주 화면 오른쪽 아래, Dock·메뉴 막대 피함)에 떠 있는 현재 페르소나 마크(페르소나를 바꾸면 따라 바뀜). 모든 데스크톱·전체 화면 앱 위에 뜨고 포커스를 뺏지 않는다. 마우스를 올리면 손가락 커서(끄는 동안 쥔 손).
  - 상태 = 둥근 카드의 **테두리 색 + 바깥 글로우**(통신기 Ned Net 과 같은 방식): 쉼 = 중립 테두리·은은한 흰빛 글로우, 작업 중 = 페르소나 보조색(Ned 는 민트) 글로우, 확인할 것 = 페르소나 색(배지 N), 입력 기다림 = 주황·키보드 아이콘(Orca 워커 세션 제외), 오류 = 빨강 점선·더 강한 글로우, 연결 끊김 = 회색·글로우 없음(마크 흐리게). 새 소식 말풍선은 페르소나 색. 연결 끊김을 뺀 모든 상태에서 테두리와 말풍선의 글로우(테두리 뒤 반사광 정도로 좁게)가 1.6초 주기로 밝아졌다 잦아든다(숨쉬기) — 움직임은 이것과 쉴 때 아주 작은 크기 변화뿐 — 바운스·흔들림·이모지 없음, 상태 전환은 0.5초 페이드. macOS "동작 줄이기"면 글로우 고정.
  - **말풍선 = 통신기 "메시지" 탭과 같은 새 소식**: 새 항목이 오면 출처 아이콘 + 제목(+ 짧은 내용)을 채팅 말풍선으로 5.5초 띄우고 접는다. 여러 개면 차례로(최대 3개), 한 번에 3개 넘게 오면 "새 소식 N" 하나로. 이미 본 항목은 다시 안 띄우고(앱이 본 키를 기억, 처음 켤 때 있던 항목은 본 것으로), 하루 한 번 그날 처음 볼 때 페르소나 인사. 입력 기다림·확인할 것이 끝나 평소로 돌아가면 "끝", 데몬이 끊기면 "연결 끊김".
  - 마우스를 올리면 상태 한 줄 + 최근 3개 목록(없으면 페르소나의 "레이더 깨끗함" 류 한 줄). 조용한 시간(`quiet`)엔 말풍선을 저절로 띄우지 않는다(올리면 보임).
  - **세션에 답하기**: 입력을 기다리는 세션이 있으면 세션 말풍선·올린 목록에 빠른 버튼 + "…" 한 줄 입력(목록은 최근 1개로 줄어듦) — 위 "세션에 답하기". 빠른 버튼과 켜짐 여부는 `GET /api/feed` 의 `quick_replies`·`session_send`.
- 데이터: `GET /api/feed`(통신기 메시지와 같은 규칙 — 열린 attention·24시간 안 브리핑 UPDATE·내 답 이후 새 Slack 답글, 각 항목에 펫 종류와 앱 딥링크) + 메뉴 막대와 같은 `state.json`(세션 status·`is_worker`·열린 attention·`quiet`, 설정 저장 때 `pet` 도 비춰 둬 바로 반영). 상태 매핑·메시지 큐는 순수 함수 — `--pet-selftest`, 화면은 `--pet-snapshot <dir>`.
- 버튼·설정: 설정 → 외형 → **데스크톱 펫** — "화면에 Ned 띄우기" `pet.enabled`(기본 끔) · "말풍선으로 알려 줄 것" 종류별 `pet.messages.greeting`(인사) · `pet.messages.session`(작업: 입력 기다림·오류·끝) · `pet.messages.slack`(멘션·DM·스레드 새 답글) · `pet.messages.mail` · `pet.messages.jira` · `pet.messages.github` · `pet.messages.sentry`(소스 → Sentry 가 꺼져 있으면 흐려짐) · `pet.messages.calendar` · `pet.messages.briefing`(아침 브리핑·순찰), 모두 기본 켬. 끈 종류는 말풍선만 안 띄우고 테두리 색·배지는 그대로, 기타 알림은 항상 표시. "위치 초기화"(Ned.app 창에서만) = 기본 위치로. 하단 "저장"으로 저장.
  - 펫에서: 클릭 = 대시보드 열기, 말풍선 클릭 = 그 항목 열기(링크 열기 설정대로 앱 딥링크 또는 웹, 링크 없으면 대시보드), 드래그 = 이동(위치는 앱이 `desktopPetOrigin` 으로 기억, 화면 밖이면 기본 위치로), 우클릭 = 대시보드 열기 · 펫 설정…(이 묶음으로) · 숨기기(`pet.enabled` 를 끄고 저장). 앱에 남는 펫 상태는 위치와 본 메시지 키뿐.

### 설정 탭
상단 바로가기: 외형 · 소스 · 맡긴 일 · 알림 · 순찰 주기 · 수집·보관 · 쓰기 액션 · 아카이브 · Claude · 앱. "시작하기"(위 "시작하기") · "다시 불러오기", 하단 "● 저장 안 된 변경" + "저장".
- **외형**: 테마 🖥️시스템/☀️라이트/🌙다크 `dashboard.theme`(바로 미리보기, 저장해야 유지) · 홈 카드 배치 ↑/↓·1열/2열 `dashboard.card_order`/`dashboard.card_span` · "홈 배치 잠금" `dashboard.locked` · "팔로업 채널을 별도 카드로" `dashboard.watch_cards` · "배치 초기화" · 링크 열기 "링크를 앱으로 열기" `dashboard.open_links_in_app` + Slack/Figma/Notion 체크(`dashboard.open_links_in_app_by_service.*`, 끄면 흐려짐) · "Slack 팀 ID" `dashboard.slack_team_id` · "Slack 워크스페이스 주소" `dashboard.slack_team_domain`(위 "링크 열기 — 앱 딥링크") · 데스크톱 펫 `pet.enabled` + 말풍선 종류 `pet.messages.*` + 위치 초기화(위 "데스크톱 펫").
- **소스**: Gmail/Slack/Jira/GitHub/Sentry/캘린더 `sources.*`(끄면 조회·보고 안 함). Slack: 팔로업 채널 `filters.slack.watch_channels` · 트래킹 제외 채널 `filters.slack.exclude_channels`(팔로업보다 우선) · 답 필요 해제 이모지 `filters.slack.ack_reactions` · 한 번에 확인할 이모지 `filters.slack.ack_check_max`(3) · 그룹 멘션 `filters.slack.group_mentions`(유저그룹 ID·핸들). Jira: 제외 프로젝트 `filters.jira.exclude_projects`. 칩 입력: ⏎/쉼표 추가, 빈 입력 Backspace 삭제.
- **맡긴 일**: 책임 목록(최대 5) `responsibilities` — 추가 · 켜기 · 제목 · 챙길 것 · 볼 곳 · 키워드 · 언제까지 · 삭제(위 "맡긴 일 — 책임 단위로 순찰").
- **알림**: 알림 켜기 `notifications.enabled` · 소스별 `notifications.kinds.*` · 아침 브리핑 알림 `notifications.briefing` · 소리 `notifications.sound` · 묶음 기준 `notifications.summary_threshold`(기본 3) · 조용한 시간 `quiet_hours`(기본 23:00~08:00) · 그 시간엔 보내지 않음/소리 없이 `notifications.quiet_delivery`.
- **순찰 주기**: heartbeat 간격 `heartbeat_minutes`(10) · 신호 조회 최소 간격 `signal_check_minutes`(60) · "바뀐 게 없으면 순찰 건너뛰기" `heartbeat_skip_unchanged`(켬) · 아침 브리핑 시각 `briefing_time`(09:00) · 홈 자동 갱신 기본 주기 `agenda_refresh_minutes`(60) · 소스별 주기 Slack/메일/캘린더/Jira/GitHub `agenda_source_minutes.*`(비우면 기본) · 조용한 시간 동작 `quiet_schedule.*` · 유휴 시 동작 `idle_schedule.*`(위 "야간 모드 · 유휴 모드").
- **쓰기 액션**: 기본 말투 `reply_tone` · 소스별 그룹 토글 `actions.*`(위 "쓰기 액션") · 답장 말투 `reply_tone_by_source.*` · 세션 빠른 답 `dashboard.session_quick_replies` · 오늘 한 액션.
- **수집·보관**: 수집 이력 기록 `history.enabled`(`c-hist-on`) · 표시 구간 Slack 시간 `history.display.slack_hours`·메일 일 `history.display.mail_days` · 수집 창 Slack 전체 재검색 시간 `history.collect.slack_hours`(`c-hist-collect-slack-h`, 24) · 보관 기간 Slack/메일/Jira/GitHub/캘린더 `history.keep_days.*`(0 = 기록 안 함) · 상태 줄(소스별 건수·일수·크기, 마지막 수집·전체 재검색, 다음 수집 창 — `/api/history/status`).
- **아카이브**: 켜기 `archive.enabled` · 볼트 경로 `archive.vault` · Ned 폴더 `archive.folder` · 담을 것 `archive.include.*` · 내 데일리 노트 embed `archive.daily_embed` · 상태·"지금 쓰기"(위 "아카이브 — Obsidian").
- **Claude**: 모델 `claude_model`(비우면 기본) · 최대 턴 `claude_max_turns`(25) · 하루 사용 상한 `agenda_daily_budget_usd`(15, 닿으면 자동 실행과 대화가 멈춤, 버튼 실행은 계속).
- **앱 (Ned.app)**: 자동 실행·실행 시 대시보드 열기·자동 시작 시에도 열기·저장소 위치·로그·데몬 다시 시작 — 즉시 적용, "저장" 대상 아님. "업데이트" 소묶음 `updates.auto_check`·`updates.check_hours`·`updates.auto_install` 은 "저장"으로(위 "Ned.app 메뉴 막대 · 설정 → 앱").
- **저장·되돌리기**:
  - 보여 주는 것: 하단 "● 저장 안 된 변경" + "저장". 바뀐 항목만 저장("바뀐 항목이 없어."면 저장할 게 없음). 다른 곳(다른 탭·config.yaml 직접 수정·데몬 업그레이드)에서 그 사이 바뀌었으면 덮어쓰지 않고 최신 값을 불러온 뒤 내가 수정한 항목은 유지 → 다시 저장.
  - 데이터: `PUT /api/config`(부분 패치 + 마지막으로 읽은 시점 비교, 어긋나면 409). 저장할 때마다 직전 config.yaml 을 `~/.ned/config-backups/` 에 백업(최근 10개).
  - 언제: 설정을 실수로 바꿨거나 예전 값으로 돌아가고 싶을 때 → 설정 탭 맨 아래 "이전 설정으로 되돌리기" → 시점 선택 → "되돌리기 확인"(지금 설정도 백업됨).
  - 새 버전: 데몬이 새 코드로 재시작되면 상단 배너 "새 버전의 Ned 가 실행 중이야 — 새로고침…" + "새로고침" 버튼, 새로고침 전까지 설정 저장이 잠김(옛 화면이 옛 설정을 쓰지 않도록).
- UI 없이 config.yaml 로만: `persona`, `port`, `notify`, `session_stale_minutes`, `draft_fast_model`, `draft_context_max_age_minutes`, `drafts_pregenerate`, `agenda_all_limit`, `agenda_context_batch`, `agenda_light_model`, `chat_ignore_budget`, `dashboard.layout`.

## 부록 A — 설정 키 전체 (`~/.ned/config.yaml`)

| 키 | 기본 | 화면 위치 |
|---|---|---|
| `heartbeat_minutes` | 10 | 설정 → 순찰 주기 → heartbeat 간격 |
| `signal_check_minutes` | 60 | 순찰 주기 → 신호 조회 최소 간격 |
| `heartbeat_skip_unchanged` | true | 순찰 주기 → 바뀐 게 없으면 순찰 건너뛰기 |
| `briefing_time` | 09:00 | 순찰 주기 → 아침 브리핑 시각 |
| `agenda_refresh_minutes` | 60 | 순찰 주기 → 홈 자동 갱신 기본 주기 |
| `agenda_source_minutes.slack` · `agenda_source_minutes.mail` · `agenda_source_minutes.calendar` · `agenda_source_minutes.jira` · `agenda_source_minutes.github` | null(=기본 주기) | 순찰 주기 → 소스별 주기 |
| `quiet_schedule.mode` · `quiet_schedule.slow_factor` | slow · 6 | 순찰 주기 → 조용한 시간 동작 |
| `idle_schedule.enabled` · `idle_schedule.after_minutes` · `idle_schedule.unchanged_runs` · `idle_schedule.mode` · `idle_schedule.slow_factor` | true · 120 · 6 · slow · 6 | 순찰 주기 → 유휴 시 동작 |
| `quiet_hours` (start/end) | 23:00~08:00 | 알림 → 조용한 시간 |
| `sources.gmail` · `sources.slack` · `sources.jira` · `sources.github` · `sources.sentry` · `sources.calendar` | 전부 true | 소스 |
| `filters.slack.watch_channels` | [] (최대 20) | 소스 → Slack → 팔로업 채널 |
| `filters.slack.exclude_channels` | [] | 소스 → Slack → 트래킹 제외 채널 |
| `filters.slack.ack_reactions` | white_check_mark, eyes, +1, heavy_check_mark | 소스 → Slack → 답 필요 해제 이모지 |
| `filters.slack.ack_check_max` | 3 (1~8) | 소스 → Slack → 한 번에 확인할 이모지 |
| `filters.slack.group_mentions` | [] (최대 8) | 소스 → Slack → 그룹 멘션 |
| `filters.jira.exclude_projects` | [] | 소스 → Jira → 제외 프로젝트 |
| `responsibilities` (항목: `id` · `title` · `goal` · `sources` · `keywords` · `until` · `enabled`) | [] (최대 5) | 맡긴 일 |
| `notifications.enabled` · `notifications.briefing` · `notifications.sound` · `notifications.summary_threshold` · `notifications.quiet_delivery` | true · true · true · 3 · skip | 알림 |
| `notifications.kinds.session` · `notifications.kinds.email` · `notifications.kinds.slack` · `notifications.kinds.jira` · `notifications.kinds.github` · `notifications.kinds.sentry` · `notifications.kinds.calendar` | 전부 true | 알림 → 소스별 |
| `actions.slack_send` · `actions.gmail_draft` · `actions.gmail_send` · `actions.gmail_mark_read` · `actions.session_send` · `actions.jira_comment` · `actions.jira_transition` · `actions.github_review` · `actions.calendar_rsvp` · `actions.calendar_create` · `actions.chat_write` · `actions.chat_session_create` | gmail_draft·session_send 만 true | 쓰기 액션 → 허용할 동작 |
| `reply_tone` · `reply_tone_by_source.slack` · `reply_tone_by_source.email` · `reply_tone_by_source.session` | "간결하고 정중한 존댓말, 핵심 먼저" · null | 쓰기 액션 → 기본 말투 / 답장 말투 |
| `dashboard.theme` · `dashboard.card_order` · `dashboard.card_span` · `dashboard.locked` · `dashboard.watch_cards` · `dashboard.layout` | system · slack,mail,jira,github · — · false · true · null | 외형 (layout 은 홈 드래그 배치) |
| `dashboard.open_links_in_app` · `dashboard.open_links_in_app_by_service.slack` · `dashboard.open_links_in_app_by_service.figma` · `dashboard.open_links_in_app_by_service.notion` | true · true · true · true | 외형 → 링크를 앱으로 열기 |
| `dashboard.slack_team_id` | "" (`T…` 만) | 외형 → Slack 팀 ID |
| `dashboard.slack_team_domain` | "" (= 모든 `*.slack.com`) | 외형 → Slack 워크스페이스 주소 |
| `dashboard.session_quick_replies` | ["ㄱㄱ", "승인", "계속"] (≤5개 · 각 ≤20자, [] = 버튼 없음) | 쓰기 액션 → 세션 빠른 답 (대기 세션 행 · 펫 말풍선) |
| `pet.enabled` | false | 외형 → 데스크톱 펫 → 화면에 Ned 띄우기 |
| `pet.messages.greeting` · `pet.messages.session` · `pet.messages.slack` · `pet.messages.mail` · `pet.messages.jira` · `pet.messages.github` · `pet.messages.sentry` · `pet.messages.calendar` · `pet.messages.briefing` | 전부 true | 외형 → 데스크톱 펫 → 말풍선으로 알려 줄 것 |
| `claude_model` · `claude_max_turns` · `agenda_daily_budget_usd` | null · 25 · 15 | Claude |
| `archive.enabled` · `archive.vault` · `archive.folder` · `archive.daily_embed` | false · "" · Ned · false | 아카이브 |
| `archive.include.briefings` · `archive.include.updates` · `archive.include.actions` · `archive.include.outputs` · `archive.include.sessions` · `archive.include.history` | true · true · true · true · false · true | 아카이브 → 담을 것 |
| `updates.auto_check` · `updates.check_hours` · `updates.auto_install` | true · 24 · false | 앱 (Ned.app) → 업데이트 ("저장"으로) |
| `history.enabled` | true | 수집·보관 → 수집 이력 기록 |
| `history.display.slack_hours` · `history.display.mail_days` | 24 · 3 | 수집·보관 → 표시 구간 |
| `history.collect.slack_hours` | 24 (1~168) | 수집·보관 → 수집 창 (Slack 전체 재검색) |
| `history.keep_days.slack` · `history.keep_days.mail` · `history.keep_days.jira` · `history.keep_days.github` · `history.keep_days.calendar` | 30 · 30 · 90 · 90 · 90 (0 = 기록 안 함) | 수집·보관 → 보관 기간 |
| `persona` | ned | UI 없음 (ned/alfred/oracle/jarvis — 말투·테마·통신기 이름) |
| `port` | 7777 | UI 없음 (`NED_PORT` 가 우선) |
| `notify` | auto | UI 없음 (auto/osascript/off) |
| `session_stale_minutes` | 180 | UI 없음 — 이 시간 이벤트 없는 세션은 사라짐 |
| `draft_context_max_age_minutes` · `draft_fast_model` · `drafts_pregenerate` | 180 · sonnet · false | UI 없음 — 초안 빠른 경로·미리 생성 |
| `agenda_all_limit` · `agenda_context_batch` · `agenda_thread_batch` · `agenda_light_model` | 20 · 5 · 8 · sonnet | UI 없음 — 전체 목록 길이, 맥락·스레드 수집 묶음, 목록 모델 |
| `chat_ignore_budget` | false | UI 없음 — true 면 하루 상한이 넘어도 통신기 대화는 허용 |

## 부록 B — 설정 화면 요소 ↔ 설정 키 (`public/index.html`)

| 요소 id | 화면 라벨 | 키 |
|---|---|---|
| `c-theme` | 외형 → 테마 | `dashboard.theme` |
| `c-cards` | 외형 → 홈 카드 배치 | `dashboard.card_order` / `dashboard.card_span` |
| `c-openapp` | 외형 → 링크를 앱으로 열기 | `dashboard.open_links_in_app` |
| `c-openapp-svc` | 외형 → 링크 열기 Slack/Figma/Notion (`data-olsvc`) | `dashboard.open_links_in_app_by_service.*` |
| `c-pet-on` | 외형 → 데스크톱 펫 → 화면에 Ned 띄우기 | `pet.enabled` |
| `c-pet-msgs` | 외형 → 데스크톱 펫 → 말풍선으로 알려 줄 것 (`data-petmsg`) | `pet.messages.*` |
| `c-slack-team` | 외형 → Slack 팀 ID | `dashboard.slack_team_id` |
| `c-slack-domain` | 외형 → Slack 워크스페이스 주소 | `dashboard.slack_team_domain` |
| `c-sources` | 소스 토글 | `sources.*` |
| `x-watch-in` | 소스 → Slack → 팔로업 채널 | `filters.slack.watch_channels` |
| `x-slack-in` | 소스 → Slack → 트래킹 제외 채널 | `filters.slack.exclude_channels` |
| `x-ack-in` | 소스 → Slack → 답 필요 해제 이모지 | `filters.slack.ack_reactions` |
| `c-ackmax` | 소스 → Slack → 한 번에 확인할 이모지 | `filters.slack.ack_check_max` |
| `x-group-in` | 소스 → Slack → 그룹 멘션 | `filters.slack.group_mentions` |
| `x-jira-in` | 소스 → Jira → 제외 프로젝트 | `filters.jira.exclude_projects` |
| `c-resp-add` | 맡긴 일 → ＋ 맡긴 일 추가 (`settings-responsibilities.js` 가 그림) | `responsibilities` |
| 행마다 `data-rf` | 맡긴 일 → 켜기 · 제목 · 챙길 것 · 볼 곳 · 키워드 · 언제까지 | `responsibilities.enabled` · `responsibilities.title` · `responsibilities.goal` · `responsibilities.sources` · `responsibilities.keywords` · `responsibilities.until` |
| `n-on` | 알림 → 알림 켜기 | `notifications.enabled` |
| `n-kinds` | 알림 → 소스별 | `notifications.kinds.*` |
| `n-brief` | 알림 → 아침 브리핑 알림 | `notifications.briefing` |
| `n-sound` | 알림 → 소리 | `notifications.sound` |
| `n-th` | 알림 → 묶음 기준 | `notifications.summary_threshold` |
| `c-qon` · `c-qs` · `c-qe` | 알림 → 조용한 시간 사용 · 시작 · 끝 | `quiet_hours` |
| `c-hb` | 순찰 주기 → heartbeat 간격 | `heartbeat_minutes` |
| `c-sig` | 순찰 주기 → 신호 조회 최소 간격 | `signal_check_minutes` |
| `c-hbskip` | 순찰 주기 → 바뀐 게 없으면 순찰 건너뛰기 | `heartbeat_skip_unchanged` |
| `c-bt` | 순찰 주기 → 아침 브리핑 시각 | `briefing_time` |
| `c-agmin` | 순찰 주기 → 홈 자동 갱신 기본 주기 | `agenda_refresh_minutes` |
| `c-int-slack` · `c-int-mail` · `c-int-calendar` · `c-int-jira` · `c-int-github` | 순찰 주기 → 소스별 주기 | `agenda_source_minutes.*` |
| `c-hist-on` | 수집·보관 → 수집 이력 기록 | `history.enabled` |
| `c-hist-slack-h` · `c-hist-mail-d` | 수집·보관 → 표시 구간 Slack(시간) · 메일(일) | `history.display.slack_hours` · `history.display.mail_days` |
| `c-hist-collect-slack-h` | 수집·보관 → 수집 창 Slack 전체 재검색(시간) | `history.collect.slack_hours` |
| `c-keep-slack` · `c-keep-mail` · `c-keep-jira` · `c-keep-github` · `c-keep-calendar` | 수집·보관 → 보관 기간 | `history.keep_days.*` |
| `c-tone` | 쓰기 액션 → 기본 말투 | `reply_tone` |
| `c-quick-replies` | 쓰기 액션 → 세션 빠른 답 (쉼표 구분) | `dashboard.session_quick_replies` |
| `c-model` | Claude → 모델 | `claude_model` |
| `c-turns` | Claude → 최대 턴 | `claude_max_turns` |
| `c-budget` | Claude → 하루 사용 상한 | `agenda_daily_budget_usd` |
| `c-arch-on` | 아카이브 → 아카이브 켜기 | `archive.enabled` |
| `c-arch-vault` | 아카이브 → 볼트 경로 | `archive.vault` |
| `c-arch-folder` | 아카이브 → Ned 폴더 | `archive.folder` |
| `c-arch-inc` | 아카이브 → 담을 것 | `archive.include.*` |
| `c-arch-embed` | 아카이브 → 내 데일리 노트 embed | `archive.daily_embed` |

쓰기 액션 토글은 `data-act="<키>"` → `actions.<키>` (부록 A).

## 부록 C — HTTP API (대시보드가 쓰는 로컬 API, 127.0.0.1)

- 수집 이력: `/api/history`(카드 "지난 7일/30일", `source`·`days`·`q`·`channel`) · `/api/history/status`(설정 → 수집·보관 상태 줄)
- 상태·데이터: `/api/state`(세션마다 `can_reply` — Orca 터미널 기록이 있어 답할 수 있나, `notification_type` — 대기를 만든 알림 종류) · `/api/agenda` · `/api/briefings` · `/api/feed`(데스크톱 펫 메시지 — 통신기 메시지 규칙 + `pet_kind`·`deep`, `pet` 설정·`quiet`, 세션에 답하기 `quick_replies`·`session_send`) · `/api/events` · `/api/costs` · `/api/actions`(오늘 한 액션) · `/api/search`(⌘K)
- 순찰·갱신: `/api/check`(지금 점검, GET 은 진행 상태) · `/api/heartbeat`(아침 브리핑 `?daily=1`) · `/api/agenda/refresh`(카드 ↻) · `/api/agenda/context`(맥락 지금 수집) · `/api/activity`(대시보드 활동 핑 — 유휴 해제)
- 할 일·확인: `/api/todos` · `/api/todos/:id`(완료·삭제) · `/api/attention/:id/review`(확인 완료) · `/api/attention/:id/dismiss`(닫기)
- 일정: `/api/calendar`(기간 조회) · `/api/calendar/events`(일정 만들기)
- 초안·보내기: `/api/draft` · `/api/send`(세션에 답하기도 — `source:"session"`, 글 ≤2,000자, 터미널 없음/닫힘·권한 대화상자 대기 409)
- 세션 만들기: `/api/sessions/create`(대화창 확인 카드 [실행], 진행은 `/api/sessions/create/:job_id`)
- 통신기: `/api/chat`(SSE) · `/api/chat/:id` · `/api/chat/:id/stop` · `/api/chats` · `/api/chat/actions/validate`(확인 카드 검증) · `/api/chat/:id/action`(카드 상태 저장)
- 아카이브: `/api/archive/status`(볼트 배지·마지막 쓰기·마지막 오류) · `/api/archive/flush`(지금 쓰기) · `/api/outputs`(정리 결과물 목록) · `/api/outputs/:id`(하나, 마크다운 포함) · `/api/outputs/:id/reveal`(Finder 에서 보기)
- 시작하기: `/api/setup`(점검 결과, `?refresh=1` 다시 확인) · `/api/setup/dismiss`(창 닫음 기록, `{dismissed:false}` 면 되돌림)
- 업데이트: `/api/update-check`(`{current, latest, source, update_available, checked_at, steps, error?, status}`, 10분 캐시, `?refresh=1` 은 새로 + 기록) · `/api/update/status`(자동 업데이트 상태: 설정·마지막/다음 확인·마지막 설치 시도) · `/api/update/install`(지금 업데이트, 202 시작 / 409 이유)
- 설정: `/api/config`(GET/PUT — 바뀐 키만, 충돌 시 409) · `/api/config/backups` · `/api/config/restore`(이전 설정으로 되돌리기)
- MCP: `/mcp`(POST — MCP Streamable HTTP, stateless·JSON 응답, 도구 `ned_attention` 외 5개. GET/DELETE 405 — 위 "MCP 서버")
- 공통: 모든 라우트(`/api/*`·`/mcp`·정적 파일)에서 Host·Origin 이 `loopback:데몬 포트` 가 아니거나 `Sec-Fetch-Site` 가 `same-origin`·`none` 이 아니면 403(다른 사이트에서 대시보드 페이지로의 최상위 이동은 `/api`·`/mcp` 밖이면 허용; DNS rebinding·다른 사이트·다른 포트 로컬 페이지 방지, Host 포트 생략도 거부)
