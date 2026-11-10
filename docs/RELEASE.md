# 릴리스 규칙

Ned 는 Claude Code 플러그인으로 배포된다. 이 레포(`github.com/HuanSuh/ned`, private)가 곧 마켓플레이스다
(`.claude-plugin/marketplace.json`, 플러그인 source `./`). 사용자는 마켓플레이스의 **기본 브랜치(main)** 를 받는다.

## 브랜치

| 브랜치 | 역할 | 누가 쓰나 |
| --- | --- | --- |
| `dev` | 통합 브랜치. 워커 브랜치 → 리뷰 → `git merge --no-ff` → `git push origin dev` | 메인 세션, 동료 PR(대상 `dev`) |
| `main` | 설치본. 마켓플레이스 기본 브랜치 — `/plugin install`·`/plugin update` 가 받는 코드 | 승격 절차로만 바꾼다(fast-forward) |

- `main` 에 직접 커밋하지 않는다. 핫픽스·되돌리기도 `dev` 에서 커밋한 뒤 아래 승격 절차로 올린다. main 은 늘 dev 의 fast-forward 다.
- 동료 PR 은 `dev` 로. CI(`.github/workflows/test.yml`)는 `main`·`dev` push 와 PR 에서 돈다.

## 버전

- `.claude-plugin/plugin.json` 의 `version` 이 플러그인 버전이다. **이 값을 올려야 사용자의 `/plugin update ned` 가 새 코드를 받는다.**
  Claude Code 는 manifest `version` 을 업데이트 판단 기준으로 쓰고, 캐시 디렉터리 이름(`~/.claude/plugins/cache/ned/ned/<version>/`)으로도 쓴다.
  커밋만 쌓이고 version 이 같으면 "already at the latest version" 으로 아무것도 바뀌지 않는다.
- 루트 `package.json` 의 `version` 도 같은 값으로 맞춘다. 둘이 다르면 테스트(`plugin-manifest.test.ts`)가 실패한다.
- semver: 기능 = minor(0.1.0 → 0.2.0), 수정 = patch(0.1.0 → 0.1.1). 0.1.0 부터 시작.
- `marketplace.json` 의 플러그인 항목에는 version 을 두지 않는다. plugin.json 이 우선하고, 두면 validate 가 경고한다.
- 모든 버전은 `CHANGELOG.md` 에 항목을 남긴다(테스트가 현재 version 항목을 확인).

## 승격 (dev → main)

1. **이 Mac 에서 설치 확인** — 메인 세션이 dev 를 설치해 본다. **clean 워킹트리에서**(`git status` 가 비어 있음) 한다.
   로컬 경로로 추가한 마켓플레이스는 캐시 없이 워킹트리를 그대로 읽기 때문에, 커밋 안 한 변경까지 설치된다.
   ```sh
   git status --short                               # 비어 있어야 함
   claude plugin validate .                         # ✔ Validation passed (CLAUDE.md 경고만 — 플러그인 루트의 CLAUDE.md 는 로드 안 됨)
   pnpm test && pnpm -s build
   ```
   그다음 Claude Code 에서 다음 순서로 확인한다(아래 "설치 확인 체크리스트"):
   - `/plugin marketplace add <이 레포 경로>` → `/plugin install ned@ned` → **`/reload-plugins`** → `/ned:install` → `/ned:status`
   - `/reload-plugins` 를 해야 이 세션에 훅과 `/ned:*` 명령이 로드된다.

   확인이 끝나면 `/plugin marketplace remove ned` 후 `HuanSuh/ned` 로 다시 추가해 GitHub 마켓플레이스로 되돌린다.
2. **버전·변경 기록** — dev 에서 `.claude-plugin/plugin.json` 과 `package.json` 의 `version` 을 **둘 다** 올리고 `CHANGELOG.md` 에 항목을 쓴다 → 커밋 → `git push origin dev`.
3. **main 으로**:
   ```sh
   git checkout main
   git merge --ff-only dev
   git tag vX.Y.Z
   git push origin main --tags
   git checkout dev
   ```
   `--ff-only` 가 실패하면 main 에 dev 에 없는 커밋이 있다는 뜻이다. 그 커밋을 dev 로 옮긴 뒤 다시 한다.

## 사용자 측

- 처음: `/plugin marketplace add HuanSuh/ned` → `/plugin install ned@ned` → `/reload-plugins` → `/ned:install`.
  private 레포라 각 Mac 에 GitHub 접근 권한(gh 로그인 또는 git 자격 증명)이 있어야 한다.
- 업데이트: `/plugin update ned` → **`/reload-plugins`(또는 새 세션)** → `/ned:install`.
  실행 중인 세션은 로드해 둔 플러그인 버전을 계속 쓴다. 그래서 reload 없이 `/ned:install` 을 치면 옛 버전 경로에서 실행된다.
  `install.sh` 는 이것을 감지하고(옛 버전 디렉터리의 `.orphaned_at`, 또는 `installed_plugins.json` 의 installPath 와 불일치) "/reload-plugins 후 다시" 로 멈춘다.
- 자동 업데이트: 서드파티 마켓플레이스는 기본으로 꺼져 있어 수동으로 받는다. 켜려면 `/plugin` → Marketplaces → ned → Enable auto-update.
  자동 업데이트를 켜도 Ned.app 재빌드는 `/ned:install` 이 한다.
- 업데이트가 필요한지는 `/ned:status` 의 "⚠ 업데이트 필요"(런타임 버전 ≠ 플러그인 버전)로 안다.
- `/ned:install` 은 새 버전을 `~/.ned/runtime.next` 에서 끝까지 빌드한 뒤에만 기존 런타임·앱을 바꾼다.
  실패하면 기존 설치는 그대로 남는다. 로그는 `~/.ned/logs/install.log`.

## 되돌리기

main 은 dev 의 fast-forward 로만 움직이므로, 되돌리기도 **revert + patch 상향** 한 가지 방식으로 한다.
같은 version 문자열로는 사용자의 `/plugin update` 가 새 코드를 받지 않기 때문이다.

```sh
git checkout dev
git revert --no-edit <문제 커밋들>        # 예: 0.3.0 에서 들어온 커밋들
# plugin.json + package.json version 0.3.1, CHANGELOG "0.3.1 — 0.3.0 되돌림" → 커밋 → push → 승격 3단계
```

그다음 사용자에게 `/plugin update ned` → `/reload-plugins` → `/ned:install` 을 안내한다.

## 설치 확인 체크리스트 (메인 세션, 이 Mac)

1. `/ned:install` 출력(또는 `~/.ned/logs/install.log`)에 다음이 있어야 한다:
   - `plugin version` 줄이 `ok`(캐시 설치) 또는 `in-place`(로컬 마켓플레이스)
   - `synced (version X.Y.Z)`
   - `runtime.next → …/runtime`
   - `Removed N …` 또는 `No Ned hooks to remove`
   - `✓ Ned installed.`
2. 옛 훅 제거 확인:
   - `grep -c ned-hook.sh ~/.claude/settings.json` → 0. 남아 있으면 이벤트가 두 번 기록된다.
   - `/ned:status` 에 "old settings.json hooks: none ✓".
3. 플러그인 훅 확인: 새 Claude Code 세션을 열고 `tail -1 ~/.ned/events/$(date +%F).jsonl` 에 `"event": "SessionStart"` 가 **한 줄**만 있는지 본다.
4. `defaults read com.ned.menubar nedRepoPath` → `~/.ned/runtime`. 대시보드 `http://127.0.0.1:7777` 이 뜬다. `~/.ned/runtime.next`·`runtime.prev` 는 없어야 한다.
5. `/ned:status` → "✓ 런타임이 플러그인 버전과 같음", 그리고 "⚠ 로드된 플러그인이 설치본과 다름" 은 없어야 한다.

## 스모크 (설치 스크립트를 바꿨을 때)

`pnpm test` 의 `install-scripts.test.ts` 가 가짜 빌드(`NED_TEST_FAKE_BUILD`)·PATH 스텁으로 분기를 확인한다. 실제 pnpm·tsc·swift 빌드까지는 손으로 돌린다.
아래는 실제 앱·설정을 건드리지 않는 격리 실행이다(`NED_APP_DEST` 와 `NED_DEFAULTS_DOMAIN` 은 둘 다 바꿔야 한다):

```sh
T=$(mktemp -d)
export NED_HOME=$T/home NED_RUNTIME_DIR=$T/runtime NED_APP_DEST=$T/apps/Ned.app NED_DEFAULTS_DOMAIN=com.ned.menubar.test \
  NED_SKIP_OPEN=1 NED_PLUGIN_MODE=1 NED_CLAUDE_SETTINGS=$T/settings.json NED_CLAUDE_PLUGINS_DIR=$T/plugins
bash scripts/install.sh < /dev/null                      # 두 번 돌리면 업데이트 경로
NED_FAIL_AT=build bash scripts/install.sh < /dev/null    # 실패 주입: 기존 runtime·앱 유지, runtime.next 없음
bash scripts/uninstall.sh < /dev/null
rm -rf "$T"; defaults delete com.ned.menubar.test 2>/dev/null
```
