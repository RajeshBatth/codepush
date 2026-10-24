cmake_minimum_required(VERSION 3.13)
project(otaspike)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# repo layout: <spike-app>/android/otaspike_native/src/main/cpp -> <spike-app>/shared, <repo>/native/otacore
get_filename_component(SPIKE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." ABSOLUTE)
get_filename_component(REPO_DIR "${SPIKE_DIR}/../.." ABSOLUTE)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)

add_library(otaspike SHARED
    otaspike_jni.cpp
    ${SPIKE_DIR}/shared/ota_unit_loader.cpp
    ${REPO_DIR}/native/otacore/src/sha256.cpp)

target_include_directories(otaspike PRIVATE
    ${SPIKE_DIR}/shared
    ${REPO_DIR}/native/otacore/include)

target_compile_options(otaspike PRIVATE -fexceptions -frtti -Wall)

target_link_libraries(otaspike
    ReactAndroid::reactnative
    ReactAndroid::jsi
    fbjni::fbjni
    log
    android)
