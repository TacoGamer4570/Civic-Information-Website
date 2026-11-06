/* Canvas map for the redistricting simulator.
 *
 * The state is stored as "id images": every pixel holds the census block under
 * it (id = block index + 1, 0 = outside). Each frame, every screen pixel looks
 * up its block, takes that block's color, and turns ink-colored where the
 * district changes from the pixel next to it. A coarse overview image is always
 * loaded; sharper tiles load on demand when zoomed in.
 */
(function (root) {
  "use strict";

  function RedistrictMap(canvas, data, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = data;              // decoded state (see app.js)
    this.opts = opts || {};
    const R = data.raster;
    this.R = R;
    this.bbox = R.bbox;
    this.px0 = (R.bbox[2] - R.bbox[0]) / R.overview.w;     // meters per overview pixel
    this.detailScale = R.detail.w / R.overview.w;
    this.tiles = new Map();          // tile index -> Uint32Array (decoded)
    this.tileLoading = new Set();
    this.tileSet = new Set(R.detail.tiles);
    this.view = { cx: (R.bbox[0] + R.bbox[2]) / 2, cy: (R.bbox[1] + R.bbox[3]) / 2, scale: 1 };
    this.colors = null;              // Uint32Array per block (little-endian RGBA)
    this.dist = null;                // Int32Array per block (district) or null
    this.labels = [];
    this.hover = -1;
    this.highlightDistrict = -1;
    this._bind();
    this.resize();
  }

  // Packs a CSS color into a little-endian RGBA uint32 (for ImageData).
  const colorCache = new Map();
  let probe = null;
  function packColor(css) {
    let v = colorCache.get(css);
    if (v !== undefined) return v;
    if (!probe) probe = document.createElement("canvas").getContext("2d");
    probe.fillStyle = "#000"; probe.fillStyle = css;
    const s = probe.fillStyle; // normalized "#rrggbb" or "rgba(...)"
    let r = 0, g = 0, b = 0, a = 255;
    if (s[0] === "#") { r = parseInt(s.slice(1, 3), 16); g = parseInt(s.slice(3, 5), 16); b = parseInt(s.slice(5, 7), 16); }
    else { const m = s.match(/[\d.]+/g); r = +m[0]; g = +m[1]; b = +m[2]; if (m[3] != null) a = Math.round(+m[3] * 255); }
    v = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    colorCache.set(css, v);
    return v;
  }
  RedistrictMap.packColor = packColor;

  RedistrictMap.prototype.resize = function () {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    const bb = this.bbox;
    this.baseScale = Math.min(this.w / (bb[2] - bb[0]), this.h / (bb[3] - bb[1])) * 0.96; // CSS px per meter
    this.image = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.pix = new Uint32Array(this.image.data.buffer);
    this.draw();
  };

  RedistrictMap.prototype.toWorld = function (px, py) {
    const s = this.baseScale * this.view.scale;
    return { x: this.view.cx + (px - this.w / 2) / s, y: this.view.cy - (py - this.h / 2) / s };
  };
  RedistrictMap.prototype.toScreen = function (x, y) {
    const s = this.baseScale * this.view.scale;
    return { x: (x - this.view.cx) * s + this.w / 2, y: -(y - this.view.cy) * s + this.h / 2 };
  };

  RedistrictMap.prototype.setPlan = function (colors, dist, labels) {
    this.colors = colors;
    this.dist = dist;
    this.labels = labels || [];
    this.draw();
  };

  RedistrictMap.prototype.draw = function () {
    if (this._raf) return;
    const self = this;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._draw(); });
  };

  // Use the detail tiles once a screen pixel covers less than an overview pixel.
  RedistrictMap.prototype._useDetail = function () {
    const metersPerDevicePx = 1 / (this.baseScale * this.view.scale * this.dpr);
    return metersPerDevicePx < this.px0 * 0.8;
  };

  RedistrictMap.prototype._ensureTiles = function () {
    if (!this._useDetail()) return;
    const D = this.R.detail, ts = D.tile;
    const pd = this.px0 / this.detailScale;
    const a = this.toWorld(0, 0), b = this.toWorld(this.w, this.h);
    const c0 = Math.max(0, Math.floor((a.x - this.bbox[0]) / pd / ts)), c1 = Math.min(D.cols - 1, Math.floor((b.x - this.bbox[0]) / pd / ts));
    const r0 = Math.max(0, Math.floor((this.bbox[3] - a.y) / pd / ts)), r1 = Math.min(D.rows - 1, Math.floor((this.bbox[3] - b.y) / pd / ts));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const ti = r * D.cols + c;
      if (this.tileSet.has(ti) && !this.tiles.has(ti) && !this.tileLoading.has(ti)) {
        this.tileLoading.add(ti);
        if (this.opts.loadTile) this.opts.loadTile(r, c);
      }
    }
  };
  RedistrictMap.prototype.addTile = function (r, c, ids) {
    const ti = r * this.R.detail.cols + c;
    this.tiles.set(ti, ids);
    this.tileLoading.delete(ti);
    this.draw();
  };

  // block id (index + 1) at a world point, or 0
  RedistrictMap.prototype._idAt = function (wx, wy, detail) {
    const R = this.R;
    const ox = (wx - this.bbox[0]) / this.px0, oy = (this.bbox[3] - wy) / this.px0;
    if (detail) {
      const ds = this.detailScale, ts = R.detail.tile;
      const dx = Math.floor(ox * ds), dy = Math.floor(oy * ds);
      if (dx >= 0 && dy >= 0 && dx < R.detail.w && dy < R.detail.h) {
        const t = this.tiles.get(((dy / ts) | 0) * R.detail.cols + ((dx / ts) | 0));
        if (t) return t[(dy % ts) * ts + (dx % ts)];
      }
    }
    const x = Math.floor(ox), y = Math.floor(oy);
    if (x < 0 || y < 0 || x >= R.overview.w || y >= R.overview.h) return 0;
    return this.data.overview[y * R.overview.w + x];
  };

  RedistrictMap.prototype._draw = function () {
    const css = getComputedStyle(this.canvas);
    const bg = packColor(css.getPropertyValue("--map-bg").trim() || "#fff");
    const ink = packColor(css.getPropertyValue("--map-ink").trim() || "#141414");
    const empty = packColor(css.getPropertyValue("--map-empty").trim() || "#ddd");
    const W = this.canvas.width, H = this.canvas.height, dpr = this.dpr;
    const R = this.R, pix = this.pix;
    const detail = this._useDetail();
    this._ensureTiles();

    // block id for every device pixel
    if (!this.ids || this.ids.length !== W * H) this.ids = new Uint32Array(W * H);
    const ids = this.ids;
    const s = this.baseScale * this.view.scale * dpr; // device px per meter
    const x0 = this.view.cx - W / 2 / s, y0 = this.view.cy + H / 2 / s;
    const ow = R.overview.w, oh = R.overview.h, over = this.data.overview;
    const colX = new Int32Array(W), colTile = new Int32Array(W), colOff = new Int32Array(W);
    const ds = this.detailScale, ts = R.detail.tile, dcols = R.detail.cols;
    for (let x = 0; x < W; x++) {
      const ox = (x0 + (x + 0.5) / s - this.bbox[0]) / this.px0;
      colX[x] = ox >= 0 && ox < ow ? Math.floor(ox) : -1;
      const dx = Math.floor(ox * ds);
      colTile[x] = dx >= 0 && dx < R.detail.w ? (dx / ts) | 0 : -1;
      colOff[x] = dx % ts;
    }
    for (let y = 0; y < H; y++) {
      const oy = (this.bbox[3] - (y0 - (y + 0.5) / s)) / this.px0;
      const row = y * W;
      const iy = Math.floor(oy);
      if (iy < 0 || iy >= oh) { ids.fill(0, row, row + W); continue; }
      const orow = iy * ow;
      let trow = -1, toff = 0;
      if (detail) {
        const dy = Math.floor(oy * ds);
        if (dy >= 0 && dy < R.detail.h) { trow = ((dy / ts) | 0) * dcols; toff = (dy % ts) * ts; }
      }
      let lastTi = -2, tile = null;
      for (let x = 0; x < W; x++) {
        const cx = colX[x];
        if (cx < 0) { ids[row + x] = 0; continue; }
        if (trow >= 0 && colTile[x] >= 0) {
          const ti = trow + colTile[x];
          if (ti !== lastTi) { tile = this.tiles.get(ti) || null; lastTi = ti; }
          if (tile) { ids[row + x] = tile[toff + colOff[x]]; continue; }
        }
        ids[row + x] = over[orow + cx];
      }
    }

    // colors + borders
    const colors = this.colors, dist = this.dist, hl = this.highlightDistrict;
    const thick = dpr >= 1.25 ? 2 : 1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const id = ids[row + x];
        if (id === 0) {
          // state outline: an outside pixel right next to an inside one
          const l = x > 0 ? ids[row + x - 1] : 0, up = y > 0 ? ids[row - W + x] : 0;
          pix[row + x] = l || up ? ink : bg;
          continue;
        }
        const u = id - 1;
        let c = colors ? colors[u] : empty;
        if (dist) {
          const d = dist[u];
          let edge = false;
          for (let t = 1; t <= thick && !edge; t++) {
            if (x >= t) { const j = ids[row + x - t]; if (j === 0 || dist[j - 1] !== d) edge = true; }
            if (y >= t) { const j = ids[row - t * W + x]; if (j === 0 || dist[j - 1] !== d) edge = true; }
          }
          if (edge) c = ink;
          else if (hl >= 0 && d !== hl) c = (((c & 0xfefefe) >>> 1) + ((bg & 0xfefefe) >>> 1)) | 0xff000000;
        } else if ((x > 0 && ids[row + x - 1] === 0) || (y > 0 && ids[row - W + x] === 0)) c = ink;
        pix[row + x] = c >>> 0;
      }
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(this.image, 0, 0);

    // labels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.labels.length) {
      const inkCss = css.getPropertyValue("--map-ink").trim() || "#141414";
      const bgCss = css.getPropertyValue("--map-bg").trim() || "#fff";
      ctx.font = "700 11px " + (css.getPropertyValue("--mono").trim() || "monospace");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const placed = [];
      for (const lb of this.labels) {
        const p = this.toScreen(lb.x, lb.y);
        if (p.x < -20 || p.y < -20 || p.x > this.w + 20 || p.y > this.h + 20) continue;
        const t = String(lb.text);
        const w = ctx.measureText(t).width + 8;
        // skip labels that would overlap one already drawn (zoom in to see them)
        const box = [p.x - w / 2 - 2, p.y - 10, p.x + w / 2 + 2, p.y + 10];
        if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
        placed.push(box);
        ctx.fillStyle = bgCss; ctx.strokeStyle = inkCss; ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(p.x - w / 2, p.y - 8, w, 16, 8); else ctx.rect(p.x - w / 2, p.y - 8, w, 16);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = inkCss;
        ctx.fillText(t, p.x, p.y + 0.5);
      }
    }
  };

  RedistrictMap.prototype.blockAt = function (px, py) {
    const w = this.toWorld(px, py);
    return this._idAt(w.x, w.y, this._useDetail()) - 1;
  };

  RedistrictMap.prototype.zoomAt = function (px, py, factor) {
    const before = this.toWorld(px, py);
    // stop when a detail pixel is ~6 screen pixels wide
    const maxScale = 6 / (this.baseScale * this.px0 / this.detailScale);
    this.view.scale = Math.max(1, Math.min(maxScale, this.view.scale * factor));
    const after = this.toWorld(px, py);
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
    if (this.view.scale === 1) { const bb = this.bbox; this.view.cx = (bb[0] + bb[2]) / 2; this.view.cy = (bb[1] + bb[3]) / 2; }
    this.draw();
  };
  RedistrictMap.prototype.resetView = function () {
    const bb = this.bbox;
    this.view = { cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, scale: 1 };
    this.draw();
  };

  RedistrictMap.prototype._bind = function () {
    const self = this, c = this.canvas;
    let drag = null, pinch = null;
    const pointers = new Map();
    c.addEventListener("wheel", function (e) {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      self.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    c.addEventListener("pointerdown", function (e) {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false };
      if (pointers.size === 2) {
        const p = Array.from(pointers.values());
        pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
        drag = null;
      }
    });
    c.addEventListener("pointermove", function (e) {
      const r = c.getBoundingClientRect();
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const p = Array.from(pointers.values());
        const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        self.zoomAt((p[0].x + p[1].x) / 2 - r.left, (p[0].y + p[1].y) / 2 - r.top, d / pinch.d);
        pinch.d = d;
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        if (drag.moved) {
          const s = self.baseScale * self.view.scale;
          self.view.cx -= dx / s; self.view.cy += dy / s;
          drag.x = e.clientX; drag.y = e.clientY;
          self.draw();
          return;
        }
      }
      if (e.pointerType === "mouse") self._hoverAt(e.clientX - r.left, e.clientY - r.top);
    });
    function end(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && e.type === "pointerup") {
        const r = c.getBoundingClientRect();
        self._hoverAt(e.clientX - r.left, e.clientY - r.top);
      }
      if (pointers.size === 0) drag = null;
    }
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", function () {
      self.hover = -1;
      if (self.opts.onHover) self.opts.onHover(-1);
    });
    if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); }).observe(c);
  };
  RedistrictMap.prototype._hoverAt = function (x, y) {
    const u = this.blockAt(x, y);
    this.hover = u;
    if (this.opts.onHover) this.opts.onHover(u, x, y);
  };

  root.RedistrictMap = RedistrictMap;
})(window);
