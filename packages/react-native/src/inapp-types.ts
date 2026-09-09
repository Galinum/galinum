import type { InAppDecisionInput, InAppFeedbackInput } from '@galinum/contracts';

export type InAppSession = Readonly<{ owner: string; userId: string | null; facts: number; appConfirmed: boolean }>;
export type InAppDestination = { kind: 'website' | 'app'; url: string };
export type InAppMessage = {
  deliveryId: string; campaignId: string; variantId: string;
  pages?: string[] | null;
  content: {
    title?: string; body?: string; presentation?: 'toast' | 'modal';
    media?: { url: string; alt?: string; decorative?: boolean };
    cta?: { label: string; destination?: InAppDestination };
    [key: string]: unknown;
  };
};
export type InAppDecision = { userId: string; entryId: string; requestId: string; messages: InAppMessage[] };
export interface InAppClientPort {
  getSnapshot(): InAppSession;
  subscribe(listener: () => void): () => void;
  decide(input: InAppDecisionInput, signal: AbortSignal): Promise<InAppDecision>;
}
export type InAppFeedback = InAppFeedbackInput & { deliveryId: string; shownFeedbackId: string };
export interface FeedbackPort {
  isCompleted(userId: string, deliveryId: string): Promise<boolean>;
  admit(input: InAppFeedback): Promise<{ feedbackId: string; state: 'queued' | 'acknowledged' }>;
  flush(): Promise<void>;
}
export type InAppActions = { dismiss(): Promise<void>; click(): Promise<void>; retry(): Promise<void> };
