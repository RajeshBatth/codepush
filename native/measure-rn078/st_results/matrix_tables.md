
#### ~30 KB unit: hbc 30628 B, JS 85538 B, `full` (zstd-19 of new hbc) ~14209 B

| edit | src diff (med) | hbc diff min / med / max (B) | med as % of full | full cheaper (cells) | `-base-bytecode` diff min / med / max (B) | med % of full |
|---|---:|---:|---:|---:|---:|---:|
| E1 numeric literal (n=3) | 41 | 84 / 84 / 181 | 0.6% | 0/3 | 84 / 84 / 181 | 0.6% |
| E2 string, same length, reworded (n=3) | 49 | 225 / 1040 / 1678 | 7.3% | 0/3 | 182 / 199 / 203 | 1.4% |
| E2t string, same length, 1-char tweak (n=3) | 40 | 84 / 84 / 91 | 0.6% | 0/3 | 182 / 190 / 203 | 1.3% |
| E3 string, longer, reworded (prefix) (n=3) | 44 | 204 / 281 / 631 | 2.0% | 0/3 | 192 / 197 / 218 | 1.4% |
| E3t string, longer, suffix appended (n=3) | 51 | 179 / 207 / 354 | 1.5% | 0/3 | 207 / 208 / 226 | 1.5% |
| E4 new string in existing fn (n=3) | 88 | 712 / 722 / 944 | 5.1% | 0/3 | 253 / 258 / 266 | 1.8% |
| E5 new fn, appended as new module at END (n=3) | 204 | 2513 / 2514 / 2626 | 17.5% | 0/3 | 443 / 443 / 447 | 3.1% |
| E5b new fn, end of a random module (n=3) | 198 | 3282 / 3367 / 3543 | 23.5% | 0/3 | 1063 / 1177 / 1219 | 8.2% |
| E6 new fn, start of a random module (n=3) | 198 | 2647 / 2741 / 3394 | 19.1% | 0/3 | 766 / 872 / 931 | 6.1% |
| E7 remove a string (n=3) | 42 | 195 / 624 / 1291 | 4.4% | 0/3 | 85 / 85 / 174 | 0.6% |
| E8 rename property (n=3) | 40 | 145 / 161 / 1050 | 1.1% | 0/3 | 211 / 239 / 247 | 1.7% |

#### ~300 KB unit: hbc 294892 B, JS 937459 B, `full` (zstd-19 of new hbc) ~102721 B

| edit | src diff (med) | hbc diff min / med / max (B) | med as % of full | full cheaper (cells) | `-base-bytecode` diff min / med / max (B) | med % of full |
|---|---:|---:|---:|---:|---:|---:|
| E1 numeric literal (n=3) | 40 | 84 / 85 / 400 | 0.1% | 0/3 | 84 / 85 / 400 | 0.1% |
| E2 string, same length, reworded (n=3) | 59 | 6007 / 9921 / 10538 | 9.7% | 0/3 | 475 / 555 / 556 | 0.5% |
| E2t string, same length, 1-char tweak (n=3) | 40 | 85 / 85 / 5062 | 0.1% | 0/3 | 475 / 548 / 548 | 0.5% |
| E3 string, longer, reworded (prefix) (n=3) | 43 | 3370 / 9767 / 11884 | 9.5% | 0/3 | 458 / 524 / 527 | 0.5% |
| E3t string, longer, suffix appended (n=3) | 52 | 545 / 1117 / 4378 | 1.1% | 0/3 | 552 / 627 / 628 | 0.6% |
| E4 new string in existing fn (n=3) | 85 | 4888 / 5035 / 5118 | 4.9% | 0/3 | 653 / 686 / 796 | 0.7% |
| E5 new fn, appended as new module at END (n=3) | 202 | 10600 / 10602 / 10624 | 10.3% | 0/3 | 914 / 916 / 916 | 0.9% |
| E5b new fn, end of a random module (n=3) | 204 | 11614 / 11681 / 11932 | 11.4% | 0/3 | 1773 / 2855 / 3003 | 2.8% |
| E6 new fn, start of a random module (n=3) | 202 | 10916 / 11361 / 11777 | 11.0% | 0/3 | 1348 / 2380 / 3129 | 2.3% |
| E7 remove a string (n=3) | 40 | 6537 / 8848 / 9676 | 8.6% | 0/3 | 85 / 86 / 86 | 0.1% |
| E8 rename property (n=3) | 41 | 873 / 6871 / 9808 | 6.7% | 0/3 | 461 / 462 / 488 | 0.4% |

#### RN host (examples/spike-app, android): hbc 860712 B, JS 2221897 B, `full` (zstd-19 of new hbc) ~348787 B

| edit | src diff (med) | hbc diff min / med / max (B) | med as % of full | full cheaper (cells) | `-base-bytecode` diff min / med / max (B) | med % of full |
|---|---:|---:|---:|---:|---:|---:|
| E1 numeric literal (n=3) | 44 | 85 / 85 / 86 | 0.0% | 0/3 | 85 / 85 / 86 | 0.0% |
| E2 string, same length, reworded (n=3) | 52 | 38368 / 40934 / 44994 | 11.7% | 0/3 | 795 / 796 / 905 | 0.2% |
| E2t string, same length, 1-char tweak (n=3) | 43 | 85 / 90 / 39703 | 0.0% | 0/3 | 665 / 923 / 1798 | 0.3% |
| E3 string, longer, reworded (prefix) (n=3) | 47 | 5925 / 41156 / 47775 | 11.8% | 0/3 | 909 / 958 / 958 | 0.3% |
| E3t string, longer, suffix appended (n=3) | 55 | 2152 / 38926 / 42932 | 11.2% | 0/3 | 929 / 1636 / 1739 | 0.5% |
| E4 new string in existing fn (n=3) | 97 | 41746 / 41901 / 42607 | 12.0% | 0/3 | 1637 / 1749 / 1835 | 0.5% |
| E5 new fn, appended as new module at END (n=3) | 211 | 46864 / 46865 / 46869 | 13.4% | 0/3 | 2134 / 2134 / 2134 | 0.6% |
| E5b new fn, end of a random module (n=3) | 199 | 48744 / 49122 / 49320 | 14.1% | 0/3 | 3845 / 4211 / 4739 | 1.2% |
| E6 new fn, start of a random module (n=3) | 208 | 47117 / 47236 / 47401 | 13.5% | 0/3 | 2439 / 3128 / 3303 | 0.9% |
| E7 remove a string (n=3) | 43 | 23715 / 48093 / 52445 | 13.8% | 0/3 | 86 / 86 / 87 | 0.0% |
| E8 rename property (n=3) | 44 | 160 / 160 / 28215 | 0.0% | 0/3 | 793 / 797 / 908 | 0.2% |
