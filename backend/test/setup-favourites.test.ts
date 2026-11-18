// @ts-nocheck
'use strict';
// Favourites (v6.1): the person's own shortlist.
//
//   - setup/favourites-store.ts: what a row may be, the 300 cap, and the
//     movie/series split the two personal rows need.
//   - collection-plan.ts: the Hub gains a Favourites folder that points at the
//     personal rows (never at a provider-prefixed id), with its own art.
//   - routes/manifest.ts: those two catalogues are declared whenever a folder
//     or Home row uses them, so a pushed folder never points at a catalogue the
//     manifest forgot.
//
// No database and no network: the pool is a fake that answers the statements
// the store issues.
const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/setup/favourites-store.ts');
const { withHubExtras, compileCollectionPlan } = require('../src/catalog/collection-plan.ts');
const { getConfiguredManifest } = require('../app.ts');

const UUID = '3f0c1d1e-1111-4222-8333-444455556666';
const CONFIG = { provider: 'torbox', torboxApiKey: 'tb-test', tmdbApiKey: 'tmdb-test', __configScope: { type: 'config', uuid: UUID, tier: 'full' } };

function pool(handler) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return handler(sql, params);
    },
  };
}

// ── The store ────────────────────────────────────────────────────────────

test('a favourite is a kind and a positive TMDB id, nothing else', async () => {
  const db = pool(() => ({ rows: [], rowCount: 0 }));
  for (const [type, id] of [['movie', 0], ['movie', -1], ['movie', 1.5], ['film', 603], ['series', 'x'], [null, 603]]) {
    assert.equal(await store.add(db, UUID, type, id), 'invalid', `${type}/${id}`);
  }
  assert.equal(db.calls.length, 0, 'an invalid favourite never reaches Postgres');
  // A setup id that is not a uuid is refused too.
  assert.equal(await store.add(db, 'not-a-uuid', 'movie', 603), 'invalid');
});

test('listing maps rows to the wire shape and is newest first', async () => {
  const db = pool(() => ({
    rows: [
      { media_type: 'movie', tmdb_id: 603, added_at: new Date('2026-11-18T10:00:00Z') },
      { media_type: 'series', tmdb_id: 1396, added_at: '2026-11-17T10:00:00Z' },
      { media_type: 'nope', tmdb_id: 1, added_at: '2026-11-16T10:00:00Z' },
    ],
    rowCount: 3,
  }));
  const items = await store.list(db, UUID);
  assert.deepEqual(items, [
    { mediaType: 'movie', tmdbId: 603, addedAt: '2026-11-18T10:00:00.000Z' },
    { mediaType: 'series', tmdbId: 1396, addedAt: '2026-11-17T10:00:00Z' },
  ]);
  assert.match(db.calls[0].sql, /ORDER BY added_at DESC/);
});

test('adding twice is a no-op, and a full list says so instead of dropping rows', async () => {
  let insertRows = [{ media_type: 'movie' }];
  let existing = [];
  const db = pool((sql) => (/^INSERT/i.test(sql.trim()) ? { rows: insertRows, rowCount: insertRows.length } : { rows: existing, rowCount: existing.length }));
  assert.equal(await store.add(db, UUID, 'movie', 603), 'added');
  insertRows = [];
  existing = [{ '?column?': 1 }];
  assert.equal(await store.add(db, UUID, 'movie', 603), 'exists');
  existing = [];
  assert.equal(await store.add(db, UUID, 'movie', 603), 'full');
  // The cap is part of the insert itself, so a burst cannot overshoot it.
  assert.match(db.calls.find((call) => /^INSERT/i.test(call.sql.trim())).sql, /count\(\*\) FROM setup_favourites WHERE uuid = \$1\) < \$4/);
  assert.equal(db.calls.find((call) => /^INSERT/i.test(call.sql.trim())).params[3], store.MAX_FAVOURITES);
});

test('the catalogue read splits movie and series and carries a version', async () => {
  const db = pool(() => ({
    rows: [
      { media_type: 'movie', tmdb_id: 603, newest: 1763460000, total: 3 },
      { media_type: 'series', tmdb_id: 1396, newest: 1763460000, total: 3 },
      { media_type: 'movie', tmdb_id: 27205, newest: 1763460000, total: 3 },
    ],
    rowCount: 3,
  }));
  const all = await store.setForCatalog(db, UUID);
  assert.deepEqual([...all.movie].sort((a, b) => a - b), [603, 27205]);
  assert.deepEqual([...all.series], [1396]);
  assert.equal(all.version, '3:1763460000', 'count and newest time: a change always moves it');
  const movies = await store.catalogIds(db, UUID, 'movie');
  assert.deepEqual([...movies.ids].sort((a, b) => a - b), [603, 27205]);
});

test('an empty list is empty, with a stable version', async () => {
  const db = pool(() => ({ rows: [], rowCount: 0 }));
  const set = await store.setForCatalog(db, UUID);
  assert.equal(set.movie.size, 0);
  assert.equal(set.series.size, 0);
  assert.equal(set.version, '0:0');
  assert.deepEqual(await store.list(db, 'nope'), []);
});

test('held seasons come from the file rows, never from the show\'s episode list', () => {
  const review = require('../src/library/review.ts');
  // The 2026-11-18 bug: a library with 17 files in S34 reported S1-S30 complete
  // because the ownership query joined lib_items to lib_episodes, whose rows all
  // share the title's entity key. These rows are what lib_items says now.
  const held = review.heldSeasonsFromRows([
    { tmdb_id: 4656, season: 34, episodes: 17, packs: 0 },
  ]);
  assert.deepEqual([...(held.get(4656) || [])], [{ season: 34, owned: 17, pack: false }]);

  // A season pack names the season and no episode: it holds the season.
  const packs = review.heldSeasonsFromRows([
    { tmdb_id: 1396, season: 2, episodes: 0, packs: 1 },
    { tmdb_id: 1396, season: 1, episodes: 8, packs: 0 },
  ]);
  assert.deepEqual([...(packs.get(1396) || [])], [
    { season: 1, owned: 8, pack: false },
    { season: 2, owned: 0, pack: true },
  ]);

  // Nonsense and empty rows never invent a season.
  assert.equal(review.heldSeasonsFromRows([{ tmdb_id: 1, season: null, episodes: 3 }]).size, 0);
  assert.equal(review.heldSeasonsFromRows([{ tmdb_id: 1, season: 2, episodes: 0, packs: 0 }]).size, 0);
  assert.equal(review.heldSeasonsFromRows([]).size, 0);
  assert.equal(review.heldSeasonsFromRows(null).size, 0);
});

test('a season length of null or 0 means unknown, never "complete"', () => {
  const review = require('../src/library/review.ts');
  // TMDB has not sent this season yet: the page must say "7 episodes", not
  // "complete". This is the bug that made a show with 7 of 10 look full.
  assert.equal(review.seasonTotal(null), null);
  assert.equal(review.seasonTotal(undefined), null);
  assert.equal(review.seasonTotal(0), null);
  assert.equal(review.seasonTotal(''), null);
  assert.equal(review.seasonTotal('nope'), null);
  assert.equal(review.seasonTotal(-3), null);
  assert.equal(review.seasonTotal(10), 10);
  assert.equal(review.seasonTotal('12'), 12);
});

// ── The Hub folder ───────────────────────────────────────────────────────

test('the Hub gains a Favourites folder that points at the personal rows', () => {
  const hub = { id: 'collection-lelibrary-hub', title: 'LeLibrary', folders: [
    { id: 'folder-lelibrary-hub-movies', title: 'Movies', catalogSources: [{ catalogId: 'torbox-movies', type: 'movie' }] },
    { id: 'folder-lelibrary-hub-shows', title: 'Shows', catalogSources: [{ catalogId: 'torbox-series', type: 'series' }] },
  ] };
  const upgraded = withHubExtras(hub);
  const ids = upgraded.folders.map((folder) => folder.id);
  // Right after Anime, in Hub order, on every provider.
  assert.deepEqual(ids.slice(0, 4), [
    'folder-lelibrary-hub-movies', 'folder-lelibrary-hub-shows',
    'folder-lelibrary-hub-anime', 'folder-lelibrary-hub-favourites',
  ]);
  const folder = upgraded.folders.find((entry) => entry.id === 'folder-lelibrary-hub-favourites');
  assert.equal(folder.title, 'Favourites');
  assert.deepEqual(folder.catalogSources.map((source) => `${source.type}:${source.catalogId}`),
    ['movie:lelibrary-user-favourites-movie', 'series:lelibrary-user-favourites-series']);
  assert.equal(folder.heroBackdropUrl, '/collection-assets/collections/covers/lelibrary-hub-favourites-v3.jpg');
  assert.equal(withHubExtras(upgraded), upgraded, 'never added twice');
});

test('the plan keeps the folder art and lists the personal rows for the manifest', () => {
  const hub = withHubExtras({ id: 'collection-lelibrary-hub', title: 'LeLibrary', folders: [
    { id: 'folder-lelibrary-hub-movies', title: 'Movies', catalogSources: [{ catalogId: 'torbox-movies', type: 'movie' }] },
    { id: 'folder-lelibrary-hub-shows', title: 'Shows', catalogSources: [{ catalogId: 'torbox-series', type: 'series' }] },
  ] });
  const plan = compileCollectionPlan({ collections: [hub], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: true });
  const planned = plan.collections[0].folders.find((folder) => folder.id === 'folder-lelibrary-hub-favourites');
  assert.match(planned.coverImageUrl, /lelibrary-hub-favourites-v3\.jpg$/);
  assert.match(planned.focusGifUrl, /lelibrary-hub-favourites-focus-v3\.gif$/);
  assert.equal(planned.focusGifEnabled, true);
  const rows = plan.userListRows.map((row) => row.catalogId);
  assert.ok(rows.includes('lelibrary-user-favourites-movie'));
  assert.ok(rows.includes('lelibrary-user-favourites-series'));
  // Without the library database their rows are never declared: no folder.
  const noDb = compileCollectionPlan({ collections: [hub], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: false });
  assert.ok(!noDb.collections[0].folders.some((folder) => folder.id === 'folder-lelibrary-hub-favourites'));
});

// ── The manifest ─────────────────────────────────────────────────────────

const favouritesRowsFrom = (plan) => plan.userListRows.map((row) => ({
  catalogId: row.catalogId, type: row.type, title: row.title,
}));

test('the manifest declares both Favourites rows for a folder that uses them', () => {
  const hub = withHubExtras({ id: 'collection-lelibrary-hub', title: 'LeLibrary', folders: [
    { id: 'folder-lelibrary-hub-movies', title: 'Movies', catalogSources: [{ catalogId: 'torbox-movies', type: 'movie' }] },
    { id: 'folder-lelibrary-hub-shows', title: 'Shows', catalogSources: [{ catalogId: 'torbox-series', type: 'series' }] },
  ] });
  const plan = compileCollectionPlan({ collections: [hub], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: true });
  const manifest = getConfiguredManifest('http://localhost:7860', CONFIG, {
    integration: 'nuvio', userListRows: favouritesRowsFrom(plan), homeRows: [], collectionRefs: plan.folderLibraryIds,
  });
  const movie = manifest.catalogs.find((catalog) => catalog.id === 'lelibrary-user-favourites-movie');
  const series = manifest.catalogs.find((catalog) => catalog.id === 'lelibrary-user-favourites-series');
  assert.ok(movie, 'the movie row is declared');
  assert.ok(series, 'the series row is declared');
  assert.equal(movie.type, 'movie');
  assert.equal(series.type, 'series');
  assert.equal(movie.name, 'Favourites');
  // Used only by a folder: advertised, kept off Home.
  assert.equal(movie.showInHome, false);
});

test('a Favourites row picked as Home is on Home, like any picked row', () => {
  const row = { enabled: true, source: { id: 'lelibrary-user-favourites-series', catalogId: 'lelibrary-user-favourites-series', type: 'series' } };
  const manifest = getConfiguredManifest('http://localhost:7860', CONFIG, {
    integration: 'nuvio',
    userListRows: [{ catalogId: 'lelibrary-user-favourites-series', type: 'series', title: 'Favourites' }, { catalogId: 'lelibrary-user-favourites-movie', type: 'movie', title: 'Favourites' }],
    homeRows: [row],
  });
  const series = manifest.catalogs.find((catalog) => catalog.id === 'lelibrary-user-favourites-series');
  assert.ok(series);
  assert.equal(series.showInHome, undefined, 'a picked row is on Home');
  const movie = manifest.catalogs.find((catalog) => catalog.id === 'lelibrary-user-favourites-movie');
  assert.equal(movie.showInHome, false, 'the other one stays off Home');
});
