#!/bin/sh
# Estimates the binary-size cost of the patch side for each plugin combination.
# Builds with -Os, section GC and dead stripping (what an app build does), then strips.
# usage: tools/measure_size.sh [workdir]     (macOS arm64 numbers; Android arm64 is the same order)
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/otacore-size}"
CC_BIN=${CC:-/usr/bin/clang}; CXX_BIN=${CXX:-/usr/bin/clang++}
for cfg in "none:OFF:OFF" "zstd:ON:OFF" "lzma:OFF:ON" "zstd+lzma:ON:ON"; do
  name=${cfg%%:*}; rest=${cfg#*:}; z=${rest%%:*}; l=${rest#*:}
  dir="$WORK/$name"
  cmake -S "$SRC" -B "$dir" -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$CC_BIN" -DCMAKE_CXX_COMPILER="$CXX_BIN" \
    -DOTACORE_ZSTD=$z -DOTACORE_LZMA=$l \
    -DCMAKE_C_FLAGS="-Os -ffunction-sections -fdata-sections -fvisibility=hidden" \
    -DCMAKE_CXX_FLAGS="-Os -ffunction-sections -fdata-sections -fvisibility=hidden -fvisibility-inlines-hidden" \
    -DCMAKE_EXE_LINKER_FLAGS="-Wl,-dead_strip" > /dev/null
  cmake --build "$dir" --target size_probe size_probe_base size_probe_manifest -j8 > /dev/null 2>&1 || { echo "$name: build failed"; continue; }
  strip -x "$dir/size_probe" "$dir/size_probe_base" "$dir/size_probe_manifest" 2>/dev/null
  # Sum of section sizes in __TEXT and __DATA (no Mach-O header, no page padding), after strip.
  sec() { size -m "$1" | awk '/^Segment __(TEXT|DATA|DATA_CONST):/ {on=1} /^Segment __PAGEZERO|^Segment __LINKEDIT/ {on=0} on && /^\tSection/ {s+=$NF} END {print s}'; }
  b=$(sec "$dir/size_probe_base"); p=$(sec "$dir/size_probe")
  echo "$name: sections(text+data) with applyPatch $p B, without $b B => patch-side cost $((p-b)) B"
  m=$(sec "$dir/size_probe_manifest")
  echo "    manifest parse+validate+select (nlohmann/json) cost $((m-b)) B"
done
