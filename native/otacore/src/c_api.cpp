#include <cstdlib>
#include <cstring>

#include "nlohmann/json.hpp"
#include "otacore/otacore.h"
#include "otacore/otacore_c.h"

using namespace otacore;

namespace {
char* dup(const std::string& s) {
  char* p = static_cast<char*>(std::malloc(s.size() + 1));
  if (p) std::memcpy(p, s.c_str(), s.size() + 1);
  return p;
}
int code(Status s) { return static_cast<int>(s); }  // enum values equal the OTACORE_* constants

class CSource : public RandomAccessSource {
 public:
  explicit CSource(const otacore_source* s) : s_(*s) {}
  uint64_t size() const override { return s_.size; }
  bool read(uint64_t off, void* buf, size_t len) override {
    if (off > s_.size || len > s_.size - off) return false;
    return s_.read(s_.ctx, off, buf, len) != 0;
  }
 private:
  otacore_source s_;
};
}  // namespace

extern "C" {

void otacore_free(void* p) { std::free(p); }

char* otacore_sha256(const void* data, size_t len) {
  try { return dup(sha256Hash(data, len)); } catch (...) { return nullptr; }
}
char* otacore_sha256_file(const char* path) {
  try {
    std::string h;
    return (path && sha256File(path, h)) ? dup(h) : nullptr;
  } catch (...) { return nullptr; }
}

double otacore_bucket(const char* d, const char* u) { return bucket(d ? d : "", u ? u : ""); }

int otacore_validate_manifest(const char* json, size_t len, char** errors_out) {
  try {
    ParseResult r = parseManifest(std::string_view(json ? json : "", json ? len : 0));
    if (errors_out) {
      std::string all;
      for (auto& e : r.errors) { all += e; all += '\n'; }
      *errors_out = r.ok ? nullptr : dup(all);
    }
    return r.ok ? 1 : 0;
  } catch (...) { if (errors_out) *errors_out = nullptr; return 0; }
}

char* otacore_select(const char* mj, size_t len, const char* unit, double bucketV, const char* embeddedHash,
                     const char* algos, const char* runningHost) {
  try {
    nlohmann::json out;
    ParseResult r = parseManifest(std::string_view(mj ? mj : "", mj ? len : 0));
    if (!r.ok) {
      out = {{"source", "embedded"}, {"reason", "invalid-manifest"}};
      return dup(out.dump());
    }
    SelectContext ctx;
    ctx.bucket = bucketV;
    ctx.embeddedHash = embeddedHash ? embeddedHash : "";
    ctx.runningHostId = runningHost ? runningHost : "embedded";
    std::string a = algos ? algos : "";
    size_t pos = 0;
    while (pos <= a.size()) {
      size_t c = a.find(',', pos);
      if (c == std::string::npos) c = a.size();
      if (c > pos) ctx.supportedAlgos.push_back(a.substr(pos, c - pos));
      pos = c + 1;
    }
    Selection s = unit ? selectUnit(r.manifest, unit, ctx) : selectHost(r.manifest, ctx);
    out["source"] = s.source == Source::Patch ? "patch" : "embedded";
    out["reason"] = s.reason;
    if (s.entry) {
      out["entry"] = {{"id", s.entry->id}, {"patchUrl", s.entry->patchUrl}, {"hash", s.entry->hash},
                      {"size", s.entry->size}, {"updateType", s.entry->updateType}};
    }
    return dup(out.dump());
  } catch (...) { return nullptr; }
}

int otacore_apply_patch(const char* o, const char* p, const char* out, const char* h) {
  try { return code(applyPatch(o ? o : "", p ? p : "", out ? out : "", h ? h : "")); }
  catch (...) { return OTACORE_IO_ERROR; }
}

int otacore_apply_patch_source(const otacore_source* old, const char* p, const char* out, const char* h) {
  try {
    if (!old || !old->read) return OTACORE_IO_ERROR;
    CSource src(old);
    return code(applyPatch(src, p ? p : "", out ? out : "", h ? h : ""));
  } catch (...) { return OTACORE_IO_ERROR; }
}

}  // extern "C"
