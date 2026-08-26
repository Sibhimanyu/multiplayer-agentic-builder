#!/usr/bin/env bash
# Probe E — A9 shape: with a 20s timeout, ONLY the stopped agent flips stale.
# Order 0009: an assertion that cannot distinguish the bug from the fix is worthless.
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/E
rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
SHA=$(git rev-parse HEAD); NS=refs/heartbeats; TIMEOUT=20
now() { python3 -c 'import time;print(int(time.time()))'; }
AGENTS="agent_e0000001 agent_e0000002 agent_e0000003"
DEAD=agent_e0000003
DUR=70; HB=4

: > "$O/hb-latency.ms"
for a in $AGENTS; do
 (
  prev=""; start=$(now)
  while [ $(( $(now) - start )) -lt $DUR ]; do
    if [ "$a" = "$DEAD" ] && [ $(( $(now) - start )) -ge 12 ]; then
      echo "$(now) DIED" >> "$O/hb-$a.log"; break; fi
    ts=$(now)
    t0=$(python3 -c 'import time;print(time.time())')
    if [ -n "$prev" ]; then git push --atomic -q origin "$SHA:$NS/$a/$ts" ":$NS/$a/$prev" 2>>"$O/hb-$a.err"
    else git push -q origin "$SHA:$NS/$a/$ts" 2>>"$O/hb-$a.err"; fi
    rc=$?
    t1=$(python3 -c 'import time;print(time.time())')
    python3 -c "print(round(($t1-$t0)*1000))" >> "$O/hb-latency.ms"
    echo "$ts rc=$rc" >> "$O/hb-$a.log"; [ $rc = 0 ] && prev=$ts
    sleep $HB
  done
 ) &
done

(
 start=$(now)
 while [ $(( $(now) - start )) -lt $((DUR+5)) ]; do
   t=$(now)
   git ls-remote origin "$NS/agent_e*" 2>/dev/null | awk -v now="$t" -v to="$TIMEOUT" '
     { n=split($2,p,"/"); a=p[3]; ts=p[4]+0; if (ts>max[a]) max[a]=ts }
     END { s=""; for (a in max) s=s sprintf("%s=%s(%ds) ", a, ((now-max[a])>to?"STALE":"live"), now-max[a]);
           print s }' | sed "s/^/$(( t - start ))s /" >> "$O/reader.log"
   sleep 3
 done
) &
wait

{
 echo "### E — timeout=${TIMEOUT}s, ${DEAD} stops at t=12s, others heartbeat every ${HB}s for ${DUR}s"
 echo
 cat "$O/reader.log"
 echo
 echo "### discrimination check: at the END of the window..."
 tail -1 "$O/reader.log"
 last=$(tail -1 "$O/reader.log")
 ok=1
 echo "$last" | grep -q "${DEAD}=STALE" || { echo "MISS: dead agent not marked stale"; ok=0; }
 for a in $AGENTS; do
   [ "$a" = "$DEAD" ] && continue
   echo "$last" | grep -q "$a=live" || { echo "FALSE POSITIVE: live agent $a marked stale"; ok=0; }
 done
 [ $ok = 1 ] && echo "RESULT: PASS — exactly the stopped agent flipped, live agents unaffected" \
              || echo "RESULT: FAIL"
} > "$O/a9.txt" 2>&1

python3 - <<'PY' > "$O/hb-latency.txt"
v=sorted(float(x) for x in open('/tmp/ghprobe/out/E/hb-latency.ms'))
def p(q):
    i=(len(v)-1)*q; lo=int(i); hi=min(lo+1,len(v)-1); return v[lo]+(v[hi]-v[lo])*(i-lo)
print(f"heartbeat push (atomic create+delete): n={len(v)} min={v[0]:.0f} p50={p(.5):.0f} p90={p(.9):.0f} max={v[-1]:.0f} ms")
PY
git ls-remote origin "$NS/*" | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null
echo "PROBE_E_DONE"
