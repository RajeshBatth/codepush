#import <UIKit/UIKit.h>

// Runs S1-S10 (examples/spike-app/SPIKE.md) sequentially on a private serial queue (never the main or JS thread).
// Line format: "OTA_SPIKE RESULT <id> PASS|FAIL <details>" via NSLog, the on-screen log block and Documents/ota_spike_results.txt.
@interface OtaSpikeRunner : NSObject
@property(nonatomic, readonly) BOOL running;
- (instancetype)initWithContainer:(UIView *)surfaceContainer log:(void (^)(NSString *line))log;
- (void)runAll;
@end
