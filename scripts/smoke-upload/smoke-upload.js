// One-shot smoke: create a draft campaign for the Archy customer, post the
// /tmp/smoke-recipients.csv file through the ingest-recipients edge function,
// and print the resulting URL so the browser MCP can drive the wizard's
// Step 3 (resume detection should jump straight there).
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const URL = 'https://vqmjevtthpedzdfotaie.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1); }

const sb = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

(async () => {
  const { data: customer, error: cErr } = await sb.from('customers').select('id, name').eq('name', 'Archy').single();
  if (cErr) throw cErr;
  console.log('customer:', customer.id, customer.name);

  const { data: campaign, error: campErr } = await sb.from('campaigns')
    .insert({ customer_id: customer.id, name: 'Smoke Test 2026-04-18 ' + new Date().getTime(), status: 'draft' })
    .select('*').single();
  if (campErr) throw campErr;
  console.log('campaign:', campaign.id, campaign.name);

  const file = fs.readFileSync('/tmp/smoke-recipients.csv');
  const b64 = file.toString('base64');

  const fnUrl = URL.replace('.supabase.co', '.functions.supabase.co') + '/ingest-recipients';
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaign_id: campaign.id, file_b64: b64, file_type: 'csv',
      column_mapping: { Company: 'company', Contact: 'contact_name', Address: 'address', City: 'city', State: 'state', Zip: 'zip' },
    }),
  });
  const json = await res.json();
  console.log('ingest status:', res.status);
  console.log('ingest result:', JSON.stringify(json, null, 2));

  console.log('\n>>> wizard URL:');
  console.log('http://localhost:8765/#/customer/' + customer.id + '/upload/' + campaign.id);
})().catch(e => { console.error(e); process.exit(1); });
