# 릴리스 규칙

Ned 는 Claude Code 플러그인으로 배포된다. 이 레포(`github.com/HuanSuh/ned`, private)가 곧 마켓플레이스이고
(`.claude-plugin/marketplace.json`, 플러그인 source `./`), 사용자는 마켓플레이스의 **기본 브랜치(main)** 를 받는다.

## 브랜치

| 브랜치 | 역할 | 누가 쓰나 |
| --- | --- | --- |
| `dev` | 통합 브랜치. 워커 브랜치 → 리뷰 → `git merge --no-ff` → `git push origin dev` | 메인 세션, 동료 PR(대상 `dev`) |
| `main` | 설치본. 마켓플레이스 기본 브랜치 — `/plugin install`·`/plugin update` 가 받는 코드 | 승격 절차로만 바꾼다(fast-forward) |

- `main` 에 직접 커밋하지 않는다. 핫픽스도 `dev` 에서 고친 뒤 아래 승격 절차로 올린다.
- 동료 PR 은 `dev` 로.

## 버전

- `.claude-plugin/plugin.json` 의 `version` 이 플러그인 버전이다. **이 값을 올려야 사용자의 `/plugin update ned` 가 새 코드를 받는다**
  — Claude Code 는 manifest `version` 을 캐시 디렉터리 이름(`~/.claude/plugins/cache/ned/ned/<version>/`)이자 업데이트 판단 기준으로 쓰므로,
  커밋만 쌓이고 version 이 같으면 "already at the latest version" 으로 아무것도 바뀌지 않는다.
- semver: 기능 = minor(0.1.0 → 0.2.0), 수정 = patch(0.1.0 → 0.1.1). 0.1.0 부터 시작.
- `marketplace.json` 의 플러그인 항목에는 version 을 두지 않는다(plugin.json 이 우선하고 validate 가 경고함).
- 모든 버전은 `CHANGELOG.md` 에 항목을 남긴다.

## 승격 (dev → main)

1. **이 Mac 에서 설치 확인** — 메인 세션이 dev 를 설치해 본다. 로컬 마켓플레이스로 등록하면 캐시 없이 워킹트리를 그대로 읽는다:
   ```sh
   claude plugin validate .                         # ✔ Validation passed (CLAUDE.md 경고만 — 플러그인 루트의 CLAUDE.md 는 로드 안 됨)
   pnpm test && pnpm -s build
   ```
   그다음 Claude Code 에서 `/plugin marketplace add <이 레포 경로>` → `/plugin install ned@ned` → `/ned:install` → `/ned:status` 로 확인
   (아래 "설치 확인 체크리스트"). 확인 뒤 GitHub 마켓플레이스로 되돌릴 때는 `/plugin marketplace remove ned` 후 `HuanSuh/ned` 로 다시 추가.
2. **버전·변경 기록** — dev 에서 `plugin.json` 의 `version` 올리기 + `CHANGELOG.md` 항목 → 커밋 → `git push origin dev`.
3. **main 으로**:
   ```sh
   git checkout main
   git merge --ff-only dev
   git tag vX.Y.Z
   git push origin main --tags
   git checkout dev
   ```
   `--ff-only` 가 실패하면 main 에 dev 에 없는 커밋이 있다는 뜻 — main 에 직접 커밋한 것을 dev 로 옮긴 뒤 다시.

## 사용자 측

- 처음: `/plugin marketplace add HuanSuh/ned` → `/plugin install ned@ned` → `/ned:install`.
  private 레포라 각 Mac 에 GitHub 접근 권한(gh 로그인 또는 git 자격 증명)이 있어야 한다.
- 업데이트: `/plugin update ned` → `/ned:install`. 서드파티 마켓플레이스는 자동 업데이트가 기본 꺼짐이라 수동으로 받는다
  (켜려면 `/plugin` → Marketplaces → ned → Enable auto-update; 그래도 Ned.app 재빌드는 `/ned:install` 이 한다).
- 업데이트가 필요한지: `/ned:status` 의 "⚠ 업데이트 필요"(런타임 버전 ≠ 플러그인 버전).

## 되돌리기

main 을 이전 태그로 되돌리고 사용자에게 `/plugin update ned` → `/ned:install` 을 안내한다. 같은 version 문자열로는 업데이트가 안 되므로
되돌린 커밋 위에 **더 높은 patch 버전**을 붙여 다시 승격한다(예: 0.3.0 이 문제 → 0.2.0 코드에 version 0.3.1 + CHANGELOG "0.3.0 되돌림").

```sh
git checkout dev && git revert --no-edit <문제 커밋들>   # 또는 0.2.0 트리로 되돌리는 커밋
# plugin.json version 0.3.1 + CHANGELOG → 승격 절차 3
```

## 설치 확인 체크리스트 (메인 세션, 이 Mac)

1. `/ned:install` 출력에 `✓ Ned installed.` · `synced (version X.Y.Z)` · 옛 훅 `Removed N …` 또는 `No Ned hooks to remove`.
2. 옛 훅 제거 확인: `grep -c ned-hook.sh ~/.claude/settings.json` → 0 (있으면 이벤트 이중 기록). `/ned:status` 의 "old settings.json hooks: none ✓".
3. 플러그인 훅 확인: 새 Claude Code 세션을 열고 `tail -1 ~/.ned/events/$(date +%F).jsonl` 에 `"event": "SessionStart"` 가 **한 줄**.
4. `defaults read com.ned.menubar nedRepoPath` → `~/.ned/runtime`, 대시보드 `http://127.0.0.1:7777` 이 뜸.
5. `/ned:status` → "✓ 런타임이 플러그인 버전과 같음".

## 스모크 (설치 스크립트를 바꿨을 때)

실제 앱·설정을 건드리지 않는 격리 실행:

```sh
T=$(mktemp -d)
NED_HOME=$T/home NED_RUNTIME_DIR=$T/runtime NED_APP_DEST=$T/apps/Ned.app NED_DEFAULTS_DOMAIN=com.ned.menubar.test \
NED_SKIP_OPEN=1 NED_PLUGIN_MODE=1 NED_SKIP_HOOK_MIGRATION=1 bash scripts/install.sh < /dev/null
# 훅 마이그레이션까지: NED_SKIP_HOOK_MIGRATION 대신 NED_CLAUDE_SETTINGS=$T/settings.json
NED_HOME=$T/home NED_RUNTIME_DIR=$T/runtime NED_APP_DEST=$T/apps/Ned.app NED_DEFAULTS_DOMAIN=com.ned.menubar.test \
NED_PLUGIN_MODE=1 bash scripts/uninstall.sh < /dev/null
rm -rf "$T"; defaults delete com.ned.menubar.test 2>/dev/null
```
