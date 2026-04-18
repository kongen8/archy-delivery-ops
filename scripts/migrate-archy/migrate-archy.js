import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { generateToken, convexHull, normalizeAddress } from './lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
dotenv.config({ path: join(REPO_ROOT, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false }
});

const REGION_BAKERY = {
  'SF': 'Boho Petite',
  'South Bay / Peninsula': 'Boho Petite',
  'LA': 'Sweet Lady Jane',
  'Orlando': 'SmallCakes',
  'Houston': "Roland's Swiss Pastries",
};

function loadRouteData() {
  const src = readFileSync(join(REPO_ROOT, 'public', 'data', 'routes.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.ROUTE_DATA;
}

async function upsertByName(table, name, row) {
  const { data: existing } = await sb.from(table).select('*').eq('name', name).maybeSingle();
  if (existing) return existing;
  const { data, error } = await sb.from(table).insert(row).select('*').single();
  if (error) throw error;
  return data;
}

async function migrateBakeries() {
  const uniqueBakeries = [...new Set(Object.values(REGION_BAKERY))];
  const bakeries = {};
  for (const name of uniqueBakeries) {
    bakeries[name] = await upsertByName('bakeries', name, {
      name,
      access_token: generateToken(),
    });
  }
  return bakeries;
}

async function migrateCustomer() {
  return upsertByName('customers', 'Archy', {
    name: 'Archy',
    contact_email: 'contact@archy.com',
    access_token: generateToken(),
  });
}

async function migrateCampaign(customerId) {
  const name = 'Archy × Daymaker Q2 2026';
  const { data: existing } = await sb
    .from('campaigns')
    .select('*')
    .eq('customer_id', customerId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return existing;
  const { data, error } = await sb
    .from('campaigns')
    .insert({ customer_id: customerId, name, status: 'active' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function migrateDepots(routeData, bakeries) {
  for (const [region, data] of Object.entries(routeData)) {
    const bakery = bakeries[REGION_BAKERY[region]];
    if (!bakery || !Array.isArray(data.depots)) continue;
    for (const d of data.depots) {
      const { data: existing } = await sb
        .from('depots')
        .select('id')
        .eq('bakery_id', bakery.id)
        .eq('name', d.name)
        .maybeSingle();
      if (existing) continue;
      const { error } = await sb.from('depots').insert({
        bakery_id: bakery.id,
        name: d.name,
        address: d.addr || '',
        lat: d.lat,
        lon: d.lon,
      });
      if (error) throw error;
    }
  }
}

async function migrateDeliveryAreas(routeData, bakeries) {
  for (const [region, data] of Object.entries(routeData)) {
    const bakery = bakeries[REGION_BAKERY[region]];
    if (!bakery) continue;
    const allStops = data.days.flatMap(d => d.routes.flatMap(r => r.stops));
    const points = allStops.map(s => ({ lat: s.lt, lon: s.ln }));
    const ring = convexHull(points);
    if (ring.length < 4) continue;
    const geometry = {
      type: 'Polygon',
      coordinates: [ring],
    };
    const areaName = `${region} (migrated)`;
    const { data: existing } = await sb
      .from('delivery_areas')
      .select('id')
      .eq('bakery_id', bakery.id)
      .eq('name', areaName)
      .maybeSingle();
    if (existing) continue;
    const { error } = await sb.from('delivery_areas').insert({
      bakery_id: bakery.id,
      name: areaName,
      geometry,
    });
    if (error) throw error;
  }
}

async function migrateRecipients(routeData, campaign, bakeries) {
  const rows = [];
  for (const [region, data] of Object.entries(routeData)) {
    const bakery = bakeries[REGION_BAKERY[region]];
    if (!bakery) continue;
    for (const day of data.days) {
      for (const route of day.routes) {
        for (const s of route.stops) {
          rows.push({
            campaign_id: campaign.id,
            bakery_id: bakery.id,
            legacy_id: s.id,
            company: s.co || '',
            contact_name: s.cn || null,
            phone: s.ph || null,
            email: null,
            address: s.ad || '',
            city: s.ci || null,
            state: s.st || null,
            zip: s.zp || null,
            lat: s.lt,
            lon: s.ln,
            assignment_status: 'assigned',
            // legacy_region lets the adapter filter by original region without
            // relying on convex-hull point-in-polygon (which drops ~2% of stops
            // on hull boundaries due to floating-point). PIP stays as the path
            // for non-legacy recipients (future customer uploads).
            customizations: { legacy_region: region },
          });
        }
      }
    }
  }
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // ignoreDuplicates was `true` — but we need UPDATE-on-conflict so re-runs
    // can backfill `customizations.legacy_region` onto rows already inserted.
    // The row shape comes from `routes.js` which is the source of truth, so
    // overwriting is idempotent.
    const { error } = await sb
      .from('recipients')
      .upsert(batch, { onConflict: 'campaign_id,legacy_id' });
    if (error) throw error;
    console.log(`  inserted recipients ${i + 1}–${i + batch.length}`);
  }
  return rows.length;
}

async function migrateDeliveryStatuses(campaign) {
  const { data: oldStatuses, error } = await sb.from('delivery_statuses').select('*');
  if (error) {
    console.warn('Skipping delivery_statuses migration (legacy table absent or inaccessible):', error.message);
    return 0;
  }
  if (!oldStatuses || !oldStatuses.length) return 0;

  const { data: recips } = await sb
    .from('recipients')
    .select('id, legacy_id')
    .eq('campaign_id', campaign.id)
    .not('legacy_id', 'is', null);
  const lookup = new Map((recips || []).map(r => [r.legacy_id, r.id]));

  const toInsert = oldStatuses
    .filter(s => lookup.has(s.id))
    .map(s => ({
      recipient_id: lookup.get(s.id),
      status: s.status,
      note: s.note,
      photo_url: s.photo_url,
      delivered_at: s.delivered_at,
      updated_at: s.updated_at,
    }));

  if (!toInsert.length) return 0;
  const { error: ierr } = await sb
    .from('delivery_statuses_v2')
    .upsert(toInsert, { onConflict: 'recipient_id' });
  if (ierr) throw ierr;
  return toInsert.length;
}

async function migrateRouteOverrides(campaign, bakeries) {
  const { data: oldOverrides, error } = await sb.from('route_overrides').select('*');
  if (error) {
    console.warn('Skipping route_overrides migration (legacy table absent):', error.message);
    return 0;
  }
  if (!oldOverrides || !oldOverrides.length) return 0;

  // Each route override belongs to a region. In the new schema, routes are
  // keyed by (campaign_id, bakery_id, delivery_area_id) — look up the area
  // created earlier by migrateDeliveryAreas (named "<region> (migrated)").
  let count = 0;
  for (const row of oldOverrides) {
    const bakery = bakeries[REGION_BAKERY[row.region]];
    if (!bakery) continue;
    const areaName = `${row.region} (migrated)`;
    const { data: area } = await sb
      .from('delivery_areas')
      .select('id')
      .eq('bakery_id', bakery.id)
      .eq('name', areaName)
      .maybeSingle();
    if (!area) {
      console.warn(`  skipping route_override for region "${row.region}" (no delivery_area)`);
      continue;
    }
    const { error: uerr } = await sb.from('routes').upsert(
      {
        campaign_id: campaign.id,
        bakery_id: bakery.id,
        delivery_area_id: area.id,
        data: row.data,
      },
      { onConflict: 'campaign_id,bakery_id,delivery_area_id' }
    );
    if (uerr) throw uerr;
    count++;
  }
  return count;
}

async function main() {
  console.log('Loading public/data/routes.js…');
  const routeData = loadRouteData();
  console.log(`  regions: ${Object.keys(routeData).join(', ')}`);

  console.log('Upserting bakeries…');
  const bakeries = await migrateBakeries();
  for (const [name, b] of Object.entries(bakeries)) {
    console.log(`  ${name}  token=${b.access_token}`);
  }

  console.log('Upserting customer Archy…');
  const customer = await migrateCustomer();
  console.log(`  Archy customer token=${customer.access_token}`);

  console.log('Upserting campaign…');
  const campaign = await migrateCampaign(customer.id);
  console.log(`  campaign_id=${campaign.id}`);

  console.log('Upserting depots…');
  await migrateDepots(routeData, bakeries);

  console.log('Upserting delivery_areas (convex hull per region)…');
  await migrateDeliveryAreas(routeData, bakeries);

  console.log('Upserting recipients…');
  const rc = await migrateRecipients(routeData, campaign, bakeries);
  console.log(`  ${rc} recipients upserted`);

  console.log('Migrating delivery_statuses → delivery_statuses_v2…');
  const sc = await migrateDeliveryStatuses(campaign);
  console.log(`  ${sc} statuses migrated`);

  console.log('Migrating route_overrides → routes…');
  const ro = await migrateRouteOverrides(campaign, bakeries);
  console.log(`  ${ro} route rows migrated`);

  console.log('\nDONE.');
  console.log('SAVE THESE TOKENS (they cannot be recovered from logs cleanly):');
  console.log(`  Archy customer: ${customer.access_token}`);
  for (const [name, b] of Object.entries(bakeries)) {
    console.log(`  Bakery "${name}": ${b.access_token}`);
  }
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
