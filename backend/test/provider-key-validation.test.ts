// @ts-nocheck
'use strict';
// A rejected debrid key used to save silently: the library then scanned
// nothing and the addon looked completely broken. Creating or saving a setup
// now checks the provider key (all four providers) and refuses a definite
// rejection, while an unreachable provider never blocks the save.
//
// Synthetic values only. A too-short TorBox key is rejected without a network
// call; the other providers are exercised through injected probes.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { mountSetupRoutes } = require('../src/routes/setup.ts');
const { createEditSessionStore } = require('../src/setup/edit-sessions.ts');
const { checkProviderKey, checkProviderKeys, classify } = require('../src/providers/key-check.ts');

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const CREATED = { uuid: UUID, secret: 's', installToken: `${UUID}.s`, tier: 'quick', createdAt: null };

async function startApp(stored) {
  const sessions = createEditSessionStore();
  const row = { uuid: UUID, tier: 'quick', name: null, hasPassword: true, config: {}, keys: {}, secret: null };
  const store = {
    create: async (input) => { stored.push(input); return CREATED; },
    resolveByUuid: async (id) => (id === UUID ? row : null),
    save: async (id, input) => { stored.push(input); return { uuid: id }; },
    checkPassword: async () => true,
    toEngineConfig: () => ({}),
  };
  const app = express();
  mountSetupRoutes(app, { getStore: async () => store, editSessions: sessions, identities: async () => ({}) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    session: sessions.issue(UUID).token,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function create(base, keys) {
  return fetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: 'quick', password: 'hunter2hunter2', config: {}, keys }),
  });
}

test('creating a setup refuses a rejected provider key and names it', async () => {
  const stored = [];
  const app = await startApp(stored);
  try {
    const res = await create(app.base, { tmdbApiKey: 'synthetic-tmdb', torboxApiKey: 'x' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid-provider-key');
    assert.match(body.error, /TorBox key was rejected/);
    assert.equal(stored.length, 0, 'nothing is created');
  } finally { await app.close(); }
});

test('provider keys are trimmed on the way in, and whitespace is no key', async () => {
  const stored = [];
  const app = await startApp(stored);
  try {
    const res = await create(app.base, { tmdbApiKey: 'synthetic-tmdb', torboxApiKey: '   ' });
    assert.equal(res.status, 201);
    assert.equal(stored[0].keys.torboxApiKey, '', 'the stored value is trimmed');
  } finally { await app.close(); }
});

test('saving a setup refuses a rejected key too, and never writes it', async () => {
  const stored = [];
  const app = await startApp(stored);
  try {
    const res = await fetch(`${app.base}/api/setup/${UUID}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.session}` },
      body: JSON.stringify({ config: {}, keys: { torboxApiKey: 'x' } }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'invalid-provider-key');
    assert.equal(stored.length, 0, 'nothing is saved');
    const ok = await fetch(`${app.base}/api/setup/${UUID}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.session}` },
      body: JSON.stringify({ config: {}, keys: { torboxApiKey: '  ' } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(stored[0].keys.torboxApiKey, '', 'trimmed before storing');
  } finally { await app.close(); }
});

test('only a definite rejection counts; an unreachable provider never blocks', async () => {
  assert.equal(classify(401, ''), 'invalid');
  assert.equal(classify(403, ''), 'invalid');
  assert.equal(classify(200, 'bad_token'), 'invalid');
  assert.equal(classify(200, 'The auth apikey is invalid'), 'invalid');
  assert.equal(classify(0, 'connect ETIMEDOUT'), 'unknown');
  assert.equal(classify(500, 'TorBox request failed'), 'unknown');
  assert.equal(classify(429, 'rate limited'), 'unknown');

  const deps = {
    torbox: async () => 'ok',
    realdebrid: async () => 'unknown',
    alldebrid: async () => 'ok',
    premiumize: async () => 'ok',
  };
  assert.equal((await checkProviderKey('torbox', '  ', deps)).state, 'invalid', 'an empty key is never valid');
  assert.equal((await checkProviderKey('torbox', ' good ', deps)).state, 'ok');
  assert.equal((await checkProviderKey('realdebrid', 'key', { realdebrid: async () => { throw new Error('boom'); } })).state, 'unknown');

  const { isKeyRejection } = require('../src/providers/key-check.ts');
  assert.equal(isKeyRejection('TorBox authentication failed (401)'), true);
  assert.equal(isKeyRejection('[RD] Torrents error: bad_token'), true);
  assert.equal(isKeyRejection('[AllDebrid] The auth apikey is invalid'), true);
  assert.equal(isKeyRejection('Invalid Premiumize API key'), true);
  assert.equal(isKeyRejection('connect ETIMEDOUT 94.140.4.10:443'), false, 'an outage is not a bad key');
  assert.equal(isKeyRejection('TorBox temporarily rate limited'), false);
  assert.equal(isKeyRejection(undefined), false);

  const checked = await checkProviderKeys(
    { torboxApiKey: ' tb ', rdApiKey: '', adApiKey: ' ad ', pmApiKey: '  ' },
    deps
  );
  assert.equal(checked.rejected, null, 'unknown is not a rejection');
  assert.equal(checked.keys.torboxApiKey, 'tb');
  assert.equal(checked.keys.adApiKey, 'ad');
  assert.equal(checked.keys.pmApiKey, '', 'whitespace is trimmed to empty');

  const rejected = await checkProviderKeys({ adApiKey: 'nope' }, { alldebrid: async () => 'invalid' });
  assert.deepEqual(rejected.rejected, { provider: 'alldebrid', label: 'AllDebrid' });
});

export interface ProviderKeyValidationTestModule {}
