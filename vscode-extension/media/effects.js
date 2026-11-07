'use strict';
// Layer effects (upstream Document/LayerEffects.swift, Rendering/MetalLayerEffects.swift, UI/EffectsSheet.swift): the
// six effects drawn around a layer's pixels, computed in the layer's own pixel grid from its pixels through its mask and
// placed by growing the layer's transform; and the edits the Layers panel and the effect panels make. Every edit is a
// manifest change with Compositor's undo name. Specification: docs/port-specs/adjustments-effects.md sections 5 and 8.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Affine, Transform } = CB;

    // LayerEffectKind, in this order (Document/LayerEffects.swift:226-228).
    const KINDS = [
        ['stroke', 'Stroke'], ['shadow', 'Drop Shadow'], ['colorOverlay', 'Color Overlay'],
        ['innerShadow', 'Inner Shadow'], ['outerGlow', 'Outer Glow'], ['innerGlow', 'Inner Glow'],
    ];
    const NAME = Object.fromEntries(KINDS);
    // The model defaults (Document/LayerEffects.swift:6-123).
    const DEFAULTS = {
        stroke: { size: 4, red: 0, green: 0, blue: 0, opacity: 1, inside: false },
        shadow: { angle: 90, distance: 20, blur: 20, red: 0, green: 0, blue: 0, opacity: 0.5 },
        colorOverlay: { red: 0, green: 0, blue: 0, opacity: 1 },
        innerShadow: { angle: 90, distance: 10, blur: 10, red: 0, green: 0, blue: 0, opacity: 0.5 },
        outerGlow: { size: 20, red: 1, green: 1, blue: 1, opacity: 0.75 },
        innerGlow: { size: 10, red: 1, green: 1, blue: 1, opacity: 0.75 },
    };

    const enabled = (e) => Boolean(e) && e.enabled !== false;
    // The footer's "Add layer effect" button (SF sparkles).
    if (CB.iconPaths) CB.iconPaths.sparkles = '<path d="M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z"/><path d="M17.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>';
    const finite01 = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
    const colorValid = (e) => finite01(e.red) && finite01(e.green) && finite01(e.blue) && finite01(e.opacity);
    const shadowValid = (e) => [e.angle, e.distance, e.blur].every(Number.isFinite) && e.angle >= -360 && e.angle <= 360
        && e.distance >= 0 && e.distance <= 5000 && e.blur >= 0 && e.blur <= 500 && colorValid(e);
    const sizeValid = (e) => Number.isFinite(e.size) && e.size >= 0 && e.size <= 500 && colorValid(e);
    // LayerEffects.isValid.
    function isValid(fx) {
        if (!fx) return true;
        return (!fx.stroke || sizeValid(fx.stroke)) && (!fx.shadow || shadowValid(fx.shadow)) && (!fx.colorOverlay || colorValid(fx.colorOverlay))
            && (!fx.innerShadow || shadowValid(fx.innerShadow)) && (!fx.outerGlow || sizeValid(fx.outerGlow)) && (!fx.innerGlow || sizeValid(fx.innerGlow));
    }
    // The visible effects, or null when none would draw.
    function visible(fx) {
        if (!fx) return null;
        const out = {};
        for (const [key] of KINDS) if (enabled(fx[key])) out[key] = fx[key];
        return Object.keys(out).length ? out : null;
    }
    const isEmpty = (fx) => !fx || KINDS.every(([key]) => !fx[key]);

    // ---------------------------------------------------------------------------------------------------------------
    // The Metal path (Rendering/MetalLayerEffects.swift:59-395), bit-exact in JS (spec 5.3).

    const f32 = Math.fround;
    const swiftRound = (v) => Math.sign(v) * Math.round(Math.abs(v));

    function effectsMargin(fx) {
        let m = 0;
        if (enabled(fx.stroke) && !fx.stroke.inside) m = Math.max(m, fx.stroke.size);
        if (enabled(fx.shadow)) m = Math.max(m, fx.shadow.distance + fx.shadow.blur * 3);
        if (enabled(fx.outerGlow)) m = Math.max(m, fx.outerGlow.size * 3);
        return Math.ceil(m) + 2;
    }
    const shadowOffset = (e) => { const r = (e.angle * Math.PI) / 180; return [-Math.cos(r) * e.distance, Math.sin(r) * e.distance]; };

    // A square max (or min) filter along rows or columns; samples past the canvas read 0.
    function spread(src, W, H, reach, smallest, rows) {
        const out = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let best = smallest ? 1 : 0;
                for (let o = -reach; o <= reach; o++) {
                    const sx = rows ? x + o : x, sy = rows ? y : y + o;
                    const v = (rows ? sx < 0 || sx >= W : sy < 0 || sy >= H) ? 0 : src[sy * W + sx];
                    best = smallest ? Math.min(best, v) : Math.max(best, v);
                }
                out[y * W + x] = best;
            }
        }
        return out;
    }

    // A bilinear sample at (x - dx, y - dy), 0 outside the canvas.
    function shift(src, W, H, dx, dy) {
        const out = new Float32Array(W * H);
        dx = f32(dx); dy = f32(dy);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const sx = f32(x - dx), sy = f32(y - dy);
                if (!(sx >= 0 && sy >= 0 && sx <= W - 1 && sy <= H - 1)) continue;
                const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
                const fx = f32(sx - x0), fy = f32(sy - y0), mix = (a, b, t) => a + (b - a) * t;
                out[y * W + x] = mix(mix(src[y0 * W + x0], src[y0 * W + x1], fx), mix(src[y1 * W + x0], src[y1 * W + x1], fx), fy);
            }
        }
        return out;
    }

    // A separable Gaussian, samples clamped to the edge.
    function blur(src, W, H, sigma) {
        sigma = f32(sigma);
        const radius = Math.max(1, Math.trunc(swiftRound(f32(sigma * 3))));
        const w = [];
        for (let o = -radius; o <= radius; o++) w.push(f32(Math.exp(-(o * o) / (2 * sigma * sigma))));
        let sum = 0;
        for (const v of w) sum += v;
        const pass = (input, rows) => {
            const out = new Float32Array(W * H);
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    let total = 0;
                    for (let o = -radius; o <= radius; o++) {
                        const s = rows ? input[y * W + Math.min(W - 1, Math.max(0, x + o))] : input[Math.min(H - 1, Math.max(0, y + o)) * W + x];
                        total += w[o + radius] * s;
                    }
                    out[y * W + x] = total / sum;
                }
            }
            return out;
        };
        return pass(pass(src, true), false);
    }

    // shown: the layer's pixels through its mask, premultiplied RGBA8, w x h. Returns the grown premultiplied image.
    function renderEffects(shown, w, h, fx) {
        const inset = effectsMargin(fx), W = w + 2 * inset, H = h + 2 * inset, n = W * H;
        const px = new Uint8Array(n * 4);
        for (let y = 0; y < h; y++) px.set(shown.subarray(y * w * 4, (y + 1) * w * 4), ((y + inset) * W + inset) * 4);
        const first = new Float32Array(n);
        for (let i = 0; i < n; i++) first[i] = px[i * 4 + 3] / 255;
        const on = (e, sized) => enabled(e) && e.opacity > 0 && (!sized || e.size > 0);
        const cl = (v) => Math.min(1, Math.max(0, v));
        const stroke = on(fx.stroke, true) ? fx.stroke : null, shadow = on(fx.shadow) ? fx.shadow : null;
        const overlay = on(fx.colorOverlay) ? fx.colorOverlay : null, inner = on(fx.innerShadow) ? fx.innerShadow : null;
        const glow = on(fx.outerGlow, true) ? fx.outerGlow : null, iglow = on(fx.innerGlow, true) ? fx.innerGlow : null;
        const ring = new Float32Array(n);
        if (stroke) {
            const reach = Math.max(1, Math.trunc(swiftRound(stroke.size)));
            const moved = spread(spread(first, W, H, reach, stroke.inside, true), W, H, reach, stroke.inside, false);
            for (let i = 0; i < n; i++) ring[i] = cl(stroke.inside ? first[i] - moved[i] : moved[i] - first[i]);
        }
        const softened = (e) => { const [dx, dy] = shadowOffset(e); const m = shift(first, W, H, dx, dy); return e.blur / 2 > 0.01 ? blur(m, W, H, e.blur / 2) : m; };
        const shadowCov = shadow ? softened(shadow) : null;
        const innerCov = inner ? softened(inner).map((v) => cl(1 - v)) : null;
        const glowCov = glow ? (glow.size / 2 > 0.01 ? blur(first, W, H, glow.size / 2) : first) : null;
        const iglowCov = iglow ? (iglow.size / 2 > 0.01 ? blur(first, W, H, iglow.size / 2) : first).map((v) => cl(1 - v)) : null;
        const col = (e) => [f32(e.red), f32(e.green), f32(e.blue)];
        const shadowColor = shadow && col(shadow), glowColor = glow && col(glow), strokeColor = stroke && col(stroke);
        const overlayColor = overlay && col(overlay), innerColor = inner && col(inner), iglowColor = iglow && col(iglow);
        const out = new Uint8Array(n * 4);
        const color = [0, 0, 0], src = [0, 0, 0, 0];
        for (let i = 0; i < n; i++) {
            color[0] = color[1] = color[2] = 0;
            let alpha = 0;
            const over = (k, c) => { for (let j = 0; j < 3; j++) color[j] = k[j] * c + color[j] * (1 - c); alpha = c + alpha * (1 - c); };
            if (shadow) { const c = cl(shadowCov[i] * shadow.opacity); for (let j = 0; j < 3; j++) color[j] = shadowColor[j] * c; alpha = c; }
            if (glow) over(glowColor, cl(glowCov[i] * (1 - first[i]) * glow.opacity));
            const sc = stroke ? cl(ring[i] * stroke.opacity) : 0;
            if (stroke && !stroke.inside) over(strokeColor, sc);
            for (let j = 0; j < 4; j++) src[j] = px[i * 4 + j] / 255;
            const recolor = (k, t) => { for (let j = 0; j < 3; j++) src[j] = src[j] + (k[j] * src[3] - src[j]) * t; };
            if (overlay) recolor(overlayColor, f32(overlay.opacity));
            if (iglow) recolor(iglowColor, cl(iglowCov[i] * iglow.opacity));
            if (inner) recolor(innerColor, cl(innerCov[i] * inner.opacity));
            for (let j = 0; j < 3; j++) color[j] = src[j] + color[j] * (1 - src[3]);
            alpha = src[3] + alpha * (1 - src[3]);
            if (stroke && stroke.inside) over(strokeColor, sc);
            for (let j = 0; j < 3; j++) out[i * 4 + j] = Math.trunc(cl(color[j]) * 255 + 0.5);
            out[i * 4 + 3] = Math.trunc(cl(alpha) * 255 + 0.5);
        }
        return { pixels: out, W, H, inset };
    }

    // LayerEffectsRenderer.placed (:425-433): the transform grown about its center in the same proportion.
    function placed(t, w, h, inset) {
        const g = { ...t };
        g.width = (t.width * (w + 2 * inset)) / w;
        g.height = (t.height * (h + 2 * inset)) / h;
        g.x = t.x + t.width / 2 - g.width / 2;
        g.y = t.y + t.height / 2 - g.height / 2;
        return g;
    }

    // The layer's pixels through its own mask, in its pixel grid, premultiplied (LayerEffects.masked, :526-537).
    function shownPixels(image, mask, record, transform, docSize) {
        const w = image.width, h = image.height;
        const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        if (mask && record.maskFile && record.maskEnabled !== false) {
            ctx.globalCompositeOperation = 'destination-in';
            const placedApart = record.maskPlacement && !CB.Render.samePlacement(record.maskPlacement, record.transform);
            if (!placedApart) ctx.drawImage(mask.alpha, 0, 0, w, h);
            else {
                // A placed mask resampled onto the layer's grid, its background outside its own rectangle.
                const cover = new OffscreenCanvas(w, h), cctx = cover.getContext('2d');
                if (CB.Render.maskBackground(mask)) { cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, w, h); }
                const placement = Transform.read(record.maskPlacement, docSize);
                const toGrid = Affine.multiply(Affine.invert(Transform.pixelToDocument(transform, w, h)), Transform.pixelToDocument(placement, mask.width, mask.height));
                cctx.save();
                Affine.setOn(cctx, toGrid);
                cctx.globalCompositeOperation = 'destination-out';
                cctx.fillStyle = '#fff';
                cctx.fillRect(0, 0, mask.width, mask.height);
                cctx.globalCompositeOperation = 'source-over';
                cctx.drawImage(mask.alpha, 0, 0);
                cctx.restore();
                ctx.drawImage(cover, 0, 0);
            }
            ctx.globalCompositeOperation = 'source-over';
        }
        const data = ctx.getImageData(0, 0, w, h).data;
        const pre = new Uint8Array(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            pre[i] = Math.round((data[i] * a) / 255); pre[i + 1] = Math.round((data[i + 1] * a) / 255); pre[i + 2] = Math.round((data[i + 2] * a) / 255);
            pre[i + 3] = a;
        }
        return pre;
    }

    // Premultiplied RGBA to a canvas.
    function toCanvas(made) {
        const { pixels, W, H } = made;
        const out = new OffscreenCanvas(W, H), ctx = out.getContext('2d');
        const image = new ImageData(W, H), d = image.data;
        for (let i = 0; i < pixels.length; i += 4) {
            const a = pixels[i + 3];
            if (!a) continue;
            d[i] = Math.min(255, Math.round((pixels[i] * 255) / a)); d[i + 1] = Math.min(255, Math.round((pixels[i + 1] * 255) / a));
            d[i + 2] = Math.min(255, Math.round((pixels[i + 2] * 255) / a)); d[i + 3] = a;
        }
        ctx.putImageData(image, 0, 0);
        return out;
    }

    // The last results, by pixels, mask and settings, so redraws and moves reuse them (LayerEffectsRenderer cache).
    const cache = [];
    function effectsImage(image, mask, record, transform, docSize) {
        const fx = visible(record.effects);
        if (!fx || !isValid(fx) || !image) return null;
        const key = JSON.stringify([fx, record.maskFile && record.maskEnabled !== false ? [record.maskPlacement || null, record.transform && mask ? 1 : 0] : null]);
        const placedApart = record.maskPlacement && !CB.Render.samePlacement(record.maskPlacement, record.transform);
        let hit = cache.find((e) => e.image === image && e.mask === (record.maskFile && record.maskEnabled !== false ? mask : null) && e.key === key
            && (!placedApart || e.transformKey === JSON.stringify(transform)));
        if (!hit) {
            const shown = shownPixels(image, mask, record, transform, docSize);
            const made = renderEffects(shown, image.width, image.height, fx);
            hit = { image, mask: record.maskFile && record.maskEnabled !== false ? mask : null, key, transformKey: JSON.stringify(transform), canvas: toCanvas(made), inset: made.inset };
            cache.push(hit);
            let cost = 0;
            for (let i = cache.length - 1; i >= 0; i--) {
                cost += cache[i].canvas.width * cache[i].canvas.height * 4;
                if (i < cache.length - 8 || cost > 256 * 1024 * 1024) { cache.splice(0, i + 1); break; }
            }
        }
        return { canvas: hit.canvas, inset: hit.inset, transform: placed(transform, image.width, image.height, hit.inset) };
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Effects that follow wet paint (Rendering/LayerEffectsSurface.swift): built once from the stroke's working canvas,
    // then rebuilt only in a window around the tiles each update changed. The window reaches past every pass's footprint,
    // so inside its inner part the result equals a full render.

    const live = new Map();

    // LayerEffectsSurface reach (:32-40).
    function liveReach(fx) {
        let r = 1;
        if (enabled(fx.stroke)) r = Math.max(r, fx.stroke.size + 2);
        if (enabled(fx.shadow)) r = Math.max(r, fx.shadow.distance + fx.shadow.blur * 3 + 2);
        if (enabled(fx.innerShadow)) r = Math.max(r, fx.innerShadow.distance + fx.innerShadow.blur * 3 + 2);
        if (enabled(fx.outerGlow)) r = Math.max(r, fx.outerGlow.size * 3 + 2);
        if (enabled(fx.innerGlow)) r = Math.max(r, fx.innerGlow.size * 3 + 2);
        return Math.ceil(r);
    }

    // The working canvas's pixels in `rect`, through the mask over the layer's own pixels (paint past them is unmasked),
    // premultiplied.
    function workPixels(work, rect, sourceRect, mask) {
        const c = new OffscreenCanvas(rect.width, rect.height), ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(work, -rect.x, -rect.y);
        if (mask && sourceRect) {
            const cover = new OffscreenCanvas(rect.width, rect.height), cctx = cover.getContext('2d');
            cctx.fillStyle = '#fff';
            cctx.fillRect(0, 0, rect.width, rect.height);
            cctx.clearRect(sourceRect.x - rect.x, sourceRect.y - rect.y, sourceRect.width, sourceRect.height);
            cctx.drawImage(mask.alpha, sourceRect.x - rect.x, sourceRect.y - rect.y, sourceRect.width, sourceRect.height);
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(cover, 0, 0);
        }
        const data = ctx.getImageData(0, 0, rect.width, rect.height).data;
        const pre = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            pre[i] = Math.round((data[i] * a) / 255); pre[i + 1] = Math.round((data[i + 1] * a) / 255); pre[i + 2] = Math.round((data[i + 2] * a) / 255);
            pre[i + 3] = a;
        }
        return pre;
    }

    function liveEffects(record, override, mask) {
        const fx = visible(record.effects);
        if (!fx || !isValid(fx)) return null;
        const useMask = record.maskFile && record.maskEnabled !== false && mask ? mask : null;
        // A mask placed apart from its layer: the layer draws without effects until the stroke ends.
        if (useMask && record.maskPlacement && !CB.Render.samePlacement(record.maskPlacement, record.transform)) return null;
        const work = override.canvas, W = work.width, H = work.height, inset = effectsMargin(fx), fxKey = JSON.stringify(fx);
        let st = live.get(record.id);
        if (!st || st.work !== work || st.W !== W || st.H !== H || st.fxKey !== fxKey) {
            const made = renderEffects(workPixels(work, { x: 0, y: 0, width: W, height: H }, override.sourceRect, useMask), W, H, fx);
            st = { work, W, H, fxKey, inset, surface: toCanvas(made), override };
            live.set(record.id, st);
        } else if (st.override !== override) {
            st.override = override;
            const d = override.liveDirty;
            if (d && d.width > 0 && d.height > 0) {
                const reach = liveReach(fx);
                const clip = (r, b) => {
                    const x0 = Math.max(r.x, b.x), y0 = Math.max(r.y, b.y), x1 = Math.min(r.x + r.width, b.x + b.width), y1 = Math.min(r.y + r.height, b.y + b.height);
                    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
                };
                const grow = (r, by) => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });
                // In the working canvas's coordinates: `inner` is replaced, `outer` is what it is computed from.
                const inner = clip(grow(d, inset), { x: -inset, y: -inset, width: W + 2 * inset, height: H + 2 * inset });
                const outer = inner && clip(grow(inner, reach), { x: 0, y: 0, width: W, height: H });
                if (inner && outer) {
                    const made = renderEffects(workPixels(work, outer, override.sourceRect, useMask), outer.width, outer.height, fx);
                    const piece = toCanvas(made), sctx = st.surface.getContext('2d');
                    const sx = inner.x - outer.x + made.inset, sy = inner.y - outer.y + made.inset;
                    sctx.clearRect(inner.x + inset, inner.y + inset, inner.width, inner.height);
                    sctx.drawImage(piece, sx, sy, inner.width, inner.height, inner.x + inset, inner.y + inset, inner.width, inner.height);
                }
            }
        }
        return { canvas: st.surface, toDocument: Affine.translate(override.toDocument, -inset, -inset) };
    }

    // The stroke ended: the next draw uses the committed pixels.
    function endLive(id) {
        live.delete(id);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Edits (Document/LayerEffects.swift:236-382), mixed into the Board.

    const Effects = {
        canEditEffects() {
            const a = this.activeLayer();
            return this.canEditLayers() && Boolean(a) && !a.isGroup && Boolean(this.doc.entry(a.id).image) && !this.isLocked(a);
        },

        layerHasPixels(record) {
            return Boolean(record) && !record.isGroup && !record.adjustment && Boolean(this.doc.entry(record.id).image);
        },

        // The effect selected in the Layers panel, while its layer is active and still has it.
        selectedEffect() {
            const s = this.effectSelection;
            const a = this.activeLayer();
            return s && a && s.layerID === a.id && a.effects && a.effects[s.kind] ? s : null;
        },

        // setEffects: validated, only on layers with pixels, nothing when unchanged; one undo step.
        setEffects(effects, id, name) {
            const record = this.doc.layer(id || this.activeID());
            if (!this.canEditLayers() || !isValid(effects) || !this.layerHasPixels(record) || this.refuseLocked([record])) return false;
            const next = isEmpty(effects) ? null : effects;
            if (JSON.stringify(record.effects || null) === JSON.stringify(next)) return false;
            return this.edit(name, () => { if (next) record.effects = next; else delete record.effects; });
        },

        addEffect(kind) {
            const id = this.activeID();
            if (!this.canEditEffects()) return;
            if (this.effectsEditing && this.effectsEditing.layerID === id && this.effectsEditing.kind === kind) return;
            this.finishEffectsEditing(false);
            const record = this.doc.layer(id);
            const original = JSON.parse(JSON.stringify(record.effects || {}));
            const effects = JSON.parse(JSON.stringify(original));
            if (!effects[kind]) {
                effects[kind] = { ...DEFAULTS[kind] };
                // A new stroke or overlay takes the background color: the foreground is usually the layer's own.
                if (kind === 'stroke' || kind === 'colorOverlay') [effects[kind].red, effects[kind].green, effects[kind].blue] = this.colors.bg;
            }
            this.setEffects(effects, id, `Add ${NAME[kind]}`);
            this.selectEffect(kind, id, true);
            this.effectsEditingOriginal = original;
        },

        selectEffect(kind, id, editing = false) {
            const record = this.doc.layer(id);
            if (!this.canEditLayers() || !record || !record.effects || !record.effects[kind]) return;
            const selection = { layerID: id, kind };
            const same = this.effectsEditing && this.effectsEditing.layerID === id && this.effectsEditing.kind === kind;
            if (editing && !same) this.finishEffectsEditing(false);
            this.selectLayer(id);
            this.selectedIDs = new Set([id]);
            this.isMaskSelected = false;
            this.effectSelection = selection;
            if (editing && !same) {
                this.effectsEditingOriginal = JSON.parse(JSON.stringify(record.effects || {}));
                this.effectsEditing = selection;
                this.openEffectPanel(selection);
            }
            this.layerSelectionChanged();
        },

        // Cancel puts back only this panel's effect (removing a just-added one); OK keeps.
        finishEffectsEditing(commit) {
            const editing = this.effectsEditing;
            if (!editing) return;
            if (this.picker.isOpen && this.pickerForEffect) this.picker.close(commit);
            const record = this.doc.layer(editing.layerID);
            if (!commit && this.effectsEditingOriginal && record && record.effects) {
                const effects = JSON.parse(JSON.stringify(record.effects));
                if (this.effectsEditingOriginal[editing.kind]) effects[editing.kind] = this.effectsEditingOriginal[editing.kind];
                else delete effects[editing.kind];
                this.setEffects(effects, editing.layerID, `Cancel ${NAME[editing.kind]}`);
            }
            this.effectsEditing = null;
            this.effectsEditingOriginal = null;
            this.closeEffectPanel();
            if (!this.selectedEffect()) this.effectSelection = null;
            this.layerSelectionChanged();
        },

        // Panel edits stay bound to the layer that opened the panel; one step each.
        changeEffects(change) {
            const editing = this.effectsEditing;
            const record = editing && this.doc.layer(editing.layerID);
            if (!record || !record.effects || !record.effects[editing.kind]) return;
            const effects = JSON.parse(JSON.stringify(record.effects));
            change(effects[editing.kind]);
            this.setEffects(effects, record.id, `Edit ${NAME[editing.kind]}`);
        },

        canCopyEffect(kind, source, target) {
            const from = this.doc.layer(source), to = this.doc.layer(target);
            return this.canEditLayers() && source !== target && Boolean(from && from.effects && from.effects[kind]) && this.layerHasPixels(to);
        },

        copyEffect(kind, source, target) {
            if (!this.canCopyEffect(kind, source, target)) return;
            const original = this.doc.layer(source).effects;
            if (this.effectsEditing && this.effectsEditing.layerID === target && this.effectsEditing.kind === kind) this.finishEffectsEditing(true);
            const effects = JSON.parse(JSON.stringify(this.doc.layer(target).effects || {}));
            effects[kind] = JSON.parse(JSON.stringify(original[kind]));
            this.setEffects(effects, target, `Copy ${NAME[kind]}`);
            this.selectEffect(kind, target);
        },

        toggleEffect(kind, id) {
            const record = this.doc.layer(id);
            if (!record || !record.effects || !record.effects[kind]) return;
            const effects = JSON.parse(JSON.stringify(record.effects));
            const on = enabled(effects[kind]);
            effects[kind].enabled = !on;
            this.setEffects(effects, id, `${on ? 'Hide' : 'Show'} ${NAME[kind]}`);
        },

        removeSelectedEffect() {
            const s = this.selectedEffect();
            if (!s || !this.canEditLayers()) return false;
            const record = this.doc.layer(s.layerID);
            if (this.effectsEditing && this.effectsEditing.layerID === s.layerID && this.effectsEditing.kind === s.kind) {
                if (this.picker.isOpen && this.pickerForEffect) this.picker.close(false);
                this.effectsEditing = null;
                this.effectsEditingOriginal = null;
                this.closeEffectPanel();
            }
            const effects = JSON.parse(JSON.stringify(record.effects));
            delete effects[s.kind];
            this.setEffects(effects, s.layerID, `Remove ${NAME[s.kind]}`);
            this.effectSelection = null;
            this.layerSelectionChanged();
            return true;
        },

        // ---------------------------------------------------------------------------------------------------------------
        // The effect panel (UI/EffectsSheet.swift)

        openEffectPanel(selection) {
            this.closeEffectPanel();
            const el = document.createElement('div');
            el.className = 'floating-panel effect-panel';
            el.setAttribute('role', 'dialog');
            this.stageEl.appendChild(el);
            this.effectPanelEl = el;
            this.effectsPanelOpen = true;
            const title = NAME[selection.kind];
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            el.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (CB.Shortcuts.isCancel(e)) { e.preventDefault(); this.finishEffectsEditing(false); }
                else if (CB.Shortcuts.isApply(e)) { e.preventDefault(); el.querySelectorAll('input.num').forEach((i) => i.dispatchEvent(new Event('change'))); this.finishEffectsEditing(true); }
            });
            this.renderEffectPanel();
            const place = this.panelPlaces[title];
            const maxX = Math.max(0, this.stageEl.clientWidth - el.offsetWidth), maxY = Math.max(0, this.stageEl.clientHeight - el.offsetHeight);
            el.style.left = `${place ? Math.min(maxX, place.left) : maxX / 2}px`;
            el.style.top = `${place ? Math.min(maxY, place.top) : maxY / 2}px`;
        },

        closeEffectPanel() {
            if (this.effectPanelEl) this.effectPanelEl.remove();
            this.effectPanelEl = null;
            this.effectsPanelOpen = false;
        },

        // Rebuilt from the layer's current effect; it closes itself when the effect is gone (undo, a delete).
        renderEffectPanel() {
            const el = this.effectPanelEl, editing = this.effectsEditing;
            if (!el || !editing) return;
            const record = this.doc.layer(editing.layerID);
            const effect = record && record.effects && record.effects[editing.kind];
            if (!effect) { this.effectsEditing = null; this.effectsEditingOriginal = null; this.closeEffectPanel(); return; }
            if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && !el.dataset.dragging) {
                this.refreshEffectPanel();
                return;
            }
            const kind = editing.kind, title = NAME[kind];
            const swatch = `<button class="effect-swatch" title="${title} color" aria-label="${title} color" style="background:rgb(${[effect.red, effect.green, effect.blue].map((v) => Math.round(v * 255)).join(',')})"></button>`;
            const row = (key, label, range, input, unit, scale = 1) => `<div class="effect-row"><span class="effect-label scrub" data-fx="${key}" data-scale="${scale}" data-min="${input[0]}" data-max="${input[1]}">${label}</span>
                <input type="range" min="${range[0]}" max="${range[1]}" step="any" data-fx-range="${key}" data-scale="${scale}">
                <span class="group tight"><input class="num" data-fx-field="${key}" data-scale="${scale}" data-min="${input[0]}" data-max="${input[1]}" style="width:48px"><span class="unit">${unit}</span></span></div>`;
            const opacity = row('opacity', 'Opacity', [0, 100], [0, 100], '%', 100);
            const angleRows = (distanceMax) => row('angle', 'Angle', [-180, 180], [-180, 180], '°') + row('distance', 'Distance', [0, distanceMax], [0, 5000], 'px') + row('blur', 'Blur', [0, 100], [0, 500], 'px');
            let body = '';
            if (kind === 'stroke') {
                body = `<div class="effect-head"><b>Stroke</b><span class="segmented"><button data-inside="false" class="${effect.inside ? '' : 'on'}">Outside</button><button data-inside="true" class="${effect.inside ? 'on' : ''}">Inside</button></span></div>
                    <div class="effect-row"><span class="effect-label">Color</span>${swatch}</div>
                    ${row('size', 'Size', [0, 20], [0, 500], 'px')}${opacity}`;
            } else if (kind === 'shadow') body = `<div class="effect-head"><b>Drop Shadow</b>${swatch}</div>${opacity}${angleRows(100)}`;
            else if (kind === 'colorOverlay') body = `<div class="effect-head"><b>Color Overlay</b>${swatch}</div>${opacity}`;
            else if (kind === 'innerShadow') body = `<div class="effect-head"><b>Inner Shadow</b>${swatch}</div>${opacity}${angleRows(50)}`;
            else body = `<div class="effect-head"><b>${title}</b>${swatch}</div>${row('size', 'Size', [0, 100], [0, 500], 'px')}${opacity}`;
            el.innerHTML = `<div class="panel-title">${title}<button class="panel-close" title="Close" aria-label="Close">${CB.icon('close')}</button></div>${body}
                <div class="buttons"><span class="spacer"></span><button class="pill cancel">Cancel</button><button class="pill ok">OK</button></div>`;
            this.bindEffectPanel(el, title);
            this.refreshEffectPanel();
        },

        refreshEffectPanel() {
            const el = this.effectPanelEl, editing = this.effectsEditing;
            const record = editing && this.doc.layer(editing.layerID);
            const effect = record && record.effects && record.effects[editing.kind];
            if (!el || !effect) return;
            el.querySelectorAll('[data-fx-range]').forEach((r) => {
                const v = effect[r.dataset.fxRange] * Number(r.dataset.scale);
                // A typed value past the slider's range pins the knob at its end.
                r.value = Math.min(Number(r.max), Math.max(Number(r.min), v));
            });
            el.querySelectorAll('[data-fx-field]').forEach((f) => {
                if (document.activeElement !== f) f.value = Math.round(effect[f.dataset.fxField] * Number(f.dataset.scale));
            });
            const sw = el.querySelector('.effect-swatch');
            if (sw) sw.style.background = `rgb(${[effect.red, effect.green, effect.blue].map((v) => Math.round(v * 255)).join(',')})`;
        },

        bindEffectPanel(el, title) {
            const set = (key, value) => this.changeEffects((e) => { e[key] = value; });
            el.querySelector('.cancel').addEventListener('click', () => this.finishEffectsEditing(false));
            el.querySelector('.panel-close').addEventListener('click', () => this.finishEffectsEditing(false));
            el.querySelector('.ok').addEventListener('click', () => this.finishEffectsEditing(true));
            el.querySelectorAll('[data-inside]').forEach((b) => b.addEventListener('click', () => set('inside', b.dataset.inside === 'true')));
            el.querySelectorAll('[data-fx-range]').forEach((r) => r.addEventListener('input', () => set(r.dataset.fxRange, Number(r.value) / Number(r.dataset.scale))));
            el.querySelectorAll('[data-fx-field]').forEach((f) => {
                const apply = (v) => {
                    if (!Number.isFinite(v)) { this.refreshEffectPanel(); return; }
                    set(f.dataset.fxField, Math.min(Number(f.dataset.max), Math.max(Number(f.dataset.min), v)) / Number(f.dataset.scale));
                };
                f.addEventListener('change', () => apply(Number(f.value)));
                f.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        e.stopPropagation();
                        apply((Number(f.value) || 0) + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1));
                    }
                });
            });
            // The title scrubs one unit per point over the field's range.
            el.querySelectorAll('.effect-label[data-fx]').forEach((label) => label.addEventListener('pointerdown', (e) => {
                const key = label.dataset.fx, scale = Number(label.dataset.scale), min = Number(label.dataset.min), max = Number(label.dataset.max);
                const record = this.doc.layer(this.effectsEditing.layerID);
                const from = record.effects[this.effectsEditing.kind][key] * scale, start = e.clientX;
                label.setPointerCapture(e.pointerId);
                el.dataset.dragging = '1';
                label.onpointermove = (m) => set(key, Math.min(max, Math.max(min, from + (m.clientX - start))) / scale);
                label.onpointerup = () => { label.onpointermove = label.onpointerup = null; delete el.dataset.dragging; };
            }));
            // The swatch opens the picker; the layer follows the working color, OK keeps it, Cancel puts it back.
            const swatch = el.querySelector('.effect-swatch');
            if (swatch) swatch.addEventListener('click', () => {
                const editing = this.effectsEditing;
                const effect = this.doc.layer(editing.layerID).effects[editing.kind];
                const original = [effect.red, effect.green, effect.blue];
                const setColor = (rgb) => this.changeEffects((e) => { [e.red, e.green, e.blue] = rgb; });
                this.pickerForEffect = true;
                this.picker.open({
                    title: `Color Picker (${NAME[editing.kind]} Color)`, color: original,
                    onChange: (rgb) => setColor(rgb),
                    onCommit: (rgb) => { this.pickerForEffect = false; setColor(rgb); },
                    onCancel: () => { this.pickerForEffect = false; setColor(original); },
                });
            });
            const handle = el.querySelector('.panel-title');
            handle.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.panel-close')) return;
                handle.setPointerCapture(e.pointerId);
                const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop };
                handle.onpointermove = (m) => {
                    el.style.left = `${Math.max(0, Math.min(this.stageEl.clientWidth - el.offsetWidth, start.left + m.clientX - start.x))}px`;
                    el.style.top = `${Math.max(0, Math.min(this.stageEl.clientHeight - el.offsetHeight, start.top + m.clientY - start.y))}px`;
                };
                handle.onpointerup = () => {
                    handle.onpointermove = handle.onpointerup = null;
                    this.panelPlaces[title] = { left: el.offsetLeft, top: el.offsetTop };
                    this.postMessage({ type: 'panelPlace', name: title, place: this.panelPlaces[title] });
                };
            });
        },
    };

    CB.Effects = { KINDS, NAME, DEFAULTS, isValid, visible, isEmpty, enabled, effectsMargin, renderEffects, placed, shownPixels, effectsImage, liveEffects, endLive };
    CB.EffectsOps = Effects;
})();
