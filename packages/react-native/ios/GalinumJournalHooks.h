#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol GalinumJournalHooks <NSObject>
@optional
- (void)checkpoint:(NSString *)point;
- (void)event:(NSString *)kind data:(NSDictionary *)data detail:(NSString *)detail;
@end

FOUNDATION_EXPORT void GalinumJournalSetHooks(id<GalinumJournalHooks> _Nullable hooks);

NS_ASSUME_NONNULL_END
