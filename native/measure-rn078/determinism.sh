#!/bin/bash
# usage: determinism.sh <hermesc> <js file> <workdir>
H=$1; J=$2; W=$3; rm -rf $W; mkdir -p $W/a $W/b/deep/er; cp $J $W/a/bundle.js; cp $J $W/b/deep/er/other_name.js
FL="-O -emit-binary -max-diagnostic-width=80"
h(){ shasum -a 256 "$1" | cut -c1-16; }
echo "1. same dir/name, twice (time apart)"; (cd $W/a && $H $FL -out ../a1.hbc bundle.js 2>/dev/null; sleep 2; $H $FL -out ../a2.hbc bundle.js 2>/dev/null); cmp $W/a1.hbc $W/a2.hbc && echo identical
echo "2. same name, different dir (relative)"; (cd $W/b/deep/er && cp bundle.js x 2>/dev/null; cp ../../../a/bundle.js bundle.js && $H $FL -out ../../../b1.hbc bundle.js 2>/dev/null); cmp $W/a1.hbc $W/b1.hbc && echo identical
echo "3. same dir, different file name"; (cd $W/a && cp bundle.js renamed.js && $H $FL -out ../a3.hbc renamed.js 2>/dev/null); cmp -l $W/a1.hbc $W/a3.hbc | wc -l | xargs echo "differing bytes:"
echo "4. absolute path vs relative path"; $H $FL -out $W/a4.hbc $W/a/bundle.js 2>/dev/null; cmp -l $W/a1.hbc $W/a4.hbc | wc -l | xargs echo "differing bytes:"
echo "5. different dirs absolute path"; $H $FL -out $W/b5.hbc $W/b/deep/er/bundle.js 2>/dev/null; cmp -l $W/a4.hbc $W/b5.hbc | wc -l | xargs echo "differing bytes:"
echo "6. stdin"; $H $FL -out $W/s1.hbc - < $W/a/bundle.js 2>/dev/null; (cd $W/b && $H $FL -out $W/s2.hbc - < $W/a/bundle.js 2>/dev/null); cmp $W/s1.hbc $W/s2.hbc && echo "stdin identical"; cmp -l $W/a1.hbc $W/s1.hbc | wc -l | xargs echo "stdin vs bundle.js differing bytes:"
echo "7. strings containing path / name in output"; for f in a1 a3 a4; do echo "$f: $(strings -a $W/$f.hbc | grep -E '/Users|renamed|bundle\.js|\.js$' | head -3 | tr '\n' ' ')"; done
echo "8. with -output-source-map: map content + hbc diff"; (cd $W/a && $H $FL -output-source-map -out ../m1.hbc bundle.js 2>/dev/null); (cd $W/b/deep/er && $H $FL -output-source-map -out ../../../m2.hbc bundle.js 2>/dev/null); cmp $W/m1.hbc $W/m2.hbc && echo "hbc identical"; cmp $W/a1.hbc $W/m1.hbc && echo "same as without map flag"; ls $W/*.map; head -c 300 $W/m1.hbc.map; echo
