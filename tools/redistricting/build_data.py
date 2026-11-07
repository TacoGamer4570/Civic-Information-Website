#!/usr/bin/env python3
"""Build the census-block data used by the redistricting simulator.

For each state this script:
  1. reads every 2020 Census block (TIGER/Line shapes + P.L. 94-171 counts),
  2. builds the block adjacency graph from the shared TIGER borders, with the
     length of each shared border (used for compactness) and each block's
     length of state border/coastline,
  3. puts every block in the 2024 precinct (New York Times) that contains it
     and estimates the block's Harris/Trump votes from its precinct's result,
     in proportion to voting-age population,
  4. draws "id images" of the state (each pixel = the block under it) at two
     resolutions, so the page can paint hundreds of thousands of blocks fast,
  5. writes data/redistricting/<st>.js and data/redistricting/<st>/t*.js.

Usage:
  pip install shapely pyproj numpy scipy geopandas rasterio
  python3 tools/redistricting/build_data.py [TX CA PA VA NC FL MI OH GA NV WI AZ NY IL MN CO OR WA NH] [--cache DIR]

Downloads (~1.8 GB) are cached in --cache (default .cache/redistricting).
"""
import argparse
import base64
import gzip
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
import zlib

import numpy as np
import shapely
from pyproj import Transformer

STATES = {
    "TX": {"fips": "48", "name": "Texas", "seats": 38, "pl": "Texas"},
    "CA": {"fips": "06", "name": "California", "seats": 52, "pl": "California"},
    "PA": {"fips": "42", "name": "Pennsylvania", "seats": 17, "pl": "Pennsylvania"},
    "VA": {"fips": "51", "name": "Virginia", "seats": 11, "pl": "Virginia"},
    "NC": {"fips": "37", "name": "North Carolina", "seats": 14, "pl": "North_Carolina"},
    "FL": {"fips": "12", "name": "Florida", "seats": 28, "pl": "Florida"},
    "MI": {"fips": "26", "name": "Michigan", "seats": 13, "pl": "Michigan"},
    "OH": {"fips": "39", "name": "Ohio", "seats": 15, "pl": "Ohio"},
    "GA": {"fips": "13", "name": "Georgia", "seats": 14, "pl": "Georgia"},
    "NV": {"fips": "32", "name": "Nevada", "seats": 4, "pl": "Nevada"},
    "WI": {"fips": "55", "name": "Wisconsin", "seats": 8, "pl": "Wisconsin"},
    "AZ": {"fips": "04", "name": "Arizona", "seats": 9, "pl": "Arizona"},
    "NY": {"fips": "36", "name": "New York", "seats": 26, "pl": "New_York"},
    "IL": {"fips": "17", "name": "Illinois", "seats": 17, "pl": "Illinois"},
    "MN": {"fips": "27", "name": "Minnesota", "seats": 8, "pl": "Minnesota"},
    "CO": {"fips": "08", "name": "Colorado", "seats": 8, "pl": "Colorado"},
    "OR": {"fips": "41", "name": "Oregon", "seats": 6, "pl": "Oregon"},
    "WA": {"fips": "53", "name": "Washington", "seats": 10, "pl": "Washington"},
    "NH": {"fips": "33", "name": "New Hampshire", "seats": 2, "pl": "New_Hampshire"},
}
NYT_URL = "https://int.nyt.com/newsgraphics/elections/map-data/2024/national/{st}-precincts-with-results.topojson.gz"
PL_URL = ("https://www2.census.gov/programs-surveys/decennial/2020/data/"
          "01-Redistricting_File--PL_94-171/{name}/{st}2020.pl.zip")
BLOCK_URL = "https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_{fips}_tabblock20.zip"

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, "data", "redistricting")

TO_ALBERS = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)  # meters
OVERVIEW_PX = 2048   # long side of the overview id image
DETAIL = 4           # detail images are DETAIL x the overview resolution
TILE = 512           # detail tile size in pixels
Q = 50.0             # meters per unit for block label points


def log(*a):
    print(*a, flush=True)


def fetch(url, path):
    if not os.path.exists(path):
        log("  downloading", url)
        with urllib.request.urlopen(url) as r, open(path + ".part", "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.rename(path + ".part", path)
    return path


# ---------------------------------------------------------------- precincts
def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    out = []
    for arc in topo["arcs"]:
        a = np.cumsum(np.array(arc, dtype=np.int64), axis=0)
        x, y = TO_ALBERS.transform(a[:, 0] * sx + tx, a[:, 1] * sy + ty)
        out.append(np.column_stack([x, y]))
    return out


def ring_coords(ring, arcs):
    pts = []
    for i in ring:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.append(a if not pts else a[1:])
    return np.concatenate(pts)


def polygonal(g):
    """Keep only the polygon parts of a geometry (make_valid can return collections)."""
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in shapely.get_parts(g) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else shapely.Polygon()


def load_precincts(st, cache):
    topo = json.load(gzip.open(fetch(NYT_URL.format(st=st), os.path.join(cache, f"{st}-precincts.topojson.gz"))))
    geoms = topo["objects"][st]["geometries"]
    arcs = decode_arcs(topo)
    shp = []
    for g in geoms:
        if "arcs" not in g:  # a few precincts come without a shape
            shp.append(shapely.Polygon())
            continue
        poly = [g["arcs"]] if g["type"] == "Polygon" else g["arcs"]
        parts = [shapely.Polygon(ring_coords(rp[0], arcs), [ring_coords(r, arcs) for r in rp[1:]]) for rp in poly]
        shp.append(shapely.MultiPolygon(parts) if len(parts) > 1 else parts[0])
    shp = np.array([polygonal(g) for g in shapely.make_valid(np.array(shp, dtype=object))], dtype=object)
    props = [g["properties"] for g in geoms]
    return shp, props


# ---------------------------------------------------------------- census
def load_pl(cache, st, meta):
    """Voting-age population by block GEOID, and county names."""
    zpath = fetch(PL_URL.format(name=meta["pl"], st=st.lower()), os.path.join(cache, f"{st.lower()}2020.pl.zip"))
    rec_to_geoid, counties, vap = {}, {}, {}
    with zipfile.ZipFile(zpath) as z:
        with z.open(f"{st.lower()}geo2020.pl") as raw:
            for line in io.TextIOWrapper(raw, encoding="latin-1"):
                f = line.split("|")
                if f[2] == "050":
                    counties[f[9][2:]] = f[-10]
                elif f[2] == "750":
                    rec_to_geoid[f[7]] = f[8][-15:]
        with z.open(f"{st.lower()}000022020.pl") as raw:
            for line in io.TextIOWrapper(raw, encoding="latin-1"):
                f = line.split("|", 6)
                g = rec_to_geoid.get(f[4])
                if g:
                    vap[g] = int(f[5])  # P0030001: population 18+
    return vap, counties


def load_blocks(cache, st, meta):
    import geopandas as gpd
    path = fetch(BLOCK_URL.format(fips=meta["fips"]), os.path.join(cache, f"tl_2020_{meta['fips']}_tabblock20.zip"))
    cols = ["GEOID20", "COUNTYFP20", "TRACTCE20", "BLOCKCE20", "POP20", "INTPTLAT20", "INTPTLON20", "ALAND20"]
    g = gpd.read_file(path, engine="pyogrio", columns=cols)
    return g.sort_values("GEOID20").reset_index(drop=True)


def adjacency(geo, n):
    """Exact block adjacency from TIGER's shared vertices.

    Every border segment is keyed by its two endpoints; a segment found in two
    blocks is a shared border, a segment found once is the state's edge.
    Returns (u, v, length) with u < v, and each block's outer-edge length.
    """
    rings, ridx = shapely.get_rings(geo, return_index=True)
    xy, cidx = shapely.get_coordinates(rings, return_index=True)
    blk = ridx[cidx]
    same = cidx[1:] == cidx[:-1]
    a, b, sb = xy[:-1][same], xy[1:][same], blk[:-1][same]
    del xy, cidx, blk, rings
    ax, ay = TO_ALBERS.transform(a[:, 0], a[:, 1])
    bx, by = TO_ALBERS.transform(b[:, 0], b[:, 1])
    L = np.hypot(bx - ax, by - ay)
    del ax, ay, bx, by
    qa = np.round(a * 1e7).astype(np.int64)
    qb = np.round(b * 1e7).astype(np.int64)
    del a, b
    swap = (qa[:, 0] > qb[:, 0]) | ((qa[:, 0] == qb[:, 0]) & (qa[:, 1] > qb[:, 1]))
    p = np.where(swap[:, None], qb, qa)
    q = np.where(swap[:, None], qa, qb)
    del qa, qb, swap
    order = np.lexsort((q[:, 1], q[:, 0], p[:, 1], p[:, 0]))
    p, q, sb, L = p[order], q[order], sb[order], L[order]
    new = np.ones(len(p), bool)
    new[1:] = np.any(p[1:] != p[:-1], axis=1) | np.any(q[1:] != q[:-1], axis=1)
    del p, q
    gid = np.cumsum(new) - 1
    cnt = np.bincount(gid)
    single = cnt[gid] == 1
    ext = np.bincount(sb[single], weights=L[single], minlength=n)
    first = np.flatnonzero(new)
    pairs = first[cnt >= 2]
    u, v, l = sb[pairs], sb[pairs + 1], L[pairs]
    m = u != v
    u, v, l = u[m], v[m], l[m]
    lo, hi = np.minimum(u, v), np.maximum(u, v)
    key = lo.astype(np.int64) * n + hi
    uk, inv = np.unique(key, return_inverse=True)
    lens = np.bincount(inv, weights=l)
    return (uk // n).astype(np.int64), (uk % n).astype(np.int64), lens, ext


def connect_components(n, u, v, px, py):
    """Link separate pieces of the graph (islands) to the nearest block outside them."""
    import scipy.sparse as sp
    import scipy.sparse.csgraph as cg
    from scipy.spatial import cKDTree
    bridges = []
    while True:
        bu = np.array([b[0] for b in bridges], dtype=np.int64)
        bv = np.array([b[1] for b in bridges], dtype=np.int64)
        A = sp.coo_matrix((np.ones(len(u) + len(bu)), (np.r_[u, bu], np.r_[v, bv])), shape=(n, n))
        nc, lab = cg.connected_components(A, directed=False)
        if nc == 1:
            return bridges
        small = int(np.argmin(np.bincount(lab)))
        mem = np.flatnonzero(lab == small)
        oth = np.flatnonzero(lab != small)
        d, j = cKDTree(np.c_[px[oth], py[oth]]).query(np.c_[px[mem], py[mem]])
        k = int(np.argmin(d))
        a, b = int(mem[k]), int(oth[j[k]])
        bridges.append((min(a, b), max(a, b)))


LINK_KM = 3.0  # land masses this close across water get linked (narrow rivers, sounds, causeways)


def land_bridges(n, u, v, water, px, py):
    """Districts may only connect over land. Pieces of land cut off by water
    (islands, Manhattan, Long Island, Michigan's Upper Peninsula...) are linked to
    every other piece within LINK_KM across the water, at their closest points,
    and anything still cut off gets one link to the nearest land.
    Returns flat [a, b, a, b, ...]."""
    import scipy.sparse as sp
    import scipy.sparse.csgraph as cg
    from scipy.spatial import cKDTree
    land = np.flatnonzero(water == 0)
    m = (water[u] == 0) & (water[v] == 0)
    lu, lv = u[m], v[m]
    pts = np.c_[px, py]
    tree = cKDTree(pts[land])

    def components(extra):
        bu = np.array([b[0] for b in extra], dtype=np.int64)
        bv = np.array([b[1] for b in extra], dtype=np.int64)
        A = sp.coo_matrix((np.ones(len(lu) + len(bu)), (np.r_[lu, bu], np.r_[lv, bv])), shape=(n, n)).tocsr()
        return cg.connected_components(A[land][:, land], directed=False)

    # 1. every pair of land masses within LINK_KM, at their closest points
    nc, lab = components([])
    best = {}
    if nc > 1:
        main = int(np.argmax(np.bincount(lab)))
        lp = pts[land]
        R = LINK_KM * 1000
        for c in range(nc):
            if c == main:
                continue
            mem = np.flatnonzero(lab == c)
            cp = lp[mem]
            lo, hi = cp.min(axis=0) - R, cp.max(axis=0) + R
            near = np.flatnonzero((lab != c) & np.all((lp >= lo) & (lp <= hi), axis=1))
            if not len(near):
                continue
            d, j = cKDTree(cp).query(lp[near], distance_upper_bound=R)
            ok = np.flatnonzero(np.isfinite(d))
            for r in ok:
                c2 = lab[near[r]]
                key = (min(c, c2), max(c, c2))
                if key not in best or d[r] < best[key][0]:
                    best[key] = (d[r], land[mem[j[r]]], land[near[r]])
    bridges = {(int(min(a, b)), int(max(a, b))) for _, a, b in best.values()}

    # 2. anything still cut off: one link to the nearest land outside it
    while True:
        nc, lab = components(list(bridges))
        if nc == 1:
            break
        sizes = np.bincount(lab)
        main = int(np.argmax(sizes))
        for c in np.argsort(sizes):
            if c == main:
                continue
            mem = np.flatnonzero(lab == c)
            d, j = tree.query(pts[land[mem]], k=min(len(land), 64))
            d = np.where(lab[j] != c, d, np.inf)
            if not np.isfinite(d).any():
                oth = np.flatnonzero(lab != c)
                d2, j2 = cKDTree(pts[land[oth]]).query(pts[land[mem]])
                i = int(np.argmin(d2)); a, b = land[mem[i]], land[oth[j2[i]]]
            else:
                i, k2 = np.unravel_index(np.argmin(d), d.shape)
                a, b = land[mem[i]], land[j[i, k2]]
            bridges.add((int(min(a, b)), int(max(a, b))))
    return [x for b in sorted(bridges) for x in b]


# ---------------------------------------------------------------- output
def pack(arr):
    return base64.b64encode(zlib.compress(np.ascontiguousarray(arr).tobytes(), 9)).decode()


def delta(a):
    a = np.asarray(a, dtype=np.int64)
    return np.r_[a[:1], np.diff(a)].astype("<i4")


def encode_ids(img):
    """Row-delta encode an id image, then deflate + base64."""
    d = img.astype(np.int64)
    d[:, 1:] = d[:, 1:] - d[:, :-1]
    return pack(d.astype("<i4"))


def rasterize(geo_proj, n, bbox, px_size, shape):
    from rasterio import features
    from rasterio.transform import from_origin
    tr = from_origin(bbox[0], bbox[3], px_size, px_size)
    ids = range(1, n + 1)
    return features.rasterize(zip(geo_proj, ids), out_shape=shape, transform=tr, fill=0, dtype="uint32")


def build(st, cache):
    meta = STATES[st]
    t0 = time.time()
    log(f"[{st}] reading census blocks")
    blocks = load_blocks(cache, st, meta)
    n = len(blocks)
    geo = np.asarray(blocks.geometry.values)
    log(f"  {n:,} blocks, {int(blocks.POP20.sum()):,} people ({time.time() - t0:.0f}s)")

    log(f"[{st}] block adjacency")
    eu, ev, elen, ext = adjacency(geo, n)
    lon = blocks.INTPTLON20.astype(float).values
    lat = blocks.INTPTLAT20.astype(float).values
    px, py = TO_ALBERS.transform(lon, lat)
    bridges = connect_components(n, eu, ev, px, py)
    log(f"  {len(eu):,} shared borders, {len(bridges)} water bridges, state edge {ext.sum() / 1000:,.0f} km ({time.time() - t0:.0f}s)")

    log(f"[{st}] projecting shapes")
    geo_proj = shapely.transform(geo, lambda c: np.column_stack(TO_ALBERS.transform(c[:, 0], c[:, 1])))
    area = shapely.area(geo_proj)
    del geo

    log(f"[{st}] matching blocks to 2024 precincts")
    pshp, props = load_precincts(st, cache)
    tree = shapely.STRtree(pshp)
    pts = shapely.points(px, py)
    hit = tree.query(pts, predicate="within")
    prec = np.full(n, -1, dtype=np.int64)
    prec[hit[0]] = hit[1]
    miss = np.flatnonzero(prec < 0)
    if len(miss):
        near = tree.query_nearest(pts[miss], all_matches=False)
        prec[miss[near[0]]] = near[1]
    pop = blocks.POP20.values.astype(np.int64)
    log(f"  {len(miss):,} blocks outside any precinct ({int(pop[miss].sum()):,} people) -> nearest precinct")

    log(f"[{st}] estimating block votes")
    vap_map, county_names = load_pl(cache, st, meta)
    vap = np.array([vap_map.get(g, 0) for g in blocks.GEOID20.values], dtype=np.float64)
    npct = len(props)
    pdem = np.array([p.get("votes_dem") or 0 for p in props], dtype=np.float64)
    prep = np.array([p.get("votes_rep") or 0 for p in props], dtype=np.float64)
    # split each precinct's votes by voting-age population; fall back to population, then area
    w = vap.copy()
    for alt in (pop.astype(np.float64), area):
        tot = np.bincount(prec, weights=w, minlength=npct)
        w = np.where(tot[prec] <= 0, alt, w)
    tot = np.bincount(prec, weights=w, minlength=npct)
    share = np.where(tot[prec] > 0, w / np.maximum(tot[prec], 1e-12), 0)
    wsave = w
    # Tiny precincts that contain no block's center: give their votes to the
    # block nearest the precinct, so no votes are lost.
    from scipy.spatial import cKDTree
    orphan = np.flatnonzero(tot <= 0)
    xb, xd, xr = [], [], []
    if len(orphan):
        # a precinct with no shape borrows the location of a sibling with the same
        # name stem (e.g. "RIVERSIDE-C" -> "RIVERSIDE-B"), or else any precinct in its county
        ids = [p["GEOID"] for p in props]
        where = list(pshp[orphan])
        for i, o in enumerate(orphan):
            if not where[i].is_empty:
                continue
            stem, county5 = ids[o].rsplit("-", 1)[0], ids[o][:5]
            sib = [j for j, g in enumerate(ids) if j != o and not pshp[j].is_empty and g.startswith(stem)] or \
                  [j for j, g in enumerate(ids) if j != o and not pshp[j].is_empty and g.startswith(county5)]
            where[i] = pshp[sib[0]]
            log(f"  precinct {ids[o]} has no shape; its votes go near {ids[sib[0]]}")
        rp = shapely.point_on_surface(np.array(where, dtype=object))
        _, nearest = cKDTree(np.c_[px, py]).query(np.c_[shapely.get_x(rp), shapely.get_y(rp)])
        keep = (pdem[orphan] + prep[orphan]) > 0
        xb, xd, xr = nearest[keep].tolist(), pdem[orphan][keep].astype(int).tolist(), prep[orphan][keep].astype(int).tolist()
    log(f"  {len(xb)} precincts with no block center; votes moved to the nearest block")
    log(f"  Harris {(pdem[prec] * share).sum() + sum(xd):,.0f} of {pdem.sum():,.0f}, Trump {(prep[prec] * share).sum() + sum(xr):,.0f} of {prep.sum():,.0f}")

    cfips = blocks.COUNTYFP20.values
    clist = sorted(set(cfips))
    cidx = {c: i for i, c in enumerate(clist)}
    county = np.array([cidx[c] for c in cfips], dtype=np.uint16)

    # edges in CSR order (u < v); bridges have length 0
    allu = np.r_[eu, [b[0] for b in bridges]].astype(np.int64)
    allv = np.r_[ev, [b[1] for b in bridges]].astype(np.int64)
    alll = np.r_[np.maximum(np.round(elen), 1), np.zeros(len(bridges))]
    o = np.lexsort((allv, allu))
    allu, allv, alll = allu[o], allv[o], alll[o]
    deg = np.bincount(allu, minlength=n)

    log(f"[{st}] drawing id images")
    minx, miny, maxx, maxy = shapely.total_bounds(geo_proj)
    px0 = max(maxx - minx, maxy - miny) / OVERVIEW_PX
    w0, h0 = int(np.ceil((maxx - minx) / px0)), int(np.ceil((maxy - miny) / px0))
    bbox = [float(minx), float(maxy - h0 * px0), float(minx + w0 * px0), float(maxy)]
    over = rasterize(geo_proj, n, bbox, px0, (h0, w0))
    w1, h1 = w0 * DETAIL, h0 * DETAIL
    detail = rasterize(geo_proj, n, bbox, px0 / DETAIL, (h1, w1))
    rows, cols = int(np.ceil(h1 / TILE)), int(np.ceil(w1 / TILE))
    tdir = os.path.join(OUT_DIR, st.lower())
    os.makedirs(tdir, exist_ok=True)
    for f in os.listdir(tdir):
        os.remove(os.path.join(tdir, f))
    tiles, tbytes = [], 0
    for r in range(rows):
        for c in range(cols):
            t = detail[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE]
            if not t.any():
                continue
            full = np.zeros((TILE, TILE), dtype=np.uint32)
            full[: t.shape[0], : t.shape[1]] = t
            body = f'window.REDISTRICT_TILE("{st}",{r},{c},"{encode_ids(full)}");\n'
            with open(os.path.join(tdir, f"t{r}_{c}.js"), "w") as fh:
                fh.write(body)
            tbytes += len(body)
            tiles.append(r * cols + c)
    log(f"  overview {w0}x{h0}, detail {w1}x{h1} in {len(tiles)} tiles ({tbytes / 1e6:.1f} MB)")

    data = {
        "state": st,
        "name": meta["name"],
        "seats": meta["seats"],
        "fips": meta["fips"],
        "source": {
            "blocks": "2020 Census blocks: TIGER/Line shapes and P.L. 94-171 counts",
            "votes": "2024 presidential results by precinct (The New York Times), split to blocks by voting-age population",
        },
        "n": n,
        "nEdges": int(len(allu)),
        "counties": [{"fips": meta["fips"] + c, "name": county_names.get(c, c)} for c in clist],
        "precincts": {
            "id": [p["GEOID"] for p in props],
            "dem": pdem.astype(int).tolist(),
            "rep": prep.astype(int).tolist(),
        },
        # land-only contiguity: links for land cut off by water [a, b, a, b, ...]
        "landBridges": land_bridges(n, allu, allv, (blocks.ALAND20.values == 0).astype(np.int8), np.asarray(px), np.asarray(py)),
        # votes of precincts with no block center, added to one nearby block
        "extraVotes": {"block": [int(x) for x in xb], "dem": xd, "rep": xr},
        # deflated little-endian typed arrays, base64. Block votes are
        # precinct votes * weight / (sum of weights in the precinct).
        "arrays": {
            "pop": ["u32", pack(pop.astype("<u4"))],
            "water": ["u8", pack((blocks.ALAND20.values == 0).astype("u1"))],  # 1 = no land (lakes, sea)
            "weight": ["u32", pack(np.minimum(np.round(wsave), 4e9).astype("<u4"))],
            "precinct": ["i32", pack(prec.astype("<i4"))],
            "county": ["u16", pack(county.astype("<u2"))],
            "tract": ["u32", pack(blocks.TRACTCE20.astype(int).values.astype("<u4"))],
            "block": ["u16", pack(blocks.BLOCKCE20.astype(int).values.astype("<u2"))],
            "area": ["u32", pack(np.round(area / 100).astype("<u4"))],   # 100 m^2 units
            "ext": ["u32", pack(np.round(ext).astype("<u4"))],           # meters
            "x": ["d32", pack(delta(np.round(np.asarray(px) / Q)))],      # Q-meter units, delta coded
            "y": ["d32", pack(delta(np.round(np.asarray(py) / Q)))],
            "deg": ["u16", pack(deg.astype("<u2"))],
            "dv": ["i32", pack((allv - allu).astype("<i4"))],
            "elen": ["u32", pack(alll.astype("<u4"))],                   # meters, 0 = water bridge
        },
        "raster": {
            "bbox": bbox, "q": Q,
            "overview": {"w": w0, "h": h0, "data": encode_ids(over)},
            "detail": {"w": w1, "h": h1, "tile": TILE, "rows": rows, "cols": cols, "tiles": tiles},
        },
    }
    path = os.path.join(OUT_DIR, f"{st.lower()}.js")
    with open(path, "w") as f:
        f.write("// Generated by tools/redistricting/build_data.py. Do not edit by hand.\n")
        f.write("(window.REDISTRICT_DATA = window.REDISTRICT_DATA || {})." + st + " = " + json.dumps(data, separators=(",", ":")) + ";\n")
    log(f"  wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


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
