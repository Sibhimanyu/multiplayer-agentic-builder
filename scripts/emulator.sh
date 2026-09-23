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
# Whether the caller PICKED this port matters below: an explicit choice is honoured to the point
# of refusing, a default is only a default.
PORT_WAS_EXPLICIT="${FIRESTORE_EMULATOR_PORT:+yes}"
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

# REFUSE if the port is already occupied.
#
# This guard was missing and it silently corrupted results. The readiness check below polls
# "is anything answering on $PORT" -- so when two runs overlapped, the second one's emulator
# failed to bind, `nc -z` succeeded against the FIRST run's emulator, and the second run
# reported "emulator ready" and executed its whole suite against a foreign, already-loaded
# backend. Both runs then contended for the same documents.
#
# That produced a real false conclusion: A2 looked like it passed in isolation twice and failed
# once, and I attributed the difference to accumulated load inside a single emulator. The actual
# variable was how many emulators were running at the time. There were seven strays.
#
# Checking "is the port answering" when the question is "is MY backend answering" is the same
# shape as a guard that passes on missing input: it succeeds for the wrong reason.
#
# A BUSY DEFAULT PORT IS NOT THE SAME PROBLEM AS A BUSY CHOSEN PORT. 8080 is the single most
# contended port on a developer machine -- here it was held by an unrelated local service, and
# refusing meant the entire emulator suite could not run on this machine at all. Moving to a free
# port keeps the invariant that actually matters ("this suite talks to an emulator I started, of
# known state") while dropping one that never did ("that emulator is on 8080").
#
# An EXPLICIT FIRESTORE_EMULATOR_PORT still refuses. If you named a port you meant it, and
# silently using a different one would be its own way of running against something unexpected.
if nc -z "$HOST" "$PORT" 2>/dev/null; then
  if [ -n "$PORT_WAS_EXPLICIT" ]; then
    echo "scripts/emulator.sh: REFUSING -- something is already listening on $HOST:$PORT," >&2
    echo "  and you asked for that port explicitly. Attaching to it would run this suite" >&2
    echo "  against a backend of unknown state, which is how results get silently corrupted." >&2
    echo "  Either another run is in progress (wait for it) or a stale emulator is left over:" >&2
    echo "    pkill -f emulators:start; pkill -f cloud-firestore-emulator" >&2
    exit 1
  fi
  BUSY="$PORT"
  PORT=""
  for candidate in $(seq 8090 8140); do
    nc -z "$HOST" "$candidate" 2>/dev/null || { PORT="$candidate"; break; }
  done
  if [ -z "$PORT" ]; then
    echo "scripts/emulator.sh: $HOST:$BUSY is busy and no free port found in 8090-8140." >&2
    exit 1
  fi
  echo "scripts/emulator.sh: $HOST:$BUSY is busy (not ours); using $HOST:$PORT instead." >&2
fi

LOG="$(mktemp -t firestore-emulator-XXXXXX.log)"
OVERRIDE=""
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

  # WAIT for the socket to actually release, do not just kill and return.
  #
  # Killing the process group does not mean the listening socket is gone by the time this
  # function returns. A back-to-back run then either fails to bind or, worse, connects to a
  # half-dead emulator -- which is exactly what happened when I ran three measurement rounds in
  # a loop with `pkill; sleep 6` between them: round 1 passed and rounds 2 and 3 failed 13/15
  # in ~400ms each. That looked like the test being unstable. It was the teardown.
  for _ in $(seq 1 60); do
    nc -z "$HOST" "$PORT" 2>/dev/null || break
    sleep 0.5
  done
  if nc -z "$HOST" "$PORT" 2>/dev/null; then
    echo "scripts/emulator.sh: WARNING -- $HOST:$PORT still listening after teardown." >&2
    echo "  A following run will refuse to start rather than attach to it." >&2
  fi
  # Surface the emulator log only on failure; on success it is noise.
  if [ "$code" -ne 0 ] && [ -s "$LOG" ]; then
    echo "--- emulator log (tail) ---" >&2
    tail -30 "$LOG" >&2
  fi
  rm -f "$LOG"
  [ -n "$OVERRIDE" ] && rm -f "$OVERRIDE"
  exit "$code"
}
trap cleanup EXIT INT TERM

# THE PORT LIVES IN firebase.json, so moving off a busy default needs a config, not a flag:
# `emulators:start` has no per-emulator port option. The override is written NEXT TO the real
# firebase.json rather than in a temp directory, because firestore.rules and
# firestore.indexes.json are named relatively and `--config` resolves them against the config's
# own location -- from /tmp they would silently not be found.
CONFIG_ARG=()
if [ "$PORT" != "8080" ]; then
  OVERRIDE="$(pwd)/.firebase-emulator-$$.json"
  node -e '
    const fs = require("node:fs");
    const j = JSON.parse(fs.readFileSync("firebase.json", "utf8"));
    j.emulators = { ...(j.emulators ?? {}), firestore: { ...(j.emulators?.firestore ?? {}), port: Number(process.argv[1]) } };
    fs.writeFileSync(process.argv[2], JSON.stringify(j, null, 2));
  ' "$PORT" "$OVERRIDE"
  CONFIG_ARG=(--config "$OVERRIDE")
fi

# --project demo-* means the SDK never needs real credentials and refuses to reach a live
# project, so a mistake here cannot bill anything.
set -m
# `${A[@]+"${A[@]}"}`, NOT `"${A[@]}"`. macOS ships bash 3.2.57, where expanding an EMPTY array
# under `set -u` aborts with `CONFIG_ARG[@]: unbound variable`. The plain form works fine whenever
# the array has entries -- which is to say it works on a machine whose port 8080 is busy, and
# breaks on every machine where it is free, including CI. Tested both ways rather than reasoned
# about, because that is a failure nobody would hit until after it shipped.
firebase emulators:start --only firestore --project "$PROJECT" \
  ${CONFIG_ARG[@]+"${CONFIG_ARG[@]}"} >"$LOG" 2>&1 &
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
