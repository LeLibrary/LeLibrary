// @ts-nocheck
'use strict';
// The schema runs as one ordered list of statements inside a transaction, and
// the first failure rolls the whole thing back. A statement that names a table
// or column that does not exist yet therefore disables the library engine on
// every fresh database, and only a database that already has the object hides
// it. This is the cheap guard: the statements are text, so the order can be
// checked without a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'library', 'db.ts'), 'utf8');

// Every `...` template literal in the MIGRATIONS array, in order.
function statements() {
  const start = source.indexOf('const MIGRATIONS');
  const end = source.indexOf('\n];', start);
  assert.ok(start >= 0 && end > start, 'the MIGRATIONS array was found');
  const body = source.slice(start, end);
  return [...body.matchAll(/`([\s\S]*?)`/g)].map((match) => match[1]);
}

// `CREATE TABLE IF NOT EXISTS x` / `ALTER TABLE x` / `CREATE INDEX ... ON x`.
function createdTables(text) {
  return [...text.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((match) => match[1].toLowerCase());
}

function referencedTables(text) {
  const altered = [...text.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((match) => match[1].toLowerCase());
  const indexed = [...text.matchAll(/CREATE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(\w+)/gi)].map((match) => match[1].toLowerCase());
  return [...altered, ...indexed];
}

test('every statement references only tables that already exist', () => {
  const seen = new Set();
  const problems = [];
  for (const statement of statements()) {
    for (const table of referencedTables(statement)) {
      if (!seen.has(table)) {
        problems.push(`${table}: ${statement.split('\n')[0].trim()}`);
      }
    }
    for (const table of createdTables(statement)) seen.add(table);
  }
  assert.deepEqual(problems, [], `statements before their table (add them after the CREATE TABLE):\n${problems.join('\n')}`);
});

test('the guard itself finds the tables the schema creates', () => {
  const seen = statements().flatMap(createdTables);
  for (const table of ['lib_items', 'lib_identities', 'lib_episodes', 'lib_tmdb_genres']) {
    assert.ok(seen.includes(table), `${table} is created`);
  }
});
