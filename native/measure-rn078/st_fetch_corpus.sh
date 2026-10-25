#!/bin/bash
# usage: st_fetch_corpus.sh [dir]   (default <repo>/.work/st/src) -> <dir>/{lodash,rxjs,date-fns,moment}/package  (npm tarballs, extracted only, never executed)
set -e
D=${1:-$(cd "$(dirname "$0")/../.." && pwd)/.work/st/src}; mkdir -p "$D/../tgz"; T=$(cd "$D/../tgz" && pwd)
cd "$T"
for p in lodash@4.17.21 rxjs@7.8.1 date-fns@2.30.0 moment@2.30.1; do
  n=${p%@*}; [ -f $n-*.tgz ] || npm pack $p >/dev/null 2>&1
  mkdir -p "$D/$n"; tar xzf $n-*.tgz -C "$D/$n"
done
ls "$D"
