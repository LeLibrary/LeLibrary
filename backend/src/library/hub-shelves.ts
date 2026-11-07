'use strict';
// The Hub's library shelves (v6): My Movies / My Shows narrowed by a fact
// about each title, same item ids, so watch progress is shared.
//
//   added    `{prefix}-{movies,series}-added`  first added to the library in
//            the last 30 days (films: their first copy; shows: their latest
//            added episode or pack), newest first
//   top      `{prefix}-{movies,series}-top`    TMDB vote average, best first,
//            only with enough votes (films 500+, shows 200+), at most 100
//   short    `{prefix}-movies-short`           films under 100 minutes
//   long     `{prefix}-movies-long`            films over 150 minutes
//   family   `{prefix}-{movies,series}-family` rated for everyone: films
//            G / PG (US), else U / PG (UK); shows TV-Y, TV-Y7, TV-G, TV-PG
//            (US), else U / PG (UK). Unrated titles are left out
//   world    `{prefix}-{movies,series}-world`  + a language in the genre extra
//            (the Hub's World Cinema folder, one tab per language)
//   decades  `{prefix}-{movies,series}-decades` + a decade in the genre extra
//            (the Hub's By Decade folder, one tab per decade)
//
// Facts come from the same background TMDB read as "Your genres"
// (library/genres.ts, table lib_tmdb_genres), the added time from the
// library's own rows (provider created time, else when LeLibrary first saw
// the file). A title without the fact (not matched, not read yet, TMDB has
// none) is left out: never guessed. Database-backed libraries only.

const store = require('./store.ts');

type Kind = 'movies' | 'series';
type Shelf = 'added' | 'top' | 'short' | 'long' | 'family';
type Row = { tmdb_id?: unknown; source_created_at?: unknown; first_seen_at?: unknown; [key: string]: unknown };

const SHELVES: readonly Shelf[] = ['added', 'top', 'short', 'long', 'family'];
// Shelves with films only (a show has no single runtime).
const MOVIES_ONLY: readonly Shelf[] = ['short', 'long'];

const ADDED_DAYS = 30;
// Top Rated: a vote floor so a title rated 9.6 by twelve people does not top
// the shelf. Shows gather far fewer votes on TMDB than films, hence the lower
// floor (checked 2026-11-07: TMDB's own "top rated" lists use 300 / 200).
const TOP_MIN_VOTES: Readonly<Record<Kind, number>> = { movies: 500, series: 200 };
const TOP_CAP = 100;
// Short & Sweet: under 100 minutes. Long Watch: over 150 minutes.
const SHORT_MAX_MINUTES = 100;
const LONG_MIN_MINUTES = 150;
// Family Friendly certifications. The US rating decides when TMDB has one
// (a PG-13 film is not family friendly because the UK rated it PG); the UK
// rating is read only when there is no US one.
const FAMILY_CERTS: Readonly<Record<Kind, { US: readonly string[]; GB: readonly string[] }>> = {
  movies: { US: ['G', 'PG'], GB: ['U', 'PG'] },
  series: { US: ['TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG'], GB: ['U', 'PG'] },
};

// World Cinema: one tab per original language (TMDB ISO 639-1 codes; `cn` is
// TMDB's code for Cantonese), named in English. English and "no language"
// (xx) are not world cinema. Tab names are what the folder sends in the genre
// extra, so a name must map back to one code.
const WORLD_LANGS: readonly string[] = [
  'ko', 'ja', 'fr', 'es', 'hi', 'it', 'de', 'zh', 'cn', 'pt', 'ru', 'sv', 'da', 'no', 'fi', 'is',
  'nl', 'pl', 'tr', 'th', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'ur', 'id', 'ms', 'tl', 'vi',
  'ar', 'fa', 'he', 'el', 'cs', 'sk', 'hu', 'ro', 'bg', 'uk', 'sr', 'hr', 'sl', 'bs', 'lt', 'lv',
  'et', 'ca', 'eu', 'gl', 'ga', 'cy', 'af', 'sw', 'yo', 'zu', 'am', 'km', 'lo', 'my', 'ka', 'hy',
  'az', 'kk', 'uz', 'mn', 'ne', 'si', 'ku', 'ps', 'mk', 'sq', 'be', 'lb', 'mt', 'xh', 'wo', 'ig',
];
// TMDB uses `nb` for some Norwegian titles: one Norwegian tab.
const LANG_ALIASES: Readonly<Record<string, string>> = { nb: 'no' };
const LANG_NAMES: Readonly<Record<string, string>> = { cn: 'Cantonese', no: 'Norwegian', zh: 'Chinese' };

let displayNames: { of: (code: string) => string | undefined } | null = null;
function languageName(code: unknown): string | null {
  const raw = String(code || '').trim().toLowerCase();
  const canonical = LANG_ALIASES[raw] || raw;
  if (!WORLD_LANGS.includes(canonical)) return null;
  if (LANG_NAMES[canonical]) return LANG_NAMES[canonical];
  try {
    displayNames = displayNames || new Intl.DisplayNames(['en-US'], { type: 'language' });
    const name = displayNames.of(canonical);
    return name && name.toLowerCase() !== canonical ? name : null;
  } catch {
    return null;
  }
}

// Every code a language tab reads (its own plus aliases).
function languageCodes(code: string): string[] {
  return [code, ...Object.keys(LANG_ALIASES).filter((alias) => LANG_ALIASES[alias] === code)];
}

function languageByName(name: unknown): string | null {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return WORLD_LANGS.find((code) => (languageName(code) || '').toLowerCase() === wanted) || null;
}

function worldLanguageNames(): string[] {
  return WORLD_LANGS.map(languageName).filter((name): name is string => !!name);
}

// By Decade: newest first. Everything before 1970 shares one tab.
const DECADES: readonly string[] = ['2020s', '2010s', '2000s', '1990s', '1980s', '1970s', 'Before 1970'];
const OLDEST_DECADE = 1970;

// The decade a release date (YYYY-MM-DD, or a Date) belongs to; null for no
// date or a date after `today` (not out yet).
function decadeOf(value: unknown, now: Date = new Date()): string | null {
  const iso = value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  if (!iso || iso > now.toISOString().slice(0, 10)) return null;
  const year = Number(iso.slice(0, 4));
  if (!year) return null;
  if (year < OLDEST_DECADE) return 'Before 1970';
  const decade = `${Math.floor(year / 10) * 10}s`;
  return DECADES.includes(decade) ? decade : null;
}

function decadeSlug(decade: string): string {
  return decade === 'Before 1970' ? 'pre1970' : decade;
}

function decadeBySlug(slug: string): string | null {
  return DECADES.find((decade) => decadeSlug(decade) === slug) || null;
}

// The folder catalogues (`-world`, `-decades`) carry the tab in the genre
// extra; the engine reads `w-<code>` / `d-<slug>`.
function tabVariant(variant: unknown, genre: unknown): string | null {
  if (variant === 'world') {
    const code = languageByName(genre);
    return code ? `w-${code}` : null;
  }
  if (variant === 'decades') {
    const wanted = String(genre || '').trim().toLowerCase();
    const decade = DECADES.find((entry) => entry.toLowerCase() === wanted);
    return decade ? `d-${decadeSlug(decade)}` : null;
  }
  return null;
}

function isShelfVariant(variant: unknown): boolean {
  return typeof variant === 'string' && (SHELVES.includes(variant as Shelf) || /^w-[a-z]{2,3}$/.test(variant) || /^d-[a-z0-9]+$/.test(variant));
}

// ── The rules, pure ──────────────────────────────────────────────────────

function toMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// When a row joined the library: the provider's own created time, else when
// LeLibrary first saw it.
function addedAt(row: Row): number | null {
  return toMs(row?.source_created_at) ?? toMs(row?.first_seen_at);
}

// TMDB id -> ISO time for titles added in the last 30 days (never in the
// future). Films count by their first copy, shows by their latest file.
function recentlyAdded(kind: Kind, rows: readonly Row[], now: Date = new Date()): Map<number, string> {
  const per = new Map<number, number>();
  for (const row of rows || []) {
    const id = Number(row?.tmdb_id);
    const at = addedAt(row);
    if (!Number.isInteger(id) || id <= 0 || at === null) continue;
    const seen = per.get(id);
    if (seen === undefined) per.set(id, at);
    else per.set(id, kind === 'movies' ? Math.min(seen, at) : Math.max(seen, at));
  }
  const to = now.getTime();
  const from = to - ADDED_DAYS * 24 * 60 * 60 * 1000;
  const out = new Map<number, string>();
  for (const [id, at] of per) if (at >= from && at <= to) out.set(id, new Date(at).toISOString());
  return out;
}

type Facts = {
  vote_average?: unknown; vote_count?: unknown; runtime?: unknown;
  certification?: unknown; certification_gb?: unknown;
};

function isTopRated(kind: Kind, facts: Facts | null | undefined): boolean {
  const votes = Number(facts?.vote_count);
  const average = Number(facts?.vote_average);
  return Number.isFinite(votes) && votes >= TOP_MIN_VOTES[kind] && Number.isFinite(average) && average > 0;
}

function isShort(facts: Facts | null | undefined): boolean {
  const minutes = Number(facts?.runtime);
  return Number.isInteger(minutes) && minutes > 0 && minutes < SHORT_MAX_MINUTES;
}

function isLong(facts: Facts | null | undefined): boolean {
  const minutes = Number(facts?.runtime);
  return Number.isInteger(minutes) && minutes > LONG_MIN_MINUTES;
}

function isFamily(kind: Kind, facts: Facts | null | undefined): boolean {
  const us = String(facts?.certification || '').trim().toUpperCase();
  if (us) return FAMILY_CERTS[kind].US.includes(us);
  const gb = String(facts?.certification_gb || '').trim().toUpperCase();
  return !!gb && FAMILY_CERTS[kind].GB.includes(gb);
}

// ── Database reads (the facts are shared by every library) ───────────────

const idCache = new Map<string, { at: number; ids: Map<number, number> }>();
const TTL_MS = 5 * 60 * 1000;

// TMDB id -> score for one shelf or tab. Cached briefly, keyed on the fill's
// version so a page cached during the first fill is rebuilt.
async function shelfIds(kind: Kind, variant: string): Promise<Map<number, number>> {
  const version = require('./genres.ts').genreVersion();
  const key = `${kind}:${variant}:${version}`;
  const hit = idCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  const mediaType = kind === 'movies' ? 'movie' : 'tv';
  const params: unknown[] = [mediaType];
  const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
  let where = '';
  let score = '0';
  if (variant === 'top') {
    where = `vote_count >= ${add(TOP_MIN_VOTES[kind])} AND vote_average > 0`;
    // Best average first, more votes breaking a tie.
    score = '(round(vote_average::numeric, 3) * 1000000000 + least(vote_count, 999999))::float8';
  } else if (variant === 'short') {
    where = `runtime > 0 AND runtime < ${add(SHORT_MAX_MINUTES)}`;
  } else if (variant === 'long') {
    where = `runtime > ${add(LONG_MIN_MINUTES)}`;
  } else if (variant === 'family') {
    const certs = FAMILY_CERTS[kind];
    where = `(CASE WHEN coalesce(btrim(certification), '') <> '' THEN upper(btrim(certification)) = ANY(${add([...certs.US])}::text[])
                   ELSE upper(btrim(coalesce(certification_gb, ''))) = ANY(${add([...certs.GB])}::text[]) END)`;
  } else if (variant.startsWith('w-')) {
    where = `orig_lang = ANY(${add(languageCodes(variant.slice(2)))}::text[])`;
  } else if (variant.startsWith('d-')) {
    const decade = decadeBySlug(variant.slice(2));
    if (!decade) return new Map();
    const today = new Date().toISOString().slice(0, 10);
    if (decade === 'Before 1970') where = `release_date < ${add(`${OLDEST_DECADE}-01-01`)}::date`;
    else {
      const start = Number(decade.slice(0, 4));
      where = `release_date >= ${add(`${start}-01-01`)}::date AND release_date < ${add(`${start + 10}-01-01`)}::date AND release_date <= ${add(today)}::date`;
    }
  } else {
    return new Map();
  }
  const pool = await store.ensure();
  const { rows } = await pool.query(`SELECT tmdb_id, ${score} AS score FROM lib_tmdb_genres WHERE media_type = $1 AND ${where}`, params);
  const ids = new Map<number, number>();
  for (const row of rows as Record<string, unknown>[]) {
    const id = Number(row['tmdb_id']);
    if (Number.isInteger(id)) ids.set(id, Number(row['score']) || 0);
  }
  for (const old of idCache.keys()) if (old.startsWith(`${kind}:${variant}:`)) idCache.delete(old);
  idCache.set(key, { at: Date.now(), ids });
  return ids;
}

// One shelf over a library's rows (already narrowed by the content filters).
// `rank` (TMDB id -> value, higher first) overrides the setup's sort for
// Recently Added (newest first) and Top Rated (best first); the other shelves
// keep the setup's sort like the genre rows.
async function applyShelf(variant: string, kind: Kind, rows: Row[], now: Date = new Date()): Promise<{ rows: Row[]; rank: Map<number, string | number> | null }> {
  if (kind === 'series' && MOVIES_ONLY.includes(variant as Shelf)) return { rows: [], rank: null };
  if (variant === 'added') {
    const rank = recentlyAdded(kind, rows, now);
    return { rows: rows.filter((row) => rank.has(Number(row.tmdb_id))), rank };
  }
  const ids = await module.exports.shelfIds(kind, variant) as Map<number, number>;
  let kept = rows.filter((row) => ids.has(Number(row.tmdb_id)));
  if (variant !== 'top') return { rows: kept, rank: null };
  // The best 100 titles this library owns (every copy of a kept title stays).
  const best = [...new Set(kept.map((row) => Number(row.tmdb_id)))]
    .sort((a, b) => (ids.get(b) || 0) - (ids.get(a) || 0))
    .slice(0, TOP_CAP);
  const keep = new Set(best);
  kept = kept.filter((row) => keep.has(Number(row.tmdb_id)));
  return { rows: kept, rank: new Map(best.map((id) => [id, ids.get(id) || 0])) };
}

// The part of a catalogue cache key that changes when the answer can: the
// fill adds facts, and Recently Added's 30-day window moves daily.
function shelfKey(variant: string, now: Date = new Date()): string {
  const version = require('./genres.ts').genreVersion();
  return variant === 'added' ? `${now.toISOString().slice(0, 10)}@${version}` : String(version);
}

// ── Push time: the World Cinema and By Decade tabs one library gets ──────

type TabEntry = { kind: Kind; name: string; count: number };
type FactRow = {
  media_type?: unknown; genre_ids?: number[]; keyword_ids?: number[] | null; orig_lang?: string | null;
  adult?: unknown; certification?: unknown; release_day?: unknown;
};

// Pure: per kind, how many titles each language / decade has, after the
// setup's content filters (a hidden title never counts toward a tab).
function tabCounts(facts: readonly FactRow[], filters: { hideAnime?: boolean; hideAdult?: boolean; excludeCategories?: string[] } | null, now: Date = new Date()): { world: TabEntry[]; decades: TabEntry[] } {
  const contentFilters = require('../catalog/content-filters.ts');
  const state = { hideAnime: !!filters?.hideAnime, hideAdult: !!filters?.hideAdult, excludeCategories: Array.isArray(filters?.excludeCategories) ? filters!.excludeCategories! : [] };
  const world = new Map<string, TabEntry>();
  const decades = new Map<string, TabEntry>();
  const bump = (map: Map<string, TabEntry>, kind: Kind, name: string) => {
    const key = `${kind}:${name}`;
    const entry = map.get(key);
    if (entry) entry.count++;
    else map.set(key, { kind, name, count: 1 });
  };
  for (const row of facts || []) {
    const kind: Kind = row?.media_type === 'movie' ? 'movies' : 'series';
    if (contentFilters.factsExcluded(row, state, kind)) continue;
    if (state.hideAdult) {
      const cert = String(row?.certification || '').toUpperCase();
      if (row?.adult === true || (cert && contentFilters.ADULT_CERTIFICATIONS[kind === 'movies' ? 'movie' : 'tv'].includes(cert))) continue;
    }
    const lang = String(row?.orig_lang || '');
    const name = lang && lang !== 'en' ? languageName(lang) : null;
    if (name) bump(world, kind, name);
    const decade = decadeOf(row?.release_day, now);
    if (decade) bump(decades, kind, decade);
  }
  const order = (entry: TabEntry) => DECADES.indexOf(entry.name) * 2 + (entry.kind === 'movies' ? 0 : 1);
  return {
    // Most owned first (like Genres), films before shows on a tie.
    world: [...world.values()].sort((a, b) => b.count - a.count || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'movies' ? -1 : 1)),
    // Newest decade first, films then shows.
    decades: [...decades.values()].sort((a, b) => order(a) - order(b)),
  };
}

async function ownedTabCounts(scopeId: string, filters: { hideAnime?: boolean; hideAdult?: boolean; excludeCategories?: string[] } | null): Promise<{ world: TabEntry[]; decades: TabEntry[] }> {
  const pool = await store.ensure();
  // My Movies and My Shows only (anime has its own row).
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (g.media_type, g.tmdb_id) g.media_type, g.genre_ids, g.keyword_ids, g.orig_lang, g.adult,
            g.certification, to_char(g.release_date, 'YYYY-MM-DD') AS release_day
       FROM lib_items i
       JOIN lib_tmdb_genres g
         ON g.media_type = CASE WHEN i.media_type = 'movie' THEN 'movie' ELSE 'tv' END AND g.tmdb_id = i.tmdb_id
      WHERE i.scope_id = $1 AND i.removed_at IS NULL AND i.match_status = 'matched' AND i.media_type IN ('movie', 'series')`,
    [scopeId]
  );
  return tabCounts(rows as FactRow[], filters);
}

export interface HubShelvesApi {
  SHELVES: readonly Shelf[];
  ADDED_DAYS: number;
  TOP_MIN_VOTES: Readonly<Record<Kind, number>>;
  TOP_CAP: number;
  SHORT_MAX_MINUTES: number;
  LONG_MIN_MINUTES: number;
  FAMILY_CERTS: Readonly<Record<Kind, { US: readonly string[]; GB: readonly string[] }>>;
  DECADES: readonly string[];
  languageName: typeof languageName;
  languageByName: typeof languageByName;
  worldLanguageNames: typeof worldLanguageNames;
  decadeOf: typeof decadeOf;
  tabVariant: typeof tabVariant;
  isShelfVariant: typeof isShelfVariant;
  recentlyAdded: typeof recentlyAdded;
  isTopRated: typeof isTopRated;
  isShort: typeof isShort;
  isLong: typeof isLong;
  isFamily: typeof isFamily;
  shelfIds: typeof shelfIds;
  applyShelf: typeof applyShelf;
  shelfKey: typeof shelfKey;
  tabCounts: typeof tabCounts;
  ownedTabCounts: typeof ownedTabCounts;
}

module.exports = {
  SHELVES, ADDED_DAYS, TOP_MIN_VOTES, TOP_CAP, SHORT_MAX_MINUTES, LONG_MIN_MINUTES, FAMILY_CERTS, DECADES,
  languageName, languageByName, worldLanguageNames, decadeOf, tabVariant, isShelfVariant,
  recentlyAdded, isTopRated, isShort, isLong, isFamily, shelfIds, applyShelf, shelfKey, tabCounts, ownedTabCounts,
} satisfies HubShelvesApi;
