
#### structure-aware upper bound, unit 30000 (hbc 30628 B, 454 strings, 202 functions); seed 1

| edit | plain diff | `-base-bytecode` diff (no device change) | remap-base diff (old' -> new) | side info S / F | remap total | remap applied to the `-base-bytecode` output | ID-free dump-text diff (semantic floor) |
|---|---:|---:|---:|---:|---:|---:|---:|
| E2 ("incompatibleTokens" -> "sne) | 1040 | 199 | 311 | 46 / 25 | 382 | 245 (vs 199 without) | 81 |
| E4 (insert string in fn) | 944 | 253 | 336 | 35 / 26 | 397 | 300 (vs 253 without) | 134 |
| E5 (append new __d module #1) | 2626 | 447 | 662 | 79 / 24 | 765 | 488 (vs 447 without) | 313 |
| E5b (fn at end of module) | 3543 | 1219 | 1343 | 79 / 26 | 1448 | 1160 (vs 1219 without) | 387 |
| E6 (fn at start of module) | 3394 | 931 | 1055 | 126 / 26 | 1207 | 779 (vs 931 without) | 331 |
| E7 (remove "priority") | 195 | 85 | 170 | 25 / 25 | 220 | 131 (vs 85 without) | 44 |
| E8 (rename .schedule) | 1050 | 247 | 331 | 45 / 25 | 401 | 292 (vs 247 without) | 49 |

#### structure-aware upper bound, unit 300000 (hbc 294892 B, 2705 strings, 2039 functions); seed 1

| edit | plain diff | `-base-bytecode` diff (no device change) | remap-base diff (old' -> new) | side info S / F | remap total | remap applied to the `-base-bytecode` output | ID-free dump-text diff (semantic floor) |
|---|---:|---:|---:|---:|---:|---:|---:|
| E2 ("No matching values" -> "seu) | 10538 | 555 | 2933 | 156 / 27 | 3116 | 603 (vs 555 without) | 84 |
| E4 (insert string in fn) | 4888 | 653 | 1183 | 29 / 27 | 1239 | 703 (vs 653 without) | 115 |
| E5 (append new __d module #1) | 10624 | 916 | 4234 | 86 / 23 | 4343 | 961 (vs 916 without) | 292 |
| E5b (fn at end of module) | 11681 | 1773 | 4333 | 86 / 29 | 4448 | 1105 (vs 1773 without) | 318 |
| E6 (fn at start of module) | 11777 | 3129 | 4385 | 86 / 27 | 4498 | 1373 (vs 3129 without) | 683 |
| E7 (remove "observed") | 6537 | 85 | 1129 | 43 / 26 | 1198 | 132 (vs 85 without) | 45 |
| E8 (rename .toPromise) | 9808 | 461 | 3144 | 105 / 29 | 3278 | 509 (vs 461 without) | 52 |

#### structure-aware upper bound, unit host (hbc 860712 B, 5764 strings, 4816 functions); seed 1

| edit | plain diff | `-base-bytecode` diff (no device change) | remap-base diff (old' -> new) | side info S / F | remap total | remap applied to the `-base-bytecode` output | ID-free dump-text diff (semantic floor) |
|---|---:|---:|---:|---:|---:|---:|---:|
| E2 ("address at " -> " ta sserdd) | 44994 | 905 | 19580 | 757 / 38 | 20375 | 998 (vs 905 without) | 75 |
| E4 (insert string in fn) | 41901 | 1637 | 15641 | 774 / 41 | 16456 | 1734 (vs 1637 without) | 140 |
| E5 (append new __d module #1) | 46865 | 2134 | 21078 | 842 / 33 | 21953 | 2226 (vs 2134 without) | 983 |
| E5b (fn at end of module) | 49320 | 3845 | 21168 | 842 / 38 | 22048 | 2245 (vs 3845 without) | 309 |
| E6 (fn at start of module) | 47236 | 3128 | 21292 | 842 / 36 | 22170 | 2435 (vs 3128 without) | 338 |
| E7 (remove "DeviceEventManager") | 48093 | 86 | 18873 | 744 / 38 | 19655 | 181 (vs 86 without) | 59 |
| E8 (rename .lastIndexOf) | 28215 | 908 | 3995 | 86 / 42 | 4123 | 1006 (vs 908 without) | 51 |
