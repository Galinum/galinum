import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  claim(scope: string): string;
  reserve(scope: string, owner: string, intent: number, eventId: string): string;
  resolveInitialIntent(scope: string, owner: string, destination: number): void;
  setIntent(scope: string, owner: string, intent: number): void;
  rejectTicket(scope: string, owner: string, ticket: string): void;
  hasStore(scope: string): Promise<boolean>;
  open(scope: string, owner: string, key: string): Promise<void>;
  closeGate(scope: string, owner: string, intent: number): Promise<void>;
  publishBinding(scope: string, owner: string, intent: number, binding: string): Promise<void>;
  admitEvent(scope: string, owner: string, ticket: string, event: string): Promise<string>;
  peek(scope: string, owner: string, intent: number): Promise<string>;
  acknowledge(scope: string, owner: string, intent: number, generation: number, through: number): Promise<void>;
  release(scope: string, owner: string): Promise<void>;
}
export default TurboModuleRegistry.get<Spec>('GalinumJournal');
