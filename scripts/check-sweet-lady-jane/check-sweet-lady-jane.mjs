import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: bakeries, error: bErr } = await sb
  .from('bakeries')
  .select('id,name,access_token,created_at')
  .ilike('name', '%sweet lady jane%');
if (bErr) throw bErr;

console.log('--- bakeries matching "sweet lady jane" ---');
for (const b of bakeries) {
  console.log(`${b.name}  id=${b.id}  token=${b.access_token}  created=${b.created_at}`);
}
if (!bakeries.length) {
  console.log('(none)');
  process.exit(0);
}

const ids = bakeries.map(b => b.id);

const { data: areas } = await sb
  .from('delivery_areas')
  .select('id,bakery_id,name,geometry,created_at')
  .in('bakery_id', ids);
console.log(`\n--- delivery_areas (${areas.length}) ---`);
for (const a of areas) {
  const g = a.geometry || {};
  let extent = '';
  try {
    const coords = g.type === 'Polygon' ? [g.coordinates[0]]
      : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0])
      : [];
    const all = coords.flat();
    if (all.length) {
      const lons = all.map(c => c[0]); const lats = all.map(c => c[1]);
      extent = `lon[${Math.min(...lons).toFixed(3)}, ${Math.max(...lons).toFixed(3)}] lat[${Math.min(...lats).toFixed(3)}, ${Math.max(...lats).toFixed(3)}]`;
    }
  } catch {}
  console.log(`  ${a.name || '(unnamed)'}  type=${g.type}  ${extent}  id=${a.id.slice(0,8)}`);
}

const { data: depots } = await sb
  .from('depots')
  .select('id,bakery_id,name,address,lat,lon,created_at')
  .in('bakery_id', ids);
console.log(`\n--- depots (${depots.length}) ---`);
for (const d of depots) {
  console.log(`  ${d.name}  |  ${d.address}  |  (${d.lat}, ${d.lon})  id=${d.id.slice(0,8)}`);
}

const { data: assigned, error: rErr } = await sb
  .from('recipients')
  .select('id,campaign_id,company,city,state,assignment_status,created_at', { count: 'exact' })
  .in('bakery_id', ids)
  .limit(20);
if (rErr) throw rErr;
console.log(`\n--- recipients assigned to SLJ bakery (showing first 20) ---`);
for (const r of assigned) {
  console.log(`  ${r.company}  ${r.city || ''}, ${r.state || ''}  status=${r.assignment_status}  campaign=${r.campaign_id.slice(0,8)}`);
}
if (!assigned.length) console.log('  (none)');

const { count: assignedCount } = await sb
  .from('recipients')
  .select('id', { count: 'exact', head: true })
  .in('bakery_id', ids);
console.log(`  total assigned: ${assignedCount}`);

const { data: laRecips, count: laCount } = await sb
  .from('recipients')
  .select('id,campaign_id,bakery_id,company,city,state,address,assignment_status,lat,lon', { count: 'exact' })
  .or('city.ilike.%los angeles%,state.eq.CA,address.ilike.%los angeles%')
  .limit(25);
console.log(`\n--- LA-ish recipients (any bakery) — count=${laCount}, sample first 25 ---`);
for (const r of laRecips || []) {
  console.log(`  ${r.company}  ${r.city || ''}, ${r.state || ''}  bakery=${r.bakery_id ? r.bakery_id.slice(0,8) : 'NULL'}  status=${r.assignment_status}  (${r.lat}, ${r.lon})`);
}

const { data: campaigns } = await sb
  .from('campaigns')
  .select('id,name,status,created_at,customer_id')
  .order('created_at', { ascending: false })
  .limit(10);
console.log(`\n--- recent campaigns ---`);
for (const c of campaigns || []) {
  console.log(`  ${c.name}  status=${c.status}  id=${c.id.slice(0,8)}  customer=${c.customer_id.slice(0,8)}  ${c.created_at}`);
}

const { data: routes } = await sb
  .from('routes')
  .select('id,campaign_id,bakery_id,updated_at')
  .in('bakery_id', ids);
console.log(`\n--- routes for SLJ (${(routes||[]).length}) ---`);
for (const r of routes || []) {
  console.log(`  campaign=${r.campaign_id.slice(0,8)}  updated=${r.updated_at}`);
}
