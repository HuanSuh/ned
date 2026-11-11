# Changelog

Ned 플러그인(`ned@ned`) 버전 기록. 버전은 `.claude-plugin/plugin.json` 의 `version` — 올리는 규칙은 `docs/RELEASE.md`.

## 0.3.2 — 2026-11-11

- MIT 라이선스(`LICENSE`)를 설치본(main)에 포함. 플러그인 아이콘(`.claude-plugin/icon.png`) 추가.
- README 설치 안내: pnpm 은 `npm i -g pnpm`, GitHub 자격 증명은 레포가 비공개인 동안만.

## 0.3.1 — 2026-11-11

- 실행할 때 빈 "Ned Settings" 창이 깜빡이던 문제 제거 — 앱의 SwiftUI 장면을 메뉴 막대에 끼워 넣지 않는 `MenuBarExtra` 로 바꿈(열 장면이 없음).
  ⌘, 로 설정을 여는 경로는 없어짐 — 메뉴 "설정…" 사용.
- 대시보드 창은 화면에 띄운 뒤 앱을 활성화(순서 정리).

## 0.3.0 — 2026-11-11

- **데스크톱 펫**: 화면에 늘 떠 있는 작은 Ned(기본 꺼짐 — 설정 → 외형 → "데스크톱 펫"). 상태를 테두리 색·반사광 글로우로
  (쉼 중립 · 작업 중 민트 · 입력 기다림 주황 · 확인할 것 페르소나 색 · 오류 빨강 점선 · 연결 끊김 회색), 새 소식은 통신기처럼 말풍선으로.
  말풍선 종류별 토글 `pet.messages.*`(인사·작업·Slack·메일·Jira·GitHub·Sentry·캘린더·브리핑), 클릭 = 대시보드, 말풍선 클릭 = 그 링크,
  우클릭 = 대시보드 열기·펫 설정…·숨기기, 끌어서 이동·위치 초기화. 데몬 `GET /api/feed`.
- **메뉴 막대 간소화**: 상태 한 줄(마지막 점검·시작 중·꺼짐+다시 시작, 확인할 것 배지, 업데이트 있음) + 대시보드 열기·설정…·업데이트 확인·종료.
- **설정 → 앱(Ned.app)**: 자동 실행(Login Items)·실행 시 대시보드 열기·저장소 위치·로그·데몬 다시 시작 — 메뉴에서 옮김, 즉시 적용.
- **업데이트**: `GET /api/update-check`, 자동 확인(`updates.auto_check`, 24시간)·옵트인 자동 설치(`updates.auto_install`)·"지금 업데이트"
  (`scripts/self-update.sh`: `claude plugin marketplace update` → `claude plugin update ned@ned` → 새 버전 install.sh).
- 빈 "Ned Settings" 창이 실행 때 남지 않게(⌘, 는 설정 → 앱으로).

## 0.2.0 — 2026-11-11

- **시작하기(첫 실행 점검)**: `/ned:install` 이 빌드 전에 코드 서명 인증서("Ned Local Signing")를 만들지 묻고, 설치 뒤 소스별 연결 상태
  (claude.ai 커넥터·`gh`·Sentry)·Slack 팀 ID·서명을 표로 보여 주고, 처음 설치면 자동 실행(Login Item) 등록을 묻는다.
- 대시보드 **시작하기** 창: 준비 안 된 항목이 있으면 처음 열 때 자동으로 뜸(설정 → 시작하기로 다시 열기). 소스별 상태·"다시 확인"·
  Slack 팀 ID 입력·자동 실행 토글(Ned.app 창)·서명 상태. `GET /api/setup`, `POST /api/setup/dismiss`, CLI `setup-check [--json]`.
- Ned.app: `--login-item-register` / `--login-item-unregister`(헤드리스), 대시보드용 `loginItem` 브리지.

## 0.1.0 — 2026-11-11

첫 Claude Code 플러그인 배포.

- **설치 방식**: `/plugin marketplace add HuanSuh/ned` → `/plugin install ned@ned` → `/ned:install`. 세션 훅은 플러그인 `hooks/hooks.json`,
  데몬·Ned.app 은 `~/.ned/runtime/` 에서 각 Mac 이 빌드. `/ned:status`·`/ned:uninstall`. 예전 `settings.json` 훅은 설치 때 자동 제거.
- 기존 기능(이 버전에 포함): 로컬 대시보드(홈 일정·할 일·소스·팔로업 카드, 인박스·장비실, 타임라인), 순찰·아침 브리핑, 야간·유휴 감속,
  통신기 Ned Net(대화·메시지, 쓰기 확인 카드·세션 만들기), 답장 초안·쓰기 액션(Slack·Gmail·세션·Jira·GitHub·캘린더), 확인 완료·해제 이모지,
  검색 ⌘K, 수집 이력, Obsidian 아카이브, 링크를 앱(Slack·Figma·Notion)으로 열기, 메뉴 막대 앱(데몬 감독·알림·Login Items).
