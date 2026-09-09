#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^GalinumJournalSubmission)(NSDictionary *publication);
typedef void (^GalinumJournalCompletion)(NSDictionary *_Nullable result, NSString *_Nullable code);

FOUNDATION_EXPORT NSString *GalinumJournalReserveObservation(NSString *scope, NSDictionary *observation);
FOUNDATION_EXPORT BOOL GalinumJournalOwnerAttached(NSString *scope);
FOUNDATION_EXPORT NSDictionary *_Nullable GalinumJournalPublishedBinding(NSString *scope);
FOUNDATION_EXPORT void GalinumJournalSetClaimObserver(void (^_Nullable observer)(NSString *scope));
FOUNDATION_EXPORT void GalinumJournalSubmitIfCurrent(NSString *scope, GalinumJournalSubmission submission, GalinumJournalCompletion completion);
FOUNDATION_EXPORT NSURL *GalinumJournalDirectory(void);
FOUNDATION_EXPORT NSDictionary *_Nullable GalinumJournalParseEnvelope(NSDictionary *_Nullable userInfo);
FOUNDATION_EXPORT void GalinumJournalPresent(NSDictionary *envelope, dispatch_block_t handoff, GalinumJournalCompletion completion);
FOUNDATION_EXPORT void GalinumJournalIngress(NSDictionary *envelope, BOOL foreground, GalinumJournalCompletion completion);
FOUNDATION_EXPORT void GalinumJournalCaptureInteraction(NSDictionary *envelope, NSString *_Nullable actionId, GalinumJournalCompletion completion);
FOUNDATION_EXPORT void GalinumJournalCaptureResponse(NSDictionary *envelope, NSString *responseId, NSString *_Nullable actionId, GalinumJournalCompletion completion);
FOUNDATION_EXPORT NSString *_Nullable GalinumJournalScopeForInstallation(NSString *installationId);

NS_ASSUME_NONNULL_END
