// @ts-nocheck
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchEpisodeTitle } = require('../src/matching/episode-title.ts');
const { resolveMatch } = require('../src/matching/resolve.ts');
const tmdb = require('../src/media/tmdb.ts');
const parser = require('../src/media/parser.ts');

const videos = [
  { season: 15, episode: 3, name: 'A Marvellous Journey Begins' },
  { season: 16, episode: 3, name: 'A Completely Different Adventure' },
  { season: 19, episode: 4, name: 'A Beautiful and Exciting Day' },
];
const main = { id: 60572, name: 'Pokémon', isJapaneseAnimation: true };
const wrong = { id: 341532, name: 'Pokemon sol y luna', isJapaneseAnimation: false };
function deps(catalog = async () => videos) {
  return {
    parse: parser.guessMediaInfo,
    search: async () => [wrong, main],
    pick: (q, c, y) => tmdb.pickBestResult(q, c, y),
    titleScore: tmdb.titleScore,
    isAnimeCandidate: c => !!c.isJapaneseAnimation,
    seasonCounts: async () => [{ season: 15, count: 58 }, { season: 16, count: 93 }, { season: 19, count: 136 }, { season: 20, count: 159 }],
    findEpisode: async () => null,
    episodeCatalog: catalog,
  };
}

test('title evidence maps a Pokemon episode to its real TMDB season', async () => {
  const result = await resolveMatch({ name: 'Pokemon.S16E03.A.Marvellous.Journey.Begins.1080p.mkv', mediaType: 'series', allowEpisodeTitleMapping: true }, deps());
  assert.equal(result.ok, true);
  assert.deepEqual([result.tmdbId, result.season, result.episode, result.mediaTypeOverride], [60572, 15, 3, 'anime']);
  assert.equal(result.episodeTitleEvidence, 'A Marvellous Journey Begins');
});

test('ambiguous or generic titles never decide an episode', () => {
  assert.equal(matchEpisodeTitle('Pokemon.S16E03.A.Marvellous.Journey.Begins.mkv', [...videos, { season: 17, episode: 2, name: 'A Marvellous Journey Begins' }]), null);
  assert.equal(matchEpisodeTitle('Pokemon.S16E03.A.Big.Day.mkv', [{ season: 1, episode: 1, name: 'A Big Day' }]), null);
});

test('mapping never uses an unrelated show or guesses when metadata is absent', async () => {
  const r = await resolveMatch({ name: 'Pokemon.S20E03.1080p', mediaType: 'series', allowEpisodeTitleMapping: true }, deps(async () => []));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'search-unavailable');
});

test('episode title mapping is opt-in and handles accented titles', async () => {
  assert.equal(matchEpisodeTitle('Pokémon.S16E03.Lete.dAmelie.et.Pikachu.mkv', [{ season: 1, episode: 2, name: "L'été d'Amélie et Pikachu" }]).episode, 2);
  const r = await resolveMatch({ name: 'Pokemon.S16E03.A.Marvellous.Journey.Begins.1080p.mkv', mediaType: 'series' }, deps());
  assert.equal(r.ok, false);
});


test('missing or duplicated episode-title evidence never guesses numbered Pokemon episodes', async () => {
  const noTitle = await resolveMatch({ name: 'Pokemon.S20E03.1080p', mediaType: 'anime', allowEpisodeTitleMapping: true }, deps());
  assert.equal(noTitle.ok, false);
  assert.equal(noTitle.reason, 'ambiguous-candidate');
  const missingMain = deps(); missingMain.search = async () => [wrong];
  const wrongShow = await resolveMatch({ name: 'Pokemon.S20E03.1080p', mediaType: 'series', allowEpisodeTitleMapping: true }, missingMain);
  assert.equal(wrongShow.ok, false);
  assert.equal(wrongShow.reason, 'no-candidate');
});

test('playback chooses the title-proven file when source numbering differs', async () => {
  const { buildStreams, populateTmdbIndexFromMetas } = require('../src/catalog/builder.ts');
  const item = { id: 'synthetic-batch', source: 'torrent', name: 'Pokemon sample', files: [
    { id: 1, name: 'Pokemon.S15E03.A.Completely.Different.Adventure.mkv', size: 200 * 1024 * 1024 },
    { id: 2, name: 'Pokemon.S16E03.A.Marvellous.Journey.Begins.mkv', size: 200 * 1024 * 1024 },
  ] };
  populateTmdbIndexFromMetas([{ type: 'series', tmdbId: 60572, season: 15, episode: 3,
    episodeTitleEvidence: 'A Marvellous Journey Begins', torboxItem: item }], 'pokemon-title-evidence-test');
  const streams = await buildStreams({ provider: 'torbox', torboxApiKey: 'synthetic', streamNotices: 'off' }, '', 'series', '60572', 15, 3, 'en-US', [], 'pokemon-title-evidence-test', { lazyLinks: true });
  assert.equal(streams.length, 1);
  assert.match(streams[0].behaviorHints.filename, /Marvellous/);
});

test('playback returns no file when the proven title is absent', async () => {
  const { buildStreams, populateTmdbIndexFromMetas } = require('../src/catalog/builder.ts');
  const item = { id: 'synthetic-other', source: 'torrent', name: 'Pokemon sample', files: [
    { id: 1, name: 'Pokemon.S15E03.A.Completely.Different.Adventure.mkv', size: 200 * 1024 * 1024 },
    { id: 2, name: 'Pokemon.S15E04.Another.Unrelated.Episode.mkv', size: 200 * 1024 * 1024 },
  ] };
  populateTmdbIndexFromMetas([{ type: 'series', tmdbId: 60572, season: 15, episode: 3,
    episodeTitleEvidence: 'A Marvellous Journey Begins', torboxItem: item }], 'pokemon-title-missing-test');
  const streams = await buildStreams({ provider: 'torbox', torboxApiKey: 'synthetic', streamNotices: 'off' }, '', 'series', '60572', 15, 3, 'en-US', [], 'pokemon-title-missing-test', { lazyLinks: true });
  assert.equal(streams.length, 0);
});

test('historical Pokemon review selects only affected rows and runs once', { skip: !process.env.LIBRARY_TEST_DATABASE_URL }, async () => {
  const { Client } = require('pg');
  const { MIGRATIONS } = require('../src/library/db.ts');
  const client = new Client({ connectionString: process.env.LIBRARY_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE lib_data_migrations (name text primary key)');
    await client.query('CREATE TEMP TABLE lib_items (name text, removed_at timestamptz, match_status text, match_error text, match_version text, tmdb_id integer)');
    await client.query("INSERT INTO lib_items VALUES ('Pokemon S16',NULL,'failed','anime-excluded:60572','old',NULL),('Pokémon S20',NULL,'matched',NULL,'old',341532),('Pokemon S21',NULL,'matched',NULL,'old',60572),('Other',NULL,'failed','anime-excluded:60572','old',NULL)");
    const migration = MIGRATIONS.find(sql => sql.includes("VALUES ('pokemon-title-review-1')"));
    assert.ok(migration);
    await client.query(migration);
    let result = await client.query("SELECT count(*)::int AS n FROM lib_items WHERE match_version='pokemon-title-review-1'");
    assert.equal(result.rows[0].n, 2);
    await client.query("UPDATE lib_items SET match_version='processed' WHERE match_version='pokemon-title-review-1'");
    await client.query(migration);
    result = await client.query("SELECT count(*)::int AS n FROM lib_items WHERE match_version='pokemon-title-review-1'");
    assert.equal(result.rows[0].n, 0);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
