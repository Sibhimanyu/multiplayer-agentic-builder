#!/usr/bin/env bash
# Provision the Firebase route's own backend + demo repo. Order 0013.
#
# NOT RUN AUTOMATICALLY. This creates real, billable-adjacent resources on a real person's
# personal Google and GitHub accounts, so it runs only when the account owner says so:
#
#   scripts/provision.sh --dry-run     # default: prints exactly what it WOULD do, touches nothing
#   scripts/provision.sh --confirm     # actually creates
#
# Scope limits from the order, enforced here rather than trusted:
#   - creates ONLY the two resources named below
#   - refuses if either already exists, rather than modifying it
#   - never enumerates-and-mutates; the eight pre-existing Firebase projects are untouched
#   - appends every created resource to PROVISIONED.md so cleanup has a list
set -uo pipefail

PROJECT_ID="${FB_PROJECT_ID:-catalyst-builder-fb}"
DISPLAY_NAME="Catalyst Builder (Firebase route)"
REPO="${DEMO_REPO:-Sibhimanyu/inventory-tracker-firebase}"
LOG="PROVISIONED.md"

MODE="dry-run"
[ "${1:-}" = "--confirm" ] && MODE="confirm"
[ "${1:-}" = "--dry-run" ] && MODE="dry-run"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$MODE" = "confirm" ]; then say "+ $*"; "$@"; return $?; fi
  say "  would run: $*"; return 0
}

step "mode: $MODE   project: $PROJECT_ID   repo: $REPO"
[ "$MODE" = "dry-run" ] && say "  (nothing will be created; pass --confirm to execute)"

# ---- preflight: refuse to touch anything that already exists ------------------------

step "preflight"

if ! command -v firebase >/dev/null; then say "FAIL: firebase CLI not found"; exit 1; fi
if ! command -v gh       >/dev/null; then say "FAIL: gh CLI not found";       exit 1; fi

ACCOUNT="$(firebase login:list 2>/dev/null | sed -n 's/.*Logged in as \(.*\)/\1/p' | head -1)"
say "  firebase account: ${ACCOUNT:-UNKNOWN}"
GH_ACCOUNT="$(gh api user --jq .login 2>/dev/null || echo UNKNOWN)"
say "  github account:   $GH_ACCOUNT"

# The pre-existing projects are someone's real work. Assert our target is NOT one of them.
#
# MISSING IS DRIFT, and my first version of this got it wrong in exactly the way I had just
# written a rule against: the awk parse failed, EXISTING came back empty, `grep -qx` matched
# nothing, and the guard cheerfully reported "free" on the strength of no data at all. A guard
# that passes when its input disappears is broken in the direction that matters.
#
# So: parse, then REQUIRE a plausible result. There are known to be eight projects on this
# account, so an empty or tiny list means the parse broke, not that the account is empty.
EXISTING="$(firebase projects:list 2>/dev/null \
  | grep -oE '[a-z0-9][a-z0-9-]{4,29}' \
  | grep -vE '^(Project|Display|Number|Resource|Location|projects?|total)$' \
  | sort -u || true)"
COUNT="$(printf '%s\n' "$EXISTING" | grep -c . || true)"
say "  pre-existing project-id candidates parsed: $COUNT"

if [ "${COUNT:-0}" -lt 2 ]; then
  say "FAIL: could not read the existing project list (parsed $COUNT candidates)."
  say "  Refusing to proceed on missing data -- an empty list would make the collision check"
  say "  vacuous, and this account is known to hold eight projects. Check 'firebase projects:list'."
  exit 1
fi

if printf '%s\n' "$EXISTING" | grep -qx "$PROJECT_ID"; then
  say "FAIL: project '$PROJECT_ID' ALREADY EXISTS."
  say "  Order 0013 says create a NEW project and never touch a pre-existing one."
  say "  Stopping rather than adopting it. Set FB_PROJECT_ID to something unused."
  exit 1
fi

if gh repo view "$REPO" >/dev/null 2>&1; then
  say "FAIL: repo '$REPO' ALREADY EXISTS. Stopping rather than modifying it."
  exit 1
fi
say "  target project and repo are both free"

# ---- create ------------------------------------------------------------------------

step "1/4  create the GCP+Firebase project (lands on Spark)"
run firebase projects:create "$PROJECT_ID" --display-name "$DISPLAY_NAME" || {
  say "FAIL: projects:create failed. If the ID is taken globally, set FB_PROJECT_ID and retry."
  exit 1
}

step "2/4  select it locally"
run firebase use "$PROJECT_ID"

step "3/4  deploy what Spark allows: Firestore rules + indexes, then Hosting"
# Rules FIRST, before any data exists: deploying them afterwards leaves a window where the
# database is open.
run firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"
run bash -c "cd client && npm run build"
run firebase deploy --only hosting --project "$PROJECT_ID"

step "4/4  create the demo repo (OURS, not shared -- see order 0013)"
run gh repo create "$REPO" --private --description "Demo target, Firebase route"

# ---- record ------------------------------------------------------------------------

if [ "$MODE" = "confirm" ]; then
  {
    printf '\n## %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf -- '- firebase project: `%s` (%s), account %s, plan **Spark**\n' "$PROJECT_ID" "$DISPLAY_NAME" "${ACCOUNT:-unknown}"
    printf -- '- github repo: `%s` (private), account %s\n' "$REPO" "$GH_ACCOUNT"
    printf -- '- deployed: firestore rules+indexes, hosting\n'
    printf -- '- NOT deployed: functions (needs Blaze; see the manual step list)\n'
  } >> "$LOG"
  say ""
  say "recorded in $LOG"
fi

step "OUTSTANDING — a human must do this; no CLI can"
say "  Cloud Functions need Blaze, and neither firebase-tools nor gcloud (not installed) can"
say "  attach billing or create a budget. So the webhook stays undeployed until:"
say ""
say "  1. console.firebase.google.com/project/$PROJECT_ID/usage/details"
say "     -> Modify plan -> Blaze -> attach a billing account"
say "  2. console.cloud.google.com/billing -> Budgets & alerts -> Create budget"
say "     scope: project $PROJECT_ID only; amount \$5/month; alerts at 50/90/100% of ACTUAL spend"
say "     (expected real spend at this volume is \$0, so ANY alert means something is looping)"
say "  3. then: firebase deploy --only functions --project $PROJECT_ID"
say ""
say "  Step 2 before step 3. Blaze has no spending cap by default, only alerts."
