// @ts-nocheck
'use strict';
// The facts the TMDB detail reply already carries and the library threw away:
// a title's overview and backdrop, and an episode's still. Pure functions, no
// database and no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const genres = require('../src/library/genres.ts');
const providers = require('../src/library/identity/providers.ts');

test('the facts fill keeps the overview and the backdrop', async () => {
  const reply = {
    data: {
      overview: 'A hacker learns the truth.',
      backdrop_path: '/backdrop.jpg',
      genres: [{ id: 28, name: 'Action' }],
      vote_average: 8.2, vote_count: 24000, runtime: 136,
      release_date: '1999-03-30', adult: false, original_language: 'en',
    },
  };
  const facts = await genres.fetchFacts('key', 'movie', 603, async () => reply);
  assert.equal(facts.overview, 'A hacker learns the truth.');
  assert.equal(facts.backdropPath, '/backdrop.jpg');
});

test('a title with no overview has none, rather than an empty string', async () => {
  const facts = await genres.fetchFacts('key', 'movie', 603, async () => ({ data: { genres: [] } }));
  assert.equal(facts.overview, null);
  assert.equal(facts.backdropPath, null);
});

test('a TVDB episode keeps its image', () => {
  const episode = providers.tvdbEpisodeRecord({
    id: 1, seasonNumber: 1, number: 2, name: 'The Reckoning',
    image: 'https://artworks.thetvdb.com/banners/episodes/1.jpg',
  });
  assert.equal(episode.image, 'https://artworks.thetvdb.com/banners/episodes/1.jpg');
  assert.equal(episode.title, 'The Reckoning');
  assert.equal(episode.season, 1);
  assert.equal(episode.episode, 2);
});

test('a TVDB episode without an image has none', () => {
  const episode = providers.tvdbEpisodeRecord({ id: 1, seasonNumber: 1, number: 2, name: 'The Reckoning' });
  assert.equal(episode.image, null);
});

test('a Kitsu episode keeps its thumbnail', () => {
  const episode = providers.kitsuEpisodeRecord({
    attributes: {
      number: 3, relativeNumber: 3, seasonNumber: 1, canonicalTitle: 'The Third',
      thumbnail: 'https://media.kitsu.tv/episodes/3.jpg',
    },
  });
  assert.equal(episode.image, 'https://media.kitsu.tv/episodes/3.jpg');
  assert.equal(episode.canonicalTitle, 'The Third');
});

test('a Kitsu episode without a thumbnail has none', () => {
  const episode = providers.kitsuEpisodeRecord({
    attributes: { number: 3, relativeNumber: 3, seasonNumber: 1, canonicalTitle: 'The Third' },
  });
  assert.equal(episode.image, null);
});
