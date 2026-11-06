#!/usr/bin/env python3
"""Build the precinct graphs used by the redistricting simulator.

For each state this script:
  1. loads 2024 presidential results + precinct shapes (New York Times),
  2. drops every populated 2020 Census block (PL 94-171) into the precinct
     that contains it, so each precinct gets a population count,
  3. builds the precinct adjacency graph from the shared topology arcs, with
     the length of each shared border (used for compactness),
  4. bridges islands to the mainland so the graph is connected,
  5. simplifies the shapes and writes data/redistricting/<st>.js.

Usage:
  pip install shapely pyproj numpy geopandas
  python3 tools/redistricting/build_data.py --cache /tmp/rd-cache [TX CA PA]

Downloads (~250 MB) are cached in --cache.
Needs geopandas too (to read the census state outline).
"""
import argparse
import gzip
import io
import json
import math
import os
import sys
import urllib.request
import zipfile

import numpy as np
import shapely
from pyproj import Transformer

STATES = {
    "TX": {"fips": "48", "name": "Texas", "seats": 38, "pl": "Texas", "tol": 60},
    "CA": {"fips": "06", "name": "California", "seats": 52, "pl": "California", "tol": 45},
    "PA": {"fips": "42", "name": "Pennsylvania", "seats": 17, "pl": "Pennsylvania", "tol": 35},
}
NYT_URL = "https://int.nyt.com/newsgraphics/elections/map-data/2024/national/{st}-precincts-with-results.topojson.gz"
STATE_URL = "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_state_500k.zip"
PL_URL = ("https://www2.census.gov/programs-surveys/decennial/2020/data/"
          "01-Redistricting_File--PL_94-171/{name}/{st}2020.pl.zip")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, "data", "redistricting")

# Conus Albers equal-area (EPSG:5070), in meters.
TO_ALBERS = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)
EPS = 5.0          # meters: borders closer than this count as touching
MIN_SHARED = 20.0  # meters of shared border needed to be neighbors (corners don't count)
GAP_CELL = 1500.0  # meters: grid used to split large holes in the precinct coverage


def polygonal(g):
    """Keep only the polygon parts of a geometry (make_valid can return collections)."""
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in shapely.get_parts(g) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else shapely.Polygon()


def fetch(url, path):
    if not os.path.exists(path):
        print("  downloading", url)
        with urllib.request.urlopen(url) as r, open(path + ".part", "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.rename(path + ".part", path)
    return path


def load_blocks(cache, st, meta):
    """Return (x, y, pop) arrays of populated blocks + {county fips: name}."""
    zpath = fetch(PL_URL.format(name=meta["pl"], st=st.lower()),
                  os.path.join(cache, f"{st.lower()}2020.pl.zip"))
    lon, lat, pop, counties = [], [], [], {}
    with zipfile.ZipFile(zpath) as z:
        with z.open(f"{st.lower()}geo2020.pl") as raw:
            for line in io.TextIOWrapper(raw, encoding="latin-1"):
                f = line.rstrip("\n").split("|")
                if f[2] == "050":
                    counties[f[9]] = f[-10]
                elif f[2] == "750":
                    p = int(f[-7])
                    if p > 0:
                        pop.append(p)
                        lat.append(float(f[-5]))
                        lon.append(float(f[-4]))
    x, y = TO_ALBERS.transform(np.array(lon), np.array(lat))
    return x, y, np.array(pop, dtype=np.int64), counties


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    out = []
    for arc in topo["arcs"]:
        a = np.cumsum(np.array(arc, dtype=np.int64), axis=0)
        lon = a[:, 0] * sx + tx
        lat = a[:, 1] * sy + ty
        x, y = TO_ALBERS.transform(lon, lat)
        out.append(np.column_stack([x, y]))
    return out


def ring_coords(ring, arcs):
    pts = []
    for i in ring:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.append(a if not pts else a[1:])
    return np.concatenate(pts)


def dp_simplify(pts, tol):
    """Douglas-Peucker on one arc; endpoints are always kept."""
    n = len(pts)
    if n <= 2:
        return pts
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        seg = pts[i + 1:j]
        d = b - a
        L = math.hypot(d[0], d[1])
        if L == 0:
            dist = np.hypot(seg[:, 0] - a[0], seg[:, 1] - a[1])
        else:
            dist = np.abs(d[0] * (seg[:, 1] - a[1]) - d[1] * (seg[:, 0] - a[0])) / L
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return pts[keep]


def fill_gaps(st, cache, shp, arcs, polys):
    """Give land with no precinct (the NYT data leaves out precincts with no
    votes) to neighboring precincts, so the map covers the whole state.

    Small holes go to one neighbor; big ones are cut into GAP_CELL squares,
    each given to the nearest precinct. New rings are appended to `arcs` and
    `polys` (in place). Returns the updated precinct geometries.
    """
    import geopandas as gpd
    states = gpd.read_file(fetch(STATE_URL, os.path.join(cache, "cb_2020_us_state_500k.zip")))
    outline = states[states.STUSPS == st].to_crs(5070).geometry.iloc[0]
    cover = shapely.union_all(shapely.buffer(shp, EPS / 2, quad_segs=2))
    gap = shapely.difference(outline, cover)
    # drop slivers along the (generalized) state outline
    gap = shapely.buffer(shapely.buffer(gap, -150, quad_segs=2), 150, quad_segs=2)
    gap = shapely.difference(gap, cover)
    pieces = [g for g in shapely.get_parts(gap) if g.area > 2e5]
    tree = shapely.STRtree(shp)
    fills = {}
    for g in pieces:
        if g.area < 4 * GAP_CELL ** 2:
            cand = tree.query(g, predicate="dwithin", distance=50)
            if len(cand) == 0:
                cand = tree.query_nearest(g, all_matches=False)
            touch = shapely.length(shapely.intersection(shapely.boundary(g), shapely.buffer(shp[cand], 50, quad_segs=2)))
            fills.setdefault(int(cand[int(np.argmax(touch))]), []).append(g)
            continue
        x0, y0, x1, y1 = g.bounds
        xs = np.arange(x0, x1, GAP_CELL)
        ys = np.arange(y0, y1, GAP_CELL)
        gx, gy = np.meshgrid(xs, ys)
        boxes = shapely.box(gx.ravel(), gy.ravel(), gx.ravel() + GAP_CELL, gy.ravel() + GAP_CELL)
        shapely.prepare(g)
        boxes = boxes[shapely.intersects(g, boxes)]
        cells = shapely.intersection(boxes, g)
        cells = cells[~shapely.is_empty(cells)]
        near = tree.query_nearest(shapely.point_on_surface(cells), all_matches=False)
        owner = np.empty(len(cells), dtype=np.int64)
        owner[near[0]] = near[1]
        for u in np.unique(owner):
            fills.setdefault(int(u), []).append(shapely.union_all(cells[owner == u]))
    added = 0.0
    for u, parts in fills.items():
        f = polygonal(shapely.make_valid(shapely.union_all(parts)))
        for poly in shapely.get_parts(f):
            if poly.geom_type != "Polygon" or poly.area < 1e3:
                continue
            rings = [np.asarray(poly.exterior.coords)] + [np.asarray(r.coords) for r in poly.interiors]
            part = []
            for r in rings:
                arcs.append(r[:, :2].copy())
                part.append([len(arcs) - 1])
            polys[u].append(part)
            added += poly.area
        shp[u] = polygonal(shapely.make_valid(shapely.union(shp[u], f)))
    print(f"  filled {added / 1e6:,.0f} km2 of land with no precinct ({len(pieces)} holes, {len(fills)} precincts grew)")
    return shp


def build(st, cache):
    meta = STATES[st]
    print(f"[{st}] loading precincts")
    topo = json.load(gzip.open(fetch(NYT_URL.format(st=st), os.path.join(cache, f"{st}-precincts.topojson.gz"))))
    geoms = topo["objects"][st]["geometries"]
    arcs = decode_arcs(topo)
    n = len(geoms)

    # Every precinct as a list of polygons; each polygon is a list of rings (arc index lists).
    polys = [[g["arcs"]] if g["type"] == "Polygon" else g["arcs"] for g in geoms]

    # Shapely geometries (projected, meters) for area / adjacency / block assignment.
    shp = []
    for poly in polys:
        parts = []
        for rp in poly:
            rings = [ring_coords(r, arcs) for r in rp]
            parts.append(shapely.Polygon(rings[0], rings[1:]))
        shp.append(shapely.MultiPolygon(parts) if len(parts) > 1 else parts[0])
    shp = np.array([polygonal(g) for g in shapely.make_valid(np.array(shp, dtype=object))], dtype=object)
    shp = fill_gaps(st, cache, shp, arcs, polys)
    area = shapely.area(shp)
    cent = shapely.point_on_surface(shp)
    cx, cy = shapely.get_x(cent), shapely.get_y(cent)
    tree = shapely.STRtree(shp)

    # Adjacency. The source topology is only partly shared (neighboring precincts
    # often have their own copies of a border, offset by well under a meter), so
    # neighbors and shared border lengths are measured geometrically: the length
    # of u's boundary within EPS of v.
    print(f"[{st}] measuring shared borders")
    bnd = shapely.boundary(shp)
    perim = shapely.length(bnd)
    qi, qj = tree.query(shp, predicate="dwithin", distance=EPS)
    m = qi < qj
    I, J = qi[m], qj[m]
    buf = shapely.buffer(shp, EPS, quad_segs=2)
    L_ij = shapely.length(shapely.intersection(bnd[I], buf[J]))
    L_ji = shapely.length(shapely.intersection(bnd[J], buf[I]))
    near = np.bincount(I, weights=L_ij, minlength=n) + np.bincount(J, weights=L_ji, minlength=n)
    ext = np.maximum(0.0, perim - near)  # state border, coastline, or gaps with no precinct
    shared = {}
    for a, b, l1, l2 in zip(I.tolist(), J.tolist(), L_ij.tolist(), L_ji.tolist()):
        L = (l1 + l2) / 2
        if L >= MIN_SHARED:
            shared[(a, b)] = L

    # Population: put every populated census block in a precinct.
    print(f"[{st}] assigning census blocks")
    bx, by, bpop, county_names = load_blocks(cache, st, meta)
    pts = shapely.points(bx, by)
    pairs = tree.query(pts, predicate="within")
    owner = np.full(len(pts), -1, dtype=np.int64)
    owner[pairs[0]] = pairs[1]  # a block on a shared edge takes any one owner
    miss = np.where(owner < 0)[0]
    if len(miss):
        near = tree.query_nearest(pts[miss], all_matches=False)
        owner[miss[near[0]]] = near[1]
    pop = np.bincount(owner, weights=bpop, minlength=n).astype(np.int64)
    print(f"  blocks {len(pts)}, outside precincts {len(miss)} ({bpop[miss].sum()} people -> nearest precinct)")
    print(f"  population {pop.sum():,}")

    # Connect islands / gaps: link each small component to its nearest outside precinct.
    adj = [set() for _ in range(n)]
    for (u, v) in shared:
        adj[u].add(v)
        adj[v].add(u)
    bridges = []
    while True:
        comp = np.full(n, -1)
        sizes = []
        for s in range(n):
            if comp[s] >= 0:
                continue
            c = len(sizes)
            stack = [s]
            comp[s] = c
            k = 0
            while stack:
                u = stack.pop()
                k += 1
                for v in adj[u]:
                    if comp[v] < 0:
                        comp[v] = c
                        stack.append(v)
            sizes.append(k)
        if len(sizes) == 1:
            break
        small = int(np.argmin(sizes))
        members = np.where(comp == small)[0]
        others = np.where(comp != small)[0]
        otree = shapely.STRtree(shp[others])
        best = None
        for u in members:
            j = otree.query_nearest(shp[u], return_distance=True)
            idx, dist = j[0][0], j[1][0]
            if best is None or dist < best[2]:
                best = (u, int(others[idx]), dist)
        u, v, d = best
        adj[u].add(v)
        adj[v].add(u)
        bridges.append((int(min(u, v)), int(max(u, v))))
    print(f"  {len(shared)} land borders, {len(bridges)} water/gap bridges, outer border {ext.sum() / 1000:,.0f} km")

    # County index from the precinct GEOID (first 5 digits = county FIPS).
    fips = [g["properties"]["GEOID"][:5] for g in geoms]
    county_list = sorted(set(fips))
    cidx = {c: i for i, c in enumerate(county_list)}

    # Arcs for drawing. Each output arc knows the precinct on either side
    # (-1 = outside the state), so the page can draw district borders.
    arc_users = [[] for _ in arcs]
    for u, poly in enumerate(polys):
        for part in poly:
            for ring in part:
                for i in ring:
                    arc_users[i if i >= 0 else ~i].append(u)
    arc_users = [sorted(set(us)) for us in arc_users]
    # For arcs only one precinct uses, find who is across each segment.
    single = [i for i, us in enumerate(arc_users) if len(us) == 1 and len(arcs[i]) > 1]
    seg_arc = np.concatenate([np.full(len(arcs[i]) - 1, i) for i in single])
    mids = np.concatenate([(arcs[i][:-1] + arcs[i][1:]) / 2 for i in single])
    mpts = shapely.points(mids[:, 0], mids[:, 1])
    owner_seg = np.array([arc_users[i][0] for i in seg_arc])
    pi, pj = tree.query(mpts, predicate="dwithin", distance=2 * EPS)
    keep = pj != owner_seg[pi]
    pi, pj = pi[keep], pj[keep]
    dist = shapely.distance(mpts[pi], shp[pj])
    order = np.lexsort((dist, pi))
    pi, pj = pi[order], pj[order]
    first = np.ones(len(pi), dtype=bool)
    first[1:] = pi[1:] != pi[:-1]
    partner = np.full(len(mpts), -1, dtype=np.int64)
    partner[pi[first]] = pj[first]
    # Nothing across: either the state's edge (-1, drawn as the outline) or a small
    # interior gap in the precinct coverage (-2, not drawn).
    union = shapely.union_all(shapely.buffer(shp, EPS, quad_segs=2))
    rings = [shapely.LineString(shapely.get_exterior_ring(g).coords) for g in shapely.get_parts(union)]
    rtree = shapely.STRtree(rings)
    lonely = np.where(partner < 0)[0]
    on_edge = np.zeros(len(mpts), dtype=bool)
    hit = rtree.query(mpts[lonely], predicate="dwithin", distance=3 * EPS)[0]
    on_edge[lonely[hit]] = True
    partner[(partner < 0) & ~on_edge] = -2
    seg_start = {}
    off = 0
    for i in single:
        seg_start[i] = off
        off += len(arcs[i]) - 1

    tol = meta["tol"]
    q = 10.0  # meters per unit
    out_arcs, out_l, out_r = [], [], []
    new_ids = []
    npts = 0

    def emit(pts, l, r):
        nonlocal npts
        sp = dp_simplify(pts, tol)
        qa = np.round(sp / q).astype(np.int64)
        kp = np.ones(len(qa), dtype=bool)
        kp[1:] = np.any(np.diff(qa, axis=0) != 0, axis=1)
        kp[-1] = True
        qa = qa[kp]
        if len(qa) == 1:
            qa = np.vstack([qa, qa])
        d = np.vstack([qa[:1], np.diff(qa, axis=0)])
        out_arcs.append(d.ravel().tolist())
        out_l.append(int(l))
        out_r.append(int(r))
        npts += len(qa)
        return len(out_arcs) - 1

    for i, a in enumerate(arcs):
        us = arc_users[i]
        if i in seg_start:
            p = partner[seg_start[i]: seg_start[i] + len(a) - 1]
            ids = []
            j0 = 0
            for j in range(1, len(p) + 1):
                if j == len(p) or p[j] != p[j0]:
                    ids.append(emit(a[j0: j + 1], us[0], p[j0]))
                    j0 = j
            new_ids.append(ids)
        else:
            new_ids.append([emit(a, us[0] if us else -1, us[1] if len(us) > 1 else -1)])

    def remap(ring):
        out = []
        for r in ring:
            out += new_ids[r] if r >= 0 else [~x for x in reversed(new_ids[~r])]
        return out

    polys = [[[remap(ring) for ring in part] for part in poly] for poly in polys]
    print(f"  arcs {len(out_arcs)} (from {len(arcs)}), drawn points {npts}")

    props = [g["properties"] for g in geoms]
    edges = []
    for (u, v), L in sorted(shared.items()):
        edges += [u, v, max(1, int(round(L)))]  # 0 is reserved for water/gap bridges
    for (u, v) in bridges:
        if (u, v) not in shared:
            edges += [u, v, 0]

    minx, miny = float(min(a[:, 0].min() for a in arcs)), float(min(a[:, 1].min() for a in arcs))
    maxx, maxy = float(max(a[:, 0].max() for a in arcs)), float(max(a[:, 1].max() for a in arcs))
    data = {
        "state": st,
        "name": meta["name"],
        "seats": meta["seats"],
        "source": {
            "votes": "2024 presidential results by precinct, The New York Times (github.com/nytimes/presidential-precinct-map-2024)",
            "population": "2020 Census P.L. 94-171 block populations, assigned to the precinct containing each block",
        },
        "n": n,
        "id": [p["GEOID"] for p in props],
        "pop": pop.tolist(),
        "dem": [int(p.get("votes_dem") or 0) for p in props],
        "rep": [int(p.get("votes_rep") or 0) for p in props],
        "tot": [int(p.get("votes_total") or 0) for p in props],
        "area": [int(round(a / 1000)) for a in area],          # 1000 m^2 units
        "ext": [int(round(e)) for e in ext],                    # meters of state border/coast
        "cx": [int(round(x / q)) for x in cx],
        "cy": [int(round(y / q)) for y in cy],
        "county": [cidx[f] for f in fips],
        "counties": [{"fips": c, "name": county_names.get(c, c)} for c in county_list],
        "edges": edges,                                          # [u, v, shared border meters, ...]
        "geo": {"q": q, "bbox": [minx / q, miny / q, maxx / q, maxy / q], "arcs": out_arcs, "left": out_l, "right": out_r, "polys": polys},
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{st.lower()}.js")
    body = json.dumps(data, separators=(",", ":"))
    with open(path, "w") as f:
        f.write("// Generated by tools/redistricting/build_data.py. Do not edit by hand.\n")
        f.write("(window.REDISTRICT_DATA = window.REDISTRICT_DATA || {})." + st + " = " + body + ";\n")
    print(f"  wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("states", nargs="*", default=list(STATES))
    ap.add_argument("--cache", default=os.path.join(ROOT, ".cache", "redistricting"))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    for st in args.states:
        build(st.upper(), args.cache)


if __name__ == "__main__":
    sys.exit(main())
