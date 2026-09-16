#!/bin/sh
# The five things order 0066 asked for, measured in a real browser against real Firestore.
#
# The credential is referenced BY PATH and never copied into the repo -- territory.md.
#
#   scripts/run-design-system-probe.sh [base_url]
#
# Needs a built board being served: cd client && npm run build && npx vite preview --port 4173
set -eu
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/multiplayer-agents/firebase-adminsdk.json"
cd "$(dirname "$0")/.."
exec node client/edge/system-shot.mjs "$@"
