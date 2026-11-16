// @ts-nocheck
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getPremiumizeDownloads } = require('../src/providers/premiumize.ts');

test('a failed flat listing cannot replace the library with fallback identities', async () => {
  const calls = [];
  const request = async (_key, _method, path) => {
    calls.push(path);
    return { error: 'unavailable', status: 503 };
  };
  await assert.rejects(getPremiumizeDownloads('synthetic-walk', request), /Premiumize library scan failed/);
  assert.deepEqual(calls, ['/item/listall']);
});

test('an incomplete nested cloud walk fails instead of returning partial data', async () => {
  const request = async (_key, _method, path, params) => {
    if (path === '/item/listall') return { data: { files: [] } };
    if (!params.id) return { data: { content: [{ type: 'file', id: '1', name: 'Film.mkv' }, { type: 'folder', id: 'nested' }] } };
    return { error: 'timeout' };
  };
  await assert.rejects(getPremiumizeDownloads('synthetic-partial', request), /Premiumize library scan failed/);
});

test('authentication rejection stops fallback requests', async () => {
  let calls = 0;
  await assert.rejects(getPremiumizeDownloads('synthetic-auth', async () => { calls++; return { error: 'unauthorized', status: 401 }; }), /Premiumize authentication failed/);
  assert.equal(calls, 1);
});

test('a successful empty cloud is preserved as an empty result', async () => {
  const request = async (_key, _method, path) => path === '/item/listall' ? { data: { files: [] } } : { data: { content: [] } };
  assert.deepEqual(await getPremiumizeDownloads('synthetic-empty', request), []);
});
