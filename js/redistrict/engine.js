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
      // mass: which land mass (connected over land borders) each unit is on, if known
      const mass = d.mass ? Int32Array.from(d.mass) : null;
      return { n, E, eu, ev, elen, econn, start, nbr, nlen, nconn, border, pop, dem, rep, area, county, nc, mass, countyLinks: d.countyLinks || null };
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
      const county = new Int32Array(m), bestPop = new Float64Array(m).fill(-1), gmass = g.mass ? new Int32Array(m) : null;
      for (let u = 0; u < n; u++) {
        const a = groupOf[u];
        pop[a] += g.pop[u]; dem[a] += g.dem[u]; rep[a] += g.rep[u]; area[a] += g.area[u];
        let inner = g.border[u];
        for (let j = g.start[u]; j < g.start[u + 1]; j++) inner -= g.nlen[j];
        ext[a] += inner;
        if (g.pop[u] > bestPop[a]) { bestPop[a] = g.pop[u]; county[a] = g.county[u]; }
        if (gmass) gmass[a] = g.mass[u];
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
      return { graph: buildGraph({ n: m, pop, dem, rep, area, ext, county, eu, ev, elen, econn, mass: gmass }), groupOf };
    }

    // a land border beats a water link, which beats a shape-only border
    function mergeConn(a, b) { return a === 1 || b === 1 ? 1 : a === 2 || b === 2 ? 2 : 0; }
    const FOUR_PI = 4 * Math.PI;
    // 2024 US popular vote, two-party (certified): Harris 75,017,613, Trump 77,302,580
    const US2024 = { dem: 75017613, rep: 77302580 };
    const US2024_SHARE = US2024.dem / (US2024.dem + US2024.rep);
    const SEARCH_CAP = 1000; // max units explored when checking a flip keeps a district connected

    // ---------- engine ----------
    function createEngine(g, opts) {
      const { n, E, eu, ev, econn, start, nbr, nlen, nconn, border, pop, dem, rep, area, county, mass } = g;
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
        polishRecom: 0.03, polishT0: 0.2, polishT1: 0.001, popW0: 30, popW1: 10000, polishFair: 1,
        balanceRecom: 0.3, balanceT0: 0.05, balanceT1: 0.001,
      }, opts.tune || {});
      // county bookkeeping costs nc*k memory; skip it when that's huge
      const countyOn = g.nc * k <= 3e7;
      // Strict land rule: on each land mass, a district must be one piece connected
      // over land. Water links may only join pieces on different land masses.
      let nMass = 0;
      if (mass) for (let u = 0; u < n; u++) if (mass[u] + 1 > nMass) nMass = mass[u] + 1;
      const massOn = nMass > 1 && nMass * k <= 3e7;
      const dm = massOn ? new Int32Array(nMass * k) : null; // units of land mass m in district d
      const nc = countyOn ? g.nc : 1;

      let totalPop = 0, totalDem = 0, totalRep = 0;
      for (let u = 0; u < n; u++) { totalPop += pop[u]; totalDem += dem[u]; totalRep += rep[u]; }
      const ideal = totalPop / k;
      const stateShare = totalDem / (totalDem + totalRep);
      // Exact population (opts.exactPop): every district within 1 person of the ideal,
      // worked out here from this graph's own total. The ideal is rarely a whole number,
      // so in practice each district gets the ideal rounded down or up. Stages that only
      // aim for a rough balance (strictPop false: precincts, whole counties) keep the
      // tolerance they were given; the block stages enforce the exact target.
      const exactPop = !!opts.exactPop && opts.strictPop !== false;
      // fine whenever the deviation shows as -1, 0 or +1 person (rounded): under 1.5 people
      const userTol = exactPop ? (1.5 - 2e-6) / ideal : opts.tol == null ? 0.005 : opts.tol;
      let tol = userTol, lo = 0, hi = 0;
      function setTol(t) { tol = t; lo = ideal * (1 - t); hi = ideal * (1 + t); }
      setTol(userTol);
      // the tolerance the later phases enforce (the target, unless balancing was skipped)
      let baseTol = userTol;
      // With an exact target the goal search would freeze: redrawing two districts at
      // once (ReCom) needs both halves to hit the target to the person. So the search
      // works within +/-0.1%, and smoothing and final balancing (which don't stop until
      // every district is within the target) bring it back to exact.
      const SEARCH_TOL_EXACT = 0.001;
      // strictPop (default): never finish with a district outside the tolerance.
      // Balancing restarts instead of giving up; if a locked result (seats, curve)
      // leaves no way to balance, that lock is loosened step by step, then dropped.
      // Only "skip phase" / stop (forceSkip) can end it early. The precinct stage of
      // a pipeline turns it off: whole precincts often can't get that close, and the
      // block stage finishes the job.
      const strictPop = opts.strictPop !== false;
      let forceSkip = false, stuckRounds = 0, lockDropped = false;
      // Required county mode: countyLock caps the county pieces (splits) at splitCap,
      // so no move may split another county; countyTree first evens out population
      // splitting as few counties as it can (see treeStep).
      const countyLockOn = !!opts.countyLock, countyTreeOn = !!opts.countyTree;
      let splitCap = Infinity, extraSplits = 0;

      // partisan requirements: top `needD` districts must be >= 50%+h for Dems,
      // bottom `needR` must be <= 50%-h. Max modes raise the requirement step by step.
      let needD = 0, needR = 0;
      if (mode === "target") { needD = Math.max(0, Math.min(k, opts.targetD | 0)); needR = k - needD; }
      if (mode === "proportional") { needD = Math.round(k * stateShare); needR = k - needD; }
      // Proportional maps: the goal is the seats-votes curve itself. The search bends
      // it toward the 1-for-1 line (no seat count is forced), so under a uniform swing each
      // extra point of vote share gives a party about one more point of seats. That
      // needs the sorted district shares spread evenly, 1/k apart, centered on the
      // statewide share: district i (weakest D first) should sit at
      //   stateShare - 1/2 + (i + 1/2) / k.
      // fairness = average (weighted) distance from those spots, in points. Later phases may
      // not let it grow by more than FAIR_SLACK.
      const isProp = mode === "proportional";
      const FAIR_SLACK = 0.25;
      let fairOn = false, curFair = 0, fairBest = Infinity, fairBestAssign = null;

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
      // Three ways to score the curve (opts.curve). x is the uniform swing from the
      // 2024 result (statewide share = stateShare + x):
      //  "weighted" (default): centered on the 2024 vote; swings within 10 points
      //    count fully, 10-25 points half (beyond that, only the small spot term, at
      //    a fifth). Small swings are the likely ones, and the far ends of the line
      //    ask for districts most states can't draw.
      //  "whole": every vote share from 0% to 100% counts the same.
      //  "range": every statewide margin within 20 points of a center counts the
      //    same (opts.curveHalf, in share: default 0.10, i.e. +/- 20 margin points).
      //    The center is the 2024 result shifted to a tied national vote
      //    (opts.curveShift, default from the 2024 US popular vote: R+1.5 in margin,
      //    so +0.75 points of share; a D+10 state is centered on D+11.5).
      const curveMode = opts.curve === "whole" || opts.curve === "range" ? opts.curve : "weighted";
      let xLo, xHi, XIN;
      if (curveMode === "whole") { xLo = -stateShare; xHi = 1 - stateShare; XIN = 2; }
      else if (curveMode === "range") {
        const c0 = opts.curveShift == null ? 0.5 - US2024_SHARE : opts.curveShift, half = opts.curveHalf == null ? 0.1 : opts.curveHalf;
        xLo = Math.max(-stateShare, c0 - half); xHi = Math.min(1 - stateShare, c0 + half); XIN = 2;
      } else { xLo = Math.max(-0.25, -stateShare); xHi = Math.min(0.25, 1 - stateShare); XIN = 0.1; }
      // the spot term, in the same units: y = share - 0.5 (a district flips at swing -y)
      function swingW(y) {
        if (curveMode === "whole") return y;
        if (curveMode === "range") return Math.min(-xLo, Math.max(-xHi, y)); // spots past the range just need to be past it
        const a = Math.abs(y), w = a <= 0.1 ? a : a <= 0.25 ? 0.1 + 0.5 * (a - 0.1) : 0.175 + 0.2 * (a - 0.25);
        return y < 0 ? -w : w;
      }
      const curveTarget = new Float64Array(k);
      for (let i = 0; i < k; i++) curveTarget[i] = swingW(Math.min(1, Math.max(0, stateShare - 0.5 + (i + 0.5) / k)) - 0.5);
      // The score is mostly the gap you see on the seats-votes chart: the area between
      // the map's seat curve (uniform swing) and the 1-for-1 line over that range
      // (weighted as above), as an average share of seats, in points. A small part is
      // the distance of each district from its spot, which also steers districts
      // whose flip point is outside the range.
      const wOf = (a, b) => { // integral of the swing weight over [a, b]
        const inA = Math.max(a, -XIN), inB = Math.min(b, XIN);
        const inner = inB > inA ? inB - inA : 0;
        return inner + 0.5 * (b - a - inner);
      };
      const wTot = Math.max(1e-9, wOf(xLo, xHi));
      // weighted integral of |c - k (stateShare + x)| over [a, b]
      function gapPiece(c, a, b) {
        if (b <= a) return 0;
        const cuts = [a];
        for (const t of [-XIN, XIN, c / k - stateShare]) if (t > a && t < b) cuts.push(t);
        cuts.push(b); cuts.sort((p, q) => p - q);
        let sum = 0;
        for (let i = 0; i + 1 < cuts.length; i++) {
          const x1 = cuts[i], x2 = cuts[i + 1], mid = (x1 + x2) / 2;
          const w = Math.abs(mid) <= XIN ? 1 : 0.5;
          sum += w * Math.abs(c - k * (stateShare + mid)) * (x2 - x1); // linear and one sign on the piece
        }
        return sum;
      }
      function fairness() {
        sortBuf.set(shares); sortBuf.sort();
        let e = 0;
        for (let i = 0; i < k; i++) e += Math.abs(swingW(sortBuf[i] - 0.5) - curveTarget[i]);
        // seats at the left edge, then step up at each district's flip point
        let c = 0;
        for (let i = 0; i < k; i++) if (sortBuf[i] > 0.5 - xLo) c++;
        let x = xLo, area = 0;
        for (let j = k - 1; j >= 0; j--) {
          const b = 0.5 - sortBuf[j];
          if (b <= xLo) continue;
          if (b >= xHi) break;
          area += gapPiece(c, x, b); c++; x = b;
        }
        area += gapPiece(c, x, xHi);
        return 100 * area / (k * wTot) + 0.1 * (100 * e / k);
      }
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
      // Minimum compactness (opts.minPP, Polsby-Popper 0..1): every district below it
      // adds its shortfall (in points) to the score, so the compactness phases push
      // those districts up first. 0 = any shape (no compactness phase at all).
      const minPP = opts.minPP == null ? 0 : opts.minPP;
      const dFloor = new Float64Array(k);
      let floorSum = 0;
      function floorOf(inv) { const pp = inv > 0 ? 1 / inv : 0; return pp < minPP ? (minPP - pp) * 100 : 0; }
      function floorAdj(d) { floorSum -= dFloor[d]; dFloor[d] = floorOf(dInv[d]); floorSum += dFloor[d]; }
      function refresh(d) {
        compSum -= dInv[d]; dInv[d] = invPP(dArea[d], dPerim[d]); compSum += dInv[d];
        if (minPP > 0) floorAdj(d);
        penSum -= dPen[d]; dPen[d] = popPen(dPop[d]); penSum += dPen[d];
        addCls(dCls[d], -1); shares[d] = share(d); dCls[d] = cls(shares[d]); addCls(dCls[d], 1);
        if (nTier) { addTier(dTier[d], -1); dTier[d] = tierBits(shares[d]); addTier(dTier[d], 1); }
      }
      function recomputePen() { penSum = 0; for (let d = 0; d < k; d++) { dPen[d] = popPen(dPop[d]); penSum += dPen[d]; } }
      // every district within the population tolerance?
      function popOk() { const lim = tol * ideal + 1e-6; for (let d = 0; d < k; d++) if (Math.abs(dPop[d] - ideal) > lim) return false; return true; }
      // resync running sums (they drift slightly over millions of updates)
      function resync() { compSum = 0; floorSum = 0; for (let d = 0; d < k; d++) { compSum += dInv[d]; floorSum += dFloor[d]; } recomputePen(); curE = energy(); }

      function recomputeAll() {
        dPop.fill(0); dDem.fill(0); dRep.fill(0); dArea.fill(0); dPerim.fill(0); dCnt.fill(0); cd.fill(0); cPresent.fill(0);
        if (massOn) { dm.fill(0); for (let u = 0; u < n; u++) dm[mass[u] * k + assign[u]]++; }
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
        floorSum = 0;
        for (let d = 0; d < k; d++) {
          dInv[d] = invPP(dArea[d], dPerim[d]); compSum += dInv[d];
          dFloor[d] = minPP > 0 ? floorOf(dInv[d]) : 0; floorSum += dFloor[d];
          dPen[d] = popPen(dPop[d]); penSum += dPen[d];
          shares[d] = share(d); dCls[d] = cls(shares[d]); addCls(dCls[d], 1);
          if (nTier) { dTier[d] = tierBits(shares[d]); addTier(dTier[d], 1); }
        }
        if (fairOn) curFair = fairness();
        partE = partisanE();
      }

      function partisanE() {
        if (mode === "neutral" || wPart === 0) return 0;
        if (fairOn) return curFair;
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
      const compact = opts.compact !== false && (opts.minPP == null || opts.minPP > 0);
      const phases = (opts.phases || (mode === "neutral" ? ["polish", "final"] : ["search", "polish", "final"]))
        .filter((p) => compact || p !== "polish");
      let phaseIdx = -1;

      function lockOk() {
        if (countyLockOn && splits > splitCap) return false;
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
        return cntSafeD >= lock.safeD && cntSafeR >= lock.safeR && (lock.fair == null || curFair <= lock.fair);
      }
      // a district below the minimum counts 3x per point of shortfall, on top of the usual shape cost
      function energy() { return wPart * partE + wComp * (compSum + 3 * floorSum) + wCty * splits + penSum; }

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
      // Each district keeps its biggest piece; stray pieces join the neighbor they share
      // the most border with. Two passes, repeated until clean: first over land only
      // (one piece per district on each land mass), then over land + water links
      // (the district as a whole is connected).
      function repairContiguity() {
        const comp = new Int32Array(n);
        let moved = 0;
        function pass(landOnly) {
          comp.fill(-1);
          const compPop = [], compDist = [], compKey = [];
          for (let s0 = 0; s0 < n; s0++) {
            if (comp[s0] >= 0) continue;
            const c = compPop.length, d = assign[s0];
            let qh = 0, qt = 0, p = 0;
            queue[qt++] = s0; comp[s0] = c;
            while (qh < qt) {
              const x = queue[qh++]; p += pop[x] + 1e-6;
              for (let j = start[x]; j < start[x + 1]; j++) {
                const y = nbr[j];
                if (nconn[j] && (!landOnly || nconn[j] === 1) && comp[y] < 0 && assign[y] === d) { comp[y] = c; queue[qt++] = y; }
              }
            }
            compPop.push(p); compDist.push(d); compKey.push(landOnly ? d * nMass + mass[s0] : d);
          }
          const main = new Map();
          for (let c = 0; c < compPop.length; c++) {
            const m0 = main.get(compKey[c]);
            if (m0 === undefined || compPop[c] > compPop[m0]) main.set(compKey[c], c);
          }
          if (main.size === compPop.length) return 0;
          const bestD = new Int32Array(compPop.length).fill(-1), bestL = new Float64Array(compPop.length).fill(-1);
          const acc = new Map();
          for (let u = 0; u < n; u++) {
            const c = comp[u];
            if (main.get(compKey[c]) === c) continue;
            for (let j = start[u]; j < start[u + 1]; j++) {
              const y = nbr[j], dy = assign[y];
              if (!nconn[j] || (landOnly && nconn[j] !== 1) || dy === compDist[c]) continue;
              const key = c * k + dy;
              const L = (acc.get(key) || 0) + nlen[j] + 1e-3;
              acc.set(key, L);
              if (L > bestL[c]) { bestL[c] = L; bestD[c] = dy; }
            }
          }
          let mv = 0;
          for (let u = 0; u < n; u++) {
            const c = comp[u];
            if (main.get(compKey[c]) !== c && bestD[c] >= 0) { assign[u] = bestD[c]; mv++; }
          }
          return mv;
        }
        for (let iter = 0; iter < 50; iter++) {
          const a = mass ? pass(true) : 0;
          const b = pass(false);
          moved += a + b;
          if (a === 0 && b === 0) break;
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
        if (massOn && !halvesKeepLandPieces(m)) { cleanup(m); return false; }
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
        if (massOn) { dm[mass[x] * k + from]--; dm[mass[x] * k + to]++; }
        if (!countyOn) return;
        const c = county[x];
        if (--cd[c * k + from] === 0) cPresent[c]--;
        if (cd[c * k + to]++ === 0) cPresent[c]++;
      }
      function cleanup(m) { for (let i = 0; i < m; i++) loc[nodes[i]] = -1; }
      // After a ReCom split (side[] over nodes[0..m)): on each land mass, each half
      // must be a single piece over land. The tree may have used a water link.
      function halvesKeepLandPieces(m) {
        stampId++;
        const seen = new Set();
        for (let i = 0; i < m; i++) {
          const x0 = nodes[i];
          if (stamp[x0] === stampId) continue;
          const key = side[i] * nMass + mass[x0];
          if (seen.has(key)) return false;
          seen.add(key);
          let qh = 0, qt = 0;
          queue[qt++] = i; stamp[x0] = stampId;
          while (qh < qt) {
            const li = queue[qh++], x = nodes[li];
            for (let j = start[x]; j < start[x + 1]; j++) {
              if (nconn[j] !== 1) continue;
              const l2 = loc[nbr[j]];
              if (l2 < 0 || side[l2] !== side[li] || stamp[nbr[j]] === stampId) continue;
              stamp[nbr[j]] = stampId; queue[qt++] = l2;
            }
          }
        }
        return true;
      }
      function setStats(d, p, de, r, a, per, c) { dPop[d] = p; dDem[d] = de; dRep[d] = r; dArea[d] = a; dPerim[d] = per; dCnt[d] = c; }
      function moveCounty(x, from, to) {
        if (massOn) { dm[mass[x] * k + from]--; dm[mass[x] * k + to]++; }
        if (!countyOn) return;
        const c = county[x];
        if (--cd[c * k + from] === 0) { cPresent[c]--; if (cPresent[c] >= 1) splits--; }
        if (cd[c * k + to]++ === 0) { cPresent[c]++; if (cPresent[c] > 1) splits++; }
      }
      function save(A, B) {
        return [dPop[A], dDem[A], dRep[A], dArea[A], dPerim[A], dCnt[A], dPop[B], dDem[B], dRep[B], dArea[B], dPerim[B], dCnt[B],
          dInv[A], dPen[A], dCls[A], shares[A], dInv[B], dPen[B], dCls[B], shares[B], compSum, penSum, splits, partE,
          cntSafeD, cntSafeR, cntComp, cntWinD, dTier[A], dTier[B], curFair].concat(Array.from(cntTier));
      }
      function restoreSaved(A, B, s) {
        dPop[A] = s[0]; dDem[A] = s[1]; dRep[A] = s[2]; dArea[A] = s[3]; dPerim[A] = s[4]; dCnt[A] = s[5];
        dPop[B] = s[6]; dDem[B] = s[7]; dRep[B] = s[8]; dArea[B] = s[9]; dPerim[B] = s[10]; dCnt[B] = s[11];
        dInv[A] = s[12]; dPen[A] = s[13]; dCls[A] = s[14]; shares[A] = s[15];
        dInv[B] = s[16]; dPen[B] = s[17]; dCls[B] = s[18]; shares[B] = s[19];
        if (minPP > 0) { floorAdj(A); floorAdj(B); }
        compSum = s[20]; penSum = s[21]; splits = s[22]; partE = s[23];
        cntSafeD = s[24]; cntSafeR = s[25]; cntComp = s[26]; cntWinD = s[27];
        dTier[A] = s[28]; dTier[B] = s[29]; curFair = s[30];
        for (let j = 0; j < nTier; j++) cntTier[j] = s[31 + j];
      }
      // stats of A and B already updated; decide, and roll back if rejected
      function tryAccept(A, B, saved) {
        refresh(A); refresh(B);
        if (fairOn) curFair = fairness();
        if (wPart > 0) partE = partisanE();
        const newE = energy();
        if (lockOk() && (phase !== "smooth" || pairInTol(A, B)) && accept(newE - curE)) { curE = newE; return true; }
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
        if (massOn) {
          // on u's land mass, u must join B's land there (if B has any), and A's land
          // there must stay one piece without u
          if (dm[mass[u] * k + B] > 0 && !touchesByLand(u, B)) return false;
          if (!stillConnectedWithout(u, A, true)) return false;
        }
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
      // ----- county-aware balancing (required county mode) -----
      // Link the districts in a spanning tree (preferring pairs that already share a
      // split county), then, from the leaves up, move each district's surplus or
      // shortfall across its tree link: first inside a county the two already share,
      // then by moving whole counties, and only if that's not enough by splitting
      // one county. That is at most one new split per link.
      let treeDone = false, tree = null, cStart = null, cUnits = null, cTot = null;
      const treeLog = opts.debugTree ? [] : null;
      function countyIndex() {
        cStart = new Int32Array(nc + 1); cTot = new Float64Array(nc);
        for (let u = 0; u < n; u++) { cStart[county[u] + 1]++; cTot[county[u]] += pop[u]; }
        for (let c = 0; c < nc; c++) cStart[c + 1] += cStart[c];
        cUnits = new Int32Array(n);
        const fill = cStart.slice(0, nc);
        for (let u = 0; u < n; u++) cUnits[fill[county[u]]++] = u;
      }
      function treeSetup() {
        countyIndex();
        const pairs = new Map();
        for (let e = 0; e < E; e++) {
          if (econn[e] !== 1) continue; // districts that only meet across water can't trade over land
          const a = assign[eu[e]], b = assign[ev[e]];
          if (a === b) continue;
          const key = a < b ? a * k + b : b * k + a;
          if (pairs.has(key)) continue;
          let shared = false;
          for (let c = 0; c < nc && !shared; c++) if (cd[c * k + a] > 0 && cd[c * k + b] > 0) shared = true;
          pairs.set(key, (shared ? 0 : 1) + 0.5 * rand());
        }
        const edges = [...pairs].sort((x, y) => x[1] - y[1]);
        const par = new Int32Array(k); for (let d = 0; d < k; d++) par[d] = d;
        const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
        const tadj = Array.from({ length: k }, () => []);
        for (const [key] of edges) {
          const a = Math.floor(key / k), b = key % k, ra = f(a), rb = f(b);
          if (ra !== rb) { par[ra] = rb; tadj[a].push(b); tadj[b].push(a); }
        }
        // children before parents
        const order = [], seen = new Uint8Array(k);
        for (let r = 0; r < k; r++) {
          if (seen[r]) continue;
          const st = [[r, -1, 0]]; seen[r] = 1;
          while (st.length) {
            const top = st[st.length - 1];
            if (top[2] < tadj[top[0]].length) {
              const y = tadj[top[0]][top[2]++];
              if (!seen[y]) { seen[y] = 1; st.push([y, top[0], 0]); }
            } else { st.pop(); if (top[1] >= 0) order.push([top[0], top[1]]); }
          }
        }
        tree = { order, i: 0, task: null, pass: tree ? tree.pass + 1 : 1, startDev: worstDev() };
      }
      // counties along the G-R border, with the side they sit on
      function borderCounties(G, R, bad, bad2) {
        const out = new Set();
        for (let e = 0; e < E; e++) {
          if (econn[e] !== 1) continue;
          const a = assign[eu[e]], b = assign[ev[e]];
          if (a === G && b === R) out.add(county[eu[e]]);
          else if (a === R && b === G) out.add(county[ev[e]]);
        }
        for (const c of bad) out.delete(c);
        if (bad2) for (const c of bad2) out.delete(c);
        return [...out];
      }
      function pickCounty(t, remaining, slack) {
        const cs = borderCounties(t.G, t.R, t.bad);
        const csWhole = cs.filter((c) => !t.badWhole.has(c));
        // 1. a county the two districts already share: no new split
        let best = -1;
        for (const c of cs) if (cd[c * k + t.R] > 0 && (best < 0 || cd[c * k + t.G] > cd[best * k + t.G])) best = c;
        if (best >= 0) { t.whole = false; return best; }
        // 2. a whole county of the giver that fits: moving it splits nothing
        for (const c of csWhole) if (cPresent[c] === 1 && cTot[c] <= remaining + slack && (best < 0 || cTot[c] > cTot[best])) best = c;
        if (best >= 0) { t.whole = true; return best; }
        // 3. a county the giver already shares with another district (no new county split)
        for (const c of cs) if (cPresent[c] > 1) { t.whole = false; return c; }
        // 4. split one county: the smallest that covers what's needed
        for (const c of cs) if (best < 0 || (cTot[c] >= remaining ? (cTot[best] < remaining || cTot[c] < cTot[best]) : cTot[c] > cTot[best])) best = c;
        t.whole = false;
        return best;
      }
      // (its own queue: moveUnit's connectivity checks reuse the shared scratch arrays)
      function moveWholeCounty(c, G, R) {
        const moved = [], q = [], inQ = new Set();
        for (let i = cStart[c]; i < cStart[c + 1]; i++) {
          const u = cUnits[i];
          if (assign[u] !== G) return false;
          for (let j = start[u]; j < start[u + 1]; j++) if (nconn[j] && assign[nbr[j]] === R) { inQ.add(u); q.push(u); break; }
        }
        // units that can't go yet (they'd cut the giver) are retried once others have moved
        let progress = true;
        while (progress) {
          progress = false;
          for (let qi = 0; qi < q.length; qi++) {
            const u = q[qi];
            if (assign[u] !== G) continue;
            if (!moveUnit(u, R)) continue;
            moved.push(u); progress = true;
            for (let j = start[u]; j < start[u + 1]; j++) {
              const y = nbr[j];
              if (nconn[j] && county[y] === c && assign[y] === G && !inQ.has(y)) { inQ.add(y); q.push(y); }
            }
          }
        }
        if (moved.length === cStart[c + 1] - cStart[c]) return true;
        if (treeLog) treeLog.push({ whole: c, units: cStart[c + 1] - cStart[c], reached: q.length, moved: moved.length, why: moveFail });
        // couldn't move it all in one piece: put it back
        for (let i = moved.length - 1; i >= 0; i--) moveUnit(moved[i], G);
        return false;
      }
      // Move u from G to R together with any small pieces of G that hang on G only
      // through u (moving u alone would strand them). Both districts are checked
      // afterwards and the move is undone if either is no longer properly connected.
      function forceMove(u, B) {
        const A = assign[u];
        let inA = 0, inB = 0;
        for (let j = start[u]; j < start[u + 1]; j++) { const a = assign[nbr[j]]; if (a === A) inA += nlen[j]; else if (a === B) inB += nlen[j]; }
        setStats(A, dPop[A] - pop[u], dDem[A] - dem[u], dRep[A] - rep[u], dArea[A] - area[u], dPerim[A] - border[u] + 2 * inA, dCnt[A] - 1);
        setStats(B, dPop[B] + pop[u], dDem[B] + dem[u], dRep[B] + rep[u], dArea[B] + area[u], dPerim[B] + border[u] - 2 * inB, dCnt[B] + 1);
        moveCounty(u, A, B); assign[u] = B;
        refresh(A); refresh(B);
      }
      function districtOk(d) {
        let s0 = -1;
        for (let u = 0; u < n && s0 < 0; u++) if (assign[u] === d) s0 = u;
        if (s0 < 0) return false;
        const seen = new Uint8Array(n), q = [s0]; seen[s0] = 1;
        let cnt = 0;
        while (q.length) { const x = q.pop(); cnt++; for (let j = start[x]; j < start[x + 1]; j++) { const y = nbr[j]; if (nconn[j] && !seen[y] && assign[y] === d) { seen[y] = 1; q.push(y); } } }
        if (cnt !== dCnt[d]) return false;
        if (!massOn) return true;
        // on each land mass, one piece over land
        const seenL = new Uint8Array(n), massSeen = new Set();
        for (let u = 0; u < n; u++) {
          if (assign[u] !== d || seenL[u]) continue;
          if (massSeen.has(mass[u])) return false;
          massSeen.add(mass[u]);
          const ql = [u]; seenL[u] = 1;
          while (ql.length) { const x = ql.pop(); for (let j = start[x]; j < start[x + 1]; j++) { const y = nbr[j]; if (nconn[j] === 1 && !seenL[y] && assign[y] === d) { seenL[y] = 1; ql.push(y); } } }
        }
        return true;
      }
      function moveWithOrphans(u, G, R, maxUnits, maxPop) {
        if (assign[u] !== G || !onBorder(u, R)) return 0;
        const seen = new Set([u]), comps = [];
        for (let j = start[u]; j < start[u + 1]; j++) {
          const y = nbr[j];
          if (!nconn[j] || assign[y] !== G || seen.has(y)) continue;
          const comp = [y]; seen.add(y);
          for (let i = 0; i < comp.length && comp.length <= maxUnits; i++) {
            const x = comp[i];
            for (let jj = start[x]; jj < start[x + 1]; jj++) { const z = nbr[jj]; if (nconn[jj] && assign[z] === G && !seen.has(z)) { seen.add(z); comp.push(z); } }
          }
          comps.push(comp);
        }
        const bigOnes = comps.filter((c) => c.length > maxUnits);
        if (bigOnes.length !== 1) return 0;
        const orphans = [u];
        for (const c of comps) if (c.length <= maxUnits) for (const x of c) orphans.push(x);
        let p = 0;
        for (const x of orphans) p += pop[x];
        if (p > maxPop) return 0;
        for (const x of orphans) forceMove(x, R);
        if (districtOk(G) && districtOk(R)) return orphans.length;
        for (let i = orphans.length - 1; i >= 0; i--) forceMove(orphans[i], G);
        return 0;
      }
      // move one block of county t.county from the giver to the receiver: the
      // biggest that still fits, along the border between them
      function moveOneBlock(t, remaining, slack) {
        const c = t.county, G = t.G, R = t.R;
        if (!t.frontier) {
          t.frontier = new Set(); t.failed = new Set(); t.zero = 0;
          for (let i = cStart[c]; i < cStart[c + 1]; i++) { const u = cUnits[i]; if (assign[u] === G && onBorder(u, R)) t.frontier.add(u); }
        }
        const cands = [];
        for (const u of t.frontier) {
          if (assign[u] !== G) { t.frontier.delete(u); continue; }
          if (!t.failed.has(u) && pop[u] <= remaining + slack) cands.push(u);
        }
        // populated blocks first (biggest first), then empty ones (they open the way)
        cands.sort((a, b) => (pop[b] > 0) - (pop[a] > 0) || pop[b] - pop[a]);
        for (let i = 0; i < Math.min(60, cands.length); i++) {
          const u = cands[i];
          if (pop[u] === 0 && t.zero > 2000) return false;
          if (!moveUnit(u, R)) {
            // it would strand a few blocks behind it: take them along
            if (!(moveFail.startsWith("would cut") && moveWithOrphans(u, G, R, 2000, remaining + slack))) { t.failed.add(u); if (treeLog) t.why = (t.why || "") + moveFail[0]; continue; }
          }
          t.frontier.delete(u); t.failed.clear();
          t.zero = pop[u] > 0 ? 0 : t.zero + 1;
          for (let j = start[u]; j < start[u + 1]; j++) {
            const y = nbr[j];
            if (nconn[j] && county[y] === c && assign[y] === G) t.frontier.add(y);
          }
          return true;
        }
        return false;
      }
      // Required county mode, last step: a county split by only a small piece (up to
      // the population tolerance) is made whole again where the piece can join the
      // district holding the rest of it. Final balancing then evens out the people moved.
      let tidied = false;
      function tidySplits() {
        if (!cStart) countyIndex();
        const maxPiece = Math.max(tol * ideal, 200);
        let fixed = 0;
        searchCap = 60000;
        try {
          for (let c = 0; c < nc; c++) {
            if (cPresent[c] <= 1) continue;
            const pp = new Map();
            for (let i = cStart[c]; i < cStart[c + 1]; i++) { const u = cUnits[i]; pp.set(assign[u], (pp.get(assign[u]) || 0) + pop[u]); }
            const byPop = [...pp].sort((x, y) => y[1] - x[1]);
            const main = byPop[0][0];
            for (const [d, pd] of byPop.slice(1)) {
              if (pd > maxPiece) continue;
              const units = [];
              for (let i = cStart[c]; i < cStart[c + 1]; i++) if (assign[cUnits[i]] === d) units.push(cUnits[i]);
              const moved = [];
              let progress = true;
              while (progress) {
                progress = false;
                for (const u of units) if (assign[u] === d && moveUnit(u, main)) { moved.push(u); progress = true; }
              }
              if (moved.length === units.length) fixed++;
              else {
                if (treeLog) treeLog.push({ tidy: c, people: pd, units: units.length, moved: moved.length, why: moveFail, touchesMain: units.some((u) => onBorder(u, main)) });
                for (let i = moved.length - 1; i >= 0; i--) moveUnit(moved[i], d);
              }
            }
          }
        } finally { searchCap = SEARCH_CAP; }
        if (fixed) {
          tidied = true;
          splitCap = Math.min(splitCap, splits);
          notes.push("Made " + fixed + " count" + (fixed === 1 ? "y" : "ies") + " whole again that had only a small piece in another district.");
          recomputePen(); if (fairOn) curFair = fairness(); partE = partisanE(); curE = energy();
        }
      }
      // one step of the tree balancing; false when every link is done
      function treeStep() {
        searchCap = 60000;
        try { return treeStep1(); } finally { searchCap = SEARCH_CAP; }
      }
      function treeStep1() {
        if (!tree) treeSetup();
        const slack = tol * ideal * 0.5;
        for (let guard = 0; guard < 4 * k + 8; guard++) {
          if (!tree.task) {
            if (tree.i >= tree.order.length) {
              // not even yet: another pass with a fresh tree, while passes keep helping
              const w = worstDev();
              if (w <= tol || tree.pass >= 10 || w > tree.startDev * 0.98) return false;
              treeSetup();
              continue;
            }
            const [A, P] = tree.order[tree.i++];
            const f = dPop[A] - ideal;
            if (Math.abs(f) <= slack) continue;
            tree.task = { child: A, sign: f > 0 ? 1 : -1, G: f > 0 ? A : P, R: f > 0 ? P : A, county: -1, whole: false, frontier: null, bad: new Set(), badWhole: new Set() };
          }
          const t = tree.task;
          const remaining = t.sign * (dPop[t.child] - ideal);
          if (remaining <= slack) { tree.task = null; continue; }
          if (t.county < 0) {
            t.county = pickCounty(t, remaining, slack); t.frontier = null;
            if (treeLog) treeLog.push({ G: t.G, R: t.R, remaining: Math.round(remaining), county: t.county, whole: t.whole, shared: t.county >= 0 && cd[t.county * k + t.R] > 0, cPop: t.county >= 0 ? cTot[t.county] : 0 });
            if (t.county < 0) { tree.task = null; continue; } // nothing left to try here; normal balancing takes over
          }
          if (t.whole) { const ok = moveWholeCounty(t.county, t.G, t.R); if (treeLog) treeLog[treeLog.length - 1].result = ok ? "moved whole" : "whole failed"; if (!ok) t.badWhole.add(t.county); t.county = -1; return true; }
          if (!moveOneBlock(t, remaining, slack)) { if (treeLog) treeLog[treeLog.length - 1].result = "blocks stopped, " + Math.round(remaining) + " left, frontier " + (t.frontier ? t.frontier.size : 0) + " fails " + (t.why || "").slice(-80); t.why = ""; t.bad.add(t.county); t.county = -1; }
          return true;
        }
        return true;
      }

      // ----- swap move (fine population balancing) -----
      // Trade a unit from A to B and a unit from B back to A in one step, so the net
      // change can be a handful of people even where every border unit holds hundreds
      // (no single flip can get a district within a tight tolerance there).
      let moveFail = "";
      function moveUnit(u, B) {
        const A = assign[u];
        if (A === B || dCnt[A] <= 1) { moveFail = "same/last"; return null; }
        let touches = false;
        for (let j = start[u]; j < start[u + 1]; j++) if (nconn[j] && assign[nbr[j]] === B) { touches = true; break; }
        if (!touches) { moveFail = "not touching"; return null; }
        if (!stillConnectedWithout(u, A)) { moveFail = "would cut the giver"; return null; }
        if (massOn) {
          if (dm[mass[u] * k + B] > 0 && !touchesByLand(u, B)) { moveFail = "only a water link"; return null; }
          if (!stillConnectedWithout(u, A, true)) { moveFail = "would cut the giver on land"; return null; }
        }
        let inA = 0, inB = 0;
        for (let j = start[u]; j < start[u + 1]; j++) {
          const a = assign[nbr[j]];
          if (a === A) inA += nlen[j]; else if (a === B) inB += nlen[j];
        }
        const saved = save(A, B);
        setStats(A, dPop[A] - pop[u], dDem[A] - dem[u], dRep[A] - rep[u], dArea[A] - area[u], dPerim[A] - border[u] + 2 * inA, dCnt[A] - 1);
        setStats(B, dPop[B] + pop[u], dDem[B] + dem[u], dRep[B] + rep[u], dArea[B] + area[u], dPerim[B] + border[u] - 2 * inB, dCnt[B] + 1);
        moveCounty(u, A, B); assign[u] = B;
        refresh(A); refresh(B);
        return saved;
      }
      function unmoveUnit(u, A, B, saved) { assign[u] = A; moveCountyRaw(u, B, A); restoreSaved(A, B, saved); }
      // Walk the A-B border from a random cut edge (up to SWAP_WALK units), then try
      // the pairs (a in A, b in B) whose populations differ by closest to what would
      // even the two districts out.
      const SWAP_WALK = 400;
      const swapA = [], swapB = [], swapPairs = [];
      function onBorder(x, other) {
        for (let j = start[x]; j < start[x + 1]; j++) if (nconn[j] && assign[nbr[j]] === other) return true;
        return false;
      }
      function swapMove(smooth) {
        // aim at a district that is still outside the tolerance, when one turns up quickly
        let e = -1;
        const lim = tol * ideal + 1e-6;
        for (let t = 0; t < (smooth ? 1 : 40); t++) {
          const e2 = randomCutEdge();
          if (e2 < 0) break;
          if (e < 0) e = e2;
          if (Math.abs(dPop[assign[eu[e2]]] - ideal) > lim || Math.abs(dPop[assign[ev[e2]]] - ideal) > lim) { e = e2; break; }
        }
        if (e < 0) return false;
        const u = eu[e], v = ev[e];
        const A = assign[u], B = assign[v];
        const want = (dPop[A] - dPop[B]) / 2; // people to move from A to B
        if (!smooth && Math.abs(want) < 0.5) return false;
        swapA.length = 0; swapB.length = 0;
        stampId++;
        let qh = 0, qt = 0;
        queue[qt++] = u; queue[qt++] = v; stamp[u] = stamp[v] = stampId;
        while (qh < qt && qt < SWAP_WALK) {
          const x = queue[qh++];
          (assign[x] === A ? swapA : swapB).push(x);
          for (let j = start[x]; j < start[x + 1]; j++) {
            const y = nbr[j];
            if (!nconn[j] || stamp[y] === stampId) continue;
            const d = assign[y];
            if ((d === A && onBorder(y, B)) || (d === B && onBorder(y, A))) { stamp[y] = stampId; queue[qt++] = y; }
          }
        }
        for (; qh < qt; qh++) (assign[queue[qh]] === A ? swapA : swapB).push(queue[qh]);
        if (!swapA.length || !swapB.length) return false;
        // best partner in B for each a (B sorted by population), keep the pairs that help
        swapB.sort((x, y) => pop[x] - pop[y]);
        swapPairs.length = 0;
        if (smooth) {
          // pairs that keep both districts within the tolerance, the most protruding first
          const outA = new Map(), outB = new Map();
          for (const a of swapA) outA.set(a, sticksOut(a, A, B));
          for (const b of swapB) outB.set(b, sticksOut(b, B, A));
          for (const a of swapA) {
            if (outA.get(a) <= 0) continue;
            // pop[b] range that keeps both districts within the tolerance
            const lo2 = Math.max(pop[a] + ideal - lim - dPop[A], pop[a] - (ideal + lim - dPop[B]));
            const hi2 = Math.min(pop[a] + ideal + lim - dPop[A], pop[a] - (ideal - lim - dPop[B]));
            if (lo2 > hi2) continue;
            let l = 0, h = swapB.length;
            while (l < h) { const mid = (l + h) >> 1; if (pop[swapB[mid]] < lo2) l = mid + 1; else h = mid; }
            for (let i = l, seen = 0; i < swapB.length && pop[swapB[i]] <= hi2 && seen < 30; i++, seen++) {
              const b = swapB[i];
              if (outB.get(b) > 0) swapPairs.push([-(outA.get(a) + outB.get(b)), a, b]);
            }
          }
        } else {
        const limit = Math.abs(want) - 1e-9;
        for (const a of swapA) {
          const target = pop[a] - want;
          let lo2 = 0, hi2 = swapB.length - 1;
          while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (pop[swapB[mid]] < target) lo2 = mid + 1; else hi2 = mid; }
          for (const i of [lo2 - 1, lo2]) {
            if (i < 0 || i >= swapB.length) continue;
            const b = swapB[i], er = Math.abs(pop[a] - pop[b] - want);
            if (er < limit) swapPairs.push([er, a, b]);
          }
        }
        }
        if (!swapPairs.length) return false;
        swapPairs.sort((p1, p2) => p1[0] - p2[0]);
        for (let t = 0; t < Math.min(6, swapPairs.length); t++) {
          const a = swapPairs[t][1], b = swapPairs[t][2];
          const s1 = moveUnit(a, B);
          if (!s1) continue;
          const s2 = moveUnit(b, A);
          if (!s2) { unmoveUnit(a, A, B, s1); continue; }
          proposals++;
          if (fairOn) curFair = fairness();
          if (wPart > 0) partE = partisanE();
          const newE = energy();
          if (lockOk() && (!smooth || pairInTol(A, B)) && (newE <= curE || rand() < Math.exp(-(newE - curE) / T))) { accepted++; curE = newE; return true; }
          unmoveUnit(b, B, A, s2); unmoveUnit(a, A, B, s1);
          return false;
        }
        return false;
      }
      function touchesByLand(u, B) {
        for (let j = start[u]; j < start[u + 1]; j++) if (nconn[j] === 1 && assign[nbr[j]] === B) return true;
        return false;
      }
      // Does district A stay connected if u leaves it? landOnly: over land borders only
      // (used for A's piece on u's land mass).
      function stillConnectedWithout(u, A, landOnly) {
        const need = landOnly ? 1 : 0;
        let targets = 0, first = -1;
        stampId++;
        for (let j = start[u]; j < start[u + 1]; j++) {
          const y = nbr[j];
          if (nconn[j] && (!need || nconn[j] === 1) && assign[y] === A && stamp[y] !== stampId) { stamp[y] = stampId; targets++; if (first < 0) first = y; }
        }
        if (landOnly && targets === 0) return true;
        if (targets <= 1) return targets === 1;
        const tgt = stampId; stampId++;
        let qh = 0, qt = 0, found = 1;
        queue[qt++] = first; stamp[first] = stampId; stamp[u] = stampId;
        while (qh < qt) {
          const x = queue[qh++];
          for (let j = start[x]; j < start[x + 1]; j++) {
            const y = nbr[j];
            if (!nconn[j] || (need && nconn[j] !== 1) || assign[y] !== A || stamp[y] === stampId) continue;
            if (stamp[y] === tgt) { found++; if (found === targets) return true; }
            stamp[y] = stampId; queue[qt++] = y;
          }
          // Give up (reject the move) if the pieces don't reconnect nearby. Always
          // safe: it can only turn down a rare valid move, never allow a split.
          if (qt > searchCap) return false;
        }
        return false;
      }
      // the county transfers below are few and deliberate, so they may look much further
      let searchCap = SEARCH_CAP;

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
          // county splits only as a light tie-breaker here: where districts follow county
          // lines, a full penalty would block every move that can fix population
          // Compactness only lightly (enough to stop aimless wandering, not enough to
          // block moves that fix population, which matters with big rural blocks)
          // exact target with a goal search still to come: balance only as far as the
          // search works (it loosens to +/-0.1% anyway); the later phases make it exact
          setTol(exactPop && phases.indexOf("search") > phaseIdx ? Math.max(baseTol, SEARCH_TOL_EXACT) : baseTol);
          wPart = 0; wComp = compact ? 0.1 : 0; wCty = wCounty * 0.05; T0 = tune.balanceT0; T1 = tune.balanceT1; recomProb = tune.balanceRecom;
          phaseBudget = Math.max(20000, searchBudget, 3 * n, 2000 * k);
        } else if (p === "search") {
          setTol(exactPop ? Math.max(baseTol, SEARCH_TOL_EXACT) : baseTol);
          wPart = 1; wComp = compact ? tune.searchComp : 0; wCty = wCounty * tune.searchComp; T0 = tune.searchT0; T1 = tune.searchT1;
          phaseBudget = searchBudget; recomProb = tune.searchRecom;
          lock = null;
          if (isMax) { tierIdx = 0; posIdx = -1; tierLock.fill(-1); posLock.fill(-Infinity); lock = { tiers: tierLock, pos: posLock }; }
        } else if (p === "polish") {
          setTol(baseTol);
          wPart = fairOn ? tune.polishFair : 0; wComp = 1; wCty = wCounty;
          T0 = tune.polishT0; T1 = tune.polishT1; phaseBudget = polishBudget; recomProb = tune.polishRecom;
          if ((!lock || (fairOn && lock.fair == null)) && mode !== "neutral") lock = currentLock();
        } else if (p === "final") {
          setTol(baseTol);
          if (countyLockOn && !countyTreeOn) tidySplits();
          wPart = fairOn ? tune.polishFair : 0; wComp = compact ? 1 : 0; wCty = wCounty;
          if ((!lock || (fairOn && lock.fair == null)) && mode !== "neutral") lock = currentLock();
          T0 = T1 = 1e-4; phaseBudget = Math.max(30000, 4 * n, 2000 * k); recomProb = 0;
        }
        recomputePen();
        partE = partisanE();
        curE = energy();
        T = T0;
        if (p === "search" && (mode === "maxD" || mode === "maxR")) startNextTarget(true);
        if (p === "search" && isProp) startFair();
        if (p === "polish") snapshotBest();
      }
      function nextPhase() {
        const keep = best;
        phaseIdx++;
        if (phaseIdx >= phases.length) { finishAll(); return; }
        const p = phases[phaseIdx];
        enterPhase(p);
        // (after a county tidy-up the earlier best map would undo it)
        if (p === "final" && !tidied) best = keep;
      }
      function finishAll() {
        if (phase === "polish" && best) restore(best.assign);
        phase = "done";
      }
      // Locks for the later phases. For gerrymanders, each district below the floor
      // keeps (almost) its level: up to 1 point of margin of slack, so the
      // census-block stage can still balance population and smooth borders.
      const LOCK_SLACK = 0.005;
      function currentLock() {
        if (isProp) return { safeD: 0, safeR: 0, comp: 0, fair: fairOn ? curFair + FAIR_SLACK : null };
        if (!isMax) return { safeD: cntSafeD, safeR: cntSafeR, comp: cntComp };
        const b = partySorted(new Float64Array(k)), pos = new Float64Array(k).fill(-Infinity);
        for (let q = 0; q < cntTier[0]; q++) pos[q] = thFloor; // safe seats: anywhere at or above the floor
        if (posOn) for (let q = cntTier[0]; q < k; q++) pos[q] = Math.min(b[q], thFloor) - LOCK_SLACK;
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
        // a proportional map handed down from the precinct stage keeps its fairness
        if (isProp && opts.lockFromStart) fairOn = true;
        if (opts.initialAssign) {
          assign.set(opts.initialAssign);
          const moved = repairContiguity();
          if (moved) notes.push("Reconnected " + moved.toLocaleString("en-US") + " stray " + unitName + (moved === 1 ? "" : "s") + " so every district stays in one piece.");
        } else {
          initialPlan();
          if (mass) repairContiguity();
        }
        recomputeAll();
        if (countyLockOn) splitCap = Math.max(splits, opts.splitCap || 0);
        if (opts.lockFromStart && mode !== "neutral") lock = currentLock();
        if (mode === "neutral" && !opts.goal) goal = { achieved: true, text: compact ? "No partisan goal: equal-population, compact districts" : "No partisan goal: equal-population districts, shapes left as they fall" };
        if (worstDev() > userTol) enterPhase("balance");
        else nextPhase();
      }

      function stepOnce() {
        stepCount++; phaseStep++;
        const frac = Math.min(1, phaseStep / phaseBudget);
        T = T0 * Math.pow(T1 / T0, frac);
        if (phase === "balance" && countyTreeOn && !treeDone) {
          if (!treeStep()) { treeDone = true; phaseStep = 0; }
          if (splits > splitCap) splitCap = splits;
          if (fairOn) curFair = fairness();
          partE = partisanE(); curE = energy();
        }
        else if (rand() < recomProb) recomMove();
        else if (phase === "smooth") { if (rand() < 0.5) swapMove(true); else flipMove(); }
        else if ((phase === "balance" || phase === "final") && rand() < (stuckRounds ? 0.6 : 0.3)) swapMove();
        else flipMove();
        if ((stepCount & 0xffff) === 0) resync();
        const check = (phaseStep & 63) === 0;

        if (phase === "balance") {
          if (check && popOk()) { nextPhase(); return; }
          if (phaseStep >= phaseBudget && (treeDone || !countyTreeOn || forceSkip)) {
            if (strictPop && !forceSkip && keepBalancing()) return;
            const w = worstDev();
            notes.push("Couldn't reach ±" + (userTol * 100).toFixed(2) + "% population balance with whole " + unitName + "s; best was ±" + (w * 100).toFixed(3) + "%.");
            setTol(w + 1e-9); baseTol = tol;
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
          if (fairOn) {
            if (curFair < fairBest - 1e-9) { fairBest = curFair; fairBestAssign.set(assign); }
            if (curFair < 0.01 || phaseStep >= phaseBudget) { restore(fairBestAssign); finishSearch(true); }
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
            if (best && curE > best.E) { const cur = assign.slice(); restore(best.assign); if (!popOk()) restore(cur); }
            finishOrSmooth();
          } else if (phaseStep >= phaseBudget) {
            if (best) { const cur = assign.slice(); restore(best.assign); if (strictPop && !popOk()) restore(cur); }
            if (strictPop && !forceSkip && !popOk() && keepBalancing()) return;
            finishOrSmooth();
          }
        } else if (phase === "smooth") {
          if (phaseStep >= phaseBudget) phase = "done";
        }
      }
      // Balancing to a tight tolerance trades blocks one at a time with shape barely
      // counting, which leaves jagged fingers along borders. Once every district is
      // within the tolerance (and the map is meant to be compact), a smoothing pass
      // only takes changes that make shapes tidier and keep every district within the
      // tolerance: moving an empty block, or swapping a protruding block for one that
      // dents in from the other side.
      function finishOrSmooth() {
        if (!compact || !strictPop || !popOk()) { phase = "done"; return; }
        phase = "smooth"; phaseStep = 0; phaseBudget = Math.max(20000, 2 * n);
        wComp = 1; wPop = 1e6; softPop = true; recomProb = 0; T0 = T1 = T = 1e-6;
        recomputePen(); partE = partisanE(); curE = energy();
      }
      function pairInTol(A, B) { const lim = tol * ideal + 1e-6; return Math.abs(dPop[A] - ideal) <= lim && Math.abs(dPop[B] - ideal) <= lim; }
      // how much of a unit's border faces the other district rather than its own (higher = sticks out)
      function sticksOut(x, own, other) {
        let s = 0;
        for (let j = start[x]; j < start[x + 1]; j++) { const d = assign[nbr[j]]; if (d === other) s += nlen[j]; else if (d === own) s -= nlen[j]; }
        return s;
      }
      // out of steps with a district still outside the tolerance: start the round
      // again (the temperature reheats), loosening a lock that may be in the way
      // false = don't keep going: inside a pipeline (restartOnStuck) the run finishes
      // normally, and if the finished map is outside the tolerance the pipeline starts
      // over from a new map
      function keepBalancing() {
        if (opts.restartOnStuck) return false;
        stuckRounds++;
        phaseStep = 0;
        // let tiny population fixes win over shape while it's stuck
        if (phase === "balance" && wComp > 0) { wComp = Math.max(0.01, wComp * 0.5); curE = energy(); }
        if (lock && stuckRounds >= 2) relaxLock();
        if (countyLockOn && stuckRounds >= 2 && splits >= splitCap) {
          splitCap++; extraSplits++;
          const i = notes.findIndex((x) => x.startsWith("Population couldn't be evened out"));
          const msg = "Population couldn't be evened out with the counties already split, so " + extraSplits + " more county piece" + (extraSplits === 1 ? " was" : "s were") + " allowed.";
          if (i >= 0) notes[i] = msg; else notes.push(msg);
        }
      }
      function relaxLock() {
        if (stuckRounds >= 5) {
          lock = null;
          if (!lockDropped) {
            lockDropped = true;
            notes.push("To get every district within ±" + (userTol * 100).toFixed(userTol < 0.001 ? 3 : 2) + "%, the " + (isProp ? "seats–votes curve" : "seat result") + " was unlocked while balancing population, so it may have shifted.");
          }
          return;
        }
        if (lock.pos) { for (let q = 0; q < k; q++) if (Number.isFinite(lock.pos[q]) && lock.pos[q] < thFloor) lock.pos[q] -= 0.005; }
        if (lock.fair != null) lock.fair += 0.5;
      }

      // Proportional: pull the seats-votes curve toward the 1-for-1 line (nothing locked yet)
      function startFair() {
        lock = null;
        fairOn = true; curFair = fairness(); fairBest = curFair;
        if (!fairBestAssign) fairBestAssign = new Int32Array(n);
        fairBestAssign.set(assign);
        // every district has a spot to reach, so give it more steps with more districts
        phaseStep = 0; phaseBudget = Math.round(searchBudget * Math.max(3, k / 5));
        partE = partisanE(); curE = energy();
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
        else if (isProp) goal = { achieved: true, text: "Seats–votes curve pulled as close to the 1-for-1 line as the map allows (" + needD + " D / " + needR + " R would be an exact split)." };
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
        // land pieces: on each land mass a district must be one piece over land
        let stray = 0;
        const strayIn = new Uint8Array(k);
        if (mass) {
          const seenL = new Uint8Array(n), pieces = new Set();
          for (let s0 = 0; s0 < n; s0++) {
            if (seenL[s0]) continue;
            const d = assign[s0], key = d * nMass + mass[s0];
            if (pieces.has(key)) { stray++; strayIn[d] = 1; } else pieces.add(key);
            let qh = 0, qt = 0; queue[qt++] = s0; seenL[s0] = 1;
            while (qh < qt) {
              const x = queue[qh++];
              for (let j = start[x]; j < start[x + 1]; j++) {
                const y = nbr[j];
                if (nconn[j] === 1 && !seenL[y] && assign[y] === d) { seenL[y] = 1; queue[qt++] = y; }
              }
            }
          }
        }
        const broken = [];
        let water = 0;
        for (let d = 0; d < k; d++) { if (comps[d] !== 1 || strayIn[d]) broken.push(d); water += usesBridge[d]; }
        return { ok: broken.length === 0, broken, water, stray };
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
          minPP, belowMinPP: minPP > 0 ? districts.filter((x) => x.pp < minPP - 1e-9).length : 0,
          curveDev: fairness(),
          curveWindow: { lo: stateShare + xLo, hi: stateShare + xHi }, // statewide Harris shares the curve is scored over                       // gap from the 1-for-1 seats-votes line (points), lower is better
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
        if (phase !== "search") {
          if (phase !== "balance") return { achieved: false, text: goal.text };
          if (countyTreeOn) {
            let sc = 0;
            for (let c = 0; c < nc; c++) if (cPresent[c] > 1) sc++;
            return { achieved: false, text: (treeDone ? "Fine-tuning population inside split counties" : "Evening out population, splitting as few counties as possible") + ": " + sc + " count" + (sc === 1 ? "y" : "ies") + " split so far, largest district ±" + (worstDev() * 100).toFixed(3) + "% off" };
          }
          // tight targets read better in people
          const off = userTol * ideal < 50
            ? Math.ceil(worstDev() * ideal - 1e-6).toLocaleString("en-US") + " people off (target: within " + (userTol * ideal <= 1 + 1e-6 ? "1 person" : Math.floor(userTol * ideal) + " people") + ")"
            : "±" + (worstDev() * 100).toFixed(3) + "% off (target ±" + (userTol * 100).toFixed(3) + "%)";
          return { achieved: false, text: "Balancing population: largest district is " + off + (stuckRounds ? "; still going (round " + (stuckRounds + 1) + ")" : "") };
        }
        if (isMax) {
          const party = mode === "maxD" ? "Democratic" : "Republican", need = Math.min(k, maxTarget);
          if (posIdx >= 0) return { achieved: false, text: "Locked " + cntTier[0] + " safe seats and " + cntTier[nTier - 1] + " wins; now pushing the #" + (posIdx + 1) + " district toward the floor" };
          if (tierIdx === 0) return { achieved: false, text: "Trying for " + need + " " + party + " seats" + (floorPts > 0 ? " won by " + floorPts + "+" : "") };
          return { achieved: false, text: "Locked " + cntTier[0] + " safe seats; now trying for " + need + " " + party + " wins" };
        }
        if (mode === "competitive") return { achieved: false, text: "Making districts competitive" };
        if (fairOn) return { achieved: false, text: "Pulling the seats–votes curve toward the 1-for-1 line" };
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
        // "skip phase" / stop: the only way to end balancing early (just this once)
        finishNow() {
          forceSkip = true;
          if (phase === "polish") { nextPhase(); }
          else if (phase === "final") { if (best) restore(best.assign); phase = "done"; }
          else if (phase === "smooth") phase = "done";
          else if (phase === "search" || phase === "balance") {
            phaseStep = phaseBudget; targetSteps = phaseBudget; searchTotal = Infinity; stepOnce();
          }
          forceSkip = false;
        },
        report,
        verifyContiguity,
        _debug: {
          // components of district A without unit u (full search), for debugging
          cutCheck(u) {
            const A = assign[u], seen = new Uint8Array(n); seen[u] = 1;
            const comps = [];
            for (let j = start[u]; j < start[u + 1]; j++) {
              const y = nbr[j];
              if (!nconn[j] || assign[y] !== A || seen[y]) continue;
              let size = 0; const q = [y]; seen[y] = 1;
              while (q.length) { const x = q.pop(); size++; for (let i = start[x]; i < start[x + 1]; i++) { const z = nbr[i]; if (nconn[i] && assign[z] === A && !seen[z]) { seen[z] = 1; q.push(z); } } }
              comps.push(size);
            }
            return { A, dCnt: dCnt[A], comps };
          },
          get frontierDebug() { return tree && tree.task ? { G: tree.task.G, R: tree.task.R, county: tree.task.county, failed: tree.task.failed ? [...tree.task.failed] : [] } : null; },
          treeLog, recomputeAll, dPop, dPerim, dArea, energy, get curE() { return curE; }, get splits() { return splits; }, get compSum() { return compSum; } },
      };
    }

    // ---------- two-level runner: precincts first, then census blocks ----------
    // fine: block graph; group: precinct id per block; opts as in createEngine plus
    // coarsePolishSteps / finePolishSteps.
    // ---------- runner with restarts ----------
    // Each run finishes normally. If the finished map has a district outside the
    // population tolerance, it's thrown away and the run starts over from a new random
    // map with a new seed (a map that can't be balanced is usually a dead end).
    // Repeats until a finished map is within the tolerance, or the run is stopped
    // (Skip phase keeps whatever it has).
    function createPipeline(fine, group, opts) {
      let seed = opts.seed == null ? (Math.random() * 4294967296) >>> 0 : opts.seed >>> 0;
      let inner = null, restarts = 0, skipped = false;
      function make() {
        inner = createPipelineOnce(fine, group, Object.assign({}, opts, {
          seed, restartOnStuck: true, startAssign: restarts ? null : opts.startAssign,
        }));
        inner.init();
      }
      function restart() {
        restarts++;
        seed = (Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) + 0x9e3779b9 + restarts) >>> 0;
        make();
      }
      return {
        init() { make(); },
        get stage() { return inner.stage; },
        get phase() { return inner.phase; },
        get useCoarse() { return inner.useCoarse; },
        get seed() { return seed; },
        get _engines() { return inner._engines; },
        run(ms) {
          const done = inner.run(ms);
          if (done && !skipped) {
            const r = inner.report(false);
            if (r.maxDev > r.userTol + 1e-12) { restart(); return false; }
          }
          return done;
        },
        finishNow() { skipped = true; inner.finishNow(); },
        assignment() { return inner.assignment(); },
        report(full) {
          const r = inner.report(full);
          r.seed = seed; r.restarts = restarts;
          if (restarts) r.notes = [restarts + " finished map" + (restarts === 1 ? " wasn't" : "s weren't") + " within the population tolerance, so it started over with a new random map (now seed " + seed + ")."].concat(r.notes);
          return r;
        },
      };
    }

    function createPipelineOnce(fine, group, opts) {
      if (opts.countyRequired) return createCountyPipeline(fine, group, opts);
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
            rand, tol: coarseTol, unitName: "precinct", initialAssign: coarseStart(), strictPop: false,
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

    // ---------- required county mode: split the fewest counties, then whole-county edits ----------
    // 1. "county": whole counties are the units (counties bigger than a district,
    //    which must be split anyway, use their precinct pieces); the goal is chased here.
    // 2. "split": on census blocks, even out population splitting as few counties as
    //    possible (createEngine's countyTree), with no other county ever split.
    // 3. "refine": unsplit counties become single units that can only move whole;
    //    split counties are their precincts. The goal and compactness are refined
    //    with the split count capped (it can only go down).
    // 4. "block": census blocks again, seat result and split cap locked: population
    //    is evened out exactly and borders smoothed inside the split counties.
    function createCountyPipeline(fine0, group, opts) {
      const rand = makeRng(opts.seed == null ? (Math.random() * 4294967296) >>> 0 : opts.seed);
      // A county is always connected to itself: a thin strip inside one county
      // (a road or rail strip joining two parts of it) counts as a connection here.
      // Corridors through other counties still don't count.
      const fine = (() => {
        const links = opts.countyLinks || fine0.countyLinks;
        if (!links || !links.length) return fine0;
        const econn = Uint8Array.from(fine0.econn);
        for (let i = 0; i < links.length; i++) econn[links[i]] = 1;
        const n0 = fine0.n, ext = new Float64Array(n0);
        for (let u = 0; u < n0; u++) { let b = fine0.border[u]; for (let j = fine0.start[u]; j < fine0.start[u + 1]; j++) b -= fine0.nlen[j]; ext[u] = b; }
        // land masses again, with those links
        const pm = new Int32Array(n0); for (let u = 0; u < n0; u++) pm[u] = u;
        const fm = (x) => { while (pm[x] !== x) { pm[x] = pm[pm[x]]; x = pm[x]; } return x; };
        for (let e = 0; e < fine0.E; e++) if (econn[e] === 1) { const a = fm(fine0.eu[e]), b = fm(fine0.ev[e]); if (a !== b) pm[a] = b; }
        const ids = new Map(), mass = new Int32Array(n0);
        for (let u = 0; u < n0; u++) { const r = fm(u); let id = ids.get(r); if (id === undefined) { id = ids.size; ids.set(r, id); } mass[u] = id; }
        return buildGraph({ n: n0, pop: fine0.pop, dem: fine0.dem, rep: fine0.rep, area: fine0.area, ext, county: fine0.county, eu: fine0.eu, ev: fine0.ev, elen: fine0.elen, econn, mass });
      })();
      const k = opts.k | 0, n = fine.n;
      const neutral = (opts.mode || "neutral") === "neutral";
      const userTol = opts.tol == null ? 0.005 : opts.tol;
      let total = 0;
      for (let u = 0; u < n; u++) total += fine.pop[u];
      const ideal = total / k;
      // county pieces: the land-connected parts of each county
      const par = new Int32Array(n); for (let u = 0; u < n; u++) par[u] = u;
      const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
      for (let e = 0; e < fine.E; e++) if (fine.econn[e] === 1 && fine.county[fine.eu[e]] === fine.county[fine.ev[e]]) { const a = f(fine.eu[e]), b = f(fine.ev[e]); if (a !== b) par[a] = b; }
      const piece = new Int32Array(n); for (let u = 0; u < n; u++) piece[u] = f(u);
      const cPop = new Float64Array(fine.nc);
      for (let u = 0; u < n; u++) cPop[fine.county[u]] += fine.pop[u];
      const big = new Uint8Array(fine.nc);
      let forced = 0;
      for (let c = 0; c < fine.nc; c++) if (cPop[c] > ideal * (1 + userTol)) { big[c] = 1; forced++; }
      const labelA = new Float64Array(n);
      // whole counties (a county split by a river or a road strip is still one unit here;
      // the block stage sorts out its land connections)
      for (let u = 0; u < n; u++) labelA[u] = big[fine.county[u]] && group ? n + group[u] : 2 * n + fine.county[u];
      const aggA = aggregate(fine, labelA);
      // whole counties are lumpy: they only aim for a loose balance here (the split
      // stage evens it out exactly, and a looser start leaves the goal search more room)
      const meanUnit = total / aggA.graph.n;
      const tolA = Math.min(0.1, Math.max(userTol, 0.01, 2 * meanUnit / ideal));
      // same block-level settings as the normal pipeline (ReCom on blocks only when districts are small)
      const smallDistricts = n / k < 2000;
      const fineTune = Object.assign({
        balanceRecom: smallDistricts ? 0.3 : 0, balanceT0: 0.003, balanceT1: 0.0003,
        polishRecom: smallDistricts ? 0.02 : 0, polishT0: 0.003, polishT1: 0.0002, popW0: 300,
      }, opts.tune && opts.tune.fine);
      let stage, engA = null, engB = null, engC = null, engD = null, aggC = null;
      const blockAssign = new Int32Array(n);
      function project(groupOf, m, sa) {
        const best = new Int32Array(m).fill(-1), bestW = new Float64Array(m).fill(-1), acc = new Map();
        for (let u = 0; u < n; u++) {
          const key = groupOf[u] * k + sa[u], w = (acc.get(key) || 0) + fine.pop[u] + 1e-3;
          acc.set(key, w);
          if (w > bestW[groupOf[u]]) { bestW[groupOf[u]] = w; best[groupOf[u]] = sa[u]; }
        }
        return best;
      }
      function init() {
        engA = createEngine(aggA.graph, Object.assign({}, opts, {
          rand, tol: tolA, strictPop: false, unitName: "county",
          initialAssign: opts.startAssign ? project(aggA.groupOf, aggA.graph.n, opts.startAssign) : null,
          phases: neutral ? ["polish"] : ["search", "polish"],
          polishSteps: Math.max(20000, Math.round((opts.coarsePolishSteps || 40000) / 4)),
          tune: Object.assign({}, opts.tune && opts.tune.coarse),
        }));
        engA.init();
        stage = "county";
      }
      function startSplit() {
        const ga = engA.assign, gof = aggA.groupOf;
        for (let u = 0; u < n; u++) blockAssign[u] = ga[gof[u]];
        engB = createEngine(fine, Object.assign({}, opts, {
          rand, initialAssign: Int32Array.from(blockAssign), goal: engA.goal, unitName: "block",
          countyLock: true, countyTree: true, phases: [], tune: fineTune,
        }));
        engB.init();
        stage = "split";
      }
      function startRefine() {
        // split counties keep their blocks; every other county piece is one unit
        const a = engB.assign, seen = new Int32Array(fine.nc).fill(-1), split = new Uint8Array(fine.nc);
        for (let u = 0; u < n; u++) { const c = fine.county[u]; if (seen[c] < 0) seen[c] = a[u]; else if (seen[c] !== a[u]) split[c] = 1; }
        const labelC = new Float64Array(n);
        for (let u = 0; u < n; u++) labelC[u] = split[fine.county[u]] ? (group ? group[u] : u) : 2 * n + piece[u];
        aggC = aggregate(fine, labelC);
        const init0 = project(aggC.groupOf, aggC.graph.n, a);
        const r = engB.report(false);
        let pp = 0, np2 = 0;
        for (let u = 0; u < aggC.graph.n; u++) { pp += aggC.graph.pop[u]; np2++; }
        const tolC = Math.min(0.05, Math.max(userTol, 0.005, 2 * (pp / np2) / ideal));
        engC = createEngine(aggC.graph, Object.assign({}, opts, {
          rand, initialAssign: init0, goal: engA.goal, unitName: "precinct", countyLock: true, splitCap: 0,
          tol: tolC, strictPop: false, countyWeight: Math.max(1, opts.countyWeight || 0),
          phases: neutral ? ["polish"] : ["search", "polish"], polishSteps: opts.coarsePolishSteps,
          tune: Object.assign({}, opts.tune && opts.tune.coarse),
        }));
        engC.init();
        notesB = r.notes.filter((x) => !/^Reconnected/.test(x));
        stage = "refine";
      }
      function startBlocks() {
        const gc = engC.assign, gof = aggC.groupOf, init1 = new Int32Array(n);
        for (let u = 0; u < n; u++) init1[u] = gc[gof[u]];
        notesC = engC.report(false).notes.filter((x) => !/^(Reconnected|Couldn't reach)/.test(x));
        engD = createEngine(fine, Object.assign({}, opts, {
          rand, initialAssign: init1, goal: engC.goal, unitName: "block", lockFromStart: true, countyLock: true,
          countyWeight: Math.max(1, opts.countyWeight || 0),
          phases: ["polish", "final"], polishSteps: opts.finePolishSteps, tune: fineTune,
        }));
        engD.init();
        stage = "block";
      }
      let notesC = [];
      let notesB = [];
      function current() { return stage === "county" ? engA : stage === "split" ? engB : stage === "refine" ? engC : engD; }
      function advance() {
        if (stage === "county" && engA.phase === "done") startSplit();
        if (stage === "split" && engB.phase === "done") startRefine();
        if (stage === "refine" && engC.phase === "done") startBlocks();
      }
      function assignment() {
        if (stage === "county") { const ga = engA.assign, gof = aggA.groupOf; for (let u = 0; u < n; u++) blockAssign[u] = ga[gof[u]]; return blockAssign; }
        if (stage === "split") return engB.assign;
        if (stage === "block") return engD.assign;
        const gc = engC.assign, gof = aggC.groupOf;
        for (let u = 0; u < n; u++) blockAssign[u] = gc[gof[u]];
        return blockAssign;
      }
      return {
        init,
        get stage() { return stage; },
        get phase() { return stage === "block" && engD.phase === "done" ? "done" : current().phase; },
        useCoarse: true,
        get _engines() { return { engA, engB, engC, engD }; },
        run(ms) { const done = current().run(ms); if (done) advance(); return this.phase === "done"; },
        finishNow() { current().finishNow(); if (current().phase === "done") advance(); },
        assignment,
        report(full) {
          const r = current().report(full);
          r.stage = stage; r.useCoarse = true;
          r.countyRequired = { forced, counties: fine.nc };
          if (stage === "refine") r.notes = notesB.concat(r.notes);
          if (stage === "block") r.notes = notesB.concat(notesC, r.notes);
          // block counts per district (units here can be whole counties)
          if (stage === "county" || stage === "refine") {
            const a = assignment(), cnt = new Int32Array(k);
            for (let u = 0; u < n; u++) cnt[a[u]]++;
            for (const d of r.districts) d.units = cnt[d.id];
          }
          return r;
        },
      };
    }

    // Decoded state arrays -> engine input. Block votes are the precinct's
    // 2024 votes split by each block's weight (voting-age population).
    //
    // Sliver blocks (road and rail strips, slivers along rivers: on average under
    // THIN_M meters wide) are too thin to hold a district together. Each one joins
    // the neighboring block it shares the most border with, and a border through it
    // only counts where it is the only land between two pieces of solid land (a
    // river crossing), never for joining two parts of a district on the same land.
    //
    // Districts may only connect over land: water blocks (no land area) are left
    // out of the graph, and land cut off by water (islands etc.) is joined only by
    // the links in meta.landBridges. Each water block is attached to a nearby land
    // block (`attach`) so it can be shown and exported with that block's district.
    const THIN_M = 30;
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
      // average width of each block: 2 * area / perimeter (a long strip w wide gives ~w)
      const per = Float64Array.from(A.ext, Number);
      for (let i = 0; i < E; i++) { per[au[i]] += A.elen[i]; per[av[i]] += A.elen[i]; }
      // slivers hang off a host: the solid land neighbor with the longest shared
      // border, or, failing that, the host of a sliver neighbor (repeated)
      const host = new Int32Array(n).fill(-1), bestLen = new Float64Array(n);
      const thin = new Uint8Array(n);
      for (let u = 0; u < n; u++) if (!water[u] && per[u] > 0 && (200 * A.area[u]) / per[u] < THIN_M) thin[u] = 1;
      const cand = new Int32Array(n);
      // a host in the sliver's own county wins over a longer border in another
      // county, so slivers don't put bits of a county into a neighbor's district
      const bestSame = new Uint8Array(n);
      function offer(x, y, len) {
        if (!thin[x] || host[x] >= 0) return;
        const hy = thin[y] ? host[y] : y;
        if (hy < 0) return;
        const same = A.county[hy] === A.county[x] ? 1 : 0;
        if (same > bestSame[x] || (same === bestSame[x] && len > bestLen[x])) { bestLen[x] = len; cand[x] = hy; bestSame[x] = same; }
      }
      for (let pass = 0; pass < 50; pass++) {
        let changed = 0;
        bestLen.fill(0); cand.fill(-1); bestSame.fill(0);
        for (let i = 0; i < E; i++) {
          const a = au[i], b = av[i], len = A.elen[i];
          if (!(len > 0) || water[a] || water[b] || (!thin[a] && !thin[b])) continue;
          offer(a, b, len); offer(b, a, len);
        }
        for (let u = 0; u < n; u++) if (cand[u] >= 0) { host[u] = cand[u]; changed++; }
        if (!changed) break;
      }
      // a sliver with no solid land to hang on (a tiny island of slivers) stays on its own
      for (let u = 0; u < n; u++) if (thin[u] && host[u] < 0) thin[u] = 0;
      // land index: solid land blocks only
      const landOf = new Int32Array(n).fill(-1);
      let nl = 0;
      for (let u = 0; u < n; u++) if (!water[u] && !thin[u]) landOf[u] = nl++;
      const landIds = new Int32Array(nl);
      for (let u = 0; u < n; u++) if (landOf[u] >= 0) landIds[landOf[u]] = u;
      // attach water blocks to land: breadth-first out from the shore
      const attach = Int32Array.from(landOf);
      for (let u = 0; u < n; u++) if (thin[u]) attach[u] = landOf[host[u]];
      const deg = new Int32Array(n);
      for (let i = 0; i < E; i++) { deg[au[i]]++; deg[av[i]]++; }
      const st = new Int32Array(n + 1);
      for (let u = 0; u < n; u++) st[u + 1] = st[u] + deg[u];
      const adj = new Int32Array(2 * E), fill = st.slice(0, n);
      for (let i = 0; i < E; i++) { adj[fill[au[i]]++] = av[i]; adj[fill[av[i]]++] = au[i]; }
      const q = new Int32Array(n);
      // first within each county, then across county lines for what's left
      for (const sameOnly of [true, false]) {
        let qh = 0, qt = 0;
        for (let u = 0; u < n; u++) if (attach[u] >= 0) q[qt++] = u;
        while (qh < qt) {
          const u = q[qh++];
          for (let j = st[u]; j < st[u + 1]; j++) { const w = adj[j]; if (attach[w] < 0 && (!sameOnly || A.county[w] === A.county[u])) { attach[w] = attach[u]; q[qt++] = w; } }
        }
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
      // edge kinds: 1 solid land border, 3 border through a sliver (settled below),
      // 2 link (zero-length island link), 0 water / shape only
      const RANK = [0, 3, 1, 2];
      const inCounty = []; // sliver borders inside one county (required county mode counts them)
      const pairs = new Map(), lu = [], lv = [], ll = [], lc = [];
      function addEdge(a, b, len, c) {
        if (a === b) return;
        const key = a < b ? a * nl + b : b * nl + a;
        const i = pairs.get(key);
        if (i === undefined) { pairs.set(key, lu.length); lu.push(Math.min(a, b)); lv.push(Math.max(a, b)); ll.push(len); lc.push(c); }
        else { ll[i] += len; if (RANK[c] > RANK[lc[i]]) lc[i] = c; }
      }
      const sliverEdge = []; // [sliver block, unit-pair index] for borders through slivers
      for (let i = 0; i < E; i++) {
        const a = au[i], b = av[i];
        const land = !water[a] && !water[b];
        const kind = !land ? 0 : !(A.elen[i] > 0) ? 2 : thin[a] || thin[b] ? 3 : 1;
        addEdge(attach[a], attach[b], A.elen[i], kind);
        if (kind === 3 && attach[a] !== attach[b]) {
          const pi = pairs.get(attach[a] < attach[b] ? attach[a] * nl + attach[b] : attach[b] * nl + attach[a]);
          if (thin[a]) sliverEdge.push(a, pi);
          if (thin[b]) sliverEdge.push(b, pi);
        }
      }
      const br = meta.landBridges || [];
      for (let i = 0; i < br.length; i += 2) {
        if (water[br[i]] || water[br[i + 1]]) continue;
        addEdge(attach[br[i]], attach[br[i + 1]], 0, 2);
      }
      // A border through a sliver joins two units over land only if their solid land
      // isn't already connected (the sliver is the only land between them, e.g. across
      // a river). Inside one piece of solid land it can't join anything: it counts for
      // shape only, so a district can't run along a road strip.
      {
        const su = new Int32Array(nl);
        for (let i = 0; i < nl; i++) su[i] = i;
        const sf = (v) => { while (su[v] !== v) { su[v] = su[su[v]]; v = su[v]; } return v; };
        for (let i = 0; i < lu.length; i++) if (lc[i] === 1) { const ra = sf(lu[i]), rb = sf(lv[i]); if (ra !== rb) su[ra] = rb; }
        for (let i = 0; i < lu.length; i++) if (lc[i] === 3) {
          if (sf(lu[i]) !== sf(lv[i])) lc[i] = 1;
          else { lc[i] = 0; if (county[lu[i]] === county[lv[i]]) inCounty.push(i); }
        }
      }
      // A sliver attached to another county's land may still touch land of its own
      // county: remember one such unit (sliverHome), so the block can follow its own
      // county when that county is all in one district. Not for slivers that are the
      // only land between two areas (a river crossing): a district may rely on those.
      const bridgeSliver = new Uint8Array(n);
      for (let i = 0; i < sliverEdge.length; i += 2) if (lc[sliverEdge[i + 1]] === 1) bridgeSliver[sliverEdge[i]] = 1;
      const sliverHome = new Int32Array(n).fill(-1);
      for (let i = 0; i < E; i++) {
        if (!(A.elen[i] > 0)) continue;
        for (const [x, y] of [[au[i], av[i]], [av[i], au[i]]]) {
          if (!thin[x] || bridgeSliver[x] || sliverHome[x] >= 0 || water[y] || A.county[y] !== A.county[x]) continue;
          const yu = attach[y];
          if (yu >= 0 && yu !== attach[x] && A.county[landIds[yu]] === A.county[x]) sliverHome[x] = yu;
        }
      }
      // Precinct-stage units: each precinct's land-connected pieces (a precinct
      // split by a river becomes two units), so precinct maps stay contiguous on land.
      const uf = new Int32Array(nl);
      for (let i = 0; i < nl; i++) uf[i] = i;
      const find = (v) => { while (uf[v] !== v) { uf[v] = uf[uf[v]]; v = uf[v]; } return v; };
      for (let i = 0; i < lu.length; i++) if (lc[i] === 1 && group[lu[i]] === group[lv[i]]) { const ra = find(lu[i]), rb = find(lv[i]); if (ra !== rb) uf[ra] = rb; }
      const piece = new Int32Array(nl);
      for (let i = 0; i < nl; i++) piece[i] = find(i);
      // land masses: connected over land borders
      for (let i = 0; i < nl; i++) uf[i] = i;
      for (let i = 0; i < lu.length; i++) if (lc[i] === 1) { const ra = find(lu[i]), rb = find(lv[i]); if (ra !== rb) uf[ra] = rb; }
      const massIds = new Map(), landMass = new Int32Array(nl);
      for (let i = 0; i < nl; i++) { const r = find(i); let id = massIds.get(r); if (id === undefined) { id = massIds.size; massIds.set(r, id); } landMass[i] = id; }
      return {
        n: nl, pop, dem, rep, area, ext, county, group: piece, precinct: group, mass: landMass,
        eu: Int32Array.from(lu), ev: Int32Array.from(lv), elen: Float64Array.from(ll), econn: Uint8Array.from(lc),
        countyLinks: Int32Array.from(inCounty),
        landIds, landOf, attach, blocks: n, thin: thin.reduce((x, y) => x + y, 0),
        blockCounty: A.county, blockWater: water, sliverHome,
      };
    }

    // land-graph assignment -> one district per census block (water follows its land)
    // Water blocks don't count for contiguity (districts connect over land), so a water
    // block goes with its own county when that county's land is all in one district;
    // otherwise with the land it's attached to.
    function expandAssign(graph, landAssign, out) {
      const a = out || new Int32Array(graph.blocks);
      for (let u = 0; u < graph.blocks; u++) a[u] = landAssign[graph.attach[u]];
      const bc = graph.blockCounty, bw = graph.blockWater, home = graph.sliverHome, landOf = graph.landOf;
      if (bc && bw && landOf) {
        // county -> its district, or -1 if split (judged on solid land blocks)
        const one = new Map();
        for (let u = 0; u < graph.blocks; u++) {
          if (landOf[u] < 0) continue;
          const c = bc[u], d = one.get(c);
          if (d === undefined) one.set(c, a[u]); else if (d !== a[u]) one.set(c, -1);
        }
        for (let u = 0; u < graph.blocks; u++) {
          if (landOf[u] >= 0) continue;
          const d = one.get(bc[u]);
          if (d === undefined || d < 0 || d === a[u]) continue;
          if (bw[u]) a[u] = d;                                            // water
          else if (home && home[u] >= 0 && landAssign[home[u]] === d) a[u] = d; // sliver touching its county's land
        }
      }
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
      const compact = opts.compact !== false && (opts.minPP == null || opts.minPP > 0);
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
        else if (mode === "target") primary = [-deficit(r)];
        // proportional: closeness to the 1-for-1 seats-votes line
        else if (mode === "proportional") primary = [-r.curveDev];
        const minPP = opts.minPP || 0;
        const shape = compact ? -r.districts.reduce((a, d) => a + (d.pp > 0 ? 1 / d.pp : 1e9) + (d.pp < minPP ? 300 * (minPP - d.pp) : 0), 0) : -r.maxDev;
        return valid ? [1].concat(primary, [shape]) : [0, -r.maxDev].concat(primary);
      }
      function better(a, b) {
        for (let i = 0; i < a.length; i++) { if (a[i] > b[i] + 1e-12) return true; if (a[i] < b[i] - 1e-12) return false; }
        return false;
      }
      function startCycle() {
        cycle++;
        // cycle 1 starts from the map you gave it (if any); later ones from the best so far,
        // except every 4th, which starts fresh
        const given = !best && cycle === 1 ? opts.startAssign || null : null;
        // later cycles search harder (up to 4x the normal budget)
        const boost = Math.min(4, 1 + 0.5 * (cycle - 1));
        pipe = createPipeline(fine, group, Object.assign({}, opts, {
          seed: (baseSeed + cycle * 7919) >>> 0,
          startAssign: given || (best && cycle % 4 !== 1 ? best.assign : null),
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

    return { makeRng, buildGraph, aggregate, createEngine, createPipeline, createEndless, prepareGraph, expandAssign, US2024, US2024_SHARE };
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
