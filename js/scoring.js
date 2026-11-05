/*
 * Scoring + matching.
 *
 * User scores:
 *   econ   -10 (left)    .. +10 (right)
 *   social +10 (liberal) .. -10 (conservative)
 *
 * Candidate match = closeness on the 2D map, blended with question-by-question
 * agreement wherever we know a candidate's stance on a specific issue.
 */
(function (root) {
  var MAX_DIST = Math.sqrt(20 * 20 + 20 * 20); // corner to corner of the map

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function round1(n) { return Math.round(n * 10) / 10; }

  /**
   * answers:   { qid: -2..2 }   (missing = skipped)
   * important: { qid: true }    (counts double)
   */
  function computeScores(questions, answers, important) {
    var sums = { econ: 0, social: 0 }, maxes = { econ: 0, social: 0 }, counts = { econ: 0, social: 0 };
    questions.forEach(function (q) {
      var a = answers[q.id];
      if (typeof a !== "number") return;
      var w = important && important[q.id] ? 2 : 1;
      sums[q.axis] += a * q.dir * w;
      maxes[q.axis] += 2 * w;
      counts[q.axis] += 1;
    });
    function axis(k) { return maxes[k] ? round1(clamp((sums[k] / maxes[k]) * 10, -10, 10)) : 0; }
    return { econ: axis("econ"), social: axis("social"), answered: counts.econ + counts.social, counts: counts };
  }

  function econLabel(e) {
    if (e <= -6) return "far left";
    if (e <= -2) return "left";
    if (e < 2) return "center";
    if (e < 6) return "right";
    return "far right";
  }
  function socialLabel(s) {
    if (s >= 6) return "very liberal";
    if (s >= 2) return "liberal";
    if (s > -2) return "moderate";
    if (s > -6) return "conservative";
    return "very conservative";
  }
  function archetype(e, s) {
    var nearCenter = Math.abs(e) < 2.5 && Math.abs(s) < 2.5;
    if (nearCenter) return { name: "Centrist", blurb: "You mix and match. No side gets your automatic vote." };
    if (e < 0 && s > 0) return { name: "Progressive", blurb: "Bigger role for government on the economy, more personal freedom on social issues." };
    if (e >= 0 && s <= 0) return { name: "Conservative", blurb: "Lower taxes and lighter regulation, with traditional values on social issues." };
    if (e >= 0 && s > 0) return { name: "Libertarian-leaning", blurb: "Free markets and personal freedom: government out of your wallet and your life." };
    return { name: "Populist", blurb: "Government should look out for working people, and traditional values matter." };
  }

  function axisCloseness(user, point) {
    var d = Math.sqrt(Math.pow(user.econ - point.econ, 2) + Math.pow(user.social - point.social, 2));
    return 1 - d / MAX_DIST;
  }

  /** user = { econ, social, answers, important } */
  function matchCandidate(user, cand) {
    var axisPct = axisCloseness(user, cand);
    var wSum = 0, agreeSum = 0, details = [];
    var stances = cand.stances || {};
    Object.keys(stances).forEach(function (qid) {
      var ua = user.answers ? user.answers[qid] : undefined;
      if (typeof ua !== "number") return;
      var w = user.important && user.important[qid] ? 2 : 1;
      var agree = 1 - Math.abs(ua - stances[qid]) / 4;
      wSum += w;
      agreeSum += agree * w;
      details.push({ qid: qid, user: ua, cand: stances[qid], agree: agree });
    });
    var overlap = details.length;
    var issuePct = overlap ? agreeSum / wSum : null;
    // The more specific stances we can compare, the more they count (up to 45%).
    var k = overlap ? Math.min(0.45, 0.15 * overlap) : 0;
    var pct = overlap ? axisPct * (1 - k) + issuePct * k : axisPct;
    return {
      pct: Math.round(clamp(pct, 0, 1) * 100),
      axisPct: Math.round(axisPct * 100),
      issuePct: issuePct === null ? null : Math.round(issuePct * 100),
      overlap: overlap,
      details: details
    };
  }

  function recommendCandidateRace(user, race) {
    var ranked = (race.candidates || []).map(function (c) {
      return { cand: c, match: matchCandidate(user, c) };
    }).sort(function (a, b) { return b.match.pct - a.match.pct; });

    var top = ranked[0] || null;
    var close = !!(ranked[1] && top.match.pct - ranked[1].match.pct < 3);

    var byParty = {};
    ranked.forEach(function (r) {
      var p = r.cand.party;
      if (p === "NP") return;
      if (!byParty[p]) byParty[p] = r;
    });
    var partyCount = Object.keys(byParty).length;
    return { ranked: ranked, top: top, close: close, byParty: partyCount > 1 ? byParty : null };
  }

  /** For ballot measures and retention votes: compare YES position vs NO position. */
  function recommendYesNo(user, race) {
    var yes = axisCloseness(user, race.yes) * 100;
    var no = axisCloseness(user, race.no) * 100;
    var diff = yes - no;
    (race.linked || []).forEach(function (l) {
      var ua = user.answers ? user.answers[l.q] : undefined;
      if (typeof ua !== "number") return;
      var w = user.important && user.important[l.q] ? 2 : 1;
      diff += ua * l.yesIs * 6 * w;
    });
    var abs = Math.abs(diff);
    var strength = abs >= 20 ? "strong" : abs >= 8 ? "lean" : abs >= 3 ? "slight" : "toss-up";
    return { vote: diff >= 0 ? "YES" : "NO", strength: strength, diff: round1(diff) };
  }

  function recommendRace(user, race) {
    if (race.type === "candidate") return recommendCandidateRace(user, race);
    return recommendYesNo(user, race);
  }

  // ---------- share links ----------
  var CODES = { "2": "a", "1": "b", "0": "c", "-1": "d", "-2": "e" };
  var DECODE = { a: 2, b: 1, c: 0, d: -1, e: -2 };

  function encodeAnswers(questions, answers, important) {
    return questions.map(function (q) {
      var a = answers[q.id];
      if (typeof a !== "number") return "-";
      var ch = CODES[String(a)];
      return important && important[q.id] ? ch.toUpperCase() : ch;
    }).join("");
  }

  function decodeAnswers(questions, str) {
    var answers = {}, important = {};
    if (typeof str !== "string") return { answers: answers, important: important };
    questions.forEach(function (q, i) {
      var ch = str.charAt(i);
      if (!ch || ch === "-") return;
      var v = DECODE[ch.toLowerCase()];
      if (typeof v !== "number") return;
      answers[q.id] = v;
      if (ch !== ch.toLowerCase()) important[q.id] = true;
    });
    return { answers: answers, important: important };
  }

  var api = {
    computeScores: computeScores, econLabel: econLabel, socialLabel: socialLabel, archetype: archetype,
    matchCandidate: matchCandidate, recommendRace: recommendRace, recommendYesNo: recommendYesNo,
    recommendCandidateRace: recommendCandidateRace,
    encodeAnswers: encodeAnswers, decodeAnswers: decodeAnswers
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.VG = root.VG || {};
  root.VG.score = api;
})(typeof window !== "undefined" ? window : globalThis);
