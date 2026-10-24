// Minimal on-disk cache (DESIGN 5.1). Layout: <base>/codepush/<versionName>-<buildNumber>/<id>.bundle
#include <filesystem>

#include "otacore/otacore.h"

namespace fs = std::filesystem;

namespace otacore {
namespace {
// Entry ids come from a signed manifest, but never let one escape the cache root.
bool safeToken(const std::string& s) {
  if (s.empty() || s == "." || s == "..") return false;
  for (char c : s) if (c == '/' || c == '\\' || c == '\0') return false;
  return true;
}
const char kBundleExt[] = ".bundle";
}  // namespace

Cache::Cache(const std::string& baseDir, const std::string& versionName, const std::string& buildNumber) {
  if (!safeToken(versionName) || !safeToken(buildNumber)) return;
  std::error_code ec;
  fs::path top = fs::path(baseDir) / "codepush";
  fs::create_directories(top, ec);
  if (ec) return;
  const std::string mine = versionName + "-" + buildNumber;
  // On every start: delete sibling roots that belong to other app versions.
  for (fs::directory_iterator it(top, ec), end; !ec && it != end; it.increment(ec)) {
    if (it->path().filename().string() != mine) fs::remove_all(it->path(), ec);
  }
  ec.clear();
  fs::create_directories(top / mine, ec);
  if (ec) return;
  root_ = (top / mine).string();
  ok_ = true;
}

std::string Cache::builtPath(const std::string& id) const {
  return safeToken(id) ? (fs::path(root_) / (id + kBundleExt)).string() : std::string();
}
std::string Cache::patchPath(const std::string& id) const {
  return safeToken(id) ? (fs::path(root_) / (id + ".patch")).string() : std::string();
}
bool Cache::has(const std::string& id) const {
  std::string p = builtPath(id);
  std::error_code ec;
  return !p.empty() && fs::is_regular_file(p, ec);
}

size_t Cache::gc(const std::vector<std::string>& keepIds) {
  if (!ok_) return 0;
  std::vector<std::string> keep;
  for (auto& id : keepIds) if (safeToken(id)) keep.push_back(id + kBundleExt);
  size_t removed = 0;
  std::error_code ec;
  for (fs::directory_iterator it(root_, ec), end; !ec && it != end; it.increment(ec)) {
    std::string name = it->path().filename().string();
    bool kept = false;
    for (auto& k : keep) if (k == name) { kept = true; break; }
    if (kept) continue;
    std::error_code rec;
    fs::remove_all(it->path(), rec);
    if (!rec) removed++;
  }
  return removed;
}

}  // namespace otacore
