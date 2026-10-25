# OTA runtime orchestrator (native/otacore/runtime) + deterministic scenario tests (native/tests/runtime).
# Included from the top-level CMakeLists.txt. Targets: otaruntime (library), test_runtime (scenarios).

set(RT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/otacore/runtime)
add_library(otaruntime STATIC ${RT_DIR}/src/runtime.cpp ${RT_DIR}/src/runtime_support.cpp ${RT_DIR}/src/crash_guard.cpp ${RT_DIR}/src/manifest_sync.cpp ${RT_DIR}/src/patch_pipeline.cpp ${RT_DIR}/src/vm_lifecycle.cpp ${RT_DIR}/src/unit_loader.cpp ${RT_DIR}/src/defaults.cpp)
target_include_directories(otaruntime PUBLIC ${RT_DIR}/include)
target_link_libraries(otaruntime PUBLIC otacore)
target_compile_options(otaruntime PRIVATE -Wall -Wextra -Wshadow)

if(OTACORE_BUILD_TOOLS)  # scenario tests build real patches with hdiffz_tool
  enable_testing()
  set(RT_TESTS ${CMAKE_CURRENT_SOURCE_DIR}/tests/runtime)
  file(GLOB RT_TEST_SRCS CONFIGURE_DEPENDS ${RT_TESTS}/*.cpp)
  add_executable(test_runtime ${RT_TEST_SRCS})
  target_link_libraries(test_runtime PRIVATE otaruntime)
  target_include_directories(test_runtime PRIVATE ${RT_TESTS} ${CMAKE_CURRENT_SOURCE_DIR}/tests ${TP}/nlohmann_json/include)
  target_compile_definitions(test_runtime PRIVATE
    HDIFFZ_TOOL_PATH="$<TARGET_FILE:hdiffz_tool>"
    RT_WORK_DIR="${CMAKE_CURRENT_SOURCE_DIR}/.work/runtime-tests")
  target_compile_options(test_runtime PRIVATE -Wall -Wextra)
  add_dependencies(test_runtime hdiffz_tool)

  # One CTest per scenario: every SCENARIO(name) in tests/runtime/*.cpp.
  foreach(src ${RT_TEST_SRCS})
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${src})
    file(STRINGS ${src} scn_lines REGEX "^SCENARIO\\([a-z0-9_]+\\)")
    foreach(line ${scn_lines})
      string(REGEX REPLACE "^SCENARIO\\(([a-z0-9_]+)\\).*" "\\1" scn "${line}")
      add_test(NAME runtime.${scn} COMMAND test_runtime ${scn})
    endforeach()
  endforeach()
endif()
