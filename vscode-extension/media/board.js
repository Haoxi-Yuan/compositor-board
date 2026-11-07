'use strict';
// The board: state, the edits every tool and panel makes (each one undo step, announced to VS Code), the options bar,
// tool rail and status bar, keyboard shortcuts, and the messages with the extension (load, save, changes from disk,
// undo/redo, and the live capture the Claude Code plugin asks for).

(function () {
    const vscode = acquireVsCodeApi();
    const CB = window.CB;
    const { Transform, TransformTool, Brush, Shapes, Blend, Selection, icon } = CB;

    // The rail in Compositor's order (EditorSession.swift:91), the board's Pen after the Shape tool and its Note tool after
    // the Eyedropper. Tools whose module registered itself (media/tools.js) fill in their slots; the rest are the board's own.
    const RAIL_ORDER = ['move', 'marquee', 'lasso', 'wand', 'crop', 'brush', 'spotHealing', 'cloneStamp', 'blur', 'gradient', 'shape', 'pen', 'type', 'eyedropper', 'note', 'hand', 'zoom'];
    const BUILTIN_TOOLS = {
        move: { icon: 'move', title: 'Move / Transform (V)', key: 'KeyV' },
        marquee: { icon: 'marquee', title: 'Marquee (M)', key: 'KeyM' },
        lasso: { icon: 'lasso', title: 'Lasso (L)', key: 'KeyL' },
        wand: { icon: 'wand', title: 'Magic (W) · Tab switches Wand and Object', key: 'KeyW' },
        brush: { icon: 'brush', title: 'Brush (B) · Eraser (E)' },
        shape: { icon: 'shapes', title: 'Shape (U) · Shift-U switches Rectangle/Ellipse' },
        eyedropper: { icon: 'pipette', title: 'Eyedropper (I)', key: 'KeyI' },
        note: { icon: 'note', title: 'Note for Claude (N)', key: 'KeyN' },
        hand: { icon: 'hand', title: 'Hand (H)', key: 'KeyH' },
        zoom: { icon: 'zoom', title: 'Zoom (Z)', key: 'KeyZ' },
    };
    const railTools = () => RAIL_ORDER.filter((id) => BUILTIN_TOOLS[id] || CB.toolSpecs.has(id)).map((id) => {
        const spec = BUILTIN_TOOLS[id] || CB.toolSpecs.get(id);
        return { id, title: spec.title, icon: spec.icon, key: spec.key };
    });
    // Clone Stamp and Smear keep tips of their own; every other tool shares the Brush's (EditorSession.swift:224-225).
    const tipFamily = (tool) => (tool === 'cloneStamp' ? 1 : tool === 'blur' ? 2 : 0);
    const PIXEL_BUDGET = 200000000;
    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const number = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
    // Zoom as Compositor writes it: the status bar with up to one decimal and grouping ("1,600%", "66.7%"), the zoom
    // field with up to two decimals.
    const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
    const zoomText = (zoom) => `${percent.format(zoom * 100)}%`;
    const zoomField = (zoom) => (zoom * 100).toFixed(2).replace(/\.?0+$/, '');
    const isTyping = CB.isTyping;
    // Compositor's menu bar: File, Edit, View, then its command menus Select, Image, Filter, Layer (CompositorApp.swift).
    const MENU_ORDER = ['File', 'Edit', 'View', 'Select', 'Image', 'Filter', 'Layer'];
    // Every item of a menu, submenus included, enabled only while `gate()` allows edits.
    const gateItems = (items, gate) => items.map((item) => item && (item.submenu
        ? { ...item, submenu: gateItems(item.submenu, gate) }
        : { ...item, enabled: () => gate() && (!item.enabled || item.enabled()) }));
    // Menu commands that keep their text meaning while a field has focus (chrome.md 16.3 step 4).
    const TEXT_COMMANDS = new Set(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All', 'Fill with Foreground', 'Fill with Background', 'Content-Aware Fill', 'Zoom In', 'Zoom Out']);
    // Menu commands VS Code runs itself at their default chords (in an editor tab; the side bar has no editor).
    const VSCODE_COMMANDS = new Set(['New Canvas', 'Open Project', 'Save', 'Save As', 'Close Project']);
    // Engine operations that change an existing layer, for the layer locks (Board.engineLockRefusal): 'active' acts on
    // the target layer, 'selected' on every selected layer as well, folders with their contents.
    const LOCKED_OPS = {
        'paint.stroke': 'active', 'paint.gradient': 'active', 'selection.fill': 'active', 'selection.clear': 'active', 'selection.cut': 'active',
        'selection.invertPixels': 'active', 'selection.movePixels': 'active', 'selection.nudgePixels': 'active', 'selection.float': 'active',
        'selection.transform': 'active', 'selection.addMask': 'active', 'mask.add': 'active', 'layer.convertDepth': 'active',
        'layer.convertHDRTo16': 'active', 'filter.commit': 'active', 'filter.apply': 'active', 'filter.repeat': 'active',
        'filter.session.commit': 'active', 'filter.session.repeat': 'active', 'levels.apply': 'active', 'hueSaturation.apply': 'active',
        'layer.merge': 'selected', 'layer.delete': 'selected', 'layer.flip': 'selected', 'layer.ungroup': 'selected', 'transform.commit': 'selected',
    };

    class Board {
        constructor() {
            const saved = vscode.getState() || {};
            this.doc = new CB.Document.BoardDocument();
            this.renderer = new CB.Render.Renderer(this.doc);
            this.history = new CB.History((label) => vscode.postMessage({ type: 'edit', label }), (bitmap) => this.isLiveBitmap(bitmap));
            this.notes = new CB.Notes((list) => vscode.postMessage({ type: 'notes', notes: list }));
            // Send to Claude requests waiting for the extension (claude-sessions.js), by id.
            this.claudeCalls = new Map();
            this.nextClaudeCall = 1;
            this.tool = 'move';
            this.brushMode = 'paint';
            this.brush = { ...Brush.DEFAULTS };
            // Tips parked by family while another family's tool is current: (diameter, hardness, opacity).
            this.parkedTips = { 1: { diameter: 40, hardness: 0, opacity: 1 }, 2: { diameter: 40, hardness: 0, opacity: 1 } };
            this.toolInstances = new Map();
            // Where each floating panel was last left this session, by title.
            this.panelPlaces = {};
            this.shape = { ...Shapes.DEFAULTS };
            this.colors = { fg: [0, 0, 0], bg: [1, 1, 1] };
            const kept = saved.settings || {};
            this.settings = { autoSelect: false, showControls: true, lockRatio: true, sampleRing: true, checkerboard: true };
            if (typeof kept.autoSelect === 'boolean') this.settings.autoSelect = kept.autoSelect;
            if (typeof kept.showControls === 'boolean') this.settings.showControls = kept.showControls;
            this.panelWidth = Math.round(Math.min(352, Math.max(222, saved.panelWidth || 252)));
            this.notesHeight = Number.isFinite(saved.notesHeight) ? saved.notesHeight : null;
            this.drawerOpen = saved.drawerOpen !== false;
            this.place = 'editor';
            this.composite = { canvas: null, ctx: null, dirty: true, below: null, belowKey: null };
            this.live = null;
            this.shapeDraft = null;
            this.lastBrushPoint = null;
            this.pendingOpacity = null;
            this.opacityDigit = null;
            this.saveState = 'Saved';
            this.frame = 0;
            this.engineCalls = new Map();
            this.nextEngineCall = 1;
            this.working = 0;
            this.idleWaiters = [];
            this.selection = null;
            this.initLayerState();
            this.initViewChrome();
            this.initProofing();
            this.selectTools = new CB.SelectTools(this);
            this.filters = new CB.FilterPanel(this);
            CB.applyState = (entry, which) => {
                // EditorSession.restore (ES:669-679): the mask stays the target only on the same layer, if it still has one.
                const activeBefore = this.activeID(), size = [this.doc.width, this.doc.height];
                const keepMask = this.isMaskSelected;
                // An undo or redo drops a pending crop frame (EditorSession.restore).
                this.cancelCrop();
                // ...and a pending gradient line, through the tool modules' own hook.
                for (const m of this.allToolModules()) if (m.restored) m.restored();
                this.doc.apply(entry, which);
                // Selection changes are undo steps too, though the selection is never saved (Selection.swift).
                if ('selectionBefore' in entry) this.selection = which === 'before' ? entry.selectionBefore : entry.selectionAfter;
                const active = this.activeID();
                this.setActive(active && this.doc.layer(active) ? active : null);
                this.isMaskSelected = keepMask && active === activeBefore && Boolean((this.activeLayer() || {}).maskFile);
                if (!this.isMaskSelected) this.viewsMaskAlone = false;
                if (size[0] !== this.doc.width || size[1] !== this.doc.height) this.view.fit();
                this.changed();
                this.renderRail();
            };
            this.buildDom();
            window.addEventListener('message', (e) => this.receive(e.data));
            document.addEventListener('keydown', (e) => this.keydown(e));
            document.addEventListener('keyup', (e) => this.keyup(e));
            for (const kind of ['copy', 'cut', 'paste']) document.addEventListener(kind, (e) => this.clipboardEvent(e));
            window.addEventListener('blur', () => {
                this.view.space = false;
                this.view.altHeld = false;
                // Losing focus ends outline and pixel drags and freehand or Marquee drafts; a polygon in progress stays.
                if (this.view.drag && this.view.drag.kind === 'select') this.view.cancel();
                this.view.cursor();
            });
            // Shift and Option are followed everywhere, even while a field has focus (the mode picker and cursor badge).
            window.addEventListener('keydown', (e) => this.selectTools.heldModifiers(e), true);
            window.addEventListener('keyup', (e) => this.selectTools.heldModifiers(e), true);
            window.addEventListener('pointerdown', (e) => this.selectTools.heldModifiers(e), true);
            window.addEventListener('pointerup', (e) => this.selectTools.heldModifiers(e), true);
            window.addEventListener('blur', () => this.selectTools.heldModifiers({}));
            vscode.postMessage({ type: 'ready' });
        }

        postMessage(message) {
            vscode.postMessage(message);
        }

        // Auto Select, Show Controls and the panel width are app-wide preferences in Compositor (UserDefaults): the extension
        // keeps them for every board. The Sample Ring and the aspect lock reset with each session, as there.
        persist() {
            vscode.setState({ settings: this.settings, panelWidth: this.panelWidth, notesHeight: this.notesHeight, drawerOpen: this.drawerOpen });
            vscode.postMessage({ type: 'preferences', preferences: { autoSelect: this.settings.autoSelect, showControls: this.settings.showControls, panelWidth: this.panelWidth, notesHeight: this.notesHeight } });
        }

        // Notes for Claude's height in the panel, dragged by the line above it (layers.js); null is the automatic height.
        setNotesHeight(height) {
            this.notesHeight = Number.isFinite(height) ? Math.round(height) : null;
            this.panelEl.classList.toggle('notes-sized', this.notesHeight !== null);
            if (this.notesHeight !== null) this.panelEl.style.setProperty('--notes-height', `${this.notesHeight}px`);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Layout

        buildDom() {
            const app = document.getElementById('app');
            app.innerHTML = `
                <div class="menubar"></div>
                <div class="options"></div>
                <div class="main">
                    <nav class="rail"></nav>
                    <div class="canvas-column">
                        <div class="ruler-corner"></div><canvas class="ruler ruler-h" aria-label="Horizontal ruler"></canvas>
                        <canvas class="ruler ruler-v" aria-label="Vertical ruler"></canvas><section class="stage" tabindex="0"></section>
                    </div>
                    <div class="resizer" title="Drag to resize the panel"></div>
                    <aside class="panel"></aside>
                </div>
                <div class="status"></div>`;
            this.optionsEl = app.querySelector('.options');
            this.railEl = app.querySelector('.rail');
            this.stageEl = app.querySelector('.stage');
            this.panelEl = app.querySelector('.panel');
            this.statusEl = app.querySelector('.status');
            document.documentElement.style.setProperty('--panel-width', `${this.panelWidth}px`);
            // One device pixel for the rows' hairlines (NLL:1410-1417).
            document.documentElement.style.setProperty('--device-pixel', `${1 / (window.devicePixelRatio || 1)}px`);
            this.view = new CB.View(this, this.stageEl);
            this.buildRulers(app.querySelector('.canvas-column'));
            this.buildNavigator(this.stageEl);
            // The pills at the foot of the canvas: CMYK proof, gamut warning, the mask viewed alone (ContentView.swift:104-113).
            this.badgesEl = document.createElement('div');
            this.badgesEl.className = 'canvas-badges';
            this.stageEl.appendChild(this.badgesEl);
            this.layers = new CB.LayersPanel(this, this.panelEl);
            this.setNotesHeight(this.notesHeight);
            // The Send to row under the notes follows the Claude sessions, which start, end and go busy on their own.
            setInterval(() => { if (!document.hidden) this.refreshClaudeSessions(); }, 10000);
            window.addEventListener('focus', () => this.refreshClaudeSessions());
            document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refreshClaudeSessions(); });
            this.picker = new CB.Picker(this.stageEl);
            this.menuBar = new CB.MenuBar(this, app.querySelector('.menubar'));
            this.menuBar.render();
            this.buildRail();
            // Narrow, as in the side bar: tools in a row, options wrapping, layers and notes in a drawer under the canvas.
            new ResizeObserver(() => {
                const compact = app.clientWidth < 560;
                if (compact === app.classList.contains('compact')) return;
                app.classList.toggle('compact', compact);
                this.panelEl.classList.toggle('collapsed', compact && !this.drawerOpen);
                this.view.resize();
            }).observe(app);
            const resizer = app.querySelector('.resizer');
            resizer.addEventListener('pointerdown', (e) => {
                resizer.setPointerCapture(e.pointerId);
                const start = e.clientX, from = this.panelWidth;
                resizer.onpointermove = (m) => {
                    this.panelWidth = Math.round(Math.min(352, Math.max(222, from - (m.clientX - start))));
                    document.documentElement.style.setProperty('--panel-width', `${this.panelWidth}px`);
                };
                resizer.onpointerup = () => { resizer.onpointermove = null; resizer.onpointerup = null; this.persist(); };
            });
        }

        buildRail() {
            this.railEl.innerHTML = railTools().map((t) => `<button class="tool" data-tool="${t.id}" title="${t.title}" aria-label="${t.title}">${icon(typeof t.icon === 'function' ? t.icon(this) : t.icon)}</button>`).join('') + `
                <div class="colors">
                    <div class="bg" title="Background color" aria-label="Background color" role="button"></div>
                    <div class="fg" title="Foreground color" aria-label="Foreground color" role="button"></div>
                    <button class="swap" title="Swap foreground and background (X)" aria-label="Swap colors">${icon('swap')}</button>
                    <button class="reset" title="Default colors (D)" aria-label="Default colors">${icon('reset')}</button>
                </div>`;
            this.railEl.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => this.selectTool(b.dataset.tool)));
            this.railEl.querySelector('.fg').addEventListener('click', () => this.pickColor('fg'));
            this.railEl.querySelector('.bg').addEventListener('click', () => this.pickColor('bg'));
            this.railEl.querySelector('.swap').addEventListener('click', () => this.swapColors());
            this.railEl.querySelector('.reset').addEventListener('click', () => this.defaultColors());
        }

        toggleDrawer() {
            this.drawerOpen = !this.drawerOpen;
            this.panelEl.classList.toggle('collapsed', !this.drawerOpen);
            this.layers.renderDrawerToggle();
            this.persist();
            this.view.resize();
        }

        // With no project open in the side bar: open one, start one, or pick up a recent one.
        showWelcome(recent) {
            this.hideWelcome();
            const el = document.createElement('div');
            el.className = 'welcome';
            el.innerHTML = `
                <div class="welcome-card">
                    <div class="welcome-title">${icon('layers')}<span>Compositor Board</span></div>
                    <p>Draw here while Claude reads and draws on the same board. Projects are Compositor <code>.comp</code> folders.</p>
                    <div class="welcome-buttons"><button class="pill open">Open Project…</button><button class="pill new">New Board…</button></div>
                    ${recent.length ? `<div class="recent-title">Recent</div>${recent.map((r) => `<button class="recent" data-root="${escape(r.root)}" title="${escape(r.root)}"><span>${escape(r.name)}</span><small>${escape(r.folder)}</small></button>`).join('')}` : ''}
                </div>`;
            document.body.appendChild(el);
            el.querySelector('.open').addEventListener('click', () => vscode.postMessage({ type: 'pickProject' }));
            el.querySelector('.new').addEventListener('click', () => vscode.postMessage({ type: 'newBoard' }));
            el.querySelectorAll('.recent').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'openRecent', root: b.dataset.root })));
            this.welcome = el;
        }

        hideWelcome() {
            if (this.welcome) this.welcome.remove();
            this.welcome = null;
        }

        renderRail() {
            const o = this.selectTools.options;
            const icons = {
                marquee: o.marqueeKind === 'Ellipse' ? 'ellipseMarquee' : 'marquee',
                lasso: o.lassoKind === 'Polygonal' ? 'polygonLasso' : 'lasso',
                wand: o.wandMode === 'Object' ? 'objectSelect' : 'wand',
            };
            for (const [id, spec] of CB.toolSpecs) if (typeof spec.icon === 'function') icons[id] = spec.icon(this);
            this.railEl.querySelectorAll('.tool').forEach((b) => {
                b.classList.toggle('on', b.dataset.tool === this.tool);
                if (icons[b.dataset.tool]) b.innerHTML = icon(icons[b.dataset.tool]);
                if (b.dataset.tool === 'brush') b.innerHTML = icon(this.brushMode === 'erase' ? 'eraser' : 'brush');
            });
            const css = (c) => `#${CB.Color.hex(c)}`;
            this.railEl.querySelector('.fg').style.background = css(this.paletteColor('fg'));
            this.railEl.querySelector('.bg').style.background = css(this.paletteColor('bg'));
            CB.PaintTools.syncMaskPalette(this);
        }

        // The options bar for the current tool (ui.md 1.6), rebuilt unless one of its fields is being typed in.
        renderOptions(force = false) {
            if (!force && this.optionsEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
                this.refreshOptionValues();
                return;
            }
            const right = `<span class="view-buttons">
                <button class="pill fit" title="Fit canvas in window (⌘0)">Fit</button>
                <button class="pill actual" title="Actual pixels (⌘1)">100%</button>
                <button class="icon-button zoom-in" title="Zoom in (⌘+)">${icon('zoomIn')}</button>
                <button class="icon-button zoom-out" title="Zoom out (⌘−)">${icon('zoomOut')}</button>
                ${this.place === 'sidebar'
                    ? `<button class="icon-button move-place" title="Move this board to an editor tab">${icon('window')}</button>`
                    : `<button class="icon-button move-place" title="Move this board to the side bar">${icon('sidebar')}</button>`}
                <button class="icon-button open-app" title="Open in the Compositor app (filters, healing, text, Camera Raw)">${icon('external')}</button></span>`;
            const swatch = `<span class="swatch fg-swatch" role="button" title="Foreground color" aria-label="Foreground color" style="background:#${CB.Color.hex(this.paletteColor('fg'))}"></span>`;
            const shapeSwatch = (title, label) => `<span class="swatch fg-swatch shape-swatch" role="button" title="${title}" aria-label="${label}" style="background:#${CB.Color.hex(this.colors.fg)}"></span>`;
            let body = '';
            if (this.tool === 'move') {
                // The Move bar (UI/TransformInspector.swift), in media/transform.js.
                body = this.moveBarHTML();
            } else if (this.tool === 'brush') {
                const b = this.brush;
                body = `<span class="title">${this.brushMode === 'erase' ? 'Eraser' : 'Brush'}</span>
                    <span class="segmented" title="Paint with the foreground color (B), or erase pixels away (E)"><button data-mode="paint" class="${this.brushMode === 'paint' ? 'on' : ''}">Paint</button><button data-mode="erase" class="${this.brushMode === 'erase' ? 'on' : ''}">Erase</button></span>
                    <span class="group"><label class="caption" data-scrub="diameter">Size</label><input class="num" data-brush="diameter"><span class="unit">px</span></span>
                    <span class="group"><label class="caption" data-scrub="hardness">Hardness</label><input type="range" min="0" max="100" data-brush-range="hardness" value="${Math.round(b.hardness * 100)}"><input class="num" data-brush="hardness"><span class="unit">%</span></span>
                    <span class="group" title="Press 1–9 for 10–90%, 0 for 100%"><label class="caption" data-scrub="opacity">Opacity</label><input type="range" min="1" max="100" data-brush-range="opacity" value="${Math.round(b.opacity * 100)}"><input class="num" data-brush="opacity"><span class="unit">%</span></span>
                    <span class="group" title="The brush trails the pointer on a string this long, so a shaky hand still draws a smooth line"><label class="caption" data-scrub="smoothing">Smoothing</label><input type="range" min="0" max="100" data-brush-range="smoothing" value="${Math.round(b.smoothing)}"><input class="num" data-brush="smoothing"></span>
                    ${this.isMaskSelected ? `${CB.PaintTools.maskPaintPicker(this)}<span class="spacer"></span><span class="secondary">Mask</span>` : `<span class="group"><span>Color</span>${swatch}</span>`}`;
            } else if (this.tool === 'shape') {
                const s = this.shape, paint = s.kind === 'Line' ? 'Fill' : s.paint;
                // The Line's Width and an outline's Width are kept apart, as Photoshop keeps line weight and stroke width.
                const width = (key) => `<span class="group"><label class="caption" data-scrub-shape="${key}">Width</label><input type="range" min="1" max="100" data-shape-range="${key}" value="${Math.min(100, s[key])}"><input class="num" data-shape="${key}"><span class="unit">px</span></span>`;
                const swatches = paint === 'Stroke & Fill'
                    ? `${shapeSwatch('The outline takes the foreground color; click to change it', 'Outline color')}<span class="swatch bg-swatch shape-swatch" role="button" title="The inside takes the background color; click to change it" aria-label="Inside color" style="background:#${CB.Color.hex(this.colors.bg)}"></span>`
                    : paint === 'Stroke' ? shapeSwatch('The outline takes the foreground color; click to change it', 'Outline color')
                    : shapeSwatch('Shapes fill with the foreground color; click to change it', 'Fill color');
                body = `<span class="title">Shape</span>
                    <span class="segmented" title="Shift-U (or Tab) steps through Rectangle, Ellipse and Line">${Shapes.KINDS.map((k) => `<button data-kind="${k}" class="${s.kind === k ? 'on' : ''}">${k}</button>`).join('')}</span>
                    ${s.kind === 'Line' ? '' : `<span class="segmented" title="Fill the shape, outline it, or both; the outline lies inside the shape">${Shapes.PAINTS.map((p) => `<button data-paint="${p}" class="${paint === p ? 'on' : ''}">${p}</button>`).join('')}</span>`}
                    ${swatches}
                    ${s.kind === 'Line' ? width('lineWidth') : paint !== 'Fill' ? width('strokeWidth') : ''}
                    ${s.kind === 'Rectangle' ? `<span class="group" title="Round the rectangle's corners by this many pixels; 0 keeps them square"><label class="caption" data-scrub-shape="cornerRadius">Radius</label><input type="range" min="0" max="200" data-shape-range="cornerRadius" value="${Math.min(200, s.cornerRadius)}"><input class="num" data-shape="cornerRadius"><span class="unit">px</span></span>
                        <label class="check" title="${s.cornerRadius > 0 ? 'Use smooth squircle corners at 60% smoothing, matching Figma\'s iOS setting' : 'Set a radius above 0 to use smooth corners.'}"><input type="checkbox" class="smooth" ${s.smoothing ? 'checked' : ''} ${s.cornerRadius > 0 ? '' : 'disabled'}> Smooth Corners</label>` : ''}`;
            } else if (this.tool === 'eyedropper') {
                body = `<span class="title">Eyedropper</span><label class="check"><input type="checkbox" class="sample-ring" ${this.settings.sampleRing ? 'checked' : ''}> Sample Ring</label>`;
            } else if (this.tool === 'note') {
                body = `<span class="title">Note</span><span style="color:var(--text2)">Pin a question or instruction to a spot; Claude reads it with the board.</span>`;
            } else if (this.tool === 'hand') {
                body = '<span class="title">Pan</span>';
            } else if (this.tool === 'none') {
                body = '<span class="title">Select a tool</span>';
            } else if (this.tool === 'zoom') {
                body = `<span class="title">Zoom</span><input class="num zoom-field" style="width:72px" aria-label="Zoom percentage" title="Zoom percentage (0.1–3200%). Press Return to apply."><span class="unit scrub zoom-scrub">%</span>`;
            } else if (this.selectTools.isTool(this.tool)) {
                body = this.selectTools.optionsHTML(this.tool);
            } else if (this.toolModule() && this.toolModule().optionsHTML) {
                body = this.toolModule().optionsHTML();
            }
            // The tool's own options scroll sideways in a narrow editor; the view buttons stay in reach.
            this.optionsEl.innerHTML = `<div class="tool-options">${body}</div>${right}`;
            this.bindOptions();
            if (this.selectTools.isTool(this.tool)) this.selectTools.bindOptions(this.optionsEl);
            if (this.tool === 'brush') CB.PaintTools.bindMaskPaint(this, this.optionsEl);
            const module = this.toolModule();
            if (module && module.bindOptions) module.bindOptions(this.optionsEl);
            this.refreshOptionValues();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Tool modules (media/tools.js)

        // The instance of a registered tool module (created on first use), or null for the board's own tools.
        toolModule(id = this.tool) {
            const spec = CB.toolSpecs.get(id);
            if (!spec || BUILTIN_TOOLS[id]) return null;
            if (!this.toolInstances.has(id)) this.toolInstances.set(id, spec.create ? spec.create(this) : {});
            return this.toolInstances.get(id);
        }

        allToolModules() {
            return [...CB.toolSpecs.keys()].map((id) => this.toolModule(id)).filter(Boolean);
        }

        // isBrushTool: Brush, Spot Healing, Clone Stamp and Smear share size, hardness, opacity, the circle and its keys.
        isBrushTool(tool = this.tool) {
            const spec = CB.toolSpecs.get(tool);
            return tool === 'brush' || Boolean(spec && spec.brushTool);
        }

        // ⌘Z while something is pending that undo only throws away (a gradient line): true when a module took it.
        interceptUndo() {
            return this.allToolModules().some((m) => m.interceptUndo && m.interceptUndo());
        }

        // Applies what tools hold pending (a gradient line) before the layer, the target or the document changes in
        // another way (resolveGradient). `reason`: 'target', 'edit' or 'save'.
        resolvePending(reason) {
            // Another layer or target applies a transform edit first (EditorSession.selectLayer). Saves leave it and a
            // crop frame alone: the board autosaves while they wait for Apply.
            const waits = reason === 'target' ? [this.commitTransformEdit()] : [];
            for (const m of this.allToolModules()) if (m.resolve) waits.push(m.resolve(reason));
            return Promise.all(waits);
        }

        bindOptions() {
            const el = this.optionsEl;
            const on = (selector, event, fn) => el.querySelectorAll(selector).forEach((n) => n.addEventListener(event, fn));
            on('.fit', 'click', () => this.view.fit());
            on('.actual', 'click', () => this.view.zoomTo(1));
            on('.zoom-in', 'click', () => this.view.zoomStep(1));
            on('.zoom-out', 'click', () => this.view.zoomStep(-1));
            on('.open-app', 'click', () => this.openInCompositor());
            on('.move-place', 'click', () => vscode.postMessage({ type: this.place === 'sidebar' ? 'moveToEditor' : 'moveToSidebar' }));
            on('.fg-swatch', 'click', () => this.pickColor('fg'));
            on('.bg-swatch', 'click', () => this.pickColor('bg'));
            // A click while ⌘ shows the flipped state stores the opposite (HeldModifiers).
            on('.auto-select', 'change', (e) => { this.settings.autoSelect = e.target.checked !== Boolean(this.selectTools.heldCommand); this.persist(); });
            on('.show-controls', 'change', (e) => { this.settings.showControls = e.target.checked; this.persist(); this.view.drawOverlay(); });
            on('.sample-ring', 'change', (e) => { this.settings.sampleRing = e.target.checked; this.persist(); });
            on('[data-mode]', 'click', (e) => { this.brushMode = e.currentTarget.dataset.mode; this.toolChanged(); });
            on('[data-kind]', 'click', (e) => { this.shape.kind = e.currentTarget.dataset.kind; this.view.cancel(); this.renderOptions(true); });
            on('[data-paint]', 'click', (e) => { this.shape.paint = e.currentTarget.dataset.paint; this.view.cancel(); this.renderOptions(true); });
            on('.smooth', 'change', (e) => { this.shape.smoothing = e.target.checked; });
            on('[data-brush-range]', 'input', (e) => {
                const key = e.target.dataset.brushRange, v = Number(e.target.value);
                this.brush[key] = key === 'smoothing' ? v : v / 100;
                this.refreshOptionValues();
            });
            on('[data-shape-range]', 'input', (e) => {
                this.shape[e.target.dataset.shapeRange] = Number(e.target.value);
                if (e.target.dataset.shapeRange === 'cornerRadius') this.renderOptions(true);
                else this.refreshOptionValues();
            });
            on('input.num', 'keydown', (e) => this.fieldKey(e));
            on('[data-brush]', 'change', (e) => {
                const key = e.target.dataset.brush, v = Number(e.target.value);
                // Text that is no number leaves the value; an infinite one falls back to the default
                // (BrushControls.swift:41-99: 40 px, 100 %, 100 %, 0).
                if (e.target.value.trim() === '' || Number.isNaN(v)) return this.refreshOptionValues();
                if (key === 'diameter') this.brush.diameter = Number.isFinite(v) ? Math.min(2000, Math.max(1, v)) : 40;
                else if (key === 'smoothing') this.brush.smoothing = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
                else if (key === 'opacity') this.brush.opacity = Number.isFinite(v) ? Math.min(100, Math.max(1, v)) / 100 : 1;
                else this.brush[key] = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : 1;
                this.renderOptions(true);
            });
            on('[data-shape]', 'change', (e) => {
                const key = e.target.dataset.shape, v = Number(e.target.value);
                if (key === 'lineWidth' || key === 'strokeWidth') this.shape[key] = Number.isFinite(v) ? Math.min(5000, Math.max(1, v)) : 4;
                else this.shape.cornerRadius = Number.isFinite(v) ? Math.min(5000, Math.max(0, v)) : 0;
                this.renderOptions(true);
            });
            // The Move bar's fields, lock, picker, flips and Apply / Cancel (media/transform.js).
            if (this.tool === 'move') this.bindMoveBar(el);
            on('.zoom-field', 'change', (e) => {
                const v = Number(String(e.target.value).replace(/[%\s]/g, ''));
                if (Number.isFinite(v) && e.target.value.trim()) this.view.zoomTo(Math.min(3200, Math.max(0.1, v)) / 100);
                else this.refreshOptionValues();
            });
            // The "%" after the zoom field scrubs the zoom, 1 % per point (UI/NavigationToolHeader.swift).
            el.querySelectorAll('.zoom-scrub').forEach((unit) => unit.addEventListener('pointerdown', (e) => {
                unit.setPointerCapture(e.pointerId);
                const start = e.clientX, from = this.view.zoom * 100;
                unit.onpointermove = (m) => this.view.zoomTo(Math.min(3200, Math.max(0.1, from + (m.clientX - start))) / 100);
                unit.onpointerup = () => { unit.onpointermove = null; unit.onpointerup = null; };
            }));
            // Shape Width and Radius captions scrub too, 1 px per point.
            el.querySelectorAll('[data-scrub-shape]').forEach((label) => label.addEventListener('pointerdown', (e) => {
                label.setPointerCapture(e.pointerId);
                const key = label.dataset.scrubShape, start = e.clientX, from = this.shape[key];
                label.onpointermove = (m) => {
                    const v = from + (m.clientX - start);
                    this.shape[key] = key === 'cornerRadius' ? Math.min(5000, Math.max(0, v)) : Math.min(5000, Math.max(1, v));
                    this.refreshOptionValues();
                };
                label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; this.renderOptions(true); };
            }));
            // Dragging a caption scrubs its value (UI/NumericScrub.swift): size 1 px, hardness and opacity 1 %, per point.
            el.querySelectorAll('[data-scrub]').forEach((label) => label.addEventListener('pointerdown', (e) => {
                label.setPointerCapture(e.pointerId);
                const key = label.dataset.scrub, start = e.clientX, from = this.brush[key];
                label.onpointermove = (m) => {
                    const d = m.clientX - start;
                    if (key === 'diameter') this.brush.diameter = Math.min(2000, Math.max(1, from + d));
                    else if (key === 'smoothing') this.brush.smoothing = Math.min(100, Math.max(0, from + d));
                    else if (key === 'opacity') this.brush.opacity = Math.min(1, Math.max(0.01, from + d / 100));
                    else this.brush.hardness = Math.min(1, Math.max(0, from + d / 100));
                    this.refreshOptionValues();
                };
                label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; this.renderOptions(true); };
            }));
        }

        // Return or Escape in a field gives the keyboard back to the canvas; arrows step by 1, or 10 with Shift.
        fieldKey(e) {
            // ⌘ menu commands still reach the board from a field (chrome.md 16.3 step 4); plain keys stay in it.
            if (!e.metaKey) e.stopPropagation();
            if (e.key === 'Enter') { e.target.dispatchEvent(new Event('change')); this.focusCanvas(); e.preventDefault(); }
            else if (e.key === 'Escape') {
                // The zoom field applies on Escape as on Return; other fields put their value back.
                if (e.target.classList.contains('zoom-field')) e.target.dispatchEvent(new Event('change'));
                else this.refreshOptionValues();
                this.focusCanvas();
                e.preventDefault();
            }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.target.value = (Number(e.target.value) || 0) + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
                e.target.dispatchEvent(new Event('change'));
            }
        }

        refreshOptionValues() {
            const el = this.optionsEl;
            const set = (selector, value) => el.querySelectorAll(selector).forEach((n) => { if (document.activeElement !== n) n.value = value; });
            set('[data-brush="diameter"]', Math.round(this.brush.diameter));
            set('[data-brush="hardness"]', Math.round(this.brush.hardness * 100));
            set('[data-brush-range="hardness"]', Math.round(this.brush.hardness * 100));
            set('[data-brush="opacity"]', Math.round(this.brush.opacity * 100));
            set('[data-brush-range="opacity"]', Math.round(this.brush.opacity * 100));
            set('[data-brush="smoothing"]', Math.round(this.brush.smoothing));
            set('[data-brush-range="smoothing"]', Math.round(this.brush.smoothing));
            set('[data-shape="lineWidth"]', number(this.shape.lineWidth));
            set('[data-shape="strokeWidth"]', number(this.shape.strokeWidth));
            set('[data-shape="cornerRadius"]', number(this.shape.cornerRadius));
            set('.zoom-field', zoomField(this.view.zoom));
            const module = this.toolModule();
            if (module && module.refreshOptions) module.refreshOptions(el);
            if (this.tool === 'move' && this.doc.manifest) this.refreshMoveBar(el);
        }

        updateStatus() {
            if (!this.doc.manifest) {
                this.statusEl.innerHTML = '<span class="spacer"></span><span class="hint">Ready when you are</span>';
                return;
            }
            // The selection header waits while the engine works on a selection (LassoControls .disabled(isBusy)).
            // Headers dim once an operation has run 250 ms (EditorSession.isBusy), whatever the tool.
            this.optionsEl.classList.toggle('busy', Boolean(this.busyShown));
            // The palette is disabled while an operation runs (canEditPalette, ColorPalette.swift:25).
            this.railEl.querySelector('.colors').classList.toggle('disabled', Boolean(this.working));
            const unrendered = this.unrenderedByLayer();
            const hints = {
                move: 'Drag to move · Handles to resize · Circle to rotate · 1–0 layer opacity · Space to pan',
                brush: `Drag to ${this.brushMode === 'erase' ? 'erase' : 'paint'} · [ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan`,
                shape: `Drag to draw a shape on a new layer · Shift ${this.shape.kind === 'Line' ? '45°' : this.shape.kind === 'Ellipse' ? 'circle' : 'square'} · Option from center · Shift-U or Tab for the next shape · Escape cancel · Space to pan`,
                note: 'Drag a box or click a spot, inside another note too, then write a note for Claude · Click a note\u2019s number or outline to open it',
                hand: 'Drag to pan · Pinch to zoom',
                zoom: 'Click to zoom in · Option-click to zoom out · Drag right or left to zoom smoothly · Space to pan',
                none: "No tool selected · Press a tool's key to pick one · Space to pan",
                marquee: this.selectTools.hint('marquee'),
                lasso: this.selectTools.hint('lasso'),
                wand: this.selectTools.hint('wand'),
            };
            const module = this.toolModule();
            if (module && module.hint) hints[this.tool] = module.hint();
            const missing = [...unrendered.values()];
            const notes = this.notes.list.filter((n) => !n.resolved && !n.replyTo).length;
            this.statusEl.innerHTML = `
                <span class="zoom">${zoomText(this.view.zoom)}</span>
                <span>${this.doc.width} × ${this.doc.height} px</span>
                <span class="colorspace">sRGB · Transparent</span>
                ${missing.length ? `<span class="chip warn" title="${escape(missing.join('\n'))}">${missing.length} not shown here</span>` : ''}
                ${notes ? `<span class="chip claude">${notes} note${notes === 1 ? '' : 's'}</span>` : ''}
                <span class="chip">${escape(this.saveState)}</span>
                <span class="spacer"></span>
                ${this.busyShown ? '<span class="hint busy"><span class="spinner"></span>Working…</span>' : this.importing ? '<span class="hint busy"><span class="spinner"></span>Importing images…</span>' : `<span class="hint">${hints[this.tool] || hints.zoom}</span>`}`;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Tools and colors

        // EditorSession.selectTool (ES:393-410): refused during a stroke or busy work; the current tool's module may
        // refuse too (text that cannot finish); a tool from another tip family swaps the tip.
        selectTool(tool, mode) {
            if (this.view.busy || this.working || this.levelsEdit) return;
            const previous = this.tool;
            if (previous !== tool) {
                const current = this.toolModule();
                if (current && current.deactivate && current.deactivate(tool) === false) return;
                // A pending transform is applied and a crop frame dropped (EditorSession.swift:398).
                this.commitTransformEdit();
                this.cancelCrop();
                this.view.cancel();
                this.selectTools.cancelDraft();
                // Switching tools applies a pending transform, as in Compositor (EditorSession.selectTool).
                if (this.selectTools.floating && tool !== 'move') this.selectTools.commitFloating();
                const from = tipFamily(previous), to = tipFamily(tool);
                if (from !== to) {
                    const { diameter, hardness, opacity } = this.brush;
                    this.parkedTips[from] = { diameter, hardness, opacity };
                    Object.assign(this.brush, this.parkedTips[to]);
                }
            }
            this.tool = tool;
            if (tool === 'brush' && mode) this.brushMode = mode;
            if (previous !== tool) {
                const next = this.toolModule();
                if (next && next.activate) next.activate(previous);
            }
            this.toolChanged();
        }

        toolChanged() {
            this.renderRail();
            this.renderOptions(true);
            this.updateStatus();
            this.view.cursor();
            this.view.drawOverlay();
        }

        // Tab: Brush Paint <-> Erase, Shape Rectangle -> Ellipse -> Line.
        cycleMode() {
            // Not during a stroke or busy work, nor while text is being typed (EditorCanvas.swift:2276-2280).
            if (this.view.busy || this.working || this.textDraft) return;
            const module = this.toolModule();
            if (this.tool === 'brush') this.brushMode = this.brushMode === 'paint' ? 'erase' : 'paint';
            else if (this.selectTools.isTool(this.tool)) this.selectTools.cycle(this.tool);
            else if (this.tool === 'shape') {
                this.view.cancel();
                this.shape.kind = Shapes.KINDS[(Shapes.KINDS.indexOf(this.shape.kind) + 1) % Shapes.KINDS.length];
            } else if (!(module && module.cycle && module.cycle())) return;
            this.toolChanged();
        }

        setColor(which, rgb) {
            if (this.isMaskSelected) {
                // A color set while the mask is the target only picks black or white (ColorPalette.setPaletteColor).
                const white = rgb[0] >= 0.999 && rgb[1] >= 0.999 && rgb[2] >= 0.999;
                this.maskPaintWhite = which === 'bg' ? !white : white;
            } else this.colors[which] = rgb;
            // Text being typed follows the foreground (ColorPalette.setPaletteColor).
            for (const m of this.allToolModules()) if (m.foregroundChanged) m.foregroundChanged(which);
            this.renderRail();
            this.renderOptions();
        }

        swapColors() {
            if (this.view.busy || this.working) return;
            if (this.isMaskSelected) this.maskPaintWhite = !this.maskPaintWhite;
            else this.colors = { fg: this.colors.bg, bg: this.colors.fg };
            for (const m of this.allToolModules()) if (m.foregroundChanged) m.foregroundChanged('fg');
            this.renderRail();
            this.renderOptions();
        }

        defaultColors() {
            if (this.view.busy || this.working) return;
            if (this.isMaskSelected) this.maskPaintWhite = false;
            else this.colors = { fg: [0, 0, 0], bg: [1, 1, 1] };
            for (const m of this.allToolModules()) if (m.foregroundChanged) m.foregroundChanged('fg');
            this.renderRail();
            this.renderOptions();
        }

        // canEditPalette (ColorPalette.swift:25): not while busy or during a stroke. With a mask selected the swatch asks
        // for black or white instead (ColorPaletteControls.swift:40-48).
        pickColor(which) {
            if (this.working || this.view.busy) return;
            if (this.isMaskSelected) { CB.PaintTools.maskPopover(this, which); return; }
            this.picker.open({
                title: `Color Picker (${which === 'fg' ? 'Foreground' : 'Background'} Color)`,
                color: this.colors[which],
                palette: true,
                onCommit: (rgb) => this.setColor(which, rgb),
            });
        }

        focusCanvas() {
            this.stageEl.focus();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Document helpers

        // Whether a bitmap is what some layer shows now (history does not count those against its budget).
        isLiveBitmap(bitmap) {
            for (const e of this.doc.pixels.values()) if (e.image === bitmap || e.mask === bitmap) return true;
            return false;
        }

        activeID() {
            return this.doc.manifest ? this.doc.manifest.activeLayerID : null;
        }

        // Selecting is not an undo step (DocumentHistory.swift:67); it is saved with the next edit.
        select(id) {
            if (!this.doc.layer(id) || this.activeID() === id) return;
            if (this.selectTools.floating) this.selectTools.commitFloating();
            this.doc.manifest.activeLayerID = id;
            this.layers.markActive();
            this.renderOptions();
            this.view.drawOverlay();
        }

        ancestors(record) {
            const out = [];
            let id = record.parentID, depth = 0;
            while (id && depth++ < 64) {
                const folder = this.doc.layer(id);
                if (!folder) break;
                out.push(folder);
                id = folder.parentID;
            }
            return out;
        }

        effectivelyVisible(record) {
            return record.isVisible && this.ancestors(record).every((f) => f.isVisible);
        }

        // An alert over the board with one OK button (ContentView's .alert), e.g. "Couldn’t paint".
        alert(title, message) {
            if (this.alertEl) this.alertEl.remove();
            const el = document.createElement('div');
            el.className = 'gone alert';
            el.innerHTML = `<div class="gone-box" role="alertdialog"><div class="panel-title">${escape(title)}</div><div>${escape(message)}</div>
                <div class="buttons"><button class="pill ok">OK</button></div></div>`;
            const close = () => { el.remove(); if (this.alertEl === el) this.alertEl = null; this.focusCanvas(); };
            el.querySelector('.ok').addEventListener('click', close);
            el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); close(); } });
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.stageEl.appendChild(el);
            el.querySelector('.ok').focus();
            this.alertEl = el;
        }

        // DocumentLimits.documentPixelBudget for this machine, sent by the extension.
        documentPixelBudget() {
            return this.documentBudget || PIXEL_BUDGET;
        }

        pixelBudget(exceptID) {
            let used = 0;
            for (const l of this.doc.layers) {
                const image = l.id !== exceptID && this.doc.entry(l.id).image;
                if (image) used += image.width * image.height;
            }
            return Math.max(0, (this.documentBudget || PIXEL_BUDGET) - used);
        }

        drawOrder() {
            return CB.Render.plan(this.doc.manifest).list;
        }

        // The topmost visible layer with pixels whose placed rectangle holds the point (a bounds test, as upstream).
        layerUnder(point) {
            const list = this.drawOrder();
            for (let i = list.length - 1; i >= 0; i--) {
                const l = list[i];
                if (!this.doc.entry(l.id).image) continue;
                if (TransformTool.contains(Transform.read(l.transform, [this.doc.width, this.doc.height]), point)) return l;
            }
            return null;
        }

        isAbove(a, b) {
            const list = this.drawOrder().map((l) => l.id);
            return list.indexOf(a) > list.indexOf(b);
        }

        // The alpha a visible pixel layer shows over `frame` (whole document pixels): its pixels through its own mask, a
        // clipping base, its folders' masks and opacity (Render.drawCoverage), effects left out.
        shownAlpha(record, frame, info) {
            const { canvas, ctx } = CB.Render.canvas2d(frame.width, frame.height);
            this.renderer.drawCoverage(ctx, record.id, frame, info);
            this.renderer.applyFolderMasks(ctx, record, frame, info);
            return new Uint32Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
        }

        // The alpha of the layer's own pixel under a document point, 0 off its pixels: one pixel read, where shownAlpha
        // draws the whole image.
        ownAlphaAt(record, point) {
            const image = this.doc.entry(record.id).image, ctx = image.getContext && image.getContext('2d');
            if (!ctx) return 255;
            const toLocal = CB.Affine.invert(Transform.pixelToDocument(this.layerTransform(record), image.width, image.height));
            const q = CB.Affine.apply(toLocal, point.x, point.y), x = Math.floor(q.x), y = Math.floor(q.y);
            if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
            return ctx.getImageData(x, y, 1, 1).data[3];
        }

        // The topmost visible pixel layer showing a pixel at the point (a board choice for the Move tool's Shift-click and
        // layer box; layerUnder keeps upstream's bounds test), passing over backgrounds when asked. Off the canvas nothing
        // shows.
        layerShownAt(point, { backgrounds = true } = {}) {
            const x = Math.floor(point.x), y = Math.floor(point.y);
            if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return null;
            const info = CB.Render.plan(this.doc.manifest), frame = { x, y, width: 1, height: 1 };
            for (let i = info.list.length - 1; i >= 0; i--) {
                const l = info.list[i];
                if (l.adjustment || !this.doc.entry(l.id).image || !this.ownAlphaAt(l, { x: x + 0.5, y: y + 0.5 })) continue;
                if (this.shownAlpha(l, frame, info)[0] >>> 24 && (backgrounds || !this.coversCanvas(l, info))) return l;
            }
            return null;
        }

        // The visible pixel layers showing a pixel inside `rect` (document points, clipped to the canvas), bottom to top.
        // Locked layers cannot move and are left out, and so is a background: a layer whose opaque pixels cover the whole
        // canvas, which any box would touch (Photoshop's Background layer is never picked this way either).
        layersShownIn(rect) {
            const canvasRect = { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
            const box = CB.Rect.intersect(CB.Rect.integral(rect), canvasRect);
            if (!box) return [];
            const info = CB.Render.plan(this.doc.manifest), out = [];
            for (const l of info.list) {
                if (l.adjustment || !this.doc.entry(l.id).image || this.isLocked(l)) continue;
                const placed = Transform.read(l.transform, [this.doc.width, this.doc.height]);
                const cs = TransformTool.corners(placed), xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
                const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
                const frame = CB.Rect.intersect(box, CB.Rect.integral(bounds));
                if (!frame || !this.shownAlpha(l, frame, info).some((v) => v >>> 24)) continue;
                if (this.coversCanvas(l, info)) continue;
                out.push(l);
            }
            return out;
        }

        // A background: every canvas pixel fully opaque in this layer. Kept until the next edit, undo or reload.
        coversCanvas(record, info) {
            const { width: w, height: h } = this.doc, entry = this.doc.entry(record.id), history = this.history;
            const key = { manifest: this.doc.manifest, image: entry.image, mask: entry.mask, last: history.done[history.done.length - 1] || null, undone: history.undone.length };
            const kept = this.backgrounds && this.backgrounds.get(record.id);
            if (kept && Object.keys(key).every((k) => kept.key[k] === key[k])) return kept.covers;
            const placed = Transform.read(record.transform, [w, h]);
            // The corners and middle first, so most layers are turned down without reading them whole.
            const covers = [[0, 0], [w, 0], [0, h], [w, h]].every(([x, y]) => TransformTool.contains(placed, { x, y }))
                && [[0.5, 0.5], [w - 0.5, 0.5], [0.5, h - 0.5], [w - 0.5, h - 0.5], [w / 2, h / 2]].every(([x, y]) => this.ownAlphaAt(record, { x, y }) === 255)
                && this.shownAlpha(record, { x: 0, y: 0, width: w, height: h }, info).every((v) => v >>> 24 === 255);
            if (!this.backgrounds) this.backgrounds = new Map();
            this.backgrounds.set(record.id, { key, covers });
            return covers;
        }

        unrenderedByLayer() {
            const map = new Map();
            if (!this.doc.manifest) return map;
            for (const l of this.doc.layers) {
                const reasons = [];
                const image = this.doc.entry(l.id).image;
                if (image && image.deep && image.deep.startsWith('HDR')) reasons.push(`${l.name}: HDR pixels cannot be shown here`);
                if (reasons.length) map.set(l.id, reasons.join('; '));
            }
            return map;
        }

        // Inserts a record directly above `anchorID` in its folder, or at the top of the folder when the anchor is one,
        // or on top when there is no anchor (Compositor's addPixelLayer / addBlankLayer).
        insertAbove(record, anchorID) {
            const layers = this.doc.layers;
            const index = layers.findIndex((l) => l.id === anchorID);
            if (index < 0) {
                delete record.parentID;
                layers.push(record);
                return;
            }
            // addPixelLayer (SelectionClipboard.swift:294-310): right above the anchor, inside it when it is a folder
            // (at the folder's array slot + 1), which opens.
            const anchor = layers[index];
            if (anchor.isGroup) {
                record.parentID = anchor.id;
                this.layers.collapsed.delete(anchor.id);
            } else if (anchor.parentID) record.parentID = anchor.parentID;
            else delete record.parentID;
            layers.splice(index + 1, 0, record);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Edits: each runs `fn` (which changes the manifest and returns pixel changes) and records one undo step.

        edit(label, fn) {
            const before = this.doc.snapshot();
            const pixels = fn() || [];
            const after = this.doc.snapshot();
            if (before === after && !pixels.length) return false;
            if (before !== after) this.doc.metaDirty = true;
            this.history.push({ label, metaBefore: before, metaAfter: after, pixels });
            this.changed();
            return true;
        }

        commitStroke(id, result, label) {
            const doc = this.doc, record = doc.layer(id), entry = doc.entry(id);
            if (!record) return;
            this.edit(label, () => {
                const pixels = [];
                delete record.text;
                delete record.shape;
                record.imageFile = `${id}.png`;
                if (!result.grew) {
                    delete entry.image.raw;
                    const ctx = entry.image.getContext('2d');
                    for (const p of result.patches) {
                        ctx.clearRect(p.rect.x, p.rect.y, p.rect.width, p.rect.height);
                        ctx.drawImage(p.after, p.rect.x, p.rect.y);
                        pixels.push({ layerID: id, kind: 'image', rect: p.rect, before: p.before, after: p.after });
                    }
                } else {
                    pixels.push({ layerID: id, kind: 'image', beforeBitmap: entry.image, afterBitmap: result.image });
                    entry.image = result.image;
                    record.transform = Transform.write(result.transform);
                    // A mask that follows the layer's pixel grid grows with it; the new area reveals (12.4).
                    if (entry.mask && record.maskFile && !record.maskPlacement) {
                        const grown = this.regrowMask(entry.mask, result.sourceRect, result.crop);
                        pixels.push({ layerID: id, kind: 'mask', beforeMask: entry.mask, afterMask: grown });
                        entry.mask = grown;
                        doc.dirtyMasks.add(id);
                    }
                }
                doc.dirtyImages.add(id);
                return pixels;
            });
        }

        // LayerMask.commitMaskTransform (LM:347-372): the unlinked mask's new place; none when it equals the layer's.
        commitMaskTransform(id, draft) {
            const record = this.doc.layer(id);
            if (!record || !TransformTool.isValid(draft)) return;
            const size = [this.doc.width, this.doc.height];
            const old = Transform.read(record.maskPlacement || record.transform, size);
            if (['x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY'].every((k) => old[k] === draft[k])) return;
            const layer = Transform.read(record.transform, size);
            const same = ['x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY'].every((k) => layer[k] === draft[k]);
            this.edit('Transform Layer Mask', () => {
                if (same) delete record.maskPlacement;
                else record.maskPlacement = Transform.write(draft);
            });
        }

        // A finished mask stroke (EditorSession+Brush.swift:172-179): the painted grid is the new mask; grown past its
        // layer, or already placed, it keeps its place on the document.
        commitMaskStroke(id, result, placed) {
            const doc = this.doc, record = doc.layer(id), entry = doc.entry(id);
            if (!record) return;
            const data = result.image.getContext('2d').getImageData(0, 0, result.image.width, result.image.height).data;
            const gray = new Uint8Array(result.image.width * result.image.height);
            for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4 + 3];
            const mask = CB.Document.maskFromGray(result.image.width, result.image.height, gray);
            this.edit('Paint Mask', () => {
                const before = entry.mask;
                entry.mask = mask;
                record.maskFile = `${id}.mask.png`;
                if (placed || result.grew) record.maskPlacement = Transform.write(result.transform);
                else delete record.maskPlacement;
                doc.dirtyMasks.add(id);
                return [{ layerID: id, kind: 'mask', beforeMask: before, afterMask: mask }];
            });
        }

        regrowMask(mask, sourceRect, crop) {
            const gray = new OffscreenCanvas(mask.width, mask.height);
            const data = new ImageData(mask.width, mask.height);
            for (let i = 0; i < mask.gray.length; i++) {
                data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = mask.gray[i];
                data.data[i * 4 + 3] = 255;
            }
            gray.getContext('2d').putImageData(data, 0, 0);
            const out = new OffscreenCanvas(crop.width, crop.height);
            const ctx = out.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, crop.width, crop.height);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(gray, sourceRect.x - crop.x, sourceRect.y - crop.y, sourceRect.width, sourceRect.height);
            const pixels = ctx.getImageData(0, 0, crop.width, crop.height).data;
            const next = new Uint8Array(crop.width * crop.height);
            for (let i = 0; i < next.length; i++) next[i] = pixels[i * 4];
            return CB.Document.maskFromGray(crop.width, crop.height, next);
        }

        commitTransform(id, draft, label) {
            const doc = this.doc, record = doc.layer(id), entry = doc.entry(id);
            if (!record || !TransformTool.isValid(draft)) return;
            const old = Transform.read(record.transform, [doc.width, doc.height]);
            // A click without a drag (or a field set to its own value) changes nothing and records no step.
            if (['x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY', 'sampling'].every((k) => old[k] === draft[k]) || !entry) return;
            // The placement, the mask's place and a live shape redrawn at its new size (media/transform.js placeRecord).
            this.edit(label, () => this.placeRecord(record, old, draft));
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Live display while dragging: everything below the layer being edited is cached.

        beginLive(id) {
            this.live = id;
            this.composite.below = null;
        }

        endLive() {
            this.live = null;
            this.composite.below = null;
            this.composite.dirty = true;
            this.schedule();
            for (const resolve of this.idleWaiters.splice(0)) resolve();
        }

        liveChanged() {
            this.composite.dirty = true;
            this.schedule();
        }

        idle() {
            return this.view.busy ? new Promise((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
        }

        setShapeDraft(draft) {
            if (draft && !this.live) this.beginLive(this.activeID());
            this.shapeDraft = draft;
            if (!draft && this.live) this.endLive();
            else this.liveChanged();
        }

        drawShapeDraft(ctx) {
            Shapes.drawPreview(ctx, this.shapeDraft, { toScreen: (p) => p, scale: 1, color: this.colors.fg, lineWidth: this.shape.lineWidth, strokeWidth: this.shape.strokeWidth, background: this.colors.bg });
        }

        compositeCanvas() {
            const doc = this.doc, c = this.composite;
            if (!c.canvas || c.canvas.width !== doc.width || c.canvas.height !== doc.height) {
                c.canvas = new OffscreenCanvas(doc.width, doc.height);
                c.ctx = c.canvas.getContext('2d', { willReadFrequently: true });
                c.dirty = true;
                c.below = null;
            }
            if (!c.dirty) return c.canvas;
            if (this.drawMaskAlone(c.ctx)) {
                c.dirty = false;
                return c.canvas;
            }
            const info = CB.Render.plan(doc.manifest);
            const active = this.activeID();
            let drafted = false;
            const afterLayer = (record, ctx, info) => {
                this.selectTools.drawFloating(record, ctx, info);
                if (this.shapeDraft && record.id === active) {
                    this.drawShapeDraft(ctx);
                    drafted = true;
                }
                // New text being typed hangs where its layer will go (EditorCanvas.swift:1166-1172).
                if (this.newTextDraft && record.id === active && !textDrawn) textDrawn = this.newTextDraft(ctx) !== false;
            };
            let textDrawn = false;
            c.ctx.setTransform(1, 0, 0, 1, 0, 0);
            c.ctx.clearRect(0, 0, doc.width, doc.height);
            if (this.live) {
                const split = this.renderer.splitIndex(info, this.live);
                if (!c.below || c.belowKey !== this.live) {
                    c.below = CB.Render.canvas2d(doc.width, doc.height);
                    this.renderer.render(c.below.ctx, { info, from: 0, to: split });
                    c.belowKey = this.live;
                }
                c.ctx.drawImage(c.below.canvas, 0, 0);
                this.renderer.render(c.ctx, { info, from: split, afterLayer });
            } else {
                this.renderer.render(c.ctx, { info, afterLayer });
            }
            if (this.shapeDraft && !drafted) this.drawShapeDraft(c.ctx);
            if (this.newTextDraft && !textDrawn) this.newTextDraft(c.ctx);
            c.dirty = false;
            return c.canvas;
        }

        // The mask alone (EditorCanvas.swift:938-953): the document in the mask's edge tone, the mask's samples as gray
        // where it sits (following a transform being dragged), or the mask stroke in progress. False when not viewing.
        drawMaskAlone(ctx) {
            const record = this.activeLayer();
            const mask = record && record.maskFile && this.doc.entry(record.id).mask;
            if (!this.viewsMaskAlone || !this.isMaskSelected || !mask) {
                this.renderMaskPill(null);
                return false;
            }
            const doc = this.doc, size = [doc.width, doc.height];
            const g = CB.Render.maskBackground(mask) ? 255 : 0;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
            ctx.fillStyle = `rgb(${g},${g},${g})`;
            ctx.fillRect(0, 0, doc.width, doc.height);
            const live = this.renderer.overrides.get(record.id);
            if (live && live.mask) {
                const { canvas, toDocument } = live.mask;
                const white = new OffscreenCanvas(canvas.width, canvas.height), wctx = white.getContext('2d');
                wctx.drawImage(canvas, 0, 0);
                wctx.globalCompositeOperation = 'source-in';
                wctx.fillStyle = '#fff';
                wctx.fillRect(0, 0, canvas.width, canvas.height);
                CB.Affine.setOn(ctx, toDocument);
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(white, 0, 0);
            } else {
                const dragged = live && live.transform;
                const placement = record.maskPlacement && !CB.Render.samePlacement(record.maskPlacement, record.transform);
                const t = placement ? Transform.read(record.maskPlacement, size) : dragged || Transform.read(record.transform, size);
                CB.Affine.setOn(ctx, Transform.pixelToDocument(t, mask.width, mask.height));
                ctx.imageSmoothingEnabled = t.sampling !== 'Nearest';
                ctx.imageSmoothingQuality = t.sampling === 'High quality' ? 'high' : 'low';
                ctx.drawImage(CB.Document.grayCanvas(mask), 0, 0);
            }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.renderMaskPill(record);
            return true;
        }

        // "Layer Mask · <name>" with × at the foot of the canvas (UI/LayerMaskMenu.swift MaskAloneBadge).
        renderMaskPill(record) {
            if (!record) {
                if (this.maskPill) this.maskPill.remove();
                this.maskPill = null;
                return;
            }
            if (!this.maskPill) {
                const el = document.createElement('div');
                el.className = 'canvas-pill';
                el.innerHTML = `${icon('maskThumb')}<b>Layer Mask</b><span class="pill-name"></span><button class="pill-close" title="Show the image again (or Option-click the mask thumbnail)" aria-label="Stop viewing the mask">${icon('close')}</button>`;
                el.querySelector('.pill-close').addEventListener('click', () => this.stopMaskAlone());
                el.addEventListener('pointerdown', (e) => e.stopPropagation());
                this.badgesEl.appendChild(el);
                this.maskPill = el;
            }
            this.maskPill.querySelector('.pill-name').textContent = record.name;
        }

        // After any change of the document: redraw, refresh the panel, options and status.
        changed() {
            // An open effect panel follows its effect, and closes when it is gone (undo, a delete).
            if (this.effectPanelEl) this.renderEffectPanel();
            this.composite.dirty = true;
            this.composite.below = null;
            this.panelDirty = true;
            this.schedule();
        }

        schedule() {
            if (this.frame) return;
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                if (!this.doc.manifest) return;
                if (this.panelDirty) {
                    this.panelDirty = false;
                    this.layers.render();
                    this.renderOptions();
                    this.updateStatus();
                }
                this.view.draw();
            });
        }

        redrawOverlay() {
            this.view.drawOverlay();
            this.updateStatus();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Notes

        notesChanged() {
            this.layers.renderNotes();
            this.redrawOverlay();
        }

        focusNote(id, pan = true) {
            const note = this.notes.list.find((n) => n.id === id);
            if (!note) return;
            this.notes.selectedID = id;
            this.notesChanged();
            if (pan) {
                const s = this.view.toScreen({ x: note.x + note.width / 2, y: note.y + note.height / 2 });
                const w = this.stageEl.clientWidth, h = this.stageEl.clientHeight;
                if (s.x < 0 || s.y < 0 || s.x > w || s.y > h) {
                    this.view.pan.x += w / 2 - s.x;
                    this.view.pan.y += h / 2 - s.y;
                    this.view.followsFit = false;
                    this.view.draw();
                }
            }
            const card = this.panelEl.querySelector('.note-card.on');
            if (card) card.scrollIntoView({ block: 'nearest' });
        }

        replyToNote(id) {
            const note = this.notes.list.find((n) => n.id === id);
            if (note) this.editNote({ rect: { x: note.x, y: note.y, width: note.width, height: note.height }, replyTo: id });
        }

        // A small editor next to the spot: Return saves, Command-Return saves and sends the thread to Claude,
        // Shift-Return starts a new line, Escape cancels.
        editNote({ rect, replyTo }) {
            this.closeMenus();
            const editor = document.createElement('div');
            editor.className = 'note-editor';
            editor.innerHTML = `<textarea placeholder="${replyTo ? 'Reply…' : 'What should Claude know or do here?'}"></textarea>
                <div class="hint">Return to pin · \u2318Return to pin and send to Claude · Shift-Return for a new line · Escape to cancel</div>
                <div class="buttons"><button class="pill cancel">Cancel</button><button class="pill save">${replyTo ? 'Reply' : 'Pin note'}</button><button class="pill save-send" title="Pin it and send the thread to a running Claude Code session (\u2318Return)">${replyTo ? 'Reply & send' : 'Pin & send'}</button></div>`;
            const corner = this.view.toScreen({ x: Math.max(rect.x, rect.x + rect.width), y: Math.min(rect.y, rect.y + rect.height) });
            editor.style.left = `${Math.min(this.stageEl.clientWidth - 250, Math.max(8, corner.x + 8))}px`;
            editor.style.top = `${Math.min(this.stageEl.clientHeight - 150, Math.max(8, corner.y))}px`;
            this.stageEl.appendChild(editor);
            this.noteEditor = editor;
            const text = editor.querySelector('textarea');
            text.focus();
            const close = () => { editor.remove(); this.noteEditor = null; this.focusCanvas(); };
            const save = (send) => {
                if (text.value.trim()) {
                    const note = this.notes.add({ ...rect, text: text.value, replyTo });
                    this.notes.selectedID = replyTo || note.id;
                    this.notesChanged();
                    if (send) this.sendNote(replyTo || note.id);
                }
                close();
            };
            text.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(e.metaKey); }
                if (e.key === 'Escape') { e.preventDefault(); close(); }
            });
            editor.addEventListener('pointerdown', (e) => e.stopPropagation());
            editor.querySelector('.save').addEventListener('click', () => save(false));
            editor.querySelector('.save-send').addEventListener('click', () => save(true));
            editor.querySelector('.cancel').addEventListener('click', close);
        }

        // Send to Claude: the note's thread goes to a running Claude Code session as a cross-session message, to the
        // board's session (the Send to row) unless `to` (a session pid from the card's menu) names another for this
        // note only. The card then says where it went.
        async sendNote(id, to) {
            const thread = this.notes.summary().find((n) => n.id === id);
            if (!thread) return;
            try {
                const sent = await this.claudeLane('send', {
                    note: { id, number: thread.number, author: thread.author, text: thread.text, rect: thread.rect, replies: thread.replies, target: thread.target }, to,
                });
                this.notes.update(id, { sentTo: sent.name, sentAt: new Date().toISOString() });
                this.notesChanged();
                this.toast(`Sent note ${thread.number} to ${sent.name}`);
            } catch (error) {
                this.alert('Couldn\u2019t send the note to Claude', error.message);
            }
            this.refreshClaudeSessions();
        }

        // The sessions Send to Claude can reach, for the Send to row under the notes (layers.js renderSessionRow); the
        // last list stays when the extension does not answer.
        async refreshClaudeSessions() {
            if (!this.doc.manifest || this.claudeRefreshing) return;
            this.claudeRefreshing = true;
            try {
                this.claudeSessions = await this.claudeLane('sessions', {}, { timeout: 10000 });
            } catch {
                // Kept as it was.
            } finally {
                this.claudeRefreshing = false;
            }
            this.layers.renderSessionRow();
        }

        // A session in a menu: its chat's title (as on its tab), busy or idle, the folder of a chat in another window, and
        // when it started where two chats share a title.
        sessionLabel(s, sessions) {
            const twin = sessions.some((o) => o !== s && o.name === s.name);
            const started = twin && s.startedAt ? `, started ${new Date(s.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
            return `${s.name}${s.status ? ` (${s.status})` : ''}${s.here ? '' : ` \u2014 ${s.folder}`}${started}`;
        }

        // The sessions as menu items: this window's chats, then the other windows' in a submenu.
        sessionItems(sessions, run) {
            const item = (s) => ({ label: this.sessionLabel(s, sessions), checked: s.target, run: () => run(s) });
            const here = sessions.filter((s) => s.here), other = sessions.filter((s) => !s.here);
            const items = here.map(item);
            if (other.length) {
                if (items.length) items.push(null);
                items.push({ label: 'Other VS Code Windows', checked: other.some((s) => s.target), submenu: other.map(item) });
            }
            if (!items.length) items.push({ label: 'No Claude Code session with the board plugin is running', disabled: true });
            return items;
        }

        // The Send to row's menu: by default the board follows the chat tab in front; a chat chosen here is pinned as
        // the board's, without sending anything, until Follow is chosen again or the chat ends.
        async claudeSessionMenu(anchor) {
            let sessions;
            try {
                sessions = await this.claudeLane('sessions');
            } catch (error) {
                this.alert('Couldn\u2019t list the Claude sessions', error.message);
                return;
            }
            this.claudeSessions = sessions;
            this.layers.renderSessionRow();
            const pinned = sessions.some((s) => s.pinned);
            const items = [
                { label: 'Follow the Chat Tab in Front', checked: !pinned, run: () => this.pinClaudeSession(null) }, null,
                ...this.sessionItems(sessions, (s) => this.pinClaudeSession(s.id)),
            ];
            const box = anchor.getBoundingClientRect();
            this.menu(box.left, box.bottom + 2, items);
        }

        async pinClaudeSession(id) {
            try {
                this.claudeSessions = await this.claudeLane('pin', { to: id });
            } catch (error) {
                this.alert('Couldn\u2019t choose the Claude session', error.message);
            }
            this.layers.renderSessionRow();
        }

        // The sessions to send this note to, the board's current one checked; picking one sends there, this once.
        async sendNoteMenu(id, anchor) {
            let sessions;
            try {
                sessions = await this.claudeLane('sessions');
            } catch (error) {
                this.alert('Couldn\u2019t list the Claude sessions', error.message);
                return;
            }
            this.claudeSessions = sessions;
            this.layers.renderSessionRow();
            const items = this.sessionItems(sessions, (s) => this.sendNote(id, s.id));
            const box = anchor.getBoundingClientRect();
            this.menu(box.left, box.bottom + 2, items);
        }

        // One request to the extension's Claude sessions (claude-sessions.js); `timeout` (ms) gives up on an answer.
        claudeLane(op, args = {}, { timeout } = {}) {
            const id = this.nextClaudeCall++;
            return new Promise((resolve, reject) => {
                this.claudeCalls.set(id, { resolve, reject });
                if (timeout) setTimeout(() => { if (this.claudeCalls.delete(id)) reject(new Error('The Claude sessions did not answer.')); }, timeout);
                vscode.postMessage({ type: 'claude', id, op, ...args });
            });
        }

        claudeAnswered({ id, ok, result, error }) {
            const call = this.claudeCalls.get(id);
            if (!call) return;
            this.claudeCalls.delete(id);
            if (ok) call.resolve(result);
            else call.reject(new Error(error));
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Menus and messages

        // A pop-up menu: items { label, run, disabled, checked, hover, submenu } or null for a separator; `onClose` runs
        // when it goes away however it does.
        menu(x, y, items, onClose) {
            this.closeMenus();
            const build = (list, left, top) => {
                const menu = document.createElement('div');
                menu.className = 'menu';
                for (const item of list) {
                    if (!item) { menu.appendChild(document.createElement('hr')); continue; }
                    const b = document.createElement('button');
                    b.innerHTML = `<span class="check">${item.checked ? '✓' : ''}</span><span class="label"></span><span class="more">${item.submenu ? '›' : ''}</span>`;
                    b.querySelector('.label').textContent = item.label;
                    b.disabled = Boolean(item.disabled);
                    b.addEventListener('pointerenter', () => {
                        if (item.hover) item.hover();
                        if (this.openSubmenu && this.openSubmenu.parent === menu) { this.openSubmenu.remove(); this.openSubmenu = null; }
                        if (item.submenu && !item.disabled) {
                            const r = b.getBoundingClientRect();
                            const sub = build(item.submenu, r.right - 4, r.top - 4);
                            sub.parent = menu;
                            this.openSubmenu = sub;
                        }
                    });
                    if (!item.submenu) b.addEventListener('click', () => { this.closeMenus(); if (item.run) item.run(); });
                    menu.appendChild(b);
                }
                document.body.appendChild(menu);
                menu.style.left = `${Math.max(2, Math.min(left, window.innerWidth - menu.offsetWidth - 4))}px`;
                menu.style.top = `${Math.max(2, Math.min(top, window.innerHeight - menu.offsetHeight - 4))}px`;
                return menu;
            };
            const menu = build(items, x, y);
            this.openMenu = menu;
            this.menuClosed = onClose || null;
            setTimeout(() => window.addEventListener('pointerdown', this.menuCloser = (e) => {
                if (!menu.contains(e.target) && !(this.openSubmenu && this.openSubmenu.contains(e.target))) this.closeMenus();
            }), 0);
        }

        closeMenus() {
            // A key let go while a menu was open never arrives (HeldModifiers' didEndTracking).
            if (this.openMenu) this.selectTools.heldModifiers({});
            if (this.openMenu) this.openMenu.remove();
            if (this.openSubmenu) this.openSubmenu.remove();
            this.openMenu = null;
            this.openSubmenu = null;
            if (this.menuCloser) window.removeEventListener('pointerdown', this.menuCloser);
            this.menuCloser = null;
            const closed = this.menuClosed;
            this.menuClosed = null;
            if (closed) closed();
        }

        toast(message) {
            const old = this.stageEl.querySelector('.toast');
            if (old) old.remove();
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = message;
            this.stageEl.appendChild(toast);
            setTimeout(() => toast.remove(), 3200);
        }

        // Runs an operation in compositor-engine (Compositor's own code) on the saved project with this board's active
        // layer and selection. `files` names temporary files the engine writes ({key: extension}); they come back as
        // bytes. The project changes it saves arrive as one undo step named `label`.
        // `quiet`: a preview a panel asks for (Camera Raw), which never makes the board busy, as the app's previews
        // render without isProjectBusy.
        engine(op, args = {}, { label, files, stateless = false, quiet = false } = {}) {
            // The board's layer locks (layer-ops.js), checked once more before Compositor's code changes a layer.
            const locked = this.engineLockRefusal(op, args);
            if (locked) return Promise.reject(new Error(locked));
            const id = this.nextEngineCall++;
            if (!quiet) this.working++;
            // "Working…" appears only for operations that take a while (250 ms, as Compositor's busy indicator).
            if (!quiet && this.working === 1) {
                clearTimeout(this.busyTimer);
                this.busyTimer = setTimeout(() => { this.busyShown = true; this.updateStatus(); }, 250);
            }
            if (!quiet) this.updateStatus();
            return new Promise((resolve, reject) => {
                this.engineCalls.set(id, { resolve, reject, quiet });
                vscode.postMessage({ type: 'engine', id, op, label, files, stateless, args: { activeLayerID: this.activeID(), ...this.engineLayerState(), ...args } });
            });
        }

        // Why an engine operation would change a locked layer, or null: the operations that change the target layer's
        // pixels, mask, depth or place, or remove it; those marked `selected` also act on every selected layer.
        engineLockRefusal(op, args) {
            if (op === 'text.commit') return args.layerID ? this.lockRefusal([this.doc.layer(args.layerID)]) : null;
            const reach = LOCKED_OPS[op];
            if (!reach) return null;
            const ids = new Set([args.activeLayerID || this.activeID()]);
            if (reach === 'selected') for (const id of this.selectedIDs) ids.add(id);
            return this.lockRefusal([...ids].map((id) => this.doc.layer(id)), { inside: reach === 'selected' });
        }

        toggleTransformControls() {
            this.settings.showControls = !this.settings.showControls;
            this.persist();
            this.renderOptions(true);
            this.view.drawOverlay();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Selection

        setSelection(next, label) {
            if (this.selectTools.floating) {
                // A pending Transform Selection is applied before the selection changes (commitTransform first).
                this.selectTools.commitFloating().then(() => this.setSelection(next, label));
                return;
            }
            const before = this.selection;
            if (Selection.same(before, next)) return;
            this.selection = next;
            this.history.push({ label, pixels: [], selectionBefore: before, selectionAfter: next });
            this.selectionChanged();
        }

        selectionChanged() {
            this.view.drawOverlay();
            this.renderOptions();
            this.updateStatus();
        }

        // An engine operation that answers with the selection as it now stands. When it also saved pixels, the
        // selection change joins the undo step the save made (named `label`), as in Compositor's single edit.
        async selectionOp(op, args, label, { stateless = false, files } = {}) {
            if (this.selectTools.floating && op !== 'selection.transform') await this.selectTools.commitFloating();
            const before = this.selection;
            const mark = this.history.done[this.history.done.length - 1];
            let result;
            try {
                result = await this.engine(op, { selection: before, foreground: this.colors.fg, background: this.colors.bg, ...args }, { label, files, stateless });
            } catch (error) {
                this.toast(error.message);
                return null;
            }
            if (result.error) this.alert(result.errorTitle || (op.startsWith('selection.fill') || op.startsWith('selection.clear') ? 'Couldn\u2019t paint' : 'Couldn\u2019t do that'), result.error);
            this.applyEngineState(result);
            if (result.unchanged || result.selection === undefined) return result;
            const after = result.selection;
            const last = this.history.done[this.history.done.length - 1];
            const name = result.editName || label;
            if (result.saved && last && last !== mark && last.label === name && !('selectionBefore' in last)) {
                last.selectionBefore = before;
                last.selectionAfter = after;
                this.selection = after;
                this.selectionChanged();
            } else {
                this.setSelection(after, name);
            }
            return result;
        }

        hasSelection() {
            return Boolean(this.selection);
        }

        hasPixelsSelected() {
            return Boolean(this.selection && !Selection.isEmpty(this.selection));
        }

        async clipboard(kind) {
            if (this.selectTools.floating) await this.selectTools.commitFloating();
            if (kind === 'paste') {
                await this.selectionOp('selection.paste', {}, 'Paste');
                return;
            }
            if (this.selection && Selection.isEmpty(this.selection)) return;
            if (kind === 'cut') {
                if (!this.selection || this.refuseLocked([this.activeLayer()])) return;
                await this.selectionOp('selection.cut', {}, 'Clear', { files: { out: 'png' } });
                return;
            }
            try {
                await this.engine('selection.copy', { selection: this.selection, merged: kind === 'copyMerged' }, { files: { out: 'png' } });
            } catch (error) {
                this.toast(error.message);
            }
        }

        fill(source) {
            const refusal = this.engineEditRefusal();
            if (refusal) return refusal === 'Busy' ? null : this.alert('Couldn\u2019t paint', refusal);
            this.selectionOp('selection.fill', { source }, 'Fill');
        }

        clearSelected() {
            if (!this.selection || Selection.isEmpty(this.selection) || this.refuseLocked([this.activeLayer()])) return;
            this.selectionOp('selection.clear', {}, 'Clear');
        }

        // Content-Aware Fill… opens its filter panel (EditorSession.canContentAwareFill).
        canContentAwareFill() {
            const record = this.doc.manifest && this.doc.layer(this.activeID());
            return Boolean(record && !record.isGroup && !record.adjustment && this.doc.entry(record.id).image && this.effectivelyVisible(record)
                && this.hasPixelsSelected() && !this.filters.isOpen && !this.selectTools.colorRange && !this.isLocked(record));
        }

        contentAwareFill() {
            if (this.refuseLocked([this.activeLayer()])) return;
            if (this.canContentAwareFill()) this.filters.open('Content-Aware Fill');
        }

        // Why Fill / Clear cannot run on the active layer (SelectionEdits.canFill), or null. Deep layers are fine: the
        // engine keeps their precision.
        engineEditRefusal() {
            const record = this.activeLayer();
            if (!this.canEditLayers()) return 'Busy';
            const refusal = this.paintRefusal(record);
            return refusal && refusal !== this.doc.pixelLock(record) ? refusal : null;
        }

        invertPixels() {
            if ((this.selection && Selection.isEmpty(this.selection)) || this.refuseLocked([this.activeLayer()])) return;
            this.selectionOp('selection.invertPixels', {}, 'Invert');
        }

        // ⌘J: Layer via Copy with a selection (not on folders), Duplicate Layer without one (SC:206-215).
        layerViaCopyOrDuplicate() {
            const a = this.activeLayer();
            if (!this.canEditLayers() || !a) return;
            if (this.selection) {
                if (!Selection.isEmpty(this.selection) && !a.isGroup) this.selectionOp('selection.layerViaCopy', {}, 'Layer via Copy');
            } else this.duplicateLayers();
        }

        // EditorSession.canUseHistory (ES:650-653): not during dialogs, strokes, renames, transforms or busy work.
        canUseHistory() {
            return Boolean(this.doc.manifest) && !this.view.busy && !this.working && !this.openPanel && !this.selectTools.colorRange
                && !this.levelsEdit && !this.adjustmentEditingID && !this.filters.isOpen
                && !this.renamingID && !this.selectTools.floating && !this.textDraft && !this.transformEdit;
        }

        undoRedo(kind) {
            if (kind === 'undo' && this.interceptUndo()) return;
            if (!this.canUseHistory()) return;
            if (this.place === 'editor') vscode.postMessage({ type: 'command', command: kind });
            else if (kind === 'undo' ? this.history.undo() : this.history.redo()) vscode.postMessage({ type: 'dirty' });
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Menus (Compositor's menu bar; CompositorApp.swift)

        menus() {
            const st = this.selectTools;
            const active = () => this.doc.manifest && this.doc.layer(this.activeID());
            const pixels = () => { const r = active(); return Boolean(r && this.doc.entry(r.id).image); };
            const doc = () => Boolean(this.doc.manifest);
            return [
                { title: 'Edit', items: [
                    // "Undo <action name>" (CompositorApp.swift:42-46).
                    { label: () => (this.history.done.length ? `Undo ${this.history.done[this.history.done.length - 1].label}` : 'Undo'), def: 'Undo', enabled: () => this.canUseHistory() && this.history.done.length > 0, run: () => this.undoRedo('undo') },
                    { label: () => (this.history.undone.length ? `Redo ${this.history.undone[this.history.undone.length - 1].label}` : 'Redo'), def: 'Redo', enabled: () => this.canUseHistory() && this.history.undone.length > 0, run: () => this.undoRedo('redo') },
                    null,
                    { label: 'Cut', def: 'Cut', enabled: () => this.hasPixelsSelected() && !this.isLocked(active()), run: () => this.clipboardKey('cut') },
                    { label: 'Copy', def: 'Copy', enabled: doc, run: () => this.clipboardKey('copy') },
                    { label: 'Copy Merged', def: 'Copy Merged', enabled: () => doc() && !(this.selection && Selection.isEmpty(this.selection)) && this.doc.layers.some((l) => this.doc.entry(l.id).image), run: () => this.clipboardKey('copyMerged') },
                    { label: 'Paste', def: 'Paste', enabled: doc, run: () => this.clipboardKey('paste') },
                    null,
                    // CommandGroup(after: .pasteboard) (CompositorApp.swift:234-236).
                    { label: 'Keyboard Shortcuts…', enabled: () => true, run: () => this.openShortcutEditor() },
                    { label: 'Fill with Foreground Color', def: 'Fill with Foreground', enabled: () => doc() && !this.engineEditRefusal(), run: () => this.fill('foreground') },
                    { label: 'Fill with Background Color', def: 'Fill with Background', enabled: () => doc() && !this.engineEditRefusal(), run: () => this.fill('background') },
                    { label: 'Clear Selection Pixels', enabled: () => this.hasSelection() && (pixels() || this.isMaskSelected) && this.canEditLayers(), run: () => this.clearSelected() },
                    { label: 'Content-Aware Fill…', def: 'Content-Aware Fill', enabled: () => this.canContentAwareFill(), run: () => this.contentAwareFill() },
                ] },
                { title: 'Image', items: [
                    // Curves…, Levels…, Hue/Saturation… and the panel adjustments (media/filters.js).
                    ...this.filters.imageMenuItems(),
                    { label: () => (this.isMaskSelected ? 'Invert Mask' : 'Invert'), def: 'Invert Pixels / Mask', enabled: () => this.canInvert(), run: () => this.invertPixels() },
                    // Canvas Size…, Image Size…, Trim…, Rotate and Flip Canvas (media/crop.js).
                    ...this.canvasCommandItems(),
                ] },
                // The Layer menu in Compositor's order and enabling (CompositorApp.swift:340-394).
                { title: 'Layer', items: [
                    // New Adjustment Layer and Edit Adjustment… (media/filters.js).
                    ...this.filters.layerMenuItems(),
                    null,
                    { label: () => (this.canTransformSelection() ? 'Transform Selection' : 'Transform Layer'), def: 'Transform Layer / Selection', enabled: () => this.canTransformCommand(), run: () => this.transformCommand() },
                    { label: () => (this.selection ? 'Layer via Copy' : 'Duplicate Layer'), def: 'Duplicate / Layer via Copy', enabled: () => this.canEditLayers() && Boolean(active()) && (!this.selection || (this.hasPixelsSelected() && !active().isGroup)), run: () => this.layerViaCopyOrDuplicate() },
                    null,
                    { label: () => (active() && active().maskSourceID ? 'Release Clipping Mask' : 'Create Clipping Mask'), def: 'Toggle Clipping Mask', enabled: () => Boolean(active()) && this.canToggleClippingMask(this.activeID()), run: () => this.toggleClippingMask(this.activeID()) },
                    null,
                    { label: 'Group Selected Layers', def: 'Group Layers', enabled: () => this.canEditLayers(), run: () => this.groupLayers() },
                    { label: 'Ungroup Layers', def: 'Ungroup Layers', enabled: () => this.canUngroupLayers(), run: () => this.ungroupLayers() },
                    { label: 'Move Out of Folder', enabled: () => this.canEditLayers() && Boolean(active() && active().parentID), run: () => this.moveOutOfFolder() },
                    { label: 'New Blank Layer', def: 'New Blank Layer', enabled: () => this.canEditLayers(), run: () => this.actions.newLayer() },
                    { label: 'Rename Layer…', enabled: () => this.canEditLayers() && Boolean(active()), run: () => this.layers.renameActive() },
                    { label: () => (active() && !active().isVisible ? 'Show Layer' : 'Hide Layer'), enabled: () => this.canEditLayers() && Boolean(active()), run: () => this.actions.setVisible(this.activeID(), !active().isVisible) },
                    // Board-only: a lock (layer-ops.js), Photoshop's Lock All.
                    { label: () => (this.selectionLocked() ? 'Unlock Layer' : 'Lock Layer'), def: 'Lock / Unlock Layer', enabled: () => this.canToggleLock(), run: () => this.toggleLock() },
                    null,
                    { label: 'Move Layer Up', def: 'Move Layer Up', enabled: () => this.canMoveActiveLayer(1), run: () => this.actions.step(this.activeID(), 1) },
                    { label: 'Move Layer Down', def: 'Move Layer Down', enabled: () => this.canMoveActiveLayer(-1), run: () => this.actions.step(this.activeID(), -1) },
                    { label: () => this.mergeTitle(), def: 'Merge Layers', enabled: () => this.canMergeLayers(), run: () => this.mergeLayers() },
                    null,
                    { label: 'Flip Layer Horizontal', enabled: () => this.canTransform(), run: () => this.flipLayers(true) },
                    { label: 'Flip Layer Vertical', enabled: () => this.canTransform(), run: () => this.flipLayers(false) },
                    null,
                    { label: () => (this.selectedEffect() ? `Delete ${CB.Effects.NAME[this.selectedEffect().kind]}` : this.isMaskSelected && active() && active().maskFile ? 'Delete Layer Mask' : this.selectedIDs.size > 1 ? 'Delete Layers' : 'Delete Layer'), enabled: () => this.canEditLayers() && Boolean(active()), run: () => this.deleteLayerOrMask() },
                ] },
                { title: 'Select', items: [
                    { label: 'All', def: 'Select All', enabled: doc, run: () => st.selectAll() },
                    { label: 'Deselect', def: 'Deselect', enabled: () => this.hasSelection(), run: () => st.deselect() },
                    { label: 'Inverse', def: 'Inverse Selection', enabled: () => this.hasSelection(), run: () => st.inverse() },
                    null,
                    { label: "Layer's Pixels", enabled: pixels, run: () => st.loadLayer(this.activeID()) },
                    { label: 'Subject', def: 'Select Subject', enabled: doc, run: () => st.subject() },
                    { label: 'Color Range…', enabled: () => doc() && !st.colorRange, run: () => st.openColorRange() },
                    { label: "Mask's Black Areas", enabled: () => Boolean(active() && active().maskFile), run: () => st.loadMask(this.activeID()) },
                    null,
                    { label: 'Expand…', enabled: () => st.canModify(), run: () => st.amountPanel('expand') },
                    { label: 'Contract…', enabled: () => st.canModify(), run: () => st.amountPanel('contract') },
                    { label: 'Feather…', enabled: () => st.canModify(), run: () => st.amountPanel('feather') },
                ] },
                { title: 'View', items: this.viewMenuItems() },
                { title: 'Filter', items: this.filters.filterMenuItems() },
                { title: 'File', items: this.fileMenuItems() },
            ].map((menu) => (menu.title === 'View' || menu.title === 'File' ? menu : {
                // While a filter panel is open only the view changes (filterEdit blocks every edit command).
                ...menu,
                items: gateItems(menu.items, () => !this.filters.isOpen && !this.selectTools.colorRange),
            })).sort((a, b) => MENU_ORDER.indexOf(a.title) - MENU_ORDER.indexOf(b.title));
        }

        // The menu item whose definition's current chord is `chord` (its key equivalent), with `vscode` when VS Code is
        // to run it at its default chord instead (chrome.md 16.3 step 5).
        menuKey(chord) {
            const S = CB.Shortcuts;
            let hit = null;
            const walk = (items) => {
                for (const item of items) {
                    if (hit || !item) continue;
                    if (item.submenu) walk(item.submenu);
                    else if (item.def && S.same(S.chordFor(item.def), chord)) hit = item;
                }
            };
            for (const menu of this.menus()) walk(menu.items);
            if (!hit) return null;
            const atDefault = S.isDefault(hit.def);
            const vscodeRuns = atDefault && ((VSCODE_COMMANDS.has(hit.def) && !(this.place === 'sidebar' && hit.def === 'Save'))
                || (this.place === 'editor' && (hit.def === 'Undo' || hit.def === 'Redo')));
            return { item: hit, vscode: vscodeRuns };
        }

        // A key equivalent of a disabled item beeps, as AppKit does.
        runMenuKey(item) {
            if (item.enabled && !item.enabled()) { CB.beep(); return; }
            item.run();
        }

        // A small panel over the canvas with Cancel and OK (Expand/Contract/Feather, Color Range). `setup(el)` returns the
        // OK handler, which returns false to keep the panel open.
        panel(title, body, setup, onCancel) {
            // One panel at a time: another one open is cancelled as its own Cancel would.
            if (this.openPanel) this.cancelPanel();
            const el = document.createElement('div');
            el.className = 'floating-panel';
            el.innerHTML = `<div class="panel-title">${escape(title)}<button class="panel-close" title="Close" aria-label="Close">${icon('close')}</button></div>${body}<div class="buttons"><button class="pill cancel">Cancel</button><button class="pill ok">OK</button></div>`;
            this.stageEl.appendChild(el);
            // FloatingPanelController: centred on the canvas the first time, then where it was last left, by name, for
            // the session (all boards share the places, kept by the extension).
            const place = this.panelPlaces[title];
            const maxX = Math.max(0, this.stageEl.clientWidth - el.offsetWidth), maxY = Math.max(0, this.stageEl.clientHeight - el.offsetHeight);
            el.style.left = `${place ? Math.min(maxX, place.left) : maxX / 2}px`;
            el.style.top = `${place ? Math.min(maxY, place.top) : maxY / 2}px`;
            this.openPanel = el;
            const ok = setup(el) || (() => true);
            // `onCancel` returning false keeps the panel (a filter being applied cannot be cancelled).
            const cancel = () => { if (onCancel && onCancel() === false) return; this.closePanel(); };
            this.panelCancel = cancel;
            el.querySelector('.ok').addEventListener('click', () => { if (ok() !== false) this.closePanel(); });
            el.querySelector('.cancel').addEventListener('click', cancel);
            // The title-bar close button acts as Cancel (windowWillClose -> onClose).
            el.querySelector('.panel-close').addEventListener('click', cancel);
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            // Panels float: dragging the title moves one off what it covers, kept inside the canvas area.
            const handle = el.querySelector('.panel-title');
            handle.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.panel-close')) return;
                handle.setPointerCapture(e.pointerId);
                const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop };
                handle.onpointermove = (m) => {
                    const maxX = this.stageEl.clientWidth - el.offsetWidth, maxY = this.stageEl.clientHeight - el.offsetHeight;
                    el.style.left = `${Math.max(0, Math.min(maxX, start.left + m.clientX - start.x))}px`;
                    el.style.top = `${Math.max(0, Math.min(maxY, start.top + m.clientY - start.y))}px`;
                };
                handle.onpointerup = () => {
                    handle.onpointermove = null;
                    handle.onpointerup = null;
                    this.panelPlaces[title] = { left: el.offsetLeft, top: el.offsetTop };
                    vscode.postMessage({ type: 'panelPlace', name: title, place: this.panelPlaces[title] });
                };
            });
            // The default and cancel buttons follow "Apply / Cancel current canvas operation" (configuredNativeShortcut).
            el.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (CB.Shortcuts.isCancel(e)) { e.preventDefault(); cancel(); }
                else if (CB.Shortcuts.isApply(e)) { e.preventDefault(); if (!el.querySelector('.ok').disabled && ok() !== false) this.closePanel(); }
            });
            const first = el.querySelector('input.num');
            if (first) { first.focus(); first.select(); }
        }

        closePanel() {
            if (this.openPanel) this.openPanel.remove();
            this.openPanel = null;
            this.panelCancel = null;
        }

        // Escape with focus outside the panel: the panel's own Cancel.
        cancelPanel() {
            if (this.panelCancel) this.panelCancel();
            else this.closePanel();
        }

        engineAnswered({ id, ok, result, error, files }) {
            const call = this.engineCalls.get(id);
            if (!call) return;
            this.engineCalls.delete(id);
            if (!call.quiet) {
                this.working = Math.max(0, this.working - 1);
                if (!this.working) {
                    clearTimeout(this.busyTimer);
                    this.busyShown = false;
                }
                this.updateStatus();
            }
            if (ok) call.resolve({ ...(result || {}), files: files || {} });
            else call.reject(new Error(error));
        }

        openInCompositor() {
            vscode.postMessage({ type: 'openInCompositor' });
        }

        // A message to the extension from a tool module (the Type tool's text lane).
        post(message) {
            vscode.postMessage(message);
        }

        // The project's folder disappeared from disk while open: nothing more can be saved, so the canvas is covered
        // with what happened and a way out, rather than letting each edit fail on its own.
        showGone(root) {
            this.gone = true;
            this.view.cancel();
            this.closePanel();
            if (this.goneEl) this.goneEl.remove();
            const el = document.createElement('div');
            el.className = 'gone';
            el.innerHTML = `<div class="gone-box"><div class="panel-title">This project is no longer on disk</div>
                <div>${escape(root)} was moved or deleted while this board was open, so changes made here cannot be saved.
                Close this board, then open the project where it is now.</div>
                <div class="buttons"><button class="pill close-gone">Close Board</button></div></div>`;
            el.querySelector('.close-gone').addEventListener('click', () => vscode.postMessage({ type: 'closeGone' }));
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.stageEl.appendChild(el);
            this.goneEl = el;
            this.saveState = 'Not on disk';
            this.updateStatus();
        }

        hideGone() {
            this.gone = false;
            if (this.goneEl) this.goneEl.remove();
            this.goneEl = null;
            this.saveState = 'Saved';
            this.updateStatus();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Keyboard (ui.md section 2 and 12.2): every chord the board handles is stopped here, so VS Code does not run
        // its own command for it as well. Undo and redo are left to VS Code, which calls back through the extension.

        // The dispatch pipeline of chrome.md 16.3: text fields keep their keys (but ⌘ menu commands that are not text
        // editing still run); a pending gradient or floating pixels take Undo; the default zoom chords repeat; menu
        // items run by their current chord (VS Code keeps New, Open, Save, Save As, Close and, in an editor tab,
        // Undo/Redo at their defaults); then a remapped canvas key is read as the key it stands for.
        keydown(event) {
            if (event.key === 'Alt') { this.view.altHeld = true; this.view.cursor(); this.view.drawOverlay(); }
            if (!this.doc.manifest || this.gone) return;
            const S = CB.Shortcuts;
            const chord = S.chordFromEvent(event);
            if (!chord) return;
            const typing = isTyping(event.target);
            const consumeEvent = () => { event.preventDefault(); event.stopPropagation(); };
            if (typing) {
                if (chord.modifiers & 1) {
                    const found = this.menuKey(chord);
                    if (found && !found.vscode && !TEXT_COMMANDS.has(found.item.def)) { consumeEvent(); this.runMenuKey(found.item); }
                }
                return;
            }
            if (!this.view.busy) {
                if (S.same(chord, S.chordFor('Undo'))) {
                    // ⌘Z with a gradient line pending only discards it (EditorSession.swift:657-660); with pixels
                    // floating it puts them back, as Escape does.
                    if (this.interceptUndo()) { consumeEvent(); return; }
                    if (this.selectTools.floating) { this.selectTools.cancelFloating(); consumeEvent(); return; }
                }
                // handleKeyboardZoom (EditorCanvas.swift:798-816): while Zoom In and Zoom Out keep their default chords,
                // ⌘= with or without ⇧ and keypad + zoom in, ⌘- (not ⇧⌘-) and keypad - zoom out, key repeat included.
                if (event.metaKey && !event.ctrlKey && !event.altKey) {
                    if (S.isDefault('Zoom In') && (event.code === 'Equal' || event.code === 'NumpadAdd')) { this.view.zoomStep(1); consumeEvent(); return; }
                    if (S.isDefault('Zoom Out') && ((event.code === 'Minus' && !event.shiftKey) || event.code === 'NumpadSubtract')) { this.view.zoomStep(-1); consumeEvent(); return; }
                }
                const found = this.menuKey(chord);
                if (found) {
                    if (found.vscode) return;
                    consumeEvent();
                    this.runMenuKey(found.item);
                    return;
                }
            }
            const translated = S.canvasChord(chord);
            if (!translated) { consumeEvent(); return; }
            const e = S.same(translated, chord) ? event : S.eventFor(translated, event);
            const consume = consumeEvent;
            const mod = e.metaKey || e.ctrlKey;
            const code = e.code;
            const st = this.selectTools;
            const module = this.toolModule();
            if (code === 'Escape') {
                if (this.cancelGuideDrag()) { if (this.view.drag && this.view.drag.kind === 'guide') this.view.drag = null; consume(); return; }
                if (this.canvasOnly && this.escapeHasNothingToCancel() && !this.picker.isOpen && !this.openMenu && this.menuBar.open === null
                    && !this.openPanel && !this.selectTools.colorRange && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
                    this.toggleCanvasOnly();
                    consume();
                    return;
                }
                if (this.view.cancel() || this.picker.isOpen || this.openMenu || this.menuBar.open !== null) {
                    this.picker.close(false);
                    this.closeMenus();
                    this.menuBar.close();
                    consume();
                } else if (st.colorRange) { st.closeColorRange(false); consume(); }
                else if (this.openPanel) { this.cancelPanel(); consume(); }
                else if (module && module.escape && module.escape()) consume();
                else if (st.key(e) || st.cancelFloating() || this.cancelTransformEdit()) consume();
                return;
            }
            if (this.view.busy) { if (!mod) consume(); return; }
            // An open panel (a filter, Expand…, Color Range) takes Return; while a filter is open the canvas is only
            // looked at: panning and zooming work, nothing edits.
            if (this.openPanel && (code === 'Enter' || code === 'NumpadEnter')) { this.openPanel.querySelector('.ok').click(); consume(); return; }
            if (this.filters.isOpen) {
                const view = mod && ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Digit0', 'Digit1'].includes(code);
                if (code === 'Space') { if (!e.repeat) { this.view.space = true; this.panKey = event.code; this.view.cursor(); } consume(); return; }
                if (!view) { if (!(mod && code === 'KeyS')) consume(); return; }
            }
            // The current tool's module sees keys first (Return applies a crop or a gradient, arrows, Delete...).
            if (module && module.keydown && module.keydown(e)) { consume(); return; }
            // A polygon or Marquee in progress takes Return and Delete first (spec 3.5: even mid-drag).
            if (!mod && st.draft && st.key(e)) { consume(); return; }
            if (!mod && (code === 'Enter' || code === 'NumpadEnter') && st.floating) { st.commitFloating(); consume(); return; }
            if (!mod && (code === 'Enter' || code === 'NumpadEnter') && this.transformEdit) { this.commitTransformEdit(); consume(); return; }
            if (mod) {
                // Menu chords ran above; ⌘-arrows (Move selected pixels, a canvas definition) are what is left.
                if (code.startsWith('Arrow') && e.metaKey && !e.ctrlKey && !e.altKey) {
                    // ⌘-arrows nudge the selected pixels with any tool, one undo step per press.
                    if (this.hasPixelsSelected() && !st.draft && !this.refuseLocked([this.activeLayer()])) {
                        const step = e.shiftKey ? 10 : 1;
                        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[code];
                        this.selectionOp('selection.nudgePixels', { dx: d[0], dy: d[1] }, 'Move Pixels');
                    }
                    consume();
                }
                return;
            }
            if (e.altKey && code !== 'Space') return;
            const tools = { KeyA: 'none' };
            for (const t of railTools()) if (t.key) tools[t.key] = t.id;
            // The hand is let go on key-up of the same physical key, remapped or not (panPhysicalKey).
            if (code === 'Space') { if (!e.repeat) { this.view.space = true; this.panKey = event.code; this.view.cursor(); } consume(); }
            else if (tools[code]) { if (!e.repeat) this.selectTool(tools[code]); consume(); }
            else if (code === 'KeyB') { this.selectTool('brush', 'paint'); consume(); }
            else if (code === 'KeyE') { this.selectTool('brush', 'erase'); consume(); }
            else if (code === 'KeyU') {
                if (e.shiftKey && this.tool === 'shape') this.cycleMode();
                else this.selectTool('shape');
                consume();
            } else if (code === 'Tab' && !e.shiftKey) { this.cycleMode(); consume(); }
            else if (code === 'KeyX') { this.swapColors(); consume(); }
            else if (code === 'KeyD') { this.defaultColors(); consume(); }
            else if ((code === 'BracketLeft' || code === 'BracketRight') && this.isBrushTool()) {
                const up = code === 'BracketRight';
                if (e.shiftKey) this.brush.hardness = Brush.stepHardness(this.brush.hardness, up);
                else this.brush.diameter = Brush.stepDiameter(this.brush.diameter, up);
                this.refreshOptionValues();
                this.view.drawOverlay();
                consume();
            } else if (/^(Digit|Numpad)[0-9]$/.test(code) && !e.shiftKey) {
                const digit = Number(code.slice(-1));
                const result = Brush.opacityDigit(this.opacityDigit, digit, performance.now());
                this.opacityDigit = result.pending;
                // typeOpacityDigit: brush tools set their opacity (Smear its strength), the Gradient its own, Move the
                // selected layers'.
                if (this.isBrushTool()) { this.brush.opacity = result.percent / 100; this.refreshOptionValues(); }
                else if (module && module.opacityDigit) module.opacityDigit(result.percent);
                else if (this.tool === 'move' && this.activeID()) this.actions.setSelectedLayersOpacity(result.percent / 100);
                consume();
            } else if ((code === 'Equal' || code === 'Minus') && e.shiftKey) {
                const record = this.activeLayer();
                if (record && this.canEditAppearance()) this.actions.setBlend(record.id, Blend.next(record.blendMode || 'Normal', code === 'Equal' ? 1 : -1));
                consume();
            } else if ((code === 'ArrowUp' || code === 'ArrowDown') && document.activeElement === this.layers.list && this.tool !== 'move' && !st.floating) {
                this.layers.stepSelection(code === 'ArrowUp' ? -1 : 1, e.shiftKey);
                consume();
            } else if (code.startsWith('Arrow') && st.isTool(this.tool)) {
                // Arrows nudge the outline (1 px, 10 px with Shift), one undo step per press.
                if (!e.ctrlKey) {
                    const step = e.shiftKey ? 10 : 1;
                    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[code];
                    st.nudge(d[0], d[1]);
                }
                consume();
            } else if (code.startsWith('Arrow') && this.tool === 'move' && st.floating) {
                const step = e.shiftKey ? 10 : 1;
                const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[code];
                st.floating.draft = { ...st.floating.draft, x: st.floating.draft.x + d[0], y: st.floating.draft.y + d[1] };
                this.changed();
                consume();
            } else if (code.startsWith('Arrow') && this.tool === 'move') {
                // nudgeLayer (EditorSession.swift:570-579): the layer, the selected layers or the unlinked mask, one step
                // each, or the open edit's draft (and corners).
                const step = e.shiftKey ? 10 : 1;
                const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[code];
                this.nudgeLayer(d[0], d[1]);
                consume();
            } else if ((code === 'Backspace' || code === 'Delete') && !e.shiftKey) {
                // ⌫ clears the selected pixels, or deletes the layer when nothing is selected (⇧⌫ is a menu chord). A board
                // choice, not Compositor's: in the Layers list it deletes as the trash button does, selection or not.
                if (this.layers.list.contains(document.activeElement)) this.deleteLayerOrMask();
                else this.deleteKeyPressed();
                consume();
            }
        }

        keyup(e) {
            if (this.view.space && e.code === (this.panKey || 'Space')) { this.view.space = false; this.panKey = null; this.view.cursor(); }
            if (e.key === 'Alt') { this.view.altHeld = false; this.view.cursor(); this.view.drawOverlay(); }
        }

        // VS Code's own Edit menu reaches the webview as DOM copy / cut / paste events; the chords are handled in keydown
        // and remembered so the event that may follow them is not run twice.
        clipboardKey(kind) {
            this.lastClipboardKey = performance.now();
            this.clipboard(kind);
        }

        clipboardEvent(e) {
            const t = e.target;
            const typing = isTyping(t);
            if (typing || !this.doc.manifest) return;
            e.preventDefault();
            if (this.filters.isOpen) return;
            if (this.lastClipboardKey && performance.now() - this.lastClipboardKey < 400) return;
            this.clipboard(e.type);
        }

        async receive(message) {
            try {
                switch (message.type) {
                    case 'load': await this.load(message); break;
                    case 'empty': this.showWelcome(message.recent || []); break;
                    // VS Code's own Undo / Redo (its menu or palette): a pending gradient or text draft takes Undo first,
                    // and history waits while canUseHistory says no, as the app's menu items do.
                    case 'undo': if (!this.interceptUndo() && this.canUseHistory()) this.history.undo(); break;
                    case 'redo': if (this.canUseHistory()) this.history.redo(); break;
                    case 'saved':
                        this.doc.markSaved(message.manifestHash);
                        this.saveState = 'Saved';
                        this.updateStatus();
                        break;
                    case 'notes':
                        this.notes.set(message.notes);
                        this.notesChanged();
                        break;
                    case 'request': await this.answer(message); break;
                    case 'engineResult': this.engineAnswered(message); break;
                    case 'claudeResult': this.claudeAnswered(message); break;
                    case 'claudeTabs': this.refreshClaudeSessions(); break;
                    case 'missing': this.showGone(message.root); break;
                    case 'shortcuts': CB.Shortcuts.load(message.json); this.menuBar.render(); break;
                    case 'cmykLoaded': this.cmykProfileLoaded(message.name); break;
                    case 'deactivate': if (this.selectTools.floating) this.selectTools.commitFloating(); break;
                    case 'found': this.hideGone(); break;
                    case 'fatal':
                        document.getElementById('app').innerHTML = `<div class="fatal">${escape(message.message)}</div>`;
                        break;
                }
            } catch (error) {
                console.error('[compositor-board]', error);
                if (message.type === 'request') vscode.postMessage({ type: 'response', id: message.id, ok: false, error: error.message });
            }
        }

        async answer({ id, kind, args }) {
            let result;
            if (kind === 'save') {
                // A pending gradient is applied before saving, as before closing (ProjectWorkspace.swift:137).
                await this.resolvePending('save');
                this.saveState = 'Saving…';
                this.updateStatus();
                // An open adjustment editor's preview is not saved; only its OK changes the layer (media/filters.js).
                result = await this.filters.savingOriginals(() => this.doc.exportChanges());
                if (!result.changed) { this.saveState = 'Saved'; this.updateStatus(); }
            } else if (kind === 'capture') result = await this.capture(args);
            else if (kind === 'external') result = await this.applyExternal(args);
            else if (kind === 'state') result = this.state();
            vscode.postMessage({ type: 'response', id, ok: true, result });
        }

        async load({ manifest, manifestHash, images, notes, boardState, settings, place }) {
            this.view.cancel();
            this.selection = null;
            this.selectTools.cancelDraft();
            this.selectTools.floating = null;
            this.selectTools.colorRange = null;
            this.filters.edit = null;
            this.renderer.overrides.clear();
            // A transform edit or crop frame belongs to the document it was opened on.
            this.transformEdit = null;
            this.transformPreviewIDs = [];
            this.cropEdit = null;
            this.closePanel();
            this.place = place || 'editor';
            this.hideWelcome();
            await this.doc.load({ manifest, manifestHash, images });
            this.initLayerState();
            this.layers.collapsed = new Set();
            this.setActive(this.doc.manifest.activeLayerID && this.doc.layer(this.doc.manifest.activeLayerID) ? this.doc.manifest.activeLayerID : null);
            this.notes.set(notes);
            this.loadBoardState(boardState);
            this.claudeSessions = null;
            this.refreshClaudeSessions();
            if (settings && settings.checkerboard === false) this.settings.checkerboard = false;
            if (settings && settings.pixelBudget) this.documentBudget = settings.pixelBudget;
            const prefs = (settings && settings.preferences) || {};
            this.readPrefs(prefs);
            if (settings && settings.panelPlaces) this.panelPlaces = { ...settings.panelPlaces, ...this.panelPlaces };
            if (settings && 'shortcuts' in settings) CB.Shortcuts.load(settings.shortcuts);
            if (typeof prefs.autoSelect === 'boolean') this.settings.autoSelect = prefs.autoSelect;
            if (typeof prefs.showControls === 'boolean') this.settings.showControls = prefs.showControls;
            if (Number.isFinite(prefs.panelWidth)) {
                this.panelWidth = Math.round(Math.min(352, Math.max(222, prefs.panelWidth)));
                document.documentElement.style.setProperty('--panel-width', `${this.panelWidth}px`);
            }
            if ('notesHeight' in prefs) this.setNotesHeight(prefs.notesHeight);
            this.history = new CB.History((label) => vscode.postMessage({ type: 'edit', label }), (bitmap) => this.isLiveBitmap(bitmap));
            this.layoutRulers();
            this.renderProofBadges();
            if (!this.cmykProfiles) this.loadCMYKProfiles();
            this.view.fit();
            this.changed();
            this.toolChanged();
            this.menuBar.render();
            if (this.doc.problems.length) this.toast(`Some layers could not be read: ${this.doc.problems.join('; ')}`);
        }

        async applyExternal(args) {
            await this.idle();
            const size = [this.doc.width, this.doc.height];
            const { entry, dirty } = await this.doc.mergeExternal(args);
            if (entry) this.history.push(entry, { silent: true });
            // A new canvas size (Crop, Canvas Size, Image Size, Trim, Rotate Canvas) fits the view again and drops a
            // crop frame (applyDocumentSize, geometry.md 9.2).
            if (size[0] !== this.doc.width || size[1] !== this.doc.height) {
                this.cancelCrop();
                this.view.fit();
            }
            this.changed();
            return { edited: Boolean(entry), label: entry ? entry.label : null, dirty };
        }

        state() {
            const record = this.doc.layer(this.activeID());
            return { activeLayer: record ? record.name : null, tool: this.tool, dirty: this.doc.isDirty(), zoom: this.view.zoom, selection: this.selectionSummary() };
        }

        // The person's selection, for Claude: its bounding box in document pixels, or that it is explicitly empty.
        selectionSummary() {
            const s = this.selection;
            if (!s) return null;
            const b = Selection.pathBounds(s.path);
            if (!b || Selection.isEmpty(s)) return { empty: true };
            const round = (v) => Math.round(v * 10) / 10;
            return { bounds: { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) }, feather: round(s.feather), antialiased: s.antialiased, outlinePoints: s.path.length };
        }

        // What Claude sees: the live composite (strokes in progress included) over a light checkerboard so transparency
        // shows, the notes drawn on top, scaled to at most `maxSize` on the long side.
        async capture({ maxSize = 1568, region, showNotes = true, showSelection = true } = {}) {
            const doc = this.doc;
            const composite = this.compositeCanvas();
            let r = { x: 0, y: 0, width: doc.width, height: doc.height };
            if (region) {
                const x = Math.max(0, Math.floor(region.x)), y = Math.max(0, Math.floor(region.y));
                r = { x, y, width: Math.max(1, Math.min(doc.width - x, Math.ceil(region.width))), height: Math.max(1, Math.min(doc.height - y, Math.ceil(region.height))) };
            }
            const scale = Math.min(1, Math.min(2576, maxSize) / Math.max(r.width, r.height));
            const w = Math.max(1, Math.round(r.width * scale)), h = Math.max(1, Math.round(r.height * scale));
            const out = new OffscreenCanvas(w, h);
            const ctx = out.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#d9d9d9';
            for (let y = 0; y < h; y += 12) for (let x = ((y / 12) & 1) * 12; x < w; x += 24) ctx.fillRect(x, y, 12, 12);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(composite, r.x, r.y, r.width, r.height, 0, 0, w, h);
            if (showSelection && this.selection && !Selection.isEmpty(this.selection)) {
                // The selection as marching ants, so Claude sees what the person picked out.
                const lineScale = Math.max(1, Math.max(w, h) / 900);
                ctx.save();
                ctx.scale(lineScale, lineScale);
                const k = scale / lineScale;
                Selection.drawAnts(ctx, this.selection.path, { a: k, b: 0, c: 0, d: k, e: -r.x * k, f: -r.y * k }, 0);
                ctx.restore();
            }
            if (showNotes) {
                this.notes.draw(ctx, (p) => ({ x: (p.x - r.x) * scale, y: (p.y - r.y) * scale }), { pixelRatio: Math.max(1, Math.max(w, h) / 900) });
            }
            const png = await CB.Document.encodePng(out);
            const info = CB.Render.plan(doc.manifest);
            const active = doc.layer(this.activeID());
            return {
                png, width: w, height: h, region: r, scale,
                notRendered: this.renderer.unrendered(info),
                notes: this.notes.summary(),
                activeLayer: active ? active.name : null,
                selection: this.selectionSummary(),
                inProgress: this.view.busy,
            };
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Layer actions used by the panel, the keyboard and the tools.

    function actions(board) {
        const doc = () => board.doc;
        const names = () => new Set(doc().layers.map((l) => l.name));
        const newID = () => crypto.randomUUID().toUpperCase();
        return {
            // A blank "Layer N" (lowest free N) above the active layer, full-canvas, no pixels yet (addBlankLayer, ES:703-731):
            // with a folder active it goes inside, after the folder's last descendant, and the folder opens.
            newLayer() {
                board.edit('New Blank Layer', () => {
                    let n = 1;
                    while (names().has(`Layer ${n}`)) n++;
                    const record = {
                        id: newID(), name: `Layer ${n}`, isVisible: true, isGroup: false, opacity: 1, blendMode: 'Normal',
                        transform: Transform.write({ x: 0, y: 0, width: doc().width, height: doc().height, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' }),
                    };
                    const layers = doc().layers, active = board.activeLayer();
                    const parent = active ? (active.isGroup ? active.id : active.parentID) : null;
                    if (parent) record.parentID = parent;
                    let at = active ? layers.indexOf(active) + 1 : layers.length;
                    if (active && active.isGroup) {
                        const inside = board.descendantIDs(active.id);
                        layers.forEach((l, i) => { if (inside.has(l.id)) at = Math.max(at, i + 1); });
                    }
                    layers.splice(at, 0, record);
                    if (parent) board.layers.collapsed.delete(parent);
                    board.setActive(record.id);
                });
                board.layerSelectionChanged();
            },

            rename(id, name) {
                board.edit('Rename Layer', () => { doc().layer(id).name = name; });
            },

            setVisible(id, visible) {
                board.edit(visible ? 'Show Layer' : 'Hide Layer', () => { doc().layer(id).isVisible = visible; });
            },

            setBlend(id, mode) {
                const record = doc().layer(id);
                if (!record || record.isGroup) return;
                board.edit('Layer Blend Mode', () => { record.blendMode = mode; });
            },

            // Opacity previews live while a slider or scrub moves, and becomes one undo step when it stops.
            previewOpacity(id, value) {
                const record = doc().layer(id);
                if (!record) return;
                if (!board.pendingOpacity || board.pendingOpacity.id !== id) board.pendingOpacity = { id, before: doc().snapshot() };
                // Stored as given, as the app's slider does (setLayerOpacity clamps but does not round).
                record.opacity = Math.min(1, Math.max(0, value));
                board.composite.dirty = true;
                board.composite.below = null;
                board.schedule();
                board.layers.render();
            },

            // Digit keys with the Move tool: every selected layer, one step (LayerAppearance.setSelectedLayersOpacity).
            setSelectedLayersOpacity(value) {
                if (!board.canEditLayers() || board.refuseLocked(board.selectedRecords())) return;
                const v = Math.min(1, Math.max(0, value));
                board.edit('Layer Opacity', () => {
                    for (const id of board.selectedIDs) { const l = doc().layer(id); if (l && (l.opacity === undefined ? 1 : l.opacity) !== v) l.opacity = v; }
                });
            },

            commitOpacity() {
                const pending = board.pendingOpacity;
                board.pendingOpacity = null;
                if (!pending) return;
                const after = doc().snapshot();
                if (after === pending.before) return;
                doc().metaDirty = true;
                board.history.push({ label: 'Layer Opacity', metaBefore: pending.before, metaAfter: after, pixels: [] });
                board.changed();
            },

            // ⌘] / ⌘[: swap with the adjacent sibling (EditorSession.swift:795-810).
            step(id, direction) {
                const m = doc().manifest;
                const record = doc().layer(id);
                if (!record) return;
                const siblings = m.layers.filter((l) => (l.parentID || null) === (record.parentID || null));
                const i = siblings.indexOf(record), j = i + direction;
                if (j < 0 || j >= siblings.length) return;
                board.edit('Reorder Layers', () => {
                    const a = m.layers.indexOf(record), b = m.layers.indexOf(siblings[j]);
                    [m.layers[a], m.layers[b]] = [m.layers[b], m.layers[a]];
                });
            },

            // A Pen path (pen-tool.js) as its own pixel layer above the active one, "Path N". Returns its id.
            addPathLayer(made) {
                let id = null;
                board.edit('Pen Path', () => {
                    id = newID();
                    let n = 1;
                    while (names().has(`Path ${n}`)) n++;
                    const record = {
                        id, name: `Path ${n}`, imageFile: `${id}.png`, isVisible: true, isGroup: false,
                        opacity: 1, blendMode: 'Normal', transform: Transform.write(made.transform),
                    };
                    board.insertAbove(record, board.activeID());
                    board.setActive(id);
                    doc().entry(id).image = made.image;
                    doc().dirtyImages.add(id);
                    return [{ layerID: id, kind: 'image', beforeBitmap: null, afterBitmap: made.image }];
                });
                return id;
            },

            // A drawn shape as its own layer above the active one, named "<Kind> N" (ShapeTool.finishShape). An outlined
            // shape is plain pixels to Compositor; its style goes to the board state (shapes.js).
            addShapeLayer(made) {
                board.edit(made.style.kind, () => {
                    const id = newID();
                    const record = {
                        id, name: Shapes.nextName(made.style.kind, names()), imageFile: `${id}.png`, isVisible: true, isGroup: false,
                        opacity: 1, blendMode: 'Normal', transform: Transform.write(made.transform),
                    };
                    if (made.outlined) {
                        board.shapeStyles[id] = made.style;
                        board.saveBoardState();
                    } else record.shape = made.style;
                    board.insertAbove(record, board.activeID());
                    board.setActive(id);
                    doc().entry(id).image = made.image;
                    doc().dirtyImages.add(id);
                    return [{ layerID: id, kind: 'image', beforeBitmap: null, afterBitmap: made.image }];
                });
            },
        };
    }

    Object.assign(Board.prototype, CB.LayerOps, CB.ViewChrome, CB.Palette, CB.Proofing, CB.EffectsOps, CB.TransformEdits, CB.FileUI || {});
    const board = new Board();
    board.actions = actions(board);
    window.board = board;
})();
