'use strict';
// Compositor's brush and eraser, ported from its GPU engine (upstream Document/BrushStroke.swift and
// Rendering/MetalBrushCoverage.swift; the full derivation with line references is docs/port-specs/brush.md).
//
// A stroke is a polyline in document pixels: a sliding window of four samples, the settled piece between the middle
// two drawn as a centripetal Catmull-Rom split into chords within 0.2 px, plus a straight provisional tail to the
// newest sample that only previews. Coverage is analytic per pixel of the target's own grid: the maximum over the
// stroke for hard tips, and accumulated optical density (the continuous form of soft dabs every 2.5 % of the
// diameter) for soft ones. Each update rebuilds the touched 256 px tiles from the original pixels and applies the
// whole stroke once at its opacity, so overlaps never exceed it.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Affine, Rect, Transform } = CB;

    const TILE = 256;
    const MAX_SIDE = 30000;
    const E25 = Math.exp(-2.5);
    const NORM = 1 - E25;
    const GL_N = [0.1834346425, 0.5255324099, 0.7966664774, 0.9602898565];
    const GL_W = [0.3626837834, 0.3137066459, 0.2223810345, 0.1012285363];
    const LUT_SIZE = 16384;

    const DEFAULTS = { diameter: 40, hardness: 1, opacity: 1, smoothing: 0 };

    function spacingFraction(hardness) {
        return hardness >= 1 ? 0.015 : 0.025;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Path: BrushStroke.appendContinuous / flushContinuous / continuousCurve

    function segment(a, b) {
        return [a.x, a.y, b.x, b.y];
    }

    function continuousCurve(start, end, before, after) {
        const knot = (t, a, b) => t + Math.max(0.0001, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
        const mix = (a, b, ta, tb, t) => {
            const wa = (tb - t) / (tb - ta), wb = (t - ta) / (tb - ta);
            return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb };
        };
        const t0 = 0, t1 = knot(t0, before, start), t2 = knot(t1, start, end), t3 = knot(t2, end, after);
        const point = (u) => {
            if (u === 0) return start;
            if (u === 1) return end;
            const t = t1 + (t2 - t1) * u;
            const a = mix(before, start, t0, t1, t), b = mix(start, end, t1, t2, t), c = mix(end, after, t2, t3, t);
            return mix(mix(a, b, t0, t2, t), mix(b, c, t1, t3, t), t1, t2, t);
        };
        const result = [];
        const subdivide = (a, b, lo, hi, depth) => {
            const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
            const error = (p) => {
                const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
                return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
            };
            const mid = (lo + hi) / 2, m = point(mid);
            const deviation = Math.max(error(m), error(point((lo + mid) / 2)), error(point((mid + hi) / 2)));
            if (deviation <= 0.2 || depth >= 10) {
                result.push(segment(a, b));
                return;
            }
            subdivide(a, m, lo, mid, depth + 1);
            subdivide(m, b, mid, hi, depth + 1);
        };
        subdivide(start, end, 0, 1, 0);
        return result;
    }

    class BrushPath {
        constructor() {
            this.samples = [];
        }

        // { settled, tail } for a new sample, or null when it adds nothing (non-finite, or a repeat of the last).
        append(point) {
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e7 || Math.abs(point.y) > 1e7) return null;
            const last = this.samples[this.samples.length - 1];
            if (last && last.x === point.x && last.y === point.y) return null;
            this.samples.push({ x: point.x, y: point.y });
            if (this.samples.length > 4) this.samples.shift();
            const s = this.samples, n = s.length;
            let settled = [];
            if (n === 1) settled = [segment(point, point)];
            else if (n >= 3) settled = continuousCurve(s[n - 3], s[n - 2], s[Math.max(0, n - 4)], point);
            const tail = n >= 2 ? [segment(s[n - 2], point)] : [];
            return { settled, tail };
        }

        flush() {
            const s = this.samples, n = s.length;
            if (n < 2) return null;
            const settled = continuousCurve(s[n - 2], s[n - 1], s[Math.max(0, n - 3)], s[n - 1]);
            this.samples = [s[n - 1]];
            return { settled, tail: [] };
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Coverage: MetalBrushCoverage kernel

    function makeTip(settings, aa) {
        const r = settings.diameter / 2, h = settings.hardness;
        const tip = { r, r2: r * r, h, aa, spacing: Math.max(0.25, settings.diameter * spacingFraction(h)) };
        tip.cov = (d2) => {
            const d = Math.sqrt(d2);
            if (h >= 1) return Math.min(1, Math.max(0, (r - d) / aa + 0.5));
            const t = Math.min(1, Math.max(0, (d / r - h) / (1 - h)));
            return Math.max(0, (Math.exp(-2.5 * t * t) - E25) / NORM);
        };
        if (h < 1) {
            // tipDensity depends only on d^2 / r^2 and the hardness, so it is tabulated over q = d^2 / r^2 in [0, 1];
            // beyond the rim it is 0. Errors only show where the coverage is saturated anyway.
            const table = new Float64Array(LUT_SIZE + 1);
            for (let i = 0; i <= LUT_SIZE; i++) table[i] = -Math.log(Math.max(1 - tip.cov((i / LUT_SIZE) * tip.r2), 0.001));
            tip.density = (d2) => {
                const q = (d2 / tip.r2) * LUT_SIZE;
                if (q >= LUT_SIZE) return 0;
                const i = q | 0, f = q - i;
                return table[i] + (table[i + 1] - table[i]) * f;
            };
        }
        return tip;
    }

    function segDist2(px, py, g) {
        const vx = g[2] - g[0], vy = g[3] - g[1];
        const t = Math.min(1, Math.max(0, ((px - g[0]) * vx + (py - g[1]) * vy) / Math.max(vx * vx + vy * vy, 1e-12)));
        const dx = px - (g[0] + t * vx), dy = py - (g[1] + t * vy);
        return dx * dx + dy * dy;
    }

    function segDensity(px, py, g, tip) {
        const vx = g[2] - g[0], vy = g[3] - g[1], len = Math.hypot(vx, vy);
        if (len < 1e-6) {
            const dx = px - g[0], dy = py - g[1];
            return tip.density(dx * dx + dy * dy); // the initial click: one tip, not divided by spacing
        }
        const ux = vx / len, uy = vy / len, proj = (px - g[0]) * ux + (py - g[1]) * uy;
        const qx = px - g[0] - proj * ux, qy = py - g[1] - proj * uy, perp2 = qx * qx + qy * qy;
        if (perp2 >= tip.r2) return 0;
        const reach = Math.sqrt(tip.r2 - perp2), lo = Math.max(0, proj - reach), hi = Math.min(len, proj + reach);
        if (hi <= lo) return 0;
        const mid = (lo + hi) / 2, half = (hi - lo) / 2;
        let sum = 0;
        for (let i = 0; i < 4; i++) {
            const a = mid - half * GL_N[i] - proj, b = mid + half * GL_N[i] - proj;
            sum += GL_W[i] * (tip.density(perp2 + a * a) + tip.density(perp2 + b * b));
        }
        return (sum * half) / tip.spacing;
    }

    // Per-stroke coverage over the target's grid, kept in lazily allocated 256 px tiles as upstream does.
    class CoverageField {
        constructor({ M, gridWidth, gridHeight, docWidth, docHeight, tip }) {
            this.M = M;
            this.Minv = Affine.invert(M);
            this.gridWidth = gridWidth;
            this.gridHeight = gridHeight;
            this.docWidth = docWidth;
            this.docHeight = docHeight;
            this.tip = tip;
            this.columns = Math.ceil(gridWidth / TILE);
            this.tiles = new Map();
            this.prevTail = { keys: new Set(), rect: null };
            // Hard tips on layers scaled up past 4x reach beyond the tile selection margin; evaluate whole tiles then.
            this.wholeTiles = tip.h >= 1 && tip.aa / 2 > 2;
        }

        // continuousKeys: each segment's bounds, inflated by r + 2 document pixels, clipped to the canvas, mapped to
        // the grid (.integral), clipped to the grid. Returns the grid rect and the tile keys covering it.
        regionFor(segments) {
            let rect = null;
            const reach = this.tip.r + 2;
            const canvas = { x: 0, y: 0, width: this.docWidth, height: this.docHeight };
            const grid = { x: 0, y: 0, width: this.gridWidth, height: this.gridHeight };
            const keys = new Set();
            for (const g of segments) {
                const box = Rect.inflate({
                    x: Math.min(g[0], g[2]), y: Math.min(g[1], g[3]),
                    width: Math.abs(g[2] - g[0]), height: Math.abs(g[3] - g[1]),
                }, reach);
                const onCanvas = Rect.intersect(box, canvas);
                if (!onCanvas) continue;
                const inGrid = Rect.intersect(Rect.integral(Affine.boundsOf(this.Minv, onCanvas)), grid);
                if (!inGrid) continue;
                rect = Rect.union(rect, inGrid);
                const tx0 = Math.floor(inGrid.x / TILE), ty0 = Math.floor(inGrid.y / TILE);
                const tx1 = Math.floor((inGrid.x + inGrid.width - 1) / TILE), ty1 = Math.floor((inGrid.y + inGrid.height - 1) / TILE);
                for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) keys.add(ty * this.columns + tx);
            }
            return { rect, keys };
        }

        tileRect(key) {
            const tx = key % this.columns, ty = Math.floor(key / this.columns);
            const x = tx * TILE, y = ty * TILE;
            return { x, y, width: Math.min(TILE, this.gridWidth - x), height: Math.min(TILE, this.gridHeight - y) };
        }

        // Evaluates the kernel for one update; returns the keys of the tiles whose coverage may have changed.
        render(settled, tail, allocate) {
            const s = this.regionFor(settled), t = this.regionFor(tail);
            const keys = new Set([...s.keys, ...t.keys, ...this.prevTail.keys]);
            const region = Rect.union(Rect.union(s.rect, t.rect), this.prevTail.rect);
            this.prevTail = t;
            if (!region) return keys;
            const { M, tip, docWidth, docHeight } = this;
            for (const key of keys) {
                let tile = this.tiles.get(key);
                if (!tile) {
                    const rect = this.tileRect(key);
                    tile = { key, ...rect, perm: new Float32Array(rect.width * rect.height), cov: new Uint8Array(rect.width * rect.height) };
                    allocate(tile);
                    this.tiles.set(key, tile);
                }
                const area = this.wholeTiles ? tile : Rect.intersect(tile, region);
                if (!area) continue;
                for (let y = area.y; y < area.y + area.height; y++) {
                    const gy = y + 0.5;
                    for (let x = area.x; x < area.x + area.width; x++) {
                        const gx = x + 0.5;
                        const px = M.a * gx + M.c * gy + M.e, py = M.b * gx + M.d * gy + M.f;
                        const i = (y - tile.y) * tile.width + (x - tile.x);
                        if (px < 0 || py < 0 || px >= docWidth || py >= docHeight) {
                            tile.cov[i] = 0;
                            continue;
                        }
                        if (tip.h >= 1) {
                            let ds = Infinity, dt = Infinity;
                            for (const g of settled) ds = Math.min(ds, segDist2(px, py, g));
                            for (const g of tail) dt = Math.min(dt, segDist2(px, py, g));
                            const v = Math.max(tile.perm[i], tip.cov(ds));
                            tile.perm[i] = v;
                            tile.cov[i] = Math.round(255 * Math.max(v, tip.cov(dt)));
                        } else {
                            let v = tile.perm[i], d = 0;
                            for (const g of settled) v += segDensity(px, py, g, tip);
                            for (const g of tail) d += segDensity(px, py, g, tip);
                            tile.perm[i] = Math.min(v, 20);
                            tile.cov[i] = Math.round(255 * (1 - Math.exp(-Math.min(v + d, 20))));
                        }
                    }
                }
            }
            return keys;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // A stroke on one pixel layer: grid, pixels, display and commit (BrushStroke.init, publish, paintSnapshot).

    function canvas2d(width, height) {
        const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
        return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: false }) };
    }

    class PaintStroke {
        // layer: { transform (CB.Transform.read form), image: canvas|null }; settings: { diameter, hardness, opacity,
        // color: [r, g, b] in 0..1, erasing }; pixelBudget: pixels this layer may grow to.
        // `selection`: a CB.Selection.clip in document pixels, or null for none.
        // `mask`: { white, background } to paint a layer mask (brush.md 11): `layer.image` is then the mask as an alpha
        // picture (alpha = mask value) in the grid it is painted in; white is laid over with the coverage, black taken
        // out with it, which is M' = G·a + M·(1 − a); new area starts at `background` (0 or 1).
        constructor({ layer, docWidth, docHeight, settings, pixelBudget = 100000000, budgetMegapixels = 200, selection = null, mask = null }) {
            const base = layer.transform;
            const image = layer.image;
            const originalWidth = image ? image.width : Math.max(1, Math.round(base.width));
            const originalHeight = image ? image.height : Math.max(1, Math.round(base.height));
            const originalMapping = Transform.pixelToDocument(base, originalWidth, originalHeight);
            const originalBounds = { x: 0, y: 0, width: originalWidth, height: originalHeight };
            const canvasInGrid = Rect.integral(Affine.boundsOf(Affine.invert(originalMapping), { x: 0, y: 0, width: docWidth, height: docHeight }));
            const extent = Rect.union(originalBounds, canvasInGrid);

            this.settings = { ...settings };
            this.mask = mask;
            if (mask) {
                this.settings.erasing = !mask.white;
                this.settings.color = [1, 1, 1];
            }
            this.docWidth = docWidth;
            this.docHeight = docHeight;
            this.width = extent.width;
            this.height = extent.height;
            this.hasSource = Boolean(image);
            this.sourceRect = { x: -extent.x, y: -extent.y, width: originalWidth, height: originalHeight };
            this.M = Affine.translate(originalMapping, extent.x, extent.y);
            this.pixelBudget = pixelBudget;
            this.budgetMegapixels = budgetMegapixels;
            const expanded = { ...base };
            expanded.width = (this.width * base.width) / originalWidth;
            expanded.height = (this.height * base.height) / originalHeight;
            const c = Affine.apply(originalMapping, extent.x + extent.width / 2, extent.y + extent.height / 2);
            expanded.x = c.x - expanded.width / 2;
            expanded.y = c.y - expanded.height / 2;
            this.paintTransform = expanded;

            const aa = Math.max(0.001, Math.min(Math.hypot(this.M.a, this.M.b), Math.hypot(this.M.c, this.M.d)));
            this.field = new CoverageField({
                M: this.M, gridWidth: this.width, gridHeight: this.height, docWidth, docHeight, tip: makeTip(settings, aa),
            });
            this.path = new BrushPath();
            this.work = null;
            if (image) {
                this.growWork(this.sourceRect);
                this.work.ctx.clearRect(this.sourceRect.x - this.work.x, this.sourceRect.y - this.work.y, this.sourceRect.width, this.sourceRect.height);
                this.work.ctx.drawImage(image, this.sourceRect.x - this.work.x, this.sourceRect.y - this.work.y);
            }
            this.allocated = this.hasSource ? { ...this.sourceRect } : null;
            const rgb = settings.color.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
            this.stamp = new ImageData(TILE, TILE);
            for (let i = 0; i < this.stamp.data.length; i += 4) {
                this.stamp.data[i] = rgb[0]; this.stamp.data[i + 1] = rgb[1]; this.stamp.data[i + 2] = rgb[2];
            }
            this.scratch = canvas2d(TILE, TILE);
            this.changed = false;
            this.selection = selection;
        }

        // The working canvas covers the source pixels and every allocated tile, in grid coordinates.
        growWork(rect) {
            const want = this.work ? Rect.union(this.work, rect) : { ...rect };
            if (this.work && Rect.equal(want, this.work)) return;
            if (want.width > MAX_SIDE || want.height > MAX_SIDE || want.width * want.height > this.pixelBudget) {
                // ProjectError.tooLarge (IO/ProjectStore.swift:76).
                const error = new Error(`This project exceeds the supported canvas, layer, file-size, or ${this.budgetMegapixels}-megapixel document limit.`);
                error.code = 'TOO_LARGE';
                throw error;
            }
            const next = canvas2d(want.width, want.height);
            if (this.mask && this.mask.background) {
                // A mask grows into its background tone: opaque where it is white.
                next.ctx.fillStyle = '#fff';
                next.ctx.fillRect(0, 0, want.width, want.height);
                if (this.work) next.ctx.clearRect(this.work.x - want.x, this.work.y - want.y, this.work.width, this.work.height);
            }
            if (this.work) next.ctx.drawImage(this.work.canvas, this.work.x - want.x, this.work.y - want.y);
            this.work = { ...want, canvas: next.canvas, ctx: next.ctx };
        }

        append(point) {
            const pieces = this.path.append(point);
            if (pieces) this.render(pieces);
        }

        flush() {
            const pieces = this.path.flush();
            if (pieces) this.render(pieces);
        }

        render({ settled, tail }) {
            const keys = this.field.render(settled, tail, (tile) => this.allocate(tile));
            for (const key of keys) {
                const tile = this.field.tiles.get(key);
                this.publish(tile);
                // What changed since the board last showed the stroke, for live layer effects (LayerEffectsSurface).
                this.unshown = Rect.union(this.unshown || null, { x: tile.x, y: tile.y, width: tile.width, height: tile.height });
            }
            if (keys.size) this.changed = true;
        }

        allocate(tile) {
            this.growWork(tile);
            this.allocated = Rect.union(this.allocated, tile);
            const base = canvas2d(tile.width, tile.height);
            base.ctx.drawImage(this.work.canvas, tile.x - this.work.x, tile.y - this.work.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
            tile.base = base.canvas;
            // The selection's coverage at each grid pixel's centre, multiplied into the stroke (SelectionClip.apply).
            if (this.selection) {
                const sel = new Uint8Array(tile.width * tile.height), M = this.M;
                for (let y = 0; y < tile.height; y++) {
                    for (let x = 0; x < tile.width; x++) {
                        const gx = tile.x + x + 0.5, gy = tile.y + y + 0.5;
                        sel[y * tile.width + x] = Math.round(255 * CB.Selection.coverageAt(this.selection, M.a * gx + M.c * gy + M.e, M.b * gx + M.d * gy + M.f));
                    }
                }
                tile.sel = sel;
            }
        }

        // The tile from its original pixels, then the stroke's color through its coverage at the stroke's opacity.
        publish(tile) {
            const data = this.stamp.data;
            for (let i = 0, n = tile.width * tile.height; i < n; i++) {
                const x = i % tile.width, y = (i / tile.width) | 0;
                data[(y * TILE + x) * 4 + 3] = tile.sel ? Math.round((tile.cov[i] * tile.sel[i]) / 255) : tile.cov[i];
            }
            this.scratch.ctx.putImageData(this.stamp, 0, 0, 0, 0, tile.width, tile.height);
            const ctx = this.work.ctx, dx = tile.x - this.work.x, dy = tile.y - this.work.y;
            ctx.save();
            ctx.clearRect(dx, dy, tile.width, tile.height);
            ctx.drawImage(tile.base, dx, dy);
            ctx.globalAlpha = this.settings.opacity;
            ctx.globalCompositeOperation = this.settings.erasing ? 'destination-out' : 'source-over';
            ctx.drawImage(this.scratch.canvas, 0, 0, tile.width, tile.height, dx, dy, tile.width, tile.height);
            ctx.restore();
        }

        // What the board draws for this layer while the stroke is in progress.
        // `liveDirty`: the tiles changed since the last display, and `sourceRect`: the layer's own pixels, both in the
        // working canvas's coordinates, so layer effects can follow the paint (media/effects.js liveEffects).
        display() {
            if (!this.work) return null;
            const dirty = this.unshown;
            this.unshown = null;
            const at = (r) => r && { x: r.x - this.work.x, y: r.y - this.work.y, width: r.width, height: r.height };
            return {
                canvas: this.work.canvas, toDocument: Affine.translate(this.M, this.work.x, this.work.y),
                liveDirty: at(dirty) || { x: 0, y: 0, width: 0, height: 0 }, sourceRect: this.hasSource ? at(this.sourceRect) : null,
            };
        }

        transformFor(bounds) {
            const c = Affine.apply(this.M, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            const t = { ...this.paintTransform };
            t.width = (bounds.width * this.paintTransform.width) / this.width;
            t.height = (bounds.height * this.paintTransform.height) / this.height;
            t.x = c.x - t.width / 2;
            t.y = c.y - t.height / 2;
            return t;
        }

        alphaBounds() {
            let bounds = null;
            for (const tile of this.field.tiles.values()) {
                const pixels = this.work.ctx.getImageData(tile.x - this.work.x, tile.y - this.work.y, tile.width, tile.height).data;
                let left = tile.width, right = 0, top = tile.height, bottom = 0;
                for (let y = 0; y < tile.height; y++) {
                    let first = 0;
                    const row = y * tile.width * 4;
                    while (first < tile.width && pixels[row + first * 4 + 3] === 0) first++;
                    if (first === tile.width) continue;
                    let last = tile.width;
                    while (last > first && pixels[row + (last - 1) * 4 + 3] === 0) last--;
                    left = Math.min(left, first);
                    right = Math.max(right, last);
                    top = Math.min(top, y);
                    bottom = y + 1;
                }
                if (right > left && bottom > top) {
                    bounds = Rect.union(bounds, { x: tile.x + left, y: tile.y + top, width: right - left, height: bottom - top });
                }
            }
            return bounds;
        }

        // The finished stroke: null if it changed nothing, else either tile patches inside the unchanged layer bounds
        // ({ grew: false, patches }) or a whole new image and transform ({ grew: true, image, transform, crop }).
        commit() {
            if (!this.changed || !this.field.tiles.size) return null;
            if (this.mask) {
                // A mask keeps every allocated tile: it grows in whole 256 px tiles (brush.md 12.3).
                const crop = Rect.integral(this.allocated);
                const image = canvas2d(crop.width, crop.height);
                if (this.mask.background) {
                    image.ctx.fillStyle = '#fff';
                    image.ctx.fillRect(0, 0, crop.width, crop.height);
                    image.ctx.clearRect(this.work.x - crop.x, this.work.y - crop.y, this.work.width, this.work.height);
                }
                image.ctx.drawImage(this.work.canvas, this.work.x - crop.x, this.work.y - crop.y);
                return { mask: true, grew: !Rect.equal(crop, this.sourceRect), image: image.canvas, transform: this.transformFor(crop), crop };
            }
            const painted = this.alphaBounds();
            let crop = this.hasSource ? Rect.union(this.sourceRect, painted) : painted;
            if (!crop) crop = Rect.integral(this.allocated);
            if (this.hasSource && Rect.equal(crop, this.sourceRect)) {
                const patches = [];
                for (const tile of this.field.tiles.values()) {
                    const inside = Rect.intersect(tile, this.sourceRect);
                    if (!inside) continue;
                    const before = canvas2d(inside.width, inside.height), after = canvas2d(inside.width, inside.height);
                    before.ctx.drawImage(tile.base, inside.x - tile.x, inside.y - tile.y, inside.width, inside.height, 0, 0, inside.width, inside.height);
                    after.ctx.drawImage(this.work.canvas, inside.x - this.work.x, inside.y - this.work.y, inside.width, inside.height, 0, 0, inside.width, inside.height);
                    patches.push({
                        rect: { x: inside.x - this.sourceRect.x, y: inside.y - this.sourceRect.y, width: inside.width, height: inside.height },
                        before: before.canvas, after: after.canvas,
                    });
                }
                return { grew: false, patches };
            }
            const image = canvas2d(crop.width, crop.height);
            image.ctx.drawImage(this.work.canvas, this.work.x - crop.x, this.work.y - crop.y);
            return { grew: true, image: image.canvas, transform: this.transformFor(crop), crop, sourceRect: this.sourceRect, hadSource: this.hasSource };
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Controls (EditorSession+Brush.swift)

    // The lazy string: no sample until the pointer is further than `radius` document pixels from the anchor, which then
    // moves along the pointer direction to exactly `radius` behind it.
    function smoothed(anchor, point, smoothing, zoomDevicePixels) {
        if (!smoothing || !anchor) return { point, anchor: point };
        const radius = smoothing / Math.max(0.01, zoomDevicePixels);
        const dx = point.x - anchor.x, dy = point.y - anchor.y, distance = Math.hypot(dx, dy);
        if (distance <= radius) return { point: null, anchor };
        const step = (distance - radius) / distance;
        const moved = { x: anchor.x + dx * step, y: anchor.y + dy * step };
        return { point: moved, anchor: moved };
    }

    // Swift's .rounded() rounds half away from zero; Math.round rounds half up, which differs only below zero.
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

    function stepDiameter(current, increase) {
        const stepped = increase ? Math.max(current + 1, roundHalfAway(current * 1.2)) : Math.min(current - 1, roundHalfAway(current / 1.2));
        return Math.min(2000, Math.max(1, stepped));
    }

    function stepHardness(current, increase) {
        const quarter = current * 4;
        const step = increase ? Math.floor(quarter + 0.001) + 1 : Math.ceil(quarter - 0.001) - 1;
        return Math.min(4, Math.max(0, step)) / 4;
    }

    // Opacity keys: a digit sets 10-90 % (0 is 100 %); a second digit within 0.6 s makes a two-digit value.
    function opacityDigit(pending, digit, now) {
        if (pending && now - pending.time < 600) return { percent: Math.max(1, pending.digit * 10 + digit), pending: null };
        return { percent: digit === 0 ? 100 : digit * 10, pending: { digit, time: now } };
    }

    CB.Brush = {
        TILE, DEFAULTS, spacingFraction, continuousCurve, BrushPath, makeTip, segDist2, segDensity, CoverageField, PaintStroke,
        smoothed, stepDiameter, stepHardness, opacityDigit,
    };
})();
