'use strict';
// The Crop tool (Document/Crop.swift, UI/CropControls.swift, the crop drag in Rendering/EditorCanvas.swift and its
// overlay in Rendering/TransformOverlay.swift; geometry.md section 2) and the Image menu's canvas commands: Canvas
// Size…, Image Size…, Trim…, Rotate and Flip Canvas, and Layer › Flip Layer (geometry.md sections 3 and 4.11). The board
// keeps the pending frame in `board.cropEdit`; whatever changes the canvas runs in compositor-engine.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Rect, TransformTool } = CB;
    const RATIOS = ['Free', 'Original', '1:1', '4:3', '3:4', '16:9', '9:16'];
    const MAX_SIDE = 30000; // DocumentLimits.maxSideExtent
    const SNAP_DISTANCE = 8; // screen points (EditorCanvas.cropSnapDistance)
    const HANDLE_REACH = 10; // screen points around corners and along edges
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));
    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    CB.iconPaths.crop = '<path d="M6.5 2.5v12.5a2 2 0 0 0 2 2h13"/><path d="M2.5 6.5h12.5a2 2 0 0 1 2 2v13"/>';

    // ---------------------------------------------------------------------------------------------------------------
    // CropGeometry, CropDrag and CropSnap (Document/Crop.swift:4-112)

    // Whole-pixel corners, at least 1 px a side.
    function snapped(r) {
        const minX = Math.min(r.x, r.x + r.width), minY = Math.min(r.y, r.y + r.height);
        const maxX = Math.max(r.x, r.x + r.width), maxY = Math.max(r.y, r.y + r.height);
        const x = roundHalfAway(minX), y = roundHalfAway(minY);
        return { x, y, width: Math.max(1, roundHalfAway(maxX) - x), height: Math.max(1, roundHalfAway(maxY) - y) };
    }

    function valid(r) {
        return Boolean(r) && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 1 && r.width <= MAX_SIDE
            && r.height >= 1 && r.height <= MAX_SIDE && Math.abs(r.x) <= 1000000 && Math.abs(r.y) <= 1000000;
    }

    // A frame dragged from `start` to `end`, or grown from `start` as its center (symmetric).
    function create(start, end, ratio, symmetric) {
        let dx = end.x - start.x, dy = end.y - start.y;
        if (ratio) {
            if (Math.abs(dx) > Math.abs(dy) * ratio) dy = (dy < 0 ? -1 : 1) * Math.abs(dx) / ratio;
            else dx = (dx < 0 ? -1 : 1) * Math.abs(dy) * ratio;
        }
        if (symmetric) return snapped({ x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 });
        return snapped({ x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy) });
    }

    // CropDrag.updated: create, move by whole pixels, or resize as the layer transform drag does on an upright frame
    // (a fixed ratio locks the frame's own aspect).
    function updated(drag, point, ratio, symmetric) {
        if (drag.mode === 'create') return create(drag.start, point, ratio, symmetric);
        if (drag.mode === 'move') return snapped({ ...drag.original, x: drag.original.x + point.x - drag.start.x, y: drag.original.y + point.y - drag.start.y });
        const transform = { ...drag.original, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
        const next = TransformTool.updated({ original: transform, start: drag.start, mode: 'resize', index: drag.index }, point, { lockRatio: Boolean(ratio), shift: false, option: symmetric });
        return snapped({ x: next.x, y: next.y, width: next.width, height: next.height });
    }

    // CropSnap.apply: moves snap the frame's closest edges keeping its size; creating and resizing snap only the edges on
    // the pointer's side (mirrored about the center when symmetric); a fixed ratio lets only moves snap.
    function snapApply(rect, drag, point, ratio, symmetric, snap) {
        if (!(snap.tolerance > 0)) return rect;
        const nearest = (value, targets) => {
            let best = null;
            for (const t of targets) {
                if (Math.abs(t - value) > snap.tolerance) continue;
                if (best !== null && Math.abs(best - value) <= Math.abs(t - value)) continue;
                best = t;
            }
            return best;
        };
        let horizontal, vertical;
        if (drag.mode === 'move') {
            const shift = (edges, targets) => {
                let best = null;
                for (const edge of edges) {
                    const t = nearest(edge, targets);
                    if (t === null) continue;
                    if (best === null || Math.abs(t - edge) < Math.abs(best)) best = t - edge;
                }
                return best || 0;
            };
            return { ...rect, x: rect.x + shift([rect.x, rect.x + rect.width], snap.xs), y: rect.y + shift([rect.y, rect.y + rect.height], snap.ys) };
        }
        if (ratio) return rect;
        if (drag.mode === 'create') { horizontal = true; vertical = true; }
        else {
            const [hx, hy] = TransformTool.HANDLES[drag.index];
            horizontal = hx !== 0.5;
            vertical = hy !== 0.5;
        }
        let r = { ...rect };
        if (horizontal) {
            if (Math.abs(point.x - r.x) <= Math.abs(point.x - (r.x + r.width))) {
                const x = nearest(r.x, snap.xs);
                if (x !== null && x < r.x + r.width) r = { ...r, x, width: r.x + r.width - x };
            } else {
                const x = nearest(r.x + r.width, snap.xs);
                if (x !== null && x > r.x) r = { ...r, width: x - r.x };
            }
        }
        if (vertical) {
            if (Math.abs(point.y - r.y) <= Math.abs(point.y - (r.y + r.height))) {
                const y = nearest(r.y, snap.ys);
                if (y !== null && y < r.y + r.height) r = { ...r, y, height: r.y + r.height - y };
            } else {
                const y = nearest(r.y + r.height, snap.ys);
                if (y !== null && y > r.y) r = { ...r, height: y - r.y };
            }
        }
        if (symmetric) {
            // The snapped (dragged) edge sets the half size; the opposite edge mirrors it about the center.
            const center = drag.mode === 'create' ? drag.start : { x: drag.original.x + drag.original.width / 2, y: drag.original.y + drag.original.height / 2 };
            if (horizontal) {
                const half = point.x >= center.x ? r.x + r.width - center.x : center.x - r.x;
                if (half >= 0.5) r = { ...r, x: center.x - half, width: half * 2 };
            }
            if (vertical) {
                const half = point.y >= center.y ? r.y + r.height - center.y : center.y - r.y;
                if (half >= 0.5) r = { ...r, y: center.y - half, height: half * 2 };
            }
        }
        return r;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The tool

    class CropTool {
        constructor(board) {
            this.board = board;
            this.drag = null;
            // Option and Control re-shape a frame being dragged without the pointer moving (EditorCanvas.flagsChanged).
            const flags = (e) => {
                if (!this.drag || (e.key !== 'Alt' && e.key !== 'Control')) return;
                this.mods = { altKey: e.altKey, ctrlKey: e.ctrlKey };
                this.update();
            };
            window.addEventListener('keydown', flags, true);
            window.addEventListener('keyup', flags, true);
        }

        get canvasRect() {
            return { x: 0, y: 0, width: this.board.doc.width, height: this.board.doc.height };
        }

        // visibleCropRect: the pending frame, or the canvas while there is none.
        get visible() {
            const edit = this.board.cropEdit;
            return edit ? edit.rect : this.canvasRect;
        }

        // cropRatio (Crop.swift:218-229): width over height, the canvas's own for Original, none for Free.
        ratio() {
            const choice = this.board.cropRatioChoice || 'Free';
            if (choice === 'Original') return this.board.doc.width / this.board.doc.height;
            const [w, h] = choice.split(':').map(Number);
            return h ? w / h : null;
        }

        // Entering the tool (EditorSession.swift:410-420): ratio Free, the frame at the canvas, or at the selection's
        // pixel bounds within it, so C then Return crops to the selection.
        activate() {
            const board = this.board;
            if (board.cropEdit || !board.doc.manifest) return;
            board.cropRatioChoice = 'Free';
            const canvas = this.canvasRect;
            let rect = canvas;
            const sel = board.selection;
            if (sel && !CB.Selection.isEmpty(sel)) {
                const bounds = CB.Selection.pathBounds(sel.path);
                const inside = bounds && Rect.intersect(Rect.integral(bounds), canvas);
                rect = inside && valid(inside) ? inside : canvas;
            }
            board.cropEdit = { rect };
        }

        // Leaving the tool drops the frame (EditorSession.swift:398).
        deactivate() {
            this.drag = null;
            this.board.cancelCrop();
            return true;
        }

        // An undo or redo drops the pending frame (EditorSession.restore, ES:669-679).
        restored() {
            this.drag = null;
            this.board.cancelCrop();
        }

        optionsHTML() {
            const board = this.board, edit = board.cropEdit;
            const choice = board.cropRatioChoice || 'Free';
            const off = !edit || board.working ? 'disabled' : '';
            return `<span class="title">Crop</span>
                <span class="group crop-ratio-group"><label class="caption">Ratio</label><select class="pop crop-ratio" aria-label="Ratio">${RATIOS.map((r) => `<option${r === choice ? ' selected' : ''}>${r}</option>`).join('')}</select></span>
                <span class="crop-size">${edit ? `${Math.trunc(edit.rect.width)} × ${Math.trunc(edit.rect.height)} px` : ''}</span>
                <span class="crop-buttons"><button class="pill crop-cancel" ${off}>Cancel</button><button class="pill crop-apply" ${off}>Apply Crop</button></span>`;
        }

        bindOptions(el) {
            const ratio = el.querySelector('.crop-ratio');
            if (ratio) ratio.addEventListener('change', () => { this.board.cropRatioChoice = ratio.value; this.changeRatio(); });
            const cancel = el.querySelector('.crop-cancel'), apply = el.querySelector('.crop-apply');
            if (cancel) cancel.addEventListener('click', () => this.board.cancelCrop());
            if (apply) apply.addEventListener('click', () => this.board.commitCrop());
        }

        // The readout follows a frame being dragged without rebuilding the header.
        refreshOptions(el) {
            const size = el.querySelector('.crop-size'), edit = this.board.cropEdit;
            if (size) size.textContent = edit ? `${Math.trunc(edit.rect.width)} × ${Math.trunc(edit.rect.height)} px` : '';
        }

        hint() {
            return 'Drag to crop · Enter apply · Escape cancel · Space to pan';
        }

        // changeCropRatio (Crop.swift:230-235): the frame keeps its width and vertical middle; an invalid refit leaves it.
        changeRatio() {
            const ratio = this.ratio(), rect = this.visible;
            if (ratio) {
                const height = rect.width / ratio;
                const next = snapped({ x: rect.x, y: rect.y + rect.height / 2 - height / 2, width: rect.width, height });
                if (valid(next)) this.board.cropEdit = { rect: next };
            }
            this.changed();
        }

        changed() {
            const board = this.board;
            board.renderOptions(true);
            board.view.draw();
        }

        // Return applies (EditorCanvas.swift:2240-2245).
        keydown(e) {
            // C again with no frame pending starts one, as selectTool(.crop) does whenever cropRect is nil.
            if (e.code === 'KeyC' && !e.metaKey && !e.ctrlKey && !e.altKey && !this.board.cropEdit && !e.repeat) {
                this.activate();
                this.changed();
                return true;
            }
            if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.metaKey && !e.ctrlKey && !e.altKey) {
                this.drag = null;
                this.board.commitCrop();
                return true;
            }
            return false;
        }

        escape() {
            this.drag = null;
            this.board.cancelCrop();
            this.board.view.draw();
            return true;
        }

        // The frame on screen and its resize regions (TransformOverlay.swift:380-405): 20 pt corner squares, then the
        // top and bottom edge bands, then the left and right ones.
        screenRect() {
            const view = this.board.view, r = this.visible;
            const a = view.toScreen({ x: r.x, y: r.y }), b = view.toScreen({ x: r.x + r.width, y: r.y + r.height });
            return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
        }

        regionAt(p) {
            const r = this.screenRect(), R = HANDLE_REACH;
            const handles = TransformTool.HANDLES.map(([u, v]) => ({ x: r.x + u * r.width, y: r.y + v * r.height }));
            const inside = (x, y, w, h) => p.x >= x && p.y >= y && p.x < x + w && p.y < y + h;
            for (const i of [0, 2, 4, 6]) if (inside(handles[i].x - R, handles[i].y - R, R * 2, R * 2)) return i;
            for (const i of [1, 5]) if (inside(r.x + R, handles[i].y - R, Math.max(0, r.width - R * 2), R * 2)) return i;
            for (const i of [3, 7]) if (inside(handles[i].x - R, r.y + R, R * 2, Math.max(0, r.height - R * 2))) return i;
            return -1;
        }

        // beginCropDrag (EditorCanvas.swift:2542-2559): a resize region resizes; inside a frame that is not the whole
        // canvas moves; anywhere else draws a new frame, the pending one gone from the press.
        down(doc, p, e) {
            const board = this.board;
            if (!board.doc.manifest || board.working) return false;
            const rect = this.visible, canvas = this.canvasRect;
            const index = this.regionAt(p);
            let mode;
            if (index >= 0) mode = 'resize';
            else if (board.cropEdit && Rect.contains(board.cropEdit.rect, doc.x, doc.y) && !Rect.equal(rect, canvas)) mode = 'move';
            else {
                mode = 'create';
                board.cropEdit = null;
                board.renderOptions(true);
            }
            const targets = board.alignmentSnapTargets(new Set(), false);
            this.snap = { ...targets, tolerance: SNAP_DISTANCE / Math.max(board.view.ppp, 0.0001) };
            this.drag = { start: doc, original: { ...rect }, mode, index };
            this.point = doc;
            this.mods = { altKey: e.altKey, ctrlKey: e.ctrlKey };
            // The cursor at the press is kept for the whole drag.
            this.dragCursor = index >= 0 ? this.resizeCursor(index) : 'crosshair';
            return true;
        }

        move(doc, p, e) {
            if (!this.drag) return;
            this.point = doc;
            this.mods = { altKey: e.altKey, ctrlKey: e.ctrlKey };
            this.update();
        }

        // dragCrop (EditorCanvas.swift:2561-2571): Option keeps the center fixed; edges snap unless Control is held or
        // View › Snap is off; an invalid result keeps the last valid frame.
        update() {
            const board = this.board, drag = this.drag;
            if (!drag || board.working) return;
            const symmetric = Boolean(this.mods.altKey), ratio = this.ratio();
            let next = updated(drag, this.point, ratio, symmetric);
            const snapOn = board.prefs ? board.prefs.snap !== false : true;
            if (snapOn && !this.mods.ctrlKey) next = snapApply(next, drag, this.point, ratio, symmetric, this.snap);
            if (!valid(next)) return;
            const before = board.cropEdit && board.cropEdit.rect;
            board.cropEdit = { rect: next };
            if (!before) board.renderOptions(true);
            else board.refreshOptionValues();
            board.view.draw();
        }

        up() {
            this.drag = null;
            this.board.renderOptions(true);
        }

        // Escape mid-drag cancels the frame, as Escape does.
        cancel() {
            this.escape();
        }

        busy() {
            return false;
        }

        resizeCursor(index) {
            return ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'][index % 4];
        }

        cursor() {
            if (this.drag) return this.dragCursor;
            const p = this.board.view.pointer;
            const index = p ? this.regionAt(p) : -1;
            return index >= 0 ? this.resizeCursor(index) : 'crosshair';
        }

        // drawCrop (TransformOverlay.swift:492-519): everything outside the frame darkened 60 %, a white frame, thirds at
        // 40 % white, eight 8 pt handles.
        drawOverlay(ctx) {
            if (!this.board.doc.manifest) return;
            const view = this.board.view, r = this.screenRect();
            const w = view.overlay.width / view.dpr, h = view.overlay.height / view.dpr;
            ctx.beginPath();
            ctx.rect(0, 0, w, h);
            ctx.rect(r.x, r.y, r.width, r.height);
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fill('evenodd');
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#ffffff';
            ctx.strokeRect(r.x, r.y, r.width, r.height);
            ctx.strokeStyle = 'rgba(255,255,255,0.4)';
            ctx.beginPath();
            for (const f of [1 / 3, 2 / 3]) {
                ctx.moveTo(r.x + r.width * f, r.y);
                ctx.lineTo(r.x + r.width * f, r.y + r.height);
                ctx.moveTo(r.x, r.y + r.height * f);
                ctx.lineTo(r.x + r.width, r.y + r.height * f);
            }
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#000000';
            for (const [u, v] of TransformTool.HANDLES) {
                const x = r.x + u * r.width, y = r.y + v * r.height;
                ctx.fillRect(x - 4, y - 4, 8, 8);
                ctx.strokeRect(x - 4, y - 4, 8, 8);
            }
        }
    }

    CB.registerTool({ id: 'crop', key: 'KeyC', title: 'Crop (C)', icon: () => 'crop', create: (board) => new CropTool(board) });

    // ---------------------------------------------------------------------------------------------------------------
    // Sheet helpers (geometry.md section 8)

    // Sheet fields: up to 3 decimals with grouping; readouts with integers are written without it.
    const sheetNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
    const parseSheet = (text) => {
        const t = String(text).trim().replace(/,/g, '');
        return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : null;
    };

    // ByteCountFormatter, .memory (geometry.md 8.5).
    function memory(bytes) {
        if (bytes < 1024) return `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;
        const units = [['KB', 0], ['MB', 1], ['GB', 2], ['TB', 2], ['PB', 2]];
        let value = bytes / 1024, i = 0;
        for (;;) {
            const digits = units[i][1];
            const rounded = Number(value.toFixed(digits));
            if (rounded < 1024 || i === units.length - 1) return `${rounded.toLocaleString('en-US', { maximumFractionDigits: digits })} ${units[i][0]}`;
            value /= 1024;
            i++;
        }
    }

    // A label that scrubs its field (UI/NumericScrub.swift): at least 1 pt of drag, `start + dx × sensitivity`, whole steps,
    // clamped to the range.
    function scrubbable(label, { get, set, range, sensitivity, enabled = () => true }) {
        label.addEventListener('pointerdown', (e) => {
            if (!enabled()) return;
            const start = e.clientX, from = get();
            let moved = false;
            label.setPointerCapture(e.pointerId);
            label.onpointermove = (m) => {
                if (!moved && Math.abs(m.clientX - start) < 1) return;
                moved = true;
                const [lo, hi] = range();
                set(Math.min(hi, Math.max(lo, roundHalfAway(from + (m.clientX - start) * sensitivity()))));
            };
            label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; };
        });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Board methods: the frame, the canvas commands and their sheets. Mixed into the Board with the transform edits.

    Object.assign(CB.TransformEdits, {
        // commitCrop (Crop.swift:236-248): the canvas resized to the frame, nothing resampled; the frame goes when it
        // worked and stays when it failed ("Couldn’t crop").
        async commitCrop() {
            const edit = this.cropEdit;
            if (!edit || !valid(edit.rect) || !this.canStartProjectOperation()) return;
            const r = edit.rect;
            const result = await this.selectionOp('canvas.crop', { rect: [r.x, r.y, r.width, r.height] }, 'Crop');
            if (result && !result.errorTitle) this.cancelCrop();
            this.renderOptions(true);
            this.view.draw();
        },

        // canStartProjectOperation (EditorSession.swift:151-154): no panel, Color Range, text, stroke or busy work.
        canStartProjectOperation() {
            return Boolean(this.doc.manifest) && !this.openPanel && !this.selectTools.colorRange && !this.textDraft && !this.working
                && !this.view.busy && !this.renamingID && !this.adjustmentEditingID && !this.levelsEdit && !this.filters.isOpen;
        },

        // ProjectController.begin: a crop frame goes and a transform is applied before a sheet opens.
        beginProjectOperation() {
            if (!this.canStartProjectOperation()) return false;
            this.cancelCrop();
            this.commitTransformEdit();
            return true;
        },

        // The Image menu after Invert (CompositorApp.swift:307-327).
        canvasCommandItems() {
            const start = () => this.canStartProjectOperation();
            const layers = () => this.canEditLayers();
            return [
                null,
                { label: 'Canvas Size…', def: 'Canvas Size', enabled: start, run: () => this.openCanvasSize() },
                { label: 'Image Size…', def: 'Image Size', enabled: start, run: () => this.openImageSize() },
                { label: 'Trim…', enabled: start, run: () => this.openTrim() },
                null,
                { label: 'Rotate Canvas 90° Clockwise', enabled: layers, run: () => this.rotateCanvas(true) },
                { label: 'Rotate Canvas 90° Counterclockwise', enabled: layers, run: () => this.rotateCanvas(false) },
                { label: 'Flip Canvas Horizontal', enabled: layers, run: () => this.flipCanvas(true) },
                { label: 'Flip Canvas Vertical', enabled: layers, run: () => this.flipCanvas(false) },
            ];
        },

        // Rotate Canvas (CanvasRotation.swift:34-61): placements turned, guides and the selection with them, one step.
        rotateCanvas(clockwise) {
            this.commitTransformEdit();
            this.cancelCrop();
            if (!this.canEditLayers()) return;
            this.selectionOp('canvas.rotate', { clockwise }, clockwise ? 'Rotate Canvas 90° Clockwise' : 'Rotate Canvas 90° Counterclockwise');
        },

        // Flip Canvas (LayerFlip.swift:55-79).
        flipCanvas(horizontal) {
            this.commitTransformEdit();
            this.cancelCrop();
            if (!this.canEditLayers()) return;
            this.selectionOp('canvas.flip', { horizontal }, horizontal ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical');
        },

        // Layer › Flip Layer (LayerFlip.swift:24-51): the active layer about its middle, or the selected layers about their
        // box's; the angle negated; linked masks follow.
        flipLayers(horizontal) {
            this.commitTransformEdit();
            if (!this.canTransform()) return;
            this.selectionOp('layer.flip', { horizontal }, horizontal ? 'Flip Horizontal' : 'Flip Vertical');
        },

        // While cropping, what lies past the canvas inside the frame is drawn too (EditorCanvas.renderBounds, the canvas
        // united with the frame): a renderer on a stand-in document shifted to the union, drawn around the canvas.
        drawCropExtension(ctx, view) {
            if (this.tool !== 'crop' || !this.cropEdit || !this.doc.manifest) return;
            const doc = this.doc, canvas = { x: 0, y: 0, width: doc.width, height: doc.height };
            const union = Rect.union(canvas, Rect.integral(this.cropEdit.rect));
            if (Rect.equal(union, canvas)) return;
            // At most 16 megapixels: a frame far past a large canvas is drawn scaled.
            const k = Math.min(1, Math.sqrt(16e6 / (union.width * union.height)));
            const key = JSON.stringify([union, k]) + doc.snapshot();
            if (!this.cropExtensionCache || this.cropExtensionCache.key !== key) {
                const shifted = JSON.parse(JSON.stringify(doc.manifest));
                const move = (t) => t && { ...t, origin: [(t.origin[0] - union.x) * k, (t.origin[1] - union.y) * k], size: [t.size[0] * k, t.size[1] * k] };
                for (const l of shifted.layers) {
                    l.transform = move(l.transform || { origin: [0, 0], size: [doc.width, doc.height], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' });
                    if (l.maskPlacement) l.maskPlacement = move(l.maskPlacement);
                }
                shifted.width = Math.max(1, Math.ceil(union.width * k));
                shifted.height = Math.max(1, Math.ceil(union.height * k));
                const stand = {
                    manifest: shifted, width: shifted.width, height: shifted.height, layers: shifted.layers,
                    entry: (id) => doc.entry(id), layer: (id) => shifted.layers.find((l) => l.id === id),
                };
                const out = CB.Render.canvas2d(shifted.width, shifted.height);
                new CB.Render.Renderer(stand).render(out.ctx, { info: CB.Render.plan(shifted) });
                this.cropExtensionCache = { key, canvas: out.canvas };
            }
            const o = view.origin(), ppp = view.ppp, dpr = view.dpr;
            const ux = o.x + union.x * ppp, uy = o.y + union.y * ppp, uw = union.width * ppp, uh = union.height * ppp;
            const cx = o.x, cy = o.y, cw = canvas.width * ppp, ch = canvas.height * ppp;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            // Only around the canvas, which is already drawn.
            ctx.beginPath();
            ctx.rect(ux, uy, uw, uh);
            ctx.rect(cx, cy, cw, ch);
            ctx.clip('evenodd');
            ctx.fillStyle = '#4d4d4d';
            ctx.fillRect(ux, uy, uw, uh);
            if (this.settings.checkerboard) {
                ctx.fillStyle = '#595959';
                const col0 = Math.floor((ux - cx) / 10), row0 = Math.floor((uy - cy) / 10);
                const col1 = Math.ceil((ux + uw - cx) / 10), row1 = Math.ceil((uy + uh - cy) / 10);
                for (let row = row0; row < row1; row++) {
                    for (let col = col0; col < col1; col++) if (((row + col) & 1) === 1) ctx.fillRect(cx + col * 10, cy + row * 10, 10, 10);
                }
            }
            ctx.imageSmoothingEnabled = view.zoom < 2;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(this.cropExtensionCache.canvas, ux, uy, uw, uh);
            ctx.restore();
        },

        // A sheet as a board panel, modal for the canvas (geometry.md 8.1). `build(el)` fills it and returns
        // { ok, valid } handlers; Return runs OK only while it is enabled, after the focused field has committed.
        sheet(title, body, build, okLabel = 'OK') {
            if (!this.beginProjectOperation()) return;
            this.panel(title, `<div class="sheet-body">${body}</div>`, (el) => {
                el.classList.add('geometry-sheet');
                const okButton = el.querySelector('.ok');
                okButton.textContent = okLabel;
                let handlers = null;
                handlers = build(el, () => { if (handlers) okButton.disabled = !handlers.valid(); });
                okButton.disabled = !handlers.valid();
                return () => {
                    const focused = el.querySelector('input:focus');
                    if (focused) focused.dispatchEvent(new Event('change'));
                    if (!handlers.valid()) return false;
                    handlers.ok();
                    return true;
                };
            });
        },

        // Image › Image Size… (UI/ImageSizeSheet.swift, geometry.md 3.2).
        openImageSize() {
            const doc = this.doc, W = doc.width, H = doc.height;
            const s = { width: W, height: H, resolution: doc.manifest.resolution || 72, locked: true, resample: true, unit: 'Pixels', sampling: 'High quality' };
            s.lastResolution = s.resolution;
            const UNITS = ['Pixels', 'Percent', 'Inches', 'Centimeters'];
            const valid = () => Number.isFinite(s.width) && Number.isFinite(s.height) && Number.isFinite(s.resolution) && s.resolution >= 1 && s.resolution <= 9600
                && roundHalfAway(s.width) >= 1 && roundHalfAway(s.width) <= MAX_SIDE && roundHalfAway(s.height) >= 1 && roundHalfAway(s.height) <= MAX_SIDE
                && (!s.resample || roundHalfAway(s.width) * roundHalfAway(s.height) <= 200000000);
            const display = (pixels, original) => (s.unit === 'Percent' ? (pixels / original) * 100 : s.unit === 'Inches' ? pixels / s.resolution
                : s.unit === 'Centimeters' ? (pixels / s.resolution) * 2.54 : pixels);
            const setDimension = (isWidth, value) => {
                if (!Number.isFinite(value) || value <= 0) return;
                if ((s.unit === 'Inches' || s.unit === 'Centimeters') && !(Number.isFinite(s.resolution) && s.resolution > 0)) return;
                if (!s.resample) {
                    s.resolution = ((isWidth ? s.width : s.height) / value) * (s.unit === 'Centimeters' ? 2.54 : 1);
                    return;
                }
                const original = isWidth ? W : H;
                const pixels = s.unit === 'Percent' ? (value / 100) * original : s.unit === 'Inches' ? value * s.resolution
                    : s.unit === 'Centimeters' ? (value / 2.54) * s.resolution : value;
                if (isWidth) { if (s.locked) s.height = (pixels * s.height) / s.width; s.width = pixels; }
                else { if (s.locked) s.width = (pixels * s.width) / s.height; s.height = pixels; }
            };
            const canScrub = () => (s.unit !== 'Inches' && s.unit !== 'Centimeters') || (Number.isFinite(s.resolution) && s.resolution > 0);
            const scrubRange = (isWidth) => {
                if (!canScrub()) return [0, 0];
                const pixels = isWidth ? s.width : s.height, other = isWidth ? s.height : s.width, original = isWidth ? W : H;
                if (!s.resample) {
                    const m = s.unit === 'Centimeters' ? 2.54 : 1;
                    return [(pixels * m) / 9600, pixels * m];
                }
                const minimum = s.locked ? Math.max(1, pixels / other) : 1;
                const dimension = s.locked ? Math.min(30000, (30000 * pixels) / other) : 30000;
                const area = s.locked ? Math.sqrt((100000000 * pixels) / other) : 100000000 / other;
                const maximum = Math.max(minimum, Math.min(dimension, area));
                return [display(minimum, original), display(maximum, original)];
            };
            const sensitivity = (isWidth) => {
                if (!canScrub()) return 0;
                if (!s.resample) return s.unit === 'Centimeters' ? 0.0254 : 0.01;
                return s.unit === 'Percent' ? 100 / (isWidth ? W : H) : s.unit === 'Inches' ? 1 / s.resolution : s.unit === 'Centimeters' ? 2.54 / s.resolution : 1;
            };
            const body = `<div class="secondary">Current: ${W} × ${H} pixels</div>
                <div class="sheet-row"><label class="sheet-label">Units</label><select class="pop units">${UNITS.map((u) => `<option>${u}</option>`).join('')}</select></div>
                <div class="sheet-row"><label class="sheet-label scrub" data-scrub="width" style="width:75px">Width</label><input class="field width" placeholder="Width"></div>
                <div class="sheet-row"><label class="sheet-label scrub" data-scrub="height" style="width:75px">Height</label><input class="field height" placeholder="Height"></div>
                <label class="check"><input type="checkbox" class="locked"> Lock aspect ratio</label>
                <div class="sheet-row"><label class="sheet-label scrub" data-scrub="resolution">Resolution</label><input class="field resolution" placeholder="Resolution"><span class="secondary">pixels/inch</span></div>
                <label class="check"><input type="checkbox" class="resample"> Resample</label>
                <div class="sheet-row sampling-row"><label class="sheet-label">Sampling</label><select class="pop sampling"><option>Nearest</option><option>Smooth</option><option>High quality</option></select></div>
                <div class="secondary callout explain"></div>
                <div class="callout result"></div>`;
            this.sheet('Image Size', body, (el, validity) => {
                const q = (sel) => el.querySelector(sel);
                const update = () => {
                    const units = q('.units');
                    [...units.options].forEach((o) => { o.hidden = !s.resample && (o.value === 'Pixels' || o.value === 'Percent'); });
                    units.value = s.unit;
                    for (const [cls, value] of [['.width', display(s.width, W)], ['.height', display(s.height, H)], ['.resolution', s.resolution]]) {
                        if (document.activeElement !== q(cls)) q(cls).value = Number.isFinite(value) ? sheetNumber.format(value) : '';
                    }
                    q('.locked').checked = s.locked;
                    q('.locked').disabled = !s.resample;
                    q('.resample').checked = s.resample;
                    q('.sampling').value = s.sampling;
                    q('.sampling-row').hidden = !s.resample;
                    q('.explain').textContent = s.resample ? 'Resizes layer pixels and applies existing transforms. Undo restores the originals.'
                        : 'Only print dimensions and resolution change. Pixels stay unchanged.';
                    const ok = valid();
                    const result = q('.result');
                    result.textContent = ok ? `Result: ${Math.trunc(roundHalfAway(s.width))} × ${Math.trunc(roundHalfAway(s.height))} pixels`
                        : 'Use 1–30,000 pixels per side, up to 200 megapixels, and 1–9,600 pixels/inch.';
                    result.classList.toggle('warning', !ok);
                    el.querySelectorAll('[data-scrub="width"], [data-scrub="height"]').forEach((l) => l.classList.toggle('disabled', !canScrub()));
                    validity();
                };
                // The resolution field: print sizes in Inches or Centimeters keep their size, pixels follow.
                const setResolution = (value) => {
                    s.resolution = value;
                    if (Number.isFinite(value) && value > 0) {
                        if (s.resample && (s.unit === 'Inches' || s.unit === 'Centimeters')) {
                            s.width *= value / s.lastResolution;
                            s.height *= value / s.lastResolution;
                        }
                        s.lastResolution = value;
                    }
                };
                const commit = (cls, apply) => q(cls).addEventListener('change', () => {
                    const n = parseSheet(q(cls).value);
                    if (n !== null) apply(n);
                    q(cls).blur();
                    update();
                });
                commit('.width', (n) => setDimension(true, n));
                commit('.height', (n) => setDimension(false, n));
                commit('.resolution', (n) => setResolution(n));
                q('.units').addEventListener('change', () => { s.unit = q('.units').value; update(); });
                q('.locked').addEventListener('change', () => { s.locked = q('.locked').checked; update(); });
                q('.resample').addEventListener('change', () => {
                    s.resample = q('.resample').checked;
                    if (!s.resample) {
                        s.width = W;
                        s.height = H;
                        s.locked = true;
                        if (s.unit === 'Pixels' || s.unit === 'Percent') s.unit = 'Inches';
                    }
                    update();
                });
                q('.sampling').addEventListener('change', () => { s.sampling = q('.sampling').value; });
                for (const isWidth of [true, false]) {
                    scrubbable(q(`[data-scrub="${isWidth ? 'width' : 'height'}"]`), {
                        get: () => display(isWidth ? s.width : s.height, isWidth ? W : H),
                        set: (v) => { setDimension(isWidth, v); update(); },
                        range: () => scrubRange(isWidth), sensitivity: () => sensitivity(isWidth), enabled: canScrub,
                    });
                }
                scrubbable(q('[data-scrub="resolution"]'), { get: () => s.resolution, set: (v) => { setResolution(v); update(); }, range: () => [1, 9600], sensitivity: () => 1 });
                update();
                return {
                    valid,
                    ok: () => this.selectionOp('image.size', { width: roundHalfAway(s.width), height: roundHalfAway(s.height), resolution: s.resolution, sampling: s.sampling }, 'Image Size'),
                };
            }, 'Resize');
        },

        // Image › Canvas Size… (UI/CanvasSizeSheet.swift, Document/CanvasSize.swift; geometry.md 3.3).
        openCanvasSize() {
            const doc = this.doc, W = doc.width, H = doc.height, resolution = doc.manifest.resolution || 72;
            const d = { width: W, height: H, relative: false, locked: false, unit: 'Pixels' };
            const foreground = [...this.colors.fg], background = [...this.colors.bg];
            let anchor = 4, extension = 'Transparent', custom = [1, 1, 1];
            const ANCHORS = ['Top left', 'Top center', 'Top right', 'Middle left', 'Center', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'];
            const valid = () => Number.isFinite(d.width) && Number.isFinite(d.height) && roundHalfAway(d.width) >= 1 && roundHalfAway(d.width) <= MAX_SIDE
                && roundHalfAway(d.height) >= 1 && roundHalfAway(d.height) <= MAX_SIDE;
            const toUnit = (pixels, original) => (d.unit === 'Percent' ? (pixels / original) * 100 : d.unit === 'Inches' ? pixels / resolution
                : d.unit === 'Centimeters' ? (pixels / resolution) * 2.54 : pixels);
            const displayed = (widthAxis) => {
                const original = widthAxis ? W : H;
                return toUnit((widthAxis ? d.width : d.height) - (d.relative ? original : 0), original);
            };
            const set = (value, widthAxis) => {
                const original = widthAxis ? W : H;
                const pixels = d.unit === 'Percent' ? (value / 100) * original : d.unit === 'Inches' ? value * resolution
                    : d.unit === 'Centimeters' ? (value / 2.54) * resolution : value;
                const final = pixels + (d.relative ? original : 0);
                if (widthAxis) { d.width = final; if (d.locked) d.height = (final * H) / W; }
                else { d.height = final; if (d.locked) d.width = (final * W) / H; }
            };
            const scrubRange = (widthAxis) => {
                const original = widthAxis ? W : H, other = widthAxis ? H : W;
                const lower = d.locked ? Math.max(1, original / other) : 1;
                const upper = d.locked ? Math.min(30000, (30000 * original) / other) : 30000;
                return [toUnit(lower - (d.relative ? original : 0), original), toUnit(upper - (d.relative ? original : 0), original)];
            };
            const sensitivity = (widthAxis) => (d.unit === 'Percent' ? 100 / (widthAxis ? W : H) : d.unit === 'Inches' ? 1 / resolution : d.unit === 'Centimeters' ? 2.54 / resolution : 1);
            const fill = () => ({ Transparent: null, Black: [0, 0, 0], White: [1, 1, 1], Foreground: foreground, Background: background, Custom: custom }[extension]);
            const body = `<div>Current: ${W} × ${H} pixels</div>
                <div class="secondary callout">${escape(memory(W * H * 4))} uncompressed RGBA canvas</div>
                <hr>
                <div class="sheet-row"><label class="sheet-label">Units</label><select class="pop units"><option>Pixels</option><option>Percent</option><option>Inches</option><option>Centimeters</option></select></div>
                <div class="sheet-row"><label class="sheet-label scrub" data-scrub="width" style="width:60px">Width</label><input class="field width" placeholder="Width"></div>
                <div class="sheet-row"><label class="sheet-label scrub" data-scrub="height" style="width:60px">Height</label><input class="field height" placeholder="Height"></div>
                <label class="check"><input type="checkbox" class="relative"> Relative to current dimensions</label>
                <label class="check"><input type="checkbox" class="locked"> Lock original aspect ratio</label>
                <div class="callout result"></div>
                <div class="anchor-area"><div><div>Anchor</div><div class="anchor-grid">${ANCHORS.map((name, i) => `<button class="anchor" data-anchor="${i}" title="${name}" aria-label="${name}"></button>`).join('')}</div></div>
                    <div class="anchor-text"><b class="anchor-name callout"></b><div class="secondary callout">Keeps this point fixed. Artwork is not scaled; cropped content remains outside the canvas.</div></div></div>
                <div class="sheet-row"><label class="sheet-label">Canvas extension</label><select class="pop extension">${['Transparent', 'Foreground', 'Background', 'Black', 'White', 'Custom'].map((x) => `<option>${x}</option>`).join('')}</select></div>
                <div class="sheet-row custom-row"><span>Extension color</span><span class="swatch extension-swatch" role="button" title="Color for the added canvas" aria-label="Extension Color"></span></div>`;
            this.sheet('Canvas Size', body, (el, validity) => {
                const q = (sel) => el.querySelector(sel);
                const update = () => {
                    q('.units').value = d.unit;
                    for (const [cls, widthAxis] of [['.width', true], ['.height', false]]) {
                        const value = displayed(widthAxis);
                        if (document.activeElement !== q(cls)) q(cls).value = Number.isFinite(value) ? sheetNumber.format(value) : '';
                    }
                    q('.relative').checked = d.relative;
                    q('.locked').checked = d.locked;
                    const ok = valid(), result = q('.result');
                    const w = Math.trunc(roundHalfAway(d.width)), h = Math.trunc(roundHalfAway(d.height));
                    result.textContent = ok ? `New: ${w} × ${h} pixels · ${memory(w * h * 4)} uncompressed` : 'Final dimensions must be 1–30,000 pixels per side.';
                    result.classList.toggle('warning', !ok);
                    result.classList.toggle('secondary', ok);
                    el.querySelectorAll('.anchor').forEach((b) => {
                        const on = Number(b.dataset.anchor) === anchor;
                        b.classList.toggle('on', on);
                        b.setAttribute('aria-pressed', on ? 'true' : 'false');
                    });
                    q('.anchor-name').textContent = ANCHORS[anchor];
                    q('.extension').value = extension;
                    q('.custom-row').hidden = extension !== 'Custom';
                    q('.extension-swatch').style.background = `#${CB.Color.hex(custom)}`;
                    validity();
                };
                const commit = (cls, widthAxis) => q(cls).addEventListener('change', () => {
                    const n = parseSheet(q(cls).value);
                    if (n !== null) set(n, widthAxis);
                    q(cls).blur();
                    update();
                });
                commit('.width', true);
                commit('.height', false);
                q('.units').addEventListener('change', () => { d.unit = q('.units').value; update(); });
                q('.relative').addEventListener('change', () => { d.relative = q('.relative').checked; update(); });
                q('.locked').addEventListener('change', () => {
                    d.locked = q('.locked').checked;
                    // Turning the lock on derives the height from the width (CanvasSizeSheet.swift:88-91).
                    if (d.locked) set(displayed(true), true);
                    update();
                });
                el.querySelectorAll('.anchor').forEach((b) => b.addEventListener('click', () => { anchor = Number(b.dataset.anchor); update(); }));
                q('.extension').addEventListener('change', () => { extension = q('.extension').value; update(); });
                q('.extension-swatch').addEventListener('click', () => {
                    this.picker.open({ title: 'Color Picker (Extension Color)', color: custom, dialog: true, onCommit: (rgb) => { custom = rgb; update(); } });
                });
                for (const widthAxis of [true, false]) {
                    scrubbable(q(`[data-scrub="${widthAxis ? 'width' : 'height'}"]`), {
                        get: () => displayed(widthAxis), set: (v) => { set(v, widthAxis); update(); },
                        range: () => scrubRange(widthAxis), sensitivity: () => sensitivity(widthAxis),
                    });
                }
                update();
                return {
                    valid,
                    ok: () => {
                        // The picker closes with the sheet, keeping its color (DialogColorSwatch.closePicker).
                        if (this.picker.isOpen) this.picker.close(true);
                        this.selectionOp('canvas.size', { width: roundHalfAway(d.width), height: roundHalfAway(d.height), anchor, fill: fill() }, 'Canvas Size');
                    },
                };
            });
        },

        // Image › Trim… (UI/TrimSheet.swift; geometry.md 3.5).
        openTrim() {
            const t = { basedOn: 'Transparent Pixels', top: true, bottom: true, left: true, right: true };
            const body = `<div class="headline">Based On</div>
                <div class="radio-group">${['Transparent Pixels', 'Top Left Pixel Color', 'Bottom Right Pixel Color'].map((b) => `<label class="check"><input type="radio" name="trim-based" value="${b}"${b === t.basedOn ? ' checked' : ''}> ${b}</label>`).join('')}</div>
                <hr>
                <div class="headline">Trim Away</div>
                <div class="trim-grid">${['top', 'bottom', 'left', 'right'].map((side) => `<label class="check"><input type="checkbox" data-side="${side}" checked> ${side[0].toUpperCase()}${side.slice(1)}</label>`).join('')}</div>`;
            this.sheet('Trim', body, (el, validity) => {
                const valid = () => t.top || t.bottom || t.left || t.right;
                el.querySelectorAll('input[name="trim-based"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) t.basedOn = r.value; }));
                el.querySelectorAll('input[data-side]').forEach((c) => c.addEventListener('change', () => { t[c.dataset.side] = c.checked; validity(); }));
                return { valid, ok: () => this.selectionOp('image.trim', { ...t }, 'Trim') };
            });
        },
    });

    CB.Crop = { snapped, valid, create, updated, snapApply, memory };
})();
