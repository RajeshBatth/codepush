// JSI adapter: evaluate a mapped Hermes-bytecode unit on the JS thread, then optionally run its entry module.
// Header-only so each platform build can include it without extra build steps. DESIGN.md 5.6 C / 5.8.
#pragma once
#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <chrono>
#include <functional>
#include <memory>
#include <string>

#include "ota_unit_loader.h"

namespace otaspike {

// A jsi::Buffer over a mapping that outlives the runtime (never unmapped).
class MappedBuffer final : public facebook::jsi::Buffer {
 public:
  explicit MappedBuffer(MappedFile f) : f_(f) {}
  size_t size() const override { return f_.size; }
  const uint8_t* data() const override { return f_.data; }

 private:
  MappedFile f_;
};

struct LoadResult {
  LoadStatus status = LoadStatus::Ok;
  std::string message;   // JS error message or detail
  double evalMs = 0;     // time spent inside evaluateJavaScript
  double requireMs = 0;  // time spent running the entry module (0 if no entry id)
};

using LoadDone = std::function<void(LoadResult)>;

// Schedules on the JS thread via the CallInvoker (never evaluate from another thread).
// entryModuleId < 0 => do not run an entry module. `done` is invoked on the JS thread.
inline void evaluateUnitAsync(std::shared_ptr<facebook::react::CallInvoker> invoker, MappedFile file, std::string sourceUrl,
                              double entryModuleId, LoadDone done) {
  if (!invoker) {
    done(LoadResult{LoadStatus::NoRuntime, "no CallInvoker", 0, 0});
    return;
  }
  invoker->invokeAsync([file, sourceUrl = std::move(sourceUrl), entryModuleId, done = std::move(done)](facebook::jsi::Runtime& rt) {
    using clock = std::chrono::steady_clock;
    LoadResult r;
    auto t0 = clock::now();
    try {
      rt.evaluateJavaScript(std::make_shared<MappedBuffer>(file), sourceUrl);
    } catch (const facebook::jsi::JSError& e) {
      r.status = LoadStatus::EvalError;
      r.message = e.getMessage();
    } catch (const facebook::jsi::JSIException& e) {
      r.status = LoadStatus::EvalError;
      r.message = e.what();
    } catch (const std::exception& e) {
      r.status = LoadStatus::EvalError;
      r.message = e.what();
    }
    auto t1 = clock::now();
    r.evalMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    if (r.status == LoadStatus::Ok && entryModuleId >= 0) {
      try {
        // Prefer the host-provided `__otaRequire`: Metro's `__r` swallows an exception thrown by the entry module and
        // reports it to ErrorUtils.reportFatalError, which crashes a release app instead of throwing to us (found by the
        // spike: JS_FINDINGS.md). `__otaRequire` hides ErrorUtils for the call so the exception propagates here.
        // Module ids are plain numbers (DESIGN.md 4: 48-bit path hashes fit a JS number).
        auto global = rt.global();
        auto custom = global.getProperty(rt, "__otaRequire");
        if (custom.isObject() && custom.getObject(rt).isFunction(rt)) {
          custom.getObject(rt).getFunction(rt).call(rt, entryModuleId);
        } else {
          global.getPropertyAsFunction(rt, "__r").call(rt, entryModuleId);
        }
      } catch (const facebook::jsi::JSError& e) {
        r.status = LoadStatus::RequireError;
        r.message = e.getMessage();
      } catch (const facebook::jsi::JSIException& e) {
        r.status = LoadStatus::RequireError;
        r.message = e.what();
      }
      r.requireMs = std::chrono::duration<double, std::milli>(clock::now() - t1).count();
    }
    done(std::move(r));
  });
}

}  // namespace otaspike
