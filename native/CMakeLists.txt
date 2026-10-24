cmake_minimum_required(VERSION 3.20)
project(otacore LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Compression plugins compiled into the PATCH side (what ships in the app).
option(OTACORE_ZSTD "Patch side: zstd-compressed diffs" ON)
option(OTACORE_LZMA "Patch side: lzma-compressed diffs" ON)
option(OTACORE_ZSTD_SMALL "zstd decoder: single Huffman decoder + short-sequence path (-~25 KB, slightly slower)" ON)
option(OTACORE_SANITIZE "Build everything with ASan+UBSan" OFF)
option(OTACORE_BUILD_TOOLS "Build hdiffz_tool and measure_patch" ON)

if(OTACORE_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=undefined -g)
  add_link_options(-fsanitize=address,undefined)
endif()

set(TP ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
set(HDP ${TP}/HDiffPatch)
set(ZSTD ${TP}/zstd/lib)
set(LZMA ${TP}/lzma/C)

# ---------------------------------------------------------------- third-party: patch side
# We compile only the sources we need; nothing from the upstream build systems is run.
add_library(hpatch_core STATIC ${HDP}/libHDiffPatch/HPatch/patch.c)
# No threads in the patch path (smaller, simpler, and mobile apps drive threading themselves).
target_compile_definitions(hpatch_core PUBLIC _IS_USED_MULTITHREAD=0 _HPATCH_IS_USED_MULTITHREAD=0
  _IS_NEED_CACHE_OLD_BY_COVERS=0 _LARGEFILE_SOURCE _FILE_OFFSET_BITS=64)
target_include_directories(hpatch_core PUBLIC ${HDP})
# patch.c includes hpatch_mt/hpatch_mt.h; with MT off its functions are not needed but keep the TU.
target_sources(hpatch_core PRIVATE ${HDP}/libHDiffPatch/HPatch/hpatch_mt/hpatch_mt.c)
set_source_files_properties(${HDP}/libHDiffPatch/HPatch/patch.c PROPERTIES COMPILE_OPTIONS "-w")
set_source_files_properties(${HDP}/libHDiffPatch/HPatch/hpatch_mt/hpatch_mt.c PROPERTIES COMPILE_OPTIONS "-w")

set(ZSTD_DEFS ZSTD_DISABLE_ASM=1 ZSTD_HAVE_WEAK_SYMBOLS=0 ZSTD_TRACE=0 ZSTD_STRIP_ERROR_STRINGS=1
    ZSTD_LEGACY_SUPPORT=0 ZSTD_MULTITHREAD=0)
if(OTACORE_ZSTD)
  add_library(zstd_dec STATIC
    ${ZSTD}/common/debug.c ${ZSTD}/common/entropy_common.c ${ZSTD}/common/error_private.c
    ${ZSTD}/common/fse_decompress.c ${ZSTD}/common/zstd_common.c ${ZSTD}/common/xxhash.c
    ${ZSTD}/decompress/huf_decompress.c ${ZSTD}/decompress/zstd_ddict.c
    ${ZSTD}/decompress/zstd_decompress.c ${ZSTD}/decompress/zstd_decompress_block.c)
  target_include_directories(zstd_dec PUBLIC ${ZSTD} PRIVATE ${ZSTD}/common)
  target_compile_definitions(zstd_dec PRIVATE ${ZSTD_DEFS})
  if(OTACORE_ZSTD_SMALL)
    target_compile_definitions(zstd_dec PRIVATE HUF_FORCE_DECOMPRESS_X1 ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT)
  endif()
  target_compile_options(zstd_dec PRIVATE -w)
endif()
if(OTACORE_LZMA)
  add_library(lzma_dec STATIC ${LZMA}/LzmaDec.c ${LZMA}/Alloc.c ${LZMA}/CpuArch.c ${LZMA}/7zStream.c)
  target_include_directories(lzma_dec PUBLIC ${LZMA})
  target_compile_definitions(lzma_dec PRIVATE Z7_ST)
  target_compile_options(lzma_dec PRIVATE -w)
endif()

# ---------------------------------------------------------------- otacore
add_library(otacore STATIC
  otacore/src/sha256.cpp otacore/src/manifest.cpp otacore/src/select.cpp
  otacore/src/patch.cpp otacore/src/cache.cpp otacore/src/c_api.cpp)
target_include_directories(otacore PUBLIC otacore/include PRIVATE ${TP}/nlohmann_json/include)
target_link_libraries(otacore PUBLIC hpatch_core)
target_compile_options(otacore PRIVATE -Wall -Wextra)
if(OTACORE_ZSTD)
  target_compile_definitions(otacore PRIVATE OTACORE_WITH_ZSTD)
  target_link_libraries(otacore PUBLIC zstd_dec)
endif()
if(OTACORE_LZMA)
  target_compile_definitions(otacore PRIVATE OTACORE_WITH_LZMA)
  target_link_libraries(otacore PUBLIC lzma_dec)
endif()
# The HDiffPatch plugin header pulls these in; keep its warnings out of our -Wall output.
set_source_files_properties(otacore/src/patch.cpp PROPERTIES COMPILE_OPTIONS "-Wno-unused-parameter;-Wno-sign-compare;-Wno-missing-field-initializers")

# ---------------------------------------------------------------- tools (diff side; NOT shipped)
if(OTACORE_BUILD_TOOLS)
  file(GLOB ZSTD_ENC ${ZSTD}/compress/*.c)
  add_library(zstd_enc STATIC ${ZSTD_ENC} ${ZSTD}/common/pool.c ${ZSTD}/common/threading.c)
  target_link_libraries(zstd_enc PUBLIC zstd_dec)
  target_compile_definitions(zstd_enc PRIVATE ${ZSTD_DEFS})
  target_include_directories(zstd_enc PRIVATE ${ZSTD}/common)
  target_compile_options(zstd_enc PRIVATE -w)

  add_library(lzma_enc STATIC ${LZMA}/LzFind.c ${LZMA}/LzFindOpt.c ${LZMA}/LzmaEnc.c)
  target_link_libraries(lzma_enc PUBLIC lzma_dec)
  target_compile_definitions(lzma_enc PRIVATE Z7_ST)
  target_compile_options(lzma_enc PRIVATE -w)
  if(OTACORE_SANITIZE)  # upstream LzmaEnc does a UB (misaligned store, clz(0)); diff side only, never shipped
    target_compile_options(lzma_enc PRIVATE -fno-sanitize=undefined)
  endif()

  set(HDIFF ${HDP}/libHDiffPatch/HDiff)
  add_library(hdiff STATIC
    ${HDIFF}/diff.cpp
    ${HDIFF}/private_diff/match_block.cpp ${HDIFF}/private_diff/bytes_rle.cpp
    ${HDIFF}/private_diff/suffix_string.cpp ${HDIFF}/private_diff/compress_detect.cpp
    ${HDIFF}/private_diff/limit_mem_diff/digest_matcher.cpp
    ${HDIFF}/private_diff/limit_mem_diff/stream_serialize.cpp
    ${HDIFF}/private_diff/limit_mem_diff/adler_roll.c
    ${HDIFF}/private_diff/libdivsufsort/divsufsort.cpp
    ${HDIFF}/private_diff/libdivsufsort/divsufsort64.cpp
    ${HDIFF}/private_diff/window_diff/window_matcher.cpp
    ${HDIFF}/private_diff/window_diff/covers_range.cpp
    ${HDP}/libHDiffPatch/HPatchLite/hpatch_lite.c)
  target_link_libraries(hdiff PUBLIC hpatch_core)
  target_compile_options(hdiff PRIVATE -w)

  # hdiffz_tool: thin CLI over HDiffPatch's create_single_compressed_diff (the format applyPatch
  # consumes). Upstream hdiffz drags in directory diff, bsdiff, vcdiff, bz2, zlib, md5... that we
  # neither need nor want to build.
  add_executable(hdiffz_tool tools/hdiffz_tool.cpp)
  target_link_libraries(hdiffz_tool PRIVATE hdiff zstd_enc lzma_enc)
  target_compile_definitions(hdiffz_tool PRIVATE _CompressPlugin_zstd _CompressPlugin_lzma)
  target_include_directories(hdiffz_tool PRIVATE ${HDP})
  target_compile_options(hdiffz_tool PRIVATE -w)

  add_executable(measure_patch tools/measure.cpp)
  target_link_libraries(measure_patch PRIVATE otacore)
  target_compile_definitions(measure_patch PRIVATE HDIFFZ_TOOL_PATH="$<TARGET_FILE:hdiffz_tool>")
  add_dependencies(measure_patch hdiffz_tool)

  # Size probes (see tools/measure_size.sh): base = no patch code reachable, full = applyPatch reachable.
  add_executable(size_probe_base tools/size_probe.cpp)
  target_link_libraries(size_probe_base PRIVATE otacore)
  add_executable(size_probe tools/size_probe.cpp)
  target_link_libraries(size_probe PRIVATE otacore)
  target_compile_definitions(size_probe PRIVATE WITH_PATCH)

  add_executable(size_probe_manifest tools/size_probe.cpp)
  target_link_libraries(size_probe_manifest PRIVATE otacore)
  target_compile_definitions(size_probe_manifest PRIVATE WITH_MANIFEST)

  add_executable(gen_synthetic tools/gen_synthetic.cpp)
  target_link_libraries(gen_synthetic PRIVATE otacore)
  target_include_directories(gen_synthetic PRIVATE ${TP}/nlohmann_json/include)
  target_compile_definitions(gen_synthetic PRIVATE HDIFFZ_TOOL_PATH="")
endif()

# Extension points (each owned by one component; files are optional)
include(cmake/runtime.cmake OPTIONAL)    # OTA runtime orchestrator + scenario tests
include(cmake/ota_tools.cmake OPTIONAL)  # build-side CLI tools used by packages/ota-build

# ---------------------------------------------------------------- tests
enable_testing()
if(OTACORE_BUILD_TOOLS)
  add_subdirectory(tests)
endif()
