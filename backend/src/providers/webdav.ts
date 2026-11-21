'use strict';
// WebDAV library source (self-host only): a NAS, rclone `serve webdav`,
// Nextcloud or Synology share becomes a library like a debrid account.
//
// Off unless WEBDAV_SOURCE=on. A server on the local network (or loopback)
// also needs WEBDAV_ALLOW_PRIVATE=on, so a shared install cannot be pointed at
// its own network; plain HTTP is only accepted for such private servers, never
// across the internet (the password would travel in clear text).
//
// The crawl asks for one folder level at a time (explicit Depth: 1 on every
// request: Apache/nginx refuse "infinity", Sabre quietly downgrades it, rclone
// treats a missing Depth as the whole tree) and gives up past fixed limits
// rather than returning half a library, so a partial scan can never empty an
// indexed library. A finished scan is reused for WEBDAV_SCAN_MINUTES.
//
// One item per folder that holds videos ("Breaking Bad/Season 1" becomes
// "Breaking Bad Season 1"); videos loose in the top folder or in a category
// folder ("Movies") are one item each. File ids are base64url of the path
// below the server address, so playback needs no lookup.
//
// Never logged: the address, user, password, folder or file names.

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const axios = require('axios');
const { PROPFIND_BODY, parseMultistatus, hrefToPath, encodePath } = require('./webdav-xml.ts');
const { isBlockedIp } = require('../streams/aiostreams.ts');
const { looksGeneric, isSeasonLike } = require('./folder-items.ts');

const SCAN_MAX_ENTRIES = 50000;
const SCAN_MAX_DEPTH = 8;
const SCAN_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
const SIDE_FILE_MAX_BYTES = 1024 * 1024;
const VIDEO_RE = /\.(mkv|mp4|avi|m4v|ts|m2ts|webm|mov|wmv)$/i;
const SIDE_RE = /\.(nfo|sfv)$/i;

export type DavErrorCode = 'disabled' | 'bad-url' | 'blocked-host' | 'insecure-http' | 'unreachable' | 'auth' | 'not-webdav' | 'timeout' | 'too-large';
export interface DavConnection { base: URL; basePath: string; auth: string; scopeSeed: string; cacheKey: string }
export interface DavFile { id: string; name: string; short_name: string; size: number }
export interface WebdavItem {
  id: string; name: string; filename: string; source: 'webdav'; size: number;
  created_at?: string; updated_at?: string; download_finished: true; download_state: 'completed';
  files: DavFile[];
}

function webdavEnabled(env: Record<string, any> = process.env): boolean {
  return String(env.WEBDAV_SOURCE || '').toLowerCase() === 'on';
}

function allowPrivate(env: Record<string, any> = process.env): boolean {
  return String(env.WEBDAV_ALLOW_PRIVATE || '').toLowerCase() === 'on';
}

function scanConcurrency(env: Record<string, any> = process.env): number {
  const value = Number(env.WEBDAV_CONCURRENCY);
  return Number.isFinite(value) && value > 0 ? Math.min(16, Math.max(1, Math.floor(value))) : SCAN_CONCURRENCY;
}

function scanTtlMs(env: Record<string, any> = process.env): number {
  const minutes = Number(env.WEBDAV_SCAN_MINUTES);
  return Math.max(5, Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
}

function davError(code: DavErrorCode): Error & { code: DavErrorCode } {
  return Object.assign(new Error(`webdav ${code}`), { code });
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function davConnection(config: any): DavConnection | null {
  const raw = String((config && config.webdavUrl) || '').trim();
  if (!raw) return null;
  let base: URL;
  try { base = new URL(raw); } catch { return null; }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  if (base.username || base.password) return null;
  base.hash = '';
  base.search = '';
  const basePath = hrefToPath(base.pathname);
  const user = String((config && config.webdavUser) || '');
  const password = String((config && config.webdavPassword) || '');
  const auth = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
  const scopeSeed = `${base.origin}${basePath}|${user}`;
  return { base, basePath, auth, scopeSeed, cacheKey: `davscan:${sha256(`${scopeSeed}|${sha256(auth)}`)}` };
}

// Resolve once, enforce the host rules, and pin the request to that address
// (no DNS rebinding between the check and the request).
async function pinnedFor(base: URL): Promise<(host: string, options: any, cb: any) => void> {
  const host = base.hostname.replace(/^\[|\]$/g, '');
  let records: { address: string; family: number }[];
  try {
    records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  } catch { throw davError('unreachable'); }
  if (!records.length) throw davError('unreachable');
  const isPrivate = records.some((record) => isBlockedIp(record.address));
  if (isPrivate && !allowPrivate()) throw davError('blocked-host');
  if (!isPrivate && base.protocol === 'http:') throw davError('insecure-http');
  // Prefer IPv4 when a name has both: "localhost" lists ::1 first, while
  // rclone and most NAS servers listen on IPv4 only.
  const { address, family } = records.find((record) => record.family === 4) || records[0];
  return (_host, options, cb) => {
    if (options && options.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

function requestError(err: any): Error & { code: DavErrorCode } {
  if (err && typeof err.code === 'string' && ['disabled', 'bad-url', 'blocked-host', 'insecure-http', 'unreachable', 'auth', 'not-webdav', 'timeout', 'too-large'].includes(err.code)) return err;
  const message = String((err && err.message) || '');
  if (/maxContentLength|maxBodyLength/i.test(message)) return davError('too-large');
  if (err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(message))) return davError('timeout');
  return davError('unreachable');
}

// One request to the WebDAV server, at `path` (decoded, absolute on the
// server). Callers decide what a status means; nothing is followed.
async function davRequest(conn: DavConnection, { method, path, url, headers = {}, data, responseType = 'text', timeout = REQUEST_TIMEOUT_MS, maxContentLength = MAX_LISTING_BYTES, decompress = true, signal, auth = true }: {
  method: string; path?: string; url?: URL; headers?: Record<string, string>; data?: string; responseType?: 'text' | 'stream';
  timeout?: number; maxContentLength?: number; decompress?: boolean; signal?: AbortSignal; auth?: boolean;
}): Promise<any> {
  // `url` is a redirect target, used as given (signed links keep their query).
  const target = url || new URL(`${conn.base.origin}${encodePath(path || '/')}`);
  const lookup = await pinnedFor(target);
  try {
    return await axios({
      method, url: target.href, data,
      headers: { ...(auth ? { Authorization: conn.auth } : {}), ...headers },
      lookup, maxRedirects: 0, timeout, maxContentLength, maxBodyLength: maxContentLength,
      validateStatus: () => true, responseType, decompress, signal,
    });
  } catch (err) { throw requestError(err); }
}

// Depth: 1 listing of one folder. Folder requests end in "/" (Apache answers
// a folder without one with a redirect).
async function propfind(conn: DavConnection, dirPath: string) {
  const res = await davRequest(conn, {
    method: 'PROPFIND', path: dirPath === '/' ? '/' : `${dirPath}/`, data: PROPFIND_BODY,
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'Accept-Encoding': 'gzip' },
  });
  if (res.status === 401 || res.status === 403) throw davError('auth');
  const body = typeof res.data === 'string' ? res.data : '';
  if (res.status !== 207 || !/multistatus/i.test(body)) throw davError('not-webdav');
  return parseMultistatus(body, dirPath);
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

// Breadth-first, a few folders at a time. Only direct children of each folder
// are used, so a server that ignores Depth still gives each file once.
async function crawl(conn: DavConnection, { maxDepth, start, budget }: { maxDepth: number; start?: string; budget: { left: number } }) {
  const files: { path: string; size: number; modified: string | null }[] = [];
  const root = start || conn.basePath;
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  const seen = new Set<string>([root]);
  let total = 0;
  let failure: Error | null = null;
  const worker = async () => {
    while (queue.length && !failure) {
      const dir = queue.shift() as { path: string; depth: number };
      let entries;
      try { entries = await propfind(conn, dir.path); } catch (err) { failure = err as Error; return; }
      total += entries.length;
      budget.left -= entries.length;
      if (budget.left < 0) { failure = davError('too-large'); return; }
      for (const entry of entries) {
        if (parentOf(entry.path) !== dir.path) continue;
        if (entry.isDir) {
          if (seen.has(entry.path)) continue;
          if (dir.depth + 1 > maxDepth) { failure = davError('too-large'); return; }
          seen.add(entry.path);
          queue.push({ path: entry.path, depth: dir.depth + 1 });
        } else {
          files.push({ path: entry.path, size: entry.size, modified: entry.modified });
        }
      }
    }
  };
  // Workers pick up folders as earlier ones add them.
  while (queue.length && !failure) {
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, queue.length) }, worker));
  }
  if (failure) throw failure;
  return files;
}

function fileRef(relPath: string): string {
  return Buffer.from(relPath, 'utf8').toString('base64url');
}

// A file id back to its path below the server address, or null for anything
// that could leave it.
function fileRefToPath(ref: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,1500}$/.test(String(ref || ''))) return null;
  const path = Buffer.from(ref, 'base64url').toString('utf8');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('\0')) return null;
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  if (path === '/' || path.endsWith('/')) return null;
  return path;
}

function iso(value: string | null): string | undefined {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function groupItems(files: { path: string; size: number; modified: string | null }[], basePath: string): WebdavItem[] {
  const rel = (path: string) => (basePath === '/' ? path : path.slice(basePath.length) || '/');
  const byDir = new Map<string, { videos: typeof files; sides: typeof files }>();
  for (const file of files) {
    const isVideo = VIDEO_RE.test(file.path);
    const isSide = SIDE_RE.test(file.path) && file.size <= SIDE_FILE_MAX_BYTES;
    if (!isVideo && !isSide) continue;
    const dir = parentOf(rel(file.path));
    const group = byDir.get(dir) || { videos: [], sides: [] };
    (isVideo ? group.videos : group.sides).push({ ...file, path: rel(file.path) });
    byDir.set(dir, group);
  }
  const items: WebdavItem[] = [];
  const dates = (list: typeof files) => {
    const times = list.map((f) => iso(f.modified)).filter(Boolean).sort() as string[];
    return { created_at: times[0], updated_at: times[times.length - 1] };
  };
  for (const [dir, group] of byDir) {
    if (!group.videos.length) continue;
    const segments = dir.split('/').filter(Boolean);
    const folder = segments[segments.length - 1] || '';
    const looseFiles = !folder || (looksGeneric(folder) && !isSeasonLike(folder));
    if (looseFiles) {
      for (const video of group.videos) {
        const name = baseName(video.path);
        items.push({
          id: `w:${sha256(`file:${video.path}`).slice(0, 24)}`, name, filename: name, source: 'webdav', size: video.size,
          ...dates([video]), download_finished: true, download_state: 'completed',
          files: [{ id: fileRef(video.path), name, short_name: name, size: video.size }],
        });
      }
      continue;
    }
    let name = folder;
    if (isSeasonLike(folder)) {
      const show = segments.slice(0, -1).reverse().find((segment) => !isSeasonLike(segment) && !looksGeneric(segment));
      if (show) name = `${show} ${folder}`;
    }
    const all = [...group.videos, ...group.sides].sort((a, b) => a.path.localeCompare(b.path));
    items.push({
      id: `w:${sha256(`dir:${dir}`).slice(0, 24)}`, name, filename: name, source: 'webdav',
      size: group.videos.reduce((total, f) => total + f.size, 0),
      ...dates(group.videos), download_finished: true, download_state: 'completed',
      files: all.map((f) => ({ id: fileRef(f.path), name: `${folder}/${baseName(f.path)}`, short_name: baseName(f.path), size: f.size })),
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

// Run `fn` over `items` a few at a time (the same shape as the crawler's own
// worker pool, without importing library code into a provider).
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const inFlight = new Map<string, Promise<WebdavItem[]>>();

// How long a shallow listing may be reused. The engine asks every 30s for a
// library someone is using, so this keeps a probe and the scan that follows it
// from listing the same folders twice, without hiding a change for long.
const SHALLOW_TTL_MS = 15_000;
// A complete re-crawl this often, whatever the shallow listings say: the fold
// level mtimes decide what is re-read in between, and this is the safety net if
// a server does not move them.
const FULL_RESCAN_MS = 30 * 60 * 1000;

type DavEntry = { path: string; isDir: boolean; size: number; modified: string | null };
type DavTree = { base: DavEntry[]; containers: string[]; children: Record<string, DavEntry[]> };
type DavUnit = { sig: string; items: WebdavItem[] };

function lastSegment(path: string): string {
  const parts = String(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// The folders worth reading, in order: real categories first, then the `__all__`
// mirror that fills in what they miss. Other `__...` folders are plumbing.
function readableContainers(tree: DavTree): { path: string; name: string; mirror: boolean }[] {
  const named = tree.containers.map((path) => ({ path, name: lastSegment(path) }));
  const primary = named.filter((container) => !container.name.startsWith('__')).map((container) => ({ ...container, mirror: false }));
  const mirrors = named.filter((container) => container.name === '__all__').map((container) => ({ ...container, mirror: true }));
  return [...primary, ...mirrors];
}

function entrySig(entry: DavEntry): string {
  return `${entry.isDir ? 'd' : 'f'}:${Number(entry.size) || 0}:${entry.modified || ''}`;
}

// One listing level in the base folder and one under each of its folders. For a
// zurg/Usenet tree that is "every release folder" in a handful of requests: the
// cheap question "is there anything new?" without walking into every release.
async function shallowTree(conn: DavConnection, cache: { get: Function; set: Function }, now: number): Promise<DavTree> {
  const key = `davshallow:${conn.cacheKey}`;
  const hit = await Promise.resolve(cache.get(key)).catch(() => null);
  if (hit && hit.tree && Number.isFinite(hit.at) && now - hit.at < SHALLOW_TTL_MS) return hit.tree as DavTree;
  const listing = async (path: string) => (await propfind(conn, path)).filter((entry: DavEntry) => parentOf(entry.path) === path);
  const base = await listing(conn.basePath) as DavEntry[];
  // Server plumbing (`__unplayable__`, `__downloads__`, `__magic__`, ...) is
  // never a library and is never read, so it is not listed either: only real
  // folders and the `__all__` mirror count.
  const containers = base
    .filter((entry) => entry.isDir)
    .map((entry) => entry.path)
    .filter((path) => !lastSegment(path).startsWith('__') || lastSegment(path) === '__all__');
  const children: Record<string, DavEntry[]> = {};
  for (const container of containers) children[container] = await listing(container) as DavEntry[];
  const tree: DavTree = { base, containers, children };
  await Promise.resolve(cache.set(key, { at: now, tree }, Math.ceil(SHALLOW_TTL_MS / 1000))).catch(() => {});
  return tree;
}

// Everything the shallow listing can see, as one hash: a new release folder, a
// removed one, or a folder whose own entry moved changes it.
function treeSignature(tree: DavTree): string {
  const parts: string[] = [];
  for (const entry of tree.base) parts.push(`b|${entry.path}|${entrySig(entry)}`);
  for (const container of tree.containers) {
    for (const entry of tree.children[container] || []) parts.push(`c|${container}|${entry.path}|${entrySig(entry)}`);
  }
  return sha256(parts.sort().join('\n'));
}

// "Did anything change?" for a WebDAV server, without crawling it. Called by the
// library engine's probe, so a new release is noticed on the next probe (30s for
// a library someone is watching) instead of after the scan interval.
async function probeWebdav(config: any, deps: { cache?: { get: Function; set: Function }; now?: () => number } = {}): Promise<{ sig: string } | null> {
  if (!webdavEnabled()) return null;
  const conn = davConnection(config);
  if (!conn) return null;
  try {
    const tree = await shallowTree(conn, deps.cache || require('../runtime/cache.ts'), (deps.now || Date.now)());
    return { sig: treeSignature(tree) };
  } catch {
    return null;
  }
}

async function listWebdavLibrary(config: any, { fresh = false, deps = {} }: { fresh?: boolean; deps?: { cache?: { get: Function; set: Function }; now?: () => number; maxEntries?: number; maxDepth?: number } } = {}): Promise<WebdavItem[]> {
  if (!webdavEnabled()) throw davError('disabled');
  const conn = davConnection(config);
  if (!conn) throw davError('bad-url');
  const cache = deps.cache || require('../runtime/cache.ts');
  const now = deps.now || Date.now;
  const previous: any = await Promise.resolve(cache.get(conn.cacheKey)).catch(() => null);
  const tree = await shallowTree(conn, cache, now());
  const sig = treeSignature(tree);
  const units: Record<string, DavUnit> = previous && previous.units && Array.isArray(previous.items) ? previous.units : {};
  const fullDue = !previous || !previous.units || !Array.isArray(previous.items)
    || now() - (Number(previous.fullAt) || 0) > Math.max(FULL_RESCAN_MS, 2 * scanTtlMs());
  // Nothing moved at all: keep the library, without listing into any release
  // folder. `fresh` asks for a verified answer, and that is what this is.
  if (!fullDue && previous.sig === sig) return previous.items as WebdavItem[];
  const running = inFlight.get(conn.cacheKey);
  if (running) return running;
  const scan = (async () => {
    // One budget for the whole scan: the shallow listing and every folder read
    // after it share it, so a server that ignores Depth or a runaway tree still
    // fails instead of returning half a library.
    const budget = { left: deps.maxEntries ?? SCAN_MAX_ENTRIES };
    budget.left -= tree.base.length;
    if (budget.left < 0) throw davError('too-large');
    const nextUnits: Record<string, DavUnit> = {};
    // Files loose in the base, or loose in a "Movies" style folder: one title
    // each. These come straight from the shallow listing, so they are free.
    const looseUnit = (dirPath: string, entries: DavEntry[]) => {
      const files = entries.filter((entry) => !entry.isDir).map((entry) => ({ path: entry.path, size: entry.size, modified: entry.modified }));
      const key = `loose:${dirPath}`;
      const unitSig = sha256(files.map((file) => `${file.path}|${file.size}|${file.modified}`).sort().join('\n'));
      const kept = units[key];
      nextUnits[key] = kept && kept.sig === unitSig ? kept : { sig: unitSig, items: groupItems(files, conn.basePath) };
    };
    // Which containers to read, and in what order. A server can expose the same
    // releases twice: zurg serves every category (movies, shows) and also a
    // `__all__` mirror of everything, and that mirror is the slow one. Real
    // folders are read first and the mirror only fills in what they do not
    // have, so nothing appears twice and the mirror's slow folders are skipped.
    // Other `__...` folders (unplayable, downloads, magic) are server plumbing,
    // never a library.
    const readable = readableContainers(tree);
    looseUnit(conn.basePath, tree.base);
    for (const container of readable.filter((entry) => !entry.mirror)) looseUnit(container.path, tree.children[container.path] || []);
    const alreadySeen = new Set<string>();
    // Every folder below a container (a release) is re-read only when its own
    // entry moved; everything else is taken from the previous scan.
    const pending: { key: string; path: string; sig: string }[] = [];
    for (const container of readable) {
      const isMirror = container.mirror;
      for (const entry of tree.children[container.path] || []) {
        if (!entry.isDir) continue;
        const name = lastSegment(entry.path);
        // The mirror only contributes releases the categories do not already
        // show. Categories are never de-duplicated against each other.
        if (isMirror && alreadySeen.has(name)) continue;
        if (!isMirror) alreadySeen.add(name);
        const key = `dir:${entry.path}`;
        const unitSig = entrySig(entry);
        const kept = units[key];
        if (kept && kept.sig === unitSig) { nextUnits[key] = kept; continue; }
        pending.push({ key, path: entry.path, sig: unitSig });
      }
    }
    // One unreadable folder must not freeze the whole library: a server can
    // answer a broken release with an error for ever. A folder that was read
    // before keeps its previous result; a new one is left out. A scatter of
    // failures (or a refused login) is still a failed scan, so a server having a
    // bad day can never be mistaken for a library that lost titles.
    let failed = 0;
    await runPool(pending, scanConcurrency(), async (unit) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const files = await crawl(conn, { start: unit.path, maxDepth: deps.maxDepth ?? SCAN_MAX_DEPTH, budget });
          nextUnits[unit.key] = { sig: unit.sig, items: groupItems(files, conn.basePath) };
          return;
        } catch (err: any) {
          // A refused login or an exhausted entry budget is a failed scan, not
          // one broken folder: never turn either into a smaller library.
          if (err && (err.code === 'auth' || err.code === 'too-large')) throw err;
          if (attempt === 0) continue;
          failed += 1;
          const kept = units[unit.key];
          if (kept) nextUnits[unit.key] = kept;
        }
      }
    });
    if (failed > 0 && failed > Math.max(3, Math.ceil(pending.length * 0.1))) throw davError('unreachable');
    const byId = new Map<string, WebdavItem>();
    for (const unit of Object.values(nextUnits)) for (const item of unit.items) byId.set(item.id, item);
    const items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    await Promise.resolve(cache.set(conn.cacheKey, {
      at: now(), sig, items, units: nextUnits, fullAt: fullDue ? now() : (Number(previous && previous.fullAt) || now()),
    }, 7 * 24 * 60 * 60)).catch(() => {});
    return items;
  })();
  inFlight.set(conn.cacheKey, scan);
  try { return await scan; } finally { inFlight.delete(conn.cacheKey); }
}

// Items always carry their file list (the scan builds it).
async function getWebdavFiles(_config: any, item: any): Promise<DavFile[]> {
  return Array.isArray(item && item.files) ? item.files : [];
}

// "Does this address work, and is there a library behind it?" Counts what the
// scan would read: the release folders (categories first, the mirror only for
// names no category has) and any video sitting loose in a category folder. A
// server laid out as categories/releases has nothing at the top level, so
// counting only the top level used to answer "0 videos in 6 folders".
async function verifyWebdav(
  { url, user, password }: { url?: string; user?: string; password?: string },
  deps: { cache?: { get: Function; set: Function }; now?: () => number } = {},
): Promise<{ valid: boolean; error?: DavErrorCode; folders?: number; videos?: number }> {
  if (!webdavEnabled()) return { valid: false, error: 'disabled' };
  const conn = davConnection({ webdavUrl: url, webdavUser: user, webdavPassword: password });
  if (!conn) return { valid: false, error: 'bad-url' };
  try {
    const tree = await shallowTree(conn, deps.cache || require('../runtime/cache.ts'), (deps.now || Date.now)());
    const containers = readableContainers(tree);
    const seen = new Set<string>();
    let folders = 0;
    for (const container of containers) {
      for (const entry of tree.children[container.path] || []) {
        if (!entry.isDir) continue;
        const name = lastSegment(entry.path);
        // The mirror only counts releases no category has, so the number here
        // matches the number of titles the scan will look at.
        if (container.mirror && seen.has(name)) continue;
        if (!container.mirror) seen.add(name);
        folders += 1;
      }
    }
    let videos = tree.base.filter((entry) => !entry.isDir && VIDEO_RE.test(entry.path)).length;
    for (const container of containers.filter((entry) => !entry.mirror)) {
      videos += (tree.children[container.path] || []).filter((entry) => !entry.isDir && VIDEO_RE.test(entry.path)).length;
    }
    return { valid: true, folders, videos };
  } catch (err: any) {
    return { valid: false, error: requestError(err).code };
  }
}

// Streaming: players cannot send the WebDAV password, so LeLibrary fetches
// the file and passes it on. Only Range/If-Range go up; only playback headers
// come back (never cookies, auth challenges or redirect targets). Redirects
// are followed here (at most 3), each target re-checked against the host
// rules, and the password is only sent to the WebDAV server's own origin.
// When the player hangs up, the upstream download stops.
// No bytes from the WebDAV server for this long ends the stream (headers and
// body alike). WEBDAV_IDLE_MS overrides it (tests).
function proxyIdleMs(): number {
  const ms = Number(process.env.WEBDAV_IDLE_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 60000;
}
// Content-Type is never taken from the WebDAV server: these bytes are served
// from LeLibrary's own address, so an HTML file there must never render as a
// page. Only video files are served, typed by extension, sandboxed.
const PASS_HEADERS = ['content-range', 'content-length', 'accept-ranges', 'etag', 'last-modified'];
const VIDEO_TYPES: Record<string, string> = {
  mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
  ts: 'video/mp2t', m2ts: 'video/mp2t', mov: 'video/quicktime', wmv: 'video/x-ms-wmv',
};

async function proxyWebdavFile(req: any, res: any, config: any, ref: string): Promise<void> {
  const fail = (status: number, message: string) => {
    if (!res.headersSent) res.status(status).type('text/plain').send(message);
    else res.destroy();
  };
  res.set('Cache-Control', 'private, no-store, no-transform');
  const conn = webdavEnabled() ? davConnection(config) : null;
  const rel = fileRefToPath(ref);
  if (!conn || !rel || !VIDEO_RE.test(rel)) return fail(404, 'Not found');
  const contentType = VIDEO_TYPES[(rel.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
  if (typeof req.headers.range === 'string') headers.Range = req.headers.range;
  if (typeof req.headers['if-range'] === 'string') headers['If-Range'] = req.headers['if-range'];
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let target = new URL(`${conn.base.origin}${encodePath(conn.basePath === '/' ? rel : `${conn.basePath}${rel}`)}`);
  let upstream: any = null;
  try {
    for (let hop = 0; ; hop++) {
      upstream = await davRequest(conn, {
        method, url: target, headers, responseType: 'stream', decompress: false,
        maxContentLength: -1, timeout: proxyIdleMs(), signal: controller.signal,
        auth: target.origin === conn.base.origin,
      });
      const location = upstream.headers && upstream.headers.location;
      if (upstream.status < 300 || upstream.status >= 400 || upstream.status === 304 || !location) break;
      upstream.data.destroy();
      if (hop >= 2) return fail(502, 'The WebDAV server redirected too many times.');
      let next: URL;
      try { next = new URL(String(location), target); } catch { return fail(502, 'The WebDAV server gave a bad redirect.'); }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') return fail(502, 'The WebDAV server gave a bad redirect.');
      target = next;
    }
  } catch (err: any) {
    if (controller.signal.aborted) return;
    const code = requestError(err).code;
    return fail(code === 'timeout' ? 504 : 502, code === 'blocked-host' || code === 'insecure-http'
      ? 'This WebDAV server is not allowed by this LeLibrary install.'
      : 'The WebDAV server could not be reached right now. Try again in a moment.');
  }
  const status = upstream.status;
  if (status === 401 || status === 403) { upstream.data.destroy(); return fail(502, 'The WebDAV server did not accept the saved username or password.'); }
  if (status === 404) { upstream.data.destroy(); return fail(404, 'This file is no longer on the WebDAV server.'); }
  if (![200, 206, 304, 416].includes(status)) { upstream.data.destroy(); return fail(502, 'The WebDAV server could not send this file right now.'); }
  res.status(status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const name of PASS_HEADERS) {
    const value = upstream.headers[name];
    if (value != null) res.setHeader(name, value);
  }
  if (method === 'HEAD' || status === 304) { upstream.data.destroy(); res.end(); return; }
  // axios' timeout only covers the wait for headers; watch the body too.
  let idle: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { controller.abort(); upstream.data.destroy(new Error('webdav idle')); }, proxyIdleMs());
  };
  armIdle();
  upstream.data.on('data', armIdle);
  await new Promise<void>((resolve) => {
    require('node:stream').pipeline(upstream.data, res, () => {
      if (idle) clearTimeout(idle);
      if (!res.writableEnded) controller.abort();
      resolve();
    });
  });
}

export interface WebdavApi {
  SCAN_MAX_ENTRIES: number; SCAN_MAX_DEPTH: number; SCAN_CONCURRENCY: number; REQUEST_TIMEOUT_MS: number; MAX_LISTING_BYTES: number;
  webdavEnabled: typeof webdavEnabled;
  allowPrivate: typeof allowPrivate;
  scanTtlMs: typeof scanTtlMs;
  scanConcurrency: typeof scanConcurrency;
  davConnection: typeof davConnection;
  davRequest: typeof davRequest;
  fileRefToPath: typeof fileRefToPath;
  listWebdavLibrary: typeof listWebdavLibrary;
  getWebdavFiles: typeof getWebdavFiles;
  verifyWebdav: typeof verifyWebdav;
  proxyWebdavFile: typeof proxyWebdavFile;
  probeWebdav: typeof probeWebdav;
  treeSignature: typeof treeSignature;
}

module.exports = {
  SCAN_MAX_ENTRIES, SCAN_MAX_DEPTH, SCAN_CONCURRENCY, REQUEST_TIMEOUT_MS, MAX_LISTING_BYTES,
  webdavEnabled, allowPrivate, scanTtlMs, scanConcurrency, davConnection, davRequest, fileRefToPath, listWebdavLibrary, getWebdavFiles, verifyWebdav, proxyWebdavFile, probeWebdav, treeSignature,
} satisfies WebdavApi;
