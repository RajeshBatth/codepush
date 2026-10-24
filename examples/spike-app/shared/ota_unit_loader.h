// Platform-neutral primitives for loading a Hermes-bytecode unit into a running RN VM (DESIGN.md 5.6 C, 5.8).
// No JSI here: this part is host-testable. The JSI adapter is in ota_unit_jsi.h.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace otaspike {

enum class LoadStatus {
  Ok = 0,
  IoError,
  TooSmall,                 // smaller than the Hermes bytecode header prefix we inspect
  NotHermesBytecode,        // magic number missing: Hermes would compile this as JS SOURCE, so never evaluate it
  BytecodeVersionMismatch,  // runtime expects a different HBC version
  Misaligned,               // Hermes requires a 4-byte aligned buffer
  HashMismatch,             // sha256 differs from the manifest hash
  EvalError,                // evaluateJavaScript threw
  RequireError,             // evaluated fine, but running the entry module threw (VM may now be polluted)
  NoRuntime,
};

const char* toString(LoadStatus s);

struct MappedFile {
  const uint8_t* data = nullptr;
  size_t size = 0;
};

// Read-only private mmap. The mapping is intentionally NEVER unmapped: Hermes may keep referencing bytecode lazily
// for the life of the process. mmap returns page-aligned memory, so alignment always holds for a fresh mapping.
LoadStatus mapFile(const std::string& path, MappedFile& out);

// Hermes bytecode header prefix: u64 magic (little endian) then u32 version.
constexpr uint64_t kHermesMagic = 0x1F1903C103BC1FC6ULL;
bool hasHermesMagic(const MappedFile& f);
uint32_t bytecodeVersion(const MappedFile& f);  // only valid if hasHermesMagic

// DESIGN.md 5.8 pre-evaluate checks, in order: size, alignment, magic, version, (optional) sha256.
// expectedHash may be empty to skip the hash (e.g. when the caller already verified the file).
LoadStatus preEvaluateChecks(const MappedFile& f, uint32_t expectedBytecodeVersion, const std::string& expectedHash);

}  // namespace otaspike
