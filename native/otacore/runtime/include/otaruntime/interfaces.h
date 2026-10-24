// otaruntime: injected interfaces. Production implementations (Kotlin/JNI, ObjC++) come later; the
// orchestrator (runtime.h) is written only against these.
//
// THREADING CONTRACT (the whole runtime relies on it):
//  * The "ota queue" is one serial executor. Runtime methods, Clock timer callbacks, Scheduler tasks,
//    Worker `done` callbacks and every `Runtime::on*` event MUST run on it, never concurrently.
//  * Only Worker `work` closures run elsewhere. They capture plain data and must not touch the Runtime.
//  * Interface calls never invoke their completion synchronously (always a later queue turn), so the
//    Runtime is never re-entered from inside one of its own calls.
//  * No exceptions cross any of these interfaces.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "otacore/otacore.h"

namespace otaruntime {

using Millis = int64_t;
using TimerId = uint64_t;  // 0 is never a valid id
using Task = std::function<void()>;

// Read-only, immutable byte range. Implementations typically wrap an mmap or an aligned heap copy.
class Buffer {
 public:
  virtual ~Buffer() = default;
  virtual const uint8_t* data() const = 0;
  virtual size_t size() const = 0;
};

class Clock {
 public:
  virtual ~Clock() = default;
  virtual Millis nowMs() = 0;                       // monotonic
  virtual TimerId schedule(Millis delayMs, Task fn) = 0;  // fn runs on the ota queue
  virtual void cancel(TimerId id) = 0;              // no-op for fired/unknown ids
};

class Scheduler {
 public:
  virtual ~Scheduler() = default;
  virtual void post(Task fn) = 0;  // run on the ota queue, after the current task
};

// Runs heavy work (hashing, applyPatch, file IO) off the ota queue.
class Worker {
 public:
  virtual ~Worker() = default;
  // `work` runs on some background thread; afterwards `done` runs on the ota queue.
  virtual void run(Task work, Task done) = 0;
};

struct ManifestRequest {
  uint64_t token = 0;
  std::string url;        // .../manifest.json
  std::string sigUrl;     // .../manifest.json.sig
  std::string ifNoneMatch;  // empty: unconditional
};
struct ManifestResponse {
  bool notModified = false;  // 304; other fields empty
  std::string body;          // exact bytes served
  std::string sigBase64;     // exact content of the .sig file (base64 Ed25519)
  std::string keyId;         // optional key id carried by the signature file
  std::string etag;
};
struct DownloadRequest {
  uint64_t token = 0;
  std::string url;
  std::string destPath;  // write atomically (temp + rename); on failure leave nothing behind
  int64_t maxBytes = 0;  // abort when the body would exceed this
};

// Completion is reported through Runtime::onManifestFetched/onManifestFailed and
// Runtime::onDownloadDone/onDownloadFailed with the request token.
class Http {
 public:
  virtual ~Http() = default;
  virtual void fetchManifest(const ManifestRequest& req) = 0;
  virtual void download(const DownloadRequest& req) = 0;
  virtual void cancel(uint64_t token) = 0;
  virtual bool isMetered() = 0;  // cellular / expensive network
};

// Minimal file operations. Methods used from Worker threads (sha256File, canonical, fileSize) must
// be thread-safe.
class FileSystem {
 public:
  virtual ~FileSystem() = default;
  virtual int64_t fileSize(const std::string& path) = 0;  // -1 when missing
  virtual bool remove(const std::string& path) = 0;
  virtual std::string canonical(const std::string& path) = 0;  // symlinks resolved; "" on failure
  virtual bool sha256File(const std::string& path, std::string& outHash) = 0;
  // Maps (or reads into an aligned buffer) the whole file. nullptr on failure.
  virtual std::shared_ptr<const Buffer> map(const std::string& path) = 0;
};

// Durable key/value storage. put() must be durable and atomic when it returns true (the crash-loop
// guard relies on it); values are binary-safe.
class Store {
 public:
  virtual ~Store() = default;
  virtual bool get(const std::string& key, std::string& out) = 0;
  virtual bool put(const std::string& key, const std::string& value) = 0;
  virtual bool erase(const std::string& key) = 0;
  virtual std::vector<std::string> keys(const std::string& prefix) = 0;
};

class SignatureVerifier {
 public:
  virtual ~SignatureVerifier() = default;
  virtual bool verify(const std::string& bytes, const std::string& sigBase64, const std::string& keyIdHint) = 0;
};

// Where the host/unit that shipped inside the binary comes from. name is "host" or a unit name.
class EmbeddedAssets {
 public:
  virtual ~EmbeddedAssets() = default;
  virtual std::shared_ptr<const Buffer> open(const std::string& name) = 0;  // ota queue
  // Old-data source for applyPatch. Called on Worker threads: thread-safe. nullptr if unknown.
  virtual std::unique_ptr<otacore::RandomAccessSource> openSource(const std::string& name) = 0;
};

// Applies a patch (default: otacore::applyPatch). Called on Worker threads. Injectable for fault tests.
class PatchBuilder {
 public:
  virtual ~PatchBuilder() = default;
  virtual otacore::Status build(otacore::RandomAccessSource& old, const std::string& patchFile,
                                const std::string& outFile, const std::string& expectedHash) = 0;
};

struct HostSource {
  std::string hostId = "embedded";  // "embedded" or the host entry id
  std::string path;                 // built file when patched (empty for embedded)
  std::shared_ptr<const Buffer> buffer;  // already checked (aligned, magic, version); null for embedded
  bool patched() const { return hostId != "embedded"; }
};

// All calls on the ota queue. createVm/destroyVm are asynchronous: the glue reports completion with
// Runtime::onVmCreated(ok) / Runtime::onVmDestroyed(). The others are synchronous (the glue may hop to
// the JS thread and wait; the work is bounded).
class VmController {
 public:
  virtual ~VmController() = default;
  virtual void createVm(const HostSource& host) = 0;
  virtual void destroyVm() = 0;
  virtual bool evaluateUnit(const Buffer& bytecode, const std::string& sourceUrl, std::string& err) = 0;
  virtual bool requireEntry(const std::string& entryModuleId, std::string& err) = 0;
  virtual bool mountSurface(const std::string& moduleName, const std::string& propsJson, std::string& err) = 0;
  virtual int mountedSurfaceCount() = 0;
};

// Lifecycle events (DESIGN 8: "download, apply, load, confirm, rollback"). CodePush does no telemetry
// itself; LoBs tag their analytics from these.
struct Event {
  std::string kind;    // see runtime.cpp / README for the list
  std::string unit;    // unit name, "host" or ""
  std::string id;      // entry id or ""
  std::string detail;
};
class Observer {
 public:
  virtual ~Observer() = default;
  virtual void onEvent(const Event& e) = 0;
};

}  // namespace otaruntime
