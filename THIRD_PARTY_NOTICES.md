# Third-party notices

This repository's own code is **not open source** (see [LICENSE](LICENSE)). It vendors, and is derived from, the third-party components below. Each keeps its own license, which is reproduced here as those licenses require. Exact versions and commit SHAs of the vendored sources are recorded in [native/third_party/VERSIONS.md](native/third_party/VERSIONS.md). Nothing in this repository's LICENSE grants or limits rights in these components beyond what their own licenses say.

| Component | Where | License |
|---|---|---|
| HDiffPatch (sisong/HDiffPatch) | `native/third_party/HDiffPatch` | MIT (also bundles libdivsufsort, MIT; see below) |
| Zstandard (facebook/zstd) | `native/third_party/zstd` | BSD-3-Clause (we use the BSD terms of its BSD/GPLv2 dual license) |
| LZMA SDK (Igor Pavlov, via the sisong/lzma mirror) | `native/third_party/lzma` | Public domain |
| JSON for Modern C++ (nlohmann/json) 3.12.0 | `native/third_party/nlohmann_json` | MIT |
| React Native community app template | `examples/spike-app` (generated app skeleton and native project files) | MIT, Copyright (c) Meta Platforms, Inc. and affiliates |
| Gradle wrapper | `examples/spike-app/android/gradle/wrapper` | Apache License 2.0 |

npm dependencies are not vendored: they are installed from their registries (see each package's `package.json` and lockfile) under their own licenses.

Vendored source rows from VERSIONS.md:

| HDiffPatch (sisong/HDiffPatch) | v5.1.3 | `3b9dca715ca492873bf2c49e22e5d5b7d2a78620` | MIT | patch side `libHDiffPatch/HPatch/*.c` (ships); diff side `libHDiffPatch/HDiff/*` (test/measure tool only); plugin headers `decompress_plugin_demo.h`, `compress_plugin_demo.h`, `compress_parallel.*`, `libParallel/` |
| zstd (facebook/zstd, upstream, not the sisong fork) | v1.5.7 | `f8745da6ff1ad1e7bab384bd1f9d742439278e99` | BSD-3-Clause (dual BSD / GPLv2; we use BSD, see `zstd/LICENSE`) | decoder (ships); encoder (tool only) |
| LZMA SDK (sisong/lzma, a mirror of 7-Zip LZMA SDK 26.02) | HEAD of default branch at fetch time (no tag matches the SDK version) | `44809544b95bbf2dccec75d954657ff76fc349ff` | Public domain (Igor Pavlov) | LzmaDec (ships, optional); LzmaEnc/LzFind (tool only) |
| nlohmann/json single header | v3.12.0 | tag commit `65ee68451d8eb2b5f3a30b410476ab83deb3289b`; `json.hpp` sha256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63` | MIT | manifest parsing (`include/nlohmann/json.hpp`) |

---

## HDiffPatch (and bundled libdivsufsort)

MIT License

HDiffPatch
Copyright (c) 2012-2025 housisong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

----------------------------------------------------------------------------------

libdivsufsort
Copyright (c) 2003-2008 Yuta Mori All Rights Reserved.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

---

## Zstandard

BSD License

For Zstandard software

Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

 * Neither the name Facebook, nor Meta, nor the names of its contributors may
   be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

(Zstandard is dual-licensed BSD / GPLv2; this project uses it under the BSD terms above. The full GPLv2 text is in `native/third_party/zstd/COPYING`.)

---

## LZMA SDK

LZMA SDK is written and placed in the public domain by Igor Pavlov (see `native/third_party/lzma/DOC/lzma-sdk.txt`). Some code in the LZMA SDK is based on public domain code from other developers, as described in that file.

---

## JSON for Modern C++ (nlohmann/json)

MIT License

Copyright (c) 2013-2025 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
