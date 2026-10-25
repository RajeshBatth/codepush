# HBC diff size: what really drives it (string-table / function-ID study, RN 0.78.3 hermesc, HBC v96)

Host machine (macOS arm64), `hermesc` 0.78.3 (sha in `VERSIONS.md`, Hermes commit `a942ef37`), patch parameters of the real pipeline (`hdiffz_tool -c zstd -l 19 -m 4`, compile `-O -emit-binary -g0`, fixed relative name). Everything here is reproducible with `./st_run_all.sh` (section 7); raw outputs are in `st_results/`. No device was involved.

## 0. Answer in one screen

* **The suspicion was right, and the real mechanism is stronger than "renumbering on insert".** Hermes does not number strings in first-use order. At the end of compilation it re-sorts the whole string set (by identifier-reference frequency class, then kind, then alphabetically, then by the position an optimizing suffix-overlap packer gives each string in the string storage) and a string's final ID is its position in that order. Function IDs are positions in the IR function list (source order). Instruction operands, function-header name fields, identifier-hash array, string table, object/array buffers all carry or follow those IDs. One added, removed or reworded string therefore changes anywhere from 0.7% to 91% of all string IDs (typically 40 to 90%, depending on where the text lands in the order), and 27 to 76% of the function bodies change although their instruction text is identical. (Section 1, evidence in 1.4 and 1.5.)
* **What it costs (plain `hermesc`, today's recipe).** Numeric edit: 85 B at every size. One reworded/added/removed string (median over the string classes E2, E3, E4, E7): 30 KB unit 0.63 KB (4% of the zstd-compressed full unit; range 0.2 to 1.7 KB), 300 KB unit 6.5 KB (6%; range 3.4 to 11.9 KB), host (860 KB) 41.7 KB (12%; range 5.9 to 52 KB). A new function: 30 KB 2.5 to 3.5 KB, 300 KB about 11 KB, host about 47 to 49 KB. Source diffs for the same edits are 40 to 210 B. Unit-sized bytecode is **not** cheap in relative terms (a typical string/feature edit is 5 to 20% of the full unit) but in absolute terms it is a few KB for chat-sized units, versus tens of KB for the host. `full` is never cheaper than the patch for a single edit, at any size down to a 3 KB unit.
* **A build-time-only fix removes 65 to 98% of that cost (and 80 to 98% of the string-edit cost at 300 KB and host): `hermesc -base-bytecode=<base.hbc>`** (Hermes "delta optimizing mode", present in the pinned hermesc's `-help`). The new build starts from the base build's string table, so every existing string keeps its ID and new strings are appended. Output is ordinary HBC (device code unchanged). Measured: string edits (reword/add/remove, medians) 30 KB 0.2 KB, 300 KB 0.5 KB, host 0.9 KB (was 0.63 / 6.5 / 41.7 KB); new string in a function 0.25 / 0.7 / 1.7 KB; new function appended at the end of the unit 0.45 / 0.9 / 2.1 KB. It reproduces the owner's original numbers exactly (`'embedded'`->`'patched'` in host app code: 32,646 B plain, **794 B** with the flag). Semantic equivalence was checked on all 33 matrix variants (function-by-function dump comparison); **not yet run on a device**.
* **A bytecode-aware diff (ID remapping, on-device inverse transform) is not worth building**: after `-base-bytecode` the remaining cost is 0.4 to 1.5 KB above an ID-free semantic floor for string edits, and the one place a remap helps (functions inserted mid-unit shift function IDs) saves 0.7 to 1.6 KB per patch and can be mostly avoided by appending new modules at the end of the unit. (Section 3.6.)

## 1. Mechanism

### 1.1 From the Hermes source at the pinned commit (`st_fetch_hermes_src.sh` downloads exactly these files)

| Step | Where | What it does |
|---|---|---|
| collect strings | `TraverseLiteralStrings.cpp::traverseLiteralStrings` | Walks declared global property names, then **every instruction operand that is a string literal, function by function in IR order**. `isIdOperand` marks property-name operands (`LoadProperty`, `StoreProperty`, `StoreNewOwnProperty`, `TryLoad/StoreGlobalProperty`, `DeleteProperty`, object-literal keys of `AllocObjectFromBuffer`) as **identifiers**; others are plain strings. Then `traverseFunctions` adds every function name (unless `-fstrip-function-names`), function-source strings, and CJS module names. |
| dedupe + provisional index | `UniquingStringLiteralAccumulator::addString` | First-use insertion order gives a provisional index and counts, per new string, how many times it was used as an identifier (`numIdentifierRefs_`). **This order is not the final ID.** |
| final order | `UniquingStringLiteralTable.cpp::toTable` | (1) `stable_sort` the new strings by `numIdentifierRefs` descending. (2) Three `std::sort`s by `(kind, string)` inside the rank windows `[0,255)`, `[255,65535)`, `[65535,...)`. The windows presumably exist so the ~255 hottest identifiers get 8-bit IDs (my inference from the `...Short` opcodes; the code has no comment saying so). (3) Pack characters into the string storage; with `-O` (`optimize == optimizationEnabled`) this is `optimizingPackStrings`: a suffix array over **all** strings, substring reuse and prefix/suffix overlaps, `planLayout` over the whole set (`ConsecutiveStringStorage.cpp`). (4) Re-sort the table entries inside each window by `(kind, offset in storage, length)`. **A string's ID is its position after step 4.** |
| delta mode | `HBC.cpp::stringAccumulatorFromBCProvider`, `toTable` (`existingStrings`) | With a base bytecode the accumulator is **seeded with the base string storage**; `toTable` only sorts/packs the *new* strings (`existingStrings` are skipped) and appends them. Existing IDs cannot move. |
| function IDs | `HBC.cpp` (`BMGen.addFunction(&F)` loop over `*M`), `BytecodeGenerator.cpp::addFunction` | `functionIDMap_.allocate(F)` in IR module order = source order of function creation. Nothing sorts them. A function inserted early shifts the index of every later function. |
| operand widths | `BytecodeList.def` | String-ID operands: `GetByIdShort` (u8), `GetById`/`TryGetById`/`PutById`/`PutNewOwnById`/`LoadConstString` (u16), `...Long`/`LoadConstStringLongIndex` (u32). Function-ID operands: `CreateClosure`/`CallDirect` (u16), `...LongIndex` (u32). ISel picks the width from the ID value, so an ID that crosses 255 or 65535 changes the instruction **size**. |
| file layout | `BytecodeFileFormat.h`, `BytecodeStream.cpp` | 128 B header (carries a 20 B source hash and `fileLength`), function headers (16 B each; hold the body offset and the function-name string ID), string kinds (RLE), identifier hashes (one u32 per identifier, in ID order), small string table (u32 per string: utf16 flag, 23-bit offset, 8-bit length), overflow table, string storage, array buffer, object key buffer (string IDs), object value buffer, bigint/regexp/cjs tables, then **function bodies** (identical bodies are deduplicated under `-O`), per-function info, debug info (empty with `-g0`), footer **SHA-1 (20 B)** of the file. |

Consequences that follow from the source (and are checked below):
1. A string's ID depends on global state (frequency windows, alphabetical neighbours, a global packing layout), not on where it is used. Adding, removing or changing **one** string can shift every ID after it in the window and can re-lay-out the storage.
2. Every instruction that names a string or function carries the ID; so do function headers, the identifier-hash array, object/array buffers (`NewObjectWithBuffer` operands are buffer offsets that move too).
3. If any table before the function bodies changes size, every function-header offset changes.
4. The header source hash, `fileLength` and the footer SHA-1 are ~45 B that always change: the floor of a patch is 84 to 86 B (this is the "85 B numeric edit").

### 1.2 What the final ID order looks like (`st_idorder.mjs`)

```
strings 2704; kind runs (from the "String Kind Entry" table): identifier x255 from id 0, string x1534 from id 256, identifier x915 from id 1790
first 12 identifier ids: 0:ArgumentOutOfRangeError  1:RangeError  2:Error  3:__spreadArray  4:Array  5:AsyncSubject  6:Subject  7:COMPLETE_NOTIFICATION  8:ColdObservable  9:Observable  10:ConnectableObservable  11:_originalDate
first 8 plain-string ids: 256:"../util/ArgumentOu"  257:"util"  258:"A"  259:"ArgumentOutOfRange"  260:"o"  261:"r"  262:"__lodash_hash_unde"  263:"lodash"
adjacent pairs in ascending alphabetical order: plain strings 75.0%, identifiers (ids >= 256) 77.9%  (50% = random, 100% = sorted)
adjacent ids with increasing storage offset: 99.9% (the final id order follows packed-storage order, not first use)
```
Host:
```
strings 5763; kind runs (from the "String Kind Entry" table): identifier x255 from id 0, string x2548 from id 255, identifier x2960 from id 2804
first 12 identifier ids: 0:$$typeof  1:type  2:API  3:isArray  4:Array  5:a  6:y  7:Boolean  8:Commands  9:Date  10:ERROR  11:elementType
first 8 plain-string ids: 255:"^ {4}... skipping "  256:"$"  257:"t"  258:"offsetLeft"  259:"f"  260:"Deprecated API for"  261:"isArrayLike"  262:"keyboardDidShow"
adjacent pairs in ascending alphabetical order: plain strings 62.1%, identifiers (ids >= 256) 65.0%  (50% = random, 100% = sorted)
adjacent ids with increasing storage offset: 100.0% (the final id order follows packed-storage order, not first use)
```
IDs follow packed-storage order (99.9 to 100%), which is only partly alphabetical (62 to 78% of adjacent pairs ascending): the packer's overlap planning perturbs the sort. Practical consequence: **the cost of a new string is not a function of its alphabetical rank**. Inserting the same literal as `!first`, `aaaa`, `mmmm`, `zzzz`, `~last` costs 3.5 to 13.7 KB on the 300 KB unit and 36 to 44 KB on the host (`st_rank.mjs`):


#### rank of a new string, unit 300000: same code, only the new literal's text differs

| new literal | plain diff | delta diff |
|---|---:|---:|
| `!first` | 10449 | 593 |
| `AAAA new string` | 4409 | 654 |
| `aaaa new string` | 6083 | 654 |
| `mmmm new string` | 5958 | 654 |
| `tttt new string` | 9632 | 654 |
| `zzzz new string` | 3559 | 654 |
| `~last` | 13706 | 592 |

#### rank of a new string, unit host: same code, only the new literal's text differs

| new literal | plain diff | delta diff |
|---|---:|---:|
| `!first` | 42568 | 1333 |
| `AAAA new string` | 36747 | 1639 |
| `aaaa new string` | 39089 | 1638 |
| `mmmm new string` | 36140 | 1638 |
| `tttt new string` | 41998 | 1637 |
| `zzzz new string` | 36849 | 1638 |
| `~last` | 44020 | 1334 |

(Delta mode: flat 0.6 KB / 1.3 to 1.6 KB regardless of text.) So there is no "name your new strings to sort last" trick.

### 1.3 Does an ID change alter instruction size?

Possible by construction (`GetByIdShort` u8 vs `GetById` u16). Observed:
* **Plain mode**: opcode histograms of old and new (host and 300 KB, E2/E4/E5b/E7/E8, 3 positions each, 30 cells) differ only by the opcodes of the edit itself. No width flips: the 255-window membership is decided by identifier reference counts, which one edit rarely changes. It is possible at the 255 / 65535 boundaries (one or two strings per edit) but I did not hit it.
* **Delta mode**: new identifiers are appended past the 255 window, so their references use the wide form: e.g. `GetByIdShort ... "schedule"` becomes `GetById ... "scheduleQ"` (+1 byte per reference, local to that function). This is the only size effect seen and it is harmless.
* What does change in instruction text in plain mode with no semantic change: `NewObjectWithBuffer`/`NewArrayWithBuffer` buffer-offset operands (253 instructions on the host for one string reword).

### 1.4 Measured: what changes in the file (`st_mech.mjs`, seed 1)

Column key: "strings w/ new ID" = strings present in old and new whose ID differs; "fns text-identical but body bytes differ" = functions whose disassembly (strings by content, callees by name) is identical in old and new yet whose binary body differs = pure renumbering; "fns w/ new index" = function-table index shifted; the right-hand columns are the **standalone HDiffPatch zstd-19 size of each region** old vs new (each non-zero cell carries ~30 to 60 B of container overhead, so they over-add against the whole-file figure).

300 KB unit (2704 strings, 2039 functions):

unit 300000: 2704 strings (1170 identifiers), 2039 functions, hbc 294892 B

| edit | variant | strings w/ new ID | fns text-identical but body bytes differ | fns w/ new index | fns whose text changed (unmatched) | body size changed | whole diff B | headers | str tables | storage | buffers | bodies | hdr+ftr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | plain | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 400 | 275 | 0 | 0 | 0 | 119 | 79 |
| E1 | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 400 | 275 | 0 | 0 | 0 | 119 | 79 |
| E2 | plain | 2019/2703 (74.7%) | 1062/2038 (52.1%) | 0 | 1 | 0 | 10538 | 744 | 5021 | 246 | 221 | 4390 | 75 |
| E2 | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 555 | 446 | 45 | 56 | 0 | 41 | 89 |
| E2t | plain | 0/2703 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 85 | 0 | 0 | 39 | 0 | 0 | 75 |
| E2t | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 548 | 446 | 45 | 43 | 0 | 41 | 89 |
| E3 | plain | 0/2703 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 3370 | 157 | 3203 | 41 | 0 | 0 | 82 |
| E3 | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 527 | 430 | 45 | 44 | 0 | 41 | 89 |
| E3t | plain | 0/2703 (0.0%) | 0/2039 (0.0%) | 0 | 0 | 0 | 1117 | 335 | 774 | 51 | 0 | 0 | 82 |
| E3t | delta | 0/2704 (0.0%) | 1/2039 (0.0%) | 0 | 0 | 0 | 628 | 521 | 45 | 55 | 0 | 41 | 89 |
| E4 | plain | 1507/2704 (55.7%) | 969/2038 (47.5%) | 0 | 1 | 0 | 4888 | 894 | 460 | 52 | 356 | 3255 | 86 |
| E4 | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 653 | 530 | 45 | 54 | 0 | 63 | 89 |
| E5 | plain | 2050/2704 (75.8%) | 1094/2038 (53.7%) | 0 | 3 | 0 | 10624 | 1588 | 4043 | 109 | 438 | 4327 | 93 |
| E5 | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 3 | 0 | 916 | 648 | 63 | 66 | 0 | 164 | 96 |
| E5b | plain | 2050/2704 (75.8%) | 1179/2038 (57.9%) | 620 | 2 | 0 | 11681 | 2169 | 4043 | 109 | 438 | 4774 | 93 |
| E5b | delta | 0/2704 (0.0%) | 263/2038 (12.9%) | 620 | 2 | 0 | 1773 | 787 | 63 | 66 | 0 | 847 | 96 |
| E6 | plain | 2050/2704 (75.8%) | 1327/2038 (65.1%) | 1892 | 2 | 0 | 11777 | 1507 | 4043 | 109 | 438 | 5475 | 93 |
| E6 | delta | 0/2704 (0.0%) | 738/2038 (36.2%) | 1892 | 2 | 0 | 3129 | 875 | 63 | 66 | 0 | 2062 | 96 |
| E7 | plain | 1307/2703 (48.4%) | 886/2038 (43.5%) | 0 | 1 | 0 | 6537 | 673 | 2204 | 63 | 398 | 3242 | 85 |
| E7 | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 85 | 0 | 0 | 0 | 0 | 40 | 75 |
| E8 | plain | 1947/2703 (72.0%) | 1087/2038 (53.3%) | 0 | 1 | 0 | 9808 | 1025 | 4268 | 143 | 187 | 4052 | 81 |
| E8 | delta | 0/2704 (0.0%) | 0/2038 (0.0%) | 0 | 1 | 0 | 461 | 364 | 49 | 48 | 0 | 41 | 88 |

(region columns = standalone HDiffPatch zstd-19 size of that region group, old vs new; identical group = 0; each non-zero cell includes ~30-60 B of container overhead, so they over-add vs the whole-file diff)

RN host (5763 strings, 4805 functions):

unit host: 5763 strings (3215 identifiers), 4805 functions, hbc 860712 B

| edit | variant | strings w/ new ID | fns text-identical but body bytes differ | fns w/ new index | fns whose text changed (unmatched) | body size changed | whole diff B | headers | str tables | storage | buffers | bodies | hdr+ftr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | plain | 0/5763 (0.0%) | 1/4804 (0.0%) | 0 | 1 | 0 | 86 | 0 | 0 | 0 | 0 | 40 | 76 |
| E1 | delta | 0/5763 (0.0%) | 1/4804 (0.0%) | 0 | 1 | 0 | 86 | 0 | 0 | 0 | 0 | 40 | 76 |
| E2 | plain | 3594/5762 (62.4%) | 3529/4665 (75.6%) | 0 | 140 | 0 | 44994 | 3530 | 12636 | 937 | 1413 | 26466 | 85 |
| E2 | delta | 0/5763 (0.0%) | 1/4804 (0.0%) | 0 | 1 | 0 | 905 | 793 | 49 | 49 | 0 | 56 | 88 |
| E2t | plain | 0/5762 (0.0%) | 0/4805 (0.0%) | 0 | 0 | 0 | 90 | 0 | 39 | 40 | 0 | 0 | 75 |
| E2t | delta | 0/5763 (0.0%) | 1/4805 (0.0%) | 0 | 0 | 0 | 1798 | 1682 | 49 | 43 | 0 | 58 | 89 |
| E3 | plain | 598/5762 (10.4%) | 715/4755 (15.0%) | 0 | 50 | 0 | 5925 | 1022 | 2433 | 51 | 154 | 2245 | 86 |
| E3 | delta | 0/5763 (0.0%) | 1/4804 (0.0%) | 0 | 1 | 0 | 909 | 793 | 49 | 50 | 0 | 56 | 89 |
| E3t | plain | 0/5762 (0.0%) | 0/4805 (0.0%) | 0 | 0 | 0 | 2152 | 559 | 1496 | 52 | 0 | 50 | 83 |
| E3t | delta | 0/5763 (0.0%) | 1/4805 (0.0%) | 0 | 0 | 0 | 1636 | 1493 | 49 | 55 | 0 | 58 | 89 |
| E4 | plain | 5281/5763 (91.6%) | 2800/4697 (59.6%) | 0 | 108 | 1 | 41901 | 5019 | 13434 | 1112 | 1378 | 20456 | 92 |
| E4 | delta | 0/5763 (0.0%) | 1/4804 (0.0%) | 0 | 1 | 1 | 1637 | 1464 | 49 | 54 | 0 | 103 | 89 |
| E5 | plain | 5088/5763 (88.3%) | 2820/4690 (60.1%) | 1 | 117 | 1 | 46865 | 5552 | 16868 | 1211 | 1545 | 22267 | 95 |
| E5 | delta | 0/5763 (0.0%) | 0/4804 (0.0%) | 0 | 3 | 0 | 2134 | 1425 | 64 | 66 | 0 | 624 | 96 |
| E5b | plain | 5088/5763 (88.3%) | 2980/4689 (63.6%) | 2040 | 117 | 7 | 49320 | 7258 | 16868 | 1211 | 1545 | 23418 | 95 |
| E5b | delta | 0/5763 (0.0%) | 473/4804 (9.8%) | 2082 | 2 | 6 | 3845 | 1737 | 64 | 66 | 0 | 1885 | 95 |
| E6 | plain | 5088/5763 (88.3%) | 2888/4689 (61.6%) | 756 | 117 | 9 | 47236 | 5862 | 16868 | 1211 | 1545 | 22676 | 95 |
| E6 | delta | 0/5763 (0.0%) | 212/4804 (4.4%) | 772 | 2 | 9 | 3128 | 2045 | 64 | 66 | 0 | 948 | 95 |
| E7 | plain | 5203/5762 (90.3%) | 3511/4665 (75.3%) | 0 | 140 | 0 | 48093 | 4175 | 14703 | 1043 | 1973 | 25776 | 91 |
| E7 | delta | 0/5763 (0.0%) | 1/4804 (0.0%) | 0 | 1 | 0 | 86 | 0 | 0 | 0 | 0 | 41 | 75 |
| E8 | plain | 4256/5762 (73.9%) | 2658/4674 (56.9%) | 0 | 131 | 0 | 28215 | 2490 | 8415 | 73 | 1020 | 15793 | 85 |
| E8 | delta | 0/5763 (0.0%) | 1/4804 (0.0%) | 0 | 1 | 0 | 908 | 793 | 53 | 44 | 0 | 56 | 89 |

(region columns = standalone HDiffPatch zstd-19 size of that region group, old vs new; identical group = 0; each non-zero cell includes ~30-60 B of container overhead, so they over-add vs the whole-file diff)

(30 KB unit: `st_results/mech_30000.txt`.)

Reading the 300 KB, plain E2 row (one same-length reword, 10.5 KB): 75% of string IDs change; 52% of the functions whose code did not change at all still have different bytes (only 1.6% of their bytes, but spread over 1000 functions, which is what defeats the matcher); the diff splits roughly 5.0 KB string tables (the small string table alone 2.7 KB: offsets/lengths reordered), 4.4 KB function bodies, 0.7 KB function headers (name-ID fields), 0.2 KB buffers, 0.25 KB storage. The same on the host: 62% of IDs, 76% of untouched bodies, 26 KB bodies + 13 KB string tables + 3.5 KB headers.

Other readings:
* **The same-length vs different-length distinction does not matter; the rank does** (E2t typo fix: if the edited string keeps its neighbours and the packer layout, 0% of IDs move and the diff is 85 B; in 1 of 3 random positions it does not, and costs 5 KB (300 KB) or 40 KB (host)).
* **E7 (remove a string) is as expensive as adding one**: the ID tail shifts down.
* **E8 (rename a property)** is cheap when the old/new names stay in the same frequency window and neighbourhood (0.2 to 0.9 KB), expensive otherwise (6.9 to 28 KB).
* **Function-ID shift**: E5 (new module at the end) shifts 0 function indexes; E5b (end of a random module) 620 (300 KB) / 2040 (host); E6 (start of a random module) 1892 / 756. In delta mode (strings pinned) this alone adds 36% of function bodies as changed (300 KB, E6) and raises the patch from 0.9 KB to 2.4 to 3.1 KB.
* **Delta mode's own floor** ("headers" column: 364 to 530 B at 2000 functions, 0.8 to 1.7 KB at 4800): any table growth moves the start of the function bodies, so every function-header offset changes by the same amount. Compressible, not free.

### 1.5 Whole-file, no regions: `-base-bytecode` closes it

Same edits, delta column: 0 string IDs change (0/2704), 0 function bodies change for string edits, region diffs collapse to the new strings, the offset shift in the function headers, and the 85 B hash floor.

## 2. Measurement matrix

Method (`st_matrix.mjs`, `st_lib.mjs`): units are Metro-style `__d(...)` bundles. 30 KB and 300 KB units are modules of the same corpora as `native/tools/make_hbc_corpus.mjs` (lodash 4.17.21, rxjs 7.8.1 cjs, date-fns 2.30.0, moment 2.30.1; CJS files, capped at 40 KB each, shuffled with a fixed seed, as many modules as reach the target **hbc** size). The host is the real bundle of `examples/spike-app` (android, 486 `__d` modules, 860,712 B hbc, byte-identical to `.spike-assets/android/embedded/host.hbc`; the app was not modified). Edits are applied to a copy at **3 different pseudo-random positions** (modules), always a real change that compiles. Numbers are bytes of the HDiffPatch single compressed diff (`-c zstd -l 19 -m 4`); "full" is the same tool against an empty file (what `patch.ts` emits for `full`), "% of full" uses the median. "src diff" is the same tool on the JS text. "plain" = today's recipe; "`-base-bytecode`" = the same compile plus `-base-bytecode=<old build's .hbc>`.

Edit classes: E1 numeric literal (+7); E2 existing string reworded, same length (reversed text: rank changes); E2t same length, one char flipped in the middle (typo fix); E3 string reworded and longer (`New ` + text); E3t string with a suffix appended; E4 new string literal in an existing function (`if (this === 4242) return 'new-string-n';`); E5 new function (one new string, one new identifier, an array/join body) as a **new `__d` module appended at the end of the unit**; E5b the same function at the end of a random existing module; E6 at the start of a random module; E7 a string literal replaced by `''` (the string existed once in the whole unit); E8 a property name used once in the whole unit renamed (`name` -> `nameQ`). E5 differs between positions only in the tag text.


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

Notes on the matrix:
* "full cheaper" never happens in the 99 cells. The worst plain cell is 24.7% of full (30 KB unit, E5b), the worst `-base-bytecode` cell 8.5%.
* Source diffs are 39 to 211 B in every cell, i.e. bytecode diffs are 2x (E1) to 1200x (host string edits) larger than source diffs in plain mode, and 2x to 42x with `-base-bytecode`.
* **Hybrid**: plain beats `-base-bytecode` in 14 of 99 cells (typically E2t/E3t/E8, plus ties for E1/E7) by up to 1.7 KB (host E2t: plain 90 B vs delta 665 to 1798 B) because delta always appends a (dead) copy of the old string and shifts the function-header offsets, while a lucky plain edit leaves everything in place. Building both and shipping the smaller is possible (both are valid HBC with the same semantics; the manifest hash is of whichever is shipped) but the gain is below 2 KB per patch and doubles the diff work; I would not bother unless measurements in production show many typo-sized releases.
* Real app code, the owner's original data point (`st_spike_real.mjs`, spike-app `src/host/marker.js` string):

| edit (real app code) | plain diff | delta diff | full |
|---|---:|---:|---:|
| 'embedded' -> 'patched' (shorter) | 32646 | 794 | 348831 |
| 'embedded' -> 'embedXXX' (same length) | 22477 | 794 | 348767 |
| 'embedded' -> 'embedded-v2' (longer) | 21173 | 909 | 348780 |

  These are 32,646 / 22,475 B in `DESIGN.md` 5.9 and they are reproduced here; the flag takes them to ~0.8 to 0.9 KB.
* Many edits at once (`st_mitig.mjs churn`; mixed E4, E1, E2, E5b, E8, E3 at random positions):


#### many edits at once (mixed classes E4,E1,E2,E5b,E8,E3 round-robin at random positions): patch size vs number of edits

| unit | edits | src diff | plain diff | plain % of full | delta diff | delta % of full | hybrid min(plain, delta) |
|---|---|---|---|---|---|---|---|
| ~30 KB | 1 | 87 | 708 | 5.0% | 260 | 1.8% | 260 |
| ~30 KB | 3 | 106 | 1721 | 12.1% | 283 | 2.0% | 283 |
| ~30 KB | 10 | 369 | 4210 | 29.6% | 1092 | 7.7% | 1092 |
| ~30 KB | 30 | 548 | 5135 | 36.1% | 1940 | 13.7% | 1940 |
| ~30 KB | 100 | 1165 | 7807 | 54.9% | 4618 | 32.5% | 4618 |
| ~300 KB | 1 | 91 | 5965 | 5.8% | 614 | 0.6% | 614 |
| ~300 KB | 3 | 120 | 11274 | 11.0% | 750 | 0.7% | 750 |
| ~300 KB | 10 | 401 | 16649 | 16.2% | 3837 | 3.7% | 3837 |
| ~300 KB | 30 | 589 | 26960 | 26.3% | 7731 | 7.5% | 7731 |
| ~300 KB | 100 | 1192 | 28947 | 28.2% | 8917 | 8.7% | 8917 |
| RN host | 1 | 100 | 43474 | 12.5% | 1278 | 0.4% | 1278 |
| RN host | 3 | 110 | 49204 | 14.1% | 1343 | 0.4% | 1343 |
| RN host | 10 | 359 | 70796 | 20.3% | 10832 | 3.1% | 10832 |
| RN host | 30 | 571 | 89843 | 25.8% | 24635 | 7.1% | 24635 |
| RN host | 100 | 1204 | 106938 | 30.7% | 25750 | 7.4% | 25750 |

## 3. Mitigations

### 3.1 `-base-bytecode` (delta optimizing mode): the one that works

Results are the "`-base-bytecode`" columns above and in every table below. Properties, all measured:
* Output is ordinary HBC v96. `hermesc -b -dump-bytecode` parses it; for 11 edit classes x 3 sizes (`st_mitig.mjs validate`, `st_results/validate.md`), the multiset of function disassemblies equals the plain build's (instruction width variants `Short`/`Long` and buffer offsets folded), the plain string set is a subset of the delta string set, and the only extras are 0 or 1 dead strings kept from the base.
* Deterministic: the same inputs give the same bytes when the base file is read from another path/cwd (checked in `validate`); output size grows by 0 to 80 B (kept dead strings + wide IDs).
* Fails closed: a base of the wrong bytecode version (98), a truncated file or a JS text file gives `Error deserializing base bytecode: ...`, exit 5, no output.
* Costs nothing on the device, the manifest, the format or the apply code. Costs in the build: ota-build must keep the **base build's** `.hbc` per unit/host (it is the artifact patches are already computed against), pass it for the *patch* build (never for the base build itself), include its sha256 in the reproducibility inputs (`verify-repro`), and treat "base missing / wrong version" as a build error.
* Chains: always compile against the **embedded** base (the same file the device patches), so there is no accumulation across releases; dead strings are bounded by what the base had.
* **Not done**: running a delta-built unit/host on a device. Hermes' loader sees a normal file, and I checked that kind-run tables with more than three runs parse, but the spike's S3/S8 should be re-run once with a delta-built `cabs` before relying on it. Treat as "very likely fine, unproven".

### 3.2 Other hermesc flags (`st_mitig.mjs flags`)

Median over 3 positions, bytes. 300 KB unit:


#### flags, unit 300000: median diff (B) over 3 positions; `plain` = recipe flags, `delta` = same + -base-bytecode=<old.hbc>

| flags | base hbc B | full zstd B | E1 plain | E2 plain | E4 plain | E5 plain | E6 plain | E8 plain | E1 delta | E2 delta | E4 delta | E5 delta | E6 delta | E8 delta |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| -O -g0 (shipping recipe) | 294892 | 102694 | 85 | 9921 | 5035 | 10602 | 11361 | 6871 | 85 | 555 | 686 | 916 | 2380 | 462 |
| -O0 -g0 | 512024 | 126243 | 85 | 1964 | 4932 | 5790 | 7259 | 157 | 85 | 513 | 690 | 1064 | 2196 | 447 |
| -Og -g0 | 511120 | 125867 | 85 | 1957 | 5297 | 5957 | 7046 | 133 | 85 | 491 | 655 | 996 | 2143 | 411 |
| -O (default -g1: file name + line tables) | 488878 | 148823 | 85 | 10006 | 6061 | 10953 | 13843 | 6875 | 85 | 639 | 1700 | 1445 | 5146 | 571 |
| -O -g0 -finline | 294892 | 102694 | 85 | 9921 | 5035 | 10602 | 11361 | 6871 | 85 | 555 | 686 | 916 | 2380 | 462 |
| -O -g0 -fno-inline | 294992 | 102715 | 85 | 9979 | 4963 | 10462 | 11333 | 6874 | 85 | 510 | 677 | 1025 | 2404 | 459 |
| -O -g0 -fstrip-function-names | 291992 | 99441 | 85 | 7014 | 4983 | 11213 | 11761 | 5557 | 85 | 481 | 751 | 1066 | 2320 | 473 |
| -O -g0 -reuse-prop-cache | 294892 | 102694 | 85 | 9921 | 5035 | 10602 | 11361 | 6871 | 85 | 555 | 686 | 916 | 2380 | 462 |
| -O -g0 -fno-static-builtins | 294892 | 102694 | 85 | 9921 | 5035 | 10602 | 11361 | 6871 | 85 | 555 | 686 | 916 | 2380 | 462 |
| -O -g0 -eager | 294892 | 102694 | 85 | 9921 | 5035 | 10602 | 11361 | 6871 | 85 | 555 | 686 | 916 | 2380 | 462 |

Host:


#### flags, unit host: median diff (B) over 3 positions; `plain` = recipe flags, `delta` = same + -base-bytecode=<old.hbc>

| flags | base hbc B | full zstd B | E1 plain | E2 plain | E4 plain | E5 plain | E6 plain | E8 plain | E1 delta | E2 delta | E4 delta | E5 delta | E6 delta | E8 delta |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| -O -g0 (shipping recipe) | 860712 | 348825 | 85 | 40934 | 41901 | 46865 | 47236 | 160 | 85 | 796 | 1749 | 2134 | 3128 | 797 |
| -O0 -g0 | 1447204 | 402092 | 85 | 5391 | 22703 | 26241 | 26900 | 170 | 85 | 839 | 1242 | 1931 | 2827 | 843 |
| -Og -g0 | 1446572 | 401823 | 85 | 5393 | 23202 | 27051 | 26886 | 170 | 85 | 914 | 1317 | 1993 | 2465 | 918 |
| -O (default -g1: file name + line tables) | 1430503 | 491728 | 85 | 40835 | 46047 | 47950 | 49457 | 168 | 85 | 937 | 5209 | 3454 | 4514 | 951 |
| -O -g0 -finline | 860712 | 348825 | 85 | 40934 | 41901 | 46865 | 47236 | 160 | 85 | 796 | 1749 | 2134 | 3128 | 797 |
| -O -g0 -fno-inline | 823580 | 344947 | 85 | 47327 | 42515 | 46679 | 46087 | 134 | 85 | 888 | 1545 | 2216 | 2629 | 896 |
| -O -g0 -fstrip-function-names | 843456 | 334773 | 85 | 32610 | 35885 | 37841 | 39118 | 156 | 85 | 842 | 1613 | 2269 | 3387 | 845 |
| -O -g0 -reuse-prop-cache | 860712 | 348825 | 85 | 40934 | 41901 | 46865 | 47236 | 160 | 85 | 796 | 1749 | 2134 | 3128 | 797 |
| -O -g0 -fno-static-builtins | 860712 | 348825 | 85 | 40934 | 41901 | 46865 | 47236 | 160 | 85 | 796 | 1749 | 2134 | 3128 | 797 |
| -O -g0 -eager | 860712 | 348825 | 85 | 40934 | 41901 | 46865 | 47236 | 160 | 85 | 796 | 1749 | 2134 | 3128 | 797 |

* `-O` vs `-O0`/`-Og`: without `-O` the string packer is `fastPackStrings` (no suffix-array overlap), the table order stays simpler and the string-reword cost drops (host E2 41 KB -> 5.4 KB, E4 42 KB -> 23 KB), but the base is 68% larger (1.45 MB vs 0.86 MB), the compressed full is 15% larger and the code is unoptimized. Not a trade worth making; it just confirms that the optimizing packer is part of the problem (the sort is the rest: E4 stays at 23 KB).
* `-g1` default debug info: bigger everywhere (host: base +66%, full +41%), diffs a little worse. Keep `-g0` as in the recipe.
* `-fstrip-function-names`: 1 to 2% smaller, reword cost 41 KB -> 33 KB on host, still renumbers; it also removes `Function.name` (affects error text and `displayName` use). Not recommended.
* `-finline`, `-reuse-prop-cache`, `-fno-static-builtins`, `-eager`: byte-identical output on this input (defaults or no-ops). `-fno-inline`: no benefit. Nothing in `hermesc -help` / `-help-hidden` orders or numbers strings except `-base-bytecode`.

### 3.3 (a) Append-only editing discipline

Function-ID stability is the part source discipline can influence: **new functions in a new module appended at the end of the unit (E5) shift 0 function indexes**; the same function inserted into the middle shifts hundreds to thousands.

| unit | mode | E5 append new module | E5b end of random module | E6 start of random module |
|---|---|---:|---:|---:|
| 30 KB | plain | 2514 | 3367 | 2741 |
| 30 KB | `-base-bytecode` | 443 | 1177 | 872 |
| 300 KB | plain | 10602 | 11681 | 11361 |
| 300 KB | `-base-bytecode` | 916 | 2855 | 2380 |
| host | plain | 46865 | 49122 | 47236 |
| host | `-base-bytecode` | 2134 | 4211 | 3128 |

(medians of 3). In plain mode discipline is worth 5 to 25% because the string renumbering dominates; in delta mode appending is **2 to 3x cheaper** than inserting. A new *string* cannot be appended in plain mode (rank test in 1.2); in delta mode it is appended by construction. Actionable form for the splitter/ota-build: emit a unit's modules in the base build's order and put modules new in this release at the end.

### 3.4 (c) Where UI copy lives (`st_mitig.mjs copy`)

150 copy strings (2 to 6 words) in a screen module inside a ~100 KB library unit; four ways to hold them (consumer code identical except how it names the text); median of 3 copy positions.


#### UI copy placement: 150 copy strings in a screen module inside a ~100 KB library unit; median of 3 copy positions

| form | hbc B | full zstd B | rewording (other text) plain | rewording (other text) delta | typo (1 char) plain | typo (1 char) delta | longer (+20 chars) plain | longer (+20 chars) delta | add a new copy string plain | add a new copy string delta | remove a copy string plain | remove a copy string delta |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| inline literals in code | 111816 | 42680 | 4992 | 351 | 85 | 317 | 1306 | 362 | 2133 | 1057 | 4470 | 279 |
| object-literal data module | 115168 | 44321 | 2981 | 343 | 85 | 314 | 310 | 355 | 3809 | 1726 | 4211 | 333 |
| JSON.parse(one string) | 115092 | 43684 | 261 | 483 | 85 | 457 | 970 | 440 | 2066 | 1181 | 1533 | 545 |
| array-literal data module | 112676 | 42845 | 4959 | 338 | 85 | 308 | 1300 | 351 | 2074 | 1000 | 4431 | 272 |

(add/remove also adds/removes the consuming call site and, for data modules, the key; keys are stable ids)

* **Plain mode**: a data module with one big `JSON.parse('{...}')` string is the best place: rewording one copy string costs 261 B vs 4,992 B inline, 2,981 B object literal, 4,959 B array. Typo fix 85 B everywhere (rank unchanged). Adding or removing a copy string is 1.5 to 4.5 KB in every form (the table still re-sorts; JSON blob is the best, 1.5 to 2.1 KB).
* **With `-base-bytecode`** the placement barely matters (rewording 0.34 to 0.48 KB in every form; inline is slightly better than the JSON blob because the blob is a larger changed string). So if delta mode is adopted, do not restructure code for patch size.
* **Server-driven copy** (fetch copy at runtime / remote config) costs zero patch bytes and zero release; it is the right answer for text that changes weekly, by definition of the numeric-edit row (85 B floor when nothing in the bundle changes).

### 3.5 (d) Finer units (`st_mitig.mjs scale`)

Same edit class, units of increasing size (median of 3; library units, host = real host):


#### diff size vs unit size (median of 3 positions; library units are shuffled corpus modules, host = RN 0.78.3 host bundle)

| unit | hbc B | functions | full zstd B | E2 plain | E4 plain | E5 plain | E6 plain | E2 delta | E4 delta | E5 delta | E6 delta | E2 plain % of full | E2 delta % of full |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ~3 KB | 2976 | 19 | 2023 | 350 | 344 | 624 | 772 | 166 | 208 | 374 | 541 | 17.3% | 8.2% |
| ~10 KB | 15224 | 104 | 7581 | 571 | 1232 | 1599 | 2127 | 179 | 231 | 421 | 764 | 7.5% | 2.4% |
| ~30 KB | 30628 | 202 | 14210 | 1040 | 722 | 2514 | 2741 | 199 | 258 | 443 | 872 | 7.3% | 1.4% |
| ~100 KB | 102376 | 665 | 39827 | 3183 | 1702 | 3451 | 3523 | 293 | 434 | 610 | 699 | 8.0% | 0.7% |
| ~300 KB | 294892 | 2039 | 102694 | 9921 | 5035 | 10602 | 11361 | 555 | 686 | 916 | 2380 | 9.7% | 0.5% |
| ~450 KB | 440944 | 3087 | 145488 | 10961 | 6931 | 12751 | 13320 | 706 | 958 | 1216 | 2409 | 7.5% | 0.5% |
| RN host | 860712 | 4816 | 348825 | 40934 | 41901 | 46865 | 47236 | 796 | 1749 | 2134 | 3128 | 11.7% | 0.2% |

* Plain-mode cost grows roughly linearly with the number of strings and functions (E2: 0.35 KB at 3 KB, 1.0 KB at 30 KB, 3.2 KB at 100 KB, 9.9 KB at 300 KB, 41 KB host), but as a fraction of the full unit it is flat at 7 to 12% from 10 KB upwards (17% at 3 KB). So splitting into finer units reduces **absolute** bytes ~linearly (a 30 KB unit pays 1 KB where a 300 KB unit pays 10 KB for the same edit) but not the relative size; the fixed per-patch overhead (hash floor ~85 B + container) is small.
* With `-base-bytecode` the cost is almost flat in size (E2: 0.17 to 0.8 KB from 3 KB to host; 0.2% to 8% of full). Finer units then matter little for patch size and mostly for blast radius and the chance of touching a unit at all.
* There is no size at which `full` beats the patch for a single edit: even at 3 KB the plain patch is 17 to 38% of full (E2/E5/E6: 350, 624, 772 B vs 2,023 B).

### 3.6 (e) Upper bound for a bytecode-aware diff (`st_norm.mjs`)

Experiment: a decoder for the 206 v96 opcodes generated from `BytecodeList.def` (self-test: opcode histogram equals `hermesc -dump-bytecode` on the 30 KB unit, 0 decode failures in 202 functions, 1337 string-ID operands, 201 function-ID operands, string and identifier counts match). Transform `T(old)`: rewrite every string-ID and function-ID operand through the old->new maps (maps by string content and by greedy monotone function-content matching), rewrite function-header name fields, permute the small string table and identifier-hash array into the new order. Then diff `T(old)` against `new` and add the cost of shipping the maps (zigzag-varint deltas, zstd-19). Last column: HDiffPatch on an ID-free dump (strings sorted by content, functions as disassembly with callee names, no offsets), i.e. the semantic change a perfect structure-aware patch would have to carry.


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

What it says:
* Remapping the plain build helps (300 KB E2 10.5 KB -> 3.1 KB total; host 45 KB -> 20 KB) but leaves 1.2 to 4.5 KB (300 KB) and 4 to 22 KB (host): the prototype does not rebuild string storage, offsets inside the small string table, or the object/array buffers (which are ID-bearing too). Completing those makes it a full re-implementation of the string-table packer on the device.
* Compared with `-base-bytecode` (0.1 to 3.1 KB at 300 KB, 0.1 to 3.8 KB host), a remap adds **nothing** for string edits (it adds the map cost) and only helps when function indexes shift: applying the remap on top of the delta-mode output takes E5b 1773 -> 1105 B and E6 3129 -> 1373 B (300 KB), host 3845 -> 2245 B and 3128 -> 2435 B. That is ~0.7 to 1.6 KB per patch, only for mid-unit function insertion, which append-ordering (3.3) removes at no cost.
* The semantic floor is 45 to 980 B. The gap between delta mode and the floor is up to 3.5 KB per patch (about 1 KB typical), mostly function-header offset shifts and function-ID shifts.
* **What an on-device inverse transform requires**: (1) an opcode table with operand kinds for the exact bytecode version (206 entries for v96; regenerate and re-review at every Hermes bump; a wrong table is silent until the hash check), (2) an instruction decoder including `SwitchImm` jump tables and overflowed function headers (my prototype skips those), (3) the string-table/identifier-hash/buffer permutation plumbing and the id maps in the patch format (new `patchAlgoVer`, new fuzz/corruption tests for the parser), (4) code identical on the build side (shared C++ in `otacore`) so that `T` is bit-exact on both, (5) memory for one transformed copy of the base (up to base size). Rough size: the table is ~1.5 KB of data, decoder and remap a few hundred lines; I did not measure shipped bytes. **Correctness burden is bounded**: the output must hash to the manifest value, so any transform bug ends as a verify failure and a fall back to the embedded bundle, never as wrong code; the real risks are build/device divergence and the per-Hermes-version table maintenance, not safety.

### 3.7 Diff parameters and lzma (`st_mitig.mjs params`)

300 KB unit (one position per edit):


#### HDiffPatch parameters, unit 300000 (one position per edit)

| params | E2 plain | E2 delta | E4 plain | E4 delta | E6 plain | E6 delta |
|---|---|---|---|---|---|---|
| zstd -l 19 -m 4 (shipping) | 10538 | 555 | 4888 | 653 | 11777 | 3129 |
| zstd -l 22 -m 4 | 10538 | 553 | 4887 | 648 | 11777 | 3133 |
| zstd -l 9 -m 4 | 11029 | 608 | 5218 | 717 | 12458 | 3331 |
| zstd -l 19 -m 1 | 10529 | 576 | 4967 | 703 | 11738 | 3127 |
| zstd -l 19 -m 2 | 10533 | 575 | 4953 | 700 | 11777 | 3127 |
| zstd -l 19 -m 8 | 11775 | 517 | 4713 | 653 | 11995 | 3137 |
| zstd -l 19 -m 16 | 13210 | 517 | 7702 | 653 | 13984 | 3992 |
| zstd -l 19 -m 32 | 13224 | 517 | 7764 | 618 | 13998 | 3925 |
| lzma -l 9 -m 4 | 9705 | 580 | 4681 | 691 | 10564 | 3010 |
| lzma -l 9 -m 2 | 9703 | 599 | 4752 | 736 | 10597 | 3009 |
| none -m 4 (uncompressed diff) | 25179 | 12853 | 27628 | 13001 | 43195 | 21750 |

Host:


#### HDiffPatch parameters, unit host (one position per edit)

| params | E2 plain | E2 delta | E4 plain | E4 delta | E6 plain | E6 delta |
|---|---|---|---|---|---|---|
| zstd -l 19 -m 4 (shipping) | 44994 | 905 | 41901 | 1637 | 47236 | 3128 |
| zstd -l 22 -m 4 | 45009 | 872 | 41901 | 1632 | 47236 | 3123 |
| zstd -l 9 -m 4 | 47956 | 1084 | 45110 | 1951 | 51003 | 3480 |
| zstd -l 19 -m 1 | 44773 | 931 | 41883 | 1658 | 46826 | 3176 |
| zstd -l 19 -m 2 | 45094 | 931 | 41849 | 1657 | 47171 | 3168 |
| zstd -l 19 -m 8 | 45840 | 840 | 42479 | 1586 | 47588 | 3096 |
| zstd -l 19 -m 16 | 52271 | 840 | 51915 | 1597 | 54081 | 3549 |
| zstd -l 19 -m 32 | 53088 | 840 | 52955 | 1597 | 54993 | 3503 |
| lzma -l 9 -m 4 | 39832 | 1004 | 36639 | 1739 | 39586 | 3073 |
| lzma -l 9 -m 2 | 39905 | 1030 | 36639 | 1762 | 39551 | 3113 |
| none -m 4 (uncompressed diff) | 132837 | 29790 | 117326 | 30558 | 123061 | 37101 |

* `-l 22` is a rounding error (within 1%), `-l 9` is 5 to 20% worse. `-m 1/2` help plain by <0.5% and hurt delta by 0 to 8%; `-m 8` is 0 to 7% better on delta cells and 2 to 12% worse on plain ones; `-m >= 16` is 16 to 58% worse on plain. The shipping `-l 19 -m 4` is a good compromise and nothing here justifies changing it.
* `lzma -l 9` is 4 to 16% smaller than zstd on the **plain** cells (host E2 45.0 -> 39.8 KB) and between 4% smaller and 11% larger on delta cells (host E2 905 -> 1004 B). It does not change the picture, and the device cost of an lzma decoder (+10 KB, `DESIGN.md` 5.7) is not justified by this.
* An uncompressed diff is 2.4x (plain) to 12 to 33x (delta) larger: a compressed diff stays mandatory.

## 4. Recommendations

**4.1 Do now (cheap, measured)**
1. Compile patch builds with `-base-bytecode=<base build's .hbc>` for the host and every unit; keep everything else in the recipe (`-O -emit-binary -g0`). Add the base hash to the repro inputs; error if the base is missing or reports another version. Re-run the device spike with one delta-built unit and the delta-built host before shipping (the only unproven part). Expected effect on `patch-report.json` ratios: single string/feature edit 0.1 to 3% of full at 300 KB and host, 1 to 8% at 30 KB; today typically 5 to 25%.
2. Order a unit's modules as in the base build, append modules new in a release at the end (the 2 to 3x residual in delta mode for function insertion goes away).
3. Keep `FULL_THRESHOLD` (0.6): with delta mode it is essentially a safety net (100 mixed edits on a 30 KB unit reach 32% of full), without it plain patches reach 55% on small units.
4. Do not restructure code for patch size once delta mode is in. Do not use `-O0`, `-g1`, `-fstrip-function-names`.

**4.2 One-page "writing patch-friendly units" list**
* Numeric/boolean/logic edits are free (85 B + the change) at any size.
* Text edits: with delta mode ~0.2 to 1 KB regardless of size; without it 0.2 to 52 KB depending on unit size, and randomly (typo fix in place: 85 B; reword: kilobytes).
* Prefer adding to the end: new modules at the end of the unit, new code after existing code.
* Do not rename/restructure properties for style in OTA releases; a rename is a delete plus an add of a string.
* Many small releases beat one big one only slightly (a release with 10 mixed edits is 4 to 11 KB in delta mode at 300 KB/host, 100 edits only 2 to 3x that).
* Frequently changing copy: serve it from the server (zero patch), not from the bundle.
* Keep unit size modest: patch size scales with unit size in plain mode.

**4.3 Ship `full` below some size?** No size-based rule is needed. For a single edit the patch beats `full` at every size down to ~3 KB (17 to 38% of full, 0.35 to 0.8 KB). Below ~3 KB zstd'd, a full costs less than 2 KB, so an absolute rule ("full when zstd-full <= 4 KB") loses nothing and avoids patch machinery for trivial units; this is a policy choice, not a measured crossover. The measured crossover is **by churn**, and only for plain builds (30 KB unit: 55% of full after ~100 mixed edits; 300 KB and host never exceed 31%).

**4.4 Calibrating soft/hard limits (proposal; the numbers are from this library corpus, calibrate on real units)**
Use ratio of the patch to the zstd'd full new artifact, as `DESIGN.md` 5.7 already says, plus a small absolute floor so tiny units do not alarm:

| | with delta mode: ≤10 mixed edits | 30 edits | 100 edits | plain: ≤10 edits |
|---|---|---|---|---|
| 30 KB unit | 1.1 KB (7.7%) | 1.9 KB (13.7%) | 4.6 KB (32.5%) | 4.2 KB (29.6%) |
| 300 KB unit | 3.8 KB (3.7%) | 7.7 KB (7.5%) | 8.9 KB (8.7%) | 16.6 KB (16.2%) |
| host | 10.8 KB (3.1%) | 24.6 KB (7.1%) | 25.8 KB (7.4%) | 70.8 KB (20.3%) |

Suggested starting point: soft limit 15% of zstd-full, hard limit 40% (below the 60% full fallback), each ignored when the patch is under ~3 KB, same ratio for units and host (the host just has a bigger absolute number: expect 1 to 5 KB for a one-string release and ~25 KB for 30 edits). **These limits only make sense with delta mode**: in plain mode a single string edit is already 5 to 14% and a 10-edit release 16 to 30%, so a 15% soft limit would flag nearly every release.

**4.5 Build a bytecode-aware diff?** No. Cost-benefit: after delta mode the remaining overhead above the semantic floor is up to 3.5 KB per patch (about 1 KB typical; the high end only when functions are inserted mid-unit); a remap recovers 0.7 to 1.6 KB of that in the best case and nothing for string edits; the price is a new on-device parser, a new `patchAlgoVer`, per-Hermes-version tables, and a build/device bit-exactness requirement (3.6). Revisit only if production data shows the delta-mode residual dominating download volume, or if the pipeline cannot use `-base-bytecode` for some reason (then the remap is a partial substitute, not a good one: 1 to 22 KB).

**4.6 Monitor in production / CI**
* per release and unit: patch bytes, ratio of zstd-full (already `ratioOfZstdFull`), count of `full` fallbacks, and the plain-equivalent for a sampled release (build both, record the ratio) to confirm delta mode keeps working after a Hermes/RN bump;
* a CI check that the new build's string-ID stability holds: number of strings whose ID differs from the base (should be 0 in delta mode; from `hermesc -b -dump-bytecode` of both) and number of functions with a new index (flags non-appended insertions);
* hbc size growth vs the base (delta mode keeps dead strings; alert if the unit grows by more than a few KB without a code change);
* base-missing / version-mismatch build errors;
* device side: load success rate per patch type (patch vs full vs embedded fallback), with delta-built bytecode split out for the first rollouts.

## 5. Limitations
* Corpus is library code (lodash/rxjs/date-fns/moment): fewer UI strings and more identifiers than an app; unit sizes are hbc bytes; units are shuffled library modules, not a real Metro unit graph; the 860 KB host is the real RN host but edits land at random modules (the real-app-code point is separately reproduced).
* Edits are synthetic, regex-driven source edits (rewording = text reversal or prefix); n = 3 positions per cell (min/median/max of 3, not a distribution); bimodality (85 B vs kilobytes) means medians of 3 can mislead for E2t/E3t/E8.
* One machine, `hermesc` 0.78.3 / HBC v96 only; the string-ID analysis is of the source at that exact commit; a Hermes bump can change the algorithm (opcode table, packer).
* `-base-bytecode` output was validated by dump comparison and parse, not executed on a device; the "validity" dump comparison folds buffer-offset operands and instruction width variants and so is not a byte-level proof.
* The remap prototype is partial (no storage/offset/buffers rebuild, no overflowed function headers, no `SwitchImm` table remap) and reports side-info cost by an ad-hoc encoding; it is an estimate, not an implementation. Device code size of a real decoder was not measured.
* `full` is measured as HDiffPatch against an empty file (as `patch.ts` does), not as a separate zstd stream.
* Distinct-position selection stops at 3; E7/E8 candidates require the literal/word to be unique in the unit, which biases to rarely-used names.

## 6. Files

| file | purpose |
|---|---|
| `st_lib.mjs` | shared: corpus + unit builder, edit classes E1..E8, compile (pinned recipe), diff, HBC region parser |
| `st_matrix.mjs`, `st_tables.mjs` | the matrix and its markdown tables |
| `st_mech.mjs` | mechanism table (IDs moved, bodies changed by renumbering, region attribution) |
| `st_idorder.mjs`, `st_rank.mjs` | what the final ID order looks like; rank of a new string |
| `st_mitig.mjs` | `flags`, `scale`, `copy`, `churn`, `params`, `validate` |
| `st_norm.mjs` | opcode decoder (self-test), remap prototype, semantic floor |
| `st_spike_real.mjs` | the owner's host-app-code string edit |
| `st_fetch_corpus.sh`, `st_fetch_hermes_src.sh` | inputs (npm tarballs extracted only; Hermes sources at the pinned commit, read as data) |
| `st_run_all.sh` | everything, in order |
| `st_results/` | outputs used in this document |

## 7. Reproduce

```sh
cd native/measure-rn078
./st_run_all.sh                     # ~15 min; scratch in <repo>/.work/st, results in <repo>/.work/st/results
# or piecewise (N=node 24 on PATH; hermesc pinned at <repo>/.tools/hermesc-rn0.78.3/hermesc, hdiffz_tool at native/build-ota-tools)
./st_fetch_corpus.sh ../../.work/st/src && ./st_fetch_hermes_src.sh ../../.work/st/hsrc
node st_matrix.mjs --sizes=30000,300000,host --out=../../.work/st/results/matrix.json && node st_tables.mjs ../../.work/st/results/matrix.json
node st_mech.mjs --size=300000 --edit=all --seed=1 --delta=1
node st_mitig.mjs flags --size=300000      # also: scale | copy | churn | params --size=host | validate --size=30000
node st_norm.mjs --selftest && node st_norm.mjs --size=300000 --edit=E2,E6
node st_rank.mjs --size=host ; node st_idorder.mjs ; node st_spike_real.mjs
# one-off: compile the same edit with and without the flag
cd /some/dir && cp unit.js bundle.js
hermesc -O -emit-binary -g0 -out plain.hbc bundle.js
hermesc -O -emit-binary -g0 -base-bytecode=base.hbc -out delta.hbc bundle.js
../../native/build-ota-tools/hdiffz_tool -c zstd -l 19 -m 4 base.hbc delta.hbc delta.patch
```
`st_run_all.sh` bundles the spike-app host with `examples/spike-app/scripts/lib.mjs` (read-only use; output goes to `.work/st/hostb`). Delete `.work/st` afterwards.
