import { randomBytes } from 'node:crypto';

export function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function generateToken(bytes = 24) {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Monotone-chain convex hull. Input: [{lat, lon}, …]. Output: GeoJSON-ring
// [[lon, lat], …] with first === last. Longitude is x, latitude is y.
export function convexHull(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  // Dedupe and sort by lon asc, lat asc
  const pts = Array.from(
    new Map(points.map(p => [`${p.lon},${p.lat}`, p])).values()
  ).sort((a, b) => a.lon - b.lon || a.lat - b.lat);

  if (pts.length === 1) {
    const p = [pts[0].lon, pts[0].lat];
    return [p, p];
  }

  const cross = (o, a, b) =>
    (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper).map(p => [p.lon, p.lat]);
  // Close the ring
  hull.push(hull[0]);
  return hull;
}
