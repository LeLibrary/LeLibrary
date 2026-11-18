// @ts-nocheck
// Regressions for the failures found in the operator's dev library:
//  - three-digit episode numbers were truncated to two (`S19E049` -> ep 4)
//  - Pokemon rows with no episode title could never reach the exact-title
//    resolver, so every RESTORE/RETRY/whole-season pack failed
//  - anthology season redirects needed the exact subtitle to fire
//  - a making-of special named `S00E01` could never pass season validation
// Pure tests: no DB, no network, no keys.
const test = require('node:test');
const assert = require('node:assert');

const parser = require('../src/media/parser.ts');
const resolve = require('../src/matching/resolve.ts');
const tmdb = require('../src/media/tmdb.ts');

function deps({ candidates = [], counts = {}, animeIds = [] } = {}) {
  return {
    parse: (name) => parser.guessMediaInfo(name),
    search: async () => candidates,
    pick: (_q, cands) => (cands && cands.length ? cands[0] : null),
    seasonCounts: async (id) => (String(id) in counts ? counts[String(id)] : null),
    titleScore: (query, cand) => tmdb.titleScore(query, cand),
    isAnimeCandidate: (cand) => animeIds.map(String).includes(String(cand && cand.id)),
    findEpisode: async () => null,
    // Empty on purpose: the public episode list is capped and does not cover
    // every Pokemon season. Exact-title evidence must still work without it.
    episodeCatalog: async () => [],
  };
}

test('three-digit episode markers keep all their digits', () => {
  assert.equal(parser.guessMediaInfo('Pokemon.S19E049.RESTORE').episode, 49);
  assert.equal(parser.guessMediaInfo('Pokemon.S20E124.Storming.Explorers.Headquarters').episode, 124);
  assert.equal(parser.guessMediaInfo('Monster.2022.S04E04.Abby.Borden.WEB-DL').episode, 4);
});

test('a RESTORE row with no episode title matches its exact series and source number', async () => {
  const candidates = [
    { id: 60572, title: 'Pokémon', first_air_date: '1997-04-01', vote_count: 5000 },
    { id: 341532, title: 'Pokemon sol y luna', vote_count: 10 },
  ];
  const out = await resolve.resolveMatch({ name: 'Pokemon.S17E21.RESTORE', mediaType: 'series',
    allowEpisodeTitleMapping: true }, deps({ candidates, counts: { 60572: [{ season: 17, count: 47 }] },
    animeIds: [60572, 341532] }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 60572);
  assert.equal(out.season, 17);
  assert.equal(out.episode, 21);
});

test('a three-digit RESTORE row resolves to the right episode, not a truncated one', async () => {
  const out = await resolve.resolveMatch({ name: 'Pokemon.S19E049.RESTORE', mediaType: 'series',
    allowEpisodeTitleMapping: true }, deps({ candidates: [{ id: 60572, title: 'Pokémon', vote_count: 5000 }],
    counts: { 60572: [{ season: 19, count: 136 }] }, animeIds: [60572] }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 60572);
  assert.equal(out.season, 19);
  assert.equal(out.episode, 49);
});

test('source S20 Pokemon releases keep resolving to Horizons, not the Sun & Moon duplicate', async () => {
  const out = await resolve.resolveMatch({ name: 'Pokemon.S20E124.Storming.Explorers.Headquarters.1080p.AMZN.WEB-DL',
    mediaType: 'series', allowEpisodeTitleMapping: true }, deps({
    candidates: [
      { id: 60572, title: 'Pokémon', vote_count: 5000 },
      { id: 341532, title: 'Pokemon sol y luna', vote_count: 10 },
    ],
    counts: { 220150: [{ season: 1, count: 159 }], 60572: [{ season: 20, count: 100 }] },
    animeIds: [60572, 341532, 220150],
  }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 220150);
  assert.equal(out.episode, 124);
});

test('a whole-season pack whose source season is absent matches the exact series without inventing a season', async () => {
  const out = await resolve.resolveMatch({ name: 'Pokemon.Horizons.S02.1080p.NF.WEB-DL.HebDub.also.English',
    mediaType: 'series', allowEpisodeTitleMapping: true }, deps({
    candidates: [{ id: 220150, title: 'Pokémon Horizons', vote_count: 500 }],
    counts: { 220150: [{ season: 1, count: 159 }] }, animeIds: [220150],
  }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 220150);
  assert.equal(out.season, null);
  assert.equal(out.episode, null);
});

test('the Lizzie Borden anthology season redirect also accepts Abby Borden releases', async () => {
  const out = await resolve.resolveMatch({ name: 'Monster.2022.S04E04.R.I.P.Rest.in.Pestilence.Abby.Borden.2160p.NF.WEB-DL',
    mediaType: 'series' }, deps({ candidates: [
    { id: 131532, title: 'Monster High', vote_count: 50 },
    { id: 65806, title: 'Monster', vote_count: 20 },
  ], counts: { 299939: [{ season: 1, count: 8 }] } }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 299939);
  assert.equal(out.season, 1);
  assert.equal(out.episode, 4);
});

test('an S00E01 making-of special resolves to its film instead of a missing season 0', async () => {
  const out = await resolve.resolveMatch({ name: 'Percy.Jackson.and.the.Olympians.S00E01.A.Heros.Journey.The.Making.of.2160p.DSNP.WEB-DL',
    mediaType: 'series' }, deps({ candidates: [
    { id: 103540, title: 'Percy Jackson and the Olympians', vote_count: 5000 },
  ], counts: { 103540: [{ season: 1, count: 8 }] } }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tmdbId, 1224953);
  assert.equal(out.tmdbType, 'movie');
  assert.equal(out.season, null);
  assert.equal(out.episode, null);
});
