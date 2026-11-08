#!/usr/bin/env bash
# Self-hosted fork: brings in the official fixes from nightly-labs/openbot.
#
#   selfhost/scripts/sync-upstream.sh            # merge upstream/main into the current branch
#   selfhost/scripts/sync-upstream.sh --tag      # merge the newest upstream release tag (v*) instead
#
# The fork keeps its changes small and in few places (see selfhost/README.md), so a merge usually
# has no conflict. After the merge the script checks that every fork hook is still in place, and
# lists new vendor endpoints for review. Then rebuild: desktop, iOS, and the server bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/nightly-labs/openbot.git
[[ -z "$(git status --porcelain --untracked-files=no)" ]] ||
  { echo "Commit or stash your changes first." >&2; exit 1; }

echo "▸ Fetching upstream"
git fetch upstream --tags --quiet
TARGET=upstream/main
if [[ "${1:-}" == "--tag" ]]; then
  TARGET="$(git tag --list 'v*' --sort=-v:refname | head -1)"
  [[ -n "$TARGET" ]] || { echo "No upstream release tag." >&2; exit 1; }
fi
BEHIND="$(git rev-list --count "HEAD..$TARGET")"
if [[ "$BEHIND" == 0 ]]; then
  echo "✓ Already up to date with $TARGET"
  exit 0
fi
echo "▸ Merging $BEHIND upstream commits from $TARGET into $(git branch --show-current)"
if ! git merge --no-edit -m "Merge $TARGET into self-hosted fork" "$TARGET"; then
  echo
  echo "✗ Merge conflicts. Resolve them, keeping each 'Self-hosted fork' line, then:"
  echo "    git add -A && git commit --no-edit && selfhost/scripts/check-selfhost.sh"
  git diff --name-only --diff-filter=U | sed 's/^/    conflict: /'
  exit 1
fi

echo "▸ Dependencies"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null 2>&1 || true
fi
bun install --frozen-lockfile >/dev/null

echo "▸ Fork hooks"
set +e
selfhost/scripts/check-selfhost.sh
check=$?
set -e
[[ $check == 1 ]] && { echo "✗ Restore the missing hooks before you build." >&2; exit 1; }

echo "▸ Focused type checks"
bun run typecheck:node
bun run typecheck:renderer

cat <<'NEXT'

✓ Merged. Next:
  selfhost/desktop/build-dmg.sh                         # new DMG
  selfhost/ios/build-testflight.sh                      # new TestFlight build
  selfhost/server/scripts/deploy.sh <user@vps> --rebuild-auth-api   # when apps/auth-api, remote/ or migrations changed
  git push origin HEAD                                  # keep the fork on GitHub up to date
NEXT
