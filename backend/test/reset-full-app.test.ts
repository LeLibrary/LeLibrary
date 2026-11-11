// @ts-nocheck
'use strict';
// The bot's signature covers the raw request body. In the full app another
// router parses JSON bodies first, so the reset routes must be mounted ahead of
// it. This runs the real app in a child process (the env is read at mount) and
// proves a correctly signed call gets past the signature check (503 with no
// database, never 401) while an unsigned one is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('the full app accepts a signed bot call and refuses an unsigned one', () => {
  const script = `
    const app = require(${JSON.stringify(path.join(__dirname, '..', 'app.ts'))});
    const { signBotRequest } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'routes', 'reset.ts'))});
    const server = app.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const route = '/api/bot/reset/poll';
      const ts = Date.now();
      const sig = signBotRequest(process.env.RESET_BOT_SECRET, 'POST', route, '{}', ts);
      const headers = { 'content-type': 'application/json', 'x-ll-ts': String(ts), 'x-ll-sig': sig };
      const signed = await fetch(base + route, { method: 'POST', headers, body: '{}' });
      const unsigned = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      console.log('RESULT ' + signed.status + ' ' + unsigned.status);
      process.exit(0);
    });
  `;
  const run = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, RESET_BOT_SECRET: 'k'.repeat(40), RESET_OPERATOR_DISCORD_ID: '111111111111111111', DATABASE_URL: '' },
    encoding: 'utf8', timeout: 60_000,
  });
  const line = String(run.stdout).split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result: ${run.stderr.slice(-300)}`);
  const [, signed, unsigned] = line.split(' ');
  assert.notEqual(signed, '401', 'a signed call must pass the signature check');
  assert.equal(unsigned, '401');
});
