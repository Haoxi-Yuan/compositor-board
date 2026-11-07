'use strict';
// Layer structure on the board: the layer selection and mask target (EditorSession activeLayerID / selectedLayerIDs /
// isMaskSelected), the gating predicates Compositor checks before every layer command, the edits that only change
// manifest fields (clipping, masks, delete), and the client of compositor-engine's structure session for edits that
// rearrange records (group, ungroup, move, duplicate, mask from a selection). Mixed into the Board. Specification:
// docs/port-specs/layers-masks.md (sections cited below).

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform, Selection } = CB;
    const LIMIT = 10000;
    const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

    const LayerOps = {
        initLayerState() {
            this.selectedIDs = new Set();
            this.lockedIDs = new Set();
            this.paths = {};
            this.shapeStyles = {};
            this.shapeChecks = new Map();
            this.noteTarget = null;
            this.isMaskSelected = false;
            this.viewsMaskAlone = false;
            this.maskPaintWhite = false;
            this.renamingID = null;
            this.blendPreview = null;
        },

        activeLayer() {
            return this.doc.manifest ? this.doc.layer(this.activeID()) : null;
        },

        // Siblings in array order (bottom to top), as `$0.parentID == layer.parentID`.
        siblings(layer) {
            const parent = layer.parentID || null;
            return this.doc.layers.filter((l) => (l.parentID || null) === parent);
        },

        // LayerGroups.descendantIDs (LG:257-264).
        descendantIDs(id) {
            const out = new Set();
            let frontier = [id];
            for (let depth = 0; frontier.length && depth < 65; depth++) {
                const next = [];
                for (const l of this.doc.layers) if (l.parentID && frontier.includes(l.parentID) && !out.has(l.id)) { out.add(l.id); next.push(l.id); }
                frontier = next;
            }
            return out;
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Selecting layers (1.1)

        // activeLayerID.didSet: another layer ends the mask target (and mask-alone view); any assignment resets the
        // selection to that layer.
        setActive(id) {
            if (id !== this.activeID()) this.isMaskSelected = false;
            if (!this.isMaskSelected) this.viewsMaskAlone = false;
            if (id) this.doc.manifest.activeLayerID = id;
            else delete this.doc.manifest.activeLayerID;
            this.selectedIDs = new Set(id ? [id] : []);
        },

        selectLayer(id) {
            if (this.view.busy || !this.doc.layer(id)) return;
            // Selecting a layer ends an effect's selection (EditorSession.selectLayer).
            this.effectSelection = null;
            if (id !== this.activeID()) this.resolvePending('target');
            if (id !== this.activeID() && this.selectTools.floating) this.selectTools.commitFloating();
            this.setActive(id);
            this.revealActiveLayer();
            this.layerSelectionChanged();
        },

        selectLayers(ids, primary) {
            if (this.view.busy) return;
            const valid = new Set([...ids].filter((id) => this.doc.layer(id)));
            if (!sameSet(valid, this.selectedIDs)) this.resolvePending('target');
            if (!sameSet(valid, this.selectedIDs) && this.selectTools.floating) this.selectTools.commitFloating();
            // Swift picks an arbitrary element when the primary is not selected; the topmost row is deterministic.
            const order = this.layers.rows().map((r) => r.record.id);
            const top = order.find((id) => valid.has(id)) || [...valid][0] || null;
            this.setActive(valid.has(primary) ? primary : top);
            this.selectedIDs = valid.size ? valid : this.selectedIDs;
            this.revealActiveLayer();
            this.layerSelectionChanged();
        },

        // A board choice, as in Photoshop (Compositor always keeps a layer selected once there is one): a Move-tool click
        // where no layer but a background shows a pixel, off the canvas too, selects no layer. The Layers list highlights none, the Move
        // tool shows no box, and what needs a layer says so until one is picked.
        deselectLayers() {
            if (this.view.busy || (!this.activeID() && !this.selectedIDs.size)) return;
            this.effectSelection = null;
            this.resolvePending('target');
            if (this.selectTools.floating) this.selectTools.commitFloating();
            this.setActive(null);
            this.layerSelectionChanged();
        },

        // A thumbnail click: the layer's pixels or its mask become the target (LM:222-228).
        selectLayerTarget(id, mask) {
            if (this.working || this.view.busy) return;
            if (Boolean(mask) !== this.isMaskSelected) this.resolvePending('target');
            this.selectLayer(id);
            const active = this.activeLayer();
            this.isMaskSelected = Boolean(mask && active && active.maskFile);
            if (!this.isMaskSelected) this.viewsMaskAlone = false;
            this.layerSelectionChanged();
        },

        // Folders holding the active layer open, and the list scrolls to it (LG:156-165, NLL:94-97).
        revealActiveLayer() {
            const active = this.activeLayer();
            if (!active) return;
            let changed = false;
            for (const folder of this.ancestors(active)) if (this.layers.collapsed.delete(folder.id)) changed = true;
            if (changed) this.panelDirty = true;
            this.layers.revealID = active.id;
        },

        layerSelectionChanged() {
            this.panelDirty = true;
            this.composite.dirty = true;
            this.schedule();
            this.renderRail();
            this.renderOptions();
            this.view.drawOverlay();
        },

        // Kept for older callers: a plain selection of one layer.
        select(id) {
            if (!this.doc.layer(id) || (this.activeID() === id && this.selectedIDs.size <= 1)) return;
            this.selectLayer(id);
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Lock (a board choice: Compositor has no layer locks; this is Photoshop's Lock All, ⌘/)

        // A locked layer, and everything inside a locked folder, keeps its pixels, place, look and existence. It can still
        // be shown or hidden, selected, renamed, moved in the stack and duplicated (the copy is not locked); canvas
        // commands and undo still reach it, and Claude's tools are not held back. The ids live in <name>.comp.board.json,
        // with the Pen's paths (pen-tool.js) and outlined shapes' styles (shapes.js); entries for layers no longer in the
        // project are dropped when it opens.
        loadBoardState(state) {
            const live = (id) => Boolean(this.doc.layer(id));
            this.lockedIDs = new Set(((state && state.locked) || []).filter(live));
            this.paths = Object.fromEntries(Object.entries((state && state.paths) || {}).filter(([id]) => live(id)));
            this.shapeStyles = Object.fromEntries(Object.entries((state && state.shapes) || {}).filter(([id]) => live(id)));
            this.shapeChecks.clear();
            // Where the notes ask Claude to make changes (core/note-target.js); null is the person's workspace.
            this.noteTarget = (state && state.noteTarget) || null;
        },

        saveBoardState() {
            this.post({ type: 'boardState', state: { locked: [...this.lockedIDs], paths: this.paths, shapes: this.shapeStyles, noteTarget: this.noteTarget } });
        },

        // The shape a layer is drawn from when it is scaled: Compositor's `shape` style, or an outlined shape's style
        // while the layer still shows it (painting, a filter or an edit made elsewhere leave plain pixels). Worked out
        // again only when the layer or the history changes.
        liveShapeStyle(record) {
            if (!record || record.shape) return record ? record.shape : null;
            const style = this.shapeStyles[record.id], image = this.doc.entry(record.id).image;
            if (!style || !image) return null;
            const h = this.history, last = h.done[h.done.length - 1] || null, c = this.shapeChecks.get(record.id);
            if (!(c && c.style === style && c.image === image && c.last === last && c.undone === h.undone.length)) {
                const live = CB.Shapes.samePixels(image, CB.Shapes.shapeImage(style, image.width, image.height));
                this.shapeChecks.set(record.id, { style, image, last, undone: h.undone.length, live });
            }
            return this.shapeChecks.get(record.id).live ? style : null;
        },

        // The layer or folder whose lock holds `record`, or null.
        lockedBy(record) {
            for (let r = record, depth = 0; r && depth < 65; r = r.parentID ? this.doc.layer(r.parentID) : null, depth++) {
                if (this.lockedIDs.has(r.id)) return r;
            }
            return null;
        },

        isLocked(record) {
            return Boolean(record && this.lockedBy(record));
        },

        // Why an edit to `records` is refused, or null. `inside` also checks what folders hold (deleting or merging a
        // folder takes its contents with it).
        lockRefusal(records = [this.activeLayer()], { inside = false } = {}) {
            const all = [];
            for (const r of records) {
                if (!r) continue;
                all.push(r);
                if (inside && r.isGroup) for (const id of this.descendantIDs(r.id)) all.push(this.doc.layer(id));
            }
            for (const r of all) {
                const by = r && this.lockedBy(r);
                if (!by) continue;
                return by === r ? `“${r.name}” is locked. Unlock it (⌘/) to change it.`
                    : `“${r.name}” is inside the locked folder “${by.name}”. Unlock the folder (⌘/) to change it.`;
            }
            return null;
        },

        // The selected layers, for the lock commands.
        selectedRecords() {
            return [...this.selectedIDs].map((id) => this.doc.layer(id)).filter(Boolean);
        },

        // Refuses with a toast when an edit would change a locked layer; true when it did.
        refuseLocked(records, options) {
            const refusal = this.lockRefusal(records, options);
            if (refusal) this.toast(refusal);
            return Boolean(refusal);
        },

        canToggleLock() {
            return this.layersLookEditable() && this.selectedRecords().length > 0;
        },

        // The command locks the selection unless every selected layer is locked already.
        selectionLocked() {
            const records = this.selectedRecords();
            return records.length > 0 && records.every((r) => this.lockedIDs.has(r.id));
        },

        toggleLock(records = this.selectedRecords()) {
            if (!records.length) return;
            const lock = !records.every((r) => this.lockedIDs.has(r.id));
            for (const r of records) {
                if (lock) this.lockedIDs.add(r.id);
                else this.lockedIDs.delete(r.id);
            }
            this.saveBoardState();
            this.toast(`${lock ? 'Locked' : 'Unlocked'} ${records.length === 1 ? `“${records[0].name}”` : `${records.length} layers`}`);
            this.panelDirty = true;
            this.schedule();
            this.renderOptions(true);
            this.view.drawOverlay();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Gates (1.2)

        // A lasting edit that waits for Apply / Cancel or a tool's own commit (crop, gradient, text, adjustment panel).
        pendingEdit() {
            return Boolean(this.cropEdit || this.gradientEdit || this.textDraft || this.adjustmentEditingID || this.transformEdit);
        },

        canEditLayers() {
            return Boolean(this.doc.manifest) && !this.view.busy && !this.working && !this.openPanel && !this.selectTools.colorRange
                && !this.filters.isOpen && !this.renamingID && !this.selectTools.floating && !this.pendingEdit();
        },

        layersLookEditable() {
            return Boolean(this.doc.manifest) && !this.openPanel && !this.selectTools.colorRange && !this.textDraft && !this.busyShown
                && !this.renamingID && !this.selectTools.floating && !this.cropEdit && !this.gradientEdit && !this.filters.isOpen
                && !(this.transformEdit && this.transformEdit.persistent)
                && !this.adjustmentEditingID;
        },

        canEditAppearance() {
            const a = this.activeLayer();
            return this.canEditLayers() && this.selectedIDs.size === 1 && Boolean(a) && !a.isGroup && !this.isLocked(a);
        },

        canEditOpacity() {
            return this.canEditLayers() && this.selectedIDs.size === 1 && Boolean(this.activeLayer()) && !this.isLocked(this.activeLayer());
        },

        canEditMask() {
            return this.canEditOpacity();
        },

        canUngroupLayers() {
            const a = this.activeLayer();
            return this.canEditLayers() && Boolean(a && a.isGroup) && !this.isLocked(a);
        },

        canConvertLayerDepth() {
            const a = this.activeLayer();
            return this.canEditLayers() && this.selectedIDs.size <= 1 && Boolean(a) && !a.text && !a.adjustment && !a.isGroup && !this.isLocked(a);
        },

        canMoveActiveLayer(offset) {
            const a = this.activeLayer();
            if (!this.canEditLayers() || !a) return false;
            const siblings = this.siblings(a);
            return Boolean(siblings[siblings.indexOf(a) + offset]);
        },

        canPlaceLayer(id, parent) {
            if (!this.canEditLayers() || !this.doc.layer(id)) return false;
            if (!parent) return true;
            const folder = this.doc.layer(parent);
            return parent !== id && !this.descendantIDs(id).has(parent) && Boolean(folder && folder.isGroup);
        },

        canCopyMask(source, target) {
            const s = this.doc.layer(source), t = this.doc.layer(target);
            return this.canEditLayers() && source !== target && Boolean(s && s.maskFile) && Boolean(t) && !t.isGroup && !this.isLocked(t);
        },

        // LayerMerge.mergePlan (MRG:7-27).
        mergePlan() {
            const active = this.activeLayer();
            if (!this.canEditLayers() || !active) return null;
            const layers = this.doc.layers, sel = this.selectedIDs;
            if (sel.size > 1) {
                const picked = new Set(sel);
                for (const id of sel) for (const d of this.descendantIDs(id)) picked.add(d);
                const ordered = layers.filter((l) => picked.has(l.id));
                const top = [...ordered].reverse().find((l) => sel.has(l.id));
                if (!ordered.some((l) => !l.isGroup) || !top) return null;
                return { action: 'Merge Layers', ids: ordered.map((l) => l.id) };
            }
            if (active.isGroup) {
                const inside = this.descendantIDs(active.id);
                if (!layers.some((l) => inside.has(l.id) && !l.isGroup)) return null;
                return { action: 'Merge Group' };
            }
            const index = layers.indexOf(active);
            const below = layers.slice(0, index).reverse().find((l) => (l.parentID || null) === (active.parentID || null));
            if (!below || below.isGroup) return null;
            return { action: 'Merge Down' };
        },

        // The layers a merge changes or removes: the merged ones (folders with their contents), or the active layer and
        // the one below it.
        mergeRecords(plan = this.mergePlan()) {
            const active = this.activeLayer();
            if (!plan || !active) return [];
            if (plan.ids) return plan.ids.map((id) => this.doc.layer(id));
            if (plan.action === 'Merge Group') return [active, ...[...this.descendantIDs(active.id)].map((id) => this.doc.layer(id))];
            const layers = this.doc.layers, index = layers.indexOf(active);
            return [active, layers.slice(0, index).reverse().find((l) => (l.parentID || null) === (active.parentID || null))];
        },

        canMergeLayers() {
            const plan = this.mergePlan();
            return plan !== null && !this.lockRefusal(this.mergeRecords(plan));
        },

        mergeTitle() {
            return (this.mergePlan() || { action: 'Merge Down' }).action;
        },

        // LiveMaskGraph.validate (LLM:4-19).
        liveMaskGraphValid(layers) {
            const byID = new Map();
            for (const l of layers) { if (byID.has(l.id)) return false; byID.set(l.id, l); }
            for (const l of layers) {
                const path = new Set();
                for (let id = l.id; id;) {
                    const r = byID.get(id);
                    if (path.size >= 256 || path.has(id) || !r) return false;
                    path.add(id);
                    if (r.maskSourceID) {
                        const s = byID.get(r.maskSourceID);
                        if (r.isGroup === true || !s || s.isGroup === true || s.adjustment) return false;
                    }
                    id = r.maskSourceID;
                }
            }
            return true;
        },

        canLinkMask(source, target) {
            if (!this.canEditLayers() || source === target) return false;
            const s = this.doc.layer(source), t = this.doc.layer(target);
            if (!s || s.isGroup || s.adjustment || !t || t.isGroup || this.isLocked(t)) return false;
            return this.liveMaskGraphValid(this.doc.layers.map((l) => (l.id === target ? { ...l, maskSourceID: source } : l)));
        },

        canToggleClippingMask(id) {
            const layer = this.doc.layer(id);
            if (!this.canEditLayers() || !layer || layer.isGroup || this.isLocked(layer)) return false;
            if (layer.maskSourceID) return true;
            const siblings = this.siblings(layer), i = siblings.indexOf(layer);
            if (i <= 0 || siblings[i - 1].isGroup) return false;
            return this.canLinkMask(siblings[i - 1].maskSourceID || siblings[i - 1].id, id);
        },

        // EditorSession.canPaint / paintRefusal (EditorSession+Brush.swift:5-33): the first reason that applies.
        paintRefusal(record = this.activeLayer()) {
            if (!record) return 'Select a layer to paint on it.';
            const locked = this.lockRefusal([record]);
            if (locked) return locked;
            const name = `“${record.name}”`;
            const mask = this.isMaskSelected && record.maskFile;
            if (this.selectedIDs.size > 1) return 'Several layers are selected. Select just one to paint on it.';
            if (record.isGroup && !mask) return `${name} is a folder, which has no pixels of its own. Paint on a layer inside it, or on the folder’s mask.`;
            if (!this.effectivelyVisible(record)) return `${name} is hidden, or inside a hidden folder. Show it to paint on it.`;
            if (mask && record.maskEnabled === false) return 'The layer mask is turned off. Shift-click its thumbnail to turn it on, then paint.';
            if (record.adjustment && !mask) return `${name} is an adjustment layer, with no pixels to paint. Paint on its mask instead.`;
            if (this.selection && Selection.isEmpty(this.selection)) return 'Nothing is selected, so there’s nowhere to paint. Choose Select › Deselect (⌘D) to paint anywhere.';
            return mask ? null : this.doc.pixelLock(record);
        },

        canPaint() {
            return this.canEditLayers() && !this.paintRefusal();
        },

        // SelectionEdits.canInvert (SelectionEdits.swift:95-101).
        canInvert() {
            const a = this.activeLayer();
            if (!this.doc.manifest || !a || this.view.busy || this.working || this.renamingID || this.textDraft) return false;
            if (this.selectedIDs.size !== 1 || (a.isGroup && !this.isMaskSelected) || !this.effectivelyVisible(a)) return false;
            if ((this.selection && Selection.isEmpty(this.selection)) || this.isLocked(a)) return false;
            return this.isMaskSelected ? Boolean(a.maskFile) && a.maskEnabled !== false : Boolean(this.doc.entry(a.id).image);
        },

        // ---------------------------------------------------------------------------------------------------------------
        // The palette while a mask is the target: black and white only (ColorPalette.swift:26-59)

        paletteColor(which) {
            if (!this.isMaskSelected) return this.colors[which];
            const white = which === 'bg' ? !this.maskPaintWhite : this.maskPaintWhite;
            return white ? [1, 1, 1] : [0, 0, 0];
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Clipping (section 16)

        toggleClippingMask(id) {
            const layer = this.doc.layer(id);
            if (!this.canEditLayers() || !layer || layer.isGroup) return;
            const siblings = this.siblings(layer);
            if (layer.maskSourceID) {
                const source = layer.maskSourceID, from = siblings.indexOf(layer);
                const releases = [];
                for (const l of siblings.slice(from)) { if (l.id === id || l.maskSourceID === source) releases.push(l); else break; }
                if (this.refuseLocked(releases)) return;
                this.edit('Release Clipping Mask', () => { releases.forEach((l) => delete l.maskSourceID); });
                return;
            }
            const i = siblings.indexOf(layer);
            if (i <= 0 || siblings[i - 1].isGroup) return;
            const source = siblings[i - 1].maskSourceID || siblings[i - 1].id;
            if (this.refuseLocked([layer]) || !this.canLinkMask(source, id)) return;
            this.edit('Create Clipping Mask', () => { layer.maskSourceID = source; });
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Delete (6.13)

        // SelectionEdits.deleteKeyPressed (SE:76-88): a selected effect goes first, then selected pixels, then the target.
        deleteKeyPressed() {
            if (this.selectedEffect()) { this.removeSelectedEffect(); return; }
            if (this.selection) { this.clearSelected(); return; }
            this.deleteLayerOrMask();
        },

        deleteLayerOrMask() {
            if (this.selectedEffect()) { this.removeSelectedEffect(); return; }
            const a = this.activeLayer();
            if (this.isMaskSelected && a && a.maskFile && this.selectedIDs.size <= 1) this.deleteLayerMask();
            else this.deleteSelectedLayers();
        },

        deleteSelectedLayers() {
            if (!this.canEditLayers() || !this.activeLayer()) return;
            const selected = this.selectedIDs.size ? this.selectedIDs : new Set([this.activeID()]);
            const ids = this.doc.layers.filter((l) => selected.has(l.id)).map((l) => l.id);
            const removed = new Set(ids);
            for (const id of ids) for (const d of this.descendantIDs(id)) removed.add(d);
            const targets = this.doc.layers.filter((l) => !removed.has(l.id) && l.maskSourceID && removed.has(l.maskSourceID));
            if (this.refuseLocked([...removed, ...targets.map((l) => l.id)].map((id) => this.doc.layer(id)))) return;
            const label = ids.length > 1 ? 'Delete Layers' : 'Delete Layer';
            if (!targets.length) {
                this.finishDeletingLayers(ids, label);
                return;
            }
            // The live-mask choice (LLM:100-130): Bake keeps the masked look in the dependents' pixels.
            this.choose(ids.length === 1 ? 'This layer supplies a live mask' : 'These layers supply live masks',
                'Bake keeps the current masked appearance in the dependent layers’ pixels. Remove Links reveals their pixels. You can undo either choice.',
                [
                    { label: 'Bake and Delete', default: true, run: () => this.selectionOp('layer.delete', { choice: 'bake' }, label) },
                    { label: 'Cancel', cancel: true },
                    { label: 'Remove Links and Delete', run: () => this.finishDeletingLayers(ids, label) },
                ]);
        },

        // LiveLayerMask.finishDeletingLayer(s) (LLM:131-154): a folder takes its contents; layers clipped to a deleted one
        // are unlinked; the layer at the deleted one's place becomes active.
        finishDeletingLayers(ids, label) {
            this.edit(label, () => {
                for (const id of ids) {
                    const m = this.doc.manifest;
                    const index = m.layers.findIndex((l) => l.id === id);
                    if (index < 0) continue;
                    const removed = new Set([id, ...this.descendantIDs(id)]);
                    m.layers = m.layers.filter((l) => !removed.has(l.id));
                    for (const l of m.layers) if (l.maskSourceID && removed.has(l.maskSourceID)) delete l.maskSourceID;
                    if (removed.has(m.activeLayerID) || !m.activeLayerID) this.setActive(m.layers.length ? m.layers[Math.min(index, m.layers.length - 1)].id : null);
                }
            });
            this.selectedIDs = new Set(this.activeID() ? [this.activeID()] : []);
            this.layerSelectionChanged();
        },

        // A modal with several buttons, in order; Return runs the default one, Escape the cancel one (NSAlert).
        choose(title, message, buttons) {
            if (this.alertEl) this.alertEl.remove();
            const el = document.createElement('div');
            el.className = 'gone alert';
            el.innerHTML = `<div class="gone-box" role="alertdialog"><div class="panel-title"></div><div class="alert-text"></div><div class="buttons"></div></div>`;
            el.querySelector('.panel-title').textContent = title;
            el.querySelector('.alert-text').textContent = message;
            const row = el.querySelector('.buttons');
            const close = () => { el.remove(); if (this.alertEl === el) this.alertEl = null; this.focusCanvas(); };
            for (const b of buttons) {
                const button = document.createElement('button');
                button.className = `pill${b.default ? ' ok' : ''}`;
                button.textContent = b.label;
                button.addEventListener('click', () => { close(); if (b.run) b.run(); });
                row.appendChild(button);
            }
            el.addEventListener('keydown', (e) => {
                e.stopPropagation();
                const pick = e.key === 'Enter' ? buttons.find((b) => b.default) : e.key === 'Escape' ? buttons.find((b) => b.cancel) : null;
                if (pick) { e.preventDefault(); close(); if (pick.run) pick.run(); }
            });
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.stageEl.appendChild(el);
            (row.querySelector('.ok') || row.firstChild).focus();
            this.alertEl = el;
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Masks (sections 10-14)

        // A uniform 1×1 mask, white or black, now the target (LM:270-278).
        addLayerMask(revealing) {
            const record = this.activeLayer();
            if (record && this.refuseLocked([record])) return;
            if (!this.canEditMask() || !record || record.maskFile) return;
            const done = this.edit(revealing ? 'Add Reveal-All Mask' : 'Add Hide-All Mask', () => {
                const mask = CB.Document.maskFromGray(1, 1, new Uint8Array([revealing ? 255 : 0]));
                const before = this.doc.entry(record.id).mask;
                this.doc.entry(record.id).mask = mask;
                record.maskFile = `${record.id}.mask.png`;
                record.maskEnabled = true;
                record.maskLinked = true;
                delete record.maskPlacement;
                this.doc.dirtyMasks.add(record.id);
                return [{ layerID: record.id, kind: 'mask', beforeMask: before, afterMask: mask }];
            });
            if (done) { this.isMaskSelected = true; this.layerSelectionChanged(); }
        },

        // The footer button: with a selection the mask reveals (or hides) it, made by Compositor (LM:240-267).
        addMask(revealing) {
            const record = this.activeLayer();
            if (record && this.refuseLocked([record])) return;
            if (!this.canEditMask() || !record || record.maskFile) return;
            if (!this.selection) { this.addLayerMask(revealing); return; }
            const image = this.doc.entry(record.id).image;
            // HDR layers: the board does not know their pixel grid, so Compositor makes the mask in a full session.
            if (image && image.deep && image.deep.startsWith('HDR')) {
                this.selectionOp('selection.addMask', { revealing }, revealing ? 'Reveal Selection' : 'Hide Selection');
                return;
            }
            this.structureOp('mask.add', { revealing, selection: this.selection }, revealing ? 'Reveal Selection' : 'Hide Selection', { out: 'png' });
        },

        toggleLayerMask() {
            const record = this.activeLayer();
            if (record && this.refuseLocked([record])) return;
            if (!this.canEditMask() || !record || !record.maskFile) return;
            const enabled = record.maskEnabled !== false;
            this.edit(enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', () => { record.maskEnabled = !enabled; });
        },

        deleteLayerMask() {
            const record = this.activeLayer();
            if (record && this.refuseLocked([record])) return;
            if (!this.canEditMask() || !record || !record.maskFile) return;
            this.edit('Delete Layer Mask', () => {
                const before = this.doc.entry(record.id).mask;
                for (const k of ['maskFile', 'maskEnabled', 'maskLinked', 'maskPlacement']) delete record[k];
                this.doc.entry(record.id).mask = null;
                return [{ layerID: record.id, kind: 'mask', beforeMask: before, afterMask: null }];
            });
            this.isMaskSelected = false;
            this.viewsMaskAlone = false;
            this.layerSelectionChanged();
        },

        toggleMaskLink(id) {
            const record = this.doc.layer(id);
            if (!this.canEditLayers() || !record || !record.maskFile || this.refuseLocked([record])) return;
            const linked = record.maskLinked !== false;
            this.edit(linked ? 'Unlink Layer Mask' : 'Link Layer Mask', () => { record.maskLinked = !linked; });
        },

        // ⌥-drag a mask thumbnail onto another row: the same mask, where it sits on the document (LM:305-317).
        copyMask(sourceID, targetID) {
            if (!this.canCopyMask(sourceID, targetID)) return;
            const source = this.doc.layer(sourceID), target = this.doc.layer(targetID), from = this.doc.entry(sourceID).mask;
            if (!from) return;
            const done = this.edit(target.maskFile ? 'Replace Layer Mask' : 'Copy Layer Mask', () => {
                const before = this.doc.entry(targetID).mask;
                const mask = CB.Document.maskFromGray(from.width, from.height, new Uint8Array(from.gray));
                this.doc.entry(targetID).mask = mask;
                target.maskFile = `${targetID}.mask.png`;
                target.maskEnabled = source.maskEnabled !== false;
                target.maskLinked = source.maskLinked !== false;
                target.maskPlacement = CB.Document.clone(source.maskPlacement || source.transform);
                this.doc.dirtyMasks.add(targetID);
                this.setActive(targetID);
                return [{ layerID: targetID, kind: 'mask', beforeMask: before, afterMask: mask }];
            });
            if (done) { this.isMaskSelected = true; this.layerSelectionChanged(); }
        },

        // ⌥-click a mask thumbnail: that mask alone on the canvas, or the image again (LM:229-236).
        toggleMaskAlone(id) {
            const showing = this.viewsMaskAlone && this.isMaskSelected && this.activeID() === id;
            this.selectLayerTarget(id, true);
            if (this.activeID() !== id || !this.isMaskSelected) return;
            this.viewsMaskAlone = !showing;
            this.layerSelectionChanged();
        },

        stopMaskAlone() {
            this.viewsMaskAlone = false;
            this.layerSelectionChanged();
        },

        // Where a mask sits after its layer moves (LM:54-59): a linked placed mask follows, an unlinked one stays where it
        // was; a uniform mask needs no placement; a placement equal to the layer's is dropped.
        maskPlacementAfterMove(record, old, next) {
            const mask = this.doc.entry(record.id).mask;
            if (!mask || !record.maskFile) return undefined;
            if (mask.width <= 1 && mask.height <= 1) return null;
            const size = [this.doc.width, this.doc.height];
            const placed = record.maskPlacement ? Transform.read(record.maskPlacement, size) : null;
            const moved = record.maskLinked !== false ? (placed && CB.TransformTool.following(placed, old, next)) : (placed || old);
            if (!moved) return null;
            const same = ['x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY'].every((k) => moved[k] === next[k]);
            return same ? null : moved;
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Engine structure session (section 19.2)

        // Pixel sizes of every layer's image and mask, for the engine's stand-in images.
        layerSizes() {
            const sizes = {};
            for (const l of this.doc.layers) {
                const e = this.doc.entry(l.id), s = {};
                if (e.image) s.image = [e.image.width, e.image.height];
                if (e.mask) s.mask = [e.mask.width, e.mask.height];
                sizes[l.id] = s;
            }
            return sizes;
        },

        async structureOp(op, args, fallbackLabel, files) {
            if (!this.canEditLayers()) return null;
            let answer;
            try {
                answer = await this.engine(op, { manifest: this.doc.manifest, sizes: this.layerSizes(), ...args }, { stateless: true, files });
            } catch (error) {
                this.toast(error.message);
                return null;
            }
            if (answer.error) this.alert('Couldn’t paint', answer.error);
            if (!answer.changed) return answer;
            await this.applyStructure(answer, fallbackLabel, answer.files || {});
            return answer;
        },

        // The engine's records applied as one undo step; copies take their source's pixels.
        async applyStructure(answer, fallbackLabel, files) {
            const selectionBefore = this.selection;
            let installed = null;
            if (answer.maskLayerID && files.out) installed = await CB.Document.decodeMask(files.out);
            const changed = this.edit(answer.editName || fallbackLabel, () => this.buildStructure(answer, installed));
            if (changed && 'selection' in answer) {
                // The mask from a selection consumed it in the same step.
                const last = this.history.done[this.history.done.length - 1];
                last.selectionBefore = selectionBefore;
                last.selectionAfter = answer.selection;
                this.selection = answer.selection;
            }
            this.applyEngineState(answer);
        },

        // Lays the engine's records over the board's (keeping the board's own fields and file names) and returns the
        // pixel changes: copies' pixels, an installed mask.
        buildStructure(answer, installed) {
            const doc = this.doc, local = new Map(doc.layers.map((l) => [l.id, l]));
            const KEYS = ['parentID', 'maskSourceID', 'maskFile', 'maskEnabled', 'maskLinked', 'maskPlacement'];
            const pixels = [];
            doc.manifest.layers = answer.layers.map((r) => {
                const mine = local.get(r.id);
                if (mine) {
                    for (const k of KEYS) { if (r[k] === undefined || r[k] === null) delete mine[k]; else mine[k] = r[k]; }
                    return mine;
                }
                const from = local.get((answer.copies || {})[r.id]), maskFrom = local.get((answer.maskCopies || {})[r.id]);
                const record = { ...(from ? CB.Document.clone(from) : {}), ...r };
                // A copy of an outlined shape is one too, as a copy keeps Compositor's `shape` style.
                if (from && this.shapeStyles[from.id]) {
                    this.shapeStyles[r.id] = CB.Document.clone(this.shapeStyles[from.id]);
                    this.saveBoardState();
                }
                for (const k of Object.keys(record)) if (record[k] === null) delete record[k];
                if (from && from.imageFile) record.imageFile = `${r.id}${from.imageFile.slice(from.imageFile.lastIndexOf('.'))}`;
                else delete record.imageFile;
                pixels.push(...this.copyPixels(from, maskFrom, r.id));
                return record;
            });
            if (answer.activeLayerID) doc.manifest.activeLayerID = answer.activeLayerID;
            if (installed) {
                const id = answer.maskLayerID, entry = doc.entry(id);
                const before = entry.mask;
                entry.mask = installed;
                doc.dirtyMasks.add(id);
                pixels.push({ layerID: id, kind: 'mask', beforeMask: before, afterMask: installed });
            }
            return pixels;
        },

        // ⌥-drag on the canvas: the layer is copied first, without an undo step of its own; the drag then moves the copy
        // and records one "Duplicate Layer" (or Escape takes the copy away again).
        async duplicateForDrag(id, selectedIDs = [id]) {
            let answer;
            try {
                answer = await this.engine('layer.duplicate', { manifest: this.doc.manifest, sizes: this.layerSizes(), activeLayerID: id, selectedLayerIDs: selectedIDs }, { stateless: true });
            } catch (error) {
                this.toast(error.message);
                return null;
            }
            if (!answer.changed) return null;
            const metaBefore = this.doc.snapshot();
            const pixels = this.buildStructure(answer, null);
            this.applyEngineState(answer);
            return { copyID: this.activeID(), metaBefore, pixels, ids: Object.keys(answer.copies || {}), originalID: id };
        },

        finishDragCopy(copy, transform) {
            const record = this.doc.layer(copy.copyID);
            if (record && transform && CB.TransformTool.isValid(transform)) {
                const old = Transform.read(record.transform, [this.doc.width, this.doc.height]);
                const placement = this.maskPlacementAfterMove(record, old, transform);
                record.transform = Transform.write(transform);
                if (placement === null) delete record.maskPlacement;
                else if (placement) record.maskPlacement = Transform.write(placement);
            }
            this.doc.metaDirty = true;
            this.history.push({ label: 'Duplicate Layer', metaBefore: copy.metaBefore, metaAfter: this.doc.snapshot(), pixels: copy.pixels });
            this.changed();
        },

        cancelDragCopy(copy) {
            this.doc.manifest = JSON.parse(copy.metaBefore);
            for (const id of copy.ids) {
                this.doc.pixels.delete(id);
                this.doc.dirtyImages.delete(id);
                this.doc.dirtyMasks.delete(id);
            }
            this.setActive(copy.originalID);
            this.changed();
        },

        // A copy's pixels: the source's canvas (with its file bytes, so 16-bit and HDR survive) and mask samples.
        copyPixels(from, maskFrom, id) {
            const pixels = [], doc = this.doc;
            const target = doc.entry(id);
            if (from) {
                const source = doc.entry(from.id).image;
                if (source) {
                    const image = new OffscreenCanvas(source.width, source.height);
                    image.getContext('2d').drawImage(source, 0, 0);
                    if (source.deep) image.deep = source.deep;
                    if (source.raw) { image.raw = source.raw; image.rawExtension = source.rawExtension; }
                    target.image = image;
                    doc.dirtyImages.add(id);
                    pixels.push({ layerID: id, kind: 'image', beforeBitmap: null, afterBitmap: image });
                }
            }
            const maskSource = maskFrom ? doc.entry(maskFrom.id).mask : from ? doc.entry(from.id).mask : null;
            if (maskSource) {
                target.mask = CB.Document.maskFromGray(maskSource.width, maskSource.height, new Uint8Array(maskSource.gray));
                doc.dirtyMasks.add(id);
                pixels.push({ layerID: id, kind: 'mask', beforeMask: null, afterMask: target.mask });
            }
            return pixels;
        },

        // The session state an engine answer carries (1.4).
        applyEngineState(answer) {
            if (!answer || !this.doc.manifest) return;
            if (answer.activeLayerID && this.doc.layer(answer.activeLayerID)) this.doc.manifest.activeLayerID = answer.activeLayerID;
            if (Array.isArray(answer.selectedLayerIDs)) {
                const ids = answer.selectedLayerIDs.filter((id) => this.doc.layer(id));
                this.selectedIDs = new Set(ids.length ? ids : this.activeID() ? [this.activeID()] : []);
            }
            if (typeof answer.isMaskSelected === 'boolean') this.isMaskSelected = answer.isMaskSelected && Boolean((this.activeLayer() || {}).maskFile);
            if (!this.isMaskSelected) this.viewsMaskAlone = false;
            if (Array.isArray(answer.collapsedGroupIDs)) this.layers.collapsed = new Set(answer.collapsedGroupIDs);
            this.revealActiveLayer();
            this.layerSelectionChanged();
        },

        // What every engine request carries about the layer selection (1.4).
        engineLayerState() {
            if (!this.doc.manifest) return {};
            return {
                selectedLayerIDs: [...this.selectedIDs],
                isMaskSelected: this.isMaskSelected,
                maskPaintWhite: this.maskPaintWhite,
                collapsedGroupIDs: [...this.layers.collapsed],
            };
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Commands

        groupLayers() {
            if (!this.canEditLayers() || this.doc.layers.length >= LIMIT) return;
            this.structureOp('layer.group', {}, 'Group Layers');
        },

        ungroupLayers() {
            if (this.refuseLocked([this.activeLayer()])) return;
            if (this.canUngroupLayers()) this.structureOp('layer.ungroup', {}, 'Ungroup Layers');
        },

        moveOutOfFolder() {
            const a = this.activeLayer();
            if (this.canEditLayers() && a && a.parentID && !this.refuseLeavingLockedFolder([a], null)) this.structureOp('layer.moveOutOfFolder', {}, 'Move Layer');
        },

        // A locked folder keeps its contents: what its lock holds cannot be moved to another parent (copies can).
        refuseLeavingLockedFolder(records, parent) {
            const leaving = records.find((r) => r && (r.parentID || null) !== (parent || null) && this.lockedBy(r) && this.lockedBy(r) !== r);
            if (!leaving) return false;
            this.toast(`“${leaving.name}” is inside the locked folder “${this.lockedBy(leaving).name}”. Unlock the folder (⌘/) to move it out.`);
            return true;
        },

        duplicateLayers() {
            if (this.canEditLayers() && this.activeLayer()) return this.structureOp('layer.duplicate', {}, 'Duplicate Layer');
            return Promise.resolve(null);
        },

        placeLayers(ids, rowID, intoFolder, copying) {
            const row = this.doc.layer(rowID);
            const parent = intoFolder ? rowID : row ? row.parentID || null : null;
            if (!copying && this.refuseLeavingLockedFolder(ids.map((id) => this.doc.layer(id)), parent)) return Promise.resolve(null);
            return this.structureOp('layer.place', { ids, rowID, intoFolder, copying }, copying ? 'Duplicate Layer' : 'Move Layer');
        },

        mergeLayers() {
            if (this.refuseLocked(this.mergeRecords())) return;
            if (this.canMergeLayers()) this.selectionOp('layer.merge', {}, this.mergeTitle());
        },

        convertLayerDepth() {
            if (!this.canConvertLayerDepth()) return;
            const image = this.doc.entry(this.activeID()).image;
            this.selectionOp('layer.convertDepth', {}, image && image.deep ? 'Convert to 8-Bit' : 'Convert to 16-Bit');
        },

        convertHDRTo16() {
            const image = this.doc.entry(this.activeID()).image;
            if (this.canConvertLayerDepth() && image && image.deep && image.deep.startsWith('HDR')) this.selectionOp('layer.convertHDRTo16', {}, 'Convert to 16-Bit');
        },
    };

    CB.LayerOps = LayerOps;
})();
