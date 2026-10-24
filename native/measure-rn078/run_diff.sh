#!/bin/bash
# usage: run_diff.sh <hermesc> <srcroot containing lodash/ rxjs/ date-fns/ moment/ (npm-packed)> <workdir>
# Rebuilds the corpus (native/tools/make_hbc_corpus.mjs), compiles v1/v2 with `hermesc -O -emit-binary`, diffs with hdiffz_tool.
set -e
H=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); SRC=$2; W=$3
T=$(cd "$(dirname "$0")/.." && pwd)/tools; HD=$(cd "$(dirname "$0")/.." && pwd)/build/hdiffz_tool
mkdir -p "$W"
sz(){ stat -f %z "$1"; }
for sc in tweak feature big; do
  d=$W/$sc; mkdir -p $d
  node $T/make_hbc_corpus.mjs $d $sc $SRC/lodash/package $SRC/rxjs/package/dist/cjs $SRC/date-fns/package $SRC/moment/package >/dev/null
  # fixed cwd + fixed relative name so output is reproducible
  for v in v1 v2; do (cd $d && mkdir -p b_$v && cp $v.js b_$v/bundle.js && cd b_$v && $H -O -emit-binary $HFLAGS -out ../$v.hbc bundle.js); done
  for pair in "js:v1.js:v2.js" "hbc:v1.hbc:v2.hbc"; do
    IFS=: read k a b <<<"$pair"
    for c in zstd lzma none; do $HD -c $c -l 19 $d/$a $d/$b $d/$k.$c.patch >/dev/null 2>&1 || $HD -c $c $d/$a $d/$b $d/$k.$c.patch >/dev/null; done
  done
  zz=$(zstd -19 -q -c $d/v2.hbc | wc -c); jz=$(zstd -19 -q -c $d/v2.js | wc -c)
  echo "$sc | js $(sz $d/v2.js) hbc $(sz $d/v2.hbc) zstd(hbc) $zz zstd(js) $jz | HBC diff none $(sz $d/hbc.none.patch) zstd $(sz $d/hbc.zstd.patch) lzma $(sz $d/hbc.lzma.patch) | JS diff none $(sz $d/js.none.patch) zstd $(sz $d/js.zstd.patch) lzma $(sz $d/js.lzma.patch)"
done
