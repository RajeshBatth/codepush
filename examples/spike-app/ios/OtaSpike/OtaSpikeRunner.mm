#import "OtaSpikeRunner.h"
#import "OtaSpikeReact.h"

#include <chrono>

static void onMain(dispatch_block_t b) {
  if (NSThread.isMainThread) b(); else dispatch_sync(dispatch_get_main_queue(), b);
}
static void sleepMs(int ms) { usleep(ms * 1000); }

@implementation OtaSpikeRunner {
  UIView *_container;
  void (^_log)(NSString *);
  dispatch_queue_t _q;
  OtaSpikeReact *_r;
  int _pass, _fail;
  NSMutableString *_all;
  NSDictionary *_m;
}

- (instancetype)initWithContainer:(UIView *)c log:(void (^)(NSString *))log {
  if ((self = [super init])) {
    _container = c;
    _log = [log copy];
    _q = dispatch_queue_create("ota.spike.runner", DISPATCH_QUEUE_SERIAL);
    _r = [OtaSpikeReact shared];
  }
  return self;
}

#pragma mark - logging

- (void)emit:(NSString *)line {
  NSLog(@"%@", line);
  _log(line);
  [_all appendFormat:@"%@\n", line];
}
- (void)result:(NSString *)tid ok:(BOOL)ok details:(NSString *)d {
  if (ok) _pass++; else _fail++;
  [self emit:[NSString stringWithFormat:@"OTA_SPIKE RESULT %@ %@ %@", tid, ok ? @"PASS" : @"FAIL", d]];
}

#pragma mark - sync helpers (runner queue only)

- (id)probeJSON:(NSString *)expr {  // expr must evaluate to a string that is JSON
  __block NSString *res = nil, *err = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [_r probe:expr completion:^(NSString *r, NSString *e) { res = r; err = e; dispatch_semaphore_signal(sem); }];
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) != 0) return nil;
  if (!res) return @{@"__error" : err ?: @"nil"};
  return [NSJSONSerialization JSONObjectWithData:[res dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingFragmentsAllowed error:nil];
}
- (NSDictionary *)probeState {
  id j = [self probeJSON:@"JSON.stringify({host:globalThis.__otaProbe&&__otaProbe.host,units:(globalThis.__otaProbe&&__otaProbe.units)||{},pwned:globalThis.__otaProbe&&__otaProbe.pwned})"];
  return [j isKindOfClass:NSDictionary.class] ? j : @{};
}
- (BOOL)waitHostReady {
  for (int i = 0; i < 150; i++) {  // 15 s
    id j = [self probeJSON:@"JSON.stringify(typeof globalThis.__r === 'function' && typeof globalThis.__otaProbe === 'object')"];
    if ([j isEqual:@YES]) return YES;
    sleepMs(100);
  }
  return NO;
}
- (OtaStep *)evalPath:(NSString *)path hash:(NSString *)hash entry:(double)entry url:(NSString *)url skip:(BOOL)skip {
  __block OtaStep *out = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [_r evaluateUnitAtPath:path hash:hash hbcVersion:[_r hbcVersion] entryId:entry sourceURL:url skipChecks:skip
              completion:^(OtaStep *s) { out = s; dispatch_semaphore_signal(sem); }];
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
    OtaStep *t = [OtaStep new]; t.status = @"Timeout"; return t;
  }
  return out;
}
- (NSString *)unitFile:(NSString *)stage name:(NSString *)name {
  NSString *rel = _m[@"units"][name][@"file"] ?: [NSString stringWithFormat:@"units/%@.hbc", name];
  return [[_r.otaDir stringByAppendingPathComponent:stage] stringByAppendingPathComponent:rel];
}
- (OtaStep *)loadUnit:(NSString *)name stage:(NSString *)stage withHash:(BOOL)withHash {
  NSDictionary *u = _m[@"units"][name];
  return [self evalPath:[self unitFile:stage name:name] hash:(withHash ? u[@"hash"] : nil) entry:[u[@"entryId"] doubleValue]
                    url:[NSString stringWithFormat:@"unit://%@/%@", stage, name] skip:NO];
}

static void collectText(UIView *v, NSMutableString *out) {
  NSString *l = v.accessibilityLabel;
  if (l.length) [out appendFormat:@"%@|", l];
  for (UIView *s in v.subviews) collectText(s, out);
}
- (NSString *)surfaceText {
  __block NSMutableString *s = [NSMutableString new];
  onMain(^{ collectText(self->_container, s); });
  return s;
}
- (BOOL)waitText:(NSString *)needle {
  for (int i = 0; i < 100; i++) {  // 10 s
    if ([[self surfaceText] containsString:needle]) return YES;
    sleepMs(100);
  }
  return NO;
}
- (void)mount:(NSString *)module {
  onMain(^{
    for (UIView *v in self->_container.subviews) [v removeFromSuperview];
    UIView *v = [self->_r surfaceViewForModule:module props:nil];
    v.frame = self->_container.bounds;
    v.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [self->_container addSubview:v];
  });
}
// Finds a view whose accessibilityLabel contains `label` and sends accessibilityActivate (what VoiceOver double-tap does;
// RN Pressable maps it to onPress via onClick).
- (BOOL)activateViewLabeled:(NSString *)label in:(UIView *)root {
  if ([root.accessibilityLabel containsString:label] && root.accessibilityTraits & UIAccessibilityTraitButton) {
    if ([root accessibilityActivate]) return YES;
  }
  for (UIView *v in root.subviews) if ([self activateViewLabeled:label in:v]) return YES;
  return NO;
}
- (void)unmount {
  onMain(^{ for (UIView *v in self->_container.subviews) [v removeFromSuperview]; });
  sleepMs(300);
}
/// Destroy + recreate the VM from `mode` (no surface mounted), wait until the new host bundle has run.
- (BOOL)freshVM:(OtaHostMode)mode {
  [self unmount];
  uintptr_t old = _r.bridgeAddress;
  onMain(^{ [self->_r destroyVM]; self->_r.hostMode = mode; });
  sleepMs(500);
  onMain(^{ [self->_r startVMIfNeeded]; });
  for (int i = 0; i < 150 && _r.bridgeAddress == old; i++) sleepMs(100);
  return [self waitHostReady];
}
/// RCTHost -reload (in-place VM recreate, re-reads bundleURL), no surface mounted.
- (BOOL)reloadVMWithMode:(OtaHostMode)mode {
  [self unmount];
  uintptr_t old = _r.bridgeAddress;
  onMain(^{ self->_r.hostMode = mode; [self->_r reloadVM]; });
  for (int i = 0; i < 150 && _r.bridgeAddress == old; i++) sleepMs(100);
  return [self waitHostReady];
}

static NSString *fmt1(double v) { return [NSString stringWithFormat:@"%.2f", v]; }

#pragma mark - tests

- (void)runAll {
  if (_running) return;
  _running = YES;
  dispatch_async(_q, ^{
    self->_pass = self->_fail = 0;
    self->_all = [NSMutableString new];
    @try { [self runSuite]; }
    @catch (NSException *e) { [self result:@"RUNNER" ok:NO details:[NSString stringWithFormat:@"exception %@: %@", e.name, e.reason]]; }
    [self emit:[NSString stringWithFormat:@"OTA_SPIKE SUMMARY pass=%d fail=%d", self->_pass, self->_fail]];
    NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
    [self->_all writeToFile:[docs stringByAppendingPathComponent:@"ota_spike_results.txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    self->_running = NO;
  });
}

- (void)runSuite {
  NSString *cerr = [_r copyBundleResourcesToDocuments];
  _m = [_r manifest];
  if (cerr || !_m) { [self result:@"S1" ok:NO details:[NSString stringWithFormat:@"setup: %@", cerr ?: @"spike.json missing"]]; return; }
  uint32_t ver = [_r hbcVersion];
  NSString *ota = _r.otaDir;
  NSString *fx = [ota stringByAppendingPathComponent:@"fixtures"];
  NSDictionary *cabs = _m[@"units"][@"cabs"];

  // ---- S1: embedded host ----
  BOOL ready = [self freshVM:OtaHostModeEmbedded];
  [self mount:@"SpikeHost"];
  BOOL txt = [self waitText:@"HOST:embedded"];
  NSDictionary *st = [self probeState];
  [self result:@"S1" ok:(ready && txt && [st[@"host"] isEqual:@"embedded"])
       details:[NSString stringWithFormat:@"ready=%d text=%d probe.host=%@ url=%@", ready, txt, st[@"host"], _r.currentBundleURL.lastPathComponent]];

  // ---- S4: pre-checks (same VM) ----
  {
    OtaStep *a = [_r checkOnlyPath:[fx stringByAppendingPathComponent:@"unit-wrong-version.hbc"] hbcVersion:ver misalign:NO];
    OtaStep *b = [_r checkOnlyPath:[fx stringByAppendingPathComponent:@"unit-text.js"] hbcVersion:ver misalign:NO];
    OtaStep *c = [_r checkOnlyPath:[fx stringByAppendingPathComponent:@"unit-truncated.hbc"] hbcVersion:ver misalign:NO];
    OtaStep *d = [_r checkOnlyPath:[self unitFile:@"embedded" name:@"cabs"] hbcVersion:ver misalign:YES];
    BOOL rej = !a.ok && !b.ok && !c.ok && !d.ok;
    BOOL exact = [a.status isEqual:@"BytecodeVersionMismatch"] && [b.status isEqual:@"NotHermesBytecode"] && [d.status isEqual:@"Misaligned"] &&
                 ([c.status isEqual:@"TooSmall"] || [c.status isEqual:@"NotHermesBytecode"]);
    // Record what Hermes does when the pre-check is bypassed, for wrong-version ONLY (the text file is never evaluated).
    OtaStep *byp = [self evalPath:[fx stringByAppendingPathComponent:@"unit-wrong-version.hbc"] hash:nil entry:-1 url:@"unit://fixture/wrong-version" skip:YES];
    NSDictionary *s4 = [self probeState];
    BOOL pwnedFalse = [s4[@"pwned"] isEqual:@NO] || [s4[@"pwned"] isEqual:@0];
    [self result:@"S4" ok:(rej && exact && pwnedFalse)
         details:[NSString stringWithFormat:@"wrongVersion=%@ text=%@ truncated=%@ misaligned=%@ pwned=%@ | hermesBypassWrongVersion=%@ msg=\"%@\" unitsAfter=%@",
                  a.status, b.status, c.status, d.status, s4[@"pwned"], byp.status, byp.message, s4[@"units"]]];
  }

  // ---- S3: embedded cabs after host ----
  OtaStep *s3 = [self loadUnit:@"cabs" stage:@"embedded" withHash:YES];
  st = [self probeState];
  [self mount:@"cabs"];
  txt = [self waitText:@"CABS:v1"];
  [self result:@"S3" ok:(s3.ok && [st[@"units"][@"cabs"] isEqual:@"v1"] && txt)
       details:[NSString stringWithFormat:@"status=%@ msg=\"%@\" probe.cabs=%@ text=%d eval=%@ms require=%@ms", s3.status, s3.message, st[@"units"][@"cabs"], txt, fmt1(s3.evalMs), fmt1(s3.requireMs)]];

  // ---- S6: patched cabs after v1 in same VM ----
  OtaStep *s6 = [self evalPath:[self unitFile:@"patched" name:@"cabs"] hash:nil entry:[cabs[@"entryId"] doubleValue] url:@"unit://patched/cabs" skip:NO];
  st = [self probeState];
  [self result:@"S6" ok:[st[@"units"][@"cabs"] isEqual:@"v1"]
       details:[NSString stringWithFormat:@"v2 evaluate status=%@ msg=\"%@\" probe.cabs=%@ (expect v1: first-wins)", s6.status, s6.message, st[@"units"][@"cabs"]]];

  // ---- S5: entry module throws ----
  {
    id badEntry = _m[@"fixtures"][@"unit-bad-entry.hbc"][@"entryId"];
    if (!badEntry) {
      [self result:@"S5" ok:NO details:@"entry id of fixtures/unit-bad-entry.hbc not found in spike.json (fixtures[unit-bad-entry.hbc].entryId)"];
    } else {
      OtaStep *bad = [self evalPath:[fx stringByAppendingPathComponent:@"unit-bad-entry.hbc"] hash:nil entry:[badEntry doubleValue] url:@"unit://fixture/bad-entry" skip:NO];
      OtaStep *ok2 = [self loadUnit:@"bus" stage:@"embedded" withHash:YES];
      st = [self probeState];
      [self result:@"S5" ok:([bad.status isEqual:@"RequireError"] && ok2.ok && [st[@"units"][@"bus"] isEqual:@"v1"])
           details:[NSString stringWithFormat:@"bad=%@ msg=\"%@\" | next load bus=%@ probe.bus=%@", bad.status, bad.message, ok2.status, st[@"units"][@"bus"]]];
    }
  }

  // ---- S2: patched host (bundleURL -> Documents/ota/patched/host.hbc), fresh VM ----
  ready = [self freshVM:OtaHostModePatched];
  [self mount:@"SpikeHost"];
  txt = [self waitText:@"HOST:patched"];
  st = [self probeState];
  [self result:@"S2" ok:(ready && txt && [st[@"host"] isEqual:@"patched"])
       details:[NSString stringWithFormat:@"ready=%d text=%d probe.host=%@ url=%@", ready, txt, st[@"host"], _r.currentBundleURL.path]];

  // ---- S9: import() path: tap "import() cabs" in SpikeHost -> Suspense -> __loadBundleAsync -> NativeOtaUnits.load -> evaluate ----
  ready = [self freshVM:OtaHostModeEmbedded];
  {
    id t = [self probeJSON:@"JSON.stringify([typeof globalThis.__loadBundleAsync])"];
    NSString *kind = [t isKindOfClass:NSArray.class] ? t[0] : @"?";
    [self mount:@"SpikeHost"];
    BOOL hostTxt = [self waitText:@"HOST:embedded"];
    __block BOOL tapped = NO;
    onMain(^{ tapped = [self activateViewLabeled:@"import() cabs" in:self->_container]; });
    txt = tapped && [self waitText:@"CABS:v1"];
    NSString *path = @"import()-tap";
    if (!txt) {  // fallback: call the same global the generated import() calls, so the native half is still measured
      path = @"direct __loadBundleAsync (tap did not render the unit)";
      if ([kind isEqual:@"function"]) {
        [self probeJSON:@"(function(){var p=globalThis.__otaProbe;p.s9='pending';Promise.resolve(globalThis.__loadBundleAsync('cabs')).then(function(){p.s9='resolved'},function(e){p.s9='rejected:'+(e&&e.message||e)});return JSON.stringify('started');})()"];
        for (int i = 0; i < 100; i++) {
          id v = [self probeJSON:@"JSON.stringify(globalThis.__otaProbe.s9)"];
          if ([v isKindOfClass:NSString.class] && ![v isEqual:@"pending"]) { txt = [v isEqual:@"resolved"]; break; }
          sleepMs(100);
        }
      }
    }
    NSDictionary *p = [self probeState];
    [self result:@"S9" ok:(ready && hostTxt && txt && [p[@"units"][@"cabs"] isEqual:@"v1"])
         details:[NSString stringWithFormat:@"path=%@ typeof __loadBundleAsync=%@ tapped=%d probe.cabs=%@ rendered/resolved=%d%@", path, kind, tapped, p[@"units"][@"cabs"], txt,
                  [kind isEqual:@"function"] ? @"" : @" (NativeOtaUnits not visible to JS: interop did not register the module)"]];
  }

  // ---- S7: reload (RCTHost -reload), then load again with FRESH runtime + invoker ----
  {
    uintptr_t oB = _r.bridgeAddress, oR = _r.runtimeAddress, oI = _r.invokerAddress;
    BOOL re = [self reloadVMWithMode:OtaHostModeEmbedded];
    uintptr_t nB = _r.bridgeAddress, nR = _r.runtimeAddress, nI = _r.invokerAddress;
    NSDictionary *pre = [self probeState];
    BOOL fresh = ((NSDictionary *)pre[@"units"]).count == 0;
    OtaStep *s7 = [self loadUnit:@"cabs" stage:@"embedded" withHash:YES];
    NSDictionary *post = [self probeState];
    [self result:@"S7" ok:(re && fresh && s7.ok && [post[@"units"][@"cabs"] isEqual:@"v1"])
         details:[NSString stringWithFormat:@"reloaded=%d probeFresh(unitsEmpty)=%d load=%@ msg=\"%@\" probe.cabs=%@ | oldRuntime=%p newRuntime=%p runtimeChanged=%d oldInvoker=%p newInvoker=%p invokerChanged=%d bridgeChanged=%d (old pointers never dereferenced)",
                  re, fresh, s7.status, s7.message, post[@"units"][@"cabs"], (void *)oR, (void *)nR, oR != nR, (void *)oI, (void *)nI, oI != nI, oB != nB]];
  }

  // ---- S10: host swap (embedded -> patched) while no surface is mounted ----
  {
    BOOL re = [self reloadVMWithMode:OtaHostModePatched];
    NSDictionary *pre = [self probeState];
    BOOL empty = ((NSDictionary *)pre[@"units"]).count == 0;
    [self mount:@"SpikeHost"];
    BOOL t1 = [self waitText:@"HOST:patched"];
    OtaStep *a = [self loadUnit:@"cabs" stage:@"embedded" withHash:YES];
    [self mount:@"cabs"];
    BOOL t2 = [self waitText:@"CABS:v1"];
    NSDictionary *post = [self probeState];
    [self result:@"S10" ok:(re && [pre[@"host"] isEqual:@"patched"] && empty && t1 && a.ok && t2 && [post[@"units"][@"cabs"] isEqual:@"v1"])
         details:[NSString stringWithFormat:@"reloaded=%d probe.host=%@ unitsEmptyAfterSwap=%d hostText=%d S3-again load=%@ cabsText=%d probe.cabs=%@", re, pre[@"host"], empty, t1, a.status, t2, post[@"units"][@"cabs"]]];
  }

  // ---- S8: timings on a fresh embedded VM (cold: first load of each unit) ----
  {
    ready = [self freshVM:OtaHostModeEmbedded];
    NSMutableString *d = [NSMutableString new];
    BOOL all = ready;
    NSString *hostPath = [[ota stringByAppendingPathComponent:@"embedded"] stringByAppendingPathComponent:@"host.hbc"];
    unsigned long long hostBytes = [[NSFileManager.defaultManager attributesOfItemAtPath:hostPath error:nil] fileSize];
    [d appendFormat:@"hostBytes=%llu", hostBytes];
    for (NSString *name in [[_m[@"units"] allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
      OtaStep *s = [self loadUnit:name stage:@"embedded" withHash:YES];
      all = all && s.ok;
      [d appendFormat:@" | %@ status=%@ bytes=%lu map=%@ms pre=%@ms sha256=%@ms eval=%@ms require=%@ms", name, s.status, (unsigned long)s.size,
       fmt1(s.mapMs), fmt1(s.preMs), fmt1(s.shaMs), fmt1(s.evalMs), fmt1(s.requireMs)];
    }
    [self result:@"S8" ok:all details:d];
  }
  [self unmount];
}
@end
