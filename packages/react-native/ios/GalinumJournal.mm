#import "GalinumJournal.h"
#import <Security/Security.h>
#import <SQLCipher/sqlite3.h>
#import "GalinumJournalHooks.h"
#import "GalinumJournalIngress.h"
#import "GalinumJournalInspection.h"
#import "GalinumJournalText.h"
#import "GalinumNotifications.h"
#import "GalinumReceiptBridge.h"

static id<GalinumJournalHooks> hooks;
static void (^claimObserver)(NSString *);
void GalinumJournalSetHooks(id<GalinumJournalHooks> value) {
  @synchronized(GalinumJournal.class) {
    hooks = value;
  }
}
void GalinumJournalSetClaimObserver(void (^observer)(NSString *)) {
  @synchronized(GalinumJournal.class) {
    claimObserver = [observer copy];
  }
}
static void checkpoint(NSString *point) {
  id<GalinumJournalHooks> current;
  @synchronized(GalinumJournal.class) {
    current = hooks;
  }
  if ([current respondsToSelector:@selector(checkpoint:)]) [current checkpoint:point];
}
static void record(NSString *kind, NSDictionary *data, NSString *detail) {
  id<GalinumJournalHooks> current;
  @synchronized(GalinumJournal.class) {
    current = hooks;
  }
  if ([current respondsToSelector:@selector(event:data:detail:)])
    [current event:kind data:data ?: @{} detail:detail ?: @""];
}
static void fail(NSString *code) {
  @throw [NSException exceptionWithName:code reason:code userInfo:nil];
}
static NSString *json(id value) {
  NSError *error;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                 options:NSJSONWritingSortedKeys
                                                   error:&error];
  if (!data) fail(@"invalid_event");
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
static NSMutableDictionary *object(NSString *value) {
  id result = [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding]
                                              options:NSJSONReadingMutableContainers
                                                error:nil];
  if (![result isKindOfClass:NSDictionary.class]) fail(@"invalid_event");
  return result;
}

@interface GJTicket : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *eventId;
@property double intent;
@property(nonatomic, copy) NSDictionary *event;
@property(nonatomic, copy) NSDictionary *observation;
@property long long observationOrdinal;
@property BOOL rejected;
@property(nonatomic, strong) NSMutableArray *waiters;
@end
@implementation GJTicket
@end

@interface GJProposal : NSObject
@property(nonatomic, copy) NSString *identifier, *userId, *operationId;
@property long long fence, controlRevision;
@property double deadline;
@end
@implementation GJProposal
@end

@interface GJActor : NSObject {
 @public
  sqlite3 *db;
}
@property(nonatomic, copy) NSString *owner;
@property(nonatomic, copy) NSString *scope;
@property(nonatomic, copy) NSString *incarnation;
@property(nonatomic, strong) NSURL *file;
@property(nonatomic, strong) NSURL *registry;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) NSMutableArray<GJTicket *> *tickets;
@property(nonatomic, strong) NSMutableDictionary<NSString *, GJProposal *> *proposals;
@property(nonatomic, copy) NSDictionary *binding;
@property(nonatomic, copy) void (^interactionListener)(NSString *);
@property double intent;
@property unsigned long long ordinal;
@property unsigned long long proposalOrdinal;
@property unsigned long long submittedCount;
@property long long lastOperation;
@property NSInteger inFlight, nativeJobs;
@property BOOL needsNotificationCleanup, notificationCleanupActive;
@property NSUInteger notificationCleanupEpoch;
@property long long displayFence, restrictions;
@property BOOL displayOpen;
@property BOOL ready;
@property BOOL released;
@property BOOL initialResolved;
- (void)drain;
- (void)notifyInteraction;
- (void)bootstrap;
- (void)bootstrapStorage;
- (void)requireNotificationCleanup:(NSDictionary *)control clear:(BOOL)clear;
- (void)importReceipts;
- (NSDictionary *)controlRow;
- (NSDictionary *)submitIfCurrent:(GalinumJournalSubmission)submission;
- (NSString *)receive:(NSDictionary *)envelope ticket:(GJTicket *)ticket foreground:(BOOL)foreground submission:(dispatch_block_t)submission;
- (GJTicket *)reserveIngress:(NSDictionary *)envelope kind:(NSString *)kind actionId:(NSString *)actionId;
- (void)captureInteraction:(NSDictionary *)envelope responseId:(NSString *)responseId actionId:(NSString *)actionId ticket:(GJTicket *)placeholder completion:(void (^)(NSDictionary *))completion;
- (NSDictionary *)settings;
- (void)cleanupNotifications;
@end
@class GalinumJournal;
@interface GalinumJournal ()
- (void)detach:(GJActor *)value dispose:(BOOL)dispose resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
@end
static NSString *processIncarnation;
static NSString *hex(NSUInteger length) {
  uint8_t random[32];
  if (length > sizeof random) fail(@"journal_storage_failure");
  if (SecRandomCopyBytes(kSecRandomDefault, length, random) != errSecSuccess) fail(@"journal_storage_failure");
  NSMutableString *value = [NSMutableString new];
  for (NSUInteger i = 0; i < length; i++) [value appendFormat:@"%02x", random[i]];
  return value;
}
static long long now(void) { return (long long)([NSDate date].timeIntervalSince1970 * 1000); }

@implementation GJActor
- (void)check:(double)intent {
  @synchronized(self) {
    if (self.released || intent != self.intent) fail(@"superseded");
  }
}
- (void)lease:(NSString *)owner {
  @synchronized(self) {
    if (self.released || ![owner isEqual:self.owner]) fail(@"journal_owner_stale");
  }
}
- (NSString *)attach {
  @synchronized(self) {
    if (!self.released || self.inFlight > 0) fail(@"journal_writer_busy");
    self.owner = NSUUID.UUID.UUIDString;
    self.lastOperation = 0;
    self.released = NO;
    self.intent = 0;
    self.initialResolved = NO;
    self.ready = NO;
    self.binding = nil;
    self.displayFence++;
    for (GJTicket *ticket in self.tickets) ticket.rejected = YES;
    [self.proposals removeAllObjects];
  }
  record(@"attach", @{}, self.owner);
  dispatch_async(self.queue, ^{
    [self drain];
  });
  return self.owner;
}
- (NSNumber *)restrictDisplay {
  @synchronized(self) {
    self.displayOpen = NO;
    self.displayFence++;
    self.restrictions++;
    record(@"restrict-display", @{}, [NSString stringWithFormat:@"%lld", self.displayFence]);
    return @(self.displayFence);
  }
}
- (NSString *)proposeDisplay:(NSString *)encoded {
  @synchronized(self) {
    if (self.released) fail(@"journal_owner_stale");
    NSDictionary *proposal = object(encoded);
    NSNumber *deadlineMs = proposal[@"deadlineMs"], *revision = proposal[@"controlRevision"];
    NSString *user = proposal[@"userId"], *operation = proposal[@"operationId"];
    if (![deadlineMs isKindOfClass:NSNumber.class] || ![revision isKindOfClass:NSNumber.class] ||
        ![user isKindOfClass:NSString.class] || ![operation isKindOfClass:NSString.class])
      fail(@"invalid_proposal");
    GJProposal *entry = [GJProposal new];
    entry.identifier =
        [NSString stringWithFormat:@"%@:proposal:%llu", self.owner, ++self.proposalOrdinal];
    entry.fence = self.displayFence;
    entry.deadline = [NSDate timeIntervalSinceReferenceDate] + deadlineMs.doubleValue / 1000.0;
    entry.controlRevision = revision.longLongValue;
    entry.userId = user;
    entry.operationId = operation;
    self.proposals[entry.identifier] = entry;
    record(@"propose-display", @{@"fence" : @(entry.fence)}, entry.identifier);
    return entry.identifier;
  }
}
- (void)opened {
  if (!db) fail(@"journal_not_open");
  if (self.needsNotificationCleanup) [self cleanupNotifications];
}
- (NSArray *)sql:(NSString *)sql values:(NSArray *)values {
  sqlite3_stmt *statement = nullptr;
  int rc = sqlite3_prepare_v2(db, sql.UTF8String, -1, &statement, nullptr);
  if (rc != SQLITE_OK) {
    record(@"sql-failed", @{@"sqlite": @(rc), @"statement": sql, @"reason": @(sqlite3_errmsg(db))}, @"prepare");
    fail(rc == SQLITE_FULL ? @"journal_storage_full" : @"journal_storage_failure");
  }
  @try {
    for (NSUInteger i = 0; i < values.count; i++) {
      id value = values[i];
      rc = value == NSNull.null ? sqlite3_bind_null(statement, (int)i + 1)
           : [value isKindOfClass:NSNumber.class]
               ? sqlite3_bind_int64(statement, (int)i + 1, [value longLongValue])
               : GJBindText(statement, (int)i + 1, value);
      if (rc != SQLITE_OK) fail(@"journal_storage_failure");
    }
    NSMutableArray *rows = [NSMutableArray new];
    while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
      NSMutableArray *row = [NSMutableArray new];
      for (int i = 0; i < sqlite3_column_count(statement); i++) {
        int type = sqlite3_column_type(statement, i);
        [row addObject:type == SQLITE_NULL ? NSNull.null
                       : type == SQLITE_INTEGER
                           ? @(sqlite3_column_int64(statement, i))
                           : GJReadText(statement, i)];
      }
      [rows addObject:row];
    }
    if (rc != SQLITE_DONE) {
      record(@"sql-failed", @{@"sqlite": @(rc), @"statement": sql, @"reason": @(sqlite3_errmsg(db))}, @"step");
      fail(rc == SQLITE_FULL ? @"journal_storage_full" : @"journal_storage_failure");
    }
    return rows;
  } @finally {
    sqlite3_finalize(statement);
  }
}
- (id)transaction:(id (^)(void))body {
  [self sql:@"BEGIN IMMEDIATE" values:@[]];
  @try {
    id value = body();
    [self sql:@"COMMIT" values:@[]];
    return value;
  } @catch (NSException *primary) {
    @try {
      [self sql:@"ROLLBACK" values:@[]];
    } @catch (NSException *cleanup) {
    } @throw primary;
  }
}
- (long long)number:(NSString *)sql generation:(NSNumber *)generation {
  NSArray *rows = [self sql:sql values:generation ? @[ generation ] : @[]];
  if (rows.count != 1) fail(@"journal_corrupt");
  return [rows[0][0] longLongValue];
}
- (NSString *)reserve:(double)intent eventId:(NSString *)eventId {
  @synchronized(self) {
    [self check:intent];
    for (GJTicket *prior in self.tickets)
      if (!prior.rejected && prior.intent == intent && eventId.length &&
          [prior.eventId isEqual:eventId])
        return json(@{@"id" : prior.identifier, @"eventId" : prior.eventId, @"reused" : @YES});
    GJTicket *ticket = [GJTicket new];
    ticket.identifier = [NSString stringWithFormat:@"%@:%llu", self.owner, ++self.ordinal];
    ticket.eventId = eventId.length ? eventId : ticket.identifier;
    ticket.intent = intent;
    ticket.waiters = [NSMutableArray new];
    [self.tickets addObject:ticket];
    record(@"reserve", @{@"ordinal" : @(self.ordinal), @"eventId" : ticket.eventId}, ticket.identifier);
    return json(@{@"id" : ticket.identifier, @"eventId" : ticket.eventId});
  }
}
- (NSString *)reserveObservation:(NSDictionary *)observation {
  NSDictionary *immutable = object(json(observation));
  if (![immutable[@"targetId"] isKindOfClass:NSString.class] ||
      ![immutable[@"attemptId"] isKindOfClass:NSString.class] ||
      ![immutable[@"installationId"] isKindOfClass:NSString.class] ||
      ![immutable[@"bindingGeneration"] isKindOfClass:NSNumber.class])
    fail(@"invalid_observation");
  @synchronized(self) {
    if (self.released) fail(@"journal_owner_stale");
    GJTicket *ticket = [GJTicket new];
    ticket.identifier = [NSString stringWithFormat:@"%@:%llu", self.owner, ++self.ordinal];
    ticket.eventId = ticket.identifier;
    ticket.intent = self.intent;
    ticket.waiters = [NSMutableArray new];
    ticket.observation = immutable;
    ticket.observationOrdinal = -2;
    [self.tickets addObject:ticket];
    record(@"reserve-native", @{@"ordinal" : @(self.ordinal)}, ticket.identifier);
    dispatch_async(self.queue, ^{
      [self drain];
    });
    return ticket.identifier;
  }
}
- (GJTicket *)reserveIngress:(NSDictionary *)envelope kind:(NSString *)kind actionId:(NSString *)actionId {
  NSDictionary *observation = @{
    @"kind" : kind,
    @"targetId" : envelope[@"targetId"],
    @"attemptId" : envelope[@"attemptId"],
    @"installationId" : envelope[@"installationId"],
    @"bindingGeneration" : envelope[@"bindingGeneration"],
    @"actionId" : actionId ?: NSNull.null
  };
  @synchronized(self) {
    if (self.released) {
      record(@"reserve-ingress", @{@"kind" : kind, @"memory" : @NO}, envelope[@"targetId"]);
      return nil;
    }
    GJTicket *ticket = [GJTicket new];
    ticket.identifier = [NSString stringWithFormat:@"%@:%llu", self.owner, ++self.ordinal];
    ticket.eventId = ticket.identifier;
    ticket.intent = self.intent;
    ticket.waiters = [NSMutableArray new];
    ticket.observation = observation;
    ticket.observationOrdinal = -1;
    [self.tickets addObject:ticket];
    record(@"reserve-ingress", @{@"kind" : kind, @"memory" : @YES, @"ordinal" : @(self.ordinal)}, ticket.identifier);
    return ticket;
  }
}
- (NSDictionary *)bindingProof {
  NSArray *rows = [self sql:@"SELECT binding FROM metadata WHERE id=1" values:@[]];
  return rows.count && rows[0][0] != NSNull.null ? object(rows[0][0]) : nil;
}
static BOOL bindingCurrent(NSDictionary *proof, NSDictionary *control, NSString *installationId, NSNumber *generation, id user) {
  if (!proof || !control || user == NSNull.null || !user) return NO;
  NSDictionary *state = control[@"state"], *session = state[@"session"];
  return [proof[@"installationId"] isEqual:installationId] && [proof[@"generation"] isEqual:generation] &&
         [proof[@"userId"] isEqual:user] && [session[@"userId"] isEqual:user] &&
         state[@"acknowledgedBindingRevision"] != NSNull.null &&
         [state[@"acknowledgedBindingRevision"] isEqual:state[@"bindingRevision"]];
}
- (long long)insertObservation:(NSString *)kind ticket:(GJTicket *)ticket envelope:(NSDictionary *)envelope actionId:(NSString *)actionId user:(id)user controlRevision:(id)revision current:(BOOL)current {
  [self sql:@"INSERT INTO observations(process,ticket,kind,target_id,attempt_id,action_id,installation_id,binding_generation,user_id,control_revision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      values:@[ processIncarnation, ticket ? ticket.identifier : NSNull.null, kind, envelope[@"targetId"], envelope[@"attemptId"], actionId ?: NSNull.null, envelope[@"installationId"], envelope[@"bindingGeneration"], user ?: NSNull.null, revision ?: NSNull.null, current ? @"pending" : @"retired", @(now()) ]];
  return [self number:@"SELECT last_insert_rowid()" generation:nil];
}
- (void)bindTicket:(GJTicket *)ticket ordinal:(long long)ordinal user:(id)user current:(BOOL)current {
  if (!ticket) return;
  @synchronized(self) {
    if (!current) {
      ticket.rejected = YES;
      return;
    }
    NSMutableDictionary *observation = [ticket.observation mutableCopy];
    observation[@"ordinal"] = @(ordinal);
    observation[@"userId"] = user;
    ticket.observation = observation;
    ticket.observationOrdinal = ordinal;
  }
}
- (NSDictionary *)settings {
  NSArray *rows = [self sql:@"SELECT foreground,channels,actions,categories FROM settings WHERE id=1" values:@[]];
  if (!rows.count) return @{@"foreground" : @"display", @"channels" : @[], @"actions" : @[], @"categories" : @[]};
  id channels = [NSJSONSerialization JSONObjectWithData:[rows[0][1] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  id actions = [NSJSONSerialization JSONObjectWithData:[rows[0][2] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  id categories = [NSJSONSerialization JSONObjectWithData:[rows[0][3] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  return @{@"foreground" : rows[0][0], @"channels" : channels ?: @[], @"actions" : actions ?: @[], @"categories" : categories ?: @[]};
}
- (NSString *)displayReason:(NSDictionary *)control envelope:(NSDictionary *)envelope foreground:(BOOL)foreground {
  if (![control[@"state"][@"session"][@"consent"] boolValue]) return @"no-consent";
  if (control[@"publication"] == NSNull.null) return @"closed-on-disk";
  @synchronized(self) {
    if (!self.displayOpen) return @"memory-closed";
    if (foreground && (!self.ready || ![self.binding[@"appConfirmed"] boolValue])) return @"identity-unconfirmed";
  }
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block BOOL enabled = NO;
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    enabled = settings.authorizationStatus == UNAuthorizationStatusAuthorized || settings.authorizationStatus == UNAuthorizationStatusProvisional || settings.authorizationStatus == UNAuthorizationStatusEphemeral;
    dispatch_semaphore_signal(done);
  }];
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) || !enabled) return @"notifications-disabled";
  if (foreground && [[self settings][@"foreground"] isEqual:@"suppress"]) return @"foreground-suppressed";
  return nil;
}
- (NSString *)receive:(NSDictionary *)envelope ticket:(GJTicket *)ticket foreground:(BOOL)foreground submission:(dispatch_block_t)handoff {
  NSMutableDictionary *result = [@{@"targetId" : envelope[@"targetId"], @"pid" : @(getpid())} mutableCopy];
  @try {
    [self bootstrapStorage];
    NSDictionary *control = [self controlRow];
    NSDictionary *proof = [self bindingProof];
    id user = control ? control[@"state"][@"session"][@"userId"] : NSNull.null;
    BOOL current = bindingCurrent(proof, control, envelope[@"installationId"], envelope[@"bindingGeneration"], user);
    long long ordinal = [[self transaction:^id {
      return @([self insertObservation:@"receipt" ticket:ticket envelope:envelope actionId:nil user:user controlRevision:control ? control[@"revision"] : nil current:current]);
    }] longLongValue];
    [self bindTicket:ticket ordinal:ordinal user:user current:current];
    result[@"ordinal"] = @(ordinal);
    result[@"receipt"] = current ? @"pending" : @"retired";
    record(@"ingress-receipt", result, envelope[@"targetId"]);
    if (!current) {
      [self drain];
      result[@"state"] = @"suppressed";
      result[@"reason"] = @"binding_mismatch";
      return json(result);
    }
    [self opened];
    NSString *reason = [self displayReason:control envelope:envelope foreground:foreground];
    if (reason) {
      record(@"display-suppressed", @{@"reason" : reason}, envelope[@"targetId"]);
      [self drain];
      result[@"state"] = @"suppressed";
      result[@"reason"] = reason;
      return json(result);
    }
    long long fence;
    @synchronized(self) {
      fence = self.displayFence;
    }
    NSString *fenceText = [NSString stringWithFormat:@"%lld", fence];
    record(@"submission-evaluated", control[@"publication"], fenceText);
    checkpoint(@"submission-gap");
    result[@"state"] = @"evaluated";
    result[@"fence"] = @(fence);
    [self drain];
    return json(result);
  } @catch (NSException *failure) {
    if (ticket) @synchronized(self) {
        ticket.rejected = YES;
      }
    record(@"ingress-failed", @{@"code" : failure.name}, envelope[@"targetId"]);
    @throw failure;
  }
}
- (void)captureInteraction:(NSDictionary *)envelope responseId:(NSString *)responseId actionId:(NSString *)actionId ticket:(GJTicket *)placeholder completion:(void (^)(NSDictionary *))completion {
  NSString *kind = actionId ? @"action" : @"tap";
  @synchronized(self) { self.nativeJobs++; }
  dispatch_async(self.queue, ^{
    NSDictionary *outcome;
    @try {
      checkpoint(@"capture-before-bootstrap");
      [self bootstrapStorage];
      NSString *responseKey = json(@[envelope[@"installationId"], envelope[@"bindingGeneration"], responseId, envelope[@"targetId"], envelope[@"attemptId"], actionId ?: NSNull.null]);
      NSArray *prior = [self sql:@"SELECT id,ordinal,status FROM interactions WHERE response_key=?" values:@[responseKey]];
      if (prior.count) {
        @synchronized(self) { placeholder.rejected = YES; }
        outcome = @{@"state": @"reused", @"interactionId": prior[0][0], @"ordinal": prior[0][1], @"disposition": prior[0][2], @"pid": @(getpid())};
        record(@"interaction-reused", outcome, prior[0][0]);
        [self drain];
      } else {
        BOOL known = actionId == nil;
        for (NSDictionary *action in envelope[@"content"][@"actions"])
          if ([action isKindOfClass:NSDictionary.class] && [action[@"id"] isEqual:actionId]) known = YES;
        if (actionId) {
          BOOL registered = NO;
          for (NSDictionary *category in [self settings][@"categories"])
            if ([category[@"id"] isEqual:envelope[@"content"][@"ios"][@"categoryId"]] && [category[@"actions"] containsObject:actionId]) registered = YES;
          known = known && registered;
        }
        if (!known) {
          @synchronized(self) {
            placeholder.rejected = YES;
          }
          record(@"interaction-invalid", @{@"action" : actionId}, envelope[@"targetId"]);
          [self drain];
          outcome = @{@"state" : @"invalid"};
        } else {
          NSDictionary *control = [self controlRow];
          NSDictionary *proof = [self bindingProof];
          id user = control ? control[@"state"][@"session"][@"userId"] : NSNull.null;
          BOOL current = bindingCurrent(proof, control, envelope[@"installationId"], envelope[@"bindingGeneration"], user);
          if (placeholder) @synchronized(self) {
              placeholder.observation = @{
                @"kind" : kind,
                @"targetId" : envelope[@"targetId"],
                @"attemptId" : envelope[@"attemptId"],
                @"installationId" : envelope[@"installationId"],
                @"bindingGeneration" : envelope[@"bindingGeneration"],
                @"actionId" : actionId ?: NSNull.null
              };
            }
          NSString *interactionId = hex(16);
          long long at = now();
          long long ordinal = [[self transaction:^id {
            long long inserted = [self insertObservation:kind ticket:placeholder envelope:envelope actionId:actionId user:user controlRevision:control ? control[@"revision"] : nil current:current];
            [self sql:@"INSERT INTO interactions(id,ordinal,kind,action_id,target_id,attempt_id,user_id,binding_generation,envelope,received_at,interacted_at,status,response_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
                values:@[ interactionId, @(inserted), kind, actionId ?: NSNull.null, envelope[@"targetId"], envelope[@"attemptId"], user ?: NSNull.null, envelope[@"bindingGeneration"], json(envelope), @(at), @(at), current ? @"pending" : @"retired", responseKey ]];
            return @(inserted);
          }] longLongValue];
          checkpoint(@"capture-commit-after");
          [self bindTicket:placeholder ordinal:ordinal user:user current:current];
          outcome = @{@"state" : current ? @"captured" : @"retired", @"kind" : kind, @"ordinal" : @(ordinal), @"interactionId" : interactionId, @"pid" : @(getpid())};
          record(@"interaction-captured", outcome, interactionId);
          [self drain];
        }
      }
    } @catch (NSException *error) {
      @synchronized(self) {
        placeholder.rejected = YES;
      }
      outcome = @{@"state" : @"failed", @"code" : error.name};
      record(@"interaction-failed", outcome, envelope[@"targetId"]);
    } @finally {
      @synchronized(self) {
        self.nativeJobs--;
      }
    }
    if (completion) completion(outcome);
  });
}
- (NSNumber *)setCapturedIntent:(double)intent {
  long long fence;
  @synchronized(self) {
    if (intent < self.intent) fail(@"superseded");
    self.intent = intent;
    self.ready = NO;
    self.displayOpen = NO;
    self.displayFence++;
    self.restrictions++;
    fence = self.displayFence;
    for (GJTicket *ticket in self.tickets)
      if (ticket.intent < intent && (ticket.intent != 0 || self.initialResolved))
        ticket.rejected = YES;
  }
  record(@"set-intent", @{}, [NSString stringWithFormat:@"%.0f", intent]);
  dispatch_async(self.queue, ^{
    [self drain];
  });
  return @(fence);
}
- (void)work:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject
        body:(id (^)(void))body {
  @synchronized(self) {
    self.inFlight++;
  }
  dispatch_async(self.queue, ^{
    @try {
      checkpoint(@"executor");
      resolve(body());
    } @catch (NSException *error) {
      reject(error.name, error.name, nil);
    } @finally {
      @synchronized(self) {
        self.inFlight--;
      }
    }
  });
}
- (NSMutableDictionary *)keychainQuery {
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @"com.galinum.journal.key",
    (__bridge id)kSecAttrAccount : self.scope,
  } mutableCopy];
}
- (NSData *)readKey {
  NSMutableDictionary *query = [self keychainQuery];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) return nil;
  if (status == errSecInteractionNotAllowed) fail(@"journal_key_unavailable");
  if (status != errSecSuccess) fail(@"journal_key_unavailable");
  NSData *key = (__bridge_transfer NSData *)result;
  if (key.length != 32) fail(@"journal_corrupt");
  return key;
}
- (NSData *)createKey {
  uint8_t bytes[32];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof bytes, bytes) != errSecSuccess)
    fail(@"journal_storage_failure");
  NSData *key = [NSData dataWithBytes:bytes length:sizeof bytes];
  NSMutableDictionary *item = [self keychainQuery];
  item[(__bridge id)kSecValueData] = key;
  item[(__bridge id)kSecAttrAccessible] =
      (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, nullptr);
  if (status != errSecSuccess) fail(@"journal_key_unavailable");
  return key;
}
- (NSDictionary *)readRegistry {
  if (![[NSFileManager defaultManager] fileExistsAtPath:self.registry.path]) return nil;
  NSData *data = [NSData dataWithContentsOfURL:self.registry];
  id value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![value isKindOfClass:NSDictionary.class] || [value[@"schema"] intValue] != 2 ||
      [value[@"incarnation"] length] != 32)
    fail(@"journal_corrupt");
  return value;
}
- (void)writeRegistry:(NSDictionary *)registry {
  NSError *error;
  NSData *data = [NSJSONSerialization dataWithJSONObject:registry options:0 error:&error];
  if (!data || ![data writeToURL:self.registry options:NSDataWritingAtomic error:&error])
    fail(@"journal_storage_failure");
  [self.registry setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}
- (void)bootstrap {
  [self bootstrapStorage];
  [self opened];
}
- (void)bootstrapStorage {
  if (db) return;
  checkpoint(@"bootstrap");
  NSURL *directory = [self.file URLByDeletingLastPathComponent];
  NSError *error;
  if (![[NSFileManager defaultManager]
                 createDirectoryAtURL:directory
          withIntermediateDirectories:YES
                           attributes:@{
                             NSFileProtectionKey :
                                 NSFileProtectionCompleteUntilFirstUserAuthentication
                           }
                                error:&error])
    fail(@"journal_storage_failure");
  if (![directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error])
    fail(@"journal_storage_failure");
  NSMutableDictionary *registry = [[self readRegistry] mutableCopy];
  BOOL dbExists = [[NSFileManager defaultManager] fileExistsAtPath:self.file.path];
  NSData *key;
  if (!registry) {
    if (dbExists) fail(@"legacy_format");
    if ([self readKey]) fail(@"journal_state_loss");
    uint8_t random[16];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof random, random) != errSecSuccess)
      fail(@"journal_storage_failure");
    NSMutableString *incarnation = [NSMutableString new];
    for (size_t i = 0; i < sizeof random; i++) [incarnation appendFormat:@"%02x", random[i]];
    registry = [@{@"schema" : @2, @"stage" : @"pending", @"incarnation" : incarnation} mutableCopy];
    [self writeRegistry:registry];
    record(@"provision", @{@"stage" : @"pending"}, incarnation);
    key = [self createKey];
    record(@"provision", @{@"stage" : @"key"}, incarnation);
  } else if ([registry[@"stage"] isEqual:@"ready"]) {
    if (!dbExists) fail(@"journal_state_loss");
    key = [self readKey];
    if (!key) fail(@"journal_key_missing");
  } else {
    key = [self readKey];
    if (!key) {
      if (dbExists) fail(@"journal_key_missing");
      key = [self createKey];
    } else record(@"provision", @{@"stage" : @"key-resumed"}, registry[@"incarnation"]);
  }
  NSString *expected = registry[@"incarnation"];
  [self openDatabase:key incarnation:expected];
  if (![registry[@"stage"] isEqual:@"ready"]) {
    registry[@"stage"] = @"ready";
    [self writeRegistry:registry];
    record(@"provision", @{@"stage" : @"ready"}, expected);
  }
  self.incarnation = expected;
  NSDictionary *row = [self controlRow];
  self.needsNotificationCleanup = [self sql:@"SELECT 1 FROM notification_cleanup WHERE id=1" values:@[]].count > 0;
  @synchronized(self) {
    if (self.restrictions == 0) self.displayOpen = row && row[@"publication"] != NSNull.null;
    record(@"bootstrap", @{@"memoryDisplayOpen" : @(self.displayOpen), @"restrictions" : @(self.restrictions)}, expected);
  }
}
- (void)openDatabase:(NSData *)key incarnation:(NSString *)expected {
  @try {
    if (sqlite3_open_v2(self.file.path.UTF8String, &db,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                        nullptr) != SQLITE_OK)
      fail(@"journal_storage_failure");
    if (sqlite3_key(db, key.bytes, (int)key.length) != SQLITE_OK) fail(@"journal_storage_failure");
    if (![self sql:@"PRAGMA cipher_version" values:@[]].count) fail(@"journal_cipher_unavailable");
    [self sql:@"PRAGMA journal_mode=WAL" values:@[]];
    [self sql:@"PRAGMA synchronous=FULL" values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY "
              @"CHECK(id=1),version INTEGER NOT NULL,installation TEXT,incarnation TEXT NOT NULL)"
       values:@[]];
    [self sql:@"INSERT OR IGNORE INTO metadata(id,version,installation,incarnation) VALUES(1,2,NULL,?)" values:@[ expected ]];
    if ([self number:@"SELECT version FROM metadata WHERE id=1" generation:nil] != 2)
      fail(@"journal_version");
    if (![[self sql:@"SELECT incarnation FROM metadata WHERE id=1" values:@[]][0][0]
            isEqual:expected])
      fail(@"journal_incarnation_mismatch");
    [self sql:@"CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),revision "
              @"INTEGER NOT NULL,foundation_scope TEXT NOT NULL,installation_id TEXT NOT "
              @"NULL,user_id TEXT,consent INTEGER NOT NULL,binding_revision INTEGER NOT "
              @"NULL,acknowledged_binding_revision INTEGER,pending TEXT,token_hash "
              @"TEXT,token_revision INTEGER,display TEXT NOT NULL)"
       values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,revision INTEGER NOT "
              @"NULL,kind TEXT NOT NULL,disposition TEXT NOT NULL)"
       values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS streams(generation INTEGER PRIMARY KEY,user_id "
              @"TEXT,next_sequence INTEGER NOT NULL,acknowledged INTEGER NOT NULL)"
       values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS commands(generation INTEGER NOT NULL,sequence "
              @"INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,PRIMARY "
              @"KEY(generation,sequence)) WITHOUT ROWID"
       values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,user_id TEXT "
              @"NOT NULL,event TEXT NOT NULL,props TEXT NOT NULL,generation INTEGER NOT "
              @"NULL,sequence INTEGER NOT NULL)"
       values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS batches(generation INTEGER PRIMARY KEY,through "
              @"INTEGER NOT NULL,body TEXT NOT NULL)"
       values:@[]];
    BOOL hasBinding = NO;
    for (NSArray *column in [self sql:@"PRAGMA table_info(metadata)" values:@[]])
      if ([column[1] isEqual:@"binding"]) hasBinding = YES;
    if (!hasBinding) [self sql:@"ALTER TABLE metadata ADD COLUMN binding TEXT" values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),foreground TEXT NOT NULL,channels TEXT NOT NULL,actions TEXT NOT NULL)" values:@[]];
    BOOL hasCategories = NO;
    for (NSArray *column in [self sql:@"PRAGMA table_info(settings)" values:@[]]) if ([column[1] isEqual:@"categories"]) hasCategories = YES;
    if (!hasCategories) [self sql:@"ALTER TABLE settings ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'" values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS observations(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,process TEXT NOT NULL,ticket TEXT,kind TEXT NOT NULL,target_id TEXT NOT NULL,attempt_id TEXT NOT NULL,action_id TEXT,installation_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,user_id TEXT,control_revision INTEGER,status TEXT NOT NULL,created_at INTEGER NOT NULL)" values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,action_id TEXT,target_id TEXT NOT NULL,attempt_id TEXT NOT NULL,user_id TEXT,binding_generation INTEGER NOT NULL,envelope TEXT NOT NULL,received_at INTEGER NOT NULL,interacted_at INTEGER NOT NULL,status TEXT NOT NULL)" values:@[]];
    BOOL hasResponseKey = NO;
    for (NSArray *column in [self sql:@"PRAGMA table_info(interactions)" values:@[]]) if ([column[1] isEqual:@"response_key"]) hasResponseKey = YES;
    if (!hasResponseKey) [self sql:@"ALTER TABLE interactions ADD COLUMN response_key TEXT" values:@[]];
    [self sql:@"CREATE UNIQUE INDEX IF NOT EXISTS interactions_response ON interactions(response_key)" values:@[]];
    [self sql:@"CREATE INDEX IF NOT EXISTS observations_pending ON observations(status,ordinal)" values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS receipts(inbox_id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,imported_at INTEGER NOT NULL)" values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS feedback(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,feedback_id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,shown_feedback_id TEXT,status TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL)" values:@[]];
    [self sql:@"CREATE TABLE IF NOT EXISTS completions(user_id TEXT NOT NULL,delivery_id TEXT NOT NULL,feedback_id TEXT NOT NULL,completed_at INTEGER NOT NULL,PRIMARY KEY(user_id,delivery_id))" values:@[]];
    [self sql:@"CREATE INDEX IF NOT EXISTS feedback_pending ON feedback(status,ordinal)" values:@[]];
    [self transaction:^id {
      BOOL migrateCleanup = ![self sql:@"SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_cleanup'" values:@[]].count;
      [self sql:@"CREATE TABLE IF NOT EXISTS notification_cleanup(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,through_generation INTEGER NOT NULL,keep_user TEXT)" values:@[]];
      if (migrateCleanup) [self requireNotificationCleanup:[self controlRow] clear:NO];
      return nil;
    }];
  } @catch (NSException *error) {
    if (db) sqlite3_close(db);
    db = nullptr;
    @throw error;
  }
}
- (NSDictionary *)controlRow {
  NSArray *rows = [self sql:@"SELECT revision,foundation_scope,installation_id,user_id,consent,"
                            @"binding_revision,acknowledged_binding_revision,pending,token_hash,"
                            @"token_revision,display FROM control WHERE id=1"
                     values:@[]];
  if (!rows.count) return nil;
  NSArray *row = rows[0];
  NSString *display = row[10];
  NSDictionary *state = @{
    @"version" : @2,
    @"scope" : row[1],
    @"installationId" : row[2],
    @"session" : @{@"userId" : row[3], @"consent" : @([row[4] longLongValue] == 1)},
    @"bindingRevision" : row[5],
    @"acknowledgedBindingRevision" : row[6],
    @"pending" : row[7] == NSNull.null ? NSNull.null : object(row[7]),
    @"token" : row[8] == NSNull.null ? NSNull.null : @{@"hash" : row[8], @"revision" : row[9]},
  };
  return @{
    @"revision" : row[0],
    @"state" : state,
    @"display" : [display isEqual:@"closed"] ? @"closed" : @"open",
    @"publication" : [display isEqual:@"closed"] ? NSNull.null : object(display),
  };
}
- (NSString *)commitControl:(NSString *)operationId
                   expected:(long long)expectedRevision
                      state:(NSString *)encoded
                   restrict:(BOOL)restrict {
  NSDictionary *state = object(encoded);
  NSDictionary *session = state[@"session"];
  if (![session isKindOfClass:NSDictionary.class]) fail(@"invalid_control");
  id user = session[@"userId"] ?: NSNull.null;
  BOOL consent = [session[@"consent"] boolValue];
  long long bindingRevision = [state[@"bindingRevision"] longLongValue];
  id acknowledged = state[@"acknowledgedBindingRevision"] ?: NSNull.null;
  id pending = state[@"pending"] == nil || state[@"pending"] == NSNull.null ? NSNull.null
                                                                             : json(state[@"pending"]);
  NSDictionary *token = state[@"token"] == NSNull.null ? nil : state[@"token"];
  if (![state[@"scope"] isKindOfClass:NSString.class] ||
      ![state[@"installationId"] isKindOfClass:NSString.class] || bindingRevision < 0 ||
      (user != NSNull.null && ![user length]))
    fail(@"invalid_control");
  NSString *prefix = [self.owner stringByAppendingString:@":"];
  if (![operationId hasPrefix:prefix]) fail(@"operation_retired");
  long long operationSequence = [[operationId substringFromIndex:prefix.length] longLongValue];
  if (operationSequence <= self.lastOperation) fail(@"operation_retired");
  self.lastOperation = operationSequence;
  __block BOOL restrictive = restrict;
  NSDictionary *receipt = [self transaction:^id {
    long long current = -1;
    NSString *display = @"closed";
    NSArray *rows = [self sql:@"SELECT revision,user_id,consent,binding_revision,display FROM "
                              @"control WHERE id=1"
                       values:@[]];
    if (rows.count) {
      NSArray *row = rows[0];
      current = [row[0] longLongValue];
      if (![row[1] isEqual:user] || ([row[2] longLongValue] == 1) != consent ||
          [row[3] longLongValue] != bindingRevision)
        restrictive = YES;
      display = row[4];
    }
    if (current != expectedRevision) fail(@"control_stale");
    if (restrictive) display = @"closed";
    long long next = current < 0 ? 1 : current + 1;
    checkpoint(@"control-commit-before");
    if (restrictive) checkpoint(@"close-commit-before");
    [self sql:@"INSERT OR REPLACE INTO control VALUES(1,?,?,?,?,?,?,?,?,?,?,?)"
        values:@[
          @(next), state[@"scope"], state[@"installationId"], user, @(consent ? 1 : 0),
          @(bindingRevision), acknowledged, pending, token ? token[@"hash"] : NSNull.null,
          token ? token[@"revision"] : NSNull.null, display
        ]];
    [self sql:@"DELETE FROM operations" values:@[]];
    [self sql:@"INSERT INTO operations VALUES(?,?,?,?)"
        values:@[ operationId, @(next), @"control", restrictive ? @"closed" : @"kept" ]];
    [self requireNotificationCleanup:[self controlRow] clear:restrict];
    if (restrictive) checkpoint(@"close-commit-after");
    return @{
      @"operationId" : operationId,
      @"revision" : @(next),
      @"display" : [display isEqual:@"closed"] ? @"closed" : @"open",
      @"restrictive" : @(restrictive)
    };
  }];
  self.needsNotificationCleanup = YES;
  @synchronized(self) {
    if (restrictive) { self.displayOpen = NO; self.displayFence++; }
  }
  checkpoint(@"control-commit-after");
  NSMutableDictionary *recorded = [receipt mutableCopy];
  @synchronized(self) {
    recorded[@"submissionsBeforeClose"] = @(self.submittedCount);
  }
  record(@"control-commit", recorded, operationId);
  [self cleanupNotifications];
  return json(receipt);
}
- (NSString *)publishDisplay:(NSString *)proposalId {
  GJProposal *proposal;
  @synchronized(self) {
    proposal = self.proposals[proposalId];
    [self.proposals removeObjectForKey:proposalId];
    if (!proposal) fail(@"invalid_proposal");
    if (self.released) fail(@"journal_owner_stale");
    if (proposal.fence != self.displayFence) fail(@"publication_stale");
    if ([NSDate timeIntervalSinceReferenceDate] > proposal.deadline) fail(@"publication_expired");
  }
  [self opened];
  NSMutableDictionary *receipt = [[self transaction:^id {
    NSArray *rows = [self sql:@"SELECT revision,user_id,consent,binding_revision,"
                              @"acknowledged_binding_revision FROM control WHERE id=1"
                       values:@[]];
    if (!rows.count) fail(@"display_ineligible");
    NSArray *row = rows[0];
    if ([row[0] longLongValue] != proposal.controlRevision || ![row[1] isEqual:proposal.userId] ||
        [row[2] longLongValue] != 1 || row[4] == NSNull.null || ![row[3] isEqual:row[4]])
      fail(@"display_ineligible");
    NSArray *operation = [self sql:@"SELECT revision FROM operations WHERE id=?" values:@[ proposal.operationId ]];
    if (!operation.count || [operation[0][0] longLongValue] != proposal.controlRevision) fail(@"publication_stale");
    NSDictionary *publication =
        @{@"publicationId" : proposal.identifier, @"controlRevision" : row[0]};
    checkpoint(@"open-commit-before");
    [self sql:@"UPDATE control SET display=? WHERE id=1" values:@[ json(publication) ]];
    [self sql:@"DELETE FROM operations WHERE kind='open'" values:@[]];
    [self sql:@"INSERT INTO operations VALUES(?,?,?,?)"
        values:@[ proposal.identifier, row[0], @"open", @"open" ]];
    return publication;
  }] mutableCopy];
  checkpoint(@"open-commit-after");
  @synchronized(self) {
    BOOL current = proposal.fence == self.displayFence && !self.released;
    if (current) self.displayOpen = YES;
    receipt[@"state"] = current ? @"open" : @"open-then-restricted";
  }
  record(@"open-commit", receipt, proposal.identifier);
  return json(receipt);
}
- (NSDictionary *)submitIfCurrent:(GalinumJournalSubmission)submission {
  [self opened];
  NSDictionary *row = [self controlRow];
  if (!row || row[@"publication"] == NSNull.null)
    return @{@"state" : @"suppressed", @"reason" : @"closed-on-disk"};
  long long fence;
  @synchronized(self) {
    if (!self.displayOpen) return @{@"state" : @"suppressed", @"reason" : @"memory-closed"};
    fence = self.displayFence;
  }
  NSString *fenceText = [NSString stringWithFormat:@"%lld", fence];
  record(@"submission-evaluated", row[@"publication"], fenceText);
  checkpoint(@"submission-gap");
  NSMutableDictionary *entry;
  @synchronized(self) {
    if (fence != self.displayFence || !self.displayOpen)
      return @{@"state" : @"suppressed", @"reason" : @"restricted-after-evaluation", @"fence" : @(fence), @"currentFence" : @(self.displayFence)};
    entry = [row[@"publication"] mutableCopy];
    entry[@"ordinal"] = @(++self.submittedCount);
    entry[@"nanos"] = @(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW));
  }
  record(@"submission-initiated", entry, fenceText);
  submission(entry);
  record(@"submission-settled", entry, fenceText);
  return @{@"state" : @"submitted", @"submission" : entry};
}
- (NSString *)persistObservation:(NSString *)commandId observation:(NSDictionary *)observation proof:(NSDictionary *)proof {
  NSNumber *ordinal = observation[@"ordinal"];
  id user = observation[@"userId"];
  BOOL match = proof[@"userId"] != NSNull.null && [observation[@"installationId"] isEqual:proof[@"installationId"]] &&
               [observation[@"bindingGeneration"] isEqual:proof[@"generation"]] && user != NSNull.null && user &&
               [user isEqual:proof[@"userId"]];
  if (!match) {
    [self sql:@"UPDATE observations SET status='retired' WHERE ordinal=?" values:@[ ordinal ]];
    [self sql:@"UPDATE interactions SET status='retired' WHERE ordinal=? AND status='pending'" values:@[ ordinal ]];
    return json(@{@"ordinal" : ordinal, @"state" : @"retired"});
  }
  NSNumber *generation = proof[@"generation"];
  long long sequence = [self number:@"SELECT next_sequence FROM streams WHERE generation=?" generation:generation];
  if (sequence >= 9007199254740991LL) fail(@"sequence_exhausted");
  NSMutableDictionary *body = [@{@"kind" : observation[@"kind"], @"targetId" : observation[@"targetId"], @"attemptId" : observation[@"attemptId"]} mutableCopy];
  if (observation[@"actionId"] && observation[@"actionId"] != NSNull.null) body[@"actionId"] = observation[@"actionId"];
  body[@"id"] = commandId;
  body[@"sequence"] = @(sequence);
  [self sql:@"INSERT INTO commands VALUES(?,?,?,?)" values:@[ generation, @(sequence), commandId, json(body) ]];
  [self sql:@"UPDATE streams SET next_sequence=next_sequence+1 WHERE generation=?" values:@[ generation ]];
  [self sql:@"UPDATE observations SET status='admitted' WHERE ordinal=?" values:@[ ordinal ]];
  return json(@{@"ordinal" : ordinal, @"state" : @"queued", @"sequence" : @(sequence)});
}
- (void)requireNotificationCleanup:(NSDictionary *)control clear:(BOOL)clear {
  if (!control) return;
  NSDictionary *session = control[@"state"][@"session"];
  id user = clear || ![session[@"consent"] boolValue] ? NSNull.null : session[@"userId"];
  long long through = [self number:@"SELECT COALESCE(MAX(generation),-1) FROM streams" generation:nil];
  [self sql:@"INSERT OR REPLACE INTO notification_cleanup VALUES(1,?,?,?)" values:@[control[@"revision"], @(through), user]];
}
- (void)cleanupNotifications {
  NSArray *rows = [self sql:@"SELECT revision,through_generation,keep_user FROM notification_cleanup WHERE id=1" values:@[]];
  if (!rows.count) { self.needsNotificationCleanup = NO; return; }
  NSArray *intent = rows[0];
  NSDictionary *control = [self controlRow];
  if (!control) fail(@"journal_corrupt");
  NSMutableSet *generations = [NSMutableSet new];
  if (intent[2] != NSNull.null)
    for (NSArray *row in [self sql:@"SELECT generation FROM streams WHERE user_id=? AND generation<=?" values:@[intent[2],intent[1]]]) [generations addObject:row[0]];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSUInteger removed = 0;
  __block BOOL complete = NO;
  NSUInteger epoch;
  @synchronized(self) { self.notificationCleanupActive = YES; epoch = ++self.notificationCleanupEpoch; }
  @try {
    [GalinumNotifications cancelForInstallation:control[@"state"][@"installationId"] throughGeneration:intent[1] keepingGenerations:generations authorize:^BOOL(dispatch_block_t cancellation) {
      @synchronized(self) {
        if (!self.notificationCleanupActive || epoch != self.notificationCleanupEpoch) return NO;
        cancellation();
        return YES;
      }
    } completion:^(NSUInteger count, BOOL settled) {
      removed = count;
      complete = settled;
      dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) || !complete) fail(@"notifications_unavailable");
    [self transaction:^id {
      [self sql:@"DELETE FROM notification_cleanup WHERE id=1 AND revision=? AND through_generation=? AND keep_user IS ?" values:intent];
      return nil;
    }];
    self.needsNotificationCleanup = [self sql:@"SELECT 1 FROM notification_cleanup WHERE id=1" values:@[]].count > 0;
    if (self.needsNotificationCleanup) fail(@"notifications_unavailable");
  } @finally {
    @synchronized(self) { self.notificationCleanupActive = NO; }
  }
  record(@"notification-owner-cleanup", @{@"removed": @(removed), @"keepUser": intent[2], @"throughGeneration": intent[1], @"revision": intent[0]}, self.scope);
}
- (void)importReceipts {
  NSDictionary *proof = [self bindingProof], *control = [self controlRow];
  for (NSDictionary *row in [GalinumReceiptStore pendingForInstallation:proof[@"installationId"] ?: @""]) {
    NSDictionary *envelope = GalinumJournalParseEnvelope(@{@"galinum": row[@"envelope"] ?: @{}});
    if (!envelope) { [GalinumReceiptStore acknowledge:row[@"id"]]; continue; }
    if (![envelope[@"installationId"] isEqual:proof[@"installationId"]]) continue;
    id user = control[@"state"][@"session"][@"userId"] ?: NSNull.null;
    BOOL current = bindingCurrent(proof, control, envelope[@"installationId"], envelope[@"bindingGeneration"], user);
    [self transaction:^id {
      if (![self sql:@"SELECT 1 FROM receipts WHERE inbox_id=?" values:@[row[@"id"]]].count) {
        long long ordinal = [self insertObservation:@"receipt" ticket:nil envelope:envelope actionId:nil user:user controlRevision:control[@"revision"] current:current];
        [self sql:@"INSERT INTO receipts VALUES(?,?,?)" values:@[row[@"id"], @(ordinal), @(now())]];
      }
      return nil;
    }];
    [GalinumReceiptStore acknowledge:row[@"id"]];
  }
}
- (void)admitOrphans:(NSDictionary *)proof {
  while (YES) {
    NSDictionary *row;
    for (NSArray *cursor in [self sql:@"SELECT ordinal,kind,target_id,attempt_id,action_id,installation_id,binding_generation,user_id,ticket,process FROM observations WHERE status='pending' ORDER BY ordinal LIMIT 1" values:@[]]) {
      NSString *ticketId = cursor[8] == NSNull.null ? nil : cursor[8];
      BOOL live = NO;
      @synchronized(self) {
        if (ticketId && [cursor[9] isEqual:processIncarnation])
          for (GJTicket *ticket in self.tickets)
            if ([ticket.identifier isEqual:ticketId]) live = YES;
      }
      if (live) return;
      row = @{@"ordinal" : cursor[0], @"kind" : cursor[1], @"targetId" : cursor[2], @"attemptId" : cursor[3], @"actionId" : cursor[4], @"installationId" : cursor[5], @"bindingGeneration" : cursor[6], @"userId" : cursor[7]};
      break;
    }
    if (!row) return;
    NSString *commandId = [NSString stringWithFormat:@"o%@", row[@"ordinal"]];
    NSString *receipt = [self transaction:^id {
      return [self persistObservation:commandId observation:row proof:proof];
    }];
    record(@"admitted", object(receipt), commandId);
    if (![row[@"kind"] isEqual:@"receipt"] && [object(receipt)[@"state"] isEqual:@"queued"]) [self notifyInteraction];
  }
}
- (NSString *)persist:(GJTicket *)ticket proof:(NSDictionary *)proof {
  [self check:ticket.intent];
  if (ticket.observationOrdinal > 0) return [self persistObservation:ticket.identifier observation:ticket.observation proof:proof];
  NSString *user = proof[@"userId"];
  if ((id)user == NSNull.null) fail(@"identify_required");
  NSNumber *generation = proof[@"generation"];
  NSMutableDictionary *body;
  if (ticket.event) {
    NSString *event = ticket.event[@"event"], *props = ticket.event[@"propsJson"];
    if (![ticket.event[@"eventId"] isEqual:ticket.eventId] || !event.length ||
        [props lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 4096)
      fail(@"invalid_event");
    NSArray *rows =
        [self sql:@"SELECT user_id,event,props,generation,sequence FROM events WHERE event_id=?"
            values:@[ ticket.eventId ]];
    if (rows.count) {
      NSArray *row = rows[0];
      if (![row[0] isEqual:user] || ![row[1] isEqual:event] || ![row[2] isEqual:props])
        fail(@"event_conflict");
      long long ack = [self number:@"SELECT acknowledged FROM streams WHERE generation=?"
                        generation:row[3]];
      if (![row[3] isEqual:generation] && [row[4] longLongValue] > ack)
        fail(@"event_pending_old_binding");
      return json(@{
        @"eventId" : ticket.eventId,
        @"state" : [row[4] longLongValue] <= ack ? @"acknowledged" : @"queued"
      });
    }
    body = [@{
      @"kind" : @"event",
      @"event" : event,
      @"eventId" : ticket.eventId,
      @"props" : object(props)
    } mutableCopy];
  } else {
    body = [ticket.observation mutableCopy];
    if (![body[@"bindingGeneration"] isEqual:generation] ||
        ![body[@"installationId"] isEqual:proof[@"installationId"]])
      fail(@"superseded");
    [body removeObjectForKey:@"bindingGeneration"];
    [body removeObjectForKey:@"installationId"];
    if (![@[ @"receipt", @"tap", @"action" ] containsObject:body[@"kind"]] ||
        ![body[@"targetId"] length] || ![body[@"attemptId"] length])
      fail(@"invalid_observation");
  }
  long long sequence = [self number:@"SELECT next_sequence FROM streams WHERE generation=?"
                         generation:generation];
  if (sequence >= 9007199254740991LL) fail(@"sequence_exhausted");
  body[@"id"] = ticket.identifier;
  body[@"sequence"] = @(sequence);
  [self sql:@"INSERT INTO commands VALUES(?,?,?,?)"
      values:@[ generation, @(sequence), ticket.identifier, json(body) ]];
  if (ticket.event)
    [self sql:@"INSERT INTO events VALUES(?,?,?,?,?,?)"
        values:@[
          ticket.eventId, user, ticket.event[@"event"], ticket.event[@"propsJson"], generation,
          @(sequence)
        ]];
  [self sql:@"UPDATE streams SET next_sequence=next_sequence+1 WHERE generation=?"
      values:@[ generation ]];
  return json(@{@"eventId" : ticket.eventId, @"state" : @"queued"});
}
- (void)notifyInteraction {
  void (^listener)(NSString *);
  @synchronized(self) { listener = self.interactionListener; }
  if (listener) listener(self.scope);
}
- (void)drain {
  while (YES) {
    GJTicket *ticket;
    NSDictionary *proof;
    BOOL admit;
    @synchronized(self) {
      admit = db && self.ready && !self.released;
      proof = self.binding;
    }
    if (admit) @try {
        [self admitOrphans:proof];
      } @catch (NSException *error) {
        if (![error.name hasPrefix:@"journal_storage"]) @throw error;
        return;
      }
    @synchronized(self) {
      ticket = self.tickets.firstObject;
      if (!ticket) return;
      if (!self.released && !ticket.rejected && ticket.intent == 0 && !self.initialResolved) return;
      if (ticket.rejected || ticket.intent != self.intent || self.released) {
        [self.tickets removeObjectAtIndex:0];
        for (NSArray *waiter in ticket.waiters)
          ((RCTPromiseRejectBlock)waiter[1])(@"superseded", @"superseded", nil);
        continue;
      }
      if (!db || !self.ready || (!ticket.event && !ticket.observation) || ticket.observationOrdinal < 0) return;
      proof = self.binding;
    }
    @try {
      NSString *receipt = [self transaction:^id {
        return [self persist:ticket proof:proof];
      }];
      @synchronized(self) {
        [self.tickets removeObject:ticket];
        [self check:ticket.intent];
        for (NSArray *waiter in ticket.waiters) ((RCTPromiseResolveBlock)waiter[0])(receipt);
      }
      record(@"admitted", object(receipt), ticket.identifier);
      if (ticket.observation && ![ticket.observation[@"kind"] isEqual:@"receipt"] && [object(receipt)[@"state"] isEqual:@"queued"]) [self notifyInteraction];
    } @catch (NSException *error) {
      @synchronized(self) {
        for (NSArray *waiter in ticket.waiters)
          ((RCTPromiseRejectBlock)waiter[1])(error.name, error.name, nil);
        [ticket.waiters removeAllObjects];
        if ([error.name hasPrefix:@"journal_storage"]) return;
        [self.tickets removeObject:ticket];
      }
    }
  }
}
@end

static NSMutableDictionary<NSString *, GJActor *> *actors;
static NSMutableArray<NSMutableDictionary *> *pendingIngress;
static GJActor *actor(NSString *scope, NSString *owner) {
  @synchronized(GJActor.class) {
    GJActor *value = actors[scope];
    if (!value || value.released || ![value.owner isEqual:owner]) fail(@"journal_owner_stale");
    return value;
  }
}
static GJActor *attachedActor(NSString *scope) {
  @synchronized(GJActor.class) {
    GJActor *value = actors[scope];
    if (!value || value.released) fail(@"journal_owner_stale");
    return value;
  }
}
NSURL *GalinumJournalDirectory(void) {
  NSURL *root = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                       inDomains:NSUserDomainMask]
                    .firstObject;
  return [root URLByAppendingPathComponent:@"GalinumJournal" isDirectory:YES];
}
NSString *GalinumJournalReserveObservation(NSString *scope, NSDictionary *observation) {
  return [attachedActor(scope) reserveObservation:observation];
}
BOOL GalinumJournalOwnerAttached(NSString *scope) {
  @synchronized(GJActor.class) {
    GJActor *value = actors[scope];
    return value && !value.released;
  }
}
NSDictionary *GalinumJournalPublishedBinding(NSString *scope) {
  GJActor *value;
  @synchronized(GJActor.class) {
    value = actors[scope];
  }
  if (!value) return nil;
  @synchronized(value) {
    return value.released || !value.ready || value.needsNotificationCleanup ? nil : value.binding;
  }
}
void GalinumJournalSubmitIfCurrent(NSString *scope, GalinumJournalSubmission submission,
                                   GalinumJournalCompletion completion) {
  GJActor *value;
  @try {
    value = attachedActor(scope);
  } @catch (NSException *error) {
    completion(nil, error.name);
    return;
  }
  [value work:^(id result) {
    completion(result, nil);
  }
      reject:^(NSString *code, NSString *message, NSError *error) {
        completion(nil, code);
      }
        body:^id {
          return [value submitIfCurrent:submission];
        }];
}
static GJActor *actorForScope(NSString *scope) {
  @synchronized(GJActor.class) {
    if (!actors) {
      actors = [NSMutableDictionary new];
      processIncarnation = hex(8);
    }
    GJActor *value = actors[scope];
    if (value) return value;
    if (scope.length != 64 ||
        [scope rangeOfCharacterFromSet:[[NSCharacterSet
                                           characterSetWithCharactersInString:@"0123456789abcdef"]
                                           invertedSet]]
                .location != NSNotFound)
      fail(@"invalid_scope");
    value = [GJActor new];
    value.scope = scope;
    value.released = YES;
    value.queue = dispatch_queue_create("com.galinum.journal", DISPATCH_QUEUE_SERIAL);
    value.tickets = [NSMutableArray new];
    value.proposals = [NSMutableDictionary new];
    NSURL *directory = GalinumJournalDirectory();
    value.file = [directory URLByAppendingPathComponent:[scope stringByAppendingString:@".db"]];
    value.registry =
        [directory URLByAppendingPathComponent:[scope stringByAppendingString:@".control.json"]];
    actors[scope] = value;
    return value;
  }
}
static NSArray *rowsAsObjects(NSArray *rows, NSArray<NSString *> *keys) {
  NSMutableArray *result = [NSMutableArray new];
  for (NSArray *row in rows) {
    NSMutableDictionary *entry = [NSMutableDictionary new];
    for (NSUInteger i = 0; i < keys.count; i++) entry[keys[i]] = row[i];
    [result addObject:entry];
  }
  return result;
}
NSDictionary *GalinumJournalFiles(NSString *scope) {
  GJActor *value = actorForScope(scope);
  NSFileManager *files = [NSFileManager defaultManager];
  return @{@"dbExists" : @([files fileExistsAtPath:value.file.path]), @"registryExists" : @([files fileExistsAtPath:value.registry.path]), @"keyExists" : @([value readKey] != nil)};
}
NSDictionary *GalinumJournalInspect(NSString *scope) {
  GJActor *value = actorForScope(scope);
  __block NSMutableDictionary *result;
  @synchronized(value) {
    value.inFlight++;
  }
  dispatch_sync(value.queue, ^{
    NSFileManager *files = [NSFileManager defaultManager];
    unsigned long long bytes = [[files attributesOfItemAtPath:value.file.path error:nil] fileSize];
    result = [@{@"pid" : @(getpid()), @"registry" : value.registry.lastPathComponent, @"db" : value.file.lastPathComponent, @"registryExists" : @([files fileExistsAtPath:value.registry.path]), @"dbExists" : @([files fileExistsAtPath:value.file.path]), @"dbBytes" : @(bytes)} mutableCopy];
    @try {
      result[@"keyExists"] = @([value readKey] != nil);
      [value bootstrapStorage];
      result[@"bootstrap"] = @"ready";
      result[@"incarnation"] = value.incarnation;
      result[@"control"] = [value controlRow] ?: NSNull.null;
      @synchronized(value) {
        result[@"memoryDisplayOpen"] = @(value.displayOpen);
        result[@"fence"] = @(value.displayFence);
        result[@"restrictions"] = @(value.restrictions);
        result[@"leaseLive"] = @(!value.released);
        result[@"inFlight"] = @(value.inFlight - 1);
        result[@"nativeJobs"] = @(value.nativeJobs);
        result[@"cleanupRequired"] = @(value.needsNotificationCleanup);
      }
      result[@"cleanupIntent"] = rowsAsObjects([value sql:@"SELECT revision,through_generation,keep_user FROM notification_cleanup" values:@[]], @[@"revision",@"throughGeneration",@"keepUser"]);
      result[@"operations"] = rowsAsObjects([value sql:@"SELECT id,revision,kind,disposition FROM operations ORDER BY revision" values:@[]], @[ @"id", @"revision", @"kind", @"disposition" ]);
      result[@"streams"] = rowsAsObjects([value sql:@"SELECT generation,user_id,next_sequence,acknowledged FROM streams ORDER BY generation" values:@[]], @[ @"generation", @"userId", @"nextSequence", @"acknowledged" ]);
      result[@"commands"] = rowsAsObjects([value sql:@"SELECT generation,sequence,id FROM commands ORDER BY generation,sequence" values:@[]], @[ @"generation", @"sequence", @"id" ]);
      result[@"observations"] = rowsAsObjects([value sql:@"SELECT ordinal,kind,status,ticket,process,user_id,binding_generation FROM observations ORDER BY ordinal" values:@[]], @[ @"ordinal", @"kind", @"status", @"ticket", @"process", @"userId", @"bindingGeneration" ]);
      result[@"interactions"] = rowsAsObjects([value sql:@"SELECT id,ordinal,kind,action_id,status,user_id FROM interactions ORDER BY ordinal" values:@[]], @[ @"id", @"ordinal", @"kind", @"actionId", @"status", @"userId" ]);
      result[@"settings"] = [value settings];
    } @catch (NSException *error) {
      result[@"bootstrap"] = error.name;
    }
  });
  @synchronized(value) {
    value.inFlight--;
  }
  return result;
}
void GalinumJournalExecute(NSString *scope, NSString *sql) {
  GJActor *value = actorForScope(scope);
  [value opened];
  [value sql:sql values:@[]];
}
void GalinumJournalOnQueue(NSString *scope, void (^body)(void), void (^completion)(NSString *code)) {
  GJActor *value = actorForScope(scope);
  [value work:^(id result) {
    if (completion) completion(nil);
  }
      reject:^(NSString *code, NSString *message, NSError *error) {
        if (completion) completion(code);
      }
        body:^id {
          body();
          return nil;
        }];
}
void GalinumJournalReloadLease(NSString *scope, NSString *owner) {
  GJActor *value = actor(scope, owner);
  [[GalinumJournal new] detach:value
                       dispose:NO
                       resolve:^(id result) {
                       }
                        reject:^(NSString *code, NSString *message, NSError *error) {
                        }];
}
NSDictionary *GalinumJournalCapacity(NSString *scope, NSString *owner, BOOL constrained) {
  GJActor *value = actor(scope, owner);
  __block NSDictionary *result;
  dispatch_sync(value.queue, ^{
    long long pages = [value number:@"PRAGMA page_count" generation:nil];
    long long limit = [value number:[NSString stringWithFormat:@"PRAGMA max_page_count=%lld", constrained ? pages : 1048576LL] generation:nil];
    NSString *version = [value sql:@"PRAGMA cipher_version" values:@[]][0][0];
    result = @{@"pages" : @(pages), @"limit" : @(limit), @"cipherVersion" : version};
  });
  return result;
}
NSDictionary *GalinumJournalParseEnvelope(NSDictionary *userInfo) {
  if (![userInfo isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *envelope = userInfo[@"galinum"];
  if (![envelope isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *content = envelope[@"content"];
  if (![envelope[@"version"] isEqual:@1] || ![envelope[@"targetId"] isKindOfClass:NSString.class] ||
      ![envelope[@"attemptId"] isKindOfClass:NSString.class] ||
      ![envelope[@"installationId"] isKindOfClass:NSString.class] ||
      ![envelope[@"bindingGeneration"] isKindOfClass:NSNumber.class] ||
      ![content isKindOfClass:NSDictionary.class] || ![content[@"title"] isKindOfClass:NSString.class] ||
      ![content[@"body"] isKindOfClass:NSString.class] ||
      ![content[@"destination"] isKindOfClass:NSDictionary.class] ||
      ![content[@"destination"][@"url"] isKindOfClass:NSString.class])
    return nil;
  NSNumber *generation = envelope[@"bindingGeneration"];
  if (!isfinite(generation.doubleValue) || generation.doubleValue < 0 || floor(generation.doubleValue) != generation.doubleValue || generation.doubleValue > 9007199254740991.0 ||
      ![envelope[@"targetId"] length] || ![envelope[@"attemptId"] length] || ![envelope[@"installationId"] length] ||
      ![@[@"app", @"website"] containsObject:content[@"destination"][@"kind"]] ||
      ![envelope[@"test"] isKindOfClass:NSNumber.class]) return nil;
  if (content[@"actions"]) {
    if (![content[@"actions"] isKindOfClass:NSArray.class]) return nil;
    for (id action in content[@"actions"])
      if (![action isKindOfClass:NSDictionary.class] || ![action[@"id"] isKindOfClass:NSString.class] || ![action[@"title"] isKindOfClass:NSString.class]) return nil;
  }
  if (content[@"ios"] && ![content[@"ios"] isKindOfClass:NSDictionary.class]) return nil;
  if (content[@"data"]) {
    if (![content[@"data"] isKindOfClass:NSDictionary.class]) return nil;
    for (id key in content[@"data"]) if (![content[@"data"][key] isKindOfClass:NSString.class]) return nil;
  }
  @try {
    return object(json(envelope));
  } @catch (NSException *invalid) {
    return nil;
  }
}
NSString *GalinumJournalScopeForInstallation(NSString *installationId) {
  NSArray *names = [[[NSFileManager defaultManager] contentsOfDirectoryAtPath:GalinumJournalDirectory().path error:nil]
      sortedArrayUsingSelector:@selector(compare:)];
  NSMutableSet *scopes = [NSMutableSet new];
  @synchronized(GJActor.class) { [scopes addObjectsFromArray:actors.allKeys ?: @[]]; }
  for (NSString *name in names) {
    if (![name hasSuffix:@".control.json"] || name.length != 64 + 13) continue;
    [scopes addObject:[name substringToIndex:64]];
  }
  __block NSString *lookupFailure;
  for (NSString *scope in scopes) {
    GJActor *candidate;
    @try {
      candidate = actorForScope(scope);
    } @catch (NSException *invalid) {
      continue;
    }
    __block NSString *installation;
    __block BOOL failed = NO;
    dispatch_sync(candidate.queue, ^{
      @try {
        [candidate bootstrapStorage];
        NSArray *rows = [candidate sql:@"SELECT installation FROM metadata WHERE id=1" values:@[]];
        installation = rows.count && rows[0][0] != NSNull.null ? rows[0][0] : @"";
      } @catch (NSException *error) {
        failed = YES;
        lookupFailure = error.name;
      }
    });
    if (failed) {
      record(@"locate-skipped", @{}, scope);
      continue;
    }
    if ([installation isEqual:installationId]) return scope;
  }
  if (lookupFailure) fail(lookupFailure);
  return nil;
}
static void finishIngress(GJActor *value, NSMutableDictionary *result, NSDictionary *envelope, long long fence, dispatch_block_t handoff, GalinumJournalCompletion completion) {
  if (handoff) checkpoint(@"presentation-main");
  @synchronized(value) {
    if (value.notificationCleanupActive) {
      dispatch_async(value.queue, ^{
        dispatch_async(dispatch_get_main_queue(), ^{ finishIngress(value, result, envelope, fence, handoff, completion); });
      });
      return;
    }
    if (fence != value.displayFence || !value.displayOpen || value.needsNotificationCleanup) {
      result[@"state"] = @"suppressed";
      result[@"reason"] = @"restricted-after-evaluation";
      record(@"display-suppressed", result, envelope[@"targetId"]);
    } else {
      NSDictionary *submission = @{@"ordinal": @(++value.submittedCount), @"nanos": @(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW))};
      NSString *fenceText = [NSString stringWithFormat:@"%lld", fence];
      record(@"submission-initiated", submission, fenceText);
      if (handoff) handoff();
      record(@"submission-settled", submission, fenceText);
      result[@"state"] = @"displayed";
      result[@"submission"] = submission;
    }
  }
  completion(result, nil);
}
static void enqueueIngress(NSDictionary *envelope, NSString *kind, NSString *responseId, NSString *actionId, BOOL foreground, dispatch_block_t handoff, GalinumJournalCompletion completion) {
  NSMutableDictionary *entry = [@{@"envelope": envelope, @"kind": kind, @"actionId": actionId ?: NSNull.null, @"tickets": [NSMutableDictionary new]} mutableCopy];
  @synchronized(GJActor.class) {
    if (!pendingIngress) pendingIngress = [NSMutableArray new];
    [pendingIngress addObject:entry];
    for (NSString *scope in actors) {
      GJTicket *ticket = [actors[scope] reserveIngress:envelope kind:kind actionId:actionId];
      if (ticket) entry[@"tickets"][scope] = ticket;
    }
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *scope, *lookupFailure;
    @try { scope = GalinumJournalScopeForInstallation(envelope[@"installationId"]); }
    @catch (NSException *error) { lookupFailure = error.name; }
    GJActor *value = scope ? actorForScope(scope) : nil;
    GJTicket *ticket;
    @synchronized(GJActor.class) {
      ticket = scope ? entry[@"tickets"][scope] : nil;
      [pendingIngress removeObjectIdenticalTo:entry];
      for (NSString *other in entry[@"tickets"]) {
        if ([other isEqual:scope]) continue;
        GJActor *candidate = actors[other];
        @synchronized(candidate) { ((GJTicket *)entry[@"tickets"][other]).rejected = YES; }
        dispatch_async(candidate.queue, ^{ [candidate drain]; });
      }
      if (value && ![kind isEqual:@"receipt"]) {
        [value captureInteraction:envelope responseId:responseId actionId:actionId ticket:ticket completion:^(NSDictionary *result) {
          completion(result, result[@"code"]);
        }];
        return;
      }
      if (value) @synchronized(value) { value.nativeJobs++; }
    }
    if (!value) {
      if (lookupFailure) { record(@"ingress-lookup-failed", @{@"code":lookupFailure}, envelope[@"targetId"]); completion(nil, lookupFailure); return; }
      completion(@{@"state": @"ignored", @"reason": @"unknown_installation"}, nil);
      return;
    }
    dispatch_async(value.queue, ^{
      @try {
        NSMutableDictionary *result = object([value receive:envelope ticket:ticket foreground:foreground submission:handoff]);
        if (![result[@"state"] isEqual:@"evaluated"]) { completion(result, nil); return; }
        long long fence = [result[@"fence"] longLongValue];
        [result removeObjectForKey:@"fence"];
        if (handoff) dispatch_async(dispatch_get_main_queue(), ^{ finishIngress(value, result, envelope, fence, handoff, completion); });
        else finishIngress(value, result, envelope, fence, nil, completion);
      }
      @catch (NSException *error) { completion(nil, error.name); }
      @finally { @synchronized(value) { value.nativeJobs--; } }
    });
  });
}
void GalinumJournalIngress(NSDictionary *envelope, BOOL foreground, GalinumJournalCompletion completion) {
  enqueueIngress(envelope, @"receipt", nil, nil, foreground, nil, completion);
}
void GalinumJournalPresent(NSDictionary *envelope, dispatch_block_t handoff, GalinumJournalCompletion completion) {
  enqueueIngress(envelope, @"receipt", nil, nil, YES, handoff, completion);
}
void GalinumJournalCaptureInteraction(NSDictionary *envelope, NSString *actionId, GalinumJournalCompletion completion) {
  GalinumJournalCaptureResponse(envelope, envelope[@"targetId"], actionId, completion);
}
void GalinumJournalCaptureResponse(NSDictionary *envelope, NSString *responseId, NSString *actionId, GalinumJournalCompletion completion) {
  enqueueIngress(envelope, actionId ? @"action" : @"tap", responseId, actionId, NO, nil, completion);
}
@interface GalinumJournal ()
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *owned;
@end
@implementation GalinumJournal
- (void)invalidate {
  NSDictionary *owned;
  @synchronized(self) {
    owned = [self.owned copy];
    [self.owned removeAllObjects];
  }
  for (NSString *scope in owned) @try {
      [self detach:actor(scope, owned[scope])
          dispose:NO
          resolve:^(id result) {
          }
           reject:^(NSString *code, NSString *message, NSError *error){
           }];
    } @catch (NSException *stale) {
    }
}
RCT_EXPORT_MODULE(GalinumJournal)
+ (BOOL)requiresMainQueueSetup {
  return NO;
}
- (void)notifyInteraction:(NSString *)scope {
  @synchronized(self) {
    if (self.owned[scope] && _eventEmitterCallback) [self emitOnInteraction:scope];
  }
}
- (NSString *)claim:(NSString *)scope {
  GJActor *value = actorForScope(scope);
  NSString *owner;
  @synchronized(GJActor.class) {
    owner = [value attach];
    __weak GalinumJournal *module = self;
    @synchronized(value) {
      value.interactionListener = ^(NSString *changedScope) { [module notifyInteraction:changedScope]; };
    }
    for (NSMutableDictionary *entry in pendingIngress) {
      NSString *action = entry[@"actionId"] == NSNull.null ? nil : entry[@"actionId"];
      GJTicket *ticket = [value reserveIngress:entry[@"envelope"] kind:entry[@"kind"] actionId:action];
      if (ticket) entry[@"tickets"][scope] = ticket;
    }
  }
  @synchronized(self) {
    if (!self.owned) self.owned = [NSMutableDictionary new];
    self.owned[scope] = owner;
  }
  void (^observer)(NSString *);
  @synchronized(GalinumJournal.class) {
    observer = claimObserver;
  }
  if (observer) observer(scope);
  return owner;
}
- (NSString *)reserve:(NSString *)scope
                owner:(NSString *)owner
               intent:(double)intent
              eventId:(NSString *)eventId {
  return [actor(scope, owner) reserve:intent eventId:eventId];
}
- (NSNumber *)resolveInitialIntent:(NSString *)scope
                            owner:(NSString *)owner
                      destination:(double)destination {
  GJActor *value = actor(scope, owner);
  @synchronized(value) {
    if (value.initialResolved) return @YES;
    value.initialResolved = YES;
    for (GJTicket *ticket in value.tickets)
      if (ticket.intent == 0) {
        if (destination == value.intent)
          ticket.intent = destination;
        else
          ticket.rejected = YES;
      }
  }
  dispatch_async(value.queue, ^{
    [value drain];
  });
  return @YES;
}
- (NSNumber *)setIntent:(NSString *)scope owner:(NSString *)owner intent:(double)intent {
  return [actor(scope, owner) setCapturedIntent:intent];
}
- (NSNumber *)rejectTicket:(NSString *)scope
                     owner:(NSString *)owner
                    ticket:(NSString *)identifier {
  GJActor *value = actor(scope, owner);
  @synchronized(value) {
    for (GJTicket *ticket in value.tickets)
      if ([ticket.identifier isEqual:identifier]) ticket.rejected = YES;
  }
  dispatch_async(value.queue, ^{
    [value drain];
  });
  return @YES;
}
- (NSNumber *)restrictDisplay:(NSString *)scope owner:(NSString *)owner {
  return [actor(scope, owner) restrictDisplay];
}
- (NSString *)proposeDisplay:(NSString *)scope
                       owner:(NSString *)owner
                    proposal:(NSString *)proposal {
  return [actor(scope, owner) proposeDisplay:proposal];
}
- (void)open:(NSString *)scope
       owner:(NSString *)owner
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value lease:owner];
           [value bootstrap];
           return nil;
         }];
}
- (void)readControl:(NSString *)scope
              owner:(NSString *)owner
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           NSDictionary *row = [value controlRow];
           if (!row) return @"null";
           NSMutableDictionary *visible = [row mutableCopy];
           [visible removeObjectForKey:@"publication"];
           return json(visible);
         }];
}
- (void)commitControl:(NSString *)scope
                owner:(NSString *)owner
          operationId:(NSString *)operationId
     expectedRevision:(double)expectedRevision
                state:(NSString *)state
             restrict:(BOOL)restrict
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           return [value commitControl:operationId
                              expected:(long long)expectedRevision
                                 state:state
                              restrict:restrict];
         }];
}
- (void)operation:(NSString *)scope
            owner:(NSString *)owner
      operationId:(NSString *)operationId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           NSArray *rows =
               [value sql:@"SELECT revision,kind,disposition FROM operations WHERE id=?"
                   values:@[ operationId ]];
           if (!rows.count) return json(@{@"state" : @"unknown"});
           return json(@{
             @"state" : @"committed",
             @"revision" : rows[0][0],
             @"kind" : rows[0][1],
             @"disposition" : rows[0][2]
           });
         }];
}
- (void)publishDisplay:(NSString *)scope
                 owner:(NSString *)owner
              proposal:(NSString *)proposal
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value lease:owner];
           return [value publishDisplay:proposal];
         }];
}
- (void)closeGate:(NSString *)scope
            owner:(NSString *)owner
           intent:(double)intent
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           @synchronized(value) {
             if (intent > value.intent) fail(@"superseded");
             value.ready = NO;
           }
           return [value transaction:^id {

             return nil;
           }];
         }];
}
- (void)publishBinding:(NSString *)scope
                 owner:(NSString *)owner
                intent:(double)intent
               binding:(NSString *)encoded
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value check:intent];
           NSDictionary *proof = object(encoded);
           if (![proof[@"bindingRevision"] isEqual:proof[@"acknowledgedBindingRevision"]])
             fail(@"binding_unacknowledged");
           NSNumber *generation = proof[@"generation"];
           if (generation.doubleValue < 0 || generation.doubleValue > 9007199254740991.0)
             fail(@"invalid_binding");
           [value transaction:^id {
             id prior = [value sql:@"SELECT installation FROM metadata WHERE id=1"
                            values:@[]][0][0];
             if (prior != NSNull.null && ![prior isEqual:proof[@"installationId"]])
               fail(@"journal_installation_mismatch");
             NSArray *control =
                 [value sql:@"SELECT installation_id,user_id,binding_revision,"
                            @"acknowledged_binding_revision FROM control WHERE id=1"
                     values:@[]];
             if (!control.count || ![control[0][0] isEqual:proof[@"installationId"]] ||
                 ![control[0][1] isEqual:proof[@"userId"] ?: NSNull.null] ||
                 control[0][3] == NSNull.null ||
                 ![control[0][2] isEqual:proof[@"bindingRevision"]] ||
                 ![control[0][3] isEqual:proof[@"acknowledgedBindingRevision"]])
               fail(@"binding_unacknowledged");
             [value sql:@"INSERT OR IGNORE INTO streams VALUES(?,?,1,0)"
                 values:@[ generation, proof[@"userId"] ]];
             if (![[value sql:@"SELECT user_id FROM streams WHERE generation=?"
                       values:@[ generation ]][0][0] isEqual:proof[@"userId"]])
               fail(@"binding_generation_conflict");
             [value sql:@"UPDATE metadata SET installation=?,binding=? WHERE id=1" values:@[ proof[@"installationId"], json(proof) ]];
             [value sql:@"UPDATE interactions SET status='retired' WHERE status='pending' AND (user_id IS NOT ? OR binding_generation<>?)" values:@[ proof[@"userId"], generation ]];
             return nil;
           }];
           @synchronized(value) {
             [value check:intent];
             value.binding = proof;
             value.ready = YES;
           }
           [value importReceipts];
           [value drain];
           return nil;
         }];
}
- (void)admitEvent:(NSString *)scope
             owner:(NSString *)owner
            ticket:(NSString *)identifier
             event:(NSString *)encoded
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  @synchronized(value) {
    GJTicket *found;
    for (GJTicket *ticket in value.tickets)
      if ([ticket.identifier isEqual:identifier]) {
        found = ticket;
        break;
      }
    if (!found) {
      reject(@"ticket_missing", @"ticket_missing", nil);
      return;
    }
    @try {
      NSDictionary *event = object(encoded);
      if (found.event && ![found.event isEqual:event]) fail(@"event_conflict");
      found.event = event;
      [found.waiters addObject:@[ [resolve copy], [reject copy] ]];
    } @catch (NSException *error) {
      if (!found.event) found.rejected = YES;
      reject(error.name, error.name, nil);
    }
  }
  dispatch_async(value.queue, ^{
    [value drain];
  });
}
- (void)peek:(NSString *)scope
       owner:(NSString *)owner
      intent:(double)intent
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           [value check:intent];
           NSDictionary *proof;
           NSUInteger pending = 0;
           @synchronized(value) {
             if (!value.ready) fail(@"binding_unacknowledged");
             proof = value.binding;
             for (GJTicket *ticket in value.tickets)
               if (!ticket.rejected && ticket.intent == intent) pending++;
           }
           NSNumber *generation = proof[@"generation"];
           long long ack = [value number:@"SELECT acknowledged FROM streams WHERE generation=?"
                              generation:generation];
           [value importReceipts];
           [value drain];
           NSArray *commands = [value transaction:^id {
             NSArray *saved = [value sql:@"SELECT body FROM batches WHERE generation=?"
                                  values:@[ generation ]];
             if (saved.count)
               return [NSJSONSerialization
                   JSONObjectWithData:[saved[0][0] dataUsingEncoding:NSUTF8StringEncoding]
                              options:0
                                error:nil];
             NSMutableArray *batch = [NSMutableArray new];
             NSNumber *through = @(ack);
             for (NSArray *row in [value sql:@"SELECT body FROM commands WHERE generation=? AND "
                                             @"sequence>? ORDER BY sequence LIMIT 32"
                                      values:@[ generation, @(ack) ]]) {
               NSDictionary *command = object(row[0]);
               [batch addObject:command];
               if ([json(@{@"bindingGeneration" : generation, @"commands" : batch})
                       lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 65536) {
                 [batch removeLastObject];
                 break;
               }
               through = command[@"sequence"];
             }
             if (batch.count)
               [value sql:@"INSERT INTO batches VALUES(?,?,?)"
                   values:@[ generation, through, json(batch) ]];
             return batch;
           }];
           return json(@{
             @"generation" : generation,
             @"acknowledgedThrough" : @(ack),
             @"lastSequence" :
                 @([value number:@"SELECT next_sequence-1 FROM streams WHERE generation=?"
                      generation:generation]),
             @"appConfirmed" : @([proof[@"appConfirmed"] boolValue]),
             @"commands" : commands,
             @"pendingAdmissions" : @(pending),
             @"appConfirmed" :
                 @([proof[@"appConfirmed"] boolValue] && proof[@"userId"] != NSNull.null)
           });
         }];
}
- (void)acknowledge:(NSString *)scope
              owner:(NSString *)owner
             intent:(double)intent
         generation:(double)generation
            through:(double)through
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value check:intent];
           return [value transaction:^id {
             if (!value.ready || [value.binding[@"generation"] doubleValue] != generation)
               fail(@"superseded");
             if (through < 0 ||
                 through >= [value number:@"SELECT next_sequence FROM streams WHERE generation=?"
                                generation:@(generation)])
               fail(@"invalid_acknowledgement");
             if (through != [value number:@"SELECT through FROM batches WHERE generation=?"
                                generation:@(generation)])
               fail(@"invalid_acknowledgement");
             [value sql:@"UPDATE streams SET acknowledged=MAX(acknowledged,?) WHERE generation=?"
                 values:@[ @(through), @(generation) ]];
             [value sql:@"DELETE FROM batches WHERE generation=?" values:@[ @(generation) ]];
             return nil;
           }];
         }];
}
- (void)detach:(GJActor *)value
       dispose:(BOOL)dispose
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
  @synchronized(value) {
    value.ready = NO;
    value.released = YES;
    value.interactionListener = nil;
    value.inFlight++;
    value.displayFence++;
    if (dispose) {
      value.displayOpen = NO;
      value.restrictions++;
    }
    for (GJTicket *ticket in value.tickets) ticket.rejected = YES;
    [value.proposals removeAllObjects];
  }
  [value work:resolve
       reject:reject
         body:^id {
           @try {
           [value drain];
           if (value->db) {
             [value transaction:^id {

               if (dispose) {
                 [value sql:@"UPDATE control SET display='closed' WHERE id=1" values:@[]];
                 [value requireNotificationCleanup:[value controlRow] clear:YES];
                 value.needsNotificationCleanup = YES;

               }
               return nil;
             }];
           }
           return nil;
           } @finally { @synchronized(value) { value.inFlight--; } }
         }];
}
- (void)configureNotifications:(NSString *)scope
                         owner:(NSString *)owner
                         setup:(NSString *)encoded
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           NSMutableDictionary *setup = object(encoded);
           if (!setup[@"foreground"]) setup[@"foreground"] = @"display";
           if (!setup[@"actions"]) setup[@"actions"] = @[];
           if (!setup[@"channels"]) setup[@"channels"] = @[];
           NSString *foreground = setup[@"foreground"];
           if (![foreground isEqual:@"display"] && ![foreground isEqual:@"suppress"]) fail(@"invalid_setup");
           if (![setup[@"actions"] isKindOfClass:NSArray.class]) fail(@"invalid_setup");
           NSDictionary *previous = [value settings];
           NSArray *prior = [previous[@"categories"] valueForKey:@"id"];
           NSDictionary *capabilities = [GalinumNotifications setup:setup replacing:prior];
           @try {
             [value transaction:^id {
               [value sql:@"INSERT OR REPLACE INTO settings VALUES(1,?,?,?,?)"
                   values:@[ foreground, json(capabilities[@"channels"]), json(setup[@"actions"]), json(setup[@"categories"] ?: @[]) ]];
               checkpoint(@"notifications-commit-before");
               return nil;
             }];
           } @catch (NSException *error) {
             @try { [GalinumNotifications setup:previous replacing:[capabilities[@"categories"] valueForKey:@"id"]]; }
             @catch (NSException *rollback) { record(@"notifications-rollback-failed", @{}, owner); }
             @throw error;
           }
           record(@"notifications-configured", capabilities, owner);
           return json(capabilities);
         }];
}
- (void)readInteractions:(NSString *)scope
                   owner:(NSString *)owner
                  intent:(double)intent
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           [value check:intent];
           NSDictionary *proof;
           @synchronized(value) {
             if (!value.ready) fail(@"binding_unacknowledged");
             proof = value.binding;
           }
           if (![proof[@"appConfirmed"] boolValue] || proof[@"userId"] == NSNull.null) fail(@"binding_unacknowledged");
           NSMutableArray *interactions = [NSMutableArray new];
           for (NSArray *row in [value sql:@"SELECT i.id,i.kind,i.action_id,i.target_id,i.attempt_id,i.user_id,i.binding_generation,i.envelope,i.received_at,i.interacted_at FROM interactions i JOIN observations o ON o.ordinal=i.ordinal WHERE i.status='pending' AND o.status='admitted' AND i.user_id=? AND i.binding_generation=? ORDER BY i.ordinal"
                                     values:@[ proof[@"userId"], proof[@"generation"] ]]) {
             NSDictionary *envelope = object(row[7]), *content = envelope[@"content"];
             NSMutableDictionary *entry = [@{
               @"id" : row[0], @"kind" : row[1], @"targetId" : row[3], @"attemptId" : row[4],
               @"test" : @([envelope[@"test"] boolValue]), @"userId" : row[5], @"bindingGeneration" : row[6],
               @"destination" : content[@"destination"],
               @"data" : [content[@"data"] isKindOfClass:NSDictionary.class] ? content[@"data"] : @{},
               @"title" : content[@"title"], @"body" : content[@"body"], @"receivedAt" : row[8], @"interactedAt" : row[9]
             } mutableCopy];
             if (row[2] != NSNull.null) entry[@"actionId"] = row[2];
             [interactions addObject:entry];
           }
           return json(interactions);
         }];
}
- (void)acknowledgeInteraction:(NSString *)scope
                         owner:(NSString *)owner
                        intent:(double)intent
                 interactionId:(NSString *)interactionId
                   disposition:(NSString *)disposition
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           [value check:intent];
           if (![disposition isEqual:@"handled"] && ![disposition isEqual:@"retired"]) fail(@"invalid_disposition");
           [value transaction:^id {
             [value sql:@"UPDATE interactions SET status=? WHERE id=? AND status='pending'" values:@[ disposition, interactionId ]];
             return nil;
           }];
           record(@"interaction-acknowledged", @{@"disposition" : disposition}, interactionId);
           return nil;
         }];
}
- (void)readCompletion:(NSString *)scope
                 owner:(NSString *)owner
                userId:(NSString *)userId
            deliveryId:(NSString *)deliveryId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           if (!userId.length || !deliveryId.length) fail(@"invalid_feedback");
           return @([value sql:@"SELECT 1 FROM completions WHERE user_id=? AND delivery_id=?" values:@[ userId, deliveryId ]].count > 0);
         }];
}
- (void)admitFeedback:(NSString *)scope
                owner:(NSString *)owner
             feedback:(NSString *)encoded
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           NSDictionary *feedback;
           @try {
             feedback = object(encoded);
           } @catch (NSException *invalid) {
             fail(@"invalid_feedback");
           }
           NSString *(^text)(NSString *) = ^NSString *(NSString *key) {
             return [feedback[key] isKindOfClass:NSString.class] ? feedback[key] : @"";
           };
           NSString *user = text(@"userId"), *delivery = text(@"deliveryId"), *type = text(@"type"), *identifier = text(@"feedbackId"), *shown = text(@"shownFeedbackId");
           BOOL terminal = [@[ @"clicked", @"dismissed", @"converted" ] containsObject:type];
           if (!user.length || user.length > 256 || !delivery.length || delivery.length > 256 || !identifier.length || identifier.length > 256 ||
               !([type isEqual:@"shown"] || terminal) || (terminal ? !shown.length : shown.length && ![shown isEqual:identifier]))
             fail(@"invalid_feedback");
           NSDictionary *receipt = [value transaction:^id {
             NSArray *rows = [value sql:@"SELECT user_id,delivery_id,type,shown_feedback_id,status FROM feedback WHERE feedback_id=?" values:@[ identifier ]];
             if (rows.count) {
               NSArray *row = rows[0];
               NSString *priorShown = row[3] == NSNull.null ? @"" : row[3];
               if (![row[0] isEqual:user] || ![row[1] isEqual:delivery] || ![row[2] isEqual:type] || ![priorShown isEqual:(terminal ? shown : @"")])
                 fail(@"feedback_conflict");
               return @{@"feedbackId" : identifier, @"state" : [row[4] isEqual:@"acknowledged"] ? @"acknowledged" : @"queued"};
             }
             if (terminal) {
               if (![value sql:@"SELECT 1 FROM feedback WHERE feedback_id=? AND user_id=? AND delivery_id=? AND type='shown'" values:@[ shown, user, delivery ]].count)
                 fail(@"feedback_shown_required");
               [value sql:@"INSERT OR IGNORE INTO completions VALUES(?,?,?,?)" values:@[ user, delivery, identifier, @(now()) ]];
             }
             [value sql:@"INSERT INTO feedback(feedback_id,user_id,delivery_id,type,shown_feedback_id,status,receipt,created_at) VALUES(?,?,?,?,?,'pending',NULL,?)"
                 values:@[ identifier, user, delivery, type, terminal ? shown : NSNull.null, @(now()) ]];
             checkpoint(@"feedback-commit-before");
             return @{@"feedbackId" : identifier, @"state" : @"queued"};
           }];
           NSMutableDictionary *recorded = [receipt mutableCopy];
           recorded[@"type"] = type;
           record(@"feedback-admitted", recorded, identifier);
           return json(receipt);
         }];
}
- (void)peekFeedback:(NSString *)scope
               owner:(NSString *)owner
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           NSMutableArray *pending = [NSMutableArray new];
           for (NSArray *row in [value sql:@"SELECT feedback_id,user_id,delivery_id,type,shown_feedback_id FROM feedback WHERE status='pending' ORDER BY ordinal LIMIT 32" values:@[]])
             [pending addObject:@{@"feedbackId" : row[0], @"userId" : row[1], @"deliveryId" : row[2], @"type" : row[3], @"shownFeedbackId" : row[4] == NSNull.null ? row[0] : row[4]}];
           return json(pending);
         }];
}
- (void)acknowledgeFeedback:(NSString *)scope
                      owner:(NSString *)owner
                 feedbackId:(NSString *)feedbackId
                    receipt:(NSString *)encoded
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           NSDictionary *receipt;
           @try {
             receipt = object(encoded);
           } @catch (NSException *invalid) {
             fail(@"feedback_receipt_mismatch");
           }
           [value transaction:^id {
             NSArray *rows = [value sql:@"SELECT user_id,delivery_id,type,status FROM feedback WHERE feedback_id=?" values:@[ feedbackId ]];
             if (!rows.count) fail(@"feedback_receipt_mismatch");
             NSArray *row = rows[0];
             NSNumber *at = [receipt[@"acknowledgedAt"] isKindOfClass:NSNumber.class] ? receipt[@"acknowledgedAt"] : nil;
             if (![receipt[@"userId"] isEqual:row[0]] || ![receipt[@"deliveryId"] isEqual:row[1]] || ![receipt[@"type"] isEqual:row[2]] ||
                 ![receipt[@"receiptId"] isEqual:feedbackId] || !at || !isfinite(at.doubleValue) || at.doubleValue < 0)
               fail(@"feedback_receipt_mismatch");
             [value sql:@"UPDATE feedback SET status='acknowledged',receipt=? WHERE feedback_id=?" values:@[ json(receipt), feedbackId ]];
             return nil;
           }];
           record(@"feedback-acknowledged", @{}, feedbackId);
           return nil;
         }];
}
- (void)cancelNotifications:(NSString *)scope
                      owner:(NSString *)owner
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value work:resolve
       reject:reject
         body:^id {
           [value opened];
           [value lease:owner];
           [value cleanupNotifications];
           record(@"notifications-cancelled", @{}, owner);
           return nil;
         }];
}
- (void)release:(NSString *)scope
          owner:(NSString *)owner
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  @synchronized(self) {
    [self.owned removeObjectForKey:scope];
  }
  [self detach:actor(scope, owner) dispose:YES resolve:resolve reject:reject];
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeGalinumJournalSpecJSI>(params);
}
@end
