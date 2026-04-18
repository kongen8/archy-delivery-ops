import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: bakeries } = await sb.from('bakeries').select('id,name');
const { data: depots } = await sb.from('depots').select('*').order('bakery_id').order('created_at');
const byBk = new Map(bakeries.map(b => [b.id, b.name]));

console.log('--- depots (' + depots.length + ' total) ---');
for (const d of depots) {
  const short = d.id.slice(0, 8);
  console.log(`[${byBk.get(d.bakery_id) || '?'}]  ${d.name}  |  ${d.address}  |  id=${short}  |  ${d.created_at}`);
}
