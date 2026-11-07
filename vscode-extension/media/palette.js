'use strict';
// Search Commands (upstream UI/CommandPalette.swift, UI/CommandPaletteView.swift): every menu item by its path, the two
// layer-mask commands and the tool entries, ranked by Compositor's fuzzy score. Specification: docs/port-specs/chrome.md
// section 15. Mixed into the Board.

(function () {
    const CB = (window.CB = window.CB || {});

    const isLetter = (c) => /\p{L}/u.test(c), isNumber = (c) => /\p{N}/u.test(c), isSpace = (c) => /\s/u.test(c);

    // CommandPalette.score (:33-98): letters in order, word starts and runs score higher; five tiers by how the query
    // sits in the title.
    function score(query, text) {
        const wanted = Array.from(query.toLowerCase()).filter((c) => !isSpace(c));
        if (!wanted.length) return 0;
        const letters = Array.from(text.toLowerCase());
        let total = 0, from = 0, previous = -2;
        for (const ch of wanted) {
            const found = letters.indexOf(ch, from);
            if (found < 0) return null;
            const wordStart = found === 0 || !(isLetter(letters[found - 1]) || isNumber(letters[found - 1]));
            total += 1 + (wordStart ? 8 : 0) + (found === previous + 1 ? 5 : 0);
            previous = found;
            from = found + 1;
        }
        const title = letters.join(''), phrase = query.toLowerCase().replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');
        const words = phrase.split(' ').filter(Boolean);
        let tier;
        if (wordsStartWords([phrase], title)) tier = 5;
        else if (words.length > 1 && wordsStartWords(words, title)) tier = 4;
        else if (title.includes(phrase)) tier = 3;
        else if (title.replaceAll(' ', '').includes(wanted.join(''))) tier = 2;
        else tier = 1;
        return tier * 1000000 + (tier === 1 ? total * 100 : 0) - Math.floor(letters.length / 4);
    }

    // Each word, in order, occurs where the previous character is not a letter; the next word is searched after it.
    function wordsStartWords(words, title) {
        let from = 0;
        for (const word of words) {
            let found = -1, search = from;
            for (let at = title.indexOf(word, search); at >= 0; at = title.indexOf(word, search)) {
                if (at === 0 || !isLetter(title[at - 1])) { found = at + word.length; break; }
                search = at + 1;
            }
            if (found < 0) return false;
            from = found;
        }
        return true;
    }

    // Enabled entries first; then the original order for an empty query or equal scores, else the higher score.
    function rank(entries, query) {
        return entries.map((e, i) => ({ e, s: score(query, e.title), i })).filter((r) => r.s !== null)
            .sort((a, b) => (a.e.isEnabled !== b.e.isEnabled ? (a.e.isEnabled ? -1 : 1)
                : (query === '' || a.s === b.s) ? a.i - b.i : b.s - a.s)).map((r) => r.e);
    }

    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const titleOf = (item) => (typeof item.label === 'function' ? item.label() : item.label);

    // Re-locates a menu item when it runs: down the submenu titles, then the n-th plain item with that title.
    function locate(menus, titles, occurrence) {
        let items = (menus.find((m) => m.title === titles[0]) || {}).items;
        for (const t of titles.slice(1, -1)) {
            const sub = items && items.find((i) => i && i.submenu && titleOf(i) === t);
            items = sub && sub.submenu;
        }
        if (!items) return null;
        const last = titles[titles.length - 1];
        return items.filter((i) => i && !i.submenu && titleOf(i) === last)[occurrence] || null;
    }

    const Palette = {
        // CommandPaletteMenu.entries + layerCommands + tools (CommandPalette.swift:104-227).
        paletteEntries() {
            const out = [], seen = new Map();
            const walk = (items, path) => {
                const sameTitle = new Map();
                for (const item of items) {
                    if (!item) continue;
                    const title = titleOf(item);
                    if (!title || item.hidden || title === 'Search Commands…') continue;
                    if (item.submenu) { walk(item.submenu, [...path, title]); continue; }
                    const titles = [...path, title], full = titles.join(' › ');
                    const occurrence = sameTitle.get(title) || 0;
                    sameTitle.set(title, occurrence + 1);
                    const count = seen.get(full) || 0;
                    seen.set(full, count + 1);
                    out.push({
                        id: count === 0 ? full : `${full} (${count + 1})`, title: full,
                        shortcut: item.def ? CB.Shortcuts.labelFor(item.def) : item.shortcut || '',
                        isEnabled: item.enabled ? Boolean(item.enabled()) : true,
                        isOn: Boolean(item.checked && item.checked()),
                        perform: () => {
                            const found = locate(this.menus(), titles, occurrence);
                            if (found && (!found.enabled || found.enabled())) found.run();
                            else CB.beep();
                        },
                    });
                }
            };
            for (const menu of this.menus()) walk(menu.items, [menu.title]);
            return [...out, ...this.paletteLayerCommands(), ...this.paletteTools()];
        },

        // "Layer › Add Layer Mask" and "(Hide All)", named for the selection when there is one (:175-185).
        paletteLayerCommands() {
            const active = this.activeLayer();
            const enabled = Boolean(active) && this.canEditMask() && !active.maskFile;
            const selected = this.hasPixelsSelected();
            return [
                { id: 'mask.reveal', title: selected ? 'Layer › Add Layer Mask from Selection' : 'Layer › Add Layer Mask', shortcut: '', isEnabled: enabled, isOn: false, perform: () => this.addMask(true) },
                { id: 'mask.hide', title: selected ? 'Layer › Add Layer Mask Hiding Selection' : 'Layer › Add Layer Mask (Hide All)', shortcut: '', isEnabled: enabled, isOn: false, perform: () => this.addMask(false) },
            ];
        },

        // The tool entries (:193-226), only for tools the board has; the shown key is the letter itself.
        paletteTools() {
            const st = this.selectTools;
            const list = [
                ['Move / Transform', 'V', 'move'],
                ['Rectangular Marquee', 'M', 'marquee', () => { st.options.marqueeKind = 'Rectangle'; }],
                ['Elliptical Marquee', 'M', 'marquee', () => { st.options.marqueeKind = 'Ellipse'; }],
                ['Lasso', 'L', 'lasso', () => { st.options.lassoKind = 'Freehand'; }],
                ['Polygonal Lasso', 'L', 'lasso', () => { st.options.lassoKind = 'Polygonal'; }],
                ['Magic Wand', 'W', 'wand', () => { st.options.wandMode = 'Wand'; }],
                ['Object Selection', 'W', 'wand', () => { st.options.wandMode = 'Object'; }],
                ['Crop', 'C', 'crop'],
                ['Brush', 'B', 'brush', () => { this.brushMode = 'paint'; }],
                ['Eraser', 'E', 'brush', () => { this.brushMode = 'erase'; }],
                ['Spot Healing Brush', 'J', 'spotHealing'],
                ['Clone Stamp', 'S', 'cloneStamp'],
                ['Liquify', 'R', 'blur', 'Liquify'],
                ['Blur', 'R', 'blur', 'Blur'],
                ['Smudge', 'R', 'blur', 'Smudge'],
                ['Gradient', 'G', 'gradient'],
                ['Rectangle', 'U', 'shape', () => { this.shape.kind = 'Rectangle'; }],
                ['Ellipse', 'U', 'shape', () => { this.shape.kind = 'Ellipse'; }],
                ['Line', 'U', 'shape', () => { this.shape.kind = 'Line'; }],
                ['Type', 'T', 'type'],
                ['Eyedropper', 'I', 'eyedropper'],
                ['Hand', 'H', 'hand'],
                ['Zoom', 'Z', 'zoom'],
                ['Note for Claude', 'N', 'note'],
            ];
            const available = (id) => ['move', 'marquee', 'lasso', 'wand', 'brush', 'shape', 'eyedropper', 'note', 'hand', 'zoom'].includes(id) || CB.toolSpecs.has(id);
            return list.filter(([, , tool]) => available(tool)).map(([name, key, tool, mode]) => ({
                id: `tool.${name}`, title: `Tool › ${name}`, shortcut: key, isEnabled: Boolean(this.doc.manifest), isOn: false,
                perform: () => {
                    this.selectTool(tool);
                    // The mode is set only if the switch happened.
                    if (this.tool !== tool) return;
                    if (typeof mode === 'function') mode();
                    else if (typeof mode === 'string') { const m = this.toolModule(tool); if (m && m.setMode) m.setMode(mode); }
                    this.toolChanged();
                },
            }));
        },

        togglePalette() {
            if (this.paletteEl) { this.closePalette(); return; }
            this.openPalette();
        },

        openPalette() {
            this.closeMenus();
            this.menuBar.close();
            const el = document.createElement('div');
            el.className = 'palette';
            el.setAttribute('role', 'dialog');
            el.innerHTML = '<input type="text" placeholder="Search commands and tools" aria-label="Search commands and tools"><div class="palette-list" role="listbox"></div>';
            document.getElementById('app').appendChild(el);
            this.paletteEl = el;
            // Entries are read afresh at each open, so titles, enabling and checks are current.
            const entries = this.paletteEntries();
            const input = el.querySelector('input'), list = el.querySelector('.palette-list');
            let query = '', chosen = 0, shown = rank(entries, query);
            const render = () => {
                list.innerHTML = shown.length ? shown.map((e, i) => `<div class="palette-row${i === chosen ? ' chosen' : ''}${e.isEnabled ? '' : ' disabled'}" role="option" aria-selected="${i === chosen}" data-index="${i}">${e.isOn ? '<span class="palette-check">✓</span>' : ''}<span class="palette-title">${escape(e.title)}</span>${e.shortcut ? `<span class="palette-shortcut">${escape(e.shortcut)}</span>` : ''}</div>`).join('')
                    : '<div class="palette-empty">No commands match</div>';
                const row = list.querySelector('.chosen');
                if (row) row.scrollIntoView({ block: 'nearest' });
            };
            const run = (entry) => {
                // A disabled entry beeps and the palette stays open.
                if (!entry.isEnabled) { CB.beep(); return; }
                this.closePalette();
                this.focusCanvas();
                setTimeout(() => entry.perform(), 0);
            };
            input.addEventListener('input', () => {
                if (input.value === query) return;
                query = input.value;
                shown = rank(entries, query);
                chosen = 0;
                render();
            });
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                const S = CB.Shortcuts;
                if (S.same(S.chordFromEvent(e), S.chordFor('Search Commands'))) { e.preventDefault(); this.closePalette(); this.focusCanvas(); return; }
                const n = shown.length;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (n) chosen = (((chosen + (e.key === 'ArrowDown' ? 1 : -1)) % n) + n) % n;
                    render();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (shown[chosen]) run(shown[chosen]);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.closePalette();
                    this.focusCanvas();
                }
            });
            list.addEventListener('click', (e) => {
                const row = e.target.closest('.palette-row');
                if (row) run(shown[Number(row.dataset.index)]);
            });
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            // It closes when it loses the keyboard, as the panel resigning key does.
            el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) setTimeout(() => { if (this.paletteEl === el && !el.contains(document.activeElement)) this.closePalette(); }, 0); });
            this.paletteCloser = () => this.closePalette();
            window.addEventListener('pointerdown', this.paletteCloser);
            window.addEventListener('blur', this.paletteCloser);
            render();
            requestAnimationFrame(() => input.focus());
        },

        closePalette() {
            if (!this.paletteEl) return;
            this.paletteEl.remove();
            this.paletteEl = null;
            window.removeEventListener('pointerdown', this.paletteCloser);
            window.removeEventListener('blur', this.paletteCloser);
        },
    };

    CB.Palette = Palette;
    CB.PaletteScore = { score, rank };
})();
