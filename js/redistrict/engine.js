/* Redistricting MCMC engine.
 *
 * Districts are unions of precincts. The chain uses two kinds of moves:
 *   - ReCom: merge two neighboring districts, draw a random spanning tree on
 *     the merged precincts, and cut one tree edge so both halves have equal
 *     population. Both halves are connected by construction.
 *   - Flip: move one border precinct into the neighboring district, allowed
 *     only if the district it leaves stays connected.
 * Moves are accepted with the Metropolis rule on an energy (simulated
 * annealing), in phases: population balance -> partisan goal -> compactness.
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

    // ---------- graph ----------
    function buildGraph(d) {
      const n = d.n;
      const E = d.edges.length / 3;
      const eu = new Int32Array(E), ev = new Int32Array(E), elen = new Float64Array(E);
      const deg = new Int32Array(n);
      for (let i = 0; i < E; i++) {
        eu[i] = d.edges[3 * i]; ev[i] = d.edges[3 * i + 1]; elen[i] = d.edges[3 * i + 2];
        deg[eu[i]]++; deg[ev[i]]++;
      }
      const start = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
      const nbr = new Int32Array(2 * E), nlen = new Float64Array(2 * E);
      const fill = start.slice(0, n);
      for (let i = 0; i < E; i++) {
        let p = fill[eu[i]]++; nbr[p] = ev[i]; nlen[p] = elen[i];
        p = fill[ev[i]]++; nbr[p] = eu[i]; nlen[p] = elen[i];
      }
      const border = new Float64Array(n);
      const pop = new Float64Array(n), dem = new Float64Array(n), rep = new Float64Array(n);
      const area = new Float64Array(n), county = new Int32Array(n);
      let nc = 0;
      for (let u = 0; u < n; u++) {
        pop[u] = d.pop[u]; dem[u] = d.dem[u]; rep[u] = d.rep[u];
        area[u] = d.area[u] * 1000; // m^2
        county[u] = d.county ? d.county[u] : 0;
        if (county[u] + 1 > nc) nc = county[u] + 1;
        let b = d.ext[u];
        for (let j = start[u]; j < start[u + 1]; j++) b += nlen[j];
        border[u] = b;
      }
      return { n, E, eu, ev, elen, start, nbr, nlen, border, pop, dem, rep, area, county, nc };
    }

    const FOUR_PI = 4 * Math.PI;

    // ---------- engine ----------
    function createEngine(data, opts) {
      const g = data.start ? data : buildGraph(data);
      const { n, E, eu, ev, start, nbr, nlen, border, pop, dem, rep, area, county, nc } = g;
      const k = opts.k | 0;
      if (k < 1 || k > n) throw new Error("bad number of districts");
      const rand = makeRng(opts.seed == null ? (Math.random() * 4294967296) >>> 0 : opts.seed);
      const mode = opts.mode || "neutral";
      const h = (opts.margin || 0) / 200;            // safe-seat margin, in two-party share
      const band = (opts.band == null ? 5 : opts.band) / 200; // competitive band
      const wCounty = opts.countyWeight || 0;
      const effort = opts.effort || 1;
      const searchBudget = Math.round((opts.searchSteps || 40000) * effort);
      const polishBudget = Math.round((opts.polishSteps || 40000) * effort);
      const tune = Object.assign({
        searchRecom: 0.6, searchT0: 0.5, searchT1: 0.01, searchComp: 0.05,
        polishRecom: 0.03, neutralRecom: 0.03, polishT0: 0.2, polishT1: 0.001, popW0: 30, popW1: 10000,
      }, opts.tune || {});

      let totalPop = 0, totalDem = 0, totalRep = 0;
      for (let u = 0; u < n; u++) { totalPop += pop[u]; totalDem += dem[u]; totalRep += rep[u]; }
      const ideal = totalPop / k;
      const stateShare = totalDem / (totalDem + totalRep);
      const userTol = opts.tol || 0.005;
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
      const cd = new Int32Array(nc * k);   // precincts of county c in district d
      const cPresent = new Int32Array(nc); // number of districts touching county c
      let splits = 0;

      // scratch buffers
      const loc = new Int32Array(n).fill(-1);
      const nodes = new Int32Array(n);
      const stamp = new Int32Array(n); let stampId = 1;
      const queue = new Int32Array(n);
      const maxLocalEdges = 2 * E + 2;
      const la = new Int32Array(maxLocalEdges), lb = new Int32Array(maxLocalEdges), lw = new Float64Array(maxLocalEdges);
      const perm = new Int32Array(maxLocalEdges);
      const uf = new Int32Array(n);
      const tStart = new Int32Array(n + 1), tAdj = new Int32Array(2 * n), tFill = new Int32Array(n);
      const tEdgeA = new Int32Array(n), tEdgeB = new Int32Array(n);
      const order = new Int32Array(n), parent = new Int32Array(n), sub = new Float64Array(n), size = new Int32Array(n), pos = new Int32Array(n);
      const cands = new Int32Array(n);
      const side = new Uint8Array(n);
      const shares = new Float64Array(k), sortBuf = new Float64Array(k);
      const changed = new Int32Array(n);

      function share(d) { const t = dDem[d] + dRep[d]; return t > 0 ? dDem[d] / t : 0.5; }
      function invPP(a, p) { return a > 0 ? (p * p) / (FOUR_PI * a) : 0; }
      // Population penalty beyond the tolerance. During polishing it is soft (with a
      // wider hard limit) so single-precinct flips can move; its weight ramps up.
      let wPop = 1000, softPop = false;
      const softHard = Math.max(3 * userTol, 0.015);
      function popPen(p) { const dev = Math.abs(p - ideal) / ideal - tol; return dev > 0 ? dev * wPop : 0; }

      function recomputeAll() {
        dPop.fill(0); dDem.fill(0); dRep.fill(0); dArea.fill(0); dPerim.fill(0); dCnt.fill(0); cd.fill(0); cPresent.fill(0);
        for (let u = 0; u < n; u++) {
          const d = assign[u];
          dPop[d] += pop[u]; dDem[d] += dem[u]; dRep[d] += rep[u]; dArea[d] += area[u]; dCnt[d]++;
          dPerim[d] += border[u];
          for (let j = start[u]; j < start[u + 1]; j++) if (assign[nbr[j]] === d) dPerim[d] -= nlen[j];
          if (cd[county[u] * k + d]++ === 0) cPresent[county[u]]++;
        }
        splits = 0;
        for (let c = 0; c < nc; c++) if (cPresent[c] > 1) splits += cPresent[c] - 1;
      }

      function partisanE(sh) {
        if (mode === "neutral") return 0;
        if (mode === "competitive") {
          let e = 0;
          for (let d = 0; d < k; d++) { const x = Math.abs(2 * sh[d] - 1) - 2 * band; if (x > 0) e += x; }
          return e * 100;
        }
        sortBuf.set(sh); sortBuf.sort(); // ascending: weakest Dem districts first
        let e = 0;
        for (let i = 0; i < needR; i++) { const x = sortBuf[i] - (0.5 - h); if (x > 0) e += x; }
        for (let i = k - needD; i < k; i++) { const x = 0.5 + h - sortBuf[i]; if (x > 0) e += x; }
        return e * 100;
      }
      function outcome(sh) {
        let safeD = 0, safeR = 0, winD = 0, comp = 0;
        for (let d = 0; d < k; d++) {
          const s = sh[d];
          if (s > 0.5) winD++;
          if (s >= 0.5 + h) safeD++;
          if (s <= 0.5 - h) safeR++;
          if (Math.abs(2 * s - 1) <= 2 * band) comp++;
        }
        return { safeD, safeR, winD, comp };
      }
      function fillShares() { for (let d = 0; d < k; d++) shares[d] = share(d); }
      function compE() { let e = 0; for (let d = 0; d < k; d++) e += invPP(dArea[d], dPerim[d]); return e; }
      function popE() { let e = 0; for (let d = 0; d < k; d++) e += popPen(dPop[d]); return e; }

      // ----- phase + weights -----
      let phase = "init";
      let wPart = 0, wComp = 1, wCty = wCounty;
      let T = 1, T0 = 1, T1 = 0.01, phaseStep = 0, phaseBudget = 1, recomProb = 0.5;
      let lock = null;      // {safeD, safeR, comp}
      let stepCount = 0, accepted = 0, proposals = 0;
      const notes = [];
      let goal = { achieved: false, text: "" };
      let best = null;      // {assign, E}
      let maxTarget = 0, targetSteps = 0, searchTotal = 0, bestAchievedAssign = null, bestAchievedT = 0;

      function lockOk(sh) {
        if (!lock) return true;
        const o = outcome(sh);
        if (mode === "competitive") return o.comp >= lock.comp;
        return o.safeD >= lock.safeD && o.safeR >= lock.safeR;
      }
      function totalE() {
        fillShares();
        return wPart * partisanE(shares) + wComp * compE() + wCty * splits + popE();
      }

      // ----- random cut edge -----
      function randomCutEdge() {
        for (let t = 0; t < 4000; t++) {
          const e = (rand() * E) | 0;
          if (assign[eu[e]] !== assign[ev[e]]) return e;
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
        // preorder from root 0
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
      // subtree population/size in local indices; localPop(i) gives node pop
      function subtreeSums(m, nodeOf) {
        for (let i = 0; i < m; i++) { sub[i] = pop[nodeOf[i]]; size[i] = 1; }
        for (let oi = m - 1; oi > 0; oi--) {
          const x = order[oi], p = parent[x];
          sub[p] += sub[x]; size[p] += size[x];
        }
      }

      // ----- initial plan: recursive spanning-tree splitting -----
      function initialPlan(t) {
        assign.fill(-1);
        let remPop = totalPop;
        for (let d = 0; d < k - 1; d++) {
          // local graph = unassigned precincts
          let m = 0;
          for (let u = 0; u < n; u++) if (assign[u] < 0) { loc[u] = m; nodes[m++] = u; }
          let le = 0;
          for (let i = 0; i < m; i++) {
            const u = nodes[i];
            for (let j = start[u]; j < start[u + 1]; j++) {
              const l2 = loc[nbr[j]];
              if (l2 > i) { la[le] = i; lb[le] = l2; le++; }
            }
          }
          const rest = k - d - 1;
          const dlo = ideal * (1 - t), dhi = ideal * (1 + t);
          const rlo = rest * ideal - (rest === 1 ? ideal * t : rest * ideal * t * 0.5);
          const rhi = rest * ideal + (rest === 1 ? ideal * t : rest * ideal * t * 0.5);
          let done = false;
          for (let attempt = 0; attempt < 60 && !done; attempt++) {
            if (!randomTree(m, le)) break;
            subtreeSums(m, nodes);
            let nc2 = 0;
            for (let oi = 1; oi < m; oi++) {
              const x = order[oi], s = sub[x], r = remPop - s;
              if (s >= dlo && s <= dhi && r >= rlo && r <= rhi) cands[nc2++] = x;
              else if (r >= dlo && r <= dhi && s >= rlo && s <= rhi) cands[nc2++] = -1 - x;
            }
            if (!nc2) continue;
            let c = cands[(rand() * nc2) | 0];
            const takeSub = c >= 0; if (!takeSub) c = -1 - c;
            const p0 = pos[c], p1 = pos[c] + size[c];
            for (let oi = 0; oi < m; oi++) {
              const inSub = oi >= p0 && oi < p1;
              if (inSub === takeSub) assign[nodes[order[oi]]] = d;
            }
            remPop -= takeSub ? sub[c] : remPop - sub[c];
            done = true;
          }
          for (let i = 0; i < m; i++) loc[nodes[i]] = -1;
          if (!done) return false;
        }
        for (let u = 0; u < n; u++) if (assign[u] < 0) assign[u] = k - 1;
        return true;
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
            if (loc[y] < 0 && (assign[y] === A || assign[y] === B)) { loc[y] = m; nodes[m++] = y; }
          }
        }
        let le = 0;
        for (let i = 0; i < m; i++) {
          const x = nodes[i];
          for (let j = start[x]; j < start[x + 1]; j++) {
            const l2 = loc[nbr[j]];
            if (l2 > i) { la[le] = i; lb[le] = l2; lw[le] = nlen[j]; le++; }
          }
        }
        const tot = dPop[A] + dPop[B];
        // In the balance phase allow anything that is no worse than now.
        let plo = lo, phi = hi;
        if (phase === "balance") {
          const worst = Math.max(Math.abs(dPop[A] - ideal), Math.abs(dPop[B] - ideal));
          if (worst <= ideal * tol) { cleanup(m); return false; }
          plo = Math.min(lo, ideal - worst); phi = Math.max(hi, ideal + worst);
        }
        let nc2 = 0;
        for (let attempt = 0; attempt < 3 && nc2 === 0; attempt++) {
          if (!randomTree(m, le)) break;
          subtreeSums(m, nodes);
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
        // label that keeps most of A in A (stable colors)
        const lab1 = overlapA * 2 >= size[c] ? A : B, lab0 = lab1 === A ? B : A;
        // new stats
        let p1v = 0, p0v = 0, d1 = 0, d0 = 0, r1 = 0, r0 = 0, a1 = 0, a0 = 0, per1 = 0, per0 = 0, c1 = 0, c0 = 0;
        for (let i = 0; i < m; i++) {
          const x = nodes[i];
          if (side[i]) { p1v += pop[x]; d1 += dem[x]; r1 += rep[x]; a1 += area[x]; per1 += border[x]; c1++; }
          else { p0v += pop[x]; d0 += dem[x]; r0 += rep[x]; a0 += area[x]; per0 += border[x]; c0++; }
        }
        for (let i = 0; i < le; i++) {
          if (side[la[i]] === side[lb[i]]) { if (side[la[i]]) per1 -= 2 * lw[i]; else per0 -= 2 * lw[i]; }
        }
        // apply tentatively
        const old = [dPop[A], dDem[A], dRep[A], dArea[A], dPerim[A], dCnt[A], dPop[B], dDem[B], dRep[B], dArea[B], dPerim[B], dCnt[B]];
        const oldE = curE;
        const oldSplits = splits;
        let nch = 0;
        for (let i = 0; i < m; i++) {
          const x = nodes[i], nl = side[i] ? lab1 : lab0;
          if (assign[x] !== nl) { changed[nch++] = x; moveCounty(x, assign[x], nl); assign[x] = nl; }
        }
        setStats(lab1, p1v, d1, r1, a1, per1, c1);
        setStats(lab0, p0v, d0, r0, a0, per0, c0);
        const newE = totalE();
        cleanup(m);
        if (accept(newE - oldE) && lockOk(shares)) { curE = newE; return true; }
        // revert
        for (let i = 0; i < nch; i++) {
          const x = changed[i], back = assign[x] === A ? B : A;
          moveCounty(x, assign[x], back); assign[x] = back;
        }
        dPop[A] = old[0]; dDem[A] = old[1]; dRep[A] = old[2]; dArea[A] = old[3]; dPerim[A] = old[4]; dCnt[A] = old[5];
        dPop[B] = old[6]; dDem[B] = old[7]; dRep[B] = old[8]; dArea[B] = old[9]; dPerim[B] = old[10]; dCnt[B] = old[11];
        splits = oldSplits;
        return false;
      }
      function cleanup(m) { for (let i = 0; i < m; i++) loc[nodes[i]] = -1; }
      function setStats(d, p, de, r, a, per, c) { dPop[d] = p; dDem[d] = de; dRep[d] = r; dArea[d] = a; dPerim[d] = per; dCnt[d] = c; }
      function moveCounty(x, from, to) {
        const c = county[x];
        if (--cd[c * k + from] === 0) { cPresent[c]--; if (cPresent[c] >= 1) splits--; }
        if (cd[c * k + to]++ === 0) { cPresent[c]++; if (cPresent[c] > 1) splits++; }
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
        const oldPen = popPen(dPop[A]) + popPen(dPop[B]);
        const newPen = popPen(nA) + popPen(nB);
        if (newPen > oldPen + 1e-9) {
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
        const oldE = curE, oldSplits = splits;
        const old = [dPop[A], dDem[A], dRep[A], dArea[A], dPerim[A], dCnt[A], dPop[B], dDem[B], dRep[B], dArea[B], dPerim[B], dCnt[B]];
        setStats(A, nA, dDem[A] - dem[u], dRep[A] - rep[u], dArea[A] - area[u], dPerim[A] - border[u] + 2 * inA, dCnt[A] - 1);
        setStats(B, nB, dDem[B] + dem[u], dRep[B] + rep[u], dArea[B] + area[u], dPerim[B] + border[u] - 2 * inB, dCnt[B] + 1);
        moveCounty(u, A, B); assign[u] = B;
        const newE = totalE();
        if (accept(newE - oldE) && lockOk(shares)) { curE = newE; return true; }
        moveCounty(u, B, A); assign[u] = A;
        dPop[A] = old[0]; dDem[A] = old[1]; dRep[A] = old[2]; dArea[A] = old[3]; dPerim[A] = old[4]; dCnt[A] = old[5];
        dPop[B] = old[6]; dDem[B] = old[7]; dRep[B] = old[8]; dArea[B] = old[9]; dPerim[B] = old[10]; dCnt[B] = old[11];
        splits = oldSplits;
        return false;
      }
      // Does district A stay connected if u leaves it?
      function stillConnectedWithout(u, A) {
        let targets = 0, first = -1;
        stampId++;
        for (let j = start[u]; j < start[u + 1]; j++) {
          const y = nbr[j];
          if (assign[y] === A && stamp[y] !== stampId) { stamp[y] = stampId; targets++; if (first < 0) first = y; }
        }
        if (targets <= 1) return targets === 1;
        const tgt = stampId; stampId++;
        let qh = 0, qt = 0, found = 1;
        queue[qt++] = first; stamp[first] = stampId; stamp[u] = stampId;
        while (qh < qt) {
          const x = queue[qh++];
          for (let j = start[x]; j < start[x + 1]; j++) {
            const y = nbr[j];
            if (assign[y] !== A || stamp[y] === stampId) continue;
            if (stamp[y] === tgt) { found++; if (found === targets) return true; }
            stamp[y] = stampId; queue[qt++] = y;
          }
        }
        return false;
      }

      function accept(dE) {
        proposals++;
        if (dE <= 0 || rand() < Math.exp(-dE / T)) { accepted++; return true; }
        return false;
      }

      // ----- phases -----
      let curE = 0;
      function snapshotBest() {
        if (!best) best = { assign: new Int32Array(n), E: Infinity };
        best.assign.set(assign); best.E = curE;
      }
      function restore(a) { assign.set(a); recomputeAll(); curE = totalE(); }

      function enterPhase(p) {
        phase = p; phaseStep = 0; best = null;
        if (p === "balance") {
          wPart = 0; wComp = 0; wCty = 0; T0 = 0.05; T1 = 0.001; phaseBudget = Math.max(20000, searchBudget); recomProb = 0.3;
        } else if (p === "search") {
          wPart = 1; wComp = tune.searchComp; wCty = wCounty * tune.searchComp; T0 = tune.searchT0; T1 = tune.searchT1; phaseBudget = searchBudget; recomProb = tune.searchRecom;
          lock = null;
          if (mode === "maxD" || mode === "maxR") { startNextTarget(true); }
        } else if (p === "polish") {
          wPart = 0; wComp = 1; wCty = wCounty;
          T0 = tune.polishT0; T1 = tune.polishT1; phaseBudget = polishBudget; recomProb = mode === "neutral" ? tune.neutralRecom : tune.polishRecom;
          fillShares();
          const o = outcome(shares);
          lock = mode === "neutral" ? null : { safeD: o.safeD, safeR: o.safeR, comp: o.comp };
        }
        softPop = p === "polish" || p === "final";
        wPop = p === "final" ? 1e6 : 1000;
        if (p === "final") { T0 = T1 = 1e-4; phaseBudget = Math.max(30000, 4 * n); recomProb = 0; }
        curE = totalE();
        T = T0;
        if (p === "polish") snapshotBest();
      }
      function startNextTarget(first) {
        fillShares();
        const o = outcome(shares);
        if (mode === "maxD") { maxTarget = first ? o.safeD + 1 : maxTarget + 1; needD = Math.min(k, maxTarget); needR = 0; }
        else { maxTarget = first ? o.safeR + 1 : maxTarget + 1; needR = Math.min(k, maxTarget); needD = 0; }
        targetSteps = 0; phaseStep = 0;
        curE = totalE();
      }
      function goalMet() {
        if (mode === "neutral") return true;
        if (mode === "competitive") return false;
        return partisanE(shares) === 0;
      }

      function init() {
        let t = userTol, ok = false;
        for (let tries = 0; tries < 8 && !ok; tries++) {
          ok = initialPlan(t);
          if (!ok) t = Math.min(0.1, t * 1.6);
        }
        if (!ok) throw new Error("Couldn't build a starting map. Try fewer districts or a looser population tolerance.");
        recomputeAll();
        if (t > userTol) notes.push("Started with a looser population tolerance (±" + (t * 100).toFixed(1) + "%) and tightened it.");
        let worst = 0;
        for (let d = 0; d < k; d++) worst = Math.max(worst, Math.abs(dPop[d] - ideal) / ideal);
        setTol(userTol);
        if (mode === "neutral") goal = { achieved: true, text: "No partisan goal: equal-population, compact districts" };
        if (worst > userTol) enterPhase("balance");
        else enterPhase(mode === "neutral" ? "polish" : "search");
      }

      function stepOnce() {
        stepCount++; phaseStep++;
        const frac = Math.min(1, phaseStep / phaseBudget);
        T = T0 * Math.pow(T1 / T0, frac);
        if (rand() < recomProb) recomMove(); else flipMove();

        if (phase === "balance") {
          if (popE() === 0) { enterPhase(mode === "neutral" ? "polish" : "search"); return; }
          if (phaseStep >= phaseBudget) {
            let worst = 0;
            for (let d = 0; d < k; d++) worst = Math.max(worst, Math.abs(dPop[d] - ideal) / ideal);
            notes.push("Couldn't reach ±" + (userTol * 100).toFixed(2) + "% population balance with whole precincts; best was ±" + (worst * 100).toFixed(2) + "%.");
            setTol(worst + 1e-9);
            enterPhase(mode === "neutral" ? "polish" : "search");
          }
        } else if (phase === "search") {
          searchTotal++;
          fillShares();
          if (mode === "maxD" || mode === "maxR") {
            targetSteps++;
            if (partisanE(shares) === 0) {
              bestAchievedT = maxTarget;
              if (!bestAchievedAssign) bestAchievedAssign = new Int32Array(n);
              bestAchievedAssign.set(assign);
              if (maxTarget >= k) { finishSearch(true); return; }
              startNextTarget(false);
              T = T0 * 0.5;
            } else if (targetSteps >= phaseBudget || searchTotal >= phaseBudget * 4) {
              if (bestAchievedAssign) restore(bestAchievedAssign);
              finishSearch(bestAchievedAssign != null);
            }
            return;
          }
          if (goalMet()) { finishSearch(true); return; }
          // remember the best partisan plan in case the goal can't be reached
          const pe = partisanE(shares);
          if (!best || pe < best.E) { if (!best) best = { assign: new Int32Array(n), E: pe }; best.assign.set(assign); best.E = pe; }
          if (phaseStep >= phaseBudget) {
            restore(best.assign);
            finishSearch(false);
          }
        } else if (phase === "polish") {
          // ramp the population penalty: loose early, strict at the end
          if ((phaseStep & 255) === 0) { wPop = tune.popW0 * Math.pow(tune.popW1 / tune.popW0, frac); curE = totalE(); }
          if (curE < best.E - 1e-12 && popE() === 0) snapshotBest();
          if (phaseStep >= phaseBudget) {
            const keep = best;
            enterPhase("final");
            best = keep;
          }
        } else if (phase === "final") {
          // strict rebalancing of the polished map, then keep whichever valid map is better
          if (popE() === 0) {
            if (curE > best.E) restore(best.assign);
            phase = "done";
          } else if (phaseStep >= phaseBudget) {
            restore(best.assign);
            phase = "done";
          }
        }
      }

      function finishSearch(achieved) {
        fillShares();
        const o = outcome(shares);
        const margin = h > 0 ? " by " + (h * 200).toFixed(0) + "+ points" : "";
        if (mode === "maxD") goal = { achieved: bestAchievedT > 0, text: "Most Democratic seats found: " + o.safeD + " of " + k + (margin ? " (won" + margin + ")" : "") };
        else if (mode === "maxR") goal = { achieved: bestAchievedT > 0, text: "Most Republican seats found: " + o.safeR + " of " + k + (margin ? " (won" + margin + ")" : "") };
        else if (mode === "competitive") goal = { achieved: true, text: o.comp + " of " + k + " districts within " + (band * 200).toFixed(0) + " points" };
        else {
          const want = needD + " D / " + needR + " R" + margin;
          goal = achieved
            ? { achieved: true, text: "Reached " + want }
            : { achieved: false, text: "Couldn't reach " + want + ". Closest map found: " + o.safeD + " D / " + o.safeR + " R" + margin + "." };
        }
        enterPhase("polish");
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
              if (assign[y] !== d) continue;
              if (nlen[j] === 0) usesBridge[d] = 1;
              if (!seen[y]) { seen[y] = 1; queue[qt++] = y; }
            }
          }
        }
        const broken = [];
        for (let d = 0; d < k; d++) if (comps[d] !== 1) broken.push(d);
        return { ok: broken.length === 0, broken, pieces: Array.from(comps), water: Array.from(usesBridge) };
      }

      function report() {
        fillShares();
        const o = outcome(shares);
        const districts = [];
        let wastedD = 0, wastedR = 0, votes = 0, maxDev = 0, ppSum = 0;
        for (let d = 0; d < k; d++) {
          const t = dDem[d] + dRep[d];
          const pp = dPerim[d] > 0 ? (FOUR_PI * dArea[d]) / (dPerim[d] * dPerim[d]) : 0;
          const dev = (dPop[d] - ideal) / ideal;
          maxDev = Math.max(maxDev, Math.abs(dev));
          ppSum += pp;
          const need = Math.floor(t / 2) + 1;
          if (dDem[d] > dRep[d]) { wastedD += dDem[d] - need; wastedR += dRep[d]; } else { wastedR += dRep[d] - need; wastedD += dDem[d]; }
          votes += t;
          let ncty = 0;
          for (let c = 0; c < nc; c++) if (cd[c * k + d] > 0) ncty++;
          districts.push({ id: d, pop: dPop[d], dev, dem: dDem[d], rep: dRep[d], share: shares[d], pp, area: dArea[d], precincts: dCnt[d], counties: ncty });
        }
        const sorted = Array.from(shares).sort((a, b) => a - b);
        const median = k % 2 ? sorted[(k - 1) / 2] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2;
        const mean = sorted.reduce((a, b) => a + b, 0) / k;
        let splitCounties = 0;
        for (let c = 0; c < nc; c++) if (cPresent[c] > 1) splitCounties++;
        return {
          phase, step: stepCount, k, ideal, tol, userTol, stateShare,
          seats: o, districts, maxDev, meanPP: ppSum / k,
          efficiencyGap: (wastedD - wastedR) / votes, // >0 means Dem votes are wasted more (map favors R)
          meanMedian: median - mean,                  // <0 means map favors R
          splitCounties, countySplits: splits,
          contiguity: verifyContiguity(),
          goal: phase === "search" || phase === "balance" || phase === "init" ? progressGoal() : goal,
          acceptRate: proposals ? accepted / proposals : 0,
          notes: notes.slice(),
          phaseProgress: Math.min(1, phaseStep / phaseBudget),
          target: { needD, needR },
        };
      }
      function progressGoal() {
        if (phase !== "search") return { achieved: false, text: phase === "balance" ? "Balancing population" : "" };
        if (mode === "maxD") return { achieved: false, text: "Trying for " + needD + " Democratic seats" };
        if (mode === "maxR") return { achieved: false, text: "Trying for " + needR + " Republican seats" };
        if (mode === "competitive") return { achieved: false, text: "Making districts competitive" };
        return { achieved: false, text: "Aiming for " + needD + " D / " + needR + " R" };
      }

      return {
        n, k, ideal,
        assign,
        init,
        get phase() { return phase; },
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
        finishNow() {
          // skip to the next phase
          if (phase === "polish" || phase === "final") { restore(best.assign); phase = "done"; }
          else if (phase === "search" || phase === "balance") { phaseStep = phaseBudget; targetSteps = phaseBudget; searchTotal = Infinity; stepOnce(); }
        },
        report,
        verifyContiguity,
        _debug: { recomputeAll, dPop, dPerim, dArea, totalE, get curE() { return curE; }, get splits() { return splits; } },
      };
    }

    return { makeRng, buildGraph, createEngine };
  }

  // Web Worker entry point. Stringified and run from a Blob URL, so it works from file:// too.
  function workerMain(self, factory) {
    const lib = factory();
    let eng = null, running = false, timer = null;
    function post(type) {
      const rep = eng.report();
      const a = new Int16Array(eng.assign);
      self.postMessage({ type, report: rep, assign: a }, [a.buffer]);
    }
    function loop() {
      timer = null;
      if (!running || !eng) return;
      let done = false;
      try { done = eng.run(120); } catch (err) { running = false; self.postMessage({ type: "error", message: String(err && err.message || err) }); return; }
      post(done ? "done" : "progress");
      if (done) { running = false; return; }
      timer = setTimeout(loop, 0);
    }
    self.onmessage = function (ev) {
      const msg = ev.data;
      try {
        if (msg.cmd === "init") {
          running = false;
          eng = lib.createEngine(msg.graph, msg.opts);
          eng.init();
          post("ready");
        } else if (msg.cmd === "run") {
          running = true; if (!timer) timer = setTimeout(loop, 0);
        } else if (msg.cmd === "pause") {
          running = false;
          if (eng) post("paused");
        } else if (msg.cmd === "finish") {
          if (eng) { eng.finishNow(); running = eng.phase !== "done"; post(eng.phase === "done" ? "done" : "progress"); if (running && !timer) timer = setTimeout(loop, 0); }
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
