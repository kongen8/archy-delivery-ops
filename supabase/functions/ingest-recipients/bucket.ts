// ===== BUCKET PRECEDENCE =====
// needs_review > geocode_failed > flagged_out_of_area > assigned
// Geocode + area match are not yet wired in Task 5; this returns 'assigned'
// for any row that has a non-empty company + address. Tasks 8 + 9 plug in
// the geocode/area inputs.
export type Bucket = 'assigned' | 'needs_review' | 'flagged_out_of_area' | 'geocode_failed';

export interface BucketInputs {
  hasCompany: boolean;
  hasAddress: boolean;
  aiConfidence?: 'low' | 'medium' | 'high';
  geocodeOk: boolean;
  areaMatch: { bakery_id: string } | null;
}

export function bucketFor(input: BucketInputs): Bucket {
  if (!input.hasCompany || !input.hasAddress) return 'needs_review';
  if (input.aiConfidence === 'low') return 'needs_review';
  if (!input.geocodeOk) return 'geocode_failed';
  if (!input.areaMatch) return 'flagged_out_of_area';
  return 'assigned';
}
