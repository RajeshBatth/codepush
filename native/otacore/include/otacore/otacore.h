// otacore: platform-neutral C++17 core of the OTA SDK (DESIGN.md 5.1-5.6, 6).
//
// Rules for this API:
//  * No exceptions cross it: every fallible call returns a Status / bool / result struct.
//  * No platform APIs: file access is std::filesystem + stdio; embedded assets are reached
//    through the RandomAccessSource interface that platform wrappers implement.
//  * Thread-safety: all free functions are reentrant; a Manifest is immutable after parsing.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace otacore {

// ---------------------------------------------------------------- sha256

// Streaming SHA-256.
class Sha256 {
 public:
  Sha256();
  void update(const void* data, size_t len);
  // Finishes the hash. The object must not be updated afterwards (call reset()).
  void finish(uint8_t out[32]);
  void reset();

 private:
  void block(const uint8_t* p);
  uint32_t h_[8];
  uint8_t buf_[64];
  uint64_t total_;
  size_t fill_;
};

// "sha256:<64 lowercase hex>"
std::string sha256Hash(const void* data, size_t len);
// Hashes a file in chunks. Returns false on I/O error.
bool sha256File(const std::string& path, std::string& outHash);
// True iff s matches ^sha256:[0-9a-f]{64}$
bool isHash(std::string_view s);

// ---------------------------------------------------------------- bucket

// sha256(UTF-8(deviceId) || 0x0A || UTF-8(unit)); first 4 bytes big-endian / 2^32. In [0,1).
// Inputs are taken as UTF-8 bytes as-is (platform wrappers must pass UTF-8, not UTF-16).
double bucket(std::string_view deviceId, std::string_view unit);

// ---------------------------------------------------------------- manifest

struct Entry {
  std::string id;
  std::string patchUrl;
  std::string hash;  // sha256 of the BUILT result
  int64_t size = 0;
  std::string updateType;  // "patch" | "full"
  bool hasRange = false;   // absent range == [0,1)
  double rangeStart = 0.0, rangeEnd = 1.0;
  bool hasRequiresHost = false;  // JSON null or absent => false
  std::string requiresHost;
};

struct UnitManifest {
  std::string unitName;
  std::string baseHash;
  std::vector<Entry> entries;
};

struct MainBundle {
  std::string baseHash;
  std::vector<Entry> entries;
};

struct Manifest {
  int schema = 0;
  std::string platform;
  std::string appVersion;
  std::string patchAlgoVer;
  int64_t version = 0;
  int64_t ttlSec = 0;
  MainBundle mainBundle;
  std::vector<UnitManifest> units;
};

struct ParseResult {
  bool ok = false;
  // Same rules and (mostly) the same wording as validateManifest() in packages/ota-core/src/manifest.ts.
  std::vector<std::string> errors;
  Manifest manifest;  // only meaningful when ok
};

// Parses and validates (schema, hash format, ranges within [0,1], disjoint ranges, duplicate ids,
// requiresHost references). Never throws. The caller should keep its previous manifest when !ok.
// NOTE: signature verification is NOT done here; platform code verifies the detached Ed25519
// signature over the exact bytes first, then calls this.
ParseResult parseManifest(std::string_view json);

// ---------------------------------------------------------------- select (DESIGN 5.2 step 2)

struct SelectContext {
  double bucket = 0.0;
  std::string embeddedHash;                // hash of the unit/host embedded in THIS binary
  std::vector<std::string> supportedAlgos; // e.g. {"v1"}
  std::string runningHostId = "embedded";  // host entry id the running VM booted with
};

enum class Source { Embedded, Patch };

struct Selection {
  Source source = Source::Embedded;
  const Entry* entry = nullptr;  // points into the Manifest passed to select*; valid while it lives
  // One of: ok, unit-not-in-manifest, base-mismatch, algo-unsupported, no-range-match,
  // requires-host-mismatch
  const char* reason = "";
};

Selection selectUnit(const Manifest& m, std::string_view unitName, const SelectContext& ctx);
Selection selectHost(const Manifest& m, const SelectContext& ctx);

// ---------------------------------------------------------------- patch application

enum class Status {
  Ok = 0,
  IoError,          // cannot read/write/rename, out of memory
  PatchCorrupt,     // patch is malformed, truncated, or inconsistent with the old data
  HashMismatch,     // patch applied but sha256(output) != expected
  UnsupportedAlgo,  // patch uses a compression/format this build does not include
};
const char* statusName(Status s);

// Random-access read-only byte source. Platform wrappers implement this over Android assets
// (AAsset_seek/read) or iOS bundle files; the core never needs the whole old file in memory.
class RandomAccessSource {
 public:
  virtual ~RandomAccessSource() = default;
  virtual uint64_t size() const = 0;
  // Reads exactly len bytes at offset; returns false on any failure or if out of range.
  virtual bool read(uint64_t offset, void* buf, size_t len) = 0;
};

class MemorySource : public RandomAccessSource {
 public:
  MemorySource(const void* data, size_t len) : p_(static_cast<const uint8_t*>(data)), n_(len) {}
  uint64_t size() const override { return n_; }
  bool read(uint64_t offset, void* buf, size_t len) override;

 private:
  const uint8_t* p_;
  size_t n_;
};

class FileSource : public RandomAccessSource {
 public:
  explicit FileSource(const std::string& path);
  ~FileSource() override;
  FileSource(const FileSource&) = delete;
  FileSource& operator=(const FileSource&) = delete;
  bool ok() const { return f_ != nullptr; }
  uint64_t size() const override { return size_; }
  bool read(uint64_t offset, void* buf, size_t len) override;

 private:
  void* f_ = nullptr;  // FILE*
  uint64_t size_ = 0;
};

// Applies patchFile to old, writes outFile + ".tmp", verifies sha256 == expectedBuiltHash,
// then renames atomically onto outFile. On any failure the temp file is removed and outFile
// is left untouched (never partial). expectedBuiltHash is "sha256:<hex>".
Status applyPatch(RandomAccessSource& old, const std::string& patchFile, const std::string& outFile,
                  const std::string& expectedBuiltHash);
// Convenience: old is a plain file.
Status applyPatch(const std::string& oldFile, const std::string& patchFile, const std::string& outFile,
                  const std::string& expectedBuiltHash);
// In-memory variant (tests, tiny units). out is cleared on failure.
Status applyPatchMemory(const uint8_t* old, size_t oldLen, const uint8_t* patch, size_t patchLen,
                        std::vector<uint8_t>& out, const std::string& expectedBuiltHash);

// Names of compression plugins compiled into this build, e.g. {"none","zstd","lzma"}.
std::vector<std::string> compiledPatchCompressors();

// ---------------------------------------------------------------- on-disk cache (DESIGN 5.1)

// Layout: <baseDir>/codepush/<versionName>-<buildNumber>/<id>.bundle
class Cache {
 public:
  // Creates the root for this app version and deletes every sibling root under
  // <baseDir>/codepush/ that belongs to another version. ok() is false on I/O failure.
  Cache(const std::string& baseDir, const std::string& versionName, const std::string& buildNumber);
  bool ok() const { return ok_; }
  const std::string& root() const { return root_; }
  // Final path for a built unit with this entry id (id must be a plain file-name token).
  std::string builtPath(const std::string& entryId) const;
  bool has(const std::string& entryId) const;
  // Path for a downloaded patch while it is in flight / waiting to be applied.
  std::string patchPath(const std::string& entryId) const;
  // Deletes every file under root not referenced: keeps <id>.bundle for ids in keepIds.
  // Patch files and temp files are always removed. Returns the number of files removed.
  size_t gc(const std::vector<std::string>& keepIds);

 private:
  bool ok_ = false;
  std::string root_;
};

// Ids of all entries (host + units) in a manifest, for Cache::gc.
std::vector<std::string> allEntryIds(const Manifest& m);

}  // namespace otacore
