// S9: legacy-style RCTBridgeModule exposed to JS as NativeModules.NativeOtaUnits / TurboModuleRegistry.get('NativeOtaUnits').
// Under bridgeless this works via the TurboModule INTEROP layer: RCTRootViewFactory turns on
// RCTEnableTurboModuleInterop(YES) + RCTEnableTurboModuleInteropBridgeProxy(YES) (we call the same in OtaSpikeReact -startVMIfNeeded),
// and RCTTurboModuleManager picks up RCT_EXPORT_MODULE classes through RCTGetModuleClasses(). No codegen spec needed.
#import <React/RCTBridgeModule.h>
#import "OtaSpikeReact.h"

@interface NativeOtaUnits : NSObject <RCTBridgeModule>
@end

@implementation NativeOtaUnits
RCT_EXPORT_MODULE(NativeOtaUnits)

+ (BOOL)requiresMainQueueSetup { return NO; }

RCT_EXPORT_METHOD(load : (NSString *)name resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSLog(@"OTA_SPIKE NativeOtaUnits.load(%@)", name);
  [[OtaSpikeReact shared] loadUnitNamed:name completion:^(OtaStep *s) {
    if (s.ok) resolve(@{@"unit" : name, @"evalMs" : @(s.evalMs), @"requireMs" : @(s.requireMs)});
    else reject(@"E_OTA_LOAD", [NSString stringWithFormat:@"%@: %@", s.status, s.message], nil);
  }];
}
@end
