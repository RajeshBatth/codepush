#!/usr/bin/env bash
# Configure + build the native C++ (native/): patch applier, runtime, tests, tools.
#   native-build.sh [--asan] [--tools] [--dir DIR] [-j N] [--clean] [-- extra cmake --build args]
#     (default)  all targets into native/build (what `ctest` runs)
#     --asan     -DOTACORE_SANITIZE=ON (ASan+UBSan) into native/build-asan
#     --tools    only hdiffz_tool + ota_apply into native/build-ota-tools (what ota-build uses)
#     --clean    remove the build dir first
# Always passes /usr/bin/clang(++): the clang* in /usr/local/bin are broken ccache symlinks. The first build is slow.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

asan=0; tools=0; clean=0; dir=""; jobs="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
while [ $# -gt 0 ]; do
  case "$1" in
    --asan) asan=1 ;;
    --tools) tools=1 ;;
    --clean) clean=1 ;;
    --dir) shift; dir="$1" ;;
    -j) shift; jobs="$1" ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    --) shift; break ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

command -v cmake >/dev/null || die "cmake not found (brew install cmake; expected in /opt/homebrew/bin)"
[ -x /usr/bin/clang++ ] || die "/usr/bin/clang++ missing: install the Xcode command line tools (xcode-select --install)"
if [ -z "$dir" ]; then
  if [ "$asan" = 1 ]; then dir="native/build-asan"; elif [ "$tools" = 1 ]; then dir="native/build-ota-tools"; else dir="native/build"; fi
fi
case "$dir" in /*) bdir="$dir" ;; *) bdir="$OTA_ROOT/$dir" ;; esac

[ "$clean" = 1 ] && { say "cleaning $bdir"; rm -rf "$bdir"; }
cfg=(-S "$OTA_ROOT/native" -B "$bdir" -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++)
[ "$asan" = 1 ] && cfg+=(-DOTACORE_SANITIZE=ON)
run cmake "${cfg[@]}"
build=(--build "$bdir" -j "$jobs")
[ "$tools" = 1 ] && build+=(--target ota_apply hdiffz_tool)
run cmake "${build[@]}" "$@"
say "native build OK: $bdir"
