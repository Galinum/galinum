#import <Foundation/Foundation.h>
#include <sqlite3.h>
#import "GalinumJournalText.h"

int main() {
  @autoreleasepool {
    sqlite3 *db;
    if (sqlite3_open(":memory:", &db) != SQLITE_OK) return 1;
    sqlite3_exec(db, "CREATE TABLE events(id TEXT PRIMARY KEY)", nullptr, nullptr, nullptr);
    NSArray *ids = @[
      [[NSString alloc] initWithBytes:"job\0a" length:5 encoding:NSUTF8StringEncoding],
      [[NSString alloc] initWithBytes:"job\0b" length:5 encoding:NSUTF8StringEncoding],
      @"multibyte-雪-🎉", @""
    ];
    for (NSString *value in ids) {
      sqlite3_stmt *stmt;
      if (sqlite3_prepare_v2(db, "INSERT INTO events VALUES(?)", -1, &stmt, nullptr) != SQLITE_OK) return 2;
      if (GJBindText(stmt, 1, value) != SQLITE_OK || sqlite3_step(stmt) != SQLITE_DONE) return 3;
      sqlite3_finalize(stmt);
    }
    sqlite3_exec(db, "CREATE TABLE legacy(id TEXT PRIMARY KEY)", nullptr, nullptr, nullptr);
    NSMutableArray *legacyInserts = [NSMutableArray new];
    for (NSString *value in [ids subarrayWithRange:NSMakeRange(0, 2)]) {
      sqlite3_stmt *legacyStatement;
      sqlite3_prepare_v2(db, "INSERT INTO legacy VALUES(?)", -1, &legacyStatement, nullptr);
      sqlite3_bind_text(legacyStatement, 1, value.UTF8String, -1, SQLITE_TRANSIENT);
      [legacyInserts addObject:@(sqlite3_step(legacyStatement))];
      sqlite3_finalize(legacyStatement);
    }
    BOOL legacyBindCollision = [legacyInserts[0] intValue] == SQLITE_DONE && [legacyInserts[1] intValue] == SQLITE_CONSTRAINT;
    NSMutableArray *actual = [NSMutableArray new];
    NSMutableArray *legacy = [NSMutableArray new];
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db, "SELECT id FROM events ORDER BY rowid", -1, &stmt, nullptr);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
      [actual addObject:GJReadText(stmt, 0)];
      [legacy addObject:[NSString stringWithUTF8String:(const char *)sqlite3_column_text(stmt, 0)]];
    }
    BOOL distinct = [actual isEqual:ids] && ![actual[0] isEqual:actual[1]];
    BOOL legacyReadCollision = [legacy[0] isEqual:legacy[1]];
    NSDictionary *result = @{@"sqliteVersion": @(sqlite3_libversion()), @"roundtrip": actual,
      @"legacyReads": legacy, @"legacyBindCollision": @(legacyBindCollision), @"legacyReadCollision": @(legacyReadCollision),
      @"explicitLengthDistinctRoundtrip": @(distinct)};
    puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:result options:0 error:nil]
                              encoding:NSUTF8StringEncoding].UTF8String);
    sqlite3_finalize(stmt);
    sqlite3_close(db);
    return distinct && legacyReadCollision && legacyBindCollision ? 0 : 4;
  }
}
