import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const turfMod = await import('@turf/turf');
globalThis.turf = turfMod;

const src = fs.readFileSync(path.resolve(__dirname, '../overlap.js'), 'utf8');
const ctx = {};
new Function('turf', 'ctx', src + '\nctx.anyOverlap = anyOverlap;')(turfMod, ctx);
const { anyOverlap } = ctx;

function poly(coords) {
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

test('disjoint polygons report no overlap', () => {
  const a = poly([[0,0],[0,1],[1,1],[1,0],[0,0]]);
  const b = poly([[2,2],[2,3],[3,3],[3,2],[2,2]]);
  assert.equal(anyOverlap(a, [b]), false);
});

test('polygons sharing only an edge do not overlap', () => {
  const a = poly([[0,0],[0,1],[1,1],[1,0],[0,0]]);
  const b = poly([[1,0],[1,1],[2,1],[2,0],[1,0]]);
  assert.equal(anyOverlap(a, [b]), false);
});

test('truly overlapping polygons are flagged', () => {
  const a = poly([[0,0],[0,2],[2,2],[2,0],[0,0]]);
  const b = poly([[1,1],[1,3],[3,3],[3,1],[1,1]]);
  assert.equal(anyOverlap(a, [b]), true);
});

test('a fully contained polygon is flagged', () => {
  const outer = poly([[0,0],[0,10],[10,10],[10,0],[0,0]]);
  const inner = poly([[2,2],[2,3],[3,3],[3,2],[2,2]]);
  assert.equal(anyOverlap(inner, [outer]), true);
});

test('overlap flag counts across a list', () => {
  const a = poly([[0,0],[0,2],[2,2],[2,0],[0,0]]);
  const b = poly([[5,5],[5,6],[6,6],[6,5],[5,5]]);
  const c = poly([[1,1],[1,3],[3,3],[3,1],[1,1]]);
  assert.equal(anyOverlap(a, [b]), false);
  assert.equal(anyOverlap(a, [b, c]), true);
});
