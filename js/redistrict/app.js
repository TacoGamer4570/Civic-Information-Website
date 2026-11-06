/* Redistricting simulator page: settings, data loading, worker lifecycle, map + results. */
(function () {
  "use strict";

  const STATES = {
    TX: { name: "Texas", seats: 38 }, CA: { name: "California", seats: 52 }, FL: { name: "Florida", seats: 28 },
    PA: { name: "Pennsylvania", seats: 17 }, NC: { name: "North Carolina", seats: 14 }, MI: { name: "Michigan", seats: 13 },
    VA: { name: "Virginia", seats: 11 },
  };
  // steps for the partisan search; polishing steps per precinct (first stage) and per block (second stage)
  const EFFORT = {
    quick: { search: 8000, coarsePer: 10, finePer: 0.5 },
    standard: { search: 25000, coarsePer: 30, finePer: 2 },
    thorough: { search: 80000, coarsePer: 80, finePer: 6 },
  };
  // Categorical slots for district identity (validated palette, light / dark steps).
  const CAT_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const CAT_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  // Diverging lean bins (margin in points, Dem minus Rep).
  const LEAN = [
    { min: 30, color: "#184f95", label: "D +30" },
    { min: 15, color: "#2a78d6", label: "D +15" },
    { min: 5, color: "#6da7ec", label: "D +5" },
    { min: 1, color: "#b7d3f6", label: "D +1" },
    { min: -1, color: "var(--lean-mid)", label: "toss-up" },
    { min: -5, color: "#f6c0bb", label: "R +1" },
    { min: -15, color: "#ec8a82", label: "R +5" },
    { min: -30, color: "#d9473f", label: "R +15" },
    { min: -Infinity, color: "#9c2a23", label: "R +30" },
  ];
  const TYPES = { u8: Uint8Array, u32: Uint32Array, i32: Int32Array, u16: Uint16Array, f32: Float32Array, d32: Int32Array };

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $("rd-form"), statline: $("rd-statline"), k: $("rd-k"), kReset: $("rd-k-reset"), kHint: $("rd-k-hint"),
    targetField: $("rd-target-field"), target: $("rd-target"), targetOut: $("rd-target-out"), targetOf: $("rd-target-of"),
    marginField: $("rd-margin-field"), margin: $("rd-margin"), marginOut: $("rd-margin-out"), marginLabel: $("rd-margin-label"), marginHint: $("rd-margin-hint"),
    tol: $("rd-tol"), county: $("rd-county"), effort: $("rd-effort"), seed: $("rd-seed"), seedClear: $("rd-seed-clear"),
    run: $("rd-run"), pause: $("rd-pause"), skip: $("rd-skip"),
    canvas: $("rd-map"), tip: $("rd-tip"), loading: $("rd-loading"), legend: $("rd-legend"),
    phases: $("rd-phases"), bar: $("rd-progress-bar"), statusText: $("rd-status-text"),
    results: $("rd-results"), tiles: $("rd-tiles"), chart: $("rd-chart"), tbody: document.querySelector("#rd-table tbody"), notes: $("rd-notes"),
    csv: $("rd-csv"), png: $("rd-png"),
    superOn: $("rd-super"), live: $("rd-live"), liveWrap: $("rd-live-wrap"),
  };

  const S = {
    st: null, D: null, map: null, worker: null, running: false, paused: false,
    assign: null, report: null, colorMode: "precinct", prevDistColor: [],
    hoverDistrict: -1, lastDraw: 0, seedUsed: null, workerUrl: null, opts: null,
  };

  // ---------- helpers ----------
  const fmt = (x) => Math.round(x).toLocaleString("en-US");
  const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
  function marginText(m) { // m = D share - R share, in points
    const a = Math.abs(m);
    if (a < 0.05) return "even";
    return (m > 0 ? "D+" : "R+") + a.toFixed(1);
  }
  function leanIndex(m) { for (let i = 0; i < LEAN.length; i++) if (m >= LEAN[i].min) return i; return LEAN.length - 1; }
  function leanColor(m) { return LEAN[leanIndex(m)].color; }
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function resolveVar(c) { return c.startsWith("var(") ? getComputedStyle(el.canvas).getPropertyValue(c.slice(4, -1)).trim() : c; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- decoding ----------
  function b64bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function inflate(b64) {
    const stream = new Blob([b64bytes(b64)]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Response(stream).arrayBuffer();
  }
  async function unpack(type, b64) {
    const a = new TYPES[type](await inflate(b64));
    if (type === "d32") for (let i = 1; i < a.length; i++) a[i] += a[i - 1];
    return a;
  }
  // id images are row-delta coded
  async function unpackIds(b64, w) {
    const a = new Uint32Array(await inflate(b64));
    for (let i = 0; i < a.length; i++) if (i % w) a[i] = (a[i] + a[i - 1]) >>> 0;
    return a;
  }

  // ---------- loading data ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  async function loadState(st) {
    stopWorker();
    S.st = st;
    S.assign = null; S.report = null;
    el.results.hidden = true;
    el.run.disabled = true;
    el.loading.hidden = false;
    el.loading.innerHTML = '<span class="mono">loading ' + STATES[st].name + ' census blocks…</span>';
    el.statline.textContent = "Loading census blocks…";
    setStatus("idle", 0, "Loading " + STATES[st].name + "…");
    try {
      if (!(window.REDISTRICT_DATA && window.REDISTRICT_DATA[st])) await loadScript("data/redistricting/" + st.toLowerCase() + ".js");
      if (S.st !== st) return;
      el.loading.innerHTML = '<span class="mono">unpacking…</span>';
      const meta = window.REDISTRICT_DATA[st];
      const names = Object.keys(meta.arrays);
      const arrs = await Promise.all(names.map((k) => unpack(meta.arrays[k][0], meta.arrays[k][1])));
      const A = {};
      names.forEach((k, i) => { A[k] = arrs[i]; });
      const overview = await unpackIds(meta.raster.overview.data, meta.raster.overview.w);
      if (S.st !== st) return;
      onData(st, meta, A, overview);
    } catch (err) {
      el.loading.innerHTML = '<span class="mono">Couldn\'t load the census data (' + escapeHtml(err && err.message || err) + '). This page needs a recent Chrome, Edge, Firefox, or Safari.</span>';
    }
  }

  function onData(st, meta, A, overview) {
    const graph = window.RedistrictEngine.prepareGraph(meta, A);
    let pop = 0, dem = 0, rep = 0, populated = 0;
    for (let u = 0; u < meta.n; u++) { pop += A.pop[u]; if (A.pop[u] > 0) populated++; }
    for (let p = 0; p < meta.precincts.dem.length; p++) { dem += meta.precincts.dem[p]; rep += meta.precincts.rep[p]; }
    const np = meta.precincts.id.length;
    const pmargin = new Float64Array(np);
    for (let p = 0; p < np; p++) { const t = meta.precincts.dem[p] + meta.precincts.rep[p]; pmargin[p] = t > 0 ? (100 * (meta.precincts.dem[p] - meta.precincts.rep[p])) / t : 0; }
    S.D = { meta, A, overview, raster: meta.raster, graph, n: meta.n, pop, populated, share: dem / (dem + rep), pmargin, np, colors: new Uint32Array(meta.n) };
    el.statline.innerHTML = "<strong>" + escapeHtml(meta.name) + "</strong>: " + fmt(meta.n) + " census blocks · " + fmt(pop) + " people<br>2024: Harris " + pct(dem / (dem + rep)) + " · Trump " + pct(rep / (dem + rep)) + " (two-party)";
    el.k.value = meta.seats;
    el.target.dataset.touched = "";
    syncK();
    // fresh canvas (drops old listeners)
    const fresh = el.canvas.cloneNode(false);
    el.canvas.replaceWith(fresh);
    el.canvas = fresh;
    window.REDISTRICT_TILE = function (tst, r, c, b64) {
      if (tst !== S.st || !S.map) return;
      unpackIds(b64, meta.raster.detail.tile).then((ids) => { if (tst === S.st && S.map) S.map.addTile(r, c, ids); });
    };
    S.map = new window.RedistrictMap(el.canvas, { raster: meta.raster, overview, water: A.water }, {
      onHover: onHover,
      loadTile: (r, c) => loadScript("data/redistricting/" + st.toLowerCase() + "/t" + r + "_" + c + ".js").catch(() => {}),
    });
    el.loading.hidden = true;
    el.run.disabled = false;
    setColorMode("precinct");
    setStatus("idle", 0, "Showing 2024 results by precinct. Pick your settings and press <strong>Draw the map</strong>.");
  }

  // ---------- settings ----------
  function mode() { return el.form.elements.mode.value; }
  function kValue() {
    let k = parseInt(el.k.value, 10);
    if (!(k >= 2)) k = 2;
    if (S.D && k > S.D.populated) k = S.D.populated;
    return k;
  }
  function syncK() {
    if (!S.D) return;
    const real = S.D.meta.seats;
    const k = kValue();
    const ideal = S.D.pop / k;
    let hint = (k === real ? "Real number of U.S. House seats. " : "Real count: " + real + ". ") + "Ideal district: " + fmt(ideal) + " people.";
    if (k >= 500) hint += " Lots of districts: expect a slower run.";
    el.kHint.textContent = hint;
    el.target.max = k;
    if (+el.target.value > k) el.target.value = k;
    if (!el.target.dataset.touched) el.target.value = Math.round(k * S.D.share);
    syncTarget();
    // show the tolerance in people
    for (const o of el.tol.options) {
      const t = +o.value;
      const people = Math.max(1, Math.round(ideal * t));
      o.textContent = "±" + +(t * 100).toPrecision(2) + "% (±" + fmt(people) + " " + (people === 1 ? "person" : "people") + ")" + (o.dataset.note ? " " + o.dataset.note : "");
    }
  }
  function syncTarget() {
    const k = +el.target.max, d = +el.target.value;
    el.targetOut.textContent = d + " D – " + (k - d) + " R";
    el.targetOf.textContent = "of " + k;
  }
  function syncMode() {
    const m = mode();
    el.targetField.hidden = m !== "target";
    el.marginField.hidden = m === "neutral";
    if (m === "competitive") {
      el.marginLabel.textContent = "Toss-up range";
      el.marginHint.textContent = "A district counts as competitive if the 2024 margin is within this many points.";
      if (!el.margin.dataset.compTouched) el.margin.value = 5;
    } else {
      el.marginLabel.textContent = "Safe-seat margin";
      el.marginHint.textContent = "A seat only counts if the winner leads by at least this many points in the 2024 presidential vote. 0 = any win.";
      if (!el.margin.dataset.touched) el.margin.value = 3;
    }
    syncMargin();
  }
  function syncMargin() {
    const v = +el.margin.value;
    el.marginOut.textContent = mode() === "competitive" ? "±" + v + " pts" : v === 0 ? "any win" : v + "+ pts";
  }

  function buildOpts() {
    const k = kValue();
    el.k.value = k;
    const ef = EFFORT[el.effort.value] || EFFORT.standard;
    let seed = parseInt(el.seed.value, 10);
    if (!Number.isFinite(seed)) seed = Math.floor(Math.random() * 1e9);
    S.seedUsed = seed;
    const m = mode();
    return {
      k, mode: m, seed,
      compact: el.form.elements.compact.value !== "0",
      endless: el.superOn.checked,
      tol: +el.tol.value,
      targetD: Math.min(k, +el.target.value),
      margin: m === "competitive" ? 0 : +el.margin.value,
      band: m === "competitive" ? +el.margin.value : 5,
      countyWeight: +el.county.value,
      searchSteps: ef.search,
      coarsePolishSteps: Math.round(ef.coarsePer * S.D.np),
      finePolishSteps: Math.round(ef.finePer * S.D.n),
    };
  }

  // ---------- worker ----------
  function stopWorker() {
    if (S.worker) { S.worker.terminate(); S.worker = null; }
    S.running = false; S.paused = false;
    el.pause.disabled = true; el.skip.disabled = true; el.pause.textContent = "Pause";
    el.skip.textContent = "Skip phase";
    el.run.textContent = "Draw the map";
  }
  function start() {
    if (!S.D) return;
    stopWorker();
    const opts = buildOpts();
    S.opts = opts;
    if (!S.workerUrl) S.workerUrl = URL.createObjectURL(new Blob([window.RedistrictEngine.workerSource], { type: "text/javascript" }));
    const w = new Worker(S.workerUrl);
    S.worker = w;
    S.running = true;
    S.prevDistColor = [];
    S.assign = null;
    S.best = null; S.liveReport = null;
    el.run.textContent = "Start over";
    el.pause.disabled = false; el.skip.disabled = false;
    el.skip.textContent = opts.endless ? "Stop & keep best" : "Skip phase";
    el.liveWrap.hidden = !opts.endless;
    setStatus("init", 0, "Building a random starting map…");
    if (S.colorMode === "precinct") setColorMode("lean");
    w.onmessage = (ev) => onWorker(ev.data);
    w.onerror = (e) => { setStatus("error", 0, "Something went wrong: " + escapeHtml(e.message || "worker error")); stopWorker(); };
    w.postMessage({ cmd: "init", graph: S.D.graph, opts });
  }
  function onWorker(msg) {
    if (msg.type === "error") { setStatus("error", 0, escapeHtml(msg.message)); stopWorker(); return; }
    const final = msg.type === "done";
    S.liveReport = msg.report;
    S.liveAssign = msg.assign;
    let fresh = false;
    if (msg.best) { S.best = msg.best; fresh = true; }
    // superthinking shows the best map so far unless you're watching the live search
    showLiveOrBest(final);
    if (msg.type === "ready") { S.worker.postMessage({ cmd: "run" }); renderLegend(); }
    const now = performance.now();
    if (final || fresh || msg.type === "ready" || msg.type === "paused" || (S.assign === S.liveAssign && now - S.lastDraw > 300)) {
      S.lastDraw = now;
      renderPlan();
      renderResults();
    }
    renderStatus(msg.type);
    if (final) {
      S.running = false;
      el.pause.disabled = true; el.skip.disabled = true;
      el.run.textContent = "Draw another";
    }
  }

  function showLiveOrBest(final) {
    if (S.opts && S.opts.endless && S.best && !final && !el.live.checked) { S.assign = S.best.assign; S.report = S.best.report; }
    else { S.assign = S.liveAssign; S.report = S.liveReport; }
  }

  // ---------- status ----------
  // UI steps: balance, search, shape (precincts), refine (blocks), verify
  function uiStep(r) {
    if (!r) return "init";
    if (r.phase === "done") return "done";
    if (r.stage === "precinct" || !r.useCoarse) {
      if (r.phase === "final") return "refine";
      return r.phase === "polish" ? "polish" : r.phase;
    }
    return "refine";
  }
  const STEP_ORDER = ["init", "balance", "search", "polish", "refine", "done"];
  function setStatus(step, progress, html) {
    const idx = STEP_ORDER.indexOf(step);
    for (const li of el.phases.children) {
      const pi = STEP_ORDER.indexOf(li.dataset.phase);
      li.classList.toggle("is-active", step === li.dataset.phase && step !== "done");
      li.classList.toggle("is-done", idx > pi || step === "done");
    }
    el.bar.style.width = Math.round(progress * 100) + "%";
    el.statusText.innerHTML = html;
  }
  function bestSummary(b) {
    const r = b.report, k = r.k, m = S.opts.mode, mg = S.opts.margin;
    let s;
    if (m === "maxD") s = r.seats.safeD + " Democratic seats" + (mg ? " (won by " + mg + "+)" : "");
    else if (m === "maxR") s = r.seats.safeR + " Republican seats" + (mg ? " (won by " + mg + "+)" : "");
    else if (m === "competitive") s = r.seats.comp + " competitive seats";
    else s = r.seats.winD + " D – " + (k - r.seats.winD) + " R";
    if (S.opts.compact) s += ", compactness " + r.meanPP.toFixed(3);
    return s + " (cycle " + b.cycle + ")";
  }
  function renderStatus(type) {
    const r = S.opts && S.opts.endless ? S.liveReport : S.report;
    if (!r) return;
    if (S.opts.endless && r.endless) {
      const best = S.best ? bestSummary(S.best) : "none yet";
      let text;
      if (r.phase === "done") {
        const c = r.contiguity;
        text = "<strong>Stopped after " + r.endless.cycle + " cycle" + (r.endless.cycle === 1 ? "" : "s") + ".</strong> Showing the best map: " + escapeHtml(best) + ". " +
          (c && c.ok ? "All " + fmt(r.k) + " districts verified contiguous." : "Contiguity check failed.") + " <span class='muted'>seed " + S.seedUsed + "</span>";
        setStatus("done", 1, text);
      } else {
        const unit = r.stage === "precinct" ? "precincts" : "census blocks";
        const goalText = r.goal.text ? r.goal.text[0].toLowerCase() + r.goal.text.slice(1) : "";
        const now = type === "paused" ? "paused" : r.stage === "block" && (r.phase === "polish" || r.phase === "final") && r.useCoarse
          ? "refining with census blocks"
          : ({ init: "starting", balance: "balancing population", search: escapeHtml(goalText), polish: "making it compact", final: "final balancing" }[r.phase] || "") + " (moving " + unit + ")";
        text = "<strong>Superthinking · cycle " + r.endless.cycle + "</strong> · best so far: " + escapeHtml(best) + "<br><span class='muted'>Now " + now + ". Press <em>Stop &amp; keep best</em> whenever you like.</span>";
        setStatus(uiStep(r), r.phaseProgress, text);
      }
      el.phases.querySelector('[data-phase="search"]').classList.toggle("is-skipped", S.opts.mode === "neutral");
      el.phases.querySelector('[data-phase="polish"]').classList.toggle("is-skipped", !S.opts.compact);
      return;
    }
    const step = uiStep(r);
    const steps = fmt(r.step) + " steps · " + pct(r.acceptRate, 0) + " of moves accepted";
    const unit = r.stage === "precinct" ? "precincts" : "census blocks";
    let text;
    if (r.phase === "done") {
      const c = r.contiguity;
      text = (c && c.ok ? "<strong>Done.</strong> All " + fmt(r.k) + " districts verified contiguous at the census-block level." : "<strong>Done</strong>, but " + (c ? c.broken.length : "?") + " district(s) failed the contiguity check.") + " <span class='muted'>" + steps + " · seed " + S.seedUsed + "</span>";
    } else if (type === "paused") {
      text = "<strong>Paused.</strong> " + escapeHtml(r.goal.text || "") + " <span class='muted'>" + steps + "</span>";
    } else {
      const label = {
        init: "Starting…",
        balance: "Balancing population (moving " + unit + ")…",
        search: escapeHtml(r.goal.text) + " (moving " + unit + ")…",
        polish: r.stage === "precinct" ? "Making districts compact, seat result locked (moving precincts)…" : "Smoothing borders and evening out population, block by block…",
        final: "Final population balancing, block by block…",
      }[r.phase] || "";
      text = label + " <span class='muted'>" + steps + "</span>";
    }
    setStatus(step, r.phase === "done" ? 1 : r.phaseProgress, text);
    el.phases.querySelector('[data-phase="search"]').classList.toggle("is-skipped", S.opts.mode === "neutral");
    el.phases.querySelector('[data-phase="polish"]').classList.toggle("is-skipped", !S.opts.compact);
  }

  // ---------- map coloring ----------
  function computeDistrictColors() {
    // Greedy graph coloring so neighboring districts never share a color;
    // districts keep their previous color when they can (less flicker).
    const g = S.D.graph, a = S.assign, k = S.report.k;
    const nb = Array.from({ length: k }, () => new Set());
    for (let i = 0; i < g.eu.length; i++) {
      const x = a[g.eu[i]], y = a[g.ev[i]];
      if (x !== y) { nb[x].add(y); nb[y].add(x); }
    }
    const order = Array.from({ length: k }, (_, i) => i).sort((p, q) => nb[q].size - nb[p].size);
    const col = new Array(k).fill(-1);
    const prev = S.prevDistColor;
    for (const v of order) {
      const used = new Set();
      for (const w of nb[v]) if (col[w] >= 0) used.add(col[w]);
      if (prev[v] != null && prev[v] >= 0 && !used.has(prev[v])) { col[v] = prev[v]; continue; }
      let c = 0;
      while (used.has(c)) c++;
      col[v] = c;
    }
    S.prevDistColor = col;
    return col;
  }
  function districtLabels() {
    const A = S.D.A, a = S.assign, k = S.report.k, n = S.D.n, q = S.D.raster.q;
    const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
    // land only, so labels don't land out in a lake
    for (let u = 0; u < n; u++) { if (A.water[u]) continue; const w = A.area[u] + 1; sx[a[u]] += A.x[u] * w; sy[a[u]] += A.y[u] * w; sw[a[u]] += w; }
    const best = new Int32Array(k).fill(-1), bestD = new Float64Array(k).fill(Infinity);
    for (let u = 0; u < n; u++) {
      const d = a[u];
      if (A.water[u] || !sw[d]) continue;
      const dx = A.x[u] - sx[d] / sw[d], dy = A.y[u] - sy[d] / sw[d];
      const dd = dx * dx + dy * dy;
      if (dd < bestD[d]) { bestD[d] = dd; best[d] = u; }
    }
    const out = [];
    for (let d = 0; d < k; d++) if (best[d] >= 0) out.push({ x: A.x[best[d]] * q, y: A.y[best[d]] * q, text: d + 1 });
    return out;
  }
  function renderPlan() {
    if (!S.map) return;
    const D = S.D, A = D.A, n = D.n, colors = D.colors;
    const pack = window.RedistrictMap.packColor;
    const leanPacked = LEAN.map((b) => pack(resolveVar(b.color)));
    if (S.colorMode === "precinct" || !S.assign) {
      const pc = new Uint32Array(D.np);
      for (let p = 0; p < D.np; p++) pc[p] = leanPacked[leanIndex(D.pmargin[p])];
      for (let u = 0; u < n; u++) colors[u] = pc[A.precinct[u]];
      S.map.setPlan(colors, S.assign, S.assign ? districtLabels() : []);
      return;
    }
    const a = S.assign;
    if (S.colorMode === "district") {
      const cols = (isDark() ? CAT_DARK : CAT_LIGHT).map(pack);
      const dc = computeDistrictColors();
      for (let u = 0; u < n; u++) colors[u] = cols[dc[a[u]] % cols.length];
    } else {
      const dl = S.report.districts.map((x) => leanPacked[leanIndex(100 * (2 * x.share - 1))]);
      for (let u = 0; u < n; u++) colors[u] = dl[a[u]];
    }
    S.map.setPlan(colors, a, districtLabels());
  }
  function setColorMode(m) {
    S.colorMode = m;
    for (const inp of document.querySelectorAll("#rd-color input")) inp.checked = inp.value === m;
    renderLegend();
    renderPlan();
  }
  function renderLegend() {
    if (S.colorMode === "district" && S.assign) {
      el.legend.innerHTML = '<span class="muted">Each color is a district; neighbors always differ. Numbers label each district.</span>';
      return;
    }
    const what = S.colorMode === "precinct" || !S.assign ? "Precinct margin, 2024" : "District margin, 2024";
    const bins = LEAN.slice().reverse();
    el.legend.innerHTML = '<span class="rd-legend-title">' + what + '</span><span class="rd-ramp">' +
      bins.map((b) => '<span class="rd-ramp-cell" style="background:' + b.color + '" title="' + b.label + '"></span>').join("") +
      '</span><span class="rd-ramp-labels"><span>R +30</span><span>even</span><span>D +30</span></span>';
  }

  // ---------- hover ----------
  function blockGeoid(u) {
    const A = S.D.A, m = S.D.meta;
    return m.counties[A.county[u]].fips + String(A.tract[u]).padStart(6, "0") + String(A.block[u]).padStart(4, "0");
  }
  function onHover(u, x, y) {
    const tip = el.tip;
    if (u < 0 || !S.D) {
      tip.hidden = true;
      if (S.hoverDistrict >= 0) { S.hoverDistrict = -1; S.map.highlightDistrict = -1; S.map.draw(); highlightRow(-1); }
      return;
    }
    const D = S.D, A = D.A, m = D.meta, g = D.graph;
    const p = A.precinct[u];
    const pd = m.precincts.dem[p], pr = m.precincts.rep[p], pt = pd + pr;
    const county = m.counties[A.county[u]].name;
    const pname = m.precincts.id[p].replace(/^\d{5}-?/, "") || m.precincts.id[p];
    let html = '<div class="rd-tip-h">Block ' + blockGeoid(u) + ' <span class="muted">' + escapeHtml(county) + "</span></div>" +
      '<div class="mono small">' + fmt(A.pop[u]) + " people" + (g.dem[u] + g.rep[u] >= 0.5 ? " · est. " + fmt(g.dem[u]) + " Harris, " + fmt(g.rep[u]) + " Trump" : "") + "</div>" +
      '<div class="mono small muted">Precinct ' + escapeHtml(pname) + ": " + (pt ? "Harris " + pct(pd / pt) + " · Trump " + pct(pr / pt) : "no votes reported") + "</div>";
    let di = -1;
    if (S.assign && S.report) {
      di = S.assign[u];
      const ds = S.report.districts[di];
      if (ds) {
        const mm = 100 * (2 * ds.share - 1);
        html += '<div class="rd-tip-d"><strong>District ' + (di + 1) + "</strong> · " + marginText(mm) + '<div class="mono small">' + fmt(ds.pop) + " people (" + (ds.pop >= S.report.ideal ? "+" : "") + fmt(ds.pop - S.report.ideal) + ") · Polsby–Popper " + ds.pp.toFixed(2) + "</div></div>";
      }
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const wrap = tip.parentElement.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + tw > wrap.width - 6) left = Math.max(6, x - tw - 14);
    if (top + th > wrap.height - 6) top = Math.max(6, y - th - 14);
    tip.style.left = left + "px"; tip.style.top = top + "px";
    if (di !== S.hoverDistrict) {
      S.hoverDistrict = di;
      S.map.highlightDistrict = di;
      S.map.draw();
      highlightRow(di);
    }
  }
  function highlightRow(di) {
    for (const tr of el.tbody.children) tr.classList.toggle("is-hl", +tr.dataset.d === di);
    for (const b of el.chart.querySelectorAll("[data-d]")) b.classList.toggle("is-hl", +b.dataset.d === di);
  }

  // ---------- results ----------
  function tile(label, value, sub, cls) {
    return '<div class="card rd-tile ' + (cls || "") + '"><div class="rd-tile-l">' + label + '</div><div class="rd-tile-v">' + value + '</div><div class="rd-tile-s small">' + sub + "</div></div>";
  }
  function renderResults() {
    const r = S.report;
    if (!r) return;
    el.results.hidden = false;
    const k = r.k;
    const dWins = r.seats.winD, rWins = k - dWins;
    const goal = r.goal || {};
    const settled = r.phase === "done" || r.phase === "polish" || r.phase === "final" || r.stage === "block";
    const goalCls = settled ? (goal.achieved ? "is-good" : S.opts.mode === "neutral" ? "" : "is-warn") : "";
    const c = r.contiguity;
    const tiles = [];
    tiles.push(tile("Seats", '<span class="party-d-ink">' + fmt(dWins) + " D</span> – <span class=\"party-r-ink\">" + fmt(rWins) + " R</span>",
      escapeHtml(goal.text || "") + (S.opts.margin > 0 && S.opts.mode !== "neutral" && S.opts.mode !== "competitive" ? "<br>Safe (" + S.opts.margin + "+ pts): " + r.seats.safeD + " D, " + r.seats.safeR + " R" : ""), goalCls));
    tiles.push(tile("Vote vs. seats", pct(r.stateShare) + " → " + pct(dWins / k, 0), "Harris share of the two-party vote, and of seats"));
    if (c) {
      tiles.push(tile("Contiguity", c.ok ? "✓ all " + fmt(k) : "✗ " + c.broken.length + " broken",
        c.ok ? "Every district is one connected set of census blocks" + (c.water ? " (" + c.water + " cross water to islands)" : "") : "Districts " + c.broken.slice(0, 10).map((x) => x + 1).join(", ") + " are split", c.ok ? "is-good" : "is-bad"));
    } else {
      tiles.push(tile("Contiguity", "…", "Every move keeps districts connected; the final check runs at the end"));
    }
    const range = r.maxPop - r.minPop;
    tiles.push(tile("Population", "±" + pct(r.maxDev, r.maxDev < 0.001 ? 3 : 2),
      "Largest and smallest districts differ by " + fmt(range) + " " + (Math.round(range) === 1 ? "person" : "people") + ". Ideal: " + fmt(r.ideal) + ".", r.maxDev <= r.userTol + 1e-9 ? "" : "is-warn"));
    tiles.push(tile("Compactness", r.meanPP.toFixed(2), "Average Polsby–Popper (1 = circle). Least compact: " + Math.min.apply(null, r.districts.map((x) => x.pp)).toFixed(2)));
    if (r.splitCounties != null) tiles.push(tile("County splits", fmt(r.splitCounties), "of " + S.D.meta.counties.length + " counties are split between districts"));
    const eg = r.efficiencyGap;
    tiles.push(tile("Efficiency gap", (Math.abs(eg) < 0.0005 ? "0%" : pct(Math.abs(eg))) + (Math.abs(eg) >= 0.0005 ? (eg > 0 ? " R" : " D") : ""), "Wasted-vote advantage. Above ~7% is a red flag."));
    const mm = r.meanMedian;
    tiles.push(tile("Mean–median", (Math.abs(mm) < 0.0005 ? "0" : (100 * Math.abs(mm)).toFixed(1) + " pts " + (mm < 0 ? "R" : "D")), "Gap between the median and average district. Near 0 is symmetric."));
    el.tiles.innerHTML = tiles.join("");

    renderChart(r);
    renderTable(r);
    el.notes.innerHTML = (r.notes || []).map(escapeHtml).join(" ");
  }

  function renderChart(r) {
    const ds = r.districts.slice().sort((a, b) => a.share - b.share);
    const k = ds.length;
    const W = Math.max(280, Math.round(el.chart.clientWidth || 720)), H = W < 520 ? 200 : 240, padL = 40, padR = 10, padT = 10, padB = 24;
    const iw = W - padL - padR, ih = H - padT - padB;
    const lo = Math.max(0, Math.min(0.2, Math.floor(ds[0].share * 10) / 10)), hi = Math.min(1, Math.max(0.8, Math.ceil(ds[k - 1].share * 10) / 10));
    const y = (v) => padT + ih - ((v - lo) / (hi - lo)) * ih;
    const slot = iw / k, gap = slot > 4 ? 2 : 0, bw = Math.max(0.5, slot - gap);
    let s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Harris share of the two-party vote in each district, sorted">';
    for (let v = lo; v <= hi + 1e-9; v += 0.1) {
      const yy = y(v).toFixed(1);
      s += '<line class="rd-grid' + (Math.abs(v - 0.5) < 1e-9 ? " rd-grid-50" : "") + '" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '"/>';
      s += '<text class="rd-axis" x="' + (padL - 6) + '" y="' + yy + '" text-anchor="end" dominant-baseline="middle">' + Math.round(v * 100) + "%</text>";
    }
    const y50 = y(0.5);
    const interactive = k <= 400;
    ds.forEach((d, i) => {
      const x = padL + i * slot + (slot - bw) / 2;
      const yv = y(d.share);
      const top = Math.min(yv, y50), h = Math.max(1, Math.abs(yv - y50));
      const cls = d.share > 0.5 ? "rd-bar-d" : "rd-bar-r";
      const m = 100 * (2 * d.share - 1);
      const bar = '<rect class="' + cls + '" x="' + x.toFixed(2) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(3, bw / 3).toFixed(1) + '"/>';
      if (interactive) {
        s += '<g class="rd-barg" data-d="' + d.id + '"><rect class="rd-hit" x="' + (padL + i * slot).toFixed(2) + '" y="' + padT + '" width="' + slot.toFixed(2) + '" height="' + ih + '"/>' + bar +
          "<title>District " + (d.id + 1) + ": Harris " + pct(d.share) + " (" + marginText(m) + ")</title></g>";
      } else s += bar;
    });
    const ys = y(r.stateShare).toFixed(1);
    s += '<line class="rd-state-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ys + '" y2="' + ys + '"/>';
    s += '<text class="rd-axis" x="' + padL + '" y="' + (H - 6) + '">weakest D district</text><text class="rd-axis" x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end">strongest D district</text>';
    s += "</svg>";
    el.chart.innerHTML = s;
    S.chartWidth = W;
    for (const g of el.chart.querySelectorAll(".rd-barg")) {
      g.addEventListener("mouseenter", () => { const di = +g.dataset.d; S.map.highlightDistrict = di; S.map.draw(); highlightRow(di); });
      g.addEventListener("mouseleave", () => { S.map.highlightDistrict = -1; S.map.draw(); highlightRow(-1); });
    }
  }

  function renderTable(r) {
    const rows = r.districts.map((d) => {
      const t = d.dem + d.rep;
      const m = 100 * (2 * d.share - 1);
      const diff = d.pop - r.ideal;
      return '<tr data-d="' + d.id + '"><th scope="row"><span class="rd-dot" style="background:' + leanColor(m) + '"></span>' + (d.id + 1) + "</th>" +
        "<td>" + fmt(d.pop) + "</td><td>" + (diff >= 0 ? "+" : "−") + fmt(Math.abs(diff)) + " <span class='muted'>(" + (d.dev >= 0 ? "+" : "") + pct(d.dev, 3) + ")</span></td>" +
        "<td>" + pct(t ? d.dem / t : 0) + "</td><td>" + pct(t ? d.rep / t : 0) + "</td>" +
        '<td class="' + (m > 0 ? "party-d-ink" : "party-r-ink") + '">' + marginText(m) + "</td>" +
        "<td>" + d.pp.toFixed(2) + "</td><td>" + fmt(d.units) + "</td><td>" + (d.counties == null ? "…" : d.counties) + "</td></tr>";
    });
    el.tbody.innerHTML = rows.join("");
    const unitHead = document.querySelector("#rd-table thead th:nth-child(8)");
    if (unitHead) unitHead.textContent = r.stage === "precinct" ? "Precincts" : "Blocks";
  }

  // ---------- exports ----------
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  // Standard block-assignment file: one row per census block.
  function exportCsv() {
    if (!S.assign) return;
    const n = S.D.n, parts = ["GEOID20,District\n"];
    let chunk = "";
    for (let u = 0; u < n; u++) {
      chunk += blockGeoid(u) + "," + (S.assign[u] + 1) + "\n";
      if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ""; }
    }
    parts.push(chunk);
    download(S.st.toLowerCase() + "-block-assignments-seed" + S.seedUsed + ".csv", new Blob(parts, { type: "text/csv" }));
  }
  function exportPng() {
    if (!S.map) return;
    S.map.canvas.toBlob((b) => b && download(S.st.toLowerCase() + "-map.png", b));
  }

  // ---------- wiring ----------
  el.form.addEventListener("submit", (e) => { e.preventDefault(); start(); });
  el.form.elements.state.forEach((r) => r.addEventListener("change", () => loadState(r.value)));
  el.form.elements.mode.forEach((r) => r.addEventListener("change", syncMode));
  el.k.addEventListener("input", syncK);
  el.k.addEventListener("change", () => { el.k.value = kValue(); syncK(); });
  el.kReset.addEventListener("click", () => { if (!S.D) return; el.k.value = S.D.meta.seats; el.target.dataset.touched = ""; syncK(); });
  el.target.addEventListener("input", () => { el.target.dataset.touched = "1"; syncTarget(); });
  el.margin.addEventListener("input", () => { el.margin.dataset[mode() === "competitive" ? "compTouched" : "touched"] = "1"; syncMargin(); });
  el.seedClear.addEventListener("click", () => { el.seed.value = ""; });
  el.pause.addEventListener("click", () => {
    if (!S.worker) return;
    S.paused = !S.paused;
    S.worker.postMessage({ cmd: S.paused ? "pause" : "run" });
    el.pause.textContent = S.paused ? "Resume" : "Pause";
  });
  el.skip.addEventListener("click", () => { if (S.worker) S.worker.postMessage({ cmd: "finish" }); });
  el.live.addEventListener("change", () => { if (!S.liveReport) return; showLiveOrBest(S.liveReport.phase === "done"); renderPlan(); renderResults(); });
  document.querySelectorAll("#rd-color input").forEach((r) => r.addEventListener("change", () => setColorMode(r.value)));
  $("rd-zoom-in").addEventListener("click", () => S.map && S.map.zoomAt(S.map.w / 2, S.map.h / 2, 1.6));
  $("rd-zoom-out").addEventListener("click", () => S.map && S.map.zoomAt(S.map.w / 2, S.map.h / 2, 1 / 1.6));
  $("rd-zoom-reset").addEventListener("click", () => S.map && S.map.resetView());
  el.csv.addEventListener("click", exportCsv);
  el.png.addEventListener("click", exportPng);
  el.tbody.addEventListener("mouseover", (e) => {
    const tr = e.target.closest("tr");
    if (!tr || !S.map) return;
    S.map.highlightDistrict = +tr.dataset.d; S.map.draw(); highlightRow(+tr.dataset.d);
  });
  el.tbody.addEventListener("mouseleave", () => { if (S.map) { S.map.highlightDistrict = -1; S.map.draw(); highlightRow(-1); } });
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { const d = $(b.dataset.open); if (d && d.showModal) d.showModal(); }));
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  });
  window.addEventListener("resize", () => {
    if (S.report && !el.results.hidden && Math.abs((el.chart.clientWidth || 0) - (S.chartWidth || 0)) > 20) renderChart(S.report);
  });
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderLegend(); renderPlan(); });

  syncMode();
  renderLegend();
  loadState(el.form.elements.state.value);
})();
