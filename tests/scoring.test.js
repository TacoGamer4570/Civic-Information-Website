// Run with: node tests/scoring.test.js
const assert = require("assert");
const { QUESTIONS } = require("../js/data/questions.js");
const { STATES } = require("../js/data/elections.js");
const S = require("../js/scoring.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; }
}

// Answer every question in the most left + most liberal way.
function extremeAnswers(econSign, socialSign) {
  const a = {};
  QUESTIONS.forEach((q) => {
    const want = q.axis === "econ" ? econSign : socialSign; // +1 right / +1 liberal
    a[q.id] = 2 * want * q.dir;
  });
  return a;
}

console.log("scores");
test("all-left, all-liberal answers give econ -10 and social +10", () => {
  const s = S.computeScores(QUESTIONS, extremeAnswers(-1, 1), {});
  assert.strictEqual(s.econ, -10);
  assert.strictEqual(s.social, 10);
});
test("all-right, all-conservative answers give econ +10 and social -10", () => {
  const s = S.computeScores(QUESTIONS, extremeAnswers(1, -1), {});
  assert.strictEqual(s.econ, 10);
  assert.strictEqual(s.social, -10);
});
test("all neutral answers give 0 / 0", () => {
  const a = {}; QUESTIONS.forEach((q) => (a[q.id] = 0));
  const s = S.computeScores(QUESTIONS, a, {});
  assert.strictEqual(s.econ, 0);
  assert.strictEqual(s.social, 0);
});
test("no answers gives 0 / 0 without NaN", () => {
  const s = S.computeScores(QUESTIONS, {}, {});
  assert.strictEqual(s.econ, 0);
  assert.strictEqual(s.social, 0);
});
test("starred questions count double", () => {
  // e1 agree (left), e2 agree (right). Starring e1 should tilt left.
  const s = S.computeScores(QUESTIONS, { e1: 2, e2: 2 }, { e1: true });
  assert.ok(s.econ < 0, "expected left tilt, got " + s.econ);
});
test("both axes stay within -10..10 for random answers", () => {
  for (let i = 0; i < 200; i++) {
    const a = {}, imp = {};
    QUESTIONS.forEach((q) => { if (Math.random() > 0.2) a[q.id] = Math.floor(Math.random() * 5) - 2; if (Math.random() > 0.8) imp[q.id] = true; });
    const s = S.computeScores(QUESTIONS, a, imp);
    assert.ok(s.econ >= -10 && s.econ <= 10 && s.social >= -10 && s.social <= 10);
  }
});

console.log("matching");
test("identical position is a 100% match", () => {
  const m = S.matchCandidate({ econ: 3, social: -2, answers: {} }, { econ: 3, social: -2 });
  assert.strictEqual(m.pct, 100);
});
test("opposite corners are a 0% match", () => {
  const m = S.matchCandidate({ econ: -10, social: 10, answers: {} }, { econ: 10, social: -10 });
  assert.strictEqual(m.pct, 0);
});
test("a progressive user matches the Democrat over the Republican in a two-party race", () => {
  const ans = extremeAnswers(-1, 1);
  const sc = S.computeScores(QUESTIONS, ans, {});
  const user = { econ: sc.econ, social: sc.social, answers: ans, important: {} };
  const rec = S.recommendRace(user, STATES.KY.races[0]);
  assert.strictEqual(rec.top.cand.party, "D");
  assert.ok(rec.byParty && rec.byParty.D && rec.byParty.R);
});
test("a conservative user matches the Republican", () => {
  const ans = extremeAnswers(1, -1);
  const sc = S.computeScores(QUESTIONS, ans, {});
  const user = { econ: sc.econ, social: sc.social, answers: ans, important: {} };
  assert.strictEqual(S.recommendRace(user, STATES.KY.races[0]).top.cand.party, "R");
});
test("issue stances shift the match when they agree", () => {
  const cand = { econ: 0, social: 0, stances: { s1: 2 } };
  const agree = S.matchCandidate({ econ: 0, social: 0, answers: { s1: 2 } }, cand);
  const disagree = S.matchCandidate({ econ: 0, social: 0, answers: { s1: -2 } }, cand);
  assert.ok(agree.pct > disagree.pct);
});

console.log("yes/no measures");
test("a user who wants data-center limits gets YES on the Ohio measure", () => {
  const ans = { e11: 2 };
  const sc = S.computeScores(QUESTIONS, ans, {});
  const r = S.recommendRace({ econ: sc.econ, social: sc.social, answers: ans }, STATES.OH.races[0]);
  assert.strictEqual(r.vote, "YES");
});
test("a user who opposes data-center limits gets NO", () => {
  const ans = { e11: -2 };
  const sc = S.computeScores(QUESTIONS, ans, {});
  const r = S.recommendRace({ econ: sc.econ, social: sc.social, answers: ans }, STATES.OH.races[0]);
  assert.strictEqual(r.vote, "NO");
});

console.log("share links");
test("encode/decode round-trips answers and stars", () => {
  const a = { e1: 2, e2: -1, s3: 0, s11: -2 };
  const imp = { e2: true, s11: true };
  const str = S.encodeAnswers(QUESTIONS, a, imp);
  assert.strictEqual(str.length, QUESTIONS.length);
  const back = S.decodeAnswers(QUESTIONS, str);
  assert.deepStrictEqual(back.answers, a);
  assert.deepStrictEqual(back.important, imp);
});
test("decode ignores junk characters", () => {
  const back = S.decodeAnswers(QUESTIONS, "zz<>");
  assert.deepStrictEqual(back.answers, {});
});

console.log("data integrity");
const qids = new Set(QUESTIONS.map((q) => q.id));
test("every state has a name, tier, races array, and official link", () => {
  Object.entries(STATES).forEach(([code, st]) => {
    assert.ok(st.name && st.tier && Array.isArray(st.races) && st.official && st.official.url, code);
  });
  assert.strictEqual(Object.keys(STATES).length, 51);
});
test("every candidate has valid scores, status, confidence, and stance ids", () => {
  const statuses = new Set(["declared", "expected", "exploring", "undecided"]);
  Object.entries(STATES).forEach(([code, st]) => st.races.forEach((r) => (r.candidates || []).forEach((c) => {
    const where = code + " / " + r.office + " / " + c.name;
    assert.ok(c.econ >= -10 && c.econ <= 10, where + " econ");
    assert.ok(c.social >= -10 && c.social <= 10, where + " social");
    assert.ok(statuses.has(c.status), where + " status");
    assert.ok(["high", "medium", "low"].includes(c.confidence), where + " confidence");
    assert.ok(["D", "R", "NP"].includes(c.party), where + " party");
    Object.entries(c.stances || {}).forEach(([q, v]) => {
      assert.ok(qids.has(q), where + " unknown question " + q);
      assert.ok(v >= -2 && v <= 2, where + " stance range");
    });
    assert.ok(c.sources && c.sources.length, where + " needs a source");
  })));
});
test("yes/no races have both positions and valid linked questions", () => {
  Object.values(STATES).forEach((st) => st.races.forEach((r) => {
    if (r.type === "candidate") return;
    assert.ok(r.yes && r.no, r.id);
    (r.linked || []).forEach((l) => assert.ok(qids.has(l.q), r.id + " linked " + l.q));
  }));
});
test("race ids are unique", () => {
  const ids = [];
  Object.values(STATES).forEach((st) => st.races.forEach((r) => ids.push(r.id)));
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log("\n" + passed + " passed" + (process.exitCode ? ", some FAILED" : ""));
