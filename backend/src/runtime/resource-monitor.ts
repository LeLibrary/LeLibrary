// Periodic aggregate diagnostics. Never include cache keys, job IDs or errors:
// these samples can be read from ordinary application logs.
const cache = require('./cache.ts');
const db = require('../library/db.ts');
const jobs = require('./jobs.ts');
const metrics = require('../library/metrics.ts');

let timer: ReturnType<typeof setInterval> | null = null;

function resourceSnapshot() {
  const memory = process.memoryUsage();
  const pool = db.poolStats();
  const library = metrics.snapshot().counters;
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers },
    cache: cache.memoryStats(),
    database: { enabled: pool.enabled, total: pool.total, idle: pool.idle, waiting: pool.waiting, max: pool.max },
    jobs: jobs.queueStats(),
    library: { syncs: library.syncs, syncErrors: library.syncErrors, probeChanged: library.probeChanged, probeUnchanged: library.probeUnchanged, probeUnknown: library.probeUnknown },
  };
}

function startResourceMonitor() {
  if (timer) return;
  timer = setInterval(() => {
    try { console.log('[Resources]', JSON.stringify(resourceSnapshot())); }
    catch { console.warn('[Resources] sample failed'); }
  }, 60_000);
  timer.unref();
}

function stopResourceMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { resourceSnapshot, startResourceMonitor, stopResourceMonitor };
