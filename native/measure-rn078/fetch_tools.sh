#!/bin/bash
# Fetch (untrusted) tarballs into <dir>, extract ONLY binaries/sources needed; nothing from them is executed except hermesc/hermes.
# usage: fetch_tools.sh <dir>   -> <dir>/rn/x/package/sdks/hermesc/osx-bin/{hermesc,hermes}, <dir>/src/{lodash,rxjs,date-fns,moment}/package
set -e; D=$1; mkdir -p $D/rn/x $D/src; cd $D/rn
npm pack react-native@0.78.3 >/dev/null
tar xzf react-native-0.78.3.tgz -C x package/sdks/.hermesversion package/sdks/hermesc/osx-bin package/scripts/react-native-xcode.sh package/package.json
shasum -a 256 x/package/sdks/hermesc/osx-bin/hermes{c,}
cd ../src; for p in lodash@4.17.21 rxjs@7.8.1 date-fns@2.30.0 moment@2.30.1; do npm pack $p >/dev/null; n=${p%@*}; mkdir -p $n; tar xzf $n-*.tgz -C $n; done
