# Compositor Selection Subsystem: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3, `MARKETING_VERSION = 1.5.3`, commit
`365b574`). All `file:line` references are relative to `upstream/Compositor/` unless they start with `engine/`,
`media/` or `CompositorTests/`. Code excerpts are verbatim. Modifier glyphs follow `ui.md`: `⌘` Command, `⌥` Option,
`⇧` Shift, `⌃` Control, `⌫` Delete, `⎋` Escape, `↩` Return.

Files read in full: `Document/Selection.swift` (363 lines), `Document/SelectionEdits.swift` (238),
`Document/SelectionClipboard.swift` (326), `Document/FloatingSelection.swift` (174), `Document/MagicWand.swift` (138),
`Document/ObjectSelection.swift` (298), `Document/ColorRangeSelection.swift` (157), `Document/ContentFill.swift` (28),
`Document/GuidedMatte.swift` (118), `Document/MaskTracing.swift` (95), `Document/SubjectRemoval.swift` (143),
`Rendering/WandPixels.h` (28), `Rendering/WandPixels.c` (205), `UI/LassoControls.swift` (271),
`UI/ColorRangeSheet.swift` (91), and the tests `CompositorTests/SelectionTests.swift`, `MagicWandTests.swift`,
`SelectionFeatherTests.swift`. Read in part (targeted): `Document/EditorSession.swift`, `CompositorApp.swift`
(Edit, Select, Image and Layer menus), `Rendering/EditorCanvas.swift` (3233; cursors, press/drag/release, keys,
autoscroll, ants timer), `Rendering/TransformOverlay.swift` (ants and draft drawing), `Document/BrushStroke.swift`
(fill, clear, lift, move), `Document/EditorSession+Brush.swift`, `Document/Filters.swift` (Content-Aware Fill path),
`Document/PixelAdjust.swift`, `Document/LayerMask.swift` (mask from selection), `Document/Crop.swift` and
`Document/Guides.swift` (snapping), `Document/LayerTransform.swift` (`TransformSnap`, `TransformEdit`),
`Document/DocumentHistory.swift`, `UI/NativeLayerList.swift` (⌘-click thumbnails), `UI/KeyboardShortcuts.swift`,
`ContentView.swift`, `CompositorTests/SelectionEditTests.swift`, `SelectionClipboardTests.swift`, and the engine
already in this repo (`engine/Sources/EngineMain.swift`, `engine/Sources/Paths.swift`, `engine/build.sh`).

**Empirical checks.** Several facts below were measured, not inferred: a scratch Swift program that calls the same
Core Graphics and Core Image APIs with the same arguments as `DocumentSelection.coverage` and `applySelection`, and a
C harness linked against upstream's `WandPixels.c`. Both ran on this machine (macOS 26, Darwin 25.6, Apple Swift 6.4).
Their output is quoted in sections 1.2, 1.3 and 8.10 and marked **(measured)**. The scratch programs were deleted
afterwards.

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| Model | `DocumentSelection { path: CGPath, antialiased = true, feather = 0 }` in **document pixels, y down**. `document.selection == nil` means no selection. A non-nil selection whose path is empty means an **explicit empty selection**, which edits "touch nothing" | `Document/Selection.swift:4-12` |
| Saved? | **No.** It is part of `CanvasDocument` (so undo covers it), never written to disk | `Document/EditorSession.swift:70-71` |
| Undo | Every selection change is one undo step and marks the project modified | `Document/Selection.swift:249-254`, `Document/DocumentHistory.swift:61-73` |
| Combine | `shape ∩ canvas`, then `union` or `subtracting` with the current path, all with `.winding`. **No intersect mode** | `Document/Selection.swift:233-247` |
| Modifiers | ⇧ = Add. ⌥ (with or without ⇧) = Subtract. Fixed at the press for the whole outline | `Document/Selection.swift:122-125` |
| Coverage | CG fill (winding) into 8-bit gray, antialiased unless `antialiased == false && feather == 0`; then `CIGaussianBlur(sigma: feather / 2)` on a clamped image | `Document/Selection.swift:15-29` |
| Aliased fill | CG's non-antialiased fill is **conservative**: every pixel the interior touches with nonzero area becomes 255 **(measured)** | section 1.3 |
| Clip | `SelectionClip { rect, coverage }`, region = path bounds grown by `ceil(2·feather) + 1`, made integral, clipped to the canvas; `coverage == nil` clips everything away | `Document/Selection.swift:34-66` |
| Tools | Marquee (Rectangle, Ellipse), Lasso (Freehand, Polygonal), Magic (Wand, Object). Keys M, L, W pick the tool; **Tab** switches its mode | `Document/Selection.swift:68-83, 182-207`, `Document/EditorSession.swift:424-441` |
| Marquee | Whole-pixel box, ⇧ squares (only a fresh ⇧ after the press), ⌥ subtracts and **never** draws from the center, corners snap | `Document/Selection.swift:91-105, 152-162`, `Rendering/EditorCanvas.swift:2409-2422` |
| Wand | Tolerance 0-255 (32), Point / 3×3 / 5×5 average, Contiguous (on), This Layer / All Layers (This Layer). Per-channel test on **premultiplied RGBA incl. alpha**. Outline traced along pixel edges | `Document/MagicWand.swift`, `Rendering/WandPixels.c` |
| Object | Vision `VNGenerateForegroundInstanceMaskRequest`, instance under the click, edge-preserving upsample, Edge −10…10 px morphology, optional smoothing (Douglas-Peucker 1.6 px, Chaikin ×3) | `Document/ObjectSelection.swift` |
| Select menu | All ⌘A, Deselect ⌘D, Inverse ⇧⌘I, Layer's Pixels, Subject ⌥⌘A, Color Range…, Mask's Black Areas, Expand…, Contract…, Feather… | `CompositorApp.swift:255-293` |
| Not present | Reselect, Border, Smooth, Grow, Similar, Transform Selection (outline only), Quick Mask, Save/Load Selection, intersect | grep of `Document/`, `UI/`, `CompositorApp.swift` |
| Expand / Contract | `path ∪ stroke(path, width 2a, round caps/joins)` clipped to canvas / `path − stroke(...)`. 1…500 px | `Document/Selection.swift:316-342` |
| Feather | `feather = min(250, sqrt(feather² + a²))`, 1…250 px | `Document/Selection.swift:325-331` |
| Pixel ops | Fill ⌥⌫ / ⌘⌫, Delete ⌫ clears, Content-Aware Fill ⇧⌫, Copy ⌘C, Copy Merged ⇧⌘C, Cut ⌘X, Paste ⌘V (in place), Layer via Copy ⌘J, ⌘-drag moves pixels, ⌘⌥-drag duplicates, ⌘-arrows nudge pixels, ⌘T transforms the selected pixels | `CompositorApp.swift:204-254, 351-354`, `Rendering/EditorCanvas.swift:2427-2441, 2255-2261` |
| Ants | 1 pt white line, then black dash `[4, 4]` pt, phase +1 every 0.12 s, modulo 8. Drawn on the hard outline (feather is not shown) | `Rendering/TransformOverlay.swift:296-311`, `Rendering/EditorCanvas.swift:2470-2486` |
| Engine | Already exchanges selections as `{ path: [["M",x,y],["L",x,y],["Q",…],["C",…],["Z"]], antialiased, feather }` or `null` | `engine/Sources/Paths.swift` |

---

## 1. Selection model

### 1.1 `DocumentSelection`

`Document/Selection.swift:4-12`:

```swift
/// A document-space selection outline, clipped to the canvas. `nil` on the document
/// means no selection; a selection whose path is empty is an explicit empty selection,
/// which later edits must treat as "touch nothing", never as "touch everything".
nonisolated struct DocumentSelection: Equatable, @unchecked Sendable {
    let path: CGPath
    var antialiased = true
    /// How far the edge fades, in document pixels. 0 is a hard edge.
    var feather: CGFloat = 0
    var isEmpty: Bool { path.isEmpty || path.boundingBoxOfPath.isNull || path.boundingBoxOfPath.isEmpty }
```

| Field | Meaning | Who sets it |
|---|---|---|
| `path` | Outline in document pixels (origin top-left, y down). Usually lies inside `[0, W] × [0, H]`, but a moved outline is not re-clipped (section 3.9) | every tool and command |
| `antialiased` | Edge coverage is fractional (true) or conservative-hard (false). Taken from the options bar's **Anti-alias** toggle (`session.selectionAntialiased`, default `true`, `Document/EditorSession.swift:266`) when a tool makes a **new** selection. Kept by Expand, Contract, Feather, Inverse and moves | `applySelection`, wand, object, color range |
| `feather` | Gaussian softening in document pixels. Only Feather changes it. A tool that makes a new selection resets it to 0 | `featherSelection` |

Semantics:

- **Three states.** `nil` (no selection: edits touch the whole layer), non-empty, and explicit empty
  (`isEmpty == true`: edits touch nothing, painting is refused). `isEmpty` uses `boundingBoxOfPath`, which is the
  tight bounds of the curve (control points excluded). A degenerate path with zero width or height is empty.
- **Where the empty state comes from**: subtracting everything (`SelectionTests.swift:55-66`), Contract past the
  middle (`Document/Selection.swift:319-321`), a Marquee or Lasso drawn entirely off the canvas in New mode (the
  intersection with the canvas is empty; see quirk 9.4), a Color Range that matches nothing returns `nil` instead
  (section 4.5).
- **Equality** is synthesized. `CGPath ==` compares element by element (CFEqual). `setSelection` skips an
  unchanged value, so no undo step is recorded (`Document/Selection.swift:249-254`).
- **Undo.** `CanvasDocument.selection` is "Part of the document so undo/redo covers selection changes. Not saved to
  disk." (`Document/EditorSession.swift:70-71`). `DocumentHistory.end` compares whole documents
  (`guard before.document != document else { return }`, `Document/DocumentHistory.swift:66`), so a selection change
  creates an undo entry **and** a new revision, which marks the project modified even though nothing on disk changes.
- **Lifetime.** Dropped (set to `nil`) by: Paste, Layer via Copy and any other `addPixelLayer` with
  `dropsSelection: true` (`Document/SelectionClipboard.swift:307`); adding a mask from the selection
  (`Document/LayerMask.swift:263`); every operation that installs a new `CanvasDocument` (Crop, Canvas Size, Image
  Size, Trim through `applyDocumentSize`, `IO/ImageResizer.swift:112-120`; opening or reloading a project,
  `Document/EditorSession+Projects.swift:21-35`). Transformed with the canvas by Rotate Canvas
  (`Document/CanvasRotation.swift:51-57`) and Flip Canvas (`Document/LayerFlip.swift:69-76`):

  ```swift
  var mirror = horizontally
      ? CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: document.size.width, ty: 0)
      : CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: document.size.height)
  ```
  ```swift
  var turn = clockwise ? CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: canvas.height, ty: 0)
                       : CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: canvas.width)
  ```
  A shape or text layer keeps it (`dropsSelection: false`, `Document/ShapeTool.swift:189`, `Document/TypeTool.swift:309`).

### 1.2 Combining outlines

Every tool that makes an outline goes through `applySelection` (`Document/Selection.swift:233-247`), except a
New-mode Magic Wand or Object result (section 3.7), which is already on the canvas:

```swift
func applySelection(_ shape: CGPath, mode: SelectionMode, name: String) {
    guard let document, canEditSelection else { return }
    let canvas = CGPath(rect: CGRect(origin: .zero, size: document.size), transform: nil)
    let clipped = shape.intersection(canvas, using: .winding)
    let result: CGPath
    switch mode {
    case .replace: result = clipped
    case .add: result = selection.map { $0.path.union(clipped, using: .winding) } ?? clipped
    case .subtract:
        // Subtracting from no selection selects nothing new, so nothing changes.
        guard let current = selection else { return }
        result = current.path.subtracting(clipped, using: .winding)
    }
    setSelection(DocumentSelection(path: result, antialiased: selectionAntialiased), name: name)
}
```

- The operations are Core Graphics' path booleans (macOS 13+: `CGPath.intersection(_:using:)`, `union`,
  `subtracting`), with the **nonzero winding** rule for reading both inputs. A self-intersecting freehand lasso is
  therefore filled where its winding number is nonzero, including regions wound twice.
- The new selection takes `selectionAntialiased` and **feather 0**, even when it adds to a feathered selection.
- There is no intersect mode: `SelectionMode` has `replace` ("New"), `add` ("Add") and `subtract` ("Subtract")
  only (`Document/Selection.swift:85-89`).

What the booleans return **(measured)**:

| Input | Result elements |
|---|---|
| `rect(10,10,40,40) ∪ ellipse(30,30,40,40)` | `M 10,10 L 50,10 L 50,30 C 61.05,30 70,38.95 70,50 C 70,61.05 61.05,70 50,70 C 38.95,70 30,61.05 30,50 L 10,50 Z`: **cubic arcs are kept**, not flattened |
| `ellipse(-10,-10,50,50) ∩ canvas(100×100)` | `M 40,15 C … C … 8.465e-08,34.97 L 0,0 L 34.97,8.465e-08 C … Z`: float noise of about 1e-7 at cut points |
| `rect(10,10,60,60) − rect(30,30,20,20)` | `M 70,70 L 10,70 L 10,10 L 70,10 Z M 30,30 L 30,50 L 50,50 L 50,30 Z`: outer contour clockwise on screen (positive shoelace area with y down), hole counterclockwise |
| counterclockwise lasso `(10,10)(10,60)(60,60)` `∩ canvas` | `M 60,60 L 10,60 L 10,10 Z`: re-oriented clockwise |
| bow tie `(10,10)(50,50)(50,10)(10,50)` `∩ canvas` | two triangles `M 50,50 L 30,30 L 50,10 Z M 30,30 L 10,50 L 10,10 Z` |
| contour that winds twice over a region `∩ canvas` | one simple contour; the twice-wound region stays filled |
| `selectAll − selectAll` (Inverse of all) | empty path, `boundingBoxOfPath` null |

So boolean results are **normalized**: non-overlapping simple contours, outer ones clockwise on screen, holes
counterclockwise, corner-touching parts split. On such a path the nonzero and even-odd rules fill the same pixels.
Raw, un-normalized paths reach `document.selection` only from a New-mode Wand or Object click, from Color Range
(traced outlines, also clockwise outside and counterclockwise for holes, `Rendering/WandPixels.h:20-22`), and from
moves and transforms of a normalized path. A port should always fill with **nonzero**.

### 1.3 Coverage

`Document/Selection.swift:14-29`:

```swift
func coverage(width: Int, height: Int) throws -> CGImage {
    let context = try BrushRaster.context(width: width, height: height, mask: true)
    context.setFillColor(gray: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setShouldAntialias(antialiased || feather > 0)
    context.setFillColor(gray: 1, alpha: 1)
    context.addPath(path)
    context.fillPath(using: .winding)
    guard let image = context.makeImage() else { throw ExportError.render }
    guard feather > 0 else { return image }
    // A feathered edge fades either side of the outline, as Photoshop's does.
    let extent = CGRect(x: 0, y: 0, width: width, height: height)
    let soft = CIImage(cgImage: image).clampedToExtent().applyingGaussianBlur(sigma: feather / 2).cropped(to: extent)
    return try PixelAdjust.render(soft, width: width, height: height, isMask: true)
}
```

- `BrushRaster.context(..., mask: true)` is 8-bit DeviceGray with no alpha, **flipped to a top-left origin**
  (`translateBy(0, height); scaleBy(1, -1)`, `Document/BrushStroke.swift:36-44`). Row 0 of the image is document row 0.
  White (255) = selected.
- **Antialiased** fills give exact area coverage to within 1/255 **(measured)**: a rect `(2.25, 2.5, 5.5, 4)` gives
  row 2 = `0 0 95 127 127 127 127 95 0` (half a row times 0.75 of a column = 95.6).
- **Aliased** fills (`antialiased == false` and `feather == 0`) are **conservative** **(measured)**: every pixel whose
  square overlaps the interior with nonzero area becomes 255; a pixel the outline only touches along an edge or corner
  stays 0.

  | Rect x-range (1 px rows) | AA row | Aliased row |
  |---|---|---|
  | 2.00 … 5.00 | `0 0 255 255 255 0` | `0 0 255 255 255 0` |
  | 2.05 … 5.05 | `0 0 243 255 255 12` | `0 0 255 255 255 255` |
  | 2.50 … 5.50 | `0 0 127 255 255 127` | `0 0 255 255 255 255` |
  | 2.95 … 5.95 | `0 0 12 255 255 243` | `0 0 255 255 255 255` |
  | sliver x 3.2, width 0.1 | `0 0 0 25 0` | `0 0 0 255 0` |

  The aliased rule is `hard = (exact area coverage > 0) ? 255 : 0`, not pixel-center sampling. Pixel-aligned outlines
  (Marquee rectangles, every traced outline) are identical either way.
- **Feather**: the 8-bit coverage is blurred by `CIGaussianBlur` with `sigma = feather / 2` in Core Image's
  unmanaged context (`PixelAdjust.ciContext`, no color conversion, `Document/PixelAdjust.swift:8`), after
  `clampedToExtent()`: **edge pixels extend outward**, so a selection that reaches the canvas (or the clip region's)
  edge stays fully selected there instead of fading. Antialiasing is forced on before the blur. The result is
  rendered back to 8-bit `.L8` (`Document/PixelAdjust.swift:50-56`). Measured values match a Gaussian **integrated
  over each pixel** (`Φ((k + 0.5)/σ) − Φ((k − 0.5)/σ)` weights) within ±1 (section 8.3 and 8.10).
- The ants (section 6) do **not** show the feather. They always run along `path`.

### 1.4 Coverage region and `SelectionClip`

`Document/Selection.swift:32-66`:

```swift
/// Four Gaussian standard deviations retain the visible falloff outside the outline.
var coverageBounds: CGRect {
    path.boundingBoxOfPath.insetBy(dx: -ceil(feather * 2), dy: -ceil(feather * 2))
}

/// Coverage for just the selected region of the canvas, ready to clip edits.
func clip(canvas size: CGSize) throws -> SelectionClip {
    let region = coverageBounds.insetBy(dx: -1, dy: -1).integral
        .intersection(CGRect(origin: .zero, size: size))
    guard !isEmpty, !region.isNull, region.width >= 1, region.height >= 1 else { return SelectionClip(rect: .zero, coverage: nil) }
    var translation = CGAffineTransform(translationX: -region.minX, y: -region.minY)
    guard let localPath = path.copy(using: &translation) else { throw ExportError.render }
    let local = DocumentSelection(path: localPath, antialiased: antialiased, feather: feather)
    let image = try local.coverage(width: Int(region.width), height: Int(region.height))
    return SelectionClip(rect: region, coverage: image)
}
```

```swift
/// Selection coverage for one region of the document. Applied as a clip, soft edges
/// blend partially; with no coverage (an empty selection) it clips everything away.
nonisolated struct SelectionClip: @unchecked Sendable {
    let rect: CGRect
    let coverage: CGImage?
    func apply(to context: CGContext) {
        guard let coverage, !rect.isEmpty else { context.clip(to: CGRect.zero); return }
        context.translateBy(x: rect.minX, y: rect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.clip(to: CGRect(origin: .zero, size: rect.size), mask: coverage)
        ...
```

- Region = `integral(bbox grown by ceil(2·feather) + 1) ∩ canvas` (`integral` floors the minimum and ceils the
  maximum). Outside the region coverage is 0. An empty selection, or one wholly off the canvas, gives
  `coverage == nil`, which clips **everything** away.
- The clamp in the blur (1.3) clamps at the **region** edge. Where the region was cut by the canvas this is the
  canvas edge (no fade there). Elsewhere the region is `4σ + 1` px past the outline, so the clamp is invisible.
- `apply` clips in **document coordinates**. When the context's current transform maps a layer's own pixel grid
  (rotated, scaled, flipped layers), Core Graphics resamples the clip mask. This is exact only for unrotated 1:1
  layers (`brush.md` 17.7 item 4).
- Coverage on a layer's grid, used by filters and adjustments (`Document/PixelAdjust.swift:22-33`): a gray grid the
  layer's pixel size, `concatenate(pixelToDocument.inverted())`, `selection.apply`, fill white. Then
  `result = coverage · adjusted + (1 − coverage) · original` in float (`CIBlendWithMask`, `:39-48`).

### 1.5 Who may edit the selection

`canEditSelection` is `canEditLayers` (`Document/Selection.swift:120`), which is false while any dialog or edit is
open: Color Range panel, Expand/Contract/Feather panel, text editing, a stroke, an import, a pending transform
(including a floating selection), a crop rectangle, a pending gradient, a pixel move, Hue/Saturation, Levels, a filter
panel, adjustment editing (`Document/EditorSession.swift:698-701`). Selection commands are silently ignored then.

---

## 2. Modes and modifiers

`Document/Selection.swift:122-139`:

```swift
/// Shift adds, Option (with or without Shift) subtracts; otherwise the options-bar mode.
func selectionMode(shift: Bool, option: Bool) -> SelectionMode {
    option ? .subtract : shift ? .add : selectionModeChoice
}
/// The mode the cursor advertises: an outline in progress keeps its starting mode,
/// otherwise the currently held modifiers or the options-bar choice.
func lassoCursorMode(shift: Bool, option: Bool) -> SelectionMode {
    lassoDraft?.mode ?? selectionMode(shift: shift, option: option)
}
/// What the options bar highlights: the same rule, using the tracked held keys.
var displayedSelectionMode: SelectionMode { lassoDraft?.mode ?? heldSelectionMode ?? selectionModeChoice }
```

- The mode is read **once, at the press** (`Rendering/EditorCanvas.swift:2442`) and stored in `LassoDraft.mode`.
  Changing modifiers during the drag does not change it. For the Marquee, ⇧ during the drag squares the box
  (section 3.3).
- ⇧⌥ is **Subtract**, not intersect (`SelectionTests.swift:48`).
- `selectionModeChoice` (options-bar segmented control, default New, `Document/EditorSession.swift:244`) applies when
  no modifier is held. It is a per-session value, not persisted.
- `heldSelectionMode` is updated from every `flagsChanged` event app-wide (`Rendering/EditorCanvas.swift:765-767`) and on
  every mouse move over the canvas (`:1612-1615`), so the options bar and the cursor badge show the held mode live.
- ⌘-click inside the selection is a pixel move (section 5.7), whatever the mode. ⌘ elsewhere is ignored.
- Layer thumbnails: ⌘-click = New, ⌘⇧-click = Add, ⌘⌥-click = Subtract (`UI/NativeLayerList.swift:1145-1149`).

---

## 3. Selection tools

### 3.1 Tools, keys and modes

| Tool (`NavigationTool`) | Rail label | Modes (`Tab` cycles) | Key | Undo names |
|---|---|---|---|---|
| `.marquee` | "Marquee (M)" | `marqueeKind`: Rectangle, Ellipse (`LassoKind.marqueeChoices`) | M | "Rectangular Marquee", "Elliptical Marquee" |
| `.lasso` | "Lasso (L)" | `lassoKind`: Freehand, Polygonal (`LassoKind.lassoChoices`) | L | "Lasso", "Polygonal Lasso" |
| `.wand` | "Magic (W) · Tab switches Wand and Object" | `wandMode`: Wand, Object | W | "Magic Wand", "Object Selection" |

Refs: `Document/EditorSession.swift:91-99, 215, 231-233`, `Document/Selection.swift:68-83, 182-207`.

- `isSelectionTool` is true for these three (`Document/EditorSession.swift:97`). They share modifiers, outline moves
  and arrow nudges.
- **M, L and W only choose the tool** in whichever mode it was last in (`pressMarqueeKey`, `pressLassoKey`,
  `pressWandKey`; key handling at `Rendering/EditorCanvas.swift:2300-2305`, with `!event.isARepeat`). **Tab** (no
  modifiers, not while typing) switches the mode: `toggleMarqueeKind()`, `toggleLassoKind()`, `wandMode = next(wandMode)`
  (`Document/EditorSession.swift:424-441`, `Rendering/EditorCanvas.swift:2276-2280`). Both toggles cancel a draft first.
  The tool bar's help strings ("Press M to switch between Rectangle and Ellipse", "Press L to switch…",
  `UI/LassoControls.swift:19, 39`) and the shortcut sheet's "Marquee / cycle shape" (`UI/KeyboardShortcuts.swift:119-120`)
  are stale. The tests pin the real behavior (`SelectionTests.swift:392-416, 459-478`).
- Kinds, modes, settings and toggles are **per session** (per open project) and reset on launch. Nothing selection-related
  is in `ToolDefaults`.
- `selectTool` to another tool cancels a draft (`cancelLasso()`), commits a pending transform and cancels a crop
  (`Document/EditorSession.swift:398`).
- The command palette offers "Rectangular Marquee", "Elliptical Marquee", "Lasso", "Polygonal Lasso", "Magic Wand",
  "Object Selection" entries that set the tool and its mode (`UI/CommandPalette.swift:195-200`).

### 3.2 Press dispatch (`lassoMouseDown`, `Rendering/EditorCanvas.swift:2427-2468`)

The canvas ignores presses while `isProjectBusy` or importing (`:1751`), with Space held (Hand), and while a panel that
samples the canvas is open (Color Range takes the click first, `:1787-1793`). For a selection tool, a press does the
first matching row:

| # | Condition | Action |
|---|---|---|
| 1 | A polygonal draft exists | Close it (double-click, or ≥ 3 corners and the press within **8 view points** of the first corner), else add a corner (`extendLasso`). Section 3.5 |
| 2 | ⌘ held and the press is inside the selection (`canMoveSelection`) | `beginPixelMove(duplicate: ⌥)`; on failure **beep**. Section 5.7 |
| 3 | Mode (from ⇧/⌥/options bar) is New and the press is inside the selection | `beginSelectionMove()`: drag the outline. Section 3.9 |
| 4 | Magic tool, Object mode | `Task { await selectObject(at: pixel, mode: mode) }` |
| 5 | Magic tool, Wand mode | `Task { await magicWand(at: pixel, mode: mode) }` |
| 6 | Otherwise | `beginLasso(at: tool == .marquee ? snappedCorner(pixel) : pixel, mode: mode)` |

```swift
/// True where dragging in New mode would move the selection outline.
func canMoveSelection(at point: CGPoint) -> Bool {
    guard let selection, !selection.isEmpty, canEditSelection, lassoDraft == nil else { return false }
    return selection.path.contains(point, using: .winding)
}
```

`pixel` is `viewport.documentPoint(from:)`: fractional document coordinates, **not clamped** to the canvas
(`Rendering/CanvasViewport.swift:25-28`).

**Release without a drag** of a row-3 outline move (`Rendering/EditorCanvas.swift:2144-2159`):

```swift
let moved = session.selectionMoveOrigin != session.selection
session.endSelectionMove()
if !moved, session.tool == .wand, session.wandMode == .object {
    Task { await session.selectObject(at: start, mode: .replace); ... }
} else if !moved, session.tool == .wand {
    // The wand's click inside the selection selects afresh from that pixel.
    Task { await session.magicWand(at: start, mode: .replace); ... }
} else if !moved {
    // A click without a drag deselects, as anywhere else with the lasso.
    session.deselect()
}
```

So in New mode a click inside the selection deselects (Marquee, Lasso), or reselects from that pixel (Wand, Object).
A click outside it with Marquee or Lasso also deselects through `finishLasso` (section 3.3). With ⇧ or ⌥ a click
without a drag does nothing.

`beginLasso` (`Document/Selection.swift:141-150`) refuses to start for the Magic tool, without `canEditSelection`, or
during an outline move:

```swift
guard tool.isSelectionTool, tool != .wand, canEditSelection, selectionMoveOrigin == nil else { return }
if tool == .marquee {
    let anchor = CGPoint(x: point.x.rounded(), y: point.y.rounded())
    lassoDraft = LassoDraft(points: [anchor], cursor: nil, mode: mode, kind: marqueeKind, anchor: anchor)
} else {
    lassoDraft = LassoDraft(points: [point], cursor: nil, mode: mode, kind: lassoKind)
}
```

### 3.3 Marquee (Rectangle, Ellipse)

**Geometry.** The anchor is the snapped press point **rounded to whole pixels**. Each drag reshapes the box from the
anchor to the snapped, rounded pointer (`Document/Selection.swift:91-105, 152-162`):

```swift
static func rect(from anchor: CGPoint, to point: CGPoint, square: Bool, fromCenter: Bool) -> CGRect {
    var dx = point.x.rounded() - anchor.x, dy = point.y.rounded() - anchor.y
    if square {
        let side = max(abs(dx), abs(dy))
        dx = dx < 0 ? -side : side
        dy = dy < 0 ? -side : side
    }
    return fromCenter
        ? CGRect(x: anchor.x - abs(dx), y: anchor.y - abs(dy), width: abs(dx) * 2, height: abs(dy) * 2)
        : CGRect(x: min(anchor.x, anchor.x + dx), y: min(anchor.y, anchor.y + dy), width: abs(dx), height: abs(dy))
}
```

The draft stores the box as 4 corner points. `rounded()` is round-half-away-from-zero (`Math.round` differs for
negative halves: use `Math.sign(v) * Math.round(Math.abs(v))`).

- **⇧ squares** (a circle for Ellipse), using the larger side, but only a **fresh** ⇧. A ⇧ held at the press chose
  Add and does not square until it is released and pressed again (`marqueeConstrainArmed`,
  `Rendering/EditorCanvas.swift:124-126, 2418-2422, 2429-2430`; test `SelectionTests.swift:418-457`). A ⇧ change
  reshapes the draft at once, without a mouse move (`:746-749`).
- **⌥ subtracts and never draws from the center.** The canvas always passes `fromCenter: false`
  (`:2421`; test `SelectionTests.swift:368-390`). `fromCenter` exists for the Shape tool, which shares `DragBox`.
- **No fixed ratio or fixed size** options exist.
- **Snapping** (`snappedCorner`, `Rendering/EditorCanvas.swift:2413-2416`; `Document/Crop.swift:186-195`): the press
  point and every drag point move, per axis, to the nearest target within `10 / pointsPerPixel` document pixels
  (`TransformSnap.distance = 10` view points, `Document/LayerTransform.swift:221`), when View › Snap is on. Targets
  (`cropSnapTargets` = `alignmentSnapTargets(includeCenters: false)`, `Document/Guides.swift:247-285`): canvas edges
  `0, W` and `0, H` (Snap To Document Bounds); every rendered pixel layer's bounding-box edges, rounded (Snap To Layers);
  layout grid lines when the grid is shown (Snap To Grid); guides when shown (Snap To Guides). **⌃ disables snapping.**
  Snapped lines are drawn as snap guides while dragging. Rounding happens after snapping.
- **Autoscroll**: when the pointer is within 12 view points of the visible edge or past it, the view pans
  `min(40, 2 + past · 0.4)` points per frame at 60 Hz toward it, and the corner follows
  (`Rendering/EditorCanvas.swift:2352-2385`). The same runs while dragging an outline (3.9).
- **Finish** on release (`finishLasso`, `Document/Selection.swift:209-231`): Ellipse with 4 points becomes
  `addEllipse(in: box)` (4 cubic arcs; CG's start point is the rightmost point, `(maxX, midY)`); Rectangle becomes
  `addLines` + `closeSubpath` (start at `(minX, minY)`, clockwise on screen). Then:

  ```swift
  let bounds = outline.boundingBoxOfPath
  guard draft.points.count >= 3 || draft.kind == .ellipse, bounds.width > 0, bounds.height > 0 else {
      if draft.mode == .replace { deselect() }
      return
  }
  applySelection(outline, mode: draft.mode, name: ...)
  ```

  A click, or a box of zero width or height, deselects in New mode and does nothing in Add or Subtract
  (`SelectionTests.swift:330-331`).
- The **Anti-alias** toggle is hidden for Rectangle ("Rectangles snap to whole pixels, so smoothing doesn't apply",
  `UI/LassoControls.swift:50-51`), but `selectionAntialiased` is still stored on the result. It makes no difference
  to an integral rectangle.

### 3.4 Freehand Lasso

- Press: `beginLasso(at: pixel)` with the fractional, unsnapped point.
- Drag: `extendLasso(to:)` on every `mouseDragged` (`Rendering/EditorCanvas.swift:1928-1931`). Points closer than a
  quarter pixel to the last one are skipped (`Document/Selection.swift:164-170`):

  ```swift
  if let last = draft.points.last, hypot(point.x - last.x, point.y - last.y) < 0.25 { return }
  ```

- **No smoothing, no simplification, no snapping**. The outline is the raw polyline of pointer samples.
- Release: `finishLasso()` closes it with a straight segment back to the first point (`addLines` + `closeSubpath`).
  Fewer than 3 points, or zero width or height, deselects in New mode.
- Losing keyboard focus mid-drag cancels a freehand or marquee draft (`Rendering/EditorCanvas.swift:2338`).

### 3.5 Polygonal Lasso

- First press: `beginLasso` (corner 1). Each later press adds a corner with `extendLasso` (same 0.25 px rule).
  Pointer moves (with or without the button) update the rubber-band end, `moveLassoCursor(to:)`
  (`Rendering/EditorCanvas.swift:1616-1619, 1932`). Releases do nothing for polygonal drafts (`:2160`).
- **Close**: a double-click (`event.clickCount >= 2`, the first click of the pair already added its corner), or a press
  within **8 view points** of the first corner once there are ≥ 3 corners (that press adds no corner), or **↩ /
  Enter** (keyCodes 36 and 76) (`Rendering/EditorCanvas.swift:2459-2466, 2225-2231`). The rubber-band point is never
  part of the outline.
- **⌫ / ⌦** (51, 117) removes the last corner. Removing the only corner cancels the draft
  (`Document/Selection.swift:174-178`). **⎋** cancels.
- A tool switch or Tab cancels. Losing focus does **not** cancel a polygonal draft (`Rendering/EditorCanvas.swift:2338`).
- A first click inside an existing selection in New mode starts an outline move instead (row 3 of 3.2).
- Mode is fixed by the modifiers at the **first** click.

### 3.6 Draft overlay (`drawLassoDraft`, `Rendering/TransformOverlay.swift:314-345`)

Drawn in view points on the overlay above the canvas, every redraw:

```swift
var points = draft.points.map { $0.applying(transform) }
if draft.kind == .polygonal, let cursor = draft.cursor { points.append(cursor.applying(transform)) }
...
if draft.kind == .ellipse, points.count == 4 { path.addEllipse(in: box) }
else {
    path.addLines(between: points)
    if draft.kind == .rectangle { path.closeSubpath() }
}
context.setStrokeColor(NSColor.black.withAlphaComponent(0.8).cgColor); context.setLineWidth(2); stroke
context.setStrokeColor(NSColor.white.cgColor);                      context.setLineWidth(1); stroke
if draft.kind == .polygonal {
    // The first corner: click it to close the outline.
    let handle = CGRect(x: first.x - 4, y: first.y - 4, width: 8, height: 8)
    white fill, black 1 pt stroke
}
```

- Solid lines (no dash, no animation): a 2 pt black line at 80 % alpha under a 1 pt white line.
- Freehand and Polygonal drafts are drawn **open** (no closing segment). Rectangle is closed. Ellipse is drawn as the
  ellipse in the box.
- The existing selection's ants keep running underneath.

### 3.7 Magic Wand

**Settings** (`Document/MagicWand.swift:3-19`, controls at `UI/LassoControls.swift:90-117`):

| Setting | Values | Default | Control |
|---|---|---|---|
| `tolerance` | 0…255, per channel | 32 | "Tolerance" label (scrub, 1 per point, 0…255) + 44 pt field + ↑/↓ steps |
| `sampleSize` | Point Sample (radius 0), 3 by 3 Average (1), 5 by 5 Average (2) | Point | menu picker |
| `sampleAllLayers` | "This Layer" / "All Layers" | **This Layer** | segmented |
| `contiguous` | on / off | **on** | "Contiguous" checkbox |
| (shared) `selectionAntialiased` | on / off | on | "Anti-alias" checkbox |

**Flow** (`magicWand(at:mode:)`, `Document/MagicWand.swift:98-123`):

1. Refused unless `canEditSelection`, not busy, no outline move, and the point is inside `[0, W) × [0, H)`.
2. Sample image at document size, 8-bit premultiplied sRGB RGBA (`selectionSample`, `:128-137`): with All Layers, the
   live composite exactly as the canvas shows it (`drawLiveComposite`, `Document/LiveLayerMask.swift:161`); with
   This Layer, the active layer's **own pixels** placed by its displayed transform, **without its mask, opacity, blend
   mode or effects**. A folder or blank layer reads as fully transparent.
3. `isProjectBusy = true`; match and trace off the main thread (C, `Rendering/WandPixels.c`).
4. Nothing matched: New mode deselects, other modes do nothing. Error: `brushError` gets "That selection is too detailed
   to outline. Try a different Tolerance, or turn on Contiguous." (more than 8 000 000 pixel edges) or the memory
   message (`:24-32`).
5. New mode: `setSelection(DocumentSelection(path: path, antialiased: selectionAntialiased), name: "Magic Wand")`,
   **without** clipping to the canvas (it is already inside). Add/Subtract: `applySelection(path, mode:)`.

**Matching** (`wand_mask`, `Rendering/WandPixels.c:17-85`):

```c
size_t x0 = seedX > radius ? seedX - radius : 0, x1 = seedX + radius < width ? seedX + radius : width - 1;
size_t y0 = seedY > radius ? seedY - radius : 0, y1 = seedY + radius < height ? seedY + radius : height - 1;
...
for (int c = 0; c < 4; ++c) reference[c] = (int)((sums[c] + samples / 2) / samples);
```

- Seed pixel = `floor(point)`. Reference = rounded mean of the `(2r+1)²` window **clipped to the image** (out-of-image
  pixels are not counted), over all four premultiplied channels.
- A pixel matches when **every** channel, alpha included, satisfies `|p[c] − reference[c]| <= tolerance`
  (`:9-15`). Transparent pixels are `(0,0,0,0)` in premultiplied form, so on This Layer the transparent area around a
  layer is one big matching region when the click is on transparency.
- Contiguous: 4-connected scanline flood fill from the seed (nothing if the seed itself fails). Otherwise every
  matching pixel in the image. Result: a `width × height` byte mask, 255 = selected.

**Tracing** (`wand_trace`, `Rendering/WandPixels.c:87-174`; `MagicWand.outline`, `Document/MagicWand.swift:55-80`):

- Directed boundary edges on the `(W+1) × (H+1)` vertex grid. For each selected pixel `(x, y)`, each side facing an
  unselected pixel (or the image edge) adds one edge, clockwise around the pixel:
  top `(x,y)→east`, right `(x+1,y)→south`, bottom `(x+1,y+1)→west`, left `(x,y+1)→north`
  (bits `EAST = 1, SOUTH = 2, WEST = 4, NORTH = 8`).
- Vertices are scanned in index order (`y · (W+1) + x`). From each vertex with edges left, a loop is walked: the first
  heading is the lowest set bit; then **prefer a right turn, then straight, then a left turn** (`turn_right`: E→S→W→N→E),
  which keeps two loops that touch at a corner apart. Each heading change records a corner. If the loop returns with
  the heading it left with, the start vertex is not a corner and is dropped.
- More than 8 000 000 edges (checked after each row) returns −2 (too detailed).
- Each loop becomes `addLines(between: corners)` + `closeSubpath()`. Outer loops run clockwise on screen, holes
  counterclockwise, so the winding rule reproduces exactly the traced pixels. Output is integer coordinates.

### 3.8 Object Selection (Magic tool, Object mode)

**Settings** (`Document/ObjectSelection.swift:5-10`, controls `UI/LassoControls.swift:119-143`):

| Setting | Values | Default | Control |
|---|---|---|---|
| `sampleAllLayers` | This Layer / All Layers | **All Layers** | segmented ("Analyze the active layer only, or every visible layer as shown") |
| `edgeOffset` | −10…10 px (clamped again at use, `:278`) | 0 | "Edge" label (scrub, 1 per point) + 40 pt field + "px" suffix. Positive tightens inward, negative grows outward |
| smoothing | = `selectionAntialiased` | on | "Anti-alias" ("Smooth the detected object outline; turn off for the raw pixel mask") |

**Flow** (`selectObject(at:mode:)`, `:273-297`, and `ObjectSelection.select`, `:29-51`):

1. Same guards and the same `selectionSample` as the wand (with this tool's own `sampleAllLayers`).
2. macOS 14+ only (`Failure.unsupported`). `VNImageRequestHandler(cgImage: sample, options: [:])` with
   `VNGenerateForegroundInstanceMaskRequest`. The whole sample image (document size) goes to Vision.
3. The instance under the click: Vision's low-resolution `instanceMask` is read nearest-neighbour at
   `x = Int(point.x / W · maskW)`, `y = Int(point.y / H · maskH)`, clamped (`:55-64`). Value 0 (background) or no
   observation returns nil, which deselects in New mode.
4. `observation.generateMask(forInstances: [instance])` (low resolution), refined to full size by
   `CIEdgePreserveUpsampleFilter` with the sample as guide, `inputSpatialSigma = 5`, `inputLumaSigma = 0.15`
   (`:67-82`), drawn at document size with high interpolation, then **thresholded at ≥ 128**.
5. Edge offset: `min(10, |edgeOffset|)` passes of 3×3 (8-neighbour) **erosion** for positive values or **dilation**
   for negative ones. Neighbours outside the image are ignored, so the image border never erodes a pixel
   (`:84-124`).
6. Trace with `MagicWand.outline` (3.7).
7. If smoothing is on (`smoothed`, `:128-166`), per closed loop: Douglas-Peucker with **tolerance 1.6 px** on the
   loop opened at its minimum-x (then minimum-y) vertex (`simplifyClosed`, `:168-181`; loops that would fall below 3
   points keep their original points), then **3 iterations of Chaikin** corner cutting (each edge `a→b` yields
   `0.75a + 0.25b` and `0.25a + 0.75b`, `:209-225`). The result is line segments only.
8. Combine like the wand: New mode `setSelection(..., name: "Object Selection")` without the canvas clip,
   Add/Subtract through `applySelection`.

### 3.9 Moving the outline

`Document/Selection.swift:262-290` and `Rendering/EditorCanvas.swift:2387-2402`:

```swift
/// Offsets from the drag's start, rounded to whole pixels so edges stay crisp. The
/// outline is not re-clipped, so it can leave the canvas and come back intact.
func moveSelection(by offset: CGSize) {
    guard let origin = selectionMoveOrigin else { return }
    var shift = CGAffineTransform(translationX: offset.width.rounded(), y: offset.height.rounded())
    guard let path = origin.path.copy(using: &shift) else { return }
    document?.selection = DocumentSelection(path: path, antialiased: origin.antialiased, feather: origin.feather)
}
```

- Start: a New-mode press inside the selection (3.2 row 3). `beginSelectionMove()` opens the undo step
  "Move Selection" and stores the origin. The whole drag is one step. A release without movement records no step.
- Each drag: `offset = pointer − press point` (document px). **⇧** keeps the move on the axis the drag has gone
  further along (`abs(dx) >= abs(dy)` keeps x) and that axis alone may snap. Then, unless **⌃** is held, snap
  (`snappedSelectionOffset`, `Document/Crop.swift:199-206`): the origin's bounding box moved by the rounded offset
  snaps its **left, center or right** (and top, middle, bottom) to the nearest crop target within `10 / pointsPerPixel`
  document px, each axis on its own (`TransformSnap.offset`, `Document/LayerTransform.swift:219-246`). The final
  offset is rounded again, so the outline always moves by **whole pixels**.
- The path is translated, never re-clipped: it can leave the canvas and come back intact
  (`SelectionTests.swift:174-185`). Coverage outside the canvas is cut by `SelectionClip`.
- Autoscroll runs as for the Marquee.
- **Arrow keys** with a selection tool, a non-empty selection, no draft and no ⌘⌃⌥: `nudgeSelection` by 1 px
  (10 px with ⇧), **one undo step per press**, no snapping (`Rendering/EditorCanvas.swift:2262-2267`).

### 3.10 Cursors (`Rendering/EditorCanvas.swift:241-410, 818-849`)

`lassoCursor(flags:at:)` picks, in order:

1. Dragging an outline: `moveSelectionCursor` (arrow with a dashed box).
2. Dragging pixels: `movePixelsCursor` (arrow + scissors) or `duplicateCursor` (black arrow over a white one offset
   5 pt) when duplicating.
3. Over the selection, with ⌘ held or in New mode: ⌘ → scissors (⌘⌥ → duplicate), otherwise `moveSelectionCursor`.
4. Magic tool, Wand mode: the wand cursor for the mode.
5. Otherwise the crosshair with the tool's icon and a mode badge.

| Cursor | Construction |
|---|---|
| Selection crosshair | System crosshair; a 12×12 box at hot spot + (7, 7) holds the tool icon (SF Symbols `lasso`, `rectangle.dashed`, `circle.dashed`, or the custom polygonal-lasso / object-selection drawings), black with a white outline. Add: a "+" at `(box.maxX + 5, box.midY)`, arms ±3 pt; Subtract: "−". White 3.2 pt round-capped under black 1.2 pt. Image 44×36, hot spot = crosshair's |
| Wand | 34×34 image, hot spot (7, 7) at the sparkle: stick from hot spot + (6, 6) to + (20, 20), four sparkle ticks from 2.5 to 6 pt; badge centered at hot spot + (17, 5). White outlines (stick 5 pt, marks 3.2 pt) under black (2.4 pt, 1.2 pt) |
| Move selection | System arrow + a 8×6 box at hot spot + (9.5, 13.5): white 2.5 pt stroke, then black 1 pt dashed `[2, 1.5]` |
| Load selection (⌘ over a layer thumbnail) | Pointing hand + the same box at + (11.5, 14.5) |
| Pixels (scissors) | Arrow + SF `scissors` 11×11 at hot spot + (9, 12), white halo of 12 offsets at 1.2 pt |
| Color Range | Eyedropper (hot spot (3, 21)), with a "+" or "−" badge disc at (12.5, 0.5, 11, 11) for Add and Remove |

### 3.11 Options bar (`UI/LassoControls.swift:3-161`)

Shown for every selection tool (`ContentView.swift:37-40`). Left to right, `HStack(spacing: 12)`, horizontal padding 18,
whole bar disabled while busy or without a document:

| Control | Shown for | Binding / action | Notes |
|---|---|---|---|
| Title "Marquee" / "Magic" / "Lasso" | all | — | `ToolHeaderStyle.titleFont` |
| Rectangle \| Ellipse (segmented) | Marquee | `marqueeKind` (cancels the draft) | |
| Wand \| Object (segmented) | Magic | `wandMode` (cancels the draft) | |
| Freehand \| Polygonal (segmented) | Lasso | `lassoKind` (cancels the draft) | |
| New \| Add \| Subtract (segmented) | all | shows `displayedSelectionMode`; clicking sets `selectionModeChoice` | help "Hold Shift to add or Option to subtract for one outline" |
| Tolerance, Sample Size, This Layer \| All Layers, Contiguous | Wand mode | `wandSettings` | 3.7 |
| This Layer \| All Layers, Edge | Object mode | `objectSelectionSettings` | 3.8 |
| Anti-alias (checkbox) | Lasso, Magic (both), Marquee Ellipse | `selectionAntialiased` | |
| Divider (18 pt) | all | | |
| Expand [n] px | all | `expandSelection(by: selectionExpandAmount)` | field 40 pt, 1…500, default 1, scrub 1 per point; disabled unless `canModifySelection` |
| Contract [n] px | all | `contractSelection(by: selectionContractAmount)` | same, default 1 |
| Feather [n] px | all | `featherSelection(by: selectionFeatherAmount)` | field 48 pt, 1…250, default **2**, a non-finite entry resets to 2 |
| (spacer) | | | |
| "Empty selection" (secondary text) | explicit empty selection | | |
| Deselect (button) | any non-nil selection | `deselect()` | |

The bar's Expand, Contract and Feather apply at once with the stored amounts. The Select menu's versions open a panel
(section 4.6). `canModifySelection` is `selection?.isEmpty == false && canEditSelection && lassoDraft == nil`
(`Document/Selection.swift:293`).

---

## 4. Select menu and selection commands

### 4.1 Menu (`CompositorApp.swift:255-293`) and related shortcuts

| Item | Shortcut | Enabled when | Calls | Undo name |
|---|---|---|---|---|
| All | ⌘A (never disabled: a focused text field gets `selectAll:` first) | always | `selectAll()` | "Select All" |
| Deselect | ⌘D | `selection != nil && canEditSelection` | `deselect()` | "Deselect" |
| Inverse | ⇧⌘I | same | `invertSelection()` | "Inverse" |
| Layer's Pixels | — | active layer has pixels, `canEditSelection` | `loadLayerSelection(layerID: active)` | "Load Layer Selection" |
| Subject | ⌥⌘A | `canSelectSubject` | `selectSubject()` | "Select Subject" |
| Color Range… | — | `canSelectColorRange` | `beginColorRange()` | "Color Range" (on OK) |
| Mask's Black Areas | — | active layer has a mask | `loadMaskSelection(layerID: active)` | "Load Mask Selection" |
| Expand… / Contract… / Feather… | — | `canModifySelection` | `promptSelectionAmount(.expand / .contract / .feather)` | "Expand Selection" / "Contract Selection" / "Feather Selection" |

Selection-related items elsewhere: Edit › Cut ⌘X, Copy ⌘C, Copy Merged ⇧⌘C, Paste ⌘V, Fill with Foreground Color ⌥⌫,
Fill with Background Color ⌘⌫, Clear Selection Pixels (no key; ⌫ on the canvas does it), Content-Aware Fill… ⇧⌫
(`CompositorApp.swift:204-254`); Image › Invert ⌘I (inside the selection); Layer › Transform Selection ⌘T (title
changes with `canTransformSelection`), Layer via Copy ⌘J (title "Duplicate Layer" without a selection)
(`:351-354`); command palette "Layer › Add Layer Mask from Selection" / "Add Layer Mask Hiding Selection"
(`UI/CommandPalette.swift:175-186`). All menu shortcuts are user-remappable (`configuredKeyboardShortcut`,
`UI/KeyboardShortcuts.swift:255-257`; defaults at `:95-104`).

### 4.2 Select All, Deselect, Inverse (`Document/Selection.swift:344-362`)

```swift
func selectAll() {
    guard let document else { return }
    setSelection(DocumentSelection(path: CGPath(rect: CGRect(origin: .zero, size: document.size), transform: nil)), name: "Select All")
}
func deselect() {
    guard selection != nil else { return }
    setSelection(nil, name: "Deselect")
}
func invertSelection() {
    guard let document, let current = selection else { return }
    let canvas = CGPath(rect: CGRect(origin: .zero, size: document.size), transform: nil)
    let inverse = DocumentSelection(path: canvas.subtracting(current.path, using: .winding), antialiased: current.antialiased,
                                    feather: current.feather)
    // The inverse of everything is no selection at all, as in Photoshop — not an invisible empty one that
    // quietly stops every brush.
    setSelection(inverse.isEmpty ? nil : inverse, name: "Inverse")
}
```

- Select All is always `antialiased: true, feather: 0` (the struct defaults), whatever the Anti-alias toggle says.
- Inverse keeps `antialiased` and `feather`. The inverse of everything is `nil`; the inverse of an explicit empty
  selection is the whole canvas. Inverse requires an existing selection (no-op on `nil`).
- There is **no Reselect**.

### 4.3 Load a layer or mask as a selection (`Document/MaskTracing.swift`)

| Command | Pixels read | Test | Then |
|---|---|---|---|
| ⌘-click layer thumbnail, Select › Layer's Pixels | the layer's own image at its own size, drawn into premultiplied RGBA, **mask ignored** | alpha ≥ 128 | `opaquePixels`, mapped by `pixelToDocument(layer.transform, w, h)` |
| ⌘-click mask thumbnail, Select › Mask's Black Areas | the mask image into 8-bit gray | gray **< 128** (the black, hiding parts) | `darkPixels`, mapped by `pixelToDocument(layer.maskTransform, w, h)` |

```swift
func loadMaskSelection(layerID: UUID, mode: SelectionMode = .replace) {
    guard canEditSelection, let layer = document?.layers.first(where: { $0.id == layerID }),
          let mask = layer.mask?.asset.image else { return }
    guard let traced = MaskTracing.darkPixels(in: mask) else { NSSound.beep(); return }
    var toDocument = BrushRaster.pixelToDocument(layer.maskTransform, width: mask.width, height: mask.height)
    guard let outline = traced.copy(using: &toDocument) else { return }
    applySelection(outline, mode: mode, name: "Load Mask Selection")
}
```

- `pixelToDocument` (`Document/BrushStroke.swift:110-116`) = translate(center) · rotate(radians) ·
  scale(size/pixels · flip) · translate(−pixels/2). A scaled or rotated layer gives a scaled or rotated outline,
  which `applySelection` clips to the canvas.
- Nothing passes the test: beep, no change (an all-white mask selects nothing, `SelectionTests.swift:267-281`; an
  empty layer selects nothing, `:306-309`).
- `MaskTracing.trace` (`:17-70`) is a Swift tracer that differs from `wand_trace`: it follows edges in dictionary order
  (loop order and start points are **not deterministic**), and at a corner where two loops touch it may join them. The
  winding-rule coverage is identical. A port can use the `wand_trace` port for both.
- Modes come from the thumbnail click's modifiers (2). The menu items always use New.

### 4.4 Select › Subject (`Document/SubjectRemoval.swift:114-142`)

1. `canSelectSubject = canEditSelection && document != nil && !isProjectBusy`.
2. Always reads the **live composite** of the whole document (`drawLiveComposite`), ignoring both tools' Sample
   settings.
3. Off the main thread: `SubjectRemoval.subjectMask(shown, under: nil, settings: FilterSettings())`. `FilterSettings()`
   has `backgroundQuality = .basic` (`Document/Filters.swift:120`), so `refined` returns Vision's mask unchanged
   (`:47`): `VNGenerateForegroundInstanceMaskRequest`, `generateScaledMaskForImage(forInstances: allInstances, from:)`,
   rendered as 8-bit gray at document size (`:29-38`). `GuidedMatte`, Contrast and Shift Edge only apply to Filter ›
   Remove Background in Advanced mode; Select Subject never uses them. Vision's mask is cached per image while the
   process lives (`MaskCache`).
4. No subject: `brushError` = "No foreground subject was detected in this layer. Try an image with a more distinct
   subject." Nothing ≥ 128: beep.
5. `MaskTracing.whitePixels` (gray ≥ 128), mapped by identity (mask is document-sized), then
   `applySelection(outline, mode: .replace, name: "Select Subject")`. The pixel-stepped outline is **not** smoothed
   and keeps `selectionAntialiased`.

Relation to Remove Background (Filter › Remove Background): the same Vision mask, but Remove Background writes a
**layer mask** (white subject, black background), optionally refined (Advanced: guided filter `GuidedMatte.refine`
with radius `refineEdges` = 12 by default, Contrast 25, Shift Edge 0) and, with a selection, changes the mask only
inside it (`Document/Filters.swift:997-1020`).

### 4.5 Select › Color Range… (`Document/ColorRangeSelection.swift`, `UI/ColorRangeSheet.swift`)

**Model** `ColorRangeEdit` (`:7-29`): `fuzziness: Double = 40` (range 0…200, rounded to integers when set),
`invert = false`, `sampleMode: HueSampleMode = .replace` (Sample / Add / Remove), `held` (⇧ = add, ⌥ = remove,
tracked from `flagsChanged`, `Rendering/EditorCanvas.swift:736-745`), `effectiveMode = held ?? sampleMode`,
`include` / `exclude` (flat `[r, g, b, r, g, b, …]` straight sRGB bytes), `preview` (panel image), `error`,
`image` (the sample), `original` (the selection when it opened).

**Flow**:

1. `beginColorRange()` (`:46-49`): needs `document != nil && colorRange == nil && canEditSelection`. The sample is
   always the **live composite** (`selectionSample(sampleAllLayers: true)`). Opens the floating "Color Range" panel
   (`ContentView.swift:235-240`). While it is open every canvas click (any tool, unless Space) is a color pick, and
   the cursor is the eyedropper.
2. Click (`sampleColorRange`, `:53-61`): the color is the **alpha-weighted 3×3 average** around `floor(point)`
   (`:98-112`). The 3×3 context starts transparent, so out-of-image pixels count as transparent:

   ```swift
   guard sums[3] > 0 else { return nil }
   return (0..<3).map { UInt8(min(255, (sums[$0] * 255 + sums[3] / 2) / sums[3])) }
   ```

   A click outside the image, or on a fully transparent 3×3 area, does nothing. Then: ⌥ → append to `exclude`;
   ⇧ → append to `include`; otherwise by `sampleMode`: Sample replaces (`include = [color]`, `exclude = []`), Add
   appends to `include`, Remove appends to `exclude`.
3. Every change (pick, Fuzziness, Invert) calls `updateColorRange()` (`:65-80`): with no include colors it restores
   `original`; otherwise it computes off the main thread and, if no newer change superseded it, sets
   `document.selection` **directly, without an undo step**, as the live preview, plus `edit.preview`.
4. Matching (`color_range_mask`, `Rendering/WandPixels.c:176-205`), per pixel of the sample:

   ```c
   if (px[3]) {
       int rgb[3];
       for (int c = 0; c < 3; ++c) rgb[c] = (px[c] * 255 + px[3] / 2) / px[3];
       matches = color_near(rgb, include, includeCount, fuzziness) && !color_near(rgb, exclude, excludeCount, fuzziness);
   }
   if (invert) matches = !matches;
   ```

   `color_near` = some listed color has `|Δr|, |Δg|, |Δb| <= fuzziness` (alpha ignored). Fully transparent pixels never
   match, so with **Invert they are selected**. The 0/255 mask is traced with `MagicWand.outline` (none matched →
   `path == nil` → `selection = nil`).
5. Panel preview (`:125-138`): the mask scaled to fit 292×200 points at 2× (Retina), medium interpolation, white =
   selected, on black. The sheet (`UI/ColorRangeSheet.swift`, width 340, padding 24): three eyedropper buttons (Sample,
   Add with `plus.circle.fill` badge, Remove with `minus.circle.fill`), the one a click will use highlighted with the
   accent color at 25 %; the preview box (black until a color is picked, 20 % white border); the hint "Click the
   image to pick the color to select." / "Shift-click adds a color, Option-click takes one away."; Fuzziness (label
   scrub 1 per point, slider 0…200, 48 pt field, 0 decimals); Invert toggle ("Select everything except those colors,
   such as all but a green screen"); an orange error line; Cancel (⎋) and OK (↩).
6. OK (`commitColorRange`, `:82-89`): puts `original` back, closes, then (if colors were picked and there was no error)
   `setSelection(result, name: "Color Range")`, or `deselect()` if nothing matched: **one undo step**. Cancel and
   closing the panel restore `original` with no step.

The result has `antialiased = selectionAntialiased`, feather 0, and replaces the old selection: Color Range has no
Add or Subtract against the existing selection.

### 4.6 Expand, Contract, Feather

**Panel** (`SelectionAmountSheet`, `UI/LassoControls.swift:187-245`; shown by `ContentView.swift:263-268` titled
"Expand Selection", "Contract Selection" or "Feather Selection", width 380): "Amount" label (scrub), slider
1…max step 1, 56 pt text field with "px"; max is 500 (Expand, Contract) or 250 (Feather); initial value = the stored
amount (`selectionExpandAmount` 1, `selectionContractAmount` 1, `selectionFeatherAmount` 2,
`Document/EditorSession.swift:277, 344-345`). An invalid entry shows "Enter a whole number from 1 to N px." and
disables OK. OK (↩) calls `confirmSelectionAmount`, which stores the amount (so the bar's field shows it) and applies
it (`Document/Selection.swift:305-314`). Cancel (⎋) closes. While it is open, `canEditLayers` is false.

**Expand / Contract** (`Document/Selection.swift:316-342`):

```swift
private func resizeSelection(by delta: CGFloat, name: String) {
    guard let document, let current = selection, canModifySelection, delta != 0, abs(delta) <= 500 else { return }
    // A band `|delta|` wide on each side of the outline, added or removed.
    let band = current.path.copy(strokingWithWidth: abs(delta) * 2, lineCap: .round, lineJoin: .round, miterLimit: 10)
    let result = delta > 0
        ? current.path.union(band, using: .winding)
            .intersection(CGPath(rect: CGRect(origin: .zero, size: document.size), transform: nil), using: .winding)
        : current.path.subtracting(band, using: .winding)
    setSelection(DocumentSelection(path: result, antialiased: current.antialiased, feather: current.feather), name: name)
}
```

- Geometric, not pixel morphology: the outline is offset by exactly `a` px (Minkowski sum or difference with a disc
  of radius `a`). Expand rounds convex corners (radius `a`, cubic arcs) and is clipped to the canvas. Contract rounds
  concave corners and keeps convex ones sharp; it also pulls away from the canvas edges, because the path already
  runs along them (`SelectionTests.swift:221-231`).
- Contract past the middle gives an **explicit empty** selection (then `canModifySelection` is false).
- Both keep `antialiased` and `feather`.
- Measured: expand 5 of square `(40,40,20,20)` = `M 65,40 L 65,60 C 65,62.76 62.76,65 60,65 L 40,65 C 37.24,65
  35,62.76 35,60 L 35,40 C 35,37.24 37.24,35 40,35 L 60,35 C 62.76,35 65,37.24 65,40 Z`; contracting that by 8 gives
  the square `43…57` (`M 57,57 L 43,57 L 43,43 L 57,43 Z`).

**Feather** (`Document/Selection.swift:325-331`):

```swift
let softened = (current.feather * current.feather + CGFloat(amount) * CGFloat(amount)).squareRoot()
setSelection(DocumentSelection(path: current.path, antialiased: current.antialiased,
                               feather: min(250, softened)), name: "Feather Selection")
```

Feathers stack like Gaussian blurs (2 then 2 = 2.83). Only the number changes; the path stays.

### 4.7 Not in Compositor

Reselect, Select › Modify › Border / Smooth, Grow, Similar, Transform Selection (outline only; ⌘T transforms the
**pixels**), Quick Mask, Save / Load Selection, intersect mode, fixed-ratio or fixed-size Marquee, single-row/column
Marquee, Magnetic Lasso, Refine Edge / Select and Mask. A grep of `Document/`, `UI/` and `CompositorApp.swift` finds
none of them.

---

## 5. Operations that use the selection

### 5.1 Gating

```swift
/// An explicitly empty selection leaves nothing paintable, so painting never starts.
var canPaint: Bool {
    canEditLayers && selectedLayerIDs.count == 1 && (activeLayer?.isGroup == false || isMaskSelected) && selection?.isEmpty != true
        && activeLayerID.map { document?.effectiveVisibleIDs.contains($0) == true } == true
        && (!isMaskSelected || activeLayer?.mask?.isEnabled == true)
        && (isMaskSelected || activeLayer?.adjustment == nil)
}
```

(`Document/EditorSession+Brush.swift:5-11`). With an explicit empty selection a brush press shows "Nothing is
selected, so there's nowhere to paint. Choose Select › Deselect (⌘D) to paint anywhere." (`:29-31`). Copy, Copy
Merged, Invert, filters and adjustments are also disabled by an explicit empty selection
(`selection?.isEmpty != true` in `canCopyPixels`, `canCopyMerged`, `canInvert`, `canAdjust`).

### 5.2 Painting clip

Brush, Eraser, Spot Healing, Clone Stamp, Smear (Blur, Smudge, Liquify) and the Gradient all paint through
`makeRasterEdit`, which sets `stroke.selectionClip = try selection?.clip(canvas: document.size)`
(`Document/EditorSession+Brush.swift:35-50`). The clip multiplies into the stroke's alpha (`brush.md` section 9). The
GPU canvas previews a gradient through the clip with `CIBlendWithRedMask` (`Rendering/EditorCanvas.swift:2978-2986`).
The clip is captured when the stroke begins.

### 5.3 Fill with Foreground / Background (⌥⌫ / ⌘⌫)

`Document/SelectionEdits.swift:50-63, 227-237`; `BrushStroke.fill` and `paintCanvas`, `Document/BrushStroke.swift:724-776`.

- Needs `canEditPixels` (= `canPaint`). Color: the palette color; on a mask, black or white from `maskPaintWhite`
  (`paletteColor(background:)`, `Document/ColorPalette.swift:26-29`).
- With **no selection** it fills the whole canvas area of the layer. The raster grid includes growth room to the
  canvas (`brush.md` 3.3), so a small layer grows to the canvas. An explicit empty selection is refused by `canPaint`.
- A text layer that is still text, with no selection and not the mask, takes the color as its text color instead
  (`recolorText`, `:58`).
- The fill is `context.fill(canvas)` clipped by the canvas and the selection coverage, source-over at full opacity,
  from each tile's original pixels. Soft edges blend partially.
- Masks use `growsMask: true`: "On a mask, a fill covers the whole canvas, past the mask's own area."
- One undo step, "Fill" or "Fill Mask". Committed through `commitRasterEdit` (async; layer bounds recomputed from the
  painted tiles, `Document/EditorSession+Brush.swift:190-232`).

### 5.4 Delete / Clear (⌫, Edit › Clear Selection Pixels)

```swift
func clearSelectedPixels() async {
    guard selection != nil, canEditPixels, let layer = activeLayer else { return }
    if isMaskSelected { await fillSelection(with: .background); return }
    guard layer.asset != nil else { return }
    await applyPixelEdit(to: layer, name: "Clear") { try $0.clearPixels() }
}
```

- `clearPixels` is destination-out through the coverage, only over the layer's existing pixel rect
  (`paintCanvas(withinSource: true)`). On a mask it fills the background color (white by default: reveal).
- The ⌫/⌦ key (`deleteKeyPressed`, `:76-80`): a selected effect is removed first; with any selection it calls
  `clearSelectedPixels()` (which does nothing for an explicit empty selection, because `canPaint` is false; the layer
  is **not** deleted); without one it deletes the targeted mask or the selected layers. During a lasso draft ⌫
  removes the last point instead.

### 5.5 Content-Aware Fill (⇧⌫)

- Enabled: `canAdjustColors && !isMaskSelected && selection?.isEmpty == false && filterEdit == nil && hueSaturation == nil`
  (`Document/Filters.swift:690-692`). ⇧⌫ on the canvas (`Rendering/EditorCanvas.swift:2209-2212`) and the Edit menu
  call `beginFilter(.contentAwareFill)`.
- `beginFilter` (`Document/Filters.swift:694-742`): the layer grid grows to cover the selection's bounds on the canvas
  (`growingTo: selection bbox ∩ canvas`), the clip is captured, and the full-size preview runs at once (automatic
  filters always preview). The filter panel says "Fill the selection using surrounding pixels from this layer." and
  "Limited to the selection" (`UI/FilterSheet.swift:85-86, 170-171`). OK is disabled until the preview is ready.
- Algorithm (`Document/ContentFill.swift:8-27`): the hole = the selection coverage drawn on the layer grid, **any
  nonzero coverage counts as hole**; `patch_fill` (multi-scale PatchMatch, `Rendering/PatchPixels.c`, the engine also
  used by Spot Healing's Content-Aware mode) fills it from opaque pixels outside the hole with a random seed
  (`UInt32.random`, `Document/Filters.swift:458`), so results differ between runs. Error when there is no source:
  "Not enough unselected, opaque image pixels to synthesize a fill. Use a smaller selection with some surrounding
  image."
- The filled image is then blended back through the coverage like every filter (`Document/Filters.swift:359-361`),
  so soft edges mix filled and original pixels.
- OK → `commitFilter()`: it awaits the preview task and commits the cached preview as one undo step
  "Content-Aware Fill" (`:861-990`). 16-bit layers are rasterized to 8 bits for it. Not repeatable with Last Filter.

### 5.6 Copy, Copy Merged, Cut, Paste, Layer via Copy

**Region** (`selectionCopyRegion`, `Document/SelectionClipboard.swift:27-40`): whole pixels of the selection's
`coverageBounds` (the whole canvas without a selection), with a 0.001 tolerance against boolean float noise, clipped to
the canvas:

```swift
let minX = floor(bounds.minX + tolerance), minY = floor(bounds.minY + tolerance)
let region = CGRect(x: minX, y: minY, width: ceil(bounds.maxX - tolerance) - minX,
                    height: ceil(bounds.maxY - tolerance) - minY).intersection(canvas)
```

**Copy (⌘C)** (`copySelection`, `:113-128`; `renderSelectedPixels`, `:50-72`):

- Pixels: a region-sized premultiplied RGBA image with the clip applied, then the active layer's **raw image** drawn at
  its displayed transform. **The layer's mask, opacity, blend mode and effects are not applied.** Soft selection edges
  become partial alpha. A mask target is copied as opaque gray (mask background color filled, then the mask's
  coverage).
- Stored as `pixelClipboard = (image, origin: region.origin, changeCount)` in **this session** and as PNG on the
  system pasteboard (`store`, `:131-139`).
- Without a selection, on a pixel layer, the whole-canvas region of the layer is copied as pixels **and** the layer is
  remembered as `copiedLayer`. Without a selection on a folder or adjustment layer only `copiedLayer` is set (a UUID
  string of type `com.compositor.copied-layer` on the pasteboard, no PNG).
- Nothing to copy (an empty region): beep.

**Copy Merged (⇧⌘C)** (`renderMergedPixels`, `:80-97`): the live composite of the region drawn on its own first, then
through the clip.

**Cut (⌘X)** (`:142-146`): needs a selection; Copy, then `clearSelectedPixels()`. The undo step is "Clear" (copy has no
step).

**Paste (⌘V)** (`CompositorApp.swift:223-232`, `paste()`, `Document/SelectionClipboard.swift:154-167`), first
applicable of:

1. On the New canvas screen with an image on the clipboard: a new canvas of the image's size.
2. A focused text field: text paste.
3. `workspace.pasteCopiedLayer()`: a `copiedLayer` still matching the pasteboard's change count → the layers are
   duplicated whole (same project, "Paste") or copied into this project (another tab) (`Document/ProjectWorkspace.swift:202-216`).
4. This session's `pixelClipboard` still matching the change count → **in place** at its origin.
5. Any image on the system pasteboard (other apps, **and pixels copied in another project tab**, whose
   `pixelClipboard` lives in the other session) → converted to sRGB RGBA and **centered**:
   `origin = (floor((W − w) / 2), floor((H − h) / 2))`.
6. Otherwise beep.

Pixels become a new layer through `addPixelLayer` (`:294-310`): inserted just above the active layer (inside its
folder, or into the active folder), named the lowest free "Layer N", made active, and **the selection is dropped**,
all in one undo step "Paste".

**Layer via Copy (⌘J)** (`layerViaCopy`, `:204-215`): with a non-empty selection on a pixel layer, the same rendered
pixels become a new layer in place ("Layer via Copy", drops the selection, `SelectionClipboardTests.swift:121-133`).
With no selection it duplicates every selected layer ("Duplicate Layer"). An explicit empty selection or a folder with
a selection does nothing.

### 5.7 Moving selected pixels (⌘-drag, ⌘⌥-drag, ⌘-arrows)

`PixelMove` (`Document/SelectionEdits.swift:13-42`), `beginPixelMove` … `nudgePixels` (`:164-225`), raster code in
`Document/BrushStroke.swift:778-866`, canvas handling in `Rendering/EditorCanvas.swift:2433-2441, 1907-1919, 2140-2143`.

1. **Start**: ⌘-press inside the selection with any selection tool. ⌘⌥ duplicates. Needs a non-empty selection,
   `canPaint`, **not** a mask target, and a layer with pixels; else beep (`cmdArrowNudgesPixelsAndMasksRefuse`).
2. **Lift** (`liftSelection`, `:789-813`): `lifted` = the layer's own pixels inside `clip.rect` (mapped to the layer
   grid, integral, ∩ the layer's pixel rect) multiplied by the coverage; `holed` = the layer's pixels with the
   coverage cut out (destination-out). No lifted pixels → refuse.
3. **Drag**: `offset = pointer − press` in document px, **⇧ keeps one axis** (the larger), **no snapping**, rounded to
   whole pixels (`movePixels(by:)`). The stored selection stays put; the ants are drawn from `displayedSelection`, the
   origin outline shifted by the offset (`:188-197`), so the outline never jumps back.
4. **Preview**: the GPU canvas draws `holed` (or the untouched original when duplicating) with `lifted` at
   `liftedTarget(offset)` above it, at the layer's opacity (`Rendering/EditorCanvas.swift:3021-3037`). With a layer
   mask or effects the tiles are rebuilt (`moveLifted`) and drawn like a stroke.
5. **Release** (`finishPixelMove`, `:199-212`): a zero offset changes nothing. Otherwise `moveLifted(by:duplicate:)`
   rebuilds the tiles from the original (hole by destination-out unless duplicating, then `lifted` source-over at the
   target with no interpolation for whole-pixel offsets), and `commitRasterEdit` writes the layer and the moved
   selection together: one undo step, "Move Pixels" or "Duplicate Pixels".
6. Pixels can move anywhere inside the stroke grid (layer ∪ canvas, `brush.md` 3.3). Pixels moved past it are cut off.
7. **⌘-arrows** (any tool; non-empty selection; no draft; no ⌃⌥): 1 px, 10 px with ⇧, one undo step per press, beep
   when refused (`Rendering/EditorCanvas.swift:2255-2261`).
8. Cancel: only losing focus mid-drag (`:2340`) or a render error (`:958-966`). **⎋ is not handled during the drag.**

### 5.8 Transform Selection (⌘T with a selection)

`Document/FloatingSelection.swift`:

1. `canTransformSelection`: no pending transform, `canEditPixels`, not a mask target, non-empty selection, the active
   layer has pixels (`:15-19`). ⌘T then calls `beginSelectionTransform()`, otherwise the layer transform (`:22-25`).
2. `beginSelectionTransform` (`:27-60`): render the selected pixels like Copy (16-bit layers at 16 bits), open the outer
   undo step "Transform Selection", `await clearSelectedPixels()` on the source, insert a layer "Floating Selection"
   just above the source (same parent, opacity and blend mode) at `region.origin` with the pixel size of the region,
   make it active, switch to the Move tool, and open a persistent `TransformEdit` with `floating` set. It is edited
   with the normal Move-tool transform handles (move, scale, rotate, ⌘-drag to distort, which sets
   `TransformEdit.corners`).
3. While it is open the ants follow the handles: `displayedSelection` applies
   `floatingSelectionTransform(edit)` = `pixelToDocument(original)⁻¹ · pixelToDocument(draft)`. During a distortion
   the outline shows only the affine part (quirk 9.17).
4. **Commit** (↩, a tool or layer switch, Save, any `commitTransform()`): if the draft is unchanged and undistorted, the
   document is restored exactly (no undo step, soft edges untouched). Otherwise `mergeFloatingTransform`
   (`:72-115`): a distorted floating image is first warped (`DistortWarp.warpTrimmed`); `FloatingMerge.merge`
   (`:128-173`) draws it onto the source layer's grid, **growing the layer** where it now extends past it (an unplaced
   mask grows with white, revealing); the selection is transformed with it (affine copy, or `DistortWarp.mapPath`);
   the floating layer is removed and the source made active again. One undo step.
5. **Cancel** (⎋): `document = before`, active layer restored, no step.

### 5.9 Filters, adjustments and Invert inside the selection

Every Filter-menu filter, Image › Curves, Levels, Hue/Saturation, Black & White, Color Balance, Exposure, Gradient Map,
Grain and Invert (⌘I) capture `selection?.clip(canvas:)` when they open and blend their result through it:
`PixelAdjust.blend` (`Document/PixelAdjust.swift:39-48`) = `CIBlendWithMask(adjusted, original, coverage on the layer
grid)`. Refs: `Document/Filters.swift:732, 359-361`, `Document/Levels.swift:158`, `Document/HueSaturation.swift:471`,
`Document/SelectionEdits.swift:115, 121-122`. The panels show "Limited to the selection". Adjustment **layers** ignore
the selection (`selection: nil`, `Document/LayerAdjustment.swift:169-202`). Remove Background with a selection changes
the new mask only inside it (`Document/Filters.swift:997-1020`).

### 5.10 Layer mask from the selection

`addMask(revealing:)` (`Document/LayerMask.swift:237-268`), the Layers panel's mask button (⌥-click for the hiding
variant) and the command palette: with a selection, a mask in the layer's own pixel grid, black (or white) everywhere,
then white (or black) through the clip — "Reveal Selection" / "Hide Selection". The selection is **dropped** in the
same undo step and the mask becomes the paint target. Without a selection: an all-white or all-black mask.

### 5.11 Crop to the selection

There is no Image › Crop command. Choosing the Crop tool (C) with a non-empty selection starts the crop rectangle at
`selection.path.boundingBoxOfPath.integral ∩ canvas` (`Document/EditorSession.swift:410-420`), so C then ↩ crops to
it (`commitCrop`, `Document/Crop.swift:236-248`). The crop installs a new document: the selection is gone afterwards.

### 5.12 Undo step names

"Rectangular Marquee", "Elliptical Marquee", "Lasso", "Polygonal Lasso", "Magic Wand", "Object Selection",
"Select Subject", "Color Range", "Load Layer Selection", "Load Mask Selection", "Select All", "Deselect",
"Inverse", "Expand Selection", "Contract Selection", "Feather Selection", "Move Selection", "Move Pixels",
"Duplicate Pixels", "Fill", "Fill Mask", "Clear", "Content-Aware Fill", "Paste", "Layer via Copy",
"Transform Selection", "Reveal Selection", "Hide Selection", "Invert", "Invert Mask".

---

## 6. Marching ants

`Rendering/TransformOverlay.swift:296-311`:

```swift
/// Marching ants: a white line under an animated black dash.
private func drawSelection() {
    guard let selection = session.displayedSelection, !selection.isEmpty, var transform = documentToView,
          let outline = antsOutline(for: selection.path),
          let path = outline.copy(using: &transform), let context = NSGraphicsContext.current?.cgContext else { return }
    context.saveGState()
    context.setLineWidth(1)
    context.addPath(path)
    context.setStrokeColor(NSColor.white.cgColor)
    context.strokePath()
    context.addPath(path)
    context.setLineDash(phase: antsPhase, lengths: [4, 4])
    context.setStrokeColor(NSColor.black.cgColor)
    context.strokePath()
    context.restoreGState()
}
```

- **Geometry**: the path is mapped to view points by `translate(documentRect.origin) · scale(pointsPerPixel)` and
  stroked in the overlay's flipped (y-down) view space. Line width **1 view point** (2 device pixels on Retina) at
  every zoom; default butt caps and miter joins (limit 10).
- **Look**: a solid **white** 1 pt line, then a **black** 1 pt line dashed **4 pt on, 4 pt off**, with
  `phase = antsPhase`. Exact `NSColor.white` / `NSColor.black`, fully opaque. No shadow.
- **Animation** (`Rendering/EditorCanvas.swift:2470-2486`):

  ```swift
  let active = session.selection?.isEmpty == false && window != nil
  if active, antsTimer == nil {
      let timer = Timer(timeInterval: 0.12, repeats: true) { [weak self] _ in
          // A redraw still pending skips this tick: a slow outline stutters rather than queuing redraws forever.
          guard let self, !self.transformOverlay.needsDisplay else { return }
          self.transformOverlay.antsPhase = (self.transformOverlay.antsPhase + 1).truncatingRemainder(dividingBy: 8)
          self.transformOverlay.needsDisplay = true
      }
  ```

  Phase steps 0, 1, …, 7, 0 every **120 ms** (8.33 pt/s; the pattern repeats every 0.96 s). A growing phase shifts
  the dashes toward the start of each subpath. Outer contours run clockwise on screen, so the ants crawl
  counterclockwise around them.
- **Shown** whenever `displayedSelection` is non-nil and non-empty, in every tool, including during an outline move,
  a pixel move (shifted outline) and a floating transform (outline follows the handles). **Hidden** for no selection
  and for an explicit empty selection (the options bar says "Empty selection" instead). The timer runs while
  `session.selection` is non-empty.
- Feather is not visualized (the ants sit on the hard outline). There is no tint or quick-mask overlay.
- **Level of detail** (`:100-187`): an outline with more than **20 000** path elements, at a zoom of fewer than one
  device pixel per document pixel, is drawn from a stand-in: the path filled into a mask (at no less than half
  resolution and at most about 40 megapixels), averaged down to `step` (the device-pixels-per-document-pixel scale
  rounded **up** to a power of two, at most 1), every pixel with **any** coverage kept, traced with
  `MagicWand.outline`, and mapped back by `scale(1/step)` + the region origin. Built in the background and cached per
  step. Until it is ready the previous one (or nothing) is drawn. Simpler outlines are always drawn in full.

---

## 7. The engine: running selection operations headless

### 7.1 What `engine/` already does

- `engine/build.sh` compiles `Document/`, `Rendering/` and `IO/` except `IO/UpdateDriver.swift`,
  `IO/CompositorApplicationDelegate.swift`, `IO/ProjectController.swift`, `IO/ProjectController+ExternalChanges.swift`,
  `IO/ImageFileDrop.swift`, `Document/ProjectWorkspace.swift`, `Rendering/EditorCanvas.swift`,
  `Rendering/InlineTextEditor.swift`, plus 8 model-only UI files. So every `EditorSession` selection method in
  section 3-5 is available. **Not** available: `EditorCanvas` (all mouse and key logic, cursors, the ants timer),
  `ProjectWorkspace` (`pasteCopiedLayer`, cross-project layer copies), `UI/LassoControls.swift`
  (`SelectionAmountSheet`) and `UI/ColorRangeSheet.swift`. `Rendering/TransformOverlay.swift` compiles but its ants
  code is private and view-bound.
- `engine/Sources/EngineMain.swift:60-77` builds a session: `ProjectStore.shared.load`, `installProject`, then
  `activeLayerID` and `selectedLayerIDs = [id]`, then `document?.selection = try selection(from: args["selection"])`
  when the key is present. `engine/Sources/Paths.swift` converts `DocumentSelection` to and from JSON (section 8.1).
- The extension flushes unsaved board strokes before every engine call and pushes what the engine saved back as one
  board undo step (`vscode-extension/extension.js:231-258`).

### 7.2 Session set-up each request needs

Set in this order (the `activeLayerID` setter resets `isMaskSelected` and `selectedLayerIDs`,
`Document/EditorSession.swift:641-646`):

1. `activeLayerID`, then `selectedLayerIDs` (already done).
2. `isMaskSelected` (**missing from `session()`**): needed for fills, clears, copies and pixel moves on masks.
3. `document?.selection` from the board (already done). Set it directly; `setSelection` would skip unchanged values and
   needs `canEditSelection`.
4. Tool settings the operation reads: `selectionAntialiased`, `wandSettings`, `objectSelectionSettings`,
   `foregroundColor` / `backgroundColor` / `maskPaintWhite`, `filterSettings`.
5. Do **not** set `tool` unless the operation needs it (`beginLasso` needs a selection tool other than `.wand`;
   `selectTool(.crop)` creates the crop rectangle).

Every answer should return `selectionJSON(session.document?.selection)` (the selection is never saved, and many
operations drop or move it), `activeLayerID`, and `saved: true` when the project was written. Clear
`session.brushError` before the call and report it after: it is how upstream surfaces failures. `NSSound.beep()`
marks "nothing happened" silently; compare the before/after state to detect it.

### 7.3 Operation table

"Sync" means the method returns with the result in place. "Async" methods are `async` and complete when the `await`
returns, except where noted.

| Operation | EditorSession call(s) | Preconditions | Sync / async, completion | Result lands in |
|---|---|---|---|---|
| Set selection from the board | `document?.selection = DocumentSelection(path:antialiased:feather:)` | none | sync | `document.selection` |
| Combine a shape (Marquee, Lasso, loaded outline) | `applySelection(shape, mode:, name:)` | `canEditSelection`; Subtract needs a current selection (else no-op) | sync | `document.selection` (`antialiased = selectionAntialiased`, feather 0) |
| Same through the draft API | `selectTool(.marquee / .lasso)`, set `marqueeKind` / `lassoKind`, `beginLasso(at:mode:)`, `dragMarquee(to:square:fromCenter:)` or `extendLasso(to:)`…, `finishLasso()` | tool is a selection tool, not `.wand` | sync | same, plus the click-deselect rule |
| Select All / Deselect / Inverse | `selectAll()`, `deselect()`, `invertSelection()` | `canEditSelection`; Inverse needs a selection | sync | `document.selection` |
| Expand / Contract / Feather | `expandSelection(by:)`, `contractSelection(by:)`, `featherSelection(by:)` | `canModifySelection` (non-empty, no draft); 1…500 (feather > 0, capped at 250) | sync | `document.selection` |
| Move / nudge outline | `beginSelectionMove()`, `moveSelection(by:)`, `endSelectionMove()`; or `nudgeSelection(dx:dy:)` | non-empty selection | sync | `document.selection` |
| Magic Wand | set `wandSettings`, `selectionAntialiased`; `await magicWand(at:mode:)` | point inside the canvas; not busy; `This Layer` reads the active layer | **async**, CPU; returns when done | `document.selection`; errors in `brushError` |
| Object Selection | set `objectSelectionSettings`, `selectionAntialiased`; `await selectObject(at:mode:)` | macOS 14+; as above | **async**, Vision; returns when done | `document.selection`; `brushError` |
| Select Subject | `await selectSubject(mode:)` | `canSelectSubject` | **async**, Vision | `document.selection`; `brushError` "No foreground subject…" |
| Load layer pixels / mask | `loadLayerSelection(layerID:mode:)`, `loadMaskSelection(layerID:mode:)` | layer with pixels (not a folder) / with a mask | sync | `document.selection`; beep when nothing qualifies |
| Color Range | `beginColorRange()`; `sampleColorRange(at:shift:option:)` per pick; `colorRange?.fuzziness`, `.invert`; `updateColorRange()`; wait; `commitColorRange()` | `canSelectColorRange` | `updateColorRange` starts an **unstructured `Task`**, not awaitable: poll (yielding the main actor) until `document.selection`, `colorRange.preview` or `colorRange.error` changes, or use the helper in 7.5 | `document.selection` |
| Fill FG / BG | set colors (or `maskPaintWhite`) and `isMaskSelected`; `await fillSelection(with: .foreground / .background)` | `canPaint` | **async** (`commitRasterEdit`) | layer pixels or mask, one step; layer may grow to the canvas |
| Clear | `await clearSelectedPixels()` | `selection != nil`, `canPaint` | **async** | layer pixels (or mask filled with background) |
| Content-Aware Fill | `beginFilter(.contentAwareFill)`, then `await commitFilter()` | `canContentAwareFill` | `beginFilter` is sync and starts the preview `Task`; `commitFilter` **awaits** it for automatic filters | layer pixels, grown to the selection on the canvas; `brushError` on failure; nondeterministic seed |
| Copy / Copy Merged | `renderSelectedPixels(from: activeLayer, mask: isMaskSelected)` / `renderMergedPixels()` → write PNG + `region.origin` | `canCopyPixels` / `canCopyMerged` | sync (throws) | a file; document unchanged. **Do not call `copySelection()`**: it writes `NSPasteboard.general` (7.4) |
| Cut | render as Copy, then `await clearSelectedPixels()` | `selection != nil`, `canCopyPixels` | async | file + layer pixels |
| Paste (pixels from the board's clipboard) | `addPixelLayer(image, at: origin, name: nextLayerName(), editName: "Paste")` | `canEditLayers` | sync | new active layer above the active one; **selection dropped** |
| Layer via Copy | `layerViaCopy()` | `canEditLayers`, selection not explicitly empty | sync (no pasteboard) | new layer (selection dropped), or duplicated layers without a selection |
| Move / duplicate pixels | `beginPixelMove(duplicate:)` → `movePixels(by:)` → `await finishPixelMove()`; or `await nudgePixels(dx:dy:)` | non-empty selection, `canPaint`, not a mask, layer has pixels; `beginPixelMove` returns false otherwise | begin sync, finish **async** | layer pixels + `document.selection` moved, one step |
| Transform selected pixels | `await beginSelectionTransform()` → `previewTransform(draft)` (and `transformEdit?.corners = [4 points]` for a distortion) → `commitTransform()` or `cancelTransform()` | `canTransformSelection` | begin **async** (awaits the clear), commit/cancel sync | source layer pixels (grown), `document.selection` transformed, floating layer removed |
| Mask from selection | `addMask(revealing:)` | `canEditMask`, layer has no mask | sync | layer mask; selection dropped; `isMaskSelected = true` |
| Invert inside selection | `await invertPixels()` | `canInvert` | async | layer pixels or mask |
| Filter / adjustment inside selection | `beginFilter(kind)`, `updateFilter(settings, preview: false)`, `await commitFilter()`; Levels and Hue/Saturation have their own begin/commit | `canAdjustColors` (or `canVignette`) | async | layer pixels, blended through the coverage |
| Crop to selection | `selectTool(.crop)` (sets `cropRect` from the selection) → `await commitCrop()` | `canStartProjectOperation` | async | new document; selection gone |
| Paint inside selection | brush API (`brush.md`) | as `canPaint` | as there | `selectionClip` is captured by `makeRasterEdit` |

### 7.4 Things that cannot run headless as upstream wrote them

| Upstream piece | Where | Why | What the engine needs instead |
|---|---|---|---|
| Press/drag/release logic, click-to-deselect, wand reselect on click, polygon closing, ⇧ armed square, snapping calls, autoscroll, keys | `Rendering/EditorCanvas.swift` (excluded) | NSView event code | The board implements it (section 8.2) and sends finished outlines or explicit operations |
| Ants, draft overlay, cursors | `Rendering/TransformOverlay.swift`, `EditorCanvas.swift` | drawing and NSCursor | The board draws them |
| Options bar, Expand/Contract/Feather panel, Color Range panel | `UI/LassoControls.swift`, `UI/ColorRangeSheet.swift` (not compiled) | SwiftUI | Board UI; engine gets numbers |
| ⌘-click thumbnail mode | `UI/NativeLayerList.swift:1145-1149` reads `NSApp.currentEvent` | AppKit event | Pass `mode` explicitly to `loadLayerSelection` / `loadMaskSelection` |
| Copy / Cut / Paste | `EditorSession.pasteboard` is `NSPasteboard.general` unless `XCTestConfigurationFilePath` is set (`Document/SelectionClipboard.swift:22-25`) | a headless engine would overwrite the user's real clipboard and race the board | Use `renderSelectedPixels` / `renderMergedPixels` / `addPixelLayer`; the board owns the clipboard (DOM `copy`/`paste` events, `ui.md` 12.2) |
| Paste of copied layers, cross-project copies | `ProjectWorkspace.pasteCopiedLayer` (excluded) | multi-tab workspace | Board-level: `duplicateLayers(ids, editName: "Paste")` within one project; cross-project needs both projects |
| `deleteKeyPressed()`, `transformCommand()`, wand/object clicks from the canvas | spawn `Task { … }` | not awaitable | Call `clearSelectedPixels()`, `beginSelectionTransform()`, `magicWand(at:mode:)` directly and `await` them |
| `updateColorRange()` | unstructured `Task` | not awaitable | Helper in 7.5 or polling |
| `NSSound.beep()` | many | harmless, but is the only signal of "nothing happened" | Compare state before and after |
| `transformEdit.corners` (distortion) | set by `EditorCanvas` ⌘-dragging a handle | UI | Set the four document-space corners directly before `commitTransform()` |

### 7.5 Suggested engine operations

Names are suggestions. Each takes the usual `project`, `activeLayerID`, `selection`, plus `isMaskSelected`.

- `selection.combine {size, selection, shape, mode, antialiased}`: geometry only. It does not need the project or a
  flush. Run the exact calls of `applySelection` (`intersection(canvas)`, `union` / `subtracting`, `.winding`) and
  return the path. Same for `selection.invert`, `selection.expand {amount}`, `selection.contract {amount}`. These are
  the operations the board cannot reproduce exactly without CGPath booleans; keeping them stateless keeps them fast.
- `selection.wand {point, mode, tolerance, sampleSize, contiguous, sampleAllLayers, antialiased}`,
  `selection.object {point, mode, edgeOffset, sampleAllLayers, antialiased}`, `selection.subject {mode}`: load the
  project (pixels needed), `await` the session method, return the selection.
- `selection.colorRange {include, exclude, fuzziness, invert, antialiased}`: build `selectionSample(document,
  sampleAllLayers: true)`, run `color_range_mask` and `MagicWand.outline` exactly as `colorRangeResult` does
  (`Document/ColorRangeSelection.swift:114-122, 140-156`; both are internal or C and callable), and return the path.
  The 3×3 eyedropper average (`:98-112`, private) is easy to repeat in the board.
- `selection.loadLayer {layerID, mode}`, `selection.loadMask {layerID, mode}`.
- Pixel operations: `selection.fill {source}`, `selection.clear`, `selection.contentAwareFill`,
  `selection.copy {merged, out}` (PNG + origin), `selection.cut {out}`, `selection.paste {png, origin}`,
  `selection.layerViaCopy`, `selection.movePixels {dx, dy, duplicate}`, `selection.transform {draft, corners?}`,
  `selection.addMask {revealing}`, `selection.crop`. Each saves with `ProjectStore.shared.save` and returns the new
  selection.
- Large outlines: a wand outline can have up to 8 000 000 edges. As nested JSON arrays that is hundreds of MB. Pass
  the path through a temporary file (the engine client already moves images as files), or use a compact form such as
  an SVG path string (section 8.1).

---

## 8. Porting notes for the JS board

### 8.1 Exchanging selections

Keep the format `engine/Sources/Paths.swift` already implements:

```json
null                                                            // no selection
{ "path": [], "antialiased": true, "feather": 0 }               // explicit empty selection
{ "path": [["M",10,10],["L",50,10],["L",50,50],["L",10,50],["Z"]], "antialiased": true, "feather": 0 }
```

- Elements: `["M", x, y]`, `["L", x, y]`, `["Q", cx, cy, x, y]`, `["C", c1x, c1y, c2x, c2y, x, y]`, `["Z"]`, in
  document pixels, y down, doubles. Booleans keep cubic curves (1.2), so `C` must be supported; `Q` never comes from
  upstream code but is cheap to keep.
- Numbers: JSON doubles round-trip exactly with `JSONSerialization` and JS `JSON.stringify`. Keep the 1e-7 noise; do
  not round paths in the board.
- `null` and `path: []` must stay distinct (`selection(from:)` maps JSON `null` to `nil` and `[]` to an empty
  path).
- An optional compact form for large outlines: `"d": "M0 0L3 0L3 3L0 3ZM1 1L1 2L2 2L2 1Z"` (SVG path data). Canvas
  accepts it directly as `new Path2D(d)`.

```js
function toPath2D(elements) {
    const p = new Path2D();
    for (const e of elements) {
        switch (e[0]) {
            case 'M': p.moveTo(e[1], e[2]); break;
            case 'L': p.lineTo(e[1], e[2]); break;
            case 'Q': p.quadraticCurveTo(e[1], e[2], e[3], e[4]); break;
            case 'C': p.bezierCurveTo(e[1], e[2], e[3], e[4], e[5], e[6]); break;
            case 'Z': p.closePath(); break;
        }
    }
    return p;
}

// CGPath.boundingBoxOfPath: tight bounds of the curve (curve extrema, not control points).
function pathBounds(elements) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0, sx = 0, sy = 0;
    const add = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    const cubicExtrema = (p0, p1, p2, p3, out) => {          // roots of the derivative in (0, 1)
        const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
        if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b); return; }
        const d = b * b - 4 * a * c; if (d < 0) return;
        const s = Math.sqrt(d); out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    };
    const at = (p0, p1, p2, p3, t) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
    for (const e of elements) {
        if (e[0] === 'M') { cx = sx = e[1]; cy = sy = e[2]; add(cx, cy); }
        else if (e[0] === 'L') { cx = e[1]; cy = e[2]; add(cx, cy); }
        else if (e[0] === 'Z') { cx = sx; cy = sy; }
        else {
            const [x1, y1, x2, y2, x3, y3] = e[0] === 'C' ? e.slice(1)
                : [cx + 2 / 3 * (e[1] - cx), cy + 2 / 3 * (e[2] - cy), e[3] + 2 / 3 * (e[1] - e[3]), e[4] + 2 / 3 * (e[2] - e[4]), e[3], e[4]];
            const ts = []; cubicExtrema(cx, x1, x2, x3, ts); for (const t of ts) if (t > 0 && t < 1) add(at(cx, x1, x2, x3, t), cy);
            const us = []; cubicExtrema(cy, y1, y2, y3, us); for (const t of us) if (t > 0 && t < 1) add(cx, at(cy, y1, y2, y3, t));
            cx = x3; cy = y3; add(cx, cy);
        }
    }
    return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
// The x-extrema pass pairs each extreme x with the start point's y (and the y pass the reverse). That point is
// already inside the bounds, so only the extreme coordinate can widen them.
const isEmptySelection = (sel) => { const b = pathBounds(sel.path); return !b || b.w <= 0 || b.h <= 0; };
```

### 8.2 What the board reproduces and what it delegates

| Piece | Board (JS) | Engine |
|---|---|---|
| Tool state machine (3.2), modifiers (2), ⇧-armed square, Marquee snapping and rounding (3.3), freehand sampling (3.4), polygon rules (3.5), outline move with snapping (3.9), nudges, autoscroll, cursors (3.10), options bar (3.11), key handling | **yes**, exact | — |
| Draft overlay (3.6), marching ants (6) | **yes** | — |
| Outline move and nudge (integer translation), Select All, Deselect, Feather (a number) | **yes**, exact (translation of doubles by integers is exact) | optional |
| Booleans: New/Add/Subtract against the canvas and the current selection, Inverse, Expand, Contract | optimistic preview only (8.4) | **authoritative**, `selection.combine` etc. |
| Coverage for painting, fill/clear previews, pixel-move preview (8.3) | **yes** | the committed pixels |
| Magic Wand, Color Range, Load Layer/Mask (pure integer arithmetic on pixels) | can be exact ports (8.6, 8.7) if the board's composite matches; otherwise delegate | `selection.wand`, `selection.colorRange`, `selection.loadLayer/Mask` |
| Object Selection, Select Subject (Vision), Content-Aware Fill (PatchMatch, random seed) | — | **engine only** |
| Fill, Clear, Cut, Paste, Layer via Copy, Move Pixels commit, Transform Selection merge, mask from selection, filters inside the selection, crop | preview only | **engine** (pixel results and layer bookkeeping) |
| Clipboard | **board** (DOM clipboard; PNG + origin; in-place paste when the board copied it, centered otherwise) | renders / inserts pixels |

Recommended flow for an outline tool: draw the draft in JS; on release apply the click-deselect rule (3.3) locally;
otherwise show the optimistic result at once (8.4) and send `selection.combine` to the engine; replace the board's
selection with the engine's answer when it arrives (usually within a few milliseconds). Keep the JS undo entry, and
attach the engine's path to it.

### 8.3 Coverage in Canvas 2D

```js
// SelectionClip: { rect: {x, y, w, h}, cov: Uint8Array | null }   (cov is rect.w × rect.h, row-major, 255 = selected)
function selectionClip(sel, W, H) {
    const b = pathBounds(sel.path);
    if (!b || b.w <= 0 || b.h <= 0) return { rect: { x: 0, y: 0, w: 0, h: 0 }, cov: null };      // clips everything
    const grow = Math.ceil(sel.feather * 2) + 1;
    let x0 = Math.floor(b.x - grow), y0 = Math.floor(b.y - grow);
    let x1 = Math.ceil(b.x + b.w + grow), y1 = Math.ceil(b.y + b.h + grow);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    if (x1 - x0 < 1 || y1 - y0 < 1) return { rect: { x: 0, y: 0, w: 0, h: 0 }, cov: null };
    const w = x1 - x0, h = y1 - y0;
    const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, -x0, -y0);
    ctx.fillStyle = '#fff';
    ctx.fill(toPath2D(sel.path), 'nonzero');                      // Canvas always antialiases paths
    const rgba = ctx.getImageData(0, 0, w, h).data;
    let cov = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) cov[i] = rgba[i * 4 + 3];      // alpha = area coverage
    if (!sel.antialiased && sel.feather <= 0) {
        for (let i = 0; i < cov.length; i++) cov[i] = cov[i] > 0 ? 255 : 0;      // CG's conservative aliased fill
    }
    if (sel.feather > 0) cov = gaussian(cov, w, h, sel.feather / 2);
    return { rect: { x: x0, y: y0, w, h }, cov };
}

// CIGaussianBlur on clampedToExtent(): separable, edge pixels repeat outward; weights integrate the Gaussian over
// each pixel (this matches the measured values; point-sampled weights come out up to ~2/255 lower at the edge).
function gaussian(src, w, h, sigma) {
    const R = Math.max(1, Math.ceil(3 * sigma));
    const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
    const k = new Float64Array(2 * R + 1);
    let sum = 0;
    for (let i = -R; i <= R; i++) { k[i + R] = Phi((i + 0.5) / sigma) - Phi((i - 0.5) / sigma); sum += k[i + R]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = 0;
        for (let i = -R; i <= R; i++) v += k[i + R] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
        tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = 0;
        for (let i = -R; i <= R; i++) v += k[i + R] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
        out[y * w + x] = Math.min(255, Math.max(0, Math.round(v)));
    }
    return out;
}
function erf(x) {   // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
}
```

Notes:

- **Do not use `ctx.filter = 'blur()'`** for feathering: it fades into transparency at the region edge instead of
  clamping, and its kernel is not specified.
- The aliased rule thresholds the browser's AA coverage at `> 0`. Skia's analytic AA is close to exact area coverage,
  but a pixel with a sliver below 1/255 may come out 0 where CG paints it. For polygons, exact area coverage by scanline
  integration is the faithful option. Pixel-aligned outlines (rectangles, traced outlines) are exact either way.
- Using the clip on a layer grid (filters, brush): for a grid pixel, map its center to document space with the layer's
  `pixelToDocument`, then sample `cov` at `(docX − rect.x, docY − rect.y)`. Use the pixel itself for 1:1 unrotated
  grids, bilinear otherwise (CG interpolates the clip mask; exact only for 1:1, `brush.md` 17.7). 0 outside `rect`;
  `cov == null` means 0 everywhere; no selection means 1 everywhere.
- Hit test for "inside the selection" (3.2, 3.10): `ctx.isPointInPath(path2d, x, y, 'nonzero')` with an identity
  transform and document coordinates, or a point-in-polygon test with flattened curves.

### 8.4 Booleans in the board

Upstream's results are CGPath booleans with curves kept (1.2). The board has two choices for its optimistic result:

1. **Raster preview** (simplest, no geometry library): keep a document-size coverage canvas. New: clear, fill the
   shape ∩ canvas. Add: fill the shape over it (`source-over`). Subtract: fill the shape with `destination-out`. The
   coverage this gives differs from CG's only along antialiased edges where shapes overlap within a pixel. Draw the
   ants from the outlines involved until the engine's path arrives (or from a trace of the coverage at > 0, as the ants'
   level-of-detail code does).
2. **Polygon booleans** with a nonzero fill rule, for example Clipper2's JavaScript port: flatten curves to a tolerance
   of 0.05 px or finer, `Union`/`Difference` with `FillRule.NonZero`, `Intersect` with the canvas rectangle; Expand and
   Contract are `InflatePaths(delta = ±a, JoinType.Round, EndType.Polygon)`, which is the same Minkowski operation as
   CG's round-joined stroke band. Results are polygons: the outline differs from CG's cubics by less than the
   flattening tolerance, and element structure and start points differ.

Either way the engine's answer replaces the board's. Inverse can be done exactly in JS without a library on a
normalized path: append the canvas rectangle (clockwise) and every subpath of the selection reversed; filled with
nonzero this is `canvas − S`. Detect "S covers the whole canvas" (the inverse is then `null`) by its area.

### 8.5 Marching ants in Canvas 2D

```js
// view: { originX, originY, ppp } — the document's top-left in CSS px and CSS px per document px (ui.md: CSS px are
// Compositor's view points). The overlay context is already scaled by devicePixelRatio.
function drawAnts(ctx, docPath, view, phase) {
    const p = new Path2D();
    p.addPath(docPath, new DOMMatrix([view.ppp, 0, 0, view.ppp, view.originX, view.originY]));
    ctx.save();
    ctx.lineWidth = 1; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
    ctx.setLineDash([]); ctx.strokeStyle = '#ffffff'; ctx.stroke(p);
    ctx.setLineDash([4, 4]); ctx.lineDashOffset = phase; ctx.strokeStyle = '#000000'; ctx.stroke(p);
    ctx.restore();
}
// Every 120 ms: if the previous frame has been drawn, phase = (phase + 1) % 8 and request a redraw.
```

- Transform the **path**, not the context, so the 1 px width and the 4/4 dash stay in screen units at every zoom.
  `lineDashOffset` has the same meaning as CG's dash `phase`.
- Run the timer only while the stored selection is non-empty, and draw from the displayed selection (shifted during a
  pixel move, transformed during a floating transform).
- Draft: `ctx.strokeStyle = 'rgba(0,0,0,0.8)'; lineWidth = 2` then white `lineWidth = 1`, no dash; freehand and
  polygonal open, rectangle closed; polygonal first-corner handle: 8×8 CSS px white square with a black 1 px stroke,
  centered on the first corner (a 1 px stroke straddles the square's edge, as in CG).
- For outlines above 20 000 elements at zoom < 1 device px per document px, mirror the level-of-detail scheme of
  section 6, using the trace port of 8.6.

### 8.6 Magic Wand and tracing in JS

Input must be **premultiplied** 8-bit RGBA, as CG stores it. `getImageData` returns straight alpha: convert with
`p = Math.round(c * a / 255)` (for `a = 255` nothing changes; `a = 0` gives zeros). The sample is the board's
composite at document size (All Layers) or the active layer's own pixels placed by its transform, with no mask,
opacity or effects (This Layer).

```js
function wandMask(px, W, H, seedX, seedY, radius, tol, contiguous) {     // px: premultiplied RGBA Uint8Array
    const mask = new Uint8Array(W * H);
    if (seedX < 0 || seedY < 0 || seedX >= W || seedY >= H) return { mask, count: 0 };
    const x0 = Math.max(0, seedX - radius), x1 = Math.min(W - 1, seedX + radius);
    const y0 = Math.max(0, seedY - radius), y1 = Math.min(H - 1, seedY + radius);
    const sums = [0, 0, 0, 0]; let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++, n++) for (let c = 0; c < 4; c++) sums[c] += px[(y * W + x) * 4 + c];
    const ref = sums.map((s) => Math.floor((s + Math.floor(n / 2)) / n));
    const match = (i) => { for (let c = 0; c < 4; c++) { const d = px[i * 4 + c] - ref[c]; if (d < -tol || d > tol) return false; } return true; };
    let count = 0;
    if (!contiguous) { for (let i = 0; i < W * H; i++) if (match(i)) { mask[i] = 255; count++; } return { mask, count }; }
    const stack = [seedX, seedY];
    while (stack.length) {
        const y = stack.pop(), x = stack.pop(), row = y * W;
        if (mask[row + x] || !match(row + x)) continue;
        let l = x, r = x;
        while (l > 0 && !mask[row + l - 1] && match(row + l - 1)) l--;
        while (r + 1 < W && !mask[row + r + 1] && match(row + r + 1)) r++;
        mask.fill(255, row + l, row + r + 1); count += r - l + 1;
        for (const ny of [y - 1, y + 1]) {                 // above first, then below, as the C does
            if (ny < 0 || ny >= H) continue;
            let inRun = false;
            for (let nx = l; nx <= r; nx++) {
                const cand = !mask[ny * W + nx] && match(ny * W + nx);
                if (cand && !inRun) stack.push(nx, ny);
                inRun = cand;
            }
        }
    }
    return { mask, count };
}

const EAST = 1, SOUTH = 2, WEST = 4, NORTH = 8;
const turnRight = (d) => (d === NORTH ? EAST : d << 1), turnLeft = (d) => (d === EAST ? NORTH : d >> 1);
function wandTrace(mask, W, H) {                         // → array of loops, each [x0, y0, x1, y1, …] corners
    const S = W + 1, out = new Uint8Array(S * (H + 1));
    let edges = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!mask[y * W + x]) continue;
            if (y === 0 || !mask[(y - 1) * W + x]) { out[y * S + x] |= EAST; edges++; }
            if (x + 1 === W || !mask[y * W + x + 1]) { out[y * S + x + 1] |= SOUTH; edges++; }
            if (y + 1 === H || !mask[(y + 1) * W + x]) { out[(y + 1) * S + x + 1] |= WEST; edges++; }
            if (x === 0 || !mask[y * W + x - 1]) { out[(y + 1) * S + x] |= NORTH; edges++; }
        }
        if (edges > 8000000) throw new Error('That selection is too detailed to outline. Try a different Tolerance, or turn on Contiguous.');
    }
    const loops = [];
    for (let start = 0; start < out.length; start++) {
        while (out[start]) {
            const pts = []; let v = start, heading = 0, initial = 0;
            do {
                const bits = out[v]; let d;
                if (!heading) d = bits & -bits;
                else if (bits & turnRight(heading)) d = turnRight(heading);
                else if (bits & heading) d = heading;
                else if (bits & turnLeft(heading)) d = turnLeft(heading);
                else d = bits & -bits;
                if (!d) break;
                out[v] &= ~d;
                if (d !== heading) pts.push(v % S, Math.floor(v / S));
                if (!heading) initial = d;
                heading = d;
                v = d === EAST ? v + 1 : d === WEST ? v - 1 : d === SOUTH ? v + S : v - S;
            } while (v !== start);
            if (heading === initial && pts.length) pts.splice(0, 2);        // start was not a corner
            loops.push(pts);
        }
    }
    return loops;      // path: for each loop, M first corner, L the rest, Z
}
```

Combining: New mode sets the traced path directly (no canvas clip); Add and Subtract go through the booleans (8.4).
Nothing matched: New deselects.

### 8.7 Color Range in JS

Eyedropper: sum the 3×3 premultiplied pixels around `floor(point)`, out-of-image pixels as zeros; `null` if the alpha
sum is 0; else `straight[c] = min(255, floor((sum[c] * 255 + floor(sumA / 2)) / sumA))`. Per pixel: skip `a == 0`
(no match); `rgb[c] = floor((p[c] * 255 + floor(a / 2)) / a)`; match = near some include color and no exclude color
(every channel within `round(fuzziness)`); invert flips, so transparent pixels become selected. Trace with 8.6. The
live preview sets the board's selection without an undo entry; OK records one ("Color Range"), Cancel restores. The
panel preview is the mask scaled into 292×200 CSS px (draw at 2× for sharpness).

### 8.8 Pixel-move preview

From the layer's own pixels and the clip mapped into its grid: `lifted = layer × cov`, `holed = layer × (1 − cov)`
(both premultiplied). Draw `holed` (or the unchanged layer when duplicating) through the layer's transform, then
`lifted` at the integer document offset carried into the grid (`liftedTarget`, `Document/BrushStroke.swift:816-822`),
at the layer's opacity and blend mode; recomposite fully if the layer has a mask or effects. Commit through the engine
(`selection.movePixels`) with the original selection; the engine returns the moved one.

### 8.9 Keys in VS Code

Add to `ui.md` 12.2 when selections ship: ⌘A and ⌘D (consume; `editor.action.selectAll` is editor-scoped), ⇧⌘I, ⌥⌘A,
⌘J (Layer via Copy; **high** clash, Toggle Panel), ⌘T, ⌘X / ⌘C / ⇧⌘C / ⌘V (use DOM `copy`/`paste` events), ⌥⌫ /
⌘⌫ / ⇧⌫ (check, as text-editing chords in some webview contexts), ⌘-arrows. Plain keys: M, L, W, Tab, ↩, ⎋, ⌫, arrows.
Suppress them while an input has focus. Track ⇧ and ⌥ on every key and pointer event (the options bar and the cursor
badge follow held modifiers live, 2).

### 8.10 Test vectors

**Coverage, antialiased (measured, 12-px rows):**

- Rect `(2.25, 2.5, 5.5, 4)`: rows 2 and 6 = `0 0 95 127 127 127 127 95 0 0 0 0`; row 3 = `0 0 191 255 255 255 255 191 0 0 0 0`.
- Ellipse in `(1, 1, 10, 8)`:
  ```
  row 1: 0   0   6 112 203 245 245 203 112   6   0 0
  row 2: 0  16 203 255 255 255 255 255 255 203  16 0
  row 3: 0 153 255 255 255 255 255 255 255 255 153 0
  row 4: 0 238 255 255 255 255 255 255 255 255 238 0     (rows 5-8 mirror rows 4-1)
  ```
- Triangle `(0,0) (10,0) (0,10)`: row r = 255 for x < 9 − r, **128** at x = 9 − r, 0 after.
- Aliased versions: rect rows 2-6 all `0 0 255 255 255 255 255 255 0 …`; ellipse row 1 = `0 0 255×8 0 0`, rows 2-7
  `0 255×10 0`; triangle row r = 255 for x ≤ 9 − r (section 1.3 for the rule).

**Feather (measured, `CIGaussianBlur`):**

- Rect `(20, 0, 20, 20)`, feather 6 (σ 3), 60×20 canvas, row 10, x = 0…59:
  `0×12, 1 4 9 17 31 51 79 110 144 176 204 224 238 246 251 254, 255×4, 254 251 246 238 224 204 176 144 110 79 51 31 17 9 4 1, 0×12`.
- Same rect, feather 2 (σ 1): `0×17, 2 17 79 176 238 253, 255×14, 253 238 176 79 17 2, 0×17`.
- Rect `(0, 0, 30, 20)`, feather 4 (σ 2), touching the canvas: rows 0 and 10 identical,
  `255×24, 254 252 245 228 197 153 102 58 27 10 3 1, 0×24`: no fade at the canvas edges.
- The integrated-Gaussian kernel of 8.3 reproduces these to ±1 (for example x = 19 at σ 3: 110.6 vs 110; x = 18:
  78.7 vs 79).

**Booleans (measured):** section 1.2 table; expand 5 / contract 8 in 4.6; Select All contracted by 10 =
`M 90,90 L 10,90 L 10,10 L 90,10 Z`; contracted by 45 more → empty.

**Tracing (measured with upstream `WandPixels.c`):**

| Mask | Loops (corners) |
|---|---|
| 1×1 `[1]` | `(0,0) (1,0) (1,1) (0,1)` |
| 3×3 ring (center 0) | `(0,0) (3,0) (3,3) (0,3)`; hole `(1,1) (1,2) (2,2) (2,1)` |
| 8×6: 3×3 ring at the corner + pixels (5,4) and (6,5) | the two ring loops, then `(5,4) (6,4) (6,5) (5,5)`, then `(6,5) (7,5) (7,6) (6,6)`: diagonal neighbours stay separate loops |
| 2×2 checker `[1,0 / 0,1]` | `(0,0) (1,0) (1,1) (0,1)`; `(1,1) (2,1) (2,2) (1,2)` |
| 4×3 `[0110 / 1111 / 0100]` | one loop `(1,0) (3,0) (3,1) (4,1) (4,2) (2,2) (2,3) (1,3) (1,2) (0,2) (0,1) (1,1)` |

As a path string: the 3×3 ring is `M0 0L3 0L3 3L0 3ZM1 1L1 2L2 2L2 1Z`.

**Wand matching (measured, and upstream tests):**

- 10×4 stripes red | blue | red (x < 3 or x ≥ 6 red), seed (1, 2), tolerance 32: contiguous selects 12 pixels (the left
  band), global selects 28 (both red bands) (`MagicWandTests.swift:43-56`).
- One row `[100,100,100,255] [132,100,100,255] [133,100,100,255] [100,100,100,222]`, seed 0, global: tolerance 0 →
  {0}; 32 → {0, 1}; 33 → {0, 1, 2, 3} (alpha counts) (`:58-68`).
- 5×5 black with a white center, seed (2, 2): point sample, tolerance 10 → only the center; 3×3 average (reference
  `(255 + 4) / 9 = 28`), tolerance 30 → the 24 black pixels (`:70-78`). Seed (0, 0) with radius 1 averages the clipped
  2×2 window only.
- Clicking the top row of a 4×3 image whose top row is red selects indices 0-3 (rows not flipped); a point outside
  the image returns nil.

**Color Range (measured):** pixels `[100,100,100,255] [55,55,55,128] [0,0,0,0]`, include gray 100, fuzziness 10 →
mask `255, 255, 0` (the half-transparent pixel un-premultiplies to 110); with Invert → `0, 0, 255`.

**Behavior (upstream tests):**

- Marquee from (60.4, 70.6) to (20.2, 30.3) → `CGRect(20, 30, 40, 41)`; coverage (20, 30) = 255, (19, 30) = 0
  (`SelectionTests.swift:319-332`).
- ⇧ square from (10, 10) to (40, 20) → `(10, 10, 30, 30)`; from-center (API only) from (50, 50) to (60, 55) →
  `(40, 45, 20, 10)`; both → `(42, 42, 16, 16)` from (50, 50) to (45, 58) (`:334-346`).
- Lasso square (−50, −50, 100) is clipped to `≤ (0…50)` (`:44-53`). Subtract with no selection → still `nil`;
  subtracting a covering square → explicit empty, coverage 0 (`:55-66`).
- Outline moved by (10.4, 29.6) then (40.2, 40.4) from the drag start → bounds `(50, 50, 20, 20)`, one undo step
  (`:157-172`). Nudges (1, 0) and (0, −10) from (10, 10) → `(11, 0, 20, 20)`, two steps (`:187-202`).
- Expand 5 of `(40, 40, 20, 20)` → minX 35, width 30; coverage (37, 50) = 255, (33, 50) = 0; Contract 8 → minX 43,
  width 14 (`:204-219`).
- Mask with black `(20, 30, 40, 40)` and a white hole `(30, 40, 10, 10)`, ⌘-click: (25, 35) selected, (35, 45) not,
  (59, 69) selected, (60, 70) not (`:250-265`). Stretched 2× → bounds `(40, 60, 80, 80)` (`:267-281`).
- Pixel move of `(10, 10, 10, 10)` by (60.2, 5) → selection `(70, 15, 10, 10)`, hole at (15, 15), red at (75, 20)
  (`SelectionEditTests.swift:252-271`).
- Copy `(40, 10, 20, 20)` straddling red | blue, Paste → "Layer 2" at origin (40, 10), size 20×20, selection `nil`
  (`SelectionClipboardTests.swift:91-109`).
- Feather 6 on `(20, 0, 20, 20)`: at least 4 clip values strictly between 8 and 247 across the edge, and the same on
  the filled layer's alpha (`SelectionFeatherTests.swift:7-46`).

---

## 9. Upstream quirks a faithful port inherits

1. **⇧⌥ subtracts**; there is no intersect mode at all.
2. **⌥ on the Marquee never draws from the center** (unlike the Shape tool and Photoshop's Marquee).
3. A ⇧ held at the press adds but does not square until pressed again.
4. A Marquee or Lasso drawn **wholly off the canvas** in New mode leaves an **explicit empty** selection (painting is
   refused) instead of deselecting.
5. Subtracting from no selection does nothing and records no step.
6. A New-mode click inside the selection deselects (Marquee, Lasso) or reselects (Wand, Object); with ⇧/⌥ a click
   does nothing.
7. A Polygonal Lasso cannot start inside an existing selection in New mode: the first click moves the outline.
8. New-mode Wand and Object results are not clipped to the canvas (they are inside it anyway); all other results are.
9. Ants ignore feather; a heavily feathered selection shows ants on its hard outline.
10. Select All is always antialiased. Feather stacks as √(f² + a²), capped at 250. Expand and Contract keep the
    feather.
11. Inverse of everything is `nil`; inverse of an explicit empty selection is the whole canvas.
12. ⌘-click on a **mask** thumbnail selects its **black** (hidden) areas, the opposite of Photoshop.
13. M, L and W only choose the tool; Tab switches the mode. The tool bar's help strings still say M and L switch it.
14. Pixels copied in one project tab and pasted in another are **centered**, not in place (the in-place clipboard is
    per session). Copy without a selection on a pixel layer also remembers the layer, so Paste duplicates the whole
    layer (text, shape, effects intact) rather than pasting pixels.
15. Copied, cut, lifted and floated pixels are the layer's raw pixels: mask, opacity, blend mode and effects are not
    applied (Copy Merged is the exception).
16. Pixel moves never snap; ⎋ does not cancel a ⌘-drag (only losing focus does); pixels moved beyond the layer ∪
    canvas grid are cut off.
17. During a distorted floating transform the outline shows only the affine part of the draft.
18. Selection changes are undo steps and mark the project modified, although the selection is never saved.
19. The aliased fill is conservative, so a non-antialiased lasso covers every pixel its interior touches (slightly
    more than the antialiased one's 50 % contour).
20. Color Range's Invert selects fully transparent pixels; its eyedropper does nothing on a fully transparent 3×3
    area; it always replaces the existing selection.
21. The Wand's "This Layer" reads the layer's raw pixels at document size: transparent surroundings and areas hidden
    by the mask all count as pixels (premultiplied zeros), and alpha is compared like a color channel.
22. Object Selection defaults to All Layers; the Wand defaults to This Layer.
23. ⌫ during any lasso draft removes its last point (even mid-drag with the Marquee).
24. `MaskTracing` (Load Layer/Mask Selection, Select Subject) emits loops in a nondeterministic order; only the
    coverage is stable.
25. Content-Aware Fill uses a fresh random seed every time; results are not reproducible.
