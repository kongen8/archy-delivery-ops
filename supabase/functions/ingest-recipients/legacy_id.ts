// Stable per-row identifier. sha256(lowercased(company) + '|' + lowercased(address))
// hex digest. Same row across re-uploads → same legacy_id → ON CONFLICT skips it.
export async function legacyId(company: string, address: string): Promise<string> {
  const norm = (company || '').trim().toLowerCase() + '|' + (address || '').trim().toLowerCase();
  const buf = new TextEncoder().encode(norm);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
