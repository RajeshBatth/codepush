// JNI glue for the OTA unit spike (Android). Spike-only code.
// - mapAndCheck: mmap + DESIGN 5.8 pre-checks + sha256, with timings
// - evaluate: otaspike::evaluateUnitAsync on the JS thread (CallInvoker from ReactContext.getJSCallInvokerHolder()),
//             then the entry module in a second JS-thread hop (see runEntry: shared header calls __r directly)
// - probe: text eval of a JSON.stringify(...) expression, for reading __otaProbe
#include <android/log.h>
#include <fbjni/fbjni.h>
#include <jni.h>

#include <ReactCommon/CallInvokerHolder.h>

#include <chrono>
#include <cstring>
#include <sys/stat.h>
#include <cstdio>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "ota_unit_jsi.h"
#include "ota_unit_loader.h"
#include "otacore/otacore.h"

namespace jsi = facebook::jsi;
namespace react = facebook::react;
using otaspike::LoadStatus;
using otaspike::MappedFile;
using clk = std::chrono::steady_clock;

#define TAG "OTA_SPIKE"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

static JavaVM* gVm = nullptr;

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  gVm = vm;
  return facebook::jni::initialize(vm, [] {});
}

static double msSince(clk::time_point t) {
  return std::chrono::duration<double, std::milli>(clk::now() - t).count();
}

static std::string str(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string r(c ? c : "");
  if (c) env->ReleaseStringUTFChars(s, c);
  return r;
}

static JNIEnv* currentEnv() {
  JNIEnv* env = nullptr;
  if (gVm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    gVm->AttachCurrentThread(&env, nullptr);  // JS thread is a Java thread already; stays attached
  }
  return env;
}

// CallInvokerHolder (Java: CallInvokerHolderImpl, @FrameworkAPI) -> shared_ptr<CallInvoker>
static std::shared_ptr<react::CallInvoker> invokerFrom(jobject holder) {
  if (!holder) return nullptr;
  try {
    auto ref = facebook::jni::alias_ref<react::CallInvokerHolder::javaobject>(
        reinterpret_cast<react::CallInvokerHolder::javaobject>(holder));
    return ref->cthis()->getCallInvoker();
  } catch (const std::exception& e) {
    LOGI("invokerFrom failed: %s", e.what());
    return nullptr;
  }
}

struct Timings {
  double mapMs = 0, checkMs = 0, shaMs = 0;
  size_t bytes = 0;
};

static void callResult(jobject gcb, const std::string& status, const std::string& message, const Timings& t, double evalMs,
                       double requireMs) {
  JNIEnv* env = currentEnv();
  jclass cls = env->GetObjectClass(gcb);
  jmethodID m = env->GetMethodID(cls, "onResult", "(Ljava/lang/String;Ljava/lang/String;DDDDJ)V");
  jstring js = env->NewStringUTF(status.c_str());
  jstring jm = env->NewStringUTF(message.c_str());
  env->CallVoidMethod(gcb, m, js, jm, t.mapMs, t.checkMs + t.shaMs, evalMs, requireMs, (jlong)t.bytes);
  if (env->ExceptionCheck()) env->ExceptionClear();
  env->DeleteLocalRef(js);
  env->DeleteLocalRef(jm);
  env->DeleteLocalRef(cls);
  env->DeleteGlobalRef(gcb);
}

// Entry module in its own JS-thread hop. NOTE: Metro's __r() swallows exceptions through ErrorUtils.reportFatalError
// (fatal in release); the JS host defines globalThis.__otaRequire which hides ErrorUtils so the error propagates.
static void runEntry(std::shared_ptr<react::CallInvoker> inv, double entryId, jobject gcb, Timings t, double evalMs) {
  inv->invokeAsync([=](jsi::Runtime& rt) {
    auto t0 = clk::now();
    std::string status = "Ok", msg;
    try {
      jsi::Value fnv = rt.global().getProperty(rt, "__otaRequire");
      if (fnv.isObject() && fnv.asObject(rt).isFunction(rt)) {
        fnv.asObject(rt).asFunction(rt).call(rt, entryId);
        msg = "via __otaRequire";
      } else {
        rt.global().getPropertyAsFunction(rt, "__r").call(rt, entryId);
        msg = "via __r (no __otaRequire)";
      }
    } catch (const jsi::JSError& e) {
      status = "RequireError";
      msg = e.getMessage();
    } catch (const std::exception& e) {
      status = "RequireError";
      msg = e.what();
    }
    callResult(gcb, status, msg, t, evalMs, msSince(t0));
  });
}

extern "C" {

JNIEXPORT jstring JNICALL Java_com_otaspike_OtaNative_nativeMapAndCheck(JNIEnv* env, jclass, jstring jpath, jint expectedVersion,
                                                                       jstring jhash, jint misalignBytes) {
  std::string path = str(env, jpath), hash = str(env, jhash);
  auto t0 = clk::now();
  MappedFile f;
  LoadStatus st = otaspike::mapFile(path, f);
  double mapMs = msSince(t0);
  double checkMs = 0, shaMs = 0;
  if (st == LoadStatus::Ok) {
    if (misalignBytes > 0 && f.size > (size_t)misalignBytes) {  // deliberately misaligned view into a valid mapping
      f.data += misalignBytes;
      f.size -= misalignBytes;
    }
    auto t1 = clk::now();
    st = otaspike::preEvaluateChecks(f, (uint32_t)expectedVersion, "");
    checkMs = msSince(t1);
    if (st == LoadStatus::Ok && !hash.empty()) {
      auto t2 = clk::now();
      st = (otacore::sha256Hash(f.data, f.size) == hash) ? LoadStatus::Ok : LoadStatus::HashMismatch;
      shaMs = msSince(t2);
    }
  }
  char buf[256];
  snprintf(buf, sizeof buf, "%s|%zu|%.3f|%.3f|%.3f|%u", otaspike::toString(st), f.size, mapMs, checkMs, shaMs,
           (st == LoadStatus::Ok || st == LoadStatus::BytecodeVersionMismatch) ? otaspike::bytecodeVersion(f) : 0u);
  return env->NewStringUTF(buf);
}

// expectedVersion < 0: skip pre-checks (spike: "what does Hermes itself do"). entryId < 0: no entry module.
JNIEXPORT void JNICALL Java_com_otaspike_OtaNative_nativeEvaluate(JNIEnv* env, jclass, jobject holder, jstring jpath,
                                                                 jdouble entryId, jstring jurl, jint expectedVersion,
                                                                 jstring jhash, jobject cb) {
  std::string path = str(env, jpath), url = str(env, jurl), hash = str(env, jhash);
  jobject gcb = env->NewGlobalRef(cb);
  Timings t;
  auto t0 = clk::now();
  MappedFile f;
  LoadStatus st = otaspike::mapFile(path, f);
  t.mapMs = msSince(t0);
  t.bytes = f.size;
  if (st == LoadStatus::Ok && expectedVersion >= 0) {
    auto t1 = clk::now();
    st = otaspike::preEvaluateChecks(f, (uint32_t)expectedVersion, "");
    t.checkMs = msSince(t1);
    if (st == LoadStatus::Ok && !hash.empty()) {
      auto t2 = clk::now();
      st = (otacore::sha256Hash(f.data, f.size) == hash) ? LoadStatus::Ok : LoadStatus::HashMismatch;
      t.shaMs = msSince(t2);
    }
  }
  if (st != LoadStatus::Ok) {
    callResult(gcb, otaspike::toString(st), "pre-check", t, 0, 0);
    return;
  }
  auto inv = invokerFrom(holder);
  if (!inv) {
    callResult(gcb, "NoRuntime", "no CallInvoker", t, 0, 0);
    return;
  }
  otaspike::evaluateUnitAsync(inv, f, url, -1, [=](otaspike::LoadResult r) {
    if (r.status != LoadStatus::Ok || entryId < 0) {
      callResult(gcb, otaspike::toString(r.status), r.message, t, r.evalMs, 0);
      return;
    }
    runEntry(inv, entryId, gcb, t, r.evalMs);
  });
}

JNIEXPORT void JNICALL Java_com_otaspike_OtaNative_nativeProbe(JNIEnv* env, jclass, jobject holder, jstring jexpr, jobject cb) {
  std::string expr = str(env, jexpr);
  jobject gcb = env->NewGlobalRef(cb);
  auto inv = invokerFrom(holder);
  auto reply = [gcb](const std::string& rt, const std::string& val) {
    JNIEnv* e = currentEnv();
    jclass cls = e->GetObjectClass(gcb);
    jmethodID m = e->GetMethodID(cls, "onProbe", "(Ljava/lang/String;Ljava/lang/String;)V");
    jstring a = e->NewStringUTF(rt.c_str());
    jstring b = e->NewStringUTF(val.c_str());
    e->CallVoidMethod(gcb, m, a, b);
    if (e->ExceptionCheck()) e->ExceptionClear();
    e->DeleteLocalRef(a);
    e->DeleteLocalRef(b);
    e->DeleteLocalRef(cls);
    e->DeleteGlobalRef(gcb);
  };
  if (!inv) {
    reply("0x0", "NOINVOKER");
    return;
  }
  inv->invokeAsync([expr, reply](jsi::Runtime& rt) {
    char addr[32];
    snprintf(addr, sizeof addr, "%p", (void*)&rt);
    std::string out;
    try {
      std::string code = "globalThis.__spikeProbeOut=(function(){try{var v=JSON.stringify(" + expr +
                         ");return v===undefined?'undefined':v;}catch(e){return 'ERR:'+String(e);}})();";
      rt.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(code), "spike://probe");
      jsi::Value v = rt.global().getProperty(rt, "__spikeProbeOut");
      out = v.isString() ? v.getString(rt).utf8(rt) : "NOTSTRING";
    } catch (const std::exception& e) {
      // Fallback if source eval is unavailable: dotted-path walk from the global + JSON.stringify via JSI.
      try {
        jsi::Value cur = rt.global().getProperty(rt, "globalThis");
        std::stringstream ss(expr);
        std::string part;
        while (std::getline(ss, part, '.')) {
          if (!cur.isObject()) {
            cur = jsi::Value::undefined();
            break;
          }
          cur = cur.asObject(rt).getProperty(rt, part.c_str());
        }
        jsi::Value s = rt.global().getPropertyAsObject(rt, "JSON").getPropertyAsFunction(rt, "stringify").call(rt, cur);
        out = s.isString() ? s.getString(rt).utf8(rt) : "undefined";
        out += " (walker; text eval failed: " + std::string(e.what()) + ")";
      } catch (const std::exception& e2) {
        out = std::string("NATIVEERR:") + e2.what();
      }
    }
    reply(addr, out);
  });
}

}  // extern "C"

// ---------------------------------------------------------------- S13-S15: otacore applyPatch on device
static long procKb(const char* key) {  // /proc/self/status "VmRSS:" / "VmHWM:" in kB
  FILE* f = fopen("/proc/self/status", "r");
  if (!f) return -1;
  char line[256];
  long v = -1;
  size_t kl = strlen(key);
  while (fgets(line, sizeof line, f)) {
    if (strncmp(line, key, kl) == 0) { v = atol(line + kl); break; }
  }
  fclose(f);
  return v;
}

// returns "<Status>|<ms>|<rssBeforeKb>|<hwmAfterKb>|<rssAfterKb>|<outExists 0/1>|<tmpExists 0/1>|<clearRefsOk 0/1>"
extern "C" JNIEXPORT jstring JNICALL Java_com_otaspike_OtaNative_nativeApplyPatch(JNIEnv* env, jclass, jstring jold, jstring jpatch,
                                                                                   jstring jout, jstring jhash) {
  std::string oldF = str(env, jold), patchF = str(env, jpatch), outF = str(env, jout), hash = str(env, jhash);
  // reset the kernel's peak-RSS watermark (VmHWM) so hwmAfter reflects only this apply
  int cr = 0;
  if (FILE* f = fopen("/proc/self/clear_refs", "w")) { cr = fputs("5", f) >= 0; if (fclose(f) != 0) cr = 0; }
  long rssBefore = procKb("VmRSS:");
  auto t0 = clk::now();
  otacore::Status st;
  {
    otacore::FileSource old(oldF);
    st = old.ok() ? otacore::applyPatch(old, patchF, outF, hash) : otacore::Status::IoError;
  }
  double ms = msSince(t0);
  long hwm = procKb("VmHWM:"), rssAfter = procKb("VmRSS:");
  struct stat sb;
  int outEx = stat(outF.c_str(), &sb) == 0, tmpEx = stat((outF + ".tmp").c_str(), &sb) == 0;
  char buf[256];
  snprintf(buf, sizeof buf, "%s|%.3f|%ld|%ld|%ld|%d|%d|%d", otacore::statusName(st), ms, rssBefore, hwm, rssAfter, outEx, tmpEx, cr);
  return env->NewStringUTF(buf);
}

extern "C" JNIEXPORT jstring JNICALL Java_com_otaspike_OtaNative_nativeSha256File(JNIEnv* env, jclass, jstring jpath) {
  std::string h;
  if (!otacore::sha256File(str(env, jpath), h)) h = "IOERROR";
  return env->NewStringUTF(h.c_str());
}
