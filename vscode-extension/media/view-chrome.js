'use strict';
// The board's View chrome (docs/port-specs/chrome.md sections 3-11 and 17): the person's View preferences, rulers,
// guides, the layout grid and its settings sheet, the pixel grid, what moves snap to, the Navigator, Canvas Only, and
// the File and View menus. Mixed into the Board.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform, TransformTool } = CB;

    // UserDefaults `tool.*`, `navigator.visible` and `cmykProfile` (Document/EditorSession.swift:198-202, 280-341,
    // ContentView.swift:6-7), kept by the extension in `compositorBoard.preferences` (chrome.md 17.2).
    const PREF_DEFAULTS = {
        rulers: false, guides: true, grid: false, gridSpacing: 64, gridSubdivisions: 8, gridColor: 'Light Gray',
        gridCustomColor: 'B3B3B3', gridStyle: 'Lines', gridOpacity: 45, snap: true, snapGuides: true, snapGrid: false,
        snapLayers: true, snapBounds: true, lockGuides: false, pixelGrid: true, navigatorVisible: false, cmykProfile: null,
    };
    // GridAppearance.Preset (Document/Guides.swift:67-88).
    const PRESETS = [
        ['Light Gray', [0.7, 0.7, 0.7]], ['Light Blue', [0.29, 0.78, 1]], ['Light Red', [1, 0.4, 0.4]], ['Green', [0.25, 0.8, 0.25]],
        ['Medium Blue', [0.2, 0.4, 1]], ['Yellow', [1, 1, 0]], ['Magenta', [1, 0, 1]], ['Cyan', [0, 1, 1]], ['Black', [0, 0, 0]], ['Custom', null],
    ];
    const STYLES = { Lines: [], 'Dashed Lines': [4, 3], Dots: [1, 2] };
    // CanvasRulerView.majorStep (UI/CanvasRulers.swift:63-65, 174-179).
    const RULER_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000];
    const RULER = 18;
    const SNAP_DISTANCE = 10;
    const GUIDE_HIT = 5;
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));
    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function hexColor(hex) {
        const h = String(hex || '').trim().replace(/^#/, '');
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
        return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    }
    const toHex = (rgb) => rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

    const ViewChrome = {
        initViewChrome() {
            this.prefs = { ...PREF_DEFAULTS };
            this.guideDrag = null;
            this.canvasOnly = false;
            this.navigatorPicture = null;
        },

        // Stored values of the right type, else the defaults (ToolDefaults).
        readPrefs(stored) {
            for (const [key, value] of Object.entries(PREF_DEFAULTS)) {
                const v = stored ? stored[key] : undefined;
                if (v === undefined || v === null) continue;
                if (typeof value === 'boolean' && typeof v === 'boolean') this.prefs[key] = v;
                else if (typeof value === 'number' && Number.isFinite(v)) this.prefs[key] = Math.round(v);
                else if ((typeof value === 'string' || value === null) && typeof v === 'string') this.prefs[key] = v;
            }
            if (!PRESETS.some(([name]) => name === this.prefs.gridColor)) this.prefs.gridColor = 'Light Gray';
            if (!STYLES[this.prefs.gridStyle]) this.prefs.gridStyle = 'Lines';
        },

        setPref(key, value) {
            this.prefs[key] = value;
            this.postMessage({ type: 'preferences', preferences: { [key]: value } });
        },

        togglePref(key) {
            this.setPref(key, !this.prefs[key]);
            // Turning snapping off drops the feedback lines (EditorSession.snapEnabled didSet).
            if (key === 'snap' && !this.prefs.snap) this.view.guides = { xs: [], ys: [] };
            this.viewChromeChanged();
        },

        viewChromeChanged() {
            this.layoutRulers();
            this.view.draw();
            this.updateNavigator();
            this.menuBar.render();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Layout grid (LayoutGrid, GridAppearance; Document/Guides.swift:34-120)

        layoutGrid() {
            const spacing = Math.min(4096, Math.max(2, Math.round(this.prefs.gridSpacing)));
            const subdivisions = Math.min(64, Math.max(1, Math.round(this.prefs.gridSubdivisions)), spacing);
            return { spacing, subdivisions, step: spacing / subdivisions };
        },

        // Every grid line along an edge, counted from the origin so an uneven step does not drift off the majors.
        gridLines(length) {
            const { step } = this.layoutGrid();
            if (length < 0) return [0];
            const count = Math.floor(length / step + 0.001);
            const out = [];
            for (let k = 0; k <= count; k++) out.push(roundHalfAway(k * step));
            return out;
        },

        gridColor() {
            const preset = PRESETS.find(([name]) => name === this.prefs.gridColor);
            return (preset && preset[1]) || hexColor(this.prefs.gridCustomColor) || [0.7, 0.7, 0.7];
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Snapping (alignmentSnapTargets, Document/Guides.swift:247-285)

        snapTargets(excludeID, includeCenters) {
            const p = this.prefs, xs = [], ys = [];
            if (!p.snap || !this.doc.manifest) return { xs, ys };
            const W = this.doc.width, H = this.doc.height;
            if (p.snapBounds) {
                xs.push(0, W);
                ys.push(0, H);
                if (includeCenters) { xs.push(W / 2); ys.push(H / 2); }
            }
            if (p.snapLayers) {
                for (const l of this.drawOrder()) {
                    if (l.id === excludeID || !this.doc.entry(l.id).image) continue;
                    const cs = this.layerCorners(l);
                    const minX = Math.min(...cs.map((c) => c.x)), maxX = Math.max(...cs.map((c) => c.x));
                    const minY = Math.min(...cs.map((c) => c.y)), maxY = Math.max(...cs.map((c) => c.y));
                    if (includeCenters) {
                        xs.push(roundHalfAway(minX), roundHalfAway((minX + maxX) / 2), roundHalfAway(maxX));
                        ys.push(roundHalfAway(minY), roundHalfAway((minY + maxY) / 2), roundHalfAway(maxY));
                    } else {
                        xs.push(roundHalfAway(minX), roundHalfAway(maxX));
                        ys.push(roundHalfAway(minY), roundHalfAway(maxY));
                    }
                }
            }
            // Hidden extras do not snap.
            if (p.snapGrid && p.grid) { xs.push(...this.gridLines(W)); ys.push(...this.gridLines(H)); }
            if (p.snapGuides && p.guides) for (const g of this.displayedGuides()) (g.axis === 'vertical' ? xs : ys).push(g.position);
            return { xs, ys };
        },

        // A layer's displayed corners (DistortWarp.corners(of: displayedTransform)).
        layerCorners(record) {
            const o = this.renderer.overrides.get(record.id);
            const t = (o && o.transform) || Transform.read(record.transform, [this.doc.width, this.doc.height]);
            return TransformTool.corners(t);
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Guides (Document/Guides.swift:136-330)

        guides() {
            return (this.doc.manifest && this.doc.manifest.guides) || [];
        },

        canClearGuides() {
            return this.guides().length > 0;
        },

        canEditGuides() {
            return Boolean(this.doc.manifest) && !this.prefs.lockGuides && !this.working && !this.levelsEdit && !this.filters.isOpen && !this.renamingID;
        },

        // Guides as shown, a drag in progress included.
        displayedGuides() {
            const guides = this.guides().map((g) => ({ ...g }));
            const drag = this.guideDrag;
            if (!drag) return guides;
            const current = { id: drag.id, axis: drag.axis, position: drag.position };
            const index = guides.findIndex((g) => g.id === drag.id);
            if (index >= 0) guides[index] = current;
            else if (drag.isNew) guides.push(current);
            return guides;
        },

        // The nearest shown guide within 5 points of a stage point.
        hitGuide(screen) {
            if (!this.prefs.guides || this.prefs.lockGuides || !this.doc.manifest) return null;
            let best = null;
            for (const g of this.displayedGuides()) {
                const at = g.axis === 'vertical' ? this.view.toScreen({ x: g.position, y: 0 }).x : this.view.toScreen({ x: 0, y: g.position }).y;
                const distance = Math.abs((g.axis === 'vertical' ? screen.x : screen.y) - at);
                if (distance <= GUIDE_HIT && (!best || distance < best.distance)) best = { guide: g, distance };
            }
            return best ? best.guide : null;
        },

        snappedGuidePosition(position, axis, excluding) {
            const p = this.prefs;
            if (!p.snap || !this.doc.manifest) return position;
            const tolerance = SNAP_DISTANCE / Math.max(this.view.ppp, 0.0001);
            const length = axis === 'vertical' ? this.doc.width : this.doc.height;
            const targets = [];
            if (p.snapGrid && p.grid) targets.push(...this.gridLines(length));
            if (p.snapGuides && p.guides) targets.push(...this.displayedGuides().filter((g) => g.axis === axis && g.id !== excluding).map((g) => g.position));
            if (p.snapBounds) targets.push(0, length / 2, length);
            if (p.snapLayers) {
                for (const l of this.drawOrder()) {
                    if (!this.doc.entry(l.id).image) continue;
                    const values = this.layerCorners(l).map((c) => (axis === 'vertical' ? c.x : c.y));
                    const min = Math.min(...values), max = Math.max(...values);
                    targets.push(roundHalfAway(min), roundHalfAway((min + max) / 2), roundHalfAway(max));
                }
            }
            let best = null;
            for (const target of targets) {
                if (Math.abs(target - position) > tolerance) continue;
                if (best !== null && Math.abs(best - position) <= Math.abs(target - position)) continue;
                best = target;
            }
            return best === null ? position : best;
        },

        beginGuideCreation(axis, position) {
            if (!this.canEditGuides()) return false;
            if (!this.prefs.guides) this.setPref('guides', true);
            this.guideDrag = { id: crypto.randomUUID().toUpperCase(), axis, position: this.snappedGuidePosition(position, axis, null), isNew: true, original: null };
            this.view.drawOverlay();
            return true;
        },

        beginGuideMove(guide) {
            if (!this.canEditGuides()) return false;
            this.guideDrag = { id: guide.id, axis: guide.axis, position: guide.position, isNew: false, original: guide.position };
            this.view.drawOverlay();
            return true;
        },

        moveGuideDrag(position) {
            if (!this.guideDrag) return;
            this.guideDrag.position = this.snappedGuidePosition(position, this.guideDrag.axis, this.guideDrag.id);
            this.view.drawOverlay();
        },

        // Released over a ruler, a new guide is dropped and an existing one deleted.
        finishGuideDrag(remove) {
            const drag = this.guideDrag;
            if (!drag) return;
            this.guideDrag = null;
            const m = this.doc.manifest;
            if (remove) {
                if (!drag.isNew) this.edit('Delete Guide', () => { m.guides = this.guides().filter((g) => g.id !== drag.id); if (!m.guides.length) delete m.guides; });
            } else if (drag.isNew) {
                this.edit('New Guide', () => { m.guides = [...this.guides(), { id: drag.id, axis: drag.axis, position: drag.position }]; });
            } else if (drag.original !== drag.position) {
                this.edit('Move Guide', () => { m.guides = this.guides().map((g) => (g.id === drag.id ? { ...g, position: drag.position } : g)); });
            }
            this.view.drawOverlay();
        },

        cancelGuideDrag() {
            if (!this.guideDrag) return false;
            this.guideDrag = null;
            this.view.drawOverlay();
            return true;
        },

        clearGuides() {
            if (!this.canClearGuides()) return;
            this.edit('Clear Guides', () => { delete this.doc.manifest.guides; });
            this.view.drawOverlay();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Lines on the canvas, under every other overlay (chrome.md 14): pixel grid, layout grid, guides.

        drawViewLines(ctx) {
            const view = this.view, doc = this.doc, dpr = view.dpr;
            if (!doc.manifest) return;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            const o = view.origin(), ppp = view.ppp;
            const left = Math.max(0, o.x), top = Math.max(0, o.y);
            const right = Math.min(view.stage.clientWidth, o.x + doc.width * ppp), bottom = Math.min(view.stage.clientHeight, o.y + doc.height * ppp);
            // Pixel grid from 800 % (EditorCanvas.swift:1404-1445): a device pixel on every document pixel edge.
            if (this.prefs.pixelGrid && view.zoom >= 8 && right > left && bottom > top) {
                ctx.fillStyle = 'rgba(140,140,140,0.45)';
                const c0 = Math.ceil((left - o.x) / ppp), c1 = Math.floor((right - o.x) / ppp);
                for (let c = c0; c <= c1; c++) ctx.fillRect((o.x + c * ppp) * dpr - 0.5, top * dpr, 1, (bottom - top) * dpr);
                const r0 = Math.ceil((top - o.y) / ppp), r1 = Math.floor((bottom - o.y) / ppp);
                for (let r = r0; r <= r1; r++) ctx.fillRect(left * dpr, (o.y + r * ppp) * dpr - 0.5, (right - left) * dpr, 1);
            }
            // Layout grid (TransformOverlay.swift:199-242): subdivisions dotted and fainter, only when 4 points apart.
            if (this.prefs.grid) {
                const grid = this.layoutGrid(), rgb = this.gridColor().map((v) => Math.round(v * 255)).join(',');
                const major = Math.min(100, Math.max(1, this.prefs.gridOpacity)) / 100;
                const xs = this.gridLines(doc.width), ys = this.gridLines(doc.height);
                const isMajor = (v) => Math.abs(roundHalfAway(v) % grid.spacing) < 0.001;
                const pass = (wantMajor, alpha, dash) => {
                    ctx.strokeStyle = `rgba(${rgb},${alpha})`;
                    ctx.lineWidth = 1;
                    ctx.setLineDash(dash.map((d) => d * dpr));
                    ctx.beginPath();
                    for (const x of xs) if (isMajor(x) === wantMajor) { const sx = (o.x + x * ppp) * dpr; ctx.moveTo(sx, o.y * dpr); ctx.lineTo(sx, (o.y + doc.height * ppp) * dpr); }
                    for (const y of ys) if (isMajor(y) === wantMajor) { const sy = (o.y + y * ppp) * dpr; ctx.moveTo(o.x * dpr, sy); ctx.lineTo((o.x + doc.width * ppp) * dpr, sy); }
                    ctx.stroke();
                };
                if (grid.step * ppp >= 4) pass(false, (major * 28) / 45, [1, 2]);
                pass(true, major, STYLES[this.prefs.gridStyle] || []);
                ctx.setLineDash([]);
            }
            // Guides (TransformOverlay.swift:244-266): cyan 90 %, one device pixel, across the whole view.
            if (this.prefs.guides) {
                ctx.fillStyle = 'rgba(0,255,255,0.9)';
                const w = view.overlay.width, h = view.overlay.height;
                for (const g of this.displayedGuides()) {
                    if (g.axis === 'vertical') ctx.fillRect((o.x + g.position * ppp) * dpr - 0.5, 0, 1, h);
                    else ctx.fillRect(0, (o.y + g.position * ppp) * dpr - 0.5, w, 1);
                }
            }
            ctx.restore();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Rulers (UI/CanvasRulers.swift)

        buildRulers(column) {
            this.canvasColumn = column;
            this.rulerH = column.querySelector('.ruler-h');
            this.rulerV = column.querySelector('.ruler-v');
            for (const [canvas, axis] of [[this.rulerH, 'horizontal'], [this.rulerV, 'vertical']]) {
                canvas.addEventListener('pointerdown', (e) => this.rulerPointerDown(e, canvas, axis));
            }
        },

        layoutRulers() {
            if (!this.canvasColumn) return;
            const shown = Boolean(this.prefs.rulers && this.doc.manifest && !this.canvasOnly);
            if (this.canvasColumn.classList.contains('rulers') !== shown) {
                this.canvasColumn.classList.toggle('rulers', shown);
                this.view.resize();
            }
        },

        rulersShown() {
            return Boolean(this.canvasColumn && this.canvasColumn.classList.contains('rulers'));
        },

        drawRulers() {
            if (!this.rulersShown()) return;
            const view = this.view, dpr = view.dpr;
            for (const [canvas, axis] of [[this.rulerH, 'h'], [this.rulerV, 'v']]) {
                const length = axis === 'h' ? canvas.clientWidth : canvas.clientHeight;
                const w = Math.max(1, Math.round((axis === 'h' ? length : RULER) * dpr)), h = Math.max(1, Math.round((axis === 'h' ? RULER : length) * dpr));
                if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
                const ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.fillStyle = '#333333';
                ctx.fillRect(0, 0, axis === 'h' ? length : RULER, axis === 'h' ? RULER : length);
                const hair = 1 / dpr, ppp = view.ppp;
                const step = RULER_STEPS.find((s) => s >= 70 / ppp) || 50000, minor = step / 10;
                const a = view.toDoc({ x: 0, y: 0 }), b = view.toDoc(axis === 'h' ? { x: length, y: 0 } : { x: 0, y: length });
                const start = axis === 'h' ? a.x : a.y, end = axis === 'h' ? b.x : b.y;
                const first = Math.floor(Math.min(start, end) / minor) * minor, last = Math.ceil(Math.max(start, end) / minor) * minor;
                const rem = (v, d) => v - d * Math.round(v / d);
                ctx.font = '8px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
                const zero = ctx.measureText('0'), ascent = zero.fontBoundingBoxAscent || 7, digit = zero.width;
                const width = (text) => Array.from(text).reduce((sum, ch) => sum + (/[0-9]/.test(ch) ? digit : ctx.measureText(ch).width), 0);
                const label = (text, at) => {
                    ctx.fillStyle = '#c7c7c7';
                    ctx.save();
                    if (axis === 'h') ctx.translate(at + 2, 0);
                    else { ctx.translate(1, at + 2); ctx.rotate(-Math.PI / 2); ctx.translate(-width(text), 0); }
                    let x = 0;
                    for (const ch of text) { ctx.fillText(ch, x, ascent); x += /[0-9]/.test(ch) ? digit : ctx.measureText(ch).width; }
                    ctx.restore();
                };
                for (let value = first; value <= last + 0.001; value += minor) {
                    const at = axis === 'h' ? view.toScreen({ x: value, y: 0 }).x : view.toScreen({ x: 0, y: value }).y;
                    const r = Math.abs(rem(value, step));
                    const major = r < 0.001 || Math.abs(r - step) < 0.001;
                    const mid = !major && Math.abs(rem(value, step / 2)) < 0.001;
                    const len = major ? 8 : mid ? 5 : 3;
                    ctx.fillStyle = '#9e9e9e';
                    if (axis === 'h') ctx.fillRect(at - hair / 2, RULER - len, hair, len);
                    else ctx.fillRect(RULER - len, at - hair / 2, len, hair);
                    if (major) { const v = Math.round(value); label(v === 0 ? '0' : String(v), at); }
                }
                ctx.fillStyle = '#141414';
                if (axis === 'h') ctx.fillRect(0, RULER - hair, length, hair);
                else ctx.fillRect(RULER - hair, 0, hair, length);
            }
        },

        // A drag out of a ruler makes a guide; released back over a ruler it is dropped (CanvasRulers.swift:132-153).
        rulerPointerDown(e, canvas, rulerAxis) {
            if (e.button !== 0 || !this.doc.manifest) return;
            this.focusCanvas();
            const view = this.view;
            const stagePoint = (ev) => { const r = view.stage.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
            const axis = rulerAxis === 'horizontal' ? 'horizontal' : 'vertical';
            const docPoint = view.toDoc(stagePoint(e));
            if (!this.beginGuideCreation(axis, axis === 'horizontal' ? docPoint.y : docPoint.x)) return;
            canvas.setPointerCapture(e.pointerId);
            view.drag = { kind: 'guide' };
            canvas.onpointermove = (m) => {
                const d = view.toDoc(stagePoint(m));
                this.moveGuideDrag(axis === 'horizontal' ? d.y : d.x);
            };
            const end = (u) => {
                canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = null;
                if (!view.drag || view.drag.kind !== 'guide') return;
                view.drag = null;
                const p = stagePoint(u);
                this.finishGuideDrag(u.type !== 'pointercancel' && this.rulersShown() && (p.x < 0 || p.y < 0));
                view.cursor();
            };
            canvas.onpointerup = end;
            canvas.onpointercancel = (u) => { this.cancelGuideDrag(); end(u); };
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Navigator (UI/NavigatorMinimap.swift, Rendering/NavigatorGeometry.swift)

        buildNavigator(stage) {
            const el = document.createElement('div');
            el.className = 'navigator';
            el.innerHTML = '<canvas></canvas><div class="navigator-border"></div>';
            el.setAttribute('aria-label', 'Click or drag to move the view');
            el.setAttribute('role', 'button');
            stage.appendChild(el);
            this.navigatorEl = el;
            el.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                el.setPointerCapture(e.pointerId);
                this.navigatorCenter(e);
                el.onpointermove = (m) => this.navigatorCenter(m);
                el.onpointerup = () => { el.onpointermove = el.onpointerup = null; };
            });
        },

        navigatorBox() {
            const W = this.doc.width, H = this.doc.height, k = Math.min(126 / W, 90 / H);
            const box = { w: Math.round(W * k), h: Math.round(H * k) };
            const s = Math.min(box.w / W, box.h / H);
            return { ...box, s, image: { x: (box.w - W * s) / 2, y: (box.h - H * s) / 2, w: W * s, h: H * s } };
        },

        // Centres the view on the minimap point (a pan, so fitting ends).
        navigatorCenter(e) {
            const geo = this.navigatorBox(), r = this.navigatorEl.getBoundingClientRect();
            const x = Math.min(this.doc.width, Math.max(0, (e.clientX - r.left - geo.image.x) / geo.s));
            const y = Math.min(this.doc.height, Math.max(0, (e.clientY - r.top - geo.image.y) / geo.s));
            const ppp = this.view.ppp;
            this.view.pan = { x: (this.doc.width * ppp) / 2 - x * ppp, y: (this.doc.height * ppp) / 2 - y * ppp };
            this.view.followsFit = false;
            this.view.draw();
        },

        // Shown when on, outside Canvas Only, at 300 % and above; the picture follows committed edits 250 ms after they
        // stop (drafts and transforms in progress are not shown).
        updateNavigator() {
            const el = this.navigatorEl;
            if (!el) return;
            const shown = Boolean(this.prefs.navigatorVisible && !this.canvasOnly && this.doc.manifest && this.view.zoom >= 3);
            el.style.display = shown ? '' : 'none';
            if (!shown) return;
            const geo = this.navigatorBox(), dpr = this.view.dpr, canvas = el.querySelector('canvas');
            el.style.width = `${geo.w}px`;
            el.style.height = `${geo.h}px`;
            const w = Math.round(geo.w * dpr), h = Math.round(geo.h * dpr);
            if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
            const stable = !this.live && !this.renderer.overrides.size && !this.selectTools.floating;
            if (stable && (!this.navigatorPicture || this.navigatorStale)) {
                clearTimeout(this.navigatorTimer);
                const make = () => {
                    this.navigatorStale = false;
                    const W = this.doc.width, H = this.doc.height, scale = Math.min(1, 300 / Math.max(W, H));
                    const pic = new OffscreenCanvas(Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale)));
                    const pctx = pic.getContext('2d');
                    pctx.imageSmoothingQuality = 'medium';
                    pctx.drawImage(this.compositeCanvas(), 0, 0, pic.width, pic.height);
                    this.navigatorPicture = pic;
                    this.updateNavigator();
                };
                if (!this.navigatorPicture) make();
                else this.navigatorTimer = setTimeout(make, 250);
            }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#1c1c1c';
            ctx.fillRect(0, 0, geo.w, geo.h);
            if (this.navigatorPicture) {
                ctx.imageSmoothingQuality = 'medium';
                ctx.drawImage(this.navigatorPicture, geo.image.x, geo.image.y, geo.image.w, geo.image.h);
            }
            // The visible part of the document, at least 3 x 3 points, inside the frame.
            const view = this.view, a = view.toDoc({ x: 0, y: 0 }), b = view.toDoc({ x: view.stage.clientWidth, y: view.stage.clientHeight });
            let x0 = geo.image.x + Math.min(a.x, b.x) * geo.s, y0 = geo.image.y + Math.min(a.y, b.y) * geo.s;
            let x1 = geo.image.x + Math.max(a.x, b.x) * geo.s, y1 = geo.image.y + Math.max(a.y, b.y) * geo.s;
            x0 = Math.max(geo.image.x, x0); y0 = Math.max(geo.image.y, y0);
            x1 = Math.min(geo.image.x + geo.image.w, x1); y1 = Math.min(geo.image.y + geo.image.h, y1);
            if (x1 - x0 < 3) { const c = (x0 + x1) / 2; x0 = c - 1.5; x1 = c + 1.5; }
            if (y1 - y0 < 3) { const c = (y0 + y1) / 2; y0 = c - 1.5; y1 = c + 1.5; }
            ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a84ff';
            ctx.lineWidth = 2.5;
            ctx.strokeRect(x0 + 1.25, y0 + 1.25, Math.max(0, x1 - x0 - 2.5), Math.max(0, y1 - y0 - 2.5));
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Canvas Only (IO/CompositorApplicationDelegate.swift:55-154; chrome.md 11)

        canToggleCanvasOnly() {
            return Boolean(this.doc.manifest) && !this.textDraft && !this.filters.isOpen && !this.levelsEdit && !this.picker.isOpen
                && !this.adjustmentEditingID && !this.effectsPanelOpen && !this.selectTools.colorRange && !this.openPanel;
        },

        toggleCanvasOnly() {
            if (!this.canvasOnly && !this.canToggleCanvasOnly()) return;
            this.canvasOnly = !this.canvasOnly;
            document.getElementById('app').classList.toggle('canvas-only', this.canvasOnly);
            this.postMessage({ type: 'canvasOnly', on: this.canvasOnly });
            this.layoutRulers();
            this.view.resize();
            this.updateNavigator();
        },

        // escapeHasNothingToCancel (Document/EditorSession.swift:314-320).
        escapeHasNothingToCancel() {
            return !this.textDraft && !this.levelsEdit && !this.view.drag && !this.selectTools.draft && !this.gradientEdit
                && !this.cropEdit && !this.guideDrag && !this.selectTools.floating && !this.selectTools.pixelMove;
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Grid Settings… (UI/GridSettingsSheet.swift; chrome.md 7.2)

        gridSettings() {
            if (!this.doc.manifest || this.openSheet) return;
            const original = { ...this.prefs };
            const p = this.prefs;
            // Opening shows the grid while the sheet is up.
            p.grid = true;
            let fromPreset = null;
            const sheet = document.createElement('div');
            sheet.className = 'sheet grid-sheet';
            sheet.setAttribute('role', 'dialog');
            sheet.innerHTML = `<div class="sheet-title">Grid</div>
                <div class="sheet-row"><span class="sheet-label">Color</span><select class="pop grid-preset" aria-label="Color">${PRESETS.map(([name]) => `<option>${escape(name)}</option>`).join('')}</select>
                    <span class="swatch dialog-swatch grid-swatch" role="button" title="Choose a custom grid color" aria-label="Grid Color"></span></div>
                <div class="sheet-row"><span class="sheet-label">Style</span><select class="pop grid-style" aria-label="Style">${Object.keys(STYLES).map((s) => `<option>${s}</option>`).join('')}</select></div>
                <div class="sheet-row"><span class="sheet-label scrub" data-grid-scrub="gridOpacity">Opacity</span><input type="range" min="1" max="100" class="grid-opacity-range"><span class="group tight"><input class="num grid-opacity" style="width:48px"><span class="unit">%</span></span></div>
                <hr>
                <div class="sheet-row"><span class="sheet-label scrub" data-grid-scrub="gridSpacing">Gridline every</span><input class="num grid-spacing" style="width:60px"><span class="secondary">pixels</span></div>
                <div class="sheet-row"><span class="sheet-label scrub" data-grid-scrub="gridSubdivisions">Subdivisions</span><input class="num grid-subdivisions" style="width:60px"></div>
                <div class="grid-info"></div>
                <div class="buttons"><button class="pill cancel">Cancel</button><button class="pill restore">Restore Defaults</button><span class="spacer"></span><button class="pill ok prominent">OK</button></div>`;
            const host = document.getElementById('app');
            host.appendChild(sheet);
            this.openSheet = sheet;
            const draft = { spacing: p.gridSpacing, subdivisions: p.gridSubdivisions };
            const valid = () => draft.spacing >= 2 && draft.spacing <= 4096 && draft.subdivisions >= 1 && draft.subdivisions <= 64 && draft.subdivisions <= draft.spacing
                && Number.isInteger(draft.spacing) && Number.isInteger(draft.subdivisions);
            const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
            const refresh = () => {
                sheet.querySelector('.grid-preset').value = p.gridColor;
                sheet.querySelector('.grid-style').value = p.gridStyle;
                sheet.querySelector('.grid-swatch').style.background = `#${toHex(this.gridColor())}`;
                for (const [sel, value] of [['.grid-opacity-range', p.gridOpacity], ['.grid-opacity', p.gridOpacity], ['.grid-spacing', draft.spacing], ['.grid-subdivisions', draft.subdivisions]]) {
                    const input = sheet.querySelector(sel);
                    if (document.activeElement !== input) input.value = value;
                }
                const info = sheet.querySelector('.grid-info');
                if (valid()) {
                    info.className = 'grid-info secondary';
                    info.textContent = `A subdivision every ${number.format(draft.spacing / draft.subdivisions)} pixels.`;
                } else {
                    info.className = 'grid-info warning';
                    info.textContent = `Use gridlines every 2–${number.format(4096)} pixels and 1–64 subdivisions, no more than the pixels between gridlines.`;
                }
                sheet.querySelector('.ok').disabled = !valid();
                this.view.drawOverlay();
            };
            // Spacing and subdivisions preview only while valid.
            const applyDraft = () => { if (valid()) { p.gridSpacing = draft.spacing; p.gridSubdivisions = draft.subdivisions; } refresh(); };
            sheet.querySelector('.grid-preset').addEventListener('change', (e) => { p.gridColor = e.target.value; fromPreset = null; refresh(); });
            sheet.querySelector('.grid-style').addEventListener('change', (e) => { p.gridStyle = e.target.value; refresh(); });
            sheet.querySelector('.grid-opacity-range').addEventListener('input', (e) => { p.gridOpacity = Math.round(Number(e.target.value)); refresh(); });
            const field = (sel, set) => {
                const input = sheet.querySelector(sel);
                input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v)) set(v); refresh(); });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        e.stopPropagation();
                        input.value = (Number(input.value) || 0) + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
                        input.dispatchEvent(new Event('change'));
                    }
                });
            };
            field('.grid-opacity', (v) => { p.gridOpacity = Math.min(100, Math.max(1, Math.round(v))); });
            field('.grid-spacing', (v) => { draft.spacing = Math.round(v); applyDraft(); });
            field('.grid-subdivisions', (v) => { draft.subdivisions = Math.round(v); applyDraft(); });
            // Scrubbable labels: opacity 0.5, spacing 1, subdivisions 0.2 per point.
            sheet.querySelectorAll('[data-grid-scrub]').forEach((label) => label.addEventListener('pointerdown', (e) => {
                label.setPointerCapture(e.pointerId);
                const key = label.dataset.gridScrub, start = e.clientX;
                const from = key === 'gridOpacity' ? p.gridOpacity : key === 'gridSpacing' ? draft.spacing : draft.subdivisions;
                const [k, lo, hi] = key === 'gridOpacity' ? [0.5, 1, 100] : key === 'gridSpacing' ? [1, 2, 4096] : [0.2, 1, 64];
                label.onpointermove = (m) => {
                    const v = Math.round(Math.min(hi, Math.max(lo, from + (m.clientX - start) * k)));
                    if (key === 'gridOpacity') p.gridOpacity = v;
                    else if (key === 'gridSpacing') draft.spacing = v;
                    else draft.subdivisions = v;
                    applyDraft();
                };
                label.onpointerup = () => { label.onpointermove = label.onpointerup = null; };
            }));
            // A colour different from the current one becomes Custom, remembering the preset it came from; picking that
            // preset's colour again goes back to it (GridSettingsSheet.swift:31-45).
            sheet.querySelector('.grid-swatch').addEventListener('click', () => {
                const before = this.gridColor();
                this.picker.open({
                    title: 'Color Picker (Grid Color)', color: before, dialog: true,
                    onCommit: (rgb) => {
                        const same = (a, b) => a.every((v, i) => Math.round(v * 255) === Math.round(b[i] * 255));
                        if (same(rgb, before)) return;
                        if (fromPreset && same(rgb, PRESETS.find(([n]) => n === fromPreset)[1])) { p.gridColor = fromPreset; fromPreset = null; }
                        else {
                            if (p.gridColor !== 'Custom') fromPreset = p.gridColor;
                            p.gridCustomColor = toHex(rgb);
                            p.gridColor = 'Custom';
                        }
                        refresh();
                    },
                });
            });
            const close = () => {
                if (this.picker.isOpen) this.picker.close(true);
                sheet.remove();
                this.openSheet = null;
                this.view.drawOverlay();
                this.focusCanvas();
            };
            const cancel = () => { Object.assign(this.prefs, original); close(); };
            const ok = () => {
                if (!valid()) return;
                // OK keeps the new values and puts back whether the grid was shown.
                p.grid = original.grid;
                const patch = {};
                for (const key of ['gridSpacing', 'gridSubdivisions', 'gridColor', 'gridCustomColor', 'gridStyle', 'gridOpacity']) patch[key] = p[key];
                this.postMessage({ type: 'preferences', preferences: patch });
                close();
            };
            sheet.querySelector('.cancel').addEventListener('click', cancel);
            sheet.querySelector('.ok').addEventListener('click', ok);
            sheet.querySelector('.restore').addEventListener('click', () => {
                draft.spacing = 64; draft.subdivisions = 8;
                Object.assign(p, { gridSpacing: 64, gridSubdivisions: 8, gridColor: 'Light Gray', gridStyle: 'Lines', gridOpacity: 45 });
                fromPreset = null;
                refresh();
            });
            sheet.addEventListener('pointerdown', (e) => e.stopPropagation());
            sheet.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (CB.Shortcuts.isCancel(e)) { e.preventDefault(); cancel(); }
                else if (CB.Shortcuts.isApply(e)) { e.preventDefault(); sheet.querySelectorAll('input.num').forEach((i) => i.dispatchEvent(new Event('change'))); ok(); }
            });
            refresh();
            sheet.querySelector('.grid-preset').focus();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Menus

        // View (CompositorApp.swift:105-194), in Compositor's order.
        viewMenuItems() {
            const doc = () => Boolean(this.doc.manifest);
            const p = this.prefs;
            const toggle = (label, key, def) => ({ label, def, enabled: doc, checked: () => Boolean(p[key]), run: () => this.togglePref(key) });
            const proof = this.proofMenuItems ? this.proofMenuItems() : null;
            return [
                { label: 'Search Commands…', def: 'Search Commands', enabled: () => true, run: () => this.togglePalette() },
                { label: 'Toggle Fullscreen', def: 'Toggle Fullscreen: the canvas alone on black (Esc also leaves)', enabled: () => this.canvasOnly || this.canToggleCanvasOnly(), checked: () => this.canvasOnly, run: () => this.toggleCanvasOnly() },
                null,
                { label: 'Fit Canvas', def: 'Fit Canvas', enabled: doc, run: () => (this.previewZoom ? this.previewZoom('fit') : this.view.fit()) },
                { label: 'Actual Pixels', def: 'Actual Pixels', enabled: doc, run: () => (this.previewZoom ? this.previewZoom('actual') : this.view.zoomTo(1)) },
                { label: 'Zoom In', def: 'Zoom In', enabled: doc, run: () => (this.previewZoom ? this.previewZoom('zoomIn') : this.view.zoomStep(1)) },
                { label: 'Zoom Out', def: 'Zoom Out', enabled: doc, run: () => (this.previewZoom ? this.previewZoom('zoomOut') : this.view.zoomStep(-1)) },
                { label: 'Navigator (300% and above)', enabled: () => true, checked: () => p.navigatorVisible, run: () => this.togglePref('navigatorVisible') },
                { label: 'Pixel Grid (800% and above)', enabled: () => true, checked: () => p.pixelGrid, run: () => this.togglePref('pixelGrid') },
                { label: 'Show Transform Controls', def: 'Show Transform Controls', enabled: () => doc() && this.tool === 'move', checked: () => this.settings.showControls, run: () => this.toggleTransformControls() },
                ...(proof ? [null, proof] : []),
                null,
                { label: 'Show', submenu: [toggle('Grid', 'grid', 'Show Grid'), toggle('Guides', 'guides', 'Show Guides')] },
                { label: 'Grid Settings…', enabled: doc, run: () => this.gridSettings() },
                toggle('Rulers', 'rulers', 'Show Rulers'),
                null,
                toggle('Snap', 'snap', 'Snap'),
                { label: 'Snap To', submenu: [toggle('Guides', 'snapGuides'), toggle('Grid', 'snapGrid'), toggle('Layers', 'snapLayers'), toggle('Document Bounds', 'snapBounds')] },
                null,
                toggle('Lock Guides', 'lockGuides', 'Lock Guides'),
                { label: 'Clear Guides', enabled: () => this.canClearGuides(), run: () => this.clearGuides() },
            ];
        },

        // File (CompositorApp.swift:49-99): the commands VS Code runs for the board (file.md 14.2).
        fileMenuItems() {
            const extra = this.fileMenuExtras ? this.fileMenuExtras() : null;
            if (extra) return extra;
            return [
                { label: 'New Canvas…', def: 'New Canvas', enabled: () => true, run: () => this.postMessage({ type: 'command', command: 'new' }) },
                { label: 'Open Project…', def: 'Open Project', enabled: () => true, run: () => this.postMessage({ type: 'command', command: 'open' }) },
                null,
                { label: 'Save', def: 'Save', enabled: () => Boolean(this.doc.manifest), run: () => this.postMessage(this.place === 'sidebar' ? { type: 'saveNow' } : { type: 'command', command: 'save' }) },
                null,
                { label: 'Close Project', def: 'Close Project', enabled: () => true, run: () => this.postMessage({ type: 'command', command: 'close' }) },
            ];
        },

        // Edit › Keyboard Shortcuts… (ShortcutSettings.show): saved shortcuts reach every open board.
        openShortcutEditor() {
            if (this.shortcutEditor) return;
            this.shortcutEditor = new CB.Shortcuts.ShortcutEditor(this.stageEl, {
                save: (json) => { this.postMessage({ type: 'shortcuts', json }); this.menuBar.render(); },
                close: () => { this.shortcutEditor = null; this.focusCanvas(); },
            });
        },
    };

    CB.ViewChrome = ViewChrome;
})();
