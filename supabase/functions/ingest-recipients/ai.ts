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

export interface NormalizedRow {
  company: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  confidence: 'low' | 'medium' | 'high';
}

export async function aiNormalizeRows(rows: Record<string, string>[]): Promise<NormalizedRow[]> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  if (rows.length === 0) return [];
  if (rows.length > 20) throw new Error('aiNormalizeRows accepts at most 20 rows per call');

  // Strip empty fields before prompting so the AI doesn't treat "" as
  // "user said leave this blank" — absence means "derive if possible".
  const compactRows = rows.map(r => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) if (v && v.trim()) out[k] = v.trim();
    return out;
  });

  const prompt = `Clean these spreadsheet rows. RULES:
- Reformat existing values; never invent missing fields.
- A field is "missing" only when the input object does not contain that key.
  When a field IS present (e.g. "address"), you may parse it to derive city /
  state / zip even if those keys are absent.
- Aggressively split combined "address" fields into address + city + state + zip,
  even when no commas separate the parts. Use US postal conventions: a 5-digit
  ZIP is the zip, the 2-letter state code immediately precedes it, and the
  city is the words between the street suffix and the state. Only leave city
  / state / zip null if the address truly lacks that information.
  Examples:
    {"address": "330 Main St San Francisco CA 94105"} → address="330 Main St", city="San Francisco", state="CA", zip="94105".
    {"address": "12 Oak Ave, Boston, MA 02118"}       → address="12 Oak Ave", city="Boston", state="MA", zip="02118".
    {"address": "PO Box 17"}                          → address="PO Box 17", city=null, state=null, zip=null.
- For fields not present in the input AND not derivable, return null.
- Return per-row "confidence": "low" when company OR address is obviously corrupted, "high" otherwise, "medium" in between.
Return JSON: {"rows": [<NormalizedRow>...]} with all 9 keys (company, contact_name, phone, email, address, city, state, zip, confidence) in the SAME order as input.

Input rows: ${JSON.stringify(compactRows)}`;

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('OpenAI normalize call failed: ' + res.status);
  const json = await res.json();
  console.log('[normalize] raw content:', json.choices[0].message.content);
  const parsed = JSON.parse(json.choices[0].message.content);
  if (!Array.isArray(parsed.rows) || parsed.rows.length !== rows.length) {
    throw new Error('OpenAI returned wrong row count');
  }
  return parsed.rows;
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
