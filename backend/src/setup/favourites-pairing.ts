'use strict';
// Pairing the Releases page with a setup (v6.1).
//
// The Releases page has no login and must never be handed a setup's install
// link: that link is a read capability for the whole library. Instead the setup
// page (already unlocked with the edit token) makes a short code, the person
// types it on the Releases page, and the server answers with a scoped session
// cookie. That cookie can do exactly two things for that one setup:
//
//   - keep the setup's favourites list (the same list the Setup page edits)
//   - ask whether up to 50 titles are in the setup's library, and how much of
//     a series they hold
//
// It cannot read a catalog, a stream, a key or the install link, and it is
// revocable from the Setup page at any time. Codes live in memory for ten
// minutes and are single use; only a hash of the session token is stored.
//
// Mutations still need a same-origin request (the router checks Origin /
// Sec-Fetch-Site), so another site cannot star things on the person's behalf.

import type { PoolLike } from './config-store.ts';
// CommonJS value, like every other backend module (Node runs these .ts files
// directly; ESM value syntax is not allowed here).
const crypto = require('node:crypto') as typeof import('node:crypto');

const COOKIE_NAME = 'llfav';
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_S = 180 * 24 * 60 * 60;
// No 0/O/1/I: a code is read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

interface PendingCode { uuid: string; expires: number }
const pendingCodes = new Map<string, PendingCode>();

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normaliseUuid(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function purge(): void {
  const now = Date.now();
  for (const [code, entry] of pendingCodes) if (entry.expires <= now) pendingCodes.delete(code);
}

// The setup page asks for one of these; it is shown once and typed elsewhere.
function createCode(uuid: unknown): { code: string; expiresAt: string } | null {
  const id = normaliseUuid(uuid);
  if (!id) return null;
  purge();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (pendingCodes.has(code)) continue;
    const expires = Date.now() + CODE_TTL_MS;
    pendingCodes.set(code, { uuid: id, expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  return null;
}

// Single use: redeeming consumes the code whether or not the session is kept.
function redeemCode(value: unknown): string | null {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  purge();
  const entry = pendingCodes.get(code);
  if (!entry) return null;
  pendingCodes.delete(code);
  return entry.uuid;
}

interface PairingSession { id: string; uuid: string }

// A new scoped token for one setup. Only its hash is stored.
async function issue(pool: PoolLike, uuid: unknown, label: unknown): Promise<{ token: string; id: string } | null> {
  const id = normaliseUuid(uuid);
  if (!id) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const pairingId = crypto.randomUUID();
  const clean = String(label || '').trim().replace(/[^\x20-\x7E]/g, '').slice(0, 40) || null;
  const { rowCount } = await pool.query(
    `INSERT INTO setup_favourites_pairings (id, setup_uuid, token_hash, label)
     VALUES ($1, $2, $3, $4)`,
    [pairingId, id, sha256(token), clean]
  );
  return Number(rowCount) > 0 ? { token, id: pairingId } : null;
}

// Cookie value -> the setup it belongs to. Touches last_used_at at most once a
// minute per request batch (coalesced in memory).
const touched = new Map<string, number>();
async function resolve(pool: PoolLike, token: unknown): Promise<PairingSession | null> {
  const raw = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : null;
  if (!raw) return null;
  const hash = sha256(raw);
  const { rows } = await pool.query(
    `SELECT id, setup_uuid FROM setup_favourites_pairings
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash]
  );
  const row = (rows as Record<string, unknown>[])[0];
  if (!row) return null;
  const id = String(row['id']);
  const now = Date.now();
  if (!(touched.get(id) && now - (touched.get(id) || 0) < 60_000)) {
    touched.set(id, now);
    pool.query('UPDATE setup_favourites_pairings SET last_used_at = now() WHERE id = $1', [id]).catch(() => {});
  }
  return { id, uuid: String(row['setup_uuid']) };
}

async function list(pool: PoolLike, uuid: unknown) {
  const id = normaliseUuid(uuid);
  if (!id) return [];
  const { rows } = await pool.query(
    `SELECT id, label, created_at, last_used_at
       FROM setup_favourites_pairings
      WHERE setup_uuid = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [id]
  );
  return (rows as Record<string, unknown>[]).map((row) => ({
    id: String(row['id']),
    label: typeof row['label'] === 'string' ? row['label'] : null,
    createdAt: row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at'] || ''),
    lastUsedAt: row['last_used_at'] instanceof Date ? row['last_used_at'].toISOString() : null,
  }));
}

async function revoke(pool: PoolLike, uuid: unknown, pairingId: unknown): Promise<boolean> {
  const id = normaliseUuid(uuid);
  if (!id || typeof pairingId !== 'string' || !/^[0-9a-f-]{36}$/i.test(pairingId)) return false;
  const { rowCount } = await pool.query(
    'UPDATE setup_favourites_pairings SET revoked_at = now() WHERE id = $1 AND setup_uuid = $2 AND revoked_at IS NULL',
    [pairingId, id]
  );
  touched.delete(pairingId);
  return Number(rowCount) > 0;
}

// Deleting a setup takes its pairings with it (foreign key), but a "revoke
// everything" button is cheaper than asking people to hunt each device.
async function revokeAll(pool: PoolLike, uuid: unknown): Promise<number> {
  const id = normaliseUuid(uuid);
  if (!id) return 0;
  const { rowCount } = await pool.query(
    'UPDATE setup_favourites_pairings SET revoked_at = now() WHERE setup_uuid = $1 AND revoked_at IS NULL',
    [id]
  );
  touched.clear();
  return Number(rowCount) || 0;
}

function tokenFromRequest(req: { headers?: Record<string, unknown> }): string | null {
  const header = String((req.headers || {})['cookie'] || '');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function cookieString(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

function clearCookieString(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// Behind Caddy the app itself is http, so the client-facing scheme comes from
// the proxy header. A cookie is only marked Secure where it will be honoured.
function isSecure(req: { headers?: Record<string, unknown> }): boolean {
  const headers = req.headers || {};
  return String(headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export interface FavouritesPairingApi {
  COOKIE_NAME: string;
  createCode: typeof createCode;
  redeemCode: typeof redeemCode;
  issue: typeof issue;
  resolve: typeof resolve;
  list: typeof list;
  revoke: typeof revoke;
  revokeAll: typeof revokeAll;
  tokenFromRequest: typeof tokenFromRequest;
  cookieString: typeof cookieString;
  clearCookieString: typeof clearCookieString;
  isSecure: typeof isSecure;
  pending: () => number;
}

module.exports = {
  COOKIE_NAME, createCode, redeemCode, issue, resolve, list, revoke, revokeAll,
  tokenFromRequest, cookieString, clearCookieString, isSecure,
  pending: () => pendingCodes.size,
} satisfies FavouritesPairingApi;
