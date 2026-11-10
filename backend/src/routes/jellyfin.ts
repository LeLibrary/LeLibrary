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

export interface JellyfinRouteDeps {
  resolveConfig: (token: string) => Promise<any>;
  // Injected in tests; production reads the indexed library.
  catalogRows?: (scopeId: string, mediaType: string) => Promise<any[]>;
  // Distinguishes "no database" from "empty library". An empty plan is a
  // deletion instruction to the plugin, so a missing pool must be a 503.
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

function defaultCatalogRows(): (scopeId: string, mediaType: string) => Promise<any[]> {
  const store = require('../library/store.ts') as { catalogRows: (scopeId: string, mediaType: string) => Promise<any[]> };
  return (scopeId, mediaType) => store.catalogRows(scopeId, mediaType);
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
  const catalogRows = deps.catalogRows || defaultCatalogRows();
  const rows = (await Promise.all(
    ['movie', 'series', 'anime'].map((mediaType) => catalogRows(scopeId, mediaType))
  )).flat();
  const filters = normalizeContentFilters(config);
  const metas = catalog.assembleMetas(rows, '')
    .filter((meta) => !metaExcluded(meta, filters, meta?.catalogType === 'movie' ? 'movie' : 'tv'));
  const now = deps.now ? deps.now() : Date.now();
  const { plan } = buildPlan({ provider: active[0], baseUrl, metas, now });
  return plan;
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
    let plan: any;
    try {
      plan = await planFor({ token, config, baseUrl, deps });
    } catch (err: any) {
      const status = err && err.status === 409 ? 409 : 503;
      res.status(status).json({ success: false, error: status === 409 ? 'no debrid provider configured' : 'library unavailable' });
      return;
    }

    // Fingerprint everything except the timestamp, so a 304 stays valid while
    // the body still reports when it was built.
    const etag = `"${hashShort(JSON.stringify({ ...plan, generatedAt: '' }))}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.json(plan);
  });
}

module.exports = { mountJellyfinRoutes, planFor } satisfies JellyfinRoutesApi;
