'use strict';
// Watch history settings (v6): which services LeLibrary reads history from,
// which ones it copies Nuvio's finished history to, and Hide watched.
//
// Stored in the setup config (not secret) as `watchHistory`:
//   { sources: { nuvio: { history }, simkl: { history, sync },
//                mdblist: { history, sync }, anilist: { history, sync } },
//     hideWatched }
// Only what differs from the defaults is stored; absent = defaults, and the
// defaults are never written (compactWatchHistory returns null for them).
// The browser copy (frontend shared/watch-history.ts) mirrors DEFAULTS; a
// test keeps the two in agreement.
//
// A source counts only when the setup has it: a saved Nuvio login, a Simkl
// or AniList connection, an MDBList key. Nuvio is read-only (it is where the
// history comes from); the other three can also receive Nuvio's history.

export type HistorySource = 'nuvio' | 'simkl' | 'mdblist' | 'anilist';
export type SyncTarget = 'simkl' | 'mdblist' | 'anilist';

export interface WatchHistorySettings {
  sources: {
    nuvio: { history: boolean };
    simkl: { history: boolean; sync: boolean };
    mdblist: { history: boolean; sync: boolean };
    anilist: { history: boolean; sync: boolean };
  };
  hideWatched: boolean;
}

const HISTORY_SOURCES: HistorySource[] = ['nuvio', 'simkl', 'mdblist', 'anilist'];
const SYNC_TARGETS: SyncTarget[] = ['simkl', 'mdblist', 'anilist'];

// Nuvio, Simkl and AniList cost the user nothing to read, so they are on
// once connected. MDBList spends the person's own daily allowance (shared
// with their other apps), so it waits to be switched on. Copying history is
// always opt-in, and so is hiding anything.
const DEFAULTS: WatchHistorySettings = {
  sources: {
    nuvio: { history: true },
    simkl: { history: true, sync: false },
    mdblist: { history: false, sync: false },
    anilist: { history: true, sync: false },
  },
  hideWatched: false,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// Any stored (or browser-sent) value -> the full settings, defaults filled.
function normalizeWatchHistory(raw: unknown): WatchHistorySettings {
  const input = asRecord(raw);
  const sources = asRecord(input['sources']);
  const pick = (name: HistorySource) => asRecord(sources[name]);
  return {
    sources: {
      nuvio: { history: flag(pick('nuvio')['history'], DEFAULTS.sources.nuvio.history) },
      simkl: { history: flag(pick('simkl')['history'], DEFAULTS.sources.simkl.history), sync: flag(pick('simkl')['sync'], false) },
      mdblist: { history: flag(pick('mdblist')['history'], DEFAULTS.sources.mdblist.history), sync: flag(pick('mdblist')['sync'], false) },
      anilist: { history: flag(pick('anilist')['history'], DEFAULTS.sources.anilist.history), sync: flag(pick('anilist')['sync'], false) },
    },
    hideWatched: flag(input['hideWatched'], DEFAULTS.hideWatched),
  };
}

// Only the differences from the defaults, or null when there are none (the
// stored key is then cleared, never written as defaults).
function compactWatchHistory(raw: unknown): Record<string, unknown> | null {
  const full = normalizeWatchHistory(raw);
  const sources: Record<string, Record<string, boolean>> = {};
  for (const name of HISTORY_SOURCES) {
    const now = full.sources[name] as Record<string, boolean>;
    const base = DEFAULTS.sources[name] as Record<string, boolean>;
    for (const field of Object.keys(base)) {
      if (now[field] !== base[field]) (sources[name] ||= {})[field] = now[field] as boolean;
    }
  }
  const out: Record<string, unknown> = {};
  if (Object.keys(sources).length) out['sources'] = sources;
  if (full.hideWatched !== DEFAULTS.hideWatched) out['hideWatched'] = full.hideWatched;
  return Object.keys(out).length ? out : null;
}

// The history sources one engine config (keys merged over config) has.
function availableHistorySources(config: Record<string, unknown> | null | undefined): Record<HistorySource, boolean> {
  const c = config || {};
  const nuvio = asRecord(asRecord(c['push'])['nuvio']);
  const watchlist = asRecord(c['watchlist']);
  const live = (provider: string): boolean => {
    const conn = asRecord(watchlist[provider]);
    const token = conn['access_token'];
    if (typeof token !== 'string' || !token) return false;
    const expires = Number(conn['expires_at'] || 0);
    // A V2 Simkl token past its 7 days still refreshes; anything else is gone.
    if (expires && expires <= Date.now() && !(provider === 'simkl' && conn['refresh_token'])) return false;
    return true;
  };
  let simkl = live('simkl');
  if (simkl) {
    const { simklClient } = require('../setup/connections.ts') as { simklClient: (conn: unknown) => { usable: boolean } };
    simkl = simklClient(watchlist['simkl']).usable;
  }
  return {
    nuvio: typeof nuvio['nuvioToken'] === 'string' && Boolean((nuvio['nuvioToken'] as string).trim()),
    simkl,
    mdblist: typeof c['mdblistKey'] === 'string' && Boolean((c['mdblistKey'] as string).trim()),
    anilist: live('anilist'),
  };
}

export interface EffectiveWatchHistory {
  settings: WatchHistorySettings;
  available: Record<HistorySource, boolean>;
  // Sources read (available and switched on).
  read: HistorySource[];
  // Services Nuvio's finished history is copied to (needs Nuvio too).
  sync: SyncTarget[];
  // Hide watched, and something to decide it from.
  hideWatched: boolean;
}

function effectiveWatchHistory(config: Record<string, unknown> | null | undefined): EffectiveWatchHistory {
  const settings = normalizeWatchHistory((config || {})['watchHistory']);
  const available = availableHistorySources(config);
  const read = HISTORY_SOURCES.filter((name) => available[name] && settings.sources[name].history);
  const sync = available.nuvio ? SYNC_TARGETS.filter((name) => available[name] && settings.sources[name].sync) : [];
  return { settings, available, read, sync, hideWatched: settings.hideWatched && read.length > 0 };
}

export interface WatchHistoryConfigApi {
  DEFAULTS: WatchHistorySettings;
  HISTORY_SOURCES: HistorySource[];
  SYNC_TARGETS: SyncTarget[];
  normalizeWatchHistory: typeof normalizeWatchHistory;
  compactWatchHistory: typeof compactWatchHistory;
  availableHistorySources: typeof availableHistorySources;
  effectiveWatchHistory: typeof effectiveWatchHistory;
}

module.exports = {
  DEFAULTS, HISTORY_SOURCES, SYNC_TARGETS, normalizeWatchHistory, compactWatchHistory, availableHistorySources, effectiveWatchHistory,
} satisfies WatchHistoryConfigApi;
