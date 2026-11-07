// Platform + watchlist credentials inside a v5.5 config row.
//
// The row has exactly one encryption mechanism (seal.js, AES-256-GCM, server
// key) for every secret type. Platform credentials are sealed - never hashed,
// because a push must read them back - under `keys.push.{stremio,nuvio}` and
// watchlist tokens under `keys.watchlist.{simkl,trakt,anilist}`. The setup password
// stays a one-way hash gating edits and has nothing to do with these.
import type { OpenedConfig } from './config-store.ts';
import type { PushApi, PushConnection } from './push.ts';

const axios = require('axios');
const { refreshNuvioToken } = require('./push.ts') as PushApi;

export type WatchlistProvider = 'simkl' | 'trakt' | 'anilist';

export interface WatchlistConn {
  access_token?: string;
  refresh_token?: string | null;
  expires_at?: number | null;
  client_id?: string;
  // The account's display name, read once at connect time (v6; absent on
  // older connections). Never a credential.
  username?: string;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// The store type without importing pg typings: only what this module calls.
export interface SetupStoreLike {
  resolveByToken: (token: unknown) => Promise<OpenedConfig | null>;
  resolveByUuid: (uuid: unknown) => Promise<OpenedConfig | null>;
  save: (uuid: unknown, input: { keys?: Record<string, unknown>; clearConfig?: string[] }) => Promise<unknown>;
}

function readPush(opened: OpenedConfig | null, platform: string): PushConnection | null {
  const envelope = asRecord(asRecord(opened?.keys)['push']);
  const conn = asRecord(envelope[platform]);
  if (!conn || Object.keys(conn).length === 0) return null;
  return conn as PushConnection;
}

function readWatchlist(opened: OpenedConfig | null, provider: string): WatchlistConn | null {
  const envelope = asRecord(asRecord(opened?.keys)['watchlist']);
  const conn = asRecord(envelope[provider]);
  if (!conn || typeof conn['access_token'] !== 'string' || !conn['access_token']) return null;
  // AniList tokens have no refresh: once expired the connection is gone
  // (public lists by username keep working).
  if (provider === 'anilist' && Number(conn['expires_at'] || 0) && Number(conn['expires_at']) <= Date.now()) return null;
  return conn as WatchlistConn;
}

// Shape check before anything is sealed. Supersets are fine (user, profiles).
function validatePushConnection(platform: string, data: unknown): string | null {
  const conn = asRecord(data);
  if (platform === 'stremio') {
    return typeof conn['stremioAuth'] === 'string' && (conn['stremioAuth'] as string).trim()
      ? null
      : 'Stremio did not return a session token';
  }
  if (platform === 'nuvio') {
    return typeof conn['nuvioToken'] === 'string' && (conn['nuvioToken'] as string).trim()
      ? null
      : 'Nuvio did not return a session token';
  }
  return 'Unknown platform';
}

function mergePushKeys(
  current: Record<string, unknown>,
  platform: string,
  connection: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, push: { ...asRecord(current['push']), [platform]: connection } };
}

function mergeWatchlistKeys(
  current: Record<string, unknown>,
  provider: string,
  connection: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, watchlist: { ...asRecord(current['watchlist']), [provider]: connection } };
}

function dropEnvelopeKey(
  current: Record<string, unknown>,
  envelope: string,
  key: string,
): Record<string, unknown> {
  const next = { ...asRecord(current[envelope]) };
  delete next[key];
  return { ...current, [envelope]: next };
}

// Trakt refresh single-flight per setup: a reused/rotated refresh token kills
// the connection, so concurrent catalog opens must not race the rotation.
const traktRefreshInFlight = new Map<string, Promise<WatchlistConn | null>>();

async function refreshTraktForSetup(store: SetupStoreLike, uuid: string, conn: WatchlistConn): Promise<WatchlistConn | null> {
  const flightKey = `${uuid}:trakt`;
  const running = traktRefreshInFlight.get(flightKey);
  if (running) return running;
  const flight = (async (): Promise<WatchlistConn | null> => {
    try {
      const refreshed = await axios.post('https://api.trakt.tv/oauth/token', {
        refresh_token: conn.refresh_token,
        client_id: process.env['TRAKT_CLIENT_ID'],
        client_secret: process.env['TRAKT_CLIENT_SECRET'],
        redirect_uri: oauthCallbackUrl('trakt'),
        grant_type: 'refresh_token',
      }, { timeout: 15000 });
      const data = (refreshed.data || {}) as Record<string, unknown>;
      if (typeof data['access_token'] !== 'string' || !data['access_token']) {
        throw new Error('Trakt refresh returned no access token');
      }
      const expiresIn = Number(data['expires_in'] || 0);
      const createdAt = Number(data['created_at'] || Math.floor(Date.now() / 1000));
      const next: WatchlistConn = {
        access_token: data['access_token'] as string,
        refresh_token: (data['refresh_token'] as string) || (conn.refresh_token as string),
        expires_at: expiresIn ? (createdAt + expiresIn) * 1000 : null,
        client_id: process.env['TRAKT_CLIENT_ID'],
      };
      const opened = await store.resolveByUuid(uuid).catch(() => null);
      if (opened) await store.save(uuid, { keys: mergeWatchlistKeys(asRecord(opened.keys), 'trakt', next) }).catch(() => {});
      return next;
    } catch {
      // Another concurrent refresh may have just rotated the stored token -
      // re-read it before declaring the connection dead.
      try {
        const reread = await store.resolveByUuid(uuid).catch(() => null);
        const current = readWatchlist(reread, 'trakt');
        if (current && current.refresh_token && current.refresh_token !== conn.refresh_token &&
          current.expires_at && Number(current.expires_at) > Date.now()) return current;
      } catch { /* fall through */ }
      return null;
    } finally {
      traktRefreshInFlight.delete(flightKey);
    }
  })();
  traktRefreshInFlight.set(flightKey, flight);
  return flight;
}

// ── Simkl (v6: AUTH V2) ───────────────────────────────────────────────
// New connections come from the V2 app (SIMKL_CLIENT_ID): a 7-day access
// token plus a sliding 180-day refresh token, scopes media:read +
// media:write. Older connections were issued to the V1 app: a five-year
// token, no refresh, and they only work with that app's client id
// (SIMKL_V1_CLIENT_ID). They keep working until Simkl retires V1 (around
// 2027-04) or the person reconnects; without the V1 id they need a
// reconnect. A V2 token is told apart locally (`auth: 'v2'`, or Simkl's
// `simkl_at_` prefix): never an API call.
const SIMKL_TOKEN_URL = 'https://api.simkl.com/oauth2/token';
// Refresh a day before the access token runs out (Simkl's advice), never
// on a timer.
const SIMKL_REFRESH_AHEAD_MS = 24 * 60 * 60 * 1000;

export type SimklKind = 'v2' | 'legacy';

export interface SimklClient {
  kind: SimklKind;
  clientId: string;
  // False for a V1 connection when this server has no V1 client id: the
  // person has to reconnect.
  usable: boolean;
  // The grant may write history (V2 with media:write only).
  write: boolean;
}

function simklKind(conn: WatchlistConn | null | undefined): SimklKind {
  if (!conn) return 'legacy';
  if (conn['auth'] === 'v2') return 'v2';
  return typeof conn.access_token === 'string' && conn.access_token.startsWith('simkl_at_') ? 'v2' : 'legacy';
}

function simklClient(conn: WatchlistConn | null | undefined): SimklClient {
  const kind = simklKind(conn);
  if (kind === 'v2') {
    const clientId = String(process.env['SIMKL_CLIENT_ID'] || '');
    const scope = String((conn && conn['scope']) || '');
    return { kind, clientId, usable: Boolean(clientId), write: Boolean(clientId) && scope.split(/\s+/).includes('media:write') };
  }
  const clientId = String(process.env['SIMKL_V1_CLIENT_ID'] || '');
  return { kind, clientId, usable: Boolean(clientId), write: false };
}

export interface SimklRefreshDeps {
  post?: (url: string, body: string, options: Record<string, unknown>) => Promise<{ data?: unknown }>;
  now?: () => number;
}

// One refresh per setup at a time. Simkl replaces the grant's access token
// on every refresh, so two refreshers on the same grant cut each other off:
// concurrent catalogue opens share this flight, and a refresh first re-reads
// the stored connection in case another request (or process) already did it.
const simklRefreshInFlight = new Map<string, Promise<WatchlistConn | null>>();

function simklTokenFresh(conn: WatchlistConn | null, now: number): boolean {
  return Boolean(conn && conn.access_token && (!conn.expires_at || Number(conn.expires_at) - now > SIMKL_REFRESH_AHEAD_MS));
}

async function refreshSimklForSetup(store: SetupStoreLike, uuid: string, conn: WatchlistConn, deps: SimklRefreshDeps = {}): Promise<WatchlistConn | null> {
  const flightKey = `${uuid}:simkl`;
  const running = simklRefreshInFlight.get(flightKey);
  if (running) return running;
  const now = deps.now || Date.now;
  const post = deps.post || ((url: string, body: string, options: Record<string, unknown>) => axios.post(url, body, options));
  const flight = (async (): Promise<WatchlistConn | null> => {
    try {
      const stored = readWatchlist(await store.resolveByUuid(uuid).catch(() => null), 'simkl');
      if (stored && stored.access_token !== conn.access_token && simklTokenFresh(stored, now())) return stored;
      const base = stored && simklKind(stored) === 'v2' ? stored : conn;
      if (!base.refresh_token) return null;
      const res = await post(SIMKL_TOKEN_URL, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: String(base.refresh_token),
        client_id: String(process.env['SIMKL_CLIENT_ID'] || ''),
        client_secret: String(process.env['SIMKL_CLIENT_SECRET'] || ''),
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': simklUserAgent() }, timeout: 15000 });
      const data = asRecord(res?.data);
      if (typeof data['access_token'] !== 'string' || !data['access_token']) throw new Error('Simkl refresh returned no access token');
      const expiresIn = Number(data['expires_in'] || 0);
      const next: WatchlistConn = {
        ...base,
        access_token: data['access_token'] as string,
        // Non-rotating today: the same refresh token comes back. Keep
        // whatever Simkl sends, in case that changes.
        refresh_token: typeof data['refresh_token'] === 'string' && data['refresh_token'] ? data['refresh_token'] as string : base.refresh_token,
        expires_at: expiresIn ? now() + expiresIn * 1000 : null,
        client_id: process.env['SIMKL_CLIENT_ID'],
        auth: 'v2',
        ...(typeof data['scope'] === 'string' && data['scope'] ? { scope: data['scope'] } : {}),
      };
      const opened = await store.resolveByUuid(uuid).catch(() => null);
      if (opened) await store.save(uuid, { keys: mergeWatchlistKeys(asRecord(opened.keys), 'simkl', next) }).catch(() => {});
      return next;
    } catch {
      // Someone else may have refreshed in the meantime: re-read first.
      const reread = readWatchlist(await store.resolveByUuid(uuid).catch(() => null), 'simkl');
      if (reread && reread.access_token !== conn.access_token && simklTokenFresh(reread, now())) return reread;
      // Still inside its lifetime: keep using it and try again next time.
      if (conn.expires_at && Number(conn.expires_at) > now()) return conn;
      return null;
    } finally {
      simklRefreshInFlight.delete(flightKey);
    }
  })();
  simklRefreshInFlight.set(flightKey, flight);
  return flight;
}

// A V2 connection close to expiry is refreshed (and saved); anything else
// comes back as it is. Null = the connection cannot be used any more.
async function liveSimklConn(store: SetupStoreLike | null, uuid: string | null, conn: WatchlistConn, deps: SimklRefreshDeps = {}): Promise<WatchlistConn | null> {
  const now = (deps.now || Date.now)();
  if (simklKind(conn) !== 'v2') return conn;
  if (simklTokenFresh(conn, now)) return conn;
  if (store && uuid && conn.refresh_token) return refreshSimklForSetup(store, uuid, conn, deps);
  return conn.expires_at && Number(conn.expires_at) > now ? conn : null;
}

function simklUserAgent(): string {
  try { return `LeLibrary/${(require('../../../package.json') as { version: string }).version}`; } catch { return 'LeLibrary'; }
}

export interface SimklAuthResolved { token: string; clientId: string; kind: SimklKind; write: boolean }

// The Simkl credentials for one engine config (the setup's keys merged over
// its config): refreshed first when a V2 token is close to expiry, saved back
// into the sealed keys. Null when there is no usable connection.
async function simklAuthForConfig(config: Record<string, unknown>, deps: SimklRefreshDeps & { store?: SetupStoreLike | null } = {}): Promise<SimklAuthResolved | null> {
  const conn = asRecord(asRecord(config['watchlist'])['simkl']) as WatchlistConn;
  if (typeof conn.access_token !== 'string' || !conn.access_token) return null;
  const scope = (config as { __configScope?: { type?: string; uuid?: string } }).__configScope;
  const uuid = scope && scope.type === 'config' && typeof scope.uuid === 'string' ? scope.uuid : null;
  let store = deps.store === undefined ? null : deps.store;
  if (deps.store === undefined && uuid && simklKind(conn) === 'v2') {
    store = await (require('./runtime.ts') as { getSetupStore: () => Promise<SetupStoreLike | null> }).getSetupStore().catch(() => null);
  }
  const live = await liveSimklConn(store, uuid, conn, deps);
  if (!live || !live.access_token) return null;
  const client = simklClient(live);
  if (!client.usable) return null;
  return { token: live.access_token, clientId: client.clientId, kind: client.kind, write: client.write };
}

function baseOrigin(): string {
  return (process.env['BASE_URL'] || '').replace(/\/+$/, '');
}

function oauthCallbackUrl(provider: string): string {
  return `${baseOrigin()}/api/setup/oauth/${provider}/callback`;
}

// Server-side read path for addon serving: resolve an install token to its
// stored watchlist connection. Trakt tokens refresh here, where the row is
// already open, so users never reconnect just because a catalogue opened
// after the token lifetime.
async function setupWatchlistConn(
  store: SetupStoreLike,
  installToken: unknown,
  provider: string,
): Promise<WatchlistConn | null> {
  const opened = await store.resolveByToken(installToken).catch(() => null);
  if (!opened) return null;
  const conn = readWatchlist(opened, provider);
  if (!conn) return null;
  if (provider === 'trakt' && conn.refresh_token && conn.expires_at && Number(conn.expires_at) <= Date.now() + 60000) {
    return refreshTraktForSetup(store, opened.uuid, conn);
  }
  if (provider === 'simkl') {
    const live = await liveSimklConn(store, opened.uuid, conn);
    return live && simklClient(live).usable ? live : null;
  }
  return conn;
}

export interface ConnectionsApi {
  readPush: (opened: OpenedConfig | null, platform: string) => PushConnection | null;
  readWatchlist: (opened: OpenedConfig | null, provider: string) => WatchlistConn | null;
  validatePushConnection: (platform: string, data: unknown) => string | null;
  mergePushKeys: (current: Record<string, unknown>, platform: string, connection: Record<string, unknown>) => Record<string, unknown>;
  mergeWatchlistKeys: (current: Record<string, unknown>, provider: string, connection: Record<string, unknown>) => Record<string, unknown>;
  dropEnvelopeKey: (current: Record<string, unknown>, envelope: string, key: string) => Record<string, unknown>;
  setupWatchlistConn: (store: SetupStoreLike, installToken: unknown, provider: string) => Promise<WatchlistConn | null>;
  refreshNuvioToken: PushApi['refreshNuvioToken'];
  simklKind: typeof simklKind;
  simklClient: typeof simklClient;
  refreshSimklForSetup: typeof refreshSimklForSetup;
  liveSimklConn: typeof liveSimklConn;
  simklAuthForConfig: typeof simklAuthForConfig;
  SIMKL_REFRESH_AHEAD_MS: number;
}

module.exports = {
  readPush,
  readWatchlist,
  validatePushConnection,
  mergePushKeys,
  mergeWatchlistKeys,
  dropEnvelopeKey,
  setupWatchlistConn,
  refreshNuvioToken,
  simklKind,
  simklClient,
  refreshSimklForSetup,
  liveSimklConn,
  simklAuthForConfig,
  SIMKL_REFRESH_AHEAD_MS,
} satisfies ConnectionsApi;
