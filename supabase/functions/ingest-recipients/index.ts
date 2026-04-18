// ===== ingest-recipients edge function =====
// Plan 3 customer upload pipeline. POST endpoint that accepts a base64-
// encoded CSV/XLSX file plus a confirmed column mapping, runs the full
// pipeline (parse → AI cleanup → geocode → area-match → bucket → bulk
// insert into recipients), and returns per-bucket totals plus a small
// sample of problem rows for the wizard to seed Step 3.
import { createClient } from '@supabase/supabase-js';

interface IngestRequest {
  campaign_id: string;
  file_b64: string;
  file_type: 'csv' | 'xlsx';
  column_mapping?: Record<string, string | null>;
  ai_disabled?: boolean;
}

interface IngestResponse {
  totals: { assigned: number; needs_review: number; flagged_out_of_area: number; geocode_failed: number };
  sample_issues: Array<{ recipient_id: string; reason: string; raw: Record<string, string>; suggested?: Record<string, string | null> }>;
  mapping_used: Record<string, string | null>;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: IngestRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!body.campaign_id || !body.file_b64 || !body.file_type) {
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Skeleton: confirm campaign exists, return empty totals. Full pipeline
  // is wired in subsequent tasks.
  const { data: campaign, error } = await sb
    .from('campaigns').select('id').eq('id', body.campaign_id).maybeSingle();
  if (error) return jsonResponse({ error: error.message }, 500);
  if (!campaign) return jsonResponse({ error: 'campaign_not_found' }, 404);

  const response: IngestResponse = {
    totals: { assigned: 0, needs_review: 0, flagged_out_of_area: 0, geocode_failed: 0 },
    sample_issues: [],
    mapping_used: body.column_mapping || {},
  };
  return jsonResponse(response);
});
