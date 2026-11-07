// Simkl/Trakt/AniList watchlist OAuth re-keyed from accounts to setups.
//
// The old flow bound state to a session cookie. There are no sessions here:
// state is a random token held server-side in a short-lived pending map that
// binds it to the setup UUID - or to nothing for pre-creation connects, where
// the callback hands the tokens to the opener instead of sealing them. The
// callback consumes the state exactly once, exchanges the code (verbatim
// provider calls), and renders a self-closing popup page that signals the
// opener, as the old flow did. An edit-page flow (v6, `sessionHash` set)
// neither seals nor posts tokens: the callback stages the connection in
// setup/pending-connections.ts and the edit save commits it.
import type { WatchlistConn } from './connections.ts';

const axios = require('axios');
const crypto = require('node:crypto') as typeof import('node:crypto');
import type { BoundedMapApi } from '../runtime/bounded-map.ts';
const { boundedSet } = require('../runtime/bounded-map.ts') as BoundedMapApi;

export type WatchlistOAuthProvider = 'simkl' | 'trakt' | 'anilist';

// AniList (v6): authorization-code grant, no scopes; the token lasts a year
// and has no refresh, so a person reconnects once a year (or keeps reading
// public lists by username without any connection).
const ANILIST_AUTHORIZE = 'https://anilist.co/api/v2/oauth/authorize';
const ANILIST_TOKEN = 'https://anilist.co/api/v2/oauth/token';
const ANILIST_DEFAULT_LIFETIME_S = 365 * 24 * 60 * 60;

// Simkl (v6): AUTH V2, the OAuth 2.0 authorization-code flow with PKCE S256
// (mandatory on V2). The code_verifier is generated here, kept server-side
// with the state and sent only on the token exchange: the browser only ever
// sees its SHA-256 challenge. Scopes: read the lists and history, and write
// history (the opt-in Nuvio -> Simkl sync). A V2 grant is a 7-day access
// token plus a sliding 180-day refresh token (refreshed in connections.ts).
const SIMKL_AUTHORIZE = 'https://simkl.com/oauth2/authorize';
const SIMKL_TOKEN = 'https://api.simkl.com/oauth2/token';
const SIMKL_ISSUER = 'https://simkl.com';
const SIMKL_SCOPES = 'media:read media:write';

const PENDING_TTL_MS = 10 * 60 * 1000;
// Abandoned flows are never consumed. States share one TTL, so each insert
// sweeps every expired state, and the cap drops the oldest live ones if a
// burst ever outruns the TTL.
const PENDING_MAX = 2000;

interface PendingOAuth {
  uuid: string | null;
  provider: WatchlistOAuthProvider;
  expiresAt: number;
  // Edit page (v6): the sign-in is staged, not sealed. The hash of the edit
  // session that started it (setup/pending-connections.ts), never the token.
  sessionHash?: string | null;
  // PKCE (Simkl V2): the verifier never leaves the server.
  codeVerifier?: string;
}

const pending = new Map<string, PendingOAuth>();

function randomState(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function oauthConfigured(provider: string): boolean {
  const vars: Record<string, string[]> = {
    simkl: ['SIMKL_CLIENT_ID', 'SIMKL_CLIENT_SECRET'],
    trakt: ['TRAKT_CLIENT_ID', 'TRAKT_CLIENT_SECRET'],
    anilist: ['ANILIST_CLIENT_ID', 'ANILIST_CLIENT_SECRET'],
  };
  const required = vars[provider];
  if (!required) return false;
  return required.every((name) => process.env[name]);
}

function callbackUrl(provider: string, baseUrl: string): string {
  return `${baseUrl}/api/setup/oauth/${provider}/callback`;
}

// PKCE pair (RFC 7636): a 43-character verifier and its S256 challenge.
function newCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function codeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function authorizeUrl(provider: WatchlistOAuthProvider, state: string, baseUrl: string): string {
  if (provider === 'simkl') {
    const u = new URL(SIMKL_AUTHORIZE);
    u.searchParams.set('client_id', String(process.env['SIMKL_CLIENT_ID'] || ''));
    u.searchParams.set('redirect_uri', callbackUrl(provider, baseUrl));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SIMKL_SCOPES);
    u.searchParams.set('state', state);
    const verifier = pending.get(state)?.codeVerifier;
    if (verifier) {
      u.searchParams.set('code_challenge', codeChallenge(verifier));
      u.searchParams.set('code_challenge_method', 'S256');
    }
    return u.toString();
  }
  const clientId = provider === 'anilist' ? process.env['ANILIST_CLIENT_ID'] : process.env['TRAKT_CLIENT_ID'];
  const u = new URL(provider === 'anilist' ? ANILIST_AUTHORIZE : 'https://trakt.tv/oauth/authorize');
  u.searchParams.set('client_id', String(clientId || ''));
  u.searchParams.set('redirect_uri', callbackUrl(provider, baseUrl));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.toString();
}

function pendingOAuthCount(): number {
  return pending.size;
}

function createPendingOAuth(
  uuid: string | null,
  provider: WatchlistOAuthProvider,
  nowMs: number = Date.now(),
  sessionHash: string | null = null,
): { state: string; expiresAt: number } {
  const state = randomState();
  const expiresAt = nowMs + PENDING_TTL_MS;
  const entry: PendingOAuth = { uuid, provider, expiresAt, sessionHash: uuid ? sessionHash : null };
  if (provider === 'simkl') entry.codeVerifier = newCodeVerifier();
  boundedSet(pending, state, entry, PENDING_MAX, (old) => old.expiresAt <= nowMs);
  return { state, expiresAt };
}

export interface ConsumedOAuth {
  uuid: string | null;
  provider: WatchlistOAuthProvider;
  sessionHash: string | null;
  codeVerifier?: string;
}

function consumePendingOAuth(state: unknown, nowMs: number = Date.now()): ConsumedOAuth | null {
  if (typeof state !== 'string' || !state) return null;
  const found = pending.get(state);
  pending.delete(state);
  if (!found || found.expiresAt <= nowMs) return null;
  return {
    uuid: found.uuid, provider: found.provider, sessionHash: found.sessionHash ?? null,
    ...(found.codeVerifier ? { codeVerifier: found.codeVerifier } : {}),
  };
}

// RFC 9207 mix-up defence: Simkl V2 sends `iss` on every callback (success
// and error); it must be Simkl's issuer exactly. Absent is accepted (older
// flows never sent it); anything else is refused before the code is used.
function issuerAccepted(provider: string, iss: unknown): boolean {
  if (provider !== 'simkl' || iss === undefined || iss === null || iss === '') return true;
  return String(iss) === SIMKL_ISSUER;
}

function appVersion(): string {
  try { return (require('../../../package.json') as { version: string }).version; } catch { return '0'; }
}

async function exchangeCode(provider: WatchlistOAuthProvider, code: string, baseUrl: string, codeVerifier?: string): Promise<WatchlistConn> {
  if (provider === 'simkl') {
    // The code is single-use and burnt even by a failed exchange: never retry.
    if (!codeVerifier) throw new Error('Simkl sign-in expired. Close this and try again.');
    const tok = await axios.post(
      SIMKL_TOKEN,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl('simkl', baseUrl),
        code_verifier: codeVerifier,
        client_id: String(process.env['SIMKL_CLIENT_ID'] || ''),
        client_secret: String(process.env['SIMKL_CLIENT_SECRET'] || ''),
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `LeLibrary/${appVersion()}` }, timeout: 15000 },
    );
    const data = (tok.data || {}) as Record<string, unknown>;
    const access = data['access_token'];
    if (!access) throw new Error('Simkl token exchange failed');
    const expiresIn = Number(data['expires_in'] || 0);
    return {
      access_token: String(access),
      refresh_token: typeof data['refresh_token'] === 'string' && data['refresh_token'] ? data['refresh_token'] as string : null,
      expires_at: expiresIn ? Date.now() + expiresIn * 1000 : null,
      client_id: process.env['SIMKL_CLIENT_ID'],
      auth: 'v2',
      // What Simkl actually granted (a typo or a missing scope is silently
      // read-only): history sync checks it before writing.
      scope: typeof data['scope'] === 'string' ? data['scope'] as string : '',
    };
  }
  if (provider === 'anilist') {
    const tok = await axios.post(ANILIST_TOKEN, {
      grant_type: 'authorization_code',
      client_id: String(process.env['ANILIST_CLIENT_ID'] || ''),
      client_secret: String(process.env['ANILIST_CLIENT_SECRET'] || ''),
      redirect_uri: callbackUrl('anilist', baseUrl),
      code,
    }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 });
    const access = (tok.data || {})['access_token'];
    if (!access) throw new Error('AniList token exchange failed');
    const expiresIn = Number((tok.data || {})['expires_in'] || 0) || ANILIST_DEFAULT_LIFETIME_S;
    return {
      access_token: String(access),
      refresh_token: null,
      expires_at: Date.now() + expiresIn * 1000,
      client_id: process.env['ANILIST_CLIENT_ID'],
    };
  }
  const tok = await axios.post('https://api.trakt.tv/oauth/token', {
    code,
    client_id: process.env['TRAKT_CLIENT_ID'],
    client_secret: process.env['TRAKT_CLIENT_SECRET'],
    redirect_uri: callbackUrl('trakt', baseUrl),
    grant_type: 'authorization_code',
  }, { timeout: 15000 });
  const access = (tok.data || {})['access_token'];
  if (!access) throw new Error('Trakt token exchange failed');
  const expiresIn = Number((tok.data || {})['expires_in'] || 0);
  const createdAt = Number((tok.data || {})['created_at'] || Math.floor(Date.now() / 1000));
  return {
    access_token: String(access),
    refresh_token: (tok.data || {})['refresh_token'] || null,
    expires_at: expiresIn ? (createdAt + expiresIn) * 1000 : null,
    client_id: process.env['TRAKT_CLIENT_ID'],
  };
}

function escHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Self-closing popup page: signals the opener (which refreshes its status)
// and closes itself, with a manual close fallback.
function popupPage(provider: string, ok: boolean, message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>LeLibrary</title></head>
<body style="background:#111;color:#eee;font-family:sans-serif;display:grid;place-items:center;min-height:90vh">
<main style="text-align:center">
<h1>${ok ? 'Connected' : 'Connection failed'}</h1>
<p>${escHtml(message)}</p>
<p><button type="button" onclick="window.close()">Close this window</button></p>
</main>
<script>
try {
  if (window.opener) window.opener.postMessage({ lelibraryWatchlist: ${JSON.stringify(provider)}, ok: ${ok ? 'true' : 'false'} }, window.location.origin);
} catch (e) {}
setTimeout(function () { window.close(); }, ${ok ? '1200' : '6000'});
<\/script>
</body></html>`;
}

// Pre-creation variant: instead of sealing into a row, the tokens ride to
// the opener over postMessage so the setup page can hold them in its draft
// (and seal them at creation). Same self-closing behaviour; the payload is
// the user's own freshly-minted tokens plus the account name when the
// callback could read it (`username`, display only).
function popupPageWithTokens(provider: string, connection: WatchlistConn): string {
  const username = typeof connection.username === 'string' && connection.username ? connection.username : null;
  const payload = JSON.stringify({ lelibraryWatchlistTokens: { provider, connection, username } }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>LeLibrary</title></head>
<body style="background:#111;color:#eee;font-family:sans-serif;display:grid;place-items:center;min-height:90vh">
<main style="text-align:center">
<h1>Connected</h1>
<p>Your lists will sync once you create the setup.</p>
<p><button type="button" onclick="window.close()">Close this window</button></p>
</main>
<script>
try {
  if (window.opener) window.opener.postMessage(${payload}, window.location.origin);
} catch (e) {}
setTimeout(function () { window.close(); }, 1200);
<\/script>
</body></html>`;
}

// Edit-page variant (v6): the connection waits server-side until the page
// saves. The opener gets only the opaque pending id and the account name,
// never a token.
function popupPageWithPending(provider: string, pendingId: string, username: string | null): string {
  const payload = JSON.stringify({ lelibraryWatchlistPending: { provider, pendingId, username: username || null } }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>LeLibrary</title></head>
<body style="background:#111;color:#eee;font-family:sans-serif;display:grid;place-items:center;min-height:90vh">
<main style="text-align:center">
<h1>Connected</h1>
<p>Save your changes on the setup page to keep this connection.</p>
<p><button type="button" onclick="window.close()">Close this window</button></p>
</main>
<script>
try {
  if (window.opener) window.opener.postMessage(${payload}, window.location.origin);
} catch (e) {}
setTimeout(function () { window.close(); }, 1200);
<\/script>
</body></html>`;
}

export interface OAuthApi {
  oauthConfigured: (provider: string) => boolean;
  callbackUrl: (provider: string, baseUrl: string) => string;
  authorizeUrl: (provider: WatchlistOAuthProvider, state: string, baseUrl: string) => string;
  createPendingOAuth: (uuid: string | null, provider: WatchlistOAuthProvider, nowMs?: number, sessionHash?: string | null) => { state: string; expiresAt: number };
  consumePendingOAuth: (state: unknown, nowMs?: number) => ConsumedOAuth | null;
  pendingOAuthCount: () => number;
  PENDING_MAX: number;
  exchangeCode: (provider: WatchlistOAuthProvider, code: string, baseUrl: string, codeVerifier?: string) => Promise<WatchlistConn>;
  issuerAccepted: (provider: string, iss: unknown) => boolean;
  codeChallenge: (verifier: string) => string;
  SIMKL_SCOPES: string;
  popupPage: (provider: string, ok: boolean, message: string) => string;
  popupPageWithTokens: (provider: string, connection: WatchlistConn) => string;
  popupPageWithPending: (provider: string, pendingId: string, username: string | null) => string;
}

module.exports = {
  oauthConfigured,
  callbackUrl,
  authorizeUrl,
  createPendingOAuth,
  consumePendingOAuth,
  pendingOAuthCount,
  PENDING_MAX,
  exchangeCode,
  issuerAccepted,
  codeChallenge,
  SIMKL_SCOPES,
  popupPage,
  popupPageWithTokens,
  popupPageWithPending,
} satisfies OAuthApi;
