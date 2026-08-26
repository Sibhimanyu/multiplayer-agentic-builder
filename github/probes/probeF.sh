#!/usr/bin/env bash
# Probe F — the LOSS path. claimTask must return {ok:false, owner, claimed_at}.
# The handoff says "read the owner from the ref's commit". That is an OBJECT read. Cost it.
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/F
rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
TOK=$(gh auth token); REPO=Sibhimanyu/inventory-tracker-github
TREE=$(git rev-parse HEAD^{tree}); BASE=$(git rev-parse HEAD)
OWNER=$(GIT_AUTHOR_DATE="2026-08-26T10:00:00Z" GIT_COMMITTER_DATE="2026-08-26T10:00:00Z" \
        git commit-tree "$TREE" -p "$BASE" -m "agent_f1234567")
git push -q origin "$OWNER:refs/claims/f-owner"
N=15
stats() { python3 -c "
import sys
v=sorted(float(x) for x in sys.stdin.read().split())
def p(q):
    i=(len(v)-1)*q; lo=int(i); hi=min(lo+1,len(v)-1); return v[lo]+(v[hi]-v[lo])*(i-lo)
print(f'n={len(v)} min={v[0]:.0f} p50={p(.5):.0f} p90={p(.9):.0f} max={v[-1]:.0f}')"; }

# F1 — ls-remote to get the sha (needed either way)
: > "$O/f1.ms"
for i in $(seq 1 $N); do
  s=$(python3 -c 'import time;print(time.time())'); git ls-remote origin refs/claims/f-owner >/dev/null 2>&1
  e=$(python3 -c 'import time;print(time.time())'); python3 -c "print(round(($e-$s)*1000))" >> "$O/f1.ms"; done

# F2 — git fetch the single claim object, then read its message locally
: > "$O/f2.ms"
for i in $(seq 1 $N); do
  git update-ref -d refs/probe/owner 2>/dev/null; rm -rf .git/objects/tmp_* 2>/dev/null
  s=$(python3 -c 'import time;print(time.time())')
  git fetch -q --no-tags origin "refs/claims/f-owner:refs/probe/owner" 2>/dev/null
  MSG=$(git log -1 --format='%s|%cI' refs/probe/owner 2>/dev/null)
  e=$(python3 -c 'import time;print(time.time())'); python3 -c "print(round(($e-$s)*1000))" >> "$O/f2.ms"; done

# F3 — one REST call: sha -> commit message + date, no local object download
: > "$O/f3.ms"
SHAV=$(git ls-remote origin refs/claims/f-owner | cut -f1)
for i in $(seq 1 $N); do
  s=$(python3 -c 'import time;print(time.time())')
  R3=$(curl -sS -H "Authorization: Bearer $TOK" "https://api.github.com/repos/$REPO/git/commits/$SHAV")
  e=$(python3 -c 'import time;print(time.time())'); python3 -c "print(round(($e-$s)*1000))" >> "$O/f3.ms"; done

# F4 — ONE REST call that returns ref AND owner together? (matching-refs is refs only)
: > "$O/f4.ms"
for i in $(seq 1 $N); do
  s=$(python3 -c 'import time;print(time.time())')
  curl -sS -H "Authorization: Bearer $TOK" "https://api.github.com/repos/$REPO/git/matching-refs/claims/" >/dev/null
  e=$(python3 -c 'import time;print(time.time())'); python3 -c "print(round(($e-$s)*1000))" >> "$O/f4.ms"; done

{
 echo "### F — cost of resolving {ok:false, owner, claimed_at} on the LOSS path"
 echo "owner commit message  : $MSG"
 echo "REST commit body      : $(echo "$R3" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["message"].strip(), "|", d["committer"]["date"])')"
 echo
 echo "F1 ls-remote one ref              $(stats < "$O/f1.ms") ms"
 echo "F2 git fetch that object + read   $(stats < "$O/f2.ms") ms"
 echo "F3 REST GET /git/commits/{sha}    $(stats < "$O/f3.ms") ms"
 echo "F4 REST GET /git/matching-refs/claims/  $(stats < "$O/f4.ms") ms"
 echo
 echo "NOTE: claimed_at above is the CLAIMANT's clock (commit date), not a server clock."
} > "$O/summary.txt" 2>&1
git push -q origin ":refs/claims/f-owner" 2>/dev/null; git update-ref -d refs/probe/owner 2>/dev/null
echo "PROBE_F_DONE"
