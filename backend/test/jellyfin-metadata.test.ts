// @ts-nocheck
'use strict';
// The metadata document the Jellyfin plugin reads: per title, with the
// episodes nested under their show. A pure function over the rows the library
// already holds: no database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMetadata } = require('../src/jellyfin/metadata.ts');

const movieRow = {
  entity_key: 'movie:603', media_type: 'movie', tmdb_id: 603, imdb_id: 'tt0133093',
  title: 'The Matrix', year: 1999, poster: 'https://image.tmdb.org/t/p/w500/p.jpg',
  logo: null, genres: ['Action'], metadata: {},
  genre_ids: [28, 878], overview: 'A computer hacker learns ...', runtime: 136,
  vote_average: 8.2, vote_count: 24000, certification: 'R',
  release_date: '1999-03-30', backdrop_path: '/b.jpg',
  season: null, episode: null, episode_title: null, episode_overview: null,
  episode_runtime: null, air_date: null, image: null,
};

test('a title carries its overview, runtime, genres and rating', () => {
  const { document } = buildMetadata({ rows: [movieRow], now: 1_700_000_000_000 });
  const movie = document.titles['movie:603'];
  assert.equal(movie.overview, 'A computer hacker learns ...');
  assert.equal(movie.runtime, 136);
  assert.deepEqual(movie.genres, ['Action', 'Science Fiction']);
  assert.equal(movie.rating, 8.2);
  assert.equal(movie.voteCount, 24000);
  assert.equal(movie.certification, 'R');
  assert.equal(movie.releaseDate, '1999-03-30');
  assert.equal(movie.poster, 'https://image.tmdb.org/t/p/w500/p.jpg');
  assert.equal(movie.backdrop, 'https://image.tmdb.org/t/p/w1280/b.jpg');
  assert.equal(document.schemaVersion, 1);
  assert.equal(typeof document.generatedAt, 'string');
});

test('a title with no tmdb id is keyed by the id it has', () => {
  const { document } = buildMetadata({
    rows: [{ ...movieRow, tmdb_id: null, imdb_id: 'tt0133093', overview: null, runtime: null }],
    now: 0,
  });
  assert.ok(document.titles['movie:tt0133093']);
});

test('a film and a show sharing a tmdb id do not collide', () => {
  const { document } = buildMetadata({
    rows: [movieRow, { ...movieRow, entity_key: 'series:603', media_type: 'series' }],
    now: 0,
  });
  assert.ok(document.titles['movie:603']);
  assert.ok(document.titles['tv:603']);
});

test('a field the library does not have is omitted, not null', () => {
  const { document } = buildMetadata({
    rows: [{ ...movieRow, overview: null, runtime: null, genre_ids: [], vote_average: null }],
    now: 0,
  });
  const movie = document.titles['movie:603'];
  assert.equal('overview' in movie, false);
  assert.equal('runtime' in movie, false);
  assert.equal('rating' in movie, false);
});

test('an episode is keyed by its season and number under its show', () => {
  const { document } = buildMetadata({
    rows: [{
      ...movieRow, entity_key: 'series:63639', media_type: 'series', tmdb_id: 63639,
      season: 1, episode: 3, episode_title: 'Remember the Cant', episode_runtime: 45,
      air_date: '2015-11-20', episode_overview: '...', image: 'https://artworks.thetvdb.com/e.jpg',
    }],
    now: 0,
  });
  const episode = document.titles['tv:63639'].episodes['1:3'];
  assert.equal(episode.title, 'Remember the Cant');
  assert.equal(episode.runtime, 45);
  assert.equal(episode.airDate, '2015-11-20');
  assert.equal(episode.still, 'https://artworks.thetvdb.com/e.jpg');
});

test('an episode with no title and no overview is left out', () => {
  const { document } = buildMetadata({
    rows: [{
      ...movieRow, entity_key: 'series:63639', media_type: 'series', tmdb_id: 63639,
      season: 1, episode: 3, episode_title: null, episode_overview: null,
    }],
    now: 0,
  });
  // An empty episode map is left out, like every other field the library
  // does not have.
  assert.equal('episodes' in document.titles['tv:63639'], false);
});

test('an anime and a series with the same tmdb id are one show', () => {
  const { document } = buildMetadata({
    rows: [
      { ...movieRow, entity_key: 'series:86831', media_type: 'series', tmdb_id: 86831 },
      { ...movieRow, entity_key: 'anime:86831', media_type: 'anime', tmdb_id: 86831 },
    ],
    now: 0,
  });
  assert.ok(document.titles['tv:86831']);
  assert.equal(Object.keys(document.titles).filter((key) => key.startsWith('anime:')).length, 0);
});

test('a title with no usable id is skipped and counted', () => {
  const { document, skipped } = buildMetadata({
    rows: [{ ...movieRow, tmdb_id: null, imdb_id: null, tvdb_id: null }],
    now: 0,
  });
  assert.equal(Object.keys(document.titles).length, 0);
  assert.equal(skipped, 1);
});
