#!/usr/bin/env bash
# Machine readiness check. No network. Prints PASS / WARN / FAIL per item; exit 1 if any FAIL.
#   FAIL = cannot run the JS pipeline or native build at all; WARN = some part (Android/iOS apps, ASan, ...) will not work.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

npass=0; nwarn=0; nfail=0
pass() { npass=$((npass+1)); printf '%sPASS%s %-26s %s\n' "$c_grn" "$c_off" "$1" "$2"; }
wrn()  { nwarn=$((nwarn+1)); printf '%sWARN%s %-26s %s\n' "$c_yel" "$c_off" "$1" "$2"; }
fail() { nfail=$((nfail+1)); printf '%sFAIL%s %-26s %s\n' "$c_red" "$c_off" "$1" "$2"; }

ver_ge() { # ver_ge 22.12.1 22.12  -> true if $1 >= $2 (numeric dotted compare)
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]
}

say "ota doctor  (repo: $OTA_ROOT)"
# ---- node / npm
if command -v node >/dev/null; then
  nv="$(node -v | sed 's/^v//')"
  if ! ver_ge "$nv" 22.12.0; then fail node "v$nv < 22.12 required ($(command -v node))"
  elif ! ver_ge "$nv" 24.0.0; then wrn node "v$nv works for schemas/ota-core, but ota-build declares engines >=24 (run .ts directly)"
  else pass node "v$nv ($(command -v node))"; fi
else fail node "not found (install via nvm: nvm install 24)"; fi
if command -v npm >/dev/null; then pass npm "$(npm -v)"; else fail npm "not found next to node"; fi

# ---- native toolchain
if command -v cmake >/dev/null; then pass cmake "$(cmake --version | head -1 | awk '{print $3}')"; else fail cmake "not found (brew install cmake; /opt/homebrew/bin)"; fi
if [ -x /usr/bin/clang++ ] && /usr/bin/clang++ --version >/dev/null 2>&1; then pass "clang++ (/usr/bin)" "$(/usr/bin/clang++ --version | head -1)"; else fail "clang++ (/usr/bin)" "missing or broken: xcode-select --install"; fi
bad=""
for c in /usr/local/bin/clang /usr/local/bin/clang++; do
  if [ -L "$c" ] && [ ! -e "$c" ]; then bad="$bad $c"; fi
done
if [ -n "$bad" ]; then wrn "ccache symlinks" "broken:$bad -> never use bare clang; scripts/native-build.sh passes /usr/bin/clang(++)"; else pass "ccache symlinks" "no broken /usr/local/bin/clang*"; fi

# ---- mobile
if command -v java >/dev/null && jv="$(java -version 2>&1 | head -1)"; then pass java "$jv"; else wrn java "not found (needed for Gradle / Android builds)"; fi
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ -d "$sdk" ]; then
  pass "android sdk" "$sdk"
  if [ -x "$sdk/emulator/emulator" ]; then pass "android emulator" "$sdk/emulator/emulator"; else wrn "android emulator" "not installed in $sdk/emulator"; fi
  if [ -x "$sdk/platform-tools/adb" ]; then pass adb "$sdk/platform-tools/adb"; else wrn adb "missing in $sdk/platform-tools"; fi
  if ls "$sdk/ndk" >/dev/null 2>&1 && [ -n "$(ls "$sdk/ndk" 2>/dev/null)" ]; then pass "android ndk" "$(ls "$sdk/ndk" | tr '\n' ' ')"; else wrn "android ndk" "none in $sdk/ndk (native Android build)"; fi
else wrn "android sdk" "not found (set ANDROID_HOME); Android app builds unavailable"; fi
if xp="$(xcode-select -p 2>/dev/null)" && [ -n "$xp" ] && command -v xcodebuild >/dev/null && xv="$(xcodebuild -version 2>/dev/null | head -1)" && [ -n "$xv" ]; then pass xcode "$xv ($xp)"; else wrn xcode "full Xcode not selected (iOS builds unavailable; CLT alone is enough for native tests)"; fi

# ---- repo state
[ -d "$OTA_ROOT/packages/ota-core/node_modules" ] && pass "deps: ota-core" "installed" || wrn "deps: ota-core" "run: (cd packages/ota-core && npm install)"
[ -d "$OTA_ROOT/packages/ota-cli/node_modules" ] && pass "deps: ota-cli" "installed" || wrn "deps: ota-cli" "run: (cd packages/ota-cli && npm install)"
[ -d "$OTA_ROOT/packages/unit-splitter/node_modules" ] && pass "deps: unit-splitter" "installed" || wrn "deps: unit-splitter" "run: (cd packages/unit-splitter && npm install)"
[ -x "$OTA_ROOT/.tools/hermesc-rn0.78.3/hermesc" ] && pass "tool: hermesc" ".tools/hermesc-rn0.78.3" || wrn "tool: hermesc" "missing: scripts/fetch-tools.sh (needs network once)"
for t in hdiffz_tool ota_apply; do
  [ -x "$OTA_ROOT/native/build-ota-tools/$t" ] && pass "tool: $t" "native/build-ota-tools" || wrn "tool: $t" "missing: scripts/native-build.sh --tools"
done

# ---- disk
avail_kb="$(df -k "$OTA_ROOT" | awk 'NR==2{print $4}')"
avail_gb=$((avail_kb / 1048576))
if [ "$avail_gb" -lt 3 ]; then fail "disk free" "$(human_kb "$avail_kb") (< 3 GB): run scripts/clean.sh"
elif [ "$avail_gb" -lt 10 ]; then wrn "disk free" "$(human_kb "$avail_kb") (< 10 GB; a native + Android build needs more)"
else pass "disk free" "$(human_kb "$avail_kb")"; fi

say ""
say "summary: $npass PASS, $nwarn WARN, $nfail FAIL"
[ "$nfail" -eq 0 ]
