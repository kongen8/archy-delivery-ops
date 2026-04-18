// One-shot cleanup: delete the 3 duplicate "Boho Petite – Chestnut St (test)"
// rows created by the pre-fix DepotManager edit bug (INSERT instead of UPDATE).
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: dupes, error } = await sb
  .from('depots')
  .select('id,name')
  .ilike('name', '%(test)%');

if (error) { console.error(error); process.exit(1); }

console.log(`Found ${dupes.length} (test) rows; deleting...`);
for (const d of dupes) {
  const { error: delErr } = await sb.from('depots').delete().eq('id', d.id);
  if (delErr) console.error(`  fail ${d.id}: ${delErr.message}`);
  else console.log(`  deleted ${d.id}  (${d.name})`);
}
console.log('done.');
