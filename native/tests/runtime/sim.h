// Deterministic simulation harness for the OTA runtime: virtual clock, serial queue, fake network,
// fake VM, in-memory store, real temp-dir files (so the real applyPatch/Cache/sha256 are exercised).
#pragma once
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <set>

#include "otaruntime/defaults.h"
#include "otaruntime/hermes.h"
#include "otaruntime/runtime.h"
#include "testutil.h"

namespace sim {
using namespace otaruntime;
using nlohmann::json;

// ---------------------------------------------------------------- scenario registry
struct Scn { const char* name; void (*fn)(); };
inline std::vector<Scn>& registry() { static std::vector<Scn> r; return r; }
struct Reg { Reg(const char* n, void (*f)()) { registry().push_back({n, f}); } };
#define SCENARIO(n) static void scn_##n(); static sim::Reg reg_##n(#n, scn_##n); static void scn_##n()

// ---------------------------------------------------------------- call log
struct Log {
  Millis* now = nullptr;
  std::vector<std::string> lines;  // "t=123 vm.evaluate ..."
  void add(const std::string& s) { lines.push_back("t=" + std::to_string(now ? *now : 0) + " " + s); }
  // Texts (without the time prefix) whose text starts with `prefix`.
  std::vector<std::string> texts(const std::string& prefix = "") const {
    std::vector<std::string> out;
    for (auto& l : lines) {
      std::string t = l.substr(l.find(' ') + 1);
      if (t.compare(0, prefix.size(), prefix) == 0) out.push_back(t);
    }
    return out;
  }
  int count(const std::string& prefix) const { return int(texts(prefix).size()); }
  // Number of lines containing `sub`.
  int countSub(const std::string& sub) const {
    int n = 0;
    for (auto& l : lines) if (l.find(sub) != std::string::npos) n++;
    return n;
  }
  // The given substrings occur in this order (not necessarily adjacent).
  bool inOrder(const std::vector<std::string>& subs) const {
    size_t k = 0;
    for (auto& l : lines) if (k < subs.size() && l.find(subs[k]) != std::string::npos) k++;
    return k == subs.size();
  }
  // Index of first line containing `sub` or -1.
  int indexOf(const std::string& sub) const {
    for (size_t i = 0; i < lines.size(); i++) if (lines[i].find(sub) != std::string::npos) return int(i);
    return -1;
  }
  // Virtual time of first line containing `sub` or -1.
  int64_t timeOf(const std::string& sub) const {
    int i = indexOf(sub);
    return i < 0 ? -1 : std::atoll(lines[size_t(i)].c_str() + 2);
  }
  std::vector<int64_t> times(const std::string& sub) const {
    std::vector<int64_t> out;
    for (auto& l : lines) if (l.find(sub) != std::string::npos) out.push_back(std::atoll(l.c_str() + 2));
    return out;
  }
  std::string dump() const {
    std::string s;
    for (auto& l : lines) s += l + "\n";
    return s;
  }
};

// ---------------------------------------------------------------- clock + serial queue + worker
class Sim : public Clock, public Scheduler, public Worker {
 public:
  Millis now_ = 0, workMs = 5;
  Millis nowMs() override { return now_; }
  TimerId schedule(Millis delay, Task fn) override {
    uint64_t id = ++seq_;
    order_.insert({now_ + std::max<Millis>(0, delay), id});
    tasks_[id] = {now_ + std::max<Millis>(0, delay), std::move(fn)};
    return id;
  }
  void cancel(TimerId id) override {
    auto it = tasks_.find(id);
    if (it == tasks_.end()) return;
    order_.erase({it->second.first, id});
    tasks_.erase(it);
  }
  void post(Task fn) override { schedule(0, std::move(fn)); }
  void run(Task work, Task done) override {
    schedule(workMs, [this, work = std::move(work), done = std::move(done)] {
      work();
      post(done);
    });
  }
  void advance(Millis ms) {
    const Millis target = now_ + ms;
    while (!order_.empty() && order_.begin()->first <= target) {
      auto k = *order_.begin();
      order_.erase(order_.begin());
      auto it = tasks_.find(k.second);
      Task fn = std::move(it->second.second);
      tasks_.erase(it);
      now_ = std::max(now_, k.first);
      fn();
    }
    now_ = target;
  }
  void idle() { advance(0); }

 private:
  uint64_t seq_ = 0;
  std::set<std::pair<Millis, uint64_t>> order_;
  std::map<uint64_t, std::pair<Millis, Task>> tasks_;
};

// ---------------------------------------------------------------- store (shared across "processes")
struct MemStore : Store {
  std::map<std::string, std::string> m;
  std::function<bool(const std::string&)> failPut;
  std::function<void(const std::string&, const std::string&)> onPut;
  bool get(const std::string& k, std::string& out) override {
    auto it = m.find(k);
    if (it == m.end()) return false;
    out = it->second;
    return true;
  }
  bool put(const std::string& k, const std::string& v) override {
    if (failPut && failPut(k)) return false;
    if (onPut) onPut(k, v);
    m[k] = v;
    return true;
  }
  bool erase(const std::string& k) override { return m.erase(k) > 0; }
  std::vector<std::string> keys(const std::string& prefix) override {
    std::vector<std::string> out;
    for (auto& kv : m) if (kv.first.compare(0, prefix.size(), prefix) == 0) out.push_back(kv.first);
    return out;
  }
  int attempts(const std::string& id) const {
    auto it = m.find("attempts/" + id);
    return it == m.end() ? 0 : std::atoi(it->second.c_str());
  }
  bool bad(const std::string& id) const { return m.count("bad/" + id) > 0; }
};

// ---------------------------------------------------------------- the "CDN" (outlives processes)
struct Server {
  std::string body, sig, etag;
  Millis manifestLatency = 50, defaultLatency = 100;
  int manifestFailures = 0;  // next N manifest requests fail
  std::map<std::string, Bytes> files;
  std::map<std::string, Millis> latency;  // per url
  std::map<std::string, int> failTimes;   // per url: next N downloads fail
  bool metered = false;
};

// ---------------------------------------------------------------- test content
inline Bytes makeHbc(uint32_t version, uint64_t seed, size_t n = 3000) {
  Bytes b(n);
  Rng r(seed);
  for (auto& x : b) x = uint8_t(r.next() >> 24);
  for (int i = 0; i < 8; i++) b[size_t(i)] = uint8_t(kHermesMagic >> (8 * i));
  for (int i = 0; i < 4; i++) b[size_t(8 + i)] = uint8_t(version >> (8 * i));
  return b;
}
inline Bytes withEdits(const Bytes& old, uint64_t seed) {  // same header, scattered edits => small patch
  Bytes b = old;
  Rng r(seed);
  for (int i = 0; i < 40; i++) b[16 + r.below(uint32_t(b.size() - 16))] = uint8_t(r.next() >> 24);
  return b;
}
constexpr uint32_t kBytecodeVersion = 96;

struct Patch {
  std::string id, url, builtHash, type = "patch";
  Bytes built, patch;
  int64_t size() const { return int64_t(patch.size()); }
};

struct EntrySpec {
  Patch p;
  bool hasRange = false;
  double s = 0, e = 1;
  std::string requiresHost;
  bool lieAboutHash = false;  // manifest hash != real built hash
};

inline std::string sigFor(const std::string& body) { return "SIG(" + otacore::sha256Hash(body.data(), body.size()) + ")"; }

struct FakeVerifier : SignatureVerifier {
  bool rejectAll = false;
  int calls = 0;
  bool verify(const std::string& bytes, const std::string& sig, const std::string&) override {
    calls++;
    return !rejectAll && sig == sigFor(bytes);
  }
};

struct Env {
  std::string dir, cacheDir;
  Bytes host;
  std::map<std::string, Bytes> units;  // embedded
  Server server;
  std::string deviceId = "device-A";
  std::map<std::string, Bytes> patchMemo;

  explicit Env(const std::string& name) {
    dir = std::string(RT_WORK_DIR) + "/" + name;
    std::error_code ec;
    fs::remove_all(dir, ec);
    fs::create_directories(dir + "/gen");
    cacheDir = dir + "/app";
    host = makeHbc(kBytecodeVersion, 1, 4000);
    units["cabs"] = makeHbc(kBytecodeVersion, 2, 3000);
    units["bus"] = makeHbc(kBytecodeVersion, 3, 3000);
  }
  const Bytes& embedded(const std::string& target) const { return target == "host" ? host : units.at(target); }
  std::string embeddedHash(const std::string& target) const { return hashOf(embedded(target)); }
  double bucket(const std::string& unit) const { return otacore::bucket(deviceId, unit); }

  // Builds a real patch (embedded -> built) with hdiffz_tool; `full` diffs against an empty file.
  Patch makePatch(const std::string& target, const std::string& id, const Bytes& built, const std::string& type = "patch") {
    Patch p;
    p.id = id; p.type = type; p.built = built; p.builtHash = hashOf(built);
    p.url = "https://cdn.test/android/11.9.0/" + id + ".patch";
    const Bytes old = type == "full" ? Bytes{} : embedded(target);
    std::string key = hashOf(old) + ">" + p.builtHash + type;
    auto it = patchMemo.find(key);
    if (it == patchMemo.end()) {
      std::string oldF = dir + "/gen/old.bin", newF = dir + "/gen/new.bin", pF = dir + "/gen/p.patch";
      writeFile(oldF, old);
      writeFile(newF, built);
      if (!makePatch_(oldF, newF, pF)) { std::fprintf(stderr, "hdiffz_tool failed\n"); std::abort(); }
      it = patchMemo.emplace(key, readFile(pF)).first;
    }
    p.patch = it->second;
    server.files[p.url] = p.patch;
    return p;
  }
  static bool makePatch_(const std::string& o, const std::string& n, const std::string& p) { return ::makePatch(o, n, p, "zstd"); }
};

struct ManifestSpec {
  int64_t version = 1;
  int ttl = 120;
  std::string algo = "v1", platform = "android", appVersion = "11.9.0";
  std::string hostBase, unitBaseOverride;
  std::vector<EntrySpec> host;
  std::map<std::string, std::vector<EntrySpec>> units;

  static json entryJson(const EntrySpec& e) {
    json j = {{"id", e.p.id}, {"patchUrl", e.p.url},
              {"hash", e.lieAboutHash ? std::string("sha256:") + std::string(64, 'a') : e.p.builtHash},
              {"size", e.p.size()}, {"updateType", e.p.type}};
    if (e.hasRange) j["range"] = json::array({e.s, e.e});
    if (!e.requiresHost.empty()) j["requiresHost"] = e.requiresHost;
    return j;
  }
  std::string build(const Env& env) const {
    json m = {{"schema", 1}, {"platform", platform}, {"appVersion", appVersion}, {"patchAlgoVer", algo},
              {"version", version}, {"ttlSec", ttl}};
    json hostEntries = json::array();
    for (auto& e : host) hostEntries.push_back(entryJson(e));
    m["mainBundle"] = {{"baseHash", hostBase.empty() ? env.embeddedHash("host") : hostBase}, {"entries", hostEntries}};
    json us = json::array();
    for (auto& kv : units) {
      json es = json::array();
      for (auto& e : kv.second) es.push_back(entryJson(e));
      us.push_back({{"unitName", kv.first},
                    {"baseHash", unitBaseOverride.empty() ? env.embeddedHash(kv.first) : unitBaseOverride},
                    {"entries", es}});
    }
    m["units"] = us;
    return m.dump();
  }
};
// Makes `spec` the current manifest on the server (properly signed).
inline std::string publish(Env& env, const ManifestSpec& spec) {
  std::string body = spec.build(env);
  env.server.body = body;
  env.server.sig = sigFor(body);
  env.server.etag = "etag-" + std::to_string(spec.version);
  return body;
}

// ---------------------------------------------------------------- fakes bound to one "process"
struct World;

struct FakeAssets : EmbeddedAssets {
  Env& env;
  explicit FakeAssets(Env& e) : env(e) {}
  std::shared_ptr<const Buffer> open(const std::string& n) override {
    auto it = n == "host" ? &env.host : env.units.count(n) ? &env.units[n] : nullptr;
    return it ? makeAlignedBuffer(it->data(), it->size()) : nullptr;
  }
  struct Src : otacore::RandomAccessSource {
    Bytes b;
    explicit Src(Bytes x) : b(std::move(x)) {}
    uint64_t size() const override { return b.size(); }
    bool read(uint64_t off, void* buf, size_t len) override {
      if (off > b.size() || len > b.size() - off) return false;
      if (len) std::memcpy(buf, b.data() + off, len);
      return true;
    }
  };
  std::unique_ptr<otacore::RandomAccessSource> openSource(const std::string& n) override {
    if (n == "host") return std::make_unique<Src>(env.host);
    auto it = env.units.find(n);
    if (it == env.units.end()) return nullptr;
    return std::make_unique<Src>(it->second);
  }
};

struct FaultFs : StdFileSystem {
  std::set<std::string> failMapContains;  // map() fails for paths containing any of these
  bool shiftBuffers = false;              // hand out misaligned buffers
  std::shared_ptr<const Buffer> map(const std::string& path) override {
    for (auto& s : failMapContains) if (path.find(s) != std::string::npos) return nullptr;
    auto b = StdFileSystem::map(path);
    if (b && shiftBuffers) return std::make_shared<Mis>(b->data(), b->size());
    return b;
  }
  struct Mis : Buffer {  // data() is guaranteed NOT 4-byte aligned
    std::vector<uint8_t> raw;
    size_t n;
    size_t off = 0;
    Mis(const uint8_t* p, size_t len) : raw(len + 8), n(len) {
      uintptr_t a = reinterpret_cast<uintptr_t>(raw.data());
      off = (a % 4 == 0) ? 1 : 2;
      if ((a + off) % 4 == 0) off++;
      std::memcpy(raw.data() + off, p, len);
    }
    const uint8_t* data() const override { return raw.data() + off; }
    size_t size() const override { return n; }
  };
};

struct FaultBuilder : DefaultPatchBuilder {
  int failIoTimes = 0;  // next N builds return IoError (disk full)
  int calls = 0;
  otacore::Status build(otacore::RandomAccessSource& o, const std::string& p, const std::string& out,
                        const std::string& h) override {
    calls++;
    if (failIoTimes > 0) { failIoTimes--; return otacore::Status::IoError; }
    return DefaultPatchBuilder::build(o, p, out, h);
  }
};

struct Result {
  int calls = 0;
  OpenResult r;
  bool done() const { return calls > 0; }
};
using ResultP = std::shared_ptr<Result>;

struct World : Observer {
  Env& env;
  Sim sim;
  Log log;
  std::shared_ptr<MemStore> store;
  FakeVerifier verifier;
  FakeAssets assets;
  FaultFs fsys;
  FaultBuilder builder;
  std::unique_ptr<Runtime> rt;
  Config cfg;

  // fake VM
  Millis vmCreateMs = 100, vmDestroyMs = 10;
  bool vmCreateFailPatched = false;
  int surfaces = 0;
  std::vector<std::string> failEvalContains;  // evaluateUnit fails when the url contains one of these
  std::vector<std::string> failEntryContains;
  std::vector<std::string> evaluated;
  std::set<uint64_t> cancelledTokens;

  struct VmImpl : VmController {
    World& w;
    explicit VmImpl(World& x) : w(x) {}
    void createVm(const HostSource& h) override {
      w.log.add("vm.createVm host=" + h.hostId);
      bool ok = !(w.vmCreateFailPatched && h.patched());
      w.sim.schedule(w.vmCreateMs, [this, ok] { w.log.add("vm.created"); w.rt->onVmCreated(ok); });
    }
    void destroyVm() override {
      w.log.add("vm.destroyVm");
      w.surfaces = 0;
      w.sim.schedule(w.vmDestroyMs, [this] { w.log.add("vm.destroyed"); w.rt->onVmDestroyed(); });
    }
    bool evaluateUnit(const Buffer& b, const std::string& url, std::string& err) override {
      w.log.add("vm.evaluate " + url);
      w.evaluated.push_back(url);
      // Mirror what a real runtime would see: only well-formed bytecode may be evaluated.
      if (checkHermesBytecode(b.data(), b.size(), kBytecodeVersion) != nullptr) { err = "TEST-BUG: unchecked buffer"; std::abort(); }
      for (auto& s : w.failEvalContains) if (url.find(s) != std::string::npos) { err = "boom"; return false; }
      return true;
    }
    bool requireEntry(const std::string& id, std::string& err) override {
      w.log.add("vm.require " + id);
      for (auto& s : w.failEntryContains) if (w.evaluated.back().find(s) != std::string::npos) { err = "no entry"; return false; }
      return true;
    }
    bool mountSurface(const std::string& m, const std::string& props, std::string&) override {
      w.log.add("vm.mount " + m + " " + props);
      w.surfaces++;
      return true;
    }
    int mountedSurfaceCount() override { return w.surfaces; }
  } vmImpl;

  struct HttpImpl : Http {
    World& w;
    explicit HttpImpl(World& x) : w(x) {}
    void fetchManifest(const ManifestRequest& r) override {
      w.log.add("http.manifest inm=" + r.ifNoneMatch);
      uint64_t tok = r.token;
      std::string inm = r.ifNoneMatch;
      w.sim.schedule(w.env.server.manifestLatency, [this, tok, inm] {
        Server& s = w.env.server;
        if (s.manifestFailures > 0) { s.manifestFailures--; w.log.add("http.manifest.fail"); w.rt->onManifestFailed(tok, "network"); return; }
        if (s.body.empty()) { w.rt->onManifestFailed(tok, "404"); return; }
        ManifestResponse resp;
        if (!inm.empty() && inm == s.etag) resp.notModified = true;
        else { resp.body = s.body; resp.sigBase64 = s.sig; resp.etag = s.etag; }
        w.log.add(resp.notModified ? "http.manifest.304" : "http.manifest.200 " + s.etag);
        w.rt->onManifestFetched(tok, resp);
      });
    }
    void download(const DownloadRequest& r) override {
      w.log.add("http.download " + r.url.substr(r.url.rfind('/') + 1));
      Server& s = w.env.server;
      Millis lat = s.latency.count(r.url) ? s.latency[r.url] : s.defaultLatency;
      DownloadRequest req = r;
      w.sim.schedule(lat, [this, req] {
        Server& sv = w.env.server;
        if (w.cancelledTokens.count(req.token)) return;
        auto f = sv.files.find(req.url);
        if (sv.failTimes[req.url] > 0) { sv.failTimes[req.url]--; w.log.add("http.download.fail"); w.rt->onDownloadFailed(req.token, "network"); return; }
        if (f == sv.files.end() || int64_t(f->second.size()) > req.maxBytes) { w.log.add("http.download.fail"); w.rt->onDownloadFailed(req.token, "404-or-too-large"); return; }
        writeFile(req.destPath, f->second);
        w.log.add("http.download.done " + req.url.substr(req.url.rfind('/') + 1));
        w.rt->onDownloadDone(req.token, int64_t(f->second.size()));
      });
    }
    void cancel(uint64_t t) override { w.cancelledTokens.insert(t); }
    bool isMetered() override { return w.env.server.metered; }
  } httpImpl;

  void onEvent(const Event& e) override { log.add("ev." + e.kind + " " + e.unit + " " + e.id + " " + e.detail); }

  World(Env& e, Config c, std::shared_ptr<MemStore> st = nullptr)
      : env(e), store(st ? st : std::make_shared<MemStore>()), assets(e), cfg(std::move(c)), vmImpl(*this), httpImpl(*this) {
    log.now = &sim.now_;
    store->onPut = [this](const std::string& k, const std::string& v) {
      if (k.compare(0, 9, "attempts/") == 0 || k.compare(0, 4, "bad/") == 0) log.add("store.put " + k + "=" + v);
    };
    Deps d;
    d.clock = &sim; d.scheduler = &sim; d.worker = &sim;
    d.http = &httpImpl; d.fs = &fsys; d.store = store.get(); d.verifier = &verifier;
    d.vm = &vmImpl; d.assets = &assets; d.builder = &builder; d.observer = this;
    rt = std::make_unique<Runtime>(cfg, d);
  }

  // ---- driving
  void advance(Millis ms) { sim.advance(ms); }
  ResultP open(const std::string& unit, const std::string& props = "{}") {
    auto r = std::make_shared<Result>();
    rt->openUnit(unit, props, [r](const OpenResult& x) { r->calls++; r->r = x; });
    return r;
  }
  ResultP load(const std::string& unit) {
    auto r = std::make_shared<Result>();
    rt->loadUnit(unit, [r](const OpenResult& x) { r->calls++; r->r = x; });
    return r;
  }
  void unmountAll() {
    surfaces = 0;
    rt->onSurfaceUnmounted();
  }
  // start + first page interactive, then let `ms` pass.
  void boot(Millis ms = 0) {
    rt->start();
    rt->onFirstPageInteractive();
    advance(ms);
  }
  // Advances in 100 ms steps until pred() or `maxMs` elapsed. Returns pred().
  bool until(const std::function<bool()>& pred, Millis maxMs) {
    for (Millis t = 0; t < maxMs && !pred(); t += 100) advance(100);
    return pred();
  }
  std::string builtFile(const std::string& id) const {
    return env.cacheDir + "/codepush/11.9.0-100/" + id + ".bundle";
  }
};

inline Config baseConfig(Env& env) {
  Config c;
  c.platform = "android"; c.appVersion = "11.9.0"; c.buildNumber = "100";
  c.cacheBaseDir = env.cacheDir;
  c.manifestUrl = "https://cdn.test/android/11.9.0/manifest.json";
  c.bytecodeVersion = kBytecodeVersion;
  c.hostEmbeddedHash = env.embeddedHash("host");
  c.units = {{"cabs", env.embeddedHash("cabs"), "100"}, {"bus", env.embeddedHash("bus"), "200"}};
  c.deviceId = env.deviceId;
  return c;
}

// Seeds the store as if a previous session had accepted `spec` (signed, cached), without any patches on disk.
inline void seedCachedManifest(Env& env, MemStore& st, const ManifestSpec& spec) {
  std::string body = spec.build(env);
  st.m["manifest.body"] = body;
  st.m["manifest.sig"] = sigFor(body);
  st.m["manifest.keyId"] = "";
  st.m["manifest.etag"] = "etag-" + std::to_string(spec.version);
  st.m["highestManifestVersion"] = std::to_string(spec.version);
}
// Pretends a previous session downloaded and built `p` (file on disk + recorded size).
inline void seedBuilt(Env& env, MemStore& st, const Patch& p) {
  std::string dir = env.cacheDir + "/codepush/11.9.0-100";
  fs::create_directories(dir);
  writeFile(dir + "/" + p.id + ".bundle", p.built);
  st.m["built/" + p.id] = std::to_string(p.built.size());
}

inline EntrySpec ranged(EntrySpec e, double s, double en) { e.hasRange = true; e.s = s; e.e = en; return e; }
inline EntrySpec including(EntrySpec e, double b) { return ranged(e, 0.0, std::min(1.0, b + 0.01)); }
inline EntrySpec excluding(EntrySpec e, double b) { return b < 0.5 ? ranged(e, 0.5, 1.0) : ranged(e, 0.0, 0.5); }
inline std::vector<std::string> V(std::initializer_list<std::string> l) { return std::vector<std::string>(l); }
inline void publishRaw(Env& env, const std::string& body, const std::string& sig, const std::string& etag) {
  env.server.body = body; env.server.sig = sig; env.server.etag = etag;
}

inline EntrySpec entry(const Patch& p) { EntrySpec e; e.p = p; return e; }

// Prints the call log when the scenario that owns it fails.
struct Dump {
  World* w;
  int before = t::failures();
  explicit Dump(World* x) : w(x) {}
  ~Dump() { if (t::failures() != before && w) std::fprintf(stderr, "---- call log ----\n%s------------------\n", w->log.dump().c_str()); }
};

inline int runAll(int argc, char** argv) {
  int failed = 0, ran = 0;
  for (auto& s : registry()) {
    if (argc > 1 && std::string(argv[1]) != s.name) continue;
    int before = t::failures();
    s.fn();
    ran++;
    if (t::failures() != before) { failed++; std::fprintf(stderr, "SCENARIO FAILED: %s\n", s.name); }
    else std::printf("ok   %s\n", s.name);
  }
  if (ran == 0) { std::fprintf(stderr, "no scenario matched\n"); return 2; }
  std::printf("%d scenarios, %d failed, %d checks\n", ran, failed, t::checks());
  return failed ? 1 : 0;
}

}  // namespace sim
