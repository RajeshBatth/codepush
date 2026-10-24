#!/usr/bin/env bash
# Shared helpers for scripts/*.sh. Source after `set -euo pipefail`:  . "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# Provides: OTA_ROOT (via env.sh), say/warn/die, run (prints then runs), c_* colors, human_kb, du_kb.

_common_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OTA_ENV_QUIET=1 . "$_common_dir/../env.sh"
unset _common_dir

if [ -t 1 ]; then c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'; else c_red=''; c_grn=''; c_yel=''; c_dim=''; c_off=''; fi

say()  { printf '%s\n' "$*"; }
warn() { printf '%sWARN%s %s\n' "$c_yel" "$c_off" "$*" >&2; }
die()  { printf '%sERROR%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
# print the command (with its cwd relative to the repo) and run it; non-zero exit propagates through `set -e`
run()  { printf '%s$ %s%s\n' "$c_dim" "$*" "$c_off"; "$@"; }

du_kb() { local t=0 k p; for p in "$@"; do [ -e "$p" ] || continue; k=$(du -sk "$p" 2>/dev/null | awk '{print $1}'); t=$((t + ${k:-0})); done; echo "$t"; }
human_kb() { awk -v k="$1" 'BEGIN{ if (k>=1048576) printf "%.1f GB", k/1048576; else if (k>=1024) printf "%.1f MB", k/1024; else printf "%d KB", k }'; }
