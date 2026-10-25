
#### UI copy placement: 150 copy strings in a screen module inside a ~100 KB library unit; median of 3 copy positions

| form | hbc B | full zstd B | rewording (other text) plain | rewording (other text) delta | typo (1 char) plain | typo (1 char) delta | longer (+20 chars) plain | longer (+20 chars) delta | add a new copy string plain | add a new copy string delta | remove a copy string plain | remove a copy string delta |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| inline literals in code | 111816 | 42680 | 4992 | 351 | 85 | 317 | 1306 | 362 | 2133 | 1057 | 4470 | 279 |
| object-literal data module | 115168 | 44321 | 2981 | 343 | 85 | 314 | 310 | 355 | 3809 | 1726 | 4211 | 333 |
| JSON.parse(one string) | 115092 | 43684 | 261 | 483 | 85 | 457 | 970 | 440 | 2066 | 1181 | 1533 | 545 |
| array-literal data module | 112676 | 42845 | 4959 | 338 | 85 | 308 | 1300 | 351 | 2074 | 1000 | 4431 | 272 |

(add/remove also adds/removes the consuming call site and, for data modules, the key; keys are stable ids)
