'use strict';
// The Layers panel (upstream UI/LayersPanel.swift, UI/NativeLayerList.swift, UI/LayerAppearanceControls.swift,
// UI/LayerMaskMenu.swift, UI/BlendModePicker.swift) and the Notes list under it. Layout, gestures and texts follow
// docs/port-specs/layers-masks.md sections 2-5 and 10-16; every edit goes through the board (one undo step each).

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform, Blend, icon } = CB;

    const THUMB = 36, MASK_THUMB = 30;
    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

    // The duplicate, clipping and show-mask cursors (NativeLayerList.swift:594-638), black with a white outline.
    const svgCursor = (body, x, y, fallback) => `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${body}</svg>`)}") ${x} ${y}, ${fallback}`;
    const outline = (paths) => `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="3.4">${paths}</g><g stroke="#000" stroke-width="1.4">${paths}</g></g>`;
    const CURSORS = {
        createClipping: svgCursor(`width="30" height="28">${outline('<path d="M3 3v8a3 3 0 0 0 3 3h6M9 10l3 4-3 4"/><rect x="13" y="2" width="14" height="11" rx="2"/><path d="M20 5v5M17.5 7.5h5"/>')}`, 3, 3, 'pointer'),
        releaseClipping: svgCursor(`width="30" height="28">${outline('<path d="M3 3v8a3 3 0 0 0 3 3h6M9 10l3 4-3 4"/><rect x="13" y="2" width="14" height="11" rx="2"/><path d="M17.5 7.5h5"/>')}`, 3, 3, 'pointer'),
    };

    class LayersPanel {
        constructor(board, root) {
            this.board = board;
            this.root = root;
            this.collapsed = new Set();
            this.anchorID = null;
            this.revealID = null;
            root.innerHTML = `
                <header class="layers-header"><span class="name">Layers</span><span class="count"></span><button class="icon-button drawer-toggle"></button></header>
                <div class="appearance">
                    <label class="caption">Blend</label>
                    <button class="pop blend" aria-label="Blend mode"></button>
                    <label class="caption opacity-scrub">Opacity</label>
                    <input type="range" class="opacity" min="0" max="100" step="any" aria-label="Opacity">
                    <span><input class="num opacity-field" style="width:44px" aria-label="Opacity percent"> <span class="unit">%</span></span>
                </div>
                <div class="layer-list" tabindex="0"></div>
                <footer>
                    <button class="icon-button new-layer" title="New blank layer (⇧⌘N)" aria-label="New blank layer">${icon('plusSquare')}</button>
                    <button class="icon-button new-folder" title="Group selected layers (⌘G)" aria-label="New folder">${icon('folderPlus')}</button>
                    <button class="icon-button add-mask" aria-label="Add layer mask">${icon('maskThumb')}</button>
                    <button class="icon-button add-adjustment" title="New adjustment layer" aria-label="New adjustment layer">${icon('adjust')}</button>
                    <button class="icon-button add-effect" title="Add layer effect" aria-label="Add layer effect">${icon('sparkles')}</button>
                    <button class="icon-button lock-layer" aria-label="Lock layer">${icon('lock')}</button>
                    <span class="spacer"></span>
                    <button class="icon-button delete-layer">${icon('trash')}</button>
                </footer>
                <div class="notes-resizer" title="Drag to resize Notes for Claude; double-click for the automatic height"></div>
                <section class="notes">
                    <header><span class="name">Notes for Claude</span><span class="tools">
                        <label class="check" style="color:var(--text2);font-size:11px"><input type="checkbox" class="show-resolved"> Resolved</label>
                    </span></header>
                    <div class="note-target-row"><span class="caption">Edit target</span><button class="note-target" aria-label="Edit target"></button></div>
                    <div class="note-target-row"><span class="caption">Send to</span><button class="note-target note-session" aria-label="Claude session"></button></div>
                    <div class="note-list"></div>
                </section>`;
            this.list = root.querySelector('.layer-list');
            this.noteList = root.querySelector('.note-list');
            this.buildAppearance();
            root.querySelector('.new-layer').addEventListener('click', () => { if (board.canEditLayers()) board.actions.newLayer(); });
            root.querySelector('.new-folder').addEventListener('click', () => board.groupLayers());
            // Option-click adds a black (hiding) mask (UI/LayerMaskMenu.swift:9-11).
            root.querySelector('.add-mask').addEventListener('click', (e) => board.addMask(!e.altKey));
            // The adjustment kinds, without ellipses (UI/LayersPanel.swift:45-49).
            root.querySelector('.add-adjustment').addEventListener('click', (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                board.filters.adjustmentMenu(r.left, r.top - 4 - 26 * CB.Adjust.KINDS.length);
            });
            // The six effects, "<Effect>…" (UI/LayersPanel.swift:50-57).
            root.querySelector('.add-effect').addEventListener('click', (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                board.menu(r.left, r.top - 4 - 26 * CB.Effects.KINDS.length, CB.Effects.KINDS.map(([kind, name]) => ({ label: `${name}…`, run: () => board.addEffect(kind) })));
            });
            root.querySelector('.lock-layer').addEventListener('click', () => board.toggleLock());
            root.querySelector('.delete-layer').addEventListener('click', () => board.deleteLayerOrMask());
            root.querySelector('.show-resolved').addEventListener('change', (e) => {
                board.notes.showResolved = e.target.checked;
                board.redrawOverlay();
                this.renderNotes();
            });
            // The line above Notes for Claude drags the notes taller or shorter, down to their header and up until the
            // layer list is at its 60 px; a double-click gives back the automatic height (at most 40 % of the panel).
            const resizer = root.querySelector('.notes-resizer'), notes = root.querySelector('.notes');
            resizer.addEventListener('pointerdown', (e) => {
                resizer.setPointerCapture(e.pointerId);
                const start = e.clientY, from = notes.getBoundingClientRect().height;
                const most = from + Math.max(0, this.list.getBoundingClientRect().height - 60);
                const least = Math.min(from, notes.querySelector('header').getBoundingClientRect().height);
                resizer.onpointermove = (m) => board.setNotesHeight(Math.min(most, Math.max(least, from - (m.clientY - start))));
                resizer.onpointerup = () => { resizer.onpointermove = null; resizer.onpointerup = null; board.persist(); };
            });
            resizer.addEventListener('dblclick', () => { board.setNotesHeight(null); board.persist(); });
            // The board's edit target: what the notes ask Claude to change. The person's workspace is the default, so it
            // is stored as none.
            root.querySelector('.note-target').addEventListener('click', (e) => this.targetMenu(e.currentTarget, board.noteTarget || { to: 'workspace', files: [] }, (target) => {
                board.noteTarget = target.to === 'workspace' && !target.files.length ? null : target;
                board.saveBoardState();
                this.renderNotes();
            }));
            // The Claude Code session Send to Claude uses for this board, by its chat's title.
            root.querySelector('.note-session').addEventListener('click', (e) => board.claudeSessionMenu(e.currentTarget));
            root.querySelector('.drawer-toggle').addEventListener('click', () => board.toggleDrawer());
            root.querySelector('.layers-header').addEventListener('dblclick', () => board.toggleDrawer());
            this.renderDrawerToggle();
            this.list.addEventListener('contextmenu', (e) => e.preventDefault());
            this.list.addEventListener('dblclick', (e) => this.doubleClick(e));
            this.list.addEventListener('pointerdown', (e) => this.listPointerDown(e));
            this.list.addEventListener('pointermove', (e) => { this.lastPointer = e; this.updateCursor(e); });
            this.list.addEventListener('pointerleave', () => { this.list.style.cursor = ''; this.lastPointer = null; });
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Blend and Opacity (UI/LayerAppearanceControls.swift, UI/BlendModePicker.swift)

        buildAppearance() {
            const board = this.board;
            const blend = this.root.querySelector('.blend');
            blend.addEventListener('click', () => this.openBlendMenu(blend));
            const slider = this.root.querySelector('.opacity');
            const field = this.root.querySelector('.opacity-field');
            // A slider drag previews live and is one undo step, "Layer Opacity", when it ends.
            slider.addEventListener('input', () => board.actions.previewOpacity(board.activeID(), Number(slider.value) / 100));
            slider.addEventListener('change', () => board.actions.commitOpacity());
            field.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    const active = board.activeLayer();
                    const now = active ? (active.opacity === undefined ? 1 : active.opacity) * 100 : 100;
                    const value = Math.min(100, Math.max(0, roundHalfAway(now) + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)));
                    field.value = value;
                    board.actions.previewOpacity(board.activeID(), value / 100);
                    board.actions.commitOpacity();
                } else if (e.key === 'Enter' || e.key === 'Escape') {
                    field.blur();
                    board.focusCanvas();
                }
            });
            // Decimals are kept (setLayerOpacity clamps but does not round); the field then shows the rounded percent.
            field.addEventListener('change', () => {
                const value = Number(field.value);
                if (Number.isFinite(value) && field.value.trim()) {
                    board.actions.previewOpacity(board.activeID(), Math.min(100, Math.max(0, value)) / 100);
                    board.actions.commitOpacity();
                }
                this.renderAppearance();
            });
            // Dragging the caption scrubs 1 % per point, unrounded, one step (UI/NumericScrub.swift).
            const scrub = this.root.querySelector('.opacity-scrub');
            scrub.addEventListener('pointerdown', (e) => {
                const record = board.activeLayer();
                if (!record || !board.canEditOpacity()) return;
                scrub.setPointerCapture(e.pointerId);
                const start = e.clientX, from = (record.opacity === undefined ? 1 : record.opacity) * 100;
                scrub.onpointermove = (m) => board.actions.previewOpacity(record.id, Math.min(100, Math.max(0, from + m.clientX - start)) / 100);
                scrub.onpointerup = () => { scrub.onpointermove = null; scrub.onpointerup = null; board.actions.commitOpacity(); };
            });
        }

        // The 24 modes in their groups; the highlighted one previews on the canvas until the menu closes.
        openBlendMenu(button) {
            const board = this.board, active = board.activeLayer();
            if (!active || !board.canEditAppearance()) return;
            const id = active.id, current = active.blendMode || 'Normal';
            const items = [];
            for (const mode of Blend.MODES) {
                if (Blend.GROUP_STARTS.has(mode)) items.push(null);
                items.push({ label: mode, checked: mode === current, hover: () => this.previewBlend(id, mode), run: () => board.actions.setBlend(id, mode) });
            }
            const box = button.getBoundingClientRect();
            board.menu(box.left, box.bottom + 2, items, () => this.previewBlend(null));
        }

        previewBlend(id, mode) {
            const board = this.board;
            board.blendPreview = id && id === board.activeID() && board.canEditAppearance() ? { id, mode } : null;
            board.renderer.blendPreview = board.blendPreview;
            board.composite.dirty = true;
            board.composite.below = null;
            board.schedule();
        }

        renderAppearance() {
            const board = this.board;
            const active = board.activeLayer();
            const blend = this.root.querySelector('.blend');
            const slider = this.root.querySelector('.opacity');
            const field = this.root.querySelector('.opacity-field');
            blend.disabled = !board.canEditAppearance();
            blend.innerHTML = `<span>${escape((active && active.blendMode) || 'Normal')}</span>${icon('chevronDown')}`;
            slider.disabled = field.disabled = !board.canEditOpacity();
            const opacity = active ? (active.opacity === undefined ? 1 : active.opacity) * 100 : 100;
            slider.value = opacity;
            if (document.activeElement !== field) field.value = roundHalfAway(opacity);
            this.renderFooter();
        }

        // Footer buttons follow layersLookEditable (UI/LayersPanel.swift:35-65); the trash and mask texts follow the target.
        renderFooter() {
            const board = this.board, active = board.activeLayer(), editable = board.layersLookEditable();
            const q = (s) => this.root.querySelector(s);
            q('.new-layer').disabled = !editable;
            q('.new-folder').disabled = !editable;
            q('.add-adjustment').disabled = !editable;
            const mask = q('.add-mask');
            mask.disabled = !editable || board.selectedIDs.size !== 1 || !active || Boolean(active.maskFile);
            mask.title = board.selection ? 'Add layer mask revealing the selection (Option-click to hide it)' : 'Add layer mask (Option-click for a black mask)';
            // Effects only for layers with pixels: not folders, blank or adjustment layers.
            q('.add-effect').disabled = !editable || !board.layerHasPixels(active);
            // Board-only: Lock / Unlock for the selected layers (⌘/).
            const lock = q('.lock-layer'), locked = board.selectionLocked();
            lock.disabled = !board.canToggleLock();
            lock.classList.toggle('on', locked);
            lock.innerHTML = icon(locked ? 'lock' : 'unlock');
            lock.title = locked ? 'Unlock the selected layers (⌘/)' : 'Lock the selected layers so they can’t be painted, moved or deleted (⌘/)';
            lock.setAttribute('aria-label', locked ? 'Unlock layer' : 'Lock layer');
            const trash = q('.delete-layer');
            trash.disabled = !editable || !active;
            const text = board.selectedEffect() ? 'Delete selected effect' : board.isMaskSelected && active && active.maskFile ? 'Delete layer mask'
                : board.selectedIDs.size > 1 ? 'Delete selected layers' : 'Delete selected layer';
            trash.title = text;
            trash.setAttribute('aria-label', text);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Rows

        // Rows top first, folders expanded unless collapsed (LayerGroups.layerRows).
        rows() {
            const layers = this.board.doc.layers || [];
            const byID = new Map(layers.map((l) => [l.id, l]));
            const children = new Map();
            for (const l of layers) {
                const key = l.parentID && byID.has(l.parentID) ? l.parentID : null;
                if (!children.has(key)) children.set(key, []);
                children.get(key).push(l);
            }
            const out = [];
            const visit = (parent, depth, visible) => {
                if (depth > 64) return;
                const siblings = [...(children.get(parent) || [])].reverse();
                for (const l of siblings) {
                    const effective = visible && l.isVisible;
                    out.push({ record: l, depth, visible: effective });
                    if (l.isGroup && !this.collapsed.has(l.id)) visit(l.id, depth + 1, effective);
                }
            };
            visit(null, 0, true);
            return out;
        }

        renderDrawerToggle() {
            const button = this.root.querySelector('.drawer-toggle');
            button.innerHTML = icon(this.board.drawerOpen ? 'chevronDown' : 'chevronUp');
            button.title = this.board.drawerOpen ? 'Hide layers and notes' : 'Show layers and notes';
        }

        // Selection moves the highlight and the target borders; rows are not rebuilt.
        markActive() {
            const board = this.board;
            this.list.querySelectorAll('.row[data-id]').forEach((r) => this.markRow(r, board.doc.layer(r.dataset.id)));
            this.renderAppearance();
        }

        // NativeLayerList.updateTarget (NLL:1079-1086): the accent border on the layer or mask thumbnail of the one active
        // layer; white on the mask while it is viewed alone.
        markRow(row, record) {
            const board = this.board;
            if (!record) return;
            row.classList.toggle('on', board.selectedIDs.has(record.id) && !board.selectTools.floating);
            const single = record.id === board.activeID() && board.selectedIDs.size === 1 && !board.selectTools.floating;
            const thumb = row.querySelector('.thumb'), mask = row.querySelector('.mask-thumb');
            if (thumb) thumb.classList.toggle('target', single && !board.isMaskSelected);
            if (mask) {
                mask.classList.toggle('target', single && board.isMaskSelected);
                mask.classList.toggle('alone', single && board.isMaskSelected && board.viewsMaskAlone);
            }
        }

        render() {
            const board = this.board, doc = board.doc;
            if (!doc.manifest) return;
            const notes = board.notes.list.filter((n) => !n.resolved && !n.replyTo).length;
            this.root.querySelector('.count').textContent = `${doc.layers.length}${notes ? ` · ${notes} note${notes === 1 ? '' : 's'}` : ''}`;
            this.renderAppearance();
            const rows = this.rows();
            if (!rows.length) {
                this.list.innerHTML = `<div class="empty">${icon('layers')}<div class="empty-title">No layers yet</div><div>Import an image or add a blank layer.</div></div>`;
                this.renderNotes();
                return;
            }
            const unrendered = board.unrenderedByLayer();
            const scroll = this.list.scrollTop;
            this.list.innerHTML = '';
            const floating = board.selectTools.floating;
            for (const { record, depth, visible } of rows) {
                if (floating && record.id === floating.sourceID) this.list.appendChild(this.floatingRow(record, floating, depth));
                this.list.appendChild(this.row(record, depth, visible, unrendered));
                for (const [kind] of CB.Effects.KINDS) if (record.effects && record.effects[kind]) this.list.appendChild(this.effectRow(record, kind, depth));
            }
            this.list.scrollTop = scroll;
            if (this.revealID) {
                const row = this.list.querySelector(`.row[data-id="${this.revealID}"]`);
                if (row) row.scrollIntoView({ block: 'nearest' });
                this.revealID = null;
            }
            this.renderNotes();
        }

        row(record, depth, visible, unrendered) {
            const board = this.board, doc = board.doc;
            const row = document.createElement('div');
            row.className = `row${visible ? '' : ' hidden-effective'}`;
            row.dataset.id = record.id;
            const indent = 24 * Math.min(depth, 8) + (record.maskSourceID ? 24 : 0);
            const entry = doc.entry(record.id);
            // Adjustment layers show their kind's symbol (AdjustmentKind.symbol, LayerAdjustment.swift:10-25).
            const thumbIcon = record.isGroup ? 'folder' : record.adjustment ? CB.Adjust.iconName(record.adjustment.kind) : record.text ? 'text' : null;
            const deep = entry.image && entry.image.deep && !record.text && !record.adjustment && !record.isGroup && !record.maskSourceID
                ? (entry.image.deep.startsWith('HDR') ? 'HDR' : '16-Bit') : null;
            const tags = [];
            if (deep) tags.push(`<span class="tag" title="${deep === 'HDR' ? 'HDR layer: keeps light brighter than white, shown as white' : '16-bit layer: keeps 16 bits a channel'}">${deep}</span>`);
            // Board-only: what this board does not draw yet is said out loud.
            if (unrendered.has(record.id)) tags.push(`<span class="tag warn" title="${escape(unrendered.get(record.id))}">not shown here</span>`);
            const sub = this.subtitle(record, entry);
            const linkable = record.maskFile && !record.isGroup && !record.adjustment;
            // Board-only: a lock (layer-ops.js lockedBy), its own or a folder's.
            const lockedBy = board.lockedBy(record);
            const linked = record.maskLinked !== false;
            row.innerHTML = `
                <button class="eye" aria-label="${record.isVisible ? 'Hide' : 'Show'} ${escape(record.name)}">${icon(record.isVisible ? 'eye' : 'eyeOff')}</button>
                <span style="width:${indent}px;flex:none"></span>
                ${record.isGroup ? `<button class="disclosure" aria-label="Expand or collapse folder" title="Expand or collapse folder">${icon(this.collapsed.has(record.id) ? 'chevronRight' : 'chevronDown')}</button>` : ''}
                <div class="thumb" title="${record.text ? 'Editable text layer' : 'Select image pixels'}">${thumbIcon ? `<div class="icon-thumb">${icon(thumbIcon)}</div>` : ''}</div>
                ${linkable ? `<button class="link" title="${linked ? 'Unlink layer and mask to move or transform them separately' : 'Link layer and mask so they move together'}" aria-label="${linked ? 'Unlink' : 'Link'} mask: ${escape(record.name)}">${linked ? icon('link') : ''}</button>` : ''}
                ${record.maskFile ? `<div class="mask-thumb${record.maskEnabled === false ? ' off' : ''}" title="Select layer mask; Option-click to view it alone; Shift-click to enable/disable; Cmd-click to select its black areas (Cmd-Shift adds, Cmd-Option subtracts)" aria-label="Select mask: ${escape(record.name)}"></div>` : ''}
                <div class="labels">
                    <div class="layer-name">${record.maskSourceID ? '↳ ' : ''}${escape(record.name)}</div>
                    <div class="sub"${sub.title ? ` title="${escape(sub.title)}"` : ''}><span class="sub-text">${escape(sub.text)}</span>${tags.join('')}</div>
                </div>
                ${lockedBy ? `<button class="lock${lockedBy === record ? '' : ' inherited'}" title="${lockedBy === record ? 'Locked: click to unlock (⌘/)' : `Locked with the folder “${escape(lockedBy.name)}”`}" aria-label="${lockedBy === record ? 'Unlock' : 'Locked'}: ${escape(record.name)}">${icon('lock')}</button>` : ''}`;
            // The eye and the disclosure wait while the panel looks disabled (NLL:997, 1060); rows stay selectable.
            const editable = board.layersLookEditable();
            row.querySelector('.eye').disabled = !editable;
            if (row.querySelector('.disclosure')) row.querySelector('.disclosure').disabled = !editable;
            if (!thumbIcon) row.querySelector('.thumb').appendChild(this.thumbnail(record));
            if (record.maskFile && entry.mask) row.querySelector('.mask-thumb').appendChild(this.maskThumbnail(record, entry.mask));
            this.markRow(row, record);
            this.bindRow(row, record);
            return row;
        }

        // An effect's sub-row (NativeLayerList.swift:984-991, 1199-1291): an eye that hides or shows it, its name (dimmed
        // when hidden); a click selects it, a double-click opens its panel, Option-drag onto another layer copies it.
        effectRow(record, kind, depth) {
            const board = this.board, name = CB.Effects.NAME[kind];
            const effect = record.effects[kind], on = CB.Effects.enabled(effect);
            const row = document.createElement('div');
            const selected = board.effectSelection && board.effectSelection.layerID === record.id && board.effectSelection.kind === kind && board.activeID() === record.id;
            row.className = `effect-row-item${selected ? ' on' : ''}${on ? '' : ' off'}`;
            row.dataset.effectOf = record.id;
            row.title = `Click to select; double-click to edit; Option-drag to copy ${name.toLowerCase()}`;
            const indent = 38 + 24 * Math.min(depth, 8) + (record.maskSourceID ? 24 : 0);
            row.innerHTML = `<button class="effect-eye" aria-label="${on ? 'Hide' : 'Show'} ${escape(name)}">${icon(on ? 'eye' : 'eyeOff')}</button>
                <span style="width:${indent - 26}px;flex:none"></span><span class="effect-name">${escape(name)}</span>`;
            const eye = row.querySelector('.effect-eye');
            eye.disabled = !board.layersLookEditable();
            eye.addEventListener('click', (e) => { e.stopPropagation(); board.toggleEffect(kind, record.id); });
            row.addEventListener('dblclick', () => board.selectEffect(kind, record.id, true));
            row.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || e.target.closest('.effect-eye')) return;
                board.selectEffect(kind, record.id);
                if (!e.altKey) return;
                // Option-drag past 3 points copies the effect onto the row it is dropped on.
                const start = { x: e.clientX, y: e.clientY };
                let dragging = false;
                const move = (m) => {
                    if (!dragging && Math.hypot(m.clientX - start.x, m.clientY - start.y) >= 3) { dragging = true; document.body.style.cursor = 'copy'; }
                    if (!dragging) return;
                    this.list.querySelectorAll('.row.drop-into').forEach((r) => r.classList.remove('drop-into'));
                    const target = document.elementFromPoint(m.clientX, m.clientY);
                    const over = target && target.closest('.row[data-id]');
                    if (over && board.canCopyEffect(kind, record.id, over.dataset.id)) over.classList.add('drop-into');
                };
                const up = (u) => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                    document.body.style.cursor = '';
                    this.list.querySelectorAll('.row.drop-into').forEach((r) => r.classList.remove('drop-into'));
                    if (!dragging) return;
                    const target = document.elementFromPoint(u.clientX, u.clientY);
                    const over = target && target.closest('.row[data-id]');
                    if (over) board.copyEffect(kind, record.id, over.dataset.id);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
            });
            return row;
        }

        // NativeLayerList subtitle (NLL:1047, 1053-1057, 1474-1481): the later rule wins.
        subtitle(record, entry) {
            const board = this.board;
            let text;
            if (record.text) text = 'Text · Double-click to edit';
            else if (record.adjustment) text = 'Adjustment · Double-click to edit';
            else if (record.isGroup) text = 'Folder';
            else {
                const t = Transform.read(record.transform, [board.doc.width, board.doc.height]);
                text = `${Math.round(t.width)} × ${Math.round(t.height)} px`;
                if (entry.image && Math.abs((t.width / entry.image.width) * 100 - 100) >= 0.05) text += ` · ${percent.format((t.width / entry.image.width) * 100)}%`;
            }
            if (record.maskSourceID) {
                const base = board.doc.layer(record.maskSourceID);
                const name = base ? base.name : 'Missing source';
                return { text: `Clipped to ${name}`, title: `Clipping mask based on ${name}. Option-click the bottom of its row to release.` };
            }
            return { text };
        }

        // Transform Selection lifts the pixels onto a temporary layer right above their source, active until the
        // transform is applied or cancelled (FloatingSelection.swift).
        floatingRow(source, floating, depth) {
            const row = document.createElement('div');
            row.className = 'row on floating';
            row.title = 'Return applies the transform; Escape puts the pixels back';
            const pseudo = { id: '__floating', name: 'Floating Selection', transform: CB.Transform.write(floating.draft), isVisible: true };
            this.board.doc.entry('__floating').image = floating.image;
            row.innerHTML = `
                <button class="eye" disabled>${icon('eye')}</button>
                <span style="width:${24 * Math.min(depth, 8)}px;flex:none"></span>
                <div class="thumb target"></div>
                <div class="labels">
                    <div class="layer-name">Floating Selection</div>
                    <div class="sub">${floating.image.width} × ${floating.image.height} px</div>
                </div>`;
            row.querySelector('.thumb').appendChild(this.thumbnail(pseudo));
            return row;
        }

        // The whole canvas in small (fitted into 36 pt), the layer drawn where it sits, on a 0.22 / 0.32 checkerboard of
        // 6 pt tiles, the lighter tile at the top left (UI/CanvasThumbnail.swift:10-33).
        thumbnail(record) {
            const doc = this.board.doc;
            const ratio = THUMB / Math.max(doc.width, doc.height);
            const w = Math.max(1, Math.round(doc.width * ratio)), h = Math.max(1, Math.round(doc.height * ratio));
            const dpr = window.devicePixelRatio || 1;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#383838';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const cell = 6 * dpr;
            ctx.fillStyle = '#525252';
            for (let y = 0, row = 0; y < canvas.height; y += cell, row++) {
                for (let x = 0, col = 0; x < canvas.width; x += cell, col++) if ((row + col) % 2 === 0) ctx.fillRect(x, y, cell, cell);
            }
            const image = doc.entry(record.id).image;
            if (image) {
                const t = Transform.read(record.transform, [doc.width, doc.height]);
                const m = Transform.pixelToDocument(t, image.width, image.height);
                const s = canvas.width / doc.width;
                ctx.setTransform(m.a * s, m.b * s, m.c * s, m.d * s, m.e * s, m.f * s);
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(image, 0, 0);
            }
            return canvas;
        }

        // The mask where it sits on a canvas-shaped 30 pt box, its edge tone beyond (UI/CanvasThumbnail.swift:38-44).
        maskThumbnail(record, mask) {
            const doc = this.board.doc, dpr = window.devicePixelRatio || 1;
            const scale = MASK_THUMB / Math.max(doc.width, doc.height);
            const w = Math.max(1, Math.round(doc.width * scale)), h = Math.max(1, Math.round(doc.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            const ctx = canvas.getContext('2d');
            const bg = CB.Render.maskBackground(mask) ? 255 : 0;
            ctx.fillStyle = `rgb(${bg},${bg},${bg})`;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const t = Transform.read(record.maskPlacement || record.transform, [doc.width, doc.height]);
            const m = Transform.pixelToDocument(t, mask.width, mask.height), s = canvas.width / doc.width;
            ctx.setTransform(m.a * s, m.b * s, m.c * s, m.d * s, m.e * s, m.f * s);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(CB.Document.grayCanvas(mask), 0, 0);
            return canvas;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Pointer gestures (NativeLayerList mouseDown, menu(for:), dragging)

        rowAt(clientY) {
            for (const row of this.list.querySelectorAll('.row[data-id]')) {
                const box = row.getBoundingClientRect();
                if (clientY >= box.top && clientY < box.bottom) return row;
            }
            return null;
        }

        // The ⌥-click clipping strip: the bottom min(10 pt, a third) of a non-folder row, not over its mask thumbnail.
        inClippingZone(e, row, record) {
            if (!record || record.isGroup || e.target.closest('.mask-thumb')) return false;
            const box = row.getBoundingClientRect();
            return e.clientY >= box.bottom - Math.min(10, box.height / 3);
        }

        // Middle-button drags scroll the list from anywhere in it (NLL:521-548).
        listPointerDown(e) {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            this.list.setPointerCapture(e.pointerId);
            let last = e.clientY;
            this.list.style.cursor = 'grabbing';
            this.list.onpointermove = (m) => { this.list.scrollTop -= m.clientY - last; last = m.clientY; };
            this.list.onpointerup = () => { this.list.onpointermove = null; this.list.onpointerup = null; this.list.style.cursor = ''; };
        }

        // Modifier changes over the list update its cursor too (NLL:594-738).
        modifiersChanged(e) {
            const p = this.lastPointer;
            if (!p) return;
            this.updateCursor({ target: p.target, clientY: p.clientY, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
        }

        updateCursor(e) {
            const board = this.board;
            const row = e.target.closest('.row[data-id]');
            const record = row && board.doc.layer(row.dataset.id);
            let cursor = '';
            if (record && e.metaKey && !e.altKey && !record.isGroup && e.target.closest('.thumb, .mask-thumb')) cursor = CB.SelectionCursors.loadSelection;
            else if (record && e.altKey && !e.metaKey) {
                if (e.target.closest('.mask-thumb')) cursor = CB.SelectionCursors.showMask;
                else if (this.inClippingZone(e, row, record)) cursor = !board.canToggleClippingMask(record.id) ? 'default' : record.maskSourceID ? CURSORS.releaseClipping : CURSORS.createClipping;
                else if (board.canEditLayers()) cursor = CB.SelectionCursors.duplicate;
            }
            this.list.style.cursor = cursor;
        }

        bindRow(row, record) {
            const board = this.board;
            const eye = row.querySelector('.eye');
            eye.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                if (e.button !== 0) return;
                if (e.altKey && !e.metaKey && this.inClippingZone(e, row, record)) { board.toggleClippingMask(record.id); return; }
                this.beginEyeSwipe(e, record);
            });
            const disclosure = row.querySelector('.disclosure');
            if (disclosure) {
                disclosure.addEventListener('pointerdown', (e) => e.stopPropagation());
                disclosure.addEventListener('click', (e) => { e.stopPropagation(); this.toggleFolder(record); });
            }
            const link = row.querySelector('.link');
            if (link) {
                link.addEventListener('pointerdown', (e) => e.stopPropagation());
                link.addEventListener('click', (e) => { e.stopPropagation(); board.toggleMaskLink(record.id); });
            }
            const lock = row.querySelector('.lock:not(.inherited)');
            if (lock) {
                lock.addEventListener('pointerdown', (e) => e.stopPropagation());
                lock.addEventListener('click', (e) => { e.stopPropagation(); if (board.layersLookEditable()) board.toggleLock([record]); });
            }
            row.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                // ⌥ in the bottom strip toggles clipping for this row, whatever is selected (NLL:736-766).
                if (e.altKey && !e.metaKey && this.inClippingZone(e, row, record)) {
                    e.stopPropagation();
                    board.toggleClippingMask(record.id);
                    this.updateCursor(e);
                    return;
                }
                // ⌘-click a thumbnail loads a selection: the layer's pixels, or a mask's black areas. ⇧ adds, ⌥ subtracts.
                const thumb = e.metaKey && e.target.closest('.thumb, .mask-thumb');
                if (thumb && !record.isGroup) {
                    const mode = e.altKey ? 'Subtract' : e.shiftKey ? 'Add' : 'New';
                    if (thumb.classList.contains('mask-thumb')) board.selectTools.loadMask(record.id, mode);
                    else if (board.doc.entry(record.id).image) board.selectTools.loadLayer(record.id, mode);
                    e.stopPropagation();
                    return;
                }
                const maskThumb = e.target.closest('.mask-thumb');
                if (maskThumb) {
                    e.stopPropagation();
                    if (e.altKey) { this.beginMaskDrag(e, record, maskThumb); return; }
                    board.selectLayerTarget(record.id, true);
                    if (e.shiftKey) board.toggleLayerMask();
                    this.beginDrag(e, row, record);
                    return;
                }
                if (e.target.closest('.thumb') && !e.shiftKey && !e.metaKey) {
                    board.selectLayerTarget(record.id, false);
                    this.anchorID = record.id;
                    this.beginDrag(e, row, record);
                    return;
                }
                this.press(e, record);
                this.beginDrag(e, row, record);
            });
            // A click on the name while the mask is the target goes back to the pixels (NLL:382-391).
            row.querySelector('.labels').addEventListener('click', () => {
                if (board.isMaskSelected && board.selectedIDs.size === 1 && board.selectedIDs.has(record.id)) board.selectLayerTarget(record.id, false);
            });
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.contextMenu(e, record);
            });
        }

        // Row selection: plain, ⇧ range from the anchor, ⌘ toggle (NSTableView, NLL:373-379).
        press(e, record) {
            const board = this.board;
            const ids = this.rows().map((r) => r.record.id);
            if (e.shiftKey && this.anchorID && ids.includes(this.anchorID)) {
                const a = ids.indexOf(this.anchorID), b = ids.indexOf(record.id);
                board.selectLayers(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)), record.id);
            } else if (e.metaKey || e.ctrlKey) {
                const next = new Set(board.selectedIDs);
                if (next.has(record.id) && next.size > 1) next.delete(record.id); else next.add(record.id);
                board.selectLayers(next, next.has(record.id) ? record.id : null);
            } else if (!(board.selectedIDs.has(record.id) && board.selectedIDs.size > 1)) {
                this.anchorID = record.id;
                board.selectLayers(new Set([record.id]), record.id);
            } else {
                // A plain press inside a multi-selection keeps it for a drag; a release without one selects just this row.
                this.pendingSingle = record.id;
                this.anchorID = record.id;
            }
        }

        // ↑ / ↓ with the list focused move the row selection; ⇧ extends it (NSTableView keys, NLL:782-817).
        stepSelection(direction, extend) {
            const board = this.board;
            const ids = this.rows().map((r) => r.record.id);
            const at = ids.indexOf(board.activeID());
            const next = ids[Math.min(ids.length - 1, Math.max(0, (at < 0 ? 0 : at) + direction))];
            if (!next) return;
            if (extend && this.anchorID && ids.includes(this.anchorID)) {
                const a = ids.indexOf(this.anchorID), b = ids.indexOf(next);
                board.selectLayers(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)), next);
            } else {
                this.anchorID = next;
                board.selectLayers(new Set([next]), next);
            }
        }

        // Collapsing a folder that holds the active layer selects the folder (LG:283-290).
        toggleFolder(record) {
            const board = this.board;
            if (board.working) return;
            if (this.collapsed.has(record.id)) this.collapsed.delete(record.id);
            else {
                const active = board.activeLayer();
                if (active && board.descendantIDs(record.id).has(active.id)) board.selectLayer(record.id);
                this.collapsed.add(record.id);
            }
            this.render();
        }

        // The eye: pressing toggles the layer, and every row the pointer passes takes the same state; one step.
        beginEyeSwipe(e, record) {
            const board = this.board;
            if (!board.canEditLayers()) return;
            const visible = !record.isVisible;
            const before = board.doc.snapshot();
            const changed = new Set();
            const apply = (r) => {
                if (!r || r.isVisible === visible) return;
                r.isVisible = visible;
                changed.add(r.id);
                board.composite.dirty = true;
                board.composite.below = null;
                board.schedule();
                this.refreshVisibility();
            };
            apply(record);
            const list = this.list;
            list.setPointerCapture(e.pointerId);
            let scroller = null;
            list.onpointermove = (m) => {
                const row = this.rowAt(m.clientY);
                if (row) apply(board.doc.layer(row.dataset.id));
                const box = list.getBoundingClientRect();
                clearInterval(scroller);
                const edge = m.clientY < box.top + 16 ? -8 : m.clientY > box.bottom - 16 ? 8 : 0;
                if (edge) scroller = setInterval(() => { list.scrollTop += edge; }, 30);
            };
            list.onpointerup = () => {
                list.onpointermove = null;
                list.onpointerup = null;
                clearInterval(scroller);
                if (!changed.size) return;
                board.doc.metaDirty = true;
                board.history.push({ label: visible ? 'Show Layer' : 'Hide Layer', metaBefore: before, metaAfter: board.doc.snapshot(), pixels: [] });
                board.changed();
            };
        }

        // Eye icons and the 35 % dimming of rows hidden through a folder, without rebuilding the rows.
        refreshVisibility() {
            const byRow = new Map(this.rows().map((r) => [r.record.id, r]));
            for (const row of this.list.querySelectorAll('.row[data-id]')) {
                const info = byRow.get(row.dataset.id);
                if (!info) continue;
                row.classList.toggle('hidden-effective', !info.visible);
                const eye = row.querySelector('.eye');
                eye.innerHTML = icon(info.record.isVisible ? 'eye' : 'eyeOff');
                eye.setAttribute('aria-label', `${info.record.isVisible ? 'Hide' : 'Show'} ${info.record.name}`);
            }
        }

        // ⌥ on a mask thumbnail: released in place it shows the mask alone (or the image again); dragged 3 pt or more onto
        // another row it copies the mask there (LM:229-236, 297-317).
        beginMaskDrag(e, record, thumb) {
            const board = this.board;
            const start = { x: e.clientX, y: e.clientY };
            let moved = false, ghost = null, target = null;
            const clear = () => { this.list.querySelectorAll('.drop-into').forEach((r) => r.classList.remove('drop-into')); };
            const move = (m) => {
                if (!moved && (m.clientX - start.x) ** 2 + (m.clientY - start.y) ** 2 < 9) return;
                moved = true;
                if (!ghost) {
                    ghost = thumb.cloneNode(true);
                    ghost.classList.add('drag-ghost');
                    document.body.appendChild(ghost);
                }
                ghost.style.left = `${m.clientX + 6}px`;
                ghost.style.top = `${m.clientY + 6}px`;
                clear();
                const row = this.rowAt(m.clientY);
                target = row && board.canCopyMask(record.id, row.dataset.id) ? row.dataset.id : null;
                if (target) row.classList.add('drop-into');
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                clear();
                if (ghost) ghost.remove();
                if (!moved) board.toggleMaskAlone(record.id);
                else if (target) board.copyMask(record.id, target);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        }

        // Rows dragged above the row under the line, into a folder (its middle third), or past the end; ⌥ at the drop
        // copies (NLL:406-497).
        beginDrag(event, row, record) {
            const board = this.board;
            const startY = event.clientY;
            let dragging = false, target = null, line = null, scroller = null, lastEvent = event;
            const rows = () => [...this.list.querySelectorAll('.row[data-id]')];
            const clear = () => {
                if (line) line.remove();
                line = null;
                rows().forEach((r) => r.classList.remove('drop-into'));
            };
            const dragged = () => {
                // The selected rows when the pressed one is selected, minus what a dragged folder carries, in panel order.
                const chosen = board.selectedIDs.has(record.id) ? board.selectedIDs : new Set([record.id]);
                const carried = new Set();
                for (const id of chosen) for (const d of board.descendantIDs(id)) carried.add(d);
                return this.rows().map((r) => r.record.id).filter((id) => chosen.has(id) && !carried.has(id));
            };
            const place = (e) => {
                clear();
                const ids = dragged();
                const all = rows();
                target = { rowID: null, intoFolder: false };
                let below = null;
                for (const r of all) {
                    const box = r.getBoundingClientRect();
                    if (e.clientY > box.bottom) continue;
                    const over = board.doc.layer(r.dataset.id);
                    const third = box.height / 3;
                    if (over.isGroup && e.clientY > box.top + third && e.clientY < box.bottom - third) {
                        target = { rowID: over.id, intoFolder: true };
                        if (ids.every((id) => board.canPlaceLayer(id, over.id))) r.classList.add('drop-into');
                        else target = null;
                        return;
                    }
                    below = e.clientY < box.top + box.height / 2 ? r : r.nextElementSibling && r.nextElementSibling.dataset.id ? r.nextElementSibling : null;
                    break;
                }
                const parent = below ? board.doc.layer(below.dataset.id).parentID || null : null;
                if (!ids.every((id) => board.canPlaceLayer(id, parent))) { target = null; return; }
                target = { rowID: below ? below.dataset.id : null, intoFolder: false };
                line = document.createElement('div');
                line.className = 'drop-line';
                if (below) this.list.insertBefore(line, below);
                else this.list.appendChild(line);
            };
            const move = (e) => {
                lastEvent = e;
                if (!dragging && Math.abs(e.clientY - startY) < 4) return;
                if (!dragging && !board.canEditLayers()) return;
                dragging = true;
                this.pendingSingle = null;
                place(e);
                this.list.style.cursor = e.altKey ? CB.SelectionCursors.duplicate : '';
                const box = this.list.getBoundingClientRect();
                clearInterval(scroller);
                const edge = e.clientY < box.top + 16 ? -8 : e.clientY > box.bottom - 16 ? 8 : 0;
                if (edge) scroller = setInterval(() => { this.list.scrollTop += edge; place(lastEvent); }, 30);
            };
            const up = (e) => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                clearInterval(scroller);
                clear();
                this.list.style.cursor = '';
                if (dragging && target) board.placeLayers(dragged(), target.rowID, target.intoFolder, e.altKey);
                else if (!dragging && this.pendingSingle) {
                    const id = this.pendingSingle;
                    this.pendingSingle = null;
                    board.selectLayers(new Set([id]), id);
                }
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        }

        // Double-click: a live text or editable adjustment opens from its thumbnail; anything else renames (NLL:392-405).
        doubleClick(e) {
            const board = this.board;
            const row = e.target.closest('.row[data-id]');
            if (!row || !board.canEditLayers()) return;
            const record = board.doc.layer(row.dataset.id);
            if (!record) return;
            board.setActive(record.id);
            const onControl = e.target.closest('.eye, .disclosure, .thumb, .link, .mask-thumb');
            if (onControl && record.text) { if (board.editText) board.editText(record.id); return; }
            // Invert has nothing to edit, so its thumbnail renames like the name does (NLL:400-401).
            if (onControl && record.adjustment && CB.Adjust.isEditable(record.adjustment.kind)) { if (board.editAdjustment) board.editAdjustment(record.id); return; }
            this.rename(row, record);
        }

        renameActive() {
            const board = this.board, record = board.activeLayer();
            if (!record) return;
            this.revealID = record.id;
            this.render();
            this.rename(this.list.querySelector(`.row[data-id="${record.id}"]`), record);
        }

        // Inline rename: trimmed, ignored when empty, one step "Rename Layer"; Escape keeps the old name (NLL:1089-1130).
        rename(row, record) {
            if (!row) return;
            const board = this.board;
            const label = row.querySelector('.layer-name');
            const input = document.createElement('input');
            input.className = 'rename';
            input.value = record.name;
            label.replaceWith(input);
            board.renamingID = record.id;
            input.focus();
            input.select();
            let done = false;
            const finish = (keep) => {
                if (done) return;
                done = true;
                board.renamingID = null;
                const name = input.value.trim();
                if (keep && name && name !== record.name) board.actions.rename(record.id, name);
                else this.render();
                this.list.focus();
            };
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') finish(true);
                if (e.key === 'Escape') finish(false);
            });
            input.addEventListener('blur', () => finish(true));
            input.addEventListener('pointerdown', (e) => e.stopPropagation());
        }

        // Right-click: the row is selected first (its thumbnail picks the target), then Compositor's menu (NLL:119-286).
        contextMenu(e, record) {
            const board = this.board;
            const onMask = e.target.closest('.mask-thumb'), onThumb = e.target.closest('.thumb');
            if (board.selectedIDs.has(record.id)) {
                if (onMask) board.selectLayerTarget(record.id, true);
                else if (onThumb) board.selectLayerTarget(record.id, false);
                else board.selectLayers(board.selectedIDs, record.id);
            } else {
                board.selectLayers(new Set([record.id]), record.id);
                if (onMask) board.selectLayerTarget(record.id, true);
            }
            const active = board.activeLayer();
            if (!active) return;
            const can = board.canEditLayers();
            const image = board.doc.entry(active.id).image;
            const items = [
                { label: 'Duplicate Layer', disabled: !can, run: () => board.duplicateLayers() },
                { label: 'Rename…', disabled: !can || board.selectedIDs.size !== 1, run: () => this.renameActive() },
                { label: board.isMaskSelected && active.maskFile ? 'Delete Mask' : board.selectedIDs.size > 1 ? 'Delete Selected Layers' : 'Delete Layer', disabled: !can, run: () => board.deleteLayerOrMask() },
                null,
                { label: active.maskSourceID ? 'Release Clipping Mask' : 'Create Clipping Mask', disabled: !board.canToggleClippingMask(active.id), run: () => board.toggleClippingMask(active.id) },
                { label: 'Group Selected Layers', disabled: !can || board.doc.layers.length >= 10000 || !board.selectedIDs.size, run: () => board.groupLayers() },
            ];
            if (record.isGroup) items.push({ label: 'Ungroup Layers', disabled: !board.canUngroupLayers(), run: () => board.ungroupLayers() });
            items.push(
                { label: 'Move Out of Folder', disabled: !can || !active.parentID, run: () => board.moveOutOfFolder() },
                { label: board.mergeTitle(), disabled: !board.canMergeLayers(), run: () => board.mergeLayers() },
            );
            if (image && image.deep && image.deep.startsWith('HDR')) items.push({ label: 'Convert to 16-Bit', disabled: !board.canConvertLayerDepth(), run: () => board.convertHDRTo16() });
            items.push(
                { label: image && image.deep ? 'Convert to 8-Bit' : 'Convert to 16-Bit', disabled: !board.canConvertLayerDepth(), run: () => board.convertLayerDepth() },
                null,
                { label: 'Add Mask', disabled: !board.canEditMask() || Boolean(active.maskFile), submenu: [
                    { label: 'Reveal All (White)', disabled: !board.canEditMask() || Boolean(active.maskFile), run: () => { board.selectLayerTarget(active.id, false); board.addMask(true); } },
                    { label: 'Hide All (Black)', disabled: !board.canEditMask() || Boolean(active.maskFile), run: () => { board.selectLayerTarget(active.id, false); board.addMask(false); } },
                ] },
                { label: active.maskEnabled === false ? 'Enable Mask' : 'Disable Mask', disabled: !board.canEditMask() || !active.maskFile, run: () => { board.selectLayerTarget(active.id, false); board.toggleLayerMask(); } },
                { label: 'Delete Mask', disabled: !board.canEditMask() || !active.maskFile, run: () => { board.selectLayerTarget(active.id, false); board.deleteLayerMask(); } },
                { label: active.maskLinked === false ? 'Link Mask' : 'Unlink Mask', disabled: !can || !active.maskFile || active.isGroup || Boolean(active.adjustment), run: () => board.toggleMaskLink(active.id) },
                null,
                { label: active.isVisible ? 'Hide Layer' : 'Show Layer', disabled: !can, run: () => board.actions.setVisible(active.id, !active.isVisible) },
                // Board-only: a lock (layer-ops.js).
                { label: board.selectionLocked() ? 'Unlock Layer' : 'Lock Layer', disabled: !board.canToggleLock(), run: () => board.toggleLock() },
                // Board-only: the same project in the Compositor app.
                null,
                { label: 'Open in Compositor', run: () => board.openInCompositor() },
            );
            board.menu(e.clientX, e.clientY, items);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Notes (board-only: questions and instructions for Claude)

        // An edit target in a few words: the files' names, or which side gets the change.
        targetLabel(target) {
            if (target && target.to === 'board') return 'This board';
            const files = (target && target.files) || [];
            return files.length ? files.map((f) => f.split('/').pop()).join(', ') : 'Workspace (Claude finds the file)';
        }

        targetTitle(target) {
            if (target && target.to === 'board') return 'Claude makes the change on this board';
            const files = (target && target.files) || [];
            return files.length ? `Claude changes these files (relative to the project's folder):\n${files.join('\n')}` : 'Claude changes the file in your workspace that the note is about, and asks you if it cannot tell which';
        }

        // The edit target menu under `anchor`. `own` is the target set here (null: none); a note's menu also offers the
        // board's target (`inherited`), and picking that calls `pick(null)`.
        targetMenu(anchor, own, pick, inherited) {
            const board = this.board;
            const is = (to, files) => Boolean(own) && own.to === to && (to === 'board' || (own.files.length > 0) === files);
            const choose = () => board.fileRequest('pickTargetFiles').then((answer) => {
                if (answer.files) pick({ to: 'workspace', files: answer.files });
            }, (error) => board.toast(error.message));
            const items = [
                { label: 'Workspace: Claude finds the file', checked: is('workspace', false), run: () => pick({ to: 'workspace', files: [] }) },
                { label: 'Workspace: Choose Files\u2026', checked: is('workspace', true), run: choose },
                { label: 'This Board: Claude draws on it', checked: is('board'), run: () => pick({ to: 'board', files: [] }) },
            ];
            if (inherited !== undefined) items.unshift({ label: `The Board\u2019s Target: ${this.targetLabel(inherited)}`, checked: !own, run: () => pick(null) }, null);
            const box = anchor.getBoundingClientRect();
            board.menu(box.left, box.bottom + 2, items);
        }

        // The Send to row: the chat Send to Claude goes to, busy or idle, or that none is running.
        renderSessionRow() {
            const button = this.root.querySelector('.note-session'), sessions = this.board.claudeSessions;
            const s = sessions && sessions.find((x) => x.target);
            const text = !sessions ? 'Looking for Claude sessions\u2026' : s ? `${s.name}${s.status ? ` \u00b7 ${s.status}` : ''}${s.here ? '' : ' \u00b7 other window'}` : 'No Claude session running';
            const title = !sessions ? '' : s ? `Send to Claude sends this board's notes to the chat \u201c${s.name}\u201d ${s.here ? 'in this window' : `in another VS Code window (${s.folder})`}. ${s.pinned ? 'You chose it' : 'It follows the Claude chat tab in front'}. Click to choose another chat.`
                : 'No Claude Code session with the board plugin is running. Start one (restart a session that was already running when the plugin was installed or updated).';
            if (button.dataset.text === text && button.title === title) return;
            button.dataset.text = text;
            button.innerHTML = `<span class="label"></span>${icon('chevronDown')}`;
            button.querySelector('.label').textContent = text;
            button.title = title;
            button.classList.toggle('none', Boolean(sessions) && !s);
        }

        renderNotes() {
            const notes = this.board.notes;
            this.renderSessionRow();
            const button = this.root.querySelector('.note-target');
            button.innerHTML = `<span class="label"></span>${icon('chevronDown')}`;
            button.querySelector('.label').textContent = this.targetLabel(this.board.noteTarget);
            button.title = this.targetTitle(this.board.noteTarget);
            const threads = notes.list.filter((n) => !n.replyTo && (notes.showResolved || !n.resolved));
            if (!threads.length) {
                this.noteList.innerHTML = '<div class="empty" style="padding:10px">Press N and drag on the canvas to point Claude at something.</div>';
                return;
            }
            this.noteList.innerHTML = '';
            for (const note of threads) {
                const card = document.createElement('div');
                card.className = `note-card ${note.author}${note.id === notes.selectedID ? ' on' : ''}${note.resolved ? ' resolved' : ''}`;
                const replies = notes.list.filter((r) => r.replyTo === note.id);
                card.innerHTML = `
                    <div class="who"><b>${notes.number(note)}</b><span>${note.author === 'claude' ? 'Claude' : 'You'}</span></div>
                    <div class="body">${escape(note.text)}</div>
                    ${replies.map((r) => `<div class="reply ${r.author}"><div class="who">${r.author === 'claude' ? 'Claude' : 'You'}</div><div class="body">${escape(r.text)}</div></div>`).join('')}
                    ${note.target ? `<div class="target" title="${escape(this.targetTitle(note.target))}">Edit target: ${escape(this.targetLabel(note.target))}</div>` : ''}
                    ${note.sentTo ? `<div class="sent" title="${escape(new Date(note.sentAt).toLocaleString())}">Sent to ${escape(note.sentTo)} at ${escape(new Date(note.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>` : ''}
                    <div class="actions">
                        <button class="do-reply">Reply</button>
                        <button class="do-resolve">${note.resolved ? 'Reopen' : 'Resolve'}</button>
                        <button class="do-delete">Delete</button>
                        <button class="do-target" title="Where Claude makes this note's change">Target\u2026</button>
                        <span class="send-group">
                            <button class="do-send" title="Send this note's thread to a running Claude Code session">Send to Claude</button>
                            <button class="do-send-menu" title="Choose the Claude session" aria-label="Choose the Claude session">${icon('chevronDown')}</button>
                        </span>
                    </div>`;
                card.addEventListener('click', () => this.board.focusNote(note.id));
                card.querySelector('.do-send').addEventListener('click', (ev) => { ev.stopPropagation(); this.board.sendNote(note.id); });
                card.querySelector('.do-send-menu').addEventListener('click', (ev) => { ev.stopPropagation(); this.board.sendNoteMenu(note.id, ev.currentTarget); });
                card.querySelector('.do-reply').addEventListener('click', (ev) => { ev.stopPropagation(); this.board.replyToNote(note.id); });
                card.querySelector('.do-resolve').addEventListener('click', (ev) => { ev.stopPropagation(); notes.update(note.id, { resolved: !note.resolved }); this.board.notesChanged(); });
                card.querySelector('.do-delete').addEventListener('click', (ev) => { ev.stopPropagation(); notes.remove(note.id); this.board.notesChanged(); });
                card.querySelector('.do-target').addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.targetMenu(ev.currentTarget, note.target || null, (target) => {
                        notes.update(note.id, { target: target || undefined });
                        this.board.notesChanged();
                    }, this.board.noteTarget);
                });
                this.noteList.appendChild(card);
            }
        }
    }

    CB.LayersPanel = LayersPanel;
})();
