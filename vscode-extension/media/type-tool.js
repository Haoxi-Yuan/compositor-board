'use strict';
// The Type tool and live text (upstream Document/TypeTool.swift, Rendering/InlineTextEditor.swift,
// UI/TypeControls.swift; specification docs/port-specs/text.md). The board owns the draft and every interaction;
// compositor-engine is the only thing that measures or draws glyphs: text.layout (on the extension's text lane)
// answers TextKit's own lines, carets and raster for a style, and text.commit runs EditorSession.applyText on the
// project. A hidden textarea is the keyboard, IME and clipboard surface; the overlay draws the caret, the selection,
// the frame and its handles from the engine's geometry.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Affine, Transform } = CB;

    const PADDING = 12;
    const ROW = 22;
    // LayerTextStyle() (Document/TypeTool.swift:7-34).
    const DEFAULTS = { content: 'Text', fontName: 'Helvetica', fontSize: 72, red: 0, green: 0, blue: 0, alignment: 'Left', tracking: 0, leading: 0 };
    const HINT = 'Drag a text box · Click text to edit · Drag box handles to resize · ⌘Return finish · Escape cancel';
    const PAINT = 'Couldn’t paint';
    // LayerTransform.handles: TL, T, TR, R, BR, B, BL, L.
    const HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

    Object.assign(CB.iconPaths, {
        alignLeft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
        alignCenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
        alignRight: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
    });

    // ---------------------------------------------------------------------------------------------------------------
    // The style (text.md 7.2, 7.3; Document/TypeTool.swift:25-187). JS strings index UTF-16 code units, the units of
    // NSRange.

    const NEWLINE = /[\n\v\f\r\u0085\u2028\u2029]/;
    function boxIsValid(s) {
        if (!s.boxSize) return true;
        const [w, h] = s.boxSize;
        return Number.isFinite(w) && Number.isFinite(h) && w >= 16 && w <= 30000 && h >= 16 && h <= 30000 && w * h <= 200000000;
    }
    function runsValid(runs, n, extra) {
        if (!runs) return true;
        let end = 0;
        for (const r of runs) {
            if (!(r.location >= end && r.length > 0 && extra(r))) return false;
            end = r.location + r.length;
        }
        return runs.length > 0 && end <= n;
    }
    const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
    function isValid(s) {
        const n = s.content.length;
        return n <= 100000 && boxIsValid(s)
            && Number.isFinite(s.fontSize) && s.fontSize >= 1 && s.fontSize <= 2000
            && [s.red, s.green, s.blue].every(unit)
            && Number.isFinite(s.tracking) && s.tracking >= -100 && s.tracking <= 1000
            && Number.isFinite(s.leading) && s.leading >= 0 && s.leading <= 5000
            && runsValid(s.colorRuns, n, (r) => [r.red, r.green, r.blue].every(unit))
            // Swift counts Characters; PostScript names are ASCII, so the length is the same there.
            && runsValid(s.fontRuns, n, (r) => r.fontName && r.fontName.length <= 200 && !NEWLINE.test(r.fontName));
    }
    const lineHeight = (s) => (s.leading > 0 ? s.leading : s.fontSize * 1.2);
    const clampRange = (s, loc, len) => {
        const n = s.content.length, a = Math.max(0, Math.min(loc, n)), b = Math.max(a, Math.min(loc + len, n));
        return [a, b];
    };
    const sameColor = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    function unitColors(s) {
        const base = [s.red, s.green, s.blue], colors = Array(s.content.length).fill(base);
        for (const r of s.colorRuns || []) for (let i = Math.max(0, r.location); i < Math.min(colors.length, r.location + r.length); i++) colors[i] = [r.red, r.green, r.blue];
        return colors;
    }
    function setUnitColors(s, colors) {
        const base = [s.red, s.green, s.blue], runs = [];
        colors.forEach((c, i) => {
            if (sameColor(c, base)) return;
            const last = runs[runs.length - 1];
            if (last && last.location + last.length === i && sameColor([last.red, last.green, last.blue], c)) last.length += 1;
            else runs.push({ location: i, length: 1, red: c[0], green: c[1], blue: c[2] });
        });
        s.colorRuns = runs.length ? runs : undefined;
    }
    function colorAt(s, i) {
        const r = (s.colorRuns || []).find((q) => q.location <= i && i < q.location + q.length);
        return r ? [r.red, r.green, r.blue] : [s.red, s.green, s.blue];
    }
    // An empty range, or one covering the whole text, recolors all of it.
    function setColor(s, color, loc, len) {
        const [a, b] = clampRange(s, loc, len), n = s.content.length;
        if (a === b || (a === 0 && b === n)) { [s.red, s.green, s.blue] = color; s.colorRuns = undefined; return; }
        const colors = unitColors(s);
        for (let i = a; i < b; i++) colors[i] = color;
        setUnitColors(s, colors);
    }
    function unitFonts(s) {
        const fonts = Array(s.content.length).fill(s.fontName);
        for (const r of s.fontRuns || []) for (let i = Math.max(0, r.location); i < Math.min(fonts.length, r.location + r.length); i++) fonts[i] = r.fontName;
        return fonts;
    }
    function setUnitFonts(s, fonts) {
        if (fonts.length && fonts.every((f) => f === fonts[0])) { s.fontName = fonts[0]; s.fontRuns = undefined; return; }
        const runs = [];
        fonts.forEach((f, i) => {
            if (f === s.fontName) return;
            const last = runs[runs.length - 1];
            if (last && last.location + last.length === i && last.fontName === f) last.length += 1;
            else runs.push({ location: i, length: 1, fontName: f });
        });
        s.fontRuns = runs.length ? runs : undefined;
    }
    const fontAt = (s, i) => ((s.fontRuns || []).find((r) => r.location <= i && i < r.location + r.length) || { fontName: s.fontName }).fontName;
    // The single face of every letter in the range, else null.
    function uniformFontName(s, loc, len) {
        const [a, b] = clampRange(s, loc, len);
        if (b <= a) return null;
        const face = fontAt(s, a);
        for (let i = a; i < b; i++) if (fontAt(s, i) !== face) return null;
        return face;
    }
    function setFont(s, name, loc, len) {
        if (!name || name.length > 200 || NEWLINE.test(name)) return;
        const [a, b] = clampRange(s, loc, len), n = s.content.length;
        if (a === b || (a === 0 && b === n)) { s.fontName = name; s.fontRuns = undefined; return; }
        const fonts = unitFonts(s);
        for (let i = a; i < b; i++) fonts[i] = name;
        setUnitFonts(s, fonts);
    }
    // Called before the content changes: `loc,len` is replaced by `newLength` units that take after the letter before
    // (or the first replaced letter, or the first letter, when there is none before).
    function replaceCharacters(s, loc, len, newLength) {
        const [a, b] = clampRange(s, loc, len);
        if (s.colorRuns) {
            const colors = unitColors(s);
            const inherited = a > 0 ? colors[a - 1] : b > a ? colors[a] : colors[0] || [s.red, s.green, s.blue];
            colors.splice(a, b - a, ...Array(Math.max(0, newLength)).fill(inherited));
            setUnitColors(s, colors);
        }
        if (s.fontRuns) {
            const fonts = unitFonts(s);
            const inherited = a > 0 ? fonts[a - 1] : b > a ? fonts[a] : fonts[0] || s.fontName;
            fonts.splice(a, b - a, ...Array(Math.max(0, newLength)).fill(inherited));
            setUnitFonts(s, fonts);
        }
    }
    // EditorSession.layerName(for:) (Document/TypeTool.swift:396-401).
    function layerName(content) {
        const flattened = content.split(/\s+/u).filter(Boolean).join(' ');
        return flattened ? Array.from(new Intl.Segmenter().segment(flattened), (g) => g.segment).slice(0, 40).join('') : 'Text';
    }
    // The style as the manifest stores it: absent optionals left out, arrays copied.
    function clean(s) {
        const out = {
            content: s.content, fontName: s.fontName, fontSize: s.fontSize, red: s.red, green: s.green, blue: s.blue,
            alignment: s.alignment, tracking: s.tracking, leading: s.leading,
        };
        if (s.boxSize) out.boxSize = [s.boxSize[0], s.boxSize[1]];
        if (s.colorRuns) out.colorRuns = s.colorRuns.map((r) => ({ ...r }));
        if (s.fontRuns) out.fontRuns = s.fontRuns.map((r) => ({ ...r }));
        return out;
    }
    const styleKey = (s) => JSON.stringify(clean(s));

    // ---------------------------------------------------------------------------------------------------------------
    // Geometry from a text.layout answer (text.md 4.3). Coordinates are image pixels (the container plus 12).

    // The lines, with the extra fragment after a trailing newline (or of empty text) as one more line that holds only
    // the end of the text.
    function linesOf(layout, length) {
        const lines = layout.lines.map((l) => ({ ...l, start: l.range[0], end: l.range[0] + l.range[1] }));
        if (layout.extra) {
            const [x, y, , h] = layout.extra.rect;
            lines.push({ start: length, end: length, rect: layout.extra.rect, carets: [[length, x]], hardBreak: false, extra: true, baseline: y + h });
        }
        return lines;
    }
    function caretX(line, index) {
        const c = line.carets.find((q) => q[0] === index);
        return c ? c[1] : null;
    }
    // The line a caret at `index` sits on: a soft-wrap boundary is the end of the upper line with the upstream
    // affinity, the start of the lower one otherwise; after a hard break it is the next line.
    function lineFor(lines, index, affinity) {
        const holding = lines.filter((l) => caretX(l, index) !== null && !(l.hardBreak && index === l.end));
        if (!holding.length) return lines.length ? lines[lines.length - 1] : null;
        return affinity === 'up' ? holding[0] : holding[holding.length - 1];
    }
    // characterIndexForInsertion: the nearest insertion point on the line under y; above the first line or below the
    // last laid-out one, the end of the laid-out text.
    function hitIndex(layout, lines, x, y) {
        if (!lines.length) return 0;
        const first = lines[0];
        if (y < first.rect[1]) return layout.laidOut;
        const line = lines.find((l) => y >= l.rect[1] && y < l.rect[1] + l.rect[3]);
        if (!line) return layout.laidOut;
        return nearestOnLine(line, x);
    }
    function nearestOnLine(line, x) {
        const carets = line.hardBreak ? line.carets.filter((c) => c[0] < line.end) : line.carets;
        const list = carets.length ? carets : line.carets;
        let best = list[0];
        for (const c of list) if (Math.abs(c[1] - x) < Math.abs(best[1] - x)) best = c;
        return best[0];
    }
    // One rectangle per line fragment the range touches (rectArray(forCharacterRange:)).
    function selectionRects(lines, a, b) {
        const out = [];
        for (const l of lines) {
            if (l.extra || !(a < l.end && b > l.start)) continue;
            const [x, y, w, h] = l.rect;
            const left = a >= l.start && caretX(l, a) !== null ? caretX(l, a) : x;
            const right = b > l.start && caretX(l, b) !== null && !(l.hardBreak && b === l.end) ? caretX(l, b) : x + w;
            out.push([left, y, Math.max(0, right - left), h]);
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Text Editing shortcuts (UI/KeyboardShortcuts.swift:135-139, 236-245): a remapped chord stands for its default;
    // a default that was moved to another chord does nothing here.

    const KEY_NAMES = { '\r': 'Enter', '\u{f702}': 'ArrowLeft', '\u{f703}': 'ArrowRight', '\u{f700}': 'ArrowUp', '\u{f701}': 'ArrowDown', '\u{1b}': 'Escape' };
    function textKey(e) {
        const own = { key: e.key, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey };
        const S = CB.Shortcuts;
        if (!S || !S.textChord || !S.chordFromEvent) return own;
        const input = S.chordFromEvent(e);
        if (!input || !input.key) return own;
        const chord = S.textChord(input);
        if (chord === null) return null;
        if (!chord || S.same(chord, input)) return own;
        const m = chord.modifiers || 0;
        return { key: KEY_NAMES[chord.key] || chord.key, meta: Boolean(m & 1), alt: Boolean(m & 2), ctrl: Boolean(m & 4), shift: Boolean(m & 8) };
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The text lane: text.layout and text.fonts on the extension's second engine process.

    class TextLane {
        constructor(board) {
            this.board = board;
            this.calls = new Map();
            this.next = 1;
            window.addEventListener('message', (e) => {
                const m = e.data;
                if (!m || m.type !== 'textEngineResult') return;
                const call = this.calls.get(m.id);
                if (!call) return;
                this.calls.delete(m.id);
                if (m.ok) call.resolve(m.result);
                else call.reject(new Error(m.error));
            });
        }

        request(op, args) {
            const id = this.next++;
            return new Promise((resolve, reject) => {
                this.calls.set(id, { resolve, reject });
                this.board.post({ type: 'textEngine', id, op, args });
            });
        }
    }

    const bytes = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    // ---------------------------------------------------------------------------------------------------------------

    class TypeTool {
        constructor(board) {
            this.board = board;
            this.view = board.view;
            this.lane = new TextLane(board);
            // textDefaults: per open project, the last committed style without its runs (TypeTool.swift:446-448).
            this.defaults = { ...DEFAULTS };
            this.draft = null;
            this.gesture = null;
            this.layouts = new Map();
            this.inflight = null;
            this.committing = null;
            this.fonts = null;
            this.caretOn = true;
            this.makeInput();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Tool hooks (media/tools.js)

        hint() { return HINT; }

        activate() {
            this.loadFonts();
        }

        // Selecting another tool finishes the text first; if that fails the tool stays (EditorSession.swift:396). The
        // commit goes through the engine, so the switch is made once it has landed.
        deactivate(next) {
            this.gesture = null;
            if (!this.draft) return true;
            if (this.isEmptyNew()) { this.close(); return true; }
            if (!this.committing) this.commit().then((ok) => { if (ok && this.board.tool === 'type') this.board.selectTool(next); });
            return false;
        }

        cycle() { return false; }

        escape() {
            if (!this.draft) return false;
            this.cancelText();
            return true;
        }

        keydown(e) {
            // ⌘Return with the canvas focused finishes too.
            if (this.draft && (e.metaKey || e.ctrlKey) && (e.code === 'Enter' || e.code === 'NumpadEnter')) { this.commit(); return true; }
            return false;
        }

        busy() { return false; }

        // ⌘Z with a draft open undoes typing, not the document (CanvasTextView.undo).
        interceptUndo() {
            if (!this.draft) return false;
            this.localUndo(false);
            return true;
        }

        // Switching layers (or the mask target) finishes the text first (LayerGroups.swift:146); the layer picked stays
        // picked once the commit has landed.
        resolve(reason) {
            if (reason !== 'target' || !this.draft || this.committing) return undefined;
            if (this.isEmptyNew()) { this.close(); return undefined; }
            let wanted = null;
            Promise.resolve().then(() => {
                const b = this.board;
                wanted = { active: b.activeID(), ids: [...b.selectedIDs], mask: b.isMaskSelected };
            });
            return this.commit({ restore: () => wanted });
        }

        cursor() {
            const g = this.gesture;
            if (g && g.kind === 'resize') return this.handleCursor(g.handle);
            if (this.draft && this.view.pointer) {
                const local = this.logicalPoint(this.view.toDoc(this.view.pointer));
                const handle = local && this.handleAt(local);
                if (handle !== null && handle !== undefined) return this.handleCursor(handle);
            }
            return 'text';
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Options bar (UI/TypeControls.swift:16-100)

        currentStyle() {
            const active = this.board.activeLayer();
            return (this.draft && this.draft.style) || (active && active.text) || this.defaults;
        }

        fontTitle() {
            const d = this.draft;
            if (!d) return this.currentStyle().fontName;
            const { start, end } = this.selection();
            if (start === end) return fontAt(d.style, Math.max(0, start - 1));
            return uniformFontName(d.style, start, end - start) || '';
        }

        // typeColor: the first selected letter's color, or the letter before the caret; not editing, the foreground.
        typeColor() {
            const d = this.draft;
            if (!d) return this.board.colors.fg;
            const { start, end } = this.selection();
            return colorAt(d.style, start < end ? start : Math.max(0, start - 1));
        }

        optionsHTML() {
            const s = this.currentStyle();
            const disabled = !this.board.doc.manifest || this.board.busyShown ? 'disabled' : '';
            const title = (this.fontTitle() || '(Multiple)').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            const color = this.typeColor();
            const align = (a, name) => `<button class="icon-button type-align${s.alignment === a ? ' on' : ''}" data-align="${a}" title="Align ${a.toLowerCase()}" aria-label="Align ${a.toLowerCase()}" ${disabled}>${CB.icon(name)}</button>`;
            return `<span class="title">Type</span>
                <span class="type-header">
                    <button class="type-font" title="Font face, including bold and italic variants" aria-label="Font" ${disabled}><span class="type-font-name">${title}</span><span class="type-font-chevron">${CB.icon('chevronDown')}</span></button>
                    <span class="group"><input class="num type-field" data-type="fontSize" placeholder="Size" style="width:52px" ${disabled}><span class="unit type-scrub" data-type-scrub="fontSize">px</span></span>
                    <span class="type-color" role="button" title="Text color" aria-label="Text color" style="background:#${CB.Color.hex(color)}"></span>
                    <span class="type-aligns">${align('Left', 'alignLeft')}${align('Center', 'alignCenter')}${align('Right', 'alignRight')}</span>
                    <span class="group"><label class="caption type-scrub" data-type-scrub="tracking">Tracking</label><input class="num type-field" data-type="tracking" placeholder="Tracking" style="width:45px" ${disabled}></span>
                    <span class="group"><label class="caption type-scrub" data-type-scrub="leading">Leading</label><input class="num type-field" data-type="leading" placeholder="Auto" style="width:52px" title="Line height, baseline to baseline. Empty or 0 is Auto: 120% of the font size." ${disabled}></span>
                </span>
                <span class="spacer"></span>
                ${this.draft ? `<button class="pill type-cancel" ${disabled}>Cancel</button><button class="pill type-done" ${disabled}>Done</button>`
                    : `<button class="pill type-edit" ${disabled || (this.board.activeLayer() && this.board.activeLayer().text ? '' : 'disabled')}>Edit Text</button>`}`;
        }

        refreshOptions(el) {
            const s = this.currentStyle();
            const set = (selector, value) => el.querySelectorAll(selector).forEach((n) => { if (document.activeElement !== n) n.value = value; });
            const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));
            set('[data-type="fontSize"]', num(s.fontSize));
            set('[data-type="tracking"]', num(s.tracking));
            // 0 is Auto: the field is left empty so its "Auto" placeholder shows through.
            set('[data-type="leading"]', s.leading > 0 ? String(Math.round(s.leading)) : '');
            const name = el.querySelector('.type-font-name');
            if (name) name.textContent = this.fontTitle() || '(Multiple)';
            const swatch = el.querySelector('.type-color');
            if (swatch) swatch.style.background = `#${CB.Color.hex(this.typeColor())}`;
            el.querySelectorAll('.type-align').forEach((b) => b.classList.toggle('on', b.dataset.align === s.alignment));
        }

        bindOptions(el) {
            const on = (selector, event, fn, capture = false) => el.querySelectorAll(selector).forEach((n) => n.addEventListener(event, fn, capture));
            on('.type-done', 'click', () => this.commit());
            on('.type-cancel', 'click', () => this.cancelText());
            on('.type-edit', 'click', () => this.editActive());
            on('.type-align', 'click', (e) => {
                const alignment = e.currentTarget.dataset.align;
                this.changeStyle((s) => { s.alignment = alignment; });
                this.refocus();
            });
            on('.type-color', 'click', () => this.openColorPicker());
            on('.type-font', 'click', (e) => this.openFontMenu(e.currentTarget));
            // The fields' own keys run before the board's (capture at the target): Return applies and gives the keys
            // back to the text, Up/Down step as ContentView's arrowSteps.
            on('.type-field', 'keydown', (e) => this.fieldKey(e), true);
            on('[data-type="fontSize"], [data-type="tracking"]', 'change', (e) => this.applyField(e.target));
            // Leading applies on every keystroke (a text binding, TypeControls.swift:75-84).
            on('[data-type="leading"]', 'input', (e) => this.applyField(e.target));
            el.querySelectorAll('.type-scrub').forEach((label) => label.addEventListener('pointerdown', (e) => this.scrub(e, label)));
        }

        // A typed value outside the range is ignored (an invalid style is dropped by changeTextStyle).
        applyField(input) {
            const key = input.dataset.type, text = input.value.trim();
            if (key === 'leading') {
                const value = Number(text);
                this.changeStyle((s) => { s.leading = Math.max(0, Math.min(5000, Number.isFinite(value) && text ? value : 0)); });
                return;
            }
            const value = Number(text);
            if (!text || !Number.isFinite(value)) { this.board.refreshOptionValues(); return; }
            this.changeStyle((s) => { s[key] = value; });
            this.board.refreshOptionValues();
        }

        fieldKey(e) {
            const input = e.target, key = input.dataset.type;
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (e.key === 'Enter') this.applyField(input);
                else this.board.refreshOptionValues();
                if (this.draft) this.focusInput(); else this.board.focusCanvas();
                return;
            }
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            const s = this.currentStyle();
            // arrowSteps (TypeControls.swift:40-89): size clamped, tracking unclamped (invalid ignored), leading from
            // the effective line height.
            if (key === 'fontSize') this.changeStyle((t) => { t.fontSize = Math.min(2000, Math.max(1, s.fontSize + step)); });
            else if (key === 'tracking') this.changeStyle((t) => { t.tracking = s.tracking + step; });
            else this.changeStyle((t) => { t.leading = Math.max(0, lineHeight(s) + step); });
            this.board.refreshOptionValues();
            input.value = key === 'leading' ? (this.currentStyle().leading > 0 ? String(Math.round(this.currentStyle().leading)) : '') : String(this.currentStyle()[key]);
        }

        // Label scrubs (UI/NumericScrub.swift): start + drag x, whole steps, clamped; the leading's starts from the
        // stored value (0 when Auto).
        scrub(e, label) {
            label.setPointerCapture(e.pointerId);
            const key = label.dataset.typeScrub, start = e.clientX, from = this.currentStyle()[key];
            const range = { fontSize: [1, 2000], tracking: [-100, 1000], leading: [0, 5000] }[key];
            label.onpointermove = (m) => {
                const v = Math.min(range[1], Math.max(range[0], Math.round(from + (m.clientX - start))));
                if (v !== this.currentStyle()[key]) this.changeStyle((s) => { s[key] = v; });
                this.board.refreshOptionValues();
            };
            label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; this.refocus(); };
        }

        // changeTextStyle (Document/TypeTool.swift:383-394): a live text layer merely selected opens for the change;
        // with none the change sets the defaults for the next text. An invalid result is dropped.
        changeStyle(change) {
            const active = this.board.activeLayer();
            if (!this.draft && active && active.text && this.board.canEditLayers()) {
                // Opened with the caret at the end, so the change covers the whole text.
                this.editActive().then((opened) => { if (opened && this.draft) this.changeStyle(change); });
                return;
            }
            if (this.draft) {
                const style = clean(this.draft.style);
                change(style);
                if (!isValid(style)) return;
                this.setStyle(style);
            } else {
                const style = { ...this.defaults };
                change(style);
                if (isValid(style)) this.defaults = style;
                this.board.refreshOptionValues();
            }
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Color (text.md 6)

        openColorPicker() {
            const board = this.board;
            if (board.picker.isOpen || board.working) return;
            const original = this.draft ? clean(this.draft.style) : null;
            const sel = this.selection();
            board.picker.open({
                title: 'Color Picker (Text Color)',
                color: this.typeColor(),
                // The working color previews on the selected letters (previewTextColor, ColorPalette.swift:158-169).
                onChange: (rgb) => {
                    if (!this.draft || !original) return;
                    const style = clean(original);
                    setColor(style, rgb, sel.start, sel.end - sel.start);
                    if (isValid(style)) this.setStyle(style, { keepUndo: true });
                },
                onCommit: (rgb) => {
                    if (this.draft) {
                        const style = clean(original || this.draft.style);
                        setColor(style, rgb, sel.start, sel.end - sel.start);
                        if (isValid(style)) this.setStyle(style);
                    } else {
                        const style = { ...this.defaults, red: rgb[0], green: rgb[1], blue: rgb[2] };
                        if (isValid(style)) this.defaults = style;
                    }
                    if (!board.isMaskSelected) { board.colors.fg = rgb; board.renderRail(); }
                    board.refreshOptionValues();
                    this.refocus();
                },
                // restoreDraftTextColors: the base color back, and the runs if the content is unchanged.
                onCancel: () => {
                    if (this.draft && original) {
                        const style = clean(this.draft.style);
                        style.red = original.red; style.green = original.green; style.blue = original.blue;
                        style.colorRuns = style.content === original.content ? original.colorRuns : undefined;
                        if (isValid(style)) this.setStyle(style, { keepUndo: true });
                    }
                    this.refocus();
                },
            });
        }

        // setPaletteColor with a draft open (ColorPalette.swift:30-56): the foreground recolors the selected letters, or
        // all of them with only a caret. Called by the board when the foreground changes (swatch, swap, default).
        foregroundChanged(which) {
            if (which !== 'fg' || !this.draft || this.board.tool !== 'type' || this.board.isMaskSelected) return;
            const rgb = this.board.colors.fg, sel = this.selection();
            const style = clean(this.draft.style);
            setColor(style, rgb, sel.start, sel.end - sel.start);
            if (isValid(style)) this.setStyle(style);
            this.refocus();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Fonts (text.md 5.2, 10.8)

        loadFonts() {
            if (this.fontsLoading) return this.fontsLoading;
            const scale = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
            this.fontsLoading = this.lane.request('text.fonts', { sprite: { scale, width: 300 } }).then((answer) => {
                const sprite = answer.sprite;
                const sheets = sprite ? sprite.sheets.map((b64) => URL.createObjectURL(new Blob([bytes(b64)], { type: 'image/png' }))) : [];
                this.fonts = { list: answer.fonts, sprite, sheets, index: new Map(answer.fonts.map((f, i) => [f.name, i])) };
                return this.fonts;
            }).catch((error) => {
                this.fontsLoading = null;
                throw error;
            });
            return this.fontsLoading;
        }

        async openFontMenu(button) {
            if (this.fontMenu) { this.closeFontMenu(false); return; }
            let fonts;
            try {
                fonts = await this.loadFonts();
            } catch (error) {
                this.board.toast(error.message);
                return;
            }
            const current = this.fontTitle();
            // A current name that is not installed is added before sorting (TypeControls.swift:225-228).
            let names = fonts.list.map((f) => f.name);
            if (current && !fonts.index.has(current)) names = [...names, current].sort();
            const items = current ? names : ['(Multiple)', ...names];
            const menu = document.createElement('div');
            menu.className = 'menu type-font-menu';
            menu.innerHTML = '<div class="type-font-space"></div>';
            document.body.appendChild(menu);
            const r = button.getBoundingClientRect();
            const height = Math.min(window.innerHeight - 16, 22 * 18 + 8);
            menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 320))}px`;
            menu.style.top = `${Math.max(4, Math.min(r.bottom + 2, window.innerHeight - height - 4))}px`;
            menu.style.height = `${height}px`;
            const space = menu.querySelector('.type-font-space');
            space.style.height = `${items.length * ROW}px`;
            const state = { menu, items, highlighted: -1, chose: false, original: this.draft ? clean(this.draft.style) : null, selection: this.selection() };
            this.fontMenu = state;
            const paint = () => {
                const first = Math.max(0, Math.floor(menu.scrollTop / ROW) - 4);
                const last = Math.min(items.length, first + Math.ceil(height / ROW) + 8);
                space.innerHTML = '';
                for (let i = first; i < last; i++) space.appendChild(this.fontRow(items[i], i, i === state.highlighted, items[i] === current));
            };
            state.paint = paint;
            menu.addEventListener('scroll', paint);
            menu.addEventListener('pointermove', (e) => {
                const row = e.target.closest('.type-font-row');
                if (row) this.highlightFont(Number(row.dataset.index));
            });
            menu.addEventListener('click', (e) => {
                const row = e.target.closest('.type-font-row');
                if (row) this.chooseFont(items[Number(row.dataset.index)]);
            });
            const at = Math.max(0, items.indexOf(current));
            menu.scrollTop = Math.max(0, at * ROW - height / 2);
            paint();
            menu.tabIndex = -1;
            menu.focus();
            menu.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Escape') { e.preventDefault(); this.closeFontMenu(false); }
                else if (e.key === 'Enter') { e.preventDefault(); if (state.highlighted >= 0) this.chooseFont(items[state.highlighted]); }
                else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const next = Math.max(0, Math.min(items.length - 1, (state.highlighted < 0 ? at : state.highlighted) + (e.key === 'ArrowDown' ? 1 : -1)));
                    this.highlightFont(next);
                    if (next * ROW < menu.scrollTop) menu.scrollTop = next * ROW;
                    else if ((next + 1) * ROW > menu.scrollTop + height) menu.scrollTop = (next + 1) * ROW - height;
                }
            });
            setTimeout(() => window.addEventListener('pointerdown', state.closer = (e) => { if (!menu.contains(e.target)) this.closeFontMenu(false); }), 0);
        }

        // A row with the face's name set in that face (the engine's sprite as a mask over the text color), or in the
        // menu font when the face cannot show its own name.
        fontRow(name, index, highlighted, current) {
            const row = document.createElement('div');
            row.className = `type-font-row${highlighted ? ' on' : ''}`;
            row.dataset.index = String(index);
            row.style.top = `${index * ROW}px`;
            const check = `<span class="check">${current ? '✓' : ''}</span>`;
            const f = this.fonts, at = f && f.index.get(name);
            if (f && f.sprite && at !== undefined && f.list[at].ownFace) {
                const per = f.sprite.rowsPerSheet, sheet = Math.floor(at / per), y = (at % per) * f.sprite.rowHeight;
                const rows = Math.min(per, f.list.length - sheet * per);
                row.innerHTML = `${check}<span class="face" aria-label="${name}" style="-webkit-mask-image:url(${f.sheets[sheet]});-webkit-mask-position:0 ${-y}px;-webkit-mask-size:${f.sprite.width}px ${rows * f.sprite.rowHeight}px;width:${f.sprite.width}px"></span>`;
            } else {
                row.innerHTML = `${check}<span class="plain"></span>`;
                row.querySelector('.plain').textContent = name;
            }
            row.title = name;
            return row;
        }

        // previewFont (TypeTool.swift:363-381): only a face previews, on the text already being edited.
        highlightFont(index) {
            const state = this.fontMenu;
            if (!state || state.highlighted === index) return;
            state.highlighted = index;
            state.paint();
            const name = state.items[index];
            if (!this.draft || !state.original || name === '(Multiple)') return;
            const style = clean(state.original);
            setFont(style, name, state.selection.start, state.selection.end - state.selection.start);
            if (isValid(style)) this.setStyle(style, { keepUndo: true });
        }

        // Choosing keeps what the preview shows; "(Multiple)" or the current name changes nothing.
        chooseFont(name) {
            const state = this.fontMenu;
            if (!state) return;
            state.chose = true;
            const current = this.fontTitle();
            this.closeFontMenu(true);
            if (name === '(Multiple)' || name === current) return;
            const sel = state.selection;
            if (this.draft && state.original) {
                const style = clean(state.original);
                setFont(style, name, sel.start, sel.end - sel.start);
                if (isValid(style)) this.setStyle(style);
            } else {
                this.changeStyle((s) => setFont(s, name, sel.start, sel.end - sel.start));
            }
            this.board.refreshOptionValues();
        }

        // Closing without a choice puts the remembered style back (endFontPreview).
        closeFontMenu(chose) {
            const state = this.fontMenu;
            if (!state) return;
            this.fontMenu = null;
            state.menu.remove();
            if (state.closer) window.removeEventListener('pointerdown', state.closer);
            if (!chose && this.draft && state.original && styleKey(this.draft.style) !== styleKey(state.original)) this.setStyle(state.original, { keepUndo: true });
            this.refocus();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Layout requests (text.md 10.5): one in flight; an answer is used only for the style it was asked for, and
        // the newest style is asked for as soon as an older answer lands.

        layoutFor(style) {
            const key = styleKey(style);
            const cached = this.layouts.get(key);
            if (cached) return Promise.resolve(cached);
            return this.lane.request('text.layout', { style: clean(style) }).then(async (answer) => {
                const layout = { ...answer, key };
                layout.image = answer.png ? await createImageBitmap(new Blob([bytes(answer.png)], { type: 'image/png' })) : null;
                delete layout.png;
                this.layouts.set(key, layout);
                // A few recent layouts are kept: typing back and forth and the font preview reuse them.
                while (this.layouts.size > 24) {
                    const oldest = this.layouts.keys().next().value;
                    const old = this.layouts.get(oldest);
                    this.layouts.delete(oldest);
                    if (old.image && old.image.close && !(this.draft && this.draft.layout === old)) old.image.close();
                }
                return layout;
            });
        }

        requestLayout() {
            const d = this.draft;
            if (!d || this.inflight) return;
            const key = styleKey(d.style);
            if (d.layout && d.layout.key === key) return;
            const cached = this.layouts.get(key);
            if (cached) { this.applyLayout(d, cached); return; }
            this.inflight = this.layoutFor(d.style).then((layout) => {
                this.inflight = null;
                if (this.draft !== d) return;
                if (styleKey(d.style) === layout.key) this.applyLayout(d, layout);
                this.requestLayout();
            }, (error) => {
                this.inflight = null;
                this.board.toast(error.message);
            });
        }

        // Image, size, lines and the shown transform switch together, so caret and pixels never disagree.
        applyLayout(d, layout) {
            d.layout = layout;
            d.lines = linesOf(layout, d.style.content.length);
            this.show();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // The draft

        // synchronize (InlineTextEditor.swift:133-186): point text on a layer grows as it is typed, keeping the
        // layer's scale and its transformed top-left corner.
        shown(d = this.draft) {
            if (!d || !d.layout) return null;
            const [w, h] = d.style.boxSize || d.layout.size;
            let t = d.transform ? { ...d.transform } : { x: d.origin.x, y: d.origin.y, width: w, height: h, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
            const image = d.layerID && this.board.doc.entry(d.layerID).image;
            if (!d.style.boxSize && d.transform && image && image.width > 0) {
                const factor = t.width / image.width;
                const anchor = pointOf(t, 0, 0);
                t.width = w * factor;
                t.height = h * factor;
                const moved = pointOf(t, 0, 0);
                t.x += anchor.x - moved.x;
                t.y += anchor.y - moved.y;
            }
            return t;
        }

        logicalSize(d = this.draft) {
            return d.style.boxSize || d.layout.size;
        }

        // The draft in place of its layer (without its mask), or new text hung above the active layer.
        show() {
            const d = this.draft, board = this.board;
            if (!d) return;
            const t = this.shown(d);
            if (t) {
                const [w, h] = this.logicalSize(d);
                const image = d.layout.image || emptyImage();
                const toDocument = Affine.multiply(Transform.pixelToDocument(t, w, h), { a: w / image.width, b: 0, c: 0, d: h / image.height, e: 0, f: 0 });
                if (d.layerID) {
                    board.renderer.overrides.set(d.layerID, { canvas: image, toDocument, transform: t, noMask: true });
                    board.newTextDraft = null;
                } else {
                    board.newTextDraft = (ctx) => {
                        // Once the committed layer is back, it alone is drawn.
                        if (this.committedFrom && board.doc.layers.some((l) => l.text && !this.committedFrom.has(l.id))) return true;
                        ctx.save();
                        Affine.setOn(ctx, toDocument);
                        ctx.imageSmoothingEnabled = true;
                        ctx.imageSmoothingQuality = 'high';
                        ctx.drawImage(image, 0, 0);
                        ctx.restore();
                    };
                }
            }
            board.liveChanged();
            this.placeInput();
            this.blink(true);
            this.view.drawOverlay();
        }

        setStyle(style, { keepUndo = false } = {}) {
            const d = this.draft;
            if (!d) return;
            if (!keepUndo) this.breakTyping();
            d.style = style;
            d.rev++;
            if (this.input.value !== style.content) {
                const { start, end } = this.selection();
                this.input.value = style.content;
                this.input.setSelectionRange(Math.min(start, style.content.length), Math.min(end, style.content.length));
            }
            this.requestLayout();
            this.board.refreshOptionValues();
            this.view.drawOverlay();
        }

        open(d, caret) {
            const board = this.board;
            this.draft = d;
            board.textDraft = d;
            this.undoStack = { done: [], undone: [], kind: null, caret: -1 };
            this.input.value = d.style.content;
            const at = caret === undefined ? d.style.content.length : caret;
            this.input.setSelectionRange(at, at);
            d.selection = { start: at, end: at };
            this.applyLayout(d, d.layout);
            board.changed();
            board.renderOptions(true);
            this.focusInput();
        }

        // The draft and its override go; nothing in the document changed meanwhile.
        close() {
            const d = this.draft, board = this.board;
            if (!d) return;
            this.draft = null;
            board.textDraft = null;
            board.newTextDraft = null;
            if (d.layerID) board.renderer.overrides.delete(d.layerID);
            this.gesture = null;
            this.closeFontMenu(true);
            clearInterval(this.blinkTimer);
            this.input.blur();
            board.changed();
            board.renderOptions(true);
            board.focusCanvas();
        }

        // cancelText (TypeTool.swift:330): the layer was never touched, so nothing needs putting back.
        cancelText() {
            this.close();
        }

        isEmptyNew() {
            const d = this.draft;
            return Boolean(d && !d.layerID && !d.style.content.trim());
        }

        // applyText through the engine (TypeTool.swift:270-322, text.md 11.3). Empty new text makes nothing; a failure
        // shows the alert and keeps the draft open. The draft's pixels stay on screen until the saved layer is back.
        commit({ restore } = {}) {
            const d = this.draft, board = this.board;
            if (!d) return Promise.resolve(true);
            if (this.committing) return this.committing;
            if (this.isEmptyNew()) { this.close(); return Promise.resolve(true); }
            if (!isValid(d.style)) return Promise.resolve(false);
            const args = {
                layerID: d.layerID, origin: [d.origin.x, d.origin.y],
                transform: d.transform ? Transform.write(d.transform) : null, style: clean(d.style),
            };
            if (!d.layerID) this.committedFrom = new Set(board.doc.layers.map((l) => l.id));
            this.committing = (async () => {
                try {
                    const result = await board.engine('text.commit', args, { label: d.layerID ? 'Edit Text' : 'New Text Layer' });
                    if (result.error) { board.alert(PAINT, result.error); return false; }
                    const wanted = restore && restore();
                    if (!wanted) board.applyEngineState(result);
                    const style = clean(d.style);
                    delete style.colorRuns;
                    delete style.fontRuns;
                    this.defaults = style;
                    if (this.draft === d) this.close();
                    if (wanted && wanted.active && board.doc.layer(wanted.active)) {
                        board.selectLayers(wanted.ids, wanted.active);
                        if (wanted.mask) board.selectLayerTarget(wanted.active, true);
                    }
                    return true;
                } catch (error) {
                    board.alert(PAINT, error.message);
                    return false;
                } finally {
                    this.committing = null;
                    this.committedFrom = null;
                }
            })();
            return this.committing;
        }

        // editActiveText (TypeTool.swift:264-268): the active layer's live text, the caret at the end.
        editActive(caret) {
            const board = this.board, record = board.activeLayer();
            if (!record || !record.text || this.draft || !board.canEditLayers()) return Promise.resolve(false);
            return this.openLayer(record, caret);
        }

        async openLayer(record, caret) {
            const board = this.board;
            if (board.refuseLocked([record])) return false;
            if (board.tool !== 'type') board.selectTool('type');
            if (board.tool !== 'type') return false;
            const style = clean(record.text);
            if (!isValid(style)) return false;
            const transform = Transform.read(record.transform, [board.doc.width, board.doc.height]);
            let layout;
            try {
                layout = await this.layoutFor(style);
            } catch (error) {
                board.alert(PAINT, error.message);
                return false;
            }
            if (this.draft || !board.doc.layer(record.id)) return false;
            this.open({ layerID: record.id, origin: { x: transform.x, y: transform.y }, transform, style, layout, rev: 0 }, caret);
            return true;
        }

        // The Layers panel's thumbnail double-click and the Move tool's double-click (EditorCanvas.swift:2584-2597).
        editLayer(id) {
            const board = this.board;
            if (!board.canEditLayers() || this.draft) return false;
            if (board.selectTools.floating) board.selectTools.commitFloating();
            board.selectLayer(id);
            this.editActive();
            return true;
        }

        // The topmost effectively visible live text whose box holds the point.
        textLayerAt(point) {
            const board = this.board;
            const layers = board.doc.layers;
            for (let i = layers.length - 1; i >= 0; i--) {
                const l = layers[i];
                if (!l.text || !board.effectivelyVisible(l) || !board.doc.entry(l.id).image) continue;
                if (containsPoint(Transform.read(l.transform, [board.doc.width, board.doc.height]), point)) return l;
            }
            return null;
        }

        // A Move-tool press: on its second click over live text the editor opens there.
        openAt(point, e) {
            if (this.clickCount(e, point) < 2) return false;
            const layer = this.board.canEditLayers() && !this.draft ? this.textLayerAt(point) : null;
            if (!layer) return false;
            return this.editLayer(layer.id);
        }

        // beginText (TypeTool.swift:235-262, 332-341): new text in the defaults, in the foreground color unless the mask
        // is the target; a click puts its first baseline on the pointer, a dragged box is exactly where it was drawn.
        async beginNew(point, box) {
            const board = this.board;
            if (!board.canEditLayers() || this.draft) return;
            const style = clean(this.defaults);
            style.content = '';
            delete style.colorRuns;
            delete style.fontRuns;
            delete style.boxSize;
            if (!board.isMaskSelected) [style.red, style.green, style.blue] = board.colors.fg;
            if (box) {
                style.boxSize = [Math.max(16, Math.round(box.width)), Math.max(16, Math.round(box.height))];
                if (!boxIsValid(style)) {
                    board.alert(PAINT, 'That text box exceeds the 30,000-pixel or 200-megapixel limit.');
                    return;
                }
            }
            let layout;
            try {
                layout = await this.layoutFor(style);
            } catch (error) {
                board.alert(PAINT, error.message);
                return;
            }
            if (this.draft || board.tool !== 'type') return;
            const baseline = PADDING + lineHeight(style) - layout.baseDescender;
            const origin = box ? { x: box.x, y: box.y } : { x: point.x - PADDING, y: point.y - baseline };
            this.open({ layerID: null, origin, transform: null, style, layout, rev: 0 }, 0);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Mapping: logical layer pixels (the editor's bounds) and the mirrored text surface.

        mapping(withFlips) {
            const d = this.draft, t = this.shown(d);
            if (!t) return null;
            const [w, h] = this.logicalSize(d);
            return Transform.pixelToDocument(withFlips ? t : { ...t, flipX: false, flipY: false }, w, h);
        }

        logicalPoint(doc, withFlips = false) {
            const m = this.draft && this.mapping(withFlips);
            const inv = m && Affine.invert(m);
            return inv ? Affine.apply(inv, doc.x, doc.y) : null;
        }

        // 6 screen points as layer pixels (InlineTextEditor handleSize).
        handleSize() {
            const t = this.shown(), [w] = this.logicalSize();
            return Math.max(2, 6 / Math.max(0.01, this.view.ppp * (t.width / w)));
        }

        edgeReach() {
            const [w, h] = this.logicalSize();
            return Math.min((this.handleSize() * 10) / 6, Math.min(w, h) / 3);
        }

        // handle(at:): a band along each edge as well as the squares; corners win over edges.
        handleAt(p) {
            const [w, h] = this.logicalSize(), reach = this.edgeReach();
            if (p.x < -reach || p.x > w + reach || p.y < -reach || p.y > h + reach) return null;
            const left = p.x <= reach, right = p.x >= w - reach, top = p.y <= reach, bottom = p.y >= h - reach;
            if (left && top) return 0;
            if (right && top) return 2;
            if (right && bottom) return 4;
            if (left && bottom) return 6;
            if (top) return 1;
            if (right) return 3;
            if (bottom) return 5;
            if (left) return 7;
            return null;
        }

        // The frame-resize arrows for an edge, turned with the box in 45° steps (handleCursor).
        handleCursor(index) {
            const positions = [0, 1, 2, 3, 0, 1, 2, 3];
            const rotation = (this.draft && this.draft.transform && this.draft.transform.rotation) || 0;
            const turns = ((Math.round(rotation / 45) % 8) + 8) % 8;
            return ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'][(positions[index] + turns) % 4];
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Pointer (InlineTextEditor mouseDown/Dragged/Up, beginTextGesture, dragTextGesture, finishTextGesture)

        // Pointer events carry no click count: presses within the double-click interval (NSEvent.doubleClickInterval,
        // 0.5 s by default) and 4 screen points of each other count up, as mouse clicks do.
        clickCount(e, doc) {
            const now = performance.now(), screen = this.view.toScreen(doc), last = this.clicks;
            const near = last && now - last.time < 500 && Math.hypot(screen.x - last.x, screen.y - last.y) <= 4;
            this.clicks = { time: now, x: screen.x, y: screen.y, count: near ? last.count + 1 : 1 };
            return this.clicks.count;
        }

        down(doc, screen, e) {
            const board = this.board;
            e = { shiftKey: e.shiftKey, detail: this.clickCount(e, doc) };
            if (!board.doc.manifest || this.committing) return true;
            // A second click while the text is still opening lands in it once it is open (a double click selects a word).
            if (this.opening) {
                this.opening.then(() => { if (this.draft) this.pressText(doc, e); });
                return true;
            }
            const d = this.draft;
            if (d && d.layout) {
                const local = this.logicalPoint(doc);
                const handle = local && this.handleAt(local);
                if (handle !== null && handle !== undefined) { this.beginResize(handle, doc); return true; }
                const [w, h] = this.logicalSize();
                if (local && local.x >= 0 && local.y >= 0 && local.x <= w && local.y <= h) {
                    // Inside the text view's frame the press places the caret; elsewhere in the padding it does nothing.
                    if (local.x >= PADDING && local.y >= PADDING && local.x <= w - PADDING && local.y <= h - PADDING) this.pressText(doc, e);
                    else this.focusInput();
                    return true;
                }
            }
            // A press outside the box finishes the text first, then starts again at the press.
            const g = { kind: 'pending', press: doc, last: doc, released: false, event: { shiftKey: e.shiftKey, detail: e.detail } };
            this.gesture = g;
            const start = () => {
                if (this.gesture !== g) return;
                const layer = this.textLayerAt(g.press);
                if (layer) {
                    this.gesture = null;
                    board.selectLayer(layer.id);
                    this.opening = this.openLayer(layer, undefined).then((opened) => {
                        this.opening = null;
                        if (!opened || !this.draft) return;
                        this.placeCaret(g.press, g.event);
                        if (!g.released) this.gesture = { kind: 'select', anchor: this.selectionAnchor };
                        if (g.last !== g.press) this.dragSelect(g.last);
                    });
                    return;
                }
                this.gesture = { kind: 'box', anchor: g.press, rect: { x: g.press.x, y: g.press.y, width: 0, height: 0 } };
                if (g.last !== g.press) this.move(g.last);
                if (g.released) this.up(g.last);
            };
            if (d) this.commit().then((ok) => { if (ok) start(); else if (this.gesture === g) this.gesture = null; });
            else start();
            return true;
        }

        move(doc) {
            const g = this.gesture;
            if (!g) return;
            if (g.kind === 'pending') g.last = doc;
            else if (g.kind === 'box') {
                // No snapping and no modifiers (dragTextGesture).
                g.rect = CB.Shapes.dragBox(g.anchor, doc, false, false);
                this.view.drawOverlay();
            } else if (g.kind === 'resize') this.continueResize(doc);
            else if (g.kind === 'select') this.dragSelect(doc);
        }

        up(doc) {
            const g = this.gesture;
            if (!g) return;
            if (g.kind === 'pending') { g.last = doc; g.released = true; return; }
            this.gesture = null;
            if (g.kind === 'box') {
                const rect = g.rect;
                this.view.drawOverlay();
                if (rect.width < 4 && rect.height < 4) this.beginNew({ x: rect.x, y: rect.y }, null);
                else this.beginNew(null, rect);
            } else if (g.kind === 'resize' || g.kind === 'select') this.focusInput();
        }

        // ⎋ during a box drag drops the box (EditorCanvas.swift:2204); other drags just end.
        cancel() {
            this.gesture = null;
            this.view.drawOverlay();
        }

        hover() {
            if (this.draft) this.view.drawOverlay();
        }

        // Pressing a handle on point text turns it into a box of its current size at once.
        beginResize(handle, doc) {
            const d = this.draft, t = this.shown(d);
            if (!d.style.boxSize) {
                const style = clean(d.style);
                style.boxSize = [...d.layout.size];
                d.transform = t;
                d.origin = { x: t.x, y: t.y };
                d.style = style;
                d.rev++;
                this.requestLayout();
            }
            this.gesture = { kind: 'resize', handle, transform: { ...t }, start: doc, style: clean(d.style) };
        }

        continueResize(point) {
            const g = this.gesture, d = this.draft;
            const old = g.transform, rad = Transform.radians(old);
            const dx = point.x - g.start.x, dy = point.y - g.start.y;
            const localX = dx * Math.cos(rad) + dy * Math.sin(rad);
            const localY = -dx * Math.sin(rad) + dy * Math.cos(rad);
            const [ux, uy] = HANDLES[g.handle];
            let left = 0, top = 0, right = old.width, bottom = old.height;
            const source = g.style.boxSize;
            const minW = (16 * old.width) / source[0], minH = (16 * old.height) / source[1];
            if (ux === 0) left = Math.min(localX, right - minW);
            if (ux === 1) right = Math.max(left + minW, right + localX);
            if (uy === 0) top = Math.min(localY, bottom - minH);
            if (uy === 1) bottom = Math.max(top + minH, bottom + localY);
            const style = clean(d.style);
            style.boxSize = [Math.round(((right - left) * source[0]) / old.width), Math.round(((bottom - top) * source[1]) / old.height)];
            if (!boxIsValid(style)) return;
            const t = { ...old, width: (style.boxSize[0] * old.width) / source[0], height: (style.boxSize[1] * old.height) / source[1] };
            const anchor = pointOf(old, left / old.width, top / old.height);
            const current = pointOf(t, 0, 0);
            t.x += anchor.x - current.x;
            t.y += anchor.y - current.y;
            if (!validTransform(t)) return;
            d.origin = { x: t.x, y: t.y };
            d.transform = t;
            d.style = style;
            d.rev++;
            this.requestLayout();
            this.show();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Caret and selection

        selection() {
            const d = this.draft;
            if (!d) return { start: 0, end: 0 };
            return { start: this.input.selectionStart, end: this.input.selectionEnd };
        }

        // A document point as an image pixel of the mirrored text surface.
        textPoint(doc) {
            return this.logicalPoint(doc, true);
        }

        indexAt(doc) {
            const d = this.draft, p = this.textPoint(doc);
            if (!p || !d.lines) return 0;
            return hitIndex(d.layout, d.lines, p.x, p.y);
        }

        // A press in the text: the caret, ⇧ extends, a double press a word, a triple press the paragraph.
        pressText(doc, e) {
            const d = this.draft, content = d.style.content;
            const index = this.indexAt(doc);
            this.breakTyping();
            d.goalX = null;
            const p = this.textPoint(doc);
            const line = d.lines && d.lines.find((l) => p && p.y >= l.rect[1] && p.y < l.rect[1] + l.rect[3]);
            d.affinity = line && !line.hardBreak && index === line.end && line !== d.lines[d.lines.length - 1] ? 'up' : 'down';
            if (e.detail === 2) {
                const [a, b] = wordRange(content, index);
                this.setSelection(a, b);
            } else if (e.detail >= 3) {
                const [a, b] = paragraphRange(content, index);
                this.setSelection(a, b);
            } else if (e.shiftKey) {
                const { start, end } = this.selection();
                const anchor = this.input.selectionDirection === 'backward' ? end : start;
                this.selectionAnchor = anchor;
                this.setSelection(Math.min(anchor, index), Math.max(anchor, index), index < anchor ? 'backward' : 'forward');
            } else {
                this.selectionAnchor = index;
                this.setSelection(index, index);
            }
            if (e.detail <= 1) this.gesture = { kind: 'select', anchor: this.selectionAnchor };
            this.focusInput();
        }

        placeCaret(doc, e) {
            this.pressText(doc, { detail: e.detail || 1, shiftKey: false });
        }

        dragSelect(doc) {
            const g = this.gesture, index = this.indexAt(doc);
            const anchor = g && g.anchor !== undefined ? g.anchor : this.selectionAnchor;
            this.setSelection(Math.min(anchor, index), Math.max(anchor, index), index < anchor ? 'backward' : 'forward');
        }

        setSelection(start, end, direction = 'none') {
            this.input.setSelectionRange(start, end, direction);
            this.selectionMoved();
        }

        selectionMoved() {
            const d = this.draft;
            if (!d) return;
            d.selection = this.selection();
            this.placeInput();
            this.blink(true);
            this.board.refreshOptionValues();
            this.view.drawOverlay();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // The input surface (text.md 10.3)

        makeInput() {
            const input = document.createElement('textarea');
            input.className = 'type-input';
            for (const [k, v] of Object.entries({ spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': 'Canvas text' })) input.setAttribute(k, v);
            this.board.stageEl.appendChild(input);
            this.input = input;
            input.addEventListener('keydown', (e) => this.inputKey(e));
            input.addEventListener('beforeinput', (e) => this.beforeInput(e));
            input.addEventListener('input', (e) => this.onInput(e));
            input.addEventListener('compositionstart', () => { this.composition = { start: input.selectionStart, end: input.selectionEnd }; });
            input.addEventListener('compositionupdate', (e) => {
                if (this.composition) this.composition.end = this.composition.start + (e.data || '').length;
            });
            input.addEventListener('compositionend', () => { this.composition = null; this.breakTyping(); this.view.drawOverlay(); });
            input.addEventListener('focus', () => this.blink(true));
            input.addEventListener('blur', () => this.view.drawOverlay());
            document.addEventListener('selectionchange', () => {
                if (this.draft && document.activeElement === input && !this.editing) {
                    const s = this.selection();
                    if (!this.draft.selection || s.start !== this.draft.selection.start || s.end !== this.draft.selection.end) {
                        this.breakTyping();
                        this.selectionMoved();
                    }
                }
            });
        }

        // Also once the press is over: a mouse-down focuses the canvas as its default action, after pointerdown.
        focusInput() {
            if (!this.draft) return;
            const focus = () => { if (this.draft && document.activeElement !== this.input) this.input.focus({ preventScroll: true }); };
            focus();
            setTimeout(focus, 0);
        }

        // Back to the text after the header, a picker or the font menu (canvasFocusRequest).
        refocus() {
            if (this.draft) this.focusInput();
        }

        // The textarea sits at the caret so an input method's candidates open there.
        placeInput() {
            const r = this.caretScreenRect();
            const s = this.input.style;
            if (!r) { s.left = '0px'; s.top = '0px'; return; }
            s.left = `${Math.round(r.x)}px`;
            s.top = `${Math.round(r.y)}px`;
            s.height = `${Math.max(1, Math.round(r.h))}px`;
        }

        blink(reset) {
            if (reset) this.caretOn = true;
            clearInterval(this.blinkTimer);
            if (!this.draft) return;
            this.blinkTimer = setInterval(() => {
                if (!this.draft) { clearInterval(this.blinkTimer); return; }
                this.caretOn = !this.caretOn;
                this.view.drawOverlay();
            }, 530);
        }

        beforeInput(e) {
            const d = this.draft;
            if (!d) { e.preventDefault(); return; }
            if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
                e.preventDefault();
                this.localUndo(e.inputType === 'historyRedo');
                return;
            }
            this.pre = { value: this.input.value, start: this.input.selectionStart, end: this.input.selectionEnd, type: e.inputType };
            this.editing = true;
        }

        // The edit as the range it replaced and the length put there, so the runs follow the text letter for letter
        // (shouldChangeTextIn, InlineTextEditor.swift:241-252).
        onInput(e) {
            const d = this.draft, input = this.input;
            this.editing = false;
            if (!d) return;
            const pre = this.pre || { value: d.style.content, start: d.selection.start, end: d.selection.end, type: e.inputType || '' };
            this.pre = null;
            const old = pre.value, value = input.value;
            if (value === old) return;
            // Longer than 100,000 units: the change is refused.
            if (value.length > 100000) {
                input.value = old;
                input.setSelectionRange(pre.start, pre.end);
                return;
            }
            const type = e.inputType || pre.type || '';
            let loc, len, added;
            if (type.startsWith('insert') && type !== 'insertCompositionText') {
                loc = pre.start; len = pre.end - pre.start; added = value.length - (old.length - len);
            } else if (type.startsWith('delete')) {
                const removed = old.length - value.length;
                if (pre.end > pre.start) { loc = pre.start; len = pre.end - pre.start; added = value.length - (old.length - len); }
                else if (type.includes('Backward')) { loc = pre.start - removed; len = removed; added = 0; }
                else { loc = pre.start; len = removed; added = 0; }
            }
            if (loc === undefined || loc < 0 || added < 0 || loc + len > old.length || old.slice(0, loc) + value.slice(loc, loc + added) + old.slice(loc + len) !== value) {
                // Common prefix and suffix, kept to the pre-edit caret.
                let a = 0;
                while (a < old.length && a < value.length && old[a] === value[a] && a < Math.min(pre.start, old.length)) a++;
                let b = 0;
                while (b < old.length - a && b < value.length - a && old[old.length - 1 - b] === value[value.length - 1 - b]) b++;
                loc = a; len = old.length - a - b; added = value.length - a - b;
            }
            const kind = type.startsWith('delete') ? 'delete' : type === 'insertFromPaste' || type === 'deleteByCut' ? 'paste' : 'insert';
            this.recordUndo(kind, pre);
            const style = clean(d.style);
            replaceCharacters(style, loc, len, added);
            style.content = value;
            // Text changed in a way the runs cannot follow keeps one color and face (InlineTextEditor.swift:237).
            if (!isValid(style)) { delete style.colorRuns; delete style.fontRuns; }
            d.style = style;
            d.rev++;
            d.goalX = null;
            d.selection = this.selection();
            this.undoStack.caret = input.selectionStart;
            this.requestLayout();
            this.board.refreshOptionValues();
            this.placeInput();
            this.blink(true);
            this.view.drawOverlay();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Local undo (text.md 4.5, 10.7): typing since the box opened, coalesced the Cocoa way.

        snapshot() {
            const s = this.draft.style;
            return { content: s.content, colorRuns: s.colorRuns && s.colorRuns.map((r) => ({ ...r })), fontRuns: s.fontRuns && s.fontRuns.map((r) => ({ ...r })), selection: this.selection() };
        }

        recordUndo(kind, pre) {
            const u = this.undoStack;
            const before = { ...this.snapshot(), content: pre.value, selection: { start: pre.start, end: pre.end } };
            const continues = u.kind === kind && (kind === 'insert' || kind === 'delete') && pre.start === pre.end && pre.start === u.caret && u.done.length;
            if (!continues) u.done.push({ before });
            u.undone = [];
            u.kind = this.composition ? null : kind;
        }

        breakTyping() {
            if (this.undoStack) this.undoStack.kind = null;
        }

        localUndo(redo) {
            const d = this.draft, u = this.undoStack;
            if (!d || !u) return;
            const from = redo ? u.undone : u.done, to = redo ? u.done : u.undone;
            const entry = from.pop();
            if (!entry) return;
            to.push({ before: this.snapshot() });
            const s = clean(d.style);
            s.content = entry.before.content;
            s.colorRuns = entry.before.colorRuns;
            s.fontRuns = entry.before.fontRuns;
            if (!isValid(s)) { delete s.colorRuns; delete s.fontRuns; }
            u.kind = null;
            d.style = s;
            d.rev++;
            this.input.value = s.content;
            const sel = entry.before.selection;
            this.input.setSelectionRange(Math.min(sel.start, s.content.length), Math.min(sel.end, s.content.length));
            d.selection = this.selection();
            this.requestLayout();
            this.board.refreshOptionValues();
            this.view.drawOverlay();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Keys inside the text (CanvasTextView.keyDown; text.md 4.4, 10.9)

        inputKey(e) {
            const d = this.draft;
            if (!d) return;
            const k = textKey(e);
            const stop = () => { e.preventDefault(); e.stopPropagation(); };
            if (!k) { stop(); return; }
            const mod = k.meta;
            if (k.key === 'Escape') { stop(); this.cancelText(); return; }
            if (mod && (k.key === 'Enter' || e.code === 'NumpadEnter')) { stop(); this.commit(); return; }
            // Option with the arrows sets spacing: left and right the tracking, up and down the leading; Shift makes
            // each step ten. Up closes the lines, down opens them, counting from what Auto works out to.
            if (k.alt && !mod && !k.ctrl && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k.key)) {
                stop();
                const step = k.shift ? 10 : 1;
                if (k.key === 'ArrowLeft') this.changeStyle((s) => { s.tracking -= step; });
                else if (k.key === 'ArrowRight') this.changeStyle((s) => { s.tracking += step; });
                else if (k.key === 'ArrowUp') this.changeStyle((s) => { s.leading = Math.max(1, lineHeight(s) - step); });
                else this.changeStyle((s) => { s.leading = lineHeight(s) + step; });
                this.board.refreshOptionValues();
                return;
            }
            if (mod && !k.alt && (e.code === 'KeyZ' || e.code === 'KeyY')) { stop(); this.localUndo(e.code === 'KeyY' || k.shift); return; }
            if (e.key === 'Tab') {
                stop();
                if (!e.shiftKey && !mod && !k.alt) document.execCommand('insertText', false, '\t');
                return;
            }
            const vertical = (k.key === 'ArrowUp' || k.key === 'ArrowDown') && !mod && !k.alt;
            const emacs = k.ctrl && !mod && (e.code === 'KeyP' || e.code === 'KeyN');
            if (vertical || emacs || k.key === 'PageUp' || k.key === 'PageDown') {
                stop();
                const down = k.key === 'ArrowDown' || e.code === 'KeyN' || k.key === 'PageDown';
                this.moveVertically(down, k.shift, k.key === 'PageUp' || k.key === 'PageDown');
                return;
            }
            const lineEnds = (mod && (k.key === 'ArrowLeft' || k.key === 'ArrowRight')) || k.key === 'Home' || k.key === 'End'
                || (k.ctrl && !mod && (e.code === 'KeyA' || e.code === 'KeyE'));
            if (lineEnds) {
                stop();
                this.moveToLineEnd(k.key === 'ArrowRight' || k.key === 'End' || e.code === 'KeyE', k.shift);
                return;
            }
            if (mod && (k.key === 'ArrowUp' || k.key === 'ArrowDown')) {
                stop();
                this.extendTo(k.key === 'ArrowDown' ? d.style.content.length : 0, k.shift);
                return;
            }
            // Everything else is the textarea's own (characters, deleting, ⌘A, the clipboard, IME); the caret moves it
            // makes break the typing run.
            if (k.key.startsWith('Arrow')) { d.goalX = null; this.breakTyping(); d.affinity = 'down'; }
        }

        // The caret or the selection's moving end to `index`; ⇧ keeps the anchor.
        extendTo(index, shift, affinity = 'down') {
            const d = this.draft, { start, end } = this.selection();
            const backward = this.input.selectionDirection === 'backward';
            d.affinity = affinity;
            this.breakTyping();
            if (!shift) { this.setSelection(index, index); return; }
            const anchor = start === end ? start : backward ? end : start;
            this.setSelection(Math.min(anchor, index), Math.max(anchor, index), index < anchor ? 'backward' : 'forward');
        }

        movingIndex() {
            const { start, end } = this.selection();
            return this.input.selectionDirection === 'backward' ? start : end;
        }

        // ↑/↓ by the engine's visual lines, keeping the x it started from; past the first or last line, the text's
        // start or end.
        moveVertically(down, shift, page) {
            const d = this.draft;
            if (!d.lines || !d.lines.length) return;
            const index = this.movingIndex();
            const line = lineFor(d.lines, index, d.affinity);
            const at = d.lines.indexOf(line);
            if (d.goalX === null || d.goalX === undefined) d.goalX = caretX(line, index) ?? line.rect[0];
            const goal = d.goalX;
            const target = page ? (down ? d.lines.length - 1 : 0) : at + (down ? 1 : -1);
            let next;
            if (target < 0) next = 0;
            else if (target >= d.lines.length) next = d.style.content.length;
            else next = nearestOnLine(d.lines[target], goal);
            const affinity = target >= 0 && target < d.lines.length && next === d.lines[target].end && !d.lines[target].hardBreak && target < d.lines.length - 1 ? 'up' : 'down';
            this.extendTo(next, shift, affinity);
            d.goalX = goal;
        }

        moveToLineEnd(end, shift) {
            const d = this.draft;
            if (!d.lines || !d.lines.length) return;
            const index = this.movingIndex();
            const line = lineFor(d.lines, index, d.affinity);
            const carets = line.hardBreak ? line.carets.filter((c) => c[0] < line.end) : line.carets;
            const list = carets.length ? carets : line.carets;
            const target = end ? list[list.length - 1][0] : list[0][0];
            const soft = end && !line.hardBreak && !line.extra && line !== d.lines[d.lines.length - 1];
            this.extendTo(target, shift, soft ? 'up' : 'down');
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Overlay (text.md 10.4)

        caretScreenRect() {
            const d = this.draft;
            if (!d || !d.lines || !d.lines.length) return null;
            const m = this.mapping(true);
            if (!m) return null;
            const { start, end } = this.selection();
            const index = start === end ? start : this.movingIndex();
            const line = lineFor(d.lines, index, d.affinity);
            const x = caretX(line, index) ?? line.rect[0];
            const a = this.view.toScreen(Affine.apply(m, x, line.rect[1]));
            const b = this.view.toScreen(Affine.apply(m, x, line.rect[1] + line.rect[3]));
            return { x: a.x, y: a.y, h: Math.hypot(b.x - a.x, b.y - a.y), a, b, line, x0: x };
        }

        drawOverlay(ctx) {
            const view = this.view;
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a84ff';
            const g = this.gesture;
            if (g && g.kind === 'box') {
                const a = view.toScreen({ x: g.rect.x, y: g.rect.y }), b = view.toScreen({ x: g.rect.x + g.rect.width, y: g.rect.y + g.rect.height });
                ctx.strokeStyle = accent;
                ctx.lineWidth = 1;
                ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
            }
            const d = this.draft;
            if (!d || !d.layout) return;
            const text = this.mapping(true), frame = this.mapping(false);
            if (!text || !frame) return;
            const quad = (m, x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => view.toScreen(Affine.apply(m, px, py)));
            const path = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); };
            // The selection, translucent whether or not the text has the keys.
            const { start, end } = this.selection();
            if (end > start && d.lines) {
                ctx.fillStyle = withAlpha(accent, 0.45);
                for (const [x, y, w, h] of selectionRects(d.lines, start, end)) { path(quad(text, x, y, w, h)); ctx.fill(); }
            }
            // The input method's marked text, underlined.
            if (this.composition && d.lines) {
                ctx.strokeStyle = colorCss(colorAt(d.style, this.composition.start));
                ctx.lineWidth = 1.5;
                for (const [x, y, w, h] of selectionRects(d.lines, this.composition.start, this.composition.end)) {
                    const pts = quad(text, x, y, w, h);
                    ctx.beginPath(); ctx.moveTo(pts[3].x, pts[3].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.stroke();
                }
            }
            // The frame: 1 pt accent, 8 white 6 pt handles, in the box's own (unflipped) order.
            const [w, h] = this.logicalSize(d);
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1;
            path(quad(frame, 0, 0, w, h));
            ctx.stroke();
            const corners = HANDLES.map(([ux, uy]) => view.toScreen(Affine.apply(frame, ux * w, uy * h)));
            const angle = Math.atan2(corners[2].y - corners[0].y, corners[2].x - corners[0].x);
            for (const c of corners) {
                ctx.save();
                ctx.translate(c.x, c.y);
                ctx.rotate(angle);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(-3, -3, 6, 6);
                ctx.strokeStyle = accent;
                ctx.strokeRect(-3, -3, 6, 6);
                ctx.restore();
            }
            // Text that does not fit is marked by a plus in the bottom-right handle.
            if (d.layout.overflow) {
                const c = corners[4], arm = 6 * 0.42;
                ctx.save();
                ctx.translate(c.x, c.y);
                ctx.rotate(angle);
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(-arm, 0); ctx.lineTo(arm, 0); ctx.moveTo(0, -arm); ctx.lineTo(0, arm); ctx.stroke();
                ctx.restore();
            }
            // The caret, in the color of the letter before it, line-fragment tall, at least one layer pixel wide.
            if (start === end && this.caretOn && document.activeElement === this.input && !(d.layout.overflow && start > d.layout.laidOut)) {
                const r = this.caretScreenRect();
                if (r) {
                    const t = this.shown(d);
                    ctx.strokeStyle = colorCss(colorAt(d.style, start > 0 ? start - 1 : 0));
                    ctx.lineWidth = Math.max(1, this.view.ppp * (t.width / w));
                    ctx.beginPath(); ctx.moveTo(r.a.x, r.a.y); ctx.lineTo(r.b.x, r.b.y); ctx.stroke();
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------------

    // LayerTransform.point: a unit point of the box, rotated about its center (flips aside).
    function pointOf(t, ux, uy) {
        const r = Transform.radians(t), c = Transform.center(t);
        const x = (ux - 0.5) * t.width, y = (uy - 0.5) * t.height;
        return { x: c.x + x * Math.cos(r) - y * Math.sin(r), y: c.y + x * Math.sin(r) + y * Math.cos(r) };
    }
    // LayerTransform.contains.
    function containsPoint(t, p) {
        const r = Transform.radians(t), c = Transform.center(t), x = p.x - c.x, y = p.y - c.y;
        return Math.abs(x * Math.cos(r) + y * Math.sin(r)) <= t.width / 2 && Math.abs(-x * Math.sin(r) + y * Math.cos(r)) <= t.height / 2;
    }
    // LayerTransform.isValid.
    function validTransform(t) {
        return [t.x, t.y, t.width, t.height, t.rotation].every(Number.isFinite) && t.width >= 1 && t.width <= 300000
            && t.height >= 1 && t.height <= 300000 && Math.abs(t.x) <= 1000000 && Math.abs(t.y) <= 1000000;
    }
    // A double click's word (NSAttributedString.doubleClick(at:)): the word segment holding the index, or the run of
    // spaces or the punctuation mark it is in.
    function wordRange(content, index) {
        if (!content.length) return [0, 0];
        const at = Math.min(index, content.length - 1);
        for (const seg of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(content)) {
            if (at >= seg.index && at < seg.index + seg.segment.length) return [seg.index, seg.index + seg.segment.length];
        }
        return [at, at + 1];
    }
    // NSString.paragraphRange: the line with its newline.
    function paragraphRange(content, index) {
        let a = index;
        while (a > 0 && content[a - 1] !== '\n') a--;
        let b = index;
        while (b < content.length && content[b] !== '\n') b++;
        return [a, Math.min(content.length, b + 1)];
    }
    let empty = null;
    function emptyImage() {
        if (!empty) empty = new OffscreenCanvas(1, 1);
        return empty;
    }
    const colorCss = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
    function withAlpha(css, alpha) {
        const probe = document.createElement('span');
        probe.style.color = css;
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color.match(/[\d.]+/g) || [10, 132, 255];
        probe.remove();
        return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    }

    CB.registerTool({
        id: 'type',
        title: 'Type (T)',
        key: 'KeyT',
        icon: 'text',
        create: (board) => new TypeTool(board),
    });

    // The Layers panel opens text from a row's thumbnail through board.editText (media/layers.js), and the Move tool's
    // double-click through openTextAt; both exist once the board does.
    window.addEventListener('DOMContentLoaded', () => {
        const board = window.board;
        if (!board) return;
        board.editText = (id) => board.toolModule('type').editLayer(id);
        board.openTextAt = (point, e) => board.toolModule('type').openAt(point, e);
    });

    CB.TextModel = {
        DEFAULTS, isValid, boxIsValid, lineHeight, colorAt, setColor, fontAt, uniformFontName, setFont, replaceCharacters, layerName,
        clean, linesOf, hitIndex, selectionRects, lineFor, wordRange, paragraphRange,
    };
})();
