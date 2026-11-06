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

console.log("state data files");
const EXPECT = {
  TX: { pop: 29145505, seats: 38, share: 0.4305 },
  CA: { pop: 39538223, seats: 52, share: 0.6040 },
  PA: { pop: 13002700, seats: 17, share: 0.4914 },
  FL: { pop: 21538187, seats: 28, share: 0.4339 },
  NC: { pop: 10439388, seats: 14, share: 0.4836 },
  MI: { pop: 10077331, seats: 13, share: 0.4928 },
  VA: { pop: 8631393, seats: 11, share: 0.5295 },
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

test("PA: a quick real run gives contiguous block districts within ±0.1%", () => {
  const { graph } = loaded.PA;
  const g = RE.buildGraph(graph);
  const p = RE.createPipeline(g, graph.group, { k: 17, mode: "proportional", margin: 0, tol: 0.001, seed: 2, searchSteps: 4000, coarsePolishSteps: 30000, finePolishSteps: 100000 });
  p.init();
  while (!p.run(5000));
  const r = p.report(true);
  assert.ok(r.contiguity.ok);
  assert.ok(connectedParts(g, p.assignment(), 17).every((c) => c === 1));
  assert.ok(r.maxDev <= 0.001 + 1e-9, String(r.maxDev));
});

console.log("\n" + passed + " passed" + (process.exitCode ? ", some FAILED" : ""));
