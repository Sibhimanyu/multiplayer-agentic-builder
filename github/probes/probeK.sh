#!/usr/bin/env bash
# Probe K -- follow-up to J. Three things J got wrong or could not distinguish.
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/K
rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
TREE=$(git rev-parse HEAD^{tree}); BASE=$(git rev-parse HEAD); SHA=$(git rev-parse HEAD)
TOK=$(gh auth token); REPO=Sibhimanyu/inventory-tracker-github
NS=refs/seq/head
mk() { git commit-tree "$TREE" -p "$BASE" -m "$1"; }   # distinct message -> distinct sha
clean() { git ls-remote origin 'refs/seq/*' 2>/dev/null | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null; }
clean

# ---------------------------------------------------------------- K1
# J1's second allocator got rc=0. Is that because the lease failed, or because
# pushing a sha to a ref that ALREADY equals that sha is a no-op?
{
echo "### K1  why did the losing allocator get rc=0?"
X=$(mk "alloc X"); Y=$(mk "alloc Y")
echo "X=$X  Y=$Y  (distinct commits)"
echo
echo "--- K1a  loser pushes the SAME sha the winner already installed ---"
git push -q origin "$X:$NS/0000000005"
echo "installed $NS/0000000005 -> X"
git push --force-with-lease="$NS/0000000005:" origin "$X:$NS/0000000005" 2>&1 | sed 's/^/    /'
echo "    rc=$?   <-- lease said 'must be ABSENT' and the ref EXISTS"
echo
echo "--- K1b  loser pushes a DIFFERENT sha to the same existing ref ---"
git push --force-with-lease="$NS/0000000005:" origin "$Y:$NS/0000000005" 2>&1 | sed 's/^/    /'
echo "    rc=$?"
echo "    ref -> $(git ls-remote origin "$NS/0000000005" | cut -f1)"
echo
echo "--- K1c  same question for a CLAIM ref (the primitive already reported verified) ---"
git push -q origin "$X:refs/claims/k-same"
git push --force-with-lease="refs/claims/k-same:" origin "$X:refs/claims/k-same" 2>&1 | sed 's/^/    /'
echo "    rc=$?   <-- same sha, existing claim ref"
git push --force-with-lease="refs/claims/k-same:" origin "$Y:refs/claims/k-same" 2>&1 | sed 's/^/    /'
echo "    rc=$?   <-- different sha, existing claim ref"
git push -q origin ":refs/claims/k-same" 2>/dev/null
} > "$O/k1-noop.txt" 2>&1
clean

# ---------------------------------------------------------------- K2
# J2 serialised instead of racing (attempts == seq for every allocator, which is
# the signature of a queue, not a collision). Force real simultaneity: every
# allocator pre-reads the counter, then all fire at a shared start barrier, and
# every allocator uses a DISTINCT commit so the K1a no-op cannot mask a loss.
ALLOC=12
git push -q origin "$SHA:$NS/0000000000"
START=$(python3 -c 'import time;print(time.time()+12)')   # fire together in 12s
for i in $(seq 1 $ALLOC); do
 (
  MYSHA=$(mk "allocator $i")
  # pre-read the counter BEFORE the barrier so every allocator starts from 0
  cur=$(git ls-remote origin "$NS/*" 2>/dev/null | awk '{n=split($2,p,"/"); print p[4]+0}' | sort -n | tail -1)
  python3 -c "
import time
t=$START-time.time()
if t>0: time.sleep(t)"
  attempts=0; got=""
  while [ $attempts -lt 60 ]; do
    attempts=$((attempts+1))
    next=$((cur+1)); nextp=$(printf '%010d' $next); curp=$(printf '%010d' $cur)
    if git push --atomic -q --force-with-lease="$NS/$nextp:" origin "$MYSHA:$NS/$nextp" ":$NS/$curp" 2>/dev/null; then
      # VERIFY we actually own it: the ref must carry OUR sha (order 0009)
      owner=$(git ls-remote origin "$NS/$nextp" | cut -f1)
      if [ "$owner" = "$MYSHA" ]; then got=$next; break; fi
      echo "$i FALSE_SUCCESS at $next (ref holds $owner not $MYSHA)" >> "$O/false-success.log"
    fi
    cur=$(git ls-remote origin "$NS/*" 2>/dev/null | awk '{n=split($2,p,"/"); print p[4]+0}' | sort -n | tail -1)
  done
  echo "${got:-NONE} $attempts" > "$O/alloc.$i"
 ) &
done
wait
{
echo "### K2  $ALLOC allocators fired from a shared barrier, each with a DISTINCT commit"
echo "allocator  seq  attempts"
for i in $(seq 1 $ALLOC); do printf '  %-8s %s\n' "$i" "$(cat "$O/alloc.$i")"; done
seqs=$(cat "$O/alloc".* | awk '$1 ~ /^[0-9]+$/ {print $1}' | sort -n)
n=$(echo "$seqs" | grep -c . ); u=$(echo "$seqs" | sort -nu | grep -c .)
echo
echo "allocated: $(echo $seqs | tr '\n' ' ')"
echo "count=$n distinct=$u expected=$ALLOC"
echo "attempts: $(cat "$O/alloc".* | awk '{print $2}' | sort -n | tr '\n' ' ')"
echo "false successes caught by the ownership re-check: $(wc -l < "$O/false-success.log" 2>/dev/null || echo 0)"
[ -f "$O/false-success.log" ] && sed 's/^/    /' "$O/false-success.log"
echo
if [ "$n" = "$u" ] && [ "$n" = "$ALLOC" ]; then echo "RESULT: PASS - $ALLOC distinct seqs, zero duplicates"; else echo "RESULT: FAIL"; fi
} > "$O/k2-barrier.txt" 2>&1
clean

# ---------------------------------------------------------------- K3
# J4 never ran (cloned a branch that existed only on the remote). Redo properly.
{
echo "### K3  does commit order on a shared branch preserve ALLOCATION order?"
git push -q origin "$SHA:refs/heads/probe-ledger" 2>/dev/null
rm -rf /tmp/ghprobe/w1 /tmp/ghprobe/w2
for w in w1 w2; do
  git clone -q --branch probe-ledger "https://github.com/$REPO.git" /tmp/ghprobe/$w
  ( cd /tmp/ghprobe/$w && git config user.email a@b.c && git config user.name x )
done
( cd /tmp/ghprobe/w1 && echo A > a.txt && git add a.txt && git commit -q -m "event A -- allocated FIRST" )
sleep 2
( cd /tmp/ghprobe/w2 && echo B > b.txt && git add b.txt && git commit -q -m "event B -- allocated SECOND" )
echo "commit timestamps:"
echo "   A: $(cd /tmp/ghprobe/w1 && git log -1 --format=%ci)"
echo "   B: $(cd /tmp/ghprobe/w2 && git log -1 --format=%ci)"
( cd /tmp/ghprobe/w2 && git push -q origin HEAD:probe-ledger ) && echo "B pushed first (it was allocated SECOND)"
echo "A's plain push:"
( cd /tmp/ghprobe/w1 && git push origin HEAD:probe-ledger 2>&1 | grep -E 'rejected|fetch first' | head -1 | sed 's/^/   /' )
( cd /tmp/ghprobe/w1 && git pull -q --rebase origin probe-ledger 2>/dev/null && git push -q origin HEAD:probe-ledger ) && echo "A pushed after pull --rebase"
echo
echo "resulting branch order, oldest commit first:"
( cd /tmp/ghprobe/w1 && git fetch -q origin && git log --format='   %h  %ci  %s' --reverse origin/probe-ledger | tail -3 )
echo
echo "and what the commit DATES say if you sort by them:"
( cd /tmp/ghprobe/w1 && git log --format='%ci|%s' origin/probe-ledger | head -2 | sort | sed 's/^/   /' )
} > "$O/k3-commit-order.txt" 2>&1
git push -q origin ":refs/heads/probe-ledger" 2>/dev/null
rm -rf /tmp/ghprobe/w1 /tmp/ghprobe/w2
clean
echo PROBE_K_DONE
