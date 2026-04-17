/**
 * VRP — Web Worker entry
 *
 * Loads the matrix service and solver into a worker context and exposes a
 * simple request/response protocol over postMessage.
 *
 * Protocol (main → worker):
 *   { type: 'solve', requestId, payload: {
 *       nodes: [{lt, ln}],   // depots first, then stops (see depotIndices)
 *       depotIndices: number[],
 *       stopIndices: number[],
 *       numDays, driversPerDay,
 *       dayActiveDepots: number[][],  // per-day allowed depot indices
 *       serviceTimeSec, objective, alphaTotal, seed, timeBudgetMs,
 *     }
 *   }
 *
 * Protocol (worker → main):
 *   { type: 'progress', requestId, stage, done, total, message }
 *   { type: 'result',   requestId, solution }   // solution is the solver output
 *                                               // (minus the matrix, which stays
 *                                               // in the worker)
 *   { type: 'error',    requestId, message }
 *
 * Note: we intentionally do NOT transfer the matrix back to the main thread —
 * all per-stop timings (legTimesSec, driveTimeSec, totalTimeSec) are already
 * baked into the solution, so the main thread never needs the matrix.
 */

/* global importScripts, VRP_MATRIX, VRP_SOLVER */

importScripts('./vrp/matrix.js', './vrp/solver.js');

self.addEventListener('message', async (event) => {
  const msg = event.data || {};
  if (msg.type !== 'solve') return;
  const { requestId, payload } = msg;

  try {
    const {
      nodes, depotIndices, stopIndices,
      numDays, driversPerDay, dayActiveDepots,
      serviceTimeSec, objective, alphaTotal, seed, timeBudgetMs,
    } = payload;

    // Stage 1: build distance matrix
    const { matrix, n } = await VRP_MATRIX.buildTimeMatrix(nodes, (done, total, message) => {
      self.postMessage({
        type: 'progress', requestId,
        stage: 'matrix', done, total,
        message: message || `Computing distances ${done}/${total}`,
      });
    });

    // Stage 2: solve
    self.postMessage({
      type: 'progress', requestId,
      stage: 'solve', done: 0, total: 1,
      message: 'Optimizing routes…',
    });

    const solution = VRP_SOLVER.solve({
      matrix, n,
      depotIndices, stopIndices,
      coords: nodes,
      numDays, driversPerDay, dayActiveDepots,
      serviceTimeSec, objective, alphaTotal, seed, timeBudgetMs,
    }, (p) => {
      // Solver progress: forward message only (no numeric total)
      self.postMessage({
        type: 'progress', requestId,
        stage: 'solve',
        message: p.message || `Day ${p.day || ''} ${p.stage || ''}`,
      });
    });

    self.postMessage({ type: 'result', requestId, solution });
  } catch (err) {
    self.postMessage({
      type: 'error', requestId,
      message: (err && err.message) || String(err),
    });
  }
});
