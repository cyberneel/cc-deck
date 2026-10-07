import { test } from 'node:test';
import assert from 'node:assert/strict';

// Old cc-deck env names keep working, and the new name wins when both are set.
delete process.env.POLYMUX_PASSWORD; // a Polymux session's shell has the real one set
Object.assign(process.env, {
  CCDECK_PASSWORD: 'old', CCDECK_TENANT_ID: 't1', POLYMUX_TENANT_ID: '',
  CCDECK_SECRET: 'old-secret', POLYMUX_SECRET: 'new-secret',
});
const { config } = await import('../src/config.js');

test('config: CCDECK_* fills unset or empty POLYMUX_*, POLYMUX_* wins', () => {
  assert.equal(config.password, 'old');
  assert.equal(config.tenantId, 't1'); // tenant guard stays on for old hosted envs
  assert.equal(config.secret, 'new-secret');
});
