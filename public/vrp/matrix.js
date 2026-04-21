/**
 * VRP — Distance Matrix Service
 *
 * Builds an N×N travel-time matrix (seconds) for a set of geographic nodes using
 * the OSRM public table API. Designed to run inside a Web Worker, but also safe
 * on the main thread (relies only on fetch + standard typed arrays).
 *
 * Public API (exposed on self.VRP_MATRIX):
 *   buildTimeMatrix(nodes, onProgress) -> Promise<{matrix: Int32Array, n: number}>
 *     nodes: Array<{lt: number, ln: number}>
 *     onProgress: optional (done, total, message) => void
 *
 *   haversineSec(a, b) -> number  (fallback per-cell travel time in seconds)
 *
 * OSRM public server constraints we respect:
 *   - /table endpoint: <=100 sources × 100 destinations per request. We use 80
 *     as a safety margin.
 *   - Unofficial sustained rate limit ~1 req/s. We space requests by OSRM_SPACING_MS.
 *   - 429 / 5xx: exponential backoff with jitter, up to MAX_RETRIES attempts.
 *     If a chunk still fails, we fill those cells with a Haversine estimate so
 *     the solver can still run (degraded accuracy rather than total failure).
 *
 * Matrix layout:
 *   matrix[i * n + j] = seconds to drive from nodes[i] to nodes[j]
 *   matrix[i * n + i] = 0
 *   Stored as Int32Array so it's transferable between main thread and Worker
 *   with zero copy.
 */

(function(global){
  'use strict';

  // Use the Vercel /osrm proxy in production to sidestep OSRM's CORS policy.
  // self.location is the worker's script origin, which matches the page.
  // Local dev hits the public OSRM server directly (no proxy configured).
  const _hostname = (self.location && self.location.hostname) || '';
  const _isLocal = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(_hostname);
  const OSRM_BASE = _isLocal
    ? 'https://router.project-osrm.org/table/v1/driving/'
    : '/osrm/table/v1/driving/';
  const CHUNK = 80;
  const OSRM_SPACING_MS = 350;
  const MAX_RETRIES = 4;
  const HAVERSINE_SPEED_KMH = 30;
  const ROAD_FACTOR = 1.4; // straight-line → road distance fudge

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  function haversineKm(lat1, lon1, lat2, lon2){
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
              Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function haversineSec(a, b){
    const km = haversineKm(a.lt, a.ln, b.lt, b.ln);
    return Math.round(km * ROAD_FACTOR / HAVERSINE_SPEED_KMH * 3600);
  }

  function fillHaversineBlock(matrix, n, nodes, rowStart, rowEnd, colStart, colEnd){
    for (let i = rowStart; i < rowEnd; i++){
      for (let j = colStart; j < colEnd; j++){
        if (i === j){ matrix[i*n + j] = 0; continue; }
        matrix[i*n + j] = haversineSec(nodes[i], nodes[j]);
      }
    }
  }

  async function fetchTableChunk(nodes, sourceIdxs, destIdxs){
    // Build coordinate string: union of all involved indices
    const allIdxs = Array.from(new Set([...sourceIdxs, ...destIdxs]));
    const idxToLocal = new Map(allIdxs.map((gi, li) => [gi, li]));
    const coords = allIdxs.map(gi => `${nodes[gi].ln},${nodes[gi].lt}`).join(';');
    const sources = sourceIdxs.map(gi => idxToLocal.get(gi)).join(';');
    const destinations = destIdxs.map(gi => idxToLocal.get(gi)).join(';');
    const url = `${OSRM_BASE}${coords}?sources=${sources}&destinations=${destinations}&annotations=duration`;

    let attempt = 0;
    let delay = 500;
    while (true) {
      try {
        const resp = await fetch(url);
        if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
          throw new Error('retryable_' + resp.status);
        }
        if (!resp.ok) throw new Error('osrm_http_' + resp.status);
        const json = await resp.json();
        if (json.code !== 'Ok' || !json.durations) throw new Error('osrm_bad_response');
        return json.durations; // 2D array: sources × destinations
      } catch (e) {
        attempt++;
        if (attempt > MAX_RETRIES) throw e;
        // Exponential backoff with jitter
        const jitter = Math.random() * 250;
        await sleep(delay + jitter);
        delay *= 2;
      }
    }
  }

  async function buildTimeMatrix(nodes, onProgress){
    const n = nodes.length;
    const matrix = new Int32Array(n * n);

    if (n <= 1) {
      return { matrix, n };
    }

    // Build chunk plan: iterate row-blocks × col-blocks
    const chunks = [];
    for (let i = 0; i < n; i += CHUNK) {
      for (let j = 0; j < n; j += CHUNK) {
        chunks.push({
          rowStart: i, rowEnd: Math.min(i + CHUNK, n),
          colStart: j, colEnd: Math.min(j + CHUNK, n),
        });
      }
    }

    const total = chunks.length;
    let done = 0;

    for (const c of chunks) {
      const sourceIdxs = [];
      for (let i = c.rowStart; i < c.rowEnd; i++) sourceIdxs.push(i);
      const destIdxs = [];
      for (let j = c.colStart; j < c.colEnd; j++) destIdxs.push(j);

      try {
        const durations = await fetchTableChunk(nodes, sourceIdxs, destIdxs);
        for (let li = 0; li < sourceIdxs.length; li++) {
          for (let lj = 0; lj < destIdxs.length; lj++) {
            const gi = sourceIdxs[li], gj = destIdxs[lj];
            const d = durations[li] && durations[li][lj];
            if (d == null) {
              matrix[gi*n + gj] = (gi === gj) ? 0 : haversineSec(nodes[gi], nodes[gj]);
            } else {
              matrix[gi*n + gj] = Math.round(d);
            }
          }
        }
      } catch (e) {
        // Degraded: fill block with Haversine fallback so the solver still runs.
        fillHaversineBlock(matrix, n, nodes, c.rowStart, c.rowEnd, c.colStart, c.colEnd);
        if (onProgress) onProgress(done, total, 'Matrix chunk failed, using Haversine fallback');
      }

      done++;
      if (onProgress) onProgress(done, total, `Computing distances ${done}/${total}`);

      // Rate-limit spacing (skip on last chunk)
      if (done < total) await sleep(OSRM_SPACING_MS);
    }

    return { matrix, n };
  }

  global.VRP_MATRIX = {
    buildTimeMatrix,
    haversineSec,
    haversineKm,
  };
})(typeof self !== 'undefined' ? self : this);
