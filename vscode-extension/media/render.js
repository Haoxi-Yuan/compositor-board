'use strict';
// Flattens a project the way Compositor's ImageExporter.render and LiveMaskRenderer do (derivation and line references
// in docs/port-specs/compositing.md): pre-order through the folders, pass-through folders whose opacity and masks
// multiply into each layer, raster masks (linked or placed apart), clipping stacks blended as a group, independent
// clipping links by the source's coverage, the 24 blend modes, adjustment layers (media/adjustments.js) and layer
// effects (media/effects.js).

(function () {
    const CB = (window.CB = window.CB || {});
    const { Affine, Rect, Transform, Blend } = CB;

    function canvas2d(width, height) {
        const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
        return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
    }

    // Draw order and everything about each drawn layer that does not depend on pixels.
    function plan(manifest) {
        const layers = manifest.layers || [];
        const byID = new Map(layers.map((l) => [l.id, l]));
        const children = new Map();
        for (const l of layers) {
            const key = l.parentID && byID.has(l.parentID) ? l.parentID : null;
            if (!children.has(key)) children.set(key, []);
            children.get(key).push(l);
        }
        const list = [];
        const visit = (parent, visible, depth) => {
            if (depth > 64) return;
            for (const l of children.get(parent) || []) {
                const effective = visible && l.isVisible;
                if (l.isGroup) visit(l.id, effective, depth + 1);
                else if (effective) list.push(l);
            }
        };
        visit(null, true, 0);

        const ancestors = (l) => {
            const out = [];
            let id = l.parentID, depth = 0;
            while (id && depth < 64 && byID.has(id)) {
                const folder = byID.get(id);
                out.push(folder);
                id = folder.parentID;
                depth++;
            }
            return out;
        };
        const opacityOf = (l) => ancestors(l).reduce((o, f) => o * (f.opacity === undefined ? 1 : f.opacity), l.opacity === undefined ? 1 : l.opacity);

        // Clipping stacks: a visible base followed immediately by visible layers clipped to it in the same folder.
        const stacks = new Map(), stacked = new Set();
        list.forEach((base, index) => {
            if (base.maskSourceID || base.adjustment) return;
            const members = [];
            for (const child of list.slice(index + 1)) {
                if (child.maskSourceID !== base.id || (child.parentID || null) !== (base.parentID || null)) break;
                members.push(child);
            }
            if (members.length) {
                stacks.set(base.id, members);
                members.forEach((m) => stacked.add(m.id));
            }
        });
        return { list, byID, ancestors, opacityOf, stacks, stacked };
    }

    // Upstream LayerMask.background: white when the mask's edge pixels average at least half way, else black.
    // LayerMask.background (LayerMask.swift:63-76): white when the edge of the mask's thumbnail (at most 96 px, drawn
    // with high-quality interpolation, LayerMask.swift:35-48) averages at least half white, else black.
    function maskBackground(mask) {
        if (mask.background !== undefined) return mask.background;
        let { width: w, height: h, gray } = mask;
        const factor = Math.min(1, 96 / Math.max(w, h));
        if (factor < 1) {
            const tw = Math.max(1, Math.floor(w * factor)), th = Math.max(1, Math.floor(h * factor));
            const thumb = new OffscreenCanvas(tw, th), tctx = thumb.getContext('2d');
            tctx.imageSmoothingQuality = 'high';
            tctx.drawImage(CB.Document.grayCanvas(mask), 0, 0, tw, th);
            const data = tctx.getImageData(0, 0, tw, th).data;
            gray = new Uint8Array(tw * th);
            for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4];
            w = tw; h = th;
        }
        let total = 0, count = 0;
        for (let x = 0; x < w; x++) { total += gray[x] + gray[(h - 1) * w + x]; count += 2; }
        for (let y = 1; y < h - 1; y++) { total += gray[y * w] + gray[y * w + w - 1]; count += 2; }
        mask.background = total * 2 >= count * 255 ? 1 : 0;
        return mask.background;
    }

    function samePlacement(a, b) {
        if (!a || !b) return !a;
        return a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.size[0] === b.size[0] && a.size[1] === b.size[1]
            && (a.rotation || 0) === (b.rotation || 0) && Boolean(a.flipX) === Boolean(b.flipX) && Boolean(a.flipY) === Boolean(b.flipY);
    }

    function setSmoothing(ctx, t, imageWidth) {
        const factor = t.width / Math.max(1, imageWidth);
        const nearest = t.sampling === 'Nearest' || (Transform.radians(t) === 0 && Math.abs(factor - 1) < 0.001);
        ctx.imageSmoothingEnabled = !nearest;
        ctx.imageSmoothingQuality = factor > 1 ? (t.sampling === 'High quality' ? 'high' : 'low') : 'high';
    }

    function fillQuad(ctx, frame, t, alpha) {
        const pts = [CB.TransformTool.point(t, 0, 0), CB.TransformTool.point(t, 1, 0), CB.TransformTool.point(t, 1, 1), CB.TransformTool.point(t, 0, 1)];
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, -frame.x, -frame.y);
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = `rgba(0,0,0,${alpha})`;
        ctx.fill();
        ctx.restore();
    }

    // A quad given by a matrix from a w × h grid, filled at `alpha`.
    function fillMatrix(ctx, frame, m, w, h, alpha) {
        const pts = [Affine.apply(m, 0, 0), Affine.apply(m, w, 0), Affine.apply(m, w, h), Affine.apply(m, 0, h)];
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, -frame.x, -frame.y);
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = `rgba(0,0,0,${alpha})`;
        ctx.fill();
        ctx.restore();
    }

    class Renderer {
        // `doc`: CB.Document.BoardDocument. `overrides`: Map id -> { canvas, toDocument } (a stroke in progress),
        // { transform } (a transform being dragged), or { mask: { canvas, toDocument, background } } (a mask stroke).
        // `blendPreview`: { id, mode } while the blend menu highlights a mode (LayerAppearance.displayedBlendMode).
        constructor(doc) {
            this.doc = doc;
            this.overrides = new Map();
            this.blendPreview = null;
        }

        blendOf(record) {
            const p = this.blendPreview;
            return p && p.id === record.id ? p.mode : record.blendMode || 'Normal';
        }

        transformOf(record) {
            const o = this.overrides.get(record.id);
            if (o && o.transform) return o.transform;
            return Transform.read(record.transform, [this.doc.width, this.doc.height]);
        }

        // The layer's pixels and where they land on the document, or null for a blank layer.
        source(record) {
            const o = this.overrides.get(record.id);
            if (o && o.canvas) return { canvas: o.canvas, toDocument: o.toDocument, transform: this.transformOf(record) };
            const image = this.doc.entry(record.id).image;
            if (!image) return null;
            const transform = this.transformOf(record);
            return { canvas: image, toDocument: Transform.pixelToDocument(transform, image.width, image.height), transform };
        }

        // A layer with visible effects draws its effects image instead (IO/ImageExporter.swift:52-60): its pixels through
        // its own mask with the effects around them, grown by the inset and placed by the grown transform, mask nil.
        // While its pixels are being painted or its mask edited live, it draws without them.
        effectsSource(record) {
            if (!record.effects || record.isGroup || record.adjustment) return null;
            const o = this.overrides.get(record.id);
            if (o && (o.mask || o.noMask)) return null;
            const entry = this.doc.entry(record.id);
            if (o && o.canvas) {
                // Wet paint: the effects follow it (LayerEffectsSurface); Smudge and Liquify, without that, draw none.
                if (!o.liveDirty) return null;
                const made = CB.Effects.liveEffects(record, o, entry.mask);
                return made && { canvas: made.canvas, toDocument: made.toDocument, transform: this.transformOf(record), effects: true };
            }
            CB.Effects.endLive(record.id);
            if (!entry.image) return null;
            const made = CB.Effects.effectsImage(entry.image, entry.mask, record, this.transformOf(record), [this.doc.width, this.doc.height]);
            if (!made) return null;
            return { canvas: made.canvas, toDocument: Transform.pixelToDocument(made.transform, made.canvas.width, made.canvas.height), transform: made.transform, effects: true };
        }

        frameOf(src) {
            const docRect = { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
            const box = Rect.intersect(Rect.integral(Affine.boundsOf(src.toDocument, { x: 0, y: 0, width: src.canvas.width, height: src.canvas.height })), docRect);
            return box;
        }

        drawPixels(ctx, src, frame) {
            ctx.save();
            Affine.setOn(ctx, Affine.translate(Affine.multiply({ a: 1, b: 0, c: 0, d: 1, e: -frame.x, f: -frame.y }, src.toDocument), 0, 0));
            setSmoothing(ctx, src.transform, src.canvas.width);
            ctx.drawImage(src.canvas, 0, 0);
            ctx.restore();
        }

        // destination-in with a mask's coverage. `placement`: the transform its gray grid is stretched over.
        applyMask(ctx, mask, placement, frame) {
            const m = Transform.pixelToDocument(placement, mask.width, mask.height);
            ctx.save();
            ctx.globalCompositeOperation = 'destination-in';
            Affine.setOn(ctx, Affine.multiply({ a: 1, b: 0, c: 0, d: 1, e: -frame.x, f: -frame.y }, m));
            setSmoothing(ctx, placement, mask.width);
            ctx.drawImage(mask.alpha, 0, 0);
            ctx.restore();
        }

        // A layer's own mask: linked masks cover the layer's rect; one placed apart covers its own rect, with the rest of
        // the layer at the mask's background (white or black).
        applyOwnMask(ctx, record, src, frame) {
            const live = this.overrides.get(record.id);
            // Text being edited shows without its mask (EditorCanvas.swift:997-1003).
            if (live && live.noMask) return;
            if (live && live.mask) {
                // A mask stroke in progress: its grid covers what it paints; the rest of the layer is at the background.
                const { canvas, toDocument, background } = live.mask;
                const cover = canvas2d(frame.width, frame.height);
                fillQuad(cover.ctx, frame, src.transform, background);
                cover.ctx.globalCompositeOperation = 'destination-out';
                fillMatrix(cover.ctx, frame, toDocument, canvas.width, canvas.height, 1);
                cover.ctx.globalCompositeOperation = 'source-over';
                cover.ctx.save();
                Affine.setOn(cover.ctx, Affine.multiply({ a: 1, b: 0, c: 0, d: 1, e: -frame.x, f: -frame.y }, toDocument));
                cover.ctx.drawImage(canvas, 0, 0);
                cover.ctx.restore();
                ctx.save();
                ctx.globalCompositeOperation = 'destination-in';
                ctx.drawImage(cover.canvas, 0, 0);
                ctx.restore();
                return;
            }
            const mask = this.doc.entry(record.id).mask;
            if (!mask || !record.maskFile || record.maskEnabled === false) return;
            // An unlinked mask being transformed on its own follows the drag.
            const placement = live && live.maskTransform ? live.maskTransform
                : record.maskPlacement && !samePlacement(record.maskPlacement, record.transform)
                    ? Transform.read(record.maskPlacement, [this.doc.width, this.doc.height]) : null;
            if (!placement) {
                this.applyMask(ctx, mask, src.transform, frame);
                return;
            }
            const cover = canvas2d(frame.width, frame.height);
            fillQuad(cover.ctx, frame, src.transform, maskBackground(mask));
            cover.ctx.globalCompositeOperation = 'destination-out';
            fillQuad(cover.ctx, frame, placement, 1);
            cover.ctx.globalCompositeOperation = 'source-over';
            const m = Transform.pixelToDocument(placement, mask.width, mask.height);
            cover.ctx.save();
            Affine.setOn(cover.ctx, Affine.multiply({ a: 1, b: 0, c: 0, d: 1, e: -frame.x, f: -frame.y }, m));
            setSmoothing(cover.ctx, placement, mask.width);
            cover.ctx.drawImage(mask.alpha, 0, 0);
            cover.ctx.restore();
            ctx.save();
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(cover.canvas, 0, 0);
            ctx.restore();
        }

        applyFolderMasks(ctx, record, frame, info) {
            for (const folder of info.ancestors(record)) {
                const mask = this.doc.entry(folder.id).mask;
                if (!mask || !folder.maskFile || folder.maskEnabled === false) continue;
                this.applyMask(ctx, mask, Transform.read(folder.transform, [this.doc.width, this.doc.height]), frame);
            }
        }

        // The coverage a clipping source gives (LiveMaskRenderer coverage): its alpha x effective opacity x own mask x its
        // own source's coverage, whatever its visibility or color, drawn into `ctx` over `frame`.
        drawCoverage(ctx, sourceID, frame, info, depth = 0) {
            const record = info.byID.get(sourceID);
            if (!record || depth > 256) return;
            const src = this.source(record);
            if (!src) return;
            const surface = canvas2d(frame.width, frame.height);
            this.drawPixels(surface.ctx, src, frame);
            this.applyOwnMask(surface.ctx, record, src, frame);
            if (record.maskSourceID) {
                const inner = canvas2d(frame.width, frame.height);
                this.drawCoverage(inner.ctx, record.maskSourceID, frame, info, depth + 1);
                surface.ctx.save();
                surface.ctx.globalCompositeOperation = 'destination-in';
                surface.ctx.drawImage(inner.canvas, 0, 0);
                surface.ctx.restore();
            }
            ctx.save();
            ctx.globalAlpha = info.opacityOf(record);
            ctx.drawImage(surface.canvas, 0, 0);
            ctx.restore();
        }

        // Composites a surface (in `frame`) onto the target in `mode` at `opacity`.
        composite(target, surface, frame, mode, opacity) {
            const op = Blend.native(mode);
            if (op) {
                target.save();
                target.setTransform(1, 0, 0, 1, 0, 0);
                target.globalAlpha = opacity;
                target.globalCompositeOperation = op;
                target.drawImage(surface, frame.x, frame.y);
                target.restore();
                return;
            }
            const dst = target.getImageData(frame.x, frame.y, frame.width, frame.height);
            const src = surface.getContext('2d').getImageData(0, 0, frame.width, frame.height);
            Blend.blendPixels(dst.data, src.data, mode, opacity);
            target.putImageData(dst, frame.x, frame.y);
        }

        drawLeaf(target, record, info) {
            const src = this.effectsSource(record) || this.source(record);
            if (!src) return;
            const frame = this.frameOf(src);
            if (!frame) return;
            const mode = this.blendOf(record);
            const opacity = info.opacityOf(record);
            const live = this.overrides.get(record.id);
            const hasMask = !src.effects && ((live && live.mask) || (record.maskFile && record.maskEnabled !== false && this.doc.entry(record.id).mask));
            const folderMasks = info.ancestors(record).some((f) => f.maskFile && f.maskEnabled !== false);
            if (!hasMask && !record.maskSourceID && !folderMasks && Blend.native(mode)) {
                // The plain case: straight onto the target, no intermediate surface.
                target.save();
                target.globalAlpha = opacity;
                target.globalCompositeOperation = Blend.native(mode);
                Affine.setOn(target, src.toDocument);
                setSmoothing(target, src.transform, src.canvas.width);
                target.drawImage(src.canvas, 0, 0);
                target.restore();
                return;
            }
            const surface = canvas2d(frame.width, frame.height);
            this.drawPixels(surface.ctx, src, frame);
            if (!src.effects) this.applyOwnMask(surface.ctx, record, src, frame);
            if (record.maskSourceID) {
                const cover = canvas2d(frame.width, frame.height);
                this.drawCoverage(cover.ctx, record.maskSourceID, frame, info);
                surface.ctx.save();
                surface.ctx.globalCompositeOperation = 'destination-in';
                surface.ctx.drawImage(cover.canvas, 0, 0);
                surface.ctx.restore();
            }
            this.applyFolderMasks(surface.ctx, record, frame, info);
            this.composite(target, surface.canvas, frame, mode, opacity);
        }

        // A clipping stack (LiveMaskRenderer, BrushPixels.c layer_unpremultiply_opaque / layer_restore_alpha): the
        // children blend against the base's colors only, the result takes the base's alpha and is composited once in
        // the base's mode.
        drawStack(target, base, members, info) {
            const src = this.effectsSource(base) || this.source(base);
            if (!src) return;
            const frame = this.frameOf(src);
            if (!frame) return;
            const surface = canvas2d(frame.width, frame.height);
            surface.ctx.save();
            surface.ctx.globalAlpha = info.opacityOf(base);
            this.drawPixels(surface.ctx, src, frame);
            surface.ctx.restore();
            // Apply the base's own mask at full strength: drawPixels drew at the base's opacity already.
            if (!src.effects) this.applyOwnMask(surface.ctx, base, src, frame);
            const image = surface.ctx.getImageData(0, 0, frame.width, frame.height);
            const d = image.data, alpha = new Uint8ClampedArray(frame.width * frame.height);
            for (let i = 0, p = 0; p < d.length; i++, p += 4) {
                alpha[i] = d[p + 3];
                if (d[p + 3] === 0) d[p] = d[p + 1] = d[p + 2] = 0;
                d[p + 3] = 255;
            }
            surface.ctx.putImageData(image, 0, 0);
            for (const child of members) {
                if (child.adjustment) {
                    this.drawStackAdjustment(surface, child, frame, info);
                    continue;
                }
                const childSrc = this.source(child);
                if (!childSrc) continue;
                const layer = canvas2d(frame.width, frame.height);
                this.drawPixels(layer.ctx, childSrc, frame);
                this.applyOwnMask(layer.ctx, child, childSrc, frame);
                this.composite(surface.ctx, layer.canvas, { x: 0, y: 0, width: frame.width, height: frame.height }, this.blendOf(child), info.opacityOf(child));
            }
            const out = surface.ctx.getImageData(0, 0, frame.width, frame.height);
            for (let i = 0, p = 0; p < out.data.length; i++, p += 4) {
                // layer_restore_alpha reads the surface's bytes as colors: where a blur child left it translucent, its
                // premultiplied colors are what get the base's alpha (BrushPixels.c:23-51).
                const a = out.data[p + 3];
                if (a < 255) for (let c = 0; c < 3; c++) out.data[p + c] = Math.round((out.data[p + c] * a) / 255);
                out.data[p + 3] = alpha[i];
            }
            surface.ctx.putImageData(out, 0, 0);
            this.applyFolderMasks(surface.ctx, base, frame, info);
            this.composite(target, surface.canvas, frame, this.blendOf(base), 1);
        }

        // An adjustment clipped into a stack adjusts the stack's surface only (LiveMaskRenderer.swift:93-110, 131-133): the
        // base made opaque and the children so far, with its own mask alone. Upstream's surface is the whole document,
        // opaque black outside the base, so a blur pulls black in at the base's edges: the surface is padded with black
        // for as far as the blur reads (adjustments-effects.md 2.6).
        drawStackAdjustment(surface, child, frame, info) {
            const adj = child.adjustment;
            if (CB.Adjust.changesNothing(adj, this.blendOf(child))) return;
            const r = CB.Adjust.resolved(adj);
            const sigma = adj.kind === 'Gaussian Blur' ? r.blurRadius : adj.kind === 'Motion Blur' ? r.motionDistance / Math.sqrt(12) : 0;
            if (!sigma) {
                CB.Adjust.drawAdjustment(this, surface.ctx, child, info, { docOrigin: { x: frame.x, y: frame.y }, inStack: true });
                return;
            }
            const reach = Math.ceil(Math.max(CB.Adjust.samplingMargin(adj), 4 * sigma + 2));
            const docRect = { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
            const padded = Rect.intersect(Rect.inflate(frame, reach), docRect);
            const work = canvas2d(padded.width, padded.height);
            work.ctx.fillStyle = '#000';
            work.ctx.fillRect(0, 0, padded.width, padded.height);
            work.ctx.drawImage(surface.canvas, frame.x - padded.x, frame.y - padded.y);
            CB.Adjust.drawAdjustment(this, work.ctx, child, info, { docOrigin: { x: padded.x, y: padded.y }, inStack: true });
            surface.ctx.save();
            surface.ctx.globalCompositeOperation = 'copy';
            surface.ctx.drawImage(work.canvas, frame.x - padded.x, frame.y - padded.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
            surface.ctx.restore();
        }

        // A top-level adjustment layer on the document composite (LiveMaskRenderer.adjust).
        drawAdjustmentLayer(ctx, record, info) {
            if (CB.Adjust.changesNothing(record.adjustment, this.blendOf(record))) return;
            CB.Adjust.drawAdjustment(this, ctx, record, info);
        }

        // What this board does not draw, so it can be said out loud rather than shown wrongly.
        unrendered(info) {
            const out = [];
            for (const l of info.list) {
                const image = this.doc.entry(l.id).image;
                if (image && image.deep && image.deep.startsWith('HDR')) out.push({ layer: l.name, what: 'HDR pixels (shown as a placeholder)' });
            }
            return out;
        }

        // Draws layers [from, to) of the draw order onto `ctx` (document pixels, identity transform).
        // `afterLayer(record, ctx)` runs after each drawn layer (the shape preview hangs above the active layer).
        render(ctx, { info = plan(this.doc.manifest), from = 0, to = info.list.length, afterLayer } = {}) {
            for (let i = from; i < to; i++) {
                const record = info.list[i];
                if (!info.stacked.has(record.id)) {
                    // An adjustment with a clipping source outside a stack (its base hidden or not right below) is
                    // skipped entirely (adjustments-effects.md 2.6).
                    if (record.adjustment) { if (!record.maskSourceID) this.drawAdjustmentLayer(ctx, record, info); }
                    else if (info.stacks.has(record.id)) this.drawStack(ctx, record, info.stacks.get(record.id), info);
                    else this.drawLeaf(ctx, record, info);
                }
                if (afterLayer) afterLayer(record, ctx, info);
            }
            return info;
        }

        // Where to split the draw order to cache everything below `id`: before the base of its clipping stack.
        splitIndex(info, id) {
            let index = info.list.findIndex((l) => l.id === id);
            if (index < 0) return info.list.length;
            while (index > 0 && info.stacked.has(info.list[index].id)) index--;
            return index;
        }
    }

    CB.Render = { Renderer, plan, canvas2d, maskBackground, samePlacement };
})();
