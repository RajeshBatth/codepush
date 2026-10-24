#include "ota_unit_loader.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstring>

#include "otacore/otacore.h"

namespace otaspike {

const char* toString(LoadStatus s) {
  switch (s) {
    case LoadStatus::Ok: return "Ok";
    case LoadStatus::IoError: return "IoError";
    case LoadStatus::TooSmall: return "TooSmall";
    case LoadStatus::NotHermesBytecode: return "NotHermesBytecode";
    case LoadStatus::BytecodeVersionMismatch: return "BytecodeVersionMismatch";
    case LoadStatus::Misaligned: return "Misaligned";
    case LoadStatus::HashMismatch: return "HashMismatch";
    case LoadStatus::EvalError: return "EvalError";
    case LoadStatus::RequireError: return "RequireError";
    case LoadStatus::NoRuntime: return "NoRuntime";
  }
  return "?";
}

LoadStatus mapFile(const std::string& path, MappedFile& out) {
  out = {};
  int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) return LoadStatus::IoError;
  struct stat st {};
  if (::fstat(fd, &st) != 0 || st.st_size <= 0) {
    ::close(fd);
    return st.st_size == 0 ? LoadStatus::TooSmall : LoadStatus::IoError;
  }
  void* p = ::mmap(nullptr, static_cast<size_t>(st.st_size), PROT_READ, MAP_PRIVATE, fd, 0);
  ::close(fd);  // the mapping stays valid after close
  if (p == MAP_FAILED) return LoadStatus::IoError;
  out.data = static_cast<const uint8_t*>(p);
  out.size = static_cast<size_t>(st.st_size);
  return LoadStatus::Ok;
}

bool hasHermesMagic(const MappedFile& f) {
  if (f.size < 8) return false;
  uint64_t m = 0;
  std::memcpy(&m, f.data, 8);  // little endian hosts (arm64/x86_64)
  return m == kHermesMagic;
}

uint32_t bytecodeVersion(const MappedFile& f) {
  uint32_t v = 0;
  if (f.size >= 12) std::memcpy(&v, f.data + 8, 4);
  return v;
}

LoadStatus preEvaluateChecks(const MappedFile& f, uint32_t expectedBytecodeVersion, const std::string& expectedHash) {
  if (f.data == nullptr || f.size < 12) return LoadStatus::TooSmall;
  if (reinterpret_cast<uintptr_t>(f.data) % 4 != 0) return LoadStatus::Misaligned;
  if (!hasHermesMagic(f)) return LoadStatus::NotHermesBytecode;
  if (bytecodeVersion(f) != expectedBytecodeVersion) return LoadStatus::BytecodeVersionMismatch;
  if (!expectedHash.empty() && otacore::sha256Hash(f.data, f.size) != expectedHash) return LoadStatus::HashMismatch;
  return LoadStatus::Ok;
}

}  // namespace otaspike
