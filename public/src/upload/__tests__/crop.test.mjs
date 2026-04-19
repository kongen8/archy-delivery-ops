import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// crop.js is browser code. fitCropRect is pure math. cropToCanvas calls
// document.createElement('canvas') + ctx.drawImage / ctx.clip; we stub those
// to capture call shape rather than building node-canvas (Cairo deps don't
// install cleanly under Node 25). Pixel-level correctness is verified via
// the in-browser smoke test in Tasks 5/6.
const calls = [];
const ctxStub = {
  save: () => calls.push(['save']),
  restore: () => calls.push(['restore']),
  beginPath: () => calls.push(['beginPath']),
  closePath: () => calls.push(['closePath']),
  arc: (...a) => calls.push(['arc', ...a]),
  clip: () => calls.push(['clip']),
  drawImage: (...a) => calls.push(['drawImage', ...a]),
};
const canvasStub = { width: 0, height: 0, getContext: () => ctxStub };
globalThis.document = { createElement: (tag) => tag === 'canvas' ? Object.assign({}, canvasStub) : null };

const src = fs.readFileSync(path.resolve(__dirname, '../crop.js'), 'utf8');
const ctx = {};
new Function('ctx', src + '\nctx.cropToCanvas = cropToCanvas;\nctx.fitCropRect = fitCropRect;')(ctx);
const { cropToCanvas, fitCropRect } = ctx;

test('fitCropRect centers a 4:6 rect inside a 1000x1000 source', () => {
  const r = fitCropRect(1000, 1000, 4 / 6);
  assert.equal(r.w, Math.round(1000 * (4/6)));
  assert.equal(r.h, 1000);
  assert.equal(r.x, Math.round((1000 - r.w) / 2));
  assert.equal(r.y, 0);
});

test('fitCropRect centers a 1:1 rect inside a wide 1600x900 source', () => {
  const r = fitCropRect(1600, 900, 1);
  assert.equal(r.w, 900);
  assert.equal(r.h, 900);
  assert.equal(r.x, Math.round((1600 - 900) / 2));
  assert.equal(r.y, 0);
});

test('fitCropRect centers a 4:6 rect inside a tall 600x1200 source', () => {
  const r = fitCropRect(600, 1200, 4 / 6);
  assert.equal(r.w, 600);
  assert.equal(r.h, Math.round(600 / (4/6)));
  assert.equal(r.x, 0);
  assert.equal(r.y, Math.round((1200 - r.h) / 2));
});

test('fitCropRect handles a square 1:1 inside a square source (full image)', () => {
  const r = fitCropRect(500, 500, 1);
  assert.equal(r.w, 500); assert.equal(r.h, 500);
  assert.equal(r.x, 0);   assert.equal(r.y, 0);
});

test('cropToCanvas draws the source rect into a fresh outputW x outputH canvas (rect mask)', () => {
  calls.length = 0;
  const fakeImg = {};
  const out = cropToCanvas(fakeImg, { x: 10, y: 20, w: 100, h: 150 }, 200, 300, 'rect');
  assert.equal(out.width, 200);
  assert.equal(out.height, 300);
  // No save/clip for rect mask, only drawImage
  assert.deepEqual(calls.find(c => c[0] === 'drawImage'),
    ['drawImage', fakeImg, 10, 20, 100, 150, 0, 0, 200, 300]);
  assert.equal(calls.find(c => c[0] === 'clip'), undefined);
});

test('cropToCanvas with round mask wraps drawImage in save/clip/restore', () => {
  calls.length = 0;
  const fakeImg = {};
  cropToCanvas(fakeImg, { x: 0, y: 0, w: 100, h: 100 }, 200, 200, 'round');
  // The expected sequence: save → beginPath → arc → closePath → clip → drawImage → restore
  const seq = calls.map(c => c[0]);
  assert.deepEqual(seq, ['save', 'beginPath', 'arc', 'closePath', 'clip', 'drawImage', 'restore']);
  // Arc center (100,100) and radius 100 (= min/2)
  const arc = calls.find(c => c[0] === 'arc');
  assert.equal(arc[1], 100); assert.equal(arc[2], 100); assert.equal(arc[3], 100);
});
