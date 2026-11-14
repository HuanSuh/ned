# 보안 정책 / Security Policy

## 지원 버전 / Supported versions

최신 `main`(플러그인 마켓플레이스가 설치하는 버전)만 보안 수정을 받는다. 이전 버전은 업데이트(`/plugin update ned` → `/reload-plugins` → `/ned:install`)로 받는다.

Only the latest `main` (what the plugin marketplace installs) receives security fixes. Older installs get them by updating.

## 제보 / Reporting a vulnerability

공개 이슈로 올리지 말고, GitHub 의 **Security → Report a vulnerability**(Private vulnerability reporting)로 비공개 제보한다.
재현 단계, 영향, 확인한 버전(`.claude-plugin/plugin.json` 의 `version`)을 적어 주면 좋다. 확인 후 답하고, 수정은 새 버전으로 낸다.

Please do not open a public issue. Report privately via GitHub **Security → Report a vulnerability** (Private vulnerability reporting),
with steps to reproduce, impact, and the version you tested (`version` in `.claude-plugin/plugin.json`).

## 범위 / Scope

범위 안 / In scope:
- 로컬 데몬 — `127.0.0.1` 의 대시보드·`/api/*`·`/mcp` (예: DNS rebinding·다른 출처에서의 호출, 쓰기 액션 게이트 우회)
  / the local daemon on `127.0.0.1`: dashboard, `/api/*`, `/mcp` (e.g. DNS rebinding, cross-origin calls, bypassing write-action gates)
- 다른 사이트·같은 Mac 의 다른 포트 페이지가 브라우저로 일으키는 부수효과 있는 요청(예: `<img>` 로 비용이 드는 GET 반복 호출)
  / side-effecting requests a page on another site or another local port triggers through the browser (e.g. costly GETs via `<img>`)
- Ned.app (메뉴 막대 앱, WKWebView 브리지) / Ned.app (menu bar app, WKWebView bridges)
- 설치·업데이트 스크립트 (`scripts/*.sh`, `/ned:install`, 자동 업데이트) / install and update scripts

범위 밖 / Out of scope:
- claude.ai 커넥터(Slack·Gmail·Google Calendar·Atlassian·GitHub)와 Claude Code 자체 — 각 제공자에게 제보한다
  / claude.ai connectors and Claude Code itself — report those to their providers
- 이 Mac 의 사용자 계정을 이미 가진 공격자(로컬 사용자 권한으로 `~/.ned` 를 읽거나 쓰는 것)
  / an attacker who already controls the local user account (reading or writing `~/.ned` as that user)
