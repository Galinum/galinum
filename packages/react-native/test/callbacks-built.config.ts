import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: [
    { find: '../src/client.js', replacement: fileURLToPath(new URL('../dist/client.js', import.meta.url)) },
    { find: '../src/types.js', replacement: fileURLToPath(new URL('../dist/types.js', import.meta.url)) },
  ] },
  test: { include: ['test/callbacks.test.ts', 'test/carriers.test.ts', 'test/inapp-client.test.ts'] },
});
