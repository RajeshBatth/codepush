#!/bin/bash
# Reproduce every number in STRING_TABLE.md (about 15 minutes on an M-series laptop). Writes to <repo>/.work/st/results (scratch, delete afterwards).
#   ./st_run_all.sh            from native/measure-rn078
# Needs: node >= 24, npm (corpus tarballs), curl (Hermes sources), zstd, the pinned hermesc in <repo>/.tools/hermesc-rn0.78.3/hermesc,
#        native/build-ota-tools/hdiffz_tool, and the spike-app host bundle (step 0) for the "host" rows.
set -e
export PATH=$(ls -d ~/.nvm/versions/node/v24*/bin):/opt/homebrew/bin:$PATH
cd "$(dirname "$0")"; REPO=$(cd ../.. && pwd); W=$REPO/.work/st; R=$W/results; mkdir -p "$R"
T(){ perl -e 'alarm 3000; exec @ARGV' "$@"; }          # no GNU timeout on macOS
# 0. inputs: corpus (npm tarballs, extracted only), Hermes sources at the pinned commit (data only), spike-app host bundle (read-only use of the app)
[ -d $W/src/lodash ] || ./st_fetch_corpus.sh $W/src
[ -f $W/hsrc/BytecodeList.def ] || ./st_fetch_hermes_src.sh $W/hsrc
if [ ! -f $W/hostb/js/host.js ]; then
  cat > $W/mkhost.mjs <<'JS'
import { APP, bundle } from '../../examples/spike-app/scripts/lib.mjs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
await bundle({ project: APP, platform: 'android', out: path.join(here, 'hostb'), appVersion: '0.0.1' });
JS
  (cd $REPO/examples/spike-app && T node $W/mkhost.mjs)     # byte-identical to .spike-assets/android/embedded/host.hbc after hermesc
fi
# 1. mechanism
T node st_idorder.mjs        > $R/idorder_300000.txt;  T node st_idorder.mjs --size=host > $R/idorder_host.txt
for s in 30000 300000 host; do T node st_mech.mjs --size=$s --edit=all --seed=1 --delta=1 > $R/mech_$s.txt; done
T node st_norm.mjs --selftest > $R/norm_selftest.txt
# 2. matrix (3 positions x 9 edit classes x {30 KB, 300 KB, host}, plain and -base-bytecode)
T node st_matrix.mjs --sizes=30000,300000,host --out=$R/matrix.json 2> $R/matrix.log
node st_tables.mjs $R/matrix.json > $R/matrix_tables.md
T node st_spike_real.mjs     > $R/spike_real.md
# 3. mitigations
T node st_mitig.mjs flags --size=300000 > $R/flags_300000.md; T node st_mitig.mjs flags --size=host > $R/flags_host.md
T node st_mitig.mjs scale    > $R/scale.md
T node st_mitig.mjs copy     > $R/copy.md
T node st_mitig.mjs churn    > $R/churn.md
T node st_mitig.mjs params --size=300000 > $R/params_300000.md; T node st_mitig.mjs params --size=host > $R/params_host.md
T node st_mitig.mjs validate --size=30000 > $R/validate.md; T node st_mitig.mjs validate --size=300000 >> $R/validate.md; T node st_mitig.mjs validate --size=host >> $R/validate.md
for s in 30000 300000 host; do T node st_norm.mjs --size=$s --edit=E2,E4,E5,E5b,E6,E7,E8 --seed=1; done > $R/norm.md
for s in 300000 host; do T node st_rank.mjs --size=$s; done > $R/rank.md
echo "done: $R   (copy to native/measure-rn078/st_results/ if you want to keep them; then rm -rf $W)"
