# Build-side tools used by packages/ota-build (included from the top-level CMakeLists via include(... OPTIONAL)).
# ota_apply links the same `otacore` the app ships, so patch round-trips in CI exercise the shipped apply code.
add_executable(ota_apply tools/ota_apply/ota_apply.cpp)
target_link_libraries(ota_apply PRIVATE otacore)
target_compile_options(ota_apply PRIVATE -Wall -Wextra)
