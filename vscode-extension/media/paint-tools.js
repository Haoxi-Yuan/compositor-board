'use strict';
// Spot Healing, Clone Stamp, Smear (Blur, Smudge, Liquify) and Gradient (upstream Document/EditorSession+Brush.swift,
// BrushStroke.swift, CloneStamp.swift, BlurTool.swift, SmudgeLiquify.swift, Rendering/MetalWarp.swift, Gradient.swift,
// UI/BrushControls.swift, UI/GradientControls.swift). Each tool previews in the webview as Compositor draws it while
// the pointer moves, and commits through compositor-engine, which replays the stroke (or the gradient line) in
// Compositor's own EditorSession: Spot Healing's patch search, Clone Stamp's resampling, Blur's softening and the GPU
// warp kernels are Compositor's exactly. The preview stays on screen until the saved layer comes back. Specification:
// docs/port-specs/paint-tools.md (sections cited below).

(function () {
    const CB = (window.CB = window.CB || {});
    const { Affine, Rect, Transform, Brush, Selection } = CB;
    const TILE = Brush.TILE;
    const COULDNT = 'Couldn’t paint';
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));
    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const canvas2d = (w, h) => {
        const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
        return { canvas, ctx: canvas.getContext('2d') };
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Rail icons (1.1): SF Symbols bandage and drop drawn as lines, the custom CloneStampToolIcon and GradientToolIcon
    // in an 18 x 18 frame centered in the 24 x 24 icon box.

    const P = CB.iconPaths;
    P.bandage = '<rect x="2.6" y="8.2" width="18.8" height="7.6" rx="3.8" transform="rotate(-45 12 12)"/><rect x="8.6" y="8.2" width="6.8" height="7.6" transform="rotate(-45 12 12)"/>'
        + '<circle cx="11" cy="11" r=".5" fill="currentColor"/><circle cx="13" cy="13" r=".5" fill="currentColor"/><circle cx="13" cy="11" r=".5" fill="currentColor"/><circle cx="11" cy="13" r=".5" fill="currentColor"/>';
    P.drop = '<path d="M12 3.5c2.9 3.8 6 7.2 6 10.6a6 6 0 0 1-12 0c0-3.4 3.1-6.8 6-10.6z"/>';
    // CloneStampToolIcon (BrushControls.swift:138-151) for w = h = 18 at (3, 3).
    P.cloneStamp = '<g fill="currentColor" stroke="none"><ellipse cx="12" cy="6.06" rx="3.06" ry="2.7"/><rect x="10.74" y="8.04" width="2.52" height="5.04"/>'
        + '<rect x="5.16" y="12.72" width="13.68" height="3.96" rx="1.44"/><rect x="4.08" y="17.76" width="15.84" height="2.16"/></g>';
    // GradientToolIcon (GradientControls.swift:70-107): a 16 x 16 Floyd-Steinberg dither of x / 15, one dot per point in
    // the frame inset by 1, clipped to a rounded rect of radius 3.5 that is also stroked at 1.4.
    P.gradient = (() => {
        const size = 16, ramp = [], on = [];
        for (let y = 0; y < size; y++) { ramp.push([]); on.push([]); for (let x = 0; x < size; x++) ramp[y].push(x / (size - 1)); }
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const set = ramp[y][x] >= 0.5;
                on[y][x] = set;
                const error = ramp[y][x] - (set ? 1 : 0);
                if (x + 1 < size) ramp[y][x + 1] += (error * 7) / 16;
                if (y + 1 >= size) continue;
                if (x > 0) ramp[y + 1][x - 1] += (error * 3) / 16;
                ramp[y + 1][x] += (error * 5) / 16;
                if (x + 1 < size) ramp[y + 1][x + 1] += error / 16;
            }
        }
        // Frame (4, 4, 16, 16) in the 24 box; dots outside the rounded corners are clipped away.
        const inside = (cx, cy) => {
            const r = 3.5, lo = 4 + r, hi = 20 - r;
            const dx = cx < lo ? lo - cx : cx > hi ? cx - hi : 0, dy = cy < lo ? lo - cy : cy > hi ? cy - hi : 0;
            return dx * dx + dy * dy <= r * r;
        };
        let d = '';
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (on[y][x] && inside(4.5 + x, 4.5 + y)) d += `M${4 + x} ${4 + y}h1v1h-1z`;
        return `<path d="${d}" fill="currentColor" stroke="none"/><rect x="4" y="4" width="16" height="16" rx="3.5" stroke-width="1.4"/>`;
    })();

    // ---------------------------------------------------------------------------------------------------------------
    // Shared stroke plumbing

    // The pieces of a press every brush tool shares: nothing while an engine commit is in flight (a press waits while
    // isProjectBusy upstream), and the "Couldn’t paint" alert when the target cannot be painted (1.5).
    function paintTarget(board) {
        if (board.working) return null;
        const record = board.activeLayer();
        const refusal = board.paintRefusal(record);
        if (refusal) {
            board.alert(COULDNT, refusal);
            return null;
        }
        return record;
    }

    function strokeSettings(board, extra = {}) {
        return { ...board.brush, color: board.colors.fg, erasing: false, ...extra };
    }

    // A PaintStroke over the active layer's pixels (or, with `mask`, a maskStrokeTarget's alpha picture).
    function makeStroke(board, record, settings, mask, Kind = Brush.PaintStroke, extra) {
        const entry = board.doc.entry(record.id);
        const sel = board.selection;
        return new Kind({
            layer: mask ? mask.layer : { transform: Transform.read(record.transform, [board.doc.width, board.doc.height]), image: entry.image },
            docWidth: board.doc.width, docHeight: board.doc.height, settings, pixelBudget: board.pixelBudget(record.id),
            budgetMegapixels: Math.round(board.documentPixelBudget() / 1e6),
            selection: sel ? Selection.clip(sel, board.doc.width, board.doc.height) : null,
            mask: mask ? { white: board.maskPaintWhite, background: mask.background } : null,
        }, extra);
    }

    // The arguments every paint.stroke carries besides the tool's own (section 8.1).
    function strokeArgs(board) {
        const b = board.brush;
        return {
            diameter: b.diameter, hardness: b.hardness, opacity: b.opacity, smoothing: b.smoothing, blurRadius: board.blurRadius,
            zoom: board.view.zoom, selection: board.selection, foreground: board.colors.fg, background: board.colors.bg,
        };
    }

    // Commits a finished stroke through compositor-engine (8.6): the preview stays until the saved layer has been
    // read back (the extension reloads it before the answer arrives), then goes; a refusal or error shows the alert.
    async function engineStroke(board, drag, args) {
        const id = drag.layerID;
        board.endLive();
        const shown = board.renderer.overrides.get(id);
        const points = drag.points.map((p) => [p.x, p.y]);
        let result = null;
        try {
            result = await board.engine('paint.stroke', {
                ...strokeArgs(board), ...args, points, activeLayerID: id, selectedLayerIDs: [id], isMaskSelected: drag.isMask,
            }, { label: args.label || 'Brush Stroke' });
            if (result.error) board.alert(COULDNT, result.error);
        } catch (error) {
            board.alert(COULDNT, error.message);
        } finally {
            if (board.renderer.overrides.get(id) === shown) board.renderer.overrides.delete(id);
            board.changed();
        }
        return result;
    }

    // The start of a stroke that may be a Shift-click line: where EditorSession.beginBrush is called (the end of the
    // last stroke on the same layer and target), else the press.
    function strokeStart(board, record, doc, e, isMask) {
        const last = board.lastBrushPoint;
        return e.shiftKey && last && last.layerID === record.id && Boolean(last.mask) === isMask ? last.point : doc;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // A stroke that paints a sample through its coverage (Clone Stamp, Blur): BrushStroke.drawClone
    // (BrushStroke.swift:544-565). `sample`: { canvas, placed, inGrid } where `placed` is in the stroke's grid pixels
    // (inGrid) or in document pixels. Per tile: the original pixels, then the sample piece masked by the coverage
    // (times the selection) laid over at the stroke's opacity, source-over. On a mask (`lerp`) the gray grid takes
    // M' = S·k + M·(1 − k), which on the board's alpha picture is a destination-out of k and an additive S·k.

    class SampleStroke extends Brush.PaintStroke {
        constructor(options, { sample, lerp = false, clipToSource = false }) {
            super(options);
            this.sample = sample;
            this.lerp = lerp;
            this.clipToSource = clipToSource;
            this.piece = canvas2d(TILE, TILE);
        }

        publish(tile) {
            const data = this.stamp.data, src = this.sourceRect;
            for (let i = 0, n = tile.width * tile.height; i < n; i++) {
                const x = i % tile.width, y = (i / tile.width) | 0;
                let a = tile.sel ? Math.round((tile.cov[i] * tile.sel[i]) / 255) : tile.cov[i];
                // Blur on a mask stays inside the mask's own pixels (growsMask false, EditorSession+Brush.swift:70).
                if (this.clipToSource) {
                    const gx = tile.x + x, gy = tile.y + y;
                    if (gx < src.x || gy < src.y || gx >= src.x + src.width || gy >= src.y + src.height) a = 0;
                }
                data[(y * TILE + x) * 4 + 3] = a;
            }
            this.scratch.ctx.putImageData(this.stamp, 0, 0, 0, 0, tile.width, tile.height);
            const pc = this.piece.ctx, s = this.sample;
            pc.save();
            pc.setTransform(1, 0, 0, 1, 0, 0);
            pc.clearRect(0, 0, TILE, TILE);
            pc.imageSmoothingEnabled = true;
            pc.imageSmoothingQuality = 'medium';
            if (s.inGrid) pc.setTransform(1, 0, 0, 1, -tile.x, -tile.y);
            else Affine.setOn(pc, Affine.multiply({ a: 1, b: 0, c: 0, d: 1, e: -tile.x, f: -tile.y }, Affine.invert(this.M)));
            pc.drawImage(s.canvas, s.placed.x, s.placed.y, s.placed.width, s.placed.height);
            pc.setTransform(1, 0, 0, 1, 0, 0);
            pc.globalCompositeOperation = 'destination-in';
            pc.drawImage(this.scratch.canvas, 0, 0, tile.width, tile.height, 0, 0, tile.width, tile.height);
            pc.restore();
            const ctx = this.work.ctx, dx = tile.x - this.work.x, dy = tile.y - this.work.y;
            ctx.save();
            ctx.clearRect(dx, dy, tile.width, tile.height);
            ctx.drawImage(tile.base, dx, dy);
            ctx.globalAlpha = this.settings.opacity;
            if (this.lerp) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.drawImage(this.scratch.canvas, 0, 0, tile.width, tile.height, dx, dy, tile.width, tile.height);
                ctx.globalCompositeOperation = 'lighter';
            }
            ctx.drawImage(this.piece.canvas, 0, 0, tile.width, tile.height, dx, dy, tile.width, tile.height);
            ctx.restore();
        }
    }

    // BlurTool.blurSample (BlurTool.swift:11-73): the layer (or mask) softened by the Radius measured on the canvas, at
    // the layer's own resolution, taken when the stroke starts. Pixel layers blur against transparency, so softening
    // spreads past their edges; a mask is padded with its edge tone first. Canvas's Gaussian stands in for Core
    // Image's (close, not bit-exact; the engine commits).
    function blurSample(board, stroke, image, mask) {
        const M = stroke.M;
        const perPixel = Math.max(1e-6, Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)));
        const src = stroke.sourceRect;
        const side = Math.max(src.width, src.height);
        const sigma = Math.min(Math.min(50, Math.max(0.5, board.blurRadius)) / perPixel, side / 2);
        const margin = Math.ceil(3 * sigma);
        const region = { x: src.x - margin, y: src.y - margin, width: src.width + 2 * margin, height: src.height + 2 * margin };
        const canvas = board.doc.width * board.doc.height;
        const budget = Math.min(200000000, Math.max(16000000, 4 * canvas));
        const fit = Math.min(1, Math.sqrt(budget / (region.width * region.height)));
        const width = Math.max(1, Math.ceil(region.width * fit)), height = Math.max(1, Math.ceil(region.height * fit));
        const sharp = canvas2d(width, height);
        if (mask && mask.background) {
            sharp.ctx.fillStyle = '#fff';
            sharp.ctx.fillRect(0, 0, width, height);
            sharp.ctx.clearRect(margin * fit, margin * fit, src.width * fit, src.height * fit);
        }
        sharp.ctx.drawImage(image, margin * fit, margin * fit, src.width * fit, src.height * fit);
        const soft = canvas2d(width, height);
        soft.ctx.filter = `blur(${sigma * fit}px)`;
        soft.ctx.drawImage(sharp.canvas, 0, 0);
        return { canvas: soft.canvas, placed: region, inGrid: true };
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Smudge and Liquify (SmudgeLiquify.swift, MetalWarp.swift kernels; spec 4.3-4.6): a document-sized premultiplied
    // working copy of the layer as the canvas shows it, changed dab by dab, shown in place of the layer.

    const f32 = Math.fround;
    function weight(u, hardness) {
        if (u >= 1) return 0;
        if (u <= hardness) return 1;
        const t = f32((1 - u) / (1 - hardness));
        return f32(t * t * (3 - 2 * t));
    }

    class WarpStroke {
        constructor({ image, transform, docWidth, docHeight, mode, settings }) {
            const W = docWidth, H = docHeight;
            this.W = W;
            this.H = H;
            this.mode = mode;
            this.diameter = Math.max(2, settings.diameter);
            this.hardness = Math.min(0.98, Math.max(0, settings.hardness));
            this.strength = Math.min(1, Math.max(0.01, settings.opacity));
            this.r = Math.ceil(this.diameter / 2);
            this.inverseRadius = f32(1 / (this.diameter / 2));
            const view = canvas2d(W, H);
            view.ctx.save();
            Affine.setOn(view.ctx, Transform.pixelToDocument(transform, image.width, image.height));
            view.ctx.imageSmoothingEnabled = transform.sampling !== 'Nearest';
            view.ctx.imageSmoothingQuality = transform.sampling === 'High quality' ? 'high' : 'low';
            view.ctx.drawImage(image, 0, 0);
            view.ctx.restore();
            this.view = view;
            const data = view.ctx.getImageData(0, 0, W, H).data;
            this.C = new Uint8ClampedArray(data.length);
            for (let i = 0; i < data.length; i += 4) {
                const a = data[i + 3];
                this.C[i] = Math.round((data[i] * a) / 255);
                this.C[i + 1] = Math.round((data[i + 1] * a) / 255);
                this.C[i + 2] = Math.round((data[i + 2] * a) / 255);
                this.C[i + 3] = a;
            }
            this.last = null;
            this.dirty = null;
            this.carried = null;
            this.O = null;
            this.F = null;
        }

        // WarpStroke.append (SmudgeLiquify.swift:91-124).
        append(point) {
            if (!this.last) {
                this.last = point;
                if (this.mode === 'Smudge') this.pickUp(point);
                return;
            }
            const from = this.last;
            const distance = Math.hypot(point.x - from.x, point.y - from.y);
            const spacing = Math.max(1, this.diameter * (this.mode === 'Smudge' ? 0.005 : 0.025));
            if (distance < spacing) return;
            const steps = Math.ceil(distance / spacing);
            let previous = from;
            for (let step = 1; step <= steps; step++) {
                const t = step / steps;
                const next = { x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t };
                if (this.mode === 'Smudge') this.smudge(next);
                else this.push(previous, next);
                previous = next;
            }
            this.last = point;
        }

        flush() {}

        markDirty(cx, cy, reach) {
            const rect = Rect.intersect({ x: cx - reach, y: cy - reach, width: 2 * reach + 1, height: 2 * reach + 1 }, { x: 0, y: 0, width: this.W, height: this.H });
            if (rect) this.dirty = Rect.union(this.dirty, rect);
        }

        // warp_pick_up: the carried square starts as the pixels under the press (0 outside the canvas).
        pickUp(point) {
            const r = this.r, side = 2 * r + 1, cx = roundHalfAway(point.x), cy = roundHalfAway(point.y);
            this.carried = new Float32Array(side * side * 4);
            for (let gy = 0; gy < side; gy++) {
                for (let gx = 0; gx < side; gx++) {
                    const px = cx + gx - r, py = cy + gy - r;
                    if (px < 0 || py < 0 || px >= this.W || py >= this.H) continue;
                    const p = (py * this.W + px) * 4, g = (gy * side + gx) * 4;
                    for (let k = 0; k < 4; k++) this.carried[g + k] = this.C[p + k];
                }
            }
        }

        // warp_smudge: each pixel moves toward the carried color by weight x strength; the carried color keeps the
        // unrounded result.
        smudge(point) {
            const r = this.r, side = 2 * r + 1, cx = roundHalfAway(point.x), cy = roundHalfAway(point.y);
            const C = this.C, carried = this.carried, keep = f32(this.strength);
            for (let gy = 0; gy < side; gy++) {
                const oy = gy - r, py = cy + oy;
                if (py < 0 || py >= this.H) continue;
                for (let gx = 0; gx < side; gx++) {
                    const ox = gx - r, px = cx + ox;
                    if (px < 0 || px >= this.W) continue;
                    const w = weight(f32(f32(Math.sqrt(ox * ox + oy * oy)) * this.inverseRadius), this.hardness);
                    if (w <= 0) continue;
                    const p = (py * this.W + px) * 4, g = (gy * side + gx) * 4, wk = f32(w * keep);
                    for (let k = 0; k < 4; k++) {
                        const under = C[p + k], held = carried[g + k];
                        const painted = f32(under + f32(f32(held - under) * wk));
                        C[p + k] = Math.min(255, Math.max(0, roundHalfAway(painted)));
                        carried[g + k] = painted;
                    }
                }
            }
            this.markDirty(cx, cy, r);
        }

        // warp_copy + warp_push (MetalWarp.swift:132-158, 223-269): the offset field moves with the brush and every
        // touched pixel is drawn again from the untouched original through its offset, one bilinear sample.
        push(a, b) {
            const W = this.W, H = this.H, r = this.r;
            const mx = f32((b.x - a.x) * this.strength), my = f32((b.y - a.y) * this.strength);
            const margin = Math.ceil(Math.max(Math.abs(mx), Math.abs(my))) + 2;
            const cx = roundHalfAway(b.x), cy = roundHalfAway(b.y);
            const x0 = Math.max(0, cx - r - margin), x1 = Math.min(W - 1, cx + r + margin);
            const y0 = Math.max(0, cy - r - margin), y1 = Math.min(H - 1, cy + r + margin);
            if (x0 > x1 || y0 > y1) return;
            const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
            if (!this.O) {
                this.O = this.C.slice();
                this.F = new Float32Array(W * H * 2);
            }
            const F = this.F, O = this.O, C = this.C;
            const before = new Float32Array(cw * ch * 2);
            for (let y = 0; y < ch; y++) before.set(F.subarray(((y0 + y) * W + x0) * 2, ((y0 + y) * W + x1 + 1) * 2), y * cw * 2);
            const side = 2 * r + 1;
            for (let gy = 0; gy < side; gy++) {
                const oy = gy - r, py = cy + oy;
                if (py < y0 || py > y1) continue;
                for (let gx = 0; gx < side; gx++) {
                    const ox = gx - r, px = cx + ox;
                    if (px < x0 || px > x1) continue;
                    const w = weight(f32(f32(Math.sqrt(ox * ox + oy * oy)) * this.inverseRadius), this.hardness);
                    if (w <= 0) continue;
                    const sx = Math.min(cw - 1, Math.max(0, f32(px - x0 - f32(mx * w))));
                    const sy = Math.min(ch - 1, Math.max(0, f32(py - y0 - f32(my * w))));
                    const ix = Math.min(cw - 2, Math.trunc(sx)), iy = Math.min(ch - 2, Math.trunc(sy));
                    if (ix < 0 || iy < 0) continue;
                    const fx = f32(sx - ix), fy = f32(sy - iy);
                    const s00 = (iy * cw + ix) * 2, s10 = s00 + 2, s01 = s00 + cw * 2, s11 = s01 + 2;
                    const lerp = (u, v, t) => f32(u + f32(f32(v - u) * t));
                    const movedX = f32(lerp(lerp(before[s00], before[s10], fx), lerp(before[s01], before[s11], fx), fy) - f32(mx * w));
                    const movedY = f32(lerp(lerp(before[s00 + 1], before[s10 + 1], fx), lerp(before[s01 + 1], before[s11 + 1], fx), fy) - f32(my * w));
                    const q = (py * W + px) * 2;
                    F[q] = movedX;
                    F[q + 1] = movedY;
                    const sourceX = Math.min(W - 1, Math.max(0, f32(px + movedX))), sourceY = Math.min(H - 1, Math.max(0, f32(py + movedY)));
                    const ix2 = Math.min(Math.trunc(sourceX), W - 2), iy2 = Math.min(Math.trunc(sourceY), H - 2);
                    const tx = f32(sourceX - ix2), ty = f32(sourceY - iy2);
                    const c00 = (iy2 * W + ix2) * 4, c10 = c00 + 4, c01 = c00 + W * 4, c11 = c01 + 4;
                    const p = (py * W + px) * 4;
                    for (let k = 0; k < 4; k++) {
                        const top = lerp(O[c00 + k], O[c10 + k], tx), bottom = lerp(O[c01 + k], O[c11 + k], tx);
                        C[p + k] = Math.min(255, Math.max(0, roundHalfAway(lerp(top, bottom, ty))));
                    }
                }
            }
            this.markDirty(cx, cy, r);
        }

        // The working copy in place of the layer, over the whole canvas: the changed part is written back to the
        // display canvas, un-premultiplied.
        display() {
            const d = this.dirty;
            if (d) {
                const out = new ImageData(d.width, d.height), o = out.data, C = this.C;
                for (let y = 0; y < d.height; y++) {
                    for (let x = 0; x < d.width; x++) {
                        const p = ((d.y + y) * this.W + d.x + x) * 4, q = (y * d.width + x) * 4, a = C[p + 3];
                        o[q + 3] = a;
                        if (a) for (let k = 0; k < 3; k++) o[q + k] = Math.min(255, Math.round((C[p + k] * 255) / a));
                    }
                }
                this.view.ctx.putImageData(out, d.x, d.y);
                this.dirty = null;
            }
            return { canvas: this.view.canvas, toDocument: Affine.identity() };
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The brush tools' options bar (BrushControls.swift; spec 1.3)

    function maskPaintPicker(board) {
        return `<select class="pop mask-paint" style="width:180px" aria-label="Paint"><option value="black" ${board.maskPaintWhite ? '' : 'selected'}>Black · Hide</option><option value="white" ${board.maskPaintWhite ? 'selected' : ''}>White · Reveal</option></select>`;
    }

    function bindMaskPaint(board, el) {
        el.querySelectorAll('.mask-paint').forEach((s) => s.addEventListener('change', () => {
            board.maskPaintWhite = s.value === 'white';
            board.renderRail();
            board.renderOptions(true);
        }));
    }

    // Size, Hardness and Opacity (Strength for Smear), the board's own fields bound in Board.bindOptions.
    function tipFields(board, opacityCaption) {
        const b = board.brush;
        return `<span class="group"><label class="caption" data-scrub="diameter">Size</label><input class="num" data-brush="diameter" style="width:48px"><span class="unit">px</span></span>
            <span class="group"><label class="caption" data-scrub="hardness">Hardness</label><input type="range" min="0" max="100" data-brush-range="hardness" value="${Math.round(b.hardness * 100)}"><input class="num" data-brush="hardness" style="width:42px"><span class="unit">%</span></span>
            <span class="group" title="Press 1–9 for 10–90%, 0 for 100%"><label class="caption" data-scrub="opacity">${opacityCaption}</label><input type="range" min="1" max="100" data-brush-range="opacity" value="${Math.round(b.opacity * 100)}"><input class="num" data-brush="opacity" style="width:42px"><span class="unit">%</span></span>`;
    }

    // The trailing part: the mask's Paint picker (every brush tool), else the Color swatch (not for Clone Stamp or
    // Smear); then the secondary notes.
    function headerTail(board, { swatch, note }) {
        let html = '';
        if (board.isMaskSelected) html += maskPaintPicker(board);
        else if (swatch) {
            html += `<span class="group"><span>Color</span><span class="swatch fg-swatch brush-swatch" role="button" title="Foreground color" aria-label="Foreground color" style="background:#${CB.Color.hex(board.colors.fg)}"></span></span>`;
        }
        html += '<span class="spacer"></span>';
        if (note) html += `<span class="secondary">${escape(note)}</span>`;
        if (board.isMaskSelected) html += '<span class="secondary">Mask</span>';
        return html;
    }

    function segmented(values, current, attr, help) {
        return `<span class="segmented"${help ? ` title="${escape(help)}"` : ''}>${values.map((v) => `<button data-${attr}="${escape(v)}" class="${v === current ? 'on' : ''}">${escape(v)}</button>`).join('')}</span>`;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Spot Healing (section 2)

    const HEALING_TYPES = ['Content-Aware', 'Create Texture', 'Proximity Match'];

    class SpotHealingTool {
        constructor(board) {
            this.board = board;
            this.type = 'Content-Aware';
        }

        optionsHTML() {
            return `<span class="title">Spot Healing</span>${segmented(HEALING_TYPES, this.type, 'healing')}${tipFields(this.board, 'Opacity')}${headerTail(this.board, { swatch: true })}`;
        }

        bindOptions(el) {
            el.querySelectorAll('[data-healing]').forEach((b) => b.addEventListener('click', () => { this.type = b.dataset.healing; this.board.toolChanged(); }));
            bindMaskPaint(this.board, el);
        }

        hint() {
            return 'Drag over blemishes to heal · [ ] size · Shift-[ ] hardness · Escape cancel · Space to pan';
        }

        cycle() {
            this.type = HEALING_TYPES[(HEALING_TYPES.indexOf(this.type) + 1) % HEALING_TYPES.length];
            return true;
        }

        // Spot Healing reworks image pixels only: on a mask nothing happens, with no message
        // (EditorSession+Brush.swift:51-53). While dragging the area to heal shows as a dark wash (2.2).
        down(doc, p, e) {
            const board = this.board;
            if (board.isMaskSelected) return true;
            const record = paintTarget(board);
            if (!record) return true;
            let stroke;
            try {
                stroke = makeStroke(board, record, strokeSettings(board, { color: [0.12, 0.12, 0.12], opacity: 0.45 }), null);
            } catch (error) {
                board.alert(COULDNT, error.message);
                return true;
            }
            const type = this.type;
            board.view.startStroke(doc, e, {
                record, stroke, isMask: false,
                onFinish: (drag) => engineStroke(board, drag, { tool: 'spotHealing', healingType: type, label: 'Spot Healing' }),
            });
            return true;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Clone Stamp (section 3)

    class CloneStampTool {
        constructor(board) {
            this.board = board;
            this.aligned = true;
            this.sampleAllLayers = false;
            this.source = null;
            this.offset = null;
            this.tip = null;
        }

        optionsHTML() {
            const board = this.board;
            return `<span class="title">Clone Stamp</span>
                <label class="check" title="Keep the source moving with the brush between strokes; off starts every stroke at the source point"><input type="checkbox" class="clone-aligned" ${this.aligned ? 'checked' : ''}> Aligned</label>
                <span class="segmented" title="Copy from the active layer only, or from every visible layer as shown"><button data-clone-sample="layer" class="${this.sampleAllLayers ? '' : 'on'}">This Layer</button><button data-clone-sample="all" class="${this.sampleAllLayers ? 'on' : ''}">All Layers</button></span>
                ${tipFields(board, 'Opacity')}${headerTail(board, { swatch: false, note: this.source ? null : 'Option-click to set the source' })}`;
        }

        bindOptions(el) {
            el.querySelectorAll('.clone-aligned').forEach((c) => c.addEventListener('change', () => { this.aligned = c.checked; this.board.view.drawOverlay(); }));
            el.querySelectorAll('[data-clone-sample]').forEach((b) => b.addEventListener('click', () => { this.sampleAllLayers = b.dataset.cloneSample === 'all'; this.board.toolChanged(); }));
            bindMaskPaint(this.board, el);
        }

        hint() {
            return 'Option-click to set the source · Drag to clone · [ ] size · Shift-[ ] hardness · 1–0 opacity · Space to pan';
        }

        // Tab flips This Layer / All Layers (EditorSession.swift:439).
        cycle() {
            this.sampleAllLayers = !this.sampleAllLayers;
            return true;
        }

        // CloneStamp.cloneStrokeOffset (CloneStamp.swift:23-27): aligned strokes keep the first stroke's whole-pixel
        // offset; otherwise it runs from the brush to the source.
        strokeOffset(point) {
            if (!this.source) return null;
            if (this.aligned && this.offset) return this.offset;
            return { x: roundHalfAway(this.source.x - point.x), y: roundHalfAway(this.source.y - point.y) };
        }

        // cloneSamplePoint (CloneStamp.swift:31-35): the source itself until a stroke fixes the offset.
        samplePoint(point) {
            if (!this.source) return null;
            const drag = this.board.view.drag;
            if (!this.offset || !(this.aligned || (drag && drag.kind === 'stroke'))) return this.source;
            return { x: point.x + this.offset.x, y: point.y + this.offset.y };
        }

        down(doc, p, e) {
            const board = this.board;
            // Option-click sets where it copies from, also with a mask selected (EditorCanvas.swift:1822-1828).
            if (e.altKey) {
                if (Number.isFinite(doc.x) && Number.isFinite(doc.y)) {
                    this.source = { x: doc.x, y: doc.y };
                    this.offset = null;
                }
                board.renderOptions(true);
                return true;
            }
            if (board.isMaskSelected) return true;
            const record = paintTarget(board);
            if (!record) return true;
            if (!this.source) {
                board.alert(COULDNT, 'Option-click where Clone Stamp should copy from first.');
                return true;
            }
            const start = strokeStart(board, record, doc, e, false);
            const offset = this.strokeOffset(start);
            const entry = board.doc.entry(record.id);
            let stroke;
            try {
                stroke = makeStroke(board, record, strokeSettings(board), null, SampleStroke, { sample: null });
            } catch (error) {
                board.alert(COULDNT, error.message);
                return true;
            }
            // CloneStamp.cloneSample (CloneStamp.swift:39-48), taken once at the start: the layer's own pixels placed by the
            // offset carried into its grid, or the canvas as it shows every visible layer. A blank layer has nothing to copy.
            if (this.sampleAllLayers) {
                const composite = board.compositeCanvas();
                const copy = canvas2d(composite.width, composite.height);
                copy.ctx.drawImage(composite, 0, 0);
                stroke.sample = { canvas: copy.canvas, placed: { x: -offset.x, y: -offset.y, width: composite.width, height: composite.height }, inGrid: false };
            } else {
                if (!entry.image) return true;
                const inv = Affine.invert(stroke.M);
                const shift = { x: inv.a * offset.x + inv.c * offset.y, y: inv.b * offset.x + inv.d * offset.y };
                const r = stroke.sourceRect;
                stroke.sample = { canvas: entry.image, placed: { x: r.x - shift.x, y: r.y - shift.y, width: r.width, height: r.height }, inGrid: true };
            }
            this.offset = offset;
            const source = this.source, aligned = this.aligned, all = this.sampleAllLayers;
            board.view.startStroke(doc, e, {
                record, stroke, isMask: false,
                onFinish: async (drag) => {
                    const result = await engineStroke(board, drag, {
                        tool: 'cloneStamp', cloneSource: [source.x, source.y], cloneOffset: [offset.x, offset.y], aligned, sampleAllLayers: all, label: 'Clone Stamp',
                    });
                    if (result && Array.isArray(result.cloneOffset)) this.offset = { x: result.cloneOffset[0], y: result.cloneOffset[1] };
                },
            });
            return true;
        }

        // Hidden system cursor with a source, no Option and no Space (EditorCanvas.swift:1477-1481).
        cursor() {
            const view = this.board.view;
            if (this.source && !view.altHeld && !view.space && !this.board.picker.isOpen) return 'none';
            return null;
        }

        // The source crosshair (BrushCursorOverlay.swift:78-93) and, between strokes, the brush circle filled with what a
        // click would stamp (EditorCanvas.swift:1519-1590, BrushCursorOverlay.swift:39-58).
        drawOverlay(ctx) {
            const board = this.board, view = board.view;
            if (!view.pointer || view.space || board.picker.isOpen) return;
            const drag = view.drag;
            if (drag && (drag.kind === 'pan' || drag.kind === 'zoom-drag')) return;
            const pointer = view.toDoc(view.pointer);
            if (!drag && !view.altHeld) this.drawStampPreview(ctx, pointer);
            const sample = this.samplePoint(pointer);
            if (!sample) return;
            const s = view.toScreen(sample);
            ctx.lineCap = 'round';
            for (const [color, width] of [['#ffffff', 3], ['#000000', 1]]) {
                ctx.strokeStyle = color;
                ctx.lineWidth = width;
                ctx.beginPath();
                ctx.moveTo(s.x - 7, s.y);
                ctx.lineTo(s.x + 7, s.y);
                ctx.moveTo(s.x, s.y - 7);
                ctx.lineTo(s.x, s.y + 7);
                ctx.stroke();
            }
        }

        drawStampPreview(ctx, pointer) {
            const board = this.board, view = board.view;
            const offset = this.strokeOffset(pointer);
            if (!offset) return;
            const record = board.activeLayer();
            const d = board.brush.diameter;
            const scale = view.ppp * view.dpr;
            const side = Math.max(1, Math.min(1024, Math.ceil(d * scale)));
            const center = { x: pointer.x + offset.x, y: pointer.y + offset.y };
            const piece = canvas2d(side, side);
            // The `d`-wide square around the source center onto the piece.
            const k = side / d;
            piece.ctx.imageSmoothingQuality = 'medium';
            if (this.sampleAllLayers) {
                piece.ctx.setTransform(k, 0, 0, k, -(center.x - d / 2) * k, -(center.y - d / 2) * k);
                piece.ctx.drawImage(board.compositeCanvas(), 0, 0);
            } else {
                const image = record && board.doc.entry(record.id).image;
                if (!image) return;
                const t = Transform.read(record.transform, [board.doc.width, board.doc.height]);
                Affine.setOn(piece.ctx, Affine.multiply({ a: k, b: 0, c: 0, d: k, e: -(center.x - d / 2) * k, f: -(center.y - d / 2) * k }, Transform.pixelToDocument(t, image.width, image.height)));
                piece.ctx.drawImage(image, 0, 0);
            }
            piece.ctx.setTransform(1, 0, 0, 1, 0, 0);
            piece.ctx.globalCompositeOperation = 'destination-in';
            piece.ctx.drawImage(this.tipMask(d, board.brush.hardness, side), 0, 0);
            const at = view.pointer, r = (d * view.ppp) / 2;
            ctx.save();
            ctx.beginPath();
            ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
            ctx.clip();
            ctx.globalAlpha = board.brush.opacity;
            ctx.drawImage(piece.canvas, at.x - r, at.y - r, 2 * r, 2 * r);
            ctx.restore();
        }

        // One click of the brush engine on a blank layer, white with alpha = coverage, at the preview's resolution.
        tipMask(d, hardness, side) {
            const key = `${d}:${hardness}:${side}`;
            if (this.tip && this.tip.key === key) return this.tip.canvas;
            const tip = Brush.makeTip({ diameter: d, hardness }, 1);
            const image = new ImageData(side, side);
            for (let y = 0; y < side; y++) {
                for (let x = 0; x < side; x++) {
                    const dx = ((x + 0.5) / side) * d - d / 2, dy = ((y + 0.5) / side) * d - d / 2;
                    const i = (y * side + x) * 4;
                    image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
                    image.data[i + 3] = Math.round(255 * tip.cov(dx * dx + dy * dy));
                }
            }
            const c = canvas2d(side, side);
            c.ctx.putImageData(image, 0, 0);
            this.tip = { key, canvas: c.canvas };
            return c.canvas;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Smear (section 4)

    const SMEAR_MODES = ['Liquify', 'Blur', 'Smudge'];

    class SmearTool {
        constructor(board) {
            this.board = board;
            this.mode = 'Liquify';
            if (!Number.isFinite(board.blurRadius)) board.blurRadius = 5;
        }

        optionsHTML() {
            const board = this.board;
            const radius = this.mode === 'Blur'
                ? `<span class="group" title="How far the blur softens, in pixels"><label class="caption" data-scrub-radius>Radius</label><input type="range" min="0.5" max="20" step="0.1" class="blur-radius-range"><input class="num blur-radius" style="width:42px"><span class="unit">px</span></span>`
                : '';
            return `<span class="title">Smear</span>${segmented(SMEAR_MODES, this.mode, 'smear', 'Liquify pushes pixels · Blur softens · Smudge drags color along')}${tipFields(board, 'Strength')}${radius}${headerTail(board, { swatch: false })}`;
        }

        bindOptions(el) {
            const board = this.board;
            el.querySelectorAll('[data-smear]').forEach((b) => b.addEventListener('click', () => { this.mode = b.dataset.smear; board.toolChanged(); }));
            // Radius: 0.5...50 typed or scrubbed (0.1 per point), the slider up to 20; non-finite becomes 5.
            el.querySelectorAll('.blur-radius').forEach((f) => {
                f.addEventListener('change', () => {
                    const v = Number(f.value);
                    board.blurRadius = Number.isFinite(v) && f.value.trim() !== '' ? Math.min(50, Math.max(0.5, v)) : 5;
                    this.refreshOptions(el);
                });
                f.addEventListener('keydown', (e) => board.fieldKey(e));
            });
            el.querySelectorAll('.blur-radius-range').forEach((s) => s.addEventListener('input', () => { board.blurRadius = Number(s.value); this.refreshOptions(el); }));
            el.querySelectorAll('[data-scrub-radius]').forEach((label) => label.addEventListener('pointerdown', (e) => {
                label.setPointerCapture(e.pointerId);
                const start = e.clientX, from = board.blurRadius;
                label.onpointermove = (m) => { board.blurRadius = Math.min(50, Math.max(0.5, from + (m.clientX - start) * 0.1)); this.refreshOptions(el); };
                label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; };
            }));
            bindMaskPaint(board, el);
        }

        refreshOptions(el) {
            const v = this.board.blurRadius;
            el.querySelectorAll('.blur-radius').forEach((f) => { if (document.activeElement !== f) f.value = String(Math.round(v * 10) / 10); });
            el.querySelectorAll('.blur-radius-range').forEach((s) => { if (document.activeElement !== s) s.value = String(Math.min(20, v)); });
        }

        hint() {
            const verb = this.mode === 'Blur' ? 'Drag to soften' : this.mode === 'Smudge' ? 'Drag to smudge' : 'Drag to push pixels';
            return `${verb} · [ ] size · Shift-[ ] hardness · 1–0 strength · Space to pan`;
        }

        cycle() {
            this.mode = SMEAR_MODES[(SMEAR_MODES.indexOf(this.mode) + 1) % SMEAR_MODES.length];
            return true;
        }

        // Search Commands' "Tool › Liquify / Blur / Smudge".
        setMode(mode) {
            if (SMEAR_MODES.includes(mode)) this.mode = mode;
        }

        down(doc, p, e) {
            const board = this.board;
            if (board.working) return true;
            return this.mode === 'Blur' ? this.beginBlur(doc, e) : this.beginWarp(doc, e);
        }

        // Blur: the Brush's coverage over a softened copy, on pixels or on the mask (4.2).
        beginBlur(doc, e) {
            const board = this.board, view = board.view;
            const record = paintTarget(board);
            if (!record) return true;
            const entry = board.doc.entry(record.id);
            const target = board.isMaskSelected && record.maskFile && entry.mask ? view.maskStrokeTarget(record, entry.mask) : null;
            const image = target ? target.layer.image : entry.image;
            if (!image) return true;
            let stroke;
            try {
                stroke = makeStroke(board, record, strokeSettings(board), target, SampleStroke, { sample: null, lerp: Boolean(target), clipToSource: Boolean(target) });
            } catch (error) {
                board.alert(COULDNT, error.message);
                return true;
            }
            stroke.sample = blurSample(board, stroke, image, target);
            view.startStroke(doc, e, {
                record, stroke, mask: target, isMask: Boolean(target),
                onFinish: (drag) => engineStroke(board, drag, { tool: 'smear', smearMode: 'Blur', label: target ? 'Paint Mask' : 'Blur' }),
            });
            return true;
        }

        // Smudge and Liquify (4.3): the layer's pixels only.
        beginWarp(doc, e) {
            const board = this.board, view = board.view;
            if (board.isMaskSelected) {
                board.alert(COULDNT, "Smudge and Liquify work on a layer's pixels, not its mask.");
                return true;
            }
            const record = paintTarget(board);
            if (!record) return true;
            const image = board.doc.entry(record.id).image;
            if (!image) return true;
            const stroke = new WarpStroke({
                image, transform: Transform.read(record.transform, [board.doc.width, board.doc.height]),
                docWidth: board.doc.width, docHeight: board.doc.height, mode: this.mode, settings: board.brush,
            });
            const mode = this.mode;
            view.startStroke(doc, e, {
                record, stroke, isMask: false,
                onFinish: (drag) => engineStroke(board, drag, { tool: 'smear', smearMode: mode, label: mode }),
            });
            return true;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Gradient (section 5)

    class GradientTool {
        constructor(board) {
            this.board = board;
            this.settings = { shape: 'Linear', style: 'Foreground to Transparent', reversed: false, opacity: 1 };
            this.edit = null;
            this.committing = false;
            this.selectionMask = null;
            this.colorKey = '';
        }

        // gradientColors (Gradient.swift:88-98): [r, g, b, alpha] for each end, the mask's black or white on a mask.
        colors(mask) {
            const board = this.board;
            const fg = mask ? board.paletteColor('fg') : board.colors.fg;
            const bg = mask ? board.paletteColor('bg') : board.colors.bg;
            const list = this.settings.style === 'Foreground to Background' ? [[...fg, 1], [...bg, 1]] : [[...fg, 1], [...fg, 0]];
            return this.settings.reversed ? list.reverse() : list;
        }

        // The header's colors and the endpoints use the palette as shown (a mask's black and white when one is selected).
        shownColors() {
            const board = this.board;
            const fg = board.paletteColor('fg'), bg = board.paletteColor('bg');
            const list = this.settings.style === 'Foreground to Background' ? [[...fg, 1], [...bg, 1]] : [[...fg, 1], [...fg, 0]];
            return this.settings.reversed ? list.reverse() : list;
        }

        optionsHTML() {
            const board = this.board, s = this.settings;
            const css = (c) => `rgba(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(',')},${c[3]})`;
            const shown = this.shownColors();
            return `<span class="title">Gradient</span>
                ${segmented(['Linear', 'Radial'], s.shape, 'gradient-shape', 'Linear runs along the line; Radial spreads out from the start point')}
                <span class="gradient-swatch" aria-hidden="true"><span style="background:linear-gradient(to right, ${css(shown[0])}, ${css(shown[1])})"></span></span>
                <select class="pop gradient-colors" aria-label="Colors"><option ${s.style === 'Foreground to Background' ? 'selected' : ''}>Foreground to Background</option><option ${s.style === 'Foreground to Transparent' ? 'selected' : ''}>Foreground to Transparent</option></select>
                <label class="check"><input type="checkbox" class="gradient-reverse" ${s.reversed ? 'checked' : ''}> Reverse</label>
                <span class="group" title="Press 1–9 for 10–90%, 0 for 100%"><label class="caption" data-gradient-scrub>Opacity</label><input type="range" min="1" max="100" class="gradient-opacity-range"><input class="num gradient-opacity" style="width:42px"><span class="unit">%</span></span>
                <span class="spacer"></span>
                ${board.isMaskSelected ? '<span class="secondary">Mask</span>' : ''}
                ${this.edit ? '<span class="gradient-actions"><button class="pill gradient-cancel">Cancel</button><button class="pill gradient-apply">Apply</button></span>' : ''}`;
        }

        bindOptions(el) {
            const board = this.board, s = this.settings;
            const changed = () => { this.refresh(); board.renderOptions(true); };
            el.querySelectorAll('[data-gradient-shape]').forEach((b) => b.addEventListener('click', () => { s.shape = b.dataset.gradientShape; changed(); }));
            el.querySelectorAll('.gradient-colors').forEach((c) => c.addEventListener('change', () => { s.style = c.value; changed(); }));
            el.querySelectorAll('.gradient-reverse').forEach((c) => c.addEventListener('change', () => { s.reversed = c.checked; changed(); }));
            el.querySelectorAll('.gradient-opacity').forEach((f) => {
                f.addEventListener('change', () => {
                    const v = Number(f.value);
                    s.opacity = Number.isFinite(v) && f.value.trim() !== '' ? Math.min(100, Math.max(1, v)) / 100 : 1;
                    this.refresh();
                    this.refreshOptions(el);
                });
                f.addEventListener('keydown', (e) => board.fieldKey(e));
            });
            el.querySelectorAll('.gradient-opacity-range').forEach((r) => r.addEventListener('input', () => { s.opacity = Number(r.value) / 100; this.refresh(); this.refreshOptions(el); }));
            el.querySelectorAll('[data-gradient-scrub]').forEach((label) => label.addEventListener('pointerdown', (e) => {
                label.setPointerCapture(e.pointerId);
                const start = e.clientX, from = s.opacity;
                label.onpointermove = (m) => { s.opacity = Math.min(1, Math.max(0.01, from + (m.clientX - start) * 0.01)); this.refresh(); this.refreshOptions(el); };
                label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; };
            }));
            el.querySelectorAll('.gradient-cancel').forEach((b) => b.addEventListener('click', () => this.cancel()));
            el.querySelectorAll('.gradient-apply').forEach((b) => b.addEventListener('click', () => this.commit()));
        }

        refreshOptions(el) {
            const v = Math.round(this.settings.opacity * 100);
            el.querySelectorAll('.gradient-opacity').forEach((f) => { if (document.activeElement !== f) f.value = String(v); });
            el.querySelectorAll('.gradient-opacity-range').forEach((r) => { if (document.activeElement !== r) r.value = String(v); });
            // A palette change (X, D, the swatches, the mask paint color) re-renders the pending gradient
            // (EditorSession.swift:205, 227-229).
            const key = JSON.stringify([this.board.colors, this.board.maskPaintWhite]);
            if (key !== this.colorKey) {
                this.colorKey = key;
                if (this.edit) this.refresh();
            }
        }

        hint() {
            return 'Drag to draw · Drag ends to adjust · Shift 45° · 1–0 opacity · Enter apply · Escape cancel';
        }

        cycle() {
            this.settings.shape = this.settings.shape === 'Linear' ? 'Radial' : 'Linear';
            this.refresh();
            return true;
        }

        opacityDigit(percent) {
            this.settings.opacity = percent / 100;
            this.refresh();
            this.board.refreshOptionValues();
        }

        hasLine() {
            const e = this.edit;
            return Boolean(e && Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) >= 0.5);
        }

        // EditorCanvas.swift:2502-2519: a press within 10 points of the pending line's end (checked first) or start grabs
        // it; anywhere else begins a new line (Gradient.beginGradient), and the drag moves its end.
        down(doc, p, e) {
            const board = this.board, view = board.view;
            if (board.working || this.committing) return true;
            if (this.edit && this.hasLine()) {
                const near = (q) => { const s = view.toScreen(q); return Math.hypot(s.x - p.x, s.y - p.y) <= 10; };
                if (near(this.edit.end)) { this.dragging = 'end'; return true; }
                if (near(this.edit.start)) { this.dragging = 'start'; return true; }
            }
            const record = board.activeLayer();
            if (!record) return true;
            const mask = Boolean(board.isMaskSelected && record.maskFile);
            if (this.edit && this.edit.layerID === record.id && this.edit.mask === mask) {
                // Dragging a new line replaces the pending one on the same target.
                this.edit.start = doc;
                this.edit.end = doc;
                this.dragging = 'end';
                this.refresh();
                return true;
            }
            const refusal = board.paintRefusal(record);
            if (refusal) {
                board.alert(COULDNT, refusal);
                return true;
            }
            this.edit = { layerID: record.id, mask, start: doc, end: doc };
            board.gradientEdit = this.edit;
            this.dragging = 'end';
            board.renderOptions(true);
            return true;
        }

        // Shift snaps the dragged end to 45° steps around the other (EditorCanvas.swift:1948-1955).
        move(doc, p, e) {
            if (!this.edit || !this.dragging) return;
            const anchor = this.dragging === 'end' ? this.edit.start : this.edit.end;
            let point = doc;
            if (e.shiftKey) {
                const dx = doc.x - anchor.x, dy = doc.y - anchor.y, length = Math.hypot(dx, dy);
                const angle = roundHalfAway(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
                point = { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length };
            }
            this.edit[this.dragging] = point;
            this.refresh();
        }

        // endGradientDrag: a click without a line leaves nothing pending (Gradient.swift:101-103).
        up() {
            this.dragging = null;
            if (this.edit && !this.hasLine()) this.cancel();
            else this.board.renderOptions(true);
        }

        busy() {
            return false;
        }

        cancel() {
            this.dragging = null;
            if (!this.edit) return false;
            this.board.renderer.overrides.delete(this.edit.layerID);
            this.edit = null;
            this.board.gradientEdit = null;
            this.board.changed();
            this.board.renderOptions(true);
            this.board.view.drawOverlay();
            return true;
        }

        escape() {
            return this.cancel();
        }

        // Return or keypad Enter applies (EditorCanvas.swift:2234-2239), following "Apply current canvas operation".
        keydown(e) {
            const apply = CB.Shortcuts && CB.Shortcuts.isApply ? CB.Shortcuts.isApply(e) || e.code === 'NumpadEnter'
                : (e.code === 'Enter' || e.code === 'NumpadEnter') && !e.metaKey && !e.ctrlKey;
            if (apply && this.edit) {
                this.commit();
                return true;
            }
            return false;
        }

        // ⌘Z with a pending gradient discards it instead of undoing (EditorSession.swift:657-660).
        interceptUndo() {
            if (!this.edit || this.committing) return false;
            this.cancel();
            return true;
        }

        // Undo and redo restore a step without the pending line (EditorSession.restore, ES:669-679): no request.
        restored() {
            if (this.edit && !this.committing) this.cancel();
        }

        // resolveGradient: switching tools, layers or the target applies it, as do other edits. A save does not (upstream
        // only closing applies it, ProjectWorkspace.swift:137): the pending line is no part of the document, and an
        // autosave must neither apply a line still being adjusted nor wait for the engine, which waits for the save.
        resolve(reason) {
            if (reason === 'save') return null;
            return this.edit && !this.committing ? this.commit() : null;
        }

        deactivate() {
            if (this.edit) this.commit();
            return true;
        }

        // Gradient.commitGradient (Gradient.swift:111-119) in compositor-engine: the same line replayed by
        // beginGradient / moveGradient / commitGradient. The preview stays until the saved layer is back.
        async commit() {
            const board = this.board, edit = this.edit;
            if (!edit || this.committing) return;
            if (!this.hasLine()) { this.cancel(); return; }
            this.committing = true;
            this.dragging = null;
            const s = this.settings;
            const shown = board.renderer.overrides.get(edit.layerID);
            // Applied because another layer or target was picked: that choice stands once the saved project (whose
            // active layer is the gradient's) has been read back. Taken after the switch that resolved it.
            let wanted = null;
            Promise.resolve().then(() => { wanted = { active: board.activeID(), ids: [...board.selectedIDs], mask: board.isMaskSelected }; });
            try {
                const result = await board.engine('paint.gradient', {
                    shape: s.shape, colors: s.style, reverse: s.reversed, opacity: s.opacity,
                    start: [edit.start.x, edit.start.y], end: [edit.end.x, edit.end.y],
                    selection: board.selection, foreground: board.colors.fg, background: board.colors.bg,
                    activeLayerID: edit.layerID, selectedLayerIDs: [edit.layerID], isMaskSelected: edit.mask,
                }, { label: edit.mask ? 'Gradient Mask' : 'Gradient' });
                if (result.error) board.alert(COULDNT, result.error);
            } catch (error) {
                board.alert(COULDNT, error.message);
            } finally {
                this.committing = false;
                if (wanted && board.doc.manifest && board.doc.layer(wanted.active)
                    && (board.activeID() !== wanted.active || board.isMaskSelected !== wanted.mask)) {
                    board.setActive(wanted.active);
                    board.selectedIDs = new Set(wanted.ids.filter((id) => board.doc.layer(id)));
                    board.isMaskSelected = wanted.mask && Boolean(board.activeLayer().maskFile);
                    board.layerSelectionChanged();
                }
                if (board.renderer.overrides.get(edit.layerID) === shown) board.renderer.overrides.delete(edit.layerID);
                if (this.edit === edit) {
                    this.edit = null;
                    board.gradientEdit = null;
                }
                board.changed();
                board.renderOptions(true);
                board.view.drawOverlay();
            }
        }

        // The selection's coverage on the canvas as an alpha picture, kept while the selection is the same.
        selectionCanvas() {
            const sel = this.board.selection;
            if (!sel) return null;
            if (this.selectionMask && this.selectionMask.selection === sel) return this.selectionMask.canvas;
            const clip = Selection.clip(sel, this.board.doc.width, this.board.doc.height);
            const c = canvas2d(this.board.doc.width, this.board.doc.height);
            if (clip.cov) {
                const image = new ImageData(clip.rect.width, clip.rect.height);
                for (let i = 0; i < clip.cov.length; i++) image.data[i * 4 + 3] = clip.cov[i];
                c.ctx.putImageData(image, clip.rect.x, clip.rect.y);
            }
            this.selectionMask = { selection: sel, canvas: c.canvas };
            return c.canvas;
        }

        // The gradient on the canvas (in document pixels), through the selection: `alpha(c)` picks each end's alpha.
        gradientLayer(colors, alpha, rgb) {
            const board = this.board, e = this.edit, s = this.settings;
            const W = board.doc.width, H = board.doc.height;
            const layer = canvas2d(W, H);
            const g = s.shape === 'Radial'
                ? layer.ctx.createRadialGradient(e.start.x, e.start.y, 0, e.start.x, e.start.y, Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y))
                : layer.ctx.createLinearGradient(e.start.x, e.start.y, e.end.x, e.end.y);
            colors.forEach((c, i) => g.addColorStop(i, `rgba(${rgb(c).map((v) => Math.round(v * 255)).join(',')},${alpha(c)})`));
            layer.ctx.fillStyle = g;
            layer.ctx.fillRect(0, 0, W, H);
            const sel = this.selectionCanvas();
            if (sel) {
                layer.ctx.globalCompositeOperation = 'destination-in';
                layer.ctx.drawImage(sel, 0, 0);
            }
            return layer.canvas;
        }

        // The pending gradient over the target's pixels (5.8): the original, then the gradient at the opacity in the
        // layer's grid spread over the canvas (makeRasterEdit, growsMask). On a mask the gray takes M' = g·a + M(1 − a).
        refresh() {
            const board = this.board, e = this.edit;
            board.view.drawOverlay();
            if (!e) return;
            const record = board.doc.layer(e.layerID);
            if (!record) return;
            if (!this.hasLine()) {
                board.renderer.overrides.delete(e.layerID);
                board.changed();
                return;
            }
            const entry = board.doc.entry(record.id);
            const size = [board.doc.width, board.doc.height];
            let target, background = false;
            if (e.mask && entry.mask) {
                const m = board.view.maskStrokeTarget(record, entry.mask);
                target = m.layer;
                background = m.background;
            } else target = { transform: Transform.read(record.transform, size), image: entry.image };
            const image = target.image;
            const w0 = image ? image.width : Math.max(1, Math.round(target.transform.width));
            const h0 = image ? image.height : Math.max(1, Math.round(target.transform.height));
            const mapping = Transform.pixelToDocument(target.transform, w0, h0);
            const inGrid = Rect.integral(Affine.boundsOf(Affine.invert(mapping), { x: 0, y: 0, width: size[0], height: size[1] }));
            const extent = Rect.union({ x: 0, y: 0, width: w0, height: h0 }, inGrid);
            const M = Affine.translate(mapping, extent.x, extent.y);
            const grid = canvas2d(extent.width, extent.height);
            if (e.mask && background) {
                grid.ctx.fillStyle = '#fff';
                grid.ctx.fillRect(0, 0, extent.width, extent.height);
                grid.ctx.clearRect(-extent.x, -extent.y, w0, h0);
            }
            if (image) grid.ctx.drawImage(image, -extent.x, -extent.y);
            const colors = this.colors(e.mask);
            grid.ctx.save();
            Affine.setOn(grid.ctx, Affine.invert(M));
            grid.ctx.globalAlpha = Math.min(1, Math.max(0, this.settings.opacity));
            if (e.mask) {
                grid.ctx.globalCompositeOperation = 'destination-out';
                grid.ctx.drawImage(this.gradientLayer(colors, (c) => c[3], () => [0, 0, 0]), 0, 0);
                grid.ctx.globalCompositeOperation = 'lighter';
                grid.ctx.drawImage(this.gradientLayer(colors, (c) => c[0] * c[3], () => [1, 1, 1]), 0, 0);
            } else {
                grid.ctx.drawImage(this.gradientLayer(colors, (c) => c[3], (c) => c.slice(0, 3)), 0, 0);
            }
            grid.ctx.restore();
            board.renderer.overrides.set(e.layerID, e.mask ? { mask: { canvas: grid.canvas, toDocument: M, background } } : { canvas: grid.canvas, toDocument: M });
            board.changed();
        }

        // TransformOverlay.swift:450-488: the rim (Radial), the line, and a circle at each end in that end's color.
        drawOverlay(ctx) {
            if (!this.hasLine()) return;
            const view = this.board.view, e = this.edit;
            const a = view.toScreen(e.start), b = view.toScreen(e.end);
            if (this.settings.shape === 'Radial') {
                const r = Math.hypot(b.x - a.x, b.y - a.y);
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
            const colors = this.colors(false).map((c, i) => (this.board.isMaskSelected ? this.shownColors()[i] : c));
            [a, b].forEach((q, i) => {
                ctx.beginPath();
                ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
                ctx.fillStyle = 'rgb(191,191,191)';
                ctx.fill();
                const c = colors[i];
                ctx.fillStyle = `rgba(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(',')},${c[3]})`;
                ctx.fill();
            });
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The palette with a mask selected (ColorPaletteControls.swift:40-56) and the eyedropper's exact sample

    // Clicking a swatch while a mask is the target asks for black or white: "Mask foreground" or "Mask background".
    function maskPopover(board, which) {
        closeMaskPopover(board);
        const anchor = board.railEl.querySelector(which === 'bg' ? '.colors .bg' : '.colors .fg').getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'mask-popover';
        el.innerHTML = `<div class="headline">${which === 'bg' ? 'Mask background' : 'Mask foreground'}</div>
            <div class="buttons"><button class="pill" data-mask-color="black">Black · Hide</button><button class="pill" data-mask-color="white">White · Reveal</button></div>`;
        document.body.appendChild(el);
        el.style.left = `${Math.min(window.innerWidth - el.offsetWidth - 4, anchor.right + 8)}px`;
        el.style.top = `${Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, anchor.top + anchor.height / 2 - el.offsetHeight / 2))}px`;
        el.querySelectorAll('[data-mask-color]').forEach((b) => b.addEventListener('click', () => {
            closeMaskPopover(board);
            const white = b.dataset.maskColor === 'white';
            board.setColor(which, white ? [1, 1, 1] : [0, 0, 0]);
        }));
        el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMaskPopover(board); } });
        const outside = (e) => { if (!el.contains(e.target)) closeMaskPopover(board); };
        setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
        board.maskPopover = { el, outside };
        el.querySelector('button').focus();
    }

    function closeMaskPopover(board) {
        const p = board.maskPopover;
        if (!p) return;
        p.el.remove();
        window.removeEventListener('pointerdown', p.outside, true);
        board.maskPopover = null;
    }

    // When the mask becomes or stops being the target the popover closes, and an open picker is cancelled as a mask
    // gets selected (ColorPaletteControls.swift:53-56). Called whenever the rail is drawn.
    function syncMaskPalette(board) {
        const masked = Boolean(board.isMaskSelected);
        if (board.paletteMasked === masked) return;
        board.paletteMasked = masked;
        closeMaskPopover(board);
        if (masked && board.picker.isOpen) board.picker.close(false);
    }

    // The board's own composite has no adjustment layers or effects yet: where a document has them, the sample is taken
    // again on mouse-up with Compositor's sampleCompositeColor (paint-tools.md 6, 8.3).
    async function refineSample(board, doc, intoPicker) {
        if (!board.doc.manifest || !board.unrenderedByLayer().size || board.working) return;
        try {
            const result = await board.engine('color.sample', { point: [doc.x, doc.y] });
            if (!result.color) return;
            if (intoPicker) board.picker.sample(result.color);
            else {
                board.colors.fg = result.color;
                board.renderRail();
                board.renderOptions();
            }
        } catch (error) {
            // The board's own sample stands.
        }
    }

    // ---------------------------------------------------------------------------------------------------------------

    CB.registerTool({ id: 'spotHealing', title: 'Spot Healing Brush (J)', key: 'KeyJ', icon: 'bandage', brushTool: true, create: (board) => new SpotHealingTool(board) });
    CB.registerTool({ id: 'cloneStamp', title: 'Clone Stamp (S) · Option-click sets the source', key: 'KeyS', icon: 'cloneStamp', brushTool: true, create: (board) => new CloneStampTool(board) });
    CB.registerTool({ id: 'blur', title: 'Smear (R)', key: 'KeyR', icon: 'drop', brushTool: true, create: (board) => new SmearTool(board) });
    CB.registerTool({ id: 'gradient', title: 'Gradient (G)', key: 'KeyG', icon: 'gradient', create: (board) => new GradientTool(board) });

    CB.PaintTools = { engineStroke, maskPaintPicker, bindMaskPaint, maskPopover, syncMaskPalette, refineSample, SampleStroke, WarpStroke, weight };
})();
