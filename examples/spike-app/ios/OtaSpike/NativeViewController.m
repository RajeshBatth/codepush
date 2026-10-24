#import "NativeViewController.h"
#import "OtaSpikeReact.h"
#import "OtaSpikeRunner.h"

// Full-screen RN surface pushed from the native screen ("Open host" / "Open cabs").
@interface ReactSurfaceViewController : UIViewController
- (instancetype)initWithModule:(NSString *)module;
@end
@implementation ReactSurfaceViewController {
  NSString *_module;
}
- (instancetype)initWithModule:(NSString *)module {
  if ((self = [super init])) { _module = module; self.title = module; }
  return self;
}
- (void)loadView {
  self.view = [[OtaSpikeReact shared] surfaceViewForModule:_module props:nil];
}
@end

@implementation NativeViewController {
  UITextView *_results;
  UIView *_surfaceContainer;
  UISegmentedControl *_mode;
  OtaSpikeRunner *_runner;
}

- (UIButton *)button:(NSString *)title action:(SEL)sel {
  UIButton *b = [UIButton buttonWithType:UIButtonTypeSystem];
  [b setTitle:title forState:UIControlStateNormal];
  b.accessibilityIdentifier = title;
  b.backgroundColor = [UIColor colorWithWhite:0.92 alpha:1];
  b.layer.cornerRadius = 6;
  [b addTarget:self action:sel forControlEvents:UIControlEventTouchUpInside];
  return b;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = @"OTA spike (native)";
  self.view.backgroundColor = UIColor.systemBackgroundColor;

  _mode = [[UISegmentedControl alloc] initWithItems:@[ @"embedded host", @"patched host" ]];
  _mode.selectedSegmentIndex = 0;

  UIButton *all = [self button:@"Run all spike tests" action:@selector(runAll)];
  UIButton *host = [self button:@"Open host" action:@selector(openHost)];
  UIButton *cabs = [self button:@"Open cabs" action:@selector(openCabs)];
  UIStackView *row = [[UIStackView alloc] initWithArrangedSubviews:@[ host, cabs ]];
  row.distribution = UIStackViewDistributionFillEqually;
  row.spacing = 8;

  _results = [UITextView new];
  _results.editable = NO;
  _results.font = [UIFont monospacedSystemFontOfSize:10 weight:UIFontWeightRegular];
  _results.accessibilityIdentifier = @"results";
  _results.layer.borderWidth = 1;
  _results.layer.borderColor = UIColor.lightGrayColor.CGColor;

  _surfaceContainer = [UIView new];  // test surfaces are mounted here by the runner (needs to be in a window to lay out)
  _surfaceContainer.layer.borderWidth = 1;
  _surfaceContainer.layer.borderColor = UIColor.blueColor.CGColor;

  UIStackView *col = [[UIStackView alloc] initWithArrangedSubviews:@[ _mode, all, row, _results, _surfaceContainer ]];
  col.axis = UILayoutConstraintAxisVertical;
  col.spacing = 8;
  col.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:col];
  UILayoutGuide *g = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [col.topAnchor constraintEqualToAnchor:g.topAnchor constant:8],
    [col.bottomAnchor constraintEqualToAnchor:g.bottomAnchor constant:-8],
    [col.leadingAnchor constraintEqualToAnchor:g.leadingAnchor constant:8],
    [col.trailingAnchor constraintEqualToAnchor:g.trailingAnchor constant:-8],
    [all.heightAnchor constraintEqualToConstant:44],
    [row.heightAnchor constraintEqualToConstant:44],
    [_surfaceContainer.heightAnchor constraintEqualToConstant:90],
  ]];
  [self append:@"native first screen ready; no React host created yet (lazy)."];
}

- (void)append:(NSString *)line {
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_results.text = [self->_results.text stringByAppendingFormat:@"%@\n", line];
    [self->_results scrollRangeToVisible:NSMakeRange(self->_results.text.length, 0)];
  });
}

- (void)applyMode {
  OtaHostMode m = _mode.selectedSegmentIndex == 1 ? OtaHostModePatched : OtaHostModeEmbedded;
  OtaSpikeReact *r = [OtaSpikeReact shared];
  NSString *err = [r copyBundleResourcesToDocuments];  // emulate downloaded files; patched host is read from Documents
  if (err) [self append:[@"copy failed: " stringByAppendingString:err]];
  if (r.hostMode != m && r.vmExists) {
    [r destroyVM];  // only valid because no surface is mounted from this screen at this point (DESIGN 5.4)
    [self append:@"host mode changed: VM destroyed, will be recreated lazily"];
  }
  r.hostMode = m;
}

- (void)openHost {
  [self applyMode];
  [self.navigationController pushViewController:[[ReactSurfaceViewController alloc] initWithModule:@"SpikeHost"] animated:YES];
}

- (void)openCabs {
  [self applyMode];
  OtaSpikeReact *r = [OtaSpikeReact shared];
  [r startVMIfNeeded];
  NSDictionary *u = [r manifest][@"units"][@"cabs"];
  if (!u) { [self append:@"no spike.json / cabs unit"]; return; }
  // Native-driven loading (DESIGN 5.8): evaluate the unit into the running VM BEFORE creating the cabs surface.
  // Poll until the host bundle has run (the invoker can run tasks before the bundle finished loading).
  __block int tries = 0;
  __weak __typeof(self) weak = self;
  __block void (^attempt)(void);
  attempt = ^{
    [r probe:@"typeof globalThis.__r === 'function' && typeof globalThis.__otaProbe === 'object'" completion:^(NSString *res, NSString *e) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (![res isEqualToString:@"true"]) {
          if (++tries > 100) { [weak append:@"host never became ready"]; attempt = nil; return; }
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), attempt);
          return;
        }
        attempt = nil;
        [r loadUnitNamed:@"cabs" completion:^(OtaStep *s) {
          dispatch_async(dispatch_get_main_queue(), ^{
            [weak append:[NSString stringWithFormat:@"cabs load: %@ %@ eval=%.1fms require=%.1fms", s.status, s.message, s.evalMs, s.requireMs]];
            // Already-loaded unit: second evaluate is harmless (first-wins) but we still mount.
            [weak.navigationController pushViewController:[[ReactSurfaceViewController alloc] initWithModule:@"cabs"] animated:YES];
          });
        }];
      });
    }];
  };
  attempt();
}

- (void)runAll {
  [self applyMode];
  if (!_runner) {
    __weak __typeof(self) weak = self;
    _runner = [[OtaSpikeRunner alloc] initWithContainer:_surfaceContainer log:^(NSString *line) { [weak append:line]; }];
  }
  if (_runner.running) return;
  _results.text = @"";
  [_runner runAll];
}
@end
