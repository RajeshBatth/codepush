// SPIKE ONLY (DESIGN.md 5.6 C / 5.8). ObjC facade over: lazy RN bridgeless host creation, the shared C++ unit loader
// (examples/spike-app/shared) and a text probe. Pure ObjC header so any .m/.mm/.swift file can import it.
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, OtaHostMode) {
  OtaHostModeEmbedded = 0,  // bundle resource ota/embedded/host.hbc (no override)
  OtaHostModePatched = 1,   // Documents/ota/patched/host.hbc
};

/// Result of a native unit load (map + pre-checks + sha256 + evaluate + require).
@interface OtaStep : NSObject
@property(nonatomic, copy) NSString *status;   // otaspike::toString(LoadStatus): "Ok", "BytecodeVersionMismatch", ...
@property(nonatomic, copy) NSString *message;  // JS error message / detail
@property(nonatomic) double mapMs, preMs, shaMs, evalMs, requireMs;
@property(nonatomic) NSUInteger size;
@property(nonatomic, readonly) BOOL ok;
@end

@interface OtaSpikeReact : NSObject
+ (instancetype)shared;

@property(nonatomic) OtaHostMode hostMode;       // read by the factory delegate's -bundleURL on create AND on reload
@property(nonatomic, readonly) BOOL vmExists;
@property(nonatomic, readonly) NSString *otaDir;  // <Documents>/ota

/// Copy bundle `ota/` over Documents/ota (emulates downloaded files). Returns error text or nil.
- (nullable NSString *)copyBundleResourcesToDocuments;
/// Parsed Documents/ota/spike.json (nil if missing).
- (nullable NSDictionary *)manifest;
- (uint32_t)hbcVersion;

/// The URL the RCTHost gets (called from the factory delegate on start and on every reload).
- (NSURL *)currentBundleURL;

// ---- VM lifecycle (main thread only) ----
/// Prewarm: create RCTHost + start (no surface). Lazily creates the factory. Safe to call repeatedly.
- (void)startVMIfNeeded;
/// Create a surface view for AppRegistry component `module` (starts the VM if needed).
- (UIView *)surfaceViewForModule:(NSString *)module props:(nullable NSDictionary *)props;
/// RCTHost -reload: tears down the RCTInstance and creates a new one, re-reading currentBundleURL. No surfaces may be mounted.
- (void)reloadVM;
/// Drops factory + RCTHost (RCTHost dealloc invalidates the instance). Caller must have removed all surface views.
- (void)destroyVM;

// ---- identities (compare only; NEVER dereference stale values) ----
- (uintptr_t)bridgeAddress;   // [RCTBridge currentBridge]
- (uintptr_t)runtimeAddress;  // [bridge runtime]
- (uintptr_t)invokerAddress;  // [bridge jsCallInvoker].get()

// ---- loader ----
/// map + pre-checks (+ sha256 when `hash` given) + evaluate on JS thread (+ __r(entryId) when entryId >= 0).
/// skipChecks bypasses preEvaluateChecks (S4: see what Hermes itself does). `completion` is called on the JS thread.
- (void)evaluateUnitAtPath:(NSString *)path
                      hash:(nullable NSString *)hash
                 hbcVersion:(uint32_t)version
                   entryId:(double)entryId
                 sourceURL:(NSString *)sourceURL
                skipChecks:(BOOL)skipChecks
                completion:(void (^)(OtaStep *))completion;
/// Pre-checks only (no VM): returns status string per file; `misalign` maps the file at +1 byte.
- (OtaStep *)checkOnlyPath:(NSString *)path hbcVersion:(uint32_t)version misalign:(BOOL)misalign;

/// Text eval of a small JSON.stringify(...) expression on the JS thread. Spike only.
- (void)probe:(NSString *)jsExpr completion:(void (^)(NSString *_Nullable result, NSString *_Nullable error))completion;

/// S9: NativeOtaUnits.load(name): evaluates Documents/ota/embedded/units/<name>.hbc with manifest hash + entryId.
- (void)loadUnitNamed:(NSString *)name completion:(void (^)(OtaStep *))completion;
@end

NS_ASSUME_NONNULL_END
