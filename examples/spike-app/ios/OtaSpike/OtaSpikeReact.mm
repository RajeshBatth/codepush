#import "OtaSpikeReact.h"

#import <React/RCTBridge.h>
#import <React/RCTBridge+Private.h>
#import <React/RCTBridgeModule.h>
#import <React-RCTAppDelegate/RCTReactNativeFactory.h>
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <ReactCommon/RCTHost.h>

#include <chrono>
#include <memory>
#include <string>

#include "ota_unit_jsi.h"
#include "ota_unit_loader.h"
#include "otacore/otacore.h"

// ---- API surprise vs docs/research/rn-0.78-loader.md: these are NOT declared in public headers; Re.Pack-style categories ----
@interface RCTBridge (OtaSpike)
- (void *)runtime;                                                       // RCTBridgeProxy.mm L97
- (std::shared_ptr<facebook::react::CallInvoker>)jsCallInvoker;          // RCTBridgeProxy.mm L103
@end
@interface RCTHost (OtaSpike)
- (void)reload;  // RCTHost+Internal.h L17 (not in RCTHost.h); implemented in RCTHost.mm L375
@end

using clock_t_ = std::chrono::steady_clock;
static double msSince(clock_t_::time_point t0) {
  return std::chrono::duration<double, std::milli>(clock_t_::now() - t0).count();
}

@implementation OtaStep
- (BOOL)ok { return [self.status isEqualToString:@"Ok"]; }
- (instancetype)init {
  if ((self = [super init])) { _status = @"Ok"; _message = @""; }
  return self;
}
@end

// Factory delegate: owns bundleURL. RCTRootViewFactory/RCTHost call -bundleURL on start() and on every reload().
@interface OtaSpikeFactoryDelegate : RCTDefaultReactNativeFactoryDelegate
@end
@implementation OtaSpikeFactoryDelegate
- (instancetype)init {
  if ((self = [super init])) { self.dependencyProvider = [RCTAppDependencyProvider new]; }
  return self;
}
- (NSURL *)bundleURL { return [[OtaSpikeReact shared] currentBundleURL]; }
- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge { return [self bundleURL]; }
- (BOOL)newArchEnabled { return YES; }
- (BOOL)bridgelessEnabled { return YES; }
- (BOOL)fabricEnabled { return YES; }
- (BOOL)turboModuleEnabled { return YES; }
@end

@implementation OtaSpikeReact {
  RCTReactNativeFactory *_factory;
  OtaSpikeFactoryDelegate *_delegate;  // factory.delegate is weak
}

+ (instancetype)shared {
  static OtaSpikeReact *s;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ s = [OtaSpikeReact new]; });
  return s;
}

- (NSString *)otaDir {
  NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  return [docs stringByAppendingPathComponent:@"ota"];
}

#pragma mark - files

- (NSString *)copyBundleResourcesToDocuments {
  NSFileManager *fm = NSFileManager.defaultManager;
  NSString *src = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"ota"];
  if (![fm fileExistsAtPath:src]) return [NSString stringWithFormat:@"bundle folder missing: %@ (run scripts/prepare-spike-assets.mjs, rebuild)", src];
  NSError *err = nil;
  [fm removeItemAtPath:self.otaDir error:nil];
  if (![fm copyItemAtPath:src toPath:self.otaDir error:&err]) return err.localizedDescription;
  return nil;
}

- (NSDictionary *)manifest {
  NSData *d = [NSData dataWithContentsOfFile:[self.otaDir stringByAppendingPathComponent:@"spike.json"]];
  if (!d) return nil;
  id j = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
  return [j isKindOfClass:NSDictionary.class] ? j : nil;
}

- (uint32_t)hbcVersion {
  NSNumber *n = [self manifest][@"hbcVersion"];
  return n ? n.unsignedIntValue : 96;
}

- (NSURL *)currentBundleURL {
  if (self.hostMode == OtaHostModePatched) {
    return [NSURL fileURLWithPath:[self.otaDir stringByAppendingPathComponent:@"patched/host.hbc"]];
  }
  // Embedded host = the app bundle resource (the "normal" shipped bundle); explicit URL instead of main.jsbundle.
  NSURL *u = [NSBundle.mainBundle URLForResource:@"host" withExtension:@"hbc" subdirectory:@"ota/embedded"];
  return u ?: [NSURL fileURLWithPath:[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"ota/embedded/host.hbc"]];
}

#pragma mark - VM lifecycle

- (BOOL)vmExists { return _factory.rootViewFactory.reactHost != nil; }

- (void)startVMIfNeeded {
  NSAssert(NSThread.isMainThread, @"main thread");
  if (!_factory) {
    _delegate = [OtaSpikeFactoryDelegate new];
    _factory = [[RCTReactNativeFactory alloc] initWithDelegate:_delegate];
  }
  RCTRootViewFactory *rvf = _factory.rootViewFactory;
  if (!rvf.reactHost) {
    // Same prerequisites RCTRootViewFactory -viewWithModuleName:... performs before createReactHostIfNeeded (private).
    RCTEnableTurboModuleInterop(YES);
    RCTEnableTurboModuleInteropBridgeProxy(YES);
    rvf.reactHost = [rvf createReactHost:nil];  // public "helper": allocs RCTHost and calls [host start]
  }
}

- (UIView *)surfaceViewForModule:(NSString *)module props:(NSDictionary *)props {
  [self startVMIfNeeded];
  return [_factory.rootViewFactory viewWithModuleName:module initialProperties:props ?: @{}];
}

- (void)reloadVM {
  [_factory.rootViewFactory.reactHost reload];
}

- (void)destroyVM {
  _factory.rootViewFactory.reactHost = nil;
  _factory = nil;
  _delegate = nil;
}

#pragma mark - runtime access

- (RCTBridge *)liveBridge {
  RCTBridge *b = [RCTBridge currentBridge];
  return b;
}
- (uintptr_t)bridgeAddress { return (uintptr_t)[self liveBridge]; }
- (uintptr_t)runtimeAddress {
  RCTBridge *b = [self liveBridge];
  return [b respondsToSelector:@selector(runtime)] ? (uintptr_t)[b runtime] : 0;
}
- (std::shared_ptr<facebook::react::CallInvoker>)liveInvoker {
  RCTBridge *b = [self liveBridge];
  if ([b respondsToSelector:@selector(jsCallInvoker)]) return [b jsCallInvoker];
  return nullptr;
}
- (uintptr_t)invokerAddress { return (uintptr_t)[self liveInvoker].get(); }

#pragma mark - loader

- (OtaStep *)checkOnlyPath:(NSString *)path hbcVersion:(uint32_t)version misalign:(BOOL)misalign {
  OtaStep *s = [OtaStep new];
  otaspike::MappedFile f;
  auto t0 = clock_t_::now();
  auto st = otaspike::mapFile(path.UTF8String, f);
  s.mapMs = msSince(t0);
  if (st != otaspike::LoadStatus::Ok) { s.status = @(otaspike::toString(st)); return s; }
  s.size = f.size;
  if (misalign) { f.data += 1; f.size -= 1; }
  t0 = clock_t_::now();
  st = otaspike::preEvaluateChecks(f, version, "");
  s.preMs = msSince(t0);
  s.status = @(otaspike::toString(st));
  return s;
}

- (void)evaluateUnitAtPath:(NSString *)path hash:(NSString *)hash hbcVersion:(uint32_t)version entryId:(double)entryId
                 sourceURL:(NSString *)sourceURL skipChecks:(BOOL)skipChecks completion:(void (^)(OtaStep *))completion {
  using namespace otaspike;
  OtaStep *s = [OtaStep new];
  MappedFile f;
  auto t0 = clock_t_::now();
  LoadStatus st = mapFile(path.UTF8String, f);
  s.mapMs = msSince(t0);
  if (st != LoadStatus::Ok) { s.status = @(toString(st)); completion(s); return; }
  s.size = f.size;
  if (!skipChecks) {
    t0 = clock_t_::now();
    st = preEvaluateChecks(f, version, "");  // size, alignment, magic, version
    s.preMs = msSince(t0);
    if (st == LoadStatus::Ok && hash.length) {
      t0 = clock_t_::now();
      std::string actual = otacore::sha256Hash(f.data, f.size);  // "sha256:<hex>"
      s.shaMs = msSince(t0);
      if (actual != hash.UTF8String) st = LoadStatus::HashMismatch;
    }
    if (st != LoadStatus::Ok) { s.status = @(toString(st)); completion(s); return; }
  }
  auto invoker = [self liveInvoker];
  // Evaluate only (entryId -1): shared evaluateUnitAsync runs Metro's __r, which swallows entry exceptions via
  // ErrorUtils.reportFatalError (fatal = crash in release). The JS side provides globalThis.__otaRequire which rethrows,
  // so the entry is run in a second JS-thread task below and a throw becomes LoadStatus::RequireError.
  evaluateUnitAsync(invoker, f, sourceURL.UTF8String, -1, [s, completion, invoker, entryId](LoadResult r) {
    s.status = @(toString(r.status));
    s.message = @(r.message.c_str());
    s.evalMs = r.evalMs;
    if (r.status != LoadStatus::Ok || entryId < 0) { completion(s); return; }
    invoker->invokeAsync([s, completion, entryId](facebook::jsi::Runtime &rt) {
      auto t0 = clock_t_::now();
      try {
        auto g = rt.global();
        const char *fn = g.hasProperty(rt, "__otaRequire") ? "__otaRequire" : "__r";
        g.getPropertyAsFunction(rt, fn).call(rt, entryId);
      } catch (const facebook::jsi::JSError &e) {
        s.status = @(toString(LoadStatus::RequireError));
        s.message = @(e.getMessage().c_str());
      } catch (const std::exception &e) {
        s.status = @(toString(LoadStatus::RequireError));
        s.message = @(e.what());
      }
      s.requireMs = msSince(t0);
      completion(s);
    });
  });
}

- (void)probe:(NSString *)jsExpr completion:(void (^)(NSString *, NSString *))completion {
  auto invoker = [self liveInvoker];
  if (!invoker) { completion(nil, @"no CallInvoker"); return; }
  std::string expr = jsExpr.UTF8String;
  invoker->invokeAsync([expr, completion](facebook::jsi::Runtime &rt) {
    try {
      auto v = rt.evaluateJavaScript(std::make_shared<facebook::jsi::StringBuffer>(expr), "otaspike-probe.js");
      std::string out = v.isString() ? v.getString(rt).utf8(rt) : (v.isUndefined() ? "undefined" : v.toString(rt).utf8(rt));
      completion(@(out.c_str()), nil);
    } catch (const facebook::jsi::JSError &e) {
      completion(nil, @(e.getMessage().c_str()));
    } catch (const std::exception &e) {
      completion(nil, @(e.what()));
    }
  });
}

- (void)loadUnitNamed:(NSString *)name completion:(void (^)(OtaStep *))completion {
  NSDictionary *u = [self manifest][@"units"][name];
  if (!u) { OtaStep *s = [OtaStep new]; s.status = @"IoError"; s.message = @"unit not in spike.json"; completion(s); return; }
  NSString *path = [self.otaDir stringByAppendingPathComponent:[@"embedded" stringByAppendingPathComponent:u[@"file"]]];
  [self evaluateUnitAtPath:path hash:u[@"hash"] hbcVersion:[self hbcVersion] entryId:[u[@"entryId"] doubleValue]
                 sourceURL:[NSString stringWithFormat:@"unit://%@", name] skipChecks:NO completion:completion];
}
@end
