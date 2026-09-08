#import <Foundation/Foundation.h>
#include <limits.h>

static inline int GJBindText(sqlite3_stmt *statement, int index, NSString *value) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) return SQLITE_MISMATCH;
  if (data.length > INT_MAX) return SQLITE_TOOBIG;
  return sqlite3_bind_text(statement, index, data.length ? (const char *)data.bytes : "",
                           (int)data.length, SQLITE_TRANSIENT);
}

static inline NSString *GJReadText(sqlite3_stmt *statement, int column) {
  const void *bytes = sqlite3_column_text(statement, column);
  int length = sqlite3_column_bytes(statement, column);
  if (!bytes && length) return nil;
  return [[NSString alloc] initWithBytes:bytes ? bytes : "" length:(NSUInteger)length
                               encoding:NSUTF8StringEncoding];
}
