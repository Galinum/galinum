#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

NS_ASSUME_NONNULL_BEGIN

@interface GalinumNotifications : NSObject <UNUserNotificationCenterDelegate>
+ (instancetype)shared;
+ (void)install;
+ (NSDictionary *)setup:(NSDictionary *)setup replacing:(NSArray *)prior;
+ (void)cancelForInstallation:(NSString *)installationId throughGeneration:(NSNumber *)through keepingGenerations:(NSSet<NSNumber *> *)generations authorize:(BOOL (^)(dispatch_block_t cancellation))authorize completion:(void (^)(NSUInteger removed, BOOL complete))completion;
+ (BOOL)serviceExtensionPresent;
@property(nonatomic, weak, readonly, nullable) id<UNUserNotificationCenterDelegate> previous;
@end

NS_ASSUME_NONNULL_END
