// @ts-nocheck
'use strict';
// Every editor route requires a bearer issued by unlock, not a raw password
// or a read capability. All data in these tests is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { mountSetupRoutes } = require('../src/routes/setup.ts');
const { createEditSessionStore } = require('../src/setup/edit-sessions.ts');
const { getSetupLimiter } = require('../src/setup/runtime.ts');

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = '123e4567-e89b-42d3-a456-426614174001';
const INSTALL = `${UUID}.synthetic-install-secret`;

async function startApp(hasPassword = true) {
  let checks = 0;
  const row = { uuid: UUID, tier: 'quick', name: null, hasPassword, config: {}, keys: { tmdbApiKey: 'synthetic-key' }, secret: null };
  const sessions = createEditSessionStore();
  const store = {
    resolveByUuid: async (id) => id === UUID ? row : null,
    resolveByToken: async (token) => token === INSTALL ? row : null,
    checkPassword: async (_id, password) => { checks++; return password === 'synthetic-password'; },
    toEngineConfig: () => ({}),
    save: async () => ({ uuid: UUID }),
    remove: async () => true,
    rotateSecret: async () => ({ installToken: 'synthetic-rotated' }),
    setPassword: async () => true,
  };
  const app = express();
  mountSetupRoutes(app, { getStore: async () => store, editSessions: sessions, identities: async () => ({}) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}/api/setup/${UUID}`, sessions, checks: () => checks, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function request(base, method, suffix, body, bearer) {
  return fetch(base + suffix, {
    method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  });
}

test('passwords cannot bypass unlock on edit, delete, rotate, password or key reveal', async () => {
  const app = await startApp();
  try {
    const operations = [
      ['PUT', '', {}], ['DELETE', '', {}], ['POST', '/secret', {}],
      ['POST', '/password', {}], ['POST', '/keys/reveal', { service: 'tmdbApiKey' }],
    ];
    for (const [method, path, extra] of operations) {
      for (let i = 0; i < 7; i++) {
        const response = await request(app.base, method, path, { password: 'synthetic-password', ...extra });
        assert.equal(response.status, 401, `${method} ${path || '/'} requires the session`);
      }
    }
    assert.equal(app.checks(), 0, 'no alternate endpoint attempts password verification');
    const wrong = app.sessions.issue(OTHER).token;
    assert.equal((await request(app.base, 'POST', '/keys/reveal', { service: 'tmdbApiKey' }, wrong)).status, 401);
    const owner = app.sessions.issue(UUID).token;
    const reveal = await request(app.base, 'POST', '/keys/reveal', { service: 'tmdbApiKey' }, owner);
    assert.equal(reveal.status, 200);
    assert.equal((await reveal.json()).key, 'synthetic-key');
  } finally { await app.close(); }
});

test('a valid edit session still saves during a password lockout', async () => {
  const app = await startApp();
  try {
    const owner = app.sessions.issue(UUID).token;
    const limiter = getSetupLimiter();
    for (let i = 0; i < 5; i++) limiter.fail('synthetic-ip', UUID);
    const saved = await request(app.base, 'PUT', '', { name: 'synthetic' }, owner);
    assert.equal(saved.status, 200);
    limiter.succeed('synthetic-ip', UUID);
  } finally { await app.close(); }
});

test('passwordless setups unlock with their own install link before editing', async () => {
  const app = await startApp(false);
  try {
    assert.equal((await request(app.base, 'DELETE', '', { installToken: INSTALL })).status, 401);
    const unlocked = await request(app.base, 'POST', '/unlock', { installToken: INSTALL });
    assert.equal(unlocked.status, 200);
    const token = (await unlocked.json()).editToken;
    assert.equal((await request(app.base, 'POST', '/keys/reveal', { service: 'tmdbApiKey' }, token)).status, 403, 'passwordless setups cannot reveal keys');
    assert.equal((await request(app.base, 'DELETE', '', {}, token)).status, 200);
  } finally { await app.close(); }
});

export interface SetupEditorSessionSecurityTestModule {};
