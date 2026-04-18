import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.resolve(__dirname, '../reassign.js'), 'utf8');
const ctx = {};
new Function('ctx', src + '\nctx.computeReassignment = computeReassignment;')(ctx);
const { computeReassignment } = ctx;

// Two square polygons: SF covers x in [0,2], SouthBay covers x in [2,4].
const areaSF = { id: 'area-sf', name: 'SF', geometry: { type: 'Polygon', coordinates: [[[0,0],[0,2],[2,2],[2,0],[0,0]]] } };
const areaSB = { id: 'area-sb', name: 'South Bay / Peninsula', geometry: { type: 'Polygon', coordinates: [[[2,0],[2,2],[4,2],[4,0],[2,0]]] } };
const areaCocolaNew = { id: 'area-cocola', name: null, geometry: { type: 'Polygon', coordinates: [[[2,0],[2,2],[4,2],[4,0],[2,0]]] } };

const BOHO = 'bakery-boho';
const COCOLA = 'bakery-cocola';

test('moves recipients from other bakery when point is inside target area', () => {
  const recipients = [
    { id: 'r1', bakery_id: BOHO, campaign_id: 'c1', lat: 1, lon: 3, customizations: {} },
    { id: 'r2', bakery_id: BOHO, campaign_id: 'c1', lat: 1, lon: 1, customizations: {} },
  ];
  const out = computeReassignment({
    thisBakeryId: COCOLA,
    thisBakeryAreas: [areaCocolaNew],
    otherBakeries: [{ id: BOHO, areas: [areaSF, areaSB] }],
    recipients,
  });
  assert.equal(out.summary.to_move, 1);
  assert.equal(out.summary.already_here, 0);
  assert.equal(out.moves[0].recipient_id, 'r1');
  assert.equal(out.moves[0].old_bakery_id, BOHO);
  assert.equal(out.moves[0].old_area_id, 'area-sb');
  assert.equal(out.moves[0].new_area_id, 'area-cocola');
});

test('recipients already on the target bakery are counted but not moved', () => {
  const recipients = [
    { id: 'r1', bakery_id: COCOLA, campaign_id: 'c1', lat: 1, lon: 3, customizations: {} },
  ];
  const out = computeReassignment({
    thisBakeryId: COCOLA,
    thisBakeryAreas: [areaCocolaNew],
    otherBakeries: [],
    recipients,
  });
  assert.equal(out.summary.total_inside, 1);
  assert.equal(out.summary.already_here, 1);
  assert.equal(out.summary.to_move, 0);
});

test('point outside all target areas is ignored entirely', () => {
  const recipients = [
    { id: 'r1', bakery_id: BOHO, campaign_id: 'c1', lat: 10, lon: 10, customizations: {} },
  ];
  const out = computeReassignment({
    thisBakeryId: COCOLA,
    thisBakeryAreas: [areaCocolaNew],
    otherBakeries: [{ id: BOHO, areas: [areaSF, areaSB] }],
    recipients,
  });
  assert.equal(out.summary.total_inside, 0);
  assert.equal(out.moves.length, 0);
  assert.equal(out.route_keys_old.length, 0);
  assert.equal(out.route_keys_new.length, 0);
});

test('recipient with no lat/lon is skipped', () => {
  const recipients = [
    { id: 'r1', bakery_id: BOHO, campaign_id: 'c1', lat: null, lon: null, customizations: {} },
  ];
  const out = computeReassignment({
    thisBakeryId: COCOLA,
    thisBakeryAreas: [areaCocolaNew],
    otherBakeries: [{ id: BOHO, areas: [areaSB] }],
    recipients,
  });
  assert.equal(out.moves.length, 0);
});

test('legacy_region tag is preferred over geometry for old_area lookup', () => {
  // Recipient's point is inside Boho's SF area geometrically, but tagged "South Bay / Peninsula".
  // The tag should win so we delete the right saved-route row.
  const recipients = [
    { id: 'r1', bakery_id: BOHO, campaign_id: 'c1', lat: 1, lon: 1.0, customizations: { legacy_region: 'South Bay / Peninsula' } },
  ];
  // Cocola's new area happens to also cover (1,1) so we get a move to evaluate.
  const cocolaArea = { id: 'area-cocola', geometry: { type: 'Polygon', coordinates: [[[0,0],[0,2],[2,2],[2,0],[0,0]]] } };
  const out = computeReassignment({
    thisBakeryId: COCOLA,
    thisBakeryAreas: [cocolaArea],
    otherBakeries: [{ id: BOHO, areas: [areaSF, areaSB] }],
    recipients,
  });
  assert.equal(out.moves.length, 1);
  assert.equal(out.moves[0].old_area_id, 'area-sb', 'legacy tag should win over geometry');
  assert.equal(out.moves[0].strip_tag, true);
});

test('route keys are deduped per (campaign, bakery, area) triple', () => {
  const recipients = [
    { id: 'r1', bakery_id: BOHO, campaign_id: 'c1', lat: 1, lon: 3, customizations: {} },
    { id: 'r2', bakery_id: BOHO, campaign_id: 'c1', lat: 1.2, lon: 3.2, customizations: {} },
    { id: 'r3', bakery_id: BOHO, campaign_id: 'c2', lat: 1, lon: 3, customizations: {} },
  ];
  const out = computeReassignment({
    thisBakeryId: COCOLA,
    thisBakeryAreas: [areaCocolaNew],
    otherBakeries: [{ id: BOHO, areas: [areaSB] }],
    recipients,
  });
  assert.equal(out.route_keys_old.length, 2, 'one per campaign');
  assert.equal(out.route_keys_new.length, 2);
  assert.ok(out.route_keys_old.every(k => k.bakery_id === BOHO));
  assert.ok(out.route_keys_new.every(k => k.bakery_id === COCOLA));
});

test('unassigned recipient (bakery_id null) has no old_area_id but still moves', () => {
  const recipients = [
    { id: 'r1', bakery_id: null, campaign_id: 'c1', lat: 1, lon: 3, customizations: {} },
  ];
  const out = computeReassignment({
    thisBakeryId: COCOLA,
    thisBakeryAreas: [areaCocolaNew],
    otherBakeries: [],
    recipients,
  });
  assert.equal(out.moves.length, 1);
  assert.equal(out.moves[0].old_bakery_id, null);
  assert.equal(out.moves[0].old_area_id, null);
  assert.equal(out.route_keys_old.length, 0, 'no old route to invalidate when there is no old area');
  assert.equal(out.route_keys_new.length, 1);
});
