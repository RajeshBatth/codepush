// Hermes bytecode header checks (DESIGN 5.8 pre-evaluate checks). Pure functions.
#pragma once
#include <cstddef>
#include <cstdint>

namespace otaruntime {

// Little-endian magic at offset 0; version u32 (little-endian) at offset 8.
constexpr uint64_t kHermesMagic = 0x1F1903C103BC1FC6ull;

// Returns nullptr when the buffer looks like Hermes bytecode of `expectedVersion` and is 4-byte aligned;
// otherwise a short reason: "misaligned", "too-small", "bad-magic", "bad-version".
inline const char* checkHermesBytecode(const uint8_t* p, size_t n, uint32_t expectedVersion) {
  if (reinterpret_cast<uintptr_t>(p) % 4 != 0) return "misaligned";
  if (n < 12) return "too-small";
  uint64_t magic = 0;
  for (int i = 7; i >= 0; i--) magic = (magic << 8) | p[i];
  if (magic != kHermesMagic) return "bad-magic";
  uint32_t ver = uint32_t(p[8]) | uint32_t(p[9]) << 8 | uint32_t(p[10]) << 16 | uint32_t(p[11]) << 24;
  if (ver != expectedVersion) return "bad-version";
  return nullptr;
}

}  // namespace otaruntime
