#!/usr/bin/env bash
# Probe D — WHEN exactly is the naive push unsafe? Refines the handoff's claim.
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/D
rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
BASE=$(git rev-parse HEAD); TREE=$(git rev-parse HEAD^{tree})

# Two SIBLING commits (agents working independently off the same base)
S1=$(git commit-tree "$TREE" -p "$BASE" -m "claim by agent_sib1")
S2=$(git commit-tree "$TREE" -p "$BASE" -m "claim by agent_sib2")
# A DESCENDANT of S1 (agent 2's branch tip happens to contain agent 1's commit)
D2=$(git commit-tree "$TREE" -p "$S1" -m "claim by agent_desc2")

{
echo "BASE=$BASE"; echo "S1=$S1  S2=$S2 (siblings)"; echo "D2=$D2 (child of S1)"; echo

echo "=== D1  naive push, second SHA is a SIBLING of the holder's ==="
git push -q origin "$S1:refs/claims/d-sib"; echo "holder set to S1"
git push origin "$S2:refs/claims/d-sib" 2>&1; echo "rc=$?"
echo "ref -> $(git ls-remote origin refs/claims/d-sib | cut -f1)"
git push -q origin ":refs/claims/d-sib"; echo

echo "=== D2  naive push, second SHA is a DESCENDANT of the holder's ==="
git push -q origin "$S1:refs/claims/d-desc"; echo "holder set to S1 ($(git log -1 --format=%s $S1))"
git push origin "$D2:refs/claims/d-desc" 2>&1; echo "rc=$?"
NOW=$(git ls-remote origin refs/claims/d-desc | cut -f1)
echo "ref -> $NOW  subject=\"$(git log -1 --format=%s $NOW)\""
if [ "$NOW" = "$D2" ]; then echo ">>> CLAIM SILENTLY STOLEN by fast-forward"; else echo ">>> holder retained"; fi
git push -q origin ":refs/claims/d-desc"; echo

echo "=== D3  LEASE push, same descendant case (the fix) ==="
git push -q origin "$S1:refs/claims/d-lease"; echo "holder set to S1"
git push --force-with-lease="refs/claims/d-lease:" origin "$D2:refs/claims/d-lease" 2>&1; echo "rc=$?"
NOW=$(git ls-remote origin refs/claims/d-lease | cut -f1)
echo "ref -> $NOW  subject=\"$(git log -1 --format=%s $NOW)\""
if [ "$NOW" = "$S1" ]; then echo ">>> holder retained, lease rejected the steal"; else echo ">>> LEASE FAILED TO PROTECT"; fi
git push -q origin ":refs/claims/d-lease"; echo

echo "=== D4  does the lease need a prior fetch of the ref? (client has NEVER seen it) ==="
git push -q origin "$S1:refs/claims/d-cold"
rm -rf .git/refs/remotes/origin 2>/dev/null; git update-ref -d refs/remotes/origin/main 2>/dev/null
echo "local remote-tracking refs: $(git for-each-ref refs/remotes | wc -l | tr -d ' ')"
git push --force-with-lease="refs/claims/d-cold:" origin "$S2:refs/claims/d-cold" 2>&1; echo "rc=$?"
NOW=$(git ls-remote origin refs/claims/d-cold | cut -f1)
echo "ref -> $NOW"; [ "$NOW" = "$S1" ] && echo ">>> rejected without any prior fetch. GOOD." || echo ">>> UNSAFE"
git push -q origin ":refs/claims/d-cold"; echo

echo "=== D5  releaseTask: can the holder delete its own claim? is delete idempotent? ==="
git push -q origin "$S1:refs/claims/d-rel"
echo "-- delete with a lease pinned to the holder's sha (only the owner can)"
git push --force-with-lease="refs/claims/d-rel:$S1" origin ":refs/claims/d-rel" 2>&1; echo "rc=$?"
echo "-- non-owner tries to delete (lease pinned to a sha it does not hold)"
git push -q origin "$S1:refs/claims/d-rel2"
git push --force-with-lease="refs/claims/d-rel2:$S2" origin ":refs/claims/d-rel2" 2>&1; echo "rc=$?"
echo "ref still -> $(git ls-remote origin refs/claims/d-rel2 | cut -f1)"
echo "-- owner deletes"
git push --force-with-lease="refs/claims/d-rel2:$S1" origin ":refs/claims/d-rel2" 2>&1; echo "rc=$?"
echo "-- delete again (idempotency: releasing what you do not own must be a no-op)"
git push --force-with-lease="refs/claims/d-rel2:$S1" origin ":refs/claims/d-rel2" 2>&1; echo "rc=$?"
git push origin ":refs/claims/d-rel2" 2>&1; echo "rc(plain delete of absent ref)=$?"
} > "$O/naive-vs-lease.txt" 2>&1
git fetch -q origin 2>/dev/null
echo "PROBE_D_DONE"
