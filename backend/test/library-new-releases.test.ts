// @ts-nocheck
'use strict';
// The Hub's New Releases folder (v6): `{prefix}-{movies,series}-new` rows,
// films released and shows last aired in the last 12 months, newest first,
// from the dates kept in lib_tmdb_genres. No network, no database: the
// engine's reads are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseLibraryCatalogId, matchesVariant, needsLibraryFacts } = require('../src/library/quality-filter.ts');
const nr = require('../src/library/new-releases.ts');
const genres = require('../src/library/genres.ts');

const ROOT = path.join(__dirname, '..', '..');
const NOW = new Date(Date.UTC(2026, 10, 6, 12)); // 2026-11-06

test('New Releases ids parse like the 4K / HDR rows', () => {
  assert.deepEqual(parseLibraryCatalogId('torbox-movies-new'), { prefix: 'torbox', kind: 'movies', variant: 'new' });
  assert.deepEqual(parseLibraryCatalogId('rd-series-new'), { prefix: 'rd', kind: 'series', variant: 'new' });
  assert.equal(parseLibraryCatalogId('torbox-anime-new'), null, 'no anime variant');
  assert.equal(parseLibraryCatalogId('torbox-movies-newest'), null);
  // Filtered by dates, not names; the request-time path answers it empty.
  assert.equal(matchesVariant({ name: 'Plain.Film.1080p' }, 'new'), true);
  assert.equal(needsLibraryFacts('new'), true);
  assert.equal(needsLibraryFacts('g-horror'), true);
  assert.equal(needsLibraryFacts('4k'), false);
});

test('the window is the last 12 months up to today', () => {
  assert.deepEqual(nr.releaseWindow(NOW), { from: '2025-11-06', to: '2026-11-06' });
  const movie = (release_date) => nr.isNewRelease('movies', { release_date }, NOW);
  assert.equal(movie('2026-11-06'), true, 'today');
  assert.equal(movie('2025-11-06'), true, 'exactly a year ago');
  assert.equal(movie('2025-12-25'), true);
  assert.equal(movie('2025-11-05'), false, 'a year and a day ago');
  assert.equal(movie('2026-11-07'), false, 'not out yet');
  assert.equal(movie(null), false, 'no date: never guessed');
  assert.equal(movie('2026'), false, 'a year alone is not a date');
  assert.equal(nr.isNewRelease('movies', null, NOW), false);
  // Dates from Postgres arrive as Date objects.
  assert.equal(nr.isNewRelease('movies', { release_date: new Date(Date.UTC(2026, 5, 1)) }, NOW), true);
});

test('shows count by their latest aired episode, so returning shows are new', () => {
  // First aired in 2011, new season this year.
  assert.equal(nr.isNewRelease('series', { release_date: '2011-04-17', last_air_date: '2026-05-19' }, NOW), true);
  // Ended years ago.
  assert.equal(nr.isNewRelease('series', { release_date: '2008-01-20', last_air_date: '2013-09-29' }, NOW), false);
  // A show only has a first air date (latest episode unknown): left out.
  assert.equal(nr.isNewRelease('series', { release_date: '2026-02-01', last_air_date: null }, NOW), false);
});

test('the dates come off the same TMDB read as the genres', () => {
  assert.deepEqual(genres.datesFrom('movie', { release_date: '2026-03-14' }), { releaseDate: '2026-03-14', lastAirDate: null, inProduction: null });
  assert.deepEqual(genres.datesFrom('movie', { release_date: '' }), { releaseDate: null, lastAirDate: null, inProduction: null });
  assert.deepEqual(genres.datesFrom('tv', { first_air_date: '2011-04-17', last_air_date: '2026-05-19', in_production: false }),
    { releaseDate: '2011-04-17', lastAirDate: '2026-05-19', inProduction: false });
  // TMDB's last aired episode wins over last_air_date (which can be a
  // scheduled episode).
  assert.equal(genres.datesFrom('tv', { last_air_date: '2026-12-01', last_episode_to_air: { air_date: '2026-10-30' } }).lastAirDate, '2026-10-30');
});

test('newest first, then by name, whatever the setup sorts by', () => {
  const { sortMetas } = require('../src/library/catalog.ts');
  const metas = [{ tmdbId: 1, name: 'B' }, { tmdbId: 2, name: 'A' }, { tmdbId: 3, name: 'C' }, { tmdbId: 4, name: 'A2' }];
  const rank = new Map([[1, '2026-01-01'], [2, '2026-09-30'], [3, '2026-01-01'], [4, '2025-12-01']]);
  sortMetas(metas, 'titulo', rank);
  assert.deepEqual(metas.map((m) => m.tmdbId), [2, 1, 3, 4]);
});

// The engine's read path with every dependency stubbed.
function stubEngine({ rows, dates, adult = [], excluded = [] }) {
  const store = require('../src/library/store.ts');
  const catalog = require('../src/library/catalog.ts');
  const cache = require('../src/runtime/cache.ts');
  const saved = {
    catalogRows: store.catalogRows, buildFromRows: catalog.buildFromRows, get: cache.get, set: cache.set,
    recent: nr.recentReleaseDates, adultTmdbIds: genres.adultTmdbIds, idsMatchingRules: genres.idsMatchingRules,
  };
  const seen = { keys: [], built: [] };
  store.catalogRows = async () => rows;
  catalog.buildFromRows = async (input, opts) => { seen.built.push({ ids: input.map((r) => r.tmdb_id), rank: opts.rank }); return []; };
  cache.get = async (key) => { seen.keys.push(key); return null; };
  cache.set = async () => true;
  nr.recentReleaseDates = async () => new Map(dates);
  genres.adultTmdbIds = async () => new Set(adult);
  genres.idsMatchingRules = async () => new Set(excluded);
  const restore = () => {
    store.catalogRows = saved.catalogRows; catalog.buildFromRows = saved.buildFromRows; cache.get = saved.get; cache.set = saved.set;
    nr.recentReleaseDates = saved.recent; genres.adultTmdbIds = saved.adultTmdbIds; genres.idsMatchingRules = saved.idsMatchingRules;
  };
  return { seen, restore };
}

const ROWS = [
  { tmdb_id: 1, entity_key: 'e1', match_meta: {} },
  { tmdb_id: 2, entity_key: 'e2', match_meta: {} },
  { tmdb_id: 3, entity_key: 'e3', match_meta: { isJapaneseAnimation: true } },
  { tmdb_id: 4, entity_key: 'e4', match_meta: {} },
  { tmdb_id: 5, entity_key: 'e5', match_meta: {} },
  { tmdb_id: null, entity_key: 'unmatched', match_meta: {} },
];
const DATES = [[1, '2026-10-01'], [2, '2026-03-01'], [3, '2026-11-01'], [4, '2026-06-01']];
const config = (extra = {}) => ({ provider: 'torbox', torboxApiKey: 'tb-new-releases-test', ...extra });

test('only dated titles in the window are kept, ranked by date', async () => {
  const engine = require('../src/library/engine.ts');
  const { seen, restore } = stubEngine({ rows: ROWS, dates: DATES });
  try {
    await engine.buildCatalog({ token: 't', config: config(), type: 'movie', variant: 'new' });
    assert.deepEqual(seen.built[0].ids, [1, 2, 3, 4], 'title 5 (no date) and the unmatched row are left out');
    assert.equal(seen.built[0].rank.get(1), '2026-10-01');
  } finally { restore(); }
});

test('content filters apply to New Releases like every library row', async () => {
  const engine = require('../src/library/engine.ts');
  const { seen, restore } = stubEngine({ rows: ROWS, dates: DATES, adult: [4], excluded: [2] });
  try {
    await engine.buildCatalog({
      token: 't', type: 'movie', variant: 'new',
      config: config({ hideAnime: true, hideAdultContent: true, excludeCategories: ['horror'] }),
    });
    // 3 is anime, 4 adult, 2 in an excluded category.
    assert.deepEqual(seen.built[0].ids, [1]);
  } finally { restore(); }
});

test('the page cache key moves with the variant, the day and the fill', async () => {
  const engine = require('../src/library/engine.ts');
  const { seen, restore } = stubEngine({ rows: ROWS, dates: DATES });
  try {
    await engine.buildCatalog({ token: 't', config: config(), type: 'movie', variant: 'new' });
    await engine.buildCatalog({ token: 't', config: config(), type: 'movie', variant: null });
    await engine.buildCatalog({ token: 't', config: config(), type: 'movie', variant: '4k' });
    assert.equal(new Set(seen.keys).size, 3, 'My Movies, 4K and New Releases never share a page');
    assert.match(nr.newReleasesKey(NOW), /^2026-11-06@\d+$/);
    assert.notEqual(nr.newReleasesKey(NOW), nr.newReleasesKey(new Date(Date.UTC(2026, 10, 7))), 'the window moves daily');
  } finally { restore(); }
});

test('the manifest declares New Releases rows only when used, and only with the library database', () => {
  const engine = require('../src/library/engine.ts');
  const { getConfiguredManifest } = require('../app.ts');
  const CONFIG = { provider: 'torbox', torboxApiKey: 'tb-test', tmdbApiKey: 'tmdb-test', __configScope: { type: 'config', uuid: '3f0c1d1e-1111-4222-8333-444455556666', tier: 'full' } };
  const ids = (m) => m.catalogs.map((c) => c.id);
  const refs = { integration: 'nuvio', qualityRefs: ['torbox-movies-new', 'torbox-series-new'] };
  assert.ok(!ids(getConfiguredManifest('http://localhost:7860', CONFIG, refs)).includes('torbox-movies-new'), 'no database: never declared');
  const original = engine.isIndexed;
  engine.isIndexed = () => true;
  try {
    assert.ok(!ids(getConfiguredManifest('http://localhost:7860', CONFIG, { integration: 'nuvio' })).some((id) => /-new$/.test(id)), 'unused: not declared');
    const folder = getConfiguredManifest('http://localhost:7860', CONFIG, refs);
    const movies = folder.catalogs.find((c) => c.id === 'torbox-movies-new');
    const shows = folder.catalogs.find((c) => c.id === 'torbox-series-new');
    assert.equal(movies.type, 'movie');
    assert.equal(movies.name, '🎬 New Movies');
    assert.equal(shows.type, 'series');
    assert.equal(shows.name, '📺 New & Returning Shows');
    assert.equal(movies.showInHome, false, 'a folder-only row stays off Home');
    const home = getConfiguredManifest('http://localhost:7860', CONFIG, { integration: 'nuvio', homeRows: [{ enabled: true, source: { id: 'torbox-series-new', catalogId: 'torbox-series-new', type: 'series' } }] });
    assert.equal(home.catalogs.find((c) => c.id === 'torbox-series-new').showInHome, undefined, 'a picked row is on Home');
  } finally {
    engine.isIndexed = original;
  }
});

test('an old Hub gains New Releases right after Shows, with its own art', () => {
  const { withHubExtras, compileCollectionPlan } = require('../src/catalog/collection-plan.ts');
  const folder = (id, catalogId, type = 'movie') => ({ id, title: id, catalogSources: [{ catalogId, type }] });
  // A 5.9 Hub: everything but New Releases, one folder of the person's own at the end.
  const hub = { id: 'collection-lelibrary-hub', title: 'LeLibrary', folders: [
    folder('folder-lelibrary-hub-movies', 'torbox-movies'),
    folder('folder-lelibrary-hub-shows', 'torbox-series', 'series'),
    folder('folder-lelibrary-hub-4k', 'torbox-movies-4k'),
    folder('folder-lelibrary-hub-hdr', 'torbox-movies-hdr'),
    folder('folder-lelibrary-hub-genres', 'torbox-movies-genres'),
    folder('folder-mine', 'lib-trending_movies'),
  ] };
  const upgraded = withHubExtras(hub);
  assert.deepEqual(upgraded.folders.map((f) => f.id), [
    'folder-lelibrary-hub-movies', 'folder-lelibrary-hub-shows', 'folder-lelibrary-hub-new',
    'folder-lelibrary-hub-added', 'folder-lelibrary-hub-top',
    'folder-lelibrary-hub-4k', 'folder-lelibrary-hub-hdr', 'folder-lelibrary-hub-genres',
    'folder-lelibrary-hub-decades', 'folder-lelibrary-hub-world', 'folder-lelibrary-hub-family', 'folder-lelibrary-hub-length', 'folder-mine',
  ]);
  const added = upgraded.folders[2];
  assert.equal(added.title, 'New Releases');
  assert.deepEqual(added.catalogSources.map((s) => `${s.type}:${s.catalogId}`), ['movie:torbox-movies-new', 'series:torbox-series-new']);
  assert.equal(added.heroBackdropUrl, '/collection-assets/collections/covers/lelibrary-hub-new-v3.jpg', 'its cover is its backdrop, like Movies / Shows');
  assert.equal(withHubExtras(upgraded), upgraded, 'never added twice');
  // A Hub where the person moved Shows to the end: New Releases follows Shows.
  const moved = withHubExtras({ ...hub, folders: [hub.folders[0], ...hub.folders.slice(2), hub.folders[1]] });
  assert.deepEqual(moved.folders.slice(-4).map((f) => f.id), ['folder-lelibrary-hub-shows', 'folder-lelibrary-hub-new', 'folder-lelibrary-hub-added', 'folder-lelibrary-hub-top']);

  const withDb = compileCollectionPlan({ collections: [hub], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: true });
  const planned = withDb.collections[0].folders.find((f) => f.id === 'folder-lelibrary-hub-new');
  assert.match(planned.coverImageUrl, /lelibrary-hub-new-v3\.jpg$/);
  assert.match(planned.focusGifUrl, /lelibrary-hub-new-focus-v3\.gif$/);
  assert.equal(planned.focusGifEnabled, true);
  // Without the library database its rows are never declared: the folder stays out.
  const noDb = compileCollectionPlan({ collections: [hub], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: false });
  assert.ok(!noDb.collections[0].folders.some((f) => f.id === 'folder-lelibrary-hub-new'));
});

test('the New Releases art ships and is Hub art, not retired community art', () => {
  for (const file of ['covers/lelibrary-hub-new-v3.jpg', 'gifs/lelibrary-hub-new-focus-v3.gif']) {
    const full = path.join(ROOT, 'frontend', 'public', 'collection-assets', 'collections', file);
    assert.ok(fs.statSync(full).size > 10_000, `${file} exists`);
    const { retiredArtworkTarget } = require('../src/catalog/curated-collections.ts');
    assert.equal(retiredArtworkTarget(`/collection-assets/collections/${file}`), '', `${file} is current Hub art (HUB_ART)`);
  }
  const sources = fs.readFileSync(path.join(ROOT, 'frontend', 'public', 'collection-assets', 'ASSET_SOURCES.md'), 'utf8');
  assert.match(sources, /lelibrary-hub-new-v3/);
});

export interface LibraryNewReleasesTestModule {};
