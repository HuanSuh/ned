# 결정 로그

지휘 세션이 사용자에게 되묻지 않고 내린 제품·설계 결정. 날짜 · 질문 · 결정 · 근거. 뒤집으려면 해당 줄을 고치고 새 WU 로.

## 2026-11-11 — WU-01 데스크톱 펫

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 기본으로 켤까? | 기본 꺼짐, 메뉴 토글 "데스크톱 펫 표시" | 업데이트한 기존 사용자 화면에 예고 없이 창이 뜨지 않게. 켜는 데 한 번이면 된다. |
| 설정 위치 | 앱 UserDefaults(`desktopPetEnabled`), config.yaml 키 없음 | 창·위치는 Ned.app 의 것이고 데몬이 알 필요가 없다. Login Item 토글과 같은 자리. |
| 그리는 방식 | SwiftUI NSPanel(비활성 패널, 모든 공간) | WKWebView 보다 가볍고 항상 떠 있는 창에 맞다. 대시보드 서버가 꺼져도 offline 표정을 보여야 한다. |
| 캐릭터 | 기존 페르소나 마크 재사용, 새 에셋 없음 | 브랜드 일관성, 페르소나 전환을 그대로 따름. 에셋 제작은 별도 결정. |
| 상태 우선순위 | offline > 오류 > 입력 기다림 > 확인할 것 N > 작업 중 > 쉼 | 사람이 지금 손대야 하는 것부터. Codex pets 의 Blocked/Needs input/Running/Ready 와 대응. |
| 워커 세션 | 입력 기다림에서 제외(`is_worker`) | 메뉴·알림과 같은 규칙 — Orca 워커는 지휘 세션이 받는다. |
| 말풍선 | 상태가 바뀔 때 4–6초, 호버로 다시 | 늘 떠 있는 창이 계속 말하면 방해된다. |
| 데몬 변경 | 없음(StateStore 데이터만) | 범위를 앱 하나로 묶어 WU 를 독립적으로. |
| (워커 보고 후) 통신기 메뉴 | 우클릭 메뉴에 넣지 않음 | 앱에서 통신기를 여는 경로가 아직 없다. 생기면 추가. |
| (워커 보고 후) 워커 세션 집계 | 입력 기다림에서만 제외, 오류·작업 중에는 포함 | 워커 오류는 사용자도 알아야 하고, 작업 중 개수는 실제 일하는 세션 수. |
| (워커 보고 후) 배지 | 확인할 것 N 배지는 더 높은 상태에서도 함께 표시 | 오류·입력 대기 중에도 쌓인 확인 거리를 놓치지 않게. |

## 2026-11-11 — WU-02 데스크톱 펫 2차

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| "앱 설정 메뉴"는 어디? | 대시보드 설정 → 외형 "데스크톱 펫", 원본은 config.yaml `pet.*`. 메뉴 토글은 같은 키를 데몬 API 로 바꿈 | 메시지 종류별 토글까지 담을 화면은 설정 탭뿐이고, 원본이 둘이면 어긋난다. WU-01 의 UserDefaults 키는 배포 전이라 바로 없앰. |
| 움직임 | 바운스·흔들기 제거, 테두리 글로우 느린 숨쉬기(≥3s)만 | "경박하다" — 위치 이동 없이 빛으로만 상태를 알린다. |
| 👋 이모지 | 캐릭터 위 이모지 오버레이 전부 제거 | 의미가 안 읽힘. 테두리 색 + 말풍선 SF Symbol·문구로 충분. |
| 대화형 메시지 데이터 | 데몬 `GET /api/feed` 신설, 통신기 buildFeed 와 같은 결과를 테스트로 묶음 | Swift 에 분류 규칙을 복제하면 통신기와 어긋난다. 대시보드 교체는 범위 밖(동작 변화 위험). |
| 메시지 종류 | greeting·session·slack·mail·jira·github·calendar·briefing (≤10, 워커가 데이터 보고 확정) | 사용자가 든 예(Slack·인사·메일) + 실제 피드 출처. |
| 종류 토글의 범위 | 말풍선만 끔, 테두리 색·배지는 그대로 | 상태는 늘 보여야 하고, 토글은 "말 걸기"를 줄이는 용도. |

## 2026-11-11 — WU-03 메뉴 막대 간소화

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 메뉴에 남길 것 | 상태 한 줄(점 + "마지막 점검 N분 전"/시작 중/꺼짐+다시 시작, 확인할 것 배지 숫자) + 대시보드 열기·설정…·업데이트 확인·종료 | 사용자 요청 그대로. 목록류는 대시보드에 이미 있다. |
| 옮길 곳 | 대시보드 설정 탭 새 "앱(Ned.app)" 묶음, 앱 브리지로 즉시 적용 | Login Item·실행 동작·저장소 위치는 앱(UserDefaults) 것이라 config.yaml 에 두지 않는다. 온보딩 loginItem 브리지와 같은 패턴. |
| 업데이트 확인 방식 | 데몬 `GET /api/update-check`: gh api(private 레포) → 로컬 마켓플레이스 클론 폴백, 설치는 하지 않고 Claude Code 명령 안내 | 업데이트는 `/plugin update`→`/reload-plugins`→`/ned:install` 흐름이어야 한다(docs/RELEASE.md). |
| WU-02 와 겹침 | 메뉴 펫 토글은 WU-02 가 지우고 펫 On/Off 는 설정 → 외형 `pet.enabled` 하나 | 같은 파일 동시 수정 최소화, 설정 원본 하나. |
| (사용자 추가) 펫 옵션 위치 | 펫 옵션 편집은 설정 → 외형 "데스크톱 펫" 하나(켜기·종류 토글·위치 초기화), 우클릭 = 대시보드 열기·펫 설정…·숨기기(=pet.enabled false 저장) | "펫 옵션도 최대한 앱 내 설정 메뉴로". 앱에 남는 펫 상태는 위치·본 메시지 키뿐. |
| (WU-02 질문) sentry·other 종류 | sentry = 9번째 토글(소스 꺼져 있으면 비활성), other = 토글 없이 항상 표시, 통신기 chatNotes 는 /api/feed 에서 제외 | 실제 attention kind 에 sentry·other 가 있다. other 는 드물고 분류가 안 된 것이라 끌 이유가 약함. chatNotes 는 브라우저 localStorage 에만 있다. |

## 2026-11-11 — WU-03 추가: 자동 업데이트

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 범위 | 자동 확인(기본 켬, 24시간) + 자동 설치(옵트인, 기본 끔) + 수동 "지금 업데이트" | 사용자 선택 "확인+자동설치". |
| 설정 위치 | config.yaml `updates.*`, 설정 → 앱 묶음 "업데이트" 소묶음(하단 저장) | 데몬 스케줄러가 돌리는 일이라 config 가 원본. |
| 설치 방식 | 분리된 `scripts/self-update.sh`: `claude plugin marketplace update` → `claude plugin update ned@ned` → 새 캐시의 install.sh | `/plugin update`→`/ned:install` 과 같은 결과를 Claude Code 창 없이. install.sh 가 앱·데몬을 내리므로 분리 실행. |
| 자동 설치 조건 | 조용한/유휴 시간 + 실행·입력 대기 세션 없음 + 최근 실패 24시간 경과 | 몇 분 빌드·앱 재시작이 작업을 끊지 않게. |
| 설치 후 | 앱 재시작 시 결과 알림, 성공이면 "열린 세션은 /reload-plugins" | 열린 Claude Code 세션은 옛 플러그인 훅을 쓴다. |
| (WU-03 질문) 낡은 "메뉴 > Login Items" 안내 | WU-03 이 온보딩·install.md·README·FEATURES 의 해당 문구를 "설정 → 앱(Ned.app)"으로 함께 고침(문구만) | 메뉴에서 토글이 사라지면 안내가 틀린다. 같은 변경 단위. |

## 2026-11-11 — WU-02 검토 후 수정

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 상태색 | 쉼 = 중립(글로우 없음), 작업 중 = 페르소나 보조색(ned 민트), 확인할 것·메시지 = accent, 입력 기다림 = 주황, 오류 = 빨강 점선 강하게, 끊김 = 회색 | Ned accent 가 빨강이라 모두 빨간 글로우 → 경보로 읽히고 구분 불가(스냅샷 검토). |
| 입력 기다림 아이콘 | hand.raised 대신 입력을 뜻하는 심볼(keyboard 등) | 사용자가 손 이모지 의미를 모르겠다고 함. |

## 2026-11-11 — 직접 수정

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 빈 "Ned Settings" 창 | SwiftUI Settings 장면 내용을 SettingsRedirect 로: 실행 5초 안이면 닫기만, 그 뒤(⌘, 등)면 닫고 설정 → 앱 | 앱 설정은 대시보드에 있다. 띄운 원인을 못 찾아 경로와 무관하게 막고 로그로 추적. |
| 펫 글로우 (WU-02 "≥3초 숨쉬기" 뒤집음) | 반경 2↔6 반사광, 1.6초 주기 | 사용자: 넓은 글로우는 과하고, 좁게·빠르게. |

## 2026-11-11 — Ned MCP 서버 (워커 ned-mcp)

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 트랜스포트 | 데몬 안 Streamable HTTP `/mcp`(stateless·JSON 응답), 플러그인 `.mcp.json` 은 `type: http` | 런타임 경로(`~/.ned/runtime`)·node 위치 문제가 없는 http 가 stdio 보다 단순하고, 데몬이 꺼져 있으면 도구가 그냥 없다. SDK 가 웹 표준 Request/Response 트랜스포트를 줘서 hono 에 바로 붙는다. 세션 상태가 필요 없어 stateless. |
| 포트 | `.mcp.json` 은 7777 고정, 다른 포트는 `claude mcp add` 수동 | 문서상 플러그인 MCP 설정에서 확실히 치환되는 건 `${CLAUDE_PLUGIN_ROOT}`·`${CLAUDE_PLUGIN_DATA}`·`${CLAUDE_PROJECT_DIR}` 뿐(`${VAR:-default}` 는 `.mcp.json` 일반 설명에만 있음) — 깨지면 모두에게 깨지니 확실한 쪽. (리뷰 후 검토) `${user_config.port}` 는 MCP 설정에서 치환된다고 문서에 있어 설정 가능하지만, `userConfig` 는 플러그인 활성화 때 모든 사용자에게 입력을 묻고 Claude Code 버전 요구도 따라와 보류 — 다른 포트는 `claude mcp add`. |
| 쓰기 범위 | `ned_mark_reviewed`(✓) 하나. 보내기·초안·세션 만들기는 후속 | ✓ 는 로컬 표시라 되돌릴 수 있고 대시보드와 같은 함수(`src/review.ts`)를 쓴다. 외부로 나가는 쓰기는 대시보드의 확인 단계·설정 토글 없이 열지 않는다. |
| 보안 | 127.0.0.1 바인딩 + loopback 이 아닌 Host·Origin 403, 인증 없음. (리뷰 후) 가드를 `src/request-guard.ts` 공용 미들웨어로 올려 `/api/*`·`/mcp`·정적 파일 모두에 건다 | DNS rebinding 은 `/api/*`(쓰기 포함)에도 같은 위협. 대시보드·Ned.app WKWebView(Origin `http://127.0.0.1:7777`)·status.sh·curl 은 모두 loopback 이라 호환. SDK 의 `allowedOrigins` 는 deprecated 라 직접 검사. |

## 2026-11-11 — 세션에 답하기 (대시보드 세션 행 · 펫 말풍선)

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 빠른 버튼 기본값·한도 | `dashboard.session_quick_replies` = ㄱㄱ · 승인 · 계속, 5개 · 20자까지, [] 허용(입력만) | 작업 지시대로. 펫·대시보드가 같은 값(`/api/feed` `quick_replies`). |
| 답한 뒤 알림 억제 | 전송 성공 시 그 세션의 현재 알림을 `dismissAttention` 과 같은 기록(alert_ts)으로 내림 — 새 Notification 이 오면 다시 뜸 | N초 타이머보다 정확하고 새 코드가 없다. 권한 프롬프트에 답하면 UserPromptSubmit 이 안 와서 "running 될 때까지" 규칙은 못 씀. |
| `can_reply` | 훅 이벤트에 `orca_pane`/`orca_tab` 이 한 번이라도 있었나(2일 이벤트 기준). 지금 열려 있나는 전송 때 409 | 상태마다 `orca terminal list` 를 돌리지 않으려고. |
| 텍스트 | session 만 2,000자, CRLF→LF, 앞뒤 공백·끝 줄바꿈 제거(Enter 는 `--enter` 한 번), 안 줄바꿈은 유지 | 끝 줄바꿈이 두 번째 Enter 가 되지 않게. 대시보드·펫 입력은 한 줄이라 안 줄바꿈은 대화창 제안에서만. |
| 펫 포커스 | 패널은 입력 모드에서만 `allowKey` + `makeKey`(비활성 패널 → 앱 활성화 없이 키보드). 0.15초 뒤에도 key 가 아니면 그때만 `NSApp.activate`, 닫을 때 앞 앱 복귀 | 다른 앱 포커스를 불필요하게 뺏지 않기. 실기 확인은 사용자 몫(GUI 자동화 금지). |
| 펫 클릭 처리 | 말풍선 위 히트 뷰가 컨트롤 프레임(PetControl id)으로 판정, 입력칸만 실제 NSTextField | 기존 PetBubbleHitView 구조 유지(SwiftUI 버튼은 히트 뷰에 가려짐). |
| (리뷰) 권한 프롬프트 | permission_prompt·elicitation_dialog 대기 세션엔 답하기 UI 없이 "터미널에서 직접 선택", 데몬도 409 | Claude Code 문서(keybindings Confirmation: Enter = confirm:yes, Esc = confirm:no, ↑↓ 이동; permissions: 선택지 Yes / Yes, don't ask again / (가끔) switch to auto mode / No)에 숫자 키 선택이 없고 선택지 순서도 바뀐다 → "1"·"2" 버튼은 보류. 데몬 거절은 초안 팝업·대화창 경로까지 막으려고. |
| (리뷰) 펫 포커스 반환 | 열 때 앞 앱 기록 → 닫을 때 Ned 가 아직 키보드를 쥐고 있으면 그 앱 activate(폴백으로 Ned 를 활성화했으면 yieldActivation 먼저). 다른 앱을 눌러 key 를 잃으면 입력을 닫고 글 보존, 재활성화 없음 | resignKey() 는 알림 메서드라 key 를 넘기지 않는다. 사용자가 고른 앱을 다시 빼앗지 않기. |
| (리뷰) 워커 세션 | 펫은 워커 세션에 답하기 없음, 대시보드 장비실은 있음 | 펫 상태 색이 워커를 빼는 규칙과 맞춤. 대시보드에선 워커도 보이는 행이라 거기서 답하는 건 허용. |

## 2026-11-14 — WU-05 맡긴 일 (상세: 로컬 `.omc/wu/WU-05/decisions.md`)

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| 원본 | `config.yaml responsibilities`(≤5) | 설정 원본 하나. |
| 평가 방식 | 기존 순찰·브리핑 출력에 선택 필드 `responsibilities`, 책임이 없으면 프롬프트 바이트 동일 | 별도 LLM 호출 없이 비용 유지. |
| 알림 | 새 kind 없음, 막힘은 `action_items` 로 | 펫·알림·피드 kind 목록 유지. |
| 표시 | 홈 위 얇은 띠(책임 있을 때만) | 그리드 레이아웃 마이그레이션 회피. |
| (리뷰) 근거 없을 때 | 순조가 아니라 지난 상태 유지(id 생략), 이미 알린 근거는 `[이미 알림]` 으로 남김(목록당 5, 새 항목 자리 안 먹음) | 막힘이 다음 순찰에 순조로 덮이던 문제. |

## 2026-11-14 — WU-04 공개 레포 정리 (상세: 로컬 `.omc/wu/WU-04/decisions.md`)

| 질문 | 결정 | 근거 |
| --- | --- | --- |
| Origin/Host | loopback + 데몬이 실제 listen 하는 포트만, 포트 없는 Host 거부 | 같은 Mac 의 다른 포트 로컬 페이지가 API 를 부르는 경로 차단. |
| (리뷰) 비용 있는 GET | `Sec-Fetch-Site` 가 있으면 same-origin·none 만(헤더 없는 curl·URLSession·MCP 는 허용) | `<img src>` 같은 no-cors GET 은 Origin 이 없어 `/api/calendar`(LLM 비용) 등을 부를 수 있었다. 다른 포트 127.0.0.1 은 same-site 라 거부. |
| 외부 링크로 대시보드 열기 | GET/HEAD + navigate + document 이고 `/api`·`/mcp` 밖이면 허용 | 정적 페이지는 부수효과 없음, Slack·Notion 링크로 대시보드를 못 여는 회귀 방지. |
| 업데이트 확인 | raw.githubusercontent → gh → 로컬 클론, 응답 64KiB 상한 | 레포 public, gh 로그인 없는 사용자. raw 내용은 버전 비교에만 쓰고 설치는 마켓플레이스 경로. |
| 취약점 제보 | GitHub Private vulnerability reporting(켜 둠), `SECURITY.md` | 공개 이슈로 취약점이 드러나지 않게. |
