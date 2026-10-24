set(VECTORS_DIR ${CMAKE_SOURCE_DIR}/../packages/ota-core/vectors)

foreach(t hashing manifest patch cache)
  add_executable(test_${t} test_${t}.cpp)
  target_link_libraries(test_${t} PRIVATE otacore)
  target_include_directories(test_${t} PRIVATE ${TP}/nlohmann_json/include)
  target_compile_definitions(test_${t} PRIVATE
    VECTORS_DIR="${VECTORS_DIR}" HDIFFZ_TOOL_PATH="$<TARGET_FILE:hdiffz_tool>")
  target_compile_options(test_${t} PRIVATE -Wall -Wextra)
  add_dependencies(test_${t} hdiffz_tool)
  add_test(NAME ${t} COMMAND test_${t})
endforeach()
