#!/bin/sh
# Everything a deploy needs, in the order it needs it.
# ORDER IS LOAD-BEARING: `vite build` empties client/dist, so the CLI artifacts come after.
set -eu
cd "$(dirname "$0")/.."
npm --prefix client run build
node scripts/build-cli.mjs
