// @ts-nocheck
// Top Boy packs use the franchise-wide S04/S05 numbering, while TMDB splits
// the 2011 run (41889) from the Netflix run (93544) and numbers the Netflix
// seasons 1-3. Episode titles in the operator's packs verify S04 -> 93544 S2
// ("Good Morals", "Likkle Favour") and S05 -> 93544 S3 ("Step Back",
// "Birthday Party", "Has It Come to This"). No keys or network used here.
const test = require('node:test');
const assert = require('node:assert');

const tables = require('../src/matching/tables.ts');
const resolve = require('../src/matching/resolve.ts');
const parser = require('../src/media/parser.ts');
const tmdb = require('../src/media/tmdb.ts');

function deps() {
  const candidates = [
    { id: 41889, title: 'Top Boy', first_air_date: '2011-10-31', vote_count: 600 },
    { id: 93544, title: 'Top Boy', first_air_date: '2019-09-13', vote_count: 1800 },
  ];
  return {
    parse: (name) => parser.guessMediaInfo(name),
    search: async () => candidates,
    pick: (q, cands, year) => tmdb.pickBestResult(q, cands, year),
    titleScore: (q, cand) => tmdb.titleScore(q, cand),
    isAnimeCandidate: () => false,
    seasonCounts: async () => [
      { season: 1, count: 4 }, { season: 2, count: 4 }, { season: 3, count: 4 },
    ],
    findEpisode: async () => null,
  };
}

test('Top Boy split-season table covers both TMDB entries', () => {
  assert.deepEqual(tables.lookupSplitSeason(41889, 5), { tmdbId: 93544, season: 3 });
  assert.deepEqual(tables.lookupSplitSeason(93544, 5), { tmdbId: 93544, season: 3 });
  assert.deepEqual(tables.lookupSplitSeason(41889, 4), { tmdbId: 93544, season: 2 });
  assert.deepEqual(tables.lookupSplitSeason(93544, 4), { tmdbId: 93544, season: 2 });
  assert.equal(tables.lookupSplitSeason(41889, 3), null);
});

test('the S05 pack resolves to the 2019 Top Boy entry with its real season', async () => {
  const out = await resolve.resolveMatch({ name: 'Top Boy S05 1080P NLSubTop Boy S05 1080P NLSub', mediaType: 'series' }, deps());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 93544);
  assert.equal(out.season, 3);
});

test('the S04 pack resolves to the 2019 Top Boy entry with its real season', async () => {
  const out = await resolve.resolveMatch({ name: 'Top Boy S04 WEBRip AAC 5 1 1080p x265-SiQ', mediaType: 'series' }, deps());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 93544);
  assert.equal(out.season, 2);
});

test('inner filenames carry the episode title used to pick files when source numbers differ', () => {
  const builder = require('../src/catalog/builder.ts');
  const file = { name: 'Top Boy S05E03 Birthday Party.mkv' };
  const info = builder.episodeFileInfo(file);
  // Source says S05E03, TMDB says S03E03, but the title is identical on both.
  assert.equal(info.episode, 3);
  assert.equal(info.episodeTitle, 'Birthday Party');
  assert.equal(builder.episodeTitleMatches(info.episodeTitle, 'Birthday Party'), true);
});
