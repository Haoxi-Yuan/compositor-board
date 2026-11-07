'use strict';
// Compositor's selection tools and commands on the board (upstream Document/Selection.swift, MagicWand.swift,
// ObjectSelection.swift, ColorRangeSelection.swift, SelectionEdits.swift, SelectionClipboard.swift,
// FloatingSelection.swift, Rendering/EditorCanvas.swift lassoMouseDown and friends, UI/LassoControls.swift; derivation
// in docs/port-specs/selection.md). The interaction runs here; booleans, Magic, Object, Subject, Color Range and every
// pixel operation run in compositor-engine through the board, so their results are Compositor's own.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Selection, Transform, TransformTool, Affine, Rect, icon } = CB;

    const SELECTION_TOOLS = new Set(['marquee', 'lasso', 'wand']);
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

    const HINTS = {
        Rectangle: 'Drag a rectangle · Shift add · Option subtract · Shift again mid-drag square · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect',
        Ellipse: 'Drag an ellipse · Shift add · Option subtract · Shift again mid-drag circle · Drag inside to move · Delete clears · ⌘D deselect',
        Object: 'Click an object to select its outline · Tab for Wand · Shift add · Option subtract · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect',
        Wand: 'Click to select similar colors · Tab for Object · Shift add · Option subtract · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect',
        Freehand: 'Drag to select · Drag inside to move · Shift add · Option subtract · Delete clears · ⌥⌫/⌘⌫ fill · ⌘D deselect',
        Polygonal: 'Click corners · Click start, double-click or Enter to close · Delete removes corner · Escape cancel',
    };

    class SelectTools {
        constructor(board) {
            this.board = board;
            this.options = {
                marqueeKind: 'Rectangle', lassoKind: 'Freehand', wandMode: 'Wand', modeChoice: 'New', antialiased: true,
                wand: { tolerance: 32, sampleSize: 0, sampleAllLayers: false, contiguous: true },
                object: { sampleAllLayers: true, edgeOffset: 0 },
                expand: 1, contract: 1, feather: 2,
            };
            this.draft = null;
            this.outlineMove = null;
            this.pixelMove = null;
            this.floating = null;
            this.colorRange = null;
            this.phase = 0;
            this.heldShift = false;
            this.heldOption = false;
            this.lastPress = null;
            setInterval(() => this.tick(), 120);
        }

        isTool(tool) {
            return SELECTION_TOOLS.has(tool);
        }

        get selection() {
            return this.board.selection;
        }

        // What the ants show: the stored selection, shifted while an outline or pixels are dragged.
        displayed() {
            const sel = this.selection;
            if (!sel) return null;
            if (this.outlineMove && this.outlineMove.origin) {
                const o = this.outlineMove.offset || { x: 0, y: 0 };
                return { ...this.outlineMove.origin, path: Selection.translate(this.outlineMove.origin.path, o.x, o.y) };
            }
            if (this.pixelMove) return { ...sel, path: Selection.translate(sel.path, this.pixelMove.offset.x, this.pixelMove.offset.y) };
            if (this.floating) {
                const m = this.floatingMap();
                if (m) return { ...sel, path: Selection.mapped(sel.path, m) };
            }
            return sel;
        }

        tick() {
            const shown = this.displayed();
            if (!shown || Selection.isEmpty(shown)) return;
            this.phase = (this.phase + 1) % 8;
            this.board.view.drawOverlay();
        }

        // ⇧ adds, ⌥ (with or without ⇧) subtracts, otherwise the options bar's choice.
        modeFor(shift, option) {
            return option ? 'Subtract' : shift ? 'Add' : this.options.modeChoice;
        }

        hint(tool) {
            if (tool === 'marquee') return HINTS[this.options.marqueeKind];
            if (tool === 'lasso') return HINTS[this.options.lassoKind];
            return HINTS[this.options.wandMode];
        }

        cycle(tool) {
            this.cancelDraft();
            if (tool === 'marquee') this.options.marqueeKind = this.options.marqueeKind === 'Rectangle' ? 'Ellipse' : 'Rectangle';
            else if (tool === 'lasso') this.options.lassoKind = this.options.lassoKind === 'Freehand' ? 'Polygonal' : 'Freehand';
            else this.options.wandMode = this.options.wandMode === 'Wand' ? 'Object' : 'Wand';
        }

        cancelDraft() {
            this.draft = null;
            this.board.view.guides = { xs: [], ys: [] };
            this.board.view.drawOverlay();
        }

        // The pointer was lost mid-drag (Escape, focus): drop the outline or pixel drag without an undo step. A polygon
        // survives, as losing focus does not cancel it in Compositor.
        cancelPointer() {
            const board = this.board;
            this.outlineMove = null;
            if (this.pixelMove) {
                board.renderer.overrides.delete(this.pixelMove.layerID);
                this.pixelMove = null;
                board.endLive();
                board.changed();
            }
            if (this.draft && this.draft.kind !== 'Polygonal') this.draft = null;
            board.view.guides = { xs: [], ys: [] };
            board.view.drawOverlay();
        }

        // Held ⇧ / ⌥ show in the options bar's New / Add / Subtract control while no outline is being drawn; ⌘ turns the
        // cursor over the selection into scissors.
        // HeldModifiers (UI/HeldModifiers.swift): keys held while typing in a text field do not count, and nothing is
        // held after the window loses focus or a menu closes.
        heldModifiers(e) {
            const typing = CB.isTyping(document.activeElement);
            const shift = !typing && e.shiftKey, option = !typing && e.altKey, command = !typing && (e.metaKey || e.ctrlKey);
            const view = this.board.view;
            view.mods = { shiftKey: shift, altKey: option, metaKey: e.metaKey, ctrlKey: e.ctrlKey };
            if (this.board.layers) this.board.layers.modifiersChanged(e);
            if (this.heldShift === shift && this.heldOption === option && this.heldCommand === command) return;
            this.heldShift = shift;
            this.heldOption = option;
            this.heldCommand = command;
            view.cursor();
            // The Move header shows Auto Select and the aspect lock as they act while ⌘ or ⇧ is held (HeldModifiers).
            if (this.board.tool === 'move') {
                const settings = this.board.settings;
                const auto = this.board.optionsEl.querySelector('.auto-select');
                if (auto) auto.checked = settings.autoSelect !== command;
                const lock = this.board.optionsEl.querySelector('.lock');
                if (lock) lock.innerHTML = CB.icon(settings.lockRatio !== shift ? 'link' : 'unlink');
            }
            // A Marquee being dragged reshapes as Shift changes, without the mouse moving (EditorCanvas.flagsChanged).
            const d = this.draft;
            if (d && (d.kind === 'Rectangle' || d.kind === 'Ellipse') && this.board.view.drag) {
                if (!shift) d.armed = true;
                this.reshapeMarquee(shift);
                this.board.view.drawOverlay();
            }
            // Color Range highlights the eyedropper a click will use.
            const cr = this.colorRange;
            if (cr && cr.element) {
                const mode = option ? 'Remove' : shift ? 'Add' : cr.sampleMode;
                cr.element.querySelectorAll('[data-cr-mode]').forEach((b) => b.classList.toggle('on', b.dataset.crMode === mode));
                this.board.view.cursor();
            }
            if (!this.isTool(this.board.tool)) return;
            const shown = this.draft ? this.draft.mode : this.modeFor(shift, option);
            this.board.optionsEl.querySelectorAll('[data-select-mode]').forEach((b) => b.classList.toggle('on', b.dataset.selectMode === shown));
            this.board.view.cursor();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Pointer (EditorCanvas.lassoMouseDown, mouseDragged, mouseUp)

        down(doc, screen, e) {
            const board = this.board, tool = board.tool;
            if (e.button !== 0) return;
            const now = performance.now();
            const double = this.lastPress && now - this.lastPress.time < 450 && Math.hypot(screen.x - this.lastPress.x, screen.y - this.lastPress.y) < 5;
            this.lastPress = { time: now, x: screen.x, y: screen.y };
            const mode = this.modeFor(e.shiftKey, e.altKey);
            const sel = this.selection;
            // 1. A polygon in progress: close it, or add a corner.
            if (this.draft && this.draft.kind === 'Polygonal') {
                const first = board.view.toScreen(this.draft.points[0]);
                if (double || (this.draft.points.length >= 3 && Math.hypot(screen.x - first.x, screen.y - first.y) <= 8)) this.finishDraft();
                else this.extend(doc);
                return;
            }
            // 2. ⌘ inside the selection moves its pixels (⌘⌥ duplicates them).
            if ((e.metaKey || e.ctrlKey) && sel && Selection.contains(sel, doc.x, doc.y)) {
                this.beginPixelMove(doc, e.altKey);
                return;
            }
            // 3. New mode inside the selection drags the outline.
            if (mode === 'New' && sel && Selection.contains(sel, doc.x, doc.y)) {
                this.outlineMove = { start: doc, origin: sel, offset: null, press: doc };
                return;
            }
            if (tool === 'wand') {
                if (this.options.wandMode === 'Object') this.object(doc, mode);
                else this.wand(doc, mode);
                return;
            }
            const start = tool === 'marquee' ? this.snapped(doc, e) : doc;
            if (tool === 'marquee') {
                const anchor = { x: roundHalfAway(start.x), y: roundHalfAway(start.y) };
                this.draft = { kind: this.options.marqueeKind, points: [anchor], anchor, box: null, mode, armed: !e.shiftKey };
            } else {
                this.draft = { kind: this.options.lassoKind, points: [doc], cursor: null, mode };
            }
            board.view.drawOverlay();
        }

        move(doc, screen, e) {
            if (this.draft && this.draft.kind === 'Polygonal') {
                this.draft.cursor = doc;
                this.board.view.drawOverlay();
                return;
            }
            if (!this.board.view.drag) return;
            if (this.outlineMove) return this.dragOutline(doc, e);
            if (this.pixelMove) return this.dragPixels(doc, e);
            if (!this.draft) return;
            if (this.draft.kind === 'Rectangle' || this.draft.kind === 'Ellipse') {
                if (!e.shiftKey) this.draft.armed = true;
                this.draft.last = this.snapped(doc, e);
                this.reshapeMarquee(e.shiftKey);
            } else this.extend(doc);
            this.board.view.drawOverlay();
        }

        reshapeMarquee(shift) {
            const d = this.draft;
            if (!d || !d.last) return;
            const box = CB.Shapes.dragBox(d.anchor, d.last, d.armed && shift, false);
            d.box = box;
            d.points = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }];
        }

        up(doc, screen, e) {
            if (this.outlineMove) return this.endOutline();
            if (this.pixelMove) return this.endPixels();
            if (this.draft && this.draft.kind !== 'Polygonal') this.finishDraft();
        }

        // A Marquee corner snapped to the canvas edges, layer edges and guides within 10 screen points (⌃ off).
        snapped(doc, e) {
            const view = this.board.view;
            if (e.ctrlKey) { view.guides = { xs: [], ys: [] }; return doc; }
            const snap = TransformTool.snappedPoint(doc, this.board.snapTargets(null, false), TransformTool.SNAP_DISTANCE / Math.max(view.ppp, 0.0001));
            view.guides = snap.guides;
            return snap.point;
        }

        extend(doc) {
            const d = this.draft;
            const last = d.points[d.points.length - 1];
            if (last && Math.hypot(doc.x - last.x, doc.y - last.y) < 0.25) return;
            d.points.push(doc);
        }

        outline(d) {
            if (d.kind === 'Ellipse') return d.box ? Selection.ellipsePath(d.box.x, d.box.y, d.box.width, d.box.height) : [];
            if (d.kind === 'Rectangle') return d.box ? Selection.rectPath(d.box.x, d.box.y, d.box.width, d.box.height) : [];
            return Selection.polygonPath(d.points);
        }

        finishDraft() {
            const d = this.draft;
            this.draft = null;
            this.board.view.guides = { xs: [], ys: [] };
            if (!d) return;
            const shape = this.outline(d);
            const b = Selection.pathBounds(shape);
            const enough = d.kind === 'Ellipse' || d.kind === 'Rectangle' ? Boolean(d.box) : d.points.length >= 3;
            if (!enough || !b || b.width <= 0 || b.height <= 0) {
                if (d.mode === 'New') this.deselect();
                this.board.view.drawOverlay();
                return;
            }
            const label = { Rectangle: 'Rectangular Marquee', Ellipse: 'Elliptical Marquee', Freehand: 'Lasso', Polygonal: 'Polygonal Lasso' }[d.kind];
            this.combine(shape, d.mode, label);
        }

        combine(shape, mode, label) {
            const doc = this.board.doc;
            return this.board.selectionOp('selection.combine', { width: doc.width, height: doc.height, shape, mode, antialiased: this.options.antialiased }, label, { stateless: true });
        }

        dragOutline(doc, e) {
            const m = this.outlineMove;
            let dx = doc.x - m.start.x, dy = doc.y - m.start.y;
            if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
            dx = roundHalfAway(dx);
            dy = roundHalfAway(dy);
            const view = this.board.view;
            view.guides = { xs: [], ys: [] };
            if (!e.ctrlKey) {
                const b = Selection.pathBounds(m.origin.path);
                if (b) {
                    const targets = this.board.snapTargets(null, false);
                    const tolerance = TransformTool.SNAP_DISTANCE / Math.max(view.ppp, 0.0001);
                    const box = { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height, rotation: 0, flipX: false, flipY: false };
                    const snap = TransformTool.snappedMove(box, { xs: e.shiftKey && dx === 0 ? [] : targets.xs, ys: e.shiftKey && dy === 0 ? [] : targets.ys }, tolerance);
                    dx = roundHalfAway(dx + snap.draft.x - box.x);
                    dy = roundHalfAway(dy + snap.draft.y - box.y);
                    view.guides = snap.guides;
                }
            }
            m.offset = { x: dx, y: dy };
            view.drawOverlay();
        }

        endOutline() {
            const m = this.outlineMove;
            this.outlineMove = null;
            this.board.view.guides = { xs: [], ys: [] };
            const moved = m.offset && (m.offset.x || m.offset.y);
            if (moved) {
                this.board.setSelection({ ...m.origin, path: Selection.translate(m.origin.path, m.offset.x, m.offset.y) }, 'Move Selection');
            } else if (this.board.tool === 'wand') {
                // A click inside the selection with the Magic tool selects afresh from that pixel.
                if (this.options.wandMode === 'Object') this.object(m.press, 'New');
                else this.wand(m.press, 'New');
            } else {
                // A click without a drag deselects, as anywhere else with the Marquee or Lasso.
                this.deselect();
            }
            this.board.view.drawOverlay();
        }

        nudge(dx, dy) {
            const sel = this.selection;
            if (!sel || Selection.isEmpty(sel) || this.draft) return false;
            this.board.setSelection({ ...sel, path: Selection.translate(sel.path, dx, dy) }, 'Move Selection');
            return true;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Moving selected pixels (⌘-drag): a live preview of the lifted pixels; the engine commits.

        beginPixelMove(doc, duplicate) {
            const board = this.board;
            const record = board.doc.layer(board.activeID());
            const refusal = board.paintRefusal(record);
            if (refusal || !board.doc.entry(record.id).image) {
                board.toast(refusal || 'There are no pixels on this layer to move.');
                return;
            }
            const W = board.doc.width, H = board.doc.height;
            const image = board.doc.entry(record.id).image;
            const t = Transform.read(record.transform, [W, H]);
            const layer = new OffscreenCanvas(W, H);
            const lctx = layer.getContext('2d');
            const toDocument = Transform.pixelToDocument(t, image.width, image.height);
            Affine.setOn(lctx, toDocument);
            lctx.drawImage(image, 0, 0);
            lctx.setTransform(1, 0, 0, 1, 0, 0);
            const clip = Selection.clip(this.selection, W, H);
            if (!clip.cov) return;
            // liftSelection (BrushStroke.swift:789-793): a selection that misses the layer's pixels lifts nothing.
            const toLayer = Affine.invert(toDocument);
            if (!toLayer || !Rect.intersect(Rect.integral(Affine.boundsOf(toLayer, clip.rect)), { x: 0, y: 0, width: image.width, height: image.height })) {
                board.toast('There are no pixels under the selection on this layer to move.');
                return;
            }
            const mask = new OffscreenCanvas(clip.rect.width, clip.rect.height);
            const data = new ImageData(clip.rect.width, clip.rect.height);
            for (let i = 0; i < clip.cov.length; i++) data.data[i * 4 + 3] = clip.cov[i];
            mask.getContext('2d').putImageData(data, 0, 0);
            const lifted = new OffscreenCanvas(clip.rect.width, clip.rect.height);
            const fctx = lifted.getContext('2d');
            fctx.drawImage(layer, -clip.rect.x, -clip.rect.y);
            fctx.globalCompositeOperation = 'destination-in';
            fctx.drawImage(mask, 0, 0);
            const base = new OffscreenCanvas(W, H);
            const bctx = base.getContext('2d');
            bctx.drawImage(layer, 0, 0);
            if (!duplicate) {
                bctx.globalCompositeOperation = 'destination-out';
                bctx.drawImage(mask, clip.rect.x, clip.rect.y);
            }
            this.pixelMove = { start: doc, offset: { x: 0, y: 0 }, duplicate, lifted, base, rect: clip.rect, layerID: record.id, preview: new OffscreenCanvas(W, H) };
            board.beginLive(record.id);
            this.showPixels();
        }

        dragPixels(doc, e) {
            const m = this.pixelMove;
            let dx = doc.x - m.start.x, dy = doc.y - m.start.y;
            if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
            m.offset = { x: roundHalfAway(dx), y: roundHalfAway(dy) };
            this.showPixels();
        }

        showPixels() {
            const m = this.pixelMove;
            const ctx = m.preview.getContext('2d');
            ctx.clearRect(0, 0, m.preview.width, m.preview.height);
            ctx.drawImage(m.base, 0, 0);
            ctx.drawImage(m.lifted, m.rect.x + m.offset.x, m.rect.y + m.offset.y);
            this.board.renderer.overrides.set(m.layerID, { canvas: m.preview, toDocument: Affine.identity() });
            this.board.liveChanged();
        }

        async endPixels() {
            const m = this.pixelMove;
            this.board.renderer.overrides.delete(m.layerID);
            this.board.endLive();
            if (!m.offset.x && !m.offset.y) { this.pixelMove = null; return; }
            // Keep the preview until the engine's result arrives, so the pixels do not jump back meanwhile.
            this.board.renderer.overrides.set(m.layerID, { canvas: m.preview, toDocument: Affine.identity() });
            try {
                await this.board.selectionOp('selection.movePixels', { dx: m.offset.x, dy: m.offset.y, duplicate: m.duplicate }, m.duplicate ? 'Duplicate Pixels' : 'Move Pixels');
            } finally {
                this.board.renderer.overrides.delete(m.layerID);
                this.pixelMove = null;
                this.board.changed();
            }
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Transform Selection (⌘T with a selection): the lifted pixels float above their layer under the Move tool's
        // handles; Return applies through the engine, Escape puts everything back.

        async beginFloating() {
            const board = this.board;
            const record = board.doc.layer(board.activeID());
            if (!record || !this.selection || Selection.isEmpty(this.selection)) return;
            let result;
            try {
                result = await board.engine('selection.float', { selection: this.selection }, { files: { out: 'png' } });
            } catch (error) {
                board.toast(error.message);
                return;
            }
            const image = await CB.Document.decodeToCanvas(result.files.out);
            const original = { x: result.origin[0], y: result.origin[1], width: result.size[0], height: result.size[1], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
            const W = board.doc.width, H = board.doc.height;
            // The source shown with the lifted pixels cut out, as the app clears them before floating.
            const entry = board.doc.entry(record.id);
            const holed = new OffscreenCanvas(W, H);
            const hctx = holed.getContext('2d');
            Affine.setOn(hctx, Transform.pixelToDocument(Transform.read(record.transform, [W, H]), entry.image.width, entry.image.height));
            hctx.drawImage(entry.image, 0, 0);
            hctx.setTransform(1, 0, 0, 1, 0, 0);
            const clip = Selection.clip(this.selection, W, H);
            if (clip.cov) {
                const data = new ImageData(clip.rect.width, clip.rect.height);
                for (let i = 0; i < clip.cov.length; i++) data.data[i * 4 + 3] = clip.cov[i];
                const mask = new OffscreenCanvas(clip.rect.width, clip.rect.height);
                mask.getContext('2d').putImageData(data, 0, 0);
                hctx.globalCompositeOperation = 'destination-out';
                hctx.drawImage(mask, clip.rect.x, clip.rect.y);
            }
            board.renderer.overrides.set(record.id, { canvas: holed, toDocument: Affine.identity() });
            this.floating = { image, original, draft: { ...original }, sourceID: record.id };
            board.selectTool('move');
            board.changed();
        }

        floatingMap() {
            const f = this.floating;
            if (!f) return null;
            const from = Transform.pixelToDocument(f.original, f.image.width, f.image.height);
            const to = Transform.pixelToDocument(f.draft, f.image.width, f.image.height);
            return Affine.multiply(to, Affine.invert(from));
        }

        // The floating pixels drawn right above their source layer (renderer afterLayer hook).
        drawFloating(record, ctx, info) {
            const f = this.floating;
            if (!f || record.id !== f.sourceID) return;
            const pseudo = { ...record, id: '__floating', transform: Transform.write(f.draft), maskFile: undefined, maskSourceID: undefined, effects: undefined };
            this.board.doc.entry('__floating').image = f.image;
            this.board.renderer.drawLeaf(ctx, pseudo, info);
        }

        async commitFloating() {
            const f = this.floating;
            if (!f) return;
            const unchanged = ['x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY'].every((k) => f.draft[k] === f.original[k]);
            this.floating = null;
            if (unchanged) {
                this.board.renderer.overrides.delete(f.sourceID);
                this.board.changed();
                return;
            }
            try {
                await this.board.selectionOp('selection.transform', { draft: Transform.write(f.draft), activeLayerID: f.sourceID }, 'Transform Selection');
            } finally {
                this.board.renderer.overrides.delete(f.sourceID);
                this.board.changed();
            }
        }

        cancelFloating() {
            const f = this.floating;
            if (!f) return false;
            this.floating = null;
            this.board.renderer.overrides.delete(f.sourceID);
            this.board.changed();
            return true;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Commands

        selectAll() {
            const doc = this.board.doc;
            this.board.setSelection({ path: Selection.rectPath(0, 0, doc.width, doc.height), antialiased: true, feather: 0 }, 'Select All');
        }

        deselect() {
            if (this.selection) this.board.setSelection(null, 'Deselect');
        }

        inverse() {
            if (!this.selection) return;
            const doc = this.board.doc;
            this.board.selectionOp('selection.invert', { width: doc.width, height: doc.height }, 'Inverse', { stateless: true });
        }

        canModify() {
            return Boolean(this.selection && !Selection.isEmpty(this.selection) && !this.draft);
        }

        resize(kind, amount) {
            if (!this.canModify()) return;
            const doc = this.board.doc;
            const n = Math.max(1, Math.min(500, Math.round(amount)));
            this.options[kind] = n;
            this.board.selectionOp(`selection.${kind}`, { width: doc.width, height: doc.height, amount: n }, kind === 'expand' ? 'Expand Selection' : 'Contract Selection', { stateless: true });
        }

        // Feathers stack like Gaussian blurs: √(f² + a²), at most 250.
        feather(amount) {
            if (!this.canModify()) return;
            const n = Math.max(1, Math.min(250, Math.round(amount)));
            this.options.feather = n;
            const sel = this.selection;
            this.board.setSelection({ ...sel, feather: Math.min(250, Math.sqrt(sel.feather * sel.feather + n * n)) }, 'Feather Selection');
        }

        wand(doc, mode) {
            const o = this.options.wand;
            if (doc.x < 0 || doc.y < 0 || doc.x >= this.board.doc.width || doc.y >= this.board.doc.height) return;
            this.board.selectionOp('selection.wand', { point: [doc.x, doc.y], mode, ...o, antialiased: this.options.antialiased }, 'Magic Wand');
        }

        object(doc, mode) {
            const o = this.options.object;
            if (doc.x < 0 || doc.y < 0 || doc.x >= this.board.doc.width || doc.y >= this.board.doc.height) return;
            this.board.selectionOp('selection.object', { point: [doc.x, doc.y], mode, ...o, antialiased: this.options.antialiased }, 'Object Selection');
        }

        subject() {
            this.board.selectionOp('selection.subject', { mode: 'New', antialiased: this.options.antialiased }, 'Select Subject');
        }

        loadLayer(layerID, mode = 'New') {
            this.board.selectionOp('selection.loadLayer', { layerID, mode, antialiased: this.options.antialiased }, 'Load Layer Selection');
        }

        loadMask(layerID, mode = 'New') {
            this.board.selectionOp('selection.loadMask', { layerID, mode, antialiased: this.options.antialiased }, 'Load Mask Selection');
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Overlay: ants, the outline being drawn, the polygon's first-corner handle.

        drawOverlay(ctx) {
            const view = this.board.view;
            const o = view.origin(), ppp = view.ppp;
            const toScreen = { a: ppp, b: 0, c: 0, d: ppp, e: o.x, f: o.y };
            const shown = this.displayed();
            if (shown && !Selection.isEmpty(shown)) Selection.drawAnts(ctx, shown.path, toScreen, this.phase);
            const d = this.draft;
            if (!d) return;
            const pts = d.points.map((p) => view.toScreen(p));
            if (d.kind === 'Polygonal' && d.cursor) pts.push(view.toScreen(d.cursor));
            const path = new Path2D();
            if (d.kind === 'Ellipse' && d.box) {
                const a = view.toScreen({ x: d.box.x, y: d.box.y });
                path.ellipse(a.x + (d.box.width * ppp) / 2, a.y + (d.box.height * ppp) / 2, (d.box.width * ppp) / 2, (d.box.height * ppp) / 2, 0, 0, Math.PI * 2);
            } else if (pts.length) {
                path.moveTo(pts[0].x, pts[0].y);
                for (const p of pts.slice(1)) path.lineTo(p.x, p.y);
                if (d.kind === 'Rectangle') path.closePath();
            }
            ctx.save();
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.lineWidth = 2;
            ctx.stroke(path);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke(path);
            if (d.kind === 'Polygonal' && pts.length) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(pts[0].x - 4, pts[0].y - 4, 8, 8);
                ctx.strokeStyle = '#000000';
                ctx.strokeRect(pts[0].x - 4, pts[0].y - 4, 8, 8);
            }
            ctx.restore();
        }

        // EditorCanvas.lassoCursor: an outline or pixel drag first, then the cursor over the selection, then the tool's.
        cursor(doc, e) {
            if (this.outlineMove) return CURSORS.moveSelection;
            if (this.pixelMove) return this.pixelMove.duplicate ? CURSORS.duplicate : CURSORS.scissors;
            const sel = this.selection, cmd = e.metaKey || e.ctrlKey;
            const mode = this.draft ? this.draft.mode : this.modeFor(e.shiftKey, e.altKey);
            if (!this.draft && sel && (cmd || mode === 'New') && Selection.contains(sel, doc.x, doc.y)) {
                if (cmd) return e.altKey ? CURSORS.duplicate : CURSORS.scissors;
                return CURSORS.moveSelection;
            }
            const tool = this.board.tool;
            if (tool === 'wand' && this.options.wandMode === 'Wand') return CURSORS.wand(mode);
            const glyph = tool === 'marquee' ? (this.options.marqueeKind === 'Ellipse' ? 'ellipseMarquee' : 'marquee')
                : tool === 'lasso' ? (this.options.lassoKind === 'Polygonal' ? 'polygonLasso' : 'lasso') : 'objectSelect';
            return CURSORS.crosshair(glyph, mode);
        }

        // Color Range's canvas cursor: the eyedropper with the badge of the mode a click will use.
        colorRangeCursor(e) {
            const cr = this.colorRange;
            const mode = e.altKey ? 'Remove' : e.shiftKey ? 'Add' : cr ? cr.sampleMode : 'Sample';
            return CURSORS.eyedropper(mode);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Keys while a selection tool is active (EditorCanvas.keyDown for lasso drafts)

        key(e) {
            const d = this.draft;
            if (e.code === 'Escape') {
                if (d) { this.cancelDraft(); return true; }
                if (this.colorRange) { this.closeColorRange(false); return true; }
                return false;
            }
            if (d && (e.code === 'Enter' || e.code === 'NumpadEnter') && d.kind === 'Polygonal') { this.finishDraft(); return true; }
            if (d && (e.code === 'Backspace' || e.code === 'Delete')) {
                d.points.pop();
                if (!d.points.length) this.draft = null;
                this.board.view.drawOverlay();
                return true;
            }
            return false;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Options bar (UI/LassoControls.swift)

        optionsHTML(tool) {
            const o = this.options;
            const seg = (name, values, current) => `<span class="segmented">${values.map((v) => `<button data-${name}="${v}" class="${current === v ? 'on' : ''}">${v}</button>`).join('')}</span>`;
            const shown = this.draft ? this.draft.mode : this.modeFor(this.heldShift, this.heldOption);
            let html = `<span class="title">${tool === 'marquee' ? 'Marquee' : tool === 'lasso' ? 'Lasso' : 'Magic'}</span>`;
            if (tool === 'marquee') html += `<span title="Press M to switch between Rectangle and Ellipse">${seg('marquee-kind', ['Rectangle', 'Ellipse'], o.marqueeKind)}</span>`;
            if (tool === 'wand') html += `<span title="Press Tab to switch between Wand and Object">${seg('wand-mode', ['Wand', 'Object'], o.wandMode)}</span>`;
            if (tool === 'lasso') html += `<span title="Press L to switch between Freehand and Polygonal">${seg('lasso-kind', ['Freehand', 'Polygonal'], o.lassoKind)}</span>`;
            html += `<span title="Hold Shift to add or Option to subtract for one outline">${seg('select-mode', ['New', 'Add', 'Subtract'], shown)}</span>`;
            if (tool === 'wand' && o.wandMode === 'Wand') {
                html += `<span class="group" title="How far each color channel (0–255) can differ from the clicked color and still be selected"><label class="caption" data-scrub-wand="tolerance">Tolerance</label><input class="num" data-wand="tolerance" style="width:44px" value="${o.wand.tolerance}"></span>
                    <select class="pop" data-wand-select="sampleSize" title="Match the clicked pixel, or the average of the pixels around it">${['Point Sample', '3 by 3 Average', '5 by 5 Average'].map((t, i) => `<option value="${i}" ${o.wand.sampleSize === i ? 'selected' : ''}>${t}</option>`).join('')}</select>
                    <span title="Read colors from the active layer only, or from every visible layer as shown">${seg('wand-layers', ['This Layer', 'All Layers'], o.wand.sampleAllLayers ? 'All Layers' : 'This Layer')}</span>
                    <label class="check" title="Select only similar pixels connected to the one you click; off selects them everywhere"><input type="checkbox" data-wand-check="contiguous" ${o.wand.contiguous ? 'checked' : ''}> Contiguous</label>`;
            }
            if (tool === 'wand' && o.wandMode === 'Object') {
                html += `<span title="Analyze the active layer only, or every visible layer as shown">${seg('object-layers', ['This Layer', 'All Layers'], o.object.sampleAllLayers ? 'All Layers' : 'This Layer')}</span>
                    <span class="group" title="Positive values tighten the detected mask inward; negative values expand it outward"><label class="caption" data-scrub-object="edgeOffset">Edge</label><input class="num" data-object="edgeOffset" style="width:40px" value="${o.object.edgeOffset}"><span class="unit">px</span></span>`;
            }
            if (!(tool === 'marquee' && o.marqueeKind === 'Rectangle')) {
                const help = tool === 'wand' && o.wandMode === 'Object' ? 'Smooth the detected object outline; turn off for the raw pixel mask' : 'Smooth selection edges; turn off for hard pixel edges';
                html += `<label class="check" title="${help}"><input type="checkbox" class="sel-antialias" ${o.antialiased ? 'checked' : ''}> Anti-alias</label>`;
            }
            const can = this.canModify();
            html += `<span class="divider"></span>
                <span class="group" title="Expand the selection by this many pixels"><button class="pill" data-resize="expand" ${can ? '' : 'disabled'}>Expand</button><input class="num" data-amount="expand" style="width:40px" value="${o.expand}" ${can ? '' : 'disabled'}><span class="unit scrub" data-scrub-amount="expand">px</span></span>
                <span class="group" title="Contract the selection by this many pixels"><button class="pill" data-resize="contract" ${can ? '' : 'disabled'}>Contract</button><input class="num" data-amount="contract" style="width:40px" value="${o.contract}" ${can ? '' : 'disabled'}><span class="unit scrub" data-scrub-amount="contract">px</span></span>
                <span class="group"><button class="pill" data-resize="feather" title="Fade the edge of the selection by this many pixels" ${can ? '' : 'disabled'}>Feather</button><input class="num" data-amount="feather" style="width:48px" value="${o.feather}" ${can ? '' : 'disabled'}><span class="unit scrub" data-scrub-amount="feather">px</span></span>`;
            if (this.selection && Selection.isEmpty(this.selection)) html += '<span style="color:var(--text2)">Empty selection</span>';
            if (this.selection) html += '<button class="pill deselect">Deselect</button>';
            return html;
        }

        bindOptions(el) {
            const o = this.options;
            const on = (selector, event, fn) => el.querySelectorAll(selector).forEach((n) => n.addEventListener(event, fn));
            const rerender = () => this.board.renderOptions(true);
            on('[data-marquee-kind]', 'click', (e) => { this.cancelDraft(); o.marqueeKind = e.currentTarget.dataset.marqueeKind; this.board.toolChanged(); });
            on('[data-lasso-kind]', 'click', (e) => { this.cancelDraft(); o.lassoKind = e.currentTarget.dataset.lassoKind; this.board.toolChanged(); });
            on('[data-wand-mode]', 'click', (e) => { this.cancelDraft(); o.wandMode = e.currentTarget.dataset.wandMode; this.board.toolChanged(); });
            on('[data-select-mode]', 'click', (e) => { o.modeChoice = e.currentTarget.dataset.selectMode; rerender(); });
            on('[data-wand-layers]', 'click', (e) => { o.wand.sampleAllLayers = e.currentTarget.dataset.wandLayers === 'All Layers'; rerender(); });
            on('[data-object-layers]', 'click', (e) => { o.object.sampleAllLayers = e.currentTarget.dataset.objectLayers === 'All Layers'; rerender(); });
            on('[data-wand-check]', 'change', (e) => { o.wand.contiguous = e.target.checked; });
            on('[data-wand-select]', 'change', (e) => { o.wand.sampleSize = Number(e.target.value); });
            on('.sel-antialias', 'change', (e) => { o.antialiased = e.target.checked; });
            // Number fields only correct their own text, so focus stays for the next arrow step.
            on('[data-wand]', 'change', (e) => { o.wand.tolerance = clampInt(e.target.value, 0, 255, 32); e.target.value = o.wand.tolerance; });
            on('[data-object]', 'change', (e) => { o.object.edgeOffset = clampInt(e.target.value, -10, 10, 0); e.target.value = o.object.edgeOffset; });
            on('[data-amount]', 'change', (e) => {
                const kind = e.target.dataset.amount;
                o[kind] = clampInt(e.target.value, 1, kind === 'feather' ? 250 : 500, kind === 'feather' ? 2 : 1);
                e.target.value = o[kind];
            });
            on('[data-resize]', 'click', (e) => {
                const kind = e.currentTarget.dataset.resize;
                if (kind === 'feather') this.feather(o.feather);
                else this.resize(kind, o[kind]);
            });
            on('.deselect', 'click', () => this.deselect());
            const scrub = (selector, key, apply) => el.querySelectorAll(selector).forEach((label) => label.addEventListener('pointerdown', (e) => {
                label.setPointerCapture(e.pointerId);
                const start = e.clientX, from = key();
                label.onpointermove = (m) => apply(from + Math.round(m.clientX - start));
                label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; rerender(); };
            }));
            scrub('[data-scrub-wand]', () => o.wand.tolerance, (v) => { o.wand.tolerance = Math.max(0, Math.min(255, v)); el.querySelector('[data-wand]').value = o.wand.tolerance; });
            el.querySelectorAll('[data-scrub-amount]').forEach((unit) => {
                const kind = unit.dataset.scrubAmount, max = kind === 'feather' ? 250 : 500;
                scrub(`[data-scrub-amount="${kind}"]`, () => o[kind], (v) => { o[kind] = Math.max(1, Math.min(max, v)); el.querySelector(`[data-amount="${kind}"]`).value = o[kind]; });
            });
            scrub('[data-scrub-object]', () => o.object.edgeOffset, (v) => { o.object.edgeOffset = Math.max(-10, Math.min(10, v)); el.querySelector('[data-object]').value = o.object.edgeOffset; });
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Select › Expand… / Contract… / Feather… (SelectionAmountSheet)

        amountPanel(kind) {
            if (!this.canModify()) return;
            const max = kind === 'feather' ? 250 : 500;
            const title = { expand: 'Expand Selection', contract: 'Contract Selection', feather: 'Feather Selection' }[kind];
            this.board.panel(title, `
                <div class="panel-row"><label class="caption scrub amount-label" style="min-width:60px">Amount</label><input type="range" min="1" max="${max}" value="${this.options[kind]}" class="amount-range"><input class="num amount-field" value="${this.options[kind]}" style="width:56px"><span class="unit">px</span></div>
                <div class="panel-hint">Enter a whole number from 1 to ${max} px.</div>`, (el) => {
                const range = el.querySelector('.amount-range'), field = el.querySelector('.amount-field'), hint = el.querySelector('.panel-hint'), ok = el.querySelector('.ok');
                const valid = () => /^\d+$/.test(field.value.trim()) && Number(field.value) >= 1 && Number(field.value) <= max;
                const sync = () => { hint.style.opacity = valid() ? 0 : 1; ok.disabled = !valid(); };
                range.addEventListener('input', () => { field.value = range.value; sync(); });
                field.addEventListener('input', () => { if (valid()) range.value = field.value; sync(); });
                const label = el.querySelector('.amount-label');
                label.addEventListener('pointerdown', (e) => {
                    label.setPointerCapture(e.pointerId);
                    const start = e.clientX, from = valid() ? Number(field.value) : 1;
                    label.onpointermove = (m) => { field.value = range.value = Math.max(1, Math.min(max, from + Math.round(m.clientX - start))); sync(); };
                    label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; };
                });
                sync();
                return () => {
                    if (!valid()) return false;
                    const n = Number(field.value);
                    if (kind === 'feather') this.feather(n);
                    else this.resize(kind, n);
                    return true;
                };
            });
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Select › Color Range… (ColorRangeSelection.swift, UI/ColorRangeSheet.swift)

        openColorRange() {
            if (this.colorRange) return;
            this.colorRange = { original: this.selection, include: [], exclude: [], fuzziness: 40, invert: false, sampleMode: 'Sample', serial: 0 };
            const cr = this.colorRange;
            this.board.panel('Color Range', `
                <div class="cr-modes segmented">${['Sample', 'Add', 'Remove'].map((m) => `<button data-cr-mode="${m}" class="${m === 'Sample' ? 'on' : ''}" title="${m === 'Sample' ? 'Click the image to select that color' : m === 'Add' ? 'Click the image to add that color to the selection' : 'Click the image to take that color out of the selection'}">${icon('pipette')}${m === 'Sample' ? '' : m === 'Add' ? '+' : '−'}</button>`).join('')}</div>
                <canvas class="cr-preview" width="584" height="400" title="Click here or on the image to pick a color"></canvas>
                <div class="hint">Click the image to pick the color to select.<br>Shift-click adds a color, Option-click takes one away.</div>
                <div class="panel-row" title="How far a color may be from the picked ones and still be selected"><label class="caption scrub cr-fuzz-label">Fuzziness</label><input type="range" min="0" max="200" value="40" class="cr-fuzz"><input class="num cr-fuzz-field" value="40" style="width:48px"></div>
                <label class="check" title="Select everything except those colors, such as all but a green screen"><input type="checkbox" class="cr-invert"> Invert</label>
                <div class="panel-error cr-error"></div>`, (el) => {
                el.classList.add('color-range');
                cr.element = el;
                el.querySelectorAll('[data-cr-mode]').forEach((b) => b.addEventListener('click', () => {
                    cr.sampleMode = b.dataset.crMode;
                    el.querySelectorAll('[data-cr-mode]').forEach((x) => x.classList.toggle('on', x === b));
                }));
                const fuzz = el.querySelector('.cr-fuzz'), field = el.querySelector('.cr-fuzz-field');
                fuzz.addEventListener('input', () => { cr.fuzziness = Number(fuzz.value); field.value = fuzz.value; this.updateColorRange(); });
                field.addEventListener('change', () => { cr.fuzziness = clampInt(field.value, 0, 200, 40); fuzz.value = cr.fuzziness; field.value = cr.fuzziness; this.updateColorRange(); });
                field.addEventListener('keydown', (e) => {
                    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                    e.preventDefault();
                    field.value = clampInt(Number(field.value) + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1), 0, 200, 40);
                    field.dispatchEvent(new Event('change'));
                });
                const label = el.querySelector('.cr-fuzz-label');
                label.addEventListener('pointerdown', (e) => {
                    label.setPointerCapture(e.pointerId);
                    const start = e.clientX, from = cr.fuzziness;
                    label.onpointermove = (m) => { cr.fuzziness = Math.max(0, Math.min(200, from + Math.round(m.clientX - start))); fuzz.value = field.value = cr.fuzziness; this.updateColorRange(); };
                    label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; };
                });
                el.querySelector('.cr-invert').addEventListener('change', (e) => { cr.invert = e.target.checked; this.updateColorRange(); });
                // The preview stands for the whole canvas, so a click on it picks the color under that spot, which keeps
                // picking possible when the panel covers most of a narrow board.
                const preview = el.querySelector('.cr-preview');
                preview.addEventListener('pointerdown', (e) => {
                    const doc = this.board.doc, r = preview.getBoundingClientRect();
                    const scale = Math.min(preview.width / doc.width, preview.height / doc.height);
                    const cx = ((e.clientX - r.left) / r.width) * preview.width, cy = ((e.clientY - r.top) / r.height) * preview.height;
                    const x = (cx - (preview.width - doc.width * scale) / 2) / scale, y = (cy - (preview.height - doc.height * scale) / 2) / scale;
                    if (x >= 0 && y >= 0 && x < doc.width && y < doc.height) this.pickColorRange({ x, y }, e.shiftKey, e.altKey);
                });
                this.drawColorRangePreview();
                return () => this.closeColorRange(true);
            }, () => this.closeColorRange(false));
        }

        // A canvas click while the panel is open picks a color (any tool).
        async pickColorRange(doc, shift, option) {
            const cr = this.colorRange;
            let answer;
            try {
                answer = await this.board.engine('selection.colorRangeSample', { point: [doc.x, doc.y] });
            } catch (error) {
                this.board.toast(error.message);
                return;
            }
            if (!answer.color || this.colorRange !== cr) return;
            const mode = option ? 'Remove' : shift ? 'Add' : cr.sampleMode;
            if (mode === 'Sample') { cr.include = [...answer.color]; cr.exclude = []; }
            else if (mode === 'Add') cr.include.push(...answer.color);
            else cr.exclude.push(...answer.color);
            this.updateColorRange();
        }

        // The live preview sets the board's selection without an undo step; OK records one.
        async updateColorRange() {
            const cr = this.colorRange;
            if (!cr) return;
            const serial = ++cr.serial;
            if (!cr.include.length) {
                this.board.selection = cr.original;
                cr.result = undefined;
                this.drawColorRangePreview();
                this.board.view.drawOverlay();
                return;
            }
            try {
                const answer = await this.board.engine('selection.colorRange', { include: cr.include, exclude: cr.exclude, fuzziness: cr.fuzziness, invert: cr.invert, antialiased: this.options.antialiased });
                if (this.colorRange !== cr || serial !== cr.serial) return;
                cr.result = answer.selection;
                this.board.selection = answer.selection;
                cr.element.querySelector('.panel-error').textContent = answer.error || '';
            } catch (error) {
                if (cr.element) cr.element.querySelector('.panel-error').textContent = error.message;
            }
            this.drawColorRangePreview();
            this.board.view.drawOverlay();
        }

        drawColorRangePreview() {
            const cr = this.colorRange;
            if (!cr || !cr.element) return;
            const canvas = cr.element.querySelector('.cr-preview');
            const ctx = canvas.getContext('2d');
            const doc = this.board.doc;
            const scale = Math.min(canvas.width / doc.width, canvas.height / doc.height);
            ctx.fillStyle = '#1b1b1b';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            ctx.translate((canvas.width - doc.width * scale) / 2, (canvas.height - doc.height * scale) / 2);
            ctx.scale(scale, scale);
            // Black where nothing is selected yet, white where the colors match (ColorRangeSheet's mask preview).
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, doc.width, doc.height);
            if (cr.result) {
                ctx.fillStyle = '#fff';
                ctx.fill(Selection.toPath2D(cr.result.path), 'nonzero');
            }
            ctx.restore();
        }

        closeColorRange(commit) {
            const cr = this.colorRange;
            if (!cr) return;
            this.colorRange = null;
            this.board.selection = cr.original;
            if (commit && cr.include.length && cr.result !== undefined) this.board.setSelection(cr.result, 'Color Range');
            this.board.closePanel();
            this.board.view.drawOverlay();
        }
    }

    function clampInt(value, low, high, fallback) {
        const n = Math.round(Number(value));
        return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
    }

    // Cursors drawn as Compositor draws them (EditorCanvas.swift:241-410, 818-849): black marks over white outlines.
    const url = (svg, x, y, fallback) => `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${svg}</svg>`)}") ${x} ${y}, ${fallback}`;
    const glyphPaths = (name) => icon(name).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    // A "+" or "−" with arms of 3 pt around (x, y).
    const badge = (mode, x, y) => (mode === 'Add' ? `M${x - 3} ${y}h6M${x} ${y - 3}v6` : mode === 'Subtract' ? `M${x - 3} ${y}h6` : '');
    const ARROW = 'M1 1v15.5l4-3.8 2.6 6 2.4-1-2.5-5.8H13z';
    const arrow = (dx = 0, dy = 0) => `<path transform="translate(${dx} ${dy})" d="${ARROW}" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>`;
    const memo = new Map();
    const once = (key, make) => { if (!memo.has(key)) memo.set(key, make()); return memo.get(key); };

    const CURSORS = {
        // The system crosshair, the tool's icon in a 12 pt box at hot spot + (7, 7), and the mode badge to its right.
        crosshair: (glyph, mode) => once(`x:${glyph}:${mode}`, () => {
            const mark = badge(mode, 32, 21);
            return url(`width="36" height="30"><g fill="none" stroke-linecap="round">
                <path d="M8 1v14M1 8h14${mark ? 'M' + mark.slice(1) : ''}" stroke="#fff" stroke-width="3.2"/>
                <path d="M8 1v14M1 8h14${mark ? 'M' + mark.slice(1) : ''}" stroke="#000" stroke-width="1.2"/></g>
                <g transform="translate(15 15) scale(0.5)" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <g stroke="#fff" stroke-width="5">${glyphPaths(glyph)}</g><g stroke="#000" stroke-width="2">${glyphPaths(glyph)}</g></g>`, 8, 8, 'crosshair');
        }),
        // The wand: the sparkle is the hot spot (7, 7), the stick from + (6, 6) to + (20, 20), the badge at + (17, 5).
        wand: (mode) => once(`w:${mode}`, () => {
            const ticks = 'M7 1.5v3M7 9.5v3M1.5 7h3M9.5 7h3';
            const mark = badge(mode, 24, 12);
            return url(`width="34" height="34"><g fill="none" stroke-linecap="round">
                <path d="M13 13l14 14" stroke="#fff" stroke-width="5"/><path d="M13 13l14 14" stroke="#000" stroke-width="2.4"/>
                <path d="${ticks}${mark}" stroke="#fff" stroke-width="3.2"/><path d="${ticks}${mark}" stroke="#000" stroke-width="1.2"/></g>`, 7, 7, 'crosshair');
        }),
        // The arrow with a small dashed box at hot spot + (9.5, 13.5).
        moveSelection: url(`width="24" height="24">${arrow()}<rect x="10.5" y="14.5" width="8" height="6" fill="none" stroke="#fff" stroke-width="2.5"/>
            <rect x="10.5" y="14.5" width="8" height="6" fill="none" stroke="#000" stroke-width="1" stroke-dasharray="2 1.5"/>`, 1, 1, 'move'),
        // The arrow with scissors at hot spot + (9, 12).
        scissors: url(`width="24" height="26">${arrow()}<g transform="translate(10 13)" fill="none" stroke-linecap="round">
            <g stroke="#fff" stroke-width="3.2"><circle cx="2.5" cy="8.5" r="2"/><circle cx="8.5" cy="8.5" r="2"/><path d="M3.8 7L9 0M7.2 7L2 0"/></g>
            <g stroke="#000" stroke-width="1.2"><circle cx="2.5" cy="8.5" r="2"/><circle cx="8.5" cy="8.5" r="2"/><path d="M3.8 7L9 0M7.2 7L2 0"/></g></g>`, 1, 1, 'grab'),
        // The duplicate cursor with a small eye: ⌥ over a mask thumbnail shows that mask alone (NLL:616-638).
        showMask: url(`width="26" height="26"><path transform="translate(5 5)" d="${ARROW}" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>${arrow()}
            <path d="M15.5 21.5c1.8-2.6 5.4-2.6 7.2 0-1.8 2.6-5.4 2.6-7.2 0z" fill="#000" stroke="#fff" stroke-width="1"/><circle cx="19.1" cy="21.5" r="1" fill="#fff"/>`, 1, 1, 'copy'),
        // A black arrow over a white one offset 5 pt.
        duplicate: url(`width="24" height="26"><path transform="translate(5 5)" d="${ARROW}" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>${arrow()}`, 1, 1, 'copy'),
        // The pointing hand with the dashed box at hot spot + (11.5, 14.5): Cmd over a layer thumbnail.
        loadSelection: url(`width="26" height="26"><path d="M6 1.5a1.5 1.5 0 0 1 3 0V8l1-.2a1.4 1.4 0 0 1 1.7 1l.1.2.9-.2a1.4 1.4 0 0 1 1.7 1v.3l.6-.1a1.4 1.4 0 0 1 1.7 1.3V15c0 2.5-1.7 4.5-4.5 4.5H9.5c-1.4 0-2.4-.6-3.2-1.7L2.6 12.6a1.4 1.4 0 0 1 2.2-1.7L6 12.3z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>
            <rect x="12.5" y="15.5" width="8" height="6" fill="none" stroke="#fff" stroke-width="2.5"/><rect x="12.5" y="15.5" width="8" height="6" fill="none" stroke="#000" stroke-width="1" stroke-dasharray="2 1.5"/>`, 7, 1, 'pointer'),
        // Circular arrows over the rotation handle.
        rotate: url(`width="24" height="24"><g fill="none" stroke-linecap="round" stroke-linejoin="round">
            <g stroke="#fff" stroke-width="4"><path d="M5 12a7 7 0 1 1 2.05 4.95"/><path d="M3 8.5L5 12l3.5-2"/></g>
            <g stroke="#000" stroke-width="1.6"><path d="M5 12a7 7 0 1 1 2.05 4.95"/><path d="M3 8.5L5 12l3.5-2"/></g></g>`, 12, 12, 'alias'),
        // The eyedropper (tip, the hot spot, at (3, 21)) with a "+" or "−" disc at (12.5, 0.5, 11, 11).
        eyedropper: (mode) => once(`e:${mode}`, () => {
            const disc = mode === 'Sample' ? '' : `<circle cx="18" cy="6" r="5.5" fill="#fff" stroke="#000" stroke-width="1"/><path d="${mode === 'Add' ? 'M15.5 6h5M18 3.5v5' : 'M15.5 6h5'}" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`;
            return url(`width="26" height="26"><g transform="translate(-0.5 0.5)" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <g stroke="#fff" stroke-width="4">${glyphPaths('pipette')}</g><g stroke="#000" stroke-width="1.6">${glyphPaths('pipette')}</g></g>${disc}`, 3, 21, 'copy');
        }),
    };

    CB.SelectTools = SelectTools;
    CB.SelectionCursors = CURSORS;
    CB.SELECTION_TOOLS = SELECTION_TOOLS;
})();
