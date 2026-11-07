// @ts-nocheck
'use strict';
// Simkl AUTH V2 (v6): PKCE sign-in, the single-flight refresh, and the V1
// legacy path. Fakes only: no request reaches Simkl, every token and id is
// synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const oauth = require('../src/setup/oauth.ts');
const conns = require('../src/setup/connections.ts');

const V2_ID = 'synthetic-simkl-v2-client';
const V2_SECRET = 'synthetic-simkl-v2-secret';
const V1_ID = 'synthetic-simkl-v1-client';
const UUID = '00000000-0000-4000-8000-0000000000aa';

function withEnv(values, fn) {
  const before = {};
  for (const [name, value] of Object.entries(values)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const restore = () => { for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) { restore(); throw err; }
}

// A setup store holding one row, as the config store would.
function fakeStore(watchlist) {
  const row = { uuid: UUID, config: {}, keys: { watchlist: { ...watchlist } } };
  const saves = [];
  return {
    row, saves,
    async resolveByUuid(uuid) { return uuid === UUID ? structuredClone(row) : null; },
    async resolveByToken() { return structuredClone(row); },
    async save(uuid, input) { saves.push(structuredClone(input)); if (input.keys) row.keys = structuredClone(input.keys); return { ok: true }; },
  };
}

test('PKCE: the verifier stays server-side with the state; the URL carries only its S256 challenge', () => withEnv({ SIMKL_CLIENT_ID: V2_ID }, () => {
  const { state } = oauth.createPendingOAuth(null, 'simkl');
  const url = new URL(oauth.authorizeUrl('simkl', state, 'https://lelibrary.test'));
  assert.equal(url.origin + url.pathname, 'https://simkl.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), V2_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'media:read media:write');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://lelibrary.test/api/setup/oauth/simkl/callback');
  const consumed = oauth.consumePendingOAuth(state);
  assert.match(consumed.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto.createHash('sha256').update(consumed.codeVerifier).digest('base64url');
  assert.equal(url.searchParams.get('code_challenge'), expected);
  assert.ok(!url.toString().includes(consumed.codeVerifier), 'the verifier never travels in the URL');
  // Other providers get no verifier.
  const trakt = oauth.createPendingOAuth(null, 'trakt');
  assert.equal('codeVerifier' in oauth.consumePendingOAuth(trakt.state), false);
}));

test('code exchange: V2 token endpoint with the verifier; a 7-day token, a refresh token and the granted scope', () => withEnv({ SIMKL_CLIENT_ID: V2_ID, SIMKL_CLIENT_SECRET: V2_SECRET }, async () => {
  const axios = require('axios');
  const original = axios.post;
  const calls = [];
  axios.post = async (url, body, options) => {
    calls.push({ url, body: new URLSearchParams(body), options });
    return { data: { access_token: 'simkl_at_synthetic', token_type: 'Bearer', expires_in: 604800, refresh_token: 'simkl_rt_synthetic', scope: 'media:read media:write' } };
  };
  try {
    const before = Date.now();
    const conn = await oauth.exchangeCode('simkl', 'code-1', 'https://lelibrary.test', 'verifier-xyz');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.simkl.com/oauth2/token');
    assert.equal(calls[0].body.get('grant_type'), 'authorization_code');
    assert.equal(calls[0].body.get('code_verifier'), 'verifier-xyz');
    assert.equal(calls[0].body.get('client_id'), V2_ID);
    assert.equal(calls[0].body.get('redirect_uri'), 'https://lelibrary.test/api/setup/oauth/simkl/callback');
    assert.equal(conn.auth, 'v2');
    assert.equal(conn.refresh_token, 'simkl_rt_synthetic');
    assert.equal(conn.scope, 'media:read media:write');
    assert.ok(conn.expires_at >= before + 604800 * 1000 - 5000);
    // Without the verifier nothing is sent (the code would be burnt).
    await assert.rejects(() => oauth.exchangeCode('simkl', 'code-2', 'https://lelibrary.test'));
    assert.equal(calls.length, 1);
  } finally { axios.post = original; }
}));

test('callback issuer check: only Simkl\'s own issuer (or none) is accepted', () => {
  assert.equal(oauth.issuerAccepted('simkl', 'https://simkl.com'), true);
  assert.equal(oauth.issuerAccepted('simkl', undefined), true);
  assert.equal(oauth.issuerAccepted('simkl', 'https://evil.example'), false);
  assert.equal(oauth.issuerAccepted('simkl', 'https://simkl.com.evil'), false);
  assert.equal(oauth.issuerAccepted('anilist', 'https://anything'), true);
});

test('refresh: single-flight per setup, the new token is saved into the sealed connection', () => withEnv({ SIMKL_CLIENT_ID: V2_ID, SIMKL_CLIENT_SECRET: V2_SECRET }, async () => {
  const now = 1_800_000_000_000;
  const conn = { access_token: 'simkl_at_old', refresh_token: 'simkl_rt_1', expires_at: now + 60 * 60 * 1000, auth: 'v2', scope: 'media:read media:write' };
  const store = fakeStore({ simkl: conn });
  let posts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const post = async (url, body) => {
    posts += 1;
    assert.equal(url, 'https://api.simkl.com/oauth2/token');
    const form = new URLSearchParams(body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'simkl_rt_1');
    await gate;
    return { data: { access_token: 'simkl_at_new', expires_in: 604800, refresh_token: 'simkl_rt_1', scope: 'media:read media:write' } };
  };
  const config = { watchlist: { simkl: conn } };
  Object.defineProperty(config, '__configScope', { value: { type: 'config', uuid: UUID } });
  const a = conns.simklAuthForConfig(config, { store, post, now: () => now });
  const b = conns.simklAuthForConfig(config, { store, post, now: () => now });
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(posts, 1, 'two catalogue opens share one refresh');
  assert.equal(ra.token, 'simkl_at_new');
  assert.equal(rb.token, 'simkl_at_new');
  assert.equal(ra.clientId, V2_ID);
  assert.equal(ra.write, true);
  assert.equal(store.row.keys.watchlist.simkl.access_token, 'simkl_at_new');
  assert.equal(store.row.keys.watchlist.simkl.refresh_token, 'simkl_rt_1');
  assert.ok(store.row.keys.watchlist.simkl.expires_at > now + 6 * 24 * 3600 * 1000);
}));

test('refresh: a token another process already rotated is used as it is, never refreshed again', () => withEnv({ SIMKL_CLIENT_ID: V2_ID }, async () => {
  const now = 1_800_000_000_000;
  const stale = { access_token: 'simkl_at_stale', refresh_token: 'simkl_rt_1', expires_at: now + 1000, auth: 'v2' };
  const store = fakeStore({ simkl: { ...stale, access_token: 'simkl_at_rotated', expires_at: now + 7 * 24 * 3600 * 1000 } });
  let posts = 0;
  const next = await conns.refreshSimklForSetup(store, UUID, stale, { post: async () => { posts += 1; return { data: {} }; }, now: () => now });
  assert.equal(posts, 0);
  assert.equal(next.access_token, 'simkl_at_rotated');
}));

test('refresh failure: still inside its lifetime keeps the token; expired is no connection', () => withEnv({ SIMKL_CLIENT_ID: V2_ID }, async () => {
  const now = 1_800_000_000_000;
  const failing = async () => { throw Object.assign(new Error('nope'), { response: { status: 400 } }); };
  const soon = { access_token: 'simkl_at_a', refresh_token: 'simkl_rt_a', expires_at: now + 3600 * 1000, auth: 'v2' };
  assert.equal((await conns.refreshSimklForSetup(fakeStore({ simkl: soon }), UUID, soon, { post: failing, now: () => now })).access_token, 'simkl_at_a');
  const gone = { ...soon, expires_at: now - 1000 };
  assert.equal(await conns.refreshSimklForSetup(fakeStore({ simkl: gone }), UUID, gone, { post: failing, now: () => now }), null);
}));

test('V1 legacy: old connections read with SIMKL_V1_CLIENT_ID, and need a reconnect without it', () => {
  const legacy = { access_token: 'a'.repeat(64) };
  withEnv({ SIMKL_CLIENT_ID: V2_ID, SIMKL_V1_CLIENT_ID: V1_ID }, () => {
    const client = conns.simklClient(legacy);
    assert.deepEqual(client, { kind: 'legacy', clientId: V1_ID, usable: true, write: false });
    assert.equal(conns.simklClient({ access_token: 'simkl_at_x' }).kind, 'v2', 'the simkl_at_ prefix marks a V2 token');
  });
  return withEnv({ SIMKL_CLIENT_ID: V2_ID, SIMKL_V1_CLIENT_ID: undefined }, async () => {
    assert.equal(conns.simklClient(legacy).usable, false);
    assert.equal(await conns.simklAuthForConfig({ watchlist: { simkl: legacy } }, { store: null }), null);
  });
});

test('V1 legacy: API calls carry the V1 client id', () => withEnv({ SIMKL_CLIENT_ID: V2_ID, SIMKL_V1_CLIENT_ID: V1_ID }, async () => {
  const auth = await conns.simklAuthForConfig({ watchlist: { simkl: { access_token: 'b'.repeat(64) } } }, { store: null });
  assert.equal(auth.clientId, V1_ID);
  assert.equal(auth.kind, 'legacy');
  assert.equal(auth.write, false, 'history is only written through V2 grants');
}));

test('watchlist status flags a V1 Simkl connection as legacy (and reconnect without the V1 id)', () => withEnv({ SIMKL_CLIENT_ID: V2_ID, SIMKL_CLIENT_SECRET: V2_SECRET, SIMKL_V1_CLIENT_ID: undefined }, async () => {
  const express = require('express');
  const { once } = require('node:events');
  const { mountSetupConnectionRoutes } = require('../src/routes/setup-connections.ts');
  const { createEditSessionStore } = require('../src/setup/edit-sessions.ts');
  const store = fakeStore({ simkl: { access_token: 'c'.repeat(64), username: 'Old' } });
  const sessions = createEditSessionStore();
  const app = express();
  mountSetupConnectionRoutes(app, { editSessions: sessions, getStore: async () => store, accountName: async () => null });
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const token = sessions.issue(UUID).token;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/setup/${UUID}/watchlist`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    assert.equal(body.simkl.connected, true);
    assert.equal(body.simkl.legacy, true);
    assert.equal(body.simkl.reconnect, true);
    store.row.keys.watchlist.simkl = { access_token: 'simkl_at_new', refresh_token: 'simkl_rt', expires_at: Date.now() + 86400000 * 7, auth: 'v2' };
    const after = await (await fetch(`http://127.0.0.1:${server.address().port}/api/setup/${UUID}/watchlist`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(after.simkl.legacy, undefined);
    // A denied consent and a foreign issuer never reach the token exchange.
    const { state } = oauth.createPendingOAuth(null, 'simkl');
    const denied = await fetch(`http://127.0.0.1:${server.address().port}/api/setup/oauth/simkl/callback?state=${state}&error=access_denied&iss=https%3A%2F%2Fsimkl.com`);
    assert.equal(denied.status, 400);
    const other = oauth.createPendingOAuth(null, 'simkl');
    const mixed = await fetch(`http://127.0.0.1:${server.address().port}/api/setup/oauth/simkl/callback?state=${other.state}&code=x&iss=https%3A%2F%2Fevil.example`);
    assert.equal(mixed.status, 400);
  } finally { server.close(); }
}));
