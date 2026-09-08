#import "GalinumJournal.h"
#import <Security/Security.h>
#import <SQLCipher/sqlite3.h>
#import "GalinumJournalText.h"

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
@property double intent;
@property unsigned long long ordinal;
@property unsigned long long proposalOrdinal;
@property long long lastOperation;
@property NSInteger inFlight;
@property long long displayFence, restrictions;
@property BOOL displayOpen;
@property BOOL ready;
@property BOOL released;
@property BOOL initialResolved;
- (void)drain;
- (void)bootstrap;
- (NSDictionary *)controlRow;
@end

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
    return entry.identifier;
  }
}
- (void)opened {
  if (!db) fail(@"journal_not_open");
}
- (NSArray *)sql:(NSString *)sql values:(NSArray *)values {
  sqlite3_stmt *statement = nullptr;
  int rc = sqlite3_prepare_v2(db, sql.UTF8String, -1, &statement, nullptr);
  if (rc != SQLITE_OK)
    fail(rc == SQLITE_FULL ? @"journal_storage_full" : @"journal_storage_failure");
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
    if (rc != SQLITE_DONE)
      fail(rc == SQLITE_FULL ? @"journal_storage_full" : @"journal_storage_failure");
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
    return json(@{@"id" : ticket.identifier, @"eventId" : ticket.eventId});
  }
}
- (NSString *)reserveObservation:(NSDictionary *)observation {
  @synchronized(self) {
    GJTicket *ticket = [GJTicket new];
    ticket.identifier = [NSString stringWithFormat:@"%@:%llu", self.owner, ++self.ordinal];
    ticket.eventId = ticket.identifier;
    ticket.intent = self.intent;
    ticket.waiters = [NSMutableArray new];
    ticket.observation = object(json(observation));
    [self.tickets addObject:ticket];
    dispatch_async(self.queue, ^{
      [self drain];
    });
    return ticket.identifier;
  }
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
  if (db) return;
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
    key = [self createKey];
  } else if ([registry[@"stage"] isEqual:@"ready"]) {
    if (!dbExists) fail(@"journal_state_loss");
    key = [self readKey];
    if (!key) fail(@"journal_key_missing");
  } else {
    key = [self readKey];
    if (!key) {
      if (dbExists) fail(@"journal_key_missing");
      key = [self createKey];
    }
  }
  NSString *expected = registry[@"incarnation"];
  [self openDatabase:key incarnation:expected];
  if (![registry[@"stage"] isEqual:@"ready"]) {
    registry[@"stage"] = @"ready";
    [self writeRegistry:registry];
  }
  self.incarnation = expected;
  NSDictionary *row = [self controlRow];
  @synchronized(self) {
    if (self.restrictions == 0) self.displayOpen = row && row[@"publication"] != NSNull.null;
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
    [self sql:@"INSERT OR IGNORE INTO metadata VALUES(1,2,NULL,?)" values:@[ expected ]];
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
    [self sql:@"INSERT OR REPLACE INTO control VALUES(1,?,?,?,?,?,?,?,?,?,?,?)"
        values:@[
          @(next), state[@"scope"], state[@"installationId"], user, @(consent ? 1 : 0),
          @(bindingRevision), acknowledged, pending, token ? token[@"hash"] : NSNull.null,
          token ? token[@"revision"] : NSNull.null, display
        ]];
    [self sql:@"DELETE FROM operations" values:@[]];
    [self sql:@"INSERT INTO operations VALUES(?,?,?,?)"
        values:@[ operationId, @(next), @"control", restrictive ? @"closed" : @"kept" ]];
    return @{
      @"operationId" : operationId,
      @"revision" : @(next),
      @"display" : [display isEqual:@"closed"] ? @"closed" : @"open",
      @"restrictive" : @(restrictive)
    };
  }];
  @synchronized(self) {
    if (restrictive) self.displayOpen = NO;
  }
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
    [self sql:@"UPDATE control SET display=? WHERE id=1" values:@[ json(publication) ]];
    [self sql:@"DELETE FROM operations WHERE kind='open'" values:@[]];
    [self sql:@"INSERT INTO operations VALUES(?,?,?,?)"
        values:@[ proposal.identifier, row[0], @"open", @"open" ]];
    return publication;
  }] mutableCopy];
  @synchronized(self) {
    BOOL current = proposal.fence == self.displayFence && !self.released;
    if (current) self.displayOpen = YES;
    receipt[@"state"] = current ? @"open" : @"open-then-restricted";
  }
  return json(receipt);
}
- (NSString *)persist:(GJTicket *)ticket proof:(NSDictionary *)proof {
  [self check:ticket.intent];
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
- (void)drain {
  while (YES) {
    GJTicket *ticket;
    NSDictionary *proof;
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
      if (!db || !self.ready || (!ticket.event && !ticket.observation)) return;
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
static GJActor *actor(NSString *scope, NSString *owner) {
  @synchronized(GJActor.class) {
    GJActor *value = actors[scope];
    if (!value || value.released || ![value.owner isEqual:owner]) fail(@"journal_owner_stale");
    return value;
  }
}
static GJActor *actorForScope(NSString *scope) {
  @synchronized(GJActor.class) {
    if (!actors) actors = [NSMutableDictionary new];
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
    NSURL *root = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                         inDomains:NSUserDomainMask]
                      .firstObject;
    NSURL *directory = [root URLByAppendingPathComponent:@"GalinumJournal" isDirectory:YES];
    value.file = [directory URLByAppendingPathComponent:[scope stringByAppendingString:@".db"]];
    value.registry =
        [directory URLByAppendingPathComponent:[scope stringByAppendingString:@".control.json"]];
    actors[scope] = value;
    return value;
  }
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
- (NSString *)claim:(NSString *)scope {
  NSString *owner = [actorForScope(scope) attach];
  @synchronized(self) {
    if (!self.owned) self.owned = [NSMutableDictionary new];
    self.owned[scope] = owner;
  }
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
             [value sql:@"UPDATE metadata SET installation=? WHERE id=1" values:@[ proof[@"installationId"] ]];
             return nil;
           }];
           @synchronized(value) {
             [value check:intent];
             value.binding = proof;
             value.ready = YES;
           }
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

               }
               return nil;
             }];
           }
           return nil;
           } @finally { @synchronized(value) { value.inFlight--; } }
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
