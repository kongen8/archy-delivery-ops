import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.resolve(__dirname, '../columns.js'), 'utf8');
const ctx = {};
new Function('ctx', src + '\nctx.suggestMapping = suggestMapping;')(ctx);
const { suggestMapping } = ctx;

test('exact target names map directly', () => {
  const out = suggestMapping(['company', 'address', 'phone']);
  assert.deepEqual(out.mapping, { company: 'company', address: 'address', phone: 'phone' });
  assert.equal(out.confidence.company, 'high');
});

test('common business synonyms map to company', () => {
  const out = suggestMapping(['Business Name', 'Street', 'Cell']);
  assert.equal(out.mapping['Business Name'], 'company');
  assert.equal(out.mapping['Street'], 'address');
  assert.equal(out.mapping['Cell'], 'phone');
});

test('unknown headers map to null with low confidence', () => {
  const out = suggestMapping(['Sales Rep', 'Internal Notes']);
  assert.equal(out.mapping['Sales Rep'], null);
  assert.equal(out.confidence['Sales Rep'], 'low');
});

test('case and punctuation are ignored', () => {
  const out = suggestMapping(['ZIP CODE', 'E-mail', 'CITY/TOWN']);
  assert.equal(out.mapping['ZIP CODE'], 'zip');
  assert.equal(out.mapping['E-mail'], 'email');
  assert.equal(out.mapping['CITY/TOWN'], 'city');
});
