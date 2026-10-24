#!/bin/bash
# usage: demo_hbc.sh <hermesc> <dist dir> <outdir>   (compiles with RN release flags -O -emit-binary -max-diagnostic-width=80)
H=$1; D=$2; O=$3; mkdir -p $O
for f in $D/host.js $D/units/*.js; do
  n=$(basename $f .js); mkdir -p $O/w_$n; cp $f $O/w_$n/bundle.js
  (cd $O/w_$n && $H -emit-binary -max-diagnostic-width=80 -O $HFLAGS -out ../$n.hbc bundle.js 2>&1 | head -3)
  echo "$n js=$(stat -f %z $f) hbc=$(stat -f %z $O/$n.hbc) zstd19(js)=$(zstd -19 -q -c $f|wc -c) zstd19(hbc)=$(zstd -19 -q -c $O/$n.hbc|wc -c)"
done
