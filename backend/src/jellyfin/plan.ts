// Jellyfin plan contract: the names, paths and keys the Jellyfin plugin writes
// to disk. Pure functions only - no config, no provider, no database - so the
// plugin's side of the contract can be pinned by tests.
//
// Values follow Docs/plans/2026-11-10-jellyfin-plugin-design.md: folder per
// title, "Title (Year)" files, "Season NN" folders for episodes, and a
// provider-scoped key the plugin can rebuild from its own listing.

export interface MoviePathInput {
  title: string;
  year?: number | null;
  quality?: string | null;
  hdr?: string | null;
}

export interface EpisodePathInput {
  seriesTitle: string;
  seriesYear?: number | null;
  season: number;
  episode: number;
  episodeEnd?: number | null;
}

export interface QualityInfo {
  quality: string | null;
  hdr: string | null;
}

// Characters Windows, SMB and most NAS boxes refuse in a file name. Replaced
// rather than dropped so "Mission: Impossible" stays readable.
const UNSAFE = /[\\/:*?"<>|]/g;

// Jellyfin scans these paths on every platform, so a trailing dot (legal on
// Linux, stripped on Windows) must never reach disk.
function sanitizeName(value: unknown): string {
  const text = String(value == null ? '' : value)
    .replace(UNSAFE, '-')
    .replace(/\s+/g, ' ');
  return text.replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120).replace(/^[.\s]+|[.\s]+$/g, '');
}

function yearOf(value: unknown): number | null {
  const year = Number(value);
  return Number.isInteger(year) && year > 1900 && year < 2200 ? year : null;
}

function qualityOf(fileName: unknown): QualityInfo {
  const name = String(fileName == null ? '' : fileName);
  const quality = /2160p|4k/i.test(name)
    ? '2160p'
    : /1080p/i.test(name)
      ? '1080p'
      : /720p/i.test(name)
        ? '720p'
        : /480p/i.test(name)
          ? '480p'
          : null;
  // Dolby Vision and HDR10+ must be tested before their plain HDR substring.
  const hdr = /dolby ?vision|\bdv\b|dovi/i.test(name)
    ? 'dv'
    : /hdr10\+/i.test(name)
      ? 'hdr10+'
      : /\bhdr\b/i.test(name)
        ? 'hdr'
        : null;
  return { quality, hdr };
}

function titleFolder(title: string, year: number | null): string {
  const base = sanitizeName(title) || 'Untitled';
  return year ? `${base} (${year})` : base;
}

function moviePath({ title, year, quality, hdr }: MoviePathInput): string {
  const folder = titleFolder(title, yearOf(year));
  const suffix = quality ? ` - ${quality}${hdr ? ` ${sanitizeName(hdr).toUpperCase()}` : ''}` : '';
  return `${folder}/${folder}${suffix}.strm`;
}

function episodePath({ seriesTitle, seriesYear, season, episode, episodeEnd }: EpisodePathInput): string {
  const folder = titleFolder(seriesTitle, yearOf(seriesYear));
  const seasonNumber = Math.max(0, Math.trunc(Number(season) || 0));
  const first = Math.max(0, Math.trunc(Number(episode) || 0));
  const last = episodeEnd != null ? Math.max(0, Math.trunc(Number(episodeEnd) || 0)) : 0;
  const episodes = last > first
    ? `E${String(first).padStart(2, '0')}-E${String(last).padStart(2, '0')}`
    : `E${String(first).padStart(2, '0')}`;
  const base = sanitizeName(seriesTitle) || 'Untitled';
  const file = `${base} S${String(seasonNumber).padStart(2, '0')}${episodes}.strm`;
  return `${folder}/Season ${String(seasonNumber).padStart(2, '0')}/${file}`;
}

// provider:{itemId}:{fileId} - the plugin rebuilds the same string from its own
// provider listing, so a plan key is the only join between the two sides.
function itemKey(provider: string, itemId: unknown, fileId: unknown): string {
  return `${String(provider)}:${String(itemId)}:${String(fileId)}`;
}

// ── The plan itself ─────────────────────────────────────────────────────
// Built from the library's matched metas (library/catalog.ts assembleMetas),
// never from a fresh provider crawl. The file a key points at is chosen here
// with the same rules the stream route uses, so Jellyfin plays what Stremio
// would have played.

const builder = require('../catalog/builder.ts') as {
  episodeFileInfo: (file: any) => any;
  embeddedItemFiles: (item: any) => any[];
};
const { isVideoFile, isJunkVideo } = require('../providers/torbox.ts') as {
  isVideoFile: (name: unknown) => boolean;
  isJunkVideo: (name: unknown) => boolean;
};

export interface PlanLibrary {
  key: 'movies' | 'shows';
  name: string;
  kind: 'movies' | 'shows';
}

export interface PlanMovieItem {
  key: string;
  library: 'movies';
  kind: 'movie';
  title: string;
  year: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  quality: string | null;
  hdr: string | null;
  path: string;
  poster: string | null;
  backdrop: string | null;
}

export interface PlanEpisodeItem {
  key: string;
  library: 'shows';
  kind: 'episode';
  seriesTitle: string;
  seriesYear: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  season: number;
  episode: number;
  episodeEnd: number | null;
  episodeTitle: string | null;
  path: string;
  poster: string | null;
  still: string | null;
}

export type PlanItem = PlanMovieItem | PlanEpisodeItem;

export interface PlanCollection {
  name: string;
  items: string[];
  poster?: string | null;
}

export interface JellyfinPlan {
  schemaVersion: number;
  generatedAt: string;
  provider: string;
  libraries: PlanLibrary[];
  items: PlanItem[];
  collections: PlanCollection[];
}

export interface PlanInput {
  provider: string;
  // The setup install URL, without a trailing slash. Root-relative art is
  // resolved against it: those URLs are the read capability on their own.
  baseUrl: string;
  // Matched metas from library/catalog.ts assembleMetas.
  metas: any[];
  collections?: PlanCollection[];
  now?: number;
}

const LIBRARIES: PlanLibrary[] = [
  { key: 'movies', name: 'LeLibrary Movies', kind: 'movies' },
  { key: 'shows', name: 'LeLibrary Shows', kind: 'shows' },
];

// Art arrives as either an absolute TMDB/ERDB URL or a root-relative path on
// this server. Anything else is dropped rather than guessed.
function absolutizeArt(url: unknown, baseUrl: string): string | null {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${baseUrl.replace(/\/+$/, '')}${value}`;
  return null;
}

function fileNameOf(file: any): string {
  return String(file?.name || file?.short_name || file?.file_name || file?.filename || '');
}

function sizeOf(file: any): number {
  const size = Number(file?.size ?? file?.bytes ?? 0);
  return Number.isFinite(size) ? size : 0;
}

function compareIds(a: unknown, b: unknown): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a).localeCompare(String(b), 'en');
}

// Biggest file wins, lowest id breaks a tie: the same copy is chosen on every
// sync, so a library does not churn through renames.
function bestFile(files: any[]): any | null {
  let best: any = null;
  for (const file of files) {
    if (!best) { best = file; continue; }
    const delta = sizeOf(file) - sizeOf(best);
    if (delta > 0 || (delta === 0 && compareIds(file?.id, best?.id) < 0)) best = file;
  }
  return best;
}

// Video files of a download with sample/trailer junk removed - but only when a
// real file remains, so a legitimate short extra is not hidden on its own.
function playableFiles(item: any): any[] {
  const files = builder.embeddedItemFiles(item);
  const videos = files.filter((file) => isVideoFile(fileNameOf(file)));
  const clean = videos.filter((file) => !isJunkVideo(fileNameOf(file)));
  return clean;
}

// Which file inside a season pack holds the requested episode. Mirrors the
// stream route: a file with no episode in its name never matches, and a defined
// season must agree with the file's season - the plan never guesses.
function episodeFileFor(files: any[], season: number, episode: number, episodeEnd: number): any | null {
  const matches = files.filter((file) => {
    const info = builder.episodeFileInfo(file);
    if (!info || info.episode == null) return false;
    if (info.season == null) return false;
    if (Number(info.season) !== season) return false;
    const from = Number(info.episode);
    const to = info.episodeEnd != null ? Number(info.episodeEnd) : from;
    return episode >= from && episode <= to;
  });
  if (!matches.length) return null;
  return bestFile(matches);
}

function itemIdOf(item: any): unknown {
  return item?.id ?? item?.torrent_id ?? item?.hash ?? null;
}

function yearOrNull(value: unknown): number | null {
  const year = Number(value);
  return Number.isInteger(year) && year > 1900 && year < 2200 ? year : null;
}

function tmdbOrNull(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function textOrNull(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function buildPlan(input: PlanInput): { plan: JellyfinPlan; skipped: number } {
  const { provider, baseUrl, metas } = input;
  const now = input.now != null ? input.now : Date.now();
  let skipped = 0;
  // Path -> winner. Two copies of one title must collapse to one path, or the
  // plugin would write two files for one film and Jellyfin would show it twice.
  const byPath = new Map<string, { itemId: unknown; fileId: unknown; out: PlanItem }>();

  const keep = (path: string, itemId: unknown, fileId: unknown, out: PlanItem): void => {
    const existing = byPath.get(path);
    if (!existing) { byPath.set(path, { itemId, fileId, out }); return; }
    const itemDelta = compareIds(itemId, existing.itemId);
    if (itemDelta < 0 || (itemDelta === 0 && compareIds(fileId, existing.fileId) < 0)) {
      byPath.set(path, { itemId, fileId, out });
    }
  };

  for (const meta of Array.isArray(metas) ? metas : []) {
    if (!meta) continue;
    const entries = Array.isArray(meta.torboxItems) ? meta.torboxItems : [];
    const isMovie = meta.catalogType === 'movie' || meta.catalogType === 'movies';
    const title = textOrNull(meta.name) || 'Untitled';
    const year = yearOrNull(meta.year);
    const poster = absolutizeArt(meta.poster, baseUrl);
    const backdrop = absolutizeArt(meta.backdrop || meta.background, baseUrl);

    for (const entry of entries) {
      const item = entry?.item;
      if (!item) { skipped += 1; continue; }
      const itemId = itemIdOf(item);
      if (itemId == null) { skipped += 1; continue; }

      if (isMovie) {
        const chosen = bestFile(playableFiles(item));
        if (!chosen || chosen.id == null) { skipped += 1; continue; }
        const { quality, hdr } = qualityOf(fileNameOf(chosen));
        keep(moviePath({ title, year, quality, hdr }), itemId, chosen.id, {
          key: itemKey(provider, itemId, chosen.id),
          library: 'movies',
          kind: 'movie',
          title,
          year,
          tmdbId: tmdbOrNull(meta.tmdbId),
          imdbId: textOrNull(meta.imdbId) || textOrNull(meta.id),
          quality,
          hdr,
          path: moviePath({ title, year, quality, hdr }),
          poster,
          backdrop,
        });
        continue;
      }

      const season = entry.season != null ? Number(entry.season) : null;
      const episode = entry.episode != null ? Number(entry.episode) : null;
      if (season == null || episode == null || !Number.isFinite(season) || !Number.isFinite(episode)) {
        // Absolute-numbered releases have no season/episode to name a file with.
        // Skipped and counted, never guessed.
        skipped += 1;
        continue;
      }
      const chosen = episodeFileFor(builder.embeddedItemFiles(item).filter((file) => isVideoFile(fileNameOf(file))), season, episode, episode);
      if (!chosen || chosen.id == null) { skipped += 1; continue; }
      const info = builder.episodeFileInfo(chosen) || {};
      const endFromMeta = entry.episodeEnd != null ? Number(entry.episodeEnd) : 0;
      const endFromFile = info.episodeEnd != null ? Number(info.episodeEnd) : 0;
      const episodeEnd = Math.max(endFromMeta, endFromFile, episode);
      const path = episodePath({ seriesTitle: title, seriesYear: year, season, episode, episodeEnd: episodeEnd > episode ? episodeEnd : null });
      keep(path, itemId, chosen.id, {
        key: itemKey(provider, itemId, chosen.id),
        library: 'shows',
        kind: 'episode',
        seriesTitle: title,
        seriesYear: year,
        tmdbId: tmdbOrNull(meta.tmdbId),
        tvdbId: tmdbOrNull(meta.tvdbId),
        season,
        episode,
        episodeEnd: episodeEnd > episode ? episodeEnd : null,
        episodeTitle: textOrNull(entry.episodeTitle) || textOrNull(meta.episodeTitle),
        path,
        poster,
        still: absolutizeArt(meta.still, baseUrl),
      });
    }
  }

  const items = [...byPath.values()].map((entry) => entry.out);
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    plan: {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      provider,
      libraries: LIBRARIES,
      items,
      collections: Array.isArray(input.collections) ? input.collections : [],
    },
    skipped,
  };
}

export interface JellyfinPlanApi {
  sanitizeName: (value: unknown) => string;
  qualityOf: (fileName: unknown) => QualityInfo;
  moviePath: (input: MoviePathInput) => string;
  episodePath: (input: EpisodePathInput) => string;
  itemKey: (provider: string, itemId: unknown, fileId: unknown) => string;
  buildPlan: (input: PlanInput) => { plan: JellyfinPlan; skipped: number };
}

module.exports = { sanitizeName, qualityOf, moviePath, episodePath, itemKey, buildPlan } satisfies JellyfinPlanApi;
