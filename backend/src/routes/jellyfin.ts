// The Jellyfin plan endpoint: GET /{uuid}.{secret}/jellyfin/config.json.
//
// One read-only document, addressed by the setup install URL (the URL is the
// read capability, exactly like every other addon read). It carries selection,
// names, ids and art URLs only - never a key, token or secret - so a Jellyfin
// server can build a library without us seeing a byte of playback traffic.
//
// Data comes from the existing library projection, so this costs the same as a
// catalog read and stays inside the matched-item rules (never guess).
import type { Request, Response } from 'express';

const catalog = require('../library/catalog.ts') as {
  assembleMetas: (rows: any[], userKey?: string) => any[];
  filterRows: (rows: any[], state: any, kind: 'movies' | 'series') => Promise<any[]>;
};
const providers = require('../providers/index.ts') as {
  activeProviders: (config: any) => string[];
  getUserKey: (config: any) => string;
};
const { normalizeContentFilters, metaExcluded } = require('../catalog/content-filters.ts') as {
  normalizeContentFilters: (config: unknown) => { hideAnime: boolean; hideAdult: boolean; excludeCategories: string[] };
  metaExcluded: (meta: any, state: any, mediaType: 'movie' | 'tv') => boolean;
};
const { hashShort } = require('../runtime/cache-fingerprint.ts') as { hashShort: (value: unknown) => string };
const { buildPlan } = require('../jellyfin/plan.ts') as {
  buildPlan: (input: any) => { plan: any; skipped: number };
};

const PLUGIN_LIBRARY_TYPES = ['movie', 'series', 'anime'];

export interface JellyfinRouteDeps {
  resolveConfig: (token: string) => Promise<any>;
  // Injected in tests; production reads the indexed library.
  catalogRows?: (scopeId: string, mediaType: string, provider?: string) => Promise<any[]>;
  // When this scope last completed a sync. Null means never: an empty plan
  // would read as "delete everything", so it is a 503 instead.
  scopeSynced?: (scopeId: string) => Promise<unknown>;
  // Row-level content filters, shared with the Library catalog.
  filterRows?: (rows: any[], state: any, kind: 'movies' | 'series') => Promise<any[]>;
  // Library change fingerprint. Null means unknown: no caching, so a plan can
  // never be served stale.
  fingerprint?: (scopeId: string) => string | null;
  // Distinguishes "no database" from "empty library".
  libraryDb?: () => boolean;
  now?: () => number;
}

export interface JellyfinRoutesApi {
  mountJellyfinRoutes: (app: any, deps: JellyfinRouteDeps) => void;
  planFor: (input: { token: string; config: any; baseUrl: string; deps: JellyfinRouteDeps }) => Promise<any>;
}

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function defaultCatalogRows(): (scopeId: string, mediaType: string, provider?: string) => Promise<any[]> {
  const store = require('../library/store.ts') as {
    catalogRows: (scopeId: string, mediaType: string, provider?: string) => Promise<any[]>;
  };
  return (scopeId, mediaType, provider) => store.catalogRows(scopeId, mediaType, provider);
}

function defaultScopeSynced(): (scopeId: string) => Promise<unknown> {
  const store = require('../library/store.ts') as { scopeLastSync: (scopeId: string) => Promise<unknown> };
  return (scopeId) => store.scopeLastSync(scopeId);
}

function defaultFingerprint(): (scopeId: string) => string | null {
  const engine = require('../library/engine.ts') as { _registry: Map<string, any> };
  return (scopeId) => {
    const rec = engine._registry.get(scopeId);
    return rec ? `${rec.catalogFp || 0}:${rec.identityVersion || 0}` : null;
  };
}

function defaultLibraryDb(): boolean {
  try {
    const db = require('../library/db.ts') as { getPool: () => unknown };
    return Boolean(db.getPool());
  } catch {
    return false;
  }
}

// The plan for one setup. Throws an Error carrying `status` for the route to
// translate: 409 when the setup has no usable provider, 503 when the library
// cannot be read (never an empty plan - that would read as "delete everything").
async function planFor({ token, config, baseUrl, deps }: { token: string; config: any; baseUrl: string; deps: JellyfinRouteDeps }): Promise<any> {
  const active = providers.activeProviders(config);
  if (!active.length) throw statusError(409, 'no debrid provider configured');
  // An empty plan is a deletion instruction to the plugin, and the real reader
  // returns [] when there is no pool at all. Refuse instead of serving empty.
  // An injected reader owns that decision itself (tests, and any future caller).
  const injectedReader = typeof deps.catalogRows === 'function';
  const libraryDb = deps.libraryDb || defaultLibraryDb;
  if (!injectedReader && !libraryDb()) throw statusError(503, 'library unavailable');
  const scopeId = providers.getUserKey(config);
  if (!scopeId) throw statusError(409, 'no debrid provider configured');

  const scopeSynced = deps.scopeSynced || defaultScopeSynced();
  if (!(await scopeSynced(scopeId))) throw statusError(503, 'library unavailable');

  // One provider per plan: the keys carry the provider name, and the plugin
  // matches them against its own listing. A multi-provider setup gets the first
  // active provider (documented limitation of the v0.1 plugin).
  const provider = active[0];
  const catalogRows = deps.catalogRows || defaultCatalogRows();
  const filterRows = deps.filterRows || catalog.filterRows;
  const state = normalizeContentFilters(config);

  const rowGroups = await Promise.all(PLUGIN_LIBRARY_TYPES.map(async (mediaType) => {
    try {
      const rows = await catalogRows(scopeId, mediaType, provider);
      return await filterRows(rows, state, mediaType === 'movie' ? 'movies' : 'series');
    } catch (err: any) {
      // A reader or genre-facts failure is "library unavailable", not a bad
      // request: the plugin must keep its files rather than see an empty plan.
      throw Object.assign(new Error(err && err.message || 'library read failed'), { status: 503 });
    }
  }));
  const rows = rowGroups.flat();

  const metas = catalog.assembleMetas(rows, '')
    .filter((meta) => !metaExcluded(meta, state, meta?.catalogType === 'movie' ? 'movie' : 'tv'));
  const now = deps.now ? deps.now() : Date.now();
  const { plan, skipped } = buildPlan({
    provider,
    baseUrl,
    metas,
    erdbToken: textOf(config.erdbToken),
    now,
  });
  if (skipped) console.log(`[Jellyfin] plan for scope ${hashShort(scopeId)} skipped ${skipped} item(s)`);
  return plan;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// One entry per scope+library state. Bounded: the last three plans only, kept as
// the serialized body so a conditional request costs a string compare instead of
// a 12 MB rebuild.
const PLAN_CACHE_MAX = 3;
const planCache = new Map<string, { etag: string; body: string }>();
const planInFlight = new Map<string, Promise<{ etag: string; body: string }>>();

function cachePlan(key: string, value: { etag: string; body: string }): void {
  planCache.set(key, value);
  while (planCache.size > PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest === undefined) break;
    planCache.delete(oldest);
  }
}

async function planResponse({ token, config, baseUrl, deps }: { token: string; config: any; baseUrl: string; deps: JellyfinRouteDeps }): Promise<{ etag: string; body: string }> {
  const scopeId = providers.getUserKey(config);
  const fingerprint = (deps.fingerprint || defaultFingerprint())(scopeId);
  const key = fingerprint ? `${scopeId}:${fingerprint}` : null;
  if (key) {
    const hit = planCache.get(key);
    if (hit) return hit;
    const pending = planInFlight.get(key);
    if (pending) return pending;
  }

  const build = (async () => {
    const plan = await planFor({ token, config, baseUrl, deps });
    // Fingerprint everything except the timestamp, so a 304 stays valid while
    // the body still reports when it was built.
    const etag = `"${hashShort(JSON.stringify({ ...plan, generatedAt: '' }))}"`;
    const value = { etag, body: JSON.stringify(plan) };
    if (key) cachePlan(key, value);
    return value;
  })();

  if (key) {
    planInFlight.set(key, build);
    build.catch(() => {}).finally(() => planInFlight.delete(key));
  }
  return build;
}

function mountJellyfinRoutes(app: any, deps: JellyfinRouteDeps): void {
  app.get('/:token/jellyfin/config.json', async (req: Request, res: Response) => {
    const token = String((req.params as any).token || '');
    let config: any = null;
    try {
      config = await deps.resolveConfig(token);
    } catch {
      config = null;
    }
    if (!config) { res.status(400).json({ success: false, error: 'invalid token' }); return; }

    const baseUrl = `${req.protocol}://${req.get('host')}/${token}`;
    let response: { etag: string; body: string };
    try {
      response = await planResponse({ token, config, baseUrl, deps });
    } catch (err: any) {
      const status = err && (err.status === 409 || err.status === 503) ? err.status : 500;
      if (status === 500) console.error('[Jellyfin] plan failed:', err && err.message);
      res.status(status).json({
        success: false,
        error: status === 409 ? 'no debrid provider configured'
          : status === 503 ? 'library unavailable'
            : 'could not build the plan',
      });
      return;
    }

    res.setHeader('ETag', response.etag);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (isNotModified(req.headers['if-none-match'], response.etag)) { res.status(304).end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(response.body);
  });
}

// Weak comparison, comma lists and `*` are all legal If-None-Match forms and a
// proxy or player may send any of them.
function isNotModified(header: unknown, etag: string): boolean {
  const value = typeof header === 'string' ? header.trim() : '';
  if (!value) return false;
  if (value === '*') return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, '');
  return value.split(',').some((tag) => strip(tag) === strip(etag));
}

module.exports = { mountJellyfinRoutes, planFor } satisfies JellyfinRoutesApi;
