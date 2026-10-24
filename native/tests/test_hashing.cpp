// sha256 (NIST vectors), bucket (shared vectors), streaming vs one-shot.
#include "testutil.h"

int main() {
  using namespace otacore;
  // FIPS 180-4 / NIST examples
  CHECK_EQ(sha256Hash("", 0), std::string("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
  CHECK_EQ(sha256Hash("abc", 3), std::string("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  const char* m2 = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  CHECK_EQ(sha256Hash(m2, 56), std::string("sha256:248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
  const char* m3 = "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
  CHECK_EQ(sha256Hash(m3, 112), std::string("sha256:cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"));
  // one million 'a', fed in odd-sized chunks (exercises buffering across block boundaries)
  {
    Sha256 h; uint8_t d[32];
    std::string chunk(997, 'a');
    size_t left = 1000000;
    while (left) { size_t n = left < chunk.size() ? left : chunk.size(); h.update(chunk.data(), n); left -= n; }
    h.finish(d);
    char hex[65];
    for (int i = 0; i < 32; i++) std::snprintf(hex + i * 2, 3, "%02x", d[i]);
    CHECK_EQ(std::string(hex), std::string("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
  }
  // padding boundaries: lengths 55,56,63,64,65 streamed byte-by-byte == one-shot
  for (size_t n : {55u, 56u, 63u, 64u, 65u, 119u, 120u}) {
    std::string s(n, 'x');
    Sha256 h; uint8_t d[32];
    for (char c : s) h.update(&c, 1);
    h.finish(d);
    std::string a = "sha256:";
    for (int i = 0; i < 32; i++) { char b[3]; std::snprintf(b, 3, "%02x", d[i]); a += b; }
    CHECK_EQ(a, sha256Hash(s.data(), s.size()));
  }
  // file helper
  {
    TempDir td("hash");
    writeFile(td / "f", Bytes{'a', 'b', 'c'});
    std::string h;
    CHECK(sha256File(td / "f", h));
    CHECK_EQ(h, std::string("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    CHECK(!sha256File(td / "missing", h));
  }
  CHECK(isHash("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  CHECK(!isHash("sha256:BA7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  CHECK(!isHash("sha256:abc"));
  CHECK(!isHash("md5:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));

  // bucket vectors shared with the TypeScript implementation: exact double equality
  {
    std::string txt = readText(VECTORS_DIR "/bucket.json");
    nlohmann::json j = nlohmann::json::parse(txt);
    CHECK(j.size() > 10);
    for (auto& v : j) {
      double got = bucket(v["deviceId"].get<std::string>(), v["unit"].get<std::string>());
      double want = v["bucket"].get<double>();
      CHECK(got == want);  // bit-for-bit
      CHECK(got >= 0.0 && got < 1.0);
    }
    std::printf("bucket vectors: %zu\n", j.size());
  }
  // UTF-8 passes through as bytes
  CHECK(bucket("d\xc3\xa9vice", "cabs") == bucket(std::string("d\xc3\xa9vice"), "cabs"));
  TEST_MAIN_END();
}
