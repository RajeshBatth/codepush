#!/bin/bash
# usage: st_fetch_hermes_src.sh [dir]  -> fetches the Hermes sources read for the study at the EXACT commit RN 0.78.3 pins (data only, never built/executed)
set -e
C=a942ef374897d85da38e9c8904574f8376555388
D=${1:-$(cd "$(dirname "$0")/../.." && pwd)/.work/st/hsrc}; mkdir -p "$D"; cd "$D"
R=https://raw.githubusercontent.com/facebook/hermes/$C
for f in lib/BCGen/HBC/{HBC.cpp,ConsecutiveStringStorage.cpp,UniquingStringLiteralTable.cpp,TraverseLiteralStrings.cpp,BytecodeStream.cpp,BytecodeGenerator.cpp} include/hermes/BCGen/HBC/{BytecodeList.def,BytecodeFileFormat.h,StringKind.h,ConsecutiveStringStorage.h,UniquingStringLiteralTable.h}; do
  curl -sf -m 60 -o "$(basename $f)" "$R/$f"
done
ls "$D"
