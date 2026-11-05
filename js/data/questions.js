/*
 * Quiz questions.
 *
 * Every answer is stored as a number from -2 (strongly disagree) to +2 (strongly agree).
 *
 * axis "econ":   dir +1 means agreeing pushes you RIGHT (+10), dir -1 pushes you LEFT (-10).
 * axis "social": dir +1 means agreeing pushes you LIBERAL (+10), dir -1 pushes you CONSERVATIVE (-10).
 *
 * Candidate "stances" in elections.js use the same ids and the same -2..+2 scale,
 * meaning "how we think this candidate would answer the question".
 */
(function (root) {
  var QUESTIONS = [
    // ---------- economy ----------
    { id: "e1", axis: "econ", dir: -1, topic: "wages",
      text: "My state should raise its minimum wage above the federal $7.25 an hour." },
    { id: "e2", axis: "econ", dir: 1, topic: "taxes",
      text: "Cutting or eliminating the state income tax should be a top priority, even if some public services get smaller." },
    { id: "e3", axis: "econ", dir: -1, topic: "health care",
      text: "Expanding public health coverage, like Medicaid, is worth the cost to the state." },
    { id: "e4", axis: "econ", dir: -1, topic: "labor",
      text: "It should be easier for workers to form unions, even when employers object." },
    { id: "e5", axis: "econ", dir: 1, topic: "school choice",
      text: "Public money should be able to follow students to private or religious schools (vouchers / school choice)." },
    { id: "e6", axis: "econ", dir: 1, topic: "regulation",
      text: "Businesses in my state face too much regulation. Cutting red tape matters more than adding new protections." },
    { id: "e7", axis: "econ", dir: -1, topic: "taxes",
      text: "High earners and large corporations should pay more in state taxes to fund public services." },
    { id: "e8", axis: "econ", dir: -1, topic: "public schools",
      text: "The state should spend more on public schools and teacher pay, even if that means higher taxes." },
    { id: "e9", axis: "econ", dir: -1, topic: "housing",
      text: "Government should do more to make housing affordable, like rent help, building homes, or tenant protections." },
    { id: "e10", axis: "econ", dir: -1, topic: "energy",
      text: "The state should speed up the move to clean energy, even if it costs some coal, oil, and gas jobs." },
    { id: "e11", axis: "econ", dir: -1, topic: "data centers",
      text: "Giant data centers should face strict limits on where and how they're built, even if it means less investment." },

    // ---------- social ----------
    { id: "s1", axis: "social", dir: 1, topic: "abortion",
      text: "Abortion should be legal in all or most cases." },
    { id: "s2", axis: "social", dir: 1, topic: "guns",
      text: "The state should pass stricter gun laws, like universal background checks or red-flag laws." },
    { id: "s3", axis: "social", dir: 1, topic: "marijuana",
      text: "Recreational marijuana should be legal for adults." },
    { id: "s4", axis: "social", dir: 1, topic: "LGBTQ+ rights",
      text: "State law should protect transgender people from discrimination in jobs, housing, and schools." },
    { id: "s5", axis: "social", dir: 1, topic: "history in schools",
      text: "Public schools should be able to teach about racism in American history without state limits on how it's taught." },
    { id: "s6", axis: "social", dir: 1, topic: "criminal justice",
      text: "Reducing prison populations and reforming policing matters more than longer sentences." },
    { id: "s7", axis: "social", dir: -1, topic: "immigration",
      text: "State and local police should actively help federal agents enforce immigration law." },
    { id: "s8", axis: "social", dir: 1, topic: "voting access",
      text: "Voting should be made easier, with more early voting, mail voting, and automatic registration." },
    { id: "s9", axis: "social", dir: -1, topic: "religion in schools",
      text: "The Ten Commandments or other religious displays should be allowed in public school classrooms." },
    { id: "s10", axis: "social", dir: 1, topic: "death penalty",
      text: "The death penalty should be abolished." },
    { id: "s11", axis: "social", dir: -1, topic: "school libraries",
      text: "Parents, not librarians or teachers, should have the final say on which books stay in school libraries." }
  ];

  var ANSWERS = [
    { value: 2, label: "Strongly agree", short: "big yes" },
    { value: 1, label: "Agree", short: "yes" },
    { value: 0, label: "Neutral / not sure", short: "meh" },
    { value: -1, label: "Disagree", short: "no" },
    { value: -2, label: "Strongly disagree", short: "big no" }
  ];

  var api = { QUESTIONS: QUESTIONS, ANSWERS: ANSWERS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.VG = root.VG || {};
  root.VG.QUESTIONS = QUESTIONS;
  root.VG.ANSWERS = ANSWERS;
})(typeof window !== "undefined" ? window : globalThis);
