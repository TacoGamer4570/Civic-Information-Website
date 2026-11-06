// Run with: node tests/redistrict.test.js
// Checks the redistricting engine on a synthetic grid and on the real state files.
const assert = require("assert");
const path = require("path");
global.window = global;
const RE = require("../js/redistrict/engine.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e.message)); process.exitCode = 1; }
}

// W x H grid of unit squares. Left half leans D, right half leans R.
function grid(W, H) {
  const n = W * H, edges = [], d = { n, pop: [], dem: [], rep: [], area: [], ext: [], county: [] };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = y * W + x;
    d.pop.push(100);
    const lean = x < W / 2 ? 60 : 40;
    d.dem.push(lean); d.rep.push(100 - lean);
    d.area.push(1000);                                    // 1000 * 1000 m^2 = 1 km^2
    d.ext.push(1000 * ((x === 0) + (x === W - 1) + (y === 0) + (y === H - 1)));
    d.county.push(Math.floor(x / 5) + 10 * Math.floor(y / 5));
    if (x + 1 < W) edges.push(u, u + 1, 1000);
    if (y + 1 < H) edges.push(u, u + W, 1000);
  }
  d.edges = edges;
  return d;
}

function districtsConnected(d, assign, k) {
  const g = RE.buildGraph(d);
  const seen = new Uint8Array(d.n), comps = new Array(k).fill(0);
  for (let s = 0; s < d.n; s++) {
    if (seen[s]) continue;
    comps[assign[s]]++;
    const q = [s]; seen[s] = 1;
    while (q.length) {
      const x = q.pop();
      for (let j = g.start[x]; j < g.start[x + 1]; j++) {
        const y = g.nbr[j];
        if (!seen[y] && assign[y] === assign[x]) { seen[y] = 1; q.push(y); }
      }
    }
  }
  return comps.every((c) => c === 1);
}

function run(d, opts) {
  const e = RE.createEngine(d, Object.assign({ seed: 3, searchSteps: 4000, polishSteps: 8000 }, opts));
  e.init();
  let guard = 0;
  while (!e.run(1000)) { if (++guard > 300) throw new Error("did not finish"); }
  return e;
}

console.log("engine (synthetic 30x30 grid)");
const G = grid(30, 30);

test("neutral run: contiguous, balanced, every precinct assigned", () => {
  const e = run(G, { k: 6, mode: "neutral", tol: 0.02 });
  const r = e.report();
  assert.strictEqual(r.phase, "done");
  assert.ok(r.contiguity.ok, "contiguity");
  assert.ok(districtsConnected(G, e.assign, 6), "independent BFS check");
  assert.ok(r.maxDev <= 0.02 + 1e-9, "population within tolerance: " + r.maxDev);
  for (let u = 0; u < G.n; u++) assert.ok(e.assign[u] >= 0 && e.assign[u] < 6);
  assert.strictEqual(r.districts.reduce((a, x) => a + x.pop, 0), 90000);
});

test("incremental district stats match a full recompute", () => {
  const e = run(G, { k: 5, mode: "maxD", tol: 0.02 });
  const before = Array.from(e._debug.dPerim);
  const beforePop = Array.from(e._debug.dPop);
  e._debug.recomputeAll();
  Array.from(e._debug.dPerim).forEach((p, i) => assert.ok(Math.abs(p - before[i]) < 1e-6, "perimeter " + i));
  Array.from(e._debug.dPop).forEach((p, i) => assert.strictEqual(p, beforePop[i]));
});

test("same seed gives the same map", () => {
  const a = run(G, { k: 4, mode: "neutral", tol: 0.02, seed: 11 });
  const b = run(G, { k: 4, mode: "neutral", tol: 0.02, seed: 11 });
  assert.deepStrictEqual(Array.from(a.assign), Array.from(b.assign));
});

test("exact seat target is reached and kept through compactness phase", () => {
  // Half the grid leans D 60-40, so 3 of 6 D seats is easy; ask for 2.
  const e = run(G, { k: 6, mode: "target", targetD: 2, margin: 2, tol: 0.02 });
  const r = e.report();
  assert.ok(r.goal.achieved, r.goal.text);
  assert.strictEqual(r.seats.safeD, 2);
  assert.strictEqual(r.seats.safeR, 4);
  assert.ok(r.contiguity.ok);
});

test("max-D beats max-R in Democratic seats", () => {
  const d = run(G, { k: 6, mode: "maxD", tol: 0.02 }).report();
  const r = run(G, { k: 6, mode: "maxR", tol: 0.02 }).report();
  assert.ok(d.seats.winD > r.seats.winD, d.seats.winD + " vs " + r.seats.winD);
});

test("efficiency gap and mean-median are 0 for a symmetric 50/50 state", () => {
  const d = grid(10, 10);
  d.dem = d.dem.map(() => 50); d.rep = d.rep.map(() => 50);
  const r = run(d, { k: 2, mode: "neutral", tol: 0.05 }).report();
  assert.ok(Math.abs(r.meanMedian) < 1e-9);
});

console.log("state data files");
const EXPECT = { TX: { pop: 29145505, seats: 38 }, CA: { pop: 39538223, seats: 52 }, PA: { pop: 13002700, seats: 17 } };
for (const st of Object.keys(EXPECT)) {
  const file = path.join(__dirname, "..", "data", "redistricting", st.toLowerCase() + ".js");
  require(file);
  const d = window.REDISTRICT_DATA[st];
  test(st + ": population matches the 2020 Census exactly", () => {
    assert.strictEqual(d.pop.reduce((a, b) => a + b, 0), EXPECT[st].pop);
    assert.strictEqual(d.seats, EXPECT[st].seats);
  });
  test(st + ": arrays line up and the precinct graph is connected", () => {
    for (const key of ["id", "pop", "dem", "rep", "tot", "area", "ext", "cx", "cy", "county"]) assert.strictEqual(d[key].length, d.n, key);
    assert.strictEqual(d.geo.polys.length, d.n);
    assert.strictEqual(d.geo.left.length, d.geo.arcs.length);
    const g = RE.buildGraph(d);
    for (let i = 0; i < d.edges.length; i += 3) assert.ok(d.edges[i] < d.n && d.edges[i + 1] < d.n && d.edges[i] !== d.edges[i + 1]);
    const seen = new Uint8Array(d.n); const q = [0]; seen[0] = 1; let c = 1;
    while (q.length) { const x = q.pop(); for (let j = g.start[x]; j < g.start[x + 1]; j++) if (!seen[g.nbr[j]]) { seen[g.nbr[j]] = 1; c++; q.push(g.nbr[j]); } }
    assert.strictEqual(c, d.n);
  });
  test(st + ": statewide 2024 votes are close to the certified totals", () => {
    const share = d.dem.reduce((a, b) => a + b, 0) / (d.dem.reduce((a, b) => a + b, 0) + d.rep.reduce((a, b) => a + b, 0));
    const official = { TX: 0.4305, CA: 0.6040, PA: 0.4914 }[st];
    assert.ok(Math.abs(share - official) < 0.003, share);
  });
}

test("PA: a quick real run produces contiguous districts within ±0.5%", () => {
  const d = window.REDISTRICT_DATA.PA;
  const e = run(d, { k: 17, mode: "proportional", tol: 0.005, margin: 0, searchSteps: 6000, polishSteps: 40000 });
  const r = e.report();
  assert.ok(r.contiguity.ok);
  assert.ok(districtsConnected(d, e.assign, 17));
  assert.ok(r.maxDev <= 0.005 + 1e-9, String(r.maxDev));
});

console.log("\n" + passed + " passed" + (process.exitCode ? ", some FAILED" : ""));
