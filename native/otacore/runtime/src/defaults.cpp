#include "otaruntime/defaults.h"

#include <cstdio>
#include <cstring>
#include <filesystem>

namespace fs = std::filesystem;

namespace otaruntime {
namespace {
class AlignedBuffer : public Buffer {
 public:
  explicit AlignedBuffer(size_t n) : words_((n + 3) / 4 + 1), n_(n) {}
  uint8_t* mut() { return reinterpret_cast<uint8_t*>(words_.data()); }
  const uint8_t* data() const override { return reinterpret_cast<const uint8_t*>(words_.data()); }
  size_t size() const override { return n_; }

 private:
  std::vector<uint32_t> words_;  // uint32_t storage => 4-byte aligned (malloc gives 16)
  size_t n_;
};
}  // namespace

std::shared_ptr<const Buffer> makeAlignedBuffer(const void* data, size_t n) {
  auto b = std::make_shared<AlignedBuffer>(n);
  if (n) std::memcpy(b->mut(), data, n);
  return b;
}

int64_t StdFileSystem::fileSize(const std::string& path) {
  std::error_code ec;
  auto n = fs::file_size(path, ec);
  return ec ? -1 : int64_t(n);
}
bool StdFileSystem::remove(const std::string& path) {
  std::error_code ec;
  fs::remove(path, ec);
  return !ec;
}
std::string StdFileSystem::canonical(const std::string& path) {
  std::error_code ec;
  auto p = fs::canonical(path, ec);
  return ec ? std::string() : p.string();
}
bool StdFileSystem::sha256File(const std::string& path, std::string& out) { return otacore::sha256File(path, out); }

std::shared_ptr<const Buffer> StdFileSystem::map(const std::string& path) {
  int64_t n = fileSize(path);
  if (n < 0) return nullptr;
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return nullptr;
  auto b = std::make_shared<AlignedBuffer>(size_t(n));
  size_t got = n ? std::fread(b->mut(), 1, size_t(n), f) : 0;
  std::fclose(f);
  if (got != size_t(n)) return nullptr;
  return b;
}

otacore::Status DefaultPatchBuilder::build(otacore::RandomAccessSource& old, const std::string& patchFile,
                                           const std::string& outFile, const std::string& expectedHash) {
  return otacore::applyPatch(old, patchFile, outFile, expectedHash);
}

}  // namespace otaruntime
