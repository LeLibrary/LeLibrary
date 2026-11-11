// Password reset and setup deletion requests (v6).
//
// A setup has no email, so "I forgot my password" needs another proof of
// ownership. The install link alone is not enough (the password exists to stop
// people who hold the link from editing), so the requester must also give one
// of the API keys saved in the setup. A person who only has the link cannot.
//
// Flow: website form (link + key) -> request id -> the user runs /reset in the
// Discord bot -> the operator approves in a DM -> after a random 0-60 s wait
// the bot DMs a one-time code (15 minutes, five tries, single use) -> the user
// types the code on the site and chooses a NEW password themselves (or
// confirms the deletion). The bot never sends a password.
const crypto = require('node:crypto') as typeof import('node:crypto');
import type { PoolLike } from './config-store.ts';
import type { OpenedConfig } from './config-store.ts';

export type ResetAction = 'reset' | 'delete';
export type ResetStatus =
  | 'pending_discord' | 'awaiting_approval' | 'approved' | 'code_issued'
  | 'done' | 'denied' | 'expired' | 'cancelled' | 'failed' | 'burned';

const ACTIONS: ResetAction[] = ['reset', 'delete'];
const OPEN_STATUSES = ['pending_discord', 'awaiting_approval', 'approved', 'code_issued'];

// Time budget, all in one place.
const LINK_TTL_MS = 30 * 60_000;        // run /reset within 30 minutes of the form
const APPROVAL_TTL_MS = 12 * 3_600_000; // the operator has 12 hours to decide
const CODE_TTL_MS = 15 * 60_000;        // a delivered code lives 15 minutes
const MAX_RELEASE_DELAY_MS = 60_000;    // random wait before the code goes out
const STALE_APPROVED_MS = 60 * 60_000;  // approved but never delivered
const MAX_CODE_TRIES = 5;
const MAX_OPEN_PER_DISCORD_USER = 3;    // linked requests per Discord user per 24 h

// No 0/O/1/I/L: these are read off a phone screen and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomChars(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function newRequestId(): string {
  return `LL-${randomChars(5)}-${randomChars(5)}`;
}

function newCode(): string {
  return `${randomChars(4)}-${randomChars(4)}`;
}

const REQUEST_ID_RE = /^LL-[A-Z0-9]{5}-[A-Z0-9]{5}$/;
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** Upper-cases and trims what a person typed; null when the shape is wrong. */
function normaliseRequestId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const id = value.trim().toUpperCase();
  return REQUEST_ID_RE.test(id) ? id : null;
}

function normaliseCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const raw = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== 8) return null;
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return CODE_RE.test(code) ? code : null;
}

/** Discord ids are snowflakes: digits only. */
function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{15,25}$/.test(value);
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

// Key fields that prove ownership. Debrid keys first; the others are accepted
// because a friend who only holds the install link knows none of them. Short
// values are ignored: a weak stored value is a guessable proof.
const PROOF_FIELDS = [
  'torboxApiKey', 'rdApiKey', 'adApiKey', 'pmApiKey',
  'tmdbApiKey', 'mdblistKey', 'erdbToken', 'rpdbKey', 'fanartKey',
];
const MIN_PROOF_LENGTH = 16;

/**
 * True when `candidate` equals one of the keys saved in the setup. Every stored
 * key is compared, in constant time, with no early exit, so timing does not say
 * which one (or how much of it) matched.
 */
function proveOwnership(opened: Pick<OpenedConfig, 'keys'> | null | undefined, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const given = candidate.trim();
  if (given.length < MIN_PROOF_LENGTH || given.length > 512) return false;
  const givenHash = sha256(given);
  let matched = false;
  const keys = (opened?.keys ?? {}) as Record<string, unknown>;
  for (const field of PROOF_FIELDS) {
    const stored = keys[field];
    if (typeof stored !== 'string' || stored.length < MIN_PROOF_LENGTH) continue;
    if (crypto.timingSafeEqual(sha256(stored), givenHash)) matched = true;
  }
  return matched;
}

/** Which proof fields a setup has, so the form can tell "nothing to prove with". */
function hasProofKey(opened: Pick<OpenedConfig, 'keys'> | null | undefined): boolean {
  const keys = (opened?.keys ?? {}) as Record<string, unknown>;
  return PROOF_FIELDS.some((field) => typeof keys[field] === 'string' && (keys[field] as string).length >= MIN_PROOF_LENGTH);
}

const RESET_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS reset_requests (
     id text PRIMARY KEY,
     uuid text NOT NULL,
     action text NOT NULL,
     status text NOT NULL,
     discord_user_id text,
     discord_name text,
     ip_hash text,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     approved_at timestamptz,
     release_at timestamptz,
     code_hash text,
     code_expires_at timestamptz,
     code_attempts integer NOT NULL DEFAULT 0,
     approval_notified boolean NOT NULL DEFAULT false,
     denial_notified boolean NOT NULL DEFAULT false,
     used_at timestamptz
   )`,
  'CREATE INDEX IF NOT EXISTS reset_requests_uuid_idx ON reset_requests (uuid)',
  'CREATE INDEX IF NOT EXISTS reset_requests_status_idx ON reset_requests (status)',
  `CREATE TABLE IF NOT EXISTS reset_audit (
     id bigserial PRIMARY KEY,
     at timestamptz NOT NULL DEFAULT now(),
     request_id text,
     uuid text,
     event text NOT NULL,
     detail text
   )`,
];

export interface ResetRow {
  id: string;
  uuid: string;
  action: ResetAction;
  status: ResetStatus;
  discord_user_id: string | null;
  discord_name: string | null;
  created_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  release_at: Date | null;
  code_hash: string | null;
  code_expires_at: Date | null;
  code_attempts: number;
  used_at: Date | null;
}

export interface PublicStatus {
  status: 'waiting_discord' | 'waiting_approval' | 'approved' | 'code_sent' | 'done' | 'denied' | 'closed';
  action: ResetAction;
  codeExpiresAt: string | null;
  expiresAt: string;
}

export interface ApprovalItem {
  id: string;
  action: ResetAction;
  discordUserId: string;
  discordName: string;
  setupName: string | null;
  setupAgeDays: number | null;
  tier: string | null;
  requestedAt: string;
}

export interface DeliveryItem {
  id: string;
  action: ResetAction;
  discordUserId: string;
  code: string;
  expiresAt: string;
}

export interface ResetStoreOptions {
  pool: PoolLike;
  key: Buffer;
  now?: () => number;
  // Test seam: the wait before a code is released (0..MAX_RELEASE_DELAY_MS).
  releaseDelayMs?: () => number;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clip(value: unknown, max: number): string {
  // Display text only: control characters out, length capped.
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function createResetStore(options: ResetStoreOptions) {
  const { pool, key } = options;
  const now = options.now ?? (() => Date.now());
  const releaseDelay = options.releaseDelayMs ?? (() => crypto.randomInt(0, MAX_RELEASE_DELAY_MS + 1));
  const at = (ms: number) => new Date(ms);

  const codeHash = (code: string) => crypto.createHmac('sha256', key).update(`reset-code:${code}`).digest('hex');

  async function audit(requestId: string | null, uuid: string | null, event: string, detail = ''): Promise<void> {
    await pool.query(
      'INSERT INTO reset_audit (request_id, uuid, event, detail) VALUES ($1,$2,$3,$4)',
      [requestId, uuid, event, clip(detail, 200)],
    ).catch(() => undefined);
  }

  // Lazy expiry: every entry point first closes whatever has run out of time.
  async function sweep(): Promise<void> {
    const t = at(now());
    await pool.query(
      `UPDATE reset_requests SET status = 'expired'
        WHERE status IN ('pending_discord','awaiting_approval') AND expires_at <= $1`, [t]);
    await pool.query(
      `UPDATE reset_requests SET status = 'expired'
        WHERE status = 'code_issued' AND code_expires_at <= $1`, [t]);
    await pool.query(
      `UPDATE reset_requests SET status = 'expired'
        WHERE status = 'approved' AND release_at <= $1`, [at(now() - STALE_APPROVED_MS)]);
  }

  async function row(id: string): Promise<ResetRow | null> {
    const result = await pool.query<ResetRow>('SELECT * FROM reset_requests WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  return {
    async migrate(): Promise<void> {
      for (const statement of RESET_MIGRATIONS) await pool.query(statement);
    },

    async create(input: { uuid: string; action: ResetAction; ipHash: string }): Promise<{ id: string; expiresAt: string }> {
      if (!ACTIONS.includes(input.action)) throw new Error('bad action');
      await sweep();
      // One open request per setup: a new one replaces the old.
      await pool.query(
        `UPDATE reset_requests SET status = 'cancelled' WHERE uuid = $1 AND status = ANY($2)`,
        [input.uuid, OPEN_STATUSES],
      );
      const expires = at(now() + LINK_TTL_MS);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = newRequestId();
        const inserted = await pool.query(
          `INSERT INTO reset_requests (id, uuid, action, status, ip_hash, created_at, expires_at)
           VALUES ($1,$2,$3,'pending_discord',$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
          [id, input.uuid, input.action, input.ipHash, at(now()), expires],
        );
        if ((inserted.rowCount ?? 0) > 0) {
          await audit(id, input.uuid, 'requested', input.action);
          return { id, expiresAt: expires.toISOString() };
        }
      }
      throw new Error('could not allocate a request id');
    },

    /** The user ran /reset <id> in Discord. */
    async link(id: string, discordUserId: string, discordName: string): Promise<'ok' | 'not_found' | 'limited'> {
      if (!isSnowflake(discordUserId)) return 'not_found';
      await sweep();
      const existing = await row(id);
      if (!existing) return 'not_found';
      // Re-running the command as the same person is harmless.
      if (existing.discord_user_id === discordUserId && ['awaiting_approval', 'approved', 'code_issued'].includes(existing.status)) return 'ok';
      if (existing.status !== 'pending_discord') return 'not_found';
      const recent = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM reset_requests
          WHERE discord_user_id = $1 AND created_at > $2 AND status <> 'pending_discord'`,
        [discordUserId, at(now() - 24 * 3_600_000)],
      );
      if (Number(recent.rows[0]?.n ?? 0) >= MAX_OPEN_PER_DISCORD_USER) {
        await audit(id, existing.uuid, 'link-limited', discordUserId);
        return 'limited';
      }
      const updated = await pool.query(
        `UPDATE reset_requests
            SET status = 'awaiting_approval', discord_user_id = $2, discord_name = $3, expires_at = $4
          WHERE id = $1 AND status = 'pending_discord' AND expires_at > $5`,
        [id, discordUserId, clip(discordName, 64), at(now() + APPROVAL_TTL_MS), at(now())],
      );
      if ((updated.rowCount ?? 0) === 0) return 'not_found';
      await audit(id, existing.uuid, 'linked', discordUserId);
      return 'ok';
    },

    async pendingApprovals(): Promise<ApprovalItem[]> {
      await sweep();
      const result = await pool.query<ResetRow & { setup_name: string | null; setup_created: Date | null; setup_tier: string | null }>(
        `SELECT r.*, c.name AS setup_name, c.created_at AS setup_created, c.tier AS setup_tier
           FROM reset_requests r LEFT JOIN configs c ON c.uuid = r.uuid
          WHERE r.status = 'awaiting_approval' AND r.approval_notified = false
          ORDER BY r.created_at LIMIT 20`,
      );
      return result.rows.map((r) => ({
        id: r.id,
        action: r.action,
        discordUserId: String(r.discord_user_id),
        discordName: clip(r.discord_name, 64),
        setupName: r.setup_name ? clip(r.setup_name, 60) : null,
        setupAgeDays: r.setup_created ? Math.floor((now() - new Date(r.setup_created).getTime()) / 86_400_000) : null,
        tier: r.setup_tier ? clip(r.setup_tier, 12) : null,
        requestedAt: iso(r.created_at) ?? '',
      }));
    },

    async ackApproval(id: string): Promise<void> {
      await pool.query('UPDATE reset_requests SET approval_notified = true WHERE id = $1', [id]);
    },

    async deniedToNotify(): Promise<Array<{ id: string; discordUserId: string }>> {
      const result = await pool.query<{ id: string; discord_user_id: string }>(
        `SELECT id, discord_user_id FROM reset_requests
          WHERE status = 'denied' AND denial_notified = false AND discord_user_id IS NOT NULL LIMIT 20`,
      );
      return result.rows.map((r) => ({ id: r.id, discordUserId: String(r.discord_user_id) }));
    },

    async ackDenial(id: string): Promise<void> {
      await pool.query('UPDATE reset_requests SET denial_notified = true WHERE id = $1', [id]);
    },

    /** The operator's decision. Only an awaiting request can be decided, once. */
    async decide(id: string, decision: 'approve' | 'deny', operatorId: string): Promise<'ok' | 'not_found'> {
      await sweep();
      const t = at(now());
      const result = decision === 'approve'
        ? await pool.query<{ uuid: string }>(
          `UPDATE reset_requests SET status = 'approved', approved_at = $2, release_at = $3
            WHERE id = $1 AND status = 'awaiting_approval' AND expires_at > $2 RETURNING uuid`,
          [id, t, at(now() + releaseDelay())])
        : await pool.query<{ uuid: string }>(
          `UPDATE reset_requests SET status = 'denied'
            WHERE id = $1 AND status = 'awaiting_approval' AND expires_at > $2 RETURNING uuid`,
          [id, t]);
      if (!result.rows[0]) return 'not_found';
      await audit(id, result.rows[0].uuid, decision === 'approve' ? 'approved' : 'denied', operatorId);
      return 'ok';
    },

    /**
     * Codes whose random wait is over. The code is generated here, stored only
     * as a keyed hash, and returned exactly once (to the bot, for the DM).
     */
    async issueDeliveries(): Promise<DeliveryItem[]> {
      await sweep();
      const due = await pool.query<{ id: string }>(
        `SELECT id FROM reset_requests
          WHERE status = 'approved' AND code_hash IS NULL AND release_at <= $1 ORDER BY release_at LIMIT 10`,
        [at(now())],
      );
      const out: DeliveryItem[] = [];
      for (const { id } of due.rows) {
        const code = newCode();
        const expires = at(now() + CODE_TTL_MS);
        const issued = await pool.query<ResetRow>(
          `UPDATE reset_requests SET status = 'code_issued', code_hash = $2, code_expires_at = $3
            WHERE id = $1 AND status = 'approved' AND code_hash IS NULL
            RETURNING id, uuid, action, discord_user_id`,
          [id, codeHash(code), expires],
        );
        const r = issued.rows[0];
        if (!r || !r.discord_user_id) continue;
        await audit(id, r.uuid, 'code-issued');
        out.push({ id, action: r.action, discordUserId: String(r.discord_user_id), code, expiresAt: expires.toISOString() });
      }
      return out;
    },

    /** The DM could not be sent: the code is dead, the user starts again. */
    async deliveryFailed(id: string): Promise<void> {
      await pool.query(`UPDATE reset_requests SET status = 'failed' WHERE id = $1 AND status = 'code_issued'`, [id]);
      await audit(id, null, 'delivery-failed');
    },

    async publicStatus(id: string): Promise<PublicStatus | null> {
      await sweep();
      const r = await row(id);
      if (!r) return null;
      const map: Record<ResetStatus, PublicStatus['status']> = {
        pending_discord: 'waiting_discord', awaiting_approval: 'waiting_approval', approved: 'approved',
        code_issued: 'code_sent', done: 'done', denied: 'denied',
        expired: 'closed', cancelled: 'closed', failed: 'closed', burned: 'closed',
      };
      return {
        status: map[r.status] ?? 'closed',
        action: r.action,
        codeExpiresAt: r.status === 'code_issued' ? iso(r.code_expires_at) : null,
        expiresAt: iso(r.expires_at) ?? '',
      };
    },

    /** What the redeem route needs to validate input before it spends the code. */
    async actionFor(id: string): Promise<ResetAction | null> {
      const r = await row(id);
      return r ? r.action : null;
    },

    /**
     * Spend a code. Returns the setup and action only when the code is right,
     * unexpired and unused; the UPDATE is the single-use guarantee (two
     * simultaneous redeems cannot both match). A wrong code costs a try and the
     * fifth burns the request. Every failure looks the same to the caller.
     */
    async redeem(id: string, code: string): Promise<{ uuid: string; action: ResetAction } | null> {
      await sweep();
      const t = at(now());
      const spent = await pool.query<{ uuid: string; action: ResetAction }>(
        `UPDATE reset_requests SET status = 'done', used_at = $2
          WHERE id = $1 AND status = 'code_issued' AND code_expires_at > $2
            AND code_attempts < $4 AND code_hash = $3
          RETURNING uuid, action`,
        [id, t, codeHash(code), MAX_CODE_TRIES],
      );
      if (spent.rows[0]) {
        await audit(id, spent.rows[0].uuid, 'redeemed', spent.rows[0].action);
        return spent.rows[0];
      }
      const failed = await pool.query<{ code_attempts: number; uuid: string }>(
        `UPDATE reset_requests SET code_attempts = code_attempts + 1
          WHERE id = $1 AND status = 'code_issued' RETURNING code_attempts, uuid`,
        [id],
      );
      const f = failed.rows[0];
      if (f && f.code_attempts >= MAX_CODE_TRIES) {
        await pool.query(`UPDATE reset_requests SET status = 'burned' WHERE id = $1 AND status = 'code_issued'`, [id]);
        await audit(id, f.uuid, 'burned', 'too many wrong codes');
      }
      return null;
    },

    audit,
  };
}

export type ResetStore = ReturnType<typeof createResetStore>;

export interface ResetRequestsApi {
  createResetStore: typeof createResetStore;
  proveOwnership: typeof proveOwnership;
  hasProofKey: typeof hasProofKey;
  normaliseRequestId: typeof normaliseRequestId;
  normaliseCode: typeof normaliseCode;
  isSnowflake: typeof isSnowflake;
  newRequestId: typeof newRequestId;
  newCode: typeof newCode;
  RESET_MIGRATIONS: string[];
  CODE_TTL_MS: number;
  MAX_CODE_TRIES: number;
  MAX_RELEASE_DELAY_MS: number;
}
module.exports = {
  createResetStore, proveOwnership, hasProofKey, normaliseRequestId, normaliseCode, isSnowflake,
  newRequestId, newCode, RESET_MIGRATIONS, CODE_TTL_MS, MAX_CODE_TRIES, MAX_RELEASE_DELAY_MS,
} satisfies ResetRequestsApi;
