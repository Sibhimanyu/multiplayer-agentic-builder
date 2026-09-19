#!/usr/bin/env bash
# Run every emulator test group, then report all of them.
#
# WHY NOT `a && b && c && d`. That is what firebase/package.json's `test` used to be, and the
# first failing group stopped the rest: a flaky stress suite meant the integration group simply
# never ran, and its result was neither green nor red but absent. Absent reads as "fine" in a
# summary, which is the same failure this repository keeps finding in different costumes.
#
# So every group runs, and the summary at the end names each one. The exit code is still non-zero
# if any group failed -- this reports more, it does not gate less.
#
# ONE EMULATOR PROCESS PER GROUP, and that separation is measured rather than tidy. Batched into
# a single emulator, the conformance suite failed at 106s with `ABORTED: Transaction lock timeout`
# from accumulated degradation caused by the stress tests earlier in the same process; alone it
# passes in ~220s, repeatedly. scripts/emulator.sh starts and tears down one per invocation.
set -uo pipefail

cd "$(dirname "$0")/.."

FAILED=()
PASSED=()

# THE GROUPS ARE NAMED, THE FILES ARE NOT. Each group's file list lives in exactly one place --
# firebase/package.json's `test:<group>` script -- and this runner delegates to it. Listing the
# files here as well would be a second copy to drift, which is the defect that put this whole
# session in motion: a script naming a file that had moved, and a test file named by no script.
# `cli/every-test-runs.test.ts` reads those same npm scripts, so the guard and the runner cannot
# disagree about what exists.
#
# Ordered cheapest-first so a structural break -- a missing file, a bad import -- surfaces in
# seconds instead of after the four-minute conformance run.
for name in directory integration conformance stress; do
  echo ""
  echo "=== $name ==="
  if npm --prefix firebase run "test:$name"; then
    PASSED+=("$name")
  else
    FAILED+=("$name")
  fi
done

echo ""
echo "=== emulator suite summary ==="
for p in ${PASSED[@]+"${PASSED[@]}"}; do echo "  PASS  $p"; done
for f in ${FAILED[@]+"${FAILED[@]}"}; do echo "  FAIL  $f"; done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "emul-groups: ${#FAILED[@]} group(s) failed: ${FAILED[*]}"
  exit 1
fi
echo "emul-groups: all ${#PASSED[@]} groups passed"
