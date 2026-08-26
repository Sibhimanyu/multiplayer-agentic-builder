#!/usr/bin/env bash
# Probe I — order 0017 ruling: "never match on an error message string; map structured fields".
# For route G the backend's error channel is `git push`. What structure does it actually give?
set -u
R=/tmp/ghprobe/repo; O=/tmp/ghprobe/out/I; rm -rf "$O"; mkdir -p "$O"; cd "$R" || exit 1
TREE=$(git rev-parse HEAD^{tree}); BASE=$(git rev-parse HEAD)
S=$(git commit-tree "$TREE" -p "$BASE" -m "agent_i0000001")
S2=$(git commit-tree "$TREE" -p "$BASE" -m "agent_i0000002")
run() { # label, then command
  local L="$1"; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  printf '%-34s rc=%-3s | %s\n' "$L" "$rc" "$(echo "$out" | grep -iE 'rejected|error|fatal|denied|remote:' | head -2 | tr '\n' ' ')"
}
{
echo "### I — exit codes and stderr for every failure class claimTask must distinguish"
echo
git push -q origin "$S:refs/claims/i-held" 2>/dev/null

run "1 claim LOST (lease rejected)"   git push --force-with-lease="refs/claims/i-held:" origin "$S2:refs/claims/i-held"
run "2 claim WON (fresh ref)"         git push --force-with-lease="refs/claims/i-fresh:" origin "$S:refs/claims/i-fresh"
run "3 non-fast-forward (no lease)"   git push origin "$S2:refs/claims/i-held"
run "4 repo does not exist"           git push "https://github.com/Sibhimanyu/no-such-repo-xyz.git" "$S:refs/claims/x"
run "5 bad credentials"               env GIT_ASKPASS=/usr/bin/true GIT_TERMINAL_PROMPT=0 \
                                        git push "https://x-access-token:ghp_invalidtoken000000000000000000000000@github.com/Sibhimanyu/inventory-tracker-github.git" "$S:refs/claims/x"
run "6 host unreachable (offline)"    git -c http.proxy=http://127.0.0.1:9 push "https://github.com/Sibhimanyu/inventory-tracker-github.git" "$S:refs/claims/x"
run "7 DNS failure"                   git push "https://no-such-host-abcxyz.invalid/r.git" "$S:refs/claims/x"

git push -q origin ":refs/claims/i-held" ":refs/claims/i-fresh" 2>/dev/null
echo
echo "### verdict"
echo "If several DISTINCT classes share one rc, the exit code alone cannot drive the"
echo "{ok:false,owner} vs StoreAuthError vs StoreOfflineError mapping that the interface requires."
} > "$O/exitcodes.txt" 2>&1
cat "$O/exitcodes.txt"
