import { expect, it, vi } from 'vitest';
const mmkv = vi.hoisted(() => ({ files: new Map<string,string>(), reads: [] as string[] }));
vi.mock('react-native-mmkv', () => ({ existsMMKV: (id: string) => { mmkv.reads.push(id);return mmkv.files.has(id); } }));
import { checkLegacyState } from '../src/legacy-store.js';
it('leaves a fresh namespace unprovisioned', async () => {
 await checkLegacyState('fresh');expect(mmkv.files.has('fresh.state')).toBe(false);
});
it('preserves old encrypted bytes and blocks without opening or rewriting', async () => {
 mmkv.files.set('legacy.state','opaque ciphertext');
 await expect(checkLegacyState('legacy')).rejects.toMatchObject({code:'legacy_format'});
 expect(mmkv.files.get('legacy.state')).toBe('opaque ciphertext');
});
it('keeps legacy failure closed on repeated attempts', async () => {
 mmkv.files.set('repeat.state','opaque');
 for (let i=0;i<2;i++) await expect(checkLegacyState('repeat')).rejects.toMatchObject({code:'legacy_format'});
 expect(mmkv.files.get('repeat.state')).toBe('opaque');
});
it('uses the exact supported namespace lookup', async () => {
 await checkLegacyState('scope');expect(mmkv.reads.at(-1)).toBe('scope.state');
});
