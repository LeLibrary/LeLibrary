'use strict';
// The Releases page's scoped session (v6.1).
//
// Everything here answers to a paired cookie (setup/favourites-pairing.ts), not
// to a setup link and not to the edit token. The cookie may only read/write one
// setup's favourites and ask how much of a handful of titles that setup holds.
// No catalogue, no stream, no key, nothing that could be used as an install
// link.
//
// Mutations are further restricted to same-origin requests, so another site
// cannot star or clear anything with the browser's cookie. Every handler is
// rate limited per IP.
import type { Express, Request, Response, Router } from 'express';
const express = require('express') as typeof import('express');
import type { PoolLike } from '../setup/config-store.ts';
import type { ConfigStore } from '../setup/config-store.ts';
import type { FavouritesApi } from '../setup/favourites-store.ts';
import type { FavouritesPairingApi } from '../setup/favourites-pairing.ts';
import type { ReviewApi } from '../library/review.ts';

const runtime = require('../setup/runtime.ts');
const configStore = require('../setup/config-store.ts') as ConfigStoreApi;
const favourites = require('../setup/favourites-store.ts') as FavouritesApi;
const pairing = require('../setup/favourites-pairing.ts') as FavouritesPairingApi;
const { rateLimit } = require('../middleware/rate-limit.ts') as {
  rateLimit: (options?: { windowMs?: number; max?: number; scope?: string }) => any;
};

interface ConfigStoreApi { toEngineConfig: (opened: unknown) => Record<string, unknown> }

const MAX_TITLES = 50;

type Context = {
  pool: PoolLike;
  uuid: string;
  pairingId: string;
  scopeId: string | null;
  lang: string;
  store: ConfigStore;
};

// Same-origin guard for anything that writes. Browsers send Origin on a JSON
// POST and Sec-Fetch-Site on every request; a request from another site has to
// say so, and one that says so is refused.
function sameOrigin(req: Request): boolean {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch { return false; }
}

function createFavouritesRouter(): { router: Router } {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  const pairLimit = rateLimit({ windowMs: 10 * 60_000, max: 10, scope: 'favourites-pair' });
  const readLimit = rateLimit({ windowMs: 60_000, max: 120, scope: 'favourites-read' });
  const writeLimit = rateLimit({ windowMs: 60_000, max: 40, scope: 'favourites-write' });
  const ownedLimit = rateLimit({ windowMs: 60_000, max: 60, scope: 'favourites-owned' });

  async function context(req: Request, res: Response): Promise<Context | null> {
    const pool = runtime.getSetupPool();
    if (!pool) { res.status(503).json({ error: 'Setup storage is unavailable on this instance' }); return null; }
    const token = pairing.tokenFromRequest(req);
    const session = token ? await pairing.resolve(pool, token) : null;
    if (!session) { res.status(401).json({ error: 'This browser is not linked to a setup yet.' }); return null; }
    const store = await runtime.getSetupStore();
    if (!store) { res.status(503).json({ error: 'Setup storage is unavailable on this instance' }); return null; }
    const opened = await store.resolveByUuid(session.uuid);
    if (!opened) { res.status(401).json({ error: 'This browser is not linked to a setup yet.' }); return null; }
    const config = configStore.toEngineConfig(opened);
    const providers = require('../providers/index.ts');
    return {
      pool,
      uuid: session.uuid,
      pairingId: session.id,
      scopeId: providers.activeProviders(config).length ? providers.getUserKey(config) : null,
      lang: typeof config['lang'] === 'string' ? (config['lang'] as string) : 'en-US',
      store,
    };
  }

  // Labels for a list of ids, when the library is available. Missing labels are
  // fine: the id is the answer, the name is a convenience.
  async function labelled(ctx: Context, items: { mediaType: 'movie' | 'series'; tmdbId: number; addedAt: string }[]) {
    if (!ctx.scopeId || !items.length) return items.map((item) => ({ ...item, title: '', year: null, poster: null }));
    let labels: { mediaType: string; tmdbId: number; title: string; year: string | null; poster: string | null }[] = [];
    try {
      labels = await (require('../library/review.ts') as ReviewApi).labels(ctx.scopeId, items);
    } catch { /* ids only */ }
    return items.map((item) => {
      const hit = labels.find((entry) => entry.tmdbId === item.tmdbId && entry.mediaType === item.mediaType);
      return { ...item, title: hit?.title || '', year: hit?.year || null, poster: hit?.poster || null };
    });
  }

  // Is this browser linked? The page asks once on load.
  router.get('/status', readLimit, async (req: Request, res: Response) => {
    const pool = runtime.getSetupPool();
    if (!pool) { res.json({ linked: false }); return; }
    const token = pairing.tokenFromRequest(req);
    const session = token ? await pairing.resolve(pool, token) : null;
    res.json({ linked: Boolean(session) });
  });

  // Redeem the code the setup page showed. Sets the scoped cookie.
  router.post('/pair', pairLimit, async (req: Request, res: Response) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    const pool = runtime.getSetupPool();
    if (!pool) { res.status(503).json({ error: 'Setup storage is unavailable on this instance' }); return; }
    const store = await runtime.getSetupStore();
    if (!store) { res.status(503).json({ error: 'Setup storage is unavailable on this instance' }); return; }
    const uuid = pairing.redeemCode((req.body ?? {})['code']);
    if (!uuid) { res.status(400).json({ error: 'That code is wrong or has expired. Make a new one on your setup page.' }); return; }
    const opened = await store.resolveByUuid(uuid);
    if (!opened) { res.status(400).json({ error: 'That code is wrong or has expired. Make a new one on your setup page.' }); return; }
    const issued = await pairing.issue(pool, uuid, (req.body ?? {})['label']);
    if (!issued) { res.status(503).json({ error: 'Could not link this browser. Try again.' }); return; }
    res.setHeader('Set-Cookie', pairing.cookieString(issued.token, pairing.isSecure(req)));
    const items = await favourites.list(pool, uuid);
    res.json({ linked: true, items: await labelled({ pool, uuid, pairingId: issued.id, scopeId: null, lang: 'en-US', store }, items) });
  });

  router.post('/disconnect', writeLimit, async (req: Request, res: Response) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    const pool = runtime.getSetupPool();
    if (!pool) { res.json({ linked: false }); return; }
    const token = pairing.tokenFromRequest(req);
    const session = token ? await pairing.resolve(pool, token) : null;
    if (session) await pairing.revoke(pool, session.uuid, session.id);
    res.setHeader('Set-Cookie', pairing.clearCookieString(pairing.isSecure(req)));
    res.json({ linked: false });
  });

  router.get('/', readLimit, async (req: Request, res: Response) => {
    const ctx = await context(req, res);
    if (!ctx) return;
    const items = await favourites.list(ctx.pool, ctx.uuid);
    res.json({ linked: true, items: await labelled(ctx, items), limit: favourites.MAX_FAVOURITES });
  });

  // Star or unstar. `wanted` defaults to true so a plain POST still adds.
  router.post('/', writeLimit, async (req: Request, res: Response) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    const ctx = await context(req, res);
    if (!ctx) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wanted = body['wanted'] !== false;
    const result = await favourites.set(ctx.pool, ctx.uuid, body['mediaType'], body['tmdbId'], wanted);
    if (result === 'invalid') { res.status(400).json({ error: 'Invalid favourite' }); return; }
    if (result === 'full') { res.status(409).json({ error: `You can keep up to ${favourites.MAX_FAVOURITES} favourites` }); return; }
    res.json({ saved: result !== 'removed', resulted: result });
  });

  router.delete('/:mediaType/:tmdbId', writeLimit, async (req: Request, res: Response) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    const ctx = await context(req, res);
    if (!ctx) return;
    const removed = await favourites.remove(ctx.pool, ctx.uuid, req.params.mediaType, req.params.tmdbId);
    res.json({ removed });
  });

  // "Do I have this, and how much of it?" One call per title page, batched for
  // up to 50 ids. Counts only.
  router.post('/owned', ownedLimit, async (req: Request, res: Response) => {
    if (!sameOrigin(req)) { res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return; }
    const ctx = await context(req, res);
    if (!ctx) return;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const items = (Array.isArray(raw['items']) ? raw['items'] : []).slice(0, MAX_TITLES);
    if (!ctx.scopeId) { res.json({ items: [] }); return; }
    const review = require('../library/review.ts') as ReviewApi;
    let owned: { mediaType: string; tmdbId: number; owned: boolean; seasons: { season: number; owned: number }[] }[] = [];
    try {
      owned = await review.ownedState(ctx.scopeId, items as { tmdbId?: unknown; mediaType?: unknown }[]);
    } catch {
      res.status(503).json({ error: 'Your library is not answering right now.' });
      return;
    }
    // Season lengths come from the Releases database, so the page can say
    // "S2 fully, S3 4 of 10" instead of a raw episode count.
    const seriesIds = owned.filter((entry) => entry.mediaType === 'series').map((entry) => entry.tmdbId);
    const totals = new Map<string, number>();
    if (seriesIds.length) {
      try {
        const releasesDb = require('../releases/db.ts');
        if (await releasesDb.ensureSchema()) {
          const { rows } = await releasesDb.getPool().query(
            'SELECT show_tmdb_id, season_number, episode_count FROM release_seasons WHERE show_tmdb_id = ANY($1::int[])',
            [seriesIds]
          );
          for (const row of rows as Record<string, unknown>[]) {
            const total = review.seasonTotal(row['episode_count']);
            if (total !== null) totals.set(`${Number(row['show_tmdb_id'])}:${Number(row['season_number'])}`, total);
          }
        }
      } catch { /* no totals: the counts still answer */ }
    }
    res.json({
      items: owned.map((entry) => ({
        mediaType: entry.mediaType,
        tmdbId: entry.tmdbId,
        owned: entry.owned,
        seasons: entry.seasons.map((season) => ({
          season: season.season,
          owned: season.owned,
          total: totals.get(`${entry.tmdbId}:${season.season}`) ?? null,
        })),
      })),
    });
  });

  return { router };
}

function mountFavouritesRoutes(app: Express): void {
  const { router } = createFavouritesRouter();
  app.use('/api/favourites', router);
}

export interface FavouritesRoutesApi {
  createFavouritesRouter: typeof createFavouritesRouter;
  mountFavouritesRoutes: typeof mountFavouritesRoutes;
}

module.exports = { createFavouritesRouter, mountFavouritesRoutes } satisfies FavouritesRoutesApi;
