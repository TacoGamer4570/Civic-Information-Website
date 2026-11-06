# ballot/decoded — 2027 voter guide

A nonpartisan voter guide for the **2027 U.S. statewide elections**.

1. Pick your state.
2. Answer 22 policy questions. You get two scores:
   - **Economy:** −10 (left) to +10 (right)
   - **Social issues:** +10 (liberal) to −10 (conservative)
3. Get matched against every statewide race on your 2027 ballot (governor, down-ballot offices like agriculture or insurance commissioner, state supreme court seats, judicial retention votes, and ballot measures), then see a suggested ballot you can print or share.

Everything runs in the browser. There's no backend, no build step, and no tracking.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000. It also works as-is on GitHub Pages: Settings → Pages → deploy from the main branch, root folder.

## Tests

```bash
node tests/scoring.test.js
node tests/redistrict.test.js
```

Covers the scoring math, matching, share-link encoding, and data integrity (valid ranges, sources on every candidate, known question ids).

## What's covered (as of Nov 5, 2026)

| State | 2027 statewide races |
|---|---|
| Kentucky | Governor/Lt. Gov, Attorney General, Secretary of State, Auditor, Treasurer, Agriculture Commissioner |
| Louisiana | Governor, Lt. Governor, Attorney General, Secretary of State, Treasurer, Agriculture, Insurance |
| Mississippi | Governor, Lt. Governor, Secretary of State, Attorney General, Auditor, Treasurer, Insurance, Agriculture |
| Wisconsin | Supreme Court (April 6) |
| Pennsylvania | Supreme Court open seat + retention votes for Todd and Mundy |
| Ohio | Proposed data-center ban amendment (still gathering signatures) |
| TX, WA, CO, ME, NJ, VA | "Watch" states: measures possible, nothing set yet |
| Everyone else | No statewide races scheduled; you still get your scores |

Most fields aren't final yet. Every candidate is tagged **running**, **expected to run**, **exploring**, or **undecided**.

## Redistricting simulator

`redistricting.html` draws maps for **California, Texas, Florida, New York, Pennsylvania, Illinois, Ohio, Georgia, North Carolina, Michigan, Virginia, Arizona, Wisconsin, Minnesota, and Nevada** with Markov chain Monte Carlo, built from **2020 Census blocks** (from 57k in NV to 669k in TX):

- **Population:** exact 2020 Census block counts (P.L. 94-171).
- **Votes:** 2024 presidential results by precinct ([NYT](https://github.com/nytimes/presidential-precinct-map-2024)), split to the blocks inside each precinct by voting-age population. Block votes are estimates; statewide totals match the precinct data exactly.
- **Map:** block adjacency and shared-border lengths straight from the Census's TIGER/Line topology Districts must connect **over land**: water blocks are left out of the search, and only land cut off by water (islands, Michigan's Upper Peninsula, Virginia's Eastern Shore...) is linked to any other land within 3 km across the water (Manhattan to the Bronx, Brooklyn and Queens, and so on), or to the nearest land if none is that close. Water blocks follow the land next to them and still count toward district shapes, plus "id images" of each state (each pixel = the block under it) for fast drawing, with sharper tiles loaded on zoom.

You choose any number of districts (2 up to one per populated block) and a goal: fair & compact, proportional, an exact seat split, a max-Democratic or max-Republican gerrymander, or as many competitive seats as possible. You also set a safe-seat margin, population tolerance (down to ±0.001%), how hard to avoid county splits, and whether to keep districts compact or ignore compactness entirely (districts are always contiguous either way).

The chain runs in a Web Worker:

1. **Balance population.**
2. **Hit the partisan goal.** For gerrymander goals the safe-seat margin is a floor: first as many districts as possible won by at least that much; then, with that count locked, as many wins under the floor as possible; then, one district at a time from the best down, each is pushed as close to the floor as it will go and locked, never giving up a seat. Safe seats are floored, not frozen: they can shed surplus votes during this step but never drop below the floor.
3. **Make it compact.** The seat result is locked while the chain improves Polsby–Popper scores. Skipped, and compactness left out of every score, when you choose *Ignore compactness*.
4. **Refine with census blocks.** Steps 1–3 move whole precincts (aggregated from blocks) for speed; then the map switches to individual blocks to balance population tightly and smooth borders, seat result still locked. With very many districts (fewer than 8 precincts each), every step runs on blocks.

**Superthinking** runs that whole sequence in cycles, forever, until you press *Stop & keep best*. Each cycle is scored against the best map so far (first your goal, then compactness, or population balance if compactness is ignored; only maps within your tolerance and fully contiguous count). Most cycles start from the best map and push further, with gerrymander goals always aiming one seat higher and later cycles searching harder. Every fourth cycle restarts from a fresh random map. The map shows the best result so far, or the live search if you tick *Watch the live search*.

Moves are ReCom (merge two districts, cut a random spanning tree into equal halves) and single-unit flips that are only allowed when the district stays connected. Every district is checked for contiguity at the block level at the end. The **Download assignments** button saves a standard block-assignment CSV (`GEOID20,District`).

### Rebuilding the data

The files in `data/redistricting/` are generated (about 93 MB). To rebuild them (downloads ~3 GB from `int.nyt.com` and `www2.census.gov`; Texas needs the most memory):

```bash
pip install shapely pyproj numpy scipy geopandas rasterio
python3 tools/redistricting/build_data.py TX CA PA FL NC MI VA OH GA NV WI AZ NY IL MN
```

## Project layout

```
index.html              page shell + methodology dialog
redistricting.html      redistricting simulator page
js/redistrict/engine.js MCMC engine (runs in a Web Worker and in node)
js/redistrict/map.js    canvas precinct/district map
js/redistrict/app.js    simulator UI
data/redistricting/     generated census-block data (<state>.js + <state>/ map tiles)
tools/redistricting/    data build script
css/styles.css          all styles (light/dark, mobile, print-the-ballot)
js/data/questions.js    the 22 quiz questions
js/data/elections.js    states, races, candidates, measures, sources  ← update this
js/scoring.js           scores, matching, yes/no logic, share links
js/app.js               UI
tests/scoring.test.js   node tests (voter guide)
tests/redistrict.test.js node tests (redistricting engine + data)
tests/load-state.js     node helper that decodes a state file
```

## Updating race data

Everything lives in `js/data/elections.js`. Each candidate looks like:

```js
{
  name: "Jane Doe", party: "D" | "R" | "NP",
  role: "State Senator",
  status: "declared" | "expected" | "exploring" | "undecided",
  econ: -4,          // -10 left .. +10 right
  social: 3,         // +10 liberal .. -10 conservative
  confidence: "high" | "medium" | "low",
  summary: "One or two neutral sentences about their record/platform.",
  stances: { s1: 2, e5: -2 },   // optional: how they'd answer quiz questions (-2..+2)
  sources: [{ label: "Outlet", url: "https://..." }]
}
```

Ballot measures and retention votes use `type: "measure"` or `"retention"` with `yes` / `no` positions, plus optional `linked` quiz questions. Bump `UPDATED` at the top of the file whenever you change data, then run the tests.

### Placement guidelines

- Base placements on record (votes, official actions, signed laws), then platform, then party. Set `confidence` to match.
- Only add `stances` you can back with a source.
- Write summaries neutrally: what they did or said, not whether it was good.

## How matching works

- **Your score** on each axis is the weighted average of your answers (starred questions count double, skipped ones don't count), scaled to ±10.
- **Candidate match** = closeness on the 2D map, blended with question-by-question agreement when we know a candidate's specific stances (up to 45% weight).
- **Yes/no races** compare where a yes vote and a no vote land, plus any directly linked question.
- Results within 3 points are flagged as a close call. Matches under 50% are flagged as weak, and a lone candidate under 50% isn't filled in on the ballot.

The placements are editorial estimates, not endorsements. The site says so throughout and shows sources and confidence for every one.
