// ===== UPLOAD: COLUMN-MAPPING HEURISTIC =====
// Pure deterministic fallback used when the AI is disabled or down. Returns
// per-source-column { mapping, confidence } in the same shape the edge
// function produces, so the wizard can render a single "AI failed" path.

const TARGETS = ['company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip'];

// Synonyms are stored already-normalized (lowercase, alphanumeric+space only).
// Mirror this table verbatim in supabase/functions/ingest-recipients/ai.ts —
// both fallbacks must produce identical output for the same headers.
const SYNONYMS = {
  company: ['company', 'business name', 'business', 'customer', 'customer name', 'account', 'practice', 'office', 'organization', 'org'],
  contact_name: ['contact', 'contact name', 'name', 'recipient', 'recipient name', 'attention', 'attn'],
  phone: ['phone', 'telephone', 'cell', 'mobile', 'phone number'],
  email: ['email', 'e mail', 'mail', 'email address'],
  address: ['address', 'street', 'street address', 'address 1', 'address1', 'addr', 'addr 1'],
  city: ['city', 'city town', 'town', 'municipality'],
  state: ['state', 'province', 'region', 'st', 'state province'],
  zip: ['zip', 'zip code', 'postal', 'postal code', 'postcode'],
};

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function suggestMapping(headers) {
  const mapping = {};
  const confidence = {};
  for (const header of headers || []) {
    const norm = normalize(header);
    let matched = null;
    let score = 'low';
    for (const target of TARGETS) {
      const synonyms = SYNONYMS[target];
      if (synonyms.includes(norm)) {
        matched = target;
        score = synonyms[0] === norm ? 'high' : 'medium';
        break;
      }
    }
    mapping[header] = matched;
    confidence[header] = matched ? score : 'low';
  }
  return { mapping, confidence };
}

if (typeof window !== 'undefined') window.suggestMapping = suggestMapping;
