import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// We can't `import` geocode.js directly — it's a classic browser script that
// hangs assignments off `window`. Read it as text, strip the `window.*`
// re-exports, and re-eval as ESM by appending an `export {…}` line.
const src = readFileSync(new URL('../geocode.js', import.meta.url), 'utf8');
const stripped = src.replace(/window\.[A-Za-z]+\s*=\s*[A-Za-z]+;?/g, '')
  + '\nexport { parseRetrieveContext };\n';
const blobUrl = 'data:text/javascript;base64,' + Buffer.from(stripped).toString('base64');
const { parseRetrieveContext } = await import(blobUrl);

test('parses a full Mapbox Searchbox v1 retrieve context', () => {
  const properties = {
    full_address: '330 Main St, San Francisco, California 94105, United States',
    context: {
      address: { name: '330 Main St' },
      place:   { name: 'San Francisco' },
      region:  { name: 'California', region_code: 'CA' },
      postcode:{ name: '94105' },
    },
  };
  assert.deepEqual(parseRetrieveContext(properties), {
    address: '330 Main St',
    city: 'San Francisco',
    state: 'CA',
    zip: '94105',
  });
});

test('falls back to top-level address when context.address is missing', () => {
  const properties = {
    full_address: '330 Main St, SF, CA',
    address: '330 Main St',
    context: {
      place:   { name: 'SF' },
      region:  { region_code: 'CA' },
    },
  };
  assert.deepEqual(parseRetrieveContext(properties), {
    address: '330 Main St',
    city: 'SF',
    state: 'CA',
    zip: null,
  });
});

test('returns null for missing pieces, never throws on partial input', () => {
  assert.deepEqual(parseRetrieveContext({}), {
    address: null, city: null, state: null, zip: null,
  });
  assert.deepEqual(parseRetrieveContext({ context: null }), {
    address: null, city: null, state: null, zip: null,
  });
});

test('prefers region.region_code (2-letter) over region.name', () => {
  const out = parseRetrieveContext({
    context: { region: { name: 'California', region_code: 'CA' } },
  });
  assert.equal(out.state, 'CA');
});

test('falls back to region.name when region_code is missing', () => {
  const out = parseRetrieveContext({
    context: { region: { name: 'CA' } },
  });
  assert.equal(out.state, 'CA');
});
