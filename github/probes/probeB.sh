#!/usr/bin/env bash
# Probe B — presence via timestamp-in-ref-name heartbeats. Correctness only; latency is probeC.
set -u
R=/tmp/ghprobe/repo
O=/tmp/ghprobe/out/B
rm -rf "$O"; mkdir -p "$O"
cd "$R" || exit 1

SHA=$(git rev-parse HEAD)
NS=refs/heartbeats

now() { python3 -c 'import time;print(int(time.time()))'; }
nowms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# ---- B-1: is the create+delete pair expressible as ONE atomic push? -----------
{
  echo "### B-1 single --atomic push: create new ts ref AND delete old ts ref"
  A=agent_b0000001
  T1=$(now)
  git push -q origin "$SHA:$NS/$A/$T1" && echo "seed ok ts=$T1"
  sleep 1
  T2=$(now)
  echo "--- git push --atomic origin \$SHA:$NS/\$A/$T2 :$NS/\$A/$T1"
  git push --atomic origin "$SHA:$NS/$A/$T2" ":$NS/$A/$T1" 2>&1
  echo "rc=$?"
  echo "--- refs now:"
  git ls-remote origin "$NS/$A/*"
  git ls-remote origin "$NS/$A/*" | awk '{print $2}' | xargs -I{} echo ":{}" | xargs -r git push -q origin
} > "$O/b1-atomic.txt" 2>&1

# ---- B-2: 5 agents heartbeating concurrently, 1 reader polling ---------------
DUR=40
HB_INT=3
AGENTS="agent_b1000001 agent_b1000002 agent_b1000003 agent_b1000004 agent_b1000005"
STOP_AT=20   # agent 5 stops heartbeating after this many seconds -> must go stale

for a in $AGENTS; do
  (
    prev=""
    start=$(now)
    while :; do
      el=$(( $(now) - start ))
      [ "$el" -ge "$DUR" ] && break
      if [ "$a" = "agent_b1000005" ] && [ "$el" -ge "$STOP_AT" ]; then break; fi
      ts=$(now)
      if [ -n "$prev" ]; then
        git push --atomic -q origin "$SHA:$NS/$a/$ts" ":$NS/$a/$prev" 2>>"$O/hb-$a.err"
      else
        git push -q origin "$SHA:$NS/$a/$ts" 2>>"$O/hb-$a.err"
      fi
      rc=$?
      echo "$(nowms) push rc=$rc ts=$ts prev=$prev" >> "$O/hb-$a.log"
      [ "$rc" = "0" ] && prev="$ts"
      sleep "$HB_INT"
    done
    echo "$(nowms) stopped" >> "$O/hb-$a.log"
  ) &
done

# reader: ls-remote only, never fetch. timestamp comes from the ref NAME.
(
  start=$(now)
  while [ $(( $(now) - start )) -lt $((DUR+15)) ]; do
    t=$(now)
    raw=$(git ls-remote origin "$NS/*" 2>/dev/null)
    line=$(echo "$raw" | awk -v now="$t" '
      $2 ~ /^refs\/heartbeats\// {
        n=split($2,p,"/"); a=p[3]; ts=p[4]+0;
        if (ts>max[a]) max[a]=ts; cnt[a]++
      }
      END {
        for (a in max) printf "%s:hb=%d:age=%d:refs=%d:stale=%s ", a, max[a], now-max[a], cnt[a], ((now-max[a])>90?"true":"false")
      }')
    echo "$(nowms) $line" >> "$O/reader.log"
    sleep 2
  done
) &
wait

# ---- B-3: derived staleness at read time, with an injected clock -------------
{
  echo "### B-3 staleness derived from ref name only, no object reads"
  now=$(now)
  git ls-remote origin "$NS/*" | awk -v now="$now" '
    $2 ~ /^refs\/heartbeats\// { n=split($2,p,"/"); a=p[3]; ts=p[4]+0; if (ts>max[a]) max[a]=ts }
    END { for (a in max) printf "%s last_heartbeat_at=%d age_s=%d stale@90s=%s\n", a, max[a], now-max[a], ((now-max[a])>90?"true":"false") }'
  echo "--- same set, evaluated against a clock advanced by 120s (A9 shape) ---"
  future=$((now+120))
  git ls-remote origin "$NS/*" | awk -v now="$future" '
    $2 ~ /^refs\/heartbeats\// { n=split($2,p,"/"); a=p[3]; ts=p[4]+0; if (ts>max[a]) max[a]=ts }
    END { for (a in max) printf "%s age_s=%d stale@90s=%s\n", a, now-max[a], ((now-max[a])>90?"true":"false") }'
} > "$O/b3-staleness.txt" 2>&1

# ---- B-4: how often did a reader observe >1 ref for one agent? ---------------
grep -o 'refs=[0-9]*' "$O/reader.log" | sort | uniq -c > "$O/b4-ref-multiplicity.txt" 2>&1

# cleanup
git ls-remote origin "$NS/*" | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null
echo "PROBE_B_DONE"
