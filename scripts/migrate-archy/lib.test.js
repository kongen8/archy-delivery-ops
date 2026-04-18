import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAddress, convexHull, generateToken } from './lib.js';

test('normalizeAddress lowercases and collapses whitespace', () => {
  assert.equal(normalizeAddress('  390 Laurel   St #310 '), '390 laurel st #310');
});

test('normalizeAddress is idempotent', () => {
  const once = normalizeAddress('390 Laurel St #310');
  assert.equal(normalizeAddress(once), once);
});

test('normalizeAddress handles empty and nullish', () => {
  assert.equal(normalizeAddress(''), '');
  assert.equal(normalizeAddress(null), '');
  assert.equal(normalizeAddress(undefined), '');
});

test('convexHull of a square returns the 4 corners (closed ring)', () => {
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
    { lat: 0.5, lon: 0.5 } // interior point should be dropped
  ];
  const hull = convexHull(pts);
  // GeoJSON: first === last
  assert.equal(hull[0][0], hull[hull.length - 1][0]);
  assert.equal(hull[0][1], hull[hull.length - 1][1]);
  // 4 unique corners + closing point = 5
  assert.equal(hull.length, 5);
});

test('convexHull handles 3 collinear points gracefully', () => {
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 0, lon: 2 }
  ];
  const hull = convexHull(pts);
  // Degenerate — we still want something valid (at least a closed 2-vertex "polygon")
  assert.ok(hull.length >= 2);
  assert.deepEqual(hull[0], hull[hull.length - 1]);
});

test('generateToken returns 32+ char URL-safe string', () => {
  const t = generateToken();
  assert.ok(t.length >= 32);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('generateToken is unique across calls', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
});
