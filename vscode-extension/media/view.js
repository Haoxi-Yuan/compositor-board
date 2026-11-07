'use strict';
// The canvas: viewport (upstream Rendering/CanvasViewport.swift), drawing the document on its checkerboard, the overlay
// (transform box, snap lines, brush circle, notes, sample ring) and pointer input for every tool. Edits are committed
// through the board, one undo step each.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Affine, Rect, Transform, TransformTool, Brush, Shapes } = CB;

    const ZOOM_LEVELS = [0.125, 1 / 6, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.25, 1.5, 2, 3, 4, 5, 6, 8, 12, 16];
    const MIN_ZOOM = 0.001, MAX_ZOOM = 32, CRISP_ZOOM = 2, FIT_MARGIN = 48;

    class View {
        constructor(board, stage) {
            this.board = board;
            this.stage = stage;
            this.canvas = document.createElement('canvas');
            this.overlay = document.createElement('canvas');
            this.overlay.className = 'overlay';
            stage.append(this.canvas, this.overlay);
            this.zoom = 1;
            this.pan = { x: 0, y: 0 };
            this.followsFit = true;
            this.pointer = null;
            this.drag = null;
            this.space = false;
            this.guides = { xs: [], ys: [] };
            this.sampleRing = null;
            new ResizeObserver(() => this.resize()).observe(stage);
            stage.addEventListener('pointerdown', (e) => this.down(e));
            stage.addEventListener('pointermove', (e) => this.move(e));
            stage.addEventListener('pointerup', (e) => this.up(e));
            stage.addEventListener('pointercancel', (e) => this.up(e, true));
            stage.addEventListener('pointerleave', () => { this.pointer = null; this.drawOverlay(); });
            stage.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
            stage.addEventListener('contextmenu', (e) => e.preventDefault());
            this.watchDisplay();
        }

        // Moving the window to a display with another pixel density: zoom counts device pixels, so a fitted canvas fits
        // again and otherwise the view keeps its place on screen (EditorCanvas.viewDidChangeBackingProperties).
        watchDisplay() {
            const dpr = this.dpr;
            const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
            query.addEventListener('change', () => {
                const ratio = (this.zoom / this.dpr) / (this.zoom / dpr);
                if (!this.followsFit) { this.pan.x *= ratio; this.pan.y *= ratio; }
                this.resize();
                this.watchDisplay();
            }, { once: true });
        }

        get dpr() { return window.devicePixelRatio || 1; }
        // CSS pixels per document pixel: Compositor's zoom counts device pixels.
        get ppp() { return this.zoom / this.dpr; }

        resize() {
            const w = this.stage.clientWidth, h = this.stage.clientHeight, dpr = this.dpr;
            for (const c of [this.canvas, this.overlay]) {
                c.width = Math.max(1, Math.round(w * dpr));
                c.height = Math.max(1, Math.round(h * dpr));
            }
            if (this.followsFit && this.board.doc.manifest) this.fit();
            this.draw();
        }

        origin() {
            const doc = this.board.doc;
            return {
                x: this.stage.clientWidth / 2 - (doc.width * this.ppp) / 2 + this.pan.x,
                y: this.stage.clientHeight / 2 - (doc.height * this.ppp) / 2 + this.pan.y,
            };
        }

        toScreen(p) {
            const o = this.origin();
            return { x: o.x + p.x * this.ppp, y: o.y + p.y * this.ppp };
        }

        toDoc(p) {
            const o = this.origin();
            return { x: (p.x - o.x) / this.ppp, y: (p.y - o.y) / this.ppp };
        }

        local(e) {
            const r = this.stage.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }

        fit() {
            const doc = this.board.doc;
            const w = this.stage.clientWidth, h = this.stage.clientHeight;
            if (!doc.manifest || !w || !h) return;
            this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(Math.max(1, w - 2 * FIT_MARGIN) / doc.width, Math.max(1, h - 2 * FIT_MARGIN) / doc.height) * this.dpr));
            this.pan = { x: 0, y: 0 };
            this.followsFit = true;
            this.changedZoom();
        }

        // Keeps the document point under `anchor` (CSS px in the stage) where it is.
        zoomTo(zoom, anchor) {
            const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
            const at = anchor || { x: this.stage.clientWidth / 2, y: this.stage.clientHeight / 2 };
            const before = this.toDoc(at);
            this.zoom = z;
            const after = this.toScreen(before);
            this.pan.x += at.x - after.x;
            this.pan.y += at.y - after.y;
            this.followsFit = false;
            this.changedZoom();
        }

        zoomStep(direction) {
            const current = this.zoom;
            const next = direction > 0 ? ZOOM_LEVELS.find((z) => z > current + 1e-9) : [...ZOOM_LEVELS].reverse().find((z) => z < current - 1e-9);
            if (next !== undefined) this.zoomTo(next);
        }

        changedZoom() {
            this.board.updateStatus();
            this.draw();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Drawing

        draw() {
            const doc = this.board.doc;
            const ctx = this.canvas.getContext('2d');
            const dpr = this.dpr;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = this.board.canvasOnly ? '#000000' : '#1b1b1b';
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            if (!doc.manifest) return;
            const o = this.origin(), w = doc.width * this.ppp, h = doc.height * this.ppp;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.35)';
            ctx.shadowBlur = 14;
            ctx.shadowOffsetY = 3;
            ctx.fillStyle = '#424242';
            ctx.fillRect(o.x, o.y, w, h);
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.rect(o.x, o.y, w, h);
            ctx.clip();
            if (this.board.settings.checkerboard && !this.board.proofTable()) {
                // 10 pt squares fixed on screen, anchored at the document's top-left; the top-left square is lighter.
                ctx.fillStyle = '#4d4d4d';
                ctx.fillRect(o.x, o.y, w, h);
                ctx.fillStyle = '#595959';
                const x0 = Math.max(0, Math.floor(-o.x / 10)), y0 = Math.max(0, Math.floor(-o.y / 10));
                const x1 = Math.ceil(Math.min(w, this.stage.clientWidth - o.x) / 10), y1 = Math.ceil(Math.min(h, this.stage.clientHeight - o.y) / 10);
                for (let row = y0; row < y1; row++) {
                    for (let col = x0 + ((row + x0) & 1); col < x1; col += 2) ctx.fillRect(o.x + col * 10, o.y + row * 10, 10, 10);
                }
            }
            const composite = this.board.compositeCanvas();
            const proof = this.board.proofTable();
            if (proof) {
                // CMYK proof (EditorCanvas.swift:2762-2771): the picture as placed on screen, over white paper, through
                // the lookup; the edge line and every overlay stay unproofed.
                const x0 = Math.max(0, Math.floor(o.x * dpr)), y0 = Math.max(0, Math.floor(o.y * dpr));
                const x1 = Math.min(this.canvas.width, Math.ceil((o.x + w) * dpr)), y1 = Math.min(this.canvas.height, Math.ceil((o.y + h) * dpr));
                if (x1 > x0 && y1 > y0) {
                    const scratch = new OffscreenCanvas(x1 - x0, y1 - y0), sctx = scratch.getContext('2d');
                    sctx.fillStyle = '#ffffff';
                    sctx.fillRect(0, 0, scratch.width, scratch.height);
                    sctx.setTransform(dpr, 0, 0, dpr, -x0, -y0);
                    sctx.imageSmoothingEnabled = this.zoom < CRISP_ZOOM;
                    sctx.imageSmoothingQuality = 'high';
                    sctx.drawImage(composite, o.x, o.y, w, h);
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.drawImage(this.board.applyProof(scratch), x0, y0);
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                }
            } else {
                ctx.imageSmoothingEnabled = this.zoom < CRISP_ZOOM;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(composite, o.x, o.y, w, h);
            }
            ctx.restore();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.strokeStyle = 'rgba(255,255,255,0.13)';
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(o.x * dpr) - 0.5, Math.round(o.y * dpr) - 0.5, Math.round(w * dpr) + 1, Math.round(h * dpr) + 1);
            // While cropping, what lies past the canvas inside the frame shows too (media/crop.js).
            this.board.drawCropExtension(ctx, this);
            this.drawOverlay();
            // The rulers and the Navigator follow every pan and zoom.
            this.board.drawRulers();
            this.board.updateNavigator();
        }

        drawOverlay() {
            const ctx = this.overlay.getContext('2d');
            const dpr = this.dpr;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
            const board = this.board;
            if (!board.doc.manifest) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a84ff';

            // Pixel grid, layout grid and guides, under every other overlay (TransformOverlay.swift:186-195).
            board.drawViewLines(ctx);

            const module = board.toolModule();
            // The transform box (TransformOverlay.swift:348-375): an accent outline through the corner handles, 7 pt white
            // handles, and the rotation handle on its stick unless distorting.
            const geo = board.transformGeometry((q) => this.toScreen(q));
            if (geo) {
                const hs = geo.handles;
                ctx.strokeStyle = accent;
                ctx.lineWidth = 1;
                ctx.beginPath();
                [0, 2, 4, 6].forEach((i, k) => (k ? ctx.lineTo(hs[i].x, hs[i].y) : ctx.moveTo(hs[i].x, hs[i].y)));
                ctx.closePath();
                if (geo.rotation) {
                    ctx.moveTo(hs[1].x, hs[1].y);
                    ctx.lineTo(geo.rotation.x, geo.rotation.y);
                }
                ctx.stroke();
                ctx.fillStyle = '#ffffff';
                for (const h of hs) { ctx.fillRect(h.x - 3.5, h.y - 3.5, 7, 7); ctx.strokeRect(h.x - 3.5, h.y - 3.5, 7, 7); }
                if (geo.rotation) {
                    ctx.beginPath();
                    ctx.arc(geo.rotation.x, geo.rotation.y, 4, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }

            // A tool's own frame or line (crop, gradient) sits where the transform box does; brush tools draw theirs
            // with the brush circle below.
            if (module && module.drawOverlay && !board.isBrushTool()) {
                ctx.save();
                module.drawOverlay(ctx);
                ctx.restore();
            }

            // Marching ants and the outline being drawn.
            board.selectTools.drawOverlay(ctx);
            // An open filter panel's own overlay (Progressive Blur's line).
            if (board.filters.isOpen) board.filters.drawOverlay(ctx);

            // Snap feedback lines, last of the document overlays: accent, 1 point, across the document.
            if (this.guides.xs.length || this.guides.ys.length) {
                const a = this.toScreen({ x: 0, y: 0 }), b = this.toScreen({ x: board.doc.width, y: board.doc.height });
                ctx.strokeStyle = accent;
                ctx.lineWidth = 1;
                for (const x of this.guides.xs) { const s = this.toScreen({ x, y: 0 }).x; ctx.beginPath(); ctx.moveTo(s, a.y); ctx.lineTo(s, b.y); ctx.stroke(); }
                for (const y of this.guides.ys) { const s = this.toScreen({ x: 0, y }).y; ctx.beginPath(); ctx.moveTo(a.x, s); ctx.lineTo(b.x, s); ctx.stroke(); }
            }

            board.notes.draw(ctx, (p) => this.toScreen(p), { draft: this.drag && this.drag.kind === 'note' ? this.drag.rect : null });

            // The Move tool's layer box: a dashed black and white outline.
            if (this.drag && this.drag.kind === 'layer-box' && this.drag.rect) {
                const r = this.drag.rect;
                const cs = [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]].map(([x, y]) => this.toScreen({ x, y }));
                ctx.save();
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                cs.forEach((c, i) => (i ? ctx.lineTo(Math.round(c.x) + 0.5, Math.round(c.y) + 0.5) : ctx.moveTo(Math.round(c.x) + 0.5, Math.round(c.y) + 0.5)));
                ctx.closePath();
                ctx.strokeStyle = '#000000';
                ctx.stroke();
                ctx.lineDashOffset = 4;
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
                ctx.restore();
            }

            // A brush tool's own overlay (the clone source and its preview), under the brush circle.
            if (module && module.drawOverlay && board.isBrushTool()) {
                ctx.save();
                module.drawOverlay(ctx);
                ctx.restore();
            }

            // Brush circle: white 2.5 pt under black 1 pt, at the raw pointer (BrushCursorOverlay.swift), for every brush
            // tool unless the pointer is picking a color.
            const picking = this.palettePicking() || board.picker.isOpen;
            const brushTool = board.isBrushTool() && !this.space && !picking;
            if (brushTool && this.pointer && !(this.drag && (this.drag.kind === 'pan' || this.drag.kind === 'zoom-drag'))) {
                const centre = this.drag && this.drag.kind === 'brush-size' ? this.drag.screenStart : this.pointer;
                const d = Math.max(1, board.brush.diameter * this.ppp);
                const ring = (diameter, dash) => {
                    ctx.setLineDash(dash);
                    ctx.beginPath();
                    ctx.arc(centre.x, centre.y, diameter / 2, 0, Math.PI * 2);
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2.5;
                    ctx.stroke();
                    ctx.strokeStyle = '#000000';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                };
                ring(d, []);
                if (this.drag && this.drag.kind === 'brush-size' && this.drag.shift && board.brush.hardness > 0) ring(d * board.brush.hardness, [4, 3]);
                ctx.setLineDash([]);
            }

            // Sample ring: the new sample on top, the color before the drag below (SampleRingOverlay.swift).
            if (this.sampleRing && board.settings.sampleRing) {
                const { at, now, before } = this.sampleRing;
                const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
                const r = 58 - 15;
                ctx.lineWidth = 24;
                ctx.strokeStyle = '#737373';
                ctx.beginPath(); ctx.arc(at.x, at.y, r, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 16;
                ctx.strokeStyle = css(now);
                ctx.beginPath(); ctx.arc(at.x, at.y, r, Math.PI, 0); ctx.stroke();
                ctx.strokeStyle = css(before);
                ctx.beginPath(); ctx.arc(at.x, at.y, r, 0, Math.PI); ctx.stroke();
            }
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Input

        // palettePicking (EditorCanvas.swift:93): the Eyedropper, or Option held with Brush, Spot Healing or Gradient
        // while no stroke or gradient drag is in progress. Clone Stamp's Option sets its source; Smear's does nothing.
        palettePicking() {
            const tool = this.board.tool, drag = this.drag;
            if (tool === 'eyedropper') return true;
            return Boolean(this.altHeld && ['brush', 'spotHealing', 'gradient'].includes(tool) && !(drag && (drag.kind === 'stroke' || drag.kind === 'tool')));
        }

        cursor() {
            const board = this.board;
            const C = CB.SelectionCursors;
            const drag = this.drag;
            let cursor = 'default';
            if (drag && drag.kind === 'pan') cursor = 'grabbing';
            else if (drag && (drag.kind === 'zoom-drag' || (drag.kind === 'zoom-tool' && drag.moved))) cursor = drag.out ? 'zoom-out' : 'zoom-in';
            else if (this.space || board.tool === 'hand') cursor = 'grab';
            else if (board.tool === 'none') cursor = 'default';
            else if (board.tool === 'zoom') cursor = this.altHeld ? 'zoom-out' : 'zoom-in';
            else if (board.toolModule() && board.toolModule().cursor && board.toolModule().cursor()) cursor = board.toolModule().cursor();
            else if (board.isBrushTool() || board.tool === 'gradient') cursor = this.palettePicking() ? C.eyedropper('Sample') : 'crosshair';
            else if (board.tool === 'eyedropper') cursor = C.eyedropper('Sample');
            else if (board.selectTools.colorRange) cursor = board.selectTools.colorRangeCursor(this.mods || { shiftKey: false, altKey: this.altHeld });
            else if (board.tool === 'note') cursor = this.pointer && board.notes.hit(this.toDoc(this.pointer), this.ppp) ? 'pointer' : 'crosshair';
            else if (board.tool === 'shape') cursor = 'crosshair';
            else if (board.selectTools.isTool(board.tool)) {
                const mods = this.mods || { shiftKey: false, altKey: this.altHeld, metaKey: false, ctrlKey: false };
                cursor = board.selectTools.cursor(this.pointer ? this.toDoc(this.pointer) : { x: -1, y: -1 }, mods);
            }
            else if (board.tool === 'move') {
                // transformCursor (EditorCanvas.swift:1645-1666): handles first, then guides, then what a press would drag.
                const geo = this.pointer && board.transformGeometry((q) => this.toScreen(q));
                const hit = geo && TransformTool.hit(geo, this.pointer);
                const guide = !hit && this.pointer && board.hitGuide(this.pointer);
                const mods = this.mods || {};
                const command = Boolean(mods.metaKey || board.selectTools.heldCommand);
                if (this.drag && this.drag.kind === 'guide') cursor = this.drag.axis === 'vertical' || (board.guideDrag && board.guideDrag.axis === 'vertical') ? 'ew-resize' : 'ns-resize';
                else if (this.drag && this.drag.cursor) cursor = this.drag.cursor;
                else if (board.working) cursor = 'default';
                else if (hit && hit.mode === 'rotate') cursor = C.rotate;
                // Distorting (⌘ held, or already distorted) moves corners freely: the white arrow says so.
                else if (hit) cursor = (board.transformEdit && board.transformEdit.corners) || command ? board.distortCursor() : TransformTool.resizeCursor(geo, hit.index);
                else if (guide) cursor = guide.axis === 'vertical' ? 'ew-resize' : 'ns-resize';
                else if (this.pointer && this.cutsSelectedPixels(this.toDoc(this.pointer), this.pointer, { ...mods, metaKey: command })) cursor = this.altHeld ? C.duplicate : C.scissors;
                // With no layer selected, a press on a layer's pixels takes it (beginTransform): the Move cursor stays.
                else if (this.pointer && !board.selectTools.floating && board.activeID() && !this.transformPressLayer(this.toDoc(this.pointer), { ...mods, metaKey: command })) cursor = 'default';
                else cursor = this.altHeld ? C.duplicate : 'move';
            }
            // An open panel's armed eyedropper or targeted adjustment.
            const panelCursor = board.filters.isOpen && !this.space && !(drag && drag.kind === 'pan') ? board.filters.cursor() : null;
            this.stage.style.cursor = panelCursor || cursor;
        }

        setModifiers(e) {
            this.altHeld = e.altKey;
            this.mods = { shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey };
            this.cursor();
        }

        down(e) {
            const board = this.board;
            if (!board.doc.manifest) return;
            this.stage.focus();
            board.closeMenus();
            const p = this.local(e);
            const doc = this.toDoc(p);
            this.pointer = p;
            this.stage.setPointerCapture(e.pointerId);
            if (e.button === 1 || this.space || (board.tool === 'hand' && e.button === 0)) {
                if (e.button === 1 && (e.metaKey || e.ctrlKey)) this.drag = { kind: 'zoom-drag', start: p, from: this.zoom, anchor: p };
                else this.drag = { kind: 'pan', last: p };
                this.cursor();
                return;
            }
            // While the color picker is open, a click anywhere samples into it.
            if (board.picker.isOpen && e.button === 0) {
                this.drag = { kind: 'sample', before: (board.picker.isOpen ? board.picker.rgb() : board.colors.fg) };
                this.sample(doc, p, true);
                return;
            }
            // While a filter panel is open the canvas can be panned and zoomed, not edited; the panel may take the press
            // (Progressive Blur's line, the Levels and Hue/Saturation eyedroppers and targeted adjustment).
            if (board.filters.isOpen && e.button === 0) {
                const handler = board.filters.canvasPress(doc, p, e);
                if (handler) this.drag = { kind: 'panel', handler };
                else if (board.tool === 'zoom') this.drag = { kind: 'zoom-tool', start: p, from: this.zoom, alt: e.altKey };
                this.cursor();
                return;
            }
            // While Color Range is open, a click picks a color for it with any tool.
            const st = board.selectTools;
            if (st.colorRange && e.button === 0) {
                this.drag = { kind: 'color-range' };
                st.pickColorRange(doc, e.shiftKey, e.altKey);
                return;
            }
            const tool = board.tool;
            if (st.isTool(tool) && e.button === 0) {
                this.drag = { kind: 'select' };
                st.down(doc, p, e);
                this.cursor();
                return;
            }
            if (board.isBrushTool(tool) && e.button === 2) {
                this.drag = { kind: 'brush-size', start: p, screenStart: p, diameter: board.brush.diameter, hardness: board.brush.hardness, shift: e.shiftKey };
                return;
            }
            if (e.button !== 0 || tool === 'none') return;
            this.altHeld = e.altKey;
            const module = board.toolModule();
            if (tool === 'zoom') this.drag = { kind: 'zoom-tool', start: p, from: this.zoom, alt: e.altKey };
            else if (this.palettePicking()) {
                this.drag = { kind: 'sample', before: board.colors.fg };
                this.sample(doc, p, false);
            } else if (module) {
                // A module takes the press with a drag of its own ('tool') or a stroke it started (startStroke).
                if (module.down && module.down(doc, p, e) && !this.drag) this.drag = { kind: 'tool' };
                this.cursor();
                this.drawOverlay();
            } else if (tool === 'brush') this.beginStroke(doc, e);
            // Double-click live text with the Move tool to edit it (EditorCanvas.swift:1853-1855, 2584-2597).
            else if (tool === 'move' && board.openTextAt && board.openTextAt(doc, e)) this.cursor();
            else if (tool === 'move' && board.hitGuide(p) && board.beginGuideMove(board.hitGuide(p))) this.drag = { kind: 'guide', axis: board.guideDrag.axis };
            else if (tool === 'move' && this.cutsSelectedPixels(doc, p, e)) {
                // The selection's own pixel drag (SelectTools.beginPixelMove): one "Move Pixels" / "Duplicate Pixels" step.
                this.drag = { kind: 'select', cursor: e.altKey ? CB.SelectionCursors.duplicate : CB.SelectionCursors.scissors };
                st.beginPixelMove(doc, e.altKey);
            } else if (tool === 'move') this.beginTransform(doc, p, e);
            else if (tool === 'shape') this.beginShape(doc, e);
            else if (tool === 'note') this.beginNote(doc);
        }

        move(e) {
            const p = this.local(e);
            this.pointer = p;
            this.altHeld = e.altKey;
            this.mods = { shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey };
            const drag = this.drag;
            if (!drag) {
                // A polygon in progress follows the pointer between clicks.
                if (this.board.selectTools.isTool(this.board.tool) && this.board.selectTools.draft) this.board.selectTools.move(this.toDoc(p), p, e);
                const module = this.board.toolModule();
                if (module && module.hover && this.board.doc.manifest) module.hover(this.toDoc(p), p, e);
                this.cursor();
                this.drawOverlay();
                return;
            }
            const doc = this.toDoc(p);
            switch (drag.kind) {
                case 'pan':
                    this.pan.x += p.x - drag.last.x;
                    this.pan.y += p.y - drag.last.y;
                    drag.last = p;
                    this.followsFit = false;
                    this.draw();
                    break;
                case 'zoom-drag':
                    drag.out = p.y > (drag.lastY === undefined ? drag.start.y : drag.lastY);
                    drag.lastY = p.y;
                    this.zoomTo(drag.from * Math.pow(2, (drag.start.y - p.y) / 100), drag.anchor);
                    this.cursor();
                    break;
                case 'zoom-tool':
                    // Once past 3 points it stays a drag, even back over the start (scrubby zoom).
                    if (drag.moved || Math.abs(p.x - drag.start.x) >= 3) {
                        drag.moved = true;
                        drag.out = p.x < (drag.lastX === undefined ? drag.start.x : drag.lastX);
                        drag.lastX = p.x;
                        this.zoomTo(drag.from * Math.pow(2, (p.x - drag.start.x) / 100), drag.start);
                        this.cursor();
                    }
                    break;
                case 'sample':
                    this.sample(doc, p, this.board.picker.isOpen);
                    break;
                case 'panel':
                    if (drag.handler.move) drag.handler.move(doc, p, e);
                    this.drawOverlay();
                    break;
                case 'brush-size':
                    this.resizeBrush(p, e.shiftKey);
                    break;
                case 'stroke':
                    this.continueStroke(doc, e);
                    break;
                case 'guide':
                    // A drag started from a ruler is followed by the ruler itself.
                    if (drag.axis) this.board.moveGuideDrag(drag.axis === 'horizontal' ? doc.y : doc.x);
                    break;
                case 'tool': {
                    const module = this.board.toolModule();
                    if (module && module.move) module.move(doc, p, e);
                    this.cursor();
                    this.drawOverlay();
                    break;
                }
                case 'transform':
                    if (Math.hypot(p.x - (drag.screenStart || p).x, p.y - (drag.screenStart || p).y) >= 3) drag.moved = true;
                    this.continueTransform(doc, e);
                    break;
                case 'layer-box':
                    if (drag.rect || Math.hypot(p.x - drag.screenStart.x, p.y - drag.screenStart.y) >= 3) {
                        drag.rect = { x: Math.min(drag.start.x, doc.x), y: Math.min(drag.start.y, doc.y), width: Math.abs(doc.x - drag.start.x), height: Math.abs(doc.y - drag.start.y) };
                        this.drawOverlay();
                    }
                    break;
                case 'shape':
                    this.continueShape(doc, e);
                    break;
                case 'note':
                    drag.rect = { x: drag.start.x, y: drag.start.y, width: doc.x - drag.start.x, height: doc.y - drag.start.y };
                    this.drawOverlay();
                    break;
                case 'select':
                    this.board.selectTools.move(doc, p, e);
                    this.autoscroll(p, e);
                    this.cursor();
                    break;
            }
        }

        // Dragging an outline past the view's edge scrolls the document under it (EditorCanvas.autoscroll): within
        // 12 pt of an edge or beyond it, 2 + 0.4 x the overshoot points a frame, at most 40, and the drag follows.
        autoscroll(p, e) {
            const margin = 12, w = this.stage.clientWidth, h = this.stage.clientHeight;
            const speed = (over) => (over > 0 ? Math.min(40, 2 + 0.4 * over) : 0);
            const dx = speed(margin - p.x) - speed(p.x - (w - margin));
            const dy = speed(margin - p.y) - speed(p.y - (h - margin));
            const st = this.board.selectTools;
            const moving = st.outlineMove || st.pixelMove || (st.draft && st.draft.kind !== 'Polygonal');
            if (!moving || (!dx && !dy)) { this.scrolling = null; return; }
            const first = !this.scrolling;
            this.scrolling = { dx, dy, p, e };
            if (!first) return;
            const step = () => {
                const s = this.scrolling;
                if (!s || !this.drag || this.drag.kind !== 'select') { this.scrolling = null; return; }
                this.pan.x += s.dx;
                this.pan.y += s.dy;
                this.followsFit = false;
                this.board.selectTools.move(this.toDoc(s.p), s.p, s.e);
                this.draw();
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        }

        up(e, cancelled = false) {
            const drag = this.drag;
            this.drag = null;
            if (!drag) return;
            const p = this.local(e);
            const doc = this.toDoc(p);
            switch (drag.kind) {
                case 'zoom-tool':
                    if (!drag.moved) this.zoomTo(this.zoom * (drag.alt ? 0.5 : 2), drag.start);
                    break;
                case 'panel':
                    if (drag.handler.up) drag.handler.up(doc, p, e, cancelled);
                    break;
                case 'sample':
                    this.sampleRing = null;
                    if (this.lastSample) CB.PaintTools.refineSample(this.board, this.lastSample, this.board.picker.isOpen);
                    this.lastSample = null;
                    if (this.board.picker.isOpen) this.board.picker.element.focus();
                    break;
                case 'stroke':
                    if (cancelled) this.cancelStroke(drag);
                    else this.finishStroke(drag, doc);
                    break;
                case 'guide':
                    // Released over a ruler, the guide is deleted (with rulers hidden it cannot be).
                    if (cancelled) this.board.cancelGuideDrag();
                    else this.board.finishGuideDrag(this.board.rulersShown() && (p.x < 0 || p.y < 0));
                    break;
                case 'tool': {
                    const module = this.board.toolModule();
                    if (cancelled && module && module.cancel) module.cancel();
                    else if (!cancelled && module && module.up) module.up(doc, p, e);
                    break;
                }
                case 'transform':
                    if (cancelled) this.cancelTransform(drag);
                    else this.finishTransform(drag);
                    if (!cancelled && drag.unselect && !drag.moved && !drag.pending) this.extendLayerSelection(drag.unselect);
                    if (!cancelled && drag.blank && !drag.moved && !drag.pending) this.board.deselectLayers();
                    break;
                case 'layer-box':
                    if (!cancelled) this.finishLayerBox(drag);
                    break;
                case 'shape':
                    if (!cancelled) this.finishShape(drag);
                    else this.board.setShapeDraft(null);
                    break;
                case 'note':
                    this.finishNote(drag);
                    break;
                case 'select':
                    this.scrolling = null;
                    if (cancelled) this.board.selectTools.cancelPointer();
                    else this.board.selectTools.up(doc, p, e);
                    break;
            }
            if (drag.kind !== 'select') this.guides = { xs: [], ys: [] };
            this.cursor();
            this.drawOverlay();
        }

        // Escape: cancel whatever drag is in progress, without an undo step.
        cancel() {
            const drag = this.drag;
            if (!drag) return false;
            this.drag = null;
            if (drag.kind === 'stroke') this.cancelStroke(drag);
            else if (drag.kind === 'guide') this.board.cancelGuideDrag();
            else if (drag.kind === 'tool') { const module = this.board.toolModule(); if (module && module.cancel) module.cancel(); }
            else if (drag.kind === 'panel') { if (drag.handler.up) drag.handler.up(null, null, null, true); }
            else if (drag.kind === 'transform') this.cancelTransform(drag);
            else if (drag.kind === 'shape') this.board.setShapeDraft(null);
            else if (drag.kind === 'select') this.board.selectTools.cancelPointer();
            this.guides = { xs: [], ys: [] };
            this.sampleRing = null;
            this.drawOverlay();
            return true;
        }

        // A drag that owns the layer's pixels. Selection drags stay open to keys (⌫ removes a corner mid-drag).
        get busy() {
            const drag = this.drag;
            if (drag && drag.kind === 'tool') {
                const module = this.board.toolModule();
                return !(module && module.busy) || Boolean(module.busy());
            }
            return Boolean(drag && (['stroke', 'transform', 'shape', 'guide'].includes(drag.kind) || (drag.kind === 'select' && this.board.selectTools.pixelMove)));
        }

        // EditorCanvas.scrollWheel / magnify (EditorCanvas.swift:2182-2199): blocked during a transform, crop or guide drag
        // and a stroke only, so a shape draft or a pixel move can still be zoomed and scrolled.
        wheelBlocked() {
            const d = this.drag;
            return Boolean(d && (['stroke', 'transform', 'guide'].includes(d.kind) || (d.kind === 'tool' && this.board.tool === 'crop')));
        }

        wheel(e) {
            e.preventDefault();
            if (this.wheelBlocked()) return;
            const p = this.local(e);
            const line = e.deltaMode === 1 ? 12 : e.deltaMode === 2 ? this.stage.clientHeight : 1;
            if (e.ctrlKey) {
                // A trackpad pinch arrives as a wheel event with ctrlKey.
                this.zoomTo(this.zoom * Math.exp(-e.deltaY / 100), p);
            } else if (e.metaKey || e.altKey) {
                // zoom *= exp(-scrollingDeltaY * 0.015); the DOM's deltaY is AppKit's scrollingDeltaY negated.
                this.zoomTo(this.zoom * Math.exp(e.deltaY * line * 0.015), p);
            } else {
                this.pan.x -= e.deltaX * line;
                this.pan.y -= e.deltaY * line;
                this.followsFit = false;
                this.draw();
            }
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Eyedropper: one document pixel of the merged visible composite; transparent pixels leave the color alone.

        sample(doc, screen, intoPicker) {
            const board = this.board;
            const x = Math.floor(doc.x), y = Math.floor(doc.y);
            if (x < 0 || y < 0 || x >= board.doc.width || y >= board.doc.height) return;
            const data = board.compositeCanvas().getContext('2d').getImageData(x, y, 1, 1).data;
            if (data[3] === 0) {
                // Nothing to sample there: the ring still shows, with the current color.
                const current = intoPicker ? board.picker.rgb() : board.colors.fg;
                this.sampleRing = { at: screen, now: current, before: this.drag ? this.drag.before : current };
                this.drawOverlay();
                return;
            }
            const rgb = [data[0] / 255, data[1] / 255, data[2] / 255];
            this.lastSample = doc;
            if (intoPicker) board.picker.sample(rgb);
            else {
                // The RGB foreground, even with a mask selected (ColorPalette.swift:232-237; paint-tools.md 6, quirk 10).
                board.colors.fg = rgb;
                board.renderRail();
                board.renderOptions();
            }
            this.sampleRing = { at: screen, now: rgb, before: this.drag ? this.drag.before : rgb };
            this.drawOverlay();
        }

        resizeBrush(p, shift) {
            const board = this.board, drag = this.drag;
            const dx = p.x - drag.start.x;
            drag.shift = shift;
            if (shift) {
                board.brush.hardness = Math.min(1, Math.max(0, drag.hardness + dx / 200));
                board.brush.diameter = drag.diameter;
            } else {
                const perPixel = Math.max(0.0001, this.ppp);
                board.brush.diameter = Math.min(2000, Math.max(1, Math.round(drag.diameter + (2 * dx) / perPixel)));
                board.brush.hardness = drag.hardness;
            }
            board.renderOptions();
            this.drawOverlay();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Brush and eraser (EditorCanvas brush handling, EditorSession+Brush.swift)

        beginStroke(doc, e) {
            const board = this.board;
            // A press while an engine commit is in flight waits, as upstream's waits while isProjectBusy.
            if (board.working) return;
            const record = board.doc.layer(board.activeID());
            const refusal = board.paintRefusal(record);
            if (refusal) {
                board.alert('Couldn\u2019t paint', refusal);
                return;
            }
            const sel = board.selection;
            const entry = board.doc.entry(record.id);
            const settings = { ...board.brush, color: board.colors.fg, erasing: board.brushMode === 'erase' };
            // With the mask as the target the stroke paints the mask, in black or white (brush.md 11).
            const target = board.isMaskSelected && record.maskFile && entry.mask ? this.maskStrokeTarget(record, entry.mask) : null;
            let stroke;
            try {
                stroke = new Brush.PaintStroke({
                    layer: target ? target.layer : { transform: Transform.read(record.transform, [board.doc.width, board.doc.height]), image: entry.image },
                    docWidth: board.doc.width, docHeight: board.doc.height, settings, pixelBudget: board.pixelBudget(record.id),
                    budgetMegapixels: Math.round(board.documentPixelBudget() / 1e6),
                    selection: sel ? CB.Selection.clip(sel, board.doc.width, board.doc.height) : null,
                    mask: target ? { white: board.maskPaintWhite, background: target.background } : null,
                });
            } catch (error) {
                board.alert('Couldn\u2019t paint', error.message);
                return;
            }
            // A 16-bit layer keeps its 16 bits (BrushStroke.swift:966): the stroke previews on the 8-bit copy shown here and
            // commits through compositor-engine (paint-tools.md 1.8).
            const deep = !target && entry.image && entry.image.deep;
            const onFinish = deep ? (drag) => CB.PaintTools.engineStroke(board, drag, {
                tool: 'brush', mode: board.brushMode === 'erase' ? 'Erase' : 'Paint', label: board.brushMode === 'erase' ? 'Erase' : 'Brush Stroke',
            }) : null;
            this.startStroke(doc, e, { record, stroke, mask: target, isMask: Boolean(target), smoothing: true, onFinish });
        }

        // A stroke drag for any brush tool (EditorCanvas.swift:1820-1840, 1957-1981, 2121-2126). Shift-click draws a
        // straight line on from where the last stroke on the same layer and target ended; Shift while dragging keeps
        // the stroke on one axis. `drag.points` keeps exactly what the canvas hands EditorSession (the press, or the
        // last end then the click; every drag point after the axis lock; the raw release), so compositor-engine can
        // replay the stroke. Options: { record, stroke (append, flush, display), mask (a maskStrokeTarget) or null,
        // isMask, smoothing (the Brush's lazy string), onFinish(drag, release) instead of the Brush's own commit,
        // onCancel(drag), display(drag) -> the renderer override to show instead of stroke.display() }.
        startStroke(doc, e, options) {
            const board = this.board, { record, stroke } = options;
            const drag = {
                kind: 'stroke', stroke, layerID: record.id, mask: options.mask || null, isMask: Boolean(options.isMask),
                smoothing: Boolean(options.smoothing), onFinish: options.onFinish || null, onCancel: options.onCancel || null,
                display: options.display || null, anchor: null, axisAnchor: null, axisHorizontal: null, lastPixel: doc, points: [],
            };
            this.drag = drag;
            board.beginLive(record.id);
            const last = board.lastBrushPoint;
            try {
                if (e.shiftKey && last && last.layerID === record.id && Boolean(last.mask) === drag.isMask) {
                    // Shift-click: a straight line on from where the last stroke ended.
                    stroke.append(last.point);
                    drag.points.push(last.point, doc);
                    drag.anchor = last.point;
                    this.appendSample(drag, doc);
                } else {
                    stroke.append(doc);
                    drag.points.push(doc);
                    drag.anchor = doc;
                    board.lastBrushPoint = { layerID: record.id, point: doc, mask: drag.isMask };
                }
            } catch (error) {
                this.failStroke(drag, error);
                return null;
            }
            drag.axisAnchor = e.shiftKey ? doc : null;
            this.showStroke(drag);
            return drag;
        }

        // One sample through the lazy-string smoothing (the Brush only).
        appendSample(drag, point) {
            const board = this.board;
            const result = drag.smoothing ? Brush.smoothed(drag.anchor, point, board.brush.smoothing, this.zoom) : { point, anchor: point };
            drag.anchor = result.anchor;
            if (!result.point) return;
            drag.stroke.append(result.point);
            board.lastBrushPoint = { layerID: drag.layerID, point: result.point, mask: drag.isMask };
        }

        continueStroke(doc, e) {
            const drag = this.drag;
            let pixel = doc;
            // Shift keeps the stroke horizontal or vertical from where it was pressed, decided after 3 px of movement.
            if (e.shiftKey) {
                const anchor = drag.axisAnchor || drag.lastPixel || pixel;
                if (!drag.axisAnchor) { drag.axisAnchor = anchor; drag.axisHorizontal = null; }
                if (drag.axisHorizontal === null && Math.hypot(pixel.x - anchor.x, pixel.y - anchor.y) >= 3) {
                    drag.axisHorizontal = Math.abs(pixel.x - anchor.x) >= Math.abs(pixel.y - anchor.y);
                }
                if (drag.axisHorizontal === null) pixel = anchor;
                else pixel = drag.axisHorizontal ? { x: pixel.x, y: anchor.y } : { x: anchor.x, y: pixel.y };
            } else {
                drag.axisAnchor = null;
                drag.axisHorizontal = null;
            }
            drag.lastPixel = pixel;
            drag.locked = Boolean(e.shiftKey);
            drag.points.push(pixel);
            try {
                this.appendSample(drag, pixel);
            } catch (error) {
                this.failStroke(drag, error);
                return;
            }
            this.showStroke(drag);
        }

        showStroke(drag) {
            const display = drag.display ? drag.display(drag) : drag.stroke.display();
            if (display && drag.mask) this.board.renderer.overrides.set(drag.layerID, { mask: { ...display, background: drag.mask.background } });
            else if (display) this.board.renderer.overrides.set(drag.layerID, display);
            this.board.liveChanged();
        }

        // The grid a mask stroke paints in (brush.md 11): an unplaced mask in its layer's pixel grid, stretched over it;
        // a placed one in its own grid at its placement (a solid one, 2×2 or smaller, one pixel per document pixel). The
        // mask is handed to the stroke as an alpha picture.
        maskStrokeTarget(record, mask) {
            const board = this.board, size = [board.doc.width, board.doc.height];
            const placed = record.maskPlacement && !CB.Render.samePlacement(record.maskPlacement, record.transform);
            const transform = Transform.read(placed ? record.maskPlacement : record.transform, size);
            const image = board.doc.entry(record.id).image;
            let w, h;
            if (!placed && image) { w = image.width; h = image.height; }
            else if (placed && (mask.width > 2 || mask.height > 2)) { w = mask.width; h = mask.height; }
            else { w = Math.max(1, Math.round(transform.width)); h = Math.max(1, Math.round(transform.height)); }
            const grid = new OffscreenCanvas(w, h);
            const ctx = grid.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(mask.alpha, 0, 0, w, h);
            return { layer: { transform, image: grid }, background: CB.Render.maskBackground(mask), placed };
        }

        finishStroke(drag, doc) {
            const board = this.board;
            drag.points.push(doc);
            if (drag.onFinish) {
                try {
                    drag.onFinish(drag, doc);
                } catch (error) {
                    this.failStroke(drag, error);
                }
                return;
            }
            try {
                // The stroke ends where the hand did: the raw point, unless Shift has it locked to an axis.
                if (!drag.locked) drag.stroke.append(doc);
                else if (board.brush.smoothing > 0 && drag.lastPixel) drag.stroke.append(drag.lastPixel);
                drag.stroke.flush();
                const result = drag.stroke.commit();
                board.renderer.overrides.delete(drag.layerID);
                board.endLive();
                if (result && drag.mask) board.commitMaskStroke(drag.layerID, result, drag.mask.placed);
                else if (result) board.commitStroke(drag.layerID, result, drag.stroke.settings.erasing ? 'Erase' : 'Brush Stroke');
            } catch (error) {
                this.failStroke(drag, error);
            }
        }

        cancelStroke(drag) {
            if (drag.onCancel) drag.onCancel(drag);
            this.board.renderer.overrides.delete(drag.layerID);
            this.board.endLive();
        }

        failStroke(drag, error) {
            this.drag = null;
            this.cancelStroke(drag);
            this.board.alert('Couldn\u2019t paint', error.message);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Move / Transform (EditorCanvas beginTransformDrag, transformPressLayer, TransformDrag; geometry.md 4). The edit
        // itself (board.transformEdit) lives in media/transform.js.

        // The layer a press that misses the handles drags, and whether it was picked from under the pointer
        // (EditorCanvas.swift:1674-1711). ⌘ flips Auto Select for the press; ⌘⇧ (or ⌘ with Auto Select off) takes the
        // layer under the pointer; several selected layers or a folder keep the press inside their box, and outside it
        // unless Auto Select finds a layer there; a press on empty canvas still drags the active layer.
        transformPressLayer(doc, mods) {
            const board = this.board;
            if (!board.doc.manifest || !(board.canEditLayers() || board.transformEdit)) return null;
            const under = board.layerUnder(doc);
            const a = board.activeLayer();
            const active = a && board.doc.entry(a.id).image && !a.isGroup && board.effectivelyVisible(a) ? a : null;
            const picks = !board.transformEdit;
            const command = Boolean(mods.metaKey);
            const autoSelect = board.settings.autoSelect !== command;
            if (command && (mods.shiftKey || !board.settings.autoSelect) && picks && under) return { id: under.id, picked: true };
            if (board.transformsAsGroup() && board.activeID()) {
                const box = board.transformEdit ? board.transformEdit.draft : board.groupBox();
                if ((box && TransformTool.contains(box, doc)) || !(picks && autoSelect) || !under) return { id: board.activeID(), picked: false };
            }
            if (active) {
                const e = board.transformEdit;
                const edited = e && e.layerID === active.id ? e.draft : board.transformTargetsMask() ? board.maskTransformOf(active) : board.layerTransform(active);
                if (TransformTool.contains(edited, doc)) {
                    // A later layer in the draw order is painted above: Auto Select prefers it, so a full-canvas
                    // background never hides a foreground layer.
                    if (picks && autoSelect && under && under.id !== active.id && board.isAbove(under.id, active.id)) return { id: under.id, picked: true };
                    return { id: active.id, picked: false };
                }
            }
            if (picks && autoSelect && under) return { id: under.id, picked: true };
            return active ? { id: active.id, picked: false } : null;
        }

        // ⌘⇧-click: the layer under the pointer joins the selection, or leaves it (LayerGroups.extendSelection).
        extendLayerSelection(id) {
            const board = this.board;
            const ids = new Set(board.selectedIDs);
            if (ids.has(id) && ids.size > 1) {
                ids.delete(id);
                board.selectLayers(ids, board.activeID() === id ? [...ids][0] : board.activeID());
            } else {
                ids.add(id);
                board.selectLayers(ids, id);
            }
        }

        // A board choice, as in Photoshop (Compositor has no layer box): with Auto Select on, or flipped on by ⌘, a press
        // where no layer but a background shows pixels (off the canvas included) draws a box instead of dragging, inside
        // the transform box too, since blank layers fill the canvas; their pixels and the handles still drag.
        startsLayerBox(doc, e) {
            const board = this.board;
            if (board.transformEdit || board.settings.autoSelect === Boolean(e.metaKey)) return false;
            return !board.layerShownAt(doc, { backgrounds: false });
        }

        // The layers the box touches become the selection (Shift at the press adds them), the topmost one active. A press
        // that did not drag is the click Compositor's press would have been, or a Shift-click on the background there.
        finishLayerBox(drag) {
            const board = this.board, mods = drag.mods;
            if (!drag.rect) {
                if (drag.blank) {
                    board.deselectLayers();
                    return;
                }
                if (mods.shiftKey && !mods.metaKey) {
                    const shown = board.layerShownAt(drag.start);
                    if (shown) this.extendLayerSelection(shown.id);
                    return;
                }
                const target = this.transformPressLayer(drag.start, mods);
                if (target && target.picked && mods.metaKey && mods.shiftKey) this.extendLayerSelection(target.id);
                else if (target && target.picked) board.selectLayer(target.id);
                return;
            }
            const ids = board.layersShownIn(drag.rect).map((l) => l.id);
            if (!ids.length) return;
            const next = new Set(mods.shiftKey ? [...board.selectedIDs, ...ids] : ids);
            board.selectLayers(next, mods.shiftKey ? board.activeID() : null);
        }

        // A board choice, not Compositor's (where the Move tool always drags the layer): as in Photoshop, a Move-tool press
        // inside the selection that misses the handles cuts and drags the active layer's selected pixels, ⌥ copies them.
        // ⌘ keeps picking the layer under the pointer; folders, adjustment, live text and shape layers, a targeted mask,
        // several selected layers and a pending transform still drag as before.
        cutsSelectedPixels(doc, p, e) {
            const board = this.board, sel = board.selection;
            if (e.metaKey || board.selectTools.floating || board.transformEdit || !board.hasPixelsSelected()) return false;
            if (!CB.Selection.contains(sel, doc.x, doc.y)) return false;
            const geo = board.transformGeometry((q) => this.toScreen(q));
            if (geo && TransformTool.hit(geo, p)) return false;
            const record = board.activeLayer();
            if (!record || record.isGroup || record.adjustment || record.text || record.shape || board.isMaskSelected) return false;
            return board.selectedIDs.size <= 1 && Boolean(board.doc.entry(record.id).image);
        }

        beginTransform(doc, p, e) {
            const board = this.board;
            const floating = board.selectTools.floating;
            if (floating) {
                // The floating pixels take every press: handles resize or rotate, anywhere else moves.
                const hit = TransformTool.hit(TransformTool.geometry(floating.draft, (q) => this.toScreen(q)), p);
                const mode = hit || { mode: 'move' };
                this.drag = {
                    kind: 'transform', floating: true, layerID: floating.sourceID, original: { ...floating.draft }, draft: floating.draft, start: doc,
                    mode: mode.mode, index: mode.index, duplicate: false,
                    cursor: mode.mode === 'rotate' ? CB.SelectionCursors.rotate : mode.mode === 'resize' ? this.stage.style.cursor : 'move',
                };
                board.beginLive(floating.sourceID);
                return;
            }
            if (!(board.canEditLayers() || board.transformEdit)) return;
            const geo = board.transformGeometry((q) => this.toScreen(q));
            let hit = geo && TransformTool.hit(geo, p), unselect = null, blank = false;
            if (!hit) {
                // A board choice, as in Photoshop: a plain click where no layer but a background shows a pixel (off the
                // canvas too) selects no layer, once it is released without dragging; a drag from there does what the
                // press does. A background (opaque over the whole canvas) is the page here, as for the layer box. With
                // no layer selected, a press on a layer's pixels takes that layer, Auto Select or not.
                const plain = !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && !board.transformEdit;
                const shownHere = plain ? board.layerShownAt(doc, { backgrounds: false }) : null;
                blank = plain && !shownHere;
                if (this.startsLayerBox(doc, e)) {
                    this.drag = { kind: 'layer-box', start: doc, screenStart: p, rect: null, cursor: 'default', blank, mods: { shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey } };
                    this.cursor();
                    return;
                }
                // Shift-click (a board choice, as in Photoshop): the layer showing pixels there joins the selection now, so
                // the drag moves it too; one already selected leaves it on release when the press did not drag.
                const shown = !board.transformEdit && e.shiftKey && !e.metaKey ? board.layerShownAt(doc) : null;
                if (shown && !board.selectedIDs.has(shown.id)) this.extendLayerSelection(shown.id);
                else if (shown) unselect = shown.id;
                else {
                    const target = this.transformPressLayer(doc, e) || (shownHere && !board.activeID() ? { id: shownHere.id, picked: true } : null);
                    // Nothing that this press could drag: a blank one selects no layer now.
                    if (!target) {
                        if (blank) board.deselectLayers();
                        return;
                    }
                    if (target.picked && e.metaKey && e.shiftKey) this.extendLayerSelection(target.id);
                    else if (target.picked) board.selectLayer(target.id);
                }
                hit = { mode: 'move' };
            }
            const duplicate = hit.mode === 'move' && e.altKey;
            // A value the Move bar's fields were still changing is applied first: this drag is an edit of its own.
            if (board.transformEdit && board.transformEdit.fromFields) board.commitTransformEdit();
            // A selection that cannot move (a locked layer in it) still lets the Shift-click take the layer out.
            if (unselect && !board.transformEdit && !board.canTransform()) { this.extendLayerSelection(unselect); return; }
            // A blank press on a layer that cannot move (a locked one) selects no layer now, instead of the refusal.
            if (blank && !board.transformEdit && !board.canTransform()) { board.deselectLayers(); return; }
            if (!board.transformEdit && !board.beginTransformEdit(false, { copying: duplicate })) return;
            let mode = hit.mode;
            // ⌘-dragging a handle distorts; once distorted, handles keep distorting (EditorCanvas.swift:2630-2634).
            if (mode === 'resize' && (e.metaKey || board.transformEdit.corners)) {
                board.beginDistort();
                if (board.transformEdit.corners) mode = 'distort';
            }
            const edit = board.transformEdit, C = CB.SelectionCursors;
            this.drag = {
                kind: 'transform', mode, index: hit.index, start: doc, original: { ...edit.draft },
                originalCorners: edit.corners ? edit.corners.map((c) => ({ ...c })) : null, duplicate, unselect, blank, screenStart: p,
                // The cursor at the press is kept for the whole drag.
                cursor: mode === 'rotate' ? C.rotate : mode === 'distort' ? board.distortCursor()
                    : mode === 'resize' ? TransformTool.resizeCursor(geo, hit.index) : duplicate ? C.duplicate : 'move',
            };
            board.beginLive(board.transformLiveID());
        }

        continueTransform(doc, e, drag = this.drag) {
            const board = this.board;
            if (drag.floating) {
                const tolerance = TransformTool.SNAP_DISTANCE / Math.max(this.ppp, 0.0001);
                const targets = board.alignmentSnapTargets(new Set(), true);
                const options = { lockRatio: board.settings.lockRatio, shift: e.shiftKey, option: e.altKey };
                const update = (q) => TransformTool.updated(drag, q, options);
                let point = doc, guides = { xs: [], ys: [] };
                if (drag.mode === 'resize' && !e.ctrlKey) ({ point, guides } = TransformTool.snappedResizePoint(doc, drag, { proportional: board.settings.lockRatio !== e.shiftKey, targets, tolerance, update }));
                let draft = TransformTool.rounded(update(point));
                if (drag.mode === 'move' && !e.ctrlKey) ({ draft, guides } = TransformTool.snappedMove(draft, targets, tolerance));
                this.guides = guides;
                board.selectTools.floating.draft = { ...drag.original, ...draft };
                board.liveChanged();
                board.refreshOptionValues();
                return;
            }
            if (drag.duplicate) {
                // Option at the press: the first movement copies the selected layers (in the engine, folders and 16-bit
                // pixels included) and the drag then moves the copies; moves meanwhile are kept and replayed.
                drag.duplicate = false;
                drag.last = { doc, e };
                drag.pending = board.beginDuplicateTransform().then((ok) => {
                    drag.pending = null;
                    const edit = board.transformEdit;
                    if (ok && edit) {
                        drag.original = { ...edit.draft };
                        board.endLive();
                        board.beginLive(board.transformLiveID());
                    }
                    if (drag.ended) {
                        board.endLive();
                        if (drag.cancelled) board.cancelTransformEdit();
                        else if (board.transformEdit && !board.transformEdit.persistent) board.commitTransformEdit();
                        return;
                    }
                    if (edit) this.continueTransform(drag.last.doc, drag.last.e, drag);
                });
                return;
            }
            if (drag.pending) { drag.last = { doc, e }; return; }
            const edit = board.transformEdit;
            if (!edit) return;
            const corners = TransformTool.draggedCorners(drag, doc, e.shiftKey);
            if (corners) {
                board.previewCorners(corners);
                return;
            }
            // Moving and resizing snap to the canvas and the other layers (a resized layer's dragged edges); rotating is
            // left alone; Control drags freely. Drags land on whole pixels and whole degrees (EditorCanvas.swift:2005-2026).
            const tolerance = TransformTool.SNAP_DISTANCE / Math.max(this.ppp, 0.0001);
            const targets = board.alignmentSnapTargets(board.transformMoving(), true);
            const options = { lockRatio: board.settings.lockRatio, shift: e.shiftKey, option: e.altKey };
            const update = (q) => TransformTool.updated(drag, q, options);
            let point = doc;
            let guides = { xs: [], ys: [] };
            if (drag.mode === 'resize' && !e.ctrlKey) {
                const snap = TransformTool.snappedResizePoint(doc, drag, { proportional: board.settings.lockRatio !== e.shiftKey, targets, tolerance, update });
                point = snap.point;
                guides = snap.guides;
            }
            let draft = TransformTool.rounded(update(point));
            if (drag.mode === 'move' && !e.ctrlKey) {
                const snap = TransformTool.snappedMove(draft, targets, tolerance);
                draft = snap.draft;
                guides = snap.guides;
            }
            this.guides = guides;
            board.previewTransformEdit(draft);
        }

        // Mouse-up: an edit that does not wait for Apply is applied (EditorCanvas.swift:2165-2170).
        finishTransform(drag) {
            const board = this.board;
            if (drag.floating) {
                // The transform stays open until Return, a tool or layer switch commits it.
                board.endLive();
                board.changed();
                return;
            }
            if (drag.pending) { drag.ended = true; return; }
            board.endLive();
            const edit = board.transformEdit;
            if (edit && !edit.persistent) board.commitTransformEdit();
            else if (edit) board.showTransformEdit();
        }

        // Escape mid-drag, or the pointer lost: the edit is cancelled (EditorCanvas.swift:2249-2251), Option-drag
        // copies included.
        cancelTransform(drag) {
            const board = this.board;
            if (drag.floating) {
                if (board.selectTools.floating) board.selectTools.floating.draft = drag.original;
                board.endLive();
                return;
            }
            if (drag.pending) {
                drag.ended = true;
                drag.cancelled = true;
                return;
            }
            board.endLive();
            board.cancelTransformEdit();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Shapes (ShapeTool.swift)

        snappedCorner(doc, e) {
            if (e.ctrlKey) return { point: doc, guides: { xs: [], ys: [] } };
            const tolerance = TransformTool.SNAP_DISTANCE / Math.max(this.ppp, 0.0001);
            return TransformTool.snappedPoint(doc, this.board.snapTargets(null, false), tolerance);
        }

        beginShape(doc, e) {
            const board = this.board;
            const snap = this.snappedCorner(doc, e);
            const draft = Shapes.beginDraft(snap.point, board.shape);
            this.drag = { kind: 'shape', draft };
            this.guides = snap.guides;
            board.setShapeDraft(draft);
        }

        continueShape(doc, e) {
            const snap = this.snappedCorner(doc, e);
            this.drag.draft = Shapes.dragDraft(this.drag.draft, snap.point, e.shiftKey, e.altKey);
            this.guides = snap.guides;
            this.board.setShapeDraft(this.drag.draft);
        }

        finishShape(drag) {
            const board = this.board;
            board.setShapeDraft(null);
            const made = Shapes.finishDraft(drag.draft, { lineWidth: board.shape.lineWidth, color: board.colors.fg, strokeWidth: board.shape.strokeWidth, background: board.colors.bg });
            if (!made) return;
            if (made.error) {
                // brushError: the same alert as a stroke that cannot be painted (ShapeTool.swift:172-174).
                board.alert('Couldn\u2019t paint', made.error);
                return;
            }
            board.actions.addShapeLayer(made);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Notes

        beginNote(doc) {
            const board = this.board;
            const hit = board.notes.hit(doc, this.ppp);
            if (hit) {
                board.focusNote(hit.id, false);
                return;
            }
            this.drag = { kind: 'note', start: doc, rect: { x: doc.x, y: doc.y, width: 0, height: 0 } };
        }

        finishNote(drag) {
            const r = drag.rect;
            const small = Math.abs(r.width) * this.ppp < 4 && Math.abs(r.height) * this.ppp < 4;
            const rect = small ? { x: drag.start.x, y: drag.start.y, width: 0, height: 0 } : r;
            this.board.editNote({ rect });
        }
    }

    CB.View = View;
})();
