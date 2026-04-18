// ===== REASSIGNMENT HELPER =====
// Pure, testable logic that decides which recipients should be moved to a
// target bakery given a fresh snapshot of areas + recipients. Separate from
// the Supabase-facing Admin.previewReassignment so it can be unit-tested
// without network I/O.

function _pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const hit = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function _pointInGeometry(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') {
    const [outer, ...holes] = geom.coordinates;
    if (!_pointInRing(lon, lat, outer)) return false;
    return !holes.some(h => _pointInRing(lon, lat, h));
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.some(poly => {
      const [outer, ...holes] = poly;
      if (!_pointInRing(lon, lat, outer)) return false;
      return !holes.some(h => _pointInRing(lon, lat, h));
    });
  }
  return false;
}

function _firstAreaContaining(areas, lon, lat) {
  for (const a of areas || []) {
    if (_pointInGeometry(lon, lat, a.geometry)) return a;
  }
  return null;
}

// computeReassignment({ thisBakeryId, thisBakeryAreas, otherBakeries, recipients })
// Returns { moves, summary, route_keys_old, route_keys_new } — see admin.js preview.
function computeReassignment({ thisBakeryId, thisBakeryAreas, otherBakeries, recipients }) {
  const byOld = {};
  const moves = [];
  let totalInside = 0;
  let alreadyHere = 0;
  const oldTripleSet = new Set();
  const newTripleSet = new Set();
  const otherById = new Map((otherBakeries || []).map(b => [b.id, b]));

  for (const r of recipients || []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const newArea = _firstAreaContaining(thisBakeryAreas, r.lon, r.lat);
    if (!newArea) continue;
    totalInside++;

    if (r.bakery_id === thisBakeryId) {
      alreadyHere++;
      continue;
    }

    const bucket = r.bakery_id || 'unassigned';
    byOld[bucket] = (byOld[bucket] || 0) + 1;

    let oldAreaId = null;
    if (r.bakery_id) {
      const oldBakery = otherById.get(r.bakery_id);
      if (oldBakery) {
        const tag = r.customizations && r.customizations.legacy_region;
        const byTag = tag ? (oldBakery.areas || []).find(a => (a.name || '').replace(/ \(migrated\)$/, '') === tag) : null;
        const oldArea = byTag || _firstAreaContaining(oldBakery.areas, r.lon, r.lat);
        if (oldArea) oldAreaId = oldArea.id;
      }
    }

    const stripTag = Boolean(r.customizations && r.customizations.legacy_region);

    moves.push({
      recipient_id: r.id,
      campaign_id: r.campaign_id,
      old_bakery_id: r.bakery_id || null,
      old_area_id: oldAreaId,
      new_area_id: newArea.id,
      strip_tag: stripTag,
    });

    if (r.campaign_id && r.bakery_id && oldAreaId) {
      oldTripleSet.add(r.campaign_id + '|' + r.bakery_id + '|' + oldAreaId);
    }
    if (r.campaign_id) {
      newTripleSet.add(r.campaign_id + '|' + thisBakeryId + '|' + newArea.id);
    }
  }

  const toTriple = key => {
    const [campaign_id, bakery_id, delivery_area_id] = key.split('|');
    return { campaign_id, bakery_id, delivery_area_id };
  };

  return {
    moves,
    summary: {
      total_inside: totalInside,
      already_here: alreadyHere,
      to_move: moves.length,
      by_old_bakery: byOld,
    },
    route_keys_old: Array.from(oldTripleSet).map(toTriple),
    route_keys_new: Array.from(newTripleSet).map(toTriple),
  };
}

if (typeof window !== 'undefined') window.computeReassignment = computeReassignment;
