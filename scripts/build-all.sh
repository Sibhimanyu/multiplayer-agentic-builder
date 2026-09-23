#!/bin/sh
# Everything a deploy needs, in the order it needs it.
# ORDER IS LOAD-BEARING: `vite build` empties client/dist, so the CLI artifacts come after.
# functions/ deploys from compiled functions/lib, not src/. Skipping this step deploys the
# previous build and reports "Deploy complete!" anyway -- which is how a fix once shipped as a no-op.
set -eu
cd "$(dirname "$0")/.."
npm --prefix functions run build
npm --prefix client run build
node scripts/build-cli.mjs
