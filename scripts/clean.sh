#!/usr/bin/env bash
# Remove regenerable build output and report the reclaimed space:  <repo>/.work  and  native/build*  (all native build dirs).
# NEVER touches node_modules, sources, .tools or schemas. Asks nothing. --dry-run only lists what would go.
# Note: native/build-ota-tools holds hdiffz_tool/ota_apply used by ota-build; rebuild with scripts/native-build.sh --tools.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

dry=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) dry=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) die "unknown option $a (see --help)" ;;
  esac
done

targets=()
[ -e "$OTA_ROOT/.work" ] && targets+=("$OTA_ROOT/.work")
for d in "$OTA_ROOT"/native/build*; do [ -d "$d" ] && targets+=("$d"); done

if [ ${#targets[@]} -eq 0 ]; then say "nothing to clean"; exit 0; fi
total=0
for t in "${targets[@]}"; do
  # safety: only ever delete things strictly inside the repo
  case "$t" in "$OTA_ROOT"/.work|"$OTA_ROOT"/native/build*) ;; *) die "refusing to touch $t" ;; esac
  k=$(du_kb "$t"); total=$((total + k))
  if [ "$dry" = 1 ]; then say "would remove ${t#$OTA_ROOT/}  ($(human_kb "$k"))"; else say "removing ${t#$OTA_ROOT/}  ($(human_kb "$k"))"; rm -rf "$t"; fi
done
if [ "$dry" = 1 ]; then say "dry run: $(human_kb "$total") would be reclaimed"; else say "reclaimed $(human_kb "$total")"; fi
