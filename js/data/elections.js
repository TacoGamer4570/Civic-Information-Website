/*
 * 2027 statewide elections data.
 *
 * HOW CANDIDATE POSITIONS WORK
 *   econ:   -10 (most left)      ... +10 (most right)
 *   social: +10 (most liberal)   ... -10 (most conservative)
 *   stances: optional { questionId: -2..+2 } = how we expect the candidate would answer a quiz question.
 *   confidence: "high" | "medium" | "low" — how much public record the estimate is based on.
 *
 * Placements are editorial estimates built from voting records, official actions,
 * campaign statements, and news coverage. They are NOT endorsements. Update them as
 * candidates publish platforms.
 *
 * STATUS
 *   declared  – formally announced / running
 *   expected  – said publicly they plan to run, no formal launch yet
 *   exploring – publicly considering
 *   undecided – incumbent who hasn't said
 *
 * Data current as of UPDATED below. Fields will change a lot before filing deadlines.
 */
(function (root) {
  var UPDATED = "2026-11-05";

  var STATES = {
    // ===================================================================
    KY: {
      name: "Kentucky",
      tier: "full",
      headline: "Open governor's race + 5 more statewide offices",
      official: { label: "Kentucky State Board of Elections", url: "https://elect.ky.gov" },
      dates: [
        { date: "2027-05-18", label: "Closed party primary" },
        { date: "2027-11-02", label: "General election" }
      ],
      systemNote: "Kentucky has closed primaries: you can only vote in the primary of the party you're registered with. Governor and lieutenant governor run together as a ticket; running mates are usually picked closer to the filing deadline.",
      races: [
        {
          id: "ky-gov", type: "candidate", office: "Governor & Lt. Governor",
          blurb: "Runs the state executive branch, signs or vetoes bills, writes the budget proposal.",
          incumbent: "Andy Beshear (D) — term-limited",
          open: true,
          candidates: [
            {
              name: "Jacqueline Coleman", party: "D", role: "Lieutenant Governor; former teacher and assistant principal",
              status: "declared", econ: -5, social: 5, confidence: "medium",
              summary: "Running on public education, health care access, and continuing the Beshear administration's agenda. Opposed the 2024 school-voucher amendment.",
              stances: { e5: -2, e8: 2, e3: 2, s1: 1 },
              sources: [
                { label: "Kentucky Lantern", url: "https://kentuckylantern.com/2026/04/20/democrat-jacqueline-coleman-announces-2027-run-for-kentucky-governor/" }
              ]
            },
            {
              name: "Rocky Adkins", party: "D", role: "Former House Majority Leader; former senior adviser to Gov. Beshear",
              status: "declared", econ: -3, social: -2, confidence: "medium",
              summary: "Pitches himself as a bipartisan, working-class Eastern Kentucky Democrat. Long legislative record backing labor, teachers and coal country, with more conservative votes on guns and abortion than most Democrats.",
              stances: { e4: 2, e5: -2, e10: -2, s1: -1, s2: -2 },
              sources: [
                { label: "WEKU", url: "https://www.weku.org/the-commonwealth/2026-07-21/adkins-makes-pitch-to-ky-voters-as-bipartisan-working-class-choice-in-gubernatorial-campaign-launch" },
                { label: "Louisville Public Media", url: "https://www.lpm.org/news/2026-10-13/rocky-adkins-builds-dominant-fundraising-lead-in-2027-kentucky-governors-race" }
              ]
            },
            {
              name: "James Comer", party: "R", role: "U.S. Representative (KY-1), chair of House Oversight; former state Agriculture Commissioner",
              status: "expected", econ: 7, social: -6, confidence: "high",
              summary: "Said he plans to run, with a formal launch expected around December 2026. Conservative record in Congress on taxes, immigration and abortion. Sec. of State Michael Adams declined to run and endorsed him.",
              stances: { s1: -2, s2: -2, s7: 2, e2: 1, e3: -1, e5: 1 },
              sources: [
                { label: "The Hill", url: "https://thehill.com/homenews/house/5880673-comer-plans-run-kentucky-governor/" },
                { label: "Adams endorsement", url: "https://www.yahoo.com/news/politics/articles/michael-adams-wont-run-governor-210329406.html" }
              ]
            }
          ]
        },
        {
          id: "ky-ag", type: "candidate", office: "Attorney General",
          blurb: "The state's top lawyer: defends state laws in court, handles consumer protection and some criminal cases.",
          incumbent: "Russell Coleman (R) — running again",
          candidates: [
            {
              name: "Russell Coleman", party: "R", role: "Attorney General (since 2024); former U.S. Attorney",
              status: "declared", econ: 5, social: -6, confidence: "high",
              summary: "Tough-on-crime focus, backed the 2024 Safer Kentucky Act, has defended the state's abortion ban, and joined multistate suits against federal regulations.",
              stances: { s6: -2, s1: -2, s7: 2, e6: 1 },
              sources: [{ label: "Ballotpedia: KY AG 2027", url: "https://ballotpedia.org/Kentucky_Attorney_General_election,_2027" }]
            }
          ]
        },
        {
          id: "ky-sos", type: "candidate", office: "Secretary of State",
          blurb: "Runs elections and business filings.",
          incumbent: "Michael Adams (R) — term-limited",
          open: true,
          candidates: [
            {
              name: "Mike Harmon", party: "R", role: "Former State Auditor (2016–2024)",
              status: "declared", econ: 6, social: -5, confidence: "medium",
              summary: "Conservative former auditor who ran for governor in 2023. Campaign largely self-funded so far.",
              stances: {},
              sources: [{ label: "Louisville Public Media", url: "https://www.lpm.org/news/2026-10-13/rocky-adkins-builds-dominant-fundraising-lead-in-2027-kentucky-governors-race" }]
            },
            {
              name: "Nick Wilson", party: "R", role: "State Representative",
              status: "declared", econ: 6, social: -6, confidence: "low",
              summary: "Conservative state House member. Listed as a candidate in early race guides; we haven't found a detailed platform yet.",
              stances: {},
              sources: [{ label: "Politics1 KY", url: "https://politics1.com/ky.htm" }]
            }
          ]
        },
        {
          id: "ky-aud", type: "candidate", office: "Auditor of Public Accounts",
          blurb: "Audits how state and local governments spend money.",
          incumbent: "Allison Ball (R)",
          candidates: [
            {
              name: "Allison Ball", party: "R", role: "State Auditor; former State Treasurer",
              status: "expected", econ: 6, social: -5, confidence: "medium",
              summary: "Expected to seek re-election. Mainstream conservative; has used the office to audit state agencies run by the Democratic governor.",
              stances: {},
              sources: [{ label: "Ballotpedia: KY 2027 executive races", url: "https://ballotpedia.org/Kentucky_state_executive_official_elections,_2027" }]
            }
          ]
        },
        {
          id: "ky-tre", type: "candidate", office: "Treasurer",
          blurb: "Manages state money, unclaimed property, and investments.",
          incumbent: "Mark Metcalf (R)",
          candidates: [
            {
              name: "Mark Metcalf", party: "R", role: "State Treasurer (since 2024); former county attorney",
              status: "expected", econ: 7, social: -7, confidence: "low",
              summary: "Expected to seek re-election. Positions himself on the party's right flank.",
              stances: {},
              sources: [{ label: "Ballotpedia: KY Treasurer", url: "https://ballotpedia.org/Kentucky_State_Treasurer" }]
            }
          ]
        },
        {
          id: "ky-ag-com", type: "candidate", office: "Commissioner of Agriculture",
          blurb: "Oversees farming programs, food safety, and weights & measures.",
          incumbent: "Jonathan Shell (R)",
          candidates: [
            {
              name: "Jonathan Shell", party: "R", role: "Agriculture Commissioner; farmer; former state House Majority Leader",
              status: "expected", econ: 5, social: -5, confidence: "low",
              summary: "Expected to seek re-election. Conservative former legislator focused on farm economy issues.",
              stances: {},
              sources: [{ label: "Ballotpedia: KY Ag 2027", url: "https://ballotpedia.org/Kentucky_Agriculture_Commissioner_election,_2027" }]
            }
          ]
        }
      ],
      watch: [
        "No Democrat has announced for Attorney General, Secretary of State, Auditor, Treasurer, or Agriculture Commissioner yet.",
        "Kentucky has no citizen-initiative process; ballot measures come only from the legislature, which usually refers them in even years."
      ]
    },

    // ===================================================================
    LA: {
      name: "Louisiana",
      tier: "full",
      headline: "Governor + 6 statewide offices",
      official: { label: "Louisiana Secretary of State", url: "https://www.sos.la.gov/ElectionsAndVoting" },
      dates: [
        { date: "2027-10-09", label: "Primary (all candidates, one ballot)" },
        { date: "2027-11-20", label: "Runoff, if no one gets 50%+" }
      ],
      systemNote: "Statewide executive races still use Louisiana's open \"jungle\" primary: every candidate from every party runs on the same ballot, and if nobody tops 50%, the top two go to a runoff. Some sources list Oct. 16 for the primary, so check the official calendar.",
      races: [
        {
          id: "la-gov", type: "candidate", office: "Governor",
          blurb: "Runs the state executive branch, signs or vetoes bills, proposes the budget.",
          incumbent: "Jeff Landry (R) — eligible for a 2nd term",
          candidates: [
            {
              name: "Jeff Landry", party: "R", role: "Governor (since 2024); former Attorney General",
              status: "undecided", econ: 7, social: -8, confidence: "high",
              summary: "Hasn't formally announced but has a large campaign war chest. As governor he signed the Ten Commandments classroom law, permitless carry, the LA GATOR school-choice program, and resumed executions.",
              stances: { s1: -2, s2: -2, s4: -2, s6: -2, s7: 2, s9: 2, s10: -2, e5: 2, e10: -2 },
              sources: [
                { label: "State Affairs", url: "https://pro.stateaffairs.com/la/elections/louisiana-statewide-election-outlook" },
                { label: "Ballotpedia: LA Gov 2027", url: "https://ballotpedia.org/Louisiana_gubernatorial_election,_2027" }
              ]
            },
            {
              name: "Jamie Davis", party: "D", role: "Farmer; 2026 Democratic nominee for U.S. Senate",
              status: "exploring", econ: -3, social: 2, confidence: "low",
              summary: "After a narrow U.S. Senate loss, said he's weighing a 2027 run for governor or backing another challenger. His Senate platform centered on affordability, health care, education, and voting rights.",
              stances: { e3: 1, e8: 1, s8: 1 },
              sources: [
                { label: "WAFB", url: "https://www.wafb.com/2026/11/04/davis-hints-2027-governor-bid-puts-landry-notice-after-narrow-senate-loss/" },
                { label: "Louisiana Illuminator", url: "https://lailluminator.com/2026/04/30/davis-senate/" }
              ]
            }
          ]
        },
        {
          id: "la-lg", type: "candidate", office: "Lieutenant Governor",
          blurb: "Leads tourism and culture; first in line if the governor leaves office. Elected separately from the governor.",
          incumbent: "Billy Nungesser (R)",
          candidates: [
            {
              name: "Billy Nungesser", party: "R", role: "Lieutenant Governor (since 2016)",
              status: "expected", econ: 4, social: -4, confidence: "medium",
              summary: "Said his plan is to run for re-election rather than governor. Establishment Republican focused on tourism and coastal issues; not a close Landry ally.",
              stances: {},
              sources: [{ label: "State Affairs", url: "https://pro.stateaffairs.com/la/elections/louisiana-statewide-election-outlook" }]
            }
          ]
        },
        {
          id: "la-ag", type: "candidate", office: "Attorney General",
          blurb: "The state's top lawyer.",
          incumbent: "Liz Murrill (R)",
          candidates: [
            {
              name: "Liz Murrill", party: "R", role: "Attorney General (since 2024)",
              status: "expected", econ: 6, social: -8, confidence: "high",
              summary: "Plans to seek a second term. Has aggressively enforced the state's abortion ban, including against out-of-state pill prescribers, and defended the Ten Commandments law.",
              stances: { s1: -2, s9: 2, s6: -1 },
              sources: [{ label: "State Affairs", url: "https://pro.stateaffairs.com/la/elections/louisiana-statewide-election-outlook" }]
            }
          ]
        },
        {
          id: "la-sos", type: "candidate", office: "Secretary of State",
          blurb: "Runs elections, business filings, and state archives.",
          incumbent: "Nancy Landry (R)",
          candidates: [
            {
              name: "Nancy Landry", party: "R", role: "Secretary of State (since 2024); former state representative",
              status: "expected", econ: 5, social: -5, confidence: "medium",
              summary: "Plans to run for at least one more term, with a formal announcement expected by the end of 2026.",
              stances: {},
              sources: [{ label: "State Affairs", url: "https://pro.stateaffairs.com/la/elections/louisiana-statewide-election-outlook" }]
            }
          ]
        },
        {
          id: "la-tre", type: "candidate", office: "Treasurer",
          blurb: "Manages state money and investments.",
          incumbent: "John Fleming (R)",
          candidates: [
            {
              name: "John Fleming", party: "R", role: "Treasurer (since 2024); former congressman and House Freedom Caucus founder",
              status: "undecided", econ: 8, social: -8, confidence: "high",
              summary: "The only statewide official who hasn't said whether he'll seek re-election. Hard-right fiscal and social record.",
              stances: { s1: -2, e2: 2 },
              sources: [{ label: "State Affairs", url: "https://pro.stateaffairs.com/la/elections/louisiana-statewide-election-outlook" }]
            }
          ]
        },
        {
          id: "la-agc", type: "candidate", office: "Commissioner of Agriculture & Forestry",
          blurb: "Oversees farming, forestry, and food-safety programs.",
          incumbent: "Mike Strain (R)",
          candidates: [
            {
              name: "Mike Strain", party: "R", role: "Agriculture Commissioner (since 2008); veterinarian",
              status: "declared", econ: 5, social: -5, confidence: "medium",
              summary: "Announced a bid for another term. Conservative, farm-industry focused; also oversees the state's medical marijuana program.",
              stances: {},
              sources: [{ label: "State Affairs", url: "https://pro.stateaffairs.com/la/elections/louisiana-statewide-election-outlook" }]
            }
          ]
        },
        {
          id: "la-ins", type: "candidate", office: "Commissioner of Insurance",
          blurb: "Regulates insurance companies and rates (a big deal for Louisiana home insurance costs).",
          incumbent: "Tim Temple (R)",
          candidates: [
            {
              name: "Tim Temple", party: "R", role: "Insurance Commissioner (since 2024); insurance executive",
              status: "declared", econ: 6, social: -4, confidence: "medium",
              summary: "Said he will run for re-election. Has pushed a market-based approach to lowering home insurance rates by attracting insurers back to the state.",
              stances: { e6: 1 },
              sources: [{ label: "State Affairs", url: "https://pro.stateaffairs.com/la/elections/louisiana-statewide-election-outlook" }]
            }
          ]
        }
      ],
      watch: [
        "Former Gov. John Bel Edwards is out of the picture after voters approved a gubernatorial term-limit amendment on Nov. 3, 2026.",
        "Other Democrats mentioned for governor: state Sen. Jay Luneau and former New Orleans Mayor Mitch Landrieu. Neither has announced.",
        "The legislature may send constitutional amendments to the Oct. 2027 ballot during its 2027 session. None are set yet."
      ]
    },

    // ===================================================================
    MS: {
      name: "Mississippi",
      tier: "full",
      headline: "Open governor's race + 7 more statewide offices",
      official: { label: "Mississippi Secretary of State", url: "https://www.sos.ms.gov/elections-voting" },
      dates: [
        { date: "2027-08-03", label: "Party primaries" },
        { date: "2027-08-24", label: "Primary runoffs" },
        { date: "2027-11-02", label: "General election" }
      ],
      systemNote: "Mississippi has open primaries: you don't register by party, but you pick one party's primary ballot on primary day (and can't switch parties for that runoff).",
      races: [
        {
          id: "ms-gov", type: "candidate", office: "Governor",
          blurb: "Runs the state executive branch, signs or vetoes bills, proposes the budget.",
          incumbent: "Tate Reeves (R) — term-limited",
          open: true,
          candidates: [
            {
              name: "Lynn Fitch", party: "R", role: "Attorney General (since 2020)",
              status: "declared", econ: 7, social: -9, confidence: "high",
              summary: "Led the Dobbs case that overturned Roe v. Wade. Campaigning on speeding up the elimination of the state income tax and on conservative social policy.",
              stances: { s1: -2, s4: -2, e2: 2 },
              sources: [{ label: "Mississippi Today", url: "https://mississippitoday.org/2026/08/05/lynn-fitch-governor-campaign/" }]
            },
            {
              name: "Andy Gipson", party: "R", role: "Agriculture Commissioner; Baptist minister; former state representative",
              status: "declared", econ: 7, social: -9, confidence: "medium",
              summary: "Calls his platform \"conservative common sense\": no tax increases (signing the taxpayer protection pledge), restoring Mississippi's ballot initiative process, and a statewide anti-crime task force.",
              stances: { s1: -2, e2: 1, s6: -1 },
              sources: [{ label: "WLBT", url: "https://www.wlbt.com/2026/04/09/mississippi-2027-election-candidates-begin-announcing-campaigns/" }]
            },
            {
              name: "Philip Gunn", party: "R", role: "Former Speaker of the House (2012–2024)",
              status: "declared", econ: 7, social: -7, confidence: "high",
              summary: "Led the 2022 income-tax phase-out and pushed school choice as Speaker; also led the 2020 effort to change the state flag. Running on tax reform, job growth and lower grocery and property taxes.",
              stances: { e2: 2, e5: 2, s1: -2 },
              sources: [{ label: "Mississippi Today", url: "https://mississippitoday.org/2026/04/14/ex-house-speaker-philip-gunn-governor-campaign/" }]
            },
            {
              name: "Shad White", party: "R", role: "State Auditor (since 2018)",
              status: "exploring", econ: 8, social: -7, confidence: "medium",
              summary: "Says he won't seek another term as auditor and is \"seriously thinking\" about governor. His pitch: cut waste in state government and return the money to taxpayers. A vocal opponent of Medicaid expansion.",
              stances: { e2: 2, e3: -2 },
              sources: [{ label: "WJTV", url: "https://www.wjtv.com/news/politics/mississippi-politics/shad-white-considering-2027-gubernatorial-bid/" }]
            },
            {
              name: "Priscilla Till", party: "D", role: "Civil rights advocate; 2026 U.S. Senate candidate",
              status: "declared", econ: -6, social: 6, confidence: "low",
              summary: "The first Democrat in the race, announced at Jackson State University. A cousin of Emmett Till, she's running on change and civil rights.",
              stances: { e3: 2, s5: 2 },
              sources: [{ label: "Mississippi Free Press", url: "https://www.mississippifreepress.org/priscilla-till-emmett-tills-cousin-announces-campaign-for-mississippi-governor-and-promises-change/" }]
            },
            {
              name: "Ivana Williams", party: "D", role: "Former Mississippi Highway Patrol trooper",
              status: "declared", econ: -4, social: 3, confidence: "low",
              summary: "Announced Nov. 4, 2026. Platform centers on higher teacher pay, better school preparation, and closer coordination between the governor's office and schools.",
              stances: { e8: 2 },
              sources: [{ label: "WTOK", url: "https://www.wtok.com/2026/11/04/former-mhp-trooper-ivana-williams-democratic-bid-governor-mississippi/" }]
            }
          ]
        },
        {
          id: "ms-lg", type: "candidate", office: "Lieutenant Governor",
          blurb: "Presides over the state Senate and controls its committees, which makes it one of the most powerful jobs in Mississippi.",
          incumbent: "Delbert Hosemann (R) — term-limited",
          open: true,
          candidates: [
            {
              name: "Michael Watson", party: "R", role: "Secretary of State (since 2020); former state senator",
              status: "declared", econ: 6, social: -7, confidence: "medium",
              summary: "Announced in April 2026. As Secretary of State, prioritized election-integrity measures; conservative record in the state Senate.",
              stances: { s8: -1 },
              sources: [{ label: "WLBT", url: "https://www.wlbt.com/2026/04/09/mississippi-2027-election-candidates-begin-announcing-campaigns/" }]
            }
          ]
        },
        {
          id: "ms-sos", type: "candidate", office: "Secretary of State",
          blurb: "Runs elections, business filings, and public lands.",
          incumbent: "Michael Watson (R) — running for Lt. Gov.",
          open: true,
          candidates: [
            {
              name: "Jeff Tate", party: "R", role: "State Senator (Meridian)",
              status: "declared", econ: 5, social: -5, confidence: "low",
              summary: "Conservative state senator. We haven't found a detailed platform yet.",
              stances: {},
              sources: [{ label: "Magnolia Tribune via Star Herald", url: "https://www.starherald.net/young-joins-carter-tate-republican-field-seeking-replace-secretary-state-watson-2027-6866de74c1b73" }]
            },
            {
              name: "Shuwaski Young", party: "R", role: "Former federal homeland-security official; 2023 Democratic SoS nominee who switched parties",
              status: "declared", econ: 4, social: -3, confidence: "low",
              summary: "Left the Democratic Party in late 2024 and is running as a Republican. Top priorities: election integrity, crime, modernizing the office, and being business-friendly.",
              stances: { s8: -1 },
              sources: [{ label: "SuperTalk Mississippi", url: "https://www.supertalk.fm/shuwaski-young-announces-2027-bid-for-mississippi-secretary-of-state/" }]
            }
          ]
        },
        {
          id: "ms-ag", type: "candidate", office: "Attorney General",
          blurb: "The state's top lawyer.",
          incumbent: "Lynn Fitch (R) — running for governor",
          open: true,
          candidates: [
            {
              name: "Sean Tindell", party: "R", role: "Commissioner of Public Safety; former state senator",
              status: "declared", econ: 5, social: -6, confidence: "medium",
              summary: "Running in the Republican primary. Led the state's public-safety department, including the expanded Capitol Police in Jackson.",
              stances: { s6: -1, s7: 1 },
              sources: [{ label: "Mississippi Today", url: "https://mississippitoday.org/2026/08/19/sean-tindell-running-attorney-general/" }]
            }
          ]
        },
        {
          id: "ms-aud", type: "candidate", office: "State Auditor",
          blurb: "Audits how state and local governments spend money.",
          incumbent: "Shad White (R) — not seeking re-election",
          open: true,
          candidates: [
            {
              name: "Nick Bain", party: "R", role: "Former state representative (Corinth); attorney",
              status: "declared", econ: 5, social: -4, confidence: "low",
              summary: "First candidate to announce for auditor.",
              stances: {},
              sources: [{ label: "WDAM", url: "https://www.wdam.com/2026/05/06/nick-bain-running-mississippi-auditor/" }]
            }
          ]
        },
        {
          id: "ms-tre", type: "candidate", office: "Treasurer",
          blurb: "Manages state money, investments, and the college savings program.",
          incumbent: "David McRae (R)",
          candidates: [
            {
              name: "David McRae", party: "R", role: "State Treasurer (since 2020)",
              status: "undecided", econ: 6, social: -5, confidence: "low",
              summary: "Incumbent with an active campaign account; hasn't confirmed a 2027 bid.",
              stances: {},
              sources: [{ label: "Mississippi Today", url: "https://mississippitoday.org/2026/02/02/campaign-finance-mississippi-governor-2027-fundraising/" }]
            }
          ]
        },
        {
          id: "ms-ins", type: "candidate", office: "Commissioner of Insurance",
          blurb: "Regulates insurance and serves as state fire marshal.",
          incumbent: "Mike Chaney (R)",
          candidates: [
            {
              name: "Mike Chaney", party: "R", role: "Insurance Commissioner (since 2008)",
              status: "undecided", econ: 4, social: -4, confidence: "low",
              summary: "Longtime incumbent; hasn't confirmed a 2027 bid.",
              stances: {},
              sources: [{ label: "Ballotpedia: MS Insurance 2027", url: "https://ballotpedia.org/Mississippi_Insurance_Commissioner_election,_2027" }]
            }
          ]
        },
        {
          id: "ms-agc", type: "candidate", office: "Commissioner of Agriculture & Commerce",
          blurb: "Oversees farming, food safety, and the state fair.",
          incumbent: "Andy Gipson (R) — running for governor",
          open: true,
          candidates: [],
          emptyNote: "Nobody has formally announced. Names floated include USDA Rural Development state director Dane Maxwell, state Rep. Vince Mangold, and the state Senate Agriculture Committee chair.",
          sources: [{ label: "Mississippi Monitor", url: "https://www.themississippimonitor.com/whos-running-for-agriculture-commissioner-in-2027/" }]
        }
      ],
      watch: [
        "Former Public Service Commissioner Brandon Presley, the 2023 Democratic nominee, is mentioned for governor but hasn't announced.",
        "State Democratic leaders said they'd hold off announcing down-ballot candidates until after the 2026 midterms.",
        "Mississippi has no working citizen-initiative process right now (a 2021 court ruling knocked it out), so no statewide ballot measures are expected."
      ]
    },

    // ===================================================================
    WI: {
      name: "Wisconsin",
      tier: "judicial",
      headline: "Open state Supreme Court seat (April)",
      official: { label: "Wisconsin Elections Commission", url: "https://elections.wi.gov" },
      dates: [
        { date: "2027-02-16", label: "Spring primary (only if 3+ candidates)" },
        { date: "2027-04-06", label: "Spring election" }
      ],
      systemNote: "Supreme Court races are officially nonpartisan, so there are no party labels on the ballot. Candidates are widely described as liberal- or conservative-leaning, and that's what our placements reflect.",
      races: [
        {
          id: "wi-sc", type: "candidate", office: "Justice of the Supreme Court",
          blurb: "One of seven justices on the state's highest court. 10-year term. Rulings shape abortion, voting maps, union law, and more.",
          incumbent: "Annette Ziegler (conservative) — retiring",
          open: true,
          nonpartisan: true,
          candidates: [
            {
              name: "Lyndsey Brunette", party: "NP", lean: "liberal-leaning", role: "Clark County Circuit Judge; former Democratic Clark County DA",
              status: "declared", econ: -3, social: 4, confidence: "low",
              summary: "Announced in April 2026. Emphasizes treatment courts, mental health, elder care and child protection cases.",
              stances: { s6: 1 },
              sources: [{ label: "WPR", url: "https://www.wpr.org/news/wisconsin-supreme-court-2027-liberal-candidate-lyndsey-brunette" }]
            },
            {
              name: "Pedro Colón", party: "NP", lean: "liberal-leaning", role: "Court of Appeals Judge; former Democratic state representative",
              status: "declared", econ: -4, social: 6, confidence: "low",
              summary: "Served 13 years as a Milwaukee County judge and 11 years in the Assembly as a Democrat before joining the appeals court.",
              stances: {},
              sources: [{ label: "WPR", url: "https://www.wpr.org/news/liberal-judge-pedro-colon-enters-2027-wisconsin-supreme-court-race" }]
            }
          ]
        }
      ],
      watch: [
        "No conservative-leaning candidate has entered yet. If one does, this race will look very different.",
        "Liberal-leaning justices currently hold a 4–3 majority; this is a conservative seat."
      ]
    },

    // ===================================================================
    PA: {
      name: "Pennsylvania",
      tier: "judicial",
      headline: "Supreme Court: 1 open seat + 2 retention votes",
      official: { label: "Pennsylvania Department of State", url: "https://www.vote.pa.gov" },
      dates: [
        { date: "2027-05-18", label: "Closed party primary" },
        { date: "2027-11-02", label: "General election" }
      ],
      systemNote: "Pennsylvania appellate judges first win a partisan election, then face yes/no \"retention\" votes every 10 years. Retention votes are traditionally about a judge's fitness, not ideology. We show which way your views lean, but weigh that as you see fit.",
      races: [
        {
          id: "pa-sc-open", type: "candidate", office: "Justice of the Supreme Court (open seat)",
          blurb: "Fills the seat Justice Christine Donohue (D) must leave at the mandatory retirement age.",
          incumbent: "Christine Donohue (D) — mandatory retirement",
          open: true,
          candidates: [],
          emptyNote: "No candidates have announced yet. Parties usually settle on nominees in early 2027 before the May primary."
        },
        {
          id: "pa-ret-todd", type: "retention", office: "Retain Chief Justice Debra Todd?",
          blurb: "Chief Justice since 2022, first elected in 2007 as a Democrat.",
          justice: "Debra Todd", party: "D",
          yes: { econ: -3, social: 4, summary: "Keeps a Democratic-elected justice on a court with a 5–2 Democratic majority." },
          no: { econ: 3, social: -3, summary: "Opens a seat; the governor names a temporary replacement (needs 2/3 Senate approval) until a later election." },
          confidence: "low",
          sources: [{ label: "Spotlight PA", url: "https://www.spotlightpa.org/news/2025/11/pennsylvania-supreme-court-retention-election-explainer-elections/" }]
        },
        {
          id: "pa-ret-mundy", type: "retention", office: "Retain Justice Sallie Mundy?",
          blurb: "Justice since 2016, elected in 2017 as a Republican.",
          justice: "Sallie Mundy", party: "R",
          yes: { econ: 3, social: -3, summary: "Keeps one of the court's two Republican-elected justices." },
          no: { econ: -3, social: 3, summary: "Opens a seat; the governor names a temporary replacement (needs 2/3 Senate approval) until a later election." },
          confidence: "low",
          sources: [{ label: "Spotlight PA", url: "https://www.spotlightpa.org/news/2025/11/pennsylvania-supreme-court-retention-election-explainer-elections/" }]
        }
      ],
      watch: [
        "Superior Court and Commonwealth Court seats may also be on the 2027 ballot; vacancies aren't final yet.",
        "Even if Republicans won the open seat, the court would be at most a 4–3 Democratic majority after 2027 unless a retention vote fails."
      ]
    },

    // ===================================================================
    OH: {
      name: "Ohio",
      tier: "measures",
      headline: "Proposed data-center amendment (not certified)",
      official: { label: "Ohio Secretary of State", url: "https://www.ohiosos.gov" },
      dates: [{ date: "2027-11-02", label: "General election" }],
      systemNote: "Ohio citizens can put constitutional amendments on the ballot with signatures equal to 10% of the last governor's-race vote, from at least 44 counties.",
      races: [
        {
          id: "oh-datacenter", type: "measure", office: "Proposed: ban on large data centers",
          status: "proposed",
          blurb: "Would amend the Ohio Constitution to ban building new data centers with a peak load above 25 megawatts. Organizers missed the 2026 deadline and are aiming for Nov. 2027.",
          yes: { econ: -4, social: 1, summary: "Blocks large new data centers in Ohio, citing power prices, water use, and local control." },
          no: { econ: 4, social: 0, summary: "Leaves data-center siting to existing state and local rules; supporters of growth cite jobs and tax revenue." },
          linked: [{ q: "e11", yesIs: 1 }],
          confidence: "medium",
          sources: [
            { label: "Ohio Capital Journal", url: "https://ohiocapitaljournal.com/2026/04/30/ohio-data-center-ban-proposal-advocates-are-trying-to-get-413000-signatures-by-july-1/" },
            { label: "Conserve Ohio (organizers)", url: "https://conserveohio.com/the-numbers/" }
          ]
        }
      ],
      watch: [
        "This only reaches the ballot if organizers turn in ~413,000 valid signatures by the summer 2027 deadline. They reported about 130,000 as of Sept. 2026."
      ]
    },

    // ===================================================================
    TX: { name: "Texas", tier: "watch", headline: "Constitutional amendments likely (TBD)",
      official: { label: "Texas Secretary of State", url: "https://www.sos.state.tx.us/elections/" },
      dates: [{ date: "2027-11-02", label: "Constitutional amendment election (expected)" }],
      races: [],
      watch: ["Texas votes on constitutional amendments after each regular legislative session. The 2027 session starts in January, so Nov. 2027 amendments are likely but none exist yet."] },
    WA: { name: "Washington", tier: "watch", headline: "Statewide initiatives possible (TBD)",
      official: { label: "Washington Secretary of State", url: "https://www.sos.wa.gov/elections" },
      dates: [{ date: "2027-11-02", label: "General election" }],
      races: [],
      watch: ["Initiatives to the Legislature filed by early January 2027 go on the November ballot if lawmakers don't pass them. Nothing is certified yet."] },
    CO: { name: "Colorado", tier: "watch", headline: "Tax measures possible (TBD)",
      official: { label: "Colorado Secretary of State", url: "https://www.coloradosos.gov/pubs/elections/" },
      dates: [{ date: "2027-11-02", label: "Coordinated election" }],
      races: [],
      watch: ["Odd-year statewide ballots in Colorado are limited to tax and fiscal (TABOR) questions. None are set yet."] },
    ME: { name: "Maine", tier: "watch", headline: "Referendum questions possible (TBD)",
      official: { label: "Maine Secretary of State", url: "https://www.maine.gov/sos/cec/elec/" },
      dates: [{ date: "2027-11-02", label: "Referendum election" }],
      races: [],
      watch: ["Maine often votes on citizen initiatives and bond questions in odd years. None are certified for 2027 yet."] },
    NJ: { name: "New Jersey", tier: "watch", headline: "Legislature on ballot; statewide questions possible",
      official: { label: "New Jersey Division of Elections", url: "https://www.nj.gov/state/elections/" },
      dates: [{ date: "2027-11-02", label: "General election" }],
      races: [],
      watch: ["All 120 legislative seats are up in 2027, but those are district races, not statewide. The legislature can add statewide public questions; none are set."] },
    VA: { name: "Virginia", tier: "watch", headline: "Legislature on ballot (district races)",
      official: { label: "Virginia Department of Elections", url: "https://www.elections.virginia.gov" },
      dates: [{ date: "2027-11-02", label: "General election" }],
      races: [],
      watch: ["The House of Delegates and state Senate are up in 2027. Those are district races, so they're outside this statewide guide for now."] }
  };

  // Every other state + DC: nothing statewide scheduled in 2027 as of UPDATED.
  var ALL = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
    LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
    NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
    OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
    WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
  };
  Object.keys(ALL).forEach(function (code) {
    if (!STATES[code]) {
      STATES[code] = {
        name: ALL[code], tier: "none", headline: "No statewide races scheduled",
        official: { label: "Find your election office", url: "https://vote.gov" },
        dates: [], races: [],
        watch: ["No statewide offices or ballot measures are scheduled here for 2027 as of our last update. Local races (mayor, city council, school board) may still be on your ballot."]
      };
    }
  });

  var api = { UPDATED: UPDATED, STATES: STATES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.VG = root.VG || {};
  root.VG.UPDATED = UPDATED;
  root.VG.STATES = STATES;
})(typeof window !== "undefined" ? window : globalThis);
