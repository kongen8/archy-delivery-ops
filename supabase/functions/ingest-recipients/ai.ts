// ===== OpenAI calls used by ingest-recipients =====
// Two functions: aiSuggestMapping (1 call, returns column→target mapping) and
// aiNormalizeRows (Task 7, batches of 20). Both use temperature=0 and
// response_format json_object so output is parseable.
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const TARGETS = ['company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip'];

export interface MappingResult {
  mapping: Record<string, string | null>;
  confidence: Record<string, 'low' | 'medium' | 'high'>;
}

export async function aiSuggestMapping(headers: string[], sampleRows: string[][]): Promise<MappingResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const sample = sampleRows.slice(0, 5).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
  const prompt = `You are mapping spreadsheet columns to a fixed schema.
Targets: ${TARGETS.join(', ')}.
Each header may map to AT MOST ONE target, and the same target may not be assigned to two headers.
If a header doesn't fit any target, map it to null.
Return JSON: {"mapping": {<header>: <target|null>}, "confidence": {<header>: "low"|"medium"|"high"}}.

Headers: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sample)}`;

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('OpenAI mapping call failed: ' + res.status);
  const json = await res.json();
  const parsed = JSON.parse(json.choices[0].message.content);
  return parsed as MappingResult;
}

// Mirrors public/src/upload/columns.js. Used when OPENAI_API_KEY is missing
// or aiSuggestMapping throws — keeps the pipeline alive.
//
// IMPORTANT: this SYNONYMS table MUST stay in sync with public/src/upload/columns.js.
// All entries are stored already-normalized (lowercase + alphanumeric+space only)
// because lookup compares against `normalize(header)` output.
const SYNONYMS: Record<string, string[]> = {
  company: ['company', 'business name', 'business', 'customer', 'customer name', 'account', 'practice', 'office', 'organization', 'org'],
  contact_name: ['contact', 'contact name', 'name', 'recipient', 'recipient name', 'attention', 'attn'],
  phone: ['phone', 'telephone', 'cell', 'mobile', 'phone number'],
  email: ['email', 'e mail', 'mail', 'email address'],
  address: ['address', 'street', 'street address', 'address 1', 'address1', 'addr', 'addr 1'],
  city: ['city', 'city town', 'town', 'municipality'],
  state: ['state', 'province', 'region', 'st', 'state province'],
  zip: ['zip', 'zip code', 'postal', 'postal code', 'postcode'],
};

function normalize(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function fallbackMapping(headers: string[]): MappingResult {
  const mapping: Record<string, string | null> = {};
  const confidence: Record<string, 'low' | 'medium' | 'high'> = {};
  for (const h of headers) {
    const norm = normalize(h);
    let matched: string | null = null;
    let score: 'low' | 'medium' | 'high' = 'low';
    for (const target of TARGETS) {
      const synonyms = SYNONYMS[target];
      if (synonyms.includes(norm)) {
        matched = target;
        score = synonyms[0] === norm ? 'high' : 'medium';
        break;
      }
    }
    mapping[h] = matched;
    confidence[h] = matched ? score : 'low';
  }
  return { mapping, confidence };
}
