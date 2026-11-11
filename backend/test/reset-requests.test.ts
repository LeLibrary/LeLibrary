// @ts-nocheck
'use strict';
// Password reset / delete requests: the pure pieces always run; the full flow
// needs a real Postgres (SETUP_TEST_DATABASE_URL), like the config store tests.
// Keys here are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const resets = require('../src/setup/reset-requests.ts');
const { signBotRequest } = require('../src/routes/reset.ts');

const DATABASE_URL = process.env.SETUP_TEST_DATABASE_URL;
const skip = DATABASE_URL ? false : 'SETUP_TEST_DATABASE_URL not set';
const KEY = crypto.createHash('sha256').update('reset-test-key').digest();
const SECRET = 'x'.repeat(40);
const OPERATOR = '111111111111111111';
const USER = '222222222222222222';
const OTHER = '333333333333333333';
const TORBOX = 'synthetic-torbox-key-0123456789';

test('proveOwnership accepts a stored key and nothing else', () => {
  const opened = { keys: { torboxApiKey: TORBOX, tmdbApiKey: 'short' } };
  assert.equal(resets.proveOwnership(opened, TORBOX), true);
  assert.equal(resets.proveOwnership(opened, `  ${TORBOX} `), true);
  assert.equal(resets.proveOwnership(opened, `${TORBOX}x`), false);
  assert.equal(resets.proveOwnership(opened, 'short'), false);
  assert.equal(resets.proveOwnership(opened, 12345), false);
  assert.equal(resets.proveOwnership(opened, null), false);
  assert.equal(resets.proveOwnership({ keys: {} }, TORBOX), false);
  assert.equal(resets.proveOwnership(null, TORBOX), false);
  // A short stored value never proves anything, even when typed exactly.
  assert.equal(resets.proveOwnership({ keys: { torboxApiKey: 'abc' } }, 'abc'), false);
  assert.equal(resets.proveOwnership(opened, 'x'.repeat(600)), false);
});

test('request ids and codes are strict shapes', () => {
  assert.match(resets.newRequestId(), /^LL-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.match(resets.newCode(), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(resets.normaliseRequestId(' ll-abcde-fghjk '), 'LL-ABCDE-FGHJK');
  assert.equal(resets.normaliseRequestId("LL-ABCDE-FGHJK'; DROP TABLE configs;--"), null);
  assert.equal(resets.normaliseRequestId({}), null);
  assert.equal(resets.normaliseCode('abcd efgh'), 'ABCD-EFGH');
  assert.equal(resets.normaliseCode('abcdefgh'), 'ABCD-EFGH');
  assert.equal(resets.normaliseCode('1 OR 1=1'), null);
  assert.equal(resets.normaliseCode(['ABCD-EFGH']), null);
  assert.equal(resets.isSnowflake('123456789012345678'), true);
  assert.equal(resets.isSnowflake('12ab'), false);
  assert.equal(resets.isSnowflake("1' OR '1'='1"), false);
});

test('the bot signature covers method, path, body and time', () => {
  const base = signBotRequest(SECRET, 'POST', '/api/bot/reset/poll', '{}', 1000);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, signBotRequest(SECRET, 'post', '/api/bot/reset/poll', '{}', 1000));
  for (const changed of [
    signBotRequest(SECRET, 'GET', '/api/bot/reset/poll', '{}', 1000),
    signBotRequest(SECRET, 'POST', '/api/bot/reset/other', '{}', 1000),
    signBotRequest(SECRET, 'POST', '/api/bot/reset/poll', '{"a":1}', 1000),
    signBotRequest(SECRET, 'POST', '/api/bot/reset/poll', '{}', 1001),
    signBotRequest('y'.repeat(40), 'POST', '/api/bot/reset/poll', '{}', 1000),
  ]) assert.notEqual(changed, base);
});

// ---- full flow against Postgres ------------------------------------------

async function harness({ env, delay = () => 0 } = {}) {
  const express = require('express');
  const { Pool } = require('pg');
  const { createConfigStore } = require('../src/setup/config-store.ts');
  const { createEditSessionStore } = require('../src/setup/edit-sessions.ts');
  const { mountResetRoutes } = require('../src/routes/reset.ts');
  // The per-IP limiter is module state: every test starts with empty buckets.
  require('../src/middleware/rate-limit.ts').rateLimitBuckets.clear();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  await pool.query('DROP TABLE IF EXISTS reset_requests, reset_audit, configs');
  const config = createConfigStore({ pool, key: KEY });
  await config.migrate();
  const clock = { t: Date.now() };
  const reset = resets.createResetStore({ pool, key: KEY, now: () => clock.t, releaseDelayMs: delay });
  await reset.migrate();
  const sessions = createEditSessionStore();
  const app = express();
  mountResetRoutes(app, {
    editSessions: sessions,
    getStore: async () => config,
    getResetStore: async () => reset,
    env: env ?? { RESET_BOT_SECRET: SECRET, RESET_OPERATOR_DISCORD_ID: OPERATOR, RESET_REQUIRE_APPROVAL: 'on' },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function pub(path, body, method = 'POST') {
    const r = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async function bot(path, body = {}, over = {}) {
    const raw = JSON.stringify(body);
    const ts = over.ts ?? Date.now();
    const sig = over.sig ?? signBotRequest(over.secret ?? SECRET, 'POST', `/api/bot/reset${path}`, raw, ts);
    const headers = { 'content-type': 'application/json' };
    if (!over.unsigned) { headers['x-ll-ts'] = String(ts); headers['x-ll-sig'] = sig; }
    const r = await fetch(`${base}/api/bot/reset${path}`, { method: 'POST', headers, body: raw });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async function setup(extra = {}) {
    return config.create({ tier: 'partial', name: 'My setup', password: 'old-password-1', keys: { torboxApiKey: TORBOX }, ...extra });
  }
  const close = async () => { server.close(); await pool.end(); };
  return { pub, bot, setup, config, reset, pool, clock, sessions, close };
}

// Drives a request up to a delivered code.
async function toCode(h, created, action = 'reset') {
  const req = await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const id = req.body.requestId;
  assert.equal((await h.bot(`/${id}/link`, { discordUserId: USER, discordName: 'someone' })).status, 200);
  assert.equal((await h.bot(`/${id}/decision`, { decision: 'approve', operatorId: OPERATOR })).status, 200);
  const poll = await h.bot('/poll');
  const delivery = poll.body.deliveries.find((d) => d.id === id);
  assert.ok(delivery, 'code delivered');
  return { id, code: delivery.code, delivery };
}

test('reset: proof, Discord link, approval, code, new password, single use', { skip }, async () => {
  const h = await harness();
  try {
    const created = await h.setup();
    // Wrong key and wrong link get the same generic answer.
    const bad = await h.pub('/api/reset/request', { installToken: created.installToken, key: 'wrong-key-0123456789abcdef', action: 'reset' });
    assert.equal(bad.status, 401);
    const noSetup = await h.pub('/api/reset/request', { installToken: `${crypto.randomUUID()}.${'a'.repeat(32)}`, key: TORBOX, action: 'reset' });
    assert.equal(noSetup.status, 401);
    assert.equal(noSetup.body.error, bad.body.error);
    // The full install URL works as well as the bare link.
    const req = await h.pub('/api/reset/request', { installToken: `https://lelibrary.uk/${created.installToken}/manifest.json`, key: TORBOX, action: 'reset' });
    assert.equal(req.status, 200);
    const id = req.body.requestId;
    assert.equal((await h.pub(`/api/reset/status/${id}`, null, 'GET')).body.status, 'waiting_discord');

    // No approval before the Discord link.
    assert.equal((await h.bot(`/${id}/decision`, { decision: 'approve', operatorId: OPERATOR })).status, 404);
    assert.equal((await h.bot(`/${id}/link`, { discordUserId: USER, discordName: 'Some <@&1> person' })).status, 200);
    // Another account cannot take over a linked request.
    assert.equal((await h.bot(`/${id}/link`, { discordUserId: OTHER, discordName: 'x' })).status, 404);
    assert.equal((await h.pub(`/api/reset/status/${id}`, null, 'GET')).body.status, 'waiting_approval');

    // The operator sees it once, with no secrets in it.
    const first = await h.bot('/poll');
    assert.equal(first.body.approvals.length, 1);
    assert.equal(first.body.approvals[0].id, id);
    assert.equal(first.body.approvals[0].discordUserId, USER);
    assert.doesNotMatch(JSON.stringify(first.body), new RegExp(TORBOX));
    assert.deepEqual(first.body.deliveries, []);
    await h.bot(`/${id}/ack`, { kind: 'approval' });
    assert.equal((await h.bot('/poll')).body.approvals.length, 0);

    // Only the operator can decide.
    assert.equal((await h.bot(`/${id}/decision`, { decision: 'approve', operatorId: OTHER })).status, 404);
    assert.equal((await h.bot(`/${id}/decision`, { decision: 'approve', operatorId: OPERATOR })).status, 200);
    // Decided once.
    assert.equal((await h.bot(`/${id}/decision`, { decision: 'deny', operatorId: OPERATOR })).status, 404);

    const delivery = (await h.bot('/poll')).body.deliveries[0];
    assert.equal(delivery.discordUserId, USER);
    assert.match(delivery.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // The code is handed out once only.
    assert.deepEqual((await h.bot('/poll')).body.deliveries, []);
    const status = (await h.pub(`/api/reset/status/${id}`, null, 'GET')).body;
    assert.equal(status.status, 'code_sent');
    assert.ok(status.codeExpiresAt);

    const session = h.sessions.issue(created.uuid);
    assert.ok(h.sessions.verify(session.token));

    // A wrong code, and a too-short password, do not spend the real code.
    assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code: 'AAAA-BBBB', newPassword: 'new-password-1' })).status, 400);
    assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code: delivery.code, newPassword: 'short' })).status, 400);
    const done = await h.pub('/api/reset/redeem', { requestId: id, code: delivery.code.toLowerCase(), newPassword: 'new-password-1' });
    assert.equal(done.status, 200, JSON.stringify(done.body));

    assert.equal(await h.config.checkPassword(created.uuid, 'old-password-1'), false);
    assert.equal(await h.config.checkPassword(created.uuid, 'new-password-1'), true);
    assert.equal(h.sessions.verify(session.token), null, 'old edit sessions are signed out');
    // The install link is unchanged and keeps serving.
    assert.ok(await h.config.resolveByToken(created.installToken));
    // Single use.
    assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code: delivery.code, newPassword: 'third-password-1' })).status, 400);
    assert.equal(await h.config.checkPassword(created.uuid, 'new-password-1'), true);
    const audit = await h.pool.query('SELECT event FROM reset_audit ORDER BY id');
    assert.deepEqual(audit.rows.map((r) => r.event), ['proof-failed', 'requested', 'linked', 'approved', 'code-issued', 'redeemed']);
  } finally { await h.close(); }
});

test('the code waits for the random delay and expires after 15 minutes', { skip }, async () => {
  const h = await harness({ delay: () => 30_000 });
  try {
    const created = await h.setup();
    const req = await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'reset' });
    const id = req.body.requestId;
    await h.bot(`/${id}/link`, { discordUserId: USER, discordName: 'u' });
    await h.bot(`/${id}/decision`, { decision: 'approve', operatorId: OPERATOR });
    assert.deepEqual((await h.bot('/poll')).body.deliveries, [], 'not yet: 30 s wait');
    assert.equal((await h.pub(`/api/reset/status/${id}`, null, 'GET')).body.status, 'approved');
    h.clock.t += 31_000;
    const delivery = (await h.bot('/poll')).body.deliveries[0];
    assert.ok(delivery);
    // 14 minutes later it still works as a code; at 15 it does not.
    h.clock.t += 15 * 60_000 + 1000;
    assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code: delivery.code, newPassword: 'new-password-1' })).status, 400);
    assert.equal(await h.config.checkPassword(created.uuid, 'old-password-1'), true);
    assert.equal((await h.pub(`/api/reset/status/${id}`, null, 'GET')).body.status, 'closed');
  } finally { await h.close(); }
});

test('five wrong codes burn the request, even for the right code afterwards', { skip }, async () => {
  const h = await harness();
  try {
    const created = await h.setup();
    const { id, code } = await toCode(h, created);
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code: 'AAAA-BBBB', newPassword: 'new-password-1' })).status, 400);
    }
    assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code, newPassword: 'new-password-1' })).status, 400);
    assert.equal(await h.config.checkPassword(created.uuid, 'old-password-1'), true);
  } finally { await h.close(); }
});

test('delete needs an explicit confirmation and removes the setup', { skip }, async () => {
  const h = await harness();
  try {
    const created = await h.setup();
    const { id, code } = await toCode(h, created, 'delete');
    assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code })).status, 400);
    assert.ok(await h.config.resolveByUuid(created.uuid), 'unconfirmed redeem deletes nothing');
    assert.equal((await h.pub('/api/reset/redeem', { requestId: id, code, confirmDelete: true })).status, 200);
    assert.equal(await h.config.resolveByUuid(created.uuid), null);
  } finally { await h.close(); }
});

test('a denied request notifies the user once and never yields a code', { skip }, async () => {
  const h = await harness();
  try {
    const created = await h.setup();
    const req = await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'reset' });
    const id = req.body.requestId;
    await h.bot(`/${id}/link`, { discordUserId: USER, discordName: 'u' });
    await h.bot(`/${id}/decision`, { decision: 'deny', operatorId: OPERATOR });
    const poll = await h.bot('/poll');
    assert.deepEqual(poll.body.denials, [{ id, discordUserId: USER }]);
    assert.deepEqual(poll.body.deliveries, []);
    await h.bot(`/${id}/ack`, { kind: 'denial' });
    assert.deepEqual((await h.bot('/poll')).body.denials, []);
    assert.equal((await h.pub(`/api/reset/status/${id}`, null, 'GET')).body.status, 'denied');
  } finally { await h.close(); }
});

test('the request must be linked in time, and a new request replaces the old one', { skip }, async () => {
  const h = await harness();
  try {
    const created = await h.setup();
    const first = (await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'reset' })).body.requestId;
    const second = (await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'reset' })).body.requestId;
    assert.notEqual(first, second);
    assert.equal((await h.bot(`/${first}/link`, { discordUserId: USER, discordName: 'u' })).status, 404);
    h.clock.t += 31 * 60_000;
    assert.equal((await h.bot(`/${second}/link`, { discordUserId: USER, discordName: 'u' })).status, 404);
  } finally { await h.close(); }
});

test('a setup without a password, or without a key to prove with, is refused', { skip }, async () => {
  const h = await harness();
  try {
    const open = await h.setup({ password: null });
    const r = await h.pub('/api/reset/request', { installToken: open.installToken, key: TORBOX, action: 'reset' });
    assert.equal(r.status, 409);
    const keyless = await h.setup({ keys: {} });
    const k = await h.pub('/api/reset/request', { installToken: keyless.installToken, key: TORBOX, action: 'reset' });
    assert.equal(k.status, 401);
  } finally { await h.close(); }
});

test('repeated wrong keys lock the setup out of the form', { skip }, async () => {
  const h = await harness();
  try {
    const created = await h.setup();
    const codes = [];
    for (let i = 0; i < 6; i += 1) {
      codes.push((await h.pub('/api/reset/request', { installToken: created.installToken, key: `wrong-key-number-${i}-padding`, action: 'reset' })).status);
    }
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(codes[5], 429);
    // Even the right key waits out the lockout.
    assert.equal((await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'reset' })).status, 429);
  } finally { await h.close(); }
});

test('bot calls need a fresh, correct, single-use signature', { skip }, async () => {
  const h = await harness();
  try {
    assert.equal((await h.bot('/poll', {}, { unsigned: true })).status, 401);
    assert.equal((await h.bot('/poll', {}, { secret: 'z'.repeat(40) })).status, 401);
    assert.equal((await h.bot('/poll', {}, { ts: Date.now() - 5 * 60_000 })).status, 401);
    assert.equal((await h.bot('/poll', {}, { sig: 'not-hex' })).status, 401);
    // A valid call replayed byte for byte is refused the second time.
    const raw = '{}';
    const ts = Date.now();
    const sig = signBotRequest(SECRET, 'POST', '/api/bot/reset/poll', raw, ts);
    assert.equal((await h.bot('/poll', {}, { ts, sig })).status, 200);
    assert.equal((await h.bot('/poll', {}, { ts, sig })).status, 401);
    // The public form cannot reach the bot routes' behaviour.
    assert.equal((await h.pub('/api/reset/poll', {})).status, 404);
  } finally { await h.close(); }
});

test('hostile input is rejected and the tables survive', { skip }, async () => {
  const h = await harness();
  try {
    const created = await h.setup();
    const evil = ["' OR '1'='1", "'; DROP TABLE configs; --", '{"$ne":null}', 'LL-AAAAA-BBBBB\' --'];
    for (const value of evil) {
      assert.ok([400, 401, 404].includes((await h.pub('/api/reset/request', { installToken: value, key: value, action: 'reset' })).status));
      assert.ok([400, 404].includes((await h.pub('/api/reset/redeem', { requestId: value, code: value, newPassword: 'new-password-1' })).status));
      assert.ok([404].includes((await h.pub(`/api/reset/status/${encodeURIComponent(value)}`, null, 'GET')).status));
      assert.ok([404].includes((await h.bot(`/${encodeURIComponent(value)}/link`, { discordUserId: value })).status));
    }
    assert.equal((await h.pub('/api/reset/request', { installToken: { a: 1 }, key: ['x'], action: 'reset' })).status, 400);
    assert.equal((await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'drop' })).status, 400);
    assert.ok(await h.config.resolveByUuid(created.uuid), 'configs table untouched');
    const left = await h.pool.query('SELECT count(*)::int AS n FROM reset_requests');
    assert.equal(left.rows[0].n, 0);
  } finally { await h.close(); }
});

test('the feature is off without the bot secret and operator id', { skip }, async () => {
  const h = await harness({ env: {} });
  try {
    assert.equal((await h.pub('/api/reset/config', null, 'GET')).body.enabled, false);
    assert.equal((await h.pub('/api/reset/request', { installToken: 'x', key: 'y', action: 'reset' })).status, 404);
    assert.equal((await h.bot('/poll')).status, 404);
  } finally { await h.close(); }
});

const AUTO_ENV = { RESET_BOT_SECRET: SECRET, RESET_OPERATOR_DISCORD_ID: OPERATOR };

test('automatic mode: linking Discord starts the wait, the operator is only told', { skip }, async () => {
  const h = await harness({ env: AUTO_ENV, delay: () => 20_000 });
  try {
    assert.equal((await h.pub('/api/reset/config', null, 'GET')).body.requiresApproval, false);
    const created = await h.setup();
    const req = await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'reset' });
    const id = req.body.requestId;
    // Still needs the real Discord link first.
    assert.deepEqual((await h.bot('/poll')).body.deliveries, []);
    assert.equal((await h.bot(`/${id}/link`, { discordUserId: USER, discordName: 'someone' })).status, 200);
    assert.equal((await h.pub(`/api/reset/status/${id}`, null, 'GET')).body.status, 'approved');
    // Informational item for the operator, flagged auto, once.
    const first = await h.bot('/poll');
    assert.equal(first.body.approvals.length, 1);
    assert.equal(first.body.approvals[0].auto, true);
    assert.deepEqual(first.body.deliveries, [], 'random wait still applies');
    await h.bot(`/${id}/ack`, { kind: 'approval' });
    assert.equal((await h.bot('/poll')).body.approvals.length, 0);
    // The server never needs an operator decision here, and one cannot be forced.
    assert.equal((await h.bot(`/${id}/decision`, { decision: 'approve', operatorId: OPERATOR })).status, 404);
    h.clock.t += 21_000;
    const delivery = (await h.bot('/poll')).body.deliveries[0];
    assert.equal(delivery.discordUserId, USER);
    const done = await h.pub('/api/reset/redeem', { requestId: id, code: delivery.code, newPassword: 'new-password-1' });
    assert.equal(done.status, 200);
    assert.equal(await h.config.checkPassword(created.uuid, 'new-password-1'), true);
  } finally { await h.close(); }
});

test('automatic mode keeps every other check: proof, user limit, wrong user', { skip }, async () => {
  const h = await harness({ env: AUTO_ENV });
  try {
    const created = await h.setup();
    const bad = await h.pub('/api/reset/request', { installToken: created.installToken, key: 'wrong-key-0123456789abcdef', action: 'reset' });
    assert.equal(bad.status, 401);
    const id = (await h.pub('/api/reset/request', { installToken: created.installToken, key: TORBOX, action: 'reset' })).body.requestId;
    assert.equal((await h.bot(`/${id}/link`, { discordUserId: USER, discordName: 'u' })).status, 200);
    // Another Discord account cannot take over or receive the code.
    assert.equal((await h.bot(`/${id}/link`, { discordUserId: OTHER, discordName: 'x' })).status, 404);
    // Re-running the command as the same person is harmless.
    assert.equal((await h.bot(`/${id}/link`, { discordUserId: USER, discordName: 'u' })).status, 200);
    // Four requests from one Discord account in a day: the fourth is refused.
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      const other = await h.setup();
      const rid = (await h.pub('/api/reset/request', { installToken: other.installToken, key: TORBOX, action: 'reset' })).body.requestId;
      results.push((await h.bot(`/${rid}/link`, { discordUserId: USER, discordName: 'u' })).status);
    }
    assert.deepEqual(results, [200, 200, 429]);
  } finally { await h.close(); }
});
