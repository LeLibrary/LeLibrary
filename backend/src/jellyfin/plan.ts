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

export interface JellyfinPlanApi {
  sanitizeName: (value: unknown) => string;
  qualityOf: (fileName: unknown) => QualityInfo;
  moviePath: (input: MoviePathInput) => string;
  episodePath: (input: EpisodePathInput) => string;
  itemKey: (provider: string, itemId: unknown, fileId: unknown) => string;
}

module.exports = { sanitizeName, qualityOf, moviePath, episodePath, itemKey } satisfies JellyfinPlanApi;
