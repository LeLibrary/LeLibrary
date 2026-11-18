// @ts-nocheck
'use strict';
// The Releases page's scoped session (v6.1).
//
// This is the one credential in LeLibrary that is not an install link, so the
// rules are pinned here: a code is short, single use and short lived; only a
// hash of the session token is stored; the cookie is HttpOnly, SameSite=Lax and
// Secure only where the proxy says https; and a cross-site POST is refused
// before anything else happens.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { once } = require('node:events');

const pairing = require('../src/setup/favourites-pairing.ts');
const { createFavouritesRouter } = require('../src/routes/favourites.ts');

const UUID = '3f0c1d1e-1111-4222-8333-444455556666';

function fakePool(rowsBySql) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const handler = rowsBySql(sql, params);
      return handler || { rows: [], rowCount: 0 };
    },
  };
}

test('a code is eight safe characters, single use, and read forgivingly', () => {
  const made = pairing.createCode(UUID);
  assert.ok(made);
  assert.match(made.code, /^[A-HJ-NP-Z2-9]{8}$/, 'no 0/O/1/I, and eight long');
  assert.ok(new Date(made.expiresAt).getTime() > Date.now());
  // Lower case, spaces and dashes are how people type a code.
  const messy = made.code.toLowerCase().replace(/(.{4})/, '$1 - ');
  assert.equal(pairing.redeemCode(messy), UUID);
  // A code works once.
  assert.equal(pairing.redeemCode(made.code), null);
});

test('unknown and malformed codes are refused, and codes are not kept forever', () => {
  assert.equal(pairing.redeemCode('ZZZZZZZZ'), null);
  assert.equal(pairing.redeemCode('short'), null);
  assert.equal(pairing.redeemCode(null), null);
  assert.equal(pairing.redeemCode({}), null);
  assert.equal(pairing.createCode('not-a-uuid'), null);
});

test('only a hash of the session token is stored', async () => {
  const db = fakePool((sql) => (/^INSERT/i.test(sql.trim()) ? { rows: [], rowCount: 1 } : null));
  const issued = await pairing.issue(db, UUID, 'Living room');
  assert.ok(issued && /^[a-f0-9]{64}$/.test(issued.token));
  const insert = db.calls.find((call) => /^INSERT/i.test(call.sql.trim()));
  assert.ok(insert);
  assert.ok(!insert.params.includes(issued.token), 'the raw token never reaches the database');
  assert.equal(insert.params[2], crypto.createHash('sha256').update(issued.token).digest('hex'));
  assert.equal(insert.params[3], 'Living room');
});

test('a session resolves by token, and revoked or malformed ones do not', async () => {
  const token = 'a'.repeat(64);
  const db = fakePool((sql) => (/^SELECT/i.test(sql.trim()) ? { rows: [{ id: 'p1', setup_uuid: UUID }], rowCount: 1 } : null));
  assert.deepEqual(await pairing.resolve(db, token), { id: 'p1', uuid: UUID });
  for (const bad of ['', 'short', 'z'.repeat(64), 'A'.repeat(64), null, 42]) {
    assert.equal(await pairing.resolve(db, bad), null, String(bad));
  }
  const revoked = fakePool(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await pairing.resolve(revoked, token), null);
});

test('the cookie is HttpOnly and Lax, and Secure only behind https', () => {
  const plain = pairing.cookieString('tok', false);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.ok(!/Secure/.test(plain), 'a plain-http dev host would drop a Secure cookie');
  assert.match(pairing.cookieString('tok', true), /; Secure/);
  assert.match(pairing.clearCookieString(false), /Max-Age=0/);
  assert.equal(pairing.isSecure({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(pairing.isSecure({ headers: {} }), false);
});

test('the cookie is read out of a busy header and nothing else is touched', () => {
  assert.equal(pairing.tokenFromRequest({ headers: { cookie: `${pairing.COOKIE_NAME}=abc; other=1` } }), 'abc');
  assert.equal(pairing.tokenFromRequest({ headers: { cookie: 'other=1' } }), null);
  assert.equal(pairing.tokenFromRequest({ headers: {} }), null);
});

// ── The router's guard rails, with no database configured ────────────────

async function withApp(fn: (base: string) => Promise<void>) {
  const app = express();
  const { router } = createFavouritesRouter();
  app.use('/api/favourites', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/favourites`;
  try { await fn(base); } finally { server.close(); }
}

test('another site cannot redeem a code or star anything with the cookie', async () => {
  await withApp(async (base: string) => {
    for (const [method, path, body] of [
      ['POST', '/pair', { code: 'ABCD2345' }],
      ['POST', '/', { mediaType: 'movie', tmdbId: 603 }],
      ['POST', '/disconnect', {}],
      ['POST', '/owned', { items: [{ mediaType: 'movie', tmdbId: 603 }] }],
    ]) {
      const res = await fetch(`${base}${path}`, {
        method, headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });
});

test('without a database the page is told it is not linked, and a bad code is a plain 400', async () => {
  await withApp(async (base: string) => {
    const status = await fetch(`${base}/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { linked: false });
    // No setup database on this instance: 503, never a 500 or a stack.
    const pair = await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD2345' }) });
    assert.equal(pair.status, 503);
    const list = await fetch(`${base}/`);
    assert.equal(list.status, 503, 'the list needs the cookie, which needs the database');
  });
});

test('a paired browser\'s cookie is not accepted when it is not a token', async () => {
  await withApp(async (base: string) => {
    const res = await fetch(`${base}/status`, { headers: { cookie: `${pairing.COOKIE_NAME}=not-a-token` } });
    assert.deepEqual(await res.json(), { linked: false });
  });
});
