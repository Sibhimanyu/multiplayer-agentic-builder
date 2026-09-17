#!/bin/sh
# Flotilla installer. Fetched by the curl one-liner in README.md.
#
# THIS FILE IS SOURCE AND IT IS TRACKED. It used to exist only in client/dist, which is
# gitignored and which `vite build` empties, so it was deleted by a routine rebuild and nobody
# noticed: hosting's catch-all rewrite answers every missing path with 200 and index.html, so
# `curl .../install.sh` kept returning 200 while piping HTML into sh.
set -eu

VERSION="0.1.0"
BASE="${FLOTILLA_BASE:-https://multiplayer-agents-eec02.web.app}"
TARBALL="flotilla-cli-${VERSION}.tgz"

say()  { printf '%s\n' "$*"; }
die()  { printf 'flotilla: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required (>=20). Install it, then run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "node >=20 is required; found $(node -v)."
command -v npm  >/dev/null 2>&1 || die "npm is required. It ships with node."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "Downloading flotilla-cli ${VERSION}…"
curl -fsSL "${BASE}/${TARBALL}" -o "${TMP}/${TARBALL}" \
  || die "could not download ${BASE}/${TARBALL}"

# The hosting rewrite returns 200 + HTML for a missing file, so a successful curl proves
# nothing about WHAT arrived. A gzip tarball starts with 0x1f 0x8b; HTML starts with '<'.
head -c 2 "${TMP}/${TARBALL}" | od -An -tx1 | tr -d ' \n' | grep -q '^1f8b' \
  || die "${BASE}/${TARBALL} did not return a tarball. The published artifact is missing."

say "Installing…"
npm install -g "${TMP}/${TARBALL}" >/dev/null 2>&1 \
  || die "npm install -g failed. Re-run with: npm install -g ${TMP}/${TARBALL}"

command -v flotilla >/dev/null 2>&1 || {
  PREFIX=$(npm prefix -g 2>/dev/null || echo "")
  die "installed, but 'flotilla' is not on your PATH. Add ${PREFIX}/bin to PATH and re-open your shell."
}

say ""
say "flotilla $(flotilla --version 2>/dev/null || echo "${VERSION}") is installed."
say ""
say "  flotilla login                 sign in with Google"
say "  cd your-repo && flotilla new \"My Project\""
say ""
