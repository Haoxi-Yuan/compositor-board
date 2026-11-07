# Compositor Layers Panel, Layer Operations, Masks and Clipping: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3). All `file:line` references are relative
to `upstream/Compositor/` unless they start with `engine/`, `media/`, `vscode-extension/` or `CompositorTests/`. Code
excerpts are verbatim. Modifier glyphs follow `ui.md`: `⌘` Command, `⌥` Option, `⇧` Shift, `⌃` Control, `⌫` Delete,
`⎋` Escape, `↩` Return.

Abbreviations used for the files cited most often:

| Short | File |
|---|---|
| `NLL` | `UI/NativeLayerList.swift` (1489 lines, read in full) |
| `ES` | `Document/EditorSession.swift` |
| `LG` | `Document/LayerGroups.swift` (read in full) |
| `LM` | `Document/LayerMask.swift` (read in full) |
| `LLM` | `Document/LiveLayerMask.swift` (read in full) |
| `MRG` | `Document/LayerMerge.swift` (read in full) |
| `SC` | `Document/SelectionClipboard.swift` |
| `APP` | `CompositorApp.swift` |

Also read in full: `UI/LayersPanel.swift`, `UI/LayerMaskMenu.swift`, `UI/LayerAppearanceControls.swift`,
`UI/BlendModePicker.swift`, `UI/CanvasThumbnail.swift`, `UI/NumericScrub.swift`, `Document/LayerAppearance.swift`,
`Document/DocumentHistory.swift`, `Document/DocumentLimits.swift`. Read in part (targeted): `ES` (session state,
layer edits, history, transform commit), `APP` (Edit and Layer menus), `ContentView.swift` (panel width, mask pill,
alerts), `Document/DeepLayers.swift:272-329`, `Document/SelectionEdits.swift:44-160`, `Document/ColorPalette.swift`,
`Document/EditorSession+Brush.swift`, `Document/BrushStroke.swift:199-256`, `Document/LayerAdjustment.swift`,
`Document/LayerEffects.swift` (copy, masked effects), `Document/LayerTransform.swift:79-95`,
`Document/EditorSession+Projects.swift`, `Document/Filters.swift:205-232` (trim), `Rendering/BrushPixels.c:3-21`,
`Rendering/EditorCanvas.swift:938-953, 2869-2885`, `IO/ProjectStore.swift` (snapshot, save, errors),
`UI/KeyboardShortcuts.swift:84-135, 300-308`, and the upstream tests `CompositorTests/GroupingSelectionTests.swift`,
`GroupTests.swift:110-190`, `LiveMaskTests.swift`, `LayerMaskTests.swift:36-66`. On the port side: `media/layers.js`,
`media/board.js` (state, `edit`, `commitTransform`, `engine`, `selectionOp`, `menus`, `keydown`, `actions`),
`media/render.js`, `media/document.js`, `media/history.js`, `media/board.css` (rows), `vscode-extension/extension.js`
(`runEngine`, `pushExternal`, `recordEdit`), `vscode-extension/core/package-io.js` (`writeProject`), and
`engine/Sources/*.swift`.

Related specs this one leans on rather than repeats: `ui.md` section 7 (panel basics, already partly ported),
`compositing.md` sections 6-8 (how masks, folders and clipping render; `media/render.js` already implements them),
`brush.md` sections 11-12 (painting a mask, mask growth), `selection.md` (mask from selection, ⌘-click loads),
`manifest.md` section 4 (record keys).

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| Layer model | `document.layers` is **bottom to top**. Folders are records with `isGroup`; hierarchy is rebuilt by grouping on `parentID`, keeping array order among siblings. The panel lists **top first** | `ES:67`, `LG:9-26, 254-256` |
| Session-only state | `activeLayerID` (saved in the manifest), `selectedLayerIDs` (a set, **not saved**), `isMaskSelected`, `viewsMaskAlone`, `collapsedGroupIDs`, `renamingLayerID`, `blendPreview`, `opacityEditLayerID`, `maskPaintWhite` | `ES:173, 227, 628-647`, `Document/EditorSession+Projects.swift:16` |
| Setting the active layer | `activeLayerID.didSet`: a different id clears `isMaskSelected` (which clears `viewsMaskAlone`); **any** assignment resets `selectedLayerIDs = [id]` | `ES:631, 641-646` |
| Gate | Layer edits need `canEditLayers` (no stroke, drag, dialog, transform, crop, gradient, filter, busy op, rename). The panel *looks* disabled only for lasting states (`layersLookEditable`) | `ES:688-701` |
| Undo | One step per command, named; whole-document snapshots incl. `activeLayerID`; no step when nothing changed; 100 steps / 256 MiB | `Document/DocumentHistory.swift` |
| Folders | Pass-through, opacity multiplies, mask clips each descendant; no blend mode, effects, painting or clipping; ≤ 64 deep | `LG:49-64`, `LM:168-210` |
| Group ⌘G | New "Folder N" at the topmost selected branch inside the nearest common parent; selected roots move in | `LG:180-225` |
| Ungroup ⇧⌘G | Children spliced in at the folder's array slot; folder's opacity, mask, effects discarded; detached clips released | `LG:233-252` |
| Merge ⌘E | Down / Layers / Group, decided by `mergePlan`; composited as shown **into a canvas-sized surface** (off-canvas pixels lost), trimmed to alpha bounds; hidden layers in the merge vanish | `MRG` |
| Clipping | `maskSourceID` = base. ⌥⌘G / ⌥-click bottom strip toggles; create clips to the next lower sibling or its base; release releases the layer and the clipped run above it | `LLM:23-71, 212-244` |
| Masks | 8-bit gray, white reveals; any layer kind incl. folders and adjustments; 1×1 when uniform; `maskPlacement` when apart; `maskLinked` decides whether moves carry it | `LM:4-48`, `compositing.md` 6 |
| Mask target | `isMaskSelected`; swatches become black/white (`maskPaintWhite`); Brush, Smear Blur, Gradient, Fill, Invert work on it; filters do not | `Document/ColorPalette.swift:26-59`, `Document/EditorSession+Brush.swift:5-53` |
| Mask alone | ⌥-click mask thumbnail: canvas shows the mask in gray, edge tone beyond it; pill "Layer Mask · name" | `LM:229-236`, `Rendering/EditorCanvas.swift:938-953` |
| Delete with dependents | Deleting a clipping base that others still use opens an alert: Bake and Delete / Cancel / Remove Links and Delete | `LLM:100-130` |
| Port split | Predicates and trivially identical field edits in board JS; reordering/re-parenting/creating records through a new **stateless engine "structure session"**; pixel-reading operations through the existing full engine session | section 1.3 |

---

## 1. Port architecture for this area

### 1.1 State the board must add

The board keeps only `manifest.activeLayerID` today (`media/board.js:517-529`). Compositor's panel needs the
following session state. None of it is saved except `activeLayerID`, which already is.

| Board field (proposed) | Upstream | Type / default | Reset rules (upstream) |
|---|---|---|---|
| `board.selectedIDs` | `selectedLayerIDs` (`ES:640`) | `Set<string>`, `{activeLayerID}` after load | Any assignment of the active layer sets it to `{id}` (`ES:644`). Only `selectLayers` (`LG:144-153`), `duplicateLayers` (`SC:253`), `reloadProject` (`EditorSession+Projects.swift:52`) and the list's own selection set more than one |
| `board.isMaskSelected` | `isMaskSelected` (`ES:631`) | `false` | Cleared when the active layer changes (`ES:643`), when its mask is deleted (`LM:293`), on load (`EditorSession+Projects.swift:21`); kept across undo only if the active layer is the same and still has a mask (`ES:674-677`) |
| `board.viewsMaskAlone` | `viewsMaskAlone` (`ES:634`) | `false` | Cleared whenever `isMaskSelected` becomes false (`ES:631`). Effective only when `isMaskSelected && active has a mask` (`maskAloneLayer`, `ES:636-639`) |
| `board.maskPaintWhite` | `maskPaintWhite` (`ES:227`) | `false` (paint black, background white) | Never reset by targeting; X toggles, D sets `false` while a mask is targeted (`Document/ColorPalette.swift:43-55`) |
| `layers.collapsed` (exists) | `collapsedGroupIDs` (`ES:173`) | `Set` | Emptied on load (`EditorSession+Projects.swift:22`); ids removed by `revealActiveLayer`, new layer / folder / adjustment / place into a folder (`ES:710`, `LG:223, 280, 315`, `Document/LayerAdjustment.swift:224`); duplicates of collapsed folders are collapsed too (`SC:274-276`) |
| `board.renamingID` | `renamingLayerID` (`ES:647`) | `null` | Set by Rename menus and double-click; cleared when the field ends (`NLL:1114`) |
| `board.blendPreview` | `blendPreview` (`ES:629`) | `null` or `{id, mode}` | Set while the blend menu is open and an item is highlighted (`Document/LayerAppearance.swift:80-84`) |
| `board.effectSelection` | `effectSelection` | `null` | Owned by the effects spec; cleared by every layer selection (`LG:145`, `LM:223`). Listed because Delete consults it first (`Document/SelectionEdits.swift:77, 85`) |

Board functions that replace `board.select(id)` (exact ports):

```js
// activeLayerID.didSet (ES:641-646)
setActive(id) {
    if (id !== this.doc.manifest.activeLayerID) this.isMaskSelected = false; // also ends viewsMaskAlone
    if (!this.isMaskSelected) this.viewsMaskAlone = false;
    if (id) this.doc.manifest.activeLayerID = id; else delete this.doc.manifest.activeLayerID;
    this.selectedIDs = new Set(id ? [id] : []);
}
// selectLayer (ES:387-393)
selectLayer(id) {
    this.effectSelection = null;
    if (this.view.busy) return;                       // brushStroke / warpStroke (levels: no board equivalent)
    if (id !== this.activeID()) { this.selectTools.commitFloating(); /* commitTransform, resolveGradient */ }
    this.setActive(id);
    this.revealActiveLayer();
}
// selectLayers (LG:144-153)
selectLayers(ids, primary) {
    this.effectSelection = null;
    if (this.view.busy) return;
    const valid = new Set([...ids].filter((id) => this.doc.layer(id)));
    if (!sameSet(valid, this.selectedIDs)) this.selectTools.commitFloating();
    // Swift's `valid.first` is an arbitrary Set element; pick the topmost row so the port is deterministic.
    this.setActive(valid.has(primary) ? primary : topmostInPanelOrder(valid));
    this.selectedIDs = valid;
    this.revealActiveLayer();
}
// selectLayerTarget (LM:222-228): a thumbnail click.
selectLayerTarget(id, mask) {
    this.effectSelection = null;
    if (this.working || this.view.busy) return;       // isProjectBusy, isImporting, brushStroke
    this.selectLayer(id);
    this.isMaskSelected = mask && Boolean(this.activeLayer()?.maskFile);   // `activeLayer?.mask != nil`
    if (!this.isMaskSelected) this.viewsMaskAlone = false;
}
// revealActiveLayer (LG:156-165): open the active layer's ancestors; the list then scrolls it into view (NLL:95-97).
```

### 1.2 Gating predicates the board must compute synchronously

Menus, the context menu, footer buttons and the ⌥ cursors need these on every redraw or mouse move, so they are
ported to JS 1:1 (they read only the manifest and board state). Engine parity for them is checked by the test op
`layer.check` (section 19).

Mapping of Compositor's blocking states to board state:

| Upstream condition (`ES:688-701`) | Board equivalent |
|---|---|
| `brushStroke`, `warpStroke`, `pixelMove` (mouse is down) | `board.view.busy` |
| `isProjectBusy` | `board.working > 0` (an engine call is out) |
| `selectionAmountOperation`, `colorRange` | `board.openPanel` (Expand/Contract/Feather), `board.selectTools.colorRange` |
| `filterEdit`, `hueSaturation`, `levels` | `board.filters.isOpen` |
| `transformEdit` (any) / `transformEdit?.persistent` | `board.selectTools.floating` or a ⌘T transform in progress / the same, persistent ones only |
| `textDraft`, `cropRect`, `gradientEdit`, `adjustmentEditingID`, `isImporting`, `showsNewDocument`, `showsImporter` | not in the board yet; `false` until those tools exist |
| `renamingLayerID != nil` | `board.renamingID !== null` |
| `showsBusy` (busy for more than 250 ms, `ES:130-140`) | `board.working > 0` for more than 250 ms (start a timer when `working` goes 0 → 1) |

```js
canEditLayers = doc && !view.busy && !working && !openPanel && !colorRange && !filters.isOpen && !renamingID
             && !transformPending && !cropRect && !gradientEdit && !textDraft && !adjustmentEditingID;     // ES:698-701
layersLookEditable = doc && !openPanel && !colorRange && !textDraft && !busyOver250ms && !renamingID
             && !(transformPending && transformPending.persistent) && !cropRect && !gradientEdit
             && !filters.isOpen && !adjustmentEditingID;                                                  // ES:692-697
canEditAppearance = canEditLayers && selectedIDs.size === 1 && active && !active.isGroup;            // LayerAppearance.swift:85
canEditOpacity    = canEditLayers && selectedIDs.size === 1 && active;                               // LayerAppearance.swift:88
canEditMask       = canEditLayers && selectedIDs.size === 1 && active;                               // LM:221
canUngroupLayers  = canEditLayers && active?.isGroup === true;                                       // LG:228
canConvertLayerDepth = canEditLayers && selectedIDs.size <= 1 && active && !active.text && !active.adjustment && !active.isGroup; // DeepLayers.swift:275-278
canMoveActiveLayer(offset): canEditLayers && active && siblings(active)[indexOf(active) + offset] exists;  // ES:795-800
canPlaceLayer(id, parent): canEditLayers && layer(id) && (parent === null
             || (parent !== id && !descendantIDs(id).has(parent) && layer(parent)?.isGroup === true));    // LG:291-296
canCopyMask(source, target): canEditLayers && source !== target && layer(source)?.maskFile && layer(target) && !layer(target).isGroup; // LM:297-302
```

`siblings(layer)` is `layers.filter(l => (l.parentID || null) === (layer.parentID || null))` in **array** order, as
`$0.parentID == layer.parentID` in Swift. `descendantIDs` is `LG:257-264`. `active.text` stands for `liveText`
(`Document/TypeTool.swift:217-220`): the manifest only carries `text` while the PNG is still the text's own raster.

Clipping and merge predicates are in sections 6 and 16.

### 1.3 Three execution paths, and which operation uses which

The decision rule:

- **A. Board JS, exact port.** The mutation is a direct field assignment, or a removal, once the JS predicate says
  yes, and touches no pixels other than copying an 8-bit gray mask: rename, visibility, opacity, blend, ⌘[ / ⌘],
  expand/collapse, mask enable / link / delete / add solid / copy, clipping create / release, delete (no
  dependents, or "Remove Links"). These are instant and are recorded with `board.edit(label, fn)`.
- **B. Engine structure session (new, stateless, no flush).** The mutation reorders, re-parents or creates records:
  Group, Ungroup, Move Out of Folder, drag move / drop into folder / ⌥-drag copy, Duplicate, and Add Mask *from a
  selection* (which rasterizes the selection, `LM:240-267`). The engine runs the real `EditorSession` method on a
  session built from the board's **current manifest** with placeholder images of the right pixel sizes (no PNG is
  read or written), and returns the resulting records, selection state and undo name; the board applies them as
  one local `board.edit` (section 19.2). Exact, a few milliseconds, and no package re-save.
- **C. Engine full session (existing `withSession`).** The operation reads pixels: Merge (⌘E), Convert to 16-Bit /
  8-Bit, Delete with "Bake and Delete", Layer via Copy (exists), Fill / Clear / Invert on a mask (exist, but must
  now send `isMaskSelected` and `maskPaintWhite`). The board flushes, the engine loads, edits, saves, and the
  change arrives as one undo step named `session.history.undoName` (`engine/Sources/SelectionOps.swift:140-148`).

| Operation | Path | EditorSession method |
|---|---|---|
| New Blank Layer ⇧⌘N | A (exists, fix 6.1) | `addBlankLayer()` `ES:703-731` |
| Rename | A (exists) | `renameLayer(_:to:)` `ES:754-760` |
| Show/Hide, eye swipe | A (swipe missing) | `toggleLayerVisibility` `ES:762-767`, `beginVisibilitySwipe`/`setVisibilityInSwipe`/`endVisibilitySwipe` `ES:771-783` |
| Opacity, blend, blend cycling | A (exists, fix 2.x) | `Document/LayerAppearance.swift:89-137` |
| Move Layer Up/Down ⌘] ⌘[ | A (exists, fix enabling) | `moveActiveLayer(by:)` `ES:801-810` |
| Collapse/expand | A | `toggleGroupExpansion` `LG:283-290` |
| Create/Release Clipping Mask ⌥⌘G, ⌥-click | A | `toggleClippingMask` `LLM:221-230` |
| Delete layers (no dependents / Remove Links) | A (exists for one layer, fix) | `finishDeletingLayer(s)` `LLM:131-154` |
| Delete with Bake | C | `LiveMaskBaker.bake` + `finishDeletingLayers` `LLM:74-130` |
| Add Reveal-All / Hide-All mask | A | `addLayerMask(revealing:)` `LM:270-278` |
| Add mask from selection | B (or C) | `addMask(revealing:)` `LM:240-267` |
| Enable/Disable, Link/Unlink, Delete mask | A | `LM:279-295, 319-327` |
| Copy mask (⌥-drag thumbnail) | A | `copyMask(from:to:)` `LM:305-317` |
| Group / New folder ⌘G | B | `groupSelectedLayers()` `LG:180-225` |
| Ungroup ⇧⌘G | B | `ungroupLayers()` `LG:233-252` |
| Move Out of Folder | B | `moveActiveLayerOutOfGroup()` `LG:319-323` |
| Drag move / into folder / ⌥-drag copy | B | `NLL:470-497` (`placeLayer`, `duplicateLayer`) |
| Duplicate ⌘J, context Duplicate | B | `duplicateActiveLayer()` `SC:225-278` |
| Merge Down / Layers / Group ⌘E | C | `mergeLayers()` `MRG:34-104` |
| Convert to 16-Bit / 8-Bit | C | `convertLayerDepth()`, `convertHDRToSixteenBit()` `Document/DeepLayers.swift:282-328` |
| Layer via Copy ⌘J (selection) | C (exists) | `layerViaCopy()` `SC:206-215` |

### 1.4 What every engine request must carry and return

Today `engine/Sources/EngineMain.swift:61-73` sets only `activeLayerID` and `selectedLayerIDs = [id]`, and
`configure` (`engine/Sources/SelectionOps.swift:126-134`) sets `isMaskSelected` and colors; the board never sends
`isMaskSelected` (`media/board.js:969`). Every engine request from now on sends, after `activeLayerID`:

| Arg | Set on the session as | Why |
|---|---|---|
| `selectedLayerIDs: [id]` | `session.selectedLayerIDs = Set(ids ∩ document ids)` **after** `activeLayerID` (the setter resets it) | merge, duplicate, group, delete, `canPaint`, `canEditMask`, `canInvert` all read it |
| `isMaskSelected: bool` | `session.isMaskSelected` (only if the active layer has a mask) | fill, clear, invert, layer via copy, copy |
| `maskPaintWhite: bool` | `session.maskPaintWhite` | `paletteColor` on a mask (`Document/ColorPalette.swift:26-28`) |
| `collapsedGroupIDs: [id]` | `session.collapsedGroupIDs` | group / place / duplicate expand or copy collapsed state |

Every answer adds `activeLayerID`, `selectedLayerIDs`, `isMaskSelected`, `collapsedGroupIDs` (all read back from the
session after the call) and `editName`. The board applies them after the external change has been merged (the
extension posts `external` before `engineResult`, `vscode-extension/extension.js:266-277`).

---

## 2. Panel layout (checklist "Panel layout")

**"Docked panel on the right of the canvas: width 222...352 pt, default 252 pt, persisted …"**
- Upstream: `@AppStorage("layersPanelWidth") … = 252.0` (`ContentView.swift:6`), range `222...352`
  (`UI/LayersPanel.swift:9`); the panel is given `min(352, max(222, saved))` (`ContentView.swift:123-126`); not shown
  while `session.canvasOnly` (Toggle Fullscreen).
- Board: exists (`media/board.js:40, 97-129`). Fixes: clamp the saved width on load (`saved.panelWidth` is used
  unclamped); hide the panel and its divider in canvas-only mode when that mode is ported.

**"Resize edge …"**
- Upstream (`ContentView.swift:375-394`): an 8 pt clear strip centered on the divider, `.pointerStyle(.columnResize)`,
  `DragGesture(minimumDistance: 1)`, `width = min(352, max(222, (start - translation.width).rounded()))`, tooltip
  **"Drag to resize the panel"**.
- Board: change the title from "Drag to resize" to the verbatim text, add `Math.round`, `cursor: col-resize`, an 8 px
  hit strip, and a 1 px drag threshold.

**"Header: title "Layers" plus the total layer count …"**
- Upstream (`UI/LayersPanel.swift:13-18`): "Layers" 12 pt semibold; `document.layers.count` (every record, folders and
  adjustments included) in caption monospaced digits, tertiary; padding 18.
- Board: exists; it appends " · N notes" (board-only, section 21). Keep.

**"Empty state …"**
- Upstream (`UI/LayersPanel.swift:22-33`): SF `square.3.layers.3d` 25 pt light, **"No layers yet"** (callout,
  medium), then **"Create a canvas or import an image."** when there is no document, **"Import an image or add a
  blank layer."** otherwise; secondary color, centered, padding 16.
- Board: says "Add a blank layer with +." (`media/layers.js:161`). Replace with the verbatim second string.

**"Whole panel grays out (layersLookEditable) …"**
- Upstream: `layersLookEditable` (`ES:692-697`, 1.2) disables the footer buttons and menus (`UI/LayersPanel.swift:39,
  41, 48, 56, 62`; `UI/LayerMaskMenu.swift:15`) and each row's eye and disclosure (`NLL:997, 1060`). The Blend and
  Opacity controls follow `canEditAppearance` / `canEditOpacity`, which use `canEditLayers`
  (`UI/LayerAppearanceControls.swift:14, 37`). Rows stay selectable. Thumbnails are disabled only while busy over
  250 ms or importing (`NLL:1028-1029`).
- Board: compute `layersLookEditable` (1.2) and disable exactly those controls; do not dim the whole list.

**"Blend mode pop-up ("Blend" row …) …"**
- Upstream: caption "Blend" (`.caption`) then the pop-up, row disabled unless `canEditAppearance`
  (`UI/LayerAppearanceControls.swift:11-14`). The pop-up is an `NSPopUpButton`, capsule border, width
  `max(proposed, 60)` (`UI/BlendModePicker.swift:20-29`), accessibility label "Blend mode".
- Board: the `<select>` is disabled only for folders (`media/layers.js:144`). Use `!canEditAppearance` (also off for
  multi-selection and while `canEditLayers` is false). See the next item for the menu itself.

**"Blend mode list, 24 modes in 6 groups …"**
- Upstream: `LayerBlendMode.groups` (`Document/LayerAppearance.swift:17-24`) with a separator between groups
  (`UI/BlendModePicker.swift:11-14`); raw values are the item titles. Note `ui.md` 7.2 says "26 modes": the code has
  **24**.
- Board: `Blend.MODES` / `GROUP_STARTS` already match; separators are disabled options.

**"Blend mode live preview …"**
- Upstream (`UI/BlendModePicker.swift:46-76`, `Document/LayerAppearance.swift:76-84`): on menu open remember the active
  id; each highlighted item calls `previewBlendMode(mode, for: id)`, which sets `blendPreview` only if `id ==
  activeLayerID && canEditAppearance`; the canvas draws `displayedBlendMode` (`blendPreview.mode` for that layer). On
  close the preview is cleared on the next run-loop turn; choosing runs `setLayerBlendMode(mode)` first, one undo step
  **"Layer Blend Mode"** (no step when the mode is unchanged, because the document is equal, `DocumentHistory.swift:68`).
- Port: a native `<select>` cannot report highlighted options. Replace it with a button that opens the board's own
  menu (`board.menu`) listing the 24 modes with separators; `pointerenter` / keyboard highlight sets
  `board.blendPreview = {id, mode}` and repaints; `render.js` must read `blendPreview` in `drawLeaf` / `drawStack`
  (`record.blendMode` → `displayedBlendMode(record)`). Closing clears it; choosing calls `actions.setBlend`.

**"Blend mode cycling: Shift-+ / Shift-− …"**
- Upstream (`Document/LayerAppearance.swift:124-129`): needs `canEditAppearance`; `LayerBlendMode.allCases` order
  (declaration order, identical to the menu), wraps; one step "Layer Blend Mode"; any tool
  (`Rendering/EditorCanvas.swift:784-787`).
- Board: exists (`media/board.js:1339-1342`); gate with `canEditAppearance` instead of `!record.isGroup`.

**"Opacity slider …"**
- Upstream: `Slider(0...1)` with no step: values are stored **unrounded** (`setLayerOpacity` clamps to 0...1,
  `Document/LayerAppearance.swift:99-107`). Drag start `beginOpacityEdit()` opens the step, every move sets the value
  inside it, drag end `finishOpacityEdit()` closes it: one step **"Layer Opacity"**, none if unchanged. Enabled by
  `canEditOpacity` (folders included; their opacity dims the contents).
- Board: slider `step=1` and `previewOpacity` rounds to 0.01 (`media/board.js:1631`). Use `step="any"` (or 0.001) and
  store the raw value; disable unless `canEditOpacity`.

**"Opacity percent field …"**
- Upstream (`UI/LayerAppearanceControls.swift:25-58`): `TextField("Opacity percent")`, 44 pt, rounded border, "%"
  caption. Return or Esc → `focused = false` and `canvasFocusRequest += 1`; losing focus runs `applyPercentage`:
  `Double(text)` if finite → `setLayerOpacity(value / 100)` (clamped; decimals allowed), then the text resyncs to
  `Int((opacity * 100).rounded())` (half away from zero). Up/Down step 1, ⇧ 10 (`arrowSteps`), each a standalone
  step. A non-number just resyncs.
- Board: Enter/Escape blur and focus the canvas (exists); `change` applies (exists). Fix: accept decimals without
  rounding the stored value; display `Math.round` with half-away-from-zero (`Math.sign(v) * Math.round(Math.abs(v))`).

**"Opacity label scrub …"**
- Upstream (`UI/NumericScrub.swift:16-42`): hover shows `resizeLeftRight`; `DragGesture(minimumDistance: 1)`;
  `value = clamp(start + translation.width * 1, 0, 100)` with **no step** (fractional points give fractional
  percents); `onStart` = `beginOpacityEdit`, `onEnd` = `finishOpacityEdit`: one step.
- Board: exists (`media/layers.js:91-100`) but rounds to whole percents and uses `ew-resize`; drop the rounding.

**"Footer button New blank layer (plus.square icon) …"**
- Upstream (`UI/LayersPanel.swift:37-39`): `addBlankLayer()`, tooltip **"New blank layer (⇧⌘N)"**, a11y "New blank
  layer", disabled unless `layersLookEditable`.
- Board: exists; gate it.

**"Footer button New folder (folder.badge.plus) …"**
- Upstream (`UI/LayersPanel.swift:40-41`): `groupSelectedLayers()` (not `addGroup()`, which is never called), tooltip
  **"Group selected layers (⌘G)"**, a11y "New folder". With nothing selected `selected` is empty, so the new folder
  is appended at the top of the root (`LG:209-211`).
- Port: path B `layer.group` (section 6.6).

**"Footer button Add layer mask …"** → section 10.

**"Footer menu New adjustment layer (circle.lefthalf.filled) …"**
- Upstream (`UI/LayersPanel.swift:43-48`): a borderless menu, items `kind.rawValue` (no ellipsis here; the Layer menu
  adds "…" for editable kinds, `APP:343-345`), in `AdjustmentKind.allCases` order: Hue/Saturation, Levels, Curves,
  Exposure, Gradient Map, Grain, Add Noise, Gaussian Blur, Motion Blur, Invert, Black & White, Color Balance; tooltip
  "New adjustment layer". `addAdjustment(kind)` (`Document/LayerAdjustment.swift:208-229`) inserts at
  `index(active) + 1` with `parentID = active.isGroup ? active : active.parentID` (so with a folder active it lands
  at the folder's array slot + 1, i.e. usually the **bottom** of the folder's contents, unlike New Blank Layer),
  refuses at 10,000 layers, undo "New <Kind> Adjustment", then opens the editor unless Invert.
- Port: adjustments spec. The record insertion is a path A edit.

**"Footer menu Add layer effect (sparkles) …"**
- Upstream (`UI/LayersPanel.swift:49-56`): items `kind.rawValue + "…"`: Stroke…, Drop Shadow…, Color Overlay…, Inner
  Shadow…, Outer Glow…, Inner Glow…; tooltip "Add layer effect", a11y "Layer effects"; disabled unless
  `layersLookEditable && active is not a folder && active has pixels`.
- Port: effects spec.

**"Footer trash button …"**
- Upstream (`UI/LayersPanel.swift:58-62`): `deleteLayerOrMask()`; tooltip and a11y: **"Delete selected effect"** if
  `selectedEffect`, else **"Delete layer mask"** if `isMaskSelected`, else **"Delete selected layers"** if more than
  one is selected, else **"Delete selected layer"**; disabled unless `layersLookEditable && activeLayer != nil`.
- Board: title is "Delete selected layer (⌫)" and it always deletes the active layer. Use the four texts and route
  through `deleteLayerOrMask` (section 6.13).

**"Footer icons dim to quarter-strength white when disabled; enlarged 8x12 pt hit areas"**
- Upstream (`UI/LayersPanel.swift:35-36, 64-65, 79-100`): `HStack(spacing: 0)`, padding h8 / v4, each icon wrapped
  in `padding(.horizontal, 8).padding(.vertical, 12)` as its hit area; enabled icons `.primary`, disabled white at
  0.5 which SwiftUI halves again (measured quarter-strength white); the whole footer `.foregroundStyle(.secondary)`.
- Board: footer has only `+` and trash. Add the five icons and spacer in this order: `plus.square`,
  `folder.badge.plus`, `rectangle.inset.filled`, `circle.lefthalf.filled` (menu), `sparkles` (menu), spacer, `trash`.
  Lucide: `square-plus`, `folder-plus`, `square-square`, `contrast`, `sparkles`, `trash-2`. Disabled color
  `rgba(255,255,255,0.25)`; each button `padding: 12px 8px`.

---

## 3. Rows (checklist "Rows")

Row anatomy, left to right, from `NLL:869-978` (`ui.md` 7.3 has the same in a table):

| Element | Geometry | Notes |
|---|---|---|
| Eye | leading 8, 20 × 32, centerY = top + 26 | `eye` / `eye.slash`; no tooltip, a11y "Hide <name>" / "Show <name>" (`NLL:1058-1059`) |
| Disclosure | leading = eye.trailing + indentation, 16 × 24 | folders only; `chevron.down` open / `chevron.right` collapsed; a11y "Expand or collapse folder" (`NLL:996-998`) |
| Layer thumbnail | slot 36 wide starting at disclosure.trailing − 2; image `fittedSize(canvas, 36)` | radius 3 |
| Link button | 9 × 20, centerX = mask slot leading − 6.5 | only when the layer has a mask and is not a folder or adjustment (`NLL:1030-1037`) |
| Mask thumbnail | slot 30 wide, gap after the layer slot 13 (with link) or 5; image `fittedSize(canvas, 30)` | hidden without a mask (slot width 0) |
| Disabled mark | red "╱", system 32 pt medium, `systemRed`, centered on the mask thumbnail | `NLL:907-909, 963-964, 1027` |
| Name | leading = mask slot trailing + 5, trailing −8, top 9; 13 pt, one line, tail truncation | `NLL:911-916, 965-967` |
| Subtitle | 3 below the name, 10 pt secondary, tail truncation, low compression resistance | `NLL:917-918, 968-970, 975-977` |
| Depth tag | 5 after the subtitle, centered on it | `NLL:971-974, 1443-1457` |
| Effect sub-rows | from top + 52, 24 pt each | effects spec |
| Hairline | 1 device pixel, white 6%, along the bottom | `NLL:923-930, 1410-1417` |

**"Native list, top layer first, row height 52 pt plus 24 pt per effect sub-row, 2 pt row spacing, faint 1-device-pixel hairline …"**
- Upstream: `rowHeight = 52`, `intercellSpacing = (0, 2)`, `heightOfRow = 52 + effects.kinds.count * 24`
  (`NLL:15-16, 363-365`); list = `layerRows` (`LG:254-256`).
- Board: rows are 52 px with 2 px margin; the hairline is `::after` at 1 CSS px. Use
  `height: calc(1px / devicePixelRatio)` (set a CSS variable from JS) and grow the row by 24 px per effect.

**"Click selects on mouse-down … Shift-click extends a range and Cmd-click toggles rows …"**
- Upstream: the table allows multiple and empty selection (`NLL:17-18`). `mouseDown` (`NLL:755-781`): an ⌥ click in the
  clipping strip is handled first (section 16); a click on an effect sub-row selects the effect; otherwise, with
  neither ⌘ nor ⇧ and unless the row is already part of a multi-selection, the row is selected immediately, the table
  becomes first responder, then AppKit tracking runs (so a plain press on a row inside a multi-selection keeps the
  group for dragging; releasing without a drag selects only that row, standard `NSTableView`). ⇧ extends a range
  from the anchor; ⌘ toggles a row. Every change calls `selectLayers(ids, primary: clickedRow if selected, else the
  first selected row, i.e. the topmost)` (`NLL:373-379`).
- Board: replace `board.select(record.id)` in `pointerdown` (`media/layers.js:312`) with: plain press → if the row is
  not in a multi-selection `selectLayers({id}, id)`, else defer to `pointerup` without a drag; ⇧ → range from an
  anchor id (the last plain-clicked row) over the visible rows; ⌘ → toggle. Row highlight `.on` for every selected
  row (not only the active one). Selecting is never an undo step.

**"A newly selected layer (e.g. picked on the canvas) is scrolled into view and its collapsed ancestor folders are expanded"**
- Upstream: `revealActiveLayer()` (`LG:156-165`) in `selectLayer`/`selectLayers`; the list scrolls the active row
  into view only when the active id changed (`NLL:94-97`).
- Board: `revealActiveLayer` removes ancestors from `layers.collapsed`, re-renders if any changed, then
  `row.scrollIntoView({block: 'nearest'})` only when the active id changed.

**"Visibility eye button (eye / eye.slash) toggles the layer, one undo step "Show Layer"/"Hide Layer""**
- Upstream: `EyeSwipeButton.mouseDown` → `beginVisibilitySwipe` (`NLL:1423-1440`, `ES:771-777`): the name is "Show
  Layer" when the layer becomes visible, else "Hide Layer"; needs `canEditLayers`; the eye is disabled unless
  `layersLookEditable`.
- Board: exists as a click; fold into the swipe below.

**"Eye swipe …"**
- Upstream: on press `beginEdit(name)` and set the pressed layer; while the button is down, every row under the
  pointer gets the same state (`setVisibilityInSwipe` skips rows already in that state), the table autoscrolls; on
  release `endEdit()`. One step.
- Board: `pointerdown` on `.eye` → `setPointerCapture`; remember `visible = !record.isVisible` and
  `metaBefore = doc.snapshot()`; apply to the pressed record; on `pointermove` find the row under `clientY` (from the
  rows' rects, not `elementFromPoint`, because rows are re-rendered) and apply; autoscroll the list when within 16 px
  of its top or bottom; on `pointerup` push one history entry `{label, metaBefore, metaAfter}` if changed. Do not
  rebuild rows during the swipe; update eye icons and the `.hidden-effective` class in place.

**"Rows of layers hidden through a hidden parent folder draw at 35% opacity"**
- Upstream: `alphaValue = visible ? 1 : 0.35` where `visible` is the effective visibility (the layer's own flag and
  every ancestor's, `LG:17`), applied to the **whole cell** including the eye (`NLL:1063`).
- Board: `.row.hidden-effective > :not(.eye)` leaves the eye bright. Use `.row.hidden-effective { opacity: 0.35 }`.

**"Folder disclosure chevron … collapsing a folder that holds the active layer selects the folder"**
- Upstream (`LG:283-290`): needs `!isProjectBusy` and a folder; expanding just removes the id; collapsing first calls
  `selectLayer(folder)` when the active layer is a descendant. Not an undo step.
- Board: disclosure exists (`media/layers.js:289-298`); add the select-folder rule and the `working` guard.

**"Indentation: 24 pt per folder depth (visual cap 8 levels) plus 24 pt more for a clipped layer …"**
- Upstream: `indentation = min(depth, 8) * 24 + (maskSourceID == nil ? 0 : 24)` (`NLL:994-995`), effect sub-rows the
  same (`NLL:989`).
- Board: matches (`media/layers.js:173`).

**"Layer thumbnail (36 pt box) …"**
- Upstream (`NLL:999-1014`, `UI/CanvasThumbnail.swift:10-33`): framed (canvas-shaped) unless adjustment, folder or
  live text; size `fittedSize(canvas, 36)` = `max(1, round(canvas * 36 / max(w, h)))` per side; drawn at backing
  scale 2: fill gray **0.22**, then gray **0.32** tiles of 12 px (6 pt) where `(row + column)` is **even**, origin
  top-left; then the layer's 96 px thumbnail placed by its transform. Folder: SF `folder` at 80% of the 36 pt slot,
  template-tinted. Adjustment: the kind's symbol at 1.21× natural size in a 36 pt template image, Curves turned 90°
  clockwise. Live text: `textformat` the same way.
- Board: draws the right content (`media/layers.js:229-256`), but the checkerboard parity is inverted (tile (0,0) is
  `#383838`; it must be the lighter `#525252`), and folders, adjustments and text use a 34 px boxed icon. Draw the
  icons unboxed in the 36 px slot, tinted `--text2`.

**"Layer thumbnail click targets the layer's pixels (accent 2 pt border); tooltip "Select image pixels" or "Editable text layer""**
- Upstream: plain click → `selectLayerTarget(id, mask: false)` then the table's own mouse-down (`NLL:1131, 1378-1379`).
  Tooltip set in `configure`: **"Editable text layer"** for live text, else **"Select image pixels"** (`NLL:1038`;
  the init-time "Select layer; Cmd-click to select its pixels (Cmd-Shift adds, Cmd-Option subtracts)" at `NLL:899` is
  always overwritten). Border (`updateTarget`, `NLL:1079-1086`): `controlAccentColor`, width 2 on the layer
  thumbnail when `active && selectedLayerIDs.count == 1 && !isMaskSelected`, on the mask thumbnail when the same with
  `isMaskSelected`.
- Board: outline on `.row.on .thumb` regardless of target or selection size, tooltip is the init-time text. Use
  `updateTarget` exactly; tooltips verbatim (folders included: they also say "Select image pixels").

**"Cmd-click layer thumbnail loads the layer's visible … pixels as the selection …"** — `[x]` done (`selection.md`
4.3). Keep the `⌘`-hover cursor rule (`NLL:1349-1358`): only while hovered, enabled, ⌘ held without ⌥.

**"Double-click on a row's thumbnail opens what it holds … double-click on the name renames"**
- Upstream (`NLL:392-405`): `doubleAction` needs `canEditLayers`; sets `activeLayerID = id`; if the second click is on
  one of the row's controls (`isOnControl`: eye, disclosure, thumbnail, link, mask thumbnail, `NLL:1134-1136`) then
  live text → `editActiveText()`, editable adjustment → `adjustmentEditingID = id`; otherwise (and for any other
  layer, including a double-click on a pixel layer's thumbnail) `renamingLayerID = id`.
- Board: renames only on `.labels`. Port the rule; text and adjustment editing belong to their specs (until they exist,
  a double-click on such a thumbnail does nothing rather than renaming).

**"Clicking the row's name while its mask is targeted switches the target back to the layer pixels …"**
- Upstream (`NLL:382-391`): table `action` on a click when `isMaskSelected && selectedLayerIDs == [row]` and the
  click is not on a control → `commitTransform()`, `selectLayerTarget(row, mask: false)`.
- Board: on `click` of `.labels` / row background with that condition.

**"Name label: single line, truncating; clipped layers prefixed "↳ ""**
- Upstream: `(maskSourceID == nil ? "" : "↳ ") + name` (`NLL:1046, 1118`). Board: matches.

**"Subtitle line …"**
- Upstream (`NLL:1047, 1053-1057, 1474-1481`), in this order, the later rule overriding:
  1. live text → **"Text · Double-click to edit"**; adjustment → **"Adjustment · Double-click to edit"**; folder →
     **"Folder"**; otherwise `sizeLabel`: `"\(Int(size.width.rounded())) × \(Int(size.height.rounded())) px"` from
     the **transform size** (a blank layer shows the canvas size), plus `" · " + percent` with 0-1 fraction digits
     (locale formatting, so `1,234.5`) when the layer has pixels and `abs(size.width / image.width * 100 - 100) >=
     0.05`.
  2. if `maskSourceID` is set (even on text or adjustment layers): **"Clipped to <source name>"**, with
     **"Missing source"** when the base is gone, and tooltip **"Clipping mask based on <name>. Option-click the bottom
     of its row to release."**
- Board (`media/layers.js:177-186`): uses the image's pixel size, shows "Empty" for blank layers, "Adjustment ·
  <kind>", "Text · edit the text in Compositor", lets folder/adjustment/text win over "Clipped to", and says "a missing
  layer". Port the rules verbatim. (Whether the board can edit text is the text spec's call; until it can, keeping a
  board-specific text subtitle is an adaptation to list in section 21.)

**"Depth tag pill "16-Bit" or "HDR" …"**
- Upstream: `depthLabel` = "HDR" or "16-Bit" for a layer with deep pixels that is not live text, adjustment or folder
  (`NLL:1485-1488`); hidden on clipped rows (`NLL:1051`); tooltips **"HDR layer: keeps light brighter than white,
  shown as white"** / **"16-bit layer: keeps 16 bits a channel"**; pill: 9 pt medium secondary text on
  `quaternaryLabelColor`, height 14, width text + 10, fully rounded.
- Board: shows the pill; add the tooltips and hide it on clipped rows.

**"Inline rename …"**
- Upstream (`NLL:1089-1130`, `ES:754-760`): the label becomes editable with a quaternary background and all text
  selected; Return or end of editing (clicking away) → `renameLayer(id, to:)`: trimmed of whitespace and newlines,
  ignored when empty, one step **"Rename Layer"** (no step for the same name); Esc restores; focus returns to the
  list. While renaming, `canEditLayers` and `canUseHistory` are false.
- Board: exists. Set `board.renamingID` while the field is open (gates and undo depend on it) and return focus to the
  list (`.layer-list` has `tabindex=0`) instead of the canvas.

**"Middle-mouse drag anywhere in the list scrolls it (closed-hand cursor) …"**
- Upstream (`NLL:521-548, 739-741`): button 2 down anywhere (even over thumbnails, eyes, effects) starts a scroll;
  `bounds.origin.y += dy`, closed-hand cursor; no selection or drag.
- Board: `pointerdown` with `button === 1` on `.layer-list`: `preventDefault()` (stops Chromium's autoscroll),
  capture, `list.scrollTop -= dy` per move, `cursor: grabbing`; skip all row handlers.

**"Cmd-A with the list focused selects the whole canvas …"**
- Upstream: `LayerTableView.selectAll` → `session.selectAll()` (`NLL:550-555`).
- Board: the document-level ⌘A already selects the canvas; make sure the list never handles ⌘A itself.

**"List keeps canvas keys working while focused …"**
- Upstream (`NLL:782-817`): Esc / Return cancel / commit a pending transform; plain Tab cycles the tool mode; X swaps,
  D resets colors (mask-aware, section 11); tool letters A V H Z B E G L M W J S U R I C T; digits →
  `typeOpacityDigit` when `usesOpacityKeys`; ⌫ / ⌦ → `deleteKeyPressed()`; anything else goes to the table (arrows
  move the row selection, ⇧-arrows extend it).
- Board: the document `keydown` already handles these. Two gaps: (1) with the list focused and neither the Move tool
  nor a transform active, ↑ / ↓ must move the row selection (⇧ extends) instead of nudging a selection outline;
  (2) digits with the Move tool apply to **every selected layer** (`setSelectedLayersOpacity`, one step "Layer
  Opacity", unchanged layers skipped, `Document/LayerAppearance.swift:110-121`), not only the active one.

**"Arrow keys in the list nudge the selected layer 1 px (Shift 10 px) … when the Move tool or a transform is active"**
- Upstream: `nudgeLayer(dx:dy:)` (`ES:570-579`); with an unlinked mask targeted it moves only the mask (section 12).
- Board: exists through the document handler (`media/board.js:1357-1365`).

**"Option held over a row shows the duplicate cursor …, over the bottom 10 pt strip the create/release-clipping cursor, over a mask thumbnail the show-mask (eye) cursor"**
- Upstream (`NLL:594-738`): only with ⌥ and without ⌘, inside the list. Over a visible mask thumbnail: `showMaskCursor`.
  In the clipping zone (section 16) of a non-folder row: `createClippingCursor` if `maskSourceID == nil`, else
  `releaseClippingCursor`, but the arrow when `!canToggleClippingMask(row)`. Elsewhere on a row:
  `CanvasView.duplicateCursor` if `canEditLayers`, else the arrow. Updated on mouse move and on modifier changes.
- Board: on `pointermove` over the list and on `keydown`/`keyup` of Alt (the board tracks `view.altHeld`), set
  `list.style.cursor` from the same rules. Cursors as CSS data-URL images (section 21):
  - clipping: 30 × 28 pt; `arrow.turn.down.right` (16 × 15 at x 1, y 11 from the bottom) and
    `rectangle.badge.plus` / `.minus` (19 × 17 at x 10, y 1 from the bottom), each black with a 1 pt white outline
    (drawn 16 times offset around a circle), hotspot (3, 3) (`NLL:594-615`);
  - show-mask: the duplicate cursor with a small `eye.fill` (7.5 × 5.5) at hotspot + (15, 18), white-outlined
    (`NLL:616-638`).

---

## 4. Drag and drop (checklist "Drag and drop")

AppKit drag-and-drop is replaced by pointer events (`ui.md` 12.1: the webview preload intercepts HTML5 drops). The
board's `beginDrag` (`media/layers.js:361-407`) is the base.

**"Drag rows to reorder …"**
- Upstream:
  - Only with `canEditLayers` (`NLL:406-411`). The dragged ids are the selected rows (AppKit drags the selection when
    the pressed row is selected), minus anything inside a dragged folder, in panel order (`NLL:503-510`).
  - Drop target (`NLL:412-439`): AppKit proposes `row` and `.above` / `.on`. `.on` is kept only for a folder row
    ("into"); on any other row it is turned into `.above` that row. Parent = the folder (into), else the target row's
    `parentID`; past the last row: root, bottom. Refused unless `canPlaceLayer` holds for every dragged id.
  - `place` (`NLL:470-497`): `current[row]` is the row **under** the drop line; layers go directly above it in its
    parent (`placeLayer(id, in: parent, above: target)`, insertion at target's array index + 1, `LG:298-318`); past
    the end `atBottom` (array index 0, root). Order: `intoFolder ? ids.reversed() : ids` so the panel order is kept.
    One edit **"Move Layer"** / **"Move Layers"** (count of dragged ids); each `placeLayer` runs `adoptClipping` then
    `releaseDetachedClipping` and `LayerHierarchy.validate`, sets `activeLayerID = id` and expands the parent; at the
    end, if anything moved, `selectLayers(Set(ids), primary: ids.first)`.
- Port: path B `layer.place` (section 19). The board keeps the hit-testing and the drop line:
  - Folder rows: top third → line above the row, middle third → into (row outlined), bottom third → line below.
    Other rows: top half above, bottom half below. (AppKit's exact split is private; this matches it except that
    AppKit turns a non-folder row's middle into "above this row".)
  - Show no line and refuse the drop where `canPlaceLayer` fails (dropping a folder into itself or a descendant).
  - Autoscroll within 16 px of the list's top or bottom while dragging.
  - Send `{ids, intoFolder, rowID: id of the row under the line or null for the end, copying: altKey at release}`.

**"Drop onto a folder row nests the layer(s) inside it, landing on top of its contents; the folder expands"**
- Upstream: `placeLayer(id, in: folder, above: nil)` → insertion at `layers.count` (end of the array, so top of the
  folder) and `collapsedGroupIDs.remove(folder)` (`LG:303, 315`).
- Port: included in `layer.place`; apply `collapsedGroupIDs` from the answer.

**"Dragging a folder carries its whole subtree; a folder cannot be dropped into itself or its descendants"**
- Upstream: the folder's descendants keep their `parentID`, so they move with it (only the dragged root changes);
  `canPlaceLayer` rejects `parent == id` and descendants (`LG:291-296`).

**"Option-drag duplicates instead of moving …; one undo step "Duplicate Layer(s)""**
- Upstream: `draggingSourceOperationMask == .copy` (⌥ held) → `duplicateLayer(id, in: parent, above:, atBottom:)` per id
  (`SC:283-292`): `selectLayer(id)`, `duplicateActiveLayer()` (copies only that layer and its subtree, because
  selecting reset `selectedLayerIDs`), then `placeLayer(copy, …)`. Outer edit **"Duplicate Layer"** /
  **"Duplicate Layers"**. Quirk: after a multi-row ⌥-drag only the **last** placed copy is selected (no reselect when
  copying, `NLL:494`).
- Port: `layer.place {copying: true}`. Cursor: duplicate cursor while ⌥ is held (section 3).

**"A layer dropped into the middle of a clipping stack is clipped to that base too; a layer moved out of its contiguous stack is released"**
- Upstream `adoptClipping` (`LLM:42-51`): for a non-folder `id` at sibling index `i` with `0 < i < count − 1`, if
  `siblings[i+1].maskSourceID = s` (and `s != id`) and `siblings[i-1]` is `s` or is clipped to `s`, then
  `id.maskSourceID = s`. `releaseDetachedClipping` (`LLM:232-244`): per sibling list, `base` = last unclipped
  non-folder (a folder resets it to nil); a clipped layer whose source ≠ `base` is released and becomes the base.
- Port: done by the engine in `layer.place` and `layer.ungroup`. Test vectors in section 20.

**"Option-drag an effect sub-row onto another layer row copies that effect …"**
- Upstream (`NLL:414-420, 442-447, 1254-1283`; `Document/LayerEffects.swift:336-362`): ⌥-press on an effect row, drag
  ≥ 3 pt; drop on any row where `canCopyEffect` (not itself, target not a folder and has pixels); replaces that kind;
  undo **"Copy <Effect>"**; selects the effect on the target.
- Port: effects spec (path A: copying one sub-object of the manifest).

**"Option-drag a mask thumbnail onto another row copies the mask"** → section 14.

---

## 5. Context menu (checklist "Context menu")

**"Right-click a row: selects it first if it was not selected …"**
- Upstream `menu(for:)` (`NLL:557-593`): on an effect sub-row, select the effect. Otherwise clear the effect
  selection, then: if the row is already selected → mask thumbnail: `selectLayerTarget(id, mask: true)`; layer
  thumbnail: `selectLayerTarget(id, mask: false)`; elsewhere: `selectLayers(selectedLayerIDs, primary: id)` (the
  multi-selection is kept, the primary moves). If the row was not selected → select only that row, then the same
  thumbnail rule (`mask: true` on the mask thumbnail, otherwise `false`). Then `contextMenu(for:)` (`NLL:119-248`),
  which also selects the row if the selection is empty.
- Board: currently `board.select(id)` then a 10-item menu. Port the rule, then build the menu below with
  `board.menu(x, y, items)`; keep `preventDefault()` on `contextmenu` (`ui.md` 12.1).

Menu items, in order, titles and enable rules verbatim (`NLL:119-286`):

| # | Title | Enabled when | Action |
|---|---|---|---|
| 1 | Duplicate Layer | `canEditLayers && active` | `duplicateActiveLayer()` (every selected layer) → `layer.duplicate` |
| 2 | Rename… | `canEditLayers && active && selected.size == 1` | `renamingLayerID = active` |
| 3 | Delete Mask / Delete Selected Layers / Delete Layer | `canEditLayers && active` | title: "Delete Mask" if `isMaskSelected && active.mask`, "Delete Selected Layers" if more than one selected, else "Delete Layer"; action `deleteLayerOrMask()` (which removes a selected effect first) |
| — | separator | | |
| 4 | Release Clipping Mask / Create Clipping Mask | `canToggleClippingMask(active)` | title from `active.maskSourceID != nil`; `toggleClippingMask(active)` |
| 5 | Group Selected Layers | `canEditLayers && layers.count < 10_000 && !selected.isEmpty` | `groupSelectedLayers()` |
| 6 | Ungroup Layers | `canUngroupLayers`; **only present when the right-clicked row is a folder** | `ungroupLayers()` |
| 7 | Move Out of Folder | `canEditLayers && active.parentID != nil` | `moveActiveLayerOutOfGroup()` |
| 8 | Merge Down / Merge Layers / Merge Group | `canMergeLayers` | title `mergeTitle`; `mergeLayers()` |
| 9 | Convert to 16-Bit (HDR layers only, inserted before 10) | `canConvertLayerDepth` | `convertHDRToSixteenBit()` |
| 10 | Convert to 16-Bit / Convert to 8-Bit | `canConvertLayerDepth` | title "Convert to 16-Bit" when the asset has no deep pixels (blank layers too), else "Convert to 8-Bit"; `convertLayerDepth()` |
| — | separator | | |
| 11 | Add Mask ▸ Reveal All (White), Hide All (Black) | `canEditMask && !active.mask` (submenu and both items) | `selectLayerTarget(active, mask: false)` then `addMask(revealing: true / false)`; with a selection these make reveal/hide-selection masks |
| 12 | Disable Mask / Enable Mask | `canEditMask && active.mask` | title "Enable Mask" when the mask is disabled, else "Disable Mask"; `selectLayerTarget(active, mask: false)` then `toggleLayerMask()` (so the target ends on the **pixels**) |
| 13 | Delete Mask | `canEditMask && active.mask` | `selectLayerTarget(active, mask: false)` then `deleteLayerMask()` |
| 14 | Unlink Mask / Link Mask | `canEditLayers && active.mask && !active.isGroup && !active.adjustment` | title "Link Mask" when unlinked, else "Unlink Mask"; `toggleMaskLink(active)` |
| — | separator | | |
| 15 | Hide Layer / Show Layer | `canEditLayers && active` | title "Show Layer" when hidden; `toggleLayerVisibility(active)` |

The checklist lines **"Duplicate Layer"**, **"Rename…"**, **"Delete Layer / Delete Selected Layers / Delete Mask"**,
**"Create Clipping Mask / Release Clipping Mask"**, **"Group Selected Layers"**, **"Ungroup Layers"**, **"Move Out of
Folder"**, **"Merge Down / Merge Layers / Merge Group"**, **"Convert to 16-Bit / Convert to 8-Bit"**, **"Add Mask ›
Reveal All (White) / Hide All (Black)"**, **"Enable Mask / Disable Mask"**, **"Delete Mask"**, **"Link Mask / Unlink
Mask"**, **"Hide Layer / Show Layer"** are all covered by this table; their operations are specified in sections 6,
8, 10, 12 and 16.

Board-only items now in the menu ("Select Layer's Pixels", "Select Mask's Black Areas", "Open in Compositor") are not
in Compositor's menu. Remove the first two (they are in the Select menu and on ⌘-click); keep "Open in Compositor"
after a final separator as a declared adaptation (section 21).

---

## 6. Layer menu commands (checklist "Layer menu commands")

The Layer menu (`APP:340-394`), in order, which the board's `menus()` (`media/board.js:1093-1105`) must reproduce:

| Item | Shortcut | Enabled (upstream) | Section |
|---|---|---|---|
| New Adjustment Layer ▸ (12 kinds, "…" on editable ones) | | `canEditLayers && document` | adjustments spec |
| Edit Adjustment… | | `canEditLayers && active.adjustment` | 6.4 |
| — | | | |
| Transform Selection / Transform Layer | ⌘T | `canTransform \|\| canTransformSelection` | transform spec |
| Duplicate Layer / Layer via Copy | ⌘J | `canCopyPixels \|\| (selection == nil && canEditLayers && active)`; title "Duplicate Layer" when `selection == nil`, else "Layer via Copy" | 6.2, 6.3 |
| — | | | |
| Create Clipping Mask / Release Clipping Mask | ⌥⌘G | `canToggleClippingMask(active)` | 6.5 |
| — | | | |
| Group Selected Layers | ⌘G | `canEditLayers` | 6.6 |
| Ungroup Layers | ⇧⌘G | `canUngroupLayers` | 6.7 |
| Move Out of Folder | | `canEditLayers && active.parentID != nil` | 6.8 |
| New Blank Layer | ⇧⌘N | `canEditLayers` | 6.1 |
| Rename Layer… | | `canEditLayers && active` | 6.9 |
| Show Layer / Hide Layer | | `canEditLayers && active` | 6.10 |
| — | | | |
| Move Layer Up | ⌘] | `canMoveActiveLayer(by: 1)` | 6.11 |
| Move Layer Down | ⌘[ | `canMoveActiveLayer(by: -1)` | 6.11 |
| Merge Down / Merge Layers / Merge Group | ⌘E | `canMergeLayers` | 6.12 |
| — | | | |
| Flip Layer Horizontal / Vertical | | `canTransform` | transform spec |
| — | | | |
| Delete <Effect> / Delete Layer Mask / Delete Layers / Delete Layer | | `canEditLayers && active` | 6.13 |

Note the Layer menu has **no** Add Layer Mask item (masks are added from the footer, the context menu and the command
palette, `UI/CommandPalette.swift:175-185`).

### 6.1 "New Blank Layer ⇧⌘N"

- Upstream (`ES:703-731`): `canEditLayers`; name `"Layer \(n)"`, smallest unused `n ≥ 1` among all names; blank
  (`asset = nil`), transform `origin 0, size = canvas`; `parentID = active.isGroup ? active : active?.parentID`; the
  parent is **expanded**; insertion at `index(active) + 1`, or `layers.count` without an active layer; with a folder
  active, `max(insertion, lastIndex(where: isInside(folder)) + 1)` where `isInside` walks **all** ancestors (up to 64),
  so the new layer is placed after the folder's last descendant in the array. Undo **"New Blank Layer"**. The new
  layer becomes active (and the only one selected). No 10,000-layer check here.
- Board (`media/board.js:1539-1550`, `insertAbove` `:608-627`): the folder case uses the last **direct** child; same
  hierarchy, different array index (which later matters to Merge Layers ordering and Group placement). Port the
  descendant walk; remove the parent from `layers.collapsed`; call `setActive(id)`.

### 6.2 "Duplicate Layer ⌘J (no selection)"

- Upstream: `layerViaCopy()` with `selection == nil` → `duplicateActiveLayer()` → `duplicateLayers(copiedLayerIDs())`
  (`SC:206-278`).
  - `copiedLayerIDs`: `selectedLayerIDs ∪ {active}`, minus anything inside a selected folder, in **array** order
    (`SC:218-222`).
  - `insertCopy(id)` (`SC:258-278`): the layer and all its descendants, in array order, copied with fresh UUIDs;
    `parentID` and `maskSourceID` remapped when they point inside the copied set, else kept (a copied clipped layer
    stays clipped to the same base); the top copy is named `name + " copy"`, descendants keep their names; every
    other field is shared (pixels, mask with its placement/enabled/linked, adjustment, shape, effects, text). The
    copies are inserted as one block at `index + 1` (just above the original). Refused (skipped) when
    `layers.count + copied ≥ 10_001`. Collapsed originals give collapsed copies.
  - With more than one copy (`SC:239-251`): copies are re-stacked with `placeLayer` above the **topmost** original
    in panel order, in panel order, inside that original's parent (so copies from different folders all land in one
    parent), which also runs `adoptClipping` / `releaseDetachedClipping`.
  - `activeLayerID` = the copy of the previously active layer (else of `ids[0]`), `selectedLayerIDs` = all copies.
    One step **"Duplicate Layer"** (nested `placeLayer` edits do not rename it).
- Port: path B `layer.duplicate`. The answer lists `copies: {copyID: originalID}`; the board copies the original's
  files (section 19.2). Folders, 16-bit and HDR layers then work (the board's current `duplicate` refuses folders and
  drops deep pixels, `media/board.js:1576-1610`).
- Canvas ⌥-drag (`media/view.js:703-708`) calls `board.actions.duplicate` synchronously and drags the copy. Make
  `actions.duplicate` return a promise and have the view start dragging the copy when it resolves, buffering pointer
  moves meanwhile (upstream's canvas ⌥-drag is `beginDuplicateTransform`, `ES:466-…`, transform spec).

### 6.3 "Layer via Copy ⌘J (with a selection)"

- Upstream (`SC:206-215`): `canEditLayers`, active layer, selection not explicitly empty; not on a folder;
  `renderSelectedPixels(from: layer, mask: isMaskSelected)` (a targeted mask is copied as opaque gray pixels) →
  `addPixelLayer(..., name: nextLayerName(), editName: "Layer via Copy")`, which drops the selection; beeps when
  nothing is rendered.
- Port: exists (`selection.layerViaCopy`, path C). Send `isMaskSelected` and `selectedLayerIDs`. Menu title:
  upstream switches on `selection == nil`, so an explicit empty selection shows "Layer via Copy" (disabled); the
  board switches on `hasPixelsSelected()` (`media/board.js:1095`). Use `this.selection ? 'Layer via Copy' :
  'Duplicate Layer'`.

### 6.4 "Edit Adjustment…"

- Upstream: `adjustmentEditingID = activeLayerID` (`APP:347-349`), enabled `canEditLayers && active.adjustment`; the
  panel opens through `.task(id: adjustmentEditingID)` (`UI/LayersPanel.swift:69-71`).
- Port: adjustments spec. While open, `adjustmentEditingID` blocks `canEditLayers` and `layersLookEditable`.

### 6.5 "Create/Release Clipping Mask ⌥⌘G (title toggles)"

- Upstream: title "Release Clipping Mask" when `active.maskSourceID != nil`, else "Create Clipping Mask"; action
  `toggleClippingMask(active)` (`APP:356-360`). Rules in section 16.
- Port: path A.

### 6.6 "Group Selected Layers ⌘G"

- Upstream `groupSelectedLayers()` (`LG:180-225`):
  1. `canEditLayers` and `layers.count < 10_000`.
  2. `selected` = `selectedLayerIDs` that exist. `rootIDs` = selected ids none of whose ancestors is selected (a
     selected folder carries its subtree).
  3. `ordered` = `rootIDs` in `hierarchy.order` (depth-first, each folder before its contents, siblings bottom to top).
  4. `parent` = the innermost ancestor of `ordered[0]` (walking `parentID`, ending in `nil` = root) that is an ancestor
     of every id in `ordered`.
  5. New folder `"Folder \(n)"` (smallest unused `n`), `isGroup = true`, transform = canvas size at origin 0, opacity
     1, Normal, `parentID = parent`.
  6. `branches` = each ordered root walked up to its ancestor whose parent is `parent`; `highest` = the last array
     index holding a branch; `insertion` = number of non-root records at or below `highest`, or `layers.count` when
     nothing is selected.
  7. `layers` = all records except the roots, folder inserted at `insertion`, then the roots appended **at the end of
     the array** in `ordered` order with `parentID = folder` (their array position is only meaningful among siblings).
  8. `LayerHierarchy.validate` (64-level depth, `LG:30-46`) or nothing happens.
  9. Edit **"Group Layers"**; `activeLayerID = folder` (selection becomes `{folder}`); expand `parent`.
- Port: path B `layer.group`. Clipping is not adjusted by Group (`groupSelectedLayers` does not call
  `releaseDetachedClipping`); clipped layers moved into the folder away from their base keep `maskSourceID` and
  render as independent links (`compositing.md` 8.2).

### 6.7 "Ungroup Layers ⇧⌘G"

- Upstream `ungroupLayers()` (`LG:233-252`): `canUngroupLayers`; the folder's **direct** children (array order) get
  `parentID = folder.parentID` and are spliced into the array at the folder's index (the folder record is dropped);
  `releaseDetachedClipping`; validate; `finishOpacityEdit()`; edit **"Ungroup Layers"**;
  `selectLayers(childIDs, primary: children.first)` (the bottom-most child becomes active); the folder id is removed
  from `collapsedGroupIDs`. The folder's own opacity, mask and effects are discarded (a visible change when they were
  not neutral).
- Port: path B `layer.ungroup`.

### 6.8 "Move Out of Folder"

- Upstream (`LG:319-323`): `placeLayer(active, in: folder.parentID, above: folder.id)` → the layer lands directly
  above its folder among the folder's siblings, with adopt/release clipping, undo **"Move Layer"**, the layer stays
  active, the new parent is expanded.
- Port: path B `layer.place {ids: [active], parentID: folder.parentID, aboveID: folder.id}`.

### 6.9 "Rename Layer…"

- Upstream: `renamingLayerID = activeLayerID` (`APP:370-371`); the list scrolls the row into view and starts the inline
  field on the next run-loop turn (`NLL:105-111`).
- Board: menu item → `layers.rename(row)` after `scrollIntoView`.

### 6.10 "Show Layer / Hide Layer (title toggles)"

- Upstream: title "Show Layer" when `active.isVisible == false`, else "Hide Layer" (`APP:372-374`);
  `toggleLayerVisibility(active)`.
- Board: exists; gate with `canEditLayers`.

### 6.11 "Move Layer Up ⌘] / Move Layer Down ⌘["

- Upstream (`ES:795-810`): siblings in array order; swap the array positions of the active layer and its neighbor at
  `index ± 1`; disabled at the ends (`canMoveActiveLayer`); undo **"Reorder Layers"**. No clipping adjustment (a base
  moved above its clipped layer keeps the link; the layer then renders as an independent link).
- Board: `actions.step` matches (`media/board.js:1683-1695`); the menu items must use `canMoveActiveLayer` for
  `enabled`, and the keys must do nothing when it is false.

### 6.12 Merge: "Merge Down ⌘E", "Merge Layers ⌘E", "Merge Group ⌘E", "Merge result"

`mergePlan()` (`MRG:7-27`), ported to JS for the title and the enabled state:

```js
function mergePlan(b) {                              // b = board
    const active = b.activeLayer();
    if (!b.canEditLayers() || !active) return null;
    const layers = b.doc.layers, sel = b.selectedIDs;
    if (sel.size > 1) {
        const picked = new Set(sel);
        for (const id of sel) for (const d of b.descendantIDs(id)) picked.add(d);
        const ordered = layers.filter((l) => picked.has(l.id));                 // array order
        const top = [...ordered].reverse().find((l) => sel.has(l.id));
        if (!ordered.some((l) => !l.isGroup) || !top) return null;
        return { ids: ordered.map((l) => l.id), removed: picked, name: top.name, parent: top.parentID || null, anchor: top.id, action: 'Merge Layers' };
    }
    if (active.isGroup) {
        const inside = b.descendantIDs(active.id);
        if (!layers.some((l) => inside.has(l.id) && !l.isGroup)) return null;
        const ids = layers.filter((l) => inside.has(l.id) || l.id === active.id).map((l) => l.id);
        return { ids, removed: new Set(ids), name: active.name, parent: active.parentID || null, anchor: active.id, action: 'Merge Group' };
    }
    const index = layers.indexOf(active);
    const below = layers.slice(0, index).reverse().find((l) => (l.parentID || null) === (active.parentID || null));
    if (!below || below.isGroup) return null;
    return { ids: [below.id, active.id], removed: new Set([below.id, active.id]), name: below.name, parent: active.parentID || null, anchor: active.id, action: 'Merge Down' };
}
const canMergeLayers = () => mergePlan(board) !== null;
const mergeTitle = () => (mergePlan(board) || { action: 'Merge Down' }).action;
```

`mergeLayers()` (`MRG:34-79`), what the engine runs:

1. `commitTransform()`; take the plan.
2. `subset` = the planned records in array order, each cut loose: `parentID = nil` when its parent is not in the plan,
   `maskSourceID = nil` when its base is not in the plan.
3. If any record in the subset has deep pixels: `mergedSixteenBit` (`MRG:83-104`): 16-bit layers drawn from their full
   16-bit pixels into a 16-bit context (half-float HDR if any is HDR); trimmed on the dithered copy; result a 16-bit
   (or HDR) layer. Otherwise: a document-sized 8-bit sRGB context, `drawLiveComposite(flat, in: context)` (the same
   code the canvas uses: blend modes, opacity incl. folder opacity of folders **in** the merge, masks, folder masks,
   clipping stacks and independent links, adjustments applied to what is below them within the merge, effects);
   `PixelFilter.trimmed` crops to the non-zero-alpha bounds (`Document/Filters.swift:208-232`,
   `Rendering/BrushPixels.c:3-21`); a result that is entirely transparent, or covers the whole canvas, keeps the full
   canvas size. Failure beeps and does nothing.
4. New layer: fresh id, `name = plan.name`, `parentID = plan.parent`, transform = the trimmed placement, opacity 1,
   Normal, no mask, **not clipped**, no effects.
5. Remove every planned record; layers clipped to any removed record now clip to the merged layer.
6. Insert at `index(anchor) − (removed records below the anchor)`.
7. Validate, `finishOpacityEdit()`, edit named `plan.action` (**"Merge Down"**, **"Merge Layers"**, **"Merge
   Group"**), `activeLayerID = merged` (selection `{merged}`, mask target off).

Consequences the port inherits (and tests, section 20.4):

- Only what is **visible** is drawn (`renderLayers`), so a hidden layer in the merge disappears with no trace.
- The surface is the canvas: pixels outside the canvas are cut off.
- Folders **outside** the merge (the parent of a Merge Down or Merge Layers result) are not baked in; the result
  sits in `plan.parent` and is drawn through that folder as before. In Merge Layers across different folders, those
  folders' opacity and masks are dropped from the merged pixels.
- Merge Down of a layer clipped to a base outside the pair (e.g. the second clipped layer of a stack, merged onto the
  first) merges the two **unclipped** and the result is not clipped: the clipped look is lost.
- Merge Down onto an adjustment layer is allowed (`below` must only not be a folder): the adjustment is applied to
  nothing below it inside the merge, then the active layer is drawn over it.

Port: path C `layer.merge`. Send `selectedLayerIDs`. The result arrives as an external change; apply
`activeLayerID` / `selectedLayerIDs` from the answer.

### 6.13 Delete: "Delete Layer / Delete Layers / Delete Layer Mask / Delete <Effect>", "Delete key (no pixel selection)", live-mask alert

- Titles: Layer menu `selectedEffect ? "Delete " + kind : (isMaskSelected && active.mask) ? "Delete Layer Mask" :
  selected.size > 1 ? "Delete Layers" : "Delete Layer"` (`APP:390-393`); context menu section 5; trash section 2.
- `deleteKeyPressed()` (`Document/SelectionEdits.swift:76-80`): selected effect → remove it; else `selection != nil`
  → `clearSelectedPixels()` (an explicit empty selection clears nothing); else `deleteLayerOrMask()`.
- `deleteLayerOrMask()` (`:84-88`): selected effect → remove; else `isMaskSelected && active.mask &&
  selected.size <= 1` → `deleteLayerMask()` (section 12); else `deleteSelectedLayers()`.
- `deleteSelectedLayers()` (`ES:745-752`): `ids` = selected ids in **array** order; one id (or none) →
  `deleteLayer(active)`; else the live-mask check, then `finishDeletingLayers(ids, baked: [:])`.
- `finishDeletingLayer(id, baked)` (`LLM:131-147`), JS port (path A):

```js
function finishDeletingLayer(b, id, baked = {}) {
    const m = b.doc.manifest;
    const index = m.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const removed = new Set([id, ...b.descendantIDs(id)]);
    m.layers = m.layers.filter((l) => !removed.has(l.id));
    for (const l of m.layers) {
        if (l.maskSourceID && removed.has(l.maskSourceID)) {
            delete l.maskSourceID;
            if (baked[l.id]) { /* path C only: the engine already replaced the pixels */ }
        }
    }
    if (removed.has(m.activeLayerID)) b.setActive(m.layers.length ? m.layers[Math.min(index, m.layers.length - 1)].id : null);
}
// One id: board.edit('Delete Layer', ...). Several: board.edit('Delete Layers', () => ids.forEach((id) => finishDeletingLayer(b, id))).
```

  The board's `deleteLayer` (`media/board.js:1558-1574`) always reassigns the active layer and only handles one id;
  replace it with the port.
- **Live-mask alert** (`LLM:100-130`). Before deleting, compute
  `removed = ⋃ (id ∪ descendants(id))` and `targets = layers not in removed whose maskSourceID ∈ removed`. If empty,
  delete directly. Otherwise show a modal:
  - message **"This layer supplies a live mask"** when `ids.length == 1`, else **"These layers supply live masks"**;
  - informative text **"Bake keeps the current masked appearance in the dependent layers’ pixels. Remove Links
    reveals their pixels. You can undo either choice."** (curly ’);
  - buttons in this order: **"Bake and Delete"** (default, ↩), **"Cancel"** (⎋), **"Remove Links and Delete"**.
  - Remove Links → path A `finishDeletingLayers(ids, {})`. Bake → path C `layer.delete {ids, choice: "bake"}`: the
    engine renders `LiveMaskBaker.bake(snapshot, target:)` (`LLM:74-98`; the target's own pixels at its own grid,
    clipped by its live source chain, keeping its raster mask and appearance; an adjustment target has no pixels and
    is just unlinked) for every target, then `finishDeletingLayers(ids, baked:)`; the step is "Delete Layer" or
    "Delete Layers". Cancel → nothing.
- Never call `deleteLayer`, `deleteActiveLayer`, `deleteSelectedLayers`, `deleteLayerOrMask` or `deleteKeyPressed` in
  the engine: they run `NSAlert.runModal()` (`LLM:108-114`), which would block a headless process.

---

## 7. Folders (checklist "Folders")

**"Folders are pass-through …"**
- Upstream: `LG:49-70`, `LM:168-210`; rendering in `compositing.md` 7. The panel shows each layer's **own** opacity.
- Board: `render.js` already multiplies folder opacity and folder masks into every descendant (`opacityOf`,
  `applyFolderMasks`, `media/render.js:49, 181-187`). Nothing to add.

**"Folders take opacity and a mask but no blend mode, effects, painting or clipping; nesting is limited to 64 levels"**
- Upstream: `canEditAppearance` excludes folders (`Document/LayerAppearance.swift:85`); the loader rejects a folder
  blend mode other than Normal (`manifest.md` 4); effects need pixels (`UI/LayersPanel.swift:56`); `canPaint` allows
  a folder only through its mask (`Document/EditorSession+Brush.swift:7`); `LiveMaskGraph.validate` forbids a folder as
  target or base (`LLM:14`); `LayerHierarchy.validate` stops at 64 (`LG:40-44`).
- Board: Blend disabled for folders (exists); clipping predicates (section 16) refuse folders; painting refusal text
  section 11.

**"New layers and adjustment layers created with a folder active go inside it; adding into a collapsed folder expands it"**
- Upstream: `ES:709-726` (blank layer: top of the folder), `Document/LayerAdjustment.swift:220-224` (adjustment:
  folder slot + 1), `SC:302` (pasted pixels: `parentID = folder`, inserted at folder index + 1).
- Board: 6.1; `insertAbove` must also expand the folder.

---

## 8. Deep layers (checklist "Deep layers (16-bit / HDR)")

**"16-bit layers in 8-bit documents …"**, **"HDR layers …"**, **"Painting on a 16-bit layer keeps the base at full
depth …"**
- Upstream: `Document/DeepLayers.swift:3-88, 122-178`. The board shows deep layers from an 8-bit decode
  (`media/document.js:176-180`) and refuses to paint them (`pixelLock`). These are display/compositing matters
  (`compositing.md` 10); in this area the board only shows the tag (section 3) and routes conversions to the engine.

**"Convert to 16-Bit (8-bit layer) …"**, **"Convert to 8-Bit …"**, **"HDR Convert to 16-Bit …"**
- Upstream (`Document/DeepLayers.swift:282-328`):
  - `convertLayerDepth()`: blank layer → clear canvas-sized 16-bit pixels, transform reset to the canvas, undo
    **"Convert to 16-Bit"**; 8-bit → same pixels plus a 16-bit copy (`deep`), **"Convert to 16-Bit"**; 16-bit or HDR
    → dithered 8-bit, **"Convert to 8-Bit"**.
  - `convertHDRToSixteenBit()`: HDR only; clipped to white, stored at 16 bits, **"Convert to 16-Bit"**.
  - Errors go to `brushError` (alert "Couldn’t paint").
- Port: path C `layer.convertDepth` / `layer.convertHDRTo16`. The board's 16-bit detection (`pngInfo.bitDepth == 16`)
  then shows the tag.

**"Conversion unavailable for text, adjustment and folder layers and for multi-selection"** — `canConvertLayerDepth`
(1.2).

---

## 9. Limits (checklist "Limits")

**"At most 10,000 layers …; any layer/mask side at most 30,000 px; one surface at most 200 MP; total raster per
document scales with RAM …"**
- Upstream: `layers.count < 10_000` for Group (`LG:181`) and new adjustment layers
  (`Document/LayerAdjustment.swift:209`); `count + copies <= 10_000` for duplicates (`SC:263`); New Blank Layer and
  paste have **no** count check. `DocumentLimits` (`Document/DocumentLimits.swift:18-37`): `maxSide = 30_000`,
  `maxSurfacePixels = 200_000_000`, `documentPixelBudget = min(800 MP, max(200 MP, physicalMemory / 16))` pixels
  (a quarter of RAM at 4 bytes a pixel). A mask from a selection larger than one surface throws `.tooLarge`
  (`LM:248`): "This project exceeds the supported canvas, layer, file-size, or N-megapixel document limit."
  (`IO/ProjectStore.swift:76`).
- Board: `PIXEL_BUDGET = 200000000` (`media/board.js:23`) stands in for the RAM-scaled budget. The engine applies the
  real limits on every path B / C call; the board's path A edits create no pixels except 1×1 masks and mask copies,
  which stay within the budget only if the board checks `pixelBudget` for mask copies (sum of mask pixels against
  `documentPixelBudget`, `Document/EditorSession+Brush.swift:44-47`). Use 200 MP as the conservative constant.

---

## 10. Adding masks (checklist "Masks and clipping › Adding masks")

**"Footer Add layer mask button, no selection: adds an all-white reveal mask (undo "Add Reveal-All Mask"); Option-click adds all-black hide mask ("Add Hide-All Mask"); the new mask becomes the target"**
- Upstream: `addMask(revealing: !optionHeldAtClick)` (`UI/LayerMaskMenu.swift:9-11`) → with `selection == nil`,
  `addLayerMask(revealing:)` (`LM:270-278`): `canEditMask`, no mask yet, `LayerMask.solid` = a **1×1** gray image of
  255 or 0, enabled, linked, no placement (`LM:27-34`); `finishOpacityEdit()`; edit **"Add Reveal-All Mask"** /
  **"Add Hide-All Mask"**; `isMaskSelected = true`.
- Port: path A.

```js
addLayerMask(revealing) {                                       // LM:270-278
    const record = this.activeLayer();
    if (!this.canEditMask() || !record || record.maskFile) return;
    this.edit(revealing ? 'Add Reveal-All Mask' : 'Add Hide-All Mask', () => {
        const mask = CB.Document.maskFromGray(1, 1, new Uint8Array([revealing ? 255 : 0]));
        this.doc.entry(record.id).mask = mask;
        record.maskFile = `${record.id}.mask.png`;
        record.maskEnabled = true;
        record.maskLinked = true;                                 // the app always writes both keys (manifest.md 4)
        delete record.maskPlacement;
        this.doc.dirtyMasks.add(record.id);
        return [{ layerID: record.id, kind: 'mask', beforeMask: null, afterMask: mask }];
    });
    this.isMaskSelected = true;
}
```

**"Footer button with a selection: Reveal Selection (white inside, black outside); Option-click Hide Selection; the selection is consumed (deselected) in the same undo step; tooltip text changes with the selection"**
- Upstream: tooltip **"Add layer mask (Option-click for a black mask)"** when `selection == nil`, else **"Add layer
  mask revealing the selection (Option-click to hide it)"**; a11y "Add layer mask" (`UI/LayerMaskMenu.swift:12-14`).
  `addMask(revealing:)` with a selection (`LM:240-267`): `canEditMask`, no mask; grid = the layer's pixel size, or
  `Int(size.rounded())` of its transform for a blank layer, folder or adjustment; refuses past `maxSurfacePixels`
  (`.tooLarge` → `brushError`); fill `revealing ? 0 : 1`, map the context by the inverse of `pixelToDocument(layer)`,
  clip to `selection.clip(canvas:)` (coverage with antialiasing and feather, `selection.md` 1.4), fill
  `revealing ? 1 : 0` over `clip.rect`; the mask keeps the full grid size (never reduced to 1×1); edit **"Reveal
  Selection"** / **"Hide Selection"**, which also sets `document.selection = nil`; `isMaskSelected = true`.
  An explicit **empty** selection counts as a selection: Reveal gives an all-black mask.
- Port: path B `mask.add {revealing}` (section 19) returns the mask PNG; the board installs it and drops its
  selection inside the same `board.edit` (`selectionBefore/After` on the entry). The existing full-session
  `selection.addMask` (`engine/Sources/SelectionOps.swift:73-75`) is a valid fallback (path C) and is required for
  HDR (`.exr`) layers, whose pixel size the board does not know (`media/document.js:171-175` uses the transform size).

**"Button disabled when several layers are selected or the layer already has a mask"**
- Upstream: `.disabled(!layersLookEditable || selectedLayerIDs.count != 1 || activeLayer == nil || activeLayer.mask != nil)`
  (`UI/LayerMaskMenu.swift:15-16`).

**"Any layer kind takes a mask …; mask pixels cover the layer's own pixel grid; a uniform mask is stored as 1x1"**
- Upstream: `canEditMask` has no kind check (`LM:220-221`); `LayerMaskTests.swift:61-63` adds a mask to a folder.
  Coverage and placement rendering: `compositing.md` 6. Only `LayerMask.solid` makes 1×1 masks.

---

## 11. Mask target and painting (checklist "Mask target and painting")

**"Mask thumbnail (30 pt, canvas-shaped, mask drawn where it sits; past its pixels it continues white or black, whichever most of its edge is): click targets the mask (accent border); tooltip lists Option/Shift/Cmd gestures"**
- Upstream: size `fittedSize(canvas, 30)` (`NLL:1015-1017`); picture `CanvasThumbnail.mask(thumbnail, transform:
  layer.maskTransform, …)` (`UI/CanvasThumbnail.swift:38-44`): fill gray `LayerMask.background(of: thumbnail)`, then
  the mask's 96 px thumbnail drawn by `maskTransform` (= `mask.placement ?? layer.transform`, `LM:404-407`).
  `LayerMask.background` (`LM:63-76`): average of the thumbnail's border pixels, white if `total * 2 >= count * 255`.
  The thumbnail is the mask resampled to `factor = min(1, 96 / max(w, h))`, `max(1, Int(w * factor))` ×
  `max(1, Int(h * factor))` with high interpolation (`LM:35-48`). Plain click → `selectLayerTarget(id, mask: true)`,
  then the table's mouse-down (`NLL:1154-1158, 1378-1379`). Tooltip **"Select layer mask; Option-click to view it
  alone; Shift-click to enable/disable; Cmd-click to select its black areas (Cmd-Shift adds, Cmd-Option subtracts)"**;
  a11y "Select mask: <name>". Accent border per `updateTarget` (section 3), white during mask-alone view.
- Board: `maskThumbnail` (`media/layers.js:259-276`) stretches the mask over a box of its own aspect with a black
  backdrop, ignores placement, and the title is "Layer mask". Replace with:

```js
// One background rule for the renderer, the thumbnail and the mask-alone view (render.js maskBackground today reads
// the full-size edge; upstream reads the <=96 px thumbnail's edge, see section 23).
maskThumbnail(record, mask) {
    const doc = this.board.doc, box = 30, dpr = window.devicePixelRatio || 1;
    const scale = box / Math.max(doc.width, doc.height);
    const w = Math.max(1, Math.round(doc.width * scale)), h = Math.max(1, Math.round(doc.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const bg = CB.Render.maskBackground(mask) ? 255 : 0;
    ctx.fillStyle = `rgb(${bg},${bg},${bg})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const t = Transform.read(record.maskPlacement || record.transform, [doc.width, doc.height]);
    const m = Transform.pixelToDocument(t, mask.width, mask.height), s = canvas.width / doc.width;
    ctx.setTransform(m.a * s, m.b * s, m.c * s, m.d * s, m.e * s, m.f * s);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(CB.Document.grayCanvas(mask), 0, 0);       // r = g = b = sample, a = 255 (new, cached on the mask)
    return canvas;
}
```

  Wire a plain click on `.mask-thumb` to `selectLayerTarget(id, true)`, ⇧-click to `selectLayerTarget(id, true)` then
  `toggleLayerMask()` (no range selection), ⌘-click (exists) to load, ⌥ to section 13 / 14.

**"With the mask targeted, Brush, Blur, Gradient, Fill and Invert work on the mask; Spot Healing and Clone Stamp do nothing on masks; filters and color adjustments are unavailable"**
- Upstream: `beginBrush` (`Document/EditorSession+Brush.swift:50-53`): Smudge/Liquify go to `beginWarp`; otherwise only
  `.brush`, `.blur`, or a brush-family tool on pixels proceed, so Spot Healing and Clone Stamp return silently on a
  mask. Erase on a mask paints the mask color (`:67`). Fill (`Document/SelectionEdits.swift:53-63`) and Invert
  (`:95-101`) honor `isMaskSelected`. `canAdjust` requires `!isMaskSelected` (`Document/HueSaturation.swift:454-461`),
  which gates every filter, Levels, Hue/Saturation and Content-Aware Fill.
- Port: the board's brush must paint the mask when `isMaskSelected` (`brush.md` 11); `filters.open`, the Filter
  and Image menus and `canContentAwareFill` must add `!this.isMaskSelected`; Fill / Clear / Invert already go to the
  engine and only need `isMaskSelected` / `maskPaintWhite` in the request (1.4).

**"Brush and fills on a mask can paint anywhere on the canvas, growing the mask past the layer's own bounds"**
- Upstream: `BrushStroke(growsMask:)` (`Document/BrushStroke.swift:199-218`): the grid extent is the mask grid ∪ the
  canvas mapped into it; Brush (`growsMask: tool == .brush`, `Document/EditorSession+Brush.swift:70`), fills
  (`Document/SelectionEdits.swift:230`) and the gradient (`Document/Gradient.swift:66`) use it. On commit a mask that
  grew becomes a **placed** mask (`maskPlacement` set) at whole-256-tile bounds; new area takes the old mask's
  background (`brush.md` 12.3).
- Port: `brush.md` 11-12 for the board's own mask strokes; fills and gradients on masks through the engine.

**"While a mask is targeted the color swatches show only black/white (X swaps, D resets to black foreground / white background) and the color picker does not open"**
- Upstream (`Document/ColorPalette.swift:26-59`): `paletteColor(background:)` = white iff `background ? !maskPaintWhite
  : maskPaintWhite`; X → `maskPaintWhite.toggle()`; D → `maskPaintWhite = false`; `setPaletteColor` on a mask sets
  `maskPaintWhite = background ? !white : white` with `white = (color == .white)`; `openColorPicker` returns when
  `isMaskSelected`. The real foreground/background colors are untouched and come back when the pixels are targeted.
- Board: `swapColors`, `defaultColors`, `pickColor`, the rail and options-bar swatches (`media/board.js:142-145,
  215-277, 482-508`) must branch on `isMaskSelected` exactly this way; brush strokes on a mask use gray
  `maskPaintWhite ? 255 : 0`.

**"Delete with a selection on a targeted mask fills the selection with the background color"**
- Upstream: `clearSelectedPixels()` → `fillSelection(with: .background)` when `isMaskSelected`
  (`Document/SelectionEdits.swift:67-72`); undo **"Fill Mask"**.
- Port: path C `selection.clear` with `isMaskSelected` and `maskPaintWhite`.

**"Image › Invert becomes "Invert Mask" (⌘I) when the mask is targeted; needs an enabled mask; inside the selection or whole mask"**
- Upstream: menu title `isMaskSelected ? "Invert Mask" : "Invert"` (`APP:305-307`); `canInvert`
  (`Document/SelectionEdits.swift:95-101`): document, no text draft, active layer, not busy or importing, no stroke or
  pixel move, not renaming, exactly one selected, not a folder unless the mask is targeted, effectively visible,
  selection not explicitly empty, and `isMaskSelected ? mask.isEnabled : layer has pixels`; undo **"Invert Mask"** /
  **"Invert"** (`:142`).
- Board: Image menu item (`media/board.js:1090-1091`) must use this predicate and title.

**"Paint refusals (alert "Couldn't paint") …"**
- Upstream `paintRefusal` (`Document/EditorSession+Brush.swift:14-33`), in this order (curly quotes and apostrophes
  are part of the strings):
  1. several selected: **"Several layers are selected. Select just one to paint on it."**
  2. folder, pixels targeted: **"“<name>” is a folder, which has no pixels of its own. Paint on a layer inside it, or
     on the folder’s mask."**
  3. not effectively visible: **"“<name>” is hidden, or inside a hidden folder. Show it to paint on it."**
  4. mask targeted and disabled: **"The layer mask is turned off. Shift-click its thumbnail to turn it on, then
     paint."**
  5. adjustment, pixels targeted: **"“<name>” is an adjustment layer, with no pixels to paint. Paint on its mask
     instead."**
  6. explicit empty selection: **"Nothing is selected, so there’s nowhere to paint. Choose Select › Deselect (⌘D) to
     paint anywhere."**
  Shown as alert **"Couldn’t paint"** with one "OK" button (`ContentView.swift:297-300`). `canPaint`
  (`:5-11`) = `canEditLayers && selected == 1 && (!folder || mask) && !emptySelection && visible && (!mask ||
  mask.isEnabled) && (mask || !adjustment)`.
- Board: `paintRefusal`, `pixelLock` and `engineEditRefusal` (`media/board.js:547-553`, `media/document.js:159-166`,
  `media/board.js:1041-1049`) use other words. Port `canPaint` and `paintRefusal` verbatim; keep the board-only
  16-bit/HDR refusal (pixels targeted only) as an adaptation after rule 5.

---

## 12. Enable, delete, link (checklist "Enable, delete, link")

**"Shift-click the mask thumbnail (or context menu Enable/Disable Mask) toggles the mask; a disabled mask is not applied and shows a red "╱" over its thumbnail; undo "Disable/Enable Layer Mask""**
- Upstream `toggleLayerMask()` (`LM:279-286`): `canEditMask`, mask present; `finishOpacityEdit()`; edit **"Disable
  Layer Mask"** when it was enabled, else **"Enable Layer Mask"**; flips `isEnabled`. ⇧-click targets the mask first
  (`NLL:1157`); the context menu targets the pixels first (section 5).
- Port: path A, `record.maskEnabled = !(record.maskEnabled !== false)` (always write the boolean). Display: the red
  mark (CSS `::after` today is a 2 px rotated bar, `media/board.css:316`; use the "╱" glyph, 32 px, weight 500,
  `#ff453a`, centered on the thumbnail). `render.js` already skips disabled masks.

**"Delete mask: trash button or Delete key with the mask targeted, context menu Delete Mask, Layer › Delete Layer Mask; undo "Delete Layer Mask""**
- Upstream `deleteLayerMask()` (`LM:287-295`): `canEditMask`, mask present; `finishOpacityEdit()`; edit **"Delete Layer
  Mask"**; `mask = nil`; `isMaskSelected = false`.
- Port: path A: delete `maskFile`, `maskEnabled`, `maskLinked`, `maskPlacement`; `entry.mask = null`; pixel entry
  `{kind: 'mask', beforeMask, afterMask: null}` so undo restores and re-writes the PNG (`media/document.js:339-341`).

**"Link button (chain icon) between layer and mask thumbnails toggles link; empty but clickable when unlinked; tooltips …; hidden for folders and adjustment layers; undo "Unlink/Link Layer Mask""**
- Upstream: button 9 × 20, `link` symbol 10 pt medium turned 45° (`NLL:841-855`), tint `secondaryLabelColor`, no image
  when unlinked; tooltip **"Unlink layer and mask to move or transform them separately"** when linked, **"Link layer
  and mask so they move together"** when unlinked; a11y "Unlink mask: <name>" / "Link mask: <name>"; enabled unless
  busy/importing (`NLL:1030-1037`). `toggleMaskLink(id)` (`LM:319-327`): `canEditLayers`, mask present;
  `commitTransform()`, `finishOpacityEdit()`; edit **"Unlink Layer Mask"** / **"Link Layer Mask"**.
- Port: path A, `record.maskLinked = record.maskLinked === false`. Add the button to the row (Lucide `link`, rotated
  45°, 10 px).

**"Linked mask follows every move/transform of its layer; unlinked, the layer moves without it and the mask stays where it was on the document"**
- Upstream `placement(movingLayer:to:)` (`LM:54-59`), used by every layer transform commit (`ES:505-521`), flips
  (`Document/LayerFlip.swift:46`) and group transforms:

```swift
func placement(movingLayer old: LayerTransform, to new: LayerTransform) -> LayerTransform? {
    // A uniform mask looks the same wherever it sits.
    guard asset.image.width > 1 || asset.image.height > 1 else { return nil }
    let moved = isLinked ? placement.map { $0.following(from: old, to: new) } : (placement ?? old)
    return moved.flatMap { $0.samePlacement(as: new) ? nil : $0 }
}
```

- Board: `commitTransform` (`media/board.js:692-720`) only carries a placed, linked mask. Replace with a port:

```js
function maskPlacementAfterMove(record, mask, old, next, size) {          // LM:54-59
    if (mask.width <= 1 && mask.height <= 1) return null;                   // uniform: delete maskPlacement
    const placed = record.maskPlacement ? Transform.read(record.maskPlacement, size) : null;
    const moved = record.maskLinked !== false ? (placed && TransformTool.following(placed, old, next)) : (placed || old);
    return moved && !TransformTool.samePlacement(moved, next) ? moved : null;  // samePlacement ignores sampling (LayerTransform.swift:91-95)
}
```

  and write `maskPlacement` (or delete it when null) on every transform commit, nudge and flip.

**"Transform an unlinked mask on its own …"**
- Upstream: `beginTransform` uses `maskAlone = isMaskSelected && mask.isLinked == false`, draft = `maskTransform`
  (`ES:456-459`); `transformTargetsMask` puts the handles on the mask's box (`ES:556`); `commitMaskTransform`
  (`LM:347-372`): new placement = `draft.samePlacement(as: layer.transform) ? nil : draft`; unchanged → no step;
  edit **"Transform Layer Mask"**. A corner distortion resamples the mask with `DistortWarp.warpMask` over the warped
  bounds with the mask background outside, **"Distort Layer Mask"**. Arrow-key nudges with the Move tool (`nudgeLayer`, `ES:570-579`) take the
  same path.
- Port: transform spec. The board's Move tool must edit `maskPlacement` (path A) when
  `isMaskSelected && maskLinked === false`; a distortion goes through the engine.

---

## 13. Mask alone view (checklist "Mask alone view")

**"Option-click the mask thumbnail shows that mask alone on the canvas in grayscale (edge tone beyond its pixels), with live strokes/gradients; Option-click again returns to the composite; the mask stays the paint target"**
- Upstream: ⌥-press on a visible mask thumbnail enters `dragMaskCopy` (`NLL:1364-1366, 1386-1404`): a release before
  the pointer moves 3 pt (`dx² + dy² >= 9`) calls `toggleMaskAlone(id)` (`LM:229-236`):

```swift
func toggleMaskAlone(_ id: UUID) {
    let showing = maskAloneLayer?.id == id
    selectLayerTarget(id, mask: true)
    guard activeLayerID == id, isMaskSelected else { return }
    viewsMaskAlone = !showing
}
```

  So ⌥-clicking another layer's mask switches the view to that mask. The canvas (`Rendering/EditorCanvas.swift:976-979,
  938-953`; GPU path `:2869-2885`) then draws, instead of the layers: the document rect filled with gray
  `LayerMask.background(of: thumbnail)`, and the mask's samples as gray (red channel copied to green and blue) placed
  at `displayedMaskPlacement ?? displayedTransform` (its placement, else the layer's transform, following a transform
  being dragged); while a stroke or gradient on this mask is in progress, the stroke's grid is drawn instead. A
  **disabled** mask is shown too (only `mask != nil` is checked, `ES:636-639`). Overlays (ants, handles, guides) still
  draw on top.
- Board: add a branch at the top of the composite (`compositeCanvas`, `media/board.js:755-…`):

```js
if (this.viewsMaskAlone && this.isMaskSelected) {
    const record = this.activeLayer(), mask = record && record.maskFile && this.doc.entry(record.id).mask;
    if (mask) {
        const g = CB.Render.maskBackground(mask) ? 255 : 0;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = `rgb(${g},${g},${g})`;
        ctx.fillRect(0, 0, doc.width, doc.height);
        const live = this.brushMaskPreview(record.id);        // brush.md: the mask stroke's grid, if one is in progress
        // displayedMaskPlacement ?? displayedTransform (LM:331-345): follow a transform being dragged, else
        // maskPlacement, else the layer's transform.
        const t = live ? live.transform : this.displayedMaskTransform(record);
        const src = live ? live.canvas : CB.Document.grayCanvas(mask);
        Affine.setOn(ctx, Transform.pixelToDocument(t, src.width, src.height));
        ctx.drawImage(src, 0, 0);                              // smoothing per t.sampling, as render.js setSmoothing
        return;                                                // no layers, no checkerboard
    }
}
```

**"Canvas pill at the bottom "Layer Mask · <layer name>" with an × button …; mask thumbnail outlined white meanwhile; targeting the pixels or another layer ends it"**
- Upstream: `MaskAloneBadge` / `CanvasPillView` (`UI/LayerMaskMenu.swift:22-33, 55-103`; placed by
  `ContentView.swift:104-113`): bottom-centered, 14 pt above the canvas bottom, in a column (spacing 8) under the CMYK
  proof pills; height 26, corner radius 13, background black 75%, border white 14% 1 pt; contents with spacing 7, left
  inset 11, right 8: SF `rectangle.inset.filled` 11 pt white, **"Layer Mask"** 12 pt semibold white, the layer name
  12 pt white 60% truncated at 220 pt, an `xmark` button 9 pt bold white with tooltip **"Show the image again (or
  Option-click the mask thumbnail)"** and a11y **"Stop viewing the mask"**, which sets `viewsMaskAlone = false`.
  `isMaskSelected = false` (any pixel target or other layer) ends the view (`ES:631`). The mask thumbnail border is
  white instead of the accent (`NLL:1085-1086`).
- Board: an absolutely positioned HTML pill in the stage, pointer events on (so the × gets clicks, as
  `acceptsFirstMouse` intends), hidden unless the view is on.

---

## 14. Copy and load masks (checklist "Copy and load masks")

**"Option-drag the mask thumbnail (>=3 pt) onto another layer row copies the mask, kept where it sits on the document, replacing any existing mask; not onto folders; undo "Copy Layer Mask"/"Replace Layer Mask""**
- Upstream: drag source as in section 13 once the pointer moves 3 pt; drop on the row under the pointer when
  `canCopyMask(from:to:)` (`LM:297-302`: `canEditLayers`, different layers, the source has a mask, the target exists
  and is **not a folder**; adjustment, text and blank layers are fine); `copyMask` (`LM:305-317`):
  `commitTransform()`, `finishOpacityEdit()`; the copy is the source's `LayerMask` (same pixels, `isEnabled`,
  `isLinked`) with `placement = source.maskTransform` (always set, even when it equals the target's transform); edit
  **"Copy Layer Mask"** when the target had none, else **"Replace Layer Mask"**; `selectLayer(target)`;
  `isMaskSelected = true`.
- Port: path A. Pointer flow: ⌥-`pointerdown` on `.mask-thumb` → capture; after 3 px start a ghost image of the
  thumbnail and outline the row under the pointer when `canCopyMask`; `pointerup` without the threshold →
  `toggleMaskAlone`; with it, on a valid row → copy:

```js
copyMask(sourceID, targetID) {                                          // LM:305-317
    if (!this.canCopyMask(sourceID, targetID)) return;
    const source = this.doc.layer(sourceID), target = this.doc.layer(targetID), from = this.doc.entry(sourceID).mask;
    this.selectTools.commitFloating();
    this.edit(target.maskFile ? 'Replace Layer Mask' : 'Copy Layer Mask', () => {
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
    this.isMaskSelected = true;
}
```

**"Cmd-click the mask thumbnail loads the mask's black (hidden) areas as the selection …"** — `[x]` done.

---

## 15. Folder and adjustment masks (checklist "Folder and adjustment masks")

**"A folder's mask clips every layer inside it, multiplied with each layer's own mask and outer folders' masks"**
- Upstream: `FolderMaskClip` (`LM:168-210`) placed by the folder's `transform` only (its `maskPlacement` is ignored),
  coverage 0 outside the folder's rect; applied to adjustment layers inside too (`LLM:195-206`); not part of a
  clipping source's coverage (`compositing.md` 7, 8.2).
- Board: `applyFolderMasks` (`media/render.js:181-187`) already does this, using `folder.transform` and
  `destination-in` (which also clears outside the rect). Painting a folder's mask (folder targeted with
  `isMaskSelected`) is allowed by `canPaint`; the board's brush must accept it (`brush.md` 11).

**"Layer effects are built from the masked pixels, so they follow the shape that is shown"**
- Upstream: `LayerEffectsRenderer.render(_:mask:effects:)` masks the pixels before building effects
  (`Document/LayerEffects.swift:448-459`).
- Board: effects are not rendered (`media/render.js:5`); when they are, pass the layer's mask (resampled into its
  grid, `clipImage`) to the effects builder.

---

## 16. Clipping masks (checklist "Clipping masks")

Exact JS ports (path A):

```js
// LiveMaskGraph.validate (LLM:4-19)
function liveMaskGraphValid(layers) {
    const byID = new Map();
    for (const l of layers) { if (byID.has(l.id)) return false; byID.set(l.id, l); }
    for (const l of layers) {
        const path = new Set();
        for (let id = l.id; id; ) {
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
}
// canLinkMask (LLM:23-30)
function canLinkMask(b, source, target) {
    if (!b.canEditLayers() || source === target) return false;
    const layers = b.doc.layers, s = b.doc.layer(source), t = b.doc.layer(target);
    if (!s || s.isGroup || s.adjustment || !t || t.isGroup) return false;
    return liveMaskGraphValid(layers.map((l) => (l.id === target ? { ...l, maskSourceID: source } : l)));
}
// canToggleClippingMask (LLM:212-219)
function canToggleClippingMask(b, id) {
    const layer = b.doc.layer(id);
    if (!b.canEditLayers() || !layer || layer.isGroup) return false;
    if (layer.maskSourceID) return true;
    const siblings = b.siblings(layer), i = siblings.indexOf(layer);
    if (i <= 0 || siblings[i - 1].isGroup) return false;
    return canLinkMask(b, siblings[i - 1].maskSourceID || siblings[i - 1].id, id);
}
// toggleClippingMask (LLM:221-230), linkMask (LLM:31-38), removeLiveMask (LLM:53-71)
function toggleClippingMask(b, id) {
    const layer = b.doc.layer(id);
    if (!b.canEditLayers() || !layer || layer.isGroup) return;
    const siblings = b.siblings(layer);
    if (layer.maskSourceID) {
        const source = layer.maskSourceID, from = siblings.indexOf(layer);
        const releases = [];
        for (const l of siblings.slice(from)) { if (l.id === id || l.maskSourceID === source) releases.push(l); else break; }
        b.edit('Release Clipping Mask', () => releases.forEach((l) => delete l.maskSourceID));
        return;
    }
    const i = siblings.indexOf(layer);
    if (i <= 0 || siblings[i - 1].isGroup) return;
    const source = siblings[i - 1].maskSourceID || siblings[i - 1].id;
    if (!canLinkMask(b, source, id)) return;
    b.edit('Create Clipping Mask', () => { layer.maskSourceID = source; });
}
```

**"Create Clipping Mask: clips the layer to the next lower sibling in the same folder, or to that sibling's base if it is already clipped (one base per stack); undo "Create Clipping Mask""** — `toggleClippingMask` above.

**"Rules: folders cannot be clipped; the base cannot be a folder or an adjustment layer; no cycles; clip chains under 256"**
- `liveMaskGraphValid` / `canLinkMask`. An adjustment layer **can** be clipped (target), never be a base; a layer
  above a clipped adjustment layer clips to that adjustment's base.

**"Release Clipping Mask releases the layer and the clipped layers above it that share its base; lower siblings untouched; undo "Release Clipping Mask""**
- `removeLiveMask` is the `releases` loop above (the run is cut at the first sibling that is neither the target nor
  clipped to the same base).

**"Option-click the bottom strip of a row (min(10 pt, row height / 3), not on folders) toggles clipping; the cursor shows a create or release clipping badge"**
- Upstream (`NLL:697-705, 736-766`): zone = `point.y >= rowRect.maxY - min(10, rowRect.height / 3)` (flipped view, so
  the **bottom** of the row), never on folder rows. With ⌥ and without ⌘ the table takes the click in the zone even
  over the eye, the layer thumbnail and effect sub-rows, but **not** over a mask thumbnail (that is the mask's
  ⌥-gesture). The click calls `toggleClippingMask(row's layer)`: the row under the pointer, not the active layer; the
  selection does not change; the effect selection is cleared; the cursor is refreshed.
- Board: in the row's `pointerdown`, before selecting: `if (e.altKey && !e.metaKey && !record.isGroup &&
  e.clientY >= box.bottom - Math.min(10, box.height / 3) && !e.target.closest('.mask-thumb')) { toggleClippingMask(...);
  return; }`. Cursor rules in section 3.

**"Clipped rows: indented 24 pt, "↳ " name prefix, subtitle "Clipped to <base>", no depth tag"** — section 3.

**"Text, shape and pixel layers can all be clipping bases"**
- Upstream: `canLinkMask` excludes only folders and adjustment layers as bases (`LLM:25`). A **blank** layer can be a
  base too; it has no pixels, so its clipped layers show nothing (`compositing.md` 8.2).
- Board: `media/render.js:52-64` builds stacks from any non-clipped, non-adjustment base; a blank base has no
  `source()` and draws nothing, matching.

---

## 17. Keyboard shortcuts (checklist "Keyboard shortcuts")

Defaults from `UI/KeyboardShortcuts.swift:104-108` (modifier codes: 1 ⌘, 3 ⌥⌘, 9 ⇧⌘). All are menu shortcuts: they
work wherever focus is except text fields, and follow their menu item's enabled state.

| Checklist line | Chord | Board `keydown` (`media/board.js:1276-1307`) |
|---|---|---|
| **"Toggle Clipping Mask: ⌥⌘G"** | `KeyG` + meta + alt, no shift | add: `if (canToggleClippingMask(active)) toggleClippingMask(active)` |
| **"Group Layers: ⌘G"** | `KeyG` + meta | add: `layer.group` (enabled by `canEditLayers`) |
| **"Ungroup Layers: ⇧⌘G"** | `KeyG` + meta + shift | add: `layer.ungroup` when `canUngroupLayers` |
| **"New Blank Layer: ⇧⌘N"** | `KeyN` + meta + shift | exists; gate with `canEditLayers` |
| **"Move Layer Up: ⌘]"** / **"Move Layer Down: ⌘["** | `BracketRight` / `BracketLeft` + meta | exist; gate with `canMoveActiveLayer` |
| **"Merge Layers: ⌘E; menu title follows context (Merge Down / Merge Layers / Merge Group)"** | `KeyE` + meta | add: `layer.merge` when `canMergeLayers` |
| **"Duplicate / Layer via Copy: ⌘J"** (`[x]`) | `KeyJ` + meta | exists; route the no-selection case to `layer.duplicate` |
| **"Undo: ⌘Z …"** / **"Redo: ⇧⌘Z …"** | | section 18 |

Upstream lets the user remap every one of these (`ShortcutSettings`); the board has fixed chords (section 21).
VS Code binds ⌘G / ⇧⌘G (Find Next / Previous) and ⌘E (Find With Selection) in editors (`ui.md` 12.2); the board
must `preventDefault()` + `stopPropagation()` them, as it already does for its other chords. ⌥⌘G has no known VS
Code default; verify in a real build.

---

## 18. Edit › Undo / Redo (checklist "Edit › Undo / Redo")

**"Undo (⌘Z): menu title "Undo <action name>" (e.g. "Undo Move Pixels"); disabled when nothing to undo"** and
**"Redo (⇧⌘Z): menu title "Redo <action name>""**
- Upstream (`APP:42-46`): `history.canUndo ? "Undo \(undoName)" : "Undo"`, disabled unless `session.canUndo`
  (`canUseHistory && (history.canUndo || gradientEdit != nil)`, `ES:654`); Redo the same with `redoName`.
- Board: VS Code owns the stack in an editor tab (`vscode-extension/extension.js:393-403`) and its own Edit menu
  cannot show names. The board's menu bar (`media/board.js:1077-1078`) shows
  `label: () => this.history.done.length ? 'Undo ' + this.history.done.at(-1).label : 'Undo'` (and `undone` for
  Redo) and `enabled: canUseHistory && stack not empty`. The board's history mirrors VS Code's one entry per push, so
  the names line up.

**"While text editing, Levels, a busy operation, the New canvas screen, the importer, a rename, or a persistent transform is active, Undo/Redo go to the focused text field's native undo instead of document history"**
- Upstream (`APP:26-41`): in those states the menu items only forward `undo:` / `redo:` to a focused `NSTextView`.
- Board: `keydown` returns early in inputs (`media/board.js:1233-1235`), so ⌘Z there reaches VS Code, which routes it
  to the webview's focused element on its own; while `renamingID` or a persistent transform is set,
  `undoRedo()` must do nothing for document history. (Verify in VS Code that ⌘Z inside the rename field undoes
  typing and does not call the custom editor's undo.)

**"History unavailable during dialogs, strokes, transforms, imports and similar modal states"**
- Upstream `canUseHistory` (`ES:650-653`): no selection-amount dialog, Color Range, text draft, busy operation,
  import, stroke, warp, Levels, New canvas screen, importer, rename, import error, **any** transform edit, PSD
  conversion sheet. (A pixel move, an open filter panel or Hue/Saturation do not block it.)
- Board: `undoRedo` checks only `view.busy` (`media/board.js:1061-1065`). Add `working`, `openPanel`, `colorRange`,
  `renamingID`, a pending transform / floating selection (the board already turns ⌘Z into "cancel floating",
  `media/board.js:1263-1268`).

**"First Undo discards a pending (uncommitted) gradient, as in Photoshop"** — gradient tool spec; `undo()` returns
after `cancelGradient()` (`ES:657-662`).

**"History limit: 100 steps and 256 MiB of pixel memory retained only by history; oldest steps dropped first"**
- Upstream (`Document/DocumentHistory.swift:25-31, 97-126`): after every append, undo and redo, drop the oldest past
  entry (then the oldest future one) while `past + future > 100` or the bytes of images held by history and **not**
  by the live document exceed 256 MiB (images counted once, by identity).
- Board: `media/history.js:12, 41-43` keeps 768 MiB of all entry bytes and no step cap. Set the cap to 100 entries and
  the byte budget to 256 MiB counted over bitmaps that are not the live `entry.image` / `entry.mask` of any layer.
  VS Code's own stack keeps going past the cap; an undo VS Code sends for a dropped entry finds nothing
  (`history.undo()` returns null): accept and document (section 23).

**"Each step snapshots the whole document (layers, guides, selection) and the active layer; images are shared, not copied"**
- Board: entries hold the manifest JSON before/after (which includes `activeLayerID` and `guides`), the selection, and
  pixel diffs. Equivalent. `selectedLayerIDs` and `isMaskSelected` are **not** part of an entry upstream either.

**"Selecting layers, navigating, and edits that change nothing create no step and keep redo history"**
- Board: `board.edit` returns without a push when nothing changed (`media/board.js:629-638`); `selectLayers` /
  `selectLayer` never push. Engine answers with `saved: false` push nothing.

**"Whole gestures are one step (nestable transactions)"**
- Board: one `board.edit` per gesture; the eye swipe, opacity drag and drag-and-drop must each be one edit (sections
  3, 2, 4); engine structure ops come back as one edit.

**"Restoring a snapshot cancels crop/gradient, keeps the mask target if valid, and refits the view when the canvas size changed (e.g. a rotation)"**
- Upstream `restore` (`ES:669-679`): `keepMaskTarget = isMaskSelected && activeLayerID == snapshot.activeLayerID`;
  then the document and active layer are replaced (the setter resets the selection to `{active}`), and
  `isMaskSelected = keepMaskTarget && active.mask != nil`.
- Board: `CB.applyState` (`media/board.js:58-63`) must, after applying: remember the active id before, call
  `setActive(newActive)` (collapses the multi-selection), and restore `isMaskSelected` under the same rule; refit when
  `width`/`height` changed.

**"Modified state: tracked against the saved revision; undoing back to the saved state reads as unmodified"**
- Board: VS Code's custom-editor dirty flag follows its edit stack and save point; the board also autosaves
  (`scheduleAutosave`). No board work.

---

## 19. Engine API to add

New file `engine/Sources/LayerOps.swift`, dispatched from `EngineOperations.run` after `selectionOperation` and
`filterOperation` (`engine/Sources/EngineMain.swift:50-58`). "Structure" ops are sent with `stateless: true` (no
flush, `vscode-extension/extension.js:250`) and never save; "full" ops use `withSession` and save.

### 19.1 Operation table

Common arguments: `project`, `activeLayerID`, `selectedLayerIDs`, `isMaskSelected`, `collapsedGroupIDs` (1.4).
Structure ops add `manifest` (the board's current manifest JSON) and `sizes` (`{id: {image: [w, h], mask: [w, h]}}`
from the decoded entries).

| Request | Kind | Extra args | EditorSession calls (exact) | Sync | Preconditions (upstream guards) | Answer adds |
|---|---|---|---|---|---|---|
| `layer.group` | structure | — | `groupSelectedLayers()` | sync | `canEditLayers`, `< 10_000` layers, valid hierarchy | `layers`, state |
| `layer.ungroup` | structure | — | `ungroupLayers()` | sync | `canUngroupLayers` | `layers`, state |
| `layer.moveOutOfFolder` | structure | — | `moveActiveLayerOutOfGroup()` | sync | active has a parent | `layers`, state |
| `layer.place` | structure | `ids` (panel order, carried descendants removed, `NLL:503-510`), `rowID` (row under the drop line, or the folder when `intoFolder`; `null` = past the end), `intoFolder`, `copying` | port of `NLL:470-497` below: `beginEdit`, loop `placeLayer(_:in:above:atBottom:)` or `duplicateLayer(_:in:above:atBottom:)`, `selectLayers(Set(ids), primary: ids.first)` when moved, `endEdit` | sync | `canPlaceLayer` for every id (`validateDrop`, `NLL:436`) | `layers`, `copies`, state |
| `layer.duplicate` | structure | `ids?`, `editName?` | `duplicateActiveLayer()`, or `duplicateLayers(ids, editName:)` | sync | `canEditLayers` | `layers`, `copies`, `maskCopies`, state |
| `mask.add` | structure | `revealing`, `selection` | `addMask(revealing:)` | sync | `canEditMask`, no mask | `layers`, mask PNG in `out` + `maskLayerID`, `selection` (now `null`), state |
| `layer.check` | structure, read-only | `ids?` | evaluates `canMergeLayers`, `mergeTitle`, `canUngroupLayers`, `canMoveActiveLayer(by: ±1)`, `canEditMask`, `canConvertLayerDepth`, `canToggleClippingMask(id)` and `canPlaceLayer(id, in:)` for `ids`, `canPaint`, `paintRefusal`, `canInvert` | sync | — | the values (tests only) |
| `layer.merge` | full | — | `mergeLayers()` | sync (draws on the main actor) | `canMergeLayers` | `saved`, `editName`, `changedFiles`, state |
| `layer.convertDepth` | full | — | `convertLayerDepth()` | sync | `canConvertLayerDepth` | same; `error` from `brushError` |
| `layer.convertHDRTo16` | full | — | `convertHDRToSixteenBit()` | sync | HDR asset | same |
| `layer.delete` | full | `choice: "bake"` | ids as `deleteSelectedLayers` (array order; one id → active), targets as `LLM:105-106`, `LiveMaskBaker.bake(snapshot, target:)` per target in `Task.detached`, then `finishDeletingLayers(ids, baked:)` | **async** (await the detached bake) | `canEditLayers` | same |
| existing `selection.fill`, `.clear`, `.invertPixels`, `.layerViaCopy`, `.copy`, `.addMask` | full | — | unchanged | — | — | must now receive `selectedLayerIDs`, `isMaskSelected`, `maskPaintWhite` |

`layer.place`, verbatim port of the private `place` in `NLL:470-497`:

```swift
func place(_ s: EditorSession, _ args: [String: Any]) {
    let ids = (args["ids"] as? [String] ?? []).compactMap(UUID.init(uuidString:))
    let copying = args["copying"] as? Bool ?? false, intoFolder = args["intoFolder"] as? Bool ?? false
    let row = (args["rowID"] as? String).flatMap(UUID.init(uuidString:))
    let parent: UUID?, above: UUID?, atBottom: Bool
    if intoFolder, let folder = row { parent = folder; above = nil; atBottom = false }
    else if let row, let target = s.document?.layers.first(where: { $0.id == row }) { parent = target.parentID; above = row; atBottom = false }
    else { parent = nil; above = nil; atBottom = true }
    guard !ids.isEmpty, ids.allSatisfy({ s.canPlaceLayer($0, in: parent) }) else { return }
    let order = intoFolder ? Array(ids.reversed()) : ids
    s.beginEdit(copying ? (ids.count > 1 ? "Duplicate Layers" : "Duplicate Layer") : (ids.count > 1 ? "Move Layers" : "Move Layer"))
    var placed = false
    for id in order {
        let done = copying ? s.duplicateLayer(id, in: parent, above: above, atBottom: atBottom)
                           : s.placeLayer(id, in: parent, above: above, atBottom: atBottom)
        placed = done || placed
    }
    if placed, !copying { s.selectLayers(Set(ids), primary: ids.first) }
    s.endEdit()
}
```

### 19.2 The structure session

```swift
/// A session holding the board's current manifest with stand-in pixels of the right sizes: enough for every edit that
/// only rearranges records (none of them draws a layer), without reading or writing the package.
func structureSession(_ args: [String: Any]) throws -> EditorSession {
    let manifest = try JSONDecoder().decode(ProjectManifest.self,
                                            from: JSONSerialization.data(withJSONObject: args["manifest"] ?? [:]))
    let sizes = args["sizes"] as? [String: [String: [Int]]] ?? [:]
    var images: [UUID: ImportedImage] = [:], masks: [UUID: ImportedImage] = [:]
    for layer in manifest.layers {
        let size = sizes[layer.id.uuidString]
        if layer.imageFile != nil { images[layer.id] = try placeholder(size?["image"], gray: false) }
        if layer.maskFile != nil { masks[layer.id] = try placeholder(size?["mask"], gray: true) }
    }
    let session = EditorSession()
    session.installProject(ProjectSnapshot(manifest: manifest, images: images, masks: masks), from: try url(args))
    // then, in this order: activeLayerID, selectedLayerIDs, isMaskSelected, collapsedGroupIDs, document.selection
    return session
}
```

- `placeholder(size, gray:)` returns an `ImportedImage(image: x, thumbnail: x, name: "")` whose `CGImage` has the true
  pixel size, backed by a `CGDataProvider(directInfo:size:callbacks:)` that serves zeros, so no `w × h × 4` buffer is
  allocated. One distinct `CGImage` per layer and per mask: copies are then identified by identity.
- `LayerShape.loaded` / `LayerText.loaded` bind to the placeholder (`EditorSession+Projects.swift:80-88`), so
  `projectSnapshot()` writes `shape` and `text` back unchanged.
- Answer: if `session.document` differs from before, `layers` = `projectSnapshot()!.manifest.layers` encoded with
  `JSONEncoder` (bottom to top, exactly the upstream array order), `editName = session.history.undoName`, and
  `copies` / `maskCopies` = `{newID: sourceID}` for every new record whose `asset?.image` (or `mask?.asset.image`) is
  identical (`===`) to an existing record's. `mask.add` writes the new mask's `CGImage` as an 8-bit gray PNG to `out`.
  State fields as in 1.4.

Applying it on the board (one undo step):

```js
applyStructure(answer, fallbackLabel, files) {
    const doc = this.doc, local = new Map(doc.layers.map((l) => [l.id, l]));
    const KEYS = ['parentID', 'maskSourceID', 'maskFile', 'maskEnabled', 'maskLinked', 'maskPlacement'];
    const selectionBefore = this.selection;
    const changed = this.edit(answer.editName || fallbackLabel, () => {
        const pixels = [];
        doc.manifest.layers = answer.layers.map((r) => {
            const mine = local.get(r.id);
            if (mine) {                                          // keep unknown keys and the board's own file names
                for (const k of KEYS) { if (r[k] === undefined) delete mine[k]; else mine[k] = r[k]; }
                return mine;
            }
            const from = local.get(answer.copies?.[r.id]), maskFrom = local.get(answer.maskCopies?.[r.id]);
            const record = { ...(from ? CB.Document.clone(from) : {}), ...r };
            if (from && from.imageFile) record.imageFile = `${r.id}${from.imageFile.slice(from.imageFile.indexOf('.'))}`;
            else delete record.imageFile;
            if (from || maskFrom) pixels.push(...this.copyPixels(from && from.id, maskFrom && maskFrom.id, r.id));
            return record;
        });
        doc.manifest.activeLayerID = answer.activeLayerID;
        if (answer.maskLayerID && files.out) pixels.push(this.installMask(answer.maskLayerID, files.out));
        return pixels;
    });
    if (changed && 'selection' in answer) {                      // mask.add consumed the selection in the same step
        const last = this.history.done[this.history.done.length - 1];
        last.selectionBefore = selectionBefore; last.selectionAfter = this.selection = answer.selection;
    }
    this.selectedIDs = new Set(answer.selectedLayerIDs);
    this.isMaskSelected = answer.isMaskSelected;
    this.layers.collapsed = new Set(answer.collapsedGroupIDs);
}
```

`copyPixels` copies the source's **original file bytes** when the source image is unmodified since it was read (see
section 23, risk 1), otherwise the decoded canvas; masks by their gray samples. New ids are marked dirty so the next
save writes them.

### 19.3 Changes to existing engine code

- `EngineOperations.session` (`engine/Sources/EngineMain.swift:61-73`): after setting `activeLayerID`, set
  `selectedLayerIDs` from `args["selectedLayerIDs"]` (intersected with the document, the active id added) and
  `collapsedGroupIDs`.
- `configure` (`engine/Sources/SelectionOps.swift:126-134`): set `isMaskSelected` only when the active layer has a
  mask (as upstream never has it otherwise).
- `outcome` (`:136-148`): add `selectedLayerIDs`, `collapsedGroupIDs`, and for saved full ops `changedFiles`: every
  image or mask file whose layer's `asset?.image` / `mask?.asset.image` is not identical to the one loaded, plus
  removed files. `ProjectStore.save` re-encodes **every** image (`IO/ProjectStore.swift:93-114`), so the extension's
  size/mtime diff (`vscode-extension/extension.js:369-377`) currently re-sends and re-decodes every layer after any
  engine edit, and the board records all of them as pixel changes in history. `pushExternal` should take
  `changedFiles` when given.

---

## 20. Test vectors

Structural vectors can run three ways: the JS port, `layer.check` / structure ops in the engine, and (for the
cited ones) upstream's own tests. Arrays are bottom to top; `X→B` means `X.maskSourceID = B`.

### 20.1 Group

1. `CompositorTests/GroupingSelectionTests.swift:6-22`: one blank layer `L`; ⌘G → `Folder 1` active, `L.parentID =
   Folder 1`; ⌘G again → `Folder 2` wraps `Folder 1` at the root, `L` stays in `Folder 1`; one Undo → 2 records.
2. `:23-48`: folder `F` with child `C`, root sibling `S`; select `{F, C, S}` primary `S`; ⌘G → wrapper `W`;
   `F.parentID = W`, `S.parentID = W`, `C.parentID = F`; drawn order `[C, S]`; selection `{W}`; Undo restores the
   document exactly.
3. `:49-69`: ⌘G with nothing selected → empty `Folder 1` at the root; layers `a` in `Folder 1` and `b` in `Folder 2`;
   select `{a, b}` → new folder `G` at the root holding both; `Folder 1` and `Folder 2` stay at the root (now empty).
4. Array `[A, B, C, D]` (root), select `{B, D}` → `[A, C, Folder 1, B, D]`, `B` and `D` inside `Folder 1`, which
   sits above `C`; active `Folder 1`; undo name "Group Layers".

### 20.2 Ungroup

1. `CompositorTests/GroupTests.swift:110-148`: `[below, F{childA, childB}, above]`, ungroup `F` → `F` gone, children
   at the root in the order below < childA < childB < above, selection `{childA, childB}`, undo name "Ungroup Layers",
   one step.
2. `:151-165`: `[base, clipped→base]` grouped then ungrouped → `clipped→base` kept.
3. `:168-189`: `[outsideBase, between, F{childSource→outsideBase}]` → ungroup → `[outsideBase, between,
   childSource]` and `childSource` released.
4. `F` with opacity 0.5 and a mask holding an opaque layer → after Ungroup the layer shows at full strength, unmasked
   (folder appearance discarded).

### 20.3 Clipping toggles (`CompositorTests/LiveMaskTests.swift:59-81`)

Three pixel layers `[L0, L1, L2]` at the root:

| Step | Result |
|---|---|
| `canToggle(L0)`, `canToggle(L1)` | false, true |
| toggle L0 | nothing changes |
| toggle L1, toggle L2 | `L1→L0`, `L2→L0` (L2 shares L1's base) |
| toggle L2 | `L2` released, `L1→L0` kept |
| toggle L2, then toggle L1 | **both** released ("Release Clipping Mask", one step) |
| Undo | `L2→L0` (and `L1→L0`) back |
| `placeLayer(L2, in: nil, atBottom: true)` | `[L2, L0, L1]`, `L2` released, `L1→L0` kept |

More: a layer above a folder → `canToggle` false; a layer above an unclipped adjustment layer → false; above an
adjustment clipped to `B` → clips to `B`; a folder → false; `linkMask(source: target, target: source)` that would
close a cycle → refused (`LiveMaskTests.swift:96-101`).

### 20.4 Drag placement and clipping

| Before | Drop | After |
|---|---|---|
| `[A, B→A]` + root layer `X` elsewhere | `X` with the line between `B` and `A` (`rowID = A`) | `[A, X→A, B→A]` (adopted), "Move Layer" |
| `[A, B→A, C→A]` | `B` above `C` (`rowID = C`) | `[A, C→A, B→A]` (B keeps its base; it is last, so not "adopted", and the run is intact) |
| `[A, B→A, D, C→A]` (made with ⌘]/⌘[, which never releases) | any `layer.place` in that folder | `C` released (`D` became the base) |
| `F{x}` | `F` onto a row inside `F` | refused, no line shown |
| `[A, B]`, ⌥-drag `A` and `B` above `B` | | two copies placed above `B`; only the last placed copy selected; "Duplicate Layers" |

### 20.5 Merge (engine; the board checks the result)

Canvas 4 × 1, nearest sampling, values ±1 for blending:

| Case | Layers (bottom → top) | Command | Expected |
|---|---|---|---|
| M1 | `L` red opaque 2×1 at (0,0); `U` blue opaque 2×1 at (1,0), opacity 0.5, active | Merge Down | one layer named **"L"** at `U`'s slot, transform origin (0,0) size 3×1; x0 (255,0,0,255), x1 ≈ (128,0,128,255), x2 ≈ (0,0,255,128); opacity 1, Normal; active; undo "Merge Down" |
| M2 | as M1, `L` hidden | Merge Down | name "L", only `U`'s pixels at (1,0) size 2×1 with alpha ≈ 128; `L` gone |
| M3 | as M1, `U` at (3,0) | Merge Down | 4×1 at (0,0): x0-1 red, x2 transparent, x3 blue α≈128; `U`'s off-canvas column lost |
| M4 | `B` opaque at x0 only; `C1→B`, `C2→B` full width; `C2` active | Merge Down | result "C1", **not clipped**, full width; the canvas now shows `C2`-over-`C1` across the whole width |
| M5 | `[A, B, C→B]`, `B` active | Merge Down | result `R` named "A"; `C→R` |
| M6 | folder `F` (opacity 0.5) with opaque white `P` covering the canvas; `F` active | Merge Group | result named `F`'s name at `F`'s slot, white with α≈128, opacity 1 |
| M7 | two blank layers | Merge Down | a canvas-sized fully transparent pixel layer (trim keeps the full size) |
| M8 | `[F1, a (in F1), b]`, `F1` opacity 0.5, select `{a, b}` | Merge Layers | result named "b" at `b`'s slot at the root; `a` merged at full strength (F1's opacity not baked); `F1` left empty |
| M9 | 16-bit `L` + 8-bit `U` | Merge Down | 16-bit result ("16-Bit" tag), PNG bit depth 16 |

Title checks: one layer with a pixel layer below → "Merge Down"; folder active with a non-folder descendant → "Merge
Group"; two selected → "Merge Layers"; active at the bottom of its folder → disabled, title "Merge Down".

### 20.6 Duplicate

- `[A, B]`, select `{A}`, ⌘J → `[A, "A copy", B]`, active "A copy", one step "Duplicate Layer".
- `[A, B]`, select `{A, B}` (active `A`) → `[A, B, "A copy", "B copy"]`, active "A copy", selection both copies.
- Folder `F{x}` → a copy "F copy" above `F` holding a copy of `x` still named "x"; a collapsed `F` gives a collapsed
  copy.
- `[B, C→B]`, duplicate `C` alone → `[B, C→B, "C copy"→B]`: the copy keeps the same base and the run stays intact.
- 16-bit and `.exr` layers duplicate with their original file bytes.

### 20.7 Delete

- `[A, B, C, D]`, select `{B, C}`, active `C` → `[A, D]`, active `D`, "Delete Layers".
- `[A, B]`: delete `B` → active `A`; delete `A` → active `B`.
- `[B, C→B]`: delete `B` → alert "This layer supplies a live mask"; Remove Links → `[C]` unclipped; Bake (engine) →
  `LiveMaskTests.swift:96-117`: 2×2 canvas, target white alpha `[255,255,255,255]` clipped to a hidden source with
  alpha `[255,0,128,255]`: the composite's alpha is the same before and after Bake and Delete, the target is
  unclipped, Undo restores both layers and the link.
- A folder deleted takes its descendants; a layer clipped to a descendant is unlinked (or baked).

### 20.8 Masks

- Add Reveal-All on a 100×100 layer → `maskFile`, 1×1 PNG value 255, `maskEnabled: true`, `maskLinked: true`, no
  `maskPlacement`, target = mask, "Add Reveal-All Mask". ⌥ → value 0, "Add Hide-All Mask".
- Layer 4×4 at (0,0) on a 4×4 canvas, selection rect (0,0)-(2,4): Reveal Selection → 4×4 mask, columns 0-1 = 255,
  2-3 = 0; selection `null` in the same step; ⌥ → inverse, "Hide Selection"; an empty selection → all 0.
- `LayerMaskTests.swift:36-64`: add hide-all (width 1), adding again does nothing, toggle → disabled, delete → no
  mask and target off; three undos walk back; `selectLayerTarget(id, mask: true / false)` flips the target; a folder
  takes a mask.
- Placement after a move by (+10, 0) of a 100×100 layer at (0,0) (`LM:54-59`):

| Mask | Linked | `maskPlacement` before | After |
|---|---|---|---|
| 1×1 | any | any | deleted |
| 100×100 | yes | none | none |
| 100×100 | yes | origin (5,5) size 50×50 | origin (15,5) size 50×50 |
| 100×100 | no | none | origin (0,0) size 100×100 (the old layer rect) |
| 100×100 | no | origin (10,0) size 100×100 | deleted (equals the new layer rect) |

- Copy mask from `S` (no placement, transform `T`) onto `R` (transform `U`): `R.maskPlacement = T` even when
  `T == U`; enabled/linked copied; "Copy Layer Mask"; again → "Replace Layer Mask"; onto a folder → refused.
- Background: a 1×1 mask of 0 → black (mask-alone view all black, thumbnail black); a 10×10 mask white with a black
  center → white; a mask whose 96 px thumbnail edge averages exactly 127.5 → white (`>=`).

### 20.9 Panel geometry and text

- Clipping zone on a 52 px row: the bottom 10 px; with two effect sub-rows (100 px) still 10 px; never on folders.
- Subtitle: a 200×100 layer scaled to 100×50 → "100 × 50 px · 50%"; scaled to 33.33% → "67 × 33 px · 33.3%"; 100.04% →
  no percent; a blank layer on a 640×480 canvas → "640 × 480 px"; a clipped text layer → "Clipped to <base>".
- Thumbnail of a 1000×500 canvas → 36×18 (layer) and 30×15 (mask) points; top-left checker tile gray 0.32.

### 20.10 History

- 101 one-step edits → the first can no longer be undone; redo entries count toward the 100.
- A selection change between two edits does not clear the redo list; Rename to the same name records nothing.
- Undo of "Add Reveal-All Mask" while the mask is targeted → target back to pixels (the mask is gone); Undo of an
  opacity change while the mask is targeted on the same layer → the mask stays targeted.

---

## 21. Not applicable in VS Code / adaptations

| Upstream | Why it cannot exist literally | Closest faithful equivalent |
|---|---|---|
| `NSTableView` selection, drag sessions, `validateDrop` / `acceptDrop` (`NLL:9-38, 406-459`) | The webview preload intercepts HTML5 drag-and-drop (`ui.md` 12.1) | Pointer events with capture on the list; the same hit zones, refusal rules and undo names (sections 3, 4) |
| AppKit range / toggle selection and the "plain press inside a multi-selection keeps it until mouse-up" behavior | No native table | Explicit anchor-based range, ⌘ toggle, deferred collapse on `pointerup` (section 3) |
| `NSAlert.runModal` for the live-mask choice (`LLM:108-114`) | No modal app alerts; a headless engine must never show one | An HTML modal over the board with the same texts, button order and keys (↩ default, ⎋ Cancel); the engine only receives the choice |
| Alert "Couldn’t paint" (`ContentView.swift:297-300`) | Same | The same modal style with title and "OK"; not a toast (the board's `toast` is a softer form; use it only for board-specific notes) |
| Custom `NSCursor`s: clipping badge, show-mask eye, duplicate, load-selection, column resize, resize-left-right, closed hand | CSS cursors only | `cursor: url(data:image/svg+xml,…) x y, auto` drawn from Lucide glyphs with the same outline treatment and hotspots; `col-resize`, `ew-resize`, `grabbing` for the system ones |
| SF Symbols (`folder`, `link`, `eye`, `rectangle.inset.filled`, `sparkles`, `circle.lefthalf.filled`, adjustment symbols) | Not redistributable outside Apple platforms (`ui.md` 12.3) | Lucide: `folder`, `link`, `eye` / `eye-off`, `square-square`, `sparkles`, `contrast`, `square-plus`, `folder-plus`, `trash-2`, `chevron-down` / `chevron-right`; adjustment icons per the adjustments spec |
| `NSPopUpButton` blend menu with highlight callbacks (`UI/BlendModePicker.swift`) | `<select>` gives no highlight events | The board's own menu with hover preview (section 2) |
| macOS menu bar items and their titles ("Undo <name>", "Merge Down", …) | A webview has no menu bar; VS Code's Edit menu shows plain "Undo" | The board's menu bar (`media/menus.js`) with dynamic labels; VS Code's undo stays the owner of ⌘Z |
| Remappable shortcuts (`ShortcutSettings`, `UI/KeyboardShortcuts.swift`) | Not ported | Fixed default chords, consumed in `keydown`; VS Code keybindings cannot reach inside the webview |
| `@AppStorage("layersPanelWidth")` | No UserDefaults | `vscode.setState({panelWidth})` (exists) |
| Retina backing scale 2 for thumbnails (`UI/CanvasThumbnail.swift:7`) | Varies | `window.devicePixelRatio` |
| 1 device-pixel hairline (`NLL:1410-1417`) | CSS px | `calc(1px / dpr)` |
| Undo history shared images and a 256 MiB "retained only by history" budget | JS canvases cannot be identity-shared with the saved files | Count bitmaps not referenced by any live entry; 100-entry cap; accept that VS Code's stack can outlive the board's (section 18) |
| HDR / 16-bit painting at full depth, deep merge, dithered display copy (`Document/DeepLayers.swift`) | Canvas 2D is 8-bit | Paint refused on deep layers (board-only text after rule 5 in section 11); conversions and merges in the engine |
| Text editing on double-click (`editActiveText`) | Text tool not in the board | Until the text spec lands, a double-click on a live-text thumbnail does nothing; the subtitle may say where to edit it (declared adaptation) |
| "Open in Compositor" | Board-only | Kept as the last context-menu item after a separator |
| Notes count in the header and the Notes drawer | Board-only (Claude notes) | Kept; the layer count itself stays `layers.length` |

## 22. Divergences in the current board (fix list)

1. No multi-selection, no mask target, no mask-alone view (`media/board.js:517-529`, `media/layers.js:312`).
2. `deleteLayer` handles one layer, always reassigns the active layer, ignores live-mask dependents.
3. `duplicate` refuses folders, drops 16-bit / HDR pixels, copies only the active layer, re-encodes PNGs.
4. Subtitle rules (pixel size instead of transform size, "Empty", adjustment/text wording, clipped precedence,
   "a missing layer"), depth tag shown on clipped rows, no tag tooltips.
5. Thumbnail checker parity inverted; folder/adjustment/text icons boxed; thumbnail tooltips wrong; accent border
   ignores the mask target and multi-selection.
6. Mask thumbnail not canvas-shaped, not placed, black backdrop instead of the edge tone; no link button; disabled mark
   is a bar, not "╱".
7. Hidden rows dim everything but the eye; upstream dims the whole row.
8. Footer lacks folder, mask, adjustment and effect buttons; trash tooltip wrong; no `layersLookEditable` gating.
9. Blend: no hover preview, enabled for multi-selection; opacity rounded to whole percents.
10. Empty-state text, resize-edge tooltip, missing rounding and clamping of the panel width.
11. Context menu: 10 board items instead of Compositor's 15 (+ submenu); right-click targeting rules missing.
12. Drag: no adopt/release clipping, no multi-drag, no ⌥-drag copy, no autoscroll.
13. Layer menu: missing Clipping, Group, Ungroup, Move Out of Folder, Rename, Merge; Move Up/Down always enabled;
    Delete title static.
14. New Blank Layer: folder insertion index uses direct children; parent folder not expanded.
15. Disclosure: collapsing a folder holding the active layer does not select the folder; selecting a layer does not
    reveal it.
16. `commitTransform` mask placement handles only placed + linked masks (`media/board.js:700-703`).
17. Engine calls never send `selectedLayerIDs`, `isMaskSelected`, `maskPaintWhite`; Image › Invert, Fill, Clear do not
    know the mask target.
18. History: 768 MiB budget, no 100-entry cap; undo does not restore the mask-target rule.

## 23. Risks and blockers

1. **Deep and EXR files are lost on board undo/redo.** `exportChanges` never writes an image whose decoded canvas is
   `deep` (`media/document.js:224-227`), and `writeProject` deletes every file the manifest no longer references
   (`vscode-extension/core/package-io.js:147-150`). Undoing a merge, delete or duplicate that removed or created a
   16-bit / HDR layer therefore leaves the manifest pointing at a file that is gone: Compositor will refuse the project
   ("An image inside the project is missing or damaged…"). Blocker for paths B and C on deep layers. Fix: keep each
   entry's original file bytes (`entry.raw`) from `decodeInto` until the board changes those pixels, and have
   `exportChanges` write `raw` verbatim for any referenced file that is missing or was pruned; the same bytes make
   duplicates and 8-bit round trips exact (Canvas 2D's premultiplied storage loses precision on semi-transparent
   pixels when re-encoded).
2. **Engine full sessions are heavy.** Each one flushes, decodes the package, re-encodes every image and renders a
   Quick Look preview (`IO/ProjectStore.swift:89-129`, `engine/Sources/EngineMain.swift:76-80`), and the extension then
   re-sends every file because sizes and mtimes all changed. Without `changedFiles` (19.3), a merge on a large
   document costs seconds and stores every layer twice in history. The structure session (19.2) exists to keep panel
   commands off this path.
3. **The structure session is new engine code** that builds an `EditorSession` from stand-in images. Every structural
   method listed was checked not to draw layer pixels; any future op added to it must be checked the same way. The
   board must send correct `sizes` (for EXR layers it does not know them, so `mask.add` on HDR layers must use the
   full-session `selection.addMask`).
4. **Never call the alerting delete entry points in the engine** (`deleteLayer`, `deleteSelectedLayers`,
   `deleteLayerOrMask`, `deleteKeyPressed`): `NSAlert.runModal()` blocks the stdio loop.
5. **Asynchronous duplicate.** `media/view.js:703-708` relies on `actions.duplicate` returning the copy at once for
   the canvas ⌥-drag; making it an engine call needs that drag to wait (6.2).
6. **Mask background approximation.** `render.js` computes the white/black edge tone from the full-size mask edge;
   upstream reads the edge of a ≤ 96 px high-quality downsample (`LM:35-48, 63-76`). They differ only for masks whose
   edge averages close to 50% gray; use one shared function (ideally on a 96 px `drawImage` downsample) for rendering,
   thumbnails and the mask-alone view so the board is at least self-consistent.
7. **Keyboard clashes to verify in a real VS Code build:** ⌘G, ⇧⌘G, ⌥⌘G, ⌘E, ⇧⌘N (New Window) and ⌘J (Toggle Panel)
   must be consumed by the webview before VS Code acts (`ui.md` 12.2 flags ⇧⌘N and ⌘J as high risk); also that ⌘Z
   inside the rename field undoes typing rather than calling the custom editor's undo.
8. **Merge runs Core Image / Metal in the engine** (`drawLiveComposite` with adjustment and separable blend surfaces);
   on a machine or CI runner without GPU access the engine's merge may fail or fall back; test M1-M9 on the target
   machines.
9. **VS Code's undo stack outlives the board's 100-entry history**: an undo for a dropped entry does nothing while
   VS Code believes it undid something. Acceptable but should be documented to the user.
