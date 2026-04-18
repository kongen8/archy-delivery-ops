// Prints every tenant's access token plus a ready-to-click dev URL so the
// operator can one-click into each bakery / customer view.
//
// Usage:
//   node scripts/print-tenant-tokens/print-tenant-tokens.mjs
//   node scripts/print-tenant-tokens/print-tenant-tokens.mjs --base http://localhost:8000
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const BASE = args.base || 'http://localhost:8000';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function header(title) {
  console.log('\n' + title);
  console.log('='.repeat(title.length));
}

function row(name, token) {
  const url = `${BASE}/?tok=${encodeURIComponent(token)}`;
  console.log(`  ${name.padEnd(30)}  ${token.slice(0, 12)}…  →  ${url}`);
}

const [{ data: bakeries, error: bErr }, { data: customers, error: cErr }] = await Promise.all([
  sb.from('bakeries').select('name,access_token').order('name'),
  sb.from('customers').select('name,access_token').order('name'),
]);

if (bErr) { console.error('bakeries fetch failed:', bErr); process.exit(1); }
if (cErr) { console.error('customers fetch failed:', cErr); process.exit(1); }

header(`Bakeries (${(bakeries || []).length})`);
(bakeries || []).forEach(b => row(b.name, b.access_token));

header(`Customers (${(customers || []).length})`);
(customers || []).forEach(c => row(c.name, c.access_token));

console.log('\nPaste one of these links into your browser to sign in.');
console.log('The token is saved to localStorage; visit ' + BASE + ' with no ?tok= to use the saved token.');
console.log('To sign out, open the browser console and run: tenantSignOut()\n');
