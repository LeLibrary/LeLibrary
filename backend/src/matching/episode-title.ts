'use strict';
// A precise episode title in a release name can resolve conflicting numbering
// schemes. Return a result only when exactly one metadata episode has a long,
// multiword title contained in the filename. No user data is logged or cached.
function normalized(value: unknown): string {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function matchEpisodeTitle(filename: string, videos: any[]): { season: number; episode: number; title: string } | null {
  const release = normalized(filename).replace(/ /g, '');
  const hits = new Map<string, { season: number; episode: number; title: string }>();
  for (const video of Array.isArray(videos) ? videos : []) {
    const title = String(video?.name || video?.title || '').trim();
    const words = normalized(title);
    const compact = words.replace(/ /g, '');
    const season = Number(video?.season), episode = Number(video?.episode);
    if (compact.length < 12 || words.split(' ').length < 3 || !release.includes(compact)) continue;
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) continue;
    hits.set(`${season}:${episode}`, { season, episode, title });
  }
  return hits.size === 1 ? hits.values().next().value || null : null;
}
module.exports = { matchEpisodeTitle };
