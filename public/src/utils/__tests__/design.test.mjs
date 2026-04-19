import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../design.js'), 'utf8');
const ctx = {};
new Function('ctx', src + '\nctx.mergeDesign = mergeDesign;')(ctx);
const { mergeDesign } = ctx;

test('uses recipient values when both sides have them', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card' },
    { cake_image_url: 'B_cake', card_image_url: 'B_card' });
  assert.deepEqual(out, { cake_image_url: 'B_cake', card_image_url: 'B_card' });
});

test('falls back to campaign default when recipient is missing a key', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card' },
    { cake_image_url: 'B_cake' });
  assert.deepEqual(out, { cake_image_url: 'B_cake', card_image_url: 'A_card' });
});

test('treats null and "" as missing', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card' },
    { cake_image_url: null, card_image_url: '' });
  assert.deepEqual(out, { cake_image_url: 'A_cake', card_image_url: 'A_card' });
});

test('returns null fields when nothing is set on either side', () => {
  const out = mergeDesign({}, {});
  assert.deepEqual(out, { cake_image_url: null, card_image_url: null });
});

test('handles undefined arguments without throwing', () => {
  const out = mergeDesign(undefined, undefined);
  assert.deepEqual(out, { cake_image_url: null, card_image_url: null });
});

test('ignores extra keys in either argument (e.g. Plan 3 skipped flag)', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card', extra: 'x' },
    { skipped: true });
  assert.deepEqual(out, { cake_image_url: 'A_cake', card_image_url: 'A_card' });
});
