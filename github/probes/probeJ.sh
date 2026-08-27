#!/usr/bin/env bash
# Probe J -- seq ordering. The third unproven primitive.
# MB4: readEvents returns STRICTLY ASCENDING seq. Gaps legal, reordering is not.
# ROWID taught this project that "the obvious ordering key" can run backwards, so
# nothing here is assumed: every claim below is measured.
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/J
rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
TREE=$(git rev-parse HEAD^{tree}); BASE=$(git rev-parse HEAD)
SHA=$(git rev-parse HEAD)
TOK=$(gh auth token); REPO=Sibhimanyu/inventory-tracker-github
NS=refs/seq/head

cleanup() { git ls-remote origin 'refs/seq/*' 2>/dev/null | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null; }
cleanup

# ---------------------------------------------------------------- J1
# Is "create N+1 and delete N" expressible as ONE atomic compare-and-swap?
{
echo "### J1  --atomic + --force-with-lease(create-if-absent) + delete, in one push"
git push -q origin "$SHA:$NS/0000000001"
echo "seeded $NS/0000000001"
echo "-- advance 1 -> 2 (lease: 2 must be ABSENT, and delete 1) --"
git push --atomic --force-with-lease="$NS/0000000002:" origin "$SHA:$NS/0000000002" ":$NS/0000000001" 2>&1
echo "rc=$?"
echo "refs now: $(git ls-remote origin "$NS/*" | awk '{print $2}' | tr '\n' ' ')"
echo
echo "-- a SECOND allocator tries the same advance (1 -> 2) after the first won --"
git push --atomic --force-with-lease="$NS/0000000002:" origin "$SHA:$NS/0000000002" ":$NS/0000000001" 2>&1
echo "rc=$?  (must be non-zero: 2 already exists AND 1 is already gone)"
echo "refs now: $(git ls-remote origin "$NS/*" | awk '{print $2}' | tr '\n' ' ')"
} > "$O/j1-cas.txt" 2>&1
cleanup

# ---------------------------------------------------------------- J2
# 12 concurrent allocators. Every one must get a DISTINCT seq. No duplicates.
git push -q origin "$SHA:$NS/0000000000"
ALLOC=12
for i in $(seq 1 $ALLOC); do
 (
  attempts=0
  while [ $attempts -lt 40 ]; do
    attempts=$((attempts+1))
    cur=$(git ls-remote origin "$NS/*" 2>/dev/null | awk '{n=split($2,p,"/"); print p[4]+0}' | sort -n | tail -1)
    [ -z "$cur" ] && { sleep 0.3; continue; }
    next=$((cur+1)); nextp=$(printf '%010d' $next); curp=$(printf '%010d' $cur)
    if git push --atomic -q --force-with-lease="$NS/$nextp:" origin "$SHA:$NS/$nextp" ":$NS/$curp" 2>/dev/null; then
      echo "$next $attempts" > "$O/alloc.$i"; break
    fi
  done
  [ -f "$O/alloc.$i" ] || echo "EXHAUSTED $attempts" > "$O/alloc.$i"
 ) &
done
wait
{
echo "### J2  $ALLOC concurrent allocators on one counter ref"
echo "allocator  seq  attempts"
for i in $(seq 1 $ALLOC); do printf '  %-8s %s\n' "$i" "$(cat "$O/alloc.$i")"; done
seqs=$(cat "$O/alloc".* | awk '$1 ~ /^[0-9]+$/ {print $1}' | sort -n)
n=$(echo "$seqs" | wc -l | tr -d ' '); u=$(echo "$seqs" | sort -nu | wc -l | tr -d ' ')
echo
echo "allocated: $(echo $seqs | tr '\n' ' ')"
echo "count=$n distinct=$u"
[ "$n" = "$u" ] && [ "$n" = "$ALLOC" ] && echo "RESULT: PASS - every allocator got a distinct seq, zero duplicates" \
                                       || echo "RESULT: FAIL - duplicate or lost allocation"
echo "total attempts: $(cat "$O/alloc".* | awk '{print $2}' | paste -sd+ - | bc) for $ALLOC allocations"
} > "$O/j2-concurrent.txt" 2>&1
cleanup

# ---------------------------------------------------------------- J3
# Is the REST/ls-remote listing ordered, and is a LEXICAL sort safe?
git push -q origin "$SHA:refs/seq/probe/9" "$SHA:refs/seq/probe/10" "$SHA:refs/seq/probe/100" "$SHA:refs/seq/probe/2"
{
echo "### J3  is ref-name ordering safe? (the ZCQL 'text sorts \"100\" before \"9\"' trap)"
echo "-- git ls-remote, as returned --"
git ls-remote origin 'refs/seq/probe/*' | awk '{print "   "$2}'
echo "-- REST matching-refs, as returned --"
curl -sS -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/git/matching-refs/seq/probe/" \
  | python3 -c 'import sys,json; [print("   "+r["ref"]) for r in json.load(sys.stdin)]'
echo
echo "-- LEXICAL sort of the unpadded names --"
git ls-remote origin 'refs/seq/probe/*' | awk '{n=split($2,p,"/"); print p[4]}' | sort | tr '\n' ' '
echo
echo "-- NUMERIC sort of the same --"
git ls-remote origin 'refs/seq/probe/*' | awk '{n=split($2,p,"/"); print p[4]}' | sort -n | tr '\n' ' '
echo
} > "$O/j3-ordering.txt" 2>&1
git ls-remote origin 'refs/seq/probe/*' | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null

# ---------------------------------------------------------------- J4
# Does COMMIT ORDER on a branch preserve allocation order? (the ROWID question)
{
echo "### J4  can commit order on a shared branch be used as seq? "
git push -q origin "$SHA:refs/heads/probe-ledger" 2>/dev/null
rm -rf /tmp/ghprobe/w1 /tmp/ghprobe/w2
git clone -q --branch probe-ledger "$R" /tmp/ghprobe/w1 2>/dev/null
git clone -q --branch probe-ledger "$R" /tmp/ghprobe/w2 2>/dev/null
for w in w1 w2; do
  ( cd /tmp/ghprobe/$w && git remote set-url origin "https://github.com/$REPO.git" \
    && git config user.email a@b.c && git config user.name x && git fetch -q origin )
done
# A commits FIRST (t=0), B commits SECOND (t=1), but B pushes first.
( cd /tmp/ghprobe/w1 && echo A > a.txt && git add a.txt && git commit -q -m "event A allocated FIRST" )
sleep 1
( cd /tmp/ghprobe/w2 && echo B > b.txt && git add b.txt && git commit -q -m "event B allocated SECOND" )
( cd /tmp/ghprobe/w2 && git push -q origin HEAD:probe-ledger ) && echo "B pushed (second allocated, first pushed)"
( cd /tmp/ghprobe/w1 && git push origin HEAD:probe-ledger 2>&1 | grep -E 'rejected|fetch first' | head -1 )
( cd /tmp/ghprobe/w1 && git pull -q --rebase origin probe-ledger && git push -q origin HEAD:probe-ledger ) && echo "A pushed after pull --rebase"
echo
echo "-- resulting commit order on the branch (oldest first) --"
( cd /tmp/ghprobe/w1 && git fetch -q origin && git log --format='   %h %ci  %s' --reverse origin/probe-ledger | tail -3 )
echo
echo "Allocation order was A then B. If the log shows B before A, commit order"
echo "does NOT preserve allocation order and cannot be seq."
} > "$O/j4-commit-order.txt" 2>&1
git push -q origin ":refs/heads/probe-ledger" 2>/dev/null
rm -rf /tmp/ghprobe/w1 /tmp/ghprobe/w2
cleanup
echo "PROBE_J_DONE"
