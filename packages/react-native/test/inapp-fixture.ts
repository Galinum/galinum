import type { InAppDecisionInput } from '@galinum/contracts';
import { getInAppController } from '../src/inapp-controller.js';
import type { FeedbackPort, InAppClientPort, InAppDecision, InAppFeedback, InAppMessage, InAppSession } from '../src/inapp-types.js';

export const inAppMessage = (id: string, presentation: 'toast' | 'modal' = 'toast'): InAppMessage => ({ deliveryId: id, campaignId: 'campaign-' + id, variantId: 'variant-' + id, content: { title: 'Update ' + id, body: 'Your report is ready.', presentation } });
export function inAppFixture() {
  let session: InAppSession = { owner: 'owner-A', userId: 'A', facts: 0, appConfirmed: true };
  const listeners = new Set<() => void>();
  const requests: { input: InAppDecisionInput; signal: AbortSignal; resolve(value: InAppDecision): void; reject(error: Error): void }[] = [];
  const admissions: InAppFeedback[] = [];
  const completed = new Set<string>();
  const destinations: string[] = [];
  let failure: InAppFeedback['type'] | undefined;
  let id = 0;
  const client: InAppClientPort = {
    getSnapshot: () => session,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    decide: (input, signal) => new Promise((resolve, reject) => { requests.push({ input, signal, resolve, reject }); }),
  };
  const feedback: FeedbackPort = {
    isCompleted: async (userId, deliveryId) => completed.has(JSON.stringify([userId, deliveryId])),
    admit: async input => {
      admissions.push({ ...input });
      if (input.type === failure) throw new Error('Injected journal admission failure');
      if (input.type !== 'shown') completed.add(JSON.stringify([input.userId, input.deliveryId]));
      return { feedbackId: input.feedbackId, state: 'queued' };
    },
    flush: async () => {},
  };
  const controller = getInAppController(client, feedback, { id: () => 'id-' + ++id, timeoutMs: 50, appSchemes: ['galinum-proof'], openDestination: async destination => { destinations.push(destination.url); } });
  return { client, feedback, controller, requests, admissions, completed, destinations,
    session: (next: Partial<InAppSession>) => { session = { ...session, ...next }; for (const listener of listeners) listener(); },
    fail: (type?: InAppFeedback['type']) => { failure = type; },
    enter: (key = 'home', path = '/') => { controller.navigate(key, path, true); controller.foreground(true); },
    respond: (messages: InAppMessage[], index = requests.length - 1, overrides: Partial<InAppDecision> = {}) => { const request = requests[index]!; request.resolve({ ...request.input, messages, ...overrides }); },
  };
}
