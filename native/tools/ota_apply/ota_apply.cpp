// ota_apply: apply an OTA patch with the SAME otacore::applyPatch the app ships.
//   ota_apply <old|-> <patch> <out> <expected-sha256:HEX>
// old '-' = empty old file (updateType "full" patches are diffs against an empty old).
// Exit code = otacore::Status (0 ok, 1 IoError, 2 PatchCorrupt, 3 HashMismatch, 4 UnsupportedAlgo); 64 = usage.
// Prints one JSON line to stdout. On failure `out` is left untouched and no temp file remains (applyPatch contract).
#include <cstdio>
#include <string>
#include <sys/stat.h>

#include "otacore/otacore.h"

static std::string jsonEscape(const std::string& s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += char(c);
  }
  return o;
}

int main(int argc, char** argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: ota_apply <old|-> <patch> <out> <expected-sha256:HEX>\n");
    printf("{\"ok\":false,\"status\":\"Usage\",\"code\":64}\n");
    return 64;
  }
  const std::string oldPath = argv[1], patch = argv[2], out = argv[3], expected = argv[4];
  otacore::Status st;
  if (oldPath == "-") {
    otacore::MemorySource empty(nullptr, 0);
    st = otacore::applyPatch(empty, patch, out, expected);
  } else {
    otacore::FileSource src(oldPath);
    if (!src.ok()) {
      printf("{\"ok\":false,\"status\":\"IoError\",\"code\":%d,\"error\":\"cannot open old file\"}\n", int(otacore::Status::IoError));
      return int(otacore::Status::IoError);
    }
    st = otacore::applyPatch(src, patch, out, expected);
  }
  long long size = -1;
  struct stat sb;
  if (st == otacore::Status::Ok && stat(out.c_str(), &sb) == 0) size = (long long)sb.st_size;
  printf("{\"ok\":%s,\"status\":\"%s\",\"code\":%d,\"out\":\"%s\",\"size\":%lld,\"expected\":\"%s\"}\n",
         st == otacore::Status::Ok ? "true" : "false", otacore::statusName(st), int(st),
         jsonEscape(out).c_str(), size, jsonEscape(expected).c_str());
  return int(st);
}
