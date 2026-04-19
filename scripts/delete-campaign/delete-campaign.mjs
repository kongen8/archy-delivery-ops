// Soft-delete (or restore) a campaign by id. Service-role only — bypasses
// RLS so admins can act on any tenant. Defaults to delete; pass --restore
// to clear deleted_at.
//
// Usage:
//   node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid>
//   node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid> --restore
//
// Refuses to delete unless status='draft'. Restore has no status check
// (admins decide what's appropriate).

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

function parseArgs(argv) {
  const out = { campaignId: null, restore: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--campaign-id') { out.campaignId = argv[++i]; }
    else if (a === '--restore') { out.restore = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else { console.error('Unknown argument:', a); process.exit(2); }
  }
  return out;
}

function usage() {
  console.log('Usage: node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid> [--restore]');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (!args.campaignId) { usage(); process.exit(2); }

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(2);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: campaign, error: cErr } = await sb
  .from('campaigns')
  .select('id, name, status, deleted_at, customer_id, created_at')
  .eq('id', args.campaignId)
  .maybeSingle();
if (cErr) { console.error('Lookup failed:', cErr.message); process.exit(1); }
if (!campaign) { console.error('Campaign', args.campaignId, 'not found'); process.exit(1); }

const { data: customer } = await sb
  .from('customers')
  .select('name')
  .eq('id', campaign.customer_id)
  .maybeSingle();

const { count: recipientCount } = await sb
  .from('recipients')
  .select('id', { count: 'exact', head: true })
  .eq('campaign_id', campaign.id);

console.log('Campaign:');
console.log('  id:         ', campaign.id);
console.log('  name:       ', campaign.name);
console.log('  customer:   ', customer?.name || '(unknown)', '(' + campaign.customer_id + ')');
console.log('  status:     ', campaign.status);
console.log('  created_at: ', campaign.created_at);
console.log('  deleted_at: ', campaign.deleted_at || '(null)');
console.log('  recipients: ', recipientCount ?? '?');
console.log('');

if (args.restore) {
  if (!campaign.deleted_at) {
    console.error('Refusing to restore: campaign is not deleted (deleted_at is null).');
    process.exit(1);
  }
} else {
  if (campaign.status !== 'draft') {
    console.error('Refusing to delete: status is "' + campaign.status + '". Only drafts can be deleted.');
    process.exit(1);
  }
  if (campaign.deleted_at) {
    console.error('Refusing to delete: already deleted at', campaign.deleted_at);
    process.exit(1);
  }
}

const rl = readline.createInterface({ input, output });
const prompt = args.restore ? 'Restore this campaign? [y/N] ' : 'Soft-delete this campaign? [y/N] ';
const answer = (await rl.question(prompt)).trim().toLowerCase();
rl.close();
if (answer !== 'y') { console.log('Aborted.'); process.exit(0); }

// Guard the UPDATE the same way the customer helper does. The interactive
// prompt above can sit open for seconds or minutes — if anything changes the
// row's status (or its deleted_at) in the meantime, we must abort instead of
// silently overwriting a row that's no longer eligible.
const update = args.restore ? { deleted_at: null } : { deleted_at: new Date().toISOString() };
let q = sb.from('campaigns').update(update).eq('id', campaign.id);
q = args.restore
  ? q.not('deleted_at', 'is', null)
  : q.eq('status', 'draft').is('deleted_at', null);
const { data: updated, error: uErr } = await q.select('deleted_at').maybeSingle();
if (uErr) { console.error('Update failed:', uErr.message); process.exit(1); }
if (!updated) {
  console.error('Aborted: campaign state changed since the prompt; nothing was modified.');
  process.exit(1);
}

console.log(args.restore ? 'Restored.' : 'Soft-deleted.', 'deleted_at =', updated.deleted_at);
