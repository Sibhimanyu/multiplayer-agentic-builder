#!/usr/bin/env bash
# Run node --test and fail on cancelled/todo, not only on failures.
#
# WHY THIS EXISTS. A latent hang in this build produced exactly this summary:
#
#   ℹ pass 61   ℹ fail 0   ℹ cancelled 2      duration_ms 2098379
#
# fail 0. Two tests cancelled by a 900-second timeout, thirty-five minutes of wall clock, and
# the word "failure" nowhere in the output. The two counts anyone actually reads -- pass and
# fail -- both looked fine. I noticed because `pass` did not equal `tests`.
#
# `node --test` exits non-zero for a cancelled test, so a bare `npm test` would have caught it
# here. But the number a human reads in CI output, in a summary comment, in a screenshot, is
# `fail`. This makes the check explicit and states the count, so a cancelled test is loud
# rather than arithmetic somebody has to do.
#
# Also treats a MISSING count as a violation rather than a pass -- missing is drift.
#
#   scripts/run-tests.sh <node --test args...>
set -uo pipefail

OUT="$(mktemp -t testrun-XXXXXX.log)"
trap 'rm -f "$OUT"' EXIT INT TERM

# --test-reporter=spec IS PINNED, NOT INHERITED. `node --test` picks its reporter from whether
# stdout is a TTY, and which reporter that is has changed between releases: Node 26 emits the spec
# form (`ℹ pass 177`) into a pipe, Node 22 emits TAP (`# pass 177`). This script parses that
# summary, so an unpinned reporter means the runtime can silently change the thing being parsed.
#
# It did. A node downgrade from v26.3.1 to v22.23.1 on the dev machine turned every run into
#
#   run-tests: FAIL -- could not read a full summary from the runner.
#
# while all 177 tests were in fact passing. That refusal is the correct behaviour and the reason
# this script exists -- absent counts are a violation, not "nothing to check" -- but the cause was
# this script trusting a default. The `#` form is still accepted below so that a runtime which
# ignores the flag degrades to parsing rather than to refusing.
node --test --test-reporter=spec "$@" 2>&1 | tee "$OUT"
NODE_STATUS="${PIPESTATUS[0]}"

count() {
  local key="$1" v
  # Either reporter's summary line: `ℹ pass 177` (spec) or `# pass 177` (tap).
  v="$(grep -E "^(ℹ|#) ${key} " "$OUT" | tail -1 | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  printf '%s' "${v:-}"
}

TESTS="$(count tests)"; PASS="$(count pass)"; FAIL="$(count fail)"
CANCELLED="$(count cancelled)"; SKIPPED="$(count skipped)"; TODO="$(count todo)"

if [ -z "$TESTS" ] || [ -z "$PASS" ] || [ -z "$FAIL" ] || [ -z "$CANCELLED" ]; then
  echo "run-tests: FAIL -- could not read a full summary from the runner." >&2
  echo "  Absent counts are a violation, not 'nothing to check'." >&2
  exit 1
fi

echo "run-tests: tests=$TESTS pass=$PASS fail=$FAIL cancelled=$CANCELLED skipped=${SKIPPED:-0} todo=${TODO:-0}"

BAD=0
[ "$FAIL" -gt 0 ] && { echo "run-tests: FAIL -- $FAIL failing test(s)" >&2; BAD=1; }
[ "$CANCELLED" -gt 0 ] && {
  echo "run-tests: FAIL -- $CANCELLED CANCELLED test(s). A cancelled test is usually a hang or" >&2
  echo "  a timeout, and it does NOT appear in the fail count. Do not raise the timeout without" >&2
  echo "  first establishing what is not finishing." >&2
  BAD=1
}
[ "${TODO:-0}" -gt 0 ] && { echo "run-tests: FAIL -- ${TODO} todo test(s); finish or delete them" >&2; BAD=1; }

# Accounting must balance. NOTE: this would NOT have caught the hang above -- 61 + 0 + 2 does
# balance to 63. The check that catches a hang is `cancelled > 0`, above. This one is for a
# different failure: a test that lands in no bucket at all, which would mean the runner itself
# lost track of it. Kept because it is nearly free, but recorded honestly rather than credited
# with a catch it would have missed.
ACCOUNTED=$(( PASS + FAIL + CANCELLED + ${SKIPPED:-0} + ${TODO:-0} ))
if [ "$ACCOUNTED" -ne "$TESTS" ]; then
  echo "run-tests: FAIL -- counts do not balance: $ACCOUNTED accounted for of $TESTS." >&2
  echo "  Something happened to a test that none of the summary buckets describes." >&2
  BAD=1
fi

[ "$BAD" -ne 0 ] && exit 1
[ "$NODE_STATUS" -ne 0 ] && { echo "run-tests: FAIL -- runner exited $NODE_STATUS" >&2; exit "$NODE_STATUS"; }
echo "run-tests: OK"
