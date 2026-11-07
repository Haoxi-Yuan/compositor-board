'use strict';
// Compositor's keyboard shortcuts (upstream UI/KeyboardShortcuts.swift): the chord model, the 119 remappable
// definitions in their order, the person's overrides, the translation of remapped canvas keys back to the keys the
// board's handlers know, the conflict rules, and the Keyboard Shortcuts editor. Specification: docs/port-specs/chrome.md
// section 16.

(function () {
    const CB = (window.CB = window.CB || {});

    // ---------------------------------------------------------------------------------------------------------------
    // Chords (ShortcutChord, KeyboardShortcuts.swift:4-74): bits 1 = ⌘, 2 = ⌥, 4 = ⌃, 8 = ⇧; key "" means None.

    const SPECIAL = {
        Backspace: '\x7f', Delete: '\x7f', Enter: '\r', NumpadEnter: '\r', Escape: '\x1b', Tab: '\t', Space: ' ',
        ArrowLeft: '', ArrowRight: '', ArrowDown: '', ArrowUp: '',
    };
    const FOLD = { '{': '[', '}': ']', '+': '=', '_': '-' };
    const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);
    // The unshifted character of each key on a US layout, for keys the layout map does not give.
    const US_BASE = {
        Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: '\'',
        Comma: ',', Period: '.', Slash: '/', Backquote: '`', IntlBackslash: '§',
        NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.', NumpadEqual: '=',
    };
    for (let i = 0; i < 26; i++) US_BASE[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i);
    for (let i = 0; i < 10; i++) { US_BASE[`Digit${i}`] = String(i); US_BASE[`Numpad${i}`] = String(i); }
    const US_SHIFTED = {
        1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')', '-': '_', '=': '+', '[': '{',
        ']': '}', '\\': '|', ';': ':', '\'': '"', ',': '<', '.': '>', '/': '?', '`': '~',
    };
    // The keys a chord's character comes from, for the event a translated chord stands for.
    const CODE_OF = {
        '\x7f': 'Backspace', '\r': 'Enter', '\x1b': 'Escape', '\t': 'Tab', ' ': 'Space',
        '': 'ArrowLeft', '': 'ArrowRight', '': 'ArrowDown', '': 'ArrowUp',
    };
    for (const [code, ch] of Object.entries(US_BASE)) if (!code.startsWith('Numpad') && !CODE_OF[ch]) CODE_OF[ch] = code;

    let layout = null;
    // The person's keyboard layout, so a key reads as the character it types (KeyboardShortcuts uses
    // charactersIgnoringModifiers); the US table when the webview cannot tell.
    if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
        navigator.keyboard.getLayoutMap().then((map) => { layout = map; }, () => {});
    }

    function chordFromEvent(e) {
        if (!e || MODIFIER_KEYS.has(e.key)) return null;
        const modifiers = (e.metaKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
        let key = SPECIAL[e.code];
        if (key === undefined) {
            const base = (layout && !e.code.startsWith('Numpad') && layout.get(e.code)) || US_BASE[e.code] || '';
            const typed = e.shiftKey ? (US_SHIFTED[base] !== undefined ? US_SHIFTED[base] : base.toUpperCase()) : base;
            key = typed.toLowerCase();
            if (FOLD[key] !== undefined) key = FOLD[key];
        }
        // A key that types nothing (F1, a dead key) is no chord: the board leaves it to VS Code.
        if (!key) return null;
        return { key, modifiers };
    }

    const LABEL = { '\x7f': 'Delete', '\r': 'Return', '\x1b': 'Esc', '\t': 'Tab', ' ': 'Space', '': '←', '': '→', '': '↓', '': '↑' };
    const label = (c) => (!c || !c.key ? 'None' : (c.modifiers & 4 ? '⌃' : '') + (c.modifiers & 2 ? '⌥' : '') + (c.modifiers & 8 ? '⇧' : '')
        + (c.modifiers & 1 ? '⌘' : '') + (LABEL[c.key] !== undefined ? LABEL[c.key] : c.key.toUpperCase()));
    // An unassigned chord (no key) never matches: it is None, not a key (ShortcutChord.isNone).
    const same = (a, b) => Boolean(a && b && a.key && b.key) && a.key === b.key && a.modifiers === b.modifiers;

    // ---------------------------------------------------------------------------------------------------------------
    // Definitions (ShortcutDefinition.all, KeyboardShortcuts.swift:83-143), in order.

    const DEFS = [];
    const def = (title, key, modifiers = 0, group = 'Canvas & Layers') => DEFS.push({ title, group, id: `${group}:${title}`, original: { key, modifiers } });
    const menu = (title, key, modifiers) => def(title, key, modifiers, 'Menus');
    menu('Undo', 'z', 1); menu('Redo', 'z', 9);
    menu('New Canvas', 'n', 1); menu('Open Project', 'o', 1);
    menu('Save', 's', 1); menu('Save As', 's', 9);
    menu('Export JPEG', 's', 11); menu('Export PNG', 'e', 9); menu('Export As', 'w', 11);
    menu('Close Project', 'w', 1); menu('Fit Canvas', '0', 1); menu('Search Commands', 'f', 1);
    menu('Actual Pixels', '1', 1); menu('Zoom In', '=', 1);
    menu('Zoom Out', '-', 1); menu('Show Transform Controls', 'h', 1);
    menu('Hide Compositor', 'h', 3); menu('Cut', 'x', 1);
    menu('Copy', 'c', 1); menu('Copy Merged', 'c', 9);
    menu('Paste', 'v', 1); menu('Fill with Foreground', '\x7f', 2);
    menu('Fill with Background', '\x7f', 1); menu('Content-Aware Fill', '\x7f', 8);
    menu('Select All', 'a', 1); menu('Deselect', 'd', 1);
    menu('Inverse Selection', 'i', 9); menu('Select Subject', 'a', 3);
    menu('Last Filter', 'f', 5); menu('Curves', 'm', 1); menu('Levels', 'l', 1);
    menu('Hue/Saturation', 'u', 1); menu('Invert Pixels / Mask', 'i', 1);
    menu('Canvas Size', 'c', 3); menu('Image Size', 'i', 3);
    menu('Transform Layer / Selection', 't', 1); menu('Duplicate / Layer via Copy', 'j', 1);
    menu('Toggle Clipping Mask', 'g', 3); menu('Group Layers', 'g', 1);
    menu('Ungroup Layers', 'g', 9);
    menu('New Blank Layer', 'n', 9); menu('Move Layer Up', ']', 1);
    menu('Move Layer Down', '[', 1); menu('Merge Layers', 'e', 1);
    // Board additions, not in Compositor: the layer lock, at Photoshop's Lock All chord.
    menu('Lock / Unlock Layer', '/', 1);
    menu('Show Grid', '\'', 1); menu('Show Guides', ';', 1);
    menu('Show Rulers', 'r', 1); menu('Snap', ';', 9);
    menu('Lock Guides', ';', 3);
    // No key by default, so they aren't hit by mistake; Photoshop's are ⌘Y and ⇧⌘Y.
    menu('CMYK Proof Colors', '', 0);
    menu('CMYK Gamut Warning', '', 0);
    for (const [title, key] of [['Toggle Fullscreen: the canvas alone on black (Esc also leaves)', 'f'], ['Select tool', 'a'], ['Move / Transform tool', 'v'], ['Hand tool', 'h'],
        ['Zoom tool', 'z'], ['Brush tool', 'b'], ['Eraser', 'e'], ['Spot Healing', 'j'],
        ['Clone Stamp', 's'], ['Type tool', 't'], ['Gradient tool', 'g'], ['Shape tool', 'u'],
        ['Eyedropper tool', 'i'], ['Marquee / cycle shape', 'm'], ['Magic', 'w'],
        ['Lasso / cycle mode', 'l'], ['Blur / Smudge / Liquify', 'r'], ['Crop tool', 'c'],
        ['Swap foreground/background', 'x'], ['Reset colors', 'd'], ['Cycle tool mode', '\t'],
        ['Temporary Hand tool (hold)', ' '], ['Delete selection / layer / effect / lasso point', '\x7f'],
        ['Apply current canvas operation', '\r'], ['Cancel current canvas operation', '\x1b'],
        ['Decrease brush size', '['], ['Increase brush size', ']']]) def(title, key);
    def('Decrease brush hardness', '[', 8); def('Increase brush hardness', ']', 8);
    def('Previous blend mode', '-', 8); def('Next blend mode', '=', 8);
    def('Cycle shape kind', 'u', 8);
    for (let digit = 0; digit <= 9; digit++) def(`Opacity digit ${digit} (type two for exact %)`, String(digit));
    for (const [direction, key] of [['Left', ''], ['Right', ''], ['Up', ''], ['Down', '']]) {
        def(`Nudge ${direction} 1 px`, key); def(`Nudge ${direction} 10 px`, key, 8);
        def(`Move selected pixels ${direction} 1 px`, key, 1); def(`Move selected pixels ${direction} 10 px`, key, 9);
    }
    def('Finish editing text', '\r', 1, 'Text Editing');
    for (const [title, key] of [['Decrease tracking', ''], ['Increase tracking', ''], ['Decrease leading', ''], ['Increase leading', '']]) {
        def(title, key, 2, 'Text Editing');
        def(`${title} by 10`, key, 10, 'Text Editing');
    }
    def('Toggle Levels preview', 'p', 2);
    const GROUPS = ['Menus', 'Canvas & Layers', 'Text Editing'];
    const byID = new Map(DEFS.map((d) => [d.id, d]));

    // ---------------------------------------------------------------------------------------------------------------
    // The person's overrides (ShortcutSettings)

    let overrides = {};

    // ShortcutSettings.problem(in:) (KeyboardShortcuts.swift:198-214), in definition order.
    function problem(values) {
        const assigned = new Map();
        for (const d of DEFS) {
            const c = values[d.id] || d.original;
            if (!c.key) continue;
            if (Array.from(c.key).length !== 1 || !(c.modifiers >= 0 && c.modifiers <= 15)) return 'Choose a single key with optional modifiers.';
            if (d.group === 'Text Editing' && (c.modifiers & 7) === 0) return 'Text-editing shortcuts need Command, Option, or Control so they do not replace normal typing.';
            if ([['q', 1], [',', 1], ['m', 3]].some(([k, m]) => c.key === k && c.modifiers === m)) return `${label(c)} is reserved by macOS.`;
            const k = `${c.key}\u0000${c.modifiers}`;
            if (assigned.has(k)) return `${label(c)} is assigned to both ${assigned.get(k)} and ${d.title}.`;
            assigned.set(k, d.title);
        }
        return null;
    }

    // Saved shortcuts are taken one at a time, in id order, keeping each that still fits (ShortcutSettings.init).
    function load(json) {
        let saved = {};
        try { saved = json ? JSON.parse(json) : {}; } catch { saved = {}; }
        const accepted = {};
        for (const id of Object.keys(saved || {}).sort()) {
            const c = saved[id];
            if (!byID.has(id) || !c || typeof c.key !== 'string' || !Number.isInteger(c.modifiers)) continue;
            const trial = { ...accepted, [id]: { key: c.key, modifiers: c.modifiers } };
            if (!problem(trial)) Object.assign(accepted, { [id]: trial[id] });
        }
        overrides = accepted;
    }

    const current = (d) => (d ? overrides[d.id] || d.original : null);
    const find = (title, group) => DEFS.find((d) => d.title === title && (!group || d.group === group)) || null;
    // The chord a definition has now, by title (menu definitions first).
    const chordFor = (title) => current(find(title, 'Menus') || find(title));
    // A menu item's shortcut column: the current chord, or nothing when it has none.
    const labelFor = (title) => {
        const c = title ? chordFor(title) : null;
        return c && c.key ? label(c) : '';
    };
    const isDefault = (title) => { const d = find(title, 'Menus') || find(title); return Boolean(d) && same(current(d), d.original); };

    // canvasEvent (KeyboardShortcuts.swift:218-236): a key that now means another canvas command is read as that
    // command's original key; an original that moved away is swallowed (null); Shift with a remapped letter follows it.
    function canvasChord(input) {
        if (!Object.keys(overrides).length || !input || !input.key) return input;
        const hit = DEFS.find((d) => d.group === 'Canvas & Layers' && same(current(d), input));
        if (hit) return hit.original;
        if (DEFS.some((d) => d.group !== 'Text Editing' && same(d.original, input) && !same(current(d), input))) return null;
        if (input.modifiers === 8) {
            const plain = { key: input.key, modifiers: 0 };
            const base = DEFS.find((d) => d.group !== 'Menus' && d.original.modifiers === 0 && same(current(d), plain));
            if (base) return { key: base.original.key, modifiers: 8 };
            if (DEFS.some((d) => d.group !== 'Menus' && same(d.original, plain) && !same(current(d), plain))) return null;
        }
        return input;
    }

    // textEvent (:238-247): inside the inline text editor, the Text Editing definitions and the Esc definition.
    function textChord(input) {
        if (!Object.keys(overrides).length || !input || !input.key) return input;
        const defs = DEFS.filter((d) => d.group === 'Text Editing' || same(d.original, { key: '\x1b', modifiers: 0 }));
        const hit = defs.find((d) => same(current(d), input));
        if (hit) return hit.original;
        if (defs.some((d) => same(d.original, input) && !same(current(d), input))) return null;
        return input;
    }

    // A keyboard event standing for `chord`, for handlers that read codes and modifier flags. `from` keeps repeat and
    // lets preventDefault/stopPropagation reach the real event.
    function eventFor(chord, from) {
        let code = CODE_OF[chord.key];
        if (!code) code = from.code;
        return {
            code, key: chord.key, repeat: from.repeat, target: from.target,
            metaKey: Boolean(chord.modifiers & 1), altKey: Boolean(chord.modifiers & 2), ctrlKey: Boolean(chord.modifiers & 4), shiftKey: Boolean(chord.modifiers & 8),
            preventDefault: () => from.preventDefault(), stopPropagation: () => from.stopPropagation(),
        };
    }

    // The dialog Apply / Cancel keys follow "Apply current canvas operation" and "Cancel current canvas operation"
    // (ShortcutSettings.native).
    const isApply = (e) => same(chordFromEvent(e), chordFor('Apply current canvas operation'));
    const isCancel = (e) => same(chordFromEvent(e), chordFor('Cancel current canvas operation'));

    // ---------------------------------------------------------------------------------------------------------------
    // Keyboard Shortcuts editor (KeyboardShortcutsSheet, KeyboardShortcuts.swift:256-328)

    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    class ShortcutEditor {
        // `save(json)`: the new overrides as Compositor's JSON; `close()` when the panel goes away.
        constructor(host, { save, close }) {
            this.host = host;
            this.onSave = save;
            this.onClose = close;
            this.draft = { ...overrides };
            this.search = '';
            this.recording = null;
            const el = document.createElement('div');
            el.className = 'floating-panel shortcuts-panel';
            el.setAttribute('role', 'dialog');
            el.innerHTML = `<div class="panel-title">Keyboard Shortcuts<button class="panel-close" title="Close" aria-label="Close">${CB.icon('close')}</button></div>
                <div class="hint secondary">Click a shortcut, then press its new key combination, or ⊗ to remove it. Changes apply when you save.</div>
                <input class="text search" type="text" placeholder="Search shortcuts" aria-label="Search shortcuts">
                <div class="shortcut-list"></div>
                <div class="shortcut-problem"></div>
                <hr>
                <div class="buttons"><button class="pill restore">Restore Defaults</button><span class="spacer"></span><button class="pill cancel">Cancel</button><button class="pill ok prominent">Save</button></div>`;
            host.appendChild(el);
            this.el = el;
            this.list = el.querySelector('.shortcut-list');
            el.querySelector('.search').addEventListener('input', (e) => { this.search = e.target.value; this.render(); });
            el.querySelector('.restore').addEventListener('click', () => { this.recording = null; this.draft = {}; this.render(); });
            el.querySelector('.cancel').addEventListener('click', () => this.close());
            el.querySelector('.panel-close').addEventListener('click', () => this.close());
            el.querySelector('.ok').addEventListener('click', () => this.save());
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            // The editor always uses Return to save and Esc to cancel when not recording.
            el.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (this.recording) return;
                if (e.target.classList.contains('search') && e.key !== 'Enter' && e.key !== 'Escape') return;
                if (e.key === 'Escape') { e.preventDefault(); this.close(); }
                else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); this.save(); }
            });
            this.render();
            el.style.left = `${Math.max(8, (host.clientWidth - el.offsetWidth) / 2)}px`;
            el.style.top = `${Math.max(8, (host.clientHeight - el.offsetHeight) / 2)}px`;
            el.querySelector('.search').focus();
        }

        render() {
            const search = this.search.toLowerCase();
            const rows = [];
            for (const group of GROUPS) {
                rows.push(`<div class="shortcut-group">${escape(group)}</div>`);
                for (const d of DEFS) {
                    if (d.group !== group || (search && !d.title.toLowerCase().includes(search))) continue;
                    const chord = this.draft[d.id] || d.original;
                    const recording = this.recording === d.id;
                    rows.push(`<div class="shortcut-row"><span class="shortcut-title">${escape(d.title)}</span>
                        <span class="recorder-wrap"><button class="recorder${recording ? ' recording' : ''}" data-id="${escape(d.id)}" aria-label="${recording ? 'Press a shortcut' : escape(label(chord))}">${recording ? 'Press keys…' : escape(label(chord))}</button>
                        ${recording && chord.key ? `<button class="recorder-clear" data-id="${escape(d.id)}" title="Remove this shortcut" aria-label="Remove this shortcut">${CB.icon('close')}</button>` : ''}</span></div>`);
                }
            }
            rows.push(`<hr><div class="shortcut-group">Contextual keys &amp; mouse gestures</div>
                <p>Text fields keep standard macOS editing keys. Dialogs share the Apply/Cancel assignments above. Numeric fields use Up/Down, with Shift for larger steps. Standard macOS commands include ⌘Q to quit and ⌃⌘F for full screen. The shortcut editor itself always uses Return to save and Esc to cancel when not recording.</p>
                <p>Option temporarily selects the eyedropper in painting tools. Shift constrains shapes/movement or adds to a selection; Option subtracts from selections or draws from center. Command-drag moves selected pixels; Command-Option-drag copies them. Option-drag duplicates layers/folders/effects; Option-click at a layer boundary toggles clipping. Command-click a thumbnail loads its selection. Control bypasses snapping. Right-drag adjusts brush size. Modifier-and-mouse gestures are fixed.</p>`);
            const scroll = this.list.scrollTop;
            this.list.innerHTML = rows.join('');
            this.list.scrollTop = scroll;
            this.list.querySelectorAll('.recorder').forEach((b) => {
                b.addEventListener('click', () => { this.recording = b.dataset.id; this.render(); });
                b.addEventListener('keydown', (e) => this.record(e, b.dataset.id));
            });
            this.list.querySelectorAll('.recorder-clear').forEach((b) => b.addEventListener('click', () => {
                this.draft = { ...this.draft, [b.dataset.id]: { key: '', modifiers: 0 } };
                this.recording = null;
                this.render();
            }));
            if (this.recording) {
                const active = this.list.querySelector(`.recorder[data-id="${CSS.escape(this.recording)}"]`);
                if (active) active.focus();
            }
            const issue = problem(this.draft);
            const shown = this.el.querySelector('.shortcut-problem');
            shown.textContent = issue || '';
            shown.style.display = issue ? '' : 'none';
            this.el.querySelector('.ok').disabled = Boolean(this.recording || issue);
        }

        // RecorderButton.keyDown: while recording every key counts, Return and Esc too; a key that types more than one
        // character beeps and keeps recording.
        record(e, id) {
            if (this.recording !== id) return;
            e.preventDefault();
            e.stopPropagation();
            const chord = chordFromEvent(e);
            // A modifier alone keeps recording; a key that types no single character beeps.
            if (!chord) { if (!MODIFIER_KEYS.has(e.key)) CB.beep(); return; }
            if (Array.from(chord.key).length !== 1) { CB.beep(); return; }
            this.draft = { ...this.draft, [id]: chord };
            this.recording = null;
            this.render();
        }

        save() {
            if (this.recording || problem(this.draft)) return;
            overrides = { ...this.draft };
            this.onSave(JSON.stringify(overrides));
            this.close();
        }

        close() {
            this.el.remove();
            if (this.onClose) this.onClose();
        }
    }

    // NSSound.beep: a short tone in the webview (chrome.md 1.1).
    let audio = null;
    CB.beep = () => {
        try {
            audio = audio || new AudioContext();
            const osc = audio.createOscillator(), gain = audio.createGain();
            osc.frequency.value = 880;
            gain.gain.value = 0.08;
            osc.connect(gain).connect(audio.destination);
            osc.start();
            osc.stop(audio.currentTime + 0.06);
        } catch { /* no audio */ }
    };

    CB.Shortcuts = {
        DEFS, GROUPS, chordFromEvent, label, same, problem, load, current, find, chordFor, labelFor, isDefault,
        canvasChord, textChord, eventFor, isApply, isCancel, ShortcutEditor,
        get overrides() { return overrides; },
    };
})();
