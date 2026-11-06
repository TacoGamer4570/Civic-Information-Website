/* Canvas map for the redistricting simulator.
 * Draws precincts filled by district (or by vote), district borders, the state
 * outline, and district number labels. Supports wheel/pinch zoom, drag pan,
 * and hover lookup through an offscreen "pick" canvas.
 */
(function (root) {
  "use strict";

  function decodeArcs(geo) {
    // arcs are delta-encoded [x0, y0, dx, dy, ...] in units of geo.q meters
    return geo.arcs.map(function (a) {
      const out = new Float64Array(a.length);
      let x = 0, y = 0;
      for (let i = 0; i < a.length; i += 2) {
        x += a[i]; y += a[i + 1];
        out[i] = x; out[i + 1] = y;
      }
      return out;
    });
  }

  function RedistrictMap(canvas, data, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = data;
    this.opts = opts || {};
    this.arcs = decodeArcs(data.geo);
    this.n = data.n;
    const bb = data.geo.bbox;
    this.bbox = bb;
    this.view = { cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, scale: 1 };
    this.assign = null;
    this.fillFn = null;
    this.labels = [];
    this.hover = -1;
    this.highlightDistrict = -1;
    this.pick = document.createElement("canvas");
    this.pickCtx = this.pick.getContext("2d", { willReadFrequently: true });
    this.pickDirty = true;
    this._buildPaths();
    this._bind();
    this.resize();
  }

  RedistrictMap.prototype._buildPaths = function () {
    // Precinct polygons as Path2D in data units (y flipped when drawn).
    const arcs = this.arcs;
    this.paths = this.data.geo.polys.map(function (poly) {
      const p = new Path2D();
      for (const part of poly) {
        for (const ring of part) {
          let first = true;
          for (const ref of ring) {
            const a = arcs[ref >= 0 ? ref : ~ref];
            const m = a.length / 2;
            for (let k = 0; k < m; k++) {
              const idx = ref >= 0 ? k : m - 1 - k;
              if (!first && k === 0) continue;
              const x = a[2 * idx], y = a[2 * idx + 1];
              if (first) { p.moveTo(x, y); first = false; } else p.lineTo(x, y);
            }
          }
          p.closePath();
        }
      }
      return p;
    });
    // Outline (state border) as one path; inner arcs are drawn per frame.
    const L = this.data.geo.left, R = this.data.geo.right;
    const outline = new Path2D();
    this.arcPaths = arcs.map(function (a, i) {
      const p = new Path2D();
      p.moveTo(a[0], a[1]);
      for (let k = 2; k < a.length; k += 2) p.lineTo(a[k], a[k + 1]);
      if (R[i] === -1 || L[i] === -1) outline.addPath(p); // -2 = interior gap, not drawn
      return p;
    });
    this.outline = outline;
  };

  RedistrictMap.prototype.resize = function () {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.pick.width = Math.round(this.w);
    this.pick.height = Math.round(this.h);
    const bb = this.bbox;
    this.baseScale = Math.min(this.w / (bb[2] - bb[0]), this.h / (bb[3] - bb[1])) * 0.94;
    this.pickDirty = true;
    this.draw();
  };

  RedistrictMap.prototype._transform = function (ctx, dpr) {
    const s = this.baseScale * this.view.scale;
    ctx.setTransform(s * dpr, 0, 0, -s * dpr, (this.w / 2 - this.view.cx * s) * dpr, (this.h / 2 + this.view.cy * s) * dpr);
    return s;
  };
  RedistrictMap.prototype.toData = function (px, py) {
    const s = this.baseScale * this.view.scale;
    return { x: (px - this.w / 2) / s + this.view.cx, y: -(py - this.h / 2) / s + this.view.cy };
  };
  RedistrictMap.prototype.toScreen = function (x, y) {
    const s = this.baseScale * this.view.scale;
    return { x: (x - this.view.cx) * s + this.w / 2, y: -(y - this.view.cy) * s + this.h / 2 };
  };

  RedistrictMap.prototype.setPlan = function (assign, fillFn, labels) {
    this.assign = assign;
    this.fillFn = fillFn;
    this.labels = labels || [];
    this.draw();
  };

  // full=true re-renders the precinct layer; otherwise only overlays change.
  RedistrictMap.prototype.draw = function (overlayOnly) {
    if (!overlayOnly) this.baseDirty = true;
    if (this._raf) return;
    const self = this;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._draw(); });
  };

  RedistrictMap.prototype._draw = function () {
    const dpr = this.dpr;
    const css = getComputedStyle(this.canvas);
    if (!this.base) { this.base = document.createElement("canvas"); this.baseCtx = this.base.getContext("2d"); }
    if (this.base.width !== this.canvas.width || this.base.height !== this.canvas.height) {
      this.base.width = this.canvas.width; this.base.height = this.canvas.height; this.baseDirty = true;
    }
    if (this.baseDirty) { this._drawBase(this.baseCtx, css); this.baseDirty = false; this.pickDirty = true; }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    this._drawOverlay(ctx, css);
  };

  RedistrictMap.prototype._drawBase = function (ctx, css) {
    const dpr = this.dpr;
    const bg = css.getPropertyValue("--map-bg").trim() || "#fff";
    const ink = css.getPropertyValue("--map-ink").trim() || "#141414";
    const empty = css.getPropertyValue("--map-empty").trim() || "#ddd";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const s = this._transform(ctx, dpr);
    const px = 1 / s; // one CSS pixel in data units

    // fills: batch precincts by color
    const groups = new Map();
    for (let u = 0; u < this.n; u++) {
      const c = this.fillFn ? this.fillFn(u) : empty;
      let g = groups.get(c);
      if (!g) { g = []; groups.set(c, g); }
      g.push(u);
    }
    for (const [color, list] of groups) {
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = px * 0.6; // hides hairline seams between neighbors
      for (const u of list) { ctx.fill(this.paths[u]); ctx.stroke(this.paths[u]); }
    }

    const a = this.assign;
    const L = this.data.geo.left, R = this.data.geo.right;
    // faint precinct lines when zoomed in
    if (this.view.scale >= 6) {
      ctx.strokeStyle = css.getPropertyValue("--map-precinct").trim() || "rgba(0,0,0,.15)";
      ctx.lineWidth = px * 0.6;
      for (let i = 0; i < this.arcPaths.length; i++) if (L[i] >= 0 && R[i] >= 0) ctx.stroke(this.arcPaths[i]);
    }
    // district borders
    if (a) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = px * 1.6;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let i = 0; i < this.arcPaths.length; i++) {
        const l = L[i], r = R[i];
        if (l >= 0 && r >= 0 && a[l] !== a[r]) ctx.stroke(this.arcPaths[i]);
      }
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = px * 1.6;
    ctx.stroke(this.outline);
  };

  RedistrictMap.prototype._drawOverlay = function (ctx, css) {
    const dpr = this.dpr;
    const bg = css.getPropertyValue("--map-bg").trim() || "#fff";
    const ink = css.getPropertyValue("--map-ink").trim() || "#141414";
    const s = this._transform(ctx, dpr);
    const px = 1 / s;
    const a = this.assign;
    const L = this.data.geo.left, R = this.data.geo.right;
    // highlighted district / hovered precinct
    if (a && this.highlightDistrict >= 0) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = px * 3.5;
      for (let i = 0; i < this.arcPaths.length; i++) {
        const l = L[i], r = R[i];
        const inL = l >= 0 && a[l] === this.highlightDistrict, inR = r >= 0 && a[r] === this.highlightDistrict;
        if (inL !== inR) ctx.stroke(this.arcPaths[i]);
      }
    }
    if (this.hover >= 0) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = px * 2;
      ctx.stroke(this.paths[this.hover]);
    }

    // labels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.labels.length && this.opts.showLabels !== false) {
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
        ctx.fillStyle = bg;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(p.x - w / 2, p.y - 8, w, 16, 8); else ctx.rect(p.x - w / 2, p.y - 8, w, 16);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = ink;
        ctx.fillText(t, p.x, p.y + 0.5);
      }
    }
  };

  // Offscreen canvas where precinct u is painted in color u+1 for hit testing.
  RedistrictMap.prototype._drawPick = function () {
    const ctx = this.pickCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.pick.width, this.pick.height);
    ctx.imageSmoothingEnabled = false;
    this._transform(ctx, 1);
    for (let u = 0; u < this.n; u++) {
      const id = u + 1;
      ctx.fillStyle = "rgb(" + (id & 255) + "," + ((id >> 8) & 255) + "," + ((id >> 16) & 255) + ")";
      ctx.fill(this.paths[u]);
    }
    this.pickDirty = false;
  };
  RedistrictMap.prototype.precinctAt = function (px, py) {
    if (this.pickDirty) this._drawPick();
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= this.pick.width || y >= this.pick.height) return -1;
    const d = this.pickCtx.getImageData(x, y, 1, 1).data;
    if (d[3] < 255) return -1;
    return (d[0] | (d[1] << 8) | (d[2] << 16)) - 1;
  };

  RedistrictMap.prototype.zoomAt = function (px, py, factor) {
    const before = this.toData(px, py);
    this.view.scale = Math.max(1, Math.min(400, this.view.scale * factor));
    const after = this.toData(px, py);
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
    let drag = null;
    const pointers = new Map();
    let pinch = null;
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
      if (e.pointerType === "mouse") self._hoverAt(e.clientX - r.left, e.clientY - r.top, e);
    });
    function end(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && e.type === "pointerup") {
        const r = c.getBoundingClientRect();
        self._hoverAt(e.clientX - r.left, e.clientY - r.top, e, true);
      }
      if (pointers.size === 0) drag = null;
    }
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", function () {
      if (self.hover >= 0) { self.hover = -1; self.draw(true); }
      if (self.opts.onHover) self.opts.onHover(-1);
    });
    if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); }).observe(c);
  };
  RedistrictMap.prototype._hoverAt = function (x, y, e, isClick) {
    const u = this.precinctAt(x, y);
    if (u !== this.hover) {
      this.hover = u;
      this.draw(true);
    }
    if (this.opts.onHover) this.opts.onHover(u, x, y, isClick);
  };

  root.RedistrictMap = RedistrictMap;
})(window);
