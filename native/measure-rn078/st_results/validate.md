
#### -base-bytecode validity, unit 30000 (hermesc -b -dump-bytecode parses both binaries; compare function texts - instruction width variants Short/Long are folded, object/array-buffer offsets ignored - and string sets)

| edit | functions equal as multiset | plain strings subset of delta | extra (dead, from base) strings in delta | delta rebuilt in other cwd == same bytes | hbc B plain / delta |
|---|---|---|---|---|---|
| E1 | yes (202) | yes | 0 | yes | 30628 / 30628 |
| E2 | yes (202) | yes | 1 | yes | 30628 / 30648 |
| E2t | yes (202) | yes | 1 | yes | 30628 / 30640 |
| E3 | yes (202) | yes | 1 | yes | 30632 / 30644 |
| E3t | yes (202) | yes | 1 | yes | 30640 / 30652 |
| E4 | yes (202) | yes | 0 | yes | 30664 / 30668 |
| E5 | yes (204) | yes | 0 | yes | 30832 / 30844 |
| E5b | yes (203) | yes | 0 | yes | 30784 / 30796 |
| E6 | yes (203) | yes | 0 | yes | 30780 / 30792 |
| E7 | yes (202) | yes | 1 | yes | 30616 / 30628 |
| E8 | yes (202) | yes | 1 | yes | 30636 / 30648 |

#### -base-bytecode validity, unit 300000 (hermesc -b -dump-bytecode parses both binaries; compare function texts - instruction width variants Short/Long are folded, object/array-buffer offsets ignored - and string sets)

| edit | functions equal as multiset | plain strings subset of delta | extra (dead, from base) strings in delta | delta rebuilt in other cwd == same bytes | hbc B plain / delta |
|---|---|---|---|---|---|
| E1 | yes (2039) | yes | 0 | yes | 294896 / 294896 |
| E2 | yes (2039) | yes | 1 | yes | 294892 / 294920 |
| E2t | yes (2039) | yes | 1 | yes | 294892 / 294920 |
| E3 | yes (2039) | yes | 1 | yes | 294896 / 294924 |
| E3t | yes (2039) | yes | 1 | yes | 294904 / 294932 |
| E4 | yes (2039) | yes | 0 | yes | 294932 / 294936 |
| E5 | yes (2041) | yes | 0 | yes | 295096 / 295108 |
| E5b | yes (2040) | yes | 0 | yes | 295048 / 295060 |
| E6 | yes (2040) | yes | 0 | yes | 295044 / 295056 |
| E7 | yes (2039) | yes | 1 | yes | 294884 / 294892 |
| E8 | yes (2039) | yes | 1 | yes | 294896 / 294912 |

#### -base-bytecode validity, unit host (hermesc -b -dump-bytecode parses both binaries; compare function texts - instruction width variants Short/Long are folded, object/array-buffer offsets ignored - and string sets)

| edit | functions equal as multiset | plain strings subset of delta | extra (dead, from base) strings in delta | delta rebuilt in other cwd == same bytes | hbc B plain / delta |
|---|---|---|---|---|---|
| E1 | yes (4805) | yes | 0 | yes | 860712 / 860712 |
| E2 | yes (4805) | yes | 1 | yes | 860720 / 860732 |
| E2t | yes (4805) | yes | 1 | yes | 860712 / 860792 |
| E3 | yes (4805) | yes | 1 | yes | 860724 / 860732 |
| E3t | yes (4805) | yes | 1 | yes | 860724 / 860804 |
| E4 | yes (4805) | yes | 0 | yes | 860748 / 860756 |
| E5 | yes (4807) | yes | 0 | yes | 860916 / 860928 |
| E5b | yes (4806) | yes | 0 | yes | 860864 / 860876 |
| E6 | yes (4806) | yes | 0 | yes | 860864 / 860876 |
| E7 | yes (4805) | yes | 1 | yes | 860696 / 860712 |
| E8 | yes (4805) | yes | 1 | yes | 860708 / 860732 |
