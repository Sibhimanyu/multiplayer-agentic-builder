#!/usr/bin/env bash
# Verify the cross-branch invariants by RUNNING them, not by reading.
#
# Order 0011, and it exists because of a defect this build shipped: my test files sat under
# shared/, so root `npm test` reported 25 tests here and 19 on the other branch. From inside
# either branch everything looked correct -- the script was fine, the suite passed. The
# divergence was only visible when the SAME command ran in both places.
#
# Reasoning that two files are identical is not evidence that two commands behave identically.
#
# Reference branch: the SHARED branch, not the other build's.
#   - it is the normative source for root package.json and tsconfig.json, which both builds are
#     frozen to, so matching it proves both builds match each other transitively
#   - and this workspace is under a standing instruction not to touch impl/catalyst at all.
#     Counting another branch's test output would be permissible per order 0011, but it is not
#     necessary to establish the invariant, and the narrower rule costs nothing here.
set -euo pipefail

REF="${XCHECK_REF:-origin/zoho-catalyst-app-builder}"
WT="$(mktemp -d -t xcheck-XXXXXX)"

cleanup() {
  git worktree remove "$WT" --force >/dev/null 2>&1 || true
  rm -rf "$WT" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "xcheck: reference = $REF"
git fetch origin --quiet
git worktree remove "$WT" --force >/dev/null 2>&1 || true
rmdir "$WT" 2>/dev/null || true
git worktree add -q "$WT" "$REF"

count() { grep -E '^ℹ tests ' | sed -E 's/[^0-9]*([0-9]+).*/\1/'; }

REF_N="$( cd "$WT" && npm install --silent >/dev/null 2>&1 && npm test 2>&1 | count )"
MINE_N="$( npm test 2>&1 | count )"

echo "xcheck: root 'npm test' -> reference $REF_N, this branch $MINE_N"

if [ "$REF_N" != "$MINE_N" ]; then
  echo "xcheck: FAIL -- root npm test does not run the same number of tests." >&2
  echo "  'Both builds pass the same tests' would be measured by two different commands." >&2
  echo "  Most likely cause: a test file under shared/. Move it into your own tree." >&2
  exit 1
fi

# Missing is drift (Order 0009): an absent or unparseable count is a violation, not a pass.
if [ -z "$REF_N" ] || [ -z "$MINE_N" ]; then
  echo "xcheck: FAIL -- could not read a test count from one side. Absent is a violation." >&2
  exit 1
fi

echo "xcheck: OK -- $MINE_N/$MINE_N on both sides, verified by running"
