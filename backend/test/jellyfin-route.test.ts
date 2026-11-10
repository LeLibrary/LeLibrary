// @ts-nocheck
'use strict';
// GET /{uuid}.{secret}/jellyfin/config.json - the read-only plan the Jellyfin
// plugin installs from. No database, no provider and no network here: the
// route's data access is injected so the shape, the ETag and the redaction are
// pinned by tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mountJellyfinRoutes } = require('../src/routes/jellyfin.ts');

function appWith(config: any, rows: any, extra: any = {}) {
  const app = express();
  mountJellyfinRoutes(app, {
    resolveConfig: async () => config,
    catalogRows: async (_scope: string, type: string) => rows[type] || [],
    scopeSynced: async () => new Date(),
    ...extra,
  } as any);
  return app;
}

// One server for the whole test: the plan's art URLs embed the origin, so two
// servers mean two different bodies and the ETag/304 assertions would compare
// ports instead of content.
function server(app: any) {
  return new Promise<any>((resolve) => {
    const instance = app.listen(0, () => {
      const port = (instance.address() as any).port;
      resolve({
        get(path: string, headers: Record<string, string> = {}) {
          return fetch(`http://127.0.0.1:${port}${path}`, { headers }).then(async (res) => ({
            status: res.status,
            headers: Object.fromEntries(res.headers as any),
            body: await res.text(),
          }));
        },
        close: () => instance.close(),
      });
    });
  });
}

const movieRow = {
  provider: 'torbox', source_id: '11', source_kind: 'torrent', name: 'The Matrix 1999',
  media_type: 'movie',
  raw: { source: 'torrent', id: 11, name: 'The Matrix 1999', files: [{ id: 2, name: 'The.Matrix.2160p.mkv', size: 18e9 }] },
  match_status: 'matched', tmdb_id: 603, imdb_id: 'tt0133093',
  match_meta: { id: 'tt0133093', name: 'The Matrix', year: 1999, catalogType: 'movie', tmdbId: 603, poster: '/erdb/poster/tmdb:movie:603' },
};

test('a torbox setup returns a plan with an ETag and no keys', async () => {
  const s = await server(appWith({ provider: 'torbox', torboxApiKey: 'SUPERSECRET' }, { movie: [movieRow], series: [], anime: [] }));
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(res.status, 200);
    assert.match(res.headers.etag, /^"[a-f0-9]{24}"$/);
    assert.equal(res.body.includes('SUPERSECRET'), false);
    const plan = JSON.parse(res.body);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.provider, 'torbox');
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].key, 'torbox:11:2');
    assert.match(plan.items[0].poster, /^http:\/\/127\.0\.0\.1:\d+\/abc\.def\/erdb\/poster\/tmdb:movie:603$/);
  } finally { s.close(); }
});

test('a repeated request with If-None-Match is a 304', async () => {
  const s = await server(appWith({ provider: 'torbox', torboxApiKey: 'k' }, { movie: [movieRow], series: [], anime: [] }));
  try {
    const first = await s.get('/abc.def/jellyfin/config.json');
    const second = await s.get('/abc.def/jellyfin/config.json', { 'if-none-match': first.headers.etag });
    assert.equal(second.status, 304);
    assert.equal(second.body, '');
  } finally { s.close(); }
});

test('the ETag does not change just because time passed', async () => {
  let now = 1_700_000_000_000;
  const s = await server(appWith({ provider: 'torbox', torboxApiKey: 'k' }, { movie: [movieRow], series: [], anime: [] }, { now: () => now }));
  try {
    const first = await s.get('/abc.def/jellyfin/config.json');
    now += 3_600_000;
    const second = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(first.headers.etag, second.headers.etag);
    assert.notEqual(JSON.parse(first.body).generatedAt, JSON.parse(second.body).generatedAt);
  } finally { s.close(); }
});

test('the setup content filters reach the row filter and remove items', async () => {
  const adult = {
    ...movieRow,
    source_id: '12',
    raw: { ...movieRow.raw, id: 12 },
    tmdb_id: 900,
    match_meta: { ...movieRow.match_meta, id: 'tt900900', name: 'Adult Film', tmdbId: 900 },
  };
  const s = await server(appWith(
    { provider: 'torbox', torboxApiKey: 'filter-key', hideAdultContent: true },
    { movie: [movieRow, adult], series: [], anime: [] },
    { filterRows: async (rows: any[]) => rows.filter((row: any) => Number(row.tmdb_id) !== 900) },
  ));
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    const plan = JSON.parse(res.body);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].key, 'torbox:11:2');
  } finally { s.close(); }
});

test('the shared row filter hides anime by its matched flag without a database', async () => {
  const { filterRows } = require('../src/library/catalog.ts');
  const rows = [
    { tmdb_id: 1, match_meta: { isJapaneseAnimation: true } },
    { tmdb_id: 2, match_meta: { isJapaneseAnimation: false } },
  ];
  const kept = await filterRows(rows, { hideAnime: true, hideAdult: false, excludeCategories: [] }, 'series');
  assert.deepEqual(kept.map((row: any) => row.tmdb_id), [2]);
});

test('an unknown token is a 400', async () => {
  const app = express();
  mountJellyfinRoutes(app, { resolveConfig: async () => null, catalogRows: async () => [] } as any);
  const s = await server(app);
  try {
    const res = await s.get('/nope/jellyfin/config.json');
    assert.equal(res.status, 400);
  } finally { s.close(); }
});

test('a setup with no provider is a 409', async () => {
  const s = await server(appWith({ provider: 'torbox' }, { movie: [], series: [], anime: [] }));
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(res.status, 409);
  } finally { s.close(); }
});

test('an unavailable library is a 503, not an empty plan', async () => {
  const s = await server(appWith({ provider: 'torbox', torboxApiKey: 'k' }, { movie: [], series: [], anime: [] }, {
    catalogRows: async () => { throw new Error('no db'); },
  }));
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(res.status, 503);
  } finally { s.close(); }
});

test('a missing library pool is a 503 when the route reads the real store', async () => {
  const app = express();
  mountJellyfinRoutes(app, {
    resolveConfig: async () => ({ provider: 'torbox', torboxApiKey: 'k' }),
    libraryDb: () => false,
  } as any);
  const s = await server(app);
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(res.status, 503);
  } finally { s.close(); }
});

test('the website 404 allowlist lets /jellyfin through to the addon route', () => {
  // The website router is mounted before the addon routes and ends in a 404
  // page; it only lets known addon paths fall through. A new addon surface must
  // be listed there or it 404s in the real app while its own tests pass.
  const fs = require('node:fs');
  const path = require('node:path');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'website.ts'), 'utf8');
  assert.match(routes, /jellyfin/);
});

test('the plan only reads rows for the setup first provider', async () => {
  const seen: string[] = [];
  const app = express();
  mountJellyfinRoutes(app, {
    resolveConfig: async () => ({ provider: 'torbox,realdebrid', torboxApiKey: 'k', rdApiKey: 'r' }),
    catalogRows: async (_scope: string, type: string, provider: string) => { seen.push(`${type}:${provider}`); return []; },
    scopeSynced: async () => new Date(),
  } as any);
  const s = await server(app);
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(res.status, 200);
    assert.deepEqual([...new Set(seen.map((x) => x.split(':')[1]))], ['torbox']);
  } finally { s.close(); }
});

test('a scope that never completed a sync is a 503, not an empty plan', async () => {
  const app = express();
  mountJellyfinRoutes(app, {
    resolveConfig: async () => ({ provider: 'torbox', torboxApiKey: 'k' }),
    catalogRows: async () => [],
    scopeSynced: async () => null,
  } as any);
  const s = await server(app);
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(res.status, 503);
  } finally { s.close(); }
});

test('content filters are applied to rows before assembly', async () => {
  let calledWith: any = null;
  const app = express();
  mountJellyfinRoutes(app, {
    resolveConfig: async () => ({ provider: 'torbox', torboxApiKey: 'k', hideAnime: true, excludeCategories: ['horror'] }),
    catalogRows: async () => [movieRow],
    scopeSynced: async () => new Date(),
    filterRows: async (rows: any[], state: any, kind: string) => { calledWith = { count: rows.length, state, kind }; return rows; },
  } as any);
  const s = await server(app);
  try {
    const res = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(res.status, 200);
    assert.equal(calledWith.count, 1);
    assert.equal(calledWith.state.hideAnime, true);
    assert.deepEqual(calledWith.state.excludeCategories, ['horror']);
  } finally { s.close(); }
});

test('a second request for the same library state reuses the built plan', async () => {
  let reads = 0;
  const app = express();
  mountJellyfinRoutes(app, {
    resolveConfig: async () => ({ provider: 'torbox', torboxApiKey: 'cache-key-1' }),
    catalogRows: async () => { reads += 1; return [movieRow]; },
    scopeSynced: async () => new Date(),
    fingerprint: () => 'fp-1',
  } as any);
  const s = await server(app);
  try {
    const first = await s.get('/abc.def/jellyfin/config.json');
    const second = await s.get('/abc.def/jellyfin/config.json');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.etag, second.headers.etag);
    assert.equal(reads, 3); // movie + series + anime, once
  } finally { s.close(); }
});

test('a changed library fingerprint rebuilds the plan', async () => {
  let reads = 0;
  let fp = 'fp-1';
  const app = express();
  mountJellyfinRoutes(app, {
    resolveConfig: async () => ({ provider: 'torbox', torboxApiKey: 'cache-key-2' }),
    catalogRows: async () => { reads += 1; return [movieRow]; },
    scopeSynced: async () => new Date(),
    fingerprint: () => fp,
  } as any);
  const s = await server(app);
  try {
    await s.get('/abc.def/jellyfin/config.json');
    fp = 'fp-2';
    await s.get('/abc.def/jellyfin/config.json');
    assert.equal(reads, 6);
  } finally { s.close(); }
});
