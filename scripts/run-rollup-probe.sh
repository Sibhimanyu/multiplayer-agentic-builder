#!/bin/sh
# Run the rollup probe against real Firestore.
#
# The credential is referenced BY PATH and never copied into the repo -- territory.md. It lives
# outside every worktree at mode 600 in a 700 directory.
set -eu
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/multiplayer-agents/firebase-adminsdk.json"
cd "$(dirname "$0")/.."
exec node firebase/rollup-probe.mjs "$@"
