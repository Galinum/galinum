import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveSecurity } from './generate-server-operations.mjs';
const contract = { components: { securitySchemes: { publishableKey: {}, secretKey: {}, hostedAgentKey: {}, installationCapability: {} } }, security: [{ publishableKey: [] }] };
test('global inheritance and explicit anonymous security remain distinct', () => {
  assert.deepEqual(effectiveSecurity(contract, {}), [{ publishableKey: [] }]);
  assert.deepEqual(effectiveSecurity(contract, { security: [] }), []);
  assert.deepEqual(effectiveSecurity(contract, { security: [{}] }), [{}]);
});
test('OR alternatives preserve each AND requirement and scopes', () => {
  const security = [{ publishableKey: [], installationCapability: [] }, { hostedAgentKey: ['read'] }, { secretKey: [] }];
  assert.deepEqual(effectiveSecurity(contract, { security }), security);
});
test('unknown or malformed requirements fail generation', () => {
  for (const security of [null, {}, [null], [{ missing: [] }], [{ secretKey: 'read' }], [{ hostedAgentKey: [3] }]]) assert.throws(() => effectiveSecurity(contract, { security }));
});
