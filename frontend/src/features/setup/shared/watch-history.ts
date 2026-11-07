// Watch history settings (config.watchHistory), Settle In and Move In.
// Mirrors backend/src/watch-history/config.ts (a backend test keeps the
// defaults and the compact form in agreement): anything at its default is
// left out of the saved config, and all-defaults saves nothing at all.
// Dependency-free so the backend test can import it.

export type HistorySourceId = 'nuvio' | 'simkl' | 'mdblist' | 'anilist';
export type SyncTargetId = 'simkl' | 'mdblist' | 'anilist';

export interface WatchHistoryDraft {
  sources: {
    nuvio: { history: boolean };
    simkl: { history: boolean; sync: boolean };
    mdblist: { history: boolean; sync: boolean };
    anilist: { history: boolean; sync: boolean };
  };
  hideWatched: boolean;
}

// Nuvio, Simkl and AniList are read once connected (free to read); MDBList
// spends the person's own daily allowance, so it waits to be switched on.
// Copying history and hiding watched titles are always opt-in.
export const DEFAULT_WATCH_HISTORY: WatchHistoryDraft = {
  sources: {
    nuvio: { history: true },
    simkl: { history: true, sync: false },
    mdblist: { history: false, sync: false },
    anilist: { history: true, sync: false },
  },
  hideWatched: false,
};

export const HISTORY_SOURCE_IDS: HistorySourceId[] = ['nuvio', 'simkl', 'mdblist', 'anilist'];

export const HISTORY_SOURCE_NAMES: Record<HistorySourceId, string> = {
  nuvio: 'Nuvio',
  simkl: 'Simkl',
  mdblist: 'MDBList',
  anilist: 'AniList',
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function cleanWatchHistory(raw: unknown): WatchHistoryDraft {
  const value = record(raw);
  const sources = record(value['sources']);
  const pick = (name: HistorySourceId) => record(sources[name]);
  const d = DEFAULT_WATCH_HISTORY.sources;
  return {
    sources: {
      nuvio: { history: flag(pick('nuvio')['history'], d.nuvio.history) },
      simkl: { history: flag(pick('simkl')['history'], d.simkl.history), sync: flag(pick('simkl')['sync'], false) },
      mdblist: { history: flag(pick('mdblist')['history'], d.mdblist.history), sync: flag(pick('mdblist')['sync'], false) },
      anilist: { history: flag(pick('anilist')['history'], d.anilist.history), sync: flag(pick('anilist')['sync'], false) },
    },
    hideWatched: flag(value['hideWatched'], DEFAULT_WATCH_HISTORY.hideWatched),
  };
}

// The compact config value, or null when everything is at its default.
export function watchHistoryForConfig(draft: WatchHistoryDraft): Record<string, unknown> | null {
  const full = cleanWatchHistory(draft);
  const sources: Record<string, Record<string, boolean>> = {};
  for (const name of HISTORY_SOURCE_IDS) {
    const now = full.sources[name] as Record<string, boolean>;
    const base = DEFAULT_WATCH_HISTORY.sources[name] as Record<string, boolean>;
    for (const field of Object.keys(base)) {
      if (now[field] !== base[field]) {
        const entry = sources[name] ?? {};
        entry[field] = now[field] as boolean;
        sources[name] = entry;
      }
    }
  }
  const out: Record<string, unknown> = {};
  if (Object.keys(sources).length) out['sources'] = sources;
  if (full.hideWatched !== DEFAULT_WATCH_HISTORY.hideWatched) out['hideWatched'] = full.hideWatched;
  return Object.keys(out).length ? out : null;
}

export type HistoryAvailability = Record<HistorySourceId, boolean>;

// The sources the card lists: only what the setup has. MDBList only with a
// key. An empty list hides the card.
export function visibleHistorySources(available: HistoryAvailability): HistorySourceId[] {
  return HISTORY_SOURCE_IDS.filter((name) => available[name]);
}

// The accordion's one-line state. Pure for unit tests.
export function watchHistorySummary(draft: WatchHistoryDraft, available: HistoryAvailability): string[] {
  const visible = visibleHistorySources(available);
  const reading = visible.filter((name) => draft.sources[name].history).map((name) => HISTORY_SOURCE_NAMES[name]);
  const parts = [reading.length ? `History from ${reading.join(', ')}` : 'History off'];
  const syncing = visible.filter((name) => name !== 'nuvio' && available.nuvio && draft.sources[name as SyncTargetId].sync);
  if (syncing.length) parts.push(`Copying to ${syncing.map((name) => HISTORY_SOURCE_NAMES[name]).join(', ')}`);
  if (draft.hideWatched && reading.length) parts.push('Hiding watched');
  return parts;
}
