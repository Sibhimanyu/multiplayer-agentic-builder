#!/usr/bin/env bash
# Probe H — why did C4's conditional GET return 200 while C3's returned 304?
# Hypothesis: the ETag is media-type dependent, so dropping the Accept header breaks 304s.
set -u
O=/tmp/ghprobe/out/H; rm -rf "$O"; mkdir -p "$O"
TOK=$(gh auth token); REPO=Sibhimanyu/inventory-tracker-github
URL="https://api.github.com/repos/$REPO/git/matching-refs/heartbeats/"
A="Accept: application/vnd.github+json"
rem() { tr -d '\r' | awk 'tolower($1)=="x-ratelimit-remaining:"{print $2}'; }
code() { tr -d '\r' | awk '/^HTTP\//{c=$2} END{print c}'; }

get() { curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOK" "$@" "$URL"; }

{
echo "### H1  ETag obtained WITH the Accept header, replayed WITH it"
E_WITH=$(get -H "$A" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
echo "etag(with Accept)    = $E_WITH"
for i in 1 2 3; do h=$(get -H "$A" -H "If-None-Match: $E_WITH"); echo "  replay $i -> $(echo "$h"|code)  remaining=$(echo "$h"|rem)"; done

echo
echo "### H2  same ETag, replayed WITHOUT the Accept header"
for i in 1 2 3; do h=$(get -H "If-None-Match: $E_WITH"); echo "  replay $i -> $(echo "$h"|code)  remaining=$(echo "$h"|rem)"; done

echo
echo "### H3  ETag obtained WITHOUT Accept, replayed WITHOUT Accept"
E_NO=$(get | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
echo "etag(no Accept)      = $E_NO"
echo "etags identical?     = $([ "$E_WITH" = "$E_NO" ] && echo YES || echo NO)"
for i in 1 2 3; do h=$(get -H "If-None-Match: $E_NO"); echo "  replay $i -> $(echo "$h"|code)  remaining=$(echo "$h"|rem)"; done

echo
echo "### H4  quota: 10x 304 vs 10x 200, measured on the counter"
r0=$(get -H "$A" | rem)
for i in $(seq 1 10); do get -H "$A" -H "If-None-Match: $E_WITH" >/dev/null; done
r1=$(get -H "$A" | rem)
echo "  10 conditional 304s: remaining $r0 -> $r1   (the two bracketing 200s cost 2)"
r2=$(get -H "$A" | rem)
for i in $(seq 1 10); do get -H "$A" >/dev/null; done
r3=$(get -H "$A" | rem)
echo "  10 unconditional 200s: remaining $r2 -> $r3  (plus 2 bracketing)"
} > "$O/etag.txt" 2>&1
echo PROBE_H_DONE
