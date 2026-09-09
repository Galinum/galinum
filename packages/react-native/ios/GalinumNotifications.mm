#import "GalinumNotifications.h"
#import "GalinumJournalIngress.h"
#import <UIKit/UIKit.h>
#import "GalinumReceiptBridge.h"

@interface GalinumNotifications ()
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> previous;
@end

static NSArray<NSString *> *staleIdentifiers(NSArray<UNNotificationRequest *> *requests, BOOL (^stale)(UNNotificationRequest *)) {
  NSMutableArray *identifiers = [NSMutableArray new];
  for (UNNotificationRequest *request in requests) if (stale(request)) [identifiers addObject:request.identifier];
  return identifiers;
}
static void cancellationPass(UNUserNotificationCenter *center, BOOL (^stale)(UNNotificationRequest *), BOOL (^authorize)(dispatch_block_t), void (^completion)(NSUInteger, BOOL), NSMutableSet *removed, NSUInteger remaining) {
  [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *pending) {
    NSArray *pendingIds = staleIdentifiers(pending, stale);
    if (!authorize(^{ [center removePendingNotificationRequestsWithIdentifiers:pendingIds]; })) { completion(removed.count, NO); return; }
    [removed addObjectsFromArray:pendingIds];
    [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *delivered) {
      NSArray *deliveredIds = staleIdentifiers([delivered valueForKey:@"request"], stale);
      if (!authorize(^{ [center removeDeliveredNotificationsWithIdentifiers:deliveredIds]; })) { completion(removed.count, NO); return; }
      [removed addObjectsFromArray:deliveredIds];
      [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *pendingAfter) {
        [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *deliveredAfter) {
          if (!authorize(^{})) { completion(removed.count, NO); return; }
          BOOL clean = staleIdentifiers(pendingAfter, stale).count == 0 && staleIdentifiers([deliveredAfter valueForKey:@"request"], stale).count == 0;
          if (!clean && remaining > 1) cancellationPass(center, stale, authorize, completion, removed, remaining - 1);
          else completion(removed.count, clean);
        }];
      }];
    }];
  }];
}

@implementation GalinumNotifications
static void onMain(dispatch_block_t block) {
  if (NSThread.isMainThread) block(); else dispatch_async(dispatch_get_main_queue(), block);
}
+ (void)load {
  [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidFinishLaunchingNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(NSNotification *note) {
                                                  [self install];
                                                }];
  GalinumJournalSetClaimObserver(^(NSString *scope) {
    if (NSThread.isMainThread) [self install];
    else dispatch_async(dispatch_get_main_queue(), ^{ [self install]; });
  });
}
+ (instancetype)shared {
  static GalinumNotifications *value;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ value = [GalinumNotifications new]; });
  return value;
}
+ (void)install {
  Class expo = NSClassFromString(@"ExpoNotifications.NotificationCenterManager");
  if ([expo respondsToSelector:@selector(shared)]) [expo performSelector:@selector(shared)];
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  GalinumNotifications *shared = [self shared];
  if (center.delegate == shared) return;
  shared.previous = center.delegate;
  center.delegate = shared;
}
+ (BOOL)serviceExtensionPresent {
  NSURL *plugins = NSBundle.mainBundle.builtInPlugInsURL;
  for (NSURL *item in [[NSFileManager defaultManager] contentsOfDirectoryAtURL:plugins includingPropertiesForKeys:nil options:0 error:nil]) {
    NSDictionary *info = [NSBundle bundleWithURL:item].infoDictionary;
    if ([info[@"NSExtension"][@"NSExtensionPointIdentifier"] isEqual:@"com.apple.usernotifications.service"] &&
        [info[@"GalinumNotificationService"] boolValue] &&
        [info[@"GalinumReceiptAppGroup"] isEqual:NSBundle.mainBundle.infoDictionary[@"GalinumReceiptAppGroup"]] &&
        [info[@"GalinumReceiptKeychainGroup"] isEqual:NSBundle.mainBundle.infoDictionary[@"GalinumReceiptKeychainGroup"]]) return YES;
  }
  return NO;
}
+ (NSDictionary *)setup:(NSDictionary *)setup replacing:(NSArray *)prior {
  if (NSThread.isMainThread) [self install]; else dispatch_sync(dispatch_get_main_queue(), ^{ [self install]; });
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.galinum.notification-setup", DISPATCH_QUEUE_SERIAL); });
  __block NSDictionary *result;
  __block NSException *failure;
  dispatch_sync(queue, ^{
    @try { result = [self performSetup:setup replacing:prior]; }
    @catch (NSException *error) { failure = error; }
  });
  if (failure) @throw failure;
  return result;
}
+ (NSDictionary *)performSetup:(NSDictionary *)setup replacing:(NSArray *)prior {
  void (^invalid)(void) = ^{ @throw [NSException exceptionWithName:@"invalid_setup" reason:@"invalid_setup" userInfo:nil]; };
  if (![setup[@"actions"] isKindOfClass:NSArray.class] || (setup[@"categories"] && ![setup[@"categories"] isKindOfClass:NSArray.class])) invalid();
  NSMutableDictionary<NSString *, NSDictionary *> *known = [NSMutableDictionary new];
  for (id action in setup[@"actions"]) {
    if (![action isKindOfClass:NSDictionary.class] || ![action[@"id"] isKindOfClass:NSString.class] || ![action[@"title"] isKindOfClass:NSString.class] || ![action[@"id"] length] || ![action[@"title"] length] || known[action[@"id"]]) invalid();
    known[action[@"id"]] = action;
  }
  NSMutableSet<UNNotificationCategory *> *categories = [NSMutableSet new];
  NSMutableArray *advertised = [NSMutableArray new], *actionIds = [NSMutableArray new];
  NSMutableSet *identifiers = [NSMutableSet new];
  for (id category in setup[@"categories"]) {
    if (![category isKindOfClass:NSDictionary.class] || ![category[@"id"] isKindOfClass:NSString.class] || ![category[@"id"] length] || ![category[@"actions"] isKindOfClass:NSArray.class] || [category[@"actions"] count] > 4 || [identifiers containsObject:category[@"id"]]) invalid();
    [identifiers addObject:category[@"id"]];
    NSMutableArray<UNNotificationAction *> *actions = [NSMutableArray new];
    NSMutableArray *composed = [NSMutableArray new];
    NSMutableSet *used = [NSMutableSet new];
    for (id identifier in category[@"actions"]) {
      NSDictionary *action = [identifier isKindOfClass:NSString.class] ? known[identifier] : nil;
      if (!action || [used containsObject:identifier]) invalid();
      [used addObject:identifier];
      [actions addObject:[UNNotificationAction actionWithIdentifier:identifier title:action[@"title"] options:UNNotificationActionOptionForeground]];
      [composed addObject:@{@"id": identifier, @"title": action[@"title"]}];
      if (![actionIds containsObject:identifier]) [actionIds addObject:identifier];
    }
    [categories addObject:[UNNotificationCategory categoryWithIdentifier:category[@"id"] actions:actions intentIdentifiers:@[] options:0]];
    [advertised addObject:@{@"id": category[@"id"], @"actions": composed}];
  }
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSSet *existing;
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getNotificationCategoriesWithCompletionHandler:^(NSSet<UNNotificationCategory *> *value) { existing = value; dispatch_semaphore_signal(done); }];
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) invalid();
  for (UNNotificationCategory *category in existing)
    if (![prior containsObject:category.identifier]) {
      if ([identifiers containsObject:category.identifier]) invalid();
      [categories addObject:category];
    }
  [center setNotificationCategories:categories];
  return @{@"actions": actionIds, @"channels": @[], @"richImages": @([self serviceExtensionPresent] && [GalinumReceiptStore prepare]), @"categories": advertised};
}
+ (void)cancelForInstallation:(NSString *)installationId throughGeneration:(NSNumber *)through keepingGenerations:(NSSet<NSNumber *> *)generations authorize:(BOOL (^)(dispatch_block_t))authorize completion:(void (^)(NSUInteger, BOOL))completion {
  BOOL (^stale)(UNNotificationRequest *) = ^BOOL(UNNotificationRequest *request) {
    NSDictionary *envelope = GalinumJournalParseEnvelope(request.content.userInfo);
    return [envelope[@"installationId"] isEqual:installationId] && [envelope[@"bindingGeneration"] longLongValue] <= through.longLongValue && ![generations containsObject:envelope[@"bindingGeneration"]];
  };
  cancellationPass(UNUserNotificationCenter.currentNotificationCenter, stale, authorize, completion, [NSMutableSet new], 3);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  NSDictionary *envelope = GalinumJournalParseEnvelope(notification.request.content.userInfo);
  if (!envelope) {
    if (notification.request.content.userInfo[@"galinum"]) { completionHandler(UNNotificationPresentationOptionNone); return; }
    id<UNUserNotificationCenterDelegate> previous = self.previous;
    if ([previous respondsToSelector:_cmd]) [previous userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completionHandler];
    else completionHandler(UNNotificationPresentationOptionNone);
    return;
  }
  __block BOOL handedOff = NO;
  GalinumJournalPresent(envelope, ^{
    handedOff = YES;
    onMain(^{ completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound | UNNotificationPresentationOptionBadge); });
  }, ^(NSDictionary *result, NSString *code) {
    if (!handedOff) onMain(^{ completionHandler(UNNotificationPresentationOptionNone); });
  });
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
  NSDictionary *envelope = GalinumJournalParseEnvelope(response.notification.request.content.userInfo);
  if (!envelope) {
    if (response.notification.request.content.userInfo[@"galinum"]) { completionHandler(); return; }
    id<UNUserNotificationCenterDelegate> previous = self.previous;
    if ([previous respondsToSelector:_cmd]) [previous userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completionHandler];
    else completionHandler();
    return;
  }
  NSString *identifier = response.actionIdentifier;
  if ([identifier isEqual:UNNotificationDismissActionIdentifier]) { completionHandler(); return; }
  NSString *actionId = [identifier isEqual:UNNotificationDefaultActionIdentifier] ? nil : identifier;
  GalinumJournalCaptureResponse(envelope, response.notification.request.identifier, actionId, ^(NSDictionary *result, NSString *code) { onMain(completionHandler); });
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center openSettingsForNotification:(UNNotification *)notification {
  id<UNUserNotificationCenterDelegate> previous = self.previous;
  if ([previous respondsToSelector:_cmd]) [previous userNotificationCenter:center openSettingsForNotification:notification];
}
@end
