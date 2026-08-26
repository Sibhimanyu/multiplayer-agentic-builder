#!/usr/bin/env bash
# Probe A — atomic claim via create-if-absent lease, 20-way concurrency, 50 rounds.
set -u
R=/tmp/ghprobe/repo
O=/tmp/ghprobe/out/A
rm -rf "$O"; mkdir -p "$O"
cd "$R" || exit 1

AGENTS=20
ROUNDS=50

# One commit per agent, reused across rounds. The commit subject IS the owner record.
declare -a SHA
for i in $(seq 0 $((AGENTS-1))); do
  id=$(printf 'agent_%08x' $((0xa0000000 + i)))
  s=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "claim by $id" 2>/dev/null)
  SHA[$i]=$s
  echo "$i $id $s" >> "$O/agents.txt"
done

# Make sure every agent commit object is already on the remote, so the race measures
# the ref update and not object upload time. Park them under refs/probe-objects/*.
for i in $(seq 0 $((AGENTS-1))); do
  echo "${SHA[$i]}:refs/probe-objects/a$i"
done | xargs git push -q origin 2>>"$O/prep.err"
echo "prep done" >> "$O/prep.err"

# ---- B0: confirm the naive form is unsafe -------------------------------------
{
  echo "### B0 naive push to an EXISTING claim ref"
  git push origin "${SHA[0]}:refs/claims/naive-demo" 2>&1
  echo "--- second agent, plain push, same ref ---"
  git push origin "${SHA[1]}:refs/claims/naive-demo" 2>&1
  echo "rc=$?"
  echo "--- ref now points at ---"
  git ls-remote origin refs/claims/naive-demo
  git push -q origin ":refs/claims/naive-demo" 2>&1
} > "$O/b0-naive.txt" 2>&1

# ---- B1/B2: lease semantics, sequential ---------------------------------------
{
  echo "### B1 lease, ref ABSENT"
  git push --force-with-lease="refs/claims/lease-demo:" origin "${SHA[0]}:refs/claims/lease-demo" 2>&1
  echo "rc=$?"
  echo "### B2 lease, ref EXISTS"
  git push --force-with-lease="refs/claims/lease-demo:" origin "${SHA[1]}:refs/claims/lease-demo" 2>&1
  echo "rc=$?"
  echo "### owner read back from the ref's commit"
  ls=$(git ls-remote origin refs/claims/lease-demo); echo "$ls"
  osha=$(echo "$ls" | cut -f1)
  echo "subject: $(git log -1 --format=%s "$osha")"
  git push -q origin ":refs/claims/lease-demo" 2>&1
} > "$O/b1b2-lease.txt" 2>&1

# ---- A2: 20 concurrent claimants, exactly one winner, 50 rounds ---------------
PASS=0; FAIL=0
: > "$O/rounds.tsv"
T0=$(python3 -c 'import time;print(time.time())')
for r in $(seq 1 $ROUNDS); do
  TASK="probe-r$(printf '%03d' "$r")"
  rm -rf "$O/rc"; mkdir -p "$O/rc"
  rt0=$(python3 -c 'import time;print(time.time())')
  for i in $(seq 0 $((AGENTS-1))); do
    (
      git push --force-with-lease="refs/claims/$TASK:" origin "${SHA[$i]}:refs/claims/$TASK" \
        > "$O/rc/out.$i" 2>&1
      echo $? > "$O/rc/rc.$i"
    ) &
  done
  wait
  rt1=$(python3 -c 'import time;print(time.time())')

  winners=0; winner_i=-1
  for i in $(seq 0 $((AGENTS-1))); do
    if [ "$(cat "$O/rc/rc.$i")" = "0" ]; then winners=$((winners+1)); winner_i=$i; fi
  done

  # correlation, not count: the ref must point at the WINNER's commit (order 0009)
  refsha=$(git ls-remote origin "refs/claims/$TASK" | cut -f1)
  wsha="${SHA[$winner_i]:-none}"
  corr="no"; [ "$refsha" = "$wsha" ] && corr="yes"
  # every loser must report rejection, not a crash
  losers_rejected=0
  for i in $(seq 0 $((AGENTS-1))); do
    [ "$i" = "$winner_i" ] && continue
    grep -q 'rejected' "$O/rc/out.$i" && losers_rejected=$((losers_rejected+1))
  done

  ok="FAIL"
  if [ "$winners" = "1" ] && [ "$corr" = "yes" ] && [ "$losers_rejected" = "$((AGENTS-1))" ]; then
    ok="PASS"; PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    cp -r "$O/rc" "$O/failed-$TASK"
  fi
  dur=$(python3 -c "print(round(($rt1-$rt0)*1000))")
  printf '%s\t%s\twinners=%s\tcorrelated=%s\tlosers_rejected=%s/%s\tround_ms=%s\n' \
    "$TASK" "$ok" "$winners" "$corr" "$losers_rejected" "$((AGENTS-1))" "$dur" >> "$O/rounds.tsv"
  git push -q origin ":refs/claims/$TASK" 2>/dev/null
done
T1=$(python3 -c 'import time;print(time.time())')

{
  echo "rounds=$ROUNDS agents=$AGENTS pass=$PASS fail=$FAIL"
  echo "total_wall_s=$(python3 -c "print(round($T1-$T0,1))")"
} > "$O/summary.txt"

# cleanup parked objects
for i in $(seq 0 $((AGENTS-1))); do echo ":refs/probe-objects/a$i"; done | xargs git push -q origin 2>/dev/null
echo "PROBE_A_DONE"
