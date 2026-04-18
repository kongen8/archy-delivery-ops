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

const src = fs.readFileSync(path.resolve(process.cwd(), '../../public/src/db/admin.js'), 'utf8');
const mod = {};
new Function('sb', 'mod', src + '\nmod.Admin = Admin;')(sb, mod);
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
