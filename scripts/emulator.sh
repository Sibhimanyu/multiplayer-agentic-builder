#!/usr/bin/env bash
# Run a command against the Firestore emulator.
#
# Two machine-specific problems this works around, both worth knowing about:
#
# 1. firebase-tools >= 15 requires a JDK 21+ runtime. The default `java` on PATH here is 1.8
#    (an Oracle applet-plugin JRE) which shadows the Homebrew JDK 26. And
#    `/usr/libexec/java_home -v 21+` exits 0 while printing that same 1.8 path, ignoring the
#    version filter — so every candidate below is version-checked by actually running it,
#    never trusted because of where it came from.
#
# 2. `firebase emulators:exec <cmd>` does NOT run <cmd> with the system node. firebase-tools
#    ships as a pkg binary with Node 20.18.2 embedded, and the embedded loader intercepts
#    `node --test ...` and tries to resolve `--test` as a module path. Node 20 also cannot
#    strip TypeScript types. So this script starts the emulator itself, waits for the port,
#    runs the command under the real node, and shuts down on the way out.
#
# Usage: scripts/emulator.sh <command...>
set -euo pipefail

PROJECT="${BAKEOFF_EMULATOR_PROJECT:-demo-bakeoff}"
PORT="${FIRESTORE_EMULATOR_PORT:-8080}"
HOST=127.0.0.1

# ---- 1. find a usable JDK -----------------------------------------------------------

jdk_major() {
  local java_bin="$1"
  [ -x "$java_bin" ] || { echo 0; return; }
  local raw major
  raw="$("$java_bin" -version 2>&1 | head -1)" || { echo 0; return; }
  # "openjdk version "26.0.1"" -> 26 ; "java version "1.8.0_501"" -> 1
  major="$(printf '%s' "$raw" | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p')"
  [ -n "$major" ] || major=0
  echo "$major"
}

use_jdk_home() {
  local home="$1"
  [ -n "$home" ] || return 1
  [ "$(jdk_major "$home/bin/java")" -ge 21 ] 2>/dev/null || return 1
  export JAVA_HOME="$home"
  export PATH="$home/bin:$PATH"
  return 0
}

find_jdk() {
  if command -v java >/dev/null 2>&1; then
    if [ "$(jdk_major "$(command -v java)")" -ge 21 ] 2>/dev/null; then return 0; fi
  fi
  if [ -x /usr/libexec/java_home ]; then
    local home
    while IFS= read -r home; do
      use_jdk_home "$home" && return 0
    done < <(/usr/libexec/java_home -V 2>&1 | sed -n 's/.*"\(\/.*\)"$/\1/p')
  fi
  local candidate
  while IFS= read -r candidate; do
    use_jdk_home "$candidate" && return 0
  done < <(ls -d /opt/homebrew/Cellar/openjdk*/*/libexec/openjdk.jdk/Contents/Home \
                 /usr/local/Cellar/openjdk*/*/libexec/openjdk.jdk/Contents/Home \
                 /Library/Java/JavaVirtualMachines/*/Contents/Home \
                 2>/dev/null | sort -Vr)
  echo "scripts/emulator.sh: no JDK 21+ found. Install one (brew install openjdk) — the" >&2
  echo "  Firestore emulator will not start without it." >&2
  return 1
}

find_jdk
echo "scripts/emulator.sh: java $(jdk_major "$(command -v java)") from ${JAVA_HOME:-PATH}" >&2

# Sourced by scripts/emulator-up.sh purely for the JDK discovery above. When that is all the
# caller wants, hand the emulator over in the foreground and stop here.
if [ -n "${BAKEOFF_DISCOVER_ONLY:-}" ]; then
  echo "scripts/emulator.sh: starting a PERSISTENT emulator (Ctrl-C to stop)" >&2
  exec firebase emulators:start --only firestore \
    --project "${BAKEOFF_EMULATOR_PROJECT:-demo-bakeoff}"
fi

# ---- 2. start the emulator ----------------------------------------------------------

LOG="$(mktemp -t firestore-emulator-XXXXXX.log)"
EMULATOR_PID=""

cleanup() {
  local code=$?
  if [ -n "$EMULATOR_PID" ] && kill -0 "$EMULATOR_PID" 2>/dev/null; then
    # Kill the process group: the CLI spawns a java child that outlives a bare SIGTERM.
    kill -TERM "-$EMULATOR_PID" 2>/dev/null || kill -TERM "$EMULATOR_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$EMULATOR_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "-$EMULATOR_PID" 2>/dev/null || true
  fi
  # Surface the emulator log only on failure; on success it is noise.
  if [ "$code" -ne 0 ] && [ -s "$LOG" ]; then
    echo "--- emulator log (tail) ---" >&2
    tail -30 "$LOG" >&2
  fi
  rm -f "$LOG"
  exit "$code"
}
trap cleanup EXIT INT TERM

# --project demo-* means the SDK never needs real credentials and refuses to reach a live
# project, so a mistake here cannot bill anything.
set -m
firebase emulators:start --only firestore --project "$PROJECT" >"$LOG" 2>&1 &
EMULATOR_PID=$!
set +m

# Poll the port rather than sleeping a fixed amount: a cold run downloads the emulator jar.
echo "scripts/emulator.sh: waiting for firestore emulator on $HOST:$PORT" >&2
for i in $(seq 1 240); do
  if nc -z "$HOST" "$PORT" 2>/dev/null; then break; fi
  if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
    echo "scripts/emulator.sh: emulator exited before becoming ready" >&2
    exit 1
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "scripts/emulator.sh: emulator did not open $HOST:$PORT within 120s" >&2
    exit 1
  fi
done
echo "scripts/emulator.sh: emulator ready" >&2

# ---- 3. run the command under the REAL node -----------------------------------------

export FIRESTORE_EMULATOR_HOST="$HOST:$PORT"
export GCLOUD_PROJECT="$PROJECT"
export GOOGLE_CLOUD_PROJECT="$PROJECT"

set +e
bash -c "$*"
STATUS=$?
set -e
exit "$STATUS"
