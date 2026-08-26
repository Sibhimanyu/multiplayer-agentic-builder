#!/usr/bin/env bash
# Am I in bounds? See docs/reference/territory.md.
#
# A script rather than a pasted snippet, for the same reason xcheck.sh is one: a check that
# lives in prose gets run once, and a check that gets run once is a claim rather than a guard.
#
# Two distinct questions, deliberately reported separately because they need opposite responses:
#
#   1. Did I modify a frozen file?      -> a VIOLATION. Revert it, raise an order request.
#   2. Has the shared branch moved on?  -> not a violation at all. Just rebase.
#
# Diffing against the shared TIP conflates them, which is how the first published version of
# this check reported three frozen files changed on a branch that had touched none: it was
# simply one commit behind. Diffing from the MERGE-BASE shows only what this branch actually
# touched, however far the shared branch has moved.
set -euo pipefail

REF="${TERRITORY_REF:-origin/zoho-catalyst-app-builder}"

# Frozen per territory.md. The exclude matters: impl-<platform>-notes.md is per-build, and a
# check that flags a file its own table exempts cries wolf, and then stops being read.
FROZEN=(
  docs shared package.json tsconfig.json
  client/src/components.tsx client/src/tokens.css
  client/index.html client/tsconfig.json client/src/store/types.ts
  ':(exclude)docs/handoff/impl-*-notes.md'
)

git fetch origin --quiet

MB="$(git merge-base "$REF" HEAD)" || {
  echo "territory: FAIL -- no merge-base with $REF. Cannot establish what this branch touched." >&2
  exit 1
}

# Missing is drift: an unresolvable merge-base or an unreadable diff fails rather than passes.
if [ -z "$MB" ]; then
  echo "territory: FAIL -- empty merge-base. Absent is a violation, not 'nothing to check'." >&2
  exit 1
fi

VIOLATIONS="$(git diff --name-only "$MB" HEAD -- "${FROZEN[@]}")"
BEHIND="$(git rev-list --count "HEAD..$REF")"

echo "territory: merge-base $(git rev-parse --short "$MB"), behind $REF by $BEHIND commit(s)"

if [ -n "$VIOLATIONS" ]; then
  echo "territory: FAIL -- frozen paths modified by this branch:" >&2
  printf '  %s\n' $VIOLATIONS >&2
  echo "  Revert them and raise an order request instead." >&2
  exit 1
fi

echo "territory: OK -- no frozen path touched by this branch"
[ "$BEHIND" -gt 0 ] && echo "territory: note -- $BEHIND commit(s) behind $REF; rebase (not a violation)"
exit 0
