// Run with: node tests/redistrict.test.js
// Checks the redistricting engine on a synthetic grid and on the real state files.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
global.window = global;
const RE = require("../js/redistrict/engine.js");
const { loadState, unpack } = require("./load-state.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e.message)); process.exitCode = 1; }
}

// W x H grid of 1 km squares. Left half leans D, right half leans R.
// group = 3x3 squares, standing in for precincts.
function grid(W, H) {
  const n = W * H, d = { n, pop: [], dem: [], rep: [], area: [], ext: [], county: [], eu: [], ev: [], elen: [], group: [] };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = y * W + x;
    d.pop.push(100);
    const lean = x < W / 2 ? 60 : 40;
    d.dem.push(lean); d.rep.push(100 - lean);
    d.area.push(1e6);
    d.ext.push(1000 * ((x === 0) + (x === W - 1) + (y === 0) + (y === H - 1)));
    d.county.push(Math.floor(x / 5) + 10 * Math.floor(y / 5));
    d.group.push(Math.floor(x / 3) + 100 * Math.floor(y / 3));
    if (x + 1 < W) { d.eu.push(u); d.ev.push(u + 1); d.elen.push(1000); }
    if (y + 1 < H) { d.eu.push(u); d.ev.push(u + W); d.elen.push(1000); }
  }
  return d;
}

function connectedParts(g, assign, k) {
  const seen = new Uint8Array(g.n), parts = new Array(k).fill(0);
  for (let s = 0; s < g.n; s++) {
    if (seen[s]) continue;
    parts[assign[s]]++;
    const q = [s]; seen[s] = 1;
    while (q.length) {
      const x = q.pop();
      for (let j = g.start[x]; j < g.start[x + 1]; j++) {
        const y = g.nbr[j];
        if (!seen[y] && assign[y] === assign[x]) { seen[y] = 1; q.push(y); }
      }
    }
  }
  return parts;
}

function finish(e) {
  let guard = 0;
  while (!e.run(1000)) { if (++guard > 600) throw new Error("did not finish"); }
  return e;
}
function run(g, opts) {
  const e = RE.createEngine(g, Object.assign({ seed: 3, searchSteps: 4000, polishSteps: 8000 }, opts));
  e.init();
  return finish(e);
}

console.log("engine (synthetic 30x30 grid)");
const G = RE.buildGraph(grid(30, 30));

test("neutral run: contiguous, balanced, every unit assigned", () => {
  const e = run(G, { k: 6, mode: "neutral", tol: 0.02 });
  const r = e.report(true);
  assert.strictEqual(r.phase, "done");
  assert.ok(r.contiguity.ok, "contiguity");
  assert.ok(connectedParts(G, e.assign, 6).every((c) => c === 1), "independent BFS check");
  assert.ok(r.maxDev <= 0.02 + 1e-9, "population within tolerance: " + r.maxDev);
  for (let u = 0; u < G.n; u++) assert.ok(e.assign[u] >= 0 && e.assign[u] < 6);
  assert.strictEqual(r.districts.reduce((a, x) => a + x.pop, 0), 90000);
});

test("incremental district stats match a full recompute", () => {
  const e = run(G, { k: 5, mode: "maxD", tol: 0.02 });
  const per = Array.from(e._debug.dPerim), pop = Array.from(e._debug.dPop), comp = e._debug.compSum;
  e._debug.recomputeAll();
  Array.from(e._debug.dPerim).forEach((p, i) => assert.ok(Math.abs(p - per[i]) < 1e-6, "perimeter " + i));
  Array.from(e._debug.dPop).forEach((p, i) => assert.strictEqual(p, pop[i]));
  assert.ok(Math.abs(e._debug.compSum - comp) < 1e-6 * Math.max(1, comp), "compactness sum");
});

test("same seed gives the same map", () => {
  const a = run(G, { k: 4, mode: "neutral", tol: 0.02, seed: 11 });
  const b = run(G, { k: 4, mode: "neutral", tol: 0.02, seed: 11 });
  assert.deepStrictEqual(Array.from(a.assign), Array.from(b.assign));
});

test("exact seat target is reached and kept through the compactness phase", () => {
  const e = run(G, { k: 6, mode: "target", targetD: 2, margin: 2, tol: 0.02 });
  const r = e.report(true);
  assert.ok(r.goal.achieved, r.goal.text);
  assert.strictEqual(r.seats.safeD, 2);
  assert.strictEqual(r.seats.safeR, 4);
  assert.ok(r.contiguity.ok);
});

test("gerrymander: safe seats, then wins, then each district pushed toward the floor", () => {
  const e = run(G, { k: 6, mode: "maxD", margin: 4, tol: 0.02, searchSteps: 6000 });
  const r = e.report(true);
  const m = r.districts.map((d) => 200 * d.share - 100).sort((a, b) => b - a);
  assert.strictEqual(r.gerry.safe, m.filter((x) => x >= 4).length);
  assert.strictEqual(r.gerry.wins, m.filter((x) => x > 0).length);
  assert.deepStrictEqual(r.gerry.margins.map((x) => x.toFixed(6)), m.map((x) => x.toFixed(6)));
  assert.ok(r.gerry.safe >= 1);
  assert.ok(r.gerry.margins.slice(0, r.gerry.safe).every((x) => x >= 4 - 1e-6), "safe seats stay at or above the floor");
  assert.ok(r.contiguity.ok);
});

test("gerrymander: the district-by-district stage never gives back a seat", () => {
  // compare with a run that stops after the seat counts (district stage off via a huge k cap is not
  // exposed, so check the invariant directly: wins after the run >= wins locked during search)
  const e = RE.createEngine(G, { k: 6, mode: "maxR", margin: 4, tol: 0.02, seed: 8, searchSteps: 6000, polishSteps: 6000 });
  e.init();
  let winsSeen = -1;
  while (!e.run(200)) {
    const r = e.report(false);
    if (r.phase !== "search" && winsSeen < 0) winsSeen = r.gerry.wins;
    if (winsSeen >= 0) assert.ok(r.gerry.wins >= winsSeen, "wins dropped");
  }
  assert.ok(e.report(false).gerry.wins >= winsSeen);
});

test("max-D beats max-R in Democratic seats", () => {
  const d = run(G, { k: 6, mode: "maxD", tol: 0.02 }).report(true);
  const r = run(G, { k: 6, mode: "maxR", tol: 0.02 }).report(true);
  assert.ok(d.seats.winD > r.seats.winD, d.seats.winD + " vs " + r.seats.winD);
});

test("ignoring compactness still gives contiguous, balanced districts", () => {
  const e = run(G, { k: 6, mode: "maxD", tol: 0.02, compact: false });
  const r = e.report(true);
  assert.ok(r.contiguity.ok);
  assert.ok(connectedParts(G, e.assign, 6).every((c) => c === 1));
  assert.ok(r.maxDev <= 0.02 + 1e-9);
});

test("many districts: 150 districts on 900 units", () => {
  const e = run(G, { k: 150, mode: "neutral", tol: 0.05 });
  const r = e.report(true);
  assert.ok(r.contiguity.ok);
  assert.strictEqual(new Set(e.assign).size, 150);
});

test("two-stage pipeline (groups, then units) keeps the seat result and contiguity", () => {
  const raw = grid(30, 30);
  const p = RE.createPipeline(G, raw.group, { k: 4, mode: "target", targetD: 1, margin: 2, tol: 0.01, seed: 5, searchSteps: 4000, coarsePolishSteps: 4000, finePolishSteps: 4000 });
  p.init();
  assert.ok(p.useCoarse);
  let guard = 0;
  while (!p.run(1000)) { if (++guard > 600) throw new Error("did not finish"); }
  const r = p.report(true);
  assert.strictEqual(r.stage, "block");
  assert.ok(r.contiguity.ok);
  assert.strictEqual(r.seats.safeD, 1);
  assert.ok(r.maxDev <= 0.01 + 1e-9, String(r.maxDev));
});

// seats away from a 1-for-1 seats-votes line, averaged over uniform swings of -10..+10 points
function seatGap(r) {
  const sh = r.districts.map((d) => d.share);
  let g = 0, m = 0;
  for (let i = -100; i <= 100; i++) {
    const x = i / 1000, seats = sh.filter((s) => s + x > 0.5).length;
    g += Math.abs(seats - Math.round(r.k * (r.stateShare + x))); m++;
  }
  return g / m;
}

test("proportional: after the seat split, the seats-votes curve is pulled toward the 1-for-1 line", () => {
  // uneven leans and turnout, so districts can be spread out
  const raw = grid(30, 30);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
    const u = y * 30 + x, votes = 50 + ((x * 3 + y * 5) % 7) * 8, lean = (33 + x + ((x * 7 + y * 13) % 11) - 5) / 100;
    raw.dem[u] = votes * lean; raw.rep[u] = votes * (1 - lean);
  }
  const g = RE.buildGraph(raw);
  const o = { k: 7, tol: 0.02, seed: 4, searchSteps: 6000, polishSteps: 8000 };
  const prop = RE.createEngine(g, Object.assign({ mode: "proportional" }, o));
  prop.init();
  let atLock = null;
  while (!prop.steps(20)) { if (atLock == null && prop.phase !== "search") atLock = prop.report(false).curveDev; }
  const r = prop.report(true);
  const plain = run(g, Object.assign({ mode: "target", targetD: r.target.needD }, o)).report(true);
  assert.ok(r.goal.achieved, r.goal.text);
  assert.strictEqual(r.seats.safeD, r.target.needD);
  assert.ok(r.contiguity.ok);
  assert.ok(r.curveDev <= atLock + 0.25 + 1e-9, "compactness phase kept the curve: " + r.curveDev + " vs " + atLock);
  assert.ok(r.curveDev < plain.curveDev, "closer to the line than seats alone: " + r.curveDev.toFixed(2) + " vs " + plain.curveDev.toFixed(2));
  assert.ok(seatGap(r) <= seatGap(plain), "seats track swings at least as well: " + seatGap(r).toFixed(2) + " vs " + seatGap(plain).toFixed(2));
});

test("superthinking: cycles keep the best map, never get worse, and stop cleanly", () => {
  const raw = grid(30, 30);
  const e = RE.createEndless(G, raw.group, { k: 6, mode: "maxD", margin: 0, tol: 0.02, seed: 9, searchSteps: 1500, coarsePolishSteps: 1500, finePolishSteps: 1500, endless: true });
  e.init();
  let last = null, improvements = 0;
  for (let i = 0; i < 400 && e.cycle < 6; i++) {
    assert.strictEqual(e.run(200), false, "never finishes on its own");
    const b = e.takeImproved();
    if (b) {
      improvements++;
      if (last) assert.ok(b.report.seats.safeD >= last.report.seats.safeD, "seat count never drops");
      last = b;
    }
  }
  assert.ok(e.cycle >= 6, "ran several cycles");
  assert.ok(improvements >= 1);
  e.stop();
  assert.strictEqual(e.phase, "done");
  const r = e.report(true);
  assert.ok(r.contiguity.ok);
  assert.ok(r.maxDev <= 0.02 + 1e-9);
  assert.strictEqual(r.seats.safeD, last.report.seats.safeD);
  assert.ok(connectedParts(G, e.assignment(), 6).every((c) => c === 1));
});

test("apply new settings to an existing map: starts from it, stays valid", () => {
  const raw = grid(30, 30);
  const base = { k: 5, tol: 0.02, seed: 4, searchSteps: 3000, coarsePolishSteps: 3000, finePolishSteps: 3000 };
  const p1 = RE.createPipeline(G, raw.group, Object.assign({}, base, { mode: "neutral" }));
  p1.init(); while (!p1.run(1000));
  const first = Int32Array.from(p1.assignment());
  // same settings, started from that map: the map barely changes
  const p2 = RE.createPipeline(G, raw.group, Object.assign({}, base, { mode: "neutral", seed: 9, startAssign: first }));
  p2.init(); while (!p2.run(1000));
  const same = p2.assignment().reduce((a, d, u) => a + (d === first[u] ? 1 : 0), 0) / G.n;
  assert.ok(same > 0.6, "kept most of the map: " + same.toFixed(2));
  // new goal on top of it: still contiguous and balanced
  const p3 = RE.createPipeline(G, raw.group, Object.assign({}, base, { mode: "maxR", margin: 2, startAssign: first }));
  p3.init(); while (!p3.run(1000));
  const r = p3.report(true);
  assert.ok(r.contiguity.ok && r.maxDev <= 0.02 + 1e-9);
  // superthinking can start from it too
  const e = RE.createEndless(G, raw.group, Object.assign({}, base, { mode: "neutral", startAssign: first, endless: true }));
  e.init(); e.run(300); e.stop();
  assert.ok(e.report(true).contiguity.ok);
});

console.log("state data files");
const EXPECT = {
  TX: { pop: 29145505, seats: 38, share: 0.4305 },
  CA: { pop: 39538223, seats: 52, share: 0.6040 },
  PA: { pop: 13002700, seats: 17, share: 0.4914 },
  FL: { pop: 21538187, seats: 28, share: 0.4339 },
  NC: { pop: 10439388, seats: 14, share: 0.4836 },
  MI: { pop: 10077331, seats: 13, share: 0.4928 },
  VA: { pop: 8631393, seats: 11, share: 0.5295 },
  OH: { pop: 11799448, seats: 15, share: 0.4434 },
  GA: { pop: 10711908, seats: 14, share: 0.4890 },
  NV: { pop: 3104614, seats: 4, share: 0.4844 },
  WI: { pop: 5893718, seats: 8, share: 0.4956 },
  AZ: { pop: 7151502, seats: 9, share: 0.4721 },
  NY: { pop: 20201249, seats: 26, share: 0.5634 },
  IL: { pop: 12812508, seats: 17, share: 0.5556 },
  MN: { pop: 5706494, seats: 8, share: 0.5217 },
  CO: { pop: 5773714, seats: 8, share: 0.5564 },
  OR: { pop: 4237256, seats: 6, share: 0.5743 },
  WA: { pop: 7705281, seats: 10, share: 0.5948 },
  NH: { pop: 1377529, seats: 2, share: 0.5141 },
  MD: { pop: 6177224, seats: 8, share: 0.6475 },
  MA: { pop: 7029917, seats: 9, share: 0.6295 },
  NJ: { pop: 9288994, seats: 12, share: 0.5293 },
  TN: { pop: 6910840, seats: 9, share: 0.3494 },
  IN: { pop: 6785528, seats: 9, share: 0.4034 },
  MO: { pop: 6154913, seats: 8, share: 0.4066 },
  SC: { pop: 5118425, seats: 7, share: 0.4093 },
  AL: { pop: 5024279, seats: 7, share: 0.3457 },
  MT: { pop: 1084225, seats: 2, share: 0.3971 },
  KY: { pop: 4505836, seats: 6, share: 0.3449 },
  LA: { pop: 4657757, seats: 6, share: 0.3882 },
  IA: { pop: 3190369, seats: 4, share: 0.4328 },
};
const loaded = {};
for (const st of Object.keys(EXPECT)) {
  test(st + ": decodes; population matches the 2020 Census exactly", () => {
    loaded[st] = loadState(st);
    const { meta, A } = loaded[st];
    for (const k of Object.keys(meta.arrays)) if (k !== "dv" && k !== "elen") assert.strictEqual(A[k].length, meta.n, k);
    assert.strictEqual(A.dv.length, meta.nEdges);
    assert.strictEqual(A.pop.reduce((a, b) => a + b, 0), EXPECT[st].pop);
    assert.strictEqual(meta.seats, EXPECT[st].seats);
  });
  test(st + ": block graph is connected", () => {
    const g = RE.buildGraph(loaded[st].graph);
    const seen = new Uint8Array(g.n); const q = [0]; seen[0] = 1; let c = 1;
    while (q.length) { const x = q.pop(); for (let j = g.start[x]; j < g.start[x + 1]; j++) if (!seen[g.nbr[j]]) { seen[g.nbr[j]] = 1; c++; q.push(g.nbr[j]); } }
    assert.strictEqual(c, g.n);
  });
  test(st + ": block vote estimates add up to the 2024 precinct results", () => {
    const { meta, graph } = loaded[st];
    const dem = graph.dem.reduce((a, b) => a + b, 0), rep = graph.rep.reduce((a, b) => a + b, 0);
    const pd = meta.precincts.dem.reduce((a, b) => a + b, 0), pr = meta.precincts.rep.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(dem - pd) / pd < 1e-4 && Math.abs(rep - pr) / pr < 1e-4, dem + " / " + pd);
    assert.ok(Math.abs(dem / (dem + rep) - EXPECT[st].share) < 0.003);
  });
  test(st + ": map images cover every populated block and the tiles exist", () => {
    const { meta } = loaded[st];
    const R = meta.raster;
    const over = unpack("i32", R.overview.data);
    assert.strictEqual(over.length, R.overview.w * R.overview.h);
    for (const t of R.detail.tiles) {
      const r = Math.floor(t / R.detail.cols), c = t % R.detail.cols;
      assert.ok(fs.existsSync(path.join(__dirname, "..", "data", "redistricting", st.toLowerCase(), "t" + r + "_" + c + ".js")), "tile " + r + "," + c);
    }
  });
}

// Independent check from the raw census data: within each district, land blocks
// connect through land borders, plus the links for land cut off by water. No other
// crossing of water counts.
function landContiguous(st, blockAssign, k) {
  const { meta, A } = loaded[st];
  const n = meta.n, parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const join = (a, b) => { if (A.water[a] || A.water[b] || blockAssign[a] !== blockAssign[b]) return; parent[find(a)] = find(b); };
  let e = 0;
  for (let u = 0; u < n; u++) for (let j = 0; j < A.deg[u]; j++, e++) join(u, u + A.dv[e]); // includes old zero-length island links
  const br = meta.landBridges;
  for (let i = 0; i < br.length; i += 2) join(br[i], br[i + 1]);
  const roots = new Array(k).fill(null).map(() => new Set());
  for (let u = 0; u < n; u++) if (!A.water[u]) roots[blockAssign[u]].add(find(u));
  if (!roots.every((r) => r.size === 1)) return false;
  // stricter: on each land mass, each district is a single piece over land
  // (no part of a district stranded inside another, reachable only across water)
  const mp = new Int32Array(n), lp = new Int32Array(n);
  for (let i = 0; i < n; i++) { mp[i] = i; lp[i] = i; }
  const f2 = (p, x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  e = 0;
  for (let u = 0; u < n; u++) for (let j = 0; j < A.deg[u]; j++, e++) {
    const v = u + A.dv[e];
    if (A.water[u] || A.water[v] || A.elen[e] === 0) continue;
    mp[f2(mp, u)] = f2(mp, v);
    if (blockAssign[u] === blockAssign[v]) lp[f2(lp, u)] = f2(lp, v);
  }
  const piece = new Map();
  for (let u = 0; u < n; u++) {
    if (A.water[u]) continue;
    const key = blockAssign[u] + "|" + f2(mp, u), p = f2(lp, u);
    if (!piece.has(key)) piece.set(key, p); else if (piece.get(key) !== p) return false;
  }
  return true;
}

test("PA: a quick real run gives districts connected over land, within ±0.1%", () => {
  const { graph } = loaded.PA;
  const g = RE.buildGraph(graph);
  const p = RE.createPipeline(g, graph.group, { k: 17, mode: "proportional", margin: 0, tol: 0.001, seed: 2, searchSteps: 4000, coarsePolishSteps: 30000, finePolishSteps: 100000 });
  p.init();
  while (!p.run(5000));
  const r = p.report(true);
  assert.ok(r.contiguity.ok);
  assert.ok(r.maxDev <= 0.001 + 1e-9, String(r.maxDev));
  assert.ok(landContiguous("PA", RE.expandAssign(graph, p.assignment()), 17), "land-only contiguity");
  assert.ok(r.meanPP > 0.1 && r.meanPP < 1, "compactness in a sane range: " + r.meanPP);
});

test("MI: districts connect over land; the Upper Peninsula only through its water link", () => {
  const { graph } = loaded.MI;
  const g = RE.buildGraph(graph);
  const p = RE.createPipeline(g, graph.group, { k: 13, mode: "neutral", tol: 0.005, seed: 3, searchSteps: 2000, coarsePolishSteps: 20000, finePolishSteps: 50000 });
  p.init();
  while (!p.run(5000));
  assert.ok(p.report(true).contiguity.ok);
  assert.ok(landContiguous("MI", RE.expandAssign(graph, p.assignment()), 13));
});

console.log("\n" + passed + " passed" + (process.exitCode ? ", some FAILED" : ""));
