#!/usr/bin/env bash
# Probe L -- K1 redone. K1 piped git through sed, so every "rc=" it printed was
# SED's exit code, not git's. The adapter branches on that value, so it has to be
# measured without a pipe in the way.
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/L; rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
TREE=$(git rev-parse HEAD^{tree}); BASE=$(git rev-parse HEAD)
mk() { git commit-tree "$TREE" -p "$BASE" -m "$1"; }
X=$(mk "alloc X"); Y=$(mk "alloc Y")
NS=refs/seq/head
git ls-remote origin 'refs/seq/*' 'refs/claims/*' 2>/dev/null | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null

# no pipes: capture output and rc separately
try() { local label="$1"; shift; local out rc
  out=$("$@" 2>&1); rc=$?
  printf '%s\n  rc=%s\n  out: %s\n\n' "$label" "$rc" "$(echo "$out" | grep -vE '^To |^hint|^error: failed' | tr '\n' ' ' | sed 's/  */ /g')"
}
{
echo "### L  create-if-absent lease: what happens when the loser pushes the SAME sha"
echo "X=$X"; echo "Y=$Y"; echo
git push -q origin "$X:$NS/0000000005"
try "L1  ref EXISTS(->X), loser pushes X   (identical sha)" \
    git push --force-with-lease="$NS/0000000005:" origin "$X:$NS/0000000005"
try "L2  ref EXISTS(->X), loser pushes Y   (different sha)" \
    git push --force-with-lease="$NS/0000000005:" origin "$Y:$NS/0000000005"
echo "  ref still -> $(git ls-remote origin "$NS/0000000005" | cut -f1)"
echo
git push -q origin ":$NS/0000000005"
try "L3  ref ABSENT, pushes X              (the winning case)" \
    git push --force-with-lease="$NS/0000000005:" origin "$X:$NS/0000000005"
echo
echo "### same question on a CLAIM ref -- the primitive already reported verified"
git push -q origin "$X:refs/claims/l-same"
try "L4  claim held by X, challenger pushes X (identical sha)" \
    git push --force-with-lease="refs/claims/l-same:" origin "$X:refs/claims/l-same"
try "L5  claim held by X, challenger pushes Y (different sha)" \
    git push --force-with-lease="refs/claims/l-same:" origin "$Y:refs/claims/l-same"
echo
echo "### does --porcelain distinguish the no-op from a real create?"
git push -q origin ":$NS/0000000006" 2>/dev/null
echo "-- fresh create --"
git push --porcelain --force-with-lease="$NS/0000000006:" origin "$X:$NS/0000000006" 2>&1 | grep -v '^To '
echo "   rc=${PIPESTATUS[0]}"
echo "-- same sha again (the no-op) --"
out=$(git push --porcelain --force-with-lease="$NS/0000000006:" origin "$X:$NS/0000000006" 2>&1); rc=$?
echo "$out" | grep -v '^To '
echo "   rc=$rc"
} > "$O/lease-noop.txt" 2>&1
git ls-remote origin 'refs/seq/*' 'refs/claims/*' 2>/dev/null | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null
cat "$O/lease-noop.txt"
