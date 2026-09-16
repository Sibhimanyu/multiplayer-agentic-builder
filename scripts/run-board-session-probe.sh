#!/bin/sh
# The board in a real browser, signed in as a real uid, against real Firebase Auth and Firestore.
#
# The credential is referenced BY PATH and never copied into the repo -- territory.md. It lives
# outside every worktree at mode 600 in a 700 directory.
#
#   scripts/run-board-session-probe.sh [base_url] [uid] [project_id]
#
# Needs a built board being served. `cd client && npm run build && npx vite preview --port 4173`.
set -eu
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/multiplayer-agents/firebase-adminsdk.json"
cd "$(dirname "$0")/.."
exec node client/edge/session-shot.mjs "$@"
