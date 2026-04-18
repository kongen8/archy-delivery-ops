import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
dotenv.config({ path: join(REPO_ROOT, '.env') });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function count(table, filter = {}) {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { count: n, error } = await q;
  if (error) throw error;
  return n;
}

async function main() {
  const bakeries = await count('bakeries');
  const customers = await count('customers');
  const campaigns = await count('campaigns');
  const recipients = await count('recipients');
  const assigned = await count('recipients', { assignment_status: 'assigned' });
  const areas = await count('delivery_areas');
  const depots = await count('depots');
  const routes = await count('routes');

  console.log('Counts after migration:');
  console.log('  bakeries:       ', bakeries, '(expect 4: Boho Petite, Sweet Lady Jane, SmallCakes, Rolands)');
  console.log('  customers:      ', customers, '(expect >=1: Archy)');
  console.log('  campaigns:      ', campaigns, '(expect >=1)');
  console.log('  recipients:     ', recipients, '(expect 918 from current routes.js)');
  console.log('  assigned recips:', assigned, '(expect === recipients)');
  console.log('  delivery_areas: ', areas, '(expect 5: one per region)');
  console.log('  depots:         ', depots, '(expect sum of ROUTE_DATA[*].depots.length)');
  console.log('  routes:         ', routes, '(expect 2: one per migrated route_overrides row, keyed by delivery_area)');

  const { data: sample } = await sb
    .from('recipients')
    .select('id, company, address, lat, lon, bakery_id, legacy_id')
    .limit(1)
    .single();
  console.log('\nSample recipient:', sample);
  if (!sample.bakery_id || !sample.lat || !sample.lon) {
    console.error('FAIL: sample recipient missing bakery_id or coordinates');
    process.exit(1);
  }

  console.log('\nOK.');
}

main().catch(e => { console.error(e); process.exit(1); });
