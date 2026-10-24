// Default implementations of FileSystem and PatchBuilder over std::filesystem / stdio / otacore.
// Portable (no platform headers); a platform may replace StdFileSystem with an mmap-based one.
#pragma once
#include "otaruntime/interfaces.h"

namespace otaruntime {

class StdFileSystem : public FileSystem {
 public:
  int64_t fileSize(const std::string& path) override;
  bool remove(const std::string& path) override;
  std::string canonical(const std::string& path) override;
  bool sha256File(const std::string& path, std::string& outHash) override;
  std::shared_ptr<const Buffer> map(const std::string& path) override;  // reads into a 16-byte aligned buffer
};

class DefaultPatchBuilder : public PatchBuilder {
 public:
  otacore::Status build(otacore::RandomAccessSource& old, const std::string& patchFile,
                        const std::string& outFile, const std::string& expectedHash) override;
};

// Owns an aligned copy of bytes (used by StdFileSystem::map and handy for tests/embedded assets).
std::shared_ptr<const Buffer> makeAlignedBuffer(const void* data, size_t n);

}  // namespace otaruntime
