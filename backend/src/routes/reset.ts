// Password reset and setup deletion (v6), see setup/reset-requests.ts for the
// flow. Two surfaces:
//   /api/reset      public: the website form, the status poll, the redeem step
//   /api/bot/reset  the Discord bot only: HMAC-signed, nothing else is accepted
//
// The feature is off unless RESET_BOT_SECRET (32+ chars) and
// RESET_OPERATOR_DISCORD_ID are set, so self-hosters are unaffected.
import type { Express, Request, Response, NextFunction } from 'express';
import type { ConfigStore } from '../setup/config-store.ts';
import type { EditSessionStore } from '../setup/edit-sessions.ts';
import type { ResetRequestsApi, ResetStore } from '../setup/reset-requests.ts';
import type { RuntimeApi } from '../setup/runtime.ts';
import type { TokenApi } from '../setup/token.ts';
import type { RateLimitApi as PasswordLimiterApi } from '../setup/rate-limit.ts';
import type { BoundedMapApi } from '../runtime/bounded-map.ts';

const crypto = require('node:crypto') as typeof import('node:crypto');
const express = require('express') as typeof import('express');
const resets = require('../setup/reset-requests.ts') as ResetRequestsApi;
const runtime = require('../setup/runtime.ts') as RuntimeApi;
const tokens = require('../setup/token.ts') as TokenApi;
const { createPasswordLimiter } = require('../setup/rate-limit.ts') as PasswordLimiterApi;
const { boundedSet } = require('../runtime/bounded-map.ts') as BoundedMapApi;
const { rateLimit } = require('../middleware/rate-limit.ts') as {
  rateLimit: (options?: { windowMs?: number; max?: number; scope?: string }) => any;
};

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const SIGNATURE_WINDOW_MS = 60_000;

export interface ResetRoutesOptions {
  editSessions?: EditSessionStore;
  // Test seams: production resolves the lazy Postgres stores.
  getStore?: () => Promise<ConfigStore | null>;
  getResetStore?: () => Promise<ResetStore | null>;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface ResetRoutesApi {
  mountResetRoutes: (app: Express, options?: ResetRoutesOptions) => void;
  signBotRequest: (secret: string, method: string, path: string, body: string, ts: number) => string;
}

function clientIp(req: Request): string {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function ipHash(ip: string): string {
  return crypto.createHash('sha256').update(`reset-ip:${ip}`).digest('hex').slice(0, 16);
}

/** The signature the bot sends: HMAC over timestamp, method, path and body hash. */
function signBotRequest(secret: string, method: string, path: string, body: string, ts: number): string {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', secret).update(`${ts}\n${method.toUpperCase()}\n${path}\n${bodyHash}`).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function mountResetRoutes(app: Express, options: ResetRoutesOptions = {}): void {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const botSecret = String(env['RESET_BOT_SECRET'] ?? '').trim();
  const operatorId = String(env['RESET_OPERATOR_DISCORD_ID'] ?? '').trim();
  const enabled = botSecret.length >= 32 && resets.isSnowflake(operatorId);
  // Default: the proof is the check and the operator is only told. With
  // RESET_REQUIRE_APPROVAL=on every request waits for the operator's button.
  const requireApproval = ['on', 'true', '1', 'yes'].includes(String(env['RESET_REQUIRE_APPROVAL'] ?? '').trim().toLowerCase());

  // Failed proofs per setup and per IP. Separate from the password limiter so
  // guessing keys here cannot lock the real owner out of unlock.
  const proofLimiter = createPasswordLimiter({ maxPerUuid: 5, maxPerIp: 10, lockoutMs: 15 * 60_000, windowMs: 10 * 60_000 });
  const seenSignatures = new Map<string, number>();

  const getStore = options.getStore ?? (() => runtime.getSetupStore());
  let resetStorePromise: Promise<ResetStore | null> | null = null;
  const getResetStore = options.getResetStore ?? (() => {
    if (!resetStorePromise) {
      resetStorePromise = (async () => {
        const pool = runtime.getSetupPool();
        if (!pool) return null;
        const { loadServerKey } = require('../setup/keys.ts') as { loadServerKey: () => Buffer | null };
        const key = loadServerKey();
        if (!key) return null;
        const store = resets.createResetStore({ pool, key });
        await store.migrate();
        return store;
      })().catch((error: unknown) => { resetStorePromise = null; throw error; });
    }
    return resetStorePromise;
  });

  async function stores(res: Response): Promise<{ config: ConfigStore; reset: ResetStore } | null> {
    try {
      const [config, reset] = await Promise.all([getStore(), getResetStore()]);
      if (config && reset) return { config, reset };
    } catch { /* fall through to 503 */ }
    if (!res.headersSent) res.status(503).json({ error: 'Setup storage is unavailable on this instance' });
    return null;
  }

  function ensureEnabled(_req: Request, res: Response, next: NextFunction): void {
    if (!enabled) { res.status(404).json({ error: 'Not found' }); return; }
    next();
  }

  async function turnstileBlocked(req: Request, res: Response, action: string): Promise<boolean> {
    const turnstile = require('../platform/turnstile.ts');
    const state = turnstile.turnstileRequestState(req);
    if (!state.enforced) return false;
    const verdict = await turnstile.verifyTurnstile((req.body as Record<string, unknown> | undefined)?.['cf-turnstile-response'], {
      action, remoteip: clientIp(req),
    });
    if (verdict.ok) return false;
    if (verdict.error === 'verify-unreachable') return false;
    res.status(403).json({ error: 'Bot check failed. Reload the page and try again.' });
    return true;
  }

  // ---- public ---------------------------------------------------------------
  const pub = express.Router();
  pub.use(express.json({ limit: '8kb' }));

  pub.get('/config', (req: Request, res: Response) => {
    const turnstile = require('../platform/turnstile.ts');
    const state = turnstile.turnstileRequestState(req);
    res.json({ enabled, siteKey: enabled ? state.siteKey : '', requiresApproval: enabled && requireApproval });
  });

  pub.use(ensureEnabled);

  // Step 1: prove the setup is yours. Same answer for every kind of mismatch.
  pub.post('/request', rateLimit({ windowMs: 10 * 60_000, max: 10, scope: 'reset-request' }), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body['action'];
    if (action !== 'reset' && action !== 'delete') { res.status(400).json({ error: 'Choose reset or delete.' }); return; }
    if (typeof body['installToken'] !== 'string' || typeof body['key'] !== 'string') {
      res.status(400).json({ error: 'Enter your install link and one of your saved API keys.' });
      return;
    }
    if (await turnstileBlocked(req, res, 'reset-request')) return;
    const s = await stores(res);
    if (!s) return;

    const ip = clientIp(req);
    // The install link names the setup; a malformed or unknown one is limited
    // under one shared bucket so it still costs the caller attempts.
    const parsed = tokens.parseInstallToken(String(body['installToken']).trim().replace(/^.*\/([0-9a-f-]{36}\.[^/]+)\/manifest\.json.*$/i, '$1'));
    const limitKey = parsed ? parsed.uuid : 'unparsed';
    const gate = proofLimiter.check(ip, limitKey);
    if (!gate.allowed) {
      res.set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    const MISMATCH = 'Those details did not match this setup.';
    const opened = parsed ? await s.config.resolveByToken(`${parsed.uuid}.${parsed.secret}`).catch(() => null) : null;
    // Evaluated even when there is no setup so the work done is the same.
    const proved = resets.proveOwnership(opened, body['key']);
    if (!opened || !proved) {
      proofLimiter.fail(ip, limitKey);
      if (opened) await s.reset.audit(null, opened.uuid, 'proof-failed', 'wrong key');
      res.status(401).json({ error: MISMATCH });
      return;
    }
    if (!opened.hasPassword) {
      res.status(409).json({ error: 'This setup has no password. Open it with your install link instead.' });
      return;
    }
    const created = await s.reset.create({ uuid: opened.uuid, action, ipHash: ipHash(ip) });
    res.json({ requestId: created.id, expiresAt: created.expiresAt, action });
  });

  // Where is my request? The request id is the capability; it says nothing
  // about the setup behind it.
  pub.get('/status/:id', rateLimit({ windowMs: 60_000, max: 60, scope: 'reset-status' }), async (req: Request, res: Response) => {
    const id = resets.normaliseRequestId(req.params['id']);
    if (!id) { res.status(404).json({ error: 'Request not found' }); return; }
    const s = await stores(res);
    if (!s) return;
    const status = await s.reset.publicStatus(id);
    if (!status) { res.status(404).json({ error: 'Request not found' }); return; }
    res.set('Cache-Control', 'no-store');
    res.json(status);
  });

  // Step 3: the code from the DM, then the user's own new password (or the
  // deletion confirmation). The code is only spent once the input is valid.
  pub.post('/redeem', rateLimit({ windowMs: 60_000, max: 12, scope: 'reset-redeem' }), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = resets.normaliseRequestId(body['requestId']);
    const code = resets.normaliseCode(body['code']);
    const BAD = 'That code is not valid. It may have expired or been used.';
    if (!id || !code) { res.status(400).json({ error: BAD }); return; }
    const s = await stores(res);
    if (!s) return;
    const action = await s.reset.actionFor(id);
    if (!action) { res.status(400).json({ error: BAD }); return; }
    if (action === 'reset') {
      const password = body['newPassword'];
      if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
        res.status(400).json({ error: `Choose a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.` });
        return;
      }
    } else if (body['confirmDelete'] !== true) {
      res.status(400).json({ error: 'Confirm that you want this setup deleted.' });
      return;
    }
    const spent = await s.reset.redeem(id, code);
    if (!spent) { res.status(400).json({ error: BAD }); return; }

    if (spent.action === 'reset') {
      await s.config.setPassword(spent.uuid, body['newPassword'] as string);
      options.editSessions?.revokeUuid(spent.uuid);
      runtime.getSetupLimiter().succeed(clientIp(req), spent.uuid);
      console.warn(`[reset] password reset uuid=${spent.uuid.slice(0, 8)}`);
      res.json({ ok: true, action: 'reset' });
      return;
    }
    const removed = await s.config.remove(spent.uuid);
    options.editSessions?.revokeUuid(spent.uuid);
    try {
      const nuvioBackups = require('../nuvio/backups.ts').defaultBackupStore();
      if (nuvioBackups) await nuvioBackups.removeAll(spent.uuid);
    } catch { /* best effort, as in the signed-in delete */ }
    console.warn(`[reset] deleted setup uuid=${spent.uuid.slice(0, 8)} removed=${removed}`);
    res.json({ ok: true, action: 'delete' });
  });

  app.use('/api/reset', pub);

  // ---- bot ------------------------------------------------------------------
  const bot = express.Router();
  bot.use(ensureEnabled);
  bot.use(express.json({
    limit: '8kb',
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  // Every call is signed; an unsigned, stale or replayed one is a plain 401.
  bot.use((req: Request, res: Response, next: NextFunction) => {
    const ts = Number(req.header('x-ll-ts'));
    const sig = String(req.header('x-ll-sig') ?? '');
    const fail = () => { res.status(401).json({ error: 'Unauthorized' }); };
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > SIGNATURE_WINDOW_MS || !/^[0-9a-f]{64}$/.test(sig)) { fail(); return; }
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const expected = signBotRequest(botSecret, req.method, req.originalUrl.split('?')[0] ?? '', raw, ts);
    if (!safeEqualHex(expected, sig)) { fail(); return; }
    if (seenSignatures.has(sig)) { fail(); return; }
    boundedSet(seenSignatures, sig, ts, 2000, (at) => now() - at > SIGNATURE_WINDOW_MS * 2);
    next();
  });

  // The bot's one regular call: new approvals to show the operator, denials to
  // tell users about, and codes whose wait is over (issued here, once).
  bot.post('/poll', async (_req: Request, res: Response) => {
    const s = await stores(res);
    if (!s) return;
    const [approvals, denials, deliveries] = await Promise.all([
      s.reset.pendingApprovals(), s.reset.deniedToNotify(), s.reset.issueDeliveries(),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ approvals, denials, deliveries });
  });

  bot.post('/:id/link', async (req: Request, res: Response) => {
    const id = resets.normaliseRequestId(req.params['id']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!id || !resets.isSnowflake(body['discordUserId'])) { res.status(404).json({ error: 'not_found' }); return; }
    const s = await stores(res);
    if (!s) return;
    const result = await s.reset.link(id, body['discordUserId'], String(body['discordName'] ?? ''), !requireApproval);
    if (result === 'ok') { res.json({ ok: true, action: await s.reset.actionFor(id) }); return; }
    res.status(result === 'limited' ? 429 : 404).json({ error: result });
  });

  bot.post('/:id/decision', async (req: Request, res: Response) => {
    const id = resets.normaliseRequestId(req.params['id']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Defence in depth: the bot checks the operator too, the server insists.
    if (!id || body['operatorId'] !== operatorId || (body['decision'] !== 'approve' && body['decision'] !== 'deny')) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const s = await stores(res);
    if (!s) return;
    const result = await s.reset.decide(id, body['decision'], operatorId);
    res.status(result === 'ok' ? 200 : 404).json(result === 'ok' ? { ok: true } : { error: 'not_found' });
  });

  bot.post('/:id/ack', async (req: Request, res: Response) => {
    const id = resets.normaliseRequestId(req.params['id']);
    const kind = (req.body as Record<string, unknown> | undefined)?.['kind'];
    if (!id || (kind !== 'approval' && kind !== 'denial')) { res.status(404).json({ error: 'not_found' }); return; }
    const s = await stores(res);
    if (!s) return;
    if (kind === 'approval') await s.reset.ackApproval(id); else await s.reset.ackDenial(id);
    res.json({ ok: true });
  });

  bot.post('/:id/delivery-failed', async (req: Request, res: Response) => {
    const id = resets.normaliseRequestId(req.params['id']);
    if (!id) { res.status(404).json({ error: 'not_found' }); return; }
    const s = await stores(res);
    if (!s) return;
    await s.reset.deliveryFailed(id);
    res.json({ ok: true });
  });

  app.use('/api/bot/reset', bot);
}

module.exports = { mountResetRoutes, signBotRequest } satisfies ResetRoutesApi;
