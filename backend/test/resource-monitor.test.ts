const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resourceSnapshot, startResourceMonitor, stopResourceMonitor } = require('../src/runtime/resource-monitor.ts');

test('resource samples expose aggregate values only', () => {
  const sample = resourceSnapshot();
  assert.ok(sample.memory.rss > 0);
  assert.equal(typeof sample.cache.keys, 'number');
  assert.equal(typeof sample.database.waiting, 'number');
  assert.equal(typeof sample.jobs.queued, 'number');
  assert.deepEqual(Object.keys(sample.library).sort(), ['probeChanged', 'probeUnchanged', 'probeUnknown', 'syncErrors', 'syncs']);
  startResourceMonitor();
  startResourceMonitor();
  stopResourceMonitor();
});
