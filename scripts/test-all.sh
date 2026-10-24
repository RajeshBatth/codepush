#!/usr/bin/env bash
# Run every test suite of the repo in order and print a summary table.
#   test-all.sh [--fast] [--native] [--no-android]
#     --fast        only the quick JS suites: ota-core (tests + typecheck + schemas) and ota-cli
#                   (skips unit-splitter ~2 min and ota-build, which run Metro + hermesc + native tools)
#     --native      also build (incremental) native/build and run its CTest suite
#     --no-android  accepted for CI parity: no suite in this repo currently needs an Android device/emulator
# Order: ota-core tests, ota-core typecheck, ota-cli, unit-splitter, ota-build (SKIPped with a reason if its tools are
# missing), [native ctest]. Logs: <repo>/.work/test-all/<suite>.log. Exit 1 if any suite FAILed. SKIP is not a failure.
# Per-suite timeout: OTA_SUITE_TIMEOUT seconds (default 1800); no hung processes are left behind.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

fast=0; native=0; noandroid=0
for a in "$@"; do
  case "$a" in
    --fast) fast=1 ;;
    --native) native=1 ;;
    --no-android) noandroid=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option $a (see --help)" ;;
  esac
done
LOGDIR="$OTA_ROOT/.work/test-all"
mkdir -p "$LOGDIR"
LIMIT="${OTA_SUITE_TIMEOUT:-1800}"
set -m  # each background job gets its own process group so a timeout can kill the whole tree

rows=()          # "name|status|pass|fail|skip|secs"
anyfail=0
t_start=$SECONDS

# run_limited <seconds> <logfile> cmd... : exit 124 on timeout
run_limited() {
  local limit="$1" log="$2"; shift 2
  "$@" >"$log" 2>&1 &
  local pid=$!
  ( sleep "$limit"; kill -TERM -- "-$pid" 2>/dev/null; sleep 5; kill -KILL -- "-$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watcher=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ] && rc=124
  return "$rc"
}

# count extracted from node:test ("ℹ pass 12") or ctest output
node_count() { grep -E "^ℹ $2 " "$1" | tail -1 | awk '{print $3}'; }

# suite <name> <kind: node|tsc|ctest> <dir> cmd...
suite() {
  local name="$1" kind="$2" dir="$3"; shift 3
  local log="$LOGDIR/${name// /_}.log" t0=$SECONDS rc=0 p="-" f="-" s="-" status
  printf '%s>> %s%s  (%s)\n' "$c_dim" "$name" "$c_off" "$*"
  (cd "$dir" && run_limited "$LIMIT" "$log" "$@") || rc=$?
  case "$kind" in
    node) p="$(node_count "$log" pass)"; f="$(node_count "$log" fail)"; s="$(node_count "$log" skipped)"; : "${p:=0}" "${f:=0}" "${s:=0}" ;;
    ctest) local line; line="$(grep -E "tests passed, " "$log" | tail -1 || true)"
           if [ -n "$line" ]; then f="$(echo "$line" | sed -E 's/.*, ([0-9]+) tests failed out of ([0-9]+).*/\1/')"; local tot; tot="$(echo "$line" | sed -E 's/.*out of ([0-9]+).*/\1/')"; p=$((tot - f)); s=0; fi ;;
  esac
  if [ "$rc" -eq 0 ]; then status=PASS
  elif [ "$rc" -eq 124 ]; then status="FAIL(timeout)"; anyfail=1
  else status=FAIL; anyfail=1; fi
  # a node suite whose every test was skipped (tools missing) is reported as SKIP
  if [ "$kind" = node ] && [ "$rc" -eq 0 ] && [ "${p}" = 0 ] && [ "${s}" != 0 ]; then status=SKIP; fi
  rows+=("$name|$status|$p|$f|$s|$((SECONDS - t0))")
  if [ "$status" != PASS ] && [ "$status" != SKIP ]; then
    printf '%s-- last 40 lines of %s --%s\n' "$c_red" "$log" "$c_off"; tail -40 "$log"
  fi
}
skip() { rows+=("$1|SKIP|-|-|-|0"); printf '%sSKIP%s %s: %s\n' "$c_yel" "$c_off" "$1" "$2"; }

say "test-all: root=$OTA_ROOT fast=$fast native=$native no-android=$noandroid"
[ "$noandroid" = 1 ] && say "(--no-android: no suite here needs an Android device; nothing to skip)"

suite "ota-core test"      node "$OTA_ROOT/packages/ota-core" npm test --silent
suite "ota-core typecheck" tsc  "$OTA_ROOT/packages/ota-core" npm run --silent typecheck
suite "ota-cli test"       node "$OTA_ROOT/packages/ota-cli"  npm test --silent

if [ "$fast" = 1 ]; then
  skip "unit-splitter test" "--fast"
  skip "ota-build test" "--fast"
else
  if [ -d "$OTA_ROOT/packages/unit-splitter/node_modules" ]; then
    suite "unit-splitter test" node "$OTA_ROOT/packages/unit-splitter" npm test --silent
  else skip "unit-splitter test" "dependencies not installed (cd packages/unit-splitter && npm install)"; fi
  missing=""
  [ -x "$OTA_ROOT/.tools/hermesc-rn0.78.3/hermesc" ] || [ -n "${OTA_HERMESC:-}" ] || missing="$missing hermesc(scripts/fetch-tools.sh)"
  [ -x "$OTA_ROOT/native/build-ota-tools/hdiffz_tool" ] || [ -n "${OTA_HDIFFZ:-}" ] || [ -n "${OTA_HDIFFZ_TOOL:-}" ] || missing="$missing hdiffz_tool(scripts/native-build.sh --tools)"
  [ -x "$OTA_ROOT/native/build-ota-tools/ota_apply" ] || [ -n "${OTA_APPLY:-}" ] || missing="$missing ota_apply(scripts/native-build.sh --tools)"
  if [ -n "$missing" ]; then skip "ota-build test" "tools missing:$missing"
  else suite "ota-build test" node "$OTA_ROOT/packages/ota-build" npm test --silent; fi
fi

if [ "$native" = 1 ]; then
  nb="$OTA_ROOT/native/build"
  if "$OTA_ROOT/scripts/native-build.sh" >"$LOGDIR/native-build.log" 2>&1; then
    suite "native ctest" ctest "$OTA_ROOT" ctest --test-dir "$nb" --output-on-failure
  else
    rows+=("native ctest|FAIL|-|-|-|0"); anyfail=1
    printf '%s-- native build failed; last 40 lines of %s --%s\n' "$c_red" "$LOGDIR/native-build.log" "$c_off"; tail -40 "$LOGDIR/native-build.log"
  fi
fi

say ""
printf '%-22s %-14s %6s %6s %6s %7s\n' SUITE RESULT PASS FAIL SKIP SECS
printf '%-22s %-14s %6s %6s %6s %7s\n' ---------------------- -------------- ------ ------ ------ -------
for r in "${rows[@]}"; do
  IFS='|' read -r n st p f s t <<<"$r"
  printf '%-22s %-14s %6s %6s %6s %7s\n' "$n" "$st" "$p" "$f" "$s" "$t"
done
say ""
say "total time: $((SECONDS - t_start))s   logs: ${LOGDIR#$OTA_ROOT/}/"
if [ "$anyfail" -ne 0 ]; then say "RESULT: FAIL"; exit 1; fi
say "RESULT: OK"
