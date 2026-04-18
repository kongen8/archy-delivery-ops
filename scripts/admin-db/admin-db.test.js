// Integration tests for admin.js. Runs against the live Supabase project
// with the service role key (read from apps/web .env per the user rule,
// with a fallback to the repo root .env).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

const candidates = [
  path.resolve(process.cwd(), '../../apps/web/.env'),
  path.resolve(process.cwd(), '../../.env'),
];
for (const p of candidates) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
const sb = createClient(url, key);

const reassignSrc = fs.readFileSync(path.resolve(process.cwd(), '../../public/src/admin/reassign.js'), 'utf8');
const adminSrc = fs.readFileSync(path.resolve(process.cwd(), '../../public/src/db/admin.js'), 'utf8');
const mod = {};
new Function('sb', 'mod', reassignSrc + '\n' + adminSrc + '\nmod.Admin = Admin;')(sb, mod);
const Admin = mod.Admin;

const suffix = Math.random().toString(36).slice(2, 8);
const mkName = kind => `TEST_${kind}_${suffix}`;

let createdBakeryId = null;
let createdCustomerId = null;
let createdAreaId = null;

after(async () => {
  if (createdAreaId) await sb.from('delivery_areas').delete().eq('id', createdAreaId);
  if (createdBakeryId) await sb.from('bakeries').delete().eq('id', createdBakeryId);
  if (createdCustomerId) await sb.from('customers').delete().eq('id', createdCustomerId);
});

test('createBakery mints an access_token and returns the row', async () => {
  const row = await Admin.createBakery({ name: mkName('bakery'), contact_email: 'ops@example.com' });
  assert.ok(row && row.id);
  assert.ok(row.access_token && row.access_token.length >= 16);
  assert.equal(row.contact_email, 'ops@example.com');
  createdBakeryId = row.id;
});

test('updateBakery patches name and email', async () => {
  const updated = await Admin.updateBakery(createdBakeryId, {
    name: mkName('bakery-renamed'), contact_email: 'renamed@example.com'
  });
  assert.equal(updated.contact_email, 'renamed@example.com');
});

test('listBakeries includes the new bakery', async () => {
  const rows = await Admin.listBakeries();
  const match = rows.find(r => r.id === createdBakeryId);
  assert.ok(match, 'new bakery should appear in listBakeries');
});

test('upsertDeliveryArea inserts then updates', async () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]],
  };
  const inserted = await Admin.upsertDeliveryArea({
    bakery_id: createdBakeryId, name: 'Test area', geometry,
  });
  assert.ok(inserted.id);
  createdAreaId = inserted.id;

  const newGeom = {
    type: 'Polygon',
    coordinates: [[[0,0],[0,2],[2,2],[2,0],[0,0]]],
  };
  const updated = await Admin.upsertDeliveryArea({
    id: createdAreaId, bakery_id: createdBakeryId, name: 'Test area v2', geometry: newGeom,
  });
  assert.equal(updated.id, createdAreaId);
  assert.equal(updated.name, 'Test area v2');
  assert.deepEqual(updated.geometry, newGeom);
});

test('getBakery returns bakery + delivery_areas + depots', async () => {
  const { bakery, delivery_areas, depots } = await Admin.getBakery(createdBakeryId);
  assert.equal(bakery.id, createdBakeryId);
  assert.ok(Array.isArray(delivery_areas));
  assert.equal(delivery_areas.length, 1);
  assert.equal(delivery_areas[0].id, createdAreaId);
  assert.ok(Array.isArray(depots));
  assert.equal(depots.length, 0);
});

test('deleteDeliveryArea removes the row', async () => {
  await Admin.deleteDeliveryArea(createdAreaId);
  const { delivery_areas } = await Admin.getBakery(createdBakeryId);
  assert.equal(delivery_areas.length, 0);
  createdAreaId = null;
});

test('createCustomer mints access_token and returns the row', async () => {
  const row = await Admin.createCustomer({ name: mkName('customer'), contact_email: 'cust@example.com' });
  assert.ok(row && row.id);
  assert.ok(row.access_token && row.access_token.length >= 16);
  createdCustomerId = row.id;
});

test('getCustomer returns customer + campaigns', async () => {
  const { customer, campaigns } = await Admin.getCustomer(createdCustomerId);
  assert.equal(customer.id, createdCustomerId);
  assert.ok(Array.isArray(campaigns));
});

test('preview + applyReassignment moves a recipient between bakeries and clears routes', async () => {
  // Arrange: target bakery "dst" with a polygon covering a specific point;
  // source bakery "src" currently owns a recipient at that point, inside its
  // own area. After reassignment, the recipient should move to "dst" and
  // stale routes rows for the triple (campaign, src, src_area) should be gone.
  const { data: dst } = await sb.from('bakeries')
    .insert({ name: mkName('dst'), access_token: crypto.randomUUID() })
    .select('*').single();
  const { data: src } = await sb.from('bakeries')
    .insert({ name: mkName('src'), access_token: crypto.randomUUID() })
    .select('*').single();

  const geom = { type: 'Polygon', coordinates: [[[10,10],[10,11],[11,11],[11,10],[10,10]]] };
  const { data: dstArea } = await sb.from('delivery_areas')
    .insert({ bakery_id: dst.id, name: 'dst-area', geometry: geom })
    .select('*').single();
  const { data: srcArea } = await sb.from('delivery_areas')
    .insert({ bakery_id: src.id, name: 'src-area', geometry: geom })
    .select('*').single();

  const { data: cust } = await sb.from('customers')
    .insert({ name: mkName('cust'), access_token: crypto.randomUUID() })
    .select('*').single();
  const { data: camp } = await sb.from('campaigns')
    .insert({ customer_id: cust.id, name: mkName('camp'), status: 'draft' })
    .select('*').single();
  const { data: recip } = await sb.from('recipients')
    .insert({
      campaign_id: camp.id, bakery_id: src.id,
      company: 'Acme', address: '1 Test Way',
      lat: 10.5, lon: 10.5,
      customizations: { legacy_region: 'src-area' },
      assignment_status: 'assigned',
    })
    .select('*').single();

  // Insert a stale route row that reassignment should invalidate.
  const { data: stale } = await sb.from('routes')
    .insert({ campaign_id: camp.id, bakery_id: src.id, delivery_area_id: srcArea.id, data: { days: [] } })
    .select('*').single();

  const cleanup = async () => {
    await sb.from('recipients').delete().eq('id', recip.id);
    await sb.from('routes').delete().eq('campaign_id', camp.id);
    await sb.from('campaigns').delete().eq('id', camp.id);
    await sb.from('customers').delete().eq('id', cust.id);
    await sb.from('delivery_areas').delete().eq('id', dstArea.id);
    await sb.from('delivery_areas').delete().eq('id', srcArea.id);
    await sb.from('bakeries').delete().eq('id', dst.id);
    await sb.from('bakeries').delete().eq('id', src.id);
  };

  try {
    const preview = await Admin.previewReassignment(dst.id);
    const relevant = preview.moves.filter(m => m.recipient_id === recip.id);
    assert.equal(relevant.length, 1);
    assert.equal(relevant[0].old_bakery_id, src.id);
    assert.equal(relevant[0].old_area_id, srcArea.id);
    assert.equal(relevant[0].new_area_id, dstArea.id);
    assert.equal(relevant[0].strip_tag, true);

    // Scope apply() to ONLY our test recipient so we don't touch real data.
    const scopedPreview = {
      ...preview,
      moves: relevant,
      route_keys_old: [{ campaign_id: camp.id, bakery_id: src.id, delivery_area_id: srcArea.id }],
      route_keys_new: [{ campaign_id: camp.id, bakery_id: dst.id, delivery_area_id: dstArea.id }],
    };
    const result = await Admin.applyReassignment(dst.id, scopedPreview);
    assert.equal(result.moved, 1);
    assert.equal(result.routes_deleted_old, 1);

    const { data: after } = await sb.from('recipients').select('*').eq('id', recip.id).single();
    assert.equal(after.bakery_id, dst.id, 'bakery_id should be rewritten to dst');
    assert.equal(after.customizations?.legacy_region, undefined, 'legacy_region should be stripped');

    const { data: afterRoute } = await sb.from('routes').select('*').eq('id', stale.id).maybeSingle();
    assert.equal(afterRoute, null, 'stale route should be deleted');
  } finally {
    await cleanup();
  }
});
