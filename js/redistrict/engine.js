/* Redistricting MCMC engine.
 *
 * Districts are unions of units (census blocks, or precincts built from
 * blocks). The chain uses two kinds of moves:
 *   - ReCom: merge two neighboring districts, draw a random spanning tree on
 *     the merged units, and cut one tree edge so both halves have equal
 *     population. Both halves are connected by construction.
 *   - Flip: move one border unit into the neighboring district, allowed
 *     only if the district it leaves stays connected.
 * Moves are accepted with the Metropolis rule on an energy (simulated
 * annealing), in phases: population balance -> partisan goal -> compactness.
 *
 * The worker runs two levels: first on precincts (fast, for the partisan
 * search), then on census blocks (exact population and borders).
 *
 * Runs in a Web Worker (see RedistrictEngine.workerSource) and in node.
 */
(function (root) {
  "use strict";

  function factory() {
    "use strict";

    // ---------- random numbers (sfc32, seeded) ----------
    function makeRng(seed) {
      let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
      function next() {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
        let t = (a + b) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        d = (d + 1) | 0;
        t = (t + d) | 0;
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
      }
      for (let i = 0; i < 20; i++) next();
      return next;
    }

    // ---------- graphs ----------
    // d: { n, pop, dem, rep, area (m^2), ext (m), county, eu, ev, elen, econn? } (arrays or typed arrays)
    // econn per edge: 1 = land border (counts for contiguity), 2 = link across water
    // for land cut off by water (counts for contiguity), 0 = shape only (a border
    // through water: counts toward perimeters, never toward contiguity). Default 1.
    function buildGraph(d) {
      const n = d.n;
      const E = d.eu.length;
      const eu = Int32Array.from(d.eu), ev = Int32Array.from(d.ev), elen = Float64Array.from(d.elen);
      const econn = d.econn ? Uint8Array.from(d.econn) : new Uint8Array(E).fill(1);
      const deg = new Int32Array(n);
      for (let i = 0; i < E; i++) { deg[eu[i]]++; deg[ev[i]]++; }
      const start = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
      const nbr = new Int32Array(2 * E), nlen = new Float64Array(2 * E), nconn = new Uint8Array(2 * E);
      const fill = start.slice(0, n);
      for (let i = 0; i < E; i++) {
        let p = fill[eu[i]]++; nbr[p] = ev[i]; nlen[p] = elen[i]; nconn[p] = econn[i];
        p = fill[ev[i]]++; nbr[p] = eu[i]; nlen[p] = elen[i]; nconn[p] = econn[i];
      }
      const pop = Float64Array.from(d.pop), dem = Float64Array.from(d.dem), rep = Float64Array.from(d.rep);
      const area = Float64Array.from(d.area), county = d.county ? Int32Array.from(d.county) : new Int32Array(n);
      const border = new Float64Array(n);
      let nc = 0;
      for (let u = 0; u < n; u++) {
        if (county[u] + 1 > nc) nc = county[u] + 1;
        let b = d.ext[u];
        for (let j = start[u]; j < start[u + 1]; j++) b += nlen[j];
        border[u] = b;
      }
      return { n, E, eu, ev, elen, econn, start, nbr, nlen, nconn, border, pop, dem, rep, area, county, nc };
    }

    // Merge units into groups (e.g. blocks -> precincts). label[u] = group id (any ints >= 0).
    // Returns { graph, groupOf } where groupOf[u] is the compact group index of unit u.
    function aggregate(g, label) {
      const n = g.n;
      const remap = new Map();
      const groupOf = new Int32Array(n);
      for (let u = 0; u < n; u++) {
        let id = remap.get(label[u]);
        if (id === undefined) { id = remap.size; remap.set(label[u], id); }
        groupOf[u] = id;
      }
      const m = remap.size;
      const pop = new Float64Array(m), dem = new Float64Array(m), rep = new Float64Array(m), area = new Float64Array(m), ext = new Float64Array(m);
      const county = new Int32Array(m), bestPop = new Float64Array(m).fill(-1);
      for (let u = 0; u < n; u++) {
        const a = groupOf[u];
        pop[a] += g.pop[u]; dem[a] += g.dem[u]; rep[a] += g.rep[u]; area[a] += g.area[u];
        let inner = g.border[u];
        for (let j = g.start[u]; j < g.start[u + 1]; j++) inner -= g.nlen[j];
        ext[a] += inner;
        if (g.pop[u] > bestPop[a]) { bestPop[a] = g.pop[u]; county[a] = g.county[u]; }
      }
      const shared = new Map();
      for (let i = 0; i < g.E; i++) {
        const a = groupOf[g.eu[i]], b = groupOf[g.ev[i]];
        if (a === b) continue;
        const key = a < b ? a * m + b : b * m + a;
        const cur = shared.get(key);
        const c = g.econn[i];
        if (cur) { cur.L += g.elen[i]; cur.c = mergeConn(cur.c, c); } else shared.set(key, { L: g.elen[i], c });
      }
      const eu = new Int32Array(shared.size), ev = new Int32Array(shared.size), elen = new Float64Array(shared.size), econn = new Uint8Array(shared.size);
      let i = 0;
      for (const [key, o] of shared) { eu[i] = Math.floor(key / m); ev[i] = key % m; elen[i] = o.L; econn[i] = o.c; i++; }
      return { graph: buildGraph({ n: m, pop, dem, rep, area, ext, county, eu, ev, elen, econn }), groupOf };
    }

    // a land border beats a water link, which beats a shape-only border
    function mergeConn(a, b) { return a === 1 || b === 1 ? 1 : a === 2 || b === 2 ? 2 : 0; }
    const FOUR_PI = 4 * Math.PI;
    const SEARCH_CAP = 1000; // max units explored when checking a flip keeps a district connected

    // ---------- engine ----------
    function createEngine(g, opts) {
      const { n, E, eu, ev, econn, start, nbr, nlen, nconn, border, pop, dem, rep, area, county } = g;
      const k = opts.k | 0;
      if (k < 1 || k > n) throw new Error("Can't make " + k + " districts from " + n + " units.");
      const rand = opts.rand || makeRng(opts.seed == null ? (Math.random() * 4294967296) >>> 0 : opts.seed);
      const mode = opts.mode || "neutral";
      const h = (opts.margin || 0) / 200;                      // safe-seat margin, in two-party share
      const band = (opts.band == null ? 5 : opts.band) / 200;  // competitive band
      const wCounty = opts.countyWeight || 0;
      const searchBudget = Math.round(opts.searchSteps || 40000);
      const polishBudget = Math.round(opts.polishSteps || 40000);
      const unitName = opts.unitName || "precinct";
      const tune = Object.assign({
        searchRecom: 0.6, searchT0: 0.5, searchT1: 0.01, searchComp: 0.05,
        polishRecom: 0.03, polishT0: 0.2, polishT1: 0.001, popW0: 30, popW1: 10000,
        balanceRecom: 0.3, balanceT0: 0.05, balanceT1: 0.001,
      }, opts.tune || {});
      // county bookkeeping costs nc*k memory; skip it when that's huge
      const countyOn = g.nc * k <= 3e7;
      const nc = countyOn ? g.nc : 1;

      let totalPop = 0, totalDem = 0, totalRep = 0;
      for (let u = 0; u < n; u++) { totalPop += pop[u]; totalDem += dem[u]; totalRep += rep[u]; }
      const ideal = totalPop / k;
      const stateShare = totalDem / (totalDem + totalRep);
      const userTol = opts.tol == null ? 0.005 : opts.tol;
      let tol = userTol, lo = 0, hi = 0;
      function setTol(t) { tol = t; lo = ideal * (1 - t); hi = ideal * (1 + t); }
      setTol(userTol);

      // partisan requirements: top `needD` districts must be >= 50%+h for Dems,
      // bottom `needR` must be <= 50%-h. Max modes raise the requirement step by step.
      let needD = 0, needR = 0;
      if (mode === "target") { needD = Math.max(0, Math.min(k, opts.targetD | 0)); needR = k - needD; }
      if (mode === "proportional") { needD = Math.round(k * stateShare); needR = k - needD; }

      // ----- plan state -----
      const assign = new Int32Array(n).fill(-1);
      const dPop = new Float64Array(k), dDem = new Float64Array(k), dRep = new Float64Array(k);
      const dArea = new Float64Array(k), dPerim = new Float64Array(k), dCnt = new Int32Array(k);
      const dInv = new Float64Array(k), dPen = new Float64Array(k), dCls = new Uint8Array(k);
      const shares = new Float64Array(k), sortBuf = new Float64Array(k);
      const cd = new Int32Array(nc * k);   // units of county c in district d
      const cPresent = new Int32Array(nc); // districts touching county c
      let splits = 0, compSum = 0, penSum = 0, partE = 0;
      let cntSafeD = 0, cntSafeR = 0, cntComp = 0, cntWinD = 0;
      // Gerrymanders (max modes), from the favored party's side:
      //  1. maximize districts won by at least the floor (safe seats), then lock that count;
      //  2. maximize the remaining wins (under the floor), then lock that count;
      //  3. one district at a time, best first: push it as close to the floor as it
      //     will go, then lock its level and move to the next. Locks mean no seat is
      //     ever given back.
      const isMax = mode === "maxD" || mode === "maxR";
      const floorPts = opts.margin || 0;
      const tierMargins = isMax ? (floorPts > 0 ? [floorPts, 0] : [0]) : [];
      const thFloor = 0.5 + floorPts / 200 + (floorPts === 0 ? 1e-9 : 0);
      const posLock = new Float64Array(k).fill(-Infinity), lockBuf = new Float64Array(k);
      const posOn = isMax && k <= 400;
      let posIdx = -1, posSteps = 0, posBestVal = -Infinity, posBestAssign = null;
      const posPatience = Math.max(1000, Math.round(searchBudget / 10));
      // party shares, best district first
      function partySorted(buf) { for (let d = 0; d < k; d++) buf[d] = pshare(shares[d]); buf.sort(); buf.reverse(); return buf; }
      const tierTh = tierMargins.map((m) => 0.5 + m / 200 + (m === 0 ? 1e-9 : 0));
      const nTier = tierTh.length;
      const cntTier = new Int32Array(nTier), dTier = new Uint8Array(k), tierLock = new Int32Array(nTier).fill(-1);
      let tierIdx = 0;
      function pshare(s) { return mode === "maxR" ? 1 - s : s; }
      function tierBits(s) { const p = pshare(s); let b = 0; for (let j = 0; j < nTier; j++) if (p >= tierTh[j]) b |= 1 << j; return b; }
      function addTier(b, sgn) { for (let j = 0; j < nTier; j++) if (b & (1 << j)) cntTier[j] += sgn; }

      // scratch buffers
      const loc = new Int32Array(n).fill(-1);
      const nodes = new Int32Array(n);
      const stamp = new Int32Array(n); let stampId = 1;
      const queue = new Int32Array(n);
      const la = new Int32Array(2 * E + 2), lb = new Int32Array(2 * E + 2), lw = new Float64Array(2 * E + 2);
      const perm = new Int32Array(2 * E + 2);
      const uf = new Int32Array(n);
      const tStart = new Int32Array(n + 1), tAdj = new Int32Array(2 * n), tFill = new Int32Array(n);
      const tEdgeA = new Int32Array(n), tEdgeB = new Int32Array(n);
      const order = new Int32Array(n), parent = new Int32Array(n), sub = new Float64Array(n), size = new Int32Array(n), pos = new Int32Array(n);
      const cands = new Int32Array(n);
      const side = new Uint8Array(n);
      const changed = new Int32Array(n);

      function share(d) { const t = dDem[d] + dRep[d]; return t > 0 ? dDem[d] / t : 0.5; }
      function invPP(a, p) { return a > 0 ? (p * p) / (FOUR_PI * a) : 0; }
      // Population penalty beyond the tolerance. While polishing it is soft (with a
      // wider hard limit) so single-unit flips can move; its weight ramps up.
      let wPop = 1000, softPop = false;
      const softHard = Math.max(3 * userTol, 0.015);
      // linear + quadratic in the excess, so population also flows from badly
      // over/under districts to slightly over/under ones
      // While balancing, a gentle pull toward the ideal size (wCenter) makes room
      // in neighboring districts so overflow can move through them.
      let wCenter = 0;
      function popPen(p) {
        const dev = Math.abs(p - ideal) / ideal, x = dev - tol;
        return ((x > 0 ? x * (1 + x * 500) : 0) + wCenter * dev * dev) * wPop;
      }
      function cls(s) { // bit 1 safe D, 2 safe R, 4 competitive, 8 D win
        return (s >= 0.5 + h ? 1 : 0) | (s <= 0.5 - h ? 2 : 0) | (Math.abs(2 * s - 1) <= 2 * band ? 4 : 0) | (s > 0.5 ? 8 : 0);
      }
      function addCls(c, sgn) { if (c & 1) cntSafeD += sgn; if (c & 2) cntSafeR += sgn; if (c & 4) cntComp += sgn; if (c & 8) cntWinD += sgn; }

      // refresh cached per-district terms for district d
      function refresh(d) {
        compSum -= dInv[d]; dInv[d] = invPP(dArea[d], dPerim[d]); compSum += dInv[d];
        penSum -= dPen[d]; dPen[d] = popPen(dPop[d]); penSum += dPen[d];
        addCls(dCls[d], -1); shares[d] = share(d); dCls[d] = cls(shares[d]); addCls(dCls[d], 1);
        if (nTier) { addTier(dTier[d], -1); dTier[d] = tierBits(shares[d]); addTier(dTier[d], 1); }
      }
      function recomputePen() { penSum = 0; for (let d = 0; d < k; d++) { dPen[d] = popPen(dPop[d]); penSum += dPen[d]; } }
      // every district within the population tolerance?
      function popOk() { const lim = tol * ideal + 1e-6; for (let d = 0; d < k; d++) if (Math.abs(dPop[d] - ideal) > lim) return false; return true; }
      // resync running sums (they drift slightly over millions of updates)
      function resync() { compSum = 0; for (let d = 0; d < k; d++) compSum += dInv[d]; recomputePen(); curE = energy(); }

      function recomputeAll() {
        dPop.fill(0); dDem.fill(0); dRep.fill(0); dArea.fill(0); dPerim.fill(0); dCnt.fill(0); cd.fill(0); cPresent.fill(0);
        for (let u = 0; u < n; u++) {
          const d = assign[u];
          dPop[d] += pop[u]; dDem[d] += dem[u]; dRep[d] += rep[u]; dArea[d] += area[u]; dCnt[d]++;
          dPerim[d] += border[u];
          for (let j = start[u]; j < start[u + 1]; j++) if (assign[nbr[j]] === d) dPerim[d] -= nlen[j];
          if (countyOn && cd[county[u] * k + d]++ === 0) cPresent[county[u]]++;
        }
        splits = 0;
        for (let c = 0; c < nc; c++) if (cPresent[c] > 1) splits += cPresent[c] - 1;
        compSum = 0; penSum = 0; cntSafeD = cntSafeR = cntComp = cntWinD = 0;
        cntTier.fill(0);
        for (let d = 0; d < k; d++) {
          dInv[d] = invPP(dArea[d], dPerim[d]); compSum += dInv[d];
          dPen[d] = popPen(dPop[d]); penSum += dPen[d];
          shares[d] = share(d); dCls[d] = cls(shares[d]); addCls(dCls[d], 1);
          if (nTier) { dTier[d] = tierBits(shares[d]); addTier(dTier[d], 1); }
        }
        partE = partisanE();
      }

      function partisanE() {
        if (mode === "neutral" || wPart === 0) return 0;
        if (mode === "competitive") {
          let e = 0;
          for (let d = 0; d < k; d++) { const x = Math.abs(2 * shares[d] - 1) - 2 * band; if (x > 0) e += x; }
          return e * 100;
        }
        if (isMax && posIdx >= 0) {
          // the district at position posIdx (best first) should get as close to the floor as it can
          const v = partySorted(sortBuf)[posIdx];
          return Math.max(0, thFloor - v) * 100;
        }
        if (isMax) {
          // the top `maxTarget` districts (by the party's share) should clear this tier's line
          for (let d = 0; d < k; d++) sortBuf[d] = pshare(shares[d]);
          sortBuf.sort();
          const th = tierTh[tierIdx], need = Math.min(k, maxTarget);
          let e = 0;
          for (let i = k - need; i < k; i++) { const x = th - sortBuf[i]; if (x > 0) e += x; }
          return e * 100;
        }
        sortBuf.set(shares); sortBuf.sort(); // ascending: weakest Dem districts first
        let e = 0;
        for (let i = 0; i < needR; i++) { const x = sortBuf[i] - (0.5 - h); if (x > 0) e += x; }
        for (let i = k - needD; i < k; i++) { const x = 0.5 + h - sortBuf[i]; if (x > 0) e += x; }
        return e * 100;
      }
      function outcome() { return { safeD: cntSafeD, safeR: cntSafeR, winD: cntWinD, comp: cntComp }; }

      // ----- phase + weights -----
      let phase = "init";
      let wPart = 0, wComp = 1, wCty = wCounty;
      let T = 1, T0 = 1, T1 = 0.01, phaseStep = 0, phaseBudget = 1, recomProb = 0.5;
      let lock = null;      // {safeD, safeR, comp}
      let stepCount = 0, accepted = 0, proposals = 0;
      const notes = [];
      let goal = opts.goal || { achieved: false, text: "" };
      let best = null;      // {assign, E}
      let maxTarget = 0, targetSteps = 0, searchTotal = 0, bestAchievedAssign = null, bestAchievedT = 0;
      let curE = 0;
      // compact=false skips the compactness phase and drops compactness from every
      // score; districts must still be contiguous (every move checks that).
      const compact = opts.compact !== false;
      const phases = (opts.phases || (mode === "neutral" ? ["polish", "final"] : ["search", "polish", "final"]))
        .filter((p) => compact || p !== "polish");
      let phaseIdx = -1;

      function lockOk() {
        if (!lock) return true;
        if (lock.tiers) {
          for (let j = 0; j < nTier; j++) if (lock.tiers[j] >= 0 && cntTier[j] < lock.tiers[j]) return false;
          if (lock.pos) {
            const b = partySorted(lockBuf);
            for (let q = 0; q < k; q++) if (b[q] < lock.pos[q]) return false;
          }
          return true;
        }
        if (mode === "competitive") return cntComp >= lock.comp;
        return cntSafeD >= lock.safeD && cntSafeR >= lock.safeR;
      }
      function energy() { return wPart * partE + wComp * compSum + wCty * splits + penSum; }

      // ----- random cut edge -----
      function randomCutEdge() {
        for (let t = 0; t < 20000; t++) {
          const e = (rand() * E) | 0;
          if (econn[e] && assign[eu[e]] !== assign[ev[e]]) return e;
        }
        return -1;
      }

      // ----- random spanning tree (Kruskal on random weights) over local graph -----
      function find(x) { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; }
      function randomTree(m, le) {
        // Kruskal with i.i.d. random weights == edges in uniformly random order (Fisher-Yates).
        for (let i = 0; i < le; i++) perm[i] = i;
        for (let i = 0; i < m; i++) uf[i] = i;
        let te = 0;
        for (let i = 0; i < le && te < m - 1; i++) {
          const r = i + ((rand() * (le - i)) | 0);
          const ei = perm[r]; perm[r] = perm[i]; perm[i] = ei;
          const ra = find(la[ei]), rb = find(lb[ei]);
          if (ra !== rb) { uf[ra] = rb; tEdgeA[te] = la[ei]; tEdgeB[te] = lb[ei]; te++; }
        }
        if (te !== m - 1) return false;
        tStart.fill(0, 0, m + 1);
        for (let i = 0; i < te; i++) { tStart[tEdgeA[i] + 1]++; tStart[tEdgeB[i] + 1]++; }
        for (let i = 0; i < m; i++) tStart[i + 1] += tStart[i];
        for (let i = 0; i < m; i++) tFill[i] = tStart[i];
        for (let i = 0; i < te; i++) { tAdj[tFill[tEdgeA[i]]++] = tEdgeB[i]; tAdj[tFill[tEdgeB[i]]++] = tEdgeA[i]; }
        const root = (rand() * m) | 0;
        let sp = 0, oi = 0;
        queue[sp++] = root; parent[root] = -1;
        while (sp > 0) {
          const x = queue[--sp];
          pos[x] = oi; order[oi++] = x;
          for (let j = tStart[x]; j < tStart[x + 1]; j++) {
            const y = tAdj[j];
            if (y !== parent[x]) { parent[y] = x; queue[sp++] = y; }
          }
        }
        return true;
      }
      function subtreeSums(m) {
        for (let i = 0; i < m; i++) { sub[i] = pop[nodes[i]]; size[i] = 1; }
        for (let oi = m - 1; oi > 0; oi--) {
          const x = order[oi], p = parent[x];
          sub[p] += sub[x]; size[p] += size[x];
        }
      }
      // local graph over nodes[0..m) (loc[] must be set); returns local edge count
      function localEdges(m) {
        let le = 0;
        for (let i = 0; i < m; i++) {
          const x = nodes[i];
          for (let j = start[x]; j < start[x + 1]; j++) {
            if (!nconn[j]) continue;
            const l2 = loc[nbr[j]];
            if (l2 > i) { la[le] = i; lb[le] = l2; lw[le] = nlen[j]; le++; }
          }
        }
        return le;
      }

      // ----- starting map: recursive bisection with random spanning trees -----
      // Each region holding kk districts is cut into kk/2 and kk - kk/2 by a tree edge
      // whose two sides have population close to the right proportion.
      function initialPlan() {
        assign.fill(-1);
        let nextId = 0;
        const stack = [{ list: null, kk: k }];
        const all = new Int32Array(n);
        for (let u = 0; u < n; u++) all[u] = u;
        stack[0].list = all;
        while (stack.length) {
          const { list, kk } = stack.pop();
          if (kk === 1) { const d = nextId++; for (let i = 0; i < list.length; i++) assign[list[i]] = d; continue; }
          const m = list.length;
          for (let i = 0; i < m; i++) { nodes[i] = list[i]; loc[list[i]] = i; }
          const le = localEdges(m);
          let P = 0;
          for (let i = 0; i < m; i++) P += pop[nodes[i]];
          const k1 = kk >> 1;
          const target = P * k1 / kk;
          // an error here is shared by all the districts below this split
          let slack = ideal * Math.max(userTol, 0.002) * 0.4 * Math.max(1, Math.min(k1, kk - k1));
          let chosen = -1, takeSub = true;
          for (let attempt = 0; attempt < 400 && chosen < 0; attempt++) {
            if (attempt && attempt % 25 === 0) slack *= 1.5;
            if (!randomTree(m, le)) throw new Error("The map's units aren't all connected.");
            subtreeSums(m);
            let nc2 = 0;
            for (let oi = 1; oi < m; oi++) {
              const x = order[oi], s = sub[x];
              if (Math.abs(s - target) <= slack && size[x] >= k1 && m - size[x] >= kk - k1) cands[nc2++] = x;
              else if (Math.abs(P - s - target) <= slack && m - size[x] >= k1 && size[x] >= kk - k1) cands[nc2++] = -1 - x;
            }
            if (nc2) { const c = cands[(rand() * nc2) | 0]; takeSub = c >= 0; chosen = takeSub ? c : -1 - c; }
          }
          for (let i = 0; i < m; i++) loc[nodes[i]] = -1;
          if (chosen < 0) throw new Error("Couldn't split the state into " + k + " equal-population districts. Try fewer districts.");
          const p0 = pos[chosen], p1 = pos[chosen] + size[chosen];
          const inSub = new Uint8Array(m);
          for (let oi = p0; oi < p1; oi++) inSub[order[oi]] = 1;
          const a = [], b = [];
          for (let i = 0; i < m; i++) ((inSub[i] === 1) === takeSub ? a : b).push(nodes[i]);
          stack.push({ list: Int32Array.from(b), kk: kk - k1 });
          stack.push({ list: Int32Array.from(a), kk: k1 });
        }
      }

      // ----- contiguity repair (after projecting a coarse map onto finer units) -----
      // Each district keeps its biggest piece; stray pieces join the neighbor they share the most border with.
      function repairContiguity() {
        const comp = new Int32Array(n);
        let moved = 0;
        for (let iter = 0; iter < 50; iter++) {
          comp.fill(-1);
          const compPop = [], compDist = [], compSize = [];
          for (let s = 0; s < n; s++) {
            if (comp[s] >= 0) continue;
            const c = compPop.length, d = assign[s];
            let qh = 0, qt = 0, p = 0;
            queue[qt++] = s; comp[s] = c;
            while (qh < qt) {
              const x = queue[qh++]; p += pop[x] + 1e-6;
              for (let j = start[x]; j < start[x + 1]; j++) {
                const y = nbr[j];
                if (nconn[j] && comp[y] < 0 && assign[y] === d) { comp[y] = c; queue[qt++] = y; }
              }
            }
            compPop.push(p); compDist.push(d); compSize.push(qt);
          }
          const main = new Int32Array(k).fill(-1);
          for (let c = 0; c < compPop.length; c++) {
            const d = compDist[c];
            if (main[d] < 0 || compPop[c] > compPop[main[d]]) main[d] = c;
          }
          if (compPop.length === k) break;
          // for each stray piece, the neighboring district with the longest shared border
          const bestD = new Int32Array(compPop.length).fill(-1), bestL = new Float64Array(compPop.length).fill(-1);
          const acc = new Map();
          for (let u = 0; u < n; u++) {
            const c = comp[u];
            if (main[compDist[c]] === c) continue;
            for (let j = start[u]; j < start[u + 1]; j++) {
              const y = nbr[j], dy = assign[y];
              if (!nconn[j] || dy === compDist[c]) continue;
              const key = c * k + dy;
              const L = (acc.get(key) || 0) + nlen[j] + 1e-3;
              acc.set(key, L);
              if (L > bestL[c]) { bestL[c] = L; bestD[c] = dy; }
            }
          }
          for (let u = 0; u < n; u++) {
            const c = comp[u];
            if (main[compDist[c]] !== c && bestD[c] >= 0) { assign[u] = bestD[c]; moved++; }
          }
        }
        return moved;
      }

      // ----- ReCom move -----
      function recomMove() {
        const e = randomCutEdge();
        if (e < 0) return false;
        const u = eu[e];
        const A = assign[u], B = assign[ev[e]];
        let m = 0;
        loc[u] = 0; nodes[m++] = u;
        for (let qi = 0; qi < m; qi++) {
          const x = nodes[qi];
          for (let j = start[x]; j < start[x + 1]; j++) {
            const y = nbr[j];
            if (nconn[j] && loc[y] < 0 && (assign[y] === A || assign[y] === B)) { loc[y] = m; nodes[m++] = y; }
          }
        }
        const le = localEdges(m);
        const tot = dPop[A] + dPop[B];
        let plo = lo, phi = hi;
        if (phase === "balance") {
          const worst = Math.max(Math.abs(dPop[A] - ideal), Math.abs(dPop[B] - ideal));
          if (worst <= ideal * tol) { cleanup(m); return false; }
          plo = Math.min(lo, ideal - worst); phi = Math.max(hi, ideal + worst);
        }
        let nc2 = 0;
        for (let attempt = 0; attempt < 3 && nc2 === 0; attempt++) {
          if (!randomTree(m, le)) break;
          subtreeSums(m);
          for (let oi = 1; oi < m; oi++) {
            const x = order[oi], s = sub[x], r = tot - s;
            if (s >= plo && s <= phi && r >= plo && r <= phi) cands[nc2++] = x;
          }
        }
        if (nc2 === 0) { cleanup(m); return false; }
        const c = cands[(rand() * nc2) | 0];
        const p0 = pos[c], p1 = pos[c] + size[c];
        let overlapA = 0;
        for (let oi = 0; oi < m; oi++) {
          const x = order[oi];
          side[x] = oi >= p0 && oi < p1 ? 1 : 0;
          if (side[x] === 1 && assign[nodes[x]] === A) overlapA++;
        }
        const lab1 = overlapA * 2 >= size[c] ? A : B, lab0 = lab1 === A ? B : A;
        let p1v = 0, p0v = 0, d1 = 0, d0 = 0, r1 = 0, r0 = 0, a1 = 0, a0 = 0, per1 = 0, per0 = 0, c1 = 0, c0 = 0;
        for (let i = 0; i < m; i++) {
          const x = nodes[i];
          if (side[i]) { p1v += pop[x]; d1 += dem[x]; r1 += rep[x]; a1 += area[x]; per1 += border[x]; c1++; }
          else { p0v += pop[x]; d0 += dem[x]; r0 += rep[x]; a0 += area[x]; per0 += border[x]; c0++; }
        }
        // borders inside each half (all borders, including shape-only ones; each seen from both ends)
        for (let i = 0; i < m; i++) {
          const x = nodes[i];
          for (let j = start[x]; j < start[x + 1]; j++) {
            const l2 = loc[nbr[j]];
            if (l2 >= 0 && side[l2] === side[i]) { if (side[i]) per1 -= nlen[j]; else per0 -= nlen[j]; }
          }
        }
        const saved = save(A, B);
        let nch = 0;
        for (let i = 0; i < m; i++) {
          const x = nodes[i], nl = side[i] ? lab1 : lab0;
          if (assign[x] !== nl) { changed[nch++] = x; moveCounty(x, assign[x], nl); assign[x] = nl; }
        }
        setStats(lab1, p1v, d1, r1, a1, per1, c1);
        setStats(lab0, p0v, d0, r0, a0, per0, c0);
        cleanup(m);
        if (tryAccept(A, B, saved)) return true;
        for (let i = 0; i < nch; i++) {
          const x = changed[i], back = assign[x] === A ? B : A;
          moveCountyRaw(x, assign[x], back); assign[x] = back;
        }
        return false;
      }
      // county counts only; `splits` is restored separately
      function moveCountyRaw(x, from, to) {
        if (!countyOn) return;
        const c = county[x];
        if (--cd[c * k + from] === 0) cPresent[c]--;
        if (cd[c * k + to]++ === 0) cPresent[c]++;
      }
      function cleanup(m) { for (let i = 0; i < m; i++) loc[nodes[i]] = -1; }
      function setStats(d, p, de, r, a, per, c) { dPop[d] = p; dDem[d] = de; dRep[d] = r; dArea[d] = a; dPerim[d] = per; dCnt[d] = c; }
      function moveCounty(x, from, to) {
        if (!countyOn) return;
        const c = county[x];
        if (--cd[c * k + from] === 0) { cPresent[c]--; if (cPresent[c] >= 1) splits--; }
        if (cd[c * k + to]++ === 0) { cPresent[c]++; if (cPresent[c] > 1) splits++; }
      }
      function save(A, B) {
        return [dPop[A], dDem[A], dRep[A], dArea[A], dPerim[A], dCnt[A], dPop[B], dDem[B], dRep[B], dArea[B], dPerim[B], dCnt[B],
          dInv[A], dPen[A], dCls[A], shares[A], dInv[B], dPen[B], dCls[B], shares[B], compSum, penSum, splits, partE,
          cntSafeD, cntSafeR, cntComp, cntWinD, dTier[A], dTier[B]].concat(Array.from(cntTier));
      }
      function restoreSaved(A, B, s) {
        dPop[A] = s[0]; dDem[A] = s[1]; dRep[A] = s[2]; dArea[A] = s[3]; dPerim[A] = s[4]; dCnt[A] = s[5];
        dPop[B] = s[6]; dDem[B] = s[7]; dRep[B] = s[8]; dArea[B] = s[9]; dPerim[B] = s[10]; dCnt[B] = s[11];
        dInv[A] = s[12]; dPen[A] = s[13]; dCls[A] = s[14]; shares[A] = s[15];
        dInv[B] = s[16]; dPen[B] = s[17]; dCls[B] = s[18]; shares[B] = s[19];
        compSum = s[20]; penSum = s[21]; splits = s[22]; partE = s[23];
        cntSafeD = s[24]; cntSafeR = s[25]; cntComp = s[26]; cntWinD = s[27];
        dTier[A] = s[28]; dTier[B] = s[29];
        for (let j = 0; j < nTier; j++) cntTier[j] = s[30 + j];
      }
      // stats of A and B already updated; decide, and roll back if rejected
      function tryAccept(A, B, saved) {
        refresh(A); refresh(B);
        if (wPart > 0) partE = partisanE();
        const newE = energy();
        if (lockOk() && accept(newE - curE)) { curE = newE; return true; }
        restoreSaved(A, B, saved);
        return false;
      }

      // ----- flip move -----
      function flipMove() {
        const e = randomCutEdge();
        if (e < 0) return false;
        let u = eu[e], v = ev[e];
        if (rand() < 0.5) { const t = u; u = v; v = t; }
        const A = assign[u], B = assign[v];
        if (dCnt[A] <= 1) return false;
        const nA = dPop[A] - pop[u], nB = dPop[B] + pop[u];
        const newPen = popPen(nA) + popPen(nB);
        if (newPen > dPen[A] + dPen[B] + 1e-9) {
          if (!softPop) return false;
          const lim = ideal * softHard;
          if (Math.abs(nA - ideal) > lim || Math.abs(nB - ideal) > lim) return false;
        }
        if (!stillConnectedWithout(u, A)) return false;
        let inA = 0, inB = 0;
        for (let j = start[u]; j < start[u + 1]; j++) {
          const a = assign[nbr[j]];
          if (a === A) inA += nlen[j]; else if (a === B) inB += nlen[j];
        }
        const saved = save(A, B);
        setStats(A, nA, dDem[A] - dem[u], dRep[A] - rep[u], dArea[A] - area[u], dPerim[A] - border[u] + 2 * inA, dCnt[A] - 1);
        setStats(B, nB, dDem[B] + dem[u], dRep[B] + rep[u], dArea[B] + area[u], dPerim[B] + border[u] - 2 * inB, dCnt[B] + 1);
        moveCounty(u, A, B); assign[u] = B;
        if (tryAccept(A, B, saved)) return true;
        assign[u] = A;
        moveCountyRaw(u, B, A);
        return false;
      }
      // Does district A stay connected if u leaves it?
      function stillConnectedWithout(u, A) {
        let targets = 0, first = -1;
        stampId++;
        for (let j = start[u]; j < start[u + 1]; j++) {
          const y = nbr[j];
          if (nconn[j] && assign[y] === A && stamp[y] !== stampId) { stamp[y] = stampId; targets++; if (first < 0) first = y; }
        }
        if (targets <= 1) return targets === 1;
        const tgt = stampId; stampId++;
        let qh = 0, qt = 0, found = 1;
        queue[qt++] = first; stamp[first] = stampId; stamp[u] = stampId;
        while (qh < qt) {
          const x = queue[qh++];
          for (let j = start[x]; j < start[x + 1]; j++) {
            const y = nbr[j];
            if (!nconn[j] || assign[y] !== A || stamp[y] === stampId) continue;
            if (stamp[y] === tgt) { found++; if (found === targets) return true; }
            stamp[y] = stampId; queue[qt++] = y;
          }
          // Give up (reject the move) if the pieces don't reconnect nearby. Always
          // safe: it can only turn down a rare valid move, never allow a split.
          if (qt > SEARCH_CAP) return false;
        }
        return false;
      }

      function accept(dE) {
        proposals++;
        if (dE <= 0 || rand() < Math.exp(-dE / T)) { accepted++; return true; }
        return false;
      }

      // ----- phases -----
      function snapshotBest() {
        if (!best) best = { assign: new Int32Array(n), E: Infinity };
        best.assign.set(assign); best.E = curE;
      }
      function restore(a) { assign.set(a); recomputeAll(); curE = energy(); }
      function worstDev() { let w = 0; for (let d = 0; d < k; d++) w = Math.max(w, Math.abs(dPop[d] - ideal) / ideal); return w; }

      function enterPhase(p) {
        phase = p; phaseStep = 0; best = null;
        softPop = p === "polish" || p === "final";
        wCenter = p === "balance" || p === "final" ? 200 : 0;
        wPop = p === "final" ? 1e6 : p === "polish" ? tune.popW0 : 1000;
        if (p === "balance") {
          // compactness counts too, so moves inside the population band aren't free
          wPart = 0; wComp = compact ? 1 : 0; wCty = wCounty; T0 = tune.balanceT0; T1 = tune.balanceT1; recomProb = tune.balanceRecom;
          phaseBudget = Math.max(20000, searchBudget, 3 * n, 2000 * k);
        } else if (p === "search") {
          wPart = 1; wComp = compact ? tune.searchComp : 0; wCty = wCounty * tune.searchComp; T0 = tune.searchT0; T1 = tune.searchT1;
          phaseBudget = searchBudget; recomProb = tune.searchRecom;
          lock = null;
          if (isMax) { tierIdx = 0; posIdx = -1; tierLock.fill(-1); posLock.fill(-Infinity); lock = { tiers: tierLock, pos: posLock }; }
        } else if (p === "polish") {
          wPart = 0; wComp = 1; wCty = wCounty;
          T0 = tune.polishT0; T1 = tune.polishT1; phaseBudget = polishBudget; recomProb = tune.polishRecom;
          if (!lock && mode !== "neutral") lock = currentLock();
        } else if (p === "final") {
          wPart = 0; wComp = compact ? 1 : 0; wCty = wCounty;
          if (!lock && mode !== "neutral") lock = currentLock();
          T0 = T1 = 1e-4; phaseBudget = Math.max(30000, 4 * n, 2000 * k); recomProb = 0;
        }
        recomputePen();
        partE = partisanE();
        curE = energy();
        T = T0;
        if (p === "search" && (mode === "maxD" || mode === "maxR")) startNextTarget(true);
        if (p === "polish") snapshotBest();
      }
      function nextPhase() {
        const keep = best;
        phaseIdx++;
        if (phaseIdx >= phases.length) { finishAll(); return; }
        const p = phases[phaseIdx];
        enterPhase(p);
        if (p === "final") best = keep;
      }
      function finishAll() {
        if (phase === "polish" && best) restore(best.assign);
        phase = "done";
      }
      // Locks for the later phases. For gerrymanders, each district below the floor
      // keeps (almost) its level: 0.2 points of slack so borders can still be smoothed.
      function currentLock() {
        if (!isMax) return { safeD: cntSafeD, safeR: cntSafeR, comp: cntComp };
        const b = partySorted(new Float64Array(k)), pos = new Float64Array(k).fill(-Infinity);
        for (let q = 0; q < cntTier[0]; q++) pos[q] = thFloor; // safe seats: anywhere at or above the floor
        if (posOn) for (let q = cntTier[0]; q < k; q++) pos[q] = Math.min(b[q], thFloor) - 0.001;
        return { tiers: Array.from(cntTier), pos };
      }
      function startNextTarget(first) {
        if (first) {
          // the map at the start of this tier is the fallback if the next seat can't be reached
          bestAchievedT = cntTier[tierIdx];
          if (!bestAchievedAssign) bestAchievedAssign = new Int32Array(n);
          bestAchievedAssign.set(assign);
        }
        maxTarget = first ? cntTier[tierIdx] + 1 : maxTarget + 1;
        if (mode === "maxD") { needD = Math.min(k, maxTarget); needR = 0; } else { needR = Math.min(k, maxTarget); needD = 0; }
        targetSteps = 0; phaseStep = 0;
        partE = partisanE();
        curE = energy();
      }

      function init() {
        if (opts.initialAssign) {
          assign.set(opts.initialAssign);
          const moved = repairContiguity();
          if (moved) notes.push("Reconnected " + moved.toLocaleString("en-US") + " stray " + unitName + "s when switching to census blocks.");
        } else {
          initialPlan();
        }
        recomputeAll();
        if (opts.lockFromStart && mode !== "neutral") lock = currentLock();
        if (mode === "neutral" && !opts.goal) goal = { achieved: true, text: compact ? "No partisan goal: equal-population, compact districts" : "No partisan goal: equal-population districts, shapes left as they fall" };
        if (worstDev() > userTol) enterPhase("balance");
        else nextPhase();
      }

      function stepOnce() {
        stepCount++; phaseStep++;
        const frac = Math.min(1, phaseStep / phaseBudget);
        T = T0 * Math.pow(T1 / T0, frac);
        if (rand() < recomProb) recomMove(); else flipMove();
        if ((stepCount & 0xffff) === 0) resync();
        const check = (phaseStep & 63) === 0;

        if (phase === "balance") {
          if (check && popOk()) { nextPhase(); return; }
          if (phaseStep >= phaseBudget) {
            const w = worstDev();
            notes.push("Couldn't reach ±" + (userTol * 100).toFixed(2) + "% population balance with whole " + unitName + "s; best was ±" + (w * 100).toFixed(3) + "%.");
            setTol(w + 1e-9);
            nextPhase();
          }
        } else if (phase === "search") {
          searchTotal++;
          if (isMax && posIdx >= 0) {
            posSteps++;
            const v = thFloor - partE / 100;
            if (v > posBestVal + 1e-9) { posBestVal = v; posBestAssign.set(assign); }
            if (partE === 0 || posSteps >= posPatience) {
              restore(posBestAssign);
              posLock[posIdx] = Math.min(posBestVal, thFloor) - 1e-9;
              posIdx++;
              if (posIdx >= k) { finishSearch(true); return; }
              startPosition();
            }
            return;
          }
          if (isMax) {
            targetSteps++;
            const patience = tierIdx === 0 ? phaseBudget : phaseBudget / 2;
            if (partE === 0) {
              bestAchievedT = maxTarget;
              bestAchievedAssign.set(assign);
              if (maxTarget >= k) { nextTier(); return; }
              startNextTarget(false);
              T = T0 * 0.5;
            } else if (targetSteps >= patience || searchTotal >= phaseBudget * (4 + 2 * nTier)) {
              restore(bestAchievedAssign);
              if (searchTotal >= phaseBudget * (4 + 2 * nTier)) { for (let j = tierIdx; j < nTier; j++) tierLock[j] = cntTier[j]; finishSearch(true); return; }
              nextTier();
            }
            return;
          }
          if (mode !== "competitive" && partE === 0) { finishSearch(true); return; }
          if (!best || partE < best.E) { if (!best) best = { assign: new Int32Array(n), E: partE }; best.assign.set(assign); best.E = partE; }
          if (phaseStep >= phaseBudget) {
            restore(best.assign);
            finishSearch(false);
          }
        } else if (phase === "polish") {
          // ramp the population penalty: loose early, strict at the end
          if ((phaseStep & 255) === 0) { wPop = tune.popW0 * Math.pow(tune.popW1 / tune.popW0, frac); recomputePen(); curE = energy(); }
          if (curE < best.E - 1e-9 && popOk()) snapshotBest();
          if (phaseStep >= phaseBudget) nextPhase();
        } else if (phase === "final") {
          // strict rebalancing of the polished map, then keep whichever valid map is better
          if (check && popOk()) {
            if (best && curE > best.E) restore(best.assign);
            phase = "done";
          } else if (phaseStep >= phaseBudget) {
            if (best) restore(best.assign);
            phase = "done";
          }
        }
      }

      // lock this count and move on: next count, then district-by-district
      function nextTier() {
        tierLock[tierIdx] = cntTier[tierIdx];
        tierIdx++;
        if (tierIdx < nTier) { startNextTarget(true); return; }
        tierIdx = nTier - 1;
        posIdx = cntTier[0]; // first district below the floor
        // Safe seats are floored, not frozen: while squeezing, each may give up votes
        // (to help the districts below) as long as it stays at or above the floor.
        for (let q = 0; q < posIdx; q++) posLock[q] = thFloor;
        if (!posOn || posIdx >= k) { posIdx = -1; finishSearch(true); return; }
        startPosition();
      }
      function startPosition() {
        posSteps = 0; phaseStep = 0;
        partE = partisanE();
        posBestVal = thFloor - partE / 100;
        if (!posBestAssign) posBestAssign = new Int32Array(n);
        posBestAssign.set(assign);
        curE = energy();
        T = T0 * 0.5;
      }
      // margins (points) from the favored party's side, best district first
      function partyMargins() { return Array.from(partySorted(new Float64Array(k)), (v) => 200 * v - 100); }
      function gerryText() {
        const S = cntTier[0], W = cntTier[nTier - 1], rest = k - S;
        // counts only: they're locked, so they stay true after later phases (margins can still shift a little)
        let t = floorPts > 0 ? " Narrower wins: " + (W - S) + "." : "";
        if (rest > 0 && posOn) t += " Every other district was then pushed as close to the floor as it would go.";
        return t;
      }
      function finishSearch(achieved) {
        const margin = h > 0 ? " by " + (h * 200).toFixed(0) + "+ points" : "";
        if (isMax) { posIdx = -1; goal = { achieved: cntTier[0] > 0, text: "Most " + (mode === "maxD" ? "Democratic" : "Republican") + " seats found: " + cntTier[0] + " of " + k + (margin ? " won" + margin : "") + "." + gerryText() }; }
        else if (mode === "competitive") goal = { achieved: true, text: cntComp + " of " + k + " districts within " + (band * 200).toFixed(0) + " points" };
        else {
          const want = needD + " D / " + needR + " R" + margin;
          goal = achieved
            ? { achieved: true, text: "Reached " + want }
            : { achieved: false, text: "Couldn't reach " + want + ". Closest map found: " + cntSafeD + " D / " + cntSafeR + " R" + margin + "." };
        }
        nextPhase();
      }

      // ----- results -----
      function verifyContiguity() {
        const comps = new Int32Array(k);
        const seen = new Uint8Array(n);
        const usesBridge = new Uint8Array(k);
        for (let s = 0; s < n; s++) {
          if (seen[s]) continue;
          const d = assign[s];
          comps[d]++;
          let qh = 0, qt = 0; queue[qt++] = s; seen[s] = 1;
          while (qh < qt) {
            const x = queue[qh++];
            for (let j = start[x]; j < start[x + 1]; j++) {
              const y = nbr[j];
              if (!nconn[j] || assign[y] !== d) continue;
              if (nconn[j] === 2) usesBridge[d] = 1;
              if (!seen[y]) { seen[y] = 1; queue[qt++] = y; }
            }
          }
        }
        const broken = [];
        let water = 0;
        for (let d = 0; d < k; d++) { if (comps[d] !== 1) broken.push(d); water += usesBridge[d]; }
        return { ok: broken.length === 0, broken, water };
      }

      // full=false skips the slower whole-map checks (used for live progress)
      function report(full) {
        const districts = new Array(k);
        let wastedD = 0, wastedR = 0, votes = 0, maxDev = 0, ppSum = 0;
        let ctyCount = null;
        if (full && countyOn) { ctyCount = new Int32Array(k); for (let c = 0; c < nc; c++) for (let d = 0; d < k; d++) if (cd[c * k + d] > 0) ctyCount[d]++; }
        for (let d = 0; d < k; d++) {
          const t = dDem[d] + dRep[d];
          const pp = dPerim[d] > 0 ? (FOUR_PI * dArea[d]) / (dPerim[d] * dPerim[d]) : 0;
          const dev = (dPop[d] - ideal) / ideal;
          maxDev = Math.max(maxDev, Math.abs(dev));
          ppSum += pp;
          const need = t / 2;
          if (dDem[d] > dRep[d]) { wastedD += dDem[d] - need; wastedR += dRep[d]; } else { wastedR += dRep[d] - need; wastedD += dDem[d]; }
          votes += t;
          districts[d] = { id: d, pop: dPop[d], dev, dem: dDem[d], rep: dRep[d], share: shares[d], pp, area: dArea[d], units: dCnt[d], counties: ctyCount ? ctyCount[d] : null };
        }
        const sorted = Array.from(shares).sort((a, b) => a - b);
        const median = k % 2 ? sorted[(k - 1) / 2] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2;
        const mean = sorted.reduce((a, b) => a + b, 0) / k;
        let splitCounties = 0;
        for (let c = 0; c < nc; c++) if (cPresent[c] > 1) splitCounties++;
        let minPop = Infinity, maxPop = -Infinity;
        for (let d = 0; d < k; d++) { minPop = Math.min(minPop, dPop[d]); maxPop = Math.max(maxPop, dPop[d]); }
        return {
          phase, step: stepCount, k, ideal, tol, userTol, stateShare, unitName,
          seats: outcome(), districts, maxDev, minPop, maxPop, meanPP: ppSum / k,
          gerry: isMax ? { floor: floorPts, safe: cntTier[0], wins: cntTier[nTier - 1], margins: partyMargins() } : null,
          efficiencyGap: (wastedD - wastedR) / votes, // >0 means Dem votes are wasted more (map favors R)
          meanMedian: median - mean,                  // <0 means map favors R
          splitCounties: countyOn ? splitCounties : null, countySplits: splits,
          contiguity: full ? verifyContiguity() : null,
          goal: phase === "search" || phase === "balance" || phase === "init" ? progressGoal() : goal,
          acceptRate: proposals ? accepted / proposals : 0,
          notes: notes.slice(),
          phaseProgress: Math.min(1, phaseStep / phaseBudget),
          target: { needD, needR },
        };
      }
      function progressGoal() {
        if (phase !== "search") return { achieved: false, text: phase === "balance" ? "Balancing population" : goal.text };
        if (isMax) {
          const party = mode === "maxD" ? "Democratic" : "Republican", need = Math.min(k, maxTarget);
          if (posIdx >= 0) return { achieved: false, text: "Locked " + cntTier[0] + " safe seats and " + cntTier[nTier - 1] + " wins; now pushing the #" + (posIdx + 1) + " district toward the floor" };
          if (tierIdx === 0) return { achieved: false, text: "Trying for " + need + " " + party + " seats" + (floorPts > 0 ? " won by " + floorPts + "+" : "") };
          return { achieved: false, text: "Locked " + cntTier[0] + " safe seats; now trying for " + need + " " + party + " wins" };
        }
        if (mode === "competitive") return { achieved: false, text: "Making districts competitive" };
        return { achieved: false, text: "Aiming for " + needD + " D / " + needR + " R" };
      }

      return {
        n, k, ideal,
        assign,
        init,
        get phase() { return phase; },
        get goal() { return goal; },
        // run until `ms` milliseconds pass or the run finishes
        run(ms) {
          const t0 = Date.now();
          let i = 0;
          while (phase !== "done") {
            stepOnce();
            if ((++i & 63) === 0 && Date.now() - t0 >= ms) break;
          }
          return phase === "done";
        },
        steps(nSteps) { for (let i = 0; i < nSteps && phase !== "done"; i++) stepOnce(); return phase === "done"; },
        // skip ahead to the next phase
        finishNow() {
          if (phase === "polish") { nextPhase(); }
          else if (phase === "final") { if (best) restore(best.assign); phase = "done"; }
          else if (phase === "search" || phase === "balance") { phaseStep = phaseBudget; targetSteps = phaseBudget; searchTotal = Infinity; stepOnce(); }
        },
        report,
        verifyContiguity,
        _debug: { recomputeAll, dPop, dPerim, dArea, energy, get curE() { return curE; }, get splits() { return splits; }, get compSum() { return compSum; } },
      };
    }

    // ---------- two-level runner: precincts first, then census blocks ----------
    // fine: block graph; group: precinct id per block; opts as in createEngine plus
    // coarsePolishSteps / finePolishSteps.
    function createPipeline(fine, group, opts) {
      const rand = makeRng(opts.seed == null ? (Math.random() * 4294967296) >>> 0 : opts.seed);
      const k = opts.k | 0;
      const agg = group ? aggregate(fine, group) : null;
      const useCoarse = agg && k * 8 <= agg.graph.n;
      const neutral = (opts.mode || "neutral") === "neutral";
      let stage, coarse = null, eng = null;
      const blockAssign = new Int32Array(fine.n);
      const coarseTune = Object.assign({}, opts.tune && opts.tune.coarse);
      // ReCom on blocks is cheap only when districts are small
      const smallDistricts = fine.n / k < 2000;
      const fineTune = Object.assign({
        balanceRecom: smallDistricts ? 0.3 : 0, balanceT0: 0.003, balanceT1: 0.0003,
        polishRecom: smallDistricts ? 0.02 : 0, polishT0: 0.003, polishT1: 0.0002, popW0: 300,
      }, opts.tune && opts.tune.fine);
      // fromCoarse: the map came out of the precinct stage, so its seat result is locked
      function startFine(initialAssign, goal, fromCoarse) {
        eng = createEngine(fine, Object.assign({}, opts, {
          rand, initialAssign, goal, lockFromStart: !!fromCoarse, unitName: "block",
          phases: fromCoarse || neutral ? ["polish", "final"] : ["search", "polish", "final"],
          polishSteps: opts.finePolishSteps, tune: fineTune,
        }));
        eng.init();
        stage = "block";
      }
      let coarseTol = 0.02;
      if (useCoarse) {
        const meanPrecinct = agg.graph.pop.reduce((x, y) => x + y, 0) / agg.graph.n;
        const ideal = agg.graph.pop.reduce((x, y) => x + y, 0) / k;
        coarseTol = Math.min(0.05, Math.max(opts.tol || 0, 0.005, 2 * meanPrecinct / ideal));
      }
      // opts.startAssign (block-level map) seeds the run; each precinct goes to the
      // district holding most of its people
      function coarseStart() {
        const sa = opts.startAssign;
        if (!sa || !useCoarse) return null;
        const m = agg.graph.n, gof = agg.groupOf;
        const best = new Int32Array(m).fill(-1), bestW = new Float64Array(m).fill(-1);
        const acc = new Map();
        for (let u = 0; u < fine.n; u++) {
          const key = gof[u] * k + sa[u];
          const w = (acc.get(key) || 0) + fine.pop[u] + 1e-3;
          acc.set(key, w);
          if (w > bestW[gof[u]]) { bestW[gof[u]] = w; best[gof[u]] = sa[u]; }
        }
        return best;
      }
      function init() {
        if (useCoarse) {
          coarse = createEngine(agg.graph, Object.assign({}, opts, {
            // as tight as whole precincts allow, so the block stage has little left to move
            rand, tol: coarseTol, unitName: "precinct", initialAssign: coarseStart(),
            phases: neutral ? ["polish"] : ["search", "polish"],
            polishSteps: opts.coarsePolishSteps, tune: coarseTune,
          }));
          coarse.init();
          stage = "precinct";
        } else {
          startFine(opts.startAssign || null, null, false);
        }
      }
      function current() { return stage === "precinct" ? coarse : eng; }
      function assignment() {
        if (stage === "precinct") {
          const ga = coarse.assign, gof = agg.groupOf;
          for (let u = 0; u < fine.n; u++) blockAssign[u] = ga[gof[u]];
          return blockAssign;
        }
        return eng.assign;
      }
      function advance() {
        if (stage === "precinct" && coarse.phase === "done") startFine(Int32Array.from(assignment()), coarse.goal, true);
      }
      return {
        init,
        get stage() { return stage; },
        get phase() { return stage === "block" && eng.phase === "done" ? "done" : current().phase; },
        useCoarse,
        run(ms) { const done = current().run(ms); if (done) advance(); return this.phase === "done"; },
        finishNow() { current().finishNow(); if (current().phase === "done") advance(); },
        assignment,
        report(full) { const r = current().report(full); r.stage = stage; r.useCoarse = useCoarse; return r; },
      };
    }

    // Decoded state arrays -> engine input. Block votes are the precinct's
    // 2024 votes split by each block's weight (voting-age population).
    //
    // Districts may only connect over land: water blocks (no land area) are left
    // out of the graph, and land cut off by water (islands etc.) is joined only by
    // the links in meta.landBridges. Each water block is attached to a nearby land
    // block (`attach`) so it can be shown and exported with that block's district.
    function prepareGraph(meta, A) {
      const n = meta.n, np = meta.precincts.id.length;
      const water = A.water || new Uint8Array(n);
      const wsum = new Float64Array(np);
      for (let u = 0; u < n; u++) wsum[A.precinct[u]] += A.weight[u];
      const bdem = new Float64Array(n), brep = new Float64Array(n);
      for (let u = 0; u < n; u++) {
        const p = A.precinct[u], f = wsum[p] > 0 ? A.weight[u] / wsum[p] : 0;
        bdem[u] = meta.precincts.dem[p] * f; brep[u] = meta.precincts.rep[p] * f;
      }
      const x = meta.extraVotes;
      if (x) for (let i = 0; i < x.block.length; i++) { bdem[x.block[i]] += x.dem[i]; brep[x.block[i]] += x.rep[i]; }
      // all block edges
      const E = meta.nEdges, au = new Int32Array(E), av = new Int32Array(E);
      let e = 0;
      for (let u = 0; u < n; u++) for (let j = 0; j < A.deg[u]; j++, e++) { au[e] = u; av[e] = u + A.dv[e]; }
      // land index
      const landOf = new Int32Array(n).fill(-1);
      let nl = 0;
      for (let u = 0; u < n; u++) if (!water[u]) landOf[u] = nl++;
      const landIds = new Int32Array(nl);
      for (let u = 0; u < n; u++) if (landOf[u] >= 0) landIds[landOf[u]] = u;
      // attach water blocks to land: breadth-first out from the shore
      const attach = Int32Array.from(landOf);
      const deg = new Int32Array(n);
      for (let i = 0; i < E; i++) { deg[au[i]]++; deg[av[i]]++; }
      const st = new Int32Array(n + 1);
      for (let u = 0; u < n; u++) st[u + 1] = st[u] + deg[u];
      const adj = new Int32Array(2 * E), fill = st.slice(0, n);
      for (let i = 0; i < E; i++) { adj[fill[au[i]]++] = av[i]; adj[fill[av[i]]++] = au[i]; }
      const q = new Int32Array(n);
      let qh = 0, qt = 0;
      for (let u = 0; u < n; u++) if (landOf[u] >= 0) q[qt++] = u;
      while (qh < qt) {
        const u = q[qh++];
        for (let j = st[u]; j < st[u + 1]; j++) { const w = adj[j]; if (attach[w] < 0) { attach[w] = attach[u]; q[qt++] = w; } }
      }
      for (let u = 0; u < n; u++) if (attach[u] < 0) attach[u] = 0;
      // Each land unit's shape includes the water attached to it, so compactness
      // still sees coastlines and bays; only contiguity ignores water.
      const pop = new Float64Array(nl), dem = new Float64Array(nl), rep = new Float64Array(nl), area = new Float64Array(nl);
      const ext = new Float64Array(nl), county = new Int32Array(nl), group = new Int32Array(nl);
      for (let u = 0; u < n; u++) {
        const l = attach[u];
        dem[l] += bdem[u]; rep[l] += brep[u]; pop[l] += A.pop[u];
        area[l] += A.area[u] * 100; ext[l] += A.ext[u];
        if (landOf[u] >= 0) { county[l] = A.county[u]; group[l] = A.precinct[u]; }
      }
      const pairs = new Map(), lu = [], lv = [], ll = [], lc = [];
      function addEdge(a, b, len, c) {
        if (a === b) return;
        const key = a < b ? a * nl + b : b * nl + a;
        const i = pairs.get(key);
        if (i === undefined) { pairs.set(key, lu.length); lu.push(Math.min(a, b)); lv.push(Math.max(a, b)); ll.push(len); lc.push(c); }
        else { ll[i] += len; lc[i] = mergeConn(lc[i], c); }
      }
      for (let i = 0; i < E; i++) {
        const land = landOf[au[i]] >= 0 && landOf[av[i]] >= 0;
        addEdge(attach[au[i]], attach[av[i]], A.elen[i], land ? (A.elen[i] > 0 ? 1 : 2) : 0);
      }
      const br = meta.landBridges || [];
      for (let i = 0; i < br.length; i += 2) {
        const a = landOf[br[i]], b = landOf[br[i + 1]];
        if (a >= 0 && b >= 0) addEdge(a, b, 0, 2);
      }
      // Precinct-stage units: each precinct's land-connected pieces (a precinct
      // split by a river becomes two units), so precinct maps stay contiguous on land.
      const uf = new Int32Array(nl);
      for (let i = 0; i < nl; i++) uf[i] = i;
      const find = (v) => { while (uf[v] !== v) { uf[v] = uf[uf[v]]; v = uf[v]; } return v; };
      for (let i = 0; i < lu.length; i++) if (lc[i] === 1 && group[lu[i]] === group[lv[i]]) { const ra = find(lu[i]), rb = find(lv[i]); if (ra !== rb) uf[ra] = rb; }
      const piece = new Int32Array(nl);
      for (let i = 0; i < nl; i++) piece[i] = find(i);
      return {
        n: nl, pop, dem, rep, area, ext, county, group: piece, precinct: group,
        eu: Int32Array.from(lu), ev: Int32Array.from(lv), elen: Float64Array.from(ll), econn: Uint8Array.from(lc),
        landIds, landOf, attach, blocks: n,
      };
    }

    // land-graph assignment -> one district per census block (water follows its land)
    function expandAssign(graph, landAssign, out) {
      const a = out || new Int32Array(graph.blocks);
      for (let u = 0; u < graph.blocks; u++) a[u] = landAssign[graph.attach[u]];
      return a;
    }

    // ---------- superthinking: run the whole pipeline in cycles, forever ----------
    // Each cycle balances, chases the goal, compacts and refines on blocks, then is
    // scored against the best map so far. Most cycles start from the best map (and
    // gerrymander goals aim one seat higher); every 4th starts from a fresh random
    // map to get out of dead ends. Runs until stop().
    function createEndless(fine, group, opts) {
      const mode = opts.mode || "neutral";
      const h = (opts.margin || 0) / 200, tol = opts.tol == null ? 0.005 : opts.tol;
      const compact = opts.compact !== false;
      let cycle = 0, pipe = null, best = null, improved = false, stopped = false;
      const baseSeed = opts.seed == null ? (Math.random() * 4294967296) >>> 0 : opts.seed;

      function deficit(r) {
        const t = r.target, sh = r.districts.map((d) => d.share).sort((a, b) => a - b), k = sh.length;
        let e = 0;
        for (let i = 0; i < t.needR; i++) e += Math.max(0, sh[i] - (0.5 - h));
        for (let i = k - t.needD; i < k; i++) e += Math.max(0, 0.5 + h - sh[i]);
        return e;
      }
      // higher is better, compared left to right
      function score(r) {
        const valid = r.contiguity && r.contiguity.ok && r.maxDev <= tol + 1e-9 ? 1 : 0;
        let primary = [0];
        // gerrymanders: safe seats, then wins, then each district's margin (capped at the floor), best first
        if (r.gerry) primary = [r.gerry.safe, r.gerry.wins].concat(r.gerry.margins.slice(r.gerry.safe).map((m) => Math.min(m, r.gerry.floor)));
        else if (mode === "competitive") primary = [r.seats.comp];
        else if (mode === "target" || mode === "proportional") primary = [-deficit(r)];
        const shape = compact ? -r.districts.reduce((a, d) => a + (d.pp > 0 ? 1 / d.pp : 1e9), 0) : -r.maxDev;
        return valid ? [1].concat(primary, [shape]) : [0, -r.maxDev].concat(primary);
      }
      function better(a, b) {
        for (let i = 0; i < a.length; i++) { if (a[i] > b[i] + 1e-12) return true; if (a[i] < b[i] - 1e-12) return false; }
        return false;
      }
      function startCycle() {
        cycle++;
        const fresh = !best || cycle % 4 === 1;
        // later cycles search harder (up to 4x the normal budget)
        const boost = Math.min(4, 1 + 0.5 * (cycle - 1));
        pipe = createPipeline(fine, group, Object.assign({}, opts, {
          seed: (baseSeed + cycle * 7919) >>> 0,
          startAssign: fresh ? null : best.assign,
          searchSteps: Math.round((opts.searchSteps || 40000) * boost),
        }));
        pipe.init();
      }
      function endCycle() {
        const r = pipe.report(true);
        const sc = score(r);
        if (!best || better(sc, best.score)) {
          best = { assign: Int32Array.from(pipe.assignment()), report: r, score: sc, cycle };
          improved = true;
        }
      }
      return {
        init() { startCycle(); },
        get phase() { return stopped ? "done" : pipe.phase; },
        get stage() { return pipe.stage; },
        get useCoarse() { return pipe.useCoarse; },
        get cycle() { return cycle; },
        run(ms) {
          if (stopped) return true;
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (pipe.run(Math.max(10, ms - (Date.now() - t0)))) { endCycle(); startCycle(); }
          }
          return false;
        },
        // stop and keep the best map (finishing the current cycle quickly if there is none yet)
        stop() {
          if (!best) {
            let guard = 0;
            while (pipe.phase !== "done" && guard++ < 50) { pipe.finishNow(); pipe.run(200); }
            endCycle();
          }
          stopped = true;
        },
        finishNow() { this.stop(); },
        takeImproved() { const b = improved ? best : null; improved = false; return b; },
        get best() { return best; },
        assignment() { return stopped ? best.assign : pipe.assignment(); },
        report(full) {
          if (stopped) return Object.assign({}, best.report, { endless: { cycle, bestCycle: best.cycle, stopped: true } });
          const r = pipe.report(full);
          r.stage = pipe.stage; r.useCoarse = pipe.useCoarse;
          r.endless = { cycle, bestCycle: best ? best.cycle : 0 };
          return r;
        },
      };
    }

    return { makeRng, buildGraph, aggregate, createEngine, createPipeline, createEndless, prepareGraph, expandAssign };
  }

  // Web Worker entry point. Stringified and run from a Blob URL, so it works from file:// too.
  function workerMain(self, factory) {
    const lib = factory();
    let pipe = null, running = false, timer = null;
    function post(type) {
      const done = pipe.phase === "done";
      const rep = pipe.report(done);
      const a = Int32Array.from(pipe.assignment());
      const msg = { type, report: rep, assign: a }, transfer = [a.buffer];
      const b = pipe.takeImproved ? pipe.takeImproved() : null;
      if (b) { msg.best = { report: b.report, assign: Int32Array.from(b.assign), cycle: b.cycle }; transfer.push(msg.best.assign.buffer); }
      self.postMessage(msg, transfer);
    }
    function loop() {
      timer = null;
      if (!running || !pipe) return;
      let done = false;
      try { done = pipe.run(150); } catch (err) { running = false; self.postMessage({ type: "error", message: String(err && err.message || err) }); return; }
      post(done ? "done" : "progress");
      if (done) { running = false; return; }
      timer = setTimeout(loop, 0);
    }
    self.onmessage = function (ev) {
      const msg = ev.data;
      try {
        if (msg.cmd === "init") {
          running = false;
          const g = lib.buildGraph(msg.graph);
          pipe = msg.opts.endless ? lib.createEndless(g, msg.graph.group, msg.opts) : lib.createPipeline(g, msg.graph.group, msg.opts);
          pipe.init();
          post("ready");
        } else if (msg.cmd === "run") {
          running = true; if (!timer) timer = setTimeout(loop, 0);
        } else if (msg.cmd === "pause") {
          running = false;
          if (pipe) post("paused");
        } else if (msg.cmd === "finish") {
          if (pipe) { pipe.finishNow(); running = pipe.phase !== "done"; post(pipe.phase === "done" ? "done" : "progress"); if (running && !timer) timer = setTimeout(loop, 0); }
        }
      } catch (err) {
        running = false;
        self.postMessage({ type: "error", message: String(err && err.message || err) });
      }
    };
  }

  const api = factory();
  api.workerSource = "(" + workerMain.toString() + ")(self, " + factory.toString() + ");";
  root.RedistrictEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
