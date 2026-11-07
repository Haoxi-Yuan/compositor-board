'use strict';
// The board's File menu (docs/port-specs/file.md): the New canvas form shown when no project is open (the side bar's
// welcome view and the New Canvas tab), importing images with Compositor's RAW develop and Photoshop conversion sheets,
// the Export As sheet with its live preview, and drops onto the canvas. Compositor's own code reads and writes in
// compositor-engine (engine/Sources/FileOps.swift); the extension shows VS Code's dialogs (file-commands.js). Mixed
// into the Board.

(function () {
    const CB = (window.CB = window.CB || {});
    // Installed once: a development VS Code has been seen to hand a webview a changed script several times over.
    if (CB.FileUI) return;
    const MAX_SIDE = 30000;
    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const groupedSide = MAX_SIDE.toLocaleString('en-US');

    // ---------------------------------------------------------------------------------------------------------------
    // New canvas (UI/NewCanvasSheet.swift)

    // NewCanvasUnit: px → in → cm → mm, print units turning into pixels at the DPI.
    const UNITS = [
        { id: 'px', name: 'Pixels', perInch: null }, { id: 'in', name: 'Inches', perInch: 1 },
        { id: 'cm', name: 'Centimeters', perInch: 2.54 }, { id: 'mm', name: 'Millimeters', perInch: 25.4 },
    ];
    const BACKGROUNDS = ['transparent', 'white', 'black'];
    // CanvasPreset.groups (NewCanvasSheet.swift:237-265).
    const PRESETS = [
        [['4K', 3840, 2160], ['1440p', 2560, 1440], ['1080p', 1920, 1080]],
        [['iPhone 18 Pro', 1206, 2622], ['iPhone 18 Pro Max', 1320, 2868], ['MacBook Pro 14"', 3024, 1964], ['MacBook Pro 16"', 3456, 2234], ['Studio Display', 5120, 2880]],
        [['Instagram Square', 1080, 1080], ['Instagram Portrait', 1080, 1350], ['Instagram Story', 1080, 1920], ['YouTube Thumb', 1080, 608]],
    ];

    // Swift's Double(String) after trimming spaces and turning every comma into a point: decimals, exponents and hex
    // pass, as Number() reads them; binary and octal literals and underscores do not (file.md 3.3).
    function parseNumber(text) {
        const t = String(text).replace(/^[ \t]+|[ \t]+$/g, '').replaceAll(',', '.');
        if (!t || /^[+-]?0[bBoO]/.test(t) || t.includes('_')) return null;
        const v = Number(t);
        return Number.isNaN(v) ? null : v;
    }

    // NewCanvasUnit.pixels: whole pixels 1...30,000 for a typed size, or null.
    function pixels(text, unit, resolution) {
        const value = parseNumber(text);
        if (value === null || !Number.isFinite(value) || value <= 0) return null;
        const px = unit.perInch ? Math.round((value / unit.perInch) * resolution) : value;
        if (px !== Math.round(px) || px < 1 || px > MAX_SIDE) return null;
        return px;
    }

    // NewCanvasUnit.text: whole pixels, or a print size with at most two decimals, no grouping.
    function unitText(px, unit, resolution) {
        if (!unit.perInch) return String(px);
        return String(Number(((px / resolution) * unit.perInch).toFixed(2)));
    }

    // ByteCountFormatter, file style (decimal units; measured outputs in file.md 10.2).
    function byteCount(n) {
        if (n === 0) return 'Zero KB';
        if (n < 1000) return n === 1 ? '1 byte' : `${n} bytes`;
        const fmt = (v, digits) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v);
        if (n < 1e6) return `${fmt(Math.round(n / 1e3), 0)} KB`;
        if (n < 1e9) return `${fmt(n / 1e6, 1)} MB`;
        return `${fmt(n / 1e9, 2)} GB`;
    }

    // Requests to the extension that answer (fileResult), by id.
    const fileRequests = new Map();
    let nextFileRequest = 1;
    // The first welcome of the side bar after the extension starts skips the clipboard suggestion (the launch tab).
    let sidebarWelcomes = 0;

    const FileUI = {
        // ---------------------------------------------------------------------------------------------------------------
        // Plumbing

        fileRequest(command, args = {}) {
            const id = nextFileRequest++;
            return new Promise((resolve, reject) => {
                fileRequests.set(id, { resolve, reject });
                this.postMessage({ type: 'fileRequest', id, command, args });
            });
        },

        // An engine operation that needs no board document (the welcome view and the New Canvas tab have none), answered
        // through the board's own engineResult path.
        fileEngine(op, args = {}, { files } = {}) {
            const id = this.nextEngineCall++;
            this.working++;
            if (this.working === 1) {
                clearTimeout(this.busyTimer);
                this.busyTimer = setTimeout(() => { this.busyShown = true; this.updateStatus(); }, 250);
            }
            this.updateStatus();
            return new Promise((resolve, reject) => {
                this.engineCalls.set(id, { resolve, reject });
                this.postMessage({ type: 'fileEngine', id, op, args, files });
            });
        },

        // A file operation reading the project as saved (its pixel budget counts), or none at all.
        fileOp(op, args = {}, opts = {}) {
            return this.doc.manifest ? this.engine(op, args, { stateless: true, ...opts }) : this.fileEngine(op, args, opts);
        },

        fileMessage(message) {
            switch (message.type) {
                case 'empty':
                    this.newCanvasTab = Boolean(message.newCanvas);
                    break;
                case 'importFiles':
                    this.queueImport(message.paths || [], { point: message.point || null, temp: message.temp || [], extraErrors: message.extraErrors || [] });
                    break;
                case 'fileAction':
                    if (message.action === 'exportAs') this.openExportAs();
                    else if (message.action === 'exportJPEG') this.openExportAs('JPEG');
                    break;
                case 'fileResult': {
                    const pending = fileRequests.get(message.id);
                    if (!pending) break;
                    fileRequests.delete(message.id);
                    if (message.ok) pending.resolve(message.result || {});
                    else pending.reject(new Error(message.error));
                    break;
                }
            }
        },

        // File requests wait while something else holds the project (canStartProjectOperation, file.md 1.1).
        canStartFileOperation() {
            return !this.view.busy && !this.filters.isOpen && !this.selectTools.colorRange && !this.openPanel && !this.textDraft
                && !this.renamingID && !this.fileSheet && !this.levelsEdit && !this.adjustmentEditingID && !this.working && !this.importing;
        },

        // begin(): a pending transform is committed and a pending gradient applied before the project is read.
        async settleForFile() {
            if (this.selectTools.floating) await this.selectTools.commitFloating();
            await this.resolvePending('save');
        },

        fileAlert(title, text) {
            return this.fileRequest('alert', { title, text });
        },

        // While a sheet is up the board is busy (Export As keeps isProjectBusy, file.md 18 quirk 9).
        holdBusy() {
            this.working++;
            if (this.working === 1) {
                clearTimeout(this.busyTimer);
                this.busyTimer = setTimeout(() => { this.busyShown = true; this.updateStatus(); }, 250);
            }
            this.updateStatus();
        },

        releaseBusy() {
            this.working = Math.max(0, this.working - 1);
            if (!this.working) { clearTimeout(this.busyTimer); this.busyShown = false; }
            this.updateStatus();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // File menu (CompositorApp.swift:49-99; file.md 14.2)

        fileMenuExtras() {
            const doc = () => Boolean(this.doc.manifest);
            const can = () => this.canStartFileOperation();
            const command = (name) => () => this.postMessage({ type: 'fileCommand', command: name });
            return [
                { label: 'New Canvas…', def: 'New Canvas', enabled: () => !this.importing && !this.levelsEdit, run: () => this.postMessage({ type: 'command', command: 'new' }) },
                { label: 'Open Project…', def: 'Open Project', enabled: can, run: command('open') },
                { label: 'Open Recent…', enabled: can, run: command('openRecent') },
                // Import Images… only waits for Levels, busy work and another import (not the full gate).
                { label: 'Import Images…', enabled: () => !this.levelsEdit && !this.busyShown && !this.importing && !this.fileSheet, run: command('importImages') },
                null,
                { label: 'Save', def: 'Save', enabled: () => doc() && can(), run: () => this.postMessage(this.place === 'sidebar' ? { type: 'saveNow' } : { type: 'command', command: 'save' }) },
                { label: 'Save As…', def: 'Save As', enabled: () => doc() && can(), run: () => this.settleForFile().then(command('saveAs')) },
                null,
                { label: 'Export JPEG…', def: 'Export JPEG', enabled: () => doc() && can(), run: () => this.openExportAs('JPEG') },
                { label: 'Export PNG…', def: 'Export PNG', enabled: () => doc() && can(), run: () => this.settleForFile().then(command('exportPNG')) },
                { label: 'Export As…', def: 'Export As', enabled: () => doc() && can(), run: () => this.openExportAs() },
                null,
                { label: 'Close Project', def: 'Close Project', enabled: () => !this.fileSheet, run: () => this.postMessage({ type: 'command', command: 'close' }) },
            ];
        },

        // ---------------------------------------------------------------------------------------------------------------
        // The welcome: the New canvas form above the recent projects (file.md 3.11). It stands in for the board's own
        // welcome card.

        showWelcome(recent) {
            this.hideWelcome();
            const el = document.createElement('div');
            el.className = `welcome${this.newCanvasTab ? ' new-canvas-tab' : ''}`;
            el.innerHTML = `<div class="welcome-card">
                    ${this.newCanvasTab ? '' : `<div class="welcome-title">${CB.icon('layers')}<span>Compositor Board</span></div>
                    <p>Draw here while Claude reads and draws on the same board. Projects are Compositor <code>.comp</code> folders.</p>`}
                    <div class="nc-host"></div>
                    ${recent.length ? `<div class="recent-title">Recent</div>${recent.map((r) => `<button class="recent" data-root="${escape(r.root)}" title="${escape(r.root)}"><span>${escape(r.name)}</span><small>${escape(r.folder)}</small></button>`).join('')}` : ''}
                </div>`;
            document.body.appendChild(el);
            el.querySelectorAll('.recent').forEach((b) => b.addEventListener('click', () => this.postMessage({ type: 'openRecent', root: b.dataset.root })));
            this.welcome = el;
            const skip = !this.newCanvasTab && sidebarWelcomes++ === 0;
            this.newCanvasForm(el.querySelector('.nc-host'), { suggestClipboard: !skip });
        },

        newCanvasForm(host, { suggestClipboard }) {
            const state = { width: '1920', height: '1080', unit: UNITS[0], resolution: 72, background: 'transparent' };
            const form = document.createElement('div');
            form.className = 'new-canvas';
            form.innerHTML = `
                <div class="nc-head"><div class="nc-title">New canvas</div>
                    <button class="nc-presets" title="Preset sizes for screens and common formats" aria-label="Preset sizes"><i></i><i></i><i></i></button></div>
                <div class="nc-dims">
                    <label class="nc-dim"><span class="nc-label">Width</span><span class="nc-field"><input class="nc-width" placeholder="Width" aria-label="Width" spellcheck="false"><span class="nc-unit"></span></span></label>
                    <span class="nc-times" aria-hidden="true">×</span>
                    <label class="nc-dim"><span class="nc-label">Height</span><span class="nc-field"><input class="nc-height" placeholder="Height" aria-label="Height" spellcheck="false"><span class="nc-unit"></span></span></label>
                </div>
                <div class="nc-pills"><button class="nc-pill nc-bg" title="Start see-through, or with a white or black Background layer. Click to switch."></button><span>·</span>
                    <button class="nc-pill nc-units" title="Units: pixels, inches, centimeters or millimeters. Click to switch."></button><span>·</span>
                    <button class="nc-pill nc-res"></button></div>
                <div class="nc-invalid"></div>
                <div class="nc-buttons"><button class="pill nc-open">Open project</button><button class="pill nc-import">Import image</button><span class="spacer"></span><button class="pill prominent nc-create">Create canvas</button></div>`;
            host.appendChild(form);
            const $ = (s) => form.querySelector(s);
            const widthField = $('.nc-width'), heightField = $('.nc-height');
            const px = () => [pixels(state.width, state.unit, state.resolution), pixels(state.height, state.unit, state.resolution)];
            const setPixels = (w, h) => {
                state.width = unitText(w, state.unit, state.resolution);
                state.height = unitText(h, state.unit, state.resolution);
                render();
            };
            // `typing`: the field being typed in keeps its own text (and caret); every other change writes both.
            const render = (typing = null) => {
                const [w, h] = px();
                const valid = w !== null && h !== null;
                if (typing !== widthField) widthField.value = state.width;
                if (typing !== heightField) heightField.value = state.height;
                form.querySelectorAll('.nc-unit').forEach((u) => { u.textContent = state.unit.id; });
                $('.nc-bg').textContent = `${state.background[0].toUpperCase()}${state.background.slice(1)} canvas`;
                $('.nc-units').textContent = state.unit.name;
                $('.nc-res').textContent = `${state.resolution} DPI`;
                $('.nc-res').title = `Resolution: 72 for screens, 300 for print. Click to switch.${state.unit.perInch && valid ? ` · ${state.resolution} DPI: ${w} × ${h} pixels` : ''}`;
                $('.nc-invalid').textContent = valid ? '' : state.unit.perInch ? `Enter a size up to ${groupedSide} pixels at this DPI.` : `Enter whole numbers from 1 to ${groupedSide} pixels.`;
                $('.nc-invalid').style.display = valid ? 'none' : '';
                $('.nc-create').disabled = !valid;
                // The whole form waits while an import or long operation runs.
                form.classList.toggle('disabled', Boolean(this.importing || this.busyShown));
            };
            this.newCanvasRender = () => render(document.activeElement);
            widthField.addEventListener('input', () => { state.width = widthField.value; render(widthField); });
            heightField.addEventListener('input', () => { state.height = heightField.value; render(heightField); });
            $('.nc-bg').addEventListener('click', () => { state.background = BACKGROUNDS[(BACKGROUNDS.indexOf(state.background) + 1) % 3]; render(); });
            // Switching units writes the same canvas in the new unit, when both sides are valid now.
            $('.nc-units').addEventListener('click', () => {
                const [w, h] = px();
                const next = UNITS[(UNITS.indexOf(state.unit) + 1) % UNITS.length];
                if (w !== null && h !== null) { state.width = unitText(w, next, state.resolution); state.height = unitText(h, next, state.resolution); }
                state.unit = next;
                render();
            });
            $('.nc-res').addEventListener('click', () => { state.resolution = state.resolution === 300 ? 72 : 300; render(); });
            $('.nc-presets').addEventListener('click', (e) => {
                const [w, h] = px();
                const items = [{ label: 'Custom', checked: !PRESETS.flat().some(([, pw, ph]) => pw === w && ph === h), run: () => {} }];
                for (const group of PRESETS) {
                    items.push(null);
                    for (const [title, pw, ph] of group) items.push({ label: title, checked: pw === w && ph === h, run: () => setPixels(pw, ph) });
                }
                const r = e.currentTarget.getBoundingClientRect();
                this.menu(r.right - 220, r.bottom + 4, items);
            });
            const create = () => {
                const [w, h] = px();
                if (w === null || h === null || form.classList.contains('disabled')) return;
                this.postMessage({ type: 'createCanvas', width: w, height: h, resolution: state.resolution, background: state.background });
            };
            $('.nc-create').addEventListener('click', create);
            $('.nc-open').addEventListener('click', () => this.postMessage({ type: 'pickProject' }));
            $('.nc-import').addEventListener('click', () => this.postMessage({ type: 'fileCommand', command: 'importImages' }));
            form.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'INPUT') e.stopPropagation();
                if (CB.Shortcuts && CB.Shortcuts.isApply(e)) { e.preventDefault(); create(); }
            });
            render();
            widthField.focus();
            // A copied image's size fills the fields once (NewCanvasSheet.clipboardDimensions).
            if (suggestClipboard) {
                this.fileEngine('clipboard.inspect').then((info) => {
                    if (info.imageSize && this.welcome && host.isConnected) setPixels(info.imageSize[0], info.imageSize[1]);
                }).catch(() => {});
            }
        },

        // ⌘V on the New canvas form with an image copied: a canvas the image's size with it in (file.md 3.10). A size
        // copied as text goes into a size field instead.
        welcomePaste(e) {
            if (!this.welcome || this.doc.manifest) return;
            const field = e.target && e.target.tagName === 'INPUT';
            const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
            const n = Number(String(text).trim());
            if (Number.isInteger(n) && n >= 1 && n <= MAX_SIDE && /^\s*\d+\s*$/.test(text)) return;
            e.preventDefault();
            this.fileRequest('fromClipboard').then((result) => {
                if (!result.none) return;
                if (field) document.execCommand('insertText', false, text);
                else CB.beep();
            }).catch((error) => this.fileAlert('Import couldn’t finish', error.message));
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Import (EditorSession.importImages; file.md 6.6): the RAW develop sheet for each RAW and the conversion report
        // for each PSD with something to report run first, then one import request, so the batch is one undo step.

        queueImport(paths, options) {
            this.importQueue = (this.importQueue || Promise.resolve()).then(() => this.importPaths(paths, options)).catch((error) => {
                console.error('[compositor-board] import failed', error);
            });
            return this.importQueue;
        },

        async importPaths(paths, { point = null, temp = [], extraErrors = [] } = {}) {
            if (!paths.length) return;
            if (this.doc.manifest) await this.settleForFile();
            this.importing = true;
            this.updateStatus();
            if (this.newCanvasRender) this.newCanvasRender();
            let usedRaw = false, cameraRaw = false;
            try {
                const plan = await this.fileOp('import.plan', { files: paths });
                const files = [], raw = {};
                for (const f of plan.entries) {
                    if (f.kind === 'raw') {
                        let shot = null;
                        // Too large or unreadable: no sheet; the import itself reports it in its place.
                        try { shot = await this.fileOp('raw.asShot', { file: f.path }); } catch { files.push(f.path); continue; }
                        usedRaw = true;
                        const chosen = await this.developSheet(f, shot);
                        if (!chosen) continue;
                        if (chosen.cameraRaw) cameraRaw = true;
                        raw[f.path] = chosen.settings;
                        files.push(f.path);
                    } else if (f.kind === 'psd') {
                        if (await this.conversionSheet(f)) files.push(f.path);
                    } else files.push(f.path);
                }
                const emptyMessage = plan.emptyMessage || null;
                let errors = null;
                if (!files.length && !emptyMessage) return;
                if (this.doc.manifest) {
                    const result = await this.engine('import.images', { files, raw, point, emptyMessage }, { label: 'Import Images' });
                    this.applyEngineState(result);
                    errors = result.errors;
                    if (cameraRaw && this.cameraRaw && result.activeLayerID) this.cameraRaw.open();
                } else {
                    const result = await this.fileRequest('fromImages', { files, raw, emptyMessage });
                    errors = result.errors;
                }
                const text = [errors, ...extraErrors].filter(Boolean).join('\n\n');
                if (text) await this.fileAlert('Import couldn’t finish', text);
            } catch (error) {
                await this.fileAlert('Import couldn’t finish', [error.message, ...extraErrors].join('\n\n'));
            } finally {
                this.closeRawSheet();
                if (usedRaw) this.fileOp('raw.release').catch(() => {});
                if (temp.length) this.fileRequest('cleanup', { temp }).catch(() => {});
                this.importing = false;
                this.updateStatus();
                if (this.newCanvasRender) this.newCanvasRender();
            }
        },

        // A modal sheet over the board (file.md 7.4, 8.5, 10.5): it takes the keyboard and the pointer until it closes.
        openSheet(className, html) {
            const backdrop = document.createElement('div');
            backdrop.className = 'file-sheet-backdrop';
            backdrop.innerHTML = `<div class="file-sheet ${className}" role="dialog" tabindex="-1">${html}</div>`;
            document.body.appendChild(backdrop);
            backdrop.addEventListener('pointerdown', (e) => e.stopPropagation());
            const sheet = backdrop.firstElementChild;
            sheet.focus();
            return { backdrop, sheet, close: () => backdrop.remove() };
        },

        // Develop “name” (RawDevelopSheet): sliders over the camera's own settings, a live 800 px preview, Import or
        // Camera Raw… (that filter, when the board has it) or Cancel. Answers { settings, cameraRaw } or null.
        developSheet(file, shot) {
            this.closeRawSheet();
            const s = { ...shot };
            const asShot = () => s.exposure === 0 && s.boost === 1 && s.temperature === s.asShotTemperature && s.tint === s.asShotTint
                && s.noiseReduction === s.asShotNoiseReduction && s.lensCorrection === s.asShotLensCorrection && s.highlightRecovery === s.asShotHighlightRecovery;
            const slider = (key, title, min, max, unit, precision, extra = '') => `<div class="raw-row"${extra}><span class="raw-label">${title}</span>
                <input type="range" min="${min}" max="${max}" step="${(max - min) / 1000}" data-raw="${key}"><span class="raw-value" data-raw-value="${key}" data-unit="${unit}" data-precision="${precision}"></span></div>`;
            const { backdrop, sheet, close } = this.openSheet('raw-sheet', `
                <div class="sheet-title">Develop “${escape(file.name)}”</div>
                <div class="raw-preview"><img alt=""><div class="raw-spinner spinner"></div><div class="raw-importing"><span class="spinner"></span>Importing…</div></div>
                ${slider('exposure', 'Exposure', -3, 3, ' EV', 2)}
                ${slider('temperature', 'Temperature', 2000, 12000, ' K', 0)}
                ${slider('tint', 'Tint', -150, 150, '', 0)}
                ${slider('boost', 'Boost', 0, 1, '', 2)}
                ${slider('noiseReduction', 'Noise Reduction', 0, 1, '', 2, ` title="${s.supportsNoiseReduction ? 'Smooths grain, at the cost of fine detail' : 'Not available for this camera'}"`)}
                <div class="raw-toggles">
                    <label class="check" title="${s.supportsLensCorrection ? 'Removes the lens\'s distortion and vignetting' : 'This file has no lens profile'}"><input type="checkbox" data-raw-toggle="lensCorrection"> Lens Correction</label>
                    <label class="check" title="${s.supportsHighlightRecovery ? 'Brings back detail in bright areas the camera partly clipped' : 'Not available for this camera'}"><input type="checkbox" data-raw-toggle="highlightRecovery"> Highlight Recovery</label>
                </div>
                <div class="buttons"><button class="pill raw-reset">Reset</button><span class="spacer"></span><button class="pill raw-cancel">Cancel</button>
                    ${this.cameraRaw ? '<button class="pill raw-camera" title="Import, then open the Camera Raw Filter">Camera Raw…</button>' : ''}<button class="pill prominent raw-import">Import</button></div>`);
            const img = sheet.querySelector('.raw-preview img');
            let url = null, inFlight = false, again = false, timer = null, first = true;
            const supports = { noiseReduction: s.supportsNoiseReduction, lensCorrection: s.supportsLensCorrection, highlightRecovery: s.supportsHighlightRecovery };
            const refresh = () => {
                sheet.querySelectorAll('[data-raw]').forEach((input) => {
                    input.value = s[input.dataset.raw];
                    input.disabled = input.dataset.raw === 'noiseReduction' && !supports.noiseReduction;
                });
                sheet.querySelectorAll('[data-raw-value]').forEach((v) => { v.textContent = `${Number(s[v.dataset.rawValue]).toFixed(Number(v.dataset.precision))}${v.dataset.unit}`; });
                sheet.querySelectorAll('[data-raw-toggle]').forEach((t) => { t.checked = Boolean(s[t.dataset.rawToggle]); t.disabled = !supports[t.dataset.rawToggle]; });
                sheet.querySelector('.raw-reset').disabled = asShot();
            };
            // The preview develops 60 ms after the last change, one at a time, the newest settings winning.
            const develop = async () => {
                if (inFlight) { again = true; return; }
                inFlight = true;
                sheet.classList.add('working');
                try {
                    const result = await this.fileOp('raw.preview', { file: file.path, settings: { ...s } }, { files: { out: 'png' } });
                    if (result.files && result.files.out && backdrop.isConnected) {
                        if (url) URL.revokeObjectURL(url);
                        url = URL.createObjectURL(new Blob([result.files.out], { type: 'image/png' }));
                        img.src = url;
                    }
                } catch { /* the preview stays as it was */ } finally {
                    inFlight = false;
                    sheet.classList.remove('working');
                    if (again) { again = false; develop(); }
                }
            };
            const changed = () => {
                refresh();
                clearTimeout(timer);
                timer = setTimeout(develop, first ? 0 : 60);
                first = false;
            };
            sheet.querySelectorAll('[data-raw]').forEach((input) => input.addEventListener('input', () => { s[input.dataset.raw] = Number(input.value); changed(); }));
            sheet.querySelectorAll('[data-raw-toggle]').forEach((t) => t.addEventListener('change', () => { s[t.dataset.rawToggle] = t.checked; changed(); }));
            sheet.querySelector('.raw-reset').addEventListener('click', () => {
                Object.assign(s, { exposure: 0, boost: 1, temperature: s.asShotTemperature, tint: s.asShotTint, noiseReduction: s.asShotNoiseReduction,
                    lensCorrection: s.asShotLensCorrection, highlightRecovery: s.asShotHighlightRecovery });
                changed();
            });
            changed();
            return new Promise((resolve) => {
                const finish = (value) => {
                    clearTimeout(timer);
                    if (!value) {
                        close();
                        if (url) URL.revokeObjectURL(url);
                    } else {
                        // Import pressed: the sheet stays, showing the full frame developing, until the layer is in.
                        sheet.classList.add('importing');
                        sheet.querySelectorAll('input, button').forEach((n) => { n.disabled = true; });
                        this.rawSheet = { close: () => { close(); if (url) URL.revokeObjectURL(url); } };
                    }
                    resolve(value);
                };
                const settings = () => ({ exposure: s.exposure, temperature: s.temperature, tint: s.tint, boost: s.boost, noiseReduction: s.noiseReduction,
                    lensCorrection: s.lensCorrection, highlightRecovery: s.highlightRecovery });
                sheet.querySelector('.raw-cancel').addEventListener('click', () => finish(null));
                sheet.querySelector('.raw-import').addEventListener('click', () => finish({ settings: settings(), cameraRaw: false }));
                const camera = sheet.querySelector('.raw-camera');
                if (camera) camera.addEventListener('click', () => finish({ settings: settings(), cameraRaw: true }));
                // Return and Escape are the sheet's default and cancel buttons (fixed, not the canvas assignments).
                sheet.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (sheet.classList.contains('importing')) return;
                    if (e.key === 'Escape') { e.preventDefault(); finish(null); }
                    else if (e.key === 'Enter') { e.preventDefault(); finish({ settings: settings(), cameraRaw: false }); }
                });
            });
        },

        closeRawSheet() {
            if (this.rawSheet) this.rawSheet.close();
            this.rawSheet = null;
        },

        // Open “name”? (PSDConversionSheet): up at once while the file is read; nothing to report closes it and the file
        // comes in; a read error closes it and the import reports the error. Answers whether to import the file.
        conversionSheet(file) {
            this.closeRawSheet();
            const { sheet, close } = this.openSheet('psd-sheet', `
                <div class="sheet-title">Open “${escape(file.name)}”?</div>
                <div class="secondary psd-subtitle">Reading the file to see what needs converting.</div>
                <div class="psd-list"><div class="psd-reading"><span class="spinner"></span><span class="secondary">Reading the Photoshop file…</span></div></div>
                <div class="buttons"><span class="spacer"></span><button class="pill psd-cancel">Cancel</button><button class="pill prominent psd-import" disabled>Import</button></div>`);
            return new Promise((resolve) => {
                let settled = false;
                const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    close();
                    resolve(value);
                };
                sheet.querySelector('.psd-cancel').addEventListener('click', () => finish(false));
                sheet.querySelector('.psd-import').addEventListener('click', () => finish(true));
                sheet.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
                    else if (e.key === 'Enter' && !sheet.querySelector('.psd-import').disabled) { e.preventDefault(); finish(true); }
                });
                // Cancelled while reading: the read still finishes, and its answer is dropped.
                this.fileOp('psd.inspect', { file: file.path }).then((report) => {
                    if (settled) return;
                    if (report.backgroundOnly || !report.conversions.length) { finish(true); return; }
                    sheet.querySelector('.psd-subtitle').textContent = 'Compositor will convert these Photoshop features. Nothing is applied until you continue.';
                    sheet.querySelector('.psd-list').innerHTML = report.conversions.map((c) => `<div class="psd-row"><div class="psd-layer">${escape(c.layerName)}</div><div>${escape(c.message)}</div></div>`).join('');
                    sheet.querySelector('.psd-import').disabled = false;
                    sheet.focus();
                }, () => finish(true));
            });
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Export As (UI/ExportAsSheet.swift; file.md 10)

        async openExportAs(start) {
            if (!this.doc.manifest || this.fileSheet || !this.canStartFileOperation()) return;
            await this.settleForFile();
            const context = await this.fileRequest('exportContext');
            // session.proofProfile ?? CMYK.chosen: View › CMYK's profile, else the person's chosen one.
            const profile = (this.proofProfile && this.proofProfile.name) || (this.prefs && this.prefs.cmykProfile) || context.cmykProfile;
            let begin;
            this.holdBusy();
            try {
                begin = await this.engine('export.begin', { cmykProfile: profile, profileFolders: context.profileFolders }, {});
            } catch (error) {
                this.releaseBusy();
                await this.fileAlert('Couldn’t export', error.message);
                return;
            }
            const raster = { width: begin.width, height: begin.height, resolution: begin.resolution > 0 ? begin.resolution : 72 };
            let format = start || this.lastExportFormat || 'PNG';
            if (format === 'EXR' && !begin.hasHDR) format = 'PNG';
            const st = {
                format, quality: context.jpegQuality, matte: [1, 1, 1], width: raster.width, height: raster.height,
                sixteenBit: false, cmyk: false, profile: begin.profile, zoom: null,
            };
            let result = null, error = null, timer = null, inFlight = false, again = false, previewURL = null;
            const { sheet, close } = this.openSheet('export-sheet', `
                <div class="ea-head"><div class="sheet-title">Export As</div><span class="spacer"></span>
                    <button class="pill ea-fit" title="Show the whole image (⌘0)">Fit</button>
                    <button class="icon-button ea-in">${CB.icon('zoomIn')}</button><button class="icon-button ea-out">${CB.icon('zoomOut')}</button></div>
                <div class="ea-preview" title="Drag or scroll to move around; double-click switches between Fit and 100%">
                    <div class="ea-scroll"><div class="ea-stage"><div class="ea-image"><img alt=""></div></div></div>
                    <div class="ea-spinner"><span class="spinner"></span></div></div>
                <div class="ea-grid">
                    <span>Format</span><span class="group"><span class="segmented ea-formats"><button data-format="JPEG">JPEG</button><button data-format="PNG">PNG</button></span><button class="pill ea-more"></button></span>
                    <span>Size</span><span class="group"><input class="num ea-w" title="Width in pixels; the height follows, keeping the proportions"><span class="secondary">×</span><input class="num ea-h" title="Height in pixels; the width follows, keeping the proportions"><span class="secondary">px</span><button class="pill ea-scale" title="Scale the export: the document stays as it is"></button></span>
                    <span class="ea-q">Quality</span><span class="group ea-q"><input type="range" min="0" max="100" class="ea-quality"><span class="ea-quality-text"></span></span>
                    <span class="ea-depth">Depth</span><span class="ea-depth"><label class="check" title="Keep the 16-bit layers' full precision, in a file about twice the size"><input type="checkbox" class="ea-16"> 16 bits per channel</label></span>
                    <span class="ea-color">Color</span><span class="group ea-color"><button class="pill ea-cmyk" title="CMYK writes a printer's inks through the profile in View › CMYK › Profile"></button><button class="pill ea-load" title="Use a CMYK ICC profile, such as the one your printer gave you">Load Profile…</button></span>
                    <span class="ea-page">Page</span><span class="secondary ea-page ea-page-text"></span>
                    <span class="ea-bg">Background</span><span class="ea-bg"><span class="dialog-swatch ea-matte" role="button" title="Color that fills transparent areas" aria-label="Export Background"></span></span>
                </div>
                <div class="ea-foot"><span class="secondary ea-status"></span><span class="spacer"></span><span class="ea-size"></span>
                    <button class="pill ea-cancel">Cancel</button><button class="pill prominent ea-export">Export…</button></div>`);
            this.fileSheet = sheet;
            const $ = (q) => sheet.querySelector(q);
            const img = $('.ea-image img'), scroller = $('.ea-scroll'), stage = $('.ea-stage'), frame = $('.ea-preview');
            const takesCMYK = () => st.format === 'JPEG' || st.format === 'TIFF' || st.format === 'PDF';
            const key = () => JSON.stringify([st.format, st.quality, st.matte, st.width, st.height, st.sixteenBit && st.format === 'PNG' && begin.hasDeep, st.cmyk && takesCMYK(), st.profile]);
            const ready = () => Boolean(result && result.key === key() && !error);
            // JPEGPreview: zoom 1 is one export pixel per device pixel; Fit shows the whole image.
            const dpr = () => window.devicePixelRatio || 1;
            const fitZoom = () => Math.min(560 / (st.width / dpr()), 330 / (st.height / dpr()));
            const shownZoom = () => (st.zoom === null ? fitZoom() : st.zoom);
            const STEPS = [0.25, 0.5, 1, 2, 4, 8];
            const step = (zoom, direction) => (direction > 0 ? STEPS.find((z) => z > zoom * 1.001) : [...STEPS].reverse().find((z) => z < zoom * 0.999));
            const layoutPreview = (old) => {
                const zoom = shownZoom();
                const w = (st.width / dpr()) * zoom, h = (st.height / dpr()) * zoom;
                const box = $('.ea-image');
                box.style.width = `${w}px`;
                box.style.height = `${h}px`;
                stage.style.width = `${Math.max(560, w)}px`;
                stage.style.height = `${Math.max(330, h)}px`;
                img.style.imageRendering = st.zoom !== null && st.zoom >= 1 ? 'pixelated' : 'auto';
                scroller.classList.toggle('zoomed', st.zoom !== null);
                // Zooming keeps the middle of the view on the same part of the image; from Fit it starts centred.
                let fx = 0.5, fy = 0.5;
                if (old !== undefined && old !== null) {
                    const bw = (st.width / dpr()) * old, bh = (st.height / dpr()) * old;
                    fx = bw > 0 ? (scroller.scrollLeft + Math.min(560, bw) / 2) / bw : 0.5;
                    fy = bh > 0 ? (scroller.scrollTop + Math.min(330, bh) / 2) / bh : 0.5;
                }
                scroller.scrollLeft = Math.min(Math.max(0, fx * w - 280), Math.max(0, w - 560));
                scroller.scrollTop = Math.min(Math.max(0, fy * h - 165), Math.max(0, h - 330));
                const percent = `${Math.round(zoom * 100)}%`;
                $('.ea-fit').disabled = st.zoom === null;
                $('.ea-in').disabled = step(zoom, 1) === undefined;
                $('.ea-out').disabled = step(zoom, -1) === undefined;
                $('.ea-in').title = `Zoom in (⌘+), now ${percent}. At 100% each pixel of the export is one pixel of the screen`;
                $('.ea-out').title = `Zoom out (⌘−), now ${percent}`;
            };
            const setZoom = (zoom) => {
                const old = st.zoom === null ? null : shownZoom();
                st.zoom = zoom;
                layoutPreview(old);
            };
            const zoomBy = (direction) => { const next = step(shownZoom(), direction); if (next !== undefined) setZoom(next); };
            this.previewZoom = (command) => {
                if (command === 'zoomIn') zoomBy(1);
                else if (command === 'zoomOut') zoomBy(-1);
                else if (command === 'fit') setZoom(null);
                else if (command === 'actual') setZoom(1);
            };
            // Both sides follow one, keeping the proportions, within 30,000 px a side and 200 megapixels.
            const setScale = (scale) => {
                const largest = Math.min(MAX_SIDE / Math.max(raster.width, raster.height), Math.sqrt(200000000 / (raster.width * raster.height)));
                const clamped = Math.min(largest, Math.max(0.01, Number.isFinite(scale) ? scale : 1));
                st.width = Math.max(1, Math.round(raster.width * clamped));
                st.height = Math.max(1, Math.round(raster.height * clamped));
            };
            const render = () => {
                sheet.querySelectorAll('[data-format]').forEach((b) => b.classList.toggle('on', b.dataset.format === st.format));
                const others = ['TIFF', 'PDF', ...(begin.hasHDR ? ['EXR'] : [])];
                const more = $('.ea-more');
                more.textContent = others.includes(st.format) ? st.format : 'More';
                more.classList.toggle('prominent', others.includes(st.format));
                more.title = `Other formats: TIFF and PDF${begin.hasHDR ? ', and EXR to keep light brighter than white' : ''}`;
                for (const [field, value] of [['.ea-w', st.width], ['.ea-h', st.height]]) if (document.activeElement !== $(field)) $(field).value = value;
                $('.ea-scale').textContent = `${Math.round((st.width / raster.width) * 100)}%`;
                const show = (cls, on) => sheet.querySelectorAll(`.${cls}`).forEach((n) => { n.style.display = on ? '' : 'none'; });
                show('ea-q', st.format === 'JPEG');
                $('.ea-quality').value = Math.round(st.quality * 100);
                $('.ea-quality-text').textContent = `${Math.round(st.quality * 100)}%`;
                show('ea-depth', st.format === 'PNG' && begin.hasDeep);
                $('.ea-16').checked = st.sixteenBit;
                show('ea-color', takesCMYK());
                $('.ea-cmyk').textContent = st.cmyk ? 'CMYK' : 'RGB';
                $('.ea-load').style.display = st.cmyk && takesCMYK() ? '' : 'none';
                show('ea-page', st.format === 'PDF');
                const inches = (n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n / raster.resolution);
                $('.ea-page-text').textContent = `${inches(st.width)} × ${inches(st.height)} in at ${Math.round(raster.resolution)} DPI`;
                show('ea-bg', st.format === 'JPEG' || st.format === 'PDF' || (st.format === 'TIFF' && st.cmyk));
                $('.ea-matte').style.background = `#${CB.Color.hex(st.matte)}`;
                $('.ea-status').textContent = st.format === 'EXR' ? 'Brighter than white kept · Transparency kept'
                    : takesCMYK() && st.cmyk ? `CMYK – ${st.profile || 'No profile'}`
                        : st.format === 'PNG' || st.format === 'TIFF' ? 'Transparency kept · sRGB' : 'sRGB';
                const size = $('.ea-size');
                if (error) { size.textContent = error; size.className = 'ea-size error'; }
                else if (ready()) { size.textContent = byteCount(result.bytes); size.className = 'ea-size'; }
                else { size.textContent = 'Updating…'; size.className = 'ea-size secondary'; }
                $('.ea-export').disabled = !ready();
                frame.classList.toggle('updating', !ready() && !error);
                layoutPreview(st.zoom);
            };
            // A new preview 200 ms after the last change; one request at a time, the newest settings winning.
            const preview = async () => {
                if (inFlight) { again = true; return; }
                inFlight = true;
                const asked = key();
                try {
                    const r = await this.engine('export.preview', {
                        token: begin.token, format: st.format, quality: st.quality, matte: st.matte, width: st.width, height: st.height,
                        sixteenBit: st.sixteenBit, cmyk: st.cmyk, cmykProfile: st.profile, profileFolders: context.profileFolders,
                    }, { stateless: true, files: { out: 'bin' } });
                    if (!sheet.isConnected || asked !== key()) return;
                    if (previewURL) URL.revokeObjectURL(previewURL);
                    previewURL = URL.createObjectURL(new Blob([r.files.out], { type: r.previewType === 'jpeg' ? 'image/jpeg' : 'image/png' }));
                    img.src = previewURL;
                    result = { key: asked, bytes: r.bytes };
                    error = null;
                } catch (e) {
                    if (asked === key()) error = e.message;
                } finally {
                    inFlight = false;
                    if (sheet.isConnected) render();
                    if (again) { again = false; preview(); }
                }
            };
            const changed = () => {
                error = null;
                render();
                clearTimeout(timer);
                timer = setTimeout(preview, 200);
            };
            sheet.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => { st.format = b.dataset.format; changed(); }));
            $('.ea-more').addEventListener('click', (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const others = ['TIFF', 'PDF', ...(begin.hasHDR ? ['EXR'] : [])];
                this.menu(r.left, r.bottom + 4, others.map((f) => ({ label: f, checked: st.format === f, run: () => { st.format = f; changed(); } })));
            });
            for (const [field, side] of [['.ea-w', 'width'], ['.ea-h', 'height']]) {
                const input = $(field);
                input.addEventListener('change', () => {
                    const v = Number(input.value);
                    if (Number.isFinite(v)) setScale(v / raster[side]);
                    input.value = st[side];
                    changed();
                });
            }
            $('.ea-scale').addEventListener('click', (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                this.menu(r.left, r.bottom + 4, [25, 50, 75, 100, 200].map((p) => ({ label: `${p}%`, run: () => { setScale(p / 100); changed(); } })));
            });
            $('.ea-quality').addEventListener('input', (e) => { st.quality = Number(e.target.value) / 100; changed(); });
            $('.ea-16').addEventListener('change', (e) => { st.sixteenBit = e.target.checked; changed(); });
            $('.ea-cmyk').addEventListener('click', (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                this.menu(r.left, r.bottom + 4, [
                    { label: 'RGB', checked: !st.cmyk, run: () => { st.cmyk = false; changed(); } },
                    { label: 'CMYK', checked: st.cmyk, run: () => { st.cmyk = true; changed(); } },
                ]);
            });
            $('.ea-load').addEventListener('click', async () => {
                const loaded = await this.fileRequest('loadProfile');
                if (loaded.error) { error = loaded.error; render(); return; }
                if (loaded.name) {
                    st.profile = loaded.name;
                    if (this.prefs) this.prefs.cmykProfile = loaded.name;
                    changed();
                }
            });
            $('.ea-matte').addEventListener('click', () => {
                this.picker.open({ title: 'Color Picker (Export Background)', color: st.matte, dialog: true, onCommit: (rgb) => { st.matte = rgb; changed(); } });
                if (this.picker.element) this.picker.element.style.zIndex = '90';
            });
            $('.ea-fit').addEventListener('click', () => setZoom(null));
            $('.ea-in').addEventListener('click', () => zoomBy(1));
            $('.ea-out').addEventListener('click', () => zoomBy(-1));
            frame.addEventListener('dblclick', () => setZoom(st.zoom === null ? 1 : null));
            // Zoomed in, a drag moves the picture around.
            scroller.addEventListener('pointerdown', (e) => {
                if (st.zoom === null) return;
                scroller.setPointerCapture(e.pointerId);
                const start = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
                scroller.classList.add('dragging');
                scroller.onpointermove = (m) => { scroller.scrollLeft = start.left - (m.clientX - start.x); scroller.scrollTop = start.top - (m.clientY - start.y); };
                scroller.onpointerup = () => { scroller.onpointermove = scroller.onpointerup = null; scroller.classList.remove('dragging'); };
            });
            const finish = async (exporting) => {
                clearTimeout(timer);
                if (this.picker.isOpen) this.picker.close(true);
                close();
                this.fileSheet = null;
                this.previewZoom = null;
                if (previewURL) URL.revokeObjectURL(previewURL);
                try {
                    if (exporting) {
                        if (st.format === 'JPEG') this.postMessage({ type: 'preferences', preferences: { jpegExportQuality: st.quality } });
                        this.lastExportFormat = st.format;
                        await this.fileRequest('exportSave', { token: begin.token, format: st.format });
                    }
                } finally {
                    this.engine('export.end', { token: begin.token }, { stateless: true }).catch(() => {});
                    this.releaseBusy();
                    this.focusCanvas();
                }
            };
            $('.ea-cancel').addEventListener('click', () => finish(false));
            $('.ea-export').addEventListener('click', () => { if (ready()) finish(true); });
            sheet.addEventListener('keydown', (e) => {
                e.stopPropagation();
                const S = CB.Shortcuts;
                const field = e.target.tagName === 'INPUT' && e.target.classList.contains('num');
                if (S.isCancel(e)) { e.preventDefault(); finish(false); return; }
                if (S.isApply(e)) {
                    e.preventDefault();
                    if (field) e.target.dispatchEvent(new Event('change'));
                    else if (ready()) finish(true);
                    return;
                }
                // ⌘0, ⌘1, ⌘= and ⌘- act on the preview while the sheet is up (session.previewZoom).
                if (e.metaKey && !e.ctrlKey && !e.altKey) {
                    const zoom = { Digit0: 'fit', Digit1: 'actual', Equal: 'zoomIn', NumpadAdd: 'zoomIn', Minus: 'zoomOut', NumpadSubtract: 'zoomOut' }[e.code];
                    if (zoom) { e.preventDefault(); this.previewZoom(zoom); }
                }
            });
            render();
            preview();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Drops onto the canvas (ContentView.onDrop; file.md 14.5)

        dropAccepts(e) {
            const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
            return types.includes('Files') || types.includes('text/uri-list') || types.includes('application/vnd.code.uri-list');
        },

        dropHighlight(on) {
            const host = this.doc.manifest ? this.stageEl : this.welcome;
            if (this.dropEl && (!on || this.dropEl.parentNode !== host)) { this.dropEl.remove(); this.dropEl = null; }
            if (on && host && !this.dropEl) {
                this.dropEl = document.createElement('div');
                this.dropEl.className = 'drop-highlight';
                host.appendChild(this.dropEl);
            }
        },

        dragEvent(e) {
            if (!this.dropAccepts(e)) return;
            e.preventDefault();
            const allowed = this.canStartFileOperation();
            if (e.type === 'dragenter') this.dragDepth = (this.dragDepth || 0) + 1;
            if (e.type === 'dragleave') this.dragDepth = Math.max(0, (this.dragDepth || 0) - 1);
            if (e.dataTransfer) e.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
            this.dropHighlight(allowed && e.type !== 'dragleave' ? true : this.dragDepth > 0 && allowed);
        },

        async dropEvent(e) {
            if (!this.dropAccepts(e)) return;
            e.preventDefault();
            this.dragDepth = 0;
            this.dropHighlight(false);
            if (!this.canStartFileOperation()) return;
            // Over the canvas of an open project the images centre on the drop point; otherwise they centre on the canvas.
            let point = null;
            if (this.doc.manifest) {
                const r = this.stageEl.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) {
                    const p = this.view.toDoc({ x: e.clientX - r.left, y: e.clientY - r.top });
                    point = [p.x, p.y];
                }
            }
            // Everything is taken from the event now: its items are gone after the handler returns.
            const items = [...e.dataTransfer.items];
            const entries = items.filter((i) => i.kind === 'file').map((i) => ({ file: i.getAsFile(), entry: i.webkitGetAsEntry ? i.webkitGetAsEntry() : null }));
            const uriText = e.dataTransfer.getData('text/uri-list') || '';
            let codeUris = [];
            try { codeUris = JSON.parse(e.dataTransfer.getData('application/vnd.code.uri-list') || '[]'); } catch { codeUris = []; }
            const uris = [...new Set([...uriText.split(/\r?\n/).filter((u) => u && !u.startsWith('#')), ...codeUris])];
            const fileUris = uris.filter((u) => u.startsWith('file:'));
            const unreadable = uris.some((u) => !u.startsWith('file:')) || (!entries.length && !fileUris.length);
            this.importing = true;
            this.updateStatus();
            try {
                const files = [], folders = [], packages = [];
                const bytes = async (file) => new Uint8Array(await file.arrayBuffer());
                const childFiles = (dir) => new Promise((resolve) => {
                    const reader = dir.createReader(), all = [];
                    const next = () => reader.readEntries((batch) => {
                        if (!batch.length) { resolve(all); return; }
                        all.push(...batch);
                        next();
                    }, () => resolve(all));
                    next();
                });
                const fileOf = (entry) => new Promise((resolve) => entry.file(resolve, () => resolve(null)));
                // Explorer drags carry paths; their file items are not read again.
                if (!fileUris.length) {
                    for (const { file, entry } of entries) {
                        if (entry && entry.isDirectory) {
                            if (/\.comp$/i.test(entry.name)) { packages.push(entry.name); continue; }
                            const children = (await childFiles(entry)).filter((c) => c.isFile && !c.name.startsWith('.'));
                            const list = [];
                            for (const child of children) {
                                const f = await fileOf(child);
                                if (f) list.push({ name: child.name, bytes: await bytes(f) });
                            }
                            folders.push({ name: entry.name, files: list });
                        } else if (file) files.push({ name: file.name, bytes: await bytes(file) });
                    }
                }
                this.postMessage({ type: 'importDrop', files, folders, uris: fileUris, point, unreadable, packages });
            } finally {
                this.importing = false;
                this.updateStatus();
            }
        },
    };

    // The board's message stream: file messages reach the mixin (the board's own receive handles the rest).
    window.addEventListener('message', (e) => { if (window.board && window.board.fileMessage) window.board.fileMessage(e.data || {}); });
    for (const kind of ['dragenter', 'dragover', 'dragleave']) {
        document.addEventListener(kind, (e) => { if (window.board && window.board.dragEvent) window.board.dragEvent(e); });
    }
    document.addEventListener('drop', (e) => { if (window.board && window.board.dropEvent) window.board.dropEvent(e); });
    document.addEventListener('paste', (e) => { if (window.board && window.board.welcomePaste) window.board.welcomePaste(e); });

    CB.FileUI = FileUI;
    CB.FileFormats = { pixels, unitText, parseNumber, byteCount, UNITS, PRESETS };
})();
