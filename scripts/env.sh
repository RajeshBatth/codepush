#!/usr/bin/env bash
# Source me:  . scripts/env.sh        (works from any cwd; bash and zsh)
#
# Sets up the toolchain environment for this repo:
#  - PATH: newest nvm node v24 (falls back to the node already on PATH), then /opt/homebrew/bin (cmake, ninja, ...)
#  - CC/CXX=/usr/bin/clang(++). NOTE: /usr/local/bin/clang* on this machine are broken ccache symlinks, so never rely on
#    the bare `clang` found via PATH; native builds must pass the compilers explicitly (native-build.sh does).
#  - OTA_ROOT: absolute path of the repo root.
# Set OTA_ENV_QUIET=1 to suppress the version printout. This file never changes shell options (safe to source anywhere).

if [ -n "${BASH_SOURCE[0]:-}" ]; then _ota_self="${BASH_SOURCE[0]}"; else _ota_self="${(%):-%x}"; fi
OTA_ROOT="$(cd "$(dirname "$_ota_self")/.." && pwd)"
export OTA_ROOT
unset _ota_self

_ota_node_bin=""
for _d in "$HOME"/.nvm/versions/node/v24*/bin; do [ -x "$_d/node" ] && _ota_node_bin="$_d"; done
if [ -n "$_ota_node_bin" ]; then
  case ":$PATH:" in *":$_ota_node_bin:"*) ;; *) PATH="$_ota_node_bin:$PATH" ;; esac
fi
unset _d
case ":$PATH:" in *":/opt/homebrew/bin:"*) ;; *) [ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH" ;; esac
unset _ota_node_bin
export PATH

if [ -x /usr/bin/clang ]; then export CC=/usr/bin/clang; export CXX=/usr/bin/clang++; fi

# Android SDK default location on macOS (only exported if present and not already set)
if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk"; fi

if [ -z "${OTA_ENV_QUIET:-}" ]; then
  echo "[env] OTA_ROOT=$OTA_ROOT"
  echo "[env] node  $(node -v 2>/dev/null || echo MISSING)  ($(command -v node 2>/dev/null || echo -))"
  echo "[env] npm   $(npm -v 2>/dev/null || echo MISSING)"
  echo "[env] cmake $(cmake --version 2>/dev/null | head -1 | awk '{print $3}' || true)"
  echo "[env] CC=${CC:-unset} CXX=${CXX:-unset}  ($( [ -n "${CXX:-}" ] && "$CXX" --version 2>/dev/null | head -1 || true))"
fi
