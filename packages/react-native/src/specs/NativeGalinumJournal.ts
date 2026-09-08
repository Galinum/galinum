import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  claim(scope: string): string;
  reserve(scope: string, owner: string, intent: number, eventId: string): string;
  resolveInitialIntent(scope: string, owner: string, destination: number): boolean;
  setIntent(scope: string, owner: string, intent: number): number;
  rejectTicket(scope: string, owner: string, ticket: string): boolean;
  restrictDisplay(scope: string, owner: string): number;
  proposeDisplay(scope: string, owner: string, proposal: string): string;
  open(scope: string, owner: string): Promise<void>;
  readControl(scope: string, owner: string): Promise<string>;
  commitControl(scope: string, owner: string, operationId: string, expectedRevision: number, state: string, restrict: boolean): Promise<string>;
  operation(scope: string, owner: string, operationId: string): Promise<string>;
  publishDisplay(scope: string, owner: string, proposal: string): Promise<string>;
  closeGate(scope: string, owner: string, intent: number): Promise<void>;
  publishBinding(scope: string, owner: string, intent: number, binding: string): Promise<void>;
  admitEvent(scope: string, owner: string, ticket: string, event: string): Promise<string>;
  peek(scope: string, owner: string, intent: number): Promise<string>;
  acknowledge(scope: string, owner: string, intent: number, generation: number, through: number): Promise<void>;
  release(scope: string, owner: string): Promise<void>;
}
export default TurboModuleRegistry.get<Spec>('GalinumJournal');
