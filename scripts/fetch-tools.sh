#!/usr/bin/env bash
# Fetch the sha256-pinned hermesc (react-native@0.78.3 tarball) into <repo>/.tools and show where hdiffz_tool / ota_apply are.
# Needs network (npm pack) the first time. Extra args are passed to `ota-build fetch-tools` (e.g. --force).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
run node "$OTA_ROOT/packages/ota-build/src/cli.ts" fetch-tools "$@"
