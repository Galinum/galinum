#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSDictionary *GalinumJournalInspect(NSString *scope);
FOUNDATION_EXPORT NSDictionary *GalinumJournalFiles(NSString *scope);
FOUNDATION_EXPORT void GalinumJournalExecute(NSString *scope, NSString *sql);
FOUNDATION_EXPORT void GalinumJournalOnQueue(NSString *scope, void (^body)(void), void (^_Nullable completion)(NSString *_Nullable code));
FOUNDATION_EXPORT void GalinumJournalReloadLease(NSString *scope, NSString *owner);
FOUNDATION_EXPORT NSDictionary *GalinumJournalCapacity(NSString *scope, NSString *owner, BOOL constrained);

NS_ASSUME_NONNULL_END
