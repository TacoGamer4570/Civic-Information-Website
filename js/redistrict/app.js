/* Redistricting simulator page: settings, worker lifecycle, map + results. */
(function () {
  "use strict";

  const STATES = { TX: { name: "Texas", seats: 38 }, CA: { name: "California", seats: 52 }, PA: { name: "Pennsylvania", seats: 17 } };
  const EFFORT = {
    quick: { search: 8000, polishPer: 15 },
    standard: { search: 25000, polishPer: 50 },
    thorough: { search: 80000, polishPer: 150 },
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
  };

  const S = {
    st: null, data: null, map: null, worker: null, running: false, paused: false,
    assign: null, report: null, colorMode: "lean", distColor: [], prevDistColor: [],
    hoverDistrict: -1, lastDraw: 0, seedUsed: null, totals: null, workerUrl: null,
  };

  // ---------- helpers ----------
  const fmt = (x) => Math.round(x).toLocaleString("en-US");
  const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
  function marginText(m) { // m = D share - R share, in points
    const a = Math.abs(m);
    if (a < 0.05) return "even";
    return (m > 0 ? "D+" : "R+") + a.toFixed(1);
  }
  function leanColor(m) { for (const b of LEAN) if (m >= b.min) return b.color; return LEAN[LEAN.length - 1].color; }
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function resolveVar(c) { return c.startsWith("var(") ? getComputedStyle(el.canvas).getPropertyValue(c.slice(4, -1)).trim() : c; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- loading data ----------
  function loadState(st) {
    stopWorker();
    S.st = st;
    S.assign = null; S.report = null;
    el.results.hidden = true;
    el.run.disabled = true;
    el.loading.hidden = false;
    el.statline.textContent = "Loading precincts…";
    setStatus("idle", 0, "Loading " + STATES[st].name + " precincts…");
    const have = window.REDISTRICT_DATA && window.REDISTRICT_DATA[st];
    if (have) return onData(st);
    const s = document.createElement("script");
    s.src = "data/redistricting/" + st.toLowerCase() + ".js";
    s.onload = () => { if (S.st === st) onData(st); };
    s.onerror = () => { el.loading.innerHTML = '<span class="mono">Couldn\'t load the precinct file. Try reloading.</span>'; };
    document.head.appendChild(s);
  }

  function onData(st) {
    const d = window.REDISTRICT_DATA[st];
    S.data = d;
    let pop = 0, dem = 0, rep = 0;
    S.margin = new Float64Array(d.n);
    for (let u = 0; u < d.n; u++) {
      pop += d.pop[u]; dem += d.dem[u]; rep += d.rep[u];
      const t = d.dem[u] + d.rep[u];
      S.margin[u] = t > 0 ? (100 * (d.dem[u] - d.rep[u])) / t : 0;
    }
    S.totals = { pop, dem, rep, share: dem / (dem + rep) };
    el.statline.innerHTML = fmt(d.n) + " precincts · " + fmt(pop) + " people<br>2024: Harris " + pct(dem / (dem + rep)) + " · Trump " + pct(rep / (dem + rep)) + " (two-party)";
    el.k.value = d.seats;
    syncK();
    if (S.map) S.map.canvas.replaceWith(S.map.canvas.cloneNode(false));
    el.canvas = $("rd-map");
    S.map = new window.RedistrictMap(el.canvas, d, { onHover: onHover });
    el.loading.hidden = true;
    el.run.disabled = false;
    setColorMode("precinct", true);
    setStatus("idle", 0, "Showing 2024 results by precinct. Pick your settings and press <strong>Draw the map</strong>.");
  }

  // ---------- settings ----------
  function mode() { return el.form.elements.mode.value; }
  function syncK() {
    const st = STATES[S.st];
    let k = parseInt(el.k.value, 10);
    if (!(k >= 2)) k = 2;
    if (k > 80) k = 80;
    const ideal = S.totals ? S.totals.pop / k : 0;
    el.kHint.textContent = (k === st.seats ? "Real number of U.S. House seats. " : "Real count: " + st.seats + ". ") + (ideal ? "Ideal district: " + fmt(ideal) + " people." : "");
    el.target.max = k;
    if (+el.target.value > k) el.target.value = k;
    if (S.totals && !el.target.dataset.touched) el.target.value = Math.round(k * S.totals.share);
    syncTarget();
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
    const k = Math.max(2, Math.min(80, parseInt(el.k.value, 10) || STATES[S.st].seats));
    const ef = EFFORT[el.effort.value] || EFFORT.standard;
    let seed = parseInt(el.seed.value, 10);
    if (!Number.isFinite(seed)) seed = Math.floor(Math.random() * 1e9);
    S.seedUsed = seed;
    const m = mode();
    return {
      k, mode: m, seed,
      tol: +el.tol.value,
      targetD: +el.target.value,
      margin: m === "competitive" ? 0 : +el.margin.value,
      band: m === "competitive" ? +el.margin.value : 5,
      countyWeight: +el.county.value,
      searchSteps: ef.search,
      polishSteps: Math.round(ef.polishPer * S.data.n),
    };
  }

  // ---------- worker ----------
  function stopWorker() {
    if (S.worker) { S.worker.terminate(); S.worker = null; }
    S.running = false; S.paused = false;
    el.pause.disabled = true; el.skip.disabled = true; el.pause.textContent = "Pause";
    el.run.textContent = "Draw the map";
  }
  function start() {
    if (!S.data) return;
    stopWorker();
    const opts = buildOpts();
    S.opts = opts;
    if (!S.workerUrl) S.workerUrl = URL.createObjectURL(new Blob([window.RedistrictEngine.workerSource], { type: "text/javascript" }));
    const w = new Worker(S.workerUrl);
    S.worker = w;
    S.running = true;
    S.prevDistColor = [];
    el.run.textContent = "Start over";
    el.pause.disabled = false; el.skip.disabled = false;
    setStatus("init", 0, "Building a random starting map…");
    if (S.colorMode === "precinct") setColorMode("lean", true);
    w.onmessage = (ev) => onWorker(ev.data);
    w.onerror = (e) => { setStatus("error", 0, "Something went wrong: " + escapeHtml(e.message || "worker error")); stopWorker(); };
    const d = S.data;
    w.postMessage({
      cmd: "init",
      graph: { n: d.n, pop: d.pop, dem: d.dem, rep: d.rep, area: d.area, ext: d.ext, county: d.county, edges: d.edges },
      opts,
    });
  }
  function onWorker(msg) {
    if (msg.type === "error") { setStatus("error", 0, escapeHtml(msg.message)); stopWorker(); return; }
    S.assign = msg.assign;
    S.report = msg.report;
    if (msg.type === "ready") { S.worker.postMessage({ cmd: "run" }); renderLegend(); }
    const now = performance.now();
    const final = msg.type === "done";
    if (final || msg.type === "ready" || msg.type === "paused" || now - S.lastDraw > 250) {
      S.lastDraw = now;
      renderPlan(final);
      renderResults(final);
    }
    renderStatus(msg.type);
    if (final) {
      S.running = false;
      el.pause.disabled = true; el.skip.disabled = true;
      el.run.textContent = "Draw another";
    }
  }

  // ---------- status ----------
  const PHASE_ORDER = ["init", "balance", "search", "polish", "final", "done"];
  function setStatus(phase, progress, html) {
    const idx = PHASE_ORDER.indexOf(phase);
    for (const li of el.phases.children) {
      const p = li.dataset.phase;
      const pi = PHASE_ORDER.indexOf(p);
      const cur = phase === p || (p === "polish" && phase === "final");
      li.classList.toggle("is-active", cur && phase !== "done");
      li.classList.toggle("is-done", idx > pi && !(p === "polish" && phase === "final") || phase === "done");
    }
    el.bar.style.width = Math.round(progress * 100) + "%";
    el.statusText.innerHTML = html;
  }
  function renderStatus(type) {
    const r = S.report;
    if (!r) return;
    const skipSearch = S.opts.mode === "neutral";
    const steps = fmt(r.step) + " steps · " + pct(r.acceptRate, 0) + " of moves accepted";
    let text;
    if (r.phase === "done") {
      const c = r.contiguity;
      text = (c.ok ? "<strong>Done.</strong> All " + r.k + " districts verified contiguous." : "<strong>Done</strong>, but " + c.broken.length + " district(s) failed the contiguity check.") + " <span class='muted'>" + steps + " · seed " + S.seedUsed + "</span>";
    } else if (type === "paused") {
      text = "<strong>Paused.</strong> " + escapeHtml(r.goal.text || "") + " <span class='muted'>" + steps + "</span>";
    } else {
      const label = { init: "Starting…", balance: "Balancing population…", search: escapeHtml(r.goal.text) + "…", polish: "Making districts compact (seat result locked)…", final: "Final population balancing…" }[r.phase] || "";
      text = label + " <span class='muted'>" + steps + "</span>";
    }
    let phase = r.phase;
    if (skipSearch && phase === "polish") phase = "polish";
    setStatus(phase, r.phase === "done" ? 1 : r.phaseProgress, text);
    if (skipSearch) {
      const li = el.phases.querySelector('[data-phase="search"]');
      li.classList.add("is-skipped");
    } else el.phases.querySelector('[data-phase="search"]').classList.remove("is-skipped");
  }

  // ---------- map coloring ----------
  function districtStats() {
    return S.report ? S.report.districts : [];
  }
  function computeDistrictColors() {
    // Greedy graph coloring so neighboring districts never share a color;
    // districts keep their previous color when they can (less flicker).
    const d = S.data, a = S.assign, k = S.report.k;
    const nb = Array.from({ length: k }, () => new Set());
    const E = d.edges;
    for (let i = 0; i < E.length; i += 3) {
      const x = a[E[i]], y = a[E[i + 1]];
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
    const d = S.data, a = S.assign, k = S.report.k;
    const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
    for (let u = 0; u < d.n; u++) { const w = d.area[u] + 1; sx[a[u]] += d.cx[u] * w; sy[a[u]] += d.cy[u] * w; sw[a[u]] += w; }
    const best = new Array(k).fill(-1), bestD = new Float64Array(k).fill(Infinity);
    for (let u = 0; u < d.n; u++) {
      const di = a[u];
      const dx = d.cx[u] - sx[di] / sw[di], dy = d.cy[u] - sy[di] / sw[di];
      const dd = dx * dx + dy * dy;
      if (dd < bestD[di]) { bestD[di] = dd; best[di] = u; }
    }
    return best.map((u, i) => ({ x: d.cx[u], y: d.cy[u], text: i + 1 }));
  }
  function renderPlan() {
    if (!S.map || !S.assign) return;
    const a = S.assign;
    const cols = isDark() ? CAT_DARK : CAT_LIGHT;
    const dist = districtStats();
    let fill;
    if (S.colorMode === "precinct") {
      const cache = LEAN.map((b) => resolveVar(b.color));
      fill = (u) => cache[LEAN.findIndex((b) => S.margin[u] >= b.min)];
    } else if (S.colorMode === "district") {
      const dc = computeDistrictColors();
      fill = (u) => cols[dc[a[u]] % cols.length];
    } else {
      const dl = dist.map((x) => resolveVar(leanColor(100 * (2 * x.share - 1))));
      fill = (u) => dl[a[u]];
    }
    S.map.setPlan(a, fill, S.colorMode === "precinct" ? [] : districtLabels());
  }
  function setColorMode(m, silent) {
    S.colorMode = m;
    for (const inp of document.querySelectorAll('#rd-color input')) inp.checked = inp.value === m;
    renderLegend();
    if (S.assign) renderPlan();
    else if (S.map) {
      const cache = LEAN.map((b) => resolveVar(b.color));
      S.map.setPlan(null, (u) => cache[LEAN.findIndex((b) => S.margin[u] >= b.min)], []);
    }
    if (!silent) S.map && S.map.draw();
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
  function onHover(u, x, y) {
    const tip = el.tip;
    if (u < 0 || !S.data) {
      tip.hidden = true;
      if (S.hoverDistrict >= 0) { S.hoverDistrict = -1; S.map.highlightDistrict = -1; S.map.draw(true); highlightRow(-1); }
      return;
    }
    const d = S.data;
    const t = d.dem[u] + d.rep[u];
    const county = d.counties[d.county[u]].name;
    const name = d.id[u].replace(/^\d{5}-?/, "") || d.id[u];
    let html = '<div class="rd-tip-h">' + escapeHtml(name) + ' <span class="muted">' + escapeHtml(county) + "</span></div>" +
      '<div class="mono small">' + fmt(d.pop[u]) + " people · " + (t ? "Harris " + pct(d.dem[u] / t) + " · Trump " + pct(d.rep[u] / t) : "no votes reported") + "</div>";
    let di = -1;
    if (S.assign && S.report) {
      di = S.assign[u];
      const ds = S.report.districts[di];
      if (ds) {
        const m = 100 * (2 * ds.share - 1);
        html += '<div class="rd-tip-d"><strong>District ' + (di + 1) + "</strong> · " + marginText(m) + '<div class="mono small">' + fmt(ds.pop) + " people (" + (ds.dev >= 0 ? "+" : "") + pct(ds.dev, 2) + ") · Polsby–Popper " + ds.pp.toFixed(2) + "</div></div>";
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
      S.map.draw(true);
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
  function renderResults(final) {
    const r = S.report;
    if (!r) return;
    el.results.hidden = false;
    const k = r.k;
    const dWins = r.seats.winD, rWins = k - dWins;
    const goal = r.goal || {};
    const goalCls = r.phase === "done" || r.phase === "polish" || r.phase === "final" ? (goal.achieved ? "is-good" : S.opts.mode === "neutral" ? "" : "is-warn") : "";
    const c = r.contiguity;
    const water = c.water.reduce((a, b) => a + b, 0);
    const tiles = [];
    tiles.push(tile("Seats", '<span class="party-d-ink">' + dWins + " D</span> – <span class=\"party-r-ink\">" + rWins + " R</span>",
      escapeHtml(goal.text || "") + (S.opts.margin > 0 && S.opts.mode !== "neutral" && S.opts.mode !== "competitive" ? "<br>Safe (" + S.opts.margin + "+ pts): " + r.seats.safeD + " D, " + r.seats.safeR + " R" : ""), goalCls));
    tiles.push(tile("Vote vs. seats", pct(r.stateShare) + " → " + pct(dWins / k, 0), "Harris share of the two-party vote, and of seats"));
    tiles.push(tile("Contiguity", c.ok ? "✓ all " + k : "✗ " + c.broken.length + " broken",
      c.ok ? "Every district is one connected piece" + (water ? " (" + water + " cross water to islands)" : "") : "Districts " + c.broken.map((x) => x + 1).join(", ") + " are split", c.ok ? "is-good" : "is-bad"));
    tiles.push(tile("Population", "±" + pct(r.maxDev, 2), "Largest gap from the ideal " + fmt(r.ideal) + " (limit ±" + pct(r.tol, 2) + ")", r.maxDev <= r.userTol + 1e-9 ? "" : "is-warn"));
    tiles.push(tile("Compactness", r.meanPP.toFixed(2), "Average Polsby–Popper (1 = circle). Least compact: " + Math.min.apply(null, r.districts.map((x) => x.pp)).toFixed(2)));
    tiles.push(tile("County splits", fmt(r.splitCounties), "of " + S.data.counties.length + " counties are split between districts"));
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
    const slot = iw / k, bw = Math.max(2, slot - 2);
    let s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Harris share of the two-party vote in each district, sorted">';
    for (let v = lo; v <= hi + 1e-9; v += 0.1) {
      const yy = y(v).toFixed(1);
      s += '<line class="rd-grid' + (Math.abs(v - 0.5) < 1e-9 ? " rd-grid-50" : "") + '" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '"/>';
      s += '<text class="rd-axis" x="' + (padL - 6) + '" y="' + yy + '" text-anchor="end" dominant-baseline="middle">' + Math.round(v * 100) + "%</text>";
    }
    const y50 = y(0.5);
    ds.forEach((d, i) => {
      const x = padL + i * slot + (slot - bw) / 2;
      const yv = y(d.share);
      const top = Math.min(yv, y50), h = Math.max(1, Math.abs(yv - y50));
      const cls = d.share > 0.5 ? "rd-bar-d" : "rd-bar-r";
      const m = 100 * (2 * d.share - 1);
      s += '<g class="rd-barg" data-d="' + d.id + '"><rect class="rd-hit" x="' + (padL + i * slot).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + ih + '"/>' +
        '<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(3, bw / 3).toFixed(1) + '"/>' +
        "<title>District " + (d.id + 1) + ": Harris " + pct(d.share) + " (" + marginText(m) + ")</title></g>";
    });
    const ys = y(r.stateShare).toFixed(1);
    s += '<line class="rd-state-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ys + '" y2="' + ys + '"/>';
    s += '<text class="rd-axis" x="' + padL + '" y="' + (H - 6) + '">weakest D district</text><text class="rd-axis" x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end">strongest D district</text>';
    s += "</svg>";
    el.chart.innerHTML = s;
    S.chartWidth = W;
    for (const g of el.chart.querySelectorAll(".rd-barg")) {
      g.addEventListener("mouseenter", () => { const di = +g.dataset.d; S.map.highlightDistrict = di; S.map.draw(true); highlightRow(di); });
      g.addEventListener("mouseleave", () => { S.map.highlightDistrict = -1; S.map.draw(true); highlightRow(-1); });
    }
  }

  function renderTable(r) {
    const rows = r.districts.map((d) => {
      const t = d.dem + d.rep;
      const m = 100 * (2 * d.share - 1);
      return '<tr data-d="' + d.id + '"><th scope="row"><span class="rd-dot" style="background:' + leanColor(m) + '"></span>' + (d.id + 1) + "</th>" +
        "<td>" + fmt(d.pop) + "</td><td>" + (d.dev >= 0 ? "+" : "") + pct(d.dev, 2) + "</td>" +
        "<td>" + pct(t ? d.dem / t : 0) + "</td><td>" + pct(t ? d.rep / t : 0) + "</td>" +
        '<td class="' + (m > 0 ? "party-d-ink" : "party-r-ink") + '">' + marginText(m) + "</td>" +
        "<td>" + d.pp.toFixed(2) + "</td><td>" + fmt(d.precincts) + "</td><td>" + d.counties + "</td></tr>";
    });
    el.tbody.innerHTML = rows.join("");
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
  function exportCsv() {
    if (!S.assign) return;
    const d = S.data;
    const lines = ["precinct_geoid,county_fips,county,district"];
    for (let u = 0; u < d.n; u++) {
      const c = d.counties[d.county[u]];
      lines.push('"' + d.id[u].replace(/"/g, '""') + '",' + c.fips + ',"' + c.name + '",' + (S.assign[u] + 1));
    }
    download(S.st.toLowerCase() + "-districts-seed" + S.seedUsed + ".csv", new Blob([lines.join("\n")], { type: "text/csv" }));
  }
  function exportPng() {
    if (!S.map) return;
    S.map.canvas.toBlob((b) => b && download(S.st.toLowerCase() + "-map.png", b));
  }

  // ---------- wiring ----------
  el.form.addEventListener("submit", (e) => { e.preventDefault(); start(); });
  el.form.elements.state.forEach((r) => r.addEventListener("change", () => { el.target.dataset.touched = ""; loadState(r.value); }));
  el.form.elements.mode.forEach((r) => r.addEventListener("change", syncMode));
  el.k.addEventListener("input", syncK);
  el.kReset.addEventListener("click", () => { el.k.value = STATES[S.st].seats; el.target.dataset.touched = ""; syncK(); });
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
  document.querySelectorAll('#rd-color input').forEach((r) => r.addEventListener("change", () => setColorMode(r.value)));
  $("rd-zoom-in").addEventListener("click", () => S.map && S.map.zoomAt(S.map.w / 2, S.map.h / 2, 1.6));
  $("rd-zoom-out").addEventListener("click", () => S.map && S.map.zoomAt(S.map.w / 2, S.map.h / 2, 1 / 1.6));
  $("rd-zoom-reset").addEventListener("click", () => S.map && S.map.resetView());
  el.csv.addEventListener("click", exportCsv);
  el.png.addEventListener("click", exportPng);
  el.tbody.addEventListener("mouseover", (e) => {
    const tr = e.target.closest("tr");
    if (!tr || !S.map) return;
    S.map.highlightDistrict = +tr.dataset.d; S.map.draw(true); highlightRow(+tr.dataset.d);
  });
  el.tbody.addEventListener("mouseleave", () => { if (S.map) { S.map.highlightDistrict = -1; S.map.draw(true); highlightRow(-1); } });
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { const d = $(b.dataset.open); if (d && d.showModal) d.showModal(); }));
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  });
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderLegend(); if (S.assign) renderPlan(); else setColorMode(S.colorMode, true); });

  window.addEventListener("resize", () => {
    if (S.report && !el.results.hidden && Math.abs((el.chart.clientWidth || 0) - (S.chartWidth || 0)) > 20) renderChart(S.report);
  });

  syncMode();
  renderLegend();
  loadState(el.form.elements.state.value);
})();
