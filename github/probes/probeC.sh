#!/usr/bin/env bash
# Probe C — notification channel latency + quota cost. Run in a QUIET window (no other probe).
set -u
R=/tmp/ghprobe/repo
O=/tmp/ghprobe/out/C
rm -rf "$O"; mkdir -p "$O"
cd "$R" || exit 1
TOK=$(gh auth token)
REPO=Sibhimanyu/inventory-tracker-github
N=${N:-25}

stats() { python3 -c "
import sys
v=sorted(float(x) for x in sys.stdin.read().split() if x.strip())
if not v: print('NO SAMPLES'); raise SystemExit
def p(q):
    i=(len(v)-1)*q; lo=int(i); hi=min(lo+1,len(v)-1)
    return v[lo]+(v[hi]-v[lo])*(i-lo)
print(f'n={len(v)} min={v[0]:.0f} p50={p(.5):.0f} p90={p(.9):.0f} max={v[-1]:.0f}')
"; }

# seed a few refs so the channels return real content
SHA=$(git rev-parse HEAD)
for i in 1 2 3; do git push -q origin "$SHA:refs/heartbeats/agent_c000000$i/$(python3 -c 'import time;print(int(time.time()))')" 2>/dev/null; done

# ---- C1 git ls-remote (whole repo) ----
: > "$O/ls-remote-all.ms"
for i in $(seq 1 $N); do
  s=$(python3 -c 'import time;print(time.time())')
  git ls-remote origin > /dev/null 2>&1
  e=$(python3 -c 'import time;print(time.time())')
  python3 -c "print(round(($e-$s)*1000))" >> "$O/ls-remote-all.ms"
done

# ---- C2 git ls-remote, heartbeat namespace only ----
: > "$O/ls-remote-hb.ms"
for i in $(seq 1 $N); do
  s=$(python3 -c 'import time;print(time.time())')
  git ls-remote origin 'refs/heartbeats/*' > /dev/null 2>&1
  e=$(python3 -c 'import time;print(time.time())')
  python3 -c "print(round(($e-$s)*1000))" >> "$O/ls-remote-hb.ms"
done

# ---- C3 REST conditional GET -> 304, and quota accounting ----
URL="https://api.github.com/repos/$REPO/git/matching-refs/heartbeats/"
hdr=$(curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" "$URL")
ETAG=$(echo "$hdr" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
echo "first (200) response headers:" > "$O/c3-detail.txt"
echo "$hdr" | tr -d '\r' | grep -iE '^(HTTP/|etag|x-ratelimit-(remaining|limit|used))' >> "$O/c3-detail.txt"

: > "$O/api-304.ms"; : > "$O/api-304.codes"; : > "$O/api-304.remaining"
for i in $(seq 1 $N); do
  s=$(python3 -c 'import time;print(time.time())')
  h=$(curl -sS -D - -o /dev/null \
      -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
      -H "If-None-Match: $ETAG" "$URL")
  e=$(python3 -c 'import time;print(time.time())')
  python3 -c "print(round(($e-$s)*1000))" >> "$O/api-304.ms"
  echo "$h" | tr -d '\r' | awk '/^HTTP\//{print $2}' | tail -1 >> "$O/api-304.codes"
  echo "$h" | tr -d '\r' | awk 'tolower($1)=="x-ratelimit-remaining:"{print $2}' >> "$O/api-304.remaining"
done

# ---- C4 does a 200 (changed) cost quota, vs a 304? ----
{
  echo "### C4 quota: 3x 304, then force a change, then 200"
  for i in 1 2 3; do
    curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOK" -H "If-None-Match: $ETAG" "$URL" \
      | tr -d '\r' | grep -iE '^(HTTP/|x-ratelimit-remaining)'
  done
  git push -q origin "$SHA:refs/heartbeats/agent_c0000099/$(python3 -c 'import time;print(int(time.time()))')" 2>/dev/null
  echo "--- after a ref change, same ETag ---"
  curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOK" -H "If-None-Match: $ETAG" "$URL" \
    | tr -d '\r' | grep -iE '^(HTTP/|x-ratelimit-remaining)'
} > "$O/c4-quota.txt" 2>&1

# ---- C5 end-to-end propagation: write a ref, poll until the API sees it ----
: > "$O/propagate.ms"
for i in $(seq 1 10); do
  TS=$(python3 -c 'import time;print(int(time.time()))')
  RN="refs/heartbeats/agent_cprop/$TS-$i"
  h=$(curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOK" "$URL")
  ET=$(echo "$h" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
  s=$(python3 -c 'import time;print(time.time())')
  git push -q origin "$SHA:$RN" 2>/dev/null
  for t in $(seq 1 200); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" -H "If-None-Match: $ET" "$URL")
    [ "$code" = "200" ] && break
    sleep 0.1
  done
  e=$(python3 -c 'import time;print(time.time())')
  python3 -c "print(round(($e-$s)*1000))" >> "$O/propagate.ms"
  git push -q origin ":$RN" 2>/dev/null
done

{
  echo "C1 git ls-remote (all refs)      $(stats < "$O/ls-remote-all.ms")"
  echo "C2 git ls-remote (refs/heartbeats/*) $(stats < "$O/ls-remote-hb.ms")"
  echo "C3 REST conditional GET -> 304   $(stats < "$O/api-304.ms")"
  echo "C3 status codes: $(sort "$O/api-304.codes" | uniq -c | tr '\n' ' ')"
  echo "C3 x-ratelimit-remaining first=$(head -1 "$O/api-304.remaining") last=$(tail -1 "$O/api-304.remaining") distinct=$(sort -u "$O/api-304.remaining" | tr '\n' ',')"
  echo "C5 write->visible-to-poller      $(stats < "$O/propagate.ms")"
} > "$O/summary.txt"

git ls-remote origin 'refs/heartbeats/*' | awk '{print ":"$2}' | xargs -r git push -q origin 2>/dev/null
echo "PROBE_C_DONE"
