#import <UIKit/UIKit.h>

// HYBRID app: the app delegate does NOT touch React Native. It shows the native first screen only.
// The RN host is created lazily by OtaSpikeReact (first "Open ..." tap or the test runner).
@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
