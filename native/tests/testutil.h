// Tiny test helpers: no framework. A failed CHECK prints and records; main returns non-zero.
#pragma once
#include <sys/stat.h>
#include <unistd.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"
#include "otacore/otacore.h"

namespace t {
inline int& failures() { static int f = 0; return f; }
inline int& checks() { static int c = 0; return c; }
}  // namespace t

#define CHECK(cond)                                                                    \
  do {                                                                                 \
    t::checks()++;                                                                     \
    if (!(cond)) { t::failures()++; std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)
#define CHECK_EQ(a, b)                                                                 \
  do {                                                                                 \
    t::checks()++;                                                                     \
    auto _a = (a); auto _b = (b);                                                      \
    if (!(_a == _b)) { t::failures()++; std::fprintf(stderr, "%s:%d: CHECK_EQ failed: %s == %s\n", __FILE__, __LINE__, #a, #b); } \
  } while (0)
#define TEST_MAIN_END()                                                                \
  std::printf("%d checks, %d failures\n", t::checks(), t::failures());                 \
  return t::failures() ? 1 : 0

namespace fs = std::filesystem;
using Bytes = std::vector<uint8_t>;

inline Bytes readFile(const std::string& p) {
  std::ifstream f(p, std::ios::binary);
  return Bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}
inline bool writeFile(const std::string& p, const Bytes& b) {
  std::ofstream f(p, std::ios::binary);
  f.write(reinterpret_cast<const char*>(b.data()), std::streamsize(b.size()));
  return bool(f);
}
inline std::string readText(const std::string& p) {
  Bytes b = readFile(p);
  return std::string(b.begin(), b.end());
}

// Unique temp dir removed on destruction.
struct TempDir {
  fs::path path;
  explicit TempDir(const char* tag) {
    static int n = 0;
    path = fs::temp_directory_path() / (std::string("otacore-test-") + tag + "-" + std::to_string(::getpid()) + "-" + std::to_string(n++));
    fs::remove_all(path);
    fs::create_directories(path);
  }
  ~TempDir() { std::error_code ec; fs::remove_all(path, ec); }
  std::string operator/(const std::string& n) const { return (path / n).string(); }
};

// Deterministic PRNG (xorshift64*), so failures reproduce.
struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed ? seed : 88172645463325252ull) {}
  uint64_t next() { s ^= s >> 12; s ^= s << 25; s ^= s >> 27; return s * 2685821657736338717ull; }
  uint32_t below(uint32_t n) { return uint32_t(next() % n); }
};

inline Bytes randomBytes(Rng& r, size_t n) {
  Bytes b(n);
  for (auto& x : b) x = uint8_t(r.next() >> 24);
  return b;
}

// Mimics a bytecode update: scattered byte edits plus insertions/deletions that shift everything after them.
inline Bytes mutateBinary(Rng& r, const Bytes& old, double editFrac, int inserts, int deletes) {
  Bytes b = old;
  size_t edits = size_t(double(b.size()) * editFrac);
  for (size_t i = 0; i < edits; i++) b[r.below(uint32_t(b.size()))] = uint8_t(r.next() >> 24);
  for (int i = 0; i < inserts; i++) {
    size_t pos = r.below(uint32_t(b.size()));
    Bytes ins = randomBytes(r, 1 + r.below(24));
    b.insert(b.begin() + long(pos), ins.begin(), ins.end());
  }
  for (int i = 0; i < deletes; i++) {
    size_t pos = r.below(uint32_t(b.size() - 64));
    b.erase(b.begin() + long(pos), b.begin() + long(pos + 1 + r.below(24)));
  }
  return b;
}

// JS-like text: lots of `__d(function(...){...},id,[deps]);` modules with identifier-ish content.
inline Bytes jsLikeBundle(Rng& r, int modules, uint64_t variantSeed = 0, int changedModules = 0) {
  static const char* words[] = {"user", "cab", "bus", "fare", "route", "state", "render", "fetch", "price",
                                "slot", "seat", "trip", "map", "list", "item", "config", "offer", "pay"};
  std::string s;
  Rng v(variantSeed + 1);
  for (int m = 0; m < modules; m++) {
    bool changed = m < changedModules;
    std::ostringstream o;
    o << "__d(function(g,r,i,a,m,e,d){\"use strict\";var _" << words[r.below(18)] << "=r(d[0]);";
    int fns = 3 + int(r.below(6));
    for (int f = 0; f < fns; f++) {
      const char* w1 = words[r.below(18)];
      const char* w2 = words[r.below(18)];
      o << "function " << w1 << "_" << f << "(" << w2 << "){if(!" << w2 << ")return null;var t=" << w2 << "."
        << words[r.below(18)] << "*" << r.below(1000);
      if (changed && f == 1) o << "+" << v.below(100000);  // the actual edit
      o << ";return {" << w1 << ":t,id:" << m << "};}";
    }
    o << "e.default=" << words[r.below(18)] << "_0;},";
    o << (1000 + m) << ",[" << (m % 7) << "]);\n";
    s += o.str();
  }
  return Bytes(s.begin(), s.end());
}

// Runs hdiffz_tool; returns the patch bytes (empty on failure).
inline bool makePatch(const std::string& oldF, const std::string& newF, const std::string& patchF,
                      const std::string& comp) {
  std::string cmd = std::string("\"") + HDIFFZ_TOOL_PATH + "\" -c " + comp + " \"" + oldF + "\" \"" + newF +
                    "\" \"" + patchF + "\" > /dev/null";
  return std::system(cmd.c_str()) == 0;
}

inline std::string hashOf(const Bytes& b) { return otacore::sha256Hash(b.data(), b.size()); }
