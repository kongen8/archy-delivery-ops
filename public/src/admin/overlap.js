// ===== OVERLAP HELPER =====
// Returns true if `feature` overlaps any feature in `others`. We measure
// the intersection polygon's area in m²; only an area > 1 m² counts as
// overlap. Shared edges produce zero-area intersections, which is what
// we want — edge contact is allowed.
function anyOverlap(feature, others) {
  if (!feature || !Array.isArray(others) || others.length === 0) return false;
  if (typeof turf === 'undefined') return false;
  const EPS_M2 = 1;
  for (const o of others) {
    if (!o || !o.geometry) continue;
    try {
      const inter = turf.intersect(turf.featureCollection([feature, o]));
      if (!inter) continue;
      const a = turf.area(inter);
      if (a > EPS_M2) return true;
    } catch (e) { /* skip malformed geometry */ }
  }
  return false;
}

if (typeof window !== 'undefined') window.anyOverlap = anyOverlap;
