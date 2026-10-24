// Patch application on top of HDiffPatch's "single compressed diff" format
// (create_single_compressed_diff on the producer side, patch_single_stream here).
//
// Why that format: the diff is read strictly sequentially, so it can later be applied while
// downloading; memory is bounded by stepMemSize (producer-chosen, default 256 KiB) plus a small
// I/O cache, independent of the unit size; the old file is only randomly READ, so it can be an
// uncompressed Android asset / iOS bundle resource accessed through RandomAccessSource.
#include <cstdio>
#include <cstring>
#include <filesystem>

#include "otacore/otacore.h"

// ---- HDiffPatch (C) ----
extern "C" {
#include "libHDiffPatch/HPatch/patch.h"
}
#ifdef OTACORE_WITH_ZSTD
#define _CompressPlugin_zstd
#endif
#ifdef OTACORE_WITH_LZMA
#define _CompressPlugin_lzma
#endif
#define _IsNeedIncludeDefaultCompressHead 1
#if defined(__clang__)
#pragma clang diagnostic ignored "-Wunused-function"
#pragma clang diagnostic ignored "-Wunused-variable"
#endif
#include "decompress_plugin_demo.h"  // static plugin tables; only the enabled ones are compiled

#if defined(__unix__) || defined(__APPLE__)
#include <unistd.h>
#define OTACORE_HAVE_FSYNC 1
#endif

namespace fs = std::filesystem;

namespace otacore {

const char* statusName(Status s) {
  switch (s) {
    case Status::Ok: return "Ok";
    case Status::IoError: return "IoError";
    case Status::PatchCorrupt: return "PatchCorrupt";
    case Status::HashMismatch: return "HashMismatch";
    case Status::UnsupportedAlgo: return "UnsupportedAlgo";
  }
  return "?";
}

std::vector<std::string> compiledPatchCompressors() {
  std::vector<std::string> v{"none"};
#ifdef OTACORE_WITH_ZSTD
  v.push_back("zstd");
#endif
#ifdef OTACORE_WITH_LZMA
  v.push_back("lzma");
#endif
  return v;
}

// ------------------------------------------------------------------ sources

bool MemorySource::read(uint64_t offset, void* buf, size_t len) {
  if (offset > n_ || len > n_ - offset) return false;
  if (len) std::memcpy(buf, p_ + offset, len);
  return true;
}

FileSource::FileSource(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return;
  if (fseeko(f, 0, SEEK_END) != 0) { std::fclose(f); return; }
  off_t sz = ftello(f);
  if (sz < 0) { std::fclose(f); return; }
  size_ = uint64_t(sz);
  f_ = f;
}
FileSource::~FileSource() { if (f_) std::fclose(static_cast<FILE*>(f_)); }
bool FileSource::read(uint64_t offset, void* buf, size_t len) {
  if (!f_ || offset > size_ || len > size_ - offset) return false;
  if (len == 0) return true;
  FILE* f = static_cast<FILE*>(f_);
  if (fseeko(f, off_t(offset), SEEK_SET) != 0) return false;
  return std::fread(buf, 1, len, f) == len;
}

// ------------------------------------------------------------------ sinks

namespace {

class Sink {
 public:
  virtual ~Sink() = default;
  virtual bool write(const uint8_t* p, size_t n) = 0;
};

class FileSink : public Sink {
 public:
  explicit FileSink(const std::string& path) { f_ = std::fopen(path.c_str(), "wb"); }
  ~FileSink() override { close(); }
  bool ok() const { return f_ != nullptr; }
  bool write(const uint8_t* p, size_t n) override { return f_ && std::fwrite(p, 1, n, f_) == n; }
  // flush + fsync + close; returns false if the data may not be durable.
  bool finish() {
    if (!f_) return false;
    bool good = std::fflush(f_) == 0;
#ifdef OTACORE_HAVE_FSYNC
    good = good && ::fsync(fileno(f_)) == 0;
#endif
    good = (std::fclose(f_) == 0) && good;
    f_ = nullptr;
    return good;
  }
  void close() { if (f_) { std::fclose(f_); f_ = nullptr; } }

 private:
  FILE* f_ = nullptr;
};

class VectorSink : public Sink {
 public:
  explicit VectorSink(std::vector<uint8_t>& v) : v_(v) {}
  bool write(const uint8_t* p, size_t n) override { v_.insert(v_.end(), p, p + n); return true; }
 private:
  std::vector<uint8_t>& v_;
};

// ------------------------------------------------------------------ the core

// Everything the HDiffPatch callbacks need; lives on the stack of runPatch().
struct Session {
  RandomAccessSource* old;
  RandomAccessSource* patch;
  Sink* sink;
  Sha256 hasher;
  uint64_t written = 0;
  bool ioError = false;       // a read/write failed for a reason other than "out of range"
  bool unsupported = false;   // compressType not compiled in
  bool sizeMismatch = false;  // header's oldDataSize != actual old size
  bool badHeader = false;
  hpatch_TDecompress plugin;  // private copy: plugins carry per-session error state
  std::vector<unsigned char> cache;
  uint64_t newSize = 0;
};

hpatch_BOOL readFrom(RandomAccessSource* src, Session* s, hpatch_StreamPos_t pos, unsigned char* out,
                     unsigned char* outEnd) {
  size_t len = size_t(outEnd - out);
  if (src->read(pos, out, len)) return hpatch_TRUE;
  // Distinguish a malformed/truncated input (read past the end) from a real I/O failure.
  if (pos > src->size() || len > src->size() - pos) return hpatch_FALSE;
  s->ioError = true;
  return hpatch_FALSE;
}
hpatch_BOOL readOld(const hpatch_TStreamInput* st, hpatch_StreamPos_t pos, unsigned char* o, unsigned char* e) {
  Session* s = static_cast<Session*>(st->streamImport);
  return readFrom(s->old, s, pos, o, e);
}
hpatch_BOOL readPatch(const hpatch_TStreamInput* st, hpatch_StreamPos_t pos, unsigned char* o, unsigned char* e) {
  Session* s = static_cast<Session*>(st->streamImport);
  return readFrom(s->patch, s, pos, o, e);
}
hpatch_BOOL writeNew(const hpatch_TStreamOutput* st, hpatch_StreamPos_t pos, const unsigned char* d,
                     const unsigned char* e) {
  Session* s = static_cast<Session*>(st->streamImport);
  if (pos != s->written) return hpatch_FALSE;  // output must be strictly sequential (we hash on the fly)
  size_t n = size_t(e - d);
  if (s->written + n > s->newSize) return hpatch_FALSE;  // patch tries to emit more than it declared
  if (!s->sink->write(d, n)) { s->ioError = true; return hpatch_FALSE; }
  s->hasher.update(d, n);
  s->written += n;
  return hpatch_TRUE;
}

// Called by HDiffPatch once the diff header is parsed: choose the decompressor, size the cache.
hpatch_BOOL onDiffInfo(sspatch_listener_t* l, const hpatch_singleCompressedDiffInfo* info,
                       hpatch_TDecompress** outPlugin, unsigned char** outCache, unsigned char** outCacheEnd) {
  Session* s = static_cast<Session*>(l->import);
  // Header values come from an untrusted file: validate before using them for allocation.
  if (info->oldDataSize != s->old->size()) { s->sizeMismatch = true; return hpatch_FALSE; }
  const hpatch_StreamPos_t kMaxStepMem = 64ull << 20;
  if (info->stepMemSize > kMaxStepMem) { s->badHeader = true; return hpatch_FALSE; }
  s->newSize = info->newDataSize;

  const char* ct = info->compressType;
  s->plugin = hpatch_TDecompress();
  std::memset(&s->plugin, 0, sizeof s->plugin);
  hpatch_TDecompress* chosen = nullptr;
  if (ct[0] == '\0') {
    chosen = nullptr;  // uncompressed diff
  }
#ifdef OTACORE_WITH_ZSTD
  else if (zstdDecompressPlugin.is_can_open(ct)) { s->plugin = zstdDecompressPlugin; chosen = &s->plugin; }
#endif
#ifdef OTACORE_WITH_LZMA
  else if (lzmaDecompressPlugin.is_can_open(ct)) { s->plugin = lzmaDecompressPlugin; chosen = &s->plugin; }
#endif
  else { s->unsupported = true; return hpatch_FALSE; }
  if (chosen) chosen->decError = hpatch_dec_ok;
  *outPlugin = chosen;

  const size_t ioCache = 256 * 1024;  // I/O cache; must be >= hpatch_kStreamCacheSize*3
  s->cache.assign(size_t(info->stepMemSize) + ioCache, 0);  // may throw bad_alloc -> caught by runPatch
  *outCache = s->cache.data();
  *outCacheEnd = s->cache.data() + s->cache.size();
  return hpatch_TRUE;
}

// Runs the patch; returns Ok when the stream finished consistently (hash is checked by the caller).
Status runPatch(RandomAccessSource& old, RandomAccessSource& patch, Sink& sink, std::string& outHash) {
  try {
    Session s;
    s.old = &old; s.patch = &patch; s.sink = &sink;
    std::memset(&s.plugin, 0, sizeof s.plugin);

    hpatch_TStreamInput oldIn;
    std::memset(&oldIn, 0, sizeof oldIn);
    oldIn.streamImport = &s; oldIn.streamSize = old.size(); oldIn.read = readOld;
    hpatch_TStreamInput patchIn;
    std::memset(&patchIn, 0, sizeof patchIn);
    patchIn.streamImport = &s; patchIn.streamSize = patch.size(); patchIn.read = readPatch;

    // newDataSize is unknown until the header is parsed; the output stream reads s.newSize lazily.
    // HDiffPatch needs streamSize up front, so parse the header first.
    hpatch_singleCompressedDiffInfo info;
    if (!getSingleCompressedDiffInfo(&info, &patchIn, 0)) return s.ioError ? Status::IoError : Status::PatchCorrupt;
    // Not our format / compression? Report that distinctly from corruption.
    sspatch_listener_t listener;
    std::memset(&listener, 0, sizeof listener);
    listener.import = &s;
    listener.onDiffInfo = onDiffInfo;

    hpatch_TStreamOutput outSt;
    std::memset(&outSt, 0, sizeof outSt);
    outSt.streamImport = &s; outSt.streamSize = info.newDataSize; outSt.write = writeNew;

    hpatch_BOOL ok = patch_single_stream(&listener, &outSt, &oldIn, &patchIn, 0, nullptr, 1);
    if (s.unsupported) return Status::UnsupportedAlgo;
    if (s.ioError) return Status::IoError;
    if (!ok || s.sizeMismatch || s.badHeader) return Status::PatchCorrupt;
    if (s.plugin.decError != hpatch_dec_ok) return Status::PatchCorrupt;
    if (s.written != info.newDataSize) return Status::PatchCorrupt;
    uint8_t d[32];
    s.hasher.finish(d);
    static const char* hex = "0123456789abcdef";
    outHash = "sha256:";
    for (int i = 0; i < 32; i++) { outHash += hex[d[i] >> 4]; outHash += hex[d[i] & 15]; }
    return Status::Ok;
  } catch (...) {  // bad_alloc etc.: never propagate across the API
    return Status::IoError;
  }
}
}  // namespace

// ------------------------------------------------------------------ public API

Status applyPatch(RandomAccessSource& old, const std::string& patchFile, const std::string& outFile,
                  const std::string& expectedBuiltHash) {
  FileSource patch(patchFile);
  if (!patch.ok()) return Status::IoError;
  const std::string tmp = outFile + ".tmp";
  std::error_code ec;
  fs::remove(tmp, ec);  // leftover from a crashed attempt
  FileSink sink(tmp);
  if (!sink.ok()) return Status::IoError;

  std::string got;
  Status st = runPatch(old, patch, sink, got);
  if (st == Status::Ok) {
    if (!sink.finish()) st = Status::IoError;
    else if (got != expectedBuiltHash) st = Status::HashMismatch;
  }
  sink.close();
  if (st != Status::Ok) { fs::remove(tmp, ec); return st; }
  // rename() atomically replaces an existing outFile on POSIX.
  fs::rename(tmp, outFile, ec);
  if (ec) { fs::remove(tmp, ec); return Status::IoError; }
  return Status::Ok;
}

Status applyPatch(const std::string& oldFile, const std::string& patchFile, const std::string& outFile,
                  const std::string& expectedBuiltHash) {
  FileSource old(oldFile);
  if (!old.ok()) return Status::IoError;
  return applyPatch(old, patchFile, outFile, expectedBuiltHash);
}

Status applyPatchMemory(const uint8_t* old, size_t oldLen, const uint8_t* patch, size_t patchLen,
                        std::vector<uint8_t>& out, const std::string& expectedBuiltHash) {
  MemorySource o(old, oldLen), p(patch, patchLen);
  out.clear();
  VectorSink sink(out);
  std::string got;
  Status st = runPatch(o, p, sink, got);
  if (st == Status::Ok && got != expectedBuiltHash) st = Status::HashMismatch;
  if (st != Status::Ok) out.clear();
  return st;
}

}  // namespace otacore
