#import "GalinumJournal.h"
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

@interface GJActor : NSObject {
 @public
  sqlite3 *db;
}
@property(nonatomic, copy) NSString *owner;
@property(nonatomic, copy) NSString *scope;
@property(nonatomic, strong) NSURL *file;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) NSMutableArray<GJTicket *> *tickets;
@property(nonatomic, copy) NSDictionary *binding;
@property double intent;
@property unsigned long long ordinal;
@property BOOL ready;
@property BOOL released;
@property BOOL initialResolved;
- (void)drain;
@end

@implementation GJActor
- (void)check:(double)intent {
  @synchronized(self) {
    if (self.released || intent != self.intent) fail(@"superseded");
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
- (void)setCapturedIntent:(double)intent {
  @synchronized(self) {
    if (intent < self.intent) fail(@"superseded");
    self.intent = intent;
    self.ready = NO;
    for (GJTicket *ticket in self.tickets)
      if (ticket.intent < intent && (ticket.intent != 0 || self.initialResolved))
        ticket.rejected = YES;
  }
  dispatch_async(self.queue, ^{
    [self drain];
  });
}
- (void)work:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject
        body:(id (^)(void))body {
  dispatch_async(self.queue, ^{
    @try {
      resolve(body());
    } @catch (NSException *error) {
      reject(error.name, error.name, nil);
    }
  });
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
      [self release:scope
              owner:owned[scope]
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
  @synchronized(GJActor.class) {
    if (!actors) actors = [NSMutableDictionary new];
    if (actors[scope]) fail(@"journal_writer_busy");
    if (scope.length != 64 ||
        [scope rangeOfCharacterFromSet:[[NSCharacterSet
                                           characterSetWithCharactersInString:@"0123456789abcdef"]
                                           invertedSet]]
                .location != NSNotFound)
      fail(@"invalid_scope");
    GJActor *value = [GJActor new];
    value.scope = scope;
    value.owner = NSUUID.UUID.UUIDString;
    value.queue = dispatch_queue_create("com.galinum.journal", DISPATCH_QUEUE_SERIAL);
    value.tickets = [NSMutableArray new];
    NSURL *root = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                         inDomains:NSUserDomainMask]
                      .firstObject;
    value.file = [[root URLByAppendingPathComponent:@"GalinumJournal" isDirectory:YES]
        URLByAppendingPathComponent:[scope stringByAppendingString:@".db"]];
    actors[scope] = value;
    @synchronized(self) {
      if (!self.owned) self.owned = [NSMutableDictionary new];
      self.owned[scope] = value.owner;
    }
    return value.owner;
  }
}
- (NSString *)reserve:(NSString *)scope
                owner:(NSString *)owner
               intent:(double)intent
              eventId:(NSString *)eventId {
  return [actor(scope, owner) reserve:intent eventId:eventId];
}
- (void)resolveInitialIntent:(NSString *)scope
                       owner:(NSString *)owner
                 destination:(double)destination {
  GJActor *value = actor(scope, owner);
  @synchronized(value) {
    if (value.initialResolved) return;
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
}
- (void)setIntent:(NSString *)scope owner:(NSString *)owner intent:(double)intent {
  [actor(scope, owner) setCapturedIntent:intent];
}
- (void)rejectTicket:(NSString *)scope owner:(NSString *)owner ticket:(NSString *)identifier {
  GJActor *value = actor(scope, owner);
  @synchronized(value) {
    for (GJTicket *ticket in value.tickets)
      if ([ticket.identifier isEqual:identifier]) ticket.rejected = YES;
  }
  dispatch_async(value.queue, ^{
    [value drain];
  });
}
- (void)hasStore:(NSString *)scope
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  GJActor *value;
  @synchronized(GJActor.class) {
    value = actors[scope];
  }
  if (!value) {
    reject(@"journal_owner_stale", @"journal_owner_stale", nil);
    return;
  }
  [value work:resolve
       reject:reject
         body:^id {
           return @([[NSFileManager defaultManager] fileExistsAtPath:value.file.path]);
         }];
}
- (void)open:(NSString *)scope
       owner:(NSString *)owner
         key:(NSString *)key
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  [value
        work:resolve
      reject:reject
        body:^id {
          if (value->db) return nil;
          if (key.length != 64 ||
              [key rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:
                                                                @"0123456789abcdef"] invertedSet]]
                      .location != NSNotFound)
            fail(@"invalid_journal_key");
          NSURL *directory = [value.file URLByDeletingLastPathComponent];
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
          @try {
            if (sqlite3_open_v2(value.file.path.UTF8String, &value->db,
                                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                                nullptr) != SQLITE_OK)
              fail(@"journal_storage_failure");
            if (sqlite3_key(value->db, key.UTF8String,
                            (int)[key lengthOfBytesUsingEncoding:NSUTF8StringEncoding]) !=
                SQLITE_OK)
              fail(@"journal_storage_failure");
            if (![value sql:@"PRAGMA cipher_version" values:@[]].count)
              fail(@"journal_cipher_unavailable");
            [value sql:@"PRAGMA journal_mode=WAL" values:@[]];
            [value sql:@"PRAGMA synchronous=FULL" values:@[]];
            [value sql:@"CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY "
                       @"CHECK(id=1),version INTEGER NOT NULL,installation TEXT,intent INTEGER NOT "
                       @"NULL,gate TEXT NOT NULL)"
                values:@[]];
            [value sql:@"INSERT OR IGNORE INTO metadata VALUES(1,1,NULL,0,'closed')" values:@[]];
            if ([value number:@"SELECT version FROM metadata WHERE id=1" generation:nil] != 1)
              fail(@"journal_version");
            [value sql:@"CREATE TABLE IF NOT EXISTS streams(generation INTEGER PRIMARY KEY,user_id "
                       @"TEXT,next_sequence INTEGER NOT NULL,acknowledged INTEGER NOT NULL)"
                values:@[]];
            [value sql:@"CREATE TABLE IF NOT EXISTS commands(generation INTEGER NOT NULL,sequence "
                       @"INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,PRIMARY "
                       @"KEY(generation,sequence)) WITHOUT ROWID"
                values:@[]];
            [value sql:@"CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,user_id TEXT "
                       @"NOT NULL,event TEXT NOT NULL,props TEXT NOT NULL,generation INTEGER NOT "
                       @"NULL,sequence INTEGER NOT NULL)"
                values:@[]];
            [value sql:@"CREATE TABLE IF NOT EXISTS batches(generation INTEGER PRIMARY KEY,through "
                       @"INTEGER NOT NULL,body TEXT NOT NULL)"
                values:@[]];
            [value sql:@"UPDATE metadata SET gate='closed' WHERE id=1" values:@[]];
          } @catch (NSException *error) {
            if (value->db) sqlite3_close(value->db);
            value->db = nullptr;
            @throw error;
          }
          return nil;
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
           double current;
           @synchronized(value) {
             if (intent > value.intent) fail(@"superseded");
             value.ready = NO;
             current = value.intent;
           }
           return [value transaction:^id {
             [value sql:@"UPDATE metadata SET intent=?,gate='closed' WHERE id=1"
                 values:@[ @(current) ]];
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
             [value sql:@"INSERT OR IGNORE INTO streams VALUES(?,?,1,0)"
                 values:@[ generation, proof[@"userId"] ]];
             if (![[value sql:@"SELECT user_id FROM streams WHERE generation=?"
                       values:@[ generation ]][0][0] isEqual:proof[@"userId"]])
               fail(@"binding_generation_conflict");
             [value sql:@"UPDATE metadata SET installation=?,intent=?,gate=? WHERE id=1"
                 values:@[ proof[@"installationId"], @(intent), encoded ]];
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
- (void)release:(NSString *)scope
          owner:(NSString *)owner
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  GJActor *value = actor(scope, owner);
  @synchronized(value) {
    value.ready = NO;
    value.released = YES;
  }
  [value work:resolve
       reject:reject
         body:^id {
           [value drain];
           if (value->db) {
             [value transaction:^id {
               [value sql:@"UPDATE metadata SET gate='closed' WHERE id=1" values:@[]];
               return nil;
             }];
             if (sqlite3_close(value->db) != SQLITE_OK) fail(@"journal_storage_failure");
             value->db = nullptr;
           }
           @synchronized(GJActor.class) {
             if (actors[scope] == value) [actors removeObjectForKey:scope];
           }
           return nil;
         }];
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeGalinumJournalSpecJSI>(params);
}
@end
