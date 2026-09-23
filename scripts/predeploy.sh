#!/bin/sh
# The gate a hosting deploy cannot get past without the published artifacts.
#
# THIS VERIFIES; IT DOES NOT BUILD. Building here was tried and is not viable: Firebase spawns
# predeploy with its own environment, where `npm run` dies on a missing stdin
# (`Cannot read properties of undefined (reading 'stdin')`) and a direct `.bin/vite` picks up a
# different node and dies on ERR_REQUIRE_ESM. Both surface only as "predeploy error: exit 1".
#
# So the build is an explicit step (`npm run build:all`) and this is the guard. The guarantee is
# the same one order 0058 asked for -- a deploy that would unpublish the installer fails instead
# -- and it holds in pure sh with no node, no npm and no PATH assumptions.
set -eu
cd "$(dirname "$0")/.."

DIST=client/dist
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' packaging/package.json | head -1)
missing=""

for f in "index.html" "install.sh" "flotilla-cli-${VERSION}.tgz"; do
  [ -s "$DIST/$f" ] || missing="$missing $f"
done

if [ -n "$missing" ]; then
  echo "predeploy: FAIL -- $DIST is missing:$missing" >&2
  echo "" >&2
  echo "Deploying now would publish a site whose curl one-liner returns HTML." >&2
  echo "hosting rewrites '**' to /index.html, so a missing install.sh answers 200 and pipes" >&2
  echo "<!DOCTYPE html> into sh. That is what happened for a day. Build first:" >&2
  echo "" >&2
  echo "  npm run build:all" >&2
  exit 1
fi

# Bytes, not names. A zero-length or HTML-bodied artifact passes a -s test.
head -c 2 "$DIST/install.sh" | grep -q '#!' || {
  echo "predeploy: FAIL -- $DIST/install.sh does not start with a shebang" >&2; exit 1; }

echo "predeploy: OK -- index.html, install.sh and flotilla-cli-${VERSION}.tgz are staged"
