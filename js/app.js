/* ballot/decoded — app UI. Plain JS, no build step. */
(function () {
  "use strict";

  var Q = VG.QUESTIONS;
  var A = VG.ANSWERS;
  var STATES = VG.STATES;
  var score = VG.score;
  var STORE_KEY = "ballot-decoded-2027-v1";
  var WEAK = 50; // match % below this counts as a weak match

  var S = { view: "home", state: null, idx: 0, answers: {}, important: {}, done: false };
  var app = document.getElementById("app");

  // ---------------------------------------------------------------- utils
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtDate(iso, opts) {
    var p = iso.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
    return d.toLocaleDateString("en-US", Object.assign({ month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }, opts || {}));
  }
  function signed(n) { return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1); }
  function answeredCount() { return Object.keys(S.answers).length; }
  function lastName(n) { var p = n.split(" "); return p[p.length - 1]; }
  function qById(id) { for (var i = 0; i < Q.length; i++) if (Q[i].id === id) return Q[i]; return null; }
  function answerLabel(v) { for (var i = 0; i < A.length; i++) if (A[i].value === v) return A[i].label.toLowerCase(); return "?"; }
  function isActive(st) { return st.tier === "full" || st.tier === "judicial" || st.tier === "measures"; }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ state: S.state, idx: S.idx, answers: S.answers, important: S.important, done: S.done }));
    } catch (e) { /* storage unavailable: fine */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && typeof d === "object") {
        S.state = STATES[d.state] ? d.state : null;
        S.idx = Math.min(Math.max(0, d.idx | 0), Q.length - 1);
        S.answers = d.answers || {};
        S.important = d.important || {};
        S.done = !!d.done;
      }
    } catch (e) { /* ignore */ }
  }

  function userProfile() {
    var sc = score.computeScores(Q, S.answers, S.important);
    return { econ: sc.econ, social: sc.social, answered: sc.answered, answers: S.answers, important: S.important };
  }

  function shareUrl() {
    var base = location.href.split("#")[0];
    return base + "#s=" + encodeURIComponent(S.state || "") + "&a=" + score.encodeAnswers(Q, S.answers, S.important);
  }

  function readHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h) return false;
    var params = {};
    h.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    if (params.s && STATES[params.s] && params.a) {
      var dec = score.decodeAnswers(Q, params.a);
      if (Object.keys(dec.answers).length) {
        S.state = params.s;
        S.answers = dec.answers;
        S.important = dec.important;
        S.idx = Q.length - 1;
        S.done = true;
        return true;
      }
    }
    return false;
  }

  function go(view) {
    S.view = view;
    if (view === "results") { S.done = true; save(); }
    if (view !== "results" && location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (view === "results") history.replaceState(null, "", shareUrl().replace(location.href.split("#")[0], ""));
    render();
    window.scrollTo(0, 0);
    var h = app.querySelector("h1");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }

  // ---------------------------------------------------------------- shared bits
  function partyChip(c) {
    if (c.party === "D") return '<span class="party party-d" title="Democrat">DEM</span>';
    if (c.party === "R") return '<span class="party party-r" title="Republican">REP</span>';
    return '<span class="party party-np" title="Nonpartisan race">' + esc(c.lean || "nonpartisan") + "</span>";
  }
  var STATUS_TEXT = { declared: "running", expected: "expected to run", exploring: "exploring a run", undecided: "hasn't decided" };
  function statusChip(st) {
    return '<span class="status status-' + esc(st) + '">' + esc(STATUS_TEXT[st] || st) + "</span>";
  }
  function confChip(c) {
    return '<span class="conf conf-' + esc(c) + '" title="How much public record this estimate is based on">' + esc(c) + " confidence</span>";
  }
  function sourcesList(srcs) {
    if (!srcs || !srcs.length) return "";
    return '<p class="sources">sources: ' + srcs.map(function (s) {
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.label) + "</a>";
    }).join(" · ") + "</p>";
  }

  // ---------------------------------------------------------------- HOME
  function renderHome() {
    var active = Object.keys(STATES).filter(function (k) { return isActive(STATES[k]); });
    var order = { full: 0, judicial: 1, measures: 2 };
    active.sort(function (a, b) { return order[STATES[a].tier] - order[STATES[b].tier] || STATES[a].name.localeCompare(STATES[b].name); });

    var progress = answeredCount();
    var resume = progress > 0 || S.done
      ? '<button class="btn btn-ghost" type="button" data-action="resume">' +
        (S.done ? "see my results again" : "pick up where I left off (" + (S.idx + 1) + "/" + Q.length + ")") + "</button>"
      : "";

    return '' +
      '<section class="hero">' +
        '<p class="eyebrow"><span class="sticker sticker-tilt">2027 elections</span> <span class="mono">statewide edition</span></p>' +
        '<h1 class="hero-title">your 2027 ballot,<br><span class="serif hl">decoded.</span></h1>' +
        '<p class="lede">Pick your state and answer ' + Q.length + ' quick policy questions. We match you against every statewide race on your 2027 ballot, from governor down to agriculture commissioner, plus ballot measures and court races. Then we build your suggested ballot.</p>' +
        '<div class="cta-row"><button class="btn btn-primary btn-lg" type="button" data-go="state">let\'s go <span aria-hidden="true">→</span></button>' + resume + '</div>' +
        '<ol class="steps">' +
          '<li class="card step"><span class="step-n">01</span><strong>where do you vote?</strong><span>pick your state</span></li>' +
          '<li class="card step"><span class="step-n">02</span><strong>what do you think?</strong><span>' + Q.length + ' questions · ~4 min · no party labels</span></li>' +
          '<li class="card step"><span class="step-n">03</span><strong>your ballot</strong><span>closest match in every race, with receipts</span></li>' +
        '</ol>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>on the ballot in 2027</h2><p class="muted">Off-year elections are small, but they decide governors, attorneys general, and state supreme courts. Tap a state to start.</p></div>' +
        '<div class="state-feature-grid">' + active.map(function (code) {
          var st = STATES[code];
          var dates = st.dates.map(function (d) { return '<li><span class="mono">' + esc(fmtDate(d.date, { year: undefined })) + "</span> " + esc(d.label) + "</li>"; }).join("");
          var count = st.races.length;
          return '<button type="button" class="card state-feature tier-' + esc(st.tier) + '" data-pick="' + code + '">' +
            '<span class="sf-top"><span class="sf-code mono">' + code + '</span><span class="sf-count">' + count + (count === 1 ? " race" : " races") + "</span></span>" +
            '<span class="sf-name">' + esc(st.name) + "</span>" +
            '<span class="sf-head">' + esc(st.headline) + "</span>" +
            '<ul class="sf-dates">' + dates + "</ul>" +
          "</button>";
        }).join("") + "</div>" +
        '<p class="muted small">Texas, Washington, Colorado, Maine, and New Jersey may add ballot measures once their 2027 lists are set. Every other state is in the picker too.</p>' +
      "</section>" +

      '<section class="section principles">' +
        '<div class="card principle"><span class="p-icon" aria-hidden="true">⚖︎</span><h3>no party labels in the quiz</h3><p>You answer on issues, not teams. Parties only show up when we show you the candidates.</p></div>' +
        '<div class="card principle"><span class="p-icon" aria-hidden="true">🔗</span><h3>every placement has receipts</h3><p>Each candidate shows sources and a confidence level, so you can check our work.</p></div>' +
        '<div class="card principle"><span class="p-icon" aria-hidden="true">🔒</span><h3>your answers stay with you</h3><p>Everything runs in your browser. Nothing is sent or stored on a server.</p></div>' +
      "</section>";
  }

  // ---------------------------------------------------------------- STATE PICKER
  function renderStatePicker() {
    var codes = Object.keys(STATES).sort(function (a, b) { return STATES[a].name.localeCompare(STATES[b].name); });
    var active = codes.filter(function (c) { return isActive(STATES[c]); });
    var rest = codes.filter(function (c) { return !isActive(STATES[c]); });
    function btn(code) {
      var st = STATES[code];
      var tag = st.tier === "full" ? "governor + more" : st.tier === "judicial" ? "supreme court" : st.tier === "measures" ? "ballot measure" : st.tier === "watch" ? "maybe measures" : "";
      return '<button type="button" class="state-btn tier-' + esc(st.tier) + (S.state === code ? " is-current" : "") + '" data-pick="' + code + '" data-name="' + esc(st.name.toLowerCase()) + '">' +
        '<span class="sb-code mono">' + code + "</span>" +
        '<span class="sb-name">' + esc(st.name) + "</span>" +
        (tag ? '<span class="sb-tag">' + tag + "</span>" : "") +
      "</button>";
    }
    return '' +
      '<section class="section narrow">' +
        '<p class="eyebrow mono">step 01 / 03</p>' +
        '<h1>where do you vote?</h1>' +
        '<p class="lede">We\'ll pull up every statewide race and ballot measure on your 2027 ballot.</p>' +
        '<label class="search"><span class="sr-only">Search states</span><input id="state-search" type="search" placeholder="type your state…" autocomplete="off"></label>' +
        '<h2 class="group-title">on the ballot in 2027</h2>' +
        '<div class="state-grid">' + active.map(btn).join("") + "</div>" +
        '<h2 class="group-title">everyone else <span class="muted small">(nothing statewide yet, but you can still get your scores)</span></h2>' +
        '<div class="state-grid">' + rest.map(btn).join("") + "</div>" +
        '<p class="none-found muted" hidden>No state matches that. Try the two-letter code?</p>' +
      "</section>";
  }

  // ---------------------------------------------------------------- QUIZ
  function renderQuiz() {
    var q = Q[S.idx];
    var cur = S.answers[q.id];
    var pct = Math.round((S.idx / Q.length) * 100);
    var st = STATES[S.state];
    return '' +
      '<section class="section narrow quiz">' +
        '<div class="quiz-top">' +
          '<p class="eyebrow mono">step 02 / 03 · ' + esc(st ? st.name : "") + ' <button type="button" class="link-btn small" data-go="state">change</button></p>' +
          '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + Q.length + '" aria-valuenow="' + S.idx + '" aria-label="Quiz progress"><span style="width:' + pct + '%"></span></div>' +
          '<p class="mono progress-label"><strong>' + String(S.idx + 1).padStart(2, "0") + "</strong> / " + Q.length + "</p>" +
        "</div>" +
        '<div class="card q-card">' +
          '<span class="chip chip-topic">' + esc(q.topic) + "</span>" +
          '<h1 class="q-text">' + esc(q.text) + "</h1>" +
          '<div class="answers" role="radiogroup" aria-label="Your answer">' +
            A.map(function (a, i) {
              var on = cur === a.value;
              return '<button type="button" role="radio" aria-checked="' + on + '" class="answer' + (on ? " is-on" : "") + '" data-answer="' + a.value + '">' +
                '<span class="kbd mono" aria-hidden="true">' + (i + 1) + "</span>" +
                '<span class="answer-label">' + esc(a.label) + "</span>" +
              "</button>";
            }).join("") +
          "</div>" +
          '<label class="star-toggle"><input type="checkbox" id="star"' + (S.important[q.id] ? " checked" : "") + '> <span class="star" aria-hidden="true">★</span> this one matters a lot to me <span class="muted">(counts double)</span></label>' +
        "</div>" +
        '<div class="q-nav">' +
          '<button type="button" class="btn btn-ghost" data-action="back"' + (S.idx === 0 ? " disabled" : "") + '>← back</button>' +
          '<button type="button" class="btn btn-ghost" data-action="skip">' + (S.idx === Q.length - 1 ? "skip & see results →" : "skip →") + "</button>" +
        "</div>" +
        '<p class="muted small center hint">tip: press 1–5 to answer, ← to go back</p>' +
      "</section>";
  }

  // ---------------------------------------------------------------- RESULTS
  function scaleBar(label, value, leftLabel, rightLabel, invert) {
    // invert: social axis shows +10 (liberal) on the left
    var pos = invert ? (10 - value) / 20 : (value + 10) / 20;
    return '<div class="scale">' +
      '<div class="scale-head"><span class="scale-label">' + label + '</span><span class="scale-val mono">' + signed(value) + "</span></div>" +
      '<div class="scale-track"><span class="scale-mid"></span><span class="scale-dot" style="left:' + (pos * 100).toFixed(1) + '%"></span></div>' +
      '<div class="scale-ends mono small"><span>' + leftLabel + "</span><span>" + rightLabel + "</span></div>" +
    "</div>";
  }

  function compass(user, st) {
    var W = 300, P = 34, size = W + P * 2;
    function x(e) { return P + ((e + 10) / 20) * W; }
    function y(s) { return P + ((10 - s) / 20) * W; }
    var dots = [];
    st.races.forEach(function (r) {
      if (r.type !== "candidate") return;
      r.candidates.forEach(function (c) {
        dots.push(c);
      });
    });
    // de-dupe by name
    var seen = {};
    dots = dots.filter(function (c) { if (seen[c.name]) return false; seen[c.name] = 1; return true; });

    var grid = "";
    for (var i = -10; i <= 10; i += 5) {
      grid += '<line x1="' + x(i) + '" y1="' + P + '" x2="' + x(i) + '" y2="' + (P + W) + '" class="g' + (i === 0 ? " g0" : "") + '"/>';
      grid += '<line x1="' + P + '" y1="' + y(i) + '" x2="' + (P + W) + '" y2="' + y(i) + '" class="g' + (i === 0 ? " g0" : "") + '"/>';
    }
    // Nudge dots apart so candidates with near-identical positions stay readable.
    var placed = [];
    var MIN = 21;
    var cands = dots.map(function (c, i) {
      var cls = c.party === "D" ? "pd" : c.party === "R" ? "pr" : "pn";
      var px = x(c.econ), py = y(c.social), step = 0;
      function clash() {
        return placed.some(function (p) { return Math.hypot(p[0] - px, p[1] - py) < MIN; });
      }
      while (clash() && step < 40) {
        step++;
        var ang = step * 2.4, rad = 6 + step * 2.2;
        px = Math.min(P + W - 8, Math.max(P + 8, x(c.econ) + Math.cos(ang) * rad));
        py = Math.min(P + W - 8, Math.max(P + 8, y(c.social) + Math.sin(ang) * rad));
      }
      placed.push([px, py]);
      return '<g class="cdot ' + cls + '" transform="translate(' + px.toFixed(1) + "," + py.toFixed(1) + ')">' +
        "<title>" + esc(c.name) + " (" + esc(c.party === "NP" ? c.lean : c.party) + "): economy " + signed(c.econ) + ", social " + signed(c.social) + "</title>" +
        '<circle r="10"/><text dy="3.5">' + (i + 1) + "</text></g>";
    }).join("");
    var you = '<g class="you" transform="translate(' + x(user.econ).toFixed(1) + "," + y(user.social).toFixed(1) + ')">' +
      "<title>You: economy " + signed(user.econ) + ", social " + signed(user.social) + "</title>" +
      '<circle r="15"/><text dy="4">you</text></g>';

    var legend = dots.length ? '<ul class="legend">' + dots.map(function (c, i) {
      var cls = c.party === "D" ? "pd" : c.party === "R" ? "pr" : "pn";
      return '<li><span class="ldot ' + cls + '">' + (i + 1) + "</span>" + esc(c.name) + "</li>";
    }).join("") + "</ul>" : '<p class="muted small">No candidates to plot in this state yet.</p>';

    return '<figure class="compass">' +
      '<svg viewBox="0 0 ' + size + " " + size + '" role="img" aria-label="Map of your position and the candidates\' estimated positions">' +
        '<rect x="' + P + '" y="' + P + '" width="' + W + '" height="' + W + '" class="plot-bg" rx="10"/>' +
        grid +
        '<text x="' + (P + W / 2) + '" y="' + (P - 12) + '" class="axis-l" text-anchor="middle">liberal ↑</text>' +
        '<text x="' + (P + W / 2) + '" y="' + (P + W + 24) + '" class="axis-l" text-anchor="middle">↓ conservative</text>' +
        '<text x="' + (P - 8) + '" y="' + (P + W / 2) + '" class="axis-l" text-anchor="middle" transform="rotate(-90 ' + (P - 12) + " " + (P + W / 2) + ')">← econ left</text>' +
        '<text x="' + (P + W + 12) + '" y="' + (P + W / 2) + '" class="axis-l" text-anchor="middle" transform="rotate(90 ' + (P + W + 12) + " " + (P + W / 2) + ')">econ right →</text>' +
        cands + you +
      "</svg>" +
      '<figcaption>' + legend + "</figcaption>" +
    "</figure>";
  }

  function alphaByLast(a, b) { return lastName(a.name).localeCompare(lastName(b.name)); }

  function ballotPaper(user, st, code) {
    var rows = st.races.map(function (r) {
      if (r.type === "candidate") {
        var rec = score.recommendRace(user, r);
        var head = '<div class="b-office"><span>' + esc(r.office) + '</span><span class="b-vote">vote for one</span></div>';
        if (!r.candidates.length) {
          return '<div class="b-race">' + head + '<div class="b-row b-tbd"><span class="oval" aria-hidden="true"></span><span class="b-name">candidates TBD</span></div></div>';
        }
        // A lone candidate who's a poor fit isn't a real "pick": leave the oval empty.
        var lonePoorFit = r.candidates.length === 1 && rec.top.match.pct < WEAK;
        var pickName = rec.top && !lonePoorFit ? rec.top.cand.name : null;
        var matchByName = {};
        rec.ranked.forEach(function (x) { matchByName[x.cand.name] = x.match.pct; });
        var sorted = r.candidates.slice().sort(alphaByLast);
        return '<div class="b-race">' + head + sorted.map(function (c) {
          var picked = c.name === pickName;
          return '<div class="b-row' + (picked ? " picked" : "") + '">' +
            '<span class="oval" aria-hidden="true"></span>' +
            '<span class="b-name">' + esc(c.name) + (picked ? '<span class="sr-only"> (suggested)</span>' : "") +
              (c.status !== "declared" ? ' <span class="b-note">' + esc(STATUS_TEXT[c.status]) + "</span>" : "") + "</span>" +
            '<span class="b-party mono">' + esc(c.party === "D" ? "DEM" : c.party === "R" ? "REP" : "") + "</span>" +
            '<span class="b-pct mono">' + matchByName[c.name] + "%</span>" +
          "</div>";
        }).join("") +
        (lonePoorFit ? '<p class="b-close mono">⚠ only candidate so far, and not a close match. Your call: vote, skip, or write in.</p>'
          : rec.top.match.pct < WEAK ? '<p class="b-close mono">⚠ weak match: nobody in this race is close to you</p>'
          : rec.close ? '<p class="b-close mono">⚠ close call (within 3 pts)</p>' : "") +
        "</div>";
      }
      // yes / no
      var yn = score.recommendRace(user, r);
      var label = r.type === "retention" ? "retention" : (r.status === "proposed" ? "proposed measure: not certified" : "ballot measure");
      return '<div class="b-race">' +
        '<div class="b-office"><span>' + esc(r.office) + '</span><span class="b-vote">' + label + "</span></div>" +
        ["YES", "NO"].map(function (v) {
          var picked = yn.vote === v && yn.strength !== "toss-up";
          return '<div class="b-row' + (picked ? " picked" : "") + '"><span class="oval" aria-hidden="true"></span><span class="b-name">' + v + (picked ? '<span class="sr-only"> (suggested)</span>' : "") + "</span><span></span>" +
            '<span class="b-pct mono">' + (picked ? esc(yn.strength) : "") + "</span></div>";
        }).join("") +
        (yn.strength === "toss-up" ? '<p class="b-close mono">⚠ toss-up: your answers don\'t point clearly either way</p>' : "") +
      "</div>";
    }).join("");

    var dates = st.dates.map(function (d) { return esc(d.label) + ": " + esc(fmtDate(d.date)); }).join(" · ");
    return '<div class="ballot" id="ballot">' +
      '<div class="ballot-head">' +
        '<div class="bh-row"><span class="mono bh-tag">SAMPLE · NOT AN OFFICIAL BALLOT</span><span class="mono bh-tag">ballot/decoded</span></div>' +
        '<h2 class="bh-title">' + esc(st.name) + ' <span class="serif">2027 statewide</span></h2>' +
        '<p class="mono small">' + dates + "</p>" +
        '<p class="bh-instr small"><span class="oval filled" aria-hidden="true"></span> = closest to your answers. % = your match. Candidates in alphabetical order.</p>' +
      "</div>" +
      rows +
      '<div class="ballot-foot mono small">Your scores: economy ' + signed(user.econ) + " · social " + signed(user.social) + " · " + code + " · data as of " + esc(fmtDate(VG.UPDATED)) + "</div>" +
    "</div>";
  }

  function stanceCompare(details) {
    if (!details.length) return "";
    return '<ul class="compare">' + details.map(function (d) {
      var q = qById(d.qid);
      var cls = d.agree >= 0.75 ? "agree" : d.agree <= 0.25 ? "disagree" : "mixed";
      var icon = cls === "agree" ? "✓" : cls === "disagree" ? "✕" : "~";
      return '<li class="' + cls + '"><span class="cmp-icon" aria-hidden="true">' + icon + "</span>" +
        '<span><strong>' + esc(q ? q.topic : d.qid) + ":</strong> you " + esc(answerLabel(d.user)) + ", they'd likely " + esc(answerLabel(d.cand)) + "</span></li>";
    }).join("") + "</ul>";
  }

  function raceCard(user, r) {
    var head = '<header class="race-head">' +
      '<h3>' + esc(r.office) + "</h3>" +
      '<p class="muted small">' + esc(r.blurb || "") + "</p>" +
      (r.incumbent ? '<p class="small"><span class="mono tag">incumbent</span> ' + esc(r.incumbent) + (r.open ? ' <span class="chip chip-open">open seat</span>' : "") + "</p>" : "") +
    "</header>";

    if (r.type === "candidate") {
      if (!r.candidates.length) {
        return '<article class="card race">' + head + '<div class="empty"><p><strong>No candidates yet.</strong> ' + esc(r.emptyNote || "") + "</p>" + sourcesList(r.sources) + "</div></article>";
      }
      var rec = score.recommendRace(user, r);
      var top = rec.top;
      var summary = '<div class="rec">' +
        '<span class="rec-label mono">closest match</span>' +
        '<span class="rec-name">' + esc(top.cand.name) + "</span>" + partyChip(top.cand) +
        '<span class="rec-pct mono">' + top.match.pct + "%</span>" +
        (rec.close ? '<span class="chip chip-warn">close call</span>' : "") +
        (top.match.pct < WEAK ? '<span class="chip chip-warn">weak match</span>' : "") +
        (r.candidates.length === 1 ? '<span class="chip">only candidate so far</span>' : "") +
      "</div>";

      var primary = "";
      if (rec.byParty) {
        primary = '<p class="primary small"><span class="mono tag">voting in a primary?</span> ' +
          Object.keys(rec.byParty).sort().map(function (p) {
            var x = rec.byParty[p];
            return "closest " + (p === "D" ? "Democrat" : p === "R" ? "Republican" : p) + ": <strong>" + esc(x.cand.name) + "</strong> (" + x.match.pct + "%)";
          }).join(" · ") + "</p>";
      }

      var list = '<ol class="cands">' + rec.ranked.map(function (x, i) {
        var c = x.cand, m = x.match;
        return '<li class="cand' + (i === 0 ? " is-top" : "") + '">' +
          '<div class="cand-row">' +
            '<span class="cand-rank mono">' + (i + 1) + "</span>" +
            '<div class="cand-main">' +
              '<div class="cand-name">' + esc(c.name) + " " + partyChip(c) + " " + statusChip(c.status) + "</div>" +
              '<div class="cand-role muted small">' + esc(c.role) + "</div>" +
            "</div>" +
            '<div class="cand-pct"><span class="mono">' + m.pct + '%</span><span class="meter"><span style="width:' + m.pct + '%"></span></span></div>' +
          "</div>" +
          '<details class="cand-more"><summary>why this score?</summary>' +
            "<p>" + esc(c.summary) + "</p>" +
            '<p class="small mono pos">estimated position: economy ' + signed(c.econ) + " (" + score.econLabel(c.econ) + ") · social " + signed(c.social) + " (" + score.socialLabel(c.social) + ") " + confChip(c.confidence) + "</p>" +
            (m.overlap ? '<p class="small">On issues you answered (' + m.overlap + " compared, " + m.issuePct + "% agreement):</p>" + stanceCompare(m.details) : '<p class="small muted">We don\'t have specific issue stances for this candidate yet, so this match is based on overall position only.</p>') +
            sourcesList(c.sources) +
          "</details>" +
        "</li>";
      }).join("") + "</ol>";

      return '<article class="card race">' + head + summary + primary + list + "</article>";
    }

    // yes/no races
    var yn = score.recommendRace(user, r);
    var linked = (r.linked || []).map(function (l) {
      var q = qById(l.q), ua = S.answers[l.q];
      if (!q || typeof ua !== "number") return "";
      return '<p class="small">Related question: <em>"' + esc(q.text) + '"</em>: you said <strong>' + esc(answerLabel(ua)) + "</strong>.</p>";
    }).join("");
    var verdict = yn.strength === "toss-up"
      ? '<span class="rec-name">toss-up</span><span class="muted small">your answers don\'t point clearly either way</span>'
      : '<span class="rec-name">' + yn.vote + '</span><span class="chip">' + esc(yn.strength) + " lean</span>";
    return '<article class="card race">' + head +
      (r.status === "proposed" ? '<p class="chip chip-warn">not on the ballot yet: still gathering signatures</p>' : "") +
      '<div class="rec"><span class="rec-label mono">' + (r.type === "retention" ? "your views lean" : "suggested") + "</span>" + verdict + "</div>" +
      '<div class="yn">' +
        '<div class="yn-opt' + (yn.vote === "YES" ? " is-pick" : "") + '"><strong>YES</strong><p class="small">' + esc(r.yes.summary) + "</p></div>" +
        '<div class="yn-opt' + (yn.vote === "NO" ? " is-pick" : "") + '"><strong>NO</strong><p class="small">' + esc(r.no.summary) + "</p></div>" +
      "</div>" + linked +
      '<p class="small">' + confChip(r.confidence || "low") + "</p>" +
      sourcesList(r.sources) +
    "</article>";
  }

  function otherStateSelect() {
    var codes = Object.keys(STATES).filter(function (c) { return isActive(STATES[c]) && c !== S.state; });
    return '<label class="peek"><span class="small mono">peek at another state:</span> <select id="peek"><option value="">choose…</option>' +
      codes.map(function (c) { return '<option value="' + c + '">' + esc(STATES[c].name) + "</option>"; }).join("") + "</select></label>";
  }

  function renderResults() {
    var st = STATES[S.state];
    var user = userProfile();
    var arch = score.archetype(user.econ, user.social);
    var skipped = Q.length - user.answered;
    var hasRaces = st.races.length > 0;

    var notFinal = false;
    st.races.forEach(function (r) {
      (r.candidates || []).forEach(function (c) { if (c.status !== "declared") notFinal = true; });
      if (r.type === "candidate" && !r.candidates.length) notFinal = true;
      if (r.status === "proposed") notFinal = true;
    });

    var html = '' +
      '<section class="section results-top">' +
        '<p class="eyebrow mono">step 03 / 03 · ' + esc(st.name) + "</p>" +
        '<h1>you\'re a <span class="serif hl">' + esc(arch.name.toLowerCase()) + ".</span></h1>" +
        '<p class="lede">' + esc(arch.blurb) + (skipped ? ' <span class="muted">(' + skipped + " question" + (skipped === 1 ? "" : "s") + " skipped)</span>" : "") + "</p>" +
        '<div class="actions">' +
          (hasRaces ? '<button type="button" class="btn btn-primary" data-action="print">print / save ballot</button>' : "") +
          '<button type="button" class="btn" data-action="copy">copy share link</button>' +
          '<button type="button" class="btn btn-ghost" data-go="state">change state</button>' +
          '<button type="button" class="btn btn-ghost" data-action="retake">retake quiz</button>' +
        "</div>" +
      "</section>" +

      '<section class="section score-grid">' +
        '<div class="card scores">' +
          "<h2>your scores</h2>" +
          scaleBar("economy", user.econ, "−10 left", "+10 right", false) +
          '<p class="small muted scale-desc">' + score.econLabel(user.econ) + "</p>" +
          scaleBar("social issues", user.social, "+10 liberal", "−10 conservative", true) +
          '<p class="small muted scale-desc">' + score.socialLabel(user.social) + "</p>" +
        "</div>" +
        '<div class="card map">' +
          "<h2>you vs. the field</h2>" +
          compass(user, st) +
        "</div>" +
      "</section>";

    if (hasRaces) {
      html += '<section class="section">' +
        '<div class="section-head"><h2>your suggested ballot</h2>' +
        (notFinal ? '<p class="notice">Heads up: it\'s ' + esc(fmtDate(VG.UPDATED, { day: undefined })) + " and these fields aren't final. Some people listed haven't officially filed, and more candidates will jump in. Check back as the election gets closer.</p>" : "") +
        '<p class="muted small">' + esc(st.systemNote || "") + "</p></div>" +
        ballotPaper(user, st, S.state) +
      "</section>" +
      '<section class="section">' +
        '<div class="section-head"><h2>race by race</h2><p class="muted">Every candidate, ranked by match. Open "why this score?" to see their record and sources.</p></div>' +
        '<div class="races">' + st.races.map(function (r) { return raceCard(user, r); }).join("") + "</div>" +
      "</section>";
    } else {
      html += '<section class="section"><div class="card empty-state">' +
        "<h2>nothing statewide in " + esc(st.name) + " for 2027 <span class=\"serif\">(yet)</span></h2>" +
        "<p>" + esc(st.headline) + ". Your scores above still work, and we'll add races here if anything gets scheduled.</p>" +
        otherStateSelect() +
      "</div></section>";
    }

    html += '<section class="section">' +
      '<div class="card watch">' +
        "<h2>keep an eye on</h2>" +
        "<ul>" + (st.watch || []).map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul>" +
        '<p class="small">Official info: <a href="' + esc(st.official.url) + '" target="_blank" rel="noopener">' + esc(st.official.label) + "</a> · Register or check your registration at <a href=\"https://vote.gov\" target=\"_blank\" rel=\"noopener\">vote.gov</a></p>" +
        (hasRaces ? otherStateSelect() : "") +
      "</div>" +
    "</section>";

    return html;
  }

  // ---------------------------------------------------------------- render + events
  function render() {
    var v = S.view;
    if ((v === "quiz" || v === "results") && !S.state) v = S.view = "state";
    app.innerHTML = v === "home" ? renderHome()
      : v === "state" ? renderStatePicker()
      : v === "quiz" ? renderQuiz()
      : renderResults();
    app.setAttribute("data-view", v);
    document.body.setAttribute("data-view", v);
    if (v === "state") bindSearch();
  }

  function bindSearch() {
    var input = document.getElementById("state-search");
    if (!input) return;
    input.addEventListener("input", function () {
      var term = input.value.trim().toLowerCase();
      var any = false;
      app.querySelectorAll(".state-btn").forEach(function (b) {
        var hit = !term || b.getAttribute("data-name").indexOf(term) !== -1 || b.getAttribute("data-pick").toLowerCase() === term;
        b.hidden = !hit;
        if (hit) any = true;
      });
      app.querySelector(".none-found").hidden = any;
    });
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var first = app.querySelector(".state-btn:not([hidden])");
      if (first) first.click();
    });
  }

  function pickState(code) {
    S.state = code;
    save();
    go(S.done ? "results" : "quiz");
  }

  function answer(val) {
    var q = Q[S.idx];
    S.answers[q.id] = val;
    var star = document.getElementById("star");
    if (star && star.checked) S.important[q.id] = true;
    save();
    // show selection briefly, then advance
    app.querySelectorAll(".answer").forEach(function (b) {
      var on = +b.getAttribute("data-answer") === val;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", on);
    });
    setTimeout(next, 170);
  }

  function next() {
    if (S.idx < Q.length - 1) { S.idx++; save(); render(); focusQuestion(); }
    else { save(); go("results"); }
  }
  function back() {
    if (S.idx > 0) { S.idx--; save(); render(); focusQuestion(); }
  }
  function focusQuestion() {
    var h = app.querySelector(".q-text");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.remove(); }, 300); }, 2200);
  }

  function copyLink() {
    var url = shareUrl();
    function fallback() {
      window.prompt("Copy this link:", url);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast("link copied ✓"); }, fallback);
    } else fallback();
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-go],[data-pick],[data-answer],[data-action],[data-open],[data-close]");
    if (!t) return;
    if (t.hasAttribute("data-go")) {
      var dest = t.getAttribute("data-go");
      go(dest);
    } else if (t.hasAttribute("data-pick")) {
      pickState(t.getAttribute("data-pick"));
    } else if (t.hasAttribute("data-answer")) {
      answer(+t.getAttribute("data-answer"));
    } else if (t.hasAttribute("data-open")) {
      var d = document.getElementById(t.getAttribute("data-open"));
      if (d && d.showModal) d.showModal(); else if (d) d.setAttribute("open", "");
    } else if (t.hasAttribute("data-close")) {
      var dlg = t.closest("dialog");
      if (dlg) dlg.close ? dlg.close() : dlg.removeAttribute("open");
    } else {
      var a = t.getAttribute("data-action");
      if (a === "back") back();
      else if (a === "skip") { delete S.answers[Q[S.idx].id]; next(); }
      else if (a === "print") window.print();
      else if (a === "copy") copyLink();
      else if (a === "retake") { S.answers = {}; S.important = {}; S.idx = 0; S.done = false; save(); go("quiz"); }
      else if (a === "resume") go(!S.state ? "state" : S.done ? "results" : "quiz");
    }
  });

  document.addEventListener("change", function (e) {
    if (e.target.id === "star") {
      var q = Q[S.idx];
      if (e.target.checked) S.important[q.id] = true; else delete S.important[q.id];
      save();
    } else if (e.target.id === "peek" && e.target.value) {
      S.state = e.target.value;
      save();
      go("results");
    }
  });

  // close dialog when clicking the backdrop
  var method = document.getElementById("method");
  method.addEventListener("click", function (e) { if (e.target === method) method.close(); });

  document.addEventListener("keydown", function (e) {
    if (S.view !== "quiz" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== "checkbox") return;
    if (method.open) return;
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= A.length) { e.preventDefault(); answer(A[n - 1].value); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
  });

  // ---------------------------------------------------------------- boot
  document.getElementById("updated").textContent = fmtDate(VG.UPDATED);
  load();
  if (readHash()) { S.view = "results"; save(); }
  render();
})();
