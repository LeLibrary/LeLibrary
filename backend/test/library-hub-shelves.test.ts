// @ts-nocheck
'use strict';
// The Hub shelves (v6): Recently Added, Top Rated, Short or Long, Family
// Friendly, World Cinema and By Decade, from the user's own library and the
// facts kept in lib_tmdb_genres. No network, no database: the engine's reads
// are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseLibraryCatalogId, matchesVariant, needsLibraryFacts } = require('../src/library/quality-filter.ts');
const shelves = require('../src/library/hub-shelves.ts');
const genres = require('../src/library/genres.ts');

const ROOT = path.join(__dirname, '..', '..');
const NOW = new Date(Date.UTC(2026, 10, 7, 12)); // 2026-11-07
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

test('shelf ids parse like the other library variants', () => {
  for (const variant of ['added', 'top', 'family', 'world', 'decades']) {
    assert.deepEqual(parseLibraryCatalogId(`torbox-movies-${variant}`), { prefix: 'torbox', kind: 'movies', variant });
    assert.deepEqual(parseLibraryCatalogId(`rd-series-${variant}`), { prefix: 'rd', kind: 'series', variant });
    assert.equal(parseLibraryCatalogId(`torbox-anime-${variant}`), null, 'no anime variant');
  }
  assert.deepEqual(parseLibraryCatalogId('torbox-movies-short'), { prefix: 'torbox', kind: 'movies', variant: 'short' });
  assert.deepEqual(parseLibraryCatalogId('pm-movies-long'), { prefix: 'pm', kind: 'movies', variant: 'long' });
  assert.equal(parseLibraryCatalogId('torbox-series-short'), null, 'films only');
  assert.equal(parseLibraryCatalogId('torbox-series-long'), null, 'films only');
  assert.equal(parseLibraryCatalogId('torbox-movies-topper'), null);
  // Filtered by facts, not names; the request-time path answers them empty.
  for (const variant of ['added', 'top', 'short', 'long', 'family', 'world', 'decades', 'w-ko', 'd-1990s']) {
    assert.equal(matchesVariant({ name: 'Plain.Film.1080p' }, variant), true, variant);
    assert.equal(needsLibraryFacts(variant), true, variant);
  }
  assert.equal(needsLibraryFacts('hdr'), false);
});

test('Recently Added: last 30 days, films by first copy, shows by latest file', () => {
  const rows = [
    // Film 1: first copy 10 days ago, a 4K copy yesterday -> counts from 10 days.
    { tmdb_id: 1, source_created_at: ago(10) },
    { tmdb_id: 1, source_created_at: ago(1) },
    // Film 2: first copy 40 days ago, a new copy yesterday -> not recently added.
    { tmdb_id: 2, source_created_at: ago(40) },
    { tmdb_id: 2, source_created_at: ago(1) },
    // Film 3: no provider time: when LeLibrary first saw it (a Date from pg).
    { tmdb_id: 3, source_created_at: null, first_seen_at: new Date(NOW.getTime() - 5 * DAY) },
    // Film 4: exactly 30 days ago is in, 31 days out.
    { tmdb_id: 4, source_created_at: ago(30) },
    { tmdb_id: 5, source_created_at: ago(31) },
    // A future time (clock skew) is not "added".
    { tmdb_id: 6, source_created_at: new Date(NOW.getTime() + DAY).toISOString() },
    // No id / no time: never guessed.
    { tmdb_id: null, source_created_at: ago(1) },
    { tmdb_id: 7 },
  ];
  const films = shelves.recentlyAdded('movies', rows, NOW);
  assert.deepEqual([...films.keys()].sort(), [1, 3, 4]);
  assert.equal(films.get(1), ago(10));
  // Shows: the latest episode decides, so show 2 (new episode yesterday) is in.
  const shows = shelves.recentlyAdded('series', rows, NOW);
  assert.deepEqual([...shows.keys()].sort(), [1, 2, 3, 4]);
  assert.equal(shows.get(2), ago(1));
});

test('Top Rated: vote floors per kind, best first, at most 100', async () => {
  assert.equal(shelves.TOP_MIN_VOTES.movies, 500);
  assert.equal(shelves.TOP_MIN_VOTES.series, 200);
  assert.equal(shelves.isTopRated('movies', { vote_average: 8.4, vote_count: 500 }), true);
  assert.equal(shelves.isTopRated('movies', { vote_average: 9.6, vote_count: 499 }), false, 'too few votes');
  assert.equal(shelves.isTopRated('series', { vote_average: 8.1, vote_count: 200 }), true);
  assert.equal(shelves.isTopRated('series', { vote_average: 8.1, vote_count: 199 }), false);
  assert.equal(shelves.isTopRated('movies', { vote_average: null, vote_count: null }), false, 'not read yet');

  const saved = shelves.shelfIds;
  // 150 owned titles above the floor, scores rising with the id.
  shelves.shelfIds = async () => new Map(Array.from({ length: 150 }, (_, i) => [i + 1, 5 + i / 100]));
  try {
    const rows = [...Array.from({ length: 150 }, (_, i) => ({ tmdb_id: i + 1 })), { tmdb_id: 150 }, { tmdb_id: 999 }];
    const out = await shelves.applyShelf('top', 'movies', rows, NOW);
    assert.equal(out.rank.size, shelves.TOP_CAP);
    assert.ok(out.rank.has(150) && out.rank.has(51) && !out.rank.has(50), 'the best 100 stay');
    assert.equal(out.rows.filter((row) => row.tmdb_id === 150).length, 2, 'every copy of a kept title stays');
    assert.ok(!out.rows.some((row) => row.tmdb_id === 999), 'no votes stored: left out');
  } finally { shelves.shelfIds = saved; }
});

test('Short or Long: under 100 / over 150 minutes, films only, unknown runtime left out', async () => {
  assert.equal(shelves.isShort({ runtime: 99 }), true);
  assert.equal(shelves.isShort({ runtime: 100 }), false);
  assert.equal(shelves.isShort({ runtime: 0 }), false, 'TMDB 0 = unknown');
  assert.equal(shelves.isShort({ runtime: null }), false);
  assert.equal(shelves.isLong({ runtime: 151 }), true);
  assert.equal(shelves.isLong({ runtime: 150 }), false);
  assert.equal(shelves.isLong({}), false);
  const out = await shelves.applyShelf('short', 'series', [{ tmdb_id: 1 }], NOW);
  assert.deepEqual(out.rows, [], 'a show has no single runtime');
  // Runtime off the same TMDB reply; shows store none.
  assert.deepEqual(genres.shelfFactsFrom('movie', { vote_average: 7.8, vote_count: 1234, runtime: 142 }), { voteAverage: 7.8, voteCount: 1234, runtime: 142 });
  assert.deepEqual(genres.shelfFactsFrom('movie', { runtime: 0 }), { voteAverage: null, voteCount: null, runtime: null });
  assert.equal(genres.shelfFactsFrom('tv', { runtime: 45, episode_run_time: [45] }).runtime, null);
});

test('Family Friendly: US rating decides, UK only when there is no US one, unrated out', () => {
  const film = (certification, certification_gb) => shelves.isFamily('movies', { certification, certification_gb });
  assert.equal(film('G'), true);
  assert.equal(film('PG'), true);
  assert.equal(film('PG-13', 'PG'), false, 'the US rating wins');
  assert.equal(film('R'), false);
  assert.equal(film(null, 'U'), true, 'UK when the US has none');
  assert.equal(film('', 'PG'), true);
  assert.equal(film(null, '12A'), false);
  assert.equal(film(null, null), false, 'unrated: left out');
  const show = (certification, certification_gb) => shelves.isFamily('series', { certification, certification_gb });
  for (const rating of ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG']) assert.equal(show(rating), true, rating);
  assert.equal(show('TV-14'), false);
  assert.equal(show('TV-MA'), false);
  assert.equal(show(null, 'U'), true);
  assert.equal(show(null, null), false);
});

test('one TMDB read gives the UK certification too', async () => {
  const reply = (data) => async () => ({ data });
  const facts = await genres.fetchFacts('k', 'movie', 1, reply({
    genres: [], keywords: { keywords: [] }, original_language: 'fr', vote_average: 7.9, vote_count: 2100, runtime: 97,
    release_dates: { results: [
      { iso_3166_1: 'US', release_dates: [{ certification: 'PG', type: 3 }] },
      { iso_3166_1: 'GB', release_dates: [{ certification: 'U', type: 3 }] },
    ] },
  }));
  assert.equal(facts.certification, 'PG');
  assert.equal(facts.certificationGb, 'U');
  assert.equal(facts.voteCount, 2100);
  assert.equal(facts.runtime, 97);
  const tv = await genres.fetchFacts('k', 'tv', 1, reply({ content_ratings: { results: [{ iso_3166_1: 'GB', rating: 'PG' }] } }));
  assert.equal(tv.certification, null);
  assert.equal(tv.certificationGb, 'PG');
  assert.equal(genres.FACTS_VERSION >= 2, true, 'bumped so titles read before get the new fields');
});

test('World Cinema: English names, one code per name, English is not world cinema', () => {
  assert.equal(shelves.languageName('ko'), 'Korean');
  assert.equal(shelves.languageName('ja'), 'Japanese');
  assert.equal(shelves.languageName('fr'), 'French');
  assert.equal(shelves.languageName('es'), 'Spanish');
  assert.equal(shelves.languageName('hi'), 'Hindi');
  assert.equal(shelves.languageName('cn'), 'Cantonese', 'TMDB code');
  assert.equal(shelves.languageName('nb'), 'Norwegian', 'one Norwegian tab');
  assert.equal(shelves.languageName('en'), null);
  assert.equal(shelves.languageName('xx'), null);
  assert.equal(shelves.tabVariant('world', 'Korean'), 'w-ko');
  assert.equal(shelves.tabVariant('world', 'norwegian'), 'w-no');
  assert.equal(shelves.tabVariant('world', 'Klingon'), null);
  const names = shelves.worldLanguageNames();
  assert.equal(new Set(names).size, names.length, 'every tab name maps back to one language');
});

test('By Decade: decade buckets, before 1970 shared, future dates left out', () => {
  assert.deepEqual(shelves.DECADES, ['2020s', '2010s', '2000s', '1990s', '1980s', '1970s', 'Before 1970']);
  assert.equal(shelves.decadeOf('2026-03-01', NOW), '2020s');
  assert.equal(shelves.decadeOf('2019-12-31', NOW), '2010s');
  assert.equal(shelves.decadeOf('1970-01-01', NOW), '1970s');
  assert.equal(shelves.decadeOf('1969-12-31', NOW), 'Before 1970');
  assert.equal(shelves.decadeOf('1931-05-01', NOW), 'Before 1970');
  assert.equal(shelves.decadeOf(new Date(Date.UTC(1994, 5, 1)), NOW), '1990s');
  assert.equal(shelves.decadeOf('2026-12-01', NOW), null, 'not out yet');
  assert.equal(shelves.decadeOf(null, NOW), null, 'no date: never guessed');
  assert.equal(shelves.tabVariant('decades', '1990s'), 'd-1990s');
  assert.equal(shelves.tabVariant('decades', 'Before 1970'), 'd-pre1970');
  assert.equal(shelves.tabVariant('decades', '1960s'), null);
});

test('language and decade tab counts respect the content filters', () => {
  const facts = [
    { media_type: 'movie', orig_lang: 'ko', genre_ids: [18], keyword_ids: [], release_day: '2019-05-30' },
    { media_type: 'movie', orig_lang: 'ko', genre_ids: [27], keyword_ids: [], release_day: '2016-07-20' },
    { media_type: 'tv', orig_lang: 'ko', genre_ids: [18], keyword_ids: [], release_day: '2021-09-17' },
    // Anime: Japanese animation.
    { media_type: 'tv', orig_lang: 'ja', genre_ids: [16], keyword_ids: [210024], release_day: '2013-04-07' },
    { media_type: 'movie', orig_lang: 'fr', genre_ids: [18], keyword_ids: [], adult: false, certification: 'NC-17', release_day: '1995-01-01' },
    { media_type: 'movie', orig_lang: 'en', genre_ids: [28], keyword_ids: [], release_day: '1985-07-03' },
    { media_type: 'movie', orig_lang: null, genre_ids: [], keyword_ids: [], release_day: null },
  ];
  const all = shelves.tabCounts(facts, null, NOW);
  assert.deepEqual(all.world, [
    { kind: 'movies', name: 'Korean', count: 2 },
    { kind: 'movies', name: 'French', count: 1 },
    { kind: 'series', name: 'Japanese', count: 1 },
    { kind: 'series', name: 'Korean', count: 1 },
  ]);
  assert.deepEqual(all.decades.map((e) => `${e.kind}:${e.name}:${e.count}`), [
    'series:2020s:1', 'movies:2010s:2', 'series:2010s:1', 'movies:1990s:1', 'movies:1980s:1',
  ], 'newest decade first, films then shows; English titles count toward decades');
  const filtered = shelves.tabCounts(facts, { hideAnime: true, hideAdult: true, excludeCategories: ['horror'] }, NOW);
  assert.deepEqual(filtered.world, [{ kind: 'movies', name: 'Korean', count: 1 }, { kind: 'series', name: 'Korean', count: 1 }]);
  assert.ok(!filtered.decades.some((e) => e.name === '1990s'), 'the adult film no longer counts');
});

test('push-time tabs: thresholds, fallback, folder left out with no tab', () => {
  const { expandHubTabs, compileCollectionPlan, withHubExtras } = require('../src/catalog/collection-plan.ts');
  const hub = withHubExtras({ id: 'collection-lelibrary-hub', title: 'LeLibrary', folders: [
    { id: 'folder-lelibrary-hub-movies', title: 'Movies', catalogSources: [{ catalogId: 'torbox-movies', type: 'movie' }] },
    { id: 'folder-lelibrary-hub-shows', title: 'Shows', catalogSources: [{ catalogId: 'torbox-series', type: 'series' }] },
  ] });
  const world = hub.folders.find((f) => f.id === 'folder-lelibrary-hub-world');
  assert.deepEqual(world.catalogSources.map((s) => `${s.type}:${s.catalogId}:${s.genre}`), ['movie:torbox-movies-world:', 'series:torbox-series-world:']);
  const tabs = {
    world: [{ kind: 'movies', name: 'Korean', count: 12 }, { kind: 'movies', name: 'French', count: 7 }, { kind: 'series', name: 'Japanese', count: 5 }, { kind: 'movies', name: 'Hindi', count: 4 }],
    decades: [{ kind: 'movies', name: '2020s', count: 40 }, { kind: 'series', name: '2020s', count: 3 }, { kind: 'movies', name: '2010s', count: 9 }, { kind: 'movies', name: '1990s', count: 5 }],
  };
  const [expanded] = expandHubTabs([hub], tabs);
  const folder = (id) => expanded.folders.find((f) => f.id === id);
  assert.deepEqual(folder('folder-lelibrary-hub-world').catalogSources.map((s) => `${s.type}:${s.catalogId}:${s.genre}`), [
    'movie:torbox-movies-world:Korean', 'movie:torbox-movies-world:French', 'series:torbox-series-world:Japanese',
  ], 'Hindi (4) is under the bar of 5');
  assert.deepEqual(folder('folder-lelibrary-hub-decades').catalogSources.map((s) => `${s.type}:${s.genre}`), ['movie:2020s', 'movie:2010s', 'movie:1990s']);
  // A small library: fewer than three tabs at 5+ falls back to 2+.
  const [small] = expandHubTabs([hub], { world: [{ kind: 'movies', name: 'Korean', count: 6 }, { kind: 'movies', name: 'French', count: 2 }, { kind: 'movies', name: 'Thai', count: 1 }], decades: [] });
  assert.deepEqual(small.folders.find((f) => f.id === 'folder-lelibrary-hub-world').catalogSources.map((s) => s.genre), ['Korean', 'French']);
  // No decade tab: the folder stays genre-less and the plan leaves it out.
  const plan = compileCollectionPlan({ collections: [small], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: true });
  const ids = plan.collections[0].folders.map((f) => f.id);
  assert.ok(ids.includes('folder-lelibrary-hub-world'));
  assert.ok(!ids.includes('folder-lelibrary-hub-decades'));
});

test('Hub order, art and database gate for the six shelf folders', () => {
  const { withHubExtras, compileCollectionPlan, expandHubTabs } = require('../src/catalog/collection-plan.ts');
  const base = { id: 'collection-lelibrary-hub', title: 'LeLibrary', folders: [
    { id: 'folder-lelibrary-hub-movies', title: 'Movies', catalogSources: [{ catalogId: 'rd-movies', type: 'movie' }] },
    { id: 'folder-lelibrary-hub-shows', title: 'Shows', catalogSources: [{ catalogId: 'rd-series', type: 'series' }] },
    { id: 'folder-lelibrary-hub-new', title: 'New Releases', catalogSources: [{ catalogId: 'rd-movies-new', type: 'movie' }] },
    { id: 'folder-lelibrary-hub-4k', title: '4K', catalogSources: [{ catalogId: 'rd-movies-4k', type: 'movie' }] },
    { id: 'folder-lelibrary-hub-hdr', title: 'HDR', catalogSources: [{ catalogId: 'rd-movies-hdr', type: 'movie' }] },
    // The person moved Genres to the top and added a folder of their own.
    { id: 'folder-mine', title: 'Mine', catalogSources: [{ catalogId: 'lib-trending_movies', type: 'movie' }] },
  ] };
  base.folders.unshift({ id: 'folder-lelibrary-hub-genres', title: 'Genres', catalogSources: [{ catalogId: 'rd-movies-genres', type: 'movie' }] });
  const upgraded = withHubExtras(base);
  assert.deepEqual(upgraded.folders.map((f) => f.id.replace('folder-lelibrary-hub-', '')), [
    'genres', 'decades', 'world', 'family', 'length', 'movies', 'shows', 'new', 'added', 'top', '4k', 'hdr', 'folder-mine',
  ], 'each new folder follows its nearest earlier Hub folder; moved folders keep their places');
  const length = upgraded.folders.find((f) => f.id === 'folder-lelibrary-hub-length');
  assert.equal(length.title, 'Short or Long');
  assert.deepEqual(length.catalogSources.map((s) => `${s.type}:${s.catalogId}`), ['movie:rd-movies-short', 'movie:rd-movies-long']);
  const titles = Object.fromEntries(upgraded.folders.map((f) => [f.id, f.title]));
  assert.equal(titles['folder-lelibrary-hub-added'], 'Recently Added');
  assert.equal(titles['folder-lelibrary-hub-top'], 'Top Rated');
  assert.equal(titles['folder-lelibrary-hub-decades'], 'By Decade');
  assert.equal(titles['folder-lelibrary-hub-world'], 'World Cinema');
  assert.equal(titles['folder-lelibrary-hub-family'], 'Family Friendly');
  assert.equal(withHubExtras(upgraded), upgraded, 'never added twice');

  const [filled] = expandHubTabs([upgraded], { world: [{ kind: 'movies', name: 'Korean', count: 9 }], decades: [{ kind: 'movies', name: '1990s', count: 9 }] });
  const withDb = compileCollectionPlan({ collections: [filled], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: true });
  const planned = withDb.collections[0].folders;
  for (const name of ['added', 'top', 'decades', 'world', 'family', 'length']) {
    const f = planned.find((x) => x.id === `folder-lelibrary-hub-${name}`);
    assert.ok(f, name);
    assert.match(f.coverImageUrl, new RegExp(`lelibrary-hub-${name}-v3\\.jpg$`));
    assert.match(f.focusGifUrl, new RegExp(`lelibrary-hub-${name}-focus-v3\\.gif$`));
    assert.equal(f.heroBackdropUrl, `/collection-assets/collections/covers/lelibrary-hub-${name}-v3.jpg`, 'its cover is its backdrop');
  }
  const noDb = compileCollectionPlan({ collections: [filled], integration: 'nuvio', manifestId: 'community.lelibrary.selfhosted', libraryFacts: false });
  const left = noDb.collections[0].folders.map((f) => f.id);
  for (const name of ['new', 'added', 'top', 'decades', 'world', 'family', 'length']) assert.ok(!left.includes(`folder-lelibrary-hub-${name}`), name);
  assert.ok(left.includes('folder-lelibrary-hub-4k'), '4K reads names, not facts');
});

test('the manifest declares shelf rows only when used, and only with the library database', () => {
  const engine = require('../src/library/engine.ts');
  const { getConfiguredManifest } = require('../app.ts');
  const CONFIG = { provider: 'torbox', torboxApiKey: 'tb-test', tmdbApiKey: 'tmdb-test', __configScope: { type: 'config', uuid: '3f0c1d1e-1111-4222-8333-444455556666', tier: 'full' } };
  const ids = (m) => m.catalogs.map((c) => c.id);
  const used = ['torbox-movies-added', 'torbox-series-added', 'torbox-movies-top', 'torbox-series-top', 'torbox-movies-short', 'torbox-movies-long',
    'torbox-movies-family', 'torbox-series-family', 'torbox-movies-world', 'torbox-series-world', 'torbox-movies-decades', 'torbox-series-decades'];
  const refs = { integration: 'nuvio', qualityRefs: used };
  assert.ok(!ids(getConfiguredManifest('http://localhost:7860', CONFIG, refs)).some((id) => used.includes(id)), 'no database: never declared');
  const original = engine.isIndexed;
  engine.isIndexed = () => true;
  try {
    const unused = ids(getConfiguredManifest('http://localhost:7860', CONFIG, { integration: 'nuvio' }));
    assert.ok(!unused.some((id) => /-(added|top|short|long|family|world|decades)$/.test(id)), 'unused: not declared');
    const manifest = getConfiguredManifest('http://localhost:7860', CONFIG, refs);
    const byId = Object.fromEntries(manifest.catalogs.map((c) => [c.id, c]));
    for (const id of used) assert.ok(byId[id], id);
    assert.equal(byId['torbox-movies-short'].name, '🎬 Short & Sweet');
    assert.equal(byId['torbox-movies-long'].name, '🎬 Long Watch');
    assert.equal(byId['torbox-series-top'].name, '📺 Top Rated Shows');
    assert.equal(byId['torbox-movies-added'].showInHome, false, 'a folder-only row stays off Home');
    assert.ok(!byId['torbox-series-short'], 'no series runtime shelf');
    const world = byId['torbox-movies-world'];
    assert.equal(world.name, 'Movies');
    assert.equal(world.extra[0].name, 'genre');
    assert.ok(world.extra[0].options.includes('Korean'));
    assert.deepEqual(byId['torbox-series-decades'].extra[0].options, shelves.DECADES);
    const home = getConfiguredManifest('http://localhost:7860', CONFIG, { integration: 'nuvio', homeRows: [{ enabled: true, source: { id: 'torbox-movies-family', catalogId: 'torbox-movies-family', type: 'movie' } }] });
    assert.equal(home.catalogs.find((c) => c.id === 'torbox-movies-family').showInHome, undefined, 'a picked row is on Home');
  } finally {
    engine.isIndexed = original;
  }
});

// The engine's read path with every dependency stubbed.
function stubEngine({ rows, ids = new Map(), adult = [], excluded = [] }) {
  const store = require('../src/library/store.ts');
  const catalog = require('../src/library/catalog.ts');
  const cache = require('../src/runtime/cache.ts');
  const saved = {
    catalogRows: store.catalogRows, buildFromRows: catalog.buildFromRows, get: cache.get, set: cache.set,
    shelfIds: shelves.shelfIds, adultTmdbIds: genres.adultTmdbIds, idsMatchingRules: genres.idsMatchingRules,
  };
  const seen = { keys: [], built: [], asked: [] };
  store.catalogRows = async () => rows;
  catalog.buildFromRows = async (input, opts) => { seen.built.push({ ids: input.map((r) => r.tmdb_id), rank: opts.rank }); return []; };
  cache.get = async (key) => { seen.keys.push(key); return null; };
  cache.set = async () => true;
  shelves.shelfIds = async (kind, variant) => { seen.asked.push(`${kind}:${variant}`); return ids; };
  genres.adultTmdbIds = async () => new Set(adult);
  genres.idsMatchingRules = async () => new Set(excluded);
  const restore = () => {
    store.catalogRows = saved.catalogRows; catalog.buildFromRows = saved.buildFromRows; cache.get = saved.get; cache.set = saved.set;
    shelves.shelfIds = saved.shelfIds; genres.adultTmdbIds = saved.adultTmdbIds; genres.idsMatchingRules = saved.idsMatchingRules;
  };
  return { seen, restore };
}

const config = (extra = {}) => ({ provider: 'torbox', torboxApiKey: 'tb-hub-shelves-test', ...extra });

test('engine: content filters apply before a shelf, titles without facts are left out', async () => {
  const engine = require('../src/library/engine.ts');
  const rows = [
    { tmdb_id: 1, match_meta: {} },
    { tmdb_id: 2, match_meta: {} },
    { tmdb_id: 3, match_meta: { isJapaneseAnimation: true } },
    { tmdb_id: 4, match_meta: {} },
    { tmdb_id: 5, match_meta: {} },
  ];
  const { seen, restore } = stubEngine({ rows, ids: new Map([[1, 0], [2, 0], [3, 0], [4, 0]]), adult: [4], excluded: [2] });
  try {
    await engine.buildCatalog({ token: 't', type: 'movie', variant: 'family', config: config({ hideAnime: true, hideAdultContent: true, excludeCategories: ['horror'] }) });
    assert.deepEqual(seen.built[0].ids, [1], '3 anime, 4 adult, 2 excluded, 5 has no rating');
    assert.equal(seen.built[0].rank, null, 'the setup sort applies');
    await engine.buildCatalog({ token: 't', type: 'series', variant: 'w-ko', config: config() });
    assert.deepEqual(seen.asked, ['movies:family', 'series:w-ko']);
  } finally { restore(); }
});

test('engine: every shelf has its own page cache key; Recently Added moves daily', async () => {
  const engine = require('../src/library/engine.ts');
  const { seen, restore } = stubEngine({ rows: [{ tmdb_id: 1, match_meta: {}, source_created_at: new Date().toISOString() }] });
  try {
    for (const variant of [null, '4k', 'added', 'top', 'short', 'long', 'family', 'w-ko', 'w-fr', 'd-1990s']) {
      await engine.buildCatalog({ token: 't', config: config(), type: 'movie', variant });
    }
    assert.equal(new Set(seen.keys).size, 10);
    assert.match(shelves.shelfKey('added', NOW), /^2026-11-07@\d+$/);
    assert.notEqual(shelves.shelfKey('added', NOW), shelves.shelfKey('added', new Date(NOW.getTime() + DAY)));
    assert.equal(shelves.shelfKey('top', NOW), shelves.shelfKey('top', new Date(NOW.getTime() + DAY)), 'Top Rated only moves with the fill');
    // Recently Added ranks by added time, newest first.
    assert.ok(seen.built[2].rank instanceof Map && seen.built[2].rank.has(1));
  } finally { restore(); }
});

test('Top Rated sorts best first whatever the setup sorts by', () => {
  const { sortMetas } = require('../src/library/catalog.ts');
  const metas = [{ tmdbId: 1, name: 'B' }, { tmdbId: 2, name: 'A' }, { tmdbId: 3, name: 'C' }];
  sortMetas(metas, 'titulo', new Map([[1, 7.1e9], [2, 8.5e9], [3, 7.1e9]]));
  assert.deepEqual(metas.map((m) => m.tmdbId), [2, 1, 3]);
});

test('migrations: additive and safe to run twice', () => {
  const { MIGRATIONS } = require('../src/library/db.ts');
  const shelfColumns = MIGRATIONS.filter((sql) => /lib_tmdb_genres ADD COLUMN/.test(sql) && /(vote_average|vote_count|runtime|certification_gb|facts_v)\b/.test(sql));
  assert.equal(shelfColumns.length, 5);
  for (const sql of shelfColumns) assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
  assert.equal(new Set(MIGRATIONS).size, MIGRATIONS.length, 'no statement twice');
});

test('preview: shelf rows are library rows', () => {
  const { classifyDraftCatalog } = require('../src/setup/preview.ts');
  for (const id of ['torbox-movies-added', 'rd-series-top', 'torbox-movies-short', 'torbox-movies-long', 'pm-series-family', 'torbox-movies-world', 'torbox-series-decades']) {
    assert.equal(classifyDraftCatalog('movie', id).kind, 'library', id);
  }
});

test('the six shelf art sets ship and are Hub art, not retired community art', () => {
  const { retiredArtworkTarget } = require('../src/catalog/curated-collections.ts');
  const sources = fs.readFileSync(path.join(ROOT, 'frontend', 'public', 'collection-assets', 'ASSET_SOURCES.md'), 'utf8');
  for (const name of ['added', 'top', 'decades', 'world', 'family', 'length']) {
    for (const file of [`covers/lelibrary-hub-${name}-v3.jpg`, `gifs/lelibrary-hub-${name}-focus-v3.gif`]) {
      const full = path.join(ROOT, 'frontend', 'public', 'collection-assets', 'collections', file);
      assert.ok(fs.statSync(full).size > 10_000, `${file} exists`);
      assert.equal(retiredArtworkTarget(`/collection-assets/collections/${file}`), '', `${file} is current Hub art (HUB_ART)`);
    }
    assert.match(sources, new RegExp(`lelibrary-hub-${name}-v3`));
  }
});

export interface LibraryHubShelvesTestModule {};
