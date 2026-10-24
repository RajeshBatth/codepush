#import "AppDelegate.h"
#import "NativeViewController.h"

@implementation AppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [[UINavigationController alloc] initWithRootViewController:[NativeViewController new]];
  [self.window makeKeyAndVisible];
  return YES;
}
@end
