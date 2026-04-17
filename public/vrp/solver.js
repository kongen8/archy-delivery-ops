/**
 * VRP — Solver
 *
 * Pure, deterministic, no I/O. Given a precomputed travel-time matrix and a
 * problem spec, returns an assignment of stops to (day, depot, driver) with
 * sequenced routes.
 *
 * Exposed on self.VRP_SOLVER:
 *   solve(problem, onProgress) -> Solution
 *
 * Problem:
 *   matrix: Int32Array (n*n seconds, row-major; matrix[i*n+j] = i→j)
 *   n: number of nodes
 *   depotIndices: number[]  (indices into the node set that are depots)
 *   stopIndices: number[]   (indices that are stops)
 *   coords: {lt,ln}[]       (node coords, used only for cluster-first day split)
 *   numDays: number
 *   driversPerDay: number
 *   dayActiveDepots: number[][]   (per-day list of depot indices allowed; if
 *                                   null/empty, all depots are allowed)
 *   serviceTimeSec: number  (default 300)
 *   objective: 'makespan' | 'total' | 'makespan+total'
 *   alphaTotal: number  (weight for total when objective='makespan+total', default 0.1)
 *   seed: number        (RNG seed, default 1)
 *   timeBudgetMs: number (soft budget for ILS, default 8000)
 *
 * Solution:
 *   days: [{day: 1-based, routes: [{driverIdx, depotIdx, stopSequence,
 *          legTimesSec, driveTimeSec, serviceTimeSec, totalTimeSec}]}]
 *   objectiveValue: number
 *   iterations: number
 *   elapsedMs: number
 *
 * Algorithm:
 *   1. Day assignment via k-means (lloyd) on stop coords with k=numDays.
 *      Clusters sorted by centroid for day-ordering stability.
 *   2. Per day: assign each stop to nearest active depot by matrix time.
 *   3. Per (day, depot) cluster: Clarke-Wright savings construction, then split
 *      or merge to exactly depot-driver-count routes.
 *   4. Local search: best-improvement with the moves
 *        relocate, swap, 2-opt-intra, or-opt (chain size 2 & 3),
 *        cross-exchange (segment swap between routes).
 *      Runs until no improving move exists in a full pass.
 *   5. Iterated Local Search: perturb (random relocations on the longest route
 *      and its neighbors), re-run local search, keep if better. Loops until
 *      timeBudget exhausted or MAX_NO_IMPROVE restarts happen.
 *
 * Objective (smaller is better):
 *   makespan:        max over routes of totalTime
 *   total:           sum over routes of driveTime
 *   makespan+total:  makespan + alphaTotal * total   (default — balances drivers
 *                    while still preferring shorter total mileage as a tiebreaker)
 */

(function(global){
  'use strict';

  // ========== Utilities ==========

  function mulberry32(seed){
    let a = (seed | 0) || 1;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function t(matrix, n, i, j){ return matrix[i * n + j]; }

  function sumArr(a){ let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }

  function haversineKm(lat1, lon1, lat2, lon2){
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
              Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // ========== Day assignment (k-means on coords) ==========

  function kmeansDays(stopIdxs, coords, k, rng){
    if (k <= 1 || stopIdxs.length <= k) {
      // Trivial: one day, or fewer stops than days
      const clusters = Array.from({length: k}, () => []);
      stopIdxs.forEach((si, i) => clusters[i % k].push(si));
      return clusters;
    }

    // k-means++ init
    const centers = [];
    const firstIdx = Math.floor(rng() * stopIdxs.length);
    centers.push({ lt: coords[stopIdxs[firstIdx]].lt, ln: coords[stopIdxs[firstIdx]].ln });

    while (centers.length < k) {
      const dists = stopIdxs.map(si => {
        const s = coords[si];
        let minD = Infinity;
        for (const c of centers) {
          const d = (s.lt-c.lt)**2 + (s.ln-c.ln)**2;
          if (d < minD) minD = d;
        }
        return minD;
      });
      const total = sumArr(dists);
      if (total === 0) {
        centers.push({ lt: coords[stopIdxs[0]].lt, ln: coords[stopIdxs[0]].ln });
        continue;
      }
      const r = rng() * total;
      let acc = 0, pick = 0;
      for (let i = 0; i < dists.length; i++) {
        acc += dists[i];
        if (acc >= r) { pick = i; break; }
      }
      centers.push({ lt: coords[stopIdxs[pick]].lt, ln: coords[stopIdxs[pick]].ln });
    }

    let assign = new Array(stopIdxs.length).fill(0);
    for (let iter = 0; iter < 50; iter++) {
      let changed = false;
      for (let i = 0; i < stopIdxs.length; i++) {
        const s = coords[stopIdxs[i]];
        let best = 0, bestD = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = (s.lt-centers[c].lt)**2 + (s.ln-centers[c].ln)**2;
          if (d < bestD) { bestD = d; best = c; }
        }
        if (assign[i] !== best) { assign[i] = best; changed = true; }
      }
      if (!changed) break;
      // Recompute centers
      const sums = Array.from({length: k}, () => ({lt:0, ln:0, n:0}));
      for (let i = 0; i < stopIdxs.length; i++) {
        const s = coords[stopIdxs[i]];
        const a = assign[i];
        sums[a].lt += s.lt; sums[a].ln += s.ln; sums[a].n++;
      }
      for (let c = 0; c < k; c++) {
        if (sums[c].n > 0) {
          centers[c] = { lt: sums[c].lt/sums[c].n, ln: sums[c].ln/sums[c].n };
        }
      }
    }

    // Rebalance: if any cluster is empty or wildly uneven, steal from biggest.
    // Target size = stops/k ± tolerance.
    const targetMin = Math.floor(stopIdxs.length / k * 0.75);
    const clusters = Array.from({length: k}, () => []);
    for (let i = 0; i < stopIdxs.length; i++) clusters[assign[i]].push(stopIdxs[i]);

    for (let c = 0; c < k; c++) {
      while (clusters[c].length < targetMin) {
        // find biggest cluster and move its farthest-from-own-center stop here
        let big = 0;
        for (let cc = 0; cc < k; cc++) if (clusters[cc].length > clusters[big].length) big = cc;
        if (big === c || clusters[big].length <= targetMin) break;
        // move closest (to c's center) stop from big
        let bestIdx = 0, bestD = Infinity;
        for (let i = 0; i < clusters[big].length; i++) {
          const s = coords[clusters[big][i]];
          const d = (s.lt-centers[c].lt)**2 + (s.ln-centers[c].ln)**2;
          if (d < bestD) { bestD = d; bestIdx = i; }
        }
        clusters[c].push(clusters[big][bestIdx]);
        clusters[big].splice(bestIdx, 1);
      }
    }

    // Stable order: sort clusters by centroid longitude (west→east)
    const centroids = clusters.map(cl => {
      if (!cl.length) return {lt:0, ln:0};
      let lt=0, ln=0;
      for (const si of cl) { lt += coords[si].lt; ln += coords[si].ln; }
      return { lt: lt/cl.length, ln: ln/cl.length };
    });
    const order = clusters.map((_, i) => i)
      .sort((a, b) => centroids[a].ln - centroids[b].ln);
    return order.map(i => clusters[i]);
  }

  // ========== Depot assignment per day ==========

  function assignToNearestDepotByMatrix(dayStops, activeDepotIdxs, matrix, n){
    const buckets = activeDepotIdxs.map(() => []);
    for (const si of dayStops) {
      let best = 0, bestT = Infinity;
      for (let di = 0; di < activeDepotIdxs.length; di++) {
        const d = activeDepotIdxs[di];
        const tt = t(matrix, n, d, si);
        if (tt < bestT) { bestT = tt; best = di; }
      }
      buckets[best].push(si);
    }
    return buckets;
  }

  // ========== Route cost helpers ==========

  function routeDriveTime(stops, depotIdx, matrix, n){
    if (stops.length === 0) return 0;
    let d = t(matrix, n, depotIdx, stops[0]);
    for (let i = 1; i < stops.length; i++) d += t(matrix, n, stops[i-1], stops[i]);
    return d;
  }

  function routeTotalTime(stops, depotIdx, matrix, n, serviceTimeSec){
    return routeDriveTime(stops, depotIdx, matrix, n) + stops.length * serviceTimeSec;
  }

  // ========== Clarke-Wright savings construction ==========
  //
  // Classical savings applied to a single depot. We produce initial routes
  // (one per customer), then merge greedily by largest saving:
  //    s(i,j) = d(0,i) + d(0,j) - d(i,j)
  // Respects route-count by stopping merges once we've reached targetRoutes
  // OR no positive savings remain.
  function clarkeWright(depotIdx, stops, matrix, n, targetRoutes){
    if (stops.length === 0) return [];
    if (stops.length <= targetRoutes) return stops.map(s => [s]);

    const routes = stops.map(s => [s]); // each stop in its own route
    const stopToRoute = new Map(stops.map((s, i) => [s, i]));

    const savings = [];
    for (let i = 0; i < stops.length; i++) {
      for (let j = i+1; j < stops.length; j++) {
        const si = stops[i], sj = stops[j];
        const sv = t(matrix, n, depotIdx, si) + t(matrix, n, depotIdx, sj) - t(matrix, n, si, sj);
        savings.push({ i: si, j: sj, s: sv });
      }
    }
    savings.sort((a, b) => b.s - a.s);

    const routeAlive = new Array(routes.length).fill(true);
    let routeCount = routes.length;

    for (const { i, j, s } of savings) {
      if (s <= 0) break;
      if (routeCount <= targetRoutes) break;
      const ri = stopToRoute.get(i), rj = stopToRoute.get(j);
      if (ri === rj || !routeAlive[ri] || !routeAlive[rj]) continue;
      const R1 = routes[ri], R2 = routes[rj];
      // Merge only if i and j are endpoints of their routes
      let merged = null;
      if (R1[R1.length-1] === i && R2[0] === j) merged = R1.concat(R2);
      else if (R1[0] === i && R2[R2.length-1] === j) merged = R2.concat(R1);
      else if (R1[0] === i && R2[0] === j) merged = R1.slice().reverse().concat(R2);
      else if (R1[R1.length-1] === i && R2[R2.length-1] === j) merged = R1.concat(R2.slice().reverse());
      else continue;
      routes[ri] = merged;
      for (const s2 of merged) stopToRoute.set(s2, ri);
      routeAlive[rj] = false;
      routeCount--;
    }

    const out = [];
    for (let i = 0; i < routes.length; i++) if (routeAlive[i]) out.push(routes[i]);

    // If we still have too many routes (no more positive savings), merge the
    // smallest pair repeatedly until we hit the target.
    while (out.length > targetRoutes) {
      out.sort((a,b) => a.length - b.length);
      const merged = out[0].concat(out[1]);
      out.splice(0, 2, merged);
    }

    // If we have too few routes (rare), split the longest route roughly in half.
    while (out.length < targetRoutes && out.some(r => r.length > 1)) {
      out.sort((a,b) => b.length - a.length);
      const biggest = out[0];
      const mid = Math.floor(biggest.length / 2);
      out[0] = biggest.slice(0, mid);
      out.push(biggest.slice(mid));
    }

    return out;
  }

  // ========== Objective ==========

  function computeObjective(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal){
    let makespan = 0, total = 0;
    for (let r = 0; r < routes.length; r++) {
      const dt = routeDriveTime(routes[r], depotIdxByRoute[r], matrix, n);
      const tt = dt + routes[r].length * serviceTimeSec;
      total += dt;
      if (tt > makespan) makespan = tt;
    }
    if (objective === 'makespan') return makespan;
    if (objective === 'total') return total;
    return makespan + (alphaTotal ?? 0.1) * total;
  }

  // ========== Local search moves ==========
  //
  // All moves operate on a flat array of routes (array of arrays of node indices)
  // and a parallel array of depot indices. They return an object describing the
  // move & delta, and accept an applyMove function to commit.
  //
  // We use best-improvement within a single pass (check every candidate move,
  // apply the best positive-delta one, repeat until no improvement).

  // Delta for inserting a single stop `s` into route R at position p, with
  // depot d. insertionDelta = t(prev,s) + t(s,next) - t(prev,next)
  function insertionDelta(R, p, s, depotIdx, matrix, n){
    const prev = p === 0 ? depotIdx : R[p-1];
    const next = p === R.length ? null : R[p];
    if (next === null) {
      // Appending at end: delta = t(prev, s). No closing at depot in this model.
      return t(matrix, n, prev, s);
    }
    return t(matrix, n, prev, s) + t(matrix, n, s, next) - t(matrix, n, prev, next);
  }

  function removalDelta(R, p, depotIdx, matrix, n){
    const s = R[p];
    const prev = p === 0 ? depotIdx : R[p-1];
    const next = p === R.length-1 ? null : R[p+1];
    if (next === null) {
      return -t(matrix, n, prev, s);
    }
    return -t(matrix, n, prev, s) - t(matrix, n, s, next) + t(matrix, n, prev, next);
  }

  // Compute per-route drive time for fast delta evaluation.
  function computeRouteDriveTimes(routes, depotIdxByRoute, matrix, n){
    const out = new Array(routes.length);
    for (let r = 0; r < routes.length; r++) {
      out[r] = routeDriveTime(routes[r], depotIdxByRoute[r], matrix, n);
    }
    return out;
  }

  // Compute objective given precomputed drive times and service time overhead.
  function objFromDrives(driveTimes, stopCounts, serviceTimeSec, objective, alphaTotal){
    let makespan = 0, total = 0;
    for (let r = 0; r < driveTimes.length; r++) {
      const tt = driveTimes[r] + stopCounts[r] * serviceTimeSec;
      total += driveTimes[r];
      if (tt > makespan) makespan = tt;
    }
    if (objective === 'makespan') return makespan;
    if (objective === 'total') return total;
    return makespan + (alphaTotal ?? 0.1) * total;
  }

  // Try relocating one stop: take stop at (rFrom, pFrom), insert at (rTo, pTo).
  // Returns best improvement found in a single scan, or null.
  function bestRelocate(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal){
    const drives = computeRouteDriveTimes(routes, depotIdxByRoute, matrix, n);
    const stopCounts = routes.map(r => r.length);
    const baseObj = objFromDrives(drives, stopCounts, serviceTimeSec, objective, alphaTotal);

    let best = null;

    for (let rFrom = 0; rFrom < routes.length; rFrom++) {
      const Rf = routes[rFrom];
      if (Rf.length === 0) continue;
      for (let pFrom = 0; pFrom < Rf.length; pFrom++) {
        const removal = removalDelta(Rf, pFrom, depotIdxByRoute[rFrom], matrix, n);
        for (let rTo = 0; rTo < routes.length; rTo++) {
          if (rTo === rFrom) continue;
          const Rt = routes[rTo];
          const s = Rf[pFrom];
          for (let pTo = 0; pTo <= Rt.length; pTo++) {
            const insert = insertionDelta(Rt, pTo, s, depotIdxByRoute[rTo], matrix, n);
            const newDrivesFrom = drives[rFrom] + removal;
            const newDrivesTo = drives[rTo] + insert;
            // temp apply in arrays for objective
            const oldDF = drives[rFrom], oldDT = drives[rTo];
            const oldSCF = stopCounts[rFrom], oldSCT = stopCounts[rTo];
            drives[rFrom] = newDrivesFrom; drives[rTo] = newDrivesTo;
            stopCounts[rFrom] = oldSCF - 1; stopCounts[rTo] = oldSCT + 1;
            const newObj = objFromDrives(drives, stopCounts, serviceTimeSec, objective, alphaTotal);
            drives[rFrom] = oldDF; drives[rTo] = oldDT;
            stopCounts[rFrom] = oldSCF; stopCounts[rTo] = oldSCT;
            const delta = newObj - baseObj;
            if (delta < -1e-6 && (!best || delta < best.delta)) {
              best = { type:'relocate', rFrom, pFrom, rTo, pTo, delta };
            }
          }
        }
      }
    }
    return best;
  }

  function applyRelocate(routes, m){
    const s = routes[m.rFrom].splice(m.pFrom, 1)[0];
    // Adjust pTo if removal happened in the same route before pTo (not possible
    // because rFrom !== rTo, but guard anyway).
    routes[m.rTo].splice(m.pTo, 0, s);
  }

  // Intra-route 2-opt: reverse segment [i, j] in one route. Delta = t(R[i-1],R[j])
  // + t(R[i], R[j+1]) - t(R[i-1],R[i]) - t(R[j], R[j+1]), with depot handling.
  function best2Opt(routes, depotIdxByRoute, matrix, n){
    let best = null;
    for (let r = 0; r < routes.length; r++) {
      const R = routes[r];
      if (R.length < 3) continue;
      const d = depotIdxByRoute[r];
      for (let i = 0; i < R.length - 1; i++) {
        for (let j = i + 1; j < R.length; j++) {
          const prev = i === 0 ? d : R[i-1];
          const next = j === R.length-1 ? null : R[j+1];
          const before = t(matrix,n,prev,R[i]) + (next !== null ? t(matrix,n,R[j],next) : 0);
          const after = t(matrix,n,prev,R[j]) + (next !== null ? t(matrix,n,R[i],next) : 0);
          // Internal segment cost is symmetric if matrix is symmetric; in practice
          // OSRM times are mildly asymmetric. Account for that by computing
          // both directions of the segment.
          let segFwd = 0, segRev = 0;
          for (let k = i; k < j; k++) {
            segFwd += t(matrix,n,R[k],R[k+1]);
            segRev += t(matrix,n,R[k+1],R[k]);
          }
          const delta = (after - before) + (segRev - segFwd);
          if (delta < -1e-6 && (!best || delta < best.delta)) {
            best = { type:'2opt', r, i, j, delta };
          }
        }
      }
    }
    return best;
  }

  function apply2Opt(routes, m){
    const R = routes[m.r];
    const seg = R.slice(m.i, m.j+1).reverse();
    for (let k = 0; k < seg.length; k++) R[m.i + k] = seg[k];
  }

  // Swap two stops from different routes.
  function bestSwap(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal){
    const drives = computeRouteDriveTimes(routes, depotIdxByRoute, matrix, n);
    const stopCounts = routes.map(r => r.length);
    const baseObj = objFromDrives(drives, stopCounts, serviceTimeSec, objective, alphaTotal);
    let best = null;

    for (let rA = 0; rA < routes.length; rA++) {
      const A = routes[rA]; if (!A.length) continue;
      const dA = depotIdxByRoute[rA];
      for (let rB = rA+1; rB < routes.length; rB++) {
        const B = routes[rB]; if (!B.length) continue;
        const dB = depotIdxByRoute[rB];
        for (let pA = 0; pA < A.length; pA++) {
          for (let pB = 0; pB < B.length; pB++) {
            // Swap A[pA] ↔ B[pB]
            const a = A[pA], b = B[pB];
            const prevA = pA === 0 ? dA : A[pA-1];
            const nextA = pA === A.length-1 ? null : A[pA+1];
            const prevB = pB === 0 ? dB : B[pB-1];
            const nextB = pB === B.length-1 ? null : B[pB+1];

            let dOldA = t(matrix,n,prevA,a) + (nextA !== null ? t(matrix,n,a,nextA) : 0);
            let dNewA = t(matrix,n,prevA,b) + (nextA !== null ? t(matrix,n,b,nextA) : 0);
            let dOldB = t(matrix,n,prevB,b) + (nextB !== null ? t(matrix,n,b,nextB) : 0);
            let dNewB = t(matrix,n,prevB,a) + (nextB !== null ? t(matrix,n,a,nextB) : 0);

            const newDriveA = drives[rA] - dOldA + dNewA;
            const newDriveB = drives[rB] - dOldB + dNewB;
            const oldDA = drives[rA], oldDB = drives[rB];
            drives[rA] = newDriveA; drives[rB] = newDriveB;
            const newObj = objFromDrives(drives, stopCounts, serviceTimeSec, objective, alphaTotal);
            drives[rA] = oldDA; drives[rB] = oldDB;

            const delta = newObj - baseObj;
            if (delta < -1e-6 && (!best || delta < best.delta)) {
              best = { type:'swap', rA, pA, rB, pB, delta };
            }
          }
        }
      }
    }
    return best;
  }

  function applySwap(routes, m){
    const tmp = routes[m.rA][m.pA];
    routes[m.rA][m.pA] = routes[m.rB][m.pB];
    routes[m.rB][m.pB] = tmp;
  }

  // Or-opt: move a chain of `k` consecutive stops from one route to another.
  function bestOrOpt(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal, chainLen){
    const drives = computeRouteDriveTimes(routes, depotIdxByRoute, matrix, n);
    const stopCounts = routes.map(r => r.length);
    const baseObj = objFromDrives(drives, stopCounts, serviceTimeSec, objective, alphaTotal);
    let best = null;

    for (let rFrom = 0; rFrom < routes.length; rFrom++) {
      const Rf = routes[rFrom];
      if (Rf.length < chainLen) continue;
      const dF = depotIdxByRoute[rFrom];
      for (let pFrom = 0; pFrom + chainLen <= Rf.length; pFrom++) {
        // Remove chain [pFrom, pFrom+chainLen-1]
        const prev = pFrom === 0 ? dF : Rf[pFrom-1];
        const next = (pFrom + chainLen) === Rf.length ? null : Rf[pFrom + chainLen];
        const chainFirst = Rf[pFrom], chainLast = Rf[pFrom + chainLen - 1];
        let removeDelta = -t(matrix,n,prev,chainFirst);
        if (next !== null) removeDelta += -t(matrix,n,chainLast,next) + t(matrix,n,prev,next);

        // Compute chain internal drive time (stays constant)
        for (let rTo = 0; rTo < routes.length; rTo++) {
          if (rTo === rFrom) continue;
          const Rt = routes[rTo];
          const dT = depotIdxByRoute[rTo];
          for (let pTo = 0; pTo <= Rt.length; pTo++) {
            const iPrev = pTo === 0 ? dT : Rt[pTo-1];
            const iNext = pTo === Rt.length ? null : Rt[pTo];
            let insertDelta = t(matrix,n,iPrev,chainFirst);
            if (iNext !== null) insertDelta += t(matrix,n,chainLast,iNext) - t(matrix,n,iPrev,iNext);

            const newDF = drives[rFrom] + removeDelta;
            const newDT = drives[rTo] + insertDelta;
            const oldDF = drives[rFrom], oldDT = drives[rTo];
            const oldSCF = stopCounts[rFrom], oldSCT = stopCounts[rTo];
            drives[rFrom] = newDF; drives[rTo] = newDT;
            stopCounts[rFrom] = oldSCF - chainLen; stopCounts[rTo] = oldSCT + chainLen;
            const newObj = objFromDrives(drives, stopCounts, serviceTimeSec, objective, alphaTotal);
            drives[rFrom] = oldDF; drives[rTo] = oldDT;
            stopCounts[rFrom] = oldSCF; stopCounts[rTo] = oldSCT;

            const delta = newObj - baseObj;
            if (delta < -1e-6 && (!best || delta < best.delta)) {
              best = { type:'oropt', rFrom, pFrom, chainLen, rTo, pTo, delta };
            }
          }
        }
      }
    }
    return best;
  }

  function applyOrOpt(routes, m){
    const chain = routes[m.rFrom].splice(m.pFrom, m.chainLen);
    routes[m.rTo].splice(m.pTo, 0, ...chain);
  }

  // ========== Local search driver ==========

  function localSearch(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal, maxPasses){
    let pass = 0;
    while (pass < (maxPasses || 100)) {
      pass++;
      const candidates = [
        bestRelocate(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal),
        bestSwap(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal),
        bestOrOpt(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal, 2),
        bestOrOpt(routes, depotIdxByRoute, matrix, n, serviceTimeSec, objective, alphaTotal, 3),
        best2Opt(routes, depotIdxByRoute, matrix, n),
      ].filter(Boolean);

      if (!candidates.length) break;
      candidates.sort((a, b) => a.delta - b.delta);
      const m = candidates[0];

      if (m.type === 'relocate') applyRelocate(routes, m);
      else if (m.type === 'swap') applySwap(routes, m);
      else if (m.type === 'oropt') applyOrOpt(routes, m);
      else if (m.type === '2opt') apply2Opt(routes, m);
    }
    return pass;
  }

  // ========== Perturbation (for ILS) ==========
  //
  // Double-bridge on the worst route if long enough, plus random shuffle of a
  // small random subset of stops across routes.
  function perturb(routes, depotIdxByRoute, matrix, n, serviceTimeSec, rng){
    // Find worst route
    let worst = 0, worstT = -Infinity;
    for (let r = 0; r < routes.length; r++) {
      const tt = routeTotalTime(routes[r], depotIdxByRoute[r], matrix, n, serviceTimeSec);
      if (tt > worstT) { worstT = tt; worst = r; }
    }

    // Double-bridge if route is long enough
    const W = routes[worst];
    if (W.length >= 8) {
      const p1 = 1 + Math.floor(rng() * (W.length/4));
      const p2 = p1 + 1 + Math.floor(rng() * (W.length/4));
      const p3 = p2 + 1 + Math.floor(rng() * (W.length/4));
      const A = W.slice(0, p1);
      const B = W.slice(p1, p2);
      const C = W.slice(p2, p3);
      const D = W.slice(p3);
      routes[worst] = A.concat(D, C, B);
    }

    // Random relocations: move k stops from random routes to random positions
    const k = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < k; i++) {
      const nonEmpty = routes.map((R, idx) => [R, idx]).filter(x => x[0].length > 0);
      if (nonEmpty.length < 2) break;
      const [Rfrom, rFromIdx] = nonEmpty[Math.floor(rng() * nonEmpty.length)];
      const pFrom = Math.floor(rng() * Rfrom.length);
      const s = Rfrom.splice(pFrom, 1)[0];
      // insert into a different random route at a random position
      let toCandidates = routes.map((_, idx) => idx).filter(idx => idx !== rFromIdx);
      const rToIdx = toCandidates[Math.floor(rng() * toCandidates.length)];
      const Rto = routes[rToIdx];
      const pTo = Math.floor(rng() * (Rto.length + 1));
      Rto.splice(pTo, 0, s);
    }
  }

  // ========== Top-level: solve ==========

  function solve(problem, onProgress){
    const startMs = Date.now();
    const {
      matrix, n, depotIndices, stopIndices, coords,
      numDays, driversPerDay, dayActiveDepots,
      serviceTimeSec = 300,
      objective = 'makespan+total',
      alphaTotal = 0.1,
      seed = 1,
      timeBudgetMs = 8000,
    } = problem;

    const rng = mulberry32(seed);

    // 1) Day assignment
    if (onProgress) onProgress({ stage: 'cluster', message: 'Partitioning stops across days' });
    const dayClusters = kmeansDays(stopIndices, coords, numDays, rng);

    const days = [];
    let iterations = 0;

    // 2-4) Per-day: depot assignment + construction + local search
    for (let d = 0; d < numDays; d++) {
      const dayStops = dayClusters[d] || [];
      if (!dayStops.length) {
        days.push({ day: d+1, routes: [] });
        continue;
      }

      const activeByDay = (dayActiveDepots && dayActiveDepots[d] && dayActiveDepots[d].length)
        ? dayActiveDepots[d]
        : depotIndices;
      const buckets = assignToNearestDepotByMatrix(dayStops, activeByDay, matrix, n);

      // Allocate driver count per depot in proportion to stops
      const totalDayStops = dayStops.length;
      const depotDrivers = buckets.map(b => {
        if (!b.length) return 0;
        return Math.max(1, Math.round(driversPerDay * b.length / totalDayStops));
      });
      // Adjust so depotDrivers sum equals driversPerDay (minus empty depots)
      const desiredTotal = Math.min(driversPerDay, totalDayStops);
      let have = depotDrivers.reduce((a,b) => a+b, 0);
      while (have > desiredTotal) {
        // remove from largest depot-driver count where depot has stops
        let bi = -1, biCount = 0;
        for (let i = 0; i < depotDrivers.length; i++) {
          if (depotDrivers[i] > 1 && depotDrivers[i] > biCount) { bi = i; biCount = depotDrivers[i]; }
        }
        if (bi < 0) break;
        depotDrivers[bi]--; have--;
      }
      while (have < desiredTotal) {
        // add to depot with most stops per driver
        let bi = -1, biRatio = 0;
        for (let i = 0; i < depotDrivers.length; i++) {
          if (!buckets[i].length) continue;
          const ratio = buckets[i].length / Math.max(1, depotDrivers[i]);
          if (ratio > biRatio) { biRatio = ratio; bi = i; }
        }
        if (bi < 0) break;
        depotDrivers[bi]++; have++;
      }

      // Build initial routes per depot
      const dayRoutes = [];
      const dayRouteDepots = [];
      for (let di = 0; di < activeByDay.length; di++) {
        const depotIdx = activeByDay[di];
        const stops = buckets[di];
        if (!stops.length) continue;
        const target = Math.max(1, depotDrivers[di]);
        const constructed = clarkeWright(depotIdx, stops, matrix, n, target);
        for (const r of constructed) {
          dayRoutes.push(r);
          dayRouteDepots.push(depotIdx);
        }
      }

      if (onProgress) onProgress({ stage: 'localsearch', day: d+1, message: `Day ${d+1}: local search` });

      // Run local search
      iterations += localSearch(dayRoutes, dayRouteDepots, matrix, n, serviceTimeSec, objective, alphaTotal, 50);

      // ILS — per-day time budget share
      const perDayBudget = Math.max(500, Math.floor(timeBudgetMs / Math.max(1, numDays)));
      const ilsStart = Date.now();
      let bestObj = computeObjective(dayRoutes, dayRouteDepots, matrix, n, serviceTimeSec, objective, alphaTotal);
      let bestRoutes = dayRoutes.map(r => r.slice());
      let bestDepots = dayRouteDepots.slice();
      let noImprove = 0;
      while (Date.now() - ilsStart < perDayBudget && noImprove < 6) {
        // Copy current best as working set
        const working = bestRoutes.map(r => r.slice());
        const workingDepots = bestDepots.slice();
        perturb(working, workingDepots, matrix, n, serviceTimeSec, rng);
        iterations += localSearch(working, workingDepots, matrix, n, serviceTimeSec, objective, alphaTotal, 30);
        const obj = computeObjective(working, workingDepots, matrix, n, serviceTimeSec, objective, alphaTotal);
        if (obj < bestObj - 1e-6) {
          bestObj = obj;
          bestRoutes = working.map(r => r.slice());
          bestDepots = workingDepots.slice();
          noImprove = 0;
        } else {
          noImprove++;
        }
      }

      // Assemble day output
      const outRoutes = [];
      for (let r = 0; r < bestRoutes.length; r++) {
        const stops = bestRoutes[r];
        if (!stops.length) continue;
        const depotIdx = bestDepots[r];
        // Leg times: [depot→stops[0], stops[0]→stops[1], ...]
        const legTimesSec = [];
        let drive = 0;
        legTimesSec.push(t(matrix, n, depotIdx, stops[0]));
        drive += legTimesSec[0];
        for (let i = 1; i < stops.length; i++) {
          const leg = t(matrix, n, stops[i-1], stops[i]);
          legTimesSec.push(leg);
          drive += leg;
        }
        const svc = stops.length * serviceTimeSec;
        outRoutes.push({
          depotIdx,
          stopSequence: stops.slice(),
          legTimesSec,
          driveTimeSec: drive,
          serviceTimeSec: svc,
          totalTimeSec: drive + svc,
        });
      }
      // Assign driverIdx within day by a stable order (depot name, then length desc)
      outRoutes.sort((a, b) => {
        if (a.depotIdx !== b.depotIdx) return a.depotIdx - b.depotIdx;
        return b.stopSequence.length - a.stopSequence.length;
      });
      outRoutes.forEach((r, i) => r.driverIdx = i);

      days.push({ day: d+1, routes: outRoutes });
    }

    // Final objective across the whole plan
    let finalMakespan = 0, finalTotal = 0;
    for (const day of days) {
      for (const r of day.routes) {
        finalTotal += r.driveTimeSec;
        if (r.totalTimeSec > finalMakespan) finalMakespan = r.totalTimeSec;
      }
    }
    const objectiveValue = objective === 'total'
      ? finalTotal
      : objective === 'makespan'
        ? finalMakespan
        : finalMakespan + alphaTotal * finalTotal;

    return {
      days,
      objectiveValue,
      makespanSec: finalMakespan,
      totalDriveSec: finalTotal,
      iterations,
      elapsedMs: Date.now() - startMs,
    };
  }

  global.VRP_SOLVER = { solve };
})(typeof self !== 'undefined' ? self : this);
