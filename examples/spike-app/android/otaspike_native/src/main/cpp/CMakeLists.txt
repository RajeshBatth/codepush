cmake_minimum_required(VERSION 3.13)
project(otaspike)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# repo layout: <spike-app>/android/otaspike_native/src/main/cpp -> <spike-app>/shared, <repo>/native/otacore
get_filename_component(SPIKE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." ABSOLUTE)
get_filename_component(REPO_DIR "${SPIKE_DIR}/../.." ABSOLUTE)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)

# ---- otacore patch side (HDiffPatch + zstd decoder), same source list / definitions as native/CMakeLists.txt
# (OTACORE_ZSTD=ON, OTACORE_ZSTD_SMALL=ON, OTACORE_LZMA=OFF). Compiled from the repo by path; nothing under native/ is edited.
set(TP ${REPO_DIR}/native/third_party)
set(HDP ${TP}/HDiffPatch)
set(ZSTD ${TP}/zstd/lib)
add_library(hpatch_core STATIC
    ${HDP}/libHDiffPatch/HPatch/patch.c
    ${HDP}/libHDiffPatch/HPatch/hpatch_mt/hpatch_mt.c)
target_compile_definitions(hpatch_core PUBLIC _IS_USED_MULTITHREAD=0 _HPATCH_IS_USED_MULTITHREAD=0
    _IS_NEED_CACHE_OLD_BY_COVERS=0 _LARGEFILE_SOURCE _FILE_OFFSET_BITS=64)
target_include_directories(hpatch_core PUBLIC ${HDP})
target_compile_options(hpatch_core PRIVATE -w -fPIC)
add_library(zstd_dec STATIC
    ${ZSTD}/common/debug.c ${ZSTD}/common/entropy_common.c ${ZSTD}/common/error_private.c
    ${ZSTD}/common/fse_decompress.c ${ZSTD}/common/zstd_common.c ${ZSTD}/common/xxhash.c
    ${ZSTD}/decompress/huf_decompress.c ${ZSTD}/decompress/zstd_ddict.c
    ${ZSTD}/decompress/zstd_decompress.c ${ZSTD}/decompress/zstd_decompress_block.c)
target_include_directories(zstd_dec PUBLIC ${ZSTD} PRIVATE ${ZSTD}/common)
target_compile_definitions(zstd_dec PRIVATE ZSTD_DISABLE_ASM=1 ZSTD_HAVE_WEAK_SYMBOLS=0 ZSTD_TRACE=0 ZSTD_STRIP_ERROR_STRINGS=1
    ZSTD_LEGACY_SUPPORT=0 ZSTD_MULTITHREAD=0 HUF_FORCE_DECOMPRESS_X1 ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT)
target_compile_options(zstd_dec PRIVATE -w -fPIC)
add_library(otacore_patch STATIC
    ${REPO_DIR}/native/otacore/src/sha256.cpp
    ${REPO_DIR}/native/otacore/src/patch.cpp)
target_include_directories(otacore_patch PUBLIC ${REPO_DIR}/native/otacore/include)
target_compile_definitions(otacore_patch PRIVATE OTACORE_WITH_ZSTD)
target_compile_options(otacore_patch PRIVATE -fPIC -fexceptions -Wno-unused-parameter -Wno-sign-compare -Wno-missing-field-initializers)
target_link_libraries(otacore_patch PUBLIC hpatch_core zstd_dec)

add_library(otaspike SHARED
    otaspike_jni.cpp
    ${SPIKE_DIR}/shared/ota_unit_loader.cpp)

target_include_directories(otaspike PRIVATE
    ${SPIKE_DIR}/shared
    ${REPO_DIR}/native/otacore/include)

target_compile_options(otaspike PRIVATE -fexceptions -frtti -Wall)

target_link_libraries(otaspike
    otacore_patch
    ReactAndroid::reactnative
    ReactAndroid::jsi
    fbjni::fbjni
    log
    android)
