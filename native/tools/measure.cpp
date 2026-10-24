// measure_patch: patch size vs full-file baselines, apply time and peak RSS.
//   measure_patch <old> <new> [label]
// Peak RSS is measured in a fresh child process (this binary re-invoked with --apply-child) because
// ru_maxrss is a process-lifetime high-water mark; we report (peak - RSS before apply) so the
// binary/runtime baseline is excluded.
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "otacore/otacore.h"

#ifdef __APPLE__
#include <mach/mach.h>
static size_t currentRssBytes() {
  mach_task_basic_info info;
  mach_msg_type_number_t n = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &n) != KERN_SUCCESS) return 0;
  return info.resident_size;
}
static size_t peakRssBytes() {  // ru_maxrss is bytes on macOS
  rusage ru; getrusage(RUSAGE_SELF, &ru); return size_t(ru.ru_maxrss);
}
#else
static size_t currentRssBytes() { return 0; }
static size_t peakRssBytes() { rusage ru; getrusage(RUSAGE_SELF, &ru); return size_t(ru.ru_maxrss) * 1024; }  // KiB on Linux
#endif

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

static uint64_t fileSize(const std::string& p) { std::error_code ec; return fs::file_size(p, ec); }

static uint64_t pipeCount(const std::string& cmd) {  // size of the stdout of `cmd`
  FILE* f = popen(cmd.c_str(), "r");
  if (!f) return 0;
  uint64_t n = 0; char buf[65536]; size_t r;
  while ((r = fread(buf, 1, sizeof buf, f)) > 0) n += r;
  pclose(f);
  return n;
}

// Child mode: apply once, print "<ms> <rss_before> <rss_peak> <status>".
static int childMain(char** a) {
  size_t before = currentRssBytes();
  auto t0 = Clock::now();
  otacore::Status s = otacore::applyPatch(a[0], a[1], a[2], a[3]);
  double ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
  std::printf("%.3f %zu %zu %d\n", ms, before, peakRssBytes(), int(s));
  return s == otacore::Status::Ok ? 0 : 1;
}

static bool runChild(const char* self, const std::string& o, const std::string& p, const std::string& out,
                     const std::string& hash, double& ms, double& rssDeltaMB, int& status) {
  std::string cmd = std::string("\"") + self + "\" --apply-child \"" + o + "\" \"" + p + "\" \"" + out + "\" " + hash;
  FILE* f = popen(cmd.c_str(), "r");
  if (!f) return false;
  size_t before = 0, peak = 0;
  int n = fscanf(f, "%lf %zu %zu %d", &ms, &before, &peak, &status);
  pclose(f);
  if (n != 4) return false;
  rssDeltaMB = peak > before ? double(peak - before) / (1024.0 * 1024.0) : 0.0;
  return true;
}

int main(int argc, char** argv) {
  if (argc >= 2 && !std::strcmp(argv[1], "--apply-child") && argc == 6) return childMain(argv + 2);
  if (argc < 3) { std::fprintf(stderr, "usage: measure_patch <old> <new> [label]\n"); return 2; }
  const std::string oldF = argv[1], newF = argv[2];
  const std::string label = argc > 3 ? argv[3] : newF;
  fs::path tmp = fs::temp_directory_path() / ("measure-" + std::to_string(getpid()));
  fs::create_directories(tmp);

  std::string newHash;
  if (!otacore::sha256File(newF, newHash)) { std::fprintf(stderr, "cannot read %s\n", newF.c_str()); return 1; }
  uint64_t oldSz = fileSize(oldF), newSz = fileSize(newF);
  uint64_t zst = pipeCount("zstd -19 -q -c \"" + newF + "\""), gz = pipeCount("gzip -9 -c \"" + newF + "\"");
  uint64_t zstPrev = pipeCount("zstd -19 -q -c \"" + oldF + "\"");
  (void)zstPrev;

  std::printf("### %s\n", label.c_str());
  std::printf("old %llu B, new %llu B | full new: raw %llu, zstd-19 %llu (%.1f%%), gzip-9 %llu (%.1f%%)\n\n",
              (unsigned long long)oldSz, (unsigned long long)newSz, (unsigned long long)newSz,
              (unsigned long long)zst, 100.0 * double(zst) / double(newSz), (unsigned long long)gz, 100.0 * double(gz) / double(newSz));
  std::printf("| diff compression | patch bytes | %% of raw new | %% of zstd(full new) | diff time | apply ms (median/3) | apply peak RSS delta MB | ok |\n");
  std::printf("|---|---:|---:|---:|---:|---:|---:|---|\n");
  for (const char* comp : {"none", "zstd", "lzma"}) {
    std::string patch = (tmp / (std::string(comp) + ".patch")).string();
    auto d0 = Clock::now();
    std::string cmd = std::string("\"") + HDIFFZ_TOOL_PATH + "\" -c " + comp + " \"" + oldF + "\" \"" + newF + "\" \"" + patch + "\" > /dev/null";
    if (std::system(cmd.c_str()) != 0) { std::printf("| %s | diff failed |||||||\n", comp); continue; }
    double diffS = std::chrono::duration<double>(Clock::now() - d0).count();
    uint64_t psz = fileSize(patch);
    std::vector<double> ms, rss;
    bool ok = true;
    for (int i = 0; i < 3; i++) {
      double m, r; int st;
      std::string out = (tmp / "out.bin").string();
      if (!runChild(argv[0], oldF, patch, out, newHash, m, r, st) || st != 0) { ok = false; break; }
      ms.push_back(m); rss.push_back(r);
    }
    auto med = [](std::vector<double> v) { std::sort(v.begin(), v.end()); return v.empty() ? 0.0 : v[v.size() / 2]; };
    std::printf("| %s | %llu | %.2f%% | %.1f%% | %.1fs | %.1f | %.1f | %s |\n", comp, (unsigned long long)psz,
                100.0 * double(psz) / double(newSz), 100.0 * double(psz) / double(zst), diffS, med(ms), med(rss), ok ? "yes" : "FAIL");
  }
  std::printf("\n");
  std::error_code ec;
  fs::remove_all(tmp, ec);
  return 0;
}
