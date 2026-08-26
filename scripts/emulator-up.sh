#!/usr/bin/env bash
# Start the Firestore emulator and LEAVE IT RUNNING, for local dashboard work.
#
# scripts/emulator.sh runs one command and tears the emulator down, which is right for tests and
# useless for looking at the board: the data dies with the process. This keeps it up so you can
# seed once and then open the dashboard against the same instance.
#
#   terminal 1:  scripts/emulator-up.sh
#   terminal 2:  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-bakeoff \
#                  node scripts/seed-demo.ts
#   terminal 3:  cd client && VITE_FIREBASE_PROJECT_ID=demo-bakeoff \
#                  VITE_FIRESTORE_EMULATOR=127.0.0.1:8080 npm run dev
#
# Ctrl-C to stop. Nothing is persisted between runs, which is deliberate: a demo fixture that
# survived a restart would eventually be mistaken for real state.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Reuse the JDK discovery from the test wrapper rather than duplicating it. Sourcing with
# BAKEOFF_DISCOVER_ONLY set stops it short of starting anything.
export BAKEOFF_DISCOVER_ONLY=1
# shellcheck disable=SC1091
source "$DIR/emulator.sh"
