# Changelog

Ned 플러그인(`ned@ned`) 버전 기록. 버전은 `.claude-plugin/plugin.json` 의 `version` — 올리는 규칙은 `docs/RELEASE.md`.

## 0.1.0 — 2026-11-11

첫 Claude Code 플러그인 배포.

- **설치 방식**: `/plugin marketplace add HuanSuh/ned` → `/plugin install ned@ned` → `/ned:install`. 세션 훅은 플러그인 `hooks/hooks.json`,
  데몬·Ned.app 은 `~/.ned/runtime/` 에서 각 Mac 이 빌드. `/ned:status`·`/ned:uninstall`. 예전 `settings.json` 훅은 설치 때 자동 제거.
- 기존 기능(이 버전에 포함): 로컬 대시보드(홈 일정·할 일·소스·팔로업 카드, 인박스·장비실, 타임라인), 순찰·아침 브리핑, 야간·유휴 감속,
  통신기 Ned Net(대화·메시지, 쓰기 확인 카드·세션 만들기), 답장 초안·쓰기 액션(Slack·Gmail·세션·Jira·GitHub·캘린더), 확인 완료·해제 이모지,
  검색 ⌘K, 수집 이력, Obsidian 아카이브, 링크를 앱(Slack·Figma·Notion)으로 열기, 메뉴 막대 앱(데몬 감독·알림·Login Items).
