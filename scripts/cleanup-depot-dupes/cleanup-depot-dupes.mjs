// One-shot cleanup: delete non-production Boho Petite depots, keeping only the
// original "Boho Petite - Chestnut St" row. Needed whenever the DepotManager
// edit flow leaves phantom INSERT rows behind during development/debugging.
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const KEEP_PATTERN = /^Boho Petite - Chestnut St$/;
const { data: bohoBakery } = await sb.from('bakeries').select('id').eq('name', 'Boho Petite').maybeSingle();
if (!bohoBakery) { console.error('No Boho Petite bakery found'); process.exit(1); }

const { data: bohoDepots } = await sb.from('depots').select('id,name').eq('bakery_id', bohoBakery.id);
const toDelete = (bohoDepots || []).filter(d => !KEEP_PATTERN.test(d.name));
console.log(`Boho Petite depots: ${bohoDepots.length}; deleting ${toDelete.length} that don't match "${KEEP_PATTERN}"`);

for (const d of toDelete) {
  const { error } = await sb.from('depots').delete().eq('id', d.id);
  if (error) console.error(`  fail ${d.id}: ${error.message}`);
  else console.log(`  deleted ${d.id}  (${d.name})`);
}
console.log('done.');
