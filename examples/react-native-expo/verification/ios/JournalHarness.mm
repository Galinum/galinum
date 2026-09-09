#import <React/RCTBridgeModule.h>
#import <GalinumJournal/GalinumJournalHooks.h>
#import <GalinumJournal/GalinumJournalIngress.h>
#import <GalinumJournal/GalinumJournalInspection.h>
#import <GalinumJournal/GalinumNotifications.h>
#import <UserNotifications/UserNotifications.h>
#import <mach/mach_time.h>
#import <pthread.h>
#import <objc/message.h>
#import "GalinumReceiptStore-Swift.h"

static NSString *encode(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
static id decode(NSString *value) {
  return [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}
static double nanos(void) { return (double)clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW); }
static NSURL *documents(void) {
  return [[NSFileManager defaultManager] URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
}

@interface GJFixtureDelegate : NSObject <UNUserNotificationCenterDelegate>
@property NSUInteger foregroundCount;
@end
@implementation GJFixtureDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  self.foregroundCount++;
  completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
@end
static GJFixtureDelegate *bareDelegate;

@interface JournalHarness : NSObject <RCTBridgeModule, GalinumJournalHooks>
@end

@implementation JournalHarness {
  NSMutableDictionary<NSString *, dispatch_group_t> *pauses;
  NSMutableSet<NSString *> *reached;
  NSMutableArray *events;
  NSMutableArray *submissions;
  NSString *failingControl;
  BOOL loseReply;
  NSData *receiptBytes;
  NSURL *receiptFile;
}
RCT_EXPORT_MODULE(JournalHarness)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (instancetype)init {
  if ((self = [super init])) {
    pauses = [NSMutableDictionary new];
    reached = [NSMutableSet new];
    events = [NSMutableArray new];
    submissions = [NSMutableArray new];
    GalinumJournalSetHooks(self);
  }
  return self;
}
- (void)checkpoint:(NSString *)point {
  if (([point isEqual:@"control-commit-before"] || [point isEqual:@"feedback-commit-before"] || [point isEqual:@"notifications-commit-before"]) && failingControl) {
    [self event:@"injected-sql-failure" data:@{} detail:point];
    GalinumJournalExecute(failingControl, @"INSERT INTO galinum_missing_fault_table VALUES(1)");
  }
  if ([point isEqual:@"control-commit-after"] && loseReply) {
    loseReply = NO;
    @throw [NSException exceptionWithName:@"journal_storage_failure" reason:@"journal_storage_failure" userInfo:nil];
  }
  dispatch_group_t latch;
  @synchronized(self) {
    latch = pauses[point];
    if (latch) [reached addObject:point];
  }
  if (!latch) return;
  [self event:@"pause-reached" data:@{} detail:point];
  dispatch_group_wait(latch, DISPATCH_TIME_FOREVER);
  [self event:@"pause-released" data:@{} detail:point];
}
- (void)event:(NSString *)kind data:(NSDictionary *)data detail:(NSString *)detail {
  NSMutableDictionary *entry = [data mutableCopy];
  entry[@"kind"] = kind;
  entry[@"detail"] = detail;
  entry[@"nanos"] = @(nanos());
  entry[@"thread"] = NSThread.isMainThread ? @"main" : [NSString stringWithFormat:@"%p", pthread_self()];
  @synchronized(self) {
    [events addObject:entry];
  }
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(config) {
  NSData *data = [NSData dataWithContentsOfURL:[documents() URLByAppendingPathComponent:@"journal-config.json"]];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}";
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(now) { return @(nanos()); }
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(tap : (NSString *)scope owner : (NSString *)owner observation : (NSString *)observation) {
  return GalinumJournalReserveObservation(scope, decode(observation));
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(pause : (NSString *)point) {
  @synchronized(self) {
    dispatch_group_t group = dispatch_group_create();
    dispatch_group_enter(group);
    pauses[point] = group;
    [reached removeObject:point];
  }
  return @YES;
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(resume : (NSString *)point) {
  dispatch_group_t latch;
  @synchronized(self) {
    latch = pauses[point];
    [pauses removeObjectForKey:point];
  }
  if (latch) dispatch_group_leave(latch);
  return @(latch != nil);
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(reached : (NSString *)point) {
  @synchronized(self) {
    return @([reached containsObject:point]);
  }
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(trace) {
  NSArray *entries;
  @synchronized(self) {
    entries = [events copy];
    [events removeAllObjects];
  }
  return encode(entries);
}
RCT_EXPORT_METHOD(block : (NSString *)scope resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  GalinumJournalOnQueue(scope, ^{ [self checkpoint:@"executor"]; }, ^(NSString *code) {
    if (code) reject(code, code, nil); else resolve(nil);
  });
}
RCT_EXPORT_METHOD(submit : (NSString *)scope resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  GalinumJournalSubmitIfCurrent(scope, ^(NSDictionary *publication) {
    @synchronized(self) {
      [submissions addObject:publication];
    }
    [self checkpoint:@"submission-handoff"];
  }, ^(NSDictionary *result, NSString *code) {
    if (code) reject(code, code, nil); else resolve(encode(result));
  });
}
RCT_EXPORT_METHOD(inspect : (NSString *)scope resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @try {
      NSMutableDictionary *result = [GalinumJournalInspect(scope) mutableCopy];
      @synchronized(self) {
        result[@"submitted"] = [submissions copy];
      }
      resolve(encode(result));
    } @catch (NSException *error) {
      reject(error.name, error.name, nil);
    }
  });
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(loseNextReply) { loseReply = YES; return @YES; }
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(reloadLease : (NSString *)scope owner : (NSString *)owner) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @try { GalinumJournalReloadLease(scope, owner); } @catch (NSException *error) {}
  });
  return @YES;
}
RCT_EXPORT_METHOD(files : (NSString *)scope resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  @try { resolve(encode(GalinumJournalFiles(scope))); } @catch (NSException *error) { reject(error.name, error.name, nil); }
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(failControlWrites : (NSString *)scope fail : (BOOL)fail) {
  failingControl = fail ? scope : nil;
  return @YES;
}
RCT_EXPORT_METHOD(removeControl : (NSString *)scope resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  GalinumJournalOnQueue(scope, ^{
    GalinumJournalExecute(scope, @"BEGIN IMMEDIATE");
    GalinumJournalExecute(scope, @"DELETE FROM control");
    GalinumJournalExecute(scope, @"DELETE FROM operations");
    GalinumJournalExecute(scope, @"COMMIT");
  }, ^(NSString *code) { if (code) reject(code, code, nil); else resolve(nil); });
}
RCT_EXPORT_METHOD(capacity : (NSString *)scope owner : (NSString *)owner constrained : (BOOL)constrained resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @try { resolve(encode(GalinumJournalCapacity(scope, owner, constrained))); } @catch (NSException *error) { reject(@"fixture_failure", @"fixture_failure", nil); }
  });
}
RCT_EXPORT_METHOD(save : (NSString *)phase encoded : (NSString *)encoded resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSMutableDictionary *result = [decode(encoded) mutableCopy];
  if (!result || [phase rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789-"] invertedSet]].location != NSNotFound) {
    reject(@"fixture_failure", @"fixture_failure", nil);
    return;
  }
  result[@"pid"] = @(getpid());
  NSURL *path = [documents() URLByAppendingPathComponent:[NSString stringWithFormat:@"journal-%@.json", phase]];
  NSData *data = [encode(result) dataUsingEncoding:NSUTF8StringEncoding];
  if (![data writeToURL:path options:NSDataWritingAtomic error:nil]) { reject(@"fixture_failure", @"fixture_failure", nil); return; }
  int fd = open(path.path.UTF8String, O_RDONLY);
  if (fd >= 0) { fcntl(fd, F_FULLFSYNC); close(fd); }
  resolve(nil);
}
RCT_EXPORT_METHOD(ingress : (NSString *)envelope foreground : (BOOL)foreground resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSDictionary *parsed = GalinumJournalParseEnvelope(@{@"galinum" : decode(envelope) ?: @{}});
  if (!parsed) { reject(@"invalid_envelope", @"invalid_envelope", nil); return; }
  GalinumJournalIngress(parsed, foreground, ^(NSDictionary *result, NSString *code) {
    if (code) reject(code, code, nil); else resolve(encode(result));
  });
}
RCT_EXPORT_METHOD(capture : (NSString *)envelope actionId : (NSString *)actionId resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSDictionary *parsed = GalinumJournalParseEnvelope(@{@"galinum" : decode(envelope) ?: @{}});
  if (!parsed) { reject(@"invalid_envelope", @"invalid_envelope", nil); return; }
  GalinumJournalCaptureInteraction(parsed, actionId.length ? actionId : nil, ^(NSDictionary *result, NSString *code) {
    if (code) reject(code, code, nil); else resolve(encode(result));
  });
}
RCT_EXPORT_METHOD(delegateState : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    id<UNUserNotificationCenterDelegate> delegate = UNUserNotificationCenter.currentNotificationCenter.delegate;
    id previous = GalinumNotifications.shared.previous;
    [UNUserNotificationCenter.currentNotificationCenter getNotificationCategoriesWithCompletionHandler:^(NSSet<UNNotificationCategory *> *categories) {
      NSMutableArray *registered = [NSMutableArray new];
      for (UNNotificationCategory *category in categories) {
        NSMutableArray *actions = [NSMutableArray new];
        for (UNNotificationAction *action in category.actions) [actions addObject:@{@"id" : action.identifier, @"title" : action.title, @"foreground" : @((action.options & UNNotificationActionOptionForeground) != 0)}];
        [registered addObject:@{@"id" : category.identifier, @"actions" : actions}];
      }
      resolve(encode(@{@"delegate" : NSStringFromClass([delegate class]) ?: @"", @"composed" : @(delegate == GalinumNotifications.shared), @"previous" : previous ? NSStringFromClass([previous class]) : @"", @"categories" : registered}));
    }];
  });
}
RCT_EXPORT_METHOD(permission : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
    if (error) reject(@"permission_error", @"permission_error", nil); else resolve(@(granted));
  }];
}
RCT_EXPORT_METHOD(schedule : (NSString *)encoded resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSDictionary *envelope = decode(encoded);
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = envelope[@"content"][@"title"];
  content.body = envelope[@"content"][@"body"];
  content.userInfo = @{@"galinum": envelope};
  content.categoryIdentifier = envelope[@"content"][@"ios"][@"categoryId"] ?: @"";
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:envelope[@"targetId"] content:content trigger:[UNTimeIntervalNotificationTrigger triggerWithTimeInterval:1 repeats:NO]];
  [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) {
    if (error) reject(@"schedule_error", @"schedule_error", nil); else resolve(nil);
  }];
}
RCT_EXPORT_METHOD(delivered : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [UNUserNotificationCenter.currentNotificationCenter getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
    NSMutableArray *rows = [NSMutableArray new];
    for (UNNotification *notification in notifications) [rows addObject:@{@"id": notification.request.identifier, @"category": notification.request.content.categoryIdentifier}];
    resolve(encode(rows));
  }];
}
RCT_EXPORT_METHOD(response : (NSString *)identifier actionId : (NSString *)actionId resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  [UNUserNotificationCenter.currentNotificationCenter getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
    UNNotification *notification;
    for (UNNotification *entry in notifications) if ([entry.request.identifier isEqual:identifier]) notification = entry;
    if (!notification) { reject(@"response_notification_missing", @"response_notification_missing", nil); return; }
    NSString *action = actionId.length ? actionId : UNNotificationDefaultActionIdentifier;
    UNNotificationResponse *response;
    for (NSString *name in @[@"responseWithNotification:actionIdentifier:", @"_responseWithNotification:actionIdentifier:"]) {
      SEL selector = NSSelectorFromString(name);
      if ([UNNotificationResponse respondsToSelector:selector]) {
        response = ((id (*)(id, SEL, id, id))objc_msgSend)(UNNotificationResponse.class, selector, notification, action);
        break;
      }
    }
    if (!response) {
      SEL selector = NSSelectorFromString(@"initWithNotification:actionIdentifier:");
      if ([UNNotificationResponse instancesRespondToSelector:selector])
        response = ((id (*)(id, SEL, id, id))objc_msgSend)([UNNotificationResponse alloc], selector, notification, action);
    }
    if (!response) { reject(@"response_fixture_unavailable", @"response_fixture_unavailable", nil); return; }
    [GalinumNotifications.shared userNotificationCenter:UNUserNotificationCenter.currentNotificationCenter didReceiveNotificationResponse:response withCompletionHandler:^{
      [self event:@"response-completed" data:@{@"requestId": identifier, @"responseClass": NSStringFromClass(response.class)} detail:action];
      resolve(nil);
    }];
  }];
}
RCT_EXPORT_METHOD(receiptBacklog : (NSString *)encoded resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  if (![GalinumReceiptStore prepare]) { reject(@"receipt_fixture_failed", @"receipt_fixture_failed", nil); return; }
  NSDictionary *envelope = decode(encoded);
  NSMutableDictionary *foreign = [envelope mutableCopy];
  foreign[@"installationId"] = [envelope[@"installationId"] stringByAppendingString:@"-foreign"];
  NSString *group = NSBundle.mainBundle.infoDictionary[@"GalinumReceiptAppGroup"];
  NSURL *directory = [[[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:group] URLByAppendingPathComponent:@"GalinumReceipts"];
  NSFileManager *files = NSFileManager.defaultManager;
  NSMutableArray *foreignFiles = [NSMutableArray new];
  for (NSUInteger i = 0; i < 64; i++) {
    NSSet *before = [NSSet setWithArray:[files contentsOfDirectoryAtPath:directory.path error:nil]];
    if (![GalinumReceiptStore capture:foreign]) { reject(@"receipt_fixture_failed", @"receipt_fixture_failed", nil); return; }
    for (NSString *name in [files contentsOfDirectoryAtPath:directory.path error:nil])
      if (![before containsObject:name] && [name hasSuffix:@".receipt"]) [foreignFiles addObject:name];
  }
  for (NSUInteger attempt = 0; attempt < 100; attempt++) {
    NSSet *before = [NSSet setWithArray:[files contentsOfDirectoryAtPath:directory.path error:nil]];
    if (![GalinumReceiptStore capture:envelope]) break;
    NSString *current;
    for (NSString *name in [files contentsOfDirectoryAtPath:directory.path error:nil])
      if (![before containsObject:name] && [name hasSuffix:@".receipt"]) current = name;
    NSUInteger earlier = 0;
    for (NSString *name in foreignFiles) if ([name compare:current] == NSOrderedAscending) earlier++;
    if (earlier >= 32) {
      resolve(encode(@{@"currentFile": current, @"foreignFiles": foreignFiles, @"earlierForeign": @(earlier)}));
      return;
    }
    [GalinumReceiptStore acknowledge:current.stringByDeletingPathExtension];
  }
  reject(@"receipt_fixture_failed", @"receipt_fixture_failed", nil);
}
RCT_EXPORT_METHOD(receiptFiles : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  NSString *group = NSBundle.mainBundle.infoDictionary[@"GalinumReceiptAppGroup"];
  NSURL *directory = [[[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:group] URLByAppendingPathComponent:@"GalinumReceipts"];
  resolve(encode([NSFileManager.defaultManager contentsOfDirectoryAtPath:directory.path error:nil] ?: @[]));
}
RCT_EXPORT_METHOD(nseFallback : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  GalinumNotificationService *service = [GalinumNotificationService new];
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = @"Fallback title";
  content.body = @"Fallback body";
  content.userInfo = @{@"galinum": @{@"version": @1, @"content": @{@"image": @"http://invalid.example/image.png"}}};
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:@"fallback" content:content trigger:nil];
  [service didReceiveNotificationRequest:request withContentHandler:^(UNNotificationContent *result) {
    resolve(encode(@{@"title": result.title, @"body": result.body, @"attachments": @(result.attachments.count)}));
  }];
  [service serviceExtensionTimeWillExpire];
}
RCT_EXPORT_METHOD(installBareDelegate : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    bareDelegate = [GJFixtureDelegate new];
    UNUserNotificationCenter.currentNotificationCenter.delegate = bareDelegate;
    [GalinumNotifications install];
    resolve(nil);
  });
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(forwardedCount) { return @(bareDelegate.foregroundCount); }
RCT_EXPORT_METHOD(scheduleForeign : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = @"Host notification";
  content.body = @"Delegated once";
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:@"host-foreign" content:content trigger:[UNTimeIntervalNotificationTrigger triggerWithTimeInterval:1 repeats:NO]];
  [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) {
    if (error) reject(@"schedule_error", @"schedule_error", nil); else resolve(nil);
  }];
}
RCT_EXPORT_METHOD(receiptProbe : (NSString *)encoded resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  BOOL ready = [GalinumReceiptStore prepare];
  NSDictionary *envelope = decode(encoded);
  BOOL captured = [GalinumReceiptStore capture:envelope];
  NSDictionary *receipt;
  for (NSDictionary *row in [GalinumReceiptStore pendingForInstallation:envelope[@"installationId"]]) if ([row[@"envelope"] isEqual:envelope]) receipt = row;
  if (!ready || !captured || !receipt) { reject(@"receipt_fixture_failed", @"receipt_fixture_failed", nil); return; }
  NSString *group = NSBundle.mainBundle.infoDictionary[@"GalinumReceiptAppGroup"];
  NSURL *directory = [[[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:group] URLByAppendingPathComponent:@"GalinumReceipts"];
  receiptFile = [directory URLByAppendingPathComponent:[receipt[@"id"] stringByAppendingString:@".receipt"]];
  receiptBytes = [NSData dataWithContentsOfURL:receiptFile];
  NSMutableData *tampered = [receiptBytes mutableCopy];
  if (tampered.length) ((uint8_t *)tampered.mutableBytes)[tampered.length - 1] ^= 1;
  [tampered writeToURL:receiptFile atomically:YES];
  BOOL rejected = YES;
  for (NSDictionary *row in [GalinumReceiptStore pendingForInstallation:envelope[@"installationId"]]) if ([row[@"id"] isEqual:receipt[@"id"]]) rejected = NO;
  [receiptBytes writeToURL:receiptFile atomically:YES];
  NSData *plain = [envelope[@"targetId"] dataUsingEncoding:NSUTF8StringEncoding];
  BOOL encrypted = [receiptBytes rangeOfData:plain options:0 range:NSMakeRange(0, receiptBytes.length)].location == NSNotFound;
  resolve(encode(@{@"ready": @(ready), @"captured": @(captured), @"encrypted": @(encrypted), @"tamperRejected": @(rejected), @"id": receipt[@"id"]}));
}
RCT_EXPORT_METHOD(restoreReceipt : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject) {
  if (!receiptBytes || ![receiptBytes writeToURL:receiptFile atomically:YES]) { reject(@"receipt_fixture_failed", @"receipt_fixture_failed", nil); return; }
  resolve(nil);
}
@end
