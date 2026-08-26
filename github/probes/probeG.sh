#!/usr/bin/env bash
# Probe G — per-operation claim latency, uncontended.
# Probe A's round_ms is the MAX of 20 concurrent pushes; that is a different number.
# v2: record rc per sample and DISCARD any round where the outcome was not the expected one.
# A push that fails fast still produces a timing; timing a failure as if it were a success is
# exactly the "intermittent test" failure order 0012 warns about.
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/G; rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
TREE=$(git rev-parse HEAD^{tree}); BASE=$(git rev-parse HEAD)
S=$(git commit-tree "$TREE" -p "$BASE" -m "agent_g0000001")
S2=$(git commit-tree "$TREE" -p "$BASE" -m "agent_g0000002")
git push -q origin "$S:refs/probe-objects/g1" "$S2:refs/probe-objects/g2" || { echo "PREP FAILED"; exit 1; }
N=30
ms() { python3 -c "print(round(($2-$1)*1000))"; }
nowf() { python3 -c 'import time;print(time.time())'; }
: > "$O/raw.tsv"
for i in $(seq 1 $N); do
  T="g2-r$i"
  a=$(nowf); git push -q --force-with-lease="refs/claims/$T:" origin "$S:refs/claims/$T"  2>/dev/null; rcw=$?
  b=$(nowf); git push -q --force-with-lease="refs/claims/$T:" origin "$S2:refs/claims/$T" 2>/dev/null; rcl=$?
  c=$(nowf); git push -q --force-with-lease="refs/claims/$T:$S" origin ":refs/claims/$T"  2>/dev/null; rcr=$?
  d=$(nowf)
  # expected: win rc=0, lose rc!=0, release rc=0. Anything else is a broken round.
  ok=1; [ $rcw -ne 0 ] && ok=0; [ $rcl -eq 0 ] && ok=0; [ $rcr -ne 0 ] && ok=0
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$T" "$ok" "$rcw" "$rcl" "$rcr" \
    "$(ms $a $b)" "$(ms $b $c)" "$(ms $c $d)" >> "$O/raw.tsv"
  [ $ok -eq 0 ] && git push -q origin ":refs/claims/$T" 2>/dev/null
done
python3 - <<'PY' > "$O/summary.txt"
rows=[l.split('\t') for l in open('/tmp/ghprobe/out/G/raw.tsv').read().splitlines()]
good=[r for r in rows if r[1]=='1']; bad=[r for r in rows if r[1]!='1']
def st(idx,label):
    v=sorted(float(r[idx]) for r in good)
    if not v: return f"{label}: NO VALID SAMPLES"
    def p(q):
        i=(len(v)-1)*q; lo=int(i); hi=min(lo+1,len(v)-1); return v[lo]+(v[hi]-v[lo])*(i-lo)
    return f"{label} n={len(v)} min={v[0]:.0f} p50={p(.5):.0f} p95={p(.95):.0f} max={v[-1]:.0f} ms"
print(f"rounds attempted={len(rows)}  valid={len(good)}  DISCARDED(wrong outcome)={len(bad)}")
for r in bad: print(f"  discarded {r[0]}: rc win={r[2]} lose={r[3]} release={r[4]}  ({r[5]}/{r[6]}/{r[7]} ms)")
print()
print(st(5,"claimTask  WIN  (lease accepted) "))
print(st(6,"claimTask  LOSE (lease rejected) "))
print(st(7,"releaseTask (pinned lease delete)"))
PY
git push -q origin ":refs/probe-objects/g1" ":refs/probe-objects/g2" 2>/dev/null
echo "PROBE_G_DONE"
