#!/usr/bin/env bash
#
# scripts/test-app-reset.sh — cleanly kill the test-app dev stack.
#
# The test-app runs as `concurrently` ⇢ `tsx watch server/index.ts` + `vite`.
# `tsx --watch` reloads the module file but in-memory state (Maps, counters)
# can survive across reloads, and a leftover Vite process on :5173 makes
# Playwright's `reuseExistingServer: true` skip the new webServer boot.
# Both produce the silent "this fix should work but doesn't" failure mode
# captured in MEMORY.md (project_dev_server_stale_state).
#
# This script is idempotent and safe to run when nothing is up.
#
# Usage:
#   ./scripts/test-app-reset.sh           # default — kill + verify
#   ./scripts/test-app-reset.sh --quiet   # suppress non-error output
#   ./scripts/test-app-reset.sh --help

set -uo pipefail

# Ignore signals that the killees might bounce back to us (e.g. SIGTERM via
# shared process group, SIGPIPE from a half-closed log stream, SIGHUP from
# a parent shell exit). We want to drive the kill — not be killed by it.
trap '' HUP PIPE TERM

QUIET=0
for arg in "$@"; do
  case "$arg" in
    -q|--quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//;$d'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

log() { if [[ $QUIET -eq 0 ]]; then echo "$@"; fi; }
err() { echo "$@" >&2; }

# Patterns scoped tightly enough to avoid killing unrelated processes:
#   - `concurrently -n server,client` is unique to the test-app dev script
#   - `tsx watch server/index.ts` is unique to the test-app server
#   - `node .../vite/bin/vite.js` running with cwd ending in `examples/test-app`
PATTERNS=(
  "concurrently.*server,client"
  "tsx.*server/index\\.ts"
  "node.*vite/bin/vite"
)

# Step 1: collect PIDs by pattern, then SIGTERM them.
killed_any=0
declare -a TARGET_PIDS=()
for pattern in "${PATTERNS[@]}"; do
  # `pgrep -f` matches against the full command line.
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && TARGET_PIDS+=("$pid")
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
done

if [[ ${#TARGET_PIDS[@]} -gt 0 ]]; then
  killed_any=1
  log "→ SIGTERM to test-app pids: ${TARGET_PIDS[*]}"
  kill -TERM "${TARGET_PIDS[@]}" 2>/dev/null || true

  # Give graceful exit up to 2 seconds.
  for _ in 1 2 3 4; do
    sleep 0.5
    still_alive=0
    for pid in "${TARGET_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        still_alive=1
        break
      fi
    done
    [[ $still_alive -eq 0 ]] && break
  done

  # Step 2: SIGKILL any survivors.
  for pid in "${TARGET_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      log "  ↳ SIGKILL stubborn pid $pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

# Step 3: free the well-known ports as a backstop. Even with clean kills,
# zombie node processes from earlier sessions sometimes hold :3000 / :5173.
for port in 3000 5173; do
  port_pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [[ -n "$port_pid" ]]; then
    killed_any=1
    log "→ port $port still held by pid $port_pid — SIGKILL"
    kill -KILL "$port_pid" 2>/dev/null || true
  fi
done

# Step 4: final verification — nothing should be left.
sleep 0.3
remnants=()
for pattern in "${PATTERNS[@]}"; do
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && remnants+=("$pid:$pattern")
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
done
for port in 3000 5173; do
  port_pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  [[ -n "$port_pid" ]] && remnants+=("$port_pid:port-$port")
done

if [[ ${#remnants[@]} -gt 0 ]]; then
  err "WARNING: processes still alive after reset: ${remnants[*]}"
  exit 1
fi

if [[ $killed_any -eq 0 ]]; then
  log "test-app dev stack: nothing to clean up"
else
  log "test-app dev stack: reset OK"
fi
