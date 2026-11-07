# Compositor Geometry (Crop, Image/Canvas Commands, Transform): Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3). All `file:line` references are relative to
`upstream/Compositor/` unless they start with `media/` (= `vscode-extension/media/`), `engine/` or `CompositorTests/`
(= `upstream/CompositorTests/`). Code excerpts are verbatim. Modifier glyphs follow `ui.md`: `⌘` Command, `⌥` Option,
`⇧` Shift, `⌃` Control, `⎋` Escape, `↩` Return.

Scope: parity checklist `docs/parity/features.md` sections "### Crop" (Tools), "## Image/Canvas commands" and
"## Transform", plus the View › Snap / Snap To rules that transforms and the crop frame use. Section 11 maps every
checklist line to the section that specifies it.

Files read in full: `Document/Crop.swift` (249), `Document/LayerTransform.swift` (246), `Document/Distort.swift` (406),
`Document/CanvasSize.swift` (82), `Document/CanvasRotation.swift` (62), `Document/LayerFlip.swift` (80),
`Document/ImageTrim.swift` (210), `Document/DocumentLimits.swift` (42), `IO/CanvasResizer.swift` (73),
`IO/ImageResizer.swift` (121), `UI/CropControls.swift` (24), `UI/TransformInspector.swift` (145),
`UI/ImageSizeSheet.swift` (171), `UI/CanvasSizeSheet.swift` (146), `UI/TrimSheet.swift` (68), `UI/NumericScrub.swift`
(63), `Rendering/TransformOverlay.swift` (520), and the tests `CropTests`, `CanvasSizeTests`, `ImageSizeTests`,
`ImageTrimTests`, `CanvasRotationTests`, `ResizeSnapTests`, `DistortTests`. Read in part (targeted):
`Document/EditorSession.swift` (1-720), `Rendering/EditorCanvas.swift` (state, cursors, press/drag/release, keys,
crop and transform drags, distortion drawing), `Rendering/GPUCanvas.swift` (`warp`), `Document/Guides.swift`
(snap targets), `Document/LayerMask.swift` (placement, mask transform), `Document/ShapeTool.swift` (`redrawShape`),
`Document/FloatingSelection.swift`, `Document/DocumentHistory.swift`, `Document/BrushStroke.swift` (`BrushRaster`),
`Document/PixelAdjust.swift`, `Document/LayerGroups.swift` (`LayerOrder`), `IO/ProjectController.swift`,
`IO/ProjectStore.swift`, `IO/ImageExporter.swift` (error texts), `CompositorApp.swift` (Image, Layer, View menus),
`ContentView.swift` (headers, alerts, arrow stepping), `UI/NativeLayerList.swift` (keys), `UI/KeyboardShortcuts.swift`,
`CompositorTests/TransformTests.swift`. Board code read: `media/transform.js`, `media/geometry.js`, `media/view.js`
(overlay and transform input), `media/board.js` (options bar, menus, keys, `commitTransform`, `engine`),
`media/render.js` (overrides), `media/select-tools.js` (floating), `vscode-extension/extension.js` (`runEngine`),
`engine/Sources/*.swift`.

**Empirical checks.** Values marked **(measured)** come from a scratch Swift program that compiled the pure upstream
code verbatim (`LayerTransform.swift` 1-246, `Crop.swift` 4-112, `CanvasSize.swift`, `DocumentLimits.swift`,
`Distort.swift` 8-84 and 181-190, `CanvasRotation.swift` 3-14, `LayerFlip.swift` 3-18, `Guides.swift` 4-32) with
Apple Swift 6.4 on this machine, plus `ByteCountFormatter`, `FormatStyle` and `Double(String)` probes. The scratch
files were deleted afterwards. VS Code key bindings were grepped from the installed 1.142 bundle, as in `ui.md` 12.

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| Layer placement | `LayerTransform {origin, size, rotation° clockwise about the center, flipX, flipY, sampling}` in document px. Pixels are never resampled by move/scale/rotate/flip | `Document/LayerTransform.swift:17-31` |
| Drag rounding | Every drag result goes through `rounded()` (Swift `.rounded()` = half away from zero): whole px, whole degrees. Typed values stay exact. **Snapping is applied after rounding**, so a center snap can leave `.5` origins | `Rendering/EditorCanvas.swift:2022-2026` |
| Crop frame | `session.cropRect` (whole px, may extend past the canvas, 1…30,000 px a side). Entering Crop starts it at the canvas, or at the selection's pixel bounds ∩ canvas | `Document/EditorSession.swift:410-420`, `Document/Crop.swift:4-14` |
| Crop ratio | Free, Original, 1:1, 4:3, 3:4, 16:9, 9:16. Choosing one refits the frame **keeping its width and vertical center** (the frame may then extend past the canvas) | `Document/Crop.swift:218-235` |
| Crop snapping | Edges (no centers) within **8** screen points; fixed ratio: only moves snap; **no snap feedback lines**; ⌃ bypasses; ⌥/⌃ re-evaluated live mid-drag | `Rendering/EditorCanvas.swift:123, 750-754, 2561-2571`, `Document/Crop.swift:48-112` |
| Crop apply | `CanvasResizer` with `contentOffset = -frame.origin`: canvas resized, layers/guides/mask placements offset, nothing resampled. One undo step "Crop", view refits, selection dropped | `Document/Crop.swift:236-248`, `IO/CanvasResizer.swift` |
| Canvas Size | Anchor 0…8 (row-major), offset `floor(Δ · column/2)`, `floor(Δ · row/2)`. Optional bottom "Canvas Extension" layer when growing with a color. Undo "Canvas Size" | `Document/CanvasSize.swift:62-76`, `IO/CanvasResizer.swift:33-70` |
| Image Size | Every layer rasterized at the new scale with its transform baked in (axis-aligned result, sampling stored), masks/effects/guides scaled, text/shapes become pixels. Undo "Image Size" | `IO/ImageResizer.swift:14-104` |
| Trim | Bounds of the flattened export render: alpha ≠ 0, or exact premultiplied RGBA ≠ the top-left / bottom-right pixel; then a canvas resize. Nothing to trim: silent no-op. Undo "Trim" | `Document/ImageTrim.swift` |
| Rotate / Flip canvas | Placements turned/mirrored (no resampling), guides and selection follow. Undo "Rotate Canvas 90° Clockwise" etc. Disabled unless `canEditLayers` (so disabled while a crop frame or transform is pending) | `Document/CanvasRotation.swift`, `Document/LayerFlip.swift:53-79`, `CompositorApp.swift:317-327` |
| Transform edit | One `TransformEdit` at a time: handle drags and field edits are non-persistent (applied on release/field exit); ⌘T and any distortion are persistent (Apply ↩ / Cancel ⎋). Undo is unavailable while any edit is open | `Document/LayerTransform.swift:108-124`, `Document/EditorSession.swift:445-579, 650-656` |
| Group transform | >1 selected layers, or a selected folder: one upright box around the visible pixel layers selected or inside selected folders (≤ 64 deep). Members follow the box by `following` (shear dropped). Undo "Transform Layers" | `Document/EditorSession.swift:356-386, 501-515` |
| Distort | ⌘-drag a handle: four free corners; waits for Apply; Apply resamples (CIPerspectiveTransform for convex quads, two affine triangles with nearest sampling for folded ones), trims to visible pixels. Undo "Distort" / "Distort Layers" / "Distort Layer Mask" | `Document/Distort.swift` |
| Snap targets | View › Snap (on), Snap To: Guides (on, only if shown), Grid (off, only if shown), Layers (on), Document Bounds (on). Transforms 10 pt with centers; crop/marquee/shape edges only | `Document/Guides.swift:247-285`, `Document/EditorSession.swift:329-340` |
| Engine | New ops: `transform.commit`, `canvas.crop`, `canvas.size`, `image.size`, `image.trim`, `canvas.rotate`, `canvas.flip`, `layer.flip` (section 9) | — |

---

## 1. Shared geometry

### 1.1 `LayerTransform`

`Document/LayerTransform.swift:17-59, 96-98`:

```swift
nonisolated struct LayerTransform: Equatable, Codable, Sendable {
    var origin: CGPoint
    var size: CGSize
    var rotation: CGFloat = 0
    var flipX = false
    var flipY = false
    var sampling: LayerSampling = .high
    var center: CGPoint { CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2) }
    var radians: CGFloat { rotation.truncatingRemainder(dividingBy: 360) * .pi / 180 }
    var isValid: Bool {
        [origin.x, origin.y, size.width, size.height, rotation].allSatisfy(\.isFinite)
            && (1...300_000).contains(size.width) && (1...300_000).contains(size.height)
            && abs(origin.x) <= 1_000_000 && abs(origin.y) <= 1_000_000
    }
    func point(_ unit: CGPoint) -> CGPoint {
        let x = (unit.x - 0.5) * size.width, y = (unit.y - 0.5) * size.height
        return CGPoint(x: center.x + x * cos(radians) - y * sin(radians),
                       y: center.y + x * sin(radians) + y * cos(radians))
    }
```

- JSON (manifest and engine): `{"origin":[x,y],"size":[w,h],"rotation":r,"flipX":b,"flipY":b,"sampling":"Nearest"|"Smooth"|"High quality"}`.
  The synthesized `Decodable` uses `decode`, not `decodeIfPresent`, so **every key must be present** when the board
  sends a transform to the engine (`media/geometry.js` `Transform.write` already writes all of them).
- `LayerSampling`: Nearest → `CGInterpolationQuality.none`, Smooth → `.low`, High quality → `.high` (`:4-15`).
- Handle order (`LayerTransform.handles`, `:96-98`): 0 TL (0,0), 1 T (0.5,0), 2 TR (1,0), 3 R (1,0.5), 4 BR (1,1),
  5 B (0.5,1), 6 BL (0,1), 7 L (0,0.5). Corners for distortion are TL, TR, BR, BL (`Document/Distort.swift:10-12`), so
  handle `2k` is corner `k`.
- `rounded()` (`:53-59`): origin and rotation `.rounded()`, sizes `max(1, .rounded())`. Swift `.rounded()` is
  "to nearest, ties away from zero": 2.5 → 3, −2.5 → −3, 0.5 → 1, −0.5 → −1 **(measured)**. `media/transform.js`
  already has the matching `roundHalfAway`.
- `following(from:to:)` and `placing(_:)` (`:62-89`) are ported in `media/transform.js` (`following`, `placing`).
  A plain move (same size, rotation, flips) carries exactly; anything else goes through the unit-square affine map and
  drops shear. `placing` keeps `flipX` and expresses a mirror through the angle and `flipY` (quirk 10.9).

### 1.2 Snap targets (View › Snap, View › Snap To)

`Document/Guides.swift:247-285` builds every target list:

```swift
func alignmentSnapTargets(excluding moving: Set<UUID> = [], includeCenters: Bool) -> (xs: [CGFloat], ys: [CGFloat]) {
    guard snapEnabled, let document else { return ([], []) }
    ...
    if snapToDocumentBounds { xs += [0, W]; ys += [0, H]; if includeCenters { xs.append(W / 2); ys.append(H / 2) } }
    if snapToLayers {
        for layer in document.renderLayers where layer.asset != nil && !moving.contains(layer.id) {
            let corners = DistortWarp.corners(of: displayedTransform(for: layer))
            // min/max of the corners, each .rounded(); centers ((min+max)/2).rounded() when includeCenters
        }
    }
    // Hidden extras do not snap, matching Photoshop.
    if snapToGrid, showsGrid { xs += layoutGrid.lines(along: W); ys += layoutGrid.lines(along: H) }
    if snapToGuides, showsGuides { for guide in displayedGuides { vertical → xs, horizontal → ys } }
    return (xs, ys)
}
```

| Setting | Default | Persisted key (`ToolDefaults`) | Ref |
|---|---|---|---|
| View › Snap (master, ⇧⌘;) | on | `snap` | `Document/EditorSession.swift:330-336` |
| Snap To › Guides | on, and only while View › Show › Guides is on | `snapGuides` | `:337` |
| Snap To › Grid | off, and only while the grid is shown | `snapGrid` | `:338` |
| Snap To › Layers | on | `snapLayers` | `:339` |
| Snap To › Document Bounds | on | `snapBounds` | `:340` |

- `renderLayers` = visible, non-folder layers bottom to top (`Document/LayerGroups.swift:89-95, 101-140`). Layers
  without pixels (blank, adjustment) are skipped. `displayedTransform` is the pending draft for layers being edited,
  but those are in `moving` and excluded anyway.
- Grid lines: `step = spacing / subdivisions` (default 64 / 8 = 8 px), `count = floor(length / step + 0.001)`, lines
  `(k · step).rounded()` for `k = 0…count` (`Document/Guides.swift:49-56`). Subdivision lines count.
- Who uses which list:

| Use | Function | Centers | Tolerance | Feedback lines | Ref |
|---|---|---|---|---|---|
| Move a layer / group box | `snappedMove` → `TransformSnap.offset` | yes | 10 pt | yes | `Document/Crop.swift:122-137` |
| Resize handle (upright only) | `snappedResizePoint` | yes | 10 pt | yes | `Document/Crop.swift:143-182` |
| Crop frame | `CropSnap.apply` with `cropSnapTargets()` | **no** | **8 pt** | **no** | `Document/Crop.swift:49-112, 209-211`; `Rendering/EditorCanvas.swift:123, 2553-2554` |
| Marquee / Shape corners | `snappedPoint` | no | 10 pt | yes | `Document/Crop.swift:186-195` |

- Tolerance in document px = `points / max(viewport.pointsPerPixel, 0.0001)`. The board's equivalent is `view.ppp`
  (CSS px per document px): `media/view.js:711` already does `SNAP_DISTANCE / Math.max(this.ppp, 0.0001)`.
- The crop's `CropSnap` is built once at the press (`Rendering/EditorCanvas.swift:2553-2554`); its targets do not
  change mid-drag. Transform targets are rebuilt on every drag event.
- **⌃ bypass.** Transform drags read ⌃ from each drag event (`:2013-2026`). The crop drag also re-runs when ⌥ or ⌃
  changes without a mouse move (`flagsChanged`, `:750-754`).
- **Feedback lines** (`Rendering/TransformOverlay.swift:269-288`): 1 pt `NSColor.controlAccentColor` lines along each
  snapped x from document y 0 to H, and each snapped y from x 0 to W (document extent, not the whole view). Cleared by
  `commitTransform`, `cancelTransform` and turning Snap off (`Document/EditorSession.swift:330-335, 485, 527`).
- **Board gap.** `media/board.js:584-589` `snapTargets` ignores the master switch and all four Snap To toggles, never
  adds grid lines, and includes guides whether or not they are shown. Port `alignmentSnapTargets` exactly, with the
  persisted toggles, and use it for transforms (centers), crop (no centers, 8 pt) and the existing shape/marquee code.

### 1.3 `TransformSnap` (move) and `snappedResizePoint` (resize)

Already ported in `media/transform.js` (`snappedMove`, `snappedResizePoint`). Exact rules for verification:

- Move: the box is the axis-aligned bounds of the draft's four corners (rotation included). Horizontally, each of
  `minX, midX, maxX` is tested against every x target; the smallest `|target − value|` within tolerance wins (ties keep
  the first found, scanning guides in order minX, midX, maxX and targets in list order). Same vertically. Offset is
  added to `origin` (`Document/LayerTransform.swift:226-245`).
- Resize: only when `drag.original.radians == 0`. The edge on the side of the dragged handle (`at = grab + pointer
  delta`; `minX` if `|minX − at.x| ≤ |maxX − at.x|`) is tested; with "proportional" (`locksTransformRatio != ⇧`) and
  both axes snapping, only the nearer one is kept. The pointer is shifted by `(target − edge) / perPixel`, where
  `perPixel` is measured by moving the pointer 1 px (skipped when `|perPixel| ≤ 0.01`). The result then goes through
  `updated` and `rounded()` (`Document/Crop.swift:143-182`, `Rendering/EditorCanvas.swift:2016-2023`).

---

## 2. Crop tool

### 2.1 State and entering the tool

State (`Document/EditorSession.swift:174-176`): `cropRect: CGRect?` (nil = no pending frame), `cropRatioChoice =
"Free"`, `cropError: String?`. The frame on screen is `visibleCropRect = cropRect ?? canvas` while the tool is Crop
(`Document/Crop.swift:214-217`).

**"Entering the tool"** (`Document/EditorSession.swift:410-420`): `selectTool(.crop)` (key `C`, rail button
"Crop (C)", SF `crop`), when `cropRect == nil`:

```swift
cropRatioChoice = "Free"
let canvas = CGRect(origin: .zero, size: document.size)
// With a selection, the crop starts at its bounds, as Photoshop's does: C, then Return, crops to it.
if let selection, !selection.isEmpty {
    let bounds = selection.path.boundingBoxOfPath.integral.intersection(canvas)
    cropRect = CropGeometry.valid(bounds) ? bounds : canvas
} else {
    cropRect = canvas
}
```

So a pending frame exists as soon as the tool is chosen, which makes `canEditLayers` false (section 2.10).
`boundingBoxOfPath` is the tight curve bounds; `.integral` floors the min and ceils the max (`media/geometry.js`
`Rect.integral`). A selection entirely off the canvas gives `CGRect.null`, which is invalid, so the canvas is used.

### 2.2 Header (`UI/CropControls.swift`)

```swift
HStack(spacing: 14) {
    Text("Crop").font(ToolHeaderStyle.titleFont)                       // 13 pt semibold
    Picker("Ratio", selection: $session.cropRatioChoice) {
        ForEach(["Free", "Original", "1:1", "4:3", "3:4", "16:9", "9:16"], id: \.self) { Text($0) }
    }.frame(width: 170)
        .onChange(of: session.cropRatioChoice) { _, _ in session.changeCropRatio() }
    if let rect = session.cropRect {
        Text("\(Int(rect.width)) × \(Int(rect.height)) px").monospacedDigit()
    }
    Spacer()
    Button("Cancel") { session.cancelCrop() }.disabled(session.cropRect == nil)
    Button("Apply Crop") { Task { await session.commitCrop() } }
        .disabled(session.cropRect == nil)
}.padding(.horizontal, 18).toolHeaderBar().disabled(session.showsBusy || session.document == nil)
```

- **"Ratio picker"**: a pop-up labeled "Ratio", 170 pt wide, default Free. Every change calls `changeCropRatio()`
  (section 2.3). It is reset to Free each time the tool is entered with no pending frame.
- **"Size readout"**: `"W × H px"`, `Int()` truncation of the frame's size, tabular digits, shown **only while
  `cropRect != nil`** (hidden after Cancel or Apply, even though the full-canvas frame is still drawn). Integer
  interpolation in SwiftUI `Text` uses `%lld`, so no grouping separator (inferred).
- **"Cancel button … and Apply Crop button"**: both disabled when `cropRect == nil`, i.e. after Cancel, after a
  successful Apply, after an undo/redo, and between a "create" press and its first drag event (2.4). They are
  **enabled right after entering the tool** (the frame equals the canvas then). The whole header is disabled while
  `showsBusy` (an operation running for more than 250 ms, `Document/EditorSession.swift:130-150`) or without a
  document.
- Status bar hint (`ContentView.swift:365`): "Drag to crop · Enter apply · Escape cancel · Space to pan".

### 2.3 Ratio and refit (`Document/Crop.swift:218-235`)

```swift
var cropRatio: CGFloat? {
    switch cropRatioChoice {
    case "Original": return document.map { CGFloat($0.width) / CGFloat($0.height) }
    case "1:1": return 1
    case "4:3": return 4 / 3
    case "3:4": return 3 / 4
    case "16:9": return 16 / 9
    case "9:16": return 9 / 16
    default: return nil
    }
}
func changeCropRatio() {
    guard let rect = visibleCropRect, let ratio = cropRatio else { return }
    let height = rect.width / ratio
    let next = CropGeometry.snapped(CGRect(x: rect.minX, y: rect.midY - height / 2, width: rect.width, height: height))
    if CropGeometry.valid(next) { cropRect = next }
}
```

- Ratio is width / height. "Original" uses the **current** canvas.
- The refit keeps x and width and centers the new height on the old vertical middle, so a tall ratio on a landscape
  frame extends far past the canvas (e.g. 9:16 on 1920 × 1080 → `(0, −1167, 1920, 3414)`, **measured**). Applying that
  enlarges the canvas.
- It runs on `visibleCropRect`, so choosing a ratio after Cancel creates a pending frame again.
- If the refit is invalid (a side over 30,000), the frame is left as it was **but the choice still changes**; later
  ratio-locked resizes then keep the frame's own aspect, not the chosen one (quirk 10.3).
- Choosing Free changes nothing.

### 2.4 Press dispatch (`Rendering/EditorCanvas.swift:2542-2559`)

**"Drag outside the frame (or inside a full-canvas frame) draws a new frame; drag inside a non-full frame moves it;
corner handles and entire edges (10-pt hit zones) resize it"**:

```swift
let rect = session.visibleCropRect ?? CGRect(origin: pixel, size: .zero)
if let region = transformOverlay.cropResizeRegions.first(where: { $0.rect.contains(point) }) {
    mode = .resize(region.index)
} else if session.cropRect?.contains(pixel) == true,
          rect != CGRect(origin: .zero, size: document.size) { mode = .move }
else { mode = .create; session.cropRect = nil }
cropDrag = CropDrag(start: pixel, original: rect, mode: mode)
```

Resize regions in **view points** (`Rendering/TransformOverlay.swift:383-405`), tested in this order with half-open
`CGRect.contains`: the four corner squares (handles 0, 2, 4, 6), each `20 × 20` centered on the corner; then the top
and bottom edge bands (1, 5) `x ∈ [minX + 10, maxX − 10)`, `y ∈ [edge − 10, edge + 10)` (width `max(0, w − 20)`); then
the left and right bands (3, 7) `y ∈ [minY + 10, maxY − 10)`, `x ∈ [edge − 10, edge + 10)`. Corners win over edges.

Consequences:
- A **click** (no drag) outside the frame, or anywhere inside a frame equal to the canvas, sets `cropRect = nil`: the
  frame snaps back to the canvas and Cancel/Apply/readout disappear (quirk 10.1).
- The interior of a non-full frame has no special cursor (it stays the crosshair) but moves the frame.
- The press is ignored while Space is held (that is a pan), and drag updates are ignored while the project is busy
  (`:1991`).
- The cursor at the press is locked for the whole drag (`dragCursor = .current`, `:2555-2558`).

### 2.5 Drag math (`Document/Crop.swift:4-46`)

**"Whole-pixel frames"** — `CropGeometry.snapped` and `valid`:

```swift
static func snapped(_ rect: CGRect) -> CGRect {
    let rect = rect.standardized
    let x = rect.minX.rounded(), y = rect.minY.rounded()
    return CGRect(x: x, y: y, width: max(1, rect.maxX.rounded() - x), height: max(1, rect.maxY.rounded() - y))
}
static func valid(_ rect: CGRect) -> Bool {
    [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite)
        && (1...DocumentLimits.maxSideExtent).contains(rect.width) && (1...DocumentLimits.maxSideExtent).contains(rect.height)
        && abs(rect.minX) <= 1_000_000 && abs(rect.minY) <= 1_000_000
}
```

**Create** (`create(from:to:ratio:symmetric:)`, `:16-26`):

```swift
var dx = end.x - start.x, dy = end.y - start.y
if let ratio {
    if abs(dx) > abs(dy) * ratio { dy = (dy < 0 ? -1 : 1) * abs(dx) / ratio }
    else { dx = (dx < 0 ? -1 : 1) * abs(dy) * ratio }
}
if symmetric {
    return snapped(CGRect(x: start.x - abs(dx), y: start.y - abs(dy), width: abs(dx) * 2, height: abs(dy) * 2))
}
return snapped(CGRect(x: min(start.x, start.x + dx), y: min(start.y, start.y + dy), width: abs(dx), height: abs(dy)))
```

Note the sign test `dy < 0 ? -1 : 1`: a zero delta counts as positive. The ratio is applied to the larger of
`|dx|` and `|dy| · ratio`, so the frame always contains the pointer's projection on that axis.

**Move** (`:38`): `snapped(original.offsetBy(dx, dy))` — whole-pixel steps, size kept.

**Resize** (`:39-44`): delegated to the layer transform drag, with the frame as an unrotated transform:

```swift
let transform = LayerTransform(origin: original.origin, size: original.size)
let drag = TransformDrag(original: transform, start: start, mode: .resize(index))
let next = drag.updated(to: point, lockRatio: ratio != nil, shift: false, option: symmetric)
return CropGeometry.snapped(CGRect(origin: next.origin, size: next.size))
```

- **"Option = symmetric"**: create grows from the press point as center; resize anchors at the frame's center
  (span ×2). `dragCrop` reads ⌥ from each event and also re-runs on ⌥/⌃ changes with the current pointer location
  (`Rendering/EditorCanvas.swift:750-754, 2563-2571`).
- **"Fixed ratio"**: create uses the chosen ratio; **resize locks the frame's current aspect** (`lockRatio: true`
  uses `original.size`), not the chosen ratio. Corners project onto the diagonal (minimum factor `1 / min(w, h)`);
  edge handles scale the other axis about the frame's middle line (`(0, 0, 1920, 1080)` right edge to x 1600 at 16:9 →
  `(0, 90, 1600, 900)`, **measured**).
- ⇧ does nothing in the crop tool (`shift: false`).
- Dragging a handle past the opposite edge turns the frame over to the other side (the `TransformDrag` flip becomes a
  positive-size rect on the far side): right edge dragged from 1920 to −100 → `(−100, 0, 100, 1080)` **(measured)**.
- After `updated` and snapping (2.6), `if CropGeometry.valid(next) { session.cropRect = next }`: an invalid result
  leaves the last valid frame (`:2570`).

### 2.6 Crop snapping (`Document/Crop.swift:48-112`)

**"Edge snapping"**: targets = `cropSnapTargets()` = `alignmentSnapTargets(includeCenters: false)` (canvas edges,
layer bounds edges, grid lines and guides as enabled; no centers), tolerance `8 / pointsPerPixel`, applied only when
`session.snappingEnabled` (View › Snap) and ⌃ is not held.

```swift
switch drag.mode {
case .move:
    // each axis: among [minX, maxX], the edge whose nearest target is closest moves onto it; size kept
    return rect.offsetBy(dx: shift([rect.minX, rect.maxX], xs), dy: shift([rect.minY, rect.maxY], ys))
case .create:
    guard ratio == nil else { return rect }
    horizontal = true; vertical = true
case .resize(let index):
    guard ratio == nil else { return rect }
    let handle = LayerTransform.handles[index]
    horizontal = handle.x != 0.5; vertical = handle.y != 0.5
}
// The dragged edge is the one on the pointer's side.
if horizontal {
    if abs(point.x - result.minX) <= abs(point.x - result.maxX) {
        if let x = nearest(result.minX, in: xs), x < result.maxX { result = (x, minY, maxX − x, h) }
    } else if let x = nearest(result.maxX, in: xs), x > result.minX { result.size.width = x − minX }
}
// same vertically
if symmetric {
    var center = CGPoint(x: drag.original.midX, y: drag.original.midY)
    if case .create = drag.mode { center = drag.start }
    if horizontal { let half = point.x >= center.x ? maxX − center.x : center.x − minX
                    if half >= 0.5 { origin.x = center.x − half; width = half * 2 } }
    // same vertically
}
```

- `nearest` keeps the first target found among equally close ones (`:56-63`).
- **"with a fixed ratio only moves snap so the ratio stays exact"**: create and resize return early when a ratio is
  set.
- No `snapGuides` are set: **the crop draws no snap feedback lines**.
- The symmetric block runs whenever ⌥ is held and snapping is on, snapped or not. For a symmetric **create** it
  mirrors about the raw, fractional press point, so the frame is generally **not on whole pixels** (quirk 10.2).

### 2.7 Display while cropping

- **"frame may extend beyond the canvas (content outside is drawn while cropping)"**: `renderBounds` is
  `canvas ∪ cropRect` while the tool is Crop (`Rendering/EditorCanvas.swift:2536-2540`). The canvas drop shadow,
  checkerboard and layer composite are drawn over that union (`:877-919`), so layer pixels past the canvas edge show
  inside the frame.
- **"Overlay"** (`Rendering/TransformOverlay.swift:492-519`), in view points, drawn instead of the transform handles
  (`:186-195`):
  1. Even-odd fill of (whole overlay view bounds) minus (frame), black at 60% alpha. This darkens the pasteboard too.
  2. Frame: 1 pt white stroke on the (unrounded) view rect.
  3. Rule of thirds: lines at 1/3 and 2/3 of the frame both ways, 1 pt, white at 40% alpha.
  4. Eight handles at the `LayerTransform.handles` positions: `8 × 8` squares, white fill, 1 pt black stroke.
  Then the marching ants, the lasso draft and any snap guides are drawn on top (`:186-195`).
- Cursors (`Rendering/EditorCanvas.swift:1453-1491`): crosshair over the canvas; in the resize regions a
  frame-resize cursor (positions TL, T, TR, R, BR, B, BL, L for handles 0…7, both directions). CSS: `nwse-resize`
  (0, 4), `ns-resize` (1, 5), `nesw-resize` (2, 6), `ew-resize` (3, 7).

### 2.8 Keys

**"Return/Enter applies, Escape cancels"** (`Rendering/EditorCanvas.swift:2240-2245`): with the Crop tool, ⎋ →
`cropDrag = nil; cancelCrop()`; ↩ or keypad Enter → `cropDrag = nil; Task { await commitCrop() }`. These are checked
after a lasso draft, a shape draft and a pending gradient, and before guide drags and transforms. ↩ with no pending
frame does nothing (`commitCrop` guards on `cropRect`). C selects the tool (`:2315`).

### 2.9 Cancellation

**"Leaving the tool, a canvas rotate/flip, an undo/redo, or starting a transform cancels the pending frame"**:
`cancelCrop()` (`cropRect = nil`) is called by `selectTool` on a real tool change (`Document/EditorSession.swift:398`),
`beginTransform` (`:446`), history `restore` (`:670`), `rotateCanvas` (`Document/CanvasRotation.swift:36`),
`flipCanvas` (`Document/LayerFlip.swift:57`), `ProjectController.begin()` (Save, Canvas Size, Image Size, Trim;
`IO/ProjectController.swift:18-24`), `installProject` and `clearProject`.

Reachability: Undo/Redo stay enabled while cropping (`canUseHistory` does not test `cropRect`), so undo cancels the
frame. ⌘T, Rotate/Flip Canvas and Flip Layer are **disabled** while `cropRect != nil` (they need `canEditLayers`), so
those cancels only fire after Cancel/Apply has cleared the frame.

### 2.10 What a pending frame blocks

`canEditLayers` requires `cropRect == nil` (`Document/EditorSession.swift:698-701`); `layersLookEditable` too
(`:692-697`). While a frame is pending: the Layers panel is grayed, and every Layer-menu command, Transform, Rotate/Flip
Canvas, Flip Layer, painting and selection edits that need `canPaint` are unavailable. Image Size, Canvas Size and Trim
stay available (they cancel the frame first). Save cancels the frame.

### 2.11 Apply

See 3.4.

---

## 3. Image/Canvas commands

### 3.1 Common machinery

Menu (`CompositorApp.swift:294-327`), Image menu, after the adjustments and Invert:

```
Invert                               ⌘I
—
Canvas Size…                         ⌥⌘C
Image Size…                          ⌥⌘I
Trim…
—
Rotate Canvas 90° Clockwise
Rotate Canvas 90° Counterclockwise
Flip Canvas Horizontal
Flip Canvas Vertical
```

- Canvas Size / Image Size / Trim: enabled when there is a document and `projects.canStart`
  (= `canStartProjectOperation && workspace?.isManaging != true`, `IO/ProjectController.swift:13-15`).
  `canStartProjectOperation` (`Document/EditorSession.swift:151-154`): no Expand/Contract/Feather panel, no Color
  Range panel, no text being edited, not busy or importing, no brush or warp stroke, no Levels, no New Canvas sheet,
  no file importer, no rename, no import error alert, no adjustment being edited, no PSD conversion sheet. A pending
  crop or transform does **not** disable them.
- `begin()` (`IO/ProjectController.swift:18-24`): `cancelCrop()`, `commitTransform()`, `isProjectBusy = true` for
  the whole sheet (so every edit waits and the headers dim after 250 ms), then the sheet opens as a window-modal sheet
  titled like the command.
- On OK: `projectSnapshot()` → resizer (actor, async) → `applyDocumentSize(result, actionName:)`
  (`IO/ImageResizer.swift:112-120`):

```swift
func applyDocumentSize(_ snapshot: ProjectSnapshot, actionName: String) {
    guard document?.id == snapshot.manifest.documentID else { return }
    beginEdit(actionName)
    let m = snapshot.manifest
    document = CanvasDocument(id: m.documentID, width: m.width, height: m.height,
        layers: snapshot.documentLayers, resolution: m.resolution ?? 72, guides: m.guides ?? [])
    endEdit()
    viewport.fit(documentSize: document!.size)
}
```

  One undo step named `actionName`, unless the new document equals the old one (`DocumentHistory.end` skips no-op
  edits). The new `CanvasDocument` has **no selection**: Crop, Canvas Size, Image Size and Trim drop the selection
  (and that alone makes an undo step when a selection existed). The view refits.
- Errors are shown as a warning alert (`IO/ProjectController.swift:356-363`) with the title below and
  `error.localizedDescription` as the message, one "OK" button. Titles use the typographic apostrophe U+2019:

| Command | Alert title | Ref |
|---|---|---|
| Canvas Size | "Couldn’t change canvas size" | `IO/ProjectController.swift:130` |
| Image Size | "Couldn’t resize the image" | `:152` |
| Trim | "Couldn’t trim image" | `:175` |
| Crop | "Couldn’t crop" (a `ContentView` alert on `cropError`) | `ContentView.swift:301-304` |

  Messages that can occur: `ProjectError.tooLarge` "This project exceeds the supported canvas, layer, file-size, or
  N-megapixel document limit." with N = `documentBudgetMegapixels` = `min(800, max(200, RAM/16 bytes)) MP`
  (`IO/ProjectStore.swift:76`, `Document/DocumentLimits.swift:36-41`); `ProjectError.invalid` "This is not a valid
  Compositor project, or its metadata is damaged."; `ProjectError.missingImage` "An image inside the project is
  missing or damaged. The current document has not been replaced."; `ExportError.render` "The canvas could not be
  rendered. Try a smaller canvas."
- Fields in the sheets are `TextField(value:format: .number.precision(.fractionLength(0...3)))`: up to 3 decimals,
  locale grouping (1920 shows as "1,920"; 26.6666 as "26.667", **measured**); the value is parsed and committed when
  the field commits (Return or focus loss), not per keystroke.
- Label scrubbing (`UI/NumericScrub.swift`): hovering a label shows the left-right resize cursor; a drag of at least
  1 pt sets `start + translation.x × sensitivity`, rounded to a multiple of `step` (1, in the **displayed unit**), and
  clamped to the range; release calls `onEnd`.

### 3.2 Image Size (`UI/ImageSizeSheet.swift`, `IO/ImageResizer.swift`)

**"Image › Image Size… (Opt-Cmd-I) opens a sheet"**: window-modal sheet, title bar "Image Size", content 430 pt wide,
padding 24, vertical spacing 18, rounded-border text fields. Layout top to bottom (`:105-169`):

| Row | Content |
|---|---|
| Title | "Image Size" (`.title2.bold()`) |
| **"Current: W × H pixels" readout** | `"Current: \(document.width) × \(document.height) pixels"`, secondary color |
| **Units picker** | pop-up "Units": Pixels, Percent, Inches, Centimeters (default Pixels). Pixels and Percent are **hidden while Resample is off** |
| **Width** | label "Width" (75 pt, leading, scrubbable) + text field (placeholder "Width") |
| **Height** | label "Height" (75 pt) + field |
| **Lock aspect ratio** | checkbox, default on, disabled while Resample is off |
| **Resolution** | label "Resolution" (scrubbable, sensitivity 1, range 1…9600, step 1) + field + "pixels/inch" (secondary) |
| **Resample** | checkbox, default on |
| Sampling (Resample on) | pop-up "Sampling": Nearest, Smooth, High quality (default High quality) |
| **Explanatory text** | Resample on: "Resizes layer pixels and applies existing transforms. Undo restores the originals." Resample off: "Only print dimensions and resolution change. Pixels stay unchanged." (callout, secondary) |
| **Result line** | valid: "Result: \(Int(width.rounded())) × \(Int(height.rounded())) pixels" (callout, secondary); invalid: "Use 1–30,000 pixels per side, up to 200 megapixels, and 1–9,600 pixels/inch." (callout, orange) |
| Buttons | "Cancel" (⎋) · spacer · "Resize" (↩, disabled when invalid) |

State (all `@State`, reset each time the sheet opens): `width`, `height` (pixels, `Double`, start at the document
size), `resolution` (starts at `document.resolution`; 72 for new canvases), `lastResolution`, `locked = true`,
`resample = true`, `unit = "Pixels"`, `sampling = .high`.

Displayed value of a dimension (`:32-39`): Pixels → px; Percent → `px / original × 100`; Inches → `px / resolution`;
Centimeters → `px / resolution × 2.54`.

**"Width field" / "Height field"** setter (`:40-63`):

```swift
guard value.isFinite, value > 0 else { return }
if unit == "Inches" || unit == "Centimeters", !(resolution.isFinite && resolution > 0) { return }
if !resample {
    resolution = (isWidth ? width : height) / value * (unit == "Centimeters" ? 2.54 : 1)
    return
}
let pixels = (Percent) value / 100 * original | (Inches) value * resolution | (Centimeters) value / 2.54 * resolution | value
if isWidth { if locked { height = pixels * height / width }; width = pixels }
else       { if locked { width = pixels * width / height };  height = pixels }
```

- Zero or negative entries are ignored (the field shows the old value again).
- The lock keeps the **current** width:height ratio (not the original one): unlock, change one side, lock again, and
  the new ratio is kept.
- Resample off: a typed print size changes the **resolution** so the pixel size stays; the other print dimension
  follows through the display formula.

Scrub ranges and sensitivities (`:65-102`), in the displayed unit; `pixels`/`other` are this axis and the other axis
in px:
- `canScrubDimensions` is false (labels disabled, range 0…0) in Inches/Centimeters when the resolution is not a
  positive finite number.
- Resample off: range `pixels × m / 9600 … pixels × m` with `m = 2.54` for Centimeters else 1; sensitivity 0.0254
  (cm) or 0.01 (in) per point.
- Resample on: `minimum = locked ? max(1, pixels / other) : 1`;
  `dimensionLimit = locked ? min(30000, 30000 × pixels / other) : 30000`;
  `areaLimit = locked ? sqrt(100,000,000 × pixels / other) : 100,000,000 / other` (100 MP, quirk 10.5);
  `maximum = max(minimum, min(dimensionLimit, areaLimit))`, each converted to the unit. Sensitivity per point:
  Pixels 1, Percent `100 / original`, Inches `1 / resolution`, Centimeters `2.54 / resolution`. Step 1 unit.

**"Resolution field"** (`:127-139`): typing or scrubbing sets `resolution`; on change, if the new value is positive and
finite: with Resample on and the unit Inches or Centimeters, `width *= new / lastResolution` and
`height *= new / lastResolution` (print size kept, pixels change); then `lastResolution = new`. A zero or negative
entry is kept in the field (invalid) without touching `lastResolution`.

**"Resample toggle"** (`:140-147`): turning it off resets `width`/`height` to the document size, forces `locked =
true`, and switches Pixels/Percent to Inches. Turning it back on changes nothing else (the unit stays Inches).

**"Sampling picker"**: only with Resample on. Its value is stored on **every** layer's transform by the resize
(quirk 10.6).

Validity (`:27-31`):

```swift
width.isFinite && height.isFinite && resolution.isFinite && (1...9600).contains(resolution)
    && (1...30000).contains(width.rounded()) && (1...30000).contains(height.rounded())
    && (!resample || width.rounded() * height.rounded() <= 200_000_000)
```

**"Cancel (Escape) / Resize (Return, disabled when invalid)"**: Resize sends `ImageSizeOptions(width:
Int(width.rounded()), height: Int(height.rounded()), resolution: resolution, sampling: sampling)`.

**"Resampling behaviour"** (`IO/ImageResizer.swift:14-104`):

1. Guards: both sides 1…30,000 and resolution 1…9600, else `tooLarge`.
2. Same pixel size: only the resolution changes; layers, images and masks are kept as they are.
3. Otherwise `w × h ≤ 200,000,000` (else `tooLarge`); `sx = w / oldW`, `sy = h / oldH`; guides scale
   (`position *= sx` for vertical, `sy` for horizontal); `effectScale = sqrt(sx · sy)`.
4. For **every** layer record (folders, blank and adjustment layers included), new transform = the integral bounds of
   its four corners scaled by `(sx, sy)`:
   `left = floor(min x), top = floor(min y), width = ceil(max x) − left, height = ceil(max y) − top`, rotation 0, no
   flips, `sampling = options.sampling`; must be valid.
5. Layers with an image: side ≤ 30,000 and the running pixel sum ≤ `documentPixelBudget`; the image is redrawn into a
   new context of that size (`translate(−left, −top)`, `scale(sx, sy)`, `LayerRenderer.draw` with the old transform
   and the new sampling). 16-bit and HDR layers are drawn from their deep pixels into a deep context and stay deep;
   8-bit layers get a new 96-px thumbnail.
6. Masks: a uniform 1 × 1 mask, or a mask with its own placement, keeps its pixels; a placement becomes
   `placement.placing(placement.unitToDocument.concatenating(scale(sx, sy)))` (shear dropped). Any other mask is
   rasterized into the layer's new bounds (gray, separate budget, `drawCoverage`).
7. Records keep id, name, visibility, parent, folder flag, opacity, blend, mask file/enabled/link, clipping source and
   adjustment; **`shape` and `text` are not copied** (live shapes and text become plain pixels); effects are
   `scaled(by: effectScale)`.

**"Applied as one undo step "Image Size" and the view refits"**: `applyImageSize` → `applyDocumentSize(…, "Image
Size")`. Failure: alert "Couldn’t resize the image".

### 3.3 Canvas Size (`UI/CanvasSizeSheet.swift`, `Document/CanvasSize.swift`, `IO/CanvasResizer.swift`)

**"Image › Canvas Size… (Opt-Cmd-C) opens a sheet"**: title bar "Canvas Size", 450 pt wide, padding 24, spacing 16.

| Row | Content |
|---|---|
| Title | "Canvas Size" (`.title2.bold()`) |
| **Current size readout and memory** | "Current: \(W) × \(H) pixels" (primary), then "\(bytes(W, H)) uncompressed RGBA canvas" (callout, secondary) |
| Divider | |
| **Units picker** | "Units": Pixels (default), Percent, Inches, Centimeters (inches/cm use the document resolution) |
| **Width** | label "Width" (60 pt, scrubbable) + field |
| **Height** | label "Height" (60 pt) + field |
| **"Relative to current dimensions"** | checkbox, default off |
| **"Lock original aspect ratio"** | checkbox, default off; turning it on runs `draft.set(draft.displayed(widthAxis: true), widthAxis: true)` |
| **New size line** | valid: "New: \(Int(w.rounded())) × \(Int(h.rounded())) pixels · \(bytes) uncompressed" (callout, secondary); invalid: "Final dimensions must be 1–30,000 pixels per side." (callout, orange) |
| **Anchor** | left: "Anchor" over a 3 × 3 grid (spacing 3) of 25 × 25 buttons, SF `circle.fill` (selected, accent tint) or `circle` (secondary tint), tooltip and accessibility label = name; right column (top padding 28): the selected name (callout bold) and "Keeps this point fixed. Artwork is not scaled; cropped content remains outside the canvas." (callout, secondary) |
| **Canvas extension** | pop-up "Canvas extension": Transparent (default), Foreground, Background, Black, White, Custom |
| Custom only | "Extension color" + a dialog color swatch titled "Extension Color" (tooltip "Color for the added canvas"), default white; clicking opens the color picker on it |
| Buttons | "Cancel" (⎋; closes the picker) · spacer · "OK" (↩, disabled when invalid; closes the picker) |

Anchor names (index row-major): 0 Top left, 1 Top center, 2 Top right, 3 Middle left, 4 Center (default), 5 Middle
right, 6 Bottom left, 7 Bottom center, 8 Bottom right.

`bytes(w, h)` = `ByteCountFormatter.string(fromByteCount: w·h·4, countStyle: .memory)` (section 8.5 gives a JS port).

`CanvasSizeDraft` (`Document/CanvasSize.swift:8-60`):

```swift
var valid: Bool { width.isFinite && height.isFinite && (1...30000).contains(width.rounded()) && (1...30000).contains(height.rounded()) }
func displayed(widthAxis: Bool) -> Double {
    let pixels = (widthAxis ? width : height) - (relative ? original : 0)
    // pixels | pixels / original * 100 | pixels / resolution | pixels / resolution * 2.54
}
mutating func set(_ value: Double, widthAxis: Bool) {
    let pixels = value | value / 100 * original | value * resolution | value / 2.54 * resolution
    let final = pixels + (relative ? original : 0)
    if widthAxis { width = final; if locked { height = final * originalHeight / originalWidth } }
    else { height = final; if locked { width = final * originalWidth / originalHeight } }
}
```

- The lock uses the **original** aspect (unlike Image Size). Percent is relative to the original side. In relative
  mode, Percent shows the change as a percentage of the original.
- Scrub (`:25-48`): range `displayed(lower)…displayed(upper)` with `lower = locked ? max(1, original/other) : 1`,
  `upper = locked ? min(30000, 30000 × original/other) : 30000` (original sides), shifted by the original side in
  relative mode; sensitivity Pixels 1, Percent `100 / original`, Inches `1 / resolution`, Centimeters
  `2.54 / resolution`; step 1 unit.
- Extension color (`:52-64`): Transparent → nil; Black/White; Foreground/Background = the palette colors captured
  when the sheet opened; Custom = the swatch. Converted to sRGB components.
- OK sends `CanvasSizeOptions(width: Int(w.rounded()), height: Int(h.rounded()), anchor: anchor, fill: fill)`.

**"Anchor 3x3 grid … odd extra pixel goes right/bottom when growing"** (`Document/CanvasSize.swift:69-75`):

```swift
// Floor puts the extra pixel on the right/bottom when expanding,
// and removes it from the left/top when shrinking around the center.
return CGPoint(x: floor(Double(width - fromWidth) * Double(anchor % 3) / 2),
        y: floor(Double(height - oldHeight) * Double(anchor / 3) / 2))
```

**"Behaviour"** (`IO/CanvasResizer.swift:7-72`):

1. Guards: sides 1…30,000, anchor 0…8 (else `tooLarge`); offset finite and `|offset| ≤ 1,000,000` (else `invalid`).
2. Same size and zero offset: the snapshot is returned unchanged.
3. Every layer's `origin += offset` (must stay valid, else `tooLarge`); every mask placement too; guides
   `position += offset` on their axis. Nothing is scaled; resolution kept.
4. Extension: only when `fill != nil` **and** the canvas grows on at least one axis. Requires
   `W × H ≤ documentPixelBudget − (sum of all image pixels)` and fewer than 10,000 layers (else `tooLarge`), and color
   components in 0…1 (else `invalid`). Creates an sRGB `W × H` image filled with the color, then **clears the old
   canvas rectangle** `(offset, oldW × oldH)` (transparent there even where the artwork has holes), inserts it at index
   0 (bottom of the root) as a visible layer "Canvas Extension" with transform `(0, 0, W, H)`, `imageFile
   "<uuid>.png"`, a 96-px thumbnail. Mixed grow/shrink still adds it (only the grown bands are colored).
5. Undo "Canvas Size"; view refits; failure alert "Couldn’t change canvas size".

### 3.4 Crop apply (`Document/Crop.swift:236-248`)

**"Apply Crop (header button or Return with the Crop tool)"**:

```swift
func commitCrop() async {
    guard canStartProjectOperation, let rect = cropRect, CropGeometry.valid(rect),
          let snapshot = projectSnapshot() else { return }
    isProjectBusy = true
    defer { isProjectBusy = false }
    do {
        let result = try await CanvasResizer.shared.resize(snapshot,
            to: CanvasSizeOptions(width: Int(rect.width), height: Int(rect.height),
                contentOffset: CGPoint(x: -rect.minX, y: -rect.minY)))
        cropRect = nil
        applyDocumentSize(result, actionName: "Crop")
    } catch { cropError = error.localizedDescription }
}
```

- Canvas becomes `Int(width) × Int(height)` (truncation), every layer/placement/guide shifts by `−frame.origin`, no
  resampling, no extension layer (fill nil), content outside stays off-canvas, a frame past the edges enlarges the
  canvas (`CropTests.sameSizeOffsetCropAndExpansionUseExactBounds`). One undo step "Crop", view refits, selection
  dropped, `cropRect = nil` (frame back at the new full canvas; tool stays Crop).
- **"Failure"**: `cropError` → alert "Couldn’t crop" with the error text; `cropRect` is **kept** (the throw happens
  before it is cleared).
- With the frame equal to the canvas and no selection, nothing changes and no undo step is recorded.

### 3.5 Trim (`UI/TrimSheet.swift`, `Document/ImageTrim.swift`)

**"Image › Trim… (no default shortcut) opens a sheet"**: title bar "Trim", 320 pt wide, padding 24, spacing 18.

```
Trim                                  (.title2.bold)
Based On                              (.headline)
  ( ) Transparent Pixels              radio group, labels hidden, default Transparent Pixels
  ( ) Top Left Pixel Color
  ( ) Bottom Right Pixel Color
—
Trim Away                             (.headline)
  [x] Top        [x] Bottom           2 × 2 grid, h-spacing 24, v-spacing 8, all on
  [x] Left       [x] Right
—
Cancel (⎋)                 OK (↩, prominent; disabled when all four are off)
```

**"Behaviour"**:

1. `ImageExporter.shared.render(snapshot)`: the flattened composite exactly as exported (adjustments, effects,
   masks, clipping; hidden layers excluded).
2. Drawn into an 8-bit sRGB premultiplied RGBA context (`BrushRaster.context`).
3. Transparent Pixels: `brush_alpha_bounds` (`Rendering/BrushPixels.c:3-21`) — per row, the first and last pixel with
   alpha ≠ 0; `left`/`right` (exclusive) over all rows, `top` = first row with content, `bottom` = last + 1. All
   transparent → nil.
4. Color modes: reference = the pixel at (0, 0) or (W−1, H−1) of that buffer; a pixel "matches" when each of the
   **premultiplied** R, G, B, A differs by ≤ `tolerance` (0, not exposed). Bounds of the non-matching pixels, same
   scan. Everything matches → nil.
5. Unchecked sides keep the full extent: `minX = left ? l : 0`, `minY = top ? t : 0`, `maxX = right ? r : W`,
   `maxY = bottom ? b : H`; empty → nil.
6. nil → **no change, no message** (`ProjectController.trim` returns quietly). The full canvas → snapshot unchanged.
   Otherwise `CanvasResizer` with `contentOffset = (−minX, −minY)` and the trimmed size; undo "Trim"; refit; selection
   dropped. Thrown errors → alert "Couldn’t trim image".

### 3.6 Rotate and flip the canvas

**"Rotate Canvas 90° Clockwise"** / **"Counterclockwise"** (`Document/CanvasRotation.swift:34-61`):

```swift
commitTransform(); cancelCrop()
guard canEditLayers, let document else { return }
finishOpacityEdit()
beginEdit(clockwise ? "Rotate Canvas 90° Clockwise" : "Rotate Canvas 90° Counterclockwise")
// every layer (folders included): transform.quarterTurned; every mask placement too
// new CanvasDocument(width: H, height: W, same id, resolution, guides turned)
// selection: path transformed by
//   cw:  CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: H, ty: 0)
//   ccw: CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: W)
viewport.fit(...); endEdit()
```

`quarterTurned` (`:7-13`): the center moves to `(H − cy, cx)` (cw) or `(cy, W − cx)` (ccw); size kept; `rotation =
(rotation ± 90).truncatingRemainder(dividingBy: 360)` (sign kept: 300 → 30 cw, −90 → −180 ccw, **measured**).
Guides (`:18-27`): vertical cw → horizontal at the same position; vertical ccw → horizontal at `W − p`; horizontal cw →
vertical at `H − p`; horizontal ccw → vertical at the same position.

**"Flip Canvas Horizontal"** / **"Vertical"** (`Document/LayerFlip.swift:55-79`): `commitTransform(); cancelCrop()`;
guard `canEditLayers`; undo "Flip Canvas Horizontal" / "Flip Canvas Vertical"; every layer transform and mask
placement `mirrored(horizontally:across: W/2 or H/2)`; selection mirrored by `(−1, 0, 0, 1, W, 0)` or
`(1, 0, 0, −1, 0, H)`; guides perpendicular to the flip mirrored (`position = 2·center − position`). No refit.

```swift
func mirrored(horizontally: Bool, across axis: CGFloat) -> LayerTransform {
    var result = self
    if horizontally { result.flipX.toggle(); result.origin.x = 2 * axis - center.x - size.width / 2 }
    else            { result.flipY.toggle(); result.origin.y = 2 * axis - center.y - size.height / 2 }
    result.rotation = -rotation
    return result
}
```

- All four menu items are disabled unless `canEditLayers` (so not while a crop frame, a transform, a gradient, a
  filter, Levels, Hue/Saturation, a pixel move or a stroke is pending), `CompositorApp.swift:317-327`.
- **"Rotate/Flip commit a pending transform and cancel a pending crop first"**: the calls exist, but from the menu
  they are unreachable because the items are disabled in exactly those states (2.9).

---

## 4. Transform

### 4.1 The edit model

`TransformEdit` (`Document/LayerTransform.swift:108-124`): `layerID`, `draft`, `persistent`, `floating` (Transform
Selection, `selection.md` 5.8), `corners: [CGPoint]?` (distortion, document px, TL TR BR BL), `mask` (an unlinked mask
transformed alone), `group: TransformGroup?` (`box` at edit start + each member's original transform), `fromFields`.

| Function | Behavior | Ref |
|---|---|---|
| `beginTransform(persistent: = true)` | `cancelCrop()`; guard no edit and `canTransform`; `tool = .move`; group → `draft = groupTransformBox`, `group = (box, originals)`; else `draft = layer.transform` or, for an unlinked mask with the mask selected, `layer.maskTransform` with `mask: true` | `Document/EditorSession.swift:445-460` |
| `previewTransform(v)` | `draft = v` only if `v.isValid` and an edit is open | `:461-464` |
| `beginDistort()` | if no corners yet and draft valid: a **persistent** copy of the edit with `corners = DistortWarp.corners(of: draft)` | `Document/Distort.swift:264-268` |
| `previewCorners(c)` | only while distorting and `DistortWarp.isUsable(c)` | `Document/Distort.swift:271-274` |
| `commitTransform()` | clears snap guides and blend preview, finishes an opacity edit; `transformEdit = nil`; floating → merge or restore; mask → `commitMaskTransform`; corners → `commitDistort`; group → "Transform Layers"; else "Transform Layer" | `Document/EditorSession.swift:484-525` |
| `cancelTransform()` | clears guides; `transformEdit = nil`; removes Option-drag copies (and closes their outer edit); floating → restore | `:526-539` |
| `nudgeLayer(dx, dy)` | opens a non-persistent edit if none, moves the draft (and corners), commits it if it opened it | `:570-579` |

`canTransform` (`:356-361`): `canEditLayers` and either (group) `!groupTransformMembers.isEmpty`, or the active layer
has pixels, is not a folder and is effectively visible. **"Transform targets only layers with pixels that are visible
and not folders (adjustment layers cannot be transformed); requires canEditLayers"**. `canEditLayers` is false while
any transform edit is open, so `canTransform` is false during an edit.

Who commits and who cancels:

| Event | Effect | Ref |
|---|---|---|
| Mouse-up after a handle/body drag | `commitTransform()` if the edit is not persistent | `Rendering/EditorCanvas.swift:2165-2170` |
| A field edit finishing (label drag released, field loses focus) | `commitTransform()` if `fromFields` | `UI/TransformInspector.swift:84-88` |
| A canvas press while a `fromFields` edit is open | commits it first, then a new drag edit starts | `Rendering/EditorCanvas.swift:2628` |
| ↩ / keypad Enter on the canvas or in the Layers list | `commitTransform()` | `:2252-2254`, `UI/NativeLayerList.swift:787-788` |
| Apply button | `commitTransform()` | `UI/TransformInspector.swift:56` |
| Selecting another layer / another tool | commit | `Document/EditorSession.swift:391, 398` |
| Rotate/Flip canvas, Flip Layer, Save, Canvas/Image Size, Trim, Option-drag duplicate | commit first | 3.1, 3.6, 4.11, `:467` |
| ⎋ on the canvas or in the Layers list, Cancel button | `cancelTransform()` | `Rendering/EditorCanvas.swift:2249-2251`, `UI/NativeLayerList.swift:785-786` |
| Canvas losing focus mid-drag | draft reset to the drag's original; a non-persistent edit is cancelled | `Rendering/EditorCanvas.swift:2341-2346` |

No-op commits record nothing (`DocumentHistory.end`, `Document/DocumentHistory.swift:66-68`).

### 4.2 Box and handles

**"Transform box drawn in the accent color around the active pixel layer … or around the whole multi-layer/folder
selection; 8 white square handles"** — `TransformOverlay.geometry` (`Rendering/TransformOverlay.swift:64-81`):

- Only with the Move tool and `showsTransformControls || transformEdit?.persistent == true` (a ⌘T or distortion box
  shows even with Show Controls off).
- Group (`transformEdit?.group != nil`, or no edit and `transformsAsGroup`): the distortion corners if distorting,
  else `transformEdit?.draft ?? groupTransformBox`.
- Single: only if the active layer has pixels, is not a folder and is effectively visible; the distortion corners when
  this layer's edit is distorting, else `editedTransform(for:)` (the draft, the group box, or the mask transform).

Drawing (`:348-375`), in view points:
1. One path: closed outline through handles 0, 2, 4, 6, plus (when `showsRotation`) a stick from handle 1 to the
   rotation handle. Stroked 1 pt `NSColor.controlAccentColor` (no dark halo).
2. Each handle: `7 × 7` rect centered on it, white fill, 1 pt accent stroke.
3. **"Rotation handle: round handle 28 pt beyond the top-middle handle, joined to it by a line; hidden while
   distorting"**: `(handles[1].x + sin(r) × 28, handles[1].y − cos(r) × 28)`, an `8 × 8` circle, white fill, accent
   stroke. For a distortion `showsRotation = false`.

Distortion geometry (`:17-24`): handles = `[c0, mid(c0,c1), c1, mid(c1,c2), c2, mid(c2,c3), c3, mid(c3,c0)]`, midpoints
taken **in view space**.

**"Hit zones: 10 pt around each handle and along each whole edge (edges resize as their midpoint handle)"**
(`:26-41`): rotation handle first (if shown), then the 8 handles in order, then the segments 0→2, 2→4, 4→6, 6→0 (a
perpendicular distance ≤ 10 with the projection inside the segment) mapping to handles 1, 3, 5, 7. The box interior is
not a hit. Ported in `media/transform.js` (`geometry`, `hit`).

Cursors (`Rendering/EditorCanvas.swift:1645-1666`, also `ui.md` 5.6): resize cursor by the box angle; over a handle with
⌘ held, or any handle while distorted, the "distort" cursor (a plain white arrow with a black outline,
`:200-201`); rotation handle `arrow.triangle.2.circlepath`; a press that would drag a layer: move cursor (⌥: duplicate
cursor). The cursor is locked for the whole drag.

### 4.3 Drag math

Already ported (`media/transform.js` `updated`; upstream `Document/LayerTransform.swift:153-214`). Checklist lines and
the rules to keep:

- **"Move: drag the body; Shift locks to the dominant axis"**: `origin += Δ`; ⇧: `|dx| ≥ |dy|` keeps x, else y.
- **"Resize: … the opposite side is the anchor; lock-ratio state (link toggle) applies, Shift inverts it for the
  drag; corner proportional scaling projects onto the diagonal"**: proportional when `locksTransformRatio != ⇧`.
  Corner factor `max(1 / min(w, h), (localX·sx·w + localY·sy·h) / (w² + h²))`; edge factor from that axis.
- **"Option-resize scales from the center"**: anchor (0.5, 0.5) and span 2.
- **"Dragging a handle past the opposite side flips the layer on that axis instead of collapsing"**: negative raw
  size toggles `flipX`/`flipY`, size stays ≥ 1, the box is placed on the other side of the anchor.
- **"Rotate: drag the rotation handle; rotation is clockwise about the box center; Shift snaps to 15° steps"**:
  `rotation += atan2(p − c) − atan2(start − c)` in degrees; ⇧ rounds the total to a multiple of 15.
- **"Drags land on whole pixels and whole degrees; typed values stay exact"**: `.rounded()` after every drag update,
  before move snapping.
- Results that are not `isValid` return the original (no change for that event).
- **"Handle drags apply on mouse-up as one undo step "Transform Layer" (no Apply needed)"**: the drag edit is
  non-persistent (4.1). Undo names: "Transform Layer", "Transform Layers" (group), "Transform Layer Mask" (unlinked
  mask alone), "Duplicate Layer"/"Duplicate Layers" when ⌥ was held at the press (the duplicate's outer edit swallows
  the transform; `Document/EditorSession.swift:466-483`, `Document/DocumentHistory.swift:53-75`).
- **"Non-destructive"**: commit only writes the transform (and mask placement / shape redraw, 4.5). **Validity**
  1…300,000 px per side and `|origin| ≤ 1,000,000`, any finite rotation.

### 4.4 Snapping during transform

- **"Moving snaps the layer's bounding box left/center/right and top/middle/bottom to targets within 10 screen
  points, each axis independently"**: after rounding; `moving` = the edited layer, or all group members
  (`Rendering/EditorCanvas.swift:2009-2011`). Not applied to rotation, distortion corners, or with ⌃ held.
- **"Resizing snaps the dragged edge(s) to targets for upright (unrotated) layers only; proportional resize snaps
  only the nearer edge"**: 1.3. The group box is upright, so group resizes snap.
- Targets: 1.2 with centers. Snapping can produce `.5` origins because centers of odd sizes are half-integers (quirk
  10.7).

### 4.5 Commit of a single layer

`Document/EditorSession.swift:516-524`:

```swift
guard edit.draft.isValid, let index = ... else { return }
beginEdit("Transform Layer")
if let mask = document?.layers[index].mask, let old = document?.layers[index].transform {
    document?.layers[index].mask?.placement = mask.placement(movingLayer: old, to: edit.draft)
}
document?.layers[index].transform = edit.draft
redrawShape(at: index)
endEdit()
```

**"Linked masks follow the layer; an unlinked mask stays where it is on the document"** —
`LayerMask.placement(movingLayer:to:)` (`Document/LayerMask.swift:54-59`):

```swift
guard asset.image.width > 1 || asset.image.height > 1 else { return nil }     // a uniform mask looks the same anywhere
let moved = isLinked ? placement.map { $0.following(from: old, to: new) } : (placement ?? old)
return moved.flatMap { $0.samePlacement(as: new) ? nil : $0 }                 // equal to the layer (any sampling) → nil
```

So: linked without placement → stays nil (follows the pixel grid); linked with placement → carried by `following`;
unlinked → keeps its placement, or gets `old` (the layer's previous transform) when it had none; a result equal to the
new layer placement is normalized to nil.

**"Shape layers redraw their shape at the new size after a transform so rounded corners keep their radius"** —
`redrawShape(at:)` (`Document/ShapeTool.swift:203-216`): for a layer with a live shape, when
`max(1, round(size))` differs from the image's pixel size and fits `maxShapePixels`, the shape is drawn again at that
size; a mask without a placement first gets `placement = layer.maskTransform`, which at that point is the **new**
transform (the layer's transform was already replaced). During the drag, a rounded rectangle is previewed redrawn at
the drag size (≤ 2048 px, radius scaled) (`:218-235`).

### 4.6 Multi-layer and folder transform

**"Several selected layers, or a selected folder, transform together in one upright box around the visible pixel
layers selected and inside selected folders (nested up to 64 levels)"** (`Document/EditorSession.swift:363-386`):

```swift
var transformsAsGroup: Bool { selectedLayerIDs.count > 1 || (selectedLayerIDs.count == 1 && activeLayer?.isGroup == true) }
var groupTransformMembers: [ImageLayer] {   // document order (bottom to top)
    layer.asset != nil, !layer.isGroup, effectively visible, and the layer or one of its ancestors (≤ 64 steps) is selected
}
var groupTransformBox: LayerTransform? {    // upright bounds of all members' corners, sides at least 1
    LayerTransform(origin: (minX, minY), size: (max(1, maxX − minX), max(1, maxY − minY)))
}
```

**"Each member follows the box … shear dropped; masks follow; one undo step "Transform Layers""** (`:501-515`):
for every member, `moved = original.following(from: group.box, to: edit.draft)`; skipped if invalid; its mask
placement becomes `mask.placement(movingLayer: original, to: moved)`; transform set; `redrawShape`. The box itself is
not stored: after the commit the next box is recomputed upright around the members, so a rotated group shows rotation
0 again.

Previews and other consumers use `pendingTransform(for:)` = `group.originals[id].following(from: box, to: draft)`
(`:565-569`).

**"Press inside the group box drags all of them; outside it too unless Auto Select finds another layer there"**
(`Rendering/EditorCanvas.swift:1679-1711, 2610-2621`): `picks = (no edit open)`, `autoSelect = transformAutoSelect XOR
⌘`. First, with `picks`, ⌘ held, a layer under the pointer and (⇧ held or the Auto Select setting off): ⌘⇧ toggles that
layer in the selection (`extendSelection`), plain ⌘ selects it alone; either way it is dragged (this rule wins even
inside the box). Then: if the box contains the point, or `!(picks && autoSelect)`, or nothing is under the pointer →
drag the group. Otherwise the layer under the pointer is selected alone and dragged.

**"Scale % of a group is relative to the group box at edit start"**: `transformPixelSize` returns `group.box.size`
during an edit and `groupTransformBox.size` without one (`:541-548`); at rest the group shows 100%.

Group flips and duplicates: the Move bar's Flip H on a group toggles the **box's** `flipX`; members receive it through
`placing`, which keeps their `flipX` and expresses the mirror as `rotation ±180` and `flipY` (quirk 10.9). Layer › Flip
Layer mirrors members directly (4.11). ⌥-drag duplicates all selected roots with their descendants
(`beginDuplicateTransform`, `:466-483`).

Dependency: the board has no multi-selection yet (`selectedLayerIDs`). It is specified in `ui.md` 7.4 (⌘-click,
⇧-click rows) and 5.2 (⌘⇧-click on the canvas).

### 4.7 Free distort

**"Cmd-drag a transform handle starts free distortion … once distorted, plain handle drags keep distorting"**
(`Rendering/EditorCanvas.swift:2630-2636`):

```swift
if case .resize(let index) = mode, modifiers.contains(.command) || session.transformEdit?.corners != nil {
    session.beginDistort()
    if session.transformEdit?.corners != nil { mode = .distort(index) }
}
transformDrag = TransformDrag(original: transform, start: pixel, mode: mode, originalCorners: session.transformEdit?.corners)
```

Only handle and edge hits (`.resize`) become distortions; ⌘ on the rotation handle rotates, ⌘ on the body flips Auto
Select. Group edits and unlinked-mask edits distort too; Transform Selection's floating pixels distort the same way
(`selection.md` 5.8).

**"Corner handle moves its corner; edge-midpoint handle moves both corners of that edge; dragging the body moves the
whole shape"** and **"Shift locks the dragged corner(s) to one axis"** (`Document/LayerTransform.swift:136-151`):

```swift
var dx = point.x - start.x, dy = point.y - start.y
if shift { if abs(dx) >= abs(dy) { dy = 0 } else { dx = 0 } }
let moved: [Int]
switch mode {
case .distort(let index): moved = index.isMultiple(of: 2) ? [index / 2] : [index / 2, (index / 2 + 1) % 4]
case .move: moved = [0, 1, 2, 3]
default: return nil
}
for corner in moved { result[corner].x += dx; result[corner].y += dy }
```

Corners are **not rounded and not snapped**. Each event calls `previewCorners`, which ignores shapes that are not
`isUsable` (the corners stay at the last usable shape).

**"Distortion waits for Apply (Return) / Cancel (Escape) rather than applying on mouse-up; numeric fields disabled and
rotation handle hidden while distorted"**: `beginDistort` makes the edit persistent; the Move bar disables its fields
when `corners != nil` (`UI/TransformInspector.swift:45-46`); Apply/Cancel appear. Arrow nudges move the draft **and**
all four corners (`Document/EditorSession.swift:577`). Cancel reverts everything in the edit, including moves and
scales made before the distortion began in the same edit.

Shape tests (`Document/Distort.swift:16-38`):

```swift
static func isUsable(_ c: [CGPoint]) -> Bool {   // 4 finite corners within ±1,000,000, both halves with area
    abs(area(c[0], c[1], c[2])) > 0.01 && abs(area(c[0], c[2], c[3])) > 0.01
}
static func isConvex(_ c: [CGPoint]) -> Bool {   // usable, and all four turn crosses > 0.01 in magnitude with one sign
}
```

A bow tie or a dented quad is usable but not convex ("folded"); a collapsed corner is not usable.

**"Live preview at up to 2048 px, with layer effects (stroke, shadow) warped along so they stay visible during the
drag"**: upstream draws a convex distortion of a layer whose mask is linked and unplaced on the GPU at full detail
(`Rendering/GPUCanvas.swift:441-465`, `CIPerspectiveTransformWithExtent` on the clamped image, cut by a warped white
square; Nearest sampling honored); everything else uses `distortPreview` (`Document/Distort.swift:315-346`): a CPU warp
at most 2048 px on the long side, its mask warped or resampled along, cached by corners. Layers with effects draw
their effects image warped along (`distortedEffects`, `:296-313`). Section 7.3 specifies the board's version.

**"Apply resamples pixels: convex shapes warp in perspective; folded/dented shapes warp as two triangles; collapsed or
twisted shapes are ignored; result cropped to visible pixels as an axis-aligned layer"** —
`DistortWarp.warp` (`:90-121`) and `warpTrimmed` (`:161-179`):

1. `bounds = (floor(min x), floor(min y), ceil(max x) − minX, ceil(max y) − minY)` of the corners; must be ≥ 1, each
   side ≤ 30,000 and the area ≤ 200,000,000 (else `ProjectError.tooLarge`). `placed = LayerTransform(origin:
   bounds.origin, size: bounds.size, sampling: transform.sampling)` (rotation 0, no flips).
2. `target = imageCorners(corners, flipX, flipY)`: image corner `(x, y) ∈ {0,1}²` goes to box corner
   `[0, 1, 3, 2][v·2 + u]` with `u = flipX ? 1−x : x`, `v = flipY ? 1−y : y`.
3. Convex: `CIImage(cgImage:)` → `CIPerspectiveTransform` with `inputTopLeft…inputBottomLeft = ((p.x − minX)·k,
   (maxY − p.y)·k)`, rendered into `W × H` 8-bit sRGB premultiplied through a `CIContext` with **no working color
   space** (interpolation on the stored sRGB values), default **linear** sampling whatever the layer's sampling
   (quirk 10.10). Pixels outside the source are transparent, so edges are soft over about one source pixel.
4. Folded: `warpFolded` (`:125-156`) draws two halves, image (TL, TR, BR) → target (TL, TR, BR) and image (TL, BR, BL) →
   target (TL, BR, BL), each by the affine map of its three points, clipped to its triangle **without antialiasing**,
   drawn with `BrushRaster.draw` = **nearest-neighbor** sampling and `.copy` blending (quirk 10.10).
5. `warpTrimmed`: alpha bounds of the warp (`brush_alpha_bounds`); if non-empty and smaller than the warp, the image
   is cropped and the transform moved/resized to the crop. Nothing visible → the uncropped warp.

**"16-bit layers are warped at 16 bits and stay 16-bit"** (`:373-377`): `DeepLayer.flattened(source)` is warped with
`sixteenBit: true` and stored through `DeepLayer.asset`.

**"Masks"** (`:378-404`): a linked mask without placement is warped with the same transform and corners (`isMask`,
gray) and cropped by the same crop (a uniform 1 × 1 mask passes through unchanged); a linked mask with its own
placement takes `placement.following(old → draft)`, its corners `carried(...)`; if convex, it is warped with
`warpMask` (its background tone outside the shape) into its own new placement, linked; otherwise, and for an unlinked
mask, the mask keeps its place: `placement = original.placement ?? layer.transform` (the layer's pre-edit transform).

**"Multi-layer/folder distort: every member takes the same perspective as the box; undo "Distort" or "Distort
Layers""** (`:276-290, 348-368`): for a group, each member's target is
`transform = original.following(from: box, to: draft)` and `corners = DistortWarp.carried(transform, by: draft, to:
shape)`; members whose carried corners are not usable are skipped (and keep their **original** transform, quirk
10.11). One undo step "Distort" (single) or "Distort Layers" (group); an unlinked mask alone: "Distort Layer Mask"
(`Document/LayerMask.swift:348-370`). Per-layer failures land in `brushError` ("Couldn’t paint" alert) and the other
members still commit.

```swift
static func carried(_ placement: LayerTransform, by transform: LayerTransform, to corners: [CGPoint]) -> [CGPoint] {
    let toUnit = CGAffineTransform(translationX: -0.5, y: -0.5)
        .concatenating(CGAffineTransform(scaleX: transform.size.width, y: transform.size.height))
        .concatenating(CGAffineTransform(rotationAngle: transform.radians))
        .concatenating(CGAffineTransform(translationX: transform.center.x, y: transform.center.y)).inverted()
    let map = homography(corners)
    return self.corners(of: placement).map { map($0.applying(toUnit)) }
}
```

`toUnit` ignores the draft's flips, matching `corners(of:)` (which ignores flips too).

### 4.8 Move bar (`UI/TransformInspector.swift`)

Layout (one row, 42 pt high, spacing 12): title "Transform" (or "Transform Mask" when the edit or selection targets an
unlinked mask), toggles "Auto Select" and "Show Controls" (`ui.md` 1.6), then a horizontally scrolling group with no
scroll indicators, then the Apply/Cancel pair. The whole view is rebuilt when the active layer changes
(`.id(session.activeLayerID)`, `ContentView.swift:30`).

The value shown is `transformEdit?.draft ?? editedTransform(for: activeLayer) ?? (0, 0, 1, 1)`.

| Control | Label / range / step | Change | Ref |
|---|---|---|---|
| **"X field"** | caption "X", width 85; scrub range −30,000…30,000 | `origin.x = n` | `:22, 67-70` |
| **"Y field"** | "Y", 85 | `origin.y = n` | `:23` |
| **"W field"** | "W", 85; scrub 1…30,000 | ignored if `n < 1`; link on: `height *= n / width`; `width = n` (origin kept) | `:24, 89-100` |
| **"H field"** | "H", 85; scrub 1…30,000 | ignored if `n < 1`; link on: `width *= n / height`; `height = n` | `:25` |
| **"Link (lock aspect ratio) toggle"** | button-style toggle, SF `link`; help "Lock aspect ratio. Hold Shift while dragging a handle to turn it the other way." Shows `locksTransformRatio != ⇧ held`; default on, **not persisted** | toggles `locksTransformRatio` | `:26-29`, `Document/EditorSession.swift:197` |
| **"Scale field"** | caption "Scale", suffix "%", width 110; scrub 0.1…30,000; help "Scale width and height together, about the center" | ignored if `n ≤ 0`; `scaled(toPercent: n, pixelSize:)` (both sides = pixelSize × n/100 about the center) | `:30-35`, `Document/LayerTransform.swift:42-50` |
| **"Angle (°) field"** | caption "°" **before** the field (scrubbable), width 75; scrub −360…360 | `rotation = n.truncatingRemainder(dividingBy: 360)` (sign kept: 450 → 90, −450 → −90) | `:36` |
| **"Sampling picker"** | pop-up "Sampling", 170 pt: Nearest, Smooth, High quality | `sampling = value` | `:37-41` |
| **"Flip H button"** | "Flip H" | `flipX.toggle()` (in the layer's own frame) | `:42` |
| **"Flip V button"** | "Flip V" | `flipY.toggle()` | `:43` |

- Scale's 100% (`pixelSize`, `:64-66`) = `transformPixelSize ?? activeLayer.size ?? value.size`: the group box at edit
  start; the floating pixels' size; the image's pixel size; for a mask edit or a blank layer, the layer's size before
  the edit.
- **"Field label scrubbing"**: sensitivity 1 per point, step 1, clamped to the ranges above, `onEnd` = finish.
- **"Field arrow stepping"**: while a field has focus, ↑/↓ change by 1, ⇧ by 10, applied immediately and written back
  formatted (`ContentView.swift:411-436`). **Typed and stepped values are not clamped** to the scrub ranges; only
  `isValid` limits them (W, H ≥ 1 and ≤ 300,000; `|X|, |Y| ≤ 1,000,000`).
- **"Live field edits"** (`:71-88, 126-128`): every keystroke that parses (`Double(text)`, finite) previews through
  `change`, which opens a **non-persistent** edit with `fromFields = true` if none is open. The edit is committed as one
  undo step when the field loses focus (↩, Tab, a click elsewhere, **and ⎋**: both ↩ and ⎋ hand focus back to the
  canvas, `ContentView.swift:402-408`), when a label scrub ends, or by any commit in 4.1. "A pending Cmd-T/distort edit
  absorbs them instead": with a persistent edit open, field changes just move its draft.
- The Sampling picker and Flip H/V call `change` **without** a finish: their edit stays open (invisible Apply/Cancel,
  Undo disabled) until the next canvas press, ↩, a tool or layer switch, or any other commit; ⎋ on the canvas reverts it
  (quirk 10.8).
- **"Number formatting"** (`:141-144`): `abs(v − v.rounded()) < 0.005 ? String(Int(v.rounded())) : String(format:
  "%.2f", v)`. No grouping. `%.2f` rounds exact binary ties to even (1.125 → "1.12"), unlike JS `toFixed` ("1.13").
- **"Fields disabled when nothing can be transformed or while distorted"**: `.disabled((!canTransform &&
  transformEdit == nil) || transformEdit?.corners != nil)` on the whole field group (the link, picker and flips
  included).
- **"Cancel (Escape) and Apply (Return) buttons appear only for edits that wait for them"** (`:49-60`): "Cancel"
  (⎋ key equivalent) and "Apply" (↩) are always laid out, at opacity 1 and hit-testable only when `transformEdit?.persistent
  == true`, else opacity 0 and not hit-testable (so ↩/⎋ still reach a drag); 0.12 s ease-out fade; both disabled with
  no edit.

### 4.9 Commands and persistent edits

**"Layer › Transform Layer (Cmd-T)"** (`CompositorApp.swift:351-352`, `Document/FloatingSelection.swift:21-25`): titled
"Transform Selection" when `canTransformSelection`, else "Transform Layer"; ⌘T; disabled when
`!canTransform && !canTransformSelection`. With a selection it floats the pixels (`selection.md` 5.8), otherwise
`beginTransform()` (persistent): Move tool, box shown even with Show Controls off, Apply/Cancel visible. Works for a
single layer, a group/folder (box) and an unlinked mask (title "Transform Mask").

**"Return/Enter applies and Escape cancels the pending transform (canvas keys)"**: 4.1. In the canvas key order these
come after lasso, shape, gradient, crop and guide-drag handling (`Rendering/EditorCanvas.swift:2225-2254`).

**"Selecting another layer or tool commits a pending transform"**: 4.1. While a persistent edit is open the Layers
panel is grayed and canvas presses never pick another layer (`picks = transformEdit == nil`), so in practice a tool
switch (rail or key) or Apply ends it.

**"While a persistent transform is pending, Undo/Redo menu items act only on text fields, and the Layers panel greys
out"** (`CompositorApp.swift:29-38`, `Document/EditorSession.swift:692-697`): the Edit menu shows plain "Undo"/"Redo"
that only send `undo:`/`redo:` to a focused text view. For any open edit (persistent or not) `canUseHistory` is false,
so the normal Undo/Redo items are disabled (`:650-656`).

### 4.10 Keyboard

**"Arrow keys with the Move tool nudge the layer (or selected layers/folder) 1 px; Shift+arrow 10 px; each nudge is
its own undo step unless a transform is pending, where it moves the draft (and distortion corners)"**
(`Rendering/EditorCanvas.swift:2268-2272`, `Document/EditorSession.swift:570-579`): no ⌘/⌃/⌥; Move tool; checked after
⌘-arrow pixel moves and selection-tool outline nudges. Undo names as for a drag ("Transform Layer", "Transform
Layers", "Transform Layer Mask"). The Layers list handles the same arrows while it has focus and the tool is Move or an
edit is open (`UI/NativeLayerList.swift:809-813`). A nudge is not snapped.

### 4.11 Flip Layer

**"Layer › Flip Layer Horizontal"** / **"Vertical"** (`CompositorApp.swift:384-387`, `Document/LayerFlip.swift:24-51`):
`commitTransform()`; guard `canTransform`; members = the group members (axis = the box center) or the active layer
(axis = its own center); `finishOpacityEdit()`; undo "Flip Horizontal" / "Flip Vertical"; each member
`mirrored(horizontally:across: axis)` (flip toggled, `rotation = −rotation`, center mirrored); masks
`mask.placement(movingLayer: old, to: flipped)`. Disabled unless `canTransform`. No shape redraw (size unchanged).
For a rotated layer this differs from the Move bar's Flip H, which keeps the angle and mirrors in the layer's own
frame.

### 4.12 Unlinked mask transformed alone

When the mask thumbnail of a layer with an **unlinked** mask is selected, `beginTransform` edits
`layer.maskTransform` (`mask.placement ?? layer.transform`) with `mask: true`; the title reads "Transform Mask"; Scale's
100% is the layer size. Commit (`Document/LayerMask.swift:348-381`): `placement = draft.samePlacement(as: layer) ? nil :
draft`; nothing if unchanged; undo "Transform Layer Mask". A distorted mask: `warpMask` with the mask's background
tone, new asset and placement, undo "Distort Layer Mask". The live preview resamples the warped mask into the layer's
grid (`maskDistortPreview`, `:385-402`).

---

## 5. Board: what exists, and divergences to fix

Ported and correct against upstream (verified line by line): `TransformTool.updated`, `rounded`, `isValid`, `point`,
`contains`, `corners`, `geometry`, `hit`, `resizeCursor`, `snappedMove`, `snappedResizePoint`, `snappedPoint`,
`placing`, `following` (`media/transform.js`); handle and box drawing (`media/view.js:191-209`); press dispatch with
Auto Select and ⌘ (`media/view.js:655-699`); floating Transform Selection (affine only).

Divergences found:

| # | Where | Board | Upstream | Fix |
|---|---|---|---|---|
| D1 | `media/board.js:692-718` `commitTransform` | mask placement only updated for linked + placed masks | `placement(movingLayer:)`: unlinked mask without placement gets `old`; uniform 1 × 1 masks never get a placement; results equal to the layer normalized to nil (4.5) | Port `placement(movingLayer:)` and use it for transforms, nudges, flips |
| D2 | same, shape branch | a grid-following mask gets `maskPlacement = old` | `= layer.maskTransform` after the transform was replaced, i.e. the **new** transform (4.5) | Use `draft` |
| D3 | `media/board.js:1291-1295`, menu `:1098` | ⌘T without a selection only selects the Move tool | persistent edit with Apply/Cancel (4.9) | Section 6 state machine |
| D4 | `media/board.js:381-414` `applyTransformField` | clamps typed X/Y/W/H/Scale; angle `((v % 360) + 360) % 360`; commits on `change` only; every change is its own undo step | no clamp on typed/stepped values (only `isValid`); angle keeps its sign; live preview per keystroke, commit on focus loss (↩ **and ⎋**), scrub end; Flip/Sampling stay pending (4.8) | Port 4.8 |
| D5 | `media/board.js:25` `number` | `Number.isInteger(v) ? String(v) : v.toFixed(2)` | `|v − round(v)| < 0.005 ? String(round(v)) : %.2f` (12.004 → "12") | Port `formatted` (8.5) |
| D6 | `media/board.js:584-589` `snapTargets` | ignores View › Snap and Snap To, no grid, guides always | 1.2 | Port `alignmentSnapTargets` with the persisted toggles |
| D7 | `media/view.js:707-712` ⌥-drag | duplicate and transform are two undo steps | one step "Duplicate Layer(s)"; ⎋ mid-drag removes the copies | Wrap both in one history entry |
| D8 | `media/view.js:157-167` `transformBoxFor` | hidden whenever Show Controls is off | shown for a persistent edit even with Show Controls off | Add the persistent rule |
| D9 | `media/board.js:217-232` Move bar | "°" is a unit after the field; no "Transform Mask" title; no Apply/Cancel | "°" is the scrubbable caption before the field; title switches; Apply/Cancel pair (4.8) | Port |
| D10 | `media/board.js:1357-1366` arrows | always commits a step | moves a pending edit's draft (and corners) without committing (4.10) | Route through `nudgeLayer` |
| D11 | renderer `frameOf` (`media/render.js:128-132`) | clips every layer to the canvas | while cropping, draws over `canvas ∪ cropRect` (2.7) | Section 7.4 |
| D12 | view refit | `view.fit()` only on load | refit whenever the document size changes, including undo/redo of a size change (`Document/EditorSession.swift:669-679`) | Refit in `changed()` when `width`/`height` differ from the last render |

---

## 6. Board state machine to add (persistent edits, groups, distortion)

Mirror `EditorSession` exactly; do not invent states. Suggested shape, in `media/board.js` (or a new
`media/transform-edit.js`):

```js
// board.transformEdit = null | {
//   layerID,            // the active layer (a folder for a folder group)
//   draft,              // plain transform object (media/geometry.js)
//   persistent,         // ⌘T or a distortion: waits for Apply/Cancel
//   corners: null | [{x,y} × 4],   // TL, TR, BR, BL in document px, unrounded
//   mask: false,        // unlinked mask transformed alone
//   group: null | { box, originals: Map<id, transform> },
//   fromFields: false,
//   duplicate: null | { copies, source, primary, historyMark },  // ⌥-drag copies (D7)
// }
beginTransform(persistent = true) {
  this.cancelCrop();
  if (this.transformEdit || !this.canTransform()) return;
  this.setTool('move');                        // without the commit/cancel side effects of selectTool
  if (this.transformsAsGroup()) {
    const members = this.groupMembers(), box = this.groupBox(members);
    if (!box) return;
    this.transformEdit = { layerID: this.activeID(), draft: box, persistent, corners: null, mask: false,
      group: { box, originals: new Map(members.map((m) => [m.id, this.transformOf(m)])) }, fromFields: false };
    return;
  }
  const r = this.activeRecord();
  const maskAlone = this.isMaskSelected && r.maskFile && r.maskLinked === false;
  this.transformEdit = { layerID: r.id, draft: maskAlone ? this.maskTransformOf(r) : this.transformOf(r), persistent,
    corners: null, mask: maskAlone, group: null, fromFields: false };
}
previewTransform(v) { if (this.transformEdit && TransformTool.isValid(v)) this.transformEdit.draft = v; }
beginDistort() {
  const e = this.transformEdit;
  if (!e || e.corners || !TransformTool.isValid(e.draft)) return;
  e.persistent = true;
  e.corners = TransformTool.corners(e.draft);        // TL, TR, BR, BL
}
previewCorners(c) { if (this.transformEdit && this.transformEdit.corners && Distort.isUsable(c)) this.transformEdit.corners = c; }
nudgeLayer(dx, dy) {
  const open = Boolean(this.transformEdit);
  if (!open) this.beginTransform(false);
  const e = this.transformEdit; if (!e) return;
  this.previewTransform({ ...e.draft, x: e.draft.x + dx, y: e.draft.y + dy });
  if (e.corners) this.previewCorners(e.corners.map((p) => ({ x: p.x + dx, y: p.y + dy })));
  if (!open) this.commitTransform();
}
commitTransform() {           // see 4.1 for every caller
  this.view.guides = { xs: [], ys: [] };
  this.actions.finishOpacityEdit && this.actions.finishOpacityEdit();
  const e = this.transformEdit; if (!e) return;
  this.transformEdit = null;
  if (e.floating) return this.selectTools.commitFloating();          // selection.md 5.8
  if (e.corners) return this.engineTransformCommit(e);               // section 9: "Distort", "Distort Layers", "Distort Layer Mask"
  if (e.mask) return this.commitMaskPlacement(e);                    // "Transform Layer Mask", local
  if (e.group) return this.commitGroup(e);                           // "Transform Layers", local (following + D1 + shapes)
  return this.commitTransformLocal(e.layerID, e.draft, 'Transform Layer');   // existing, with D1/D2
}
cancelTransform() { this.view.guides = { xs: [], ys: [] }; const e = this.transformEdit; if (!e) return;
  this.transformEdit = null; if (e.duplicate) this.removeDuplicates(e.duplicate); if (e.floating) this.selectTools.cancelFloating(); }
```

Rules the board must enforce around it:

- `canEditLayers()` false while `transformEdit` or `cropRect` is set (plus the board's existing busy/filter/color
  range rules). `canTransform()` = `canEditLayers()` and (group ? members : active layer with pixels, not a folder,
  effectively visible).
- `layersLookEditable` false for a persistent edit or a pending crop: gray the Layers panel and ignore its clicks.
- Undo/Redo (`media/board.js` `undoRedo`, VS Code's ⌘Z callback) refuse while `transformEdit` is set. Undo during a
  pending crop is allowed and cancels the crop.
- `selectTool(t)`: on a real change, `commitTransform()`, `cancelCrop()`, then the existing draft cancels; entering
  Crop sets the frame (2.1). `select(id)` (layer) commits first.
- The webview flush before Save (`ProjectController.save` → `begin()`): commit the transform and cancel the crop
  before the extension writes the project (`docs/parity/features.md:1555`).
- Drags: a press calls `commitTransform()` if `fromFields`, then `beginTransform(false)` if no edit; ⌘ on a handle hit
  calls `beginDistort()` and switches the drag to `distort`; mouse-up commits only if `!persistent`; losing focus
  mid-drag restores `drag.original` and cancels a non-persistent edit.
- Group preview: draw each member at `following(original, box → draft)`; the overlay box is the draft.
- Move bar: bind to `transformEdit.draft` when open; `change(fn)` opens `beginTransform(false)` with `fromFields = true`
  when needed; `finish()` commits when `fromFields`.

---

## 7. Drawing distortions and the crop in the webview

### 7.1 Homography in JS (exact port of `DistortWarp.homography`)

```js
// Unit square (u right, v down) → quad c = [TL, TR, BR, BL] (Document/Distort.swift:56-73). Returns a row-major 3×3
// M with [X, Y, W]ᵀ = M · [u, v, 1]ᵀ and point = (X / W, Y / W).
function homography(c) {
  const sx = c[0].x - c[1].x + c[2].x - c[3].x, sy = c[0].y - c[1].y + c[2].y - c[3].y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = c[1].x - c[2].x, dx2 = c[3].x - c[2].x, dy1 = c[1].y - c[2].y, dy2 = c[3].y - c[2].y;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) > 1e-12) { g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den; }
  }
  return [c[1].x - c[0].x + g * c[1].x, c[3].x - c[0].x + h * c[3].x, c[0].x,
          c[1].y - c[0].y + g * c[1].y, c[3].y - c[0].y + h * c[3].y, c[0].y,
          g, h, 1];
}
const project = (M, u, v) => { const w = M[6] * u + M[7] * v + M[8];
  return { x: (M[0] * u + M[1] * v + M[2]) / w, y: (M[3] * u + M[4] * v + M[5]) / w }; };
function invert3(M) {                       // adjugate / determinant; null when singular
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
          B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
          C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
// DistortWarp.isUsable / isConvex / imageCorners / carried: port verbatim from Document/Distort.swift:16-38, 77-84,
// 183-190. carried: unit = toUnit(draft, p) with dx = p − center(draft), x = dx·cos r + dy·sin r,
// y = −dx·sin r + dy·cos r, u = x / w + 0.5, v = y / h + 0.5 (flips ignored); result = project(homography(Q), u, v).
```

For an image of `W × H` pixels shown through `draft` and distorted to `Q`, image pixel `(px, py)` lands at
`project(homography(Q), u, v)` with `s = px / W`, `t = py / H`, `u = flipX ? 1 − s : s`, `v = flipY ? 1 − t : t`
(equivalent to `imageCorners` + `CIPerspectiveTransform`, since a projective map of the unit square is fixed by its
four corners). The screen map is this followed by the view's affine document → screen transform.

### 7.2 Preview strategy

Draw the distorted layer into an `OffscreenCanvas` over its warp bounds `B` (2048-px long-side cap, as upstream's CPU
preview; `k = min(1, 2048 / max(Bw, Bh))`), then hand it to the existing renderer as an override
`{ canvas, toDocument: translate(B.x, B.y) · scale(Bw / canvas.width, Bh / canvas.height), transform: axis-aligned B }`.
This keeps blend modes, opacity, clipping and folder compositing in `media/render.js` unchanged. The commit is done by
the engine (section 9), so the preview only has to look right.

**WebGL2 (recommended for convex quads).** One quad covering the output canvas; per fragment:

```glsl
#version 300 es
precision highp float;
uniform sampler2D image;          // premultiplied RGBA (UNPACK_PREMULTIPLY_ALPHA_WEBGL = true, no color conversion),
                                  // CLAMP_TO_EDGE, LINEAR (NEAREST when the layer's sampling is "Nearest")
uniform mat3 docToUnit;           // invert3(homography(Q)), transposed for GLSL's column-major layout
uniform vec4 frame;               // B.x, B.y, Bw / outW, Bh / outH
uniform float outH;
uniform bvec2 flipped;            // draft.flipX, draft.flipY
out vec4 color;
void main() {
  vec2 doc = frame.xy + vec2(gl_FragCoord.x, outH - gl_FragCoord.y) * frame.zw;   // row 0 = top
  vec3 q = docToUnit * vec3(doc, 1.0);
  vec2 uv = q.xy / q.z;
  // Soft edge as upstream's GPU path (a white square warped with linear sampling): about one output pixel.
  vec2 fw = max(fwidth(uv), vec2(1e-6));
  vec2 inside = min(uv, 1.0 - uv) / fw;
  float coverage = clamp(min(inside.x, inside.y) + 0.5, 0.0, 1.0);
  vec2 st = vec2(flipped.x ? 1.0 - uv.x : uv.x, flipped.y ? 1.0 - uv.y : uv.y);
  color = texture(image, clamp(st, 0.0, 1.0)) * coverage;       // premultiplied out
}
```

Read it back with `transferToImageBitmap()` (or draw the WebGL canvas with `drawImage`) into the override canvas. Do
not convert color spaces: upstream interpolates stored sRGB values (`CIContext` working space `NSNull`).

**Canvas 2D fallback (convex).** Subdivide the unit square into `N × N` cells with `N = clamp(ceil(maxEdgeScreenPx /
24), 2, 32)`; for each cell map its four unit corners with `project`, and draw two triangles with an affine
`drawImage` (source triangle in image pixels via the flip mapping, destination triangle in output pixels), each
clipped to its destination triangle grown by 0.5 px to hide seams. The affine map from three points is upstream's
`affine(from:to:)` (`Document/Distort.swift:41-53`). Error versus true perspective shrinks with N; it is a preview
only.

**Folded quads (not convex, usable)** — always Canvas 2D, exactly as `warpFolded`: two triangles, image
`(0,0)-(W,0)-(W,H)` → target `TL, TR, BR` and image `(0,0)-(W,H)-(0,H)` → target `TL, BR, BL` (targets from
`imageCorners`), each `save(); clip(triangle); setTransform(affine); imageSmoothingEnabled = false;
globalCompositeOperation = 'copy'; drawImage(); restore()`. Upstream disables antialiasing on the clip; Canvas 2D
cannot, so the shared diagonal may blend slightly.

**Masks in the preview** (`Document/Distort.swift:315-346`): a linked mask without placement is warped with the same
mapping (its own pixel size) and applied as the override's mask; a linked mask with a placement uses
`carried(placement.following(old → draft), draft, Q)` if convex; otherwise, and for unlinked masks, the mask stays at
`maskPlacement ?? the layer's pre-edit transform` on the document. The renderer override needs two optional fields for
this: `maskAlpha` (already in the override canvas's grid) or `maskPlacement` (a document placement to apply instead of
the layer's), because `applyOwnMask` (`media/render.js:155-180`) currently derives everything from the record.

**Groups**: each member gets `transform_i = following(original_i, box → draft)` and `Q_i = carried(transform_i,
draft, Q)`; members with unusable `Q_i` are drawn undistorted at `transform_i`.

**Effects**: the board does not draw layer effects yet (`media/board.js` `unrenderedByLayer`); when it does, warp the
effects image with `carried(grown placement)` as `distortedEffects` does.

**Overlay for a distortion**: the box outline through the four corners (view space), handles at the corners and at
the view-space midpoints, no rotation handle; hit testing as 4.2 with these eight points.

### 7.3 Between Apply and the engine's answer

Keep the warped override until the engine's saved project arrives through `pushExternal` (one history entry named
by `editName`), then drop it, as upstream seeds the effects preview to avoid a blink (`Document/Distort.swift:357-365`).
On an engine error, drop the override, restore the layer, and show the error.

### 7.4 Crop overlay and renderer region

- While the Crop tool is active, render the composite over `canvas ∪ cropRect` (the visible frame): extend
  `Renderer.frameOf`'s clip rectangle and the view's canvas background (shadow, 10 pt checkerboard) to that union.
- Overlay order: crop overlay (2.7), then selection ants, then snap lines. Crop handles are `8 × 8` white with black
  stroke; transform handles are `7 × 7` white with accent stroke.
- Re-run the crop drag update on `keydown`/`keyup` of Alt and Control with the last pointer position.

---

## 8. Sheets, fields and formatting in the webview

### 8.1 Sheets as board panels

Use the board's existing floating panel (`media/board.js:1134-1171`, `board.panel(title, body, setup, onCancel)`), but
make it modal for the canvas: no canvas edits while it is open (upstream holds `isProjectBusy` for the sheet's
lifetime). ↩ = OK/Resize (only when enabled), ⎋ = Cancel. Commit the focused field's text before running OK.

### 8.2 Units, scrubbing, validity

Port the formulas in 3.2 and 3.3 verbatim, keeping internal state in pixels (`Double`) and displaying in the unit.
Scrub labels: `cursor: ew-resize`, pointer capture, `value = clamp(round((start + dx × sensitivity) / step) × step)`.

### 8.3 Parsing typed numbers

- Move bar fields (Swift `Double(String)`, **measured**): accept `12.`, `.5`, `+5`, `1e3`, `0x10`; reject
  surrounding whitespace, `1,920`, `1_000`, `-`, empty. `inf`/`nan` parse but are rejected as non-finite. JS
  `Number()` differs (`Number("") === 0`, `Number(" 12 ") === 12`): use
  `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/` (hex can be ignored).
- Sheet fields (`FormatStyle.number`): locale-aware, grouping accepted ("1,920"); parse on commit.

### 8.4 Display formats

- Sheet fields: up to 3 decimals with grouping: `new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 })`
  (1920 → "1,920", 26.6666… → "26.667").
- Readouts with integer interpolation ("Current: 1920 × 1080 pixels", "Result: …", "W × H px", "New: …"): no grouping.
- Validation messages use the literal "30,000" and "9,600" and "200".

### 8.5 Memory size (`ByteCountFormatter`, `.memory`) — measured

| Bytes | Text |
|---|---|
| 4 | 4 bytes |
| 1,023 | 1,023 bytes |
| 1,024 | 1 KB |
| 1,536 | 2 KB |
| 1,024,000 | 1,000 KB |
| 1,048,575 | 1 MB |
| 1,572,864 | 1.5 MB |
| 8,294,400 (1920 × 1080 × 4) | 7.9 MB |
| 48,000,000 | 45.8 MB |
| 1,610,612,736 | 1.5 GB |
| 3,600,000,000 (30,000² × 4) | 3.35 GB |

JS port: binary units (1024); bytes and KB with 0 decimals, MB with up to 1, GB and above with up to 2 (trailing zeros
dropped); promote to the next unit when the rounded value reaches 1024; grouping in the number; "1 byte" singular.

```js
function memory(bytes) {
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = [['KB', 0], ['MB', 1], ['GB', 2], ['TB', 2], ['PB', 2]];
  let value = bytes / 1024, i = 0;
  for (;;) {
    const [, digits] = units[i];
    const rounded = Number(value.toFixed(digits));
    if (rounded < 1024 || i === units.length - 1) {
      return `${rounded.toLocaleString('en-US', { maximumFractionDigits: digits })} ${units[i][0]}`;
    }
    value /= 1024; i++;
  }
}
```

### 8.6 Move bar number format

```js
const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));
function formatted(v) {                                  // UI/TransformInspector.swift:141-144
  if (Math.abs(v - roundHalfAway(v)) < 0.005) return String(roundHalfAway(v) || 0);
  return toFixed2HalfEven(v);                            // %.2f: exact binary ties go to even (1.125 → "1.12")
}
// A double is exactly halfway between two hundredths only when it is j/8 with j odd (x.125, x.375, x.625, x.875);
// there `toFixed` rounds up while printf rounds to even. Every other value: `toFixed(2)` already matches.
function toFixed2HalfEven(v) {
  if (Number.isInteger(v * 8) && !Number.isInteger(v * 4)) {
    const n = Math.floor(v * 100);                       // exact: v * 100 = n + 0.5
    return ((n % 2 === 0 ? n : n + 1) / 100).toFixed(2);
  }
  return v.toFixed(2);
}
```

---

## 9. Engine API to add

### 9.1 Session set-up

`engine/Sources/EngineMain.swift:110-121` (`session`) loads the project (through the stamp-checked snapshot cache,
`:76-83`) and sets `activeLayerID` (which resets `selectedLayerIDs` to `[id]` and `isMaskSelected`). Add, after it:
`selectedLayerIDs` from `args.selectedLayerIDs` (union the active id), then `configure` (`isMaskSelected`, palette
colors; `engine/Sources/SelectionOps.swift:133-140`). The board must send `selectedLayerIDs` for group transforms and
flips once it has multi-selection.

All operations below run inside `withSession` (`engine/Sources/SelectionOps.swift:113-131`: load, act, save only if the document other than its selection changed,
answer `saved`, `editName` = `history.undoName`, `selection`, `activeLayerID`, `error` = `brushError`). Before any of
them the board commits its own pending transform and cancels its crop (as `ProjectController.begin()` does), and the
extension flushes unsaved strokes (`vscode-extension/extension.js:242-283`).

### 9.2 Operations

| Request | Args (besides `project`, `activeLayerID`, `selection`) | EditorSession calls | Sync / async | Result and undo name |
|---|---|---|---|---|
| `transform.commit` | `selectedLayerIDs?`, `isMaskSelected?`, `draft` (full transform JSON), `corners?` `[[x,y]×4]`, `box?` | `beginTransform(persistent: true)`; error if `transformEdit == nil` ("Nothing here can be transformed: select a visible layer with pixels."); if `box` is given and every field is within 1e-6 of `transformEdit.group.box`, rebuild the edit with the board's box (`TransformEdit(layerID:draft:persistent:group: TransformGroup(box: box, originals: …))`) so `following` matches the board bit for bit; `previewTransform(draft)`; if `corners`: `beginDistort()`, `previewCorners(corners)`, error if `transformEdit?.corners != corners` ("That shape can't be drawn."); `commitTransform()` | sync | "Transform Layer", "Transform Layers", "Transform Layer Mask", "Distort", "Distort Layers", "Distort Layer Mask"; per-layer warp failures in `error` |
| `canvas.crop` | `rect: [x, y, w, h]` | `cropRect = rect`; `await commitCrop()`; on `cropError`: `errorTitle: "Couldn’t crop"`, `error: cropError` | async | "Crop"; selection null |
| `canvas.size` | `width`, `height` (Int), `anchor` 0…8, `fill: null \| [r, g, b]` (sRGB 0…1; the board resolves Foreground/Background/Custom) | `projectSnapshot()`; `try await CanvasResizer.shared.resize(snapshot, to: CanvasSizeOptions(width:height:anchor:fill:))`; `applyDocumentSize(result, actionName: "Canvas Size")`; catch → `errorTitle: "Couldn’t change canvas size"` | async | "Canvas Size"; selection null |
| `image.size` | `width`, `height` (Int), `resolution` (Double), `sampling` ("Nearest" \| "Smooth" \| "High quality") | `try await ImageResizer.shared.resize(snapshot, to: ImageSizeOptions(…))`; `applyImageSize(result)`; catch → `errorTitle: "Couldn’t resize the image"` | async | "Image Size"; selection null |
| `image.trim` | `basedOn` ("Transparent Pixels" \| "Top Left Pixel Color" \| "Bottom Right Pixel Color"), `top`, `bottom`, `left`, `right` | `try await ImageTrim.trim(snapshot, options: TrimOptions(…))`; nil → `{saved: false, unchanged: true}` (no message); else `applyDocumentSize(result, actionName: "Trim")`; catch → `errorTitle: "Couldn’t trim image"` | async | "Trim"; selection null |
| `canvas.rotate` | `clockwise: Bool` | `rotateCanvas(clockwise:)` | sync | "Rotate Canvas 90° Clockwise" / "… Counterclockwise"; selection turned |
| `canvas.flip` | `horizontal: Bool` | `flipCanvas(horizontally:)` | sync | "Flip Canvas Horizontal" / "Vertical"; selection mirrored |
| `layer.flip` | `horizontal: Bool`, `selectedLayerIDs?` | `flipLayers(horizontally:)` | sync | "Flip Horizontal" / "Flip Vertical" |

Notes:
- `IO/ProjectController.swift` is excluded from the engine build (`engine/build.sh`), so the engine replicates its
  three methods without the sheets (above) and returns `errorTitle` + `error` for the board's alert. `commitCrop`,
  `trim(options:)`, `rotateCanvas`, `flipCanvas`, `flipLayers`, `applyDocumentSize` and `applyImageSize` are in
  compiled files and callable as they are.
- `ImageExporter.render` (Trim) and `DistortWarp` (Core Image, Core Graphics) run headless; `CIPerspectiveTransform`
  needs no window.
- The board treats a changed `width`/`height` in the pushed manifest as a canvas change: refit the view, drop its own
  crop frame (`cropRect = null`, frame back to the new canvas), and adopt `result.selection` (null for the four size
  commands) inside the same undo entry, as `selectionOp` already does (`media/board.js:963-990`).

### 9.3 What stays in the board

Pure placement arithmetic, already needed for the live preview, is committed locally with the exact formulas of this
spec: single-layer affine transforms (existing `commitTransform`, with D1/D2), group affine transforms (`following`,
D1, shape redraw via `Shapes.redrawFor`), the unlinked-mask placement (4.12, affine only), nudges, Flip Layer, Flip
Canvas and Rotate Canvas. Use the engine ops above as the parity oracle in tests: for the same project and edit, the
board's manifest must equal the engine's. Anything that creates or resamples pixels goes to the engine: distortion,
Image Size, Trim (needs the exact export render), Canvas Size with an extension, and, for one code path, Crop and
plain Canvas Size too.

---

## 10. Upstream quirks a faithful port inherits

1. **A click outside the crop frame resets it.** "Create" mode sets `cropRect = nil` at the press; without a drag the
   frame returns to the full canvas and Cancel/Apply/readout disappear (`Rendering/EditorCanvas.swift:2551`).
2. **⌥-created crop frames are fractional with Snap on.** `CropSnap.apply`'s symmetric block mirrors about the raw
   press point: press (100.3, 50.7), drag to (170.2, 80.1) → `(30.6, 21.4, 139.4, 58.6)` **(measured)**. The readout
   shows `139 × 58 px`, Apply makes a 139 × 58 canvas with layers shifted by (−30.6, −21.4).
3. **Ratio refit can fail silently.** An invalid refit keeps the old frame while the picker shows the new ratio;
   ratio-locked resizes keep the frame's own aspect (`Document/Crop.swift:230-235, 42`).
4. **Crop shows no snap lines**, unlike moves and marquees.
5. **Image Size scrub caps the area at 100 MP** while validation allows 200 MP (`UI/ImageSizeSheet.swift:80`).
6. **Image Size stores the chosen Sampling on every layer** (a "Nearest" resize leaves every layer Nearest-sampled for
   later transforms), and bakes every transform: hidden resolution of scaled-down layers is lost.
7. **Center snapping leaves half-pixel origins** after rounding: a 101-px-wide layer whose middle snaps to 500 lands
   at x 449.5 (`TransformSnap`, **measured** offset 4.5).
8. **Flip H/V and Sampling in the Move bar leave an open edit**: no undo step until the next press, ↩ or tool/layer
   switch; Undo is disabled meanwhile and ⎋ reverts it. ⎋ in a Move-bar text field **applies** what was typed.
9. **Group mirror representation.** A box flip reaches members through `placing`, which keeps `flipX` and encodes the
   mirror as `rotation −180` + `flipY` (a 50 × 50 member at (0, 0) in a 200 × 100 box flipped → origin (150, 0),
   rotation −180, flipY **(measured)**). Visually identical to a flipX.
10. **Distort Apply ignores the layer's sampling** for convex shapes (Core Image linear) and uses **nearest** for
    folded shapes (`BrushRaster.draw` sets `interpolationQuality = .none`); the GPU preview honors Nearest.
11. **A group member whose carried corners are unusable is skipped at Apply** and keeps its original transform, even
    though the box moved (`Document/Distort.swift:352-356`).
12. **Rotate/Flip Canvas "commit transform / cancel crop first" is unreachable from the menu**: the items are disabled
    in those states.
13. **Crop/Canvas Size/Image Size/Trim drop the selection**, and with a selection a no-op Apply still records an undo
    step.
14. **The Move bar's Flip H keeps the angle; Layer › Flip Layer Horizontal negates it** (different results on rotated
    layers).
15. **Typed Move-bar values are not range-clamped** (only `isValid`): X 40,000 is accepted; the scrub ranges are the
    only clamps.

---

## 11. Test vectors

All **(measured)** with upstream code unless marked "derived".

### 11.1 Crop

| Case | Result `(x, y, w, h)` |
|---|---|
| `create(from: (100,100), to: (20,60), ratio: 2)` | (20, 60, 80, 40) |
| `create((10.4,20.6) → (210.5,90.2), Free)` | (10, 21, 201, 69) |
| `create((10,10) → (110,30), 16:9)` | (10, 10, 100, 56) |
| `create((10,10) → (30,110), 16:9)` | (10, 10, 178, 100) |
| `create((50,50) → (80,60), Free, symmetric)` | (20, 40, 60, 20) |
| `create((50,50) → (50,50))` (no movement) | (50, 50, 1, 1) |
| `create((0,0) → (100,0), 4:3)` | (0, 0, 100, 75) |
| `create((0,0) → (−100,0), 1:1)` | (−100, 0, 100, 100) |
| Refit 1920 × 1080 frame: 1:1 / 4:3 / 3:4 / 16:9 / 9:16 / Original | (0,−420,1920,1920) / (0,−180,1920,1440) / (0,−740,1920,2560) / (0,0,1920,1080) / (0,−1167,1920,3414) / (0,0,1920,1080) |
| Refit 1001 × 500 frame: 16:9 / 4:3 | (0, −32, 1001, 564) / (0, −125, 1001, 750) |
| Resize BR of (0,0,1920,1080) by (+100, 0), 16:9 | (0, 0, 1996, 1123) |
| Resize BR to (1820, 1000), Free / ⌥ | (0, 0, 1820, 1000) / (100, 80, 1720, 920) |
| Resize R edge to x 1600, 16:9 | (0, 90, 1600, 900) |
| Resize R edge to x −100, Free | (−100, 0, 100, 1080) |
| Move (10,10,50,50) by (+0.6, −0.6) | (11, 9, 50, 50) |
| Snap targets x [0, 200], y [0, 100], tol 8: Free create (52,18) → (195,97) | (52, 18, 148, 82) |
| same targets: move (10,10,60,40) by (−5,−6), ratio 1:1 (moves still snap) | (0, 0, 60, 40) |
| ⌥ create (100.3,50.7) → (196,97), snapping | (0.6, 1.4, 199.4, 98.6) |
| Upstream `CropTests.cropEdgesSnapToNearbyEdges` | all cases there (move to (0,20,60,40); BR to (10,10,140,70); far (10,10,110,50); ratio frame unchanged; create (52,18,98,62)) |
| Apply (8, 4, 32, 16) on a 64 × 32 image at (0,0) | canvas 32 × 16, layer origin (−8, −4), same image (`CropTests`) |
| Apply (−20, 10, 100, 50), then (−10, −10, 140, 80) on 100 × 50 | origins (20, −10), then (30, 0); canvas 140 × 80 (`CropTests`) |
| Selection-start: selection bounds (12.3, 7.8)-(40.1, 20.2) on 100 × 50 | frame (12, 7, 29, 14) (derived: integral) |

### 11.2 Canvas Size

| Case | Result |
|---|---|
| Offsets 64 × 32 → 69 × 37, anchors 0…8 | (0,0) (2,0) (5,0) (0,2) (2,2) (5,2) (0,5) (2,5) (5,5) |
| 64 × 32 → 59 × 27 | (0,0) (−3,0) (−5,0) (0,−3) (−3,−3) (−5,−3) (0,−5) (−3,−5) (−5,−5) |
| 64 × 32 → 65 × 33 | (0,0) (0,0) (1,0) (0,0) (0,0) (1,0) (0,1) (0,1) (1,1) |
| 64 × 32 → 63 × 31 | (0,0) (−1,0) (−1,0) (0,−1) (−1,−1) (−1,−1) (0,−1) (−1,−1) (−1,−1) |
| Draft 1920 × 1080 @ 72: Inches / Centimeters | 26.6667 × 15 / 67.7333 × 38.1 |
| Percent 150 on width, unlocked | 2880 × 1080 (valid); lock on → 2880 × 1620 |
| 10 cm @ 72, locked | 283.4646 × 159.4488 → "New: 283 × 159 pixels" |
| 100 × 100, width 30000.4 / 30000.5 / 0.4 / 0.5 | valid / invalid / invalid / valid |
| `CanvasSizeTests.relativeRatioAndUnitsUseFinalDimensions` (1000 × 500 @ 100) | relative+locked +200 → 1200 × 600; −250 height → 500 × 250; 10 in → 1000 × 500; 50% → 500 × 250; 12.7 cm displayed |
| 4 × 4 → 8 × 2, center, red fill | 2 layers; pixel (0,0) red, (3,0) transparent, (7,1) red (`CanvasSizeTests`) |
| 4 × 4 → 2 × 2 with white fill | no extension layer; 30,000² with white fill throws `tooLarge` |

### 11.3 Image Size

| Case | Result |
|---|---|
| 1920 × 1080 @ 72, Percent 50 on width, locked | 960 × 540 (derived) |
| Inches: width 10 in, locked | 720 × 405; then resolution 72 → 300: 3000 × 1687.5 → "Result: 3000 × 1688 pixels" (derived) |
| Resample off, Inches, width 10 in | resolution 192; height shows 5.625 in (derived) |
| 20000 × 10001 resample on | invalid (200.02 MP) (derived) |
| Layer (101, 51, 301, 151) on 1000 × 500 → 500 × 250 | new transform (50, 25, 151, 76) |
| Layer 100 × 50 at (100,100) rot 45, ×2 | (193, 143, 214, 214), rotation 0 |
| `ImageSizeTests` rot 90 64 × 32 at (−16, 4), 64 × 32 doc → 128 × 96 | (−1, −37, 65, 193) (test: ≈ 64 × 192 within 1, origin y < 0) |
| Placement (10, 20, 30 × 40, rot 30) scaled (2, 1) | origin (22.958, 17.812), size (54.083, 44.376), rot 16.102 |

### 11.4 Trim (`ImageTrimTests`)

| Image | Options | Rect |
|---|---|---|
| 20 × 20, content x 2..<17, y 4..<15 | all sides | (2, 4, 15, 11) |
| same | top + bottom | (0, 4, 20, 11) |
| same | left + right | (2, 0, 15, 20) |
| 16 × 16, 3-px blue border | top-left color, all / top only | (3, 3, 10, 10) / (0, 3, 16, 13) |
| 16 × 16, magenta right/bottom 4 px | bottom-right color | (0, 0, 12, 12) |
| solid or fully transparent | any | nil (no change) |
| 100 × 100 doc, 40 × 40 opaque layer at (20, 30) | transparent | canvas 40 × 40, layer at (0, 0); undo restores |

### 11.5 Rotate / flip

| Case | Result |
|---|---|
| Layer (10, 20, 100 × 50, rot 15) on 300 × 200, cw | origin (105, 35), rot 105 |
| same, ccw | origin (−5, 215), rot −75 |
| rot 300, cw / rot −90, ccw | rot 30 / rot −180 |
| Flip canvas H on 300 wide | origin (190, 20), rot −15, flipX |
| Flip layer V (own center) | origin unchanged, rot −15, flipY |
| `CanvasRotationTests` 3 × 2 reds [10,20,30 / 40,50,60] | cw → [40,10,50,20,60,30]; ccw → [30,60,20,50,10,40]; guides v30 → h30, h10 → v50; selection (0,0,20,10) on 100 × 60 → (50, 0, 10, 20) |

### 11.6 Transform and distortion

| Case | Result |
|---|---|
| (0,0,200,100), BR drag (+50, +10), locked | 244 × 122 at (0, 0) |
| same, ⇧ (free) | 250 × 110 |
| same, ⌥ locked | 288 × 144 at (−44, −22) |
| BR dragged to (−50, −20), free | (−50, −20, 50 × 20), flipX and flipY |
| Rotate from (100, −28) to (150, 0) / to (160, 10) with ⇧ | 45° / 60° |
| Distort top edge (handle 1) (+10, +5) / with ⇧ | corners (10,5) (210,5) (200,100) (0,100) / (10,0) (210,0) (200,100) (0,100) |
| Snap box (445..546) × (10..60) to xs [0, 500, 1000], ys [0, 300], tol 10 | offset (4.5, −10), x target 500 |
| Scale 25% of 400 × 200 pixels, layer (10, 10, 200 × 100) | (60, 35, 100 × 50); before: 50% |
| `homography([(10,10),(60,10),(30,30),(10,30)])` at (0.5,0.5) / (0.5,0) / (1,0.5) / (0.25,0.75) | (24.2857, 24.2857) / (35, 10) / (38.5714, 24.2857) / (15.8824, 27.6471) |
| that quad: convex; bow tie [0,2,1,3]: usable, not convex; dent (0,0),(100,0),(30,30),(0,100): usable, not convex; collapsed: neither | — |
| Parallelogram (0,0),(100,0),(120,50),(20,50) center | (60, 25) |
| `imageCorners(quad above, flipX)` | TL (60,10), TR (10,10), BR (10,30), BL (30,30) |
| `corners(of: (0,0,100×50, rot 30))` | (19.1987, −21.6506) (105.8013, 28.3494) (80.8013, 71.6506) (−5.8013, 21.6506) |
| `carried((0,0,50×50), by box (0,0,100×100), to (0,0),(100,0),(80,100),(20,100))` | (0,0) (50,0) (50,62.5) (12.5,62.5) |
| Group following: member (0,0,50×50) in box (0,0,200×100) → box 400 wide | (0, 0, 100 × 50) |
| → box rotated 90 | origin (100, −50), rot 90 |
| → box flipX | origin (150, 0), rot −180, flipY |
| member (10,10,50×20, rot 45) → box rot 30, 400 × 100 at (−100, 0) | origin (−37.112, −53.630), size (79.057, 25.298), rot 56.565 (shear dropped) |
| `DistortTests`: 20 × 20 red at (10,10) to (10,10),(60,10),(30,30),(10,30) | layer (10, 10, 50 × 20) rot 0; alpha 255 at (50,12) and (15,25), 0 at (50,28) and (80,12); one undo step |
| `DistortTests`: 40 × 20 with a 10 × 10 square at (15,5), to (10,10),(60,10),(50,30),(10,30) | trimmed: width < 20, height ≤ 12, origin ≥ (20, 14) |
| `ResizeSnapTests` | right edge to 147 snaps to 150; locked BR to (146,148) snaps bottom to 150 and stays square; rotated 20° does not snap |

### 11.7 Formatting

| Value | Move bar | Sheet field |
|---|---|---|
| 12 / 12.004 / 12.005 / 12.5 | "12" / "12" / "12.01" / "12.50" | "12" / "12.004" / "12.005" / "12.5" |
| −0.001 / −3.333 / 99.996 | "0" / "-3.33" / "100" | — |
| 1.125 | "1.12" (JS `toFixed`: "1.13") | "1.125" |
| 1920 / 1234567.891 / 26.6666666 | "1920" | "1,920" / "1,234,567.891" / "26.667" |

---

## 12. Not applicable in VS Code / adaptations

| Upstream | Why | Board |
|---|---|---|
| Window-modal sheets (`NSWindow` sheet, `beginSheet`) | no AppKit | Board panels, modal for the canvas (8.1) |
| `NSAlert` warning sheets ("Couldn’t …") | no AppKit | A board alert panel with the same title and message (or `vscode.window.showWarningMessage(title, { modal: true, detail })` via the extension) |
| `NSCursor.frameResize`, SF cursors | no AppKit | CSS `nwse/ns/nesw/ew-resize`; rotate and distort cursors as `url(data:…)` images (`ui.md` 12.3) |
| `controlAccentColor` | system accent | `--accent` (already used by `media/view.js:177`) |
| ⌥⌘I Image Size | VS Code **Toggle Developer Tools** (mac primary 2599, verified in the 1.142 bundle) | Consume with `preventDefault` + `stopPropagation`; verify DevTools does not open; else offer the menu only |
| ⌥⌘C Canvas Size | VS Code **Copy Path of Active File** (`copyFilePath`, mac primary 2593 when the explorer is not focused, verified) — overwrites the clipboard | Consume; verify |
| ⌘T Transform Layer | Go to Symbol in Workspace (`ui.md` 12.2) | Consume (already done) |
| ⌘H Show Transform Controls | macOS Hide | Header checkbox only (`ui.md` 12.2) |
| Undo/Redo menu "act only on text fields" during ⌘T | single VS Code ⌘Z callback | Refuse history while `transformEdit` is set; let inputs keep native undo |
| GPU (Metal/Core Image) distortion preview | no Metal | WebGL2 or Canvas 2D (7.2); commit in the engine |
| `showsBusy` 250 ms dimming | — | Dim the header and block edits while an engine size/crop/distort request runs (`media/board.js` `working`) |
| Layer effects warped during distortion | the board does not draw effects | N/A until effects are drawn (7.2) |
| `ProjectWorkspace.isManaging` in `canStart` | multi-tab workspace | N/A |

---

## 13. Checklist index

Each line of `docs/parity/features.md` in scope, by its short title, and where it is specified.

| Checklist line | Section |
|---|---|
| Tools › Crop › Entering the tool | 2.1 |
| Tools › Crop › Ratio picker | 2.2, 2.3 |
| Tools › Crop › Size readout | 2.2 |
| Tools › Crop › Cancel button … and Apply Crop button | 2.2 |
| Tools › Crop › Drag outside the frame … draws a new frame | 2.4 |
| Tools › Crop › Option = symmetric | 2.5, 2.6, 7.4 |
| Tools › Crop › Fixed ratio constrains creating and resizing | 2.5, 2.6 |
| Tools › Crop › Edge snapping | 1.2, 2.6 |
| Tools › Crop › Whole-pixel frames | 2.5, 2.7, quirk 10.2 |
| Tools › Crop › Overlay | 2.7, 7.4 |
| Tools › Crop › Return/Enter applies, Escape cancels | 2.8 |
| Tools › Crop › Leaving the tool … cancels the pending frame | 2.9 |
| Image Size › Image › Image Size… (Opt-Cmd-I) | 3.1, 3.2, 12 |
| Image Size › "Current: W × H pixels" readout | 3.2 |
| Image Size › Units picker | 3.2 |
| Image Size › Width field | 3.2 |
| Image Size › Height field | 3.2 |
| Image Size › Lock aspect ratio toggle | 3.2 |
| Image Size › Resolution field | 3.2 |
| Image Size › Resample toggle | 3.2 |
| Image Size › Sampling picker | 3.2, quirk 10.6 |
| Image Size › Explanatory text | 3.2 |
| Image Size › Result line … or orange validation | 3.2 |
| Image Size › Cancel (Escape) / Resize (Return) | 3.2 |
| Image Size › Resampling behaviour | 3.2 |
| Image Size › Applied as one undo step "Image Size" … failure alert | 3.1, 3.2 |
| Canvas Size › Image › Canvas Size… (Opt-Cmd-C) | 3.1, 3.3, 12 |
| Canvas Size › Current size readout and uncompressed RGBA memory | 3.3, 8.5 |
| Canvas Size › Units picker | 3.3 |
| Canvas Size › Width field | 3.3 |
| Canvas Size › Height field | 3.3 |
| Canvas Size › "Relative to current dimensions" toggle | 3.3 |
| Canvas Size › "Lock original aspect ratio" toggle | 3.3 |
| Canvas Size › New size line … or orange "Final dimensions…" | 3.3 |
| Canvas Size › Anchor 3x3 grid | 3.3 |
| Canvas Size › Canvas extension picker | 3.3 |
| Canvas Size › Custom extension color swatch | 3.3 |
| Canvas Size › Cancel (Escape) / OK (Return) | 3.3 |
| Canvas Size › Behaviour | 3.3 |
| Crop › Apply Crop | 3.4 |
| Crop › Failure shows the "Couldn’t crop" alert | 3.1, 3.4 |
| Trim › Image › Trim… | 3.1, 3.5 |
| Trim › Based On (radio group) | 3.5 |
| Trim › Trim Away toggles | 3.5 |
| Trim › Cancel (Escape) / OK (Return) | 3.5 |
| Trim › Behaviour | 3.5 |
| Rotate/Flip canvas › Rotate Canvas 90° Clockwise | 3.6 |
| Rotate/Flip canvas › Rotate Canvas 90° Counterclockwise | 3.6 |
| Rotate/Flip canvas › Flip Canvas Horizontal | 3.6 |
| Rotate/Flip canvas › Flip Canvas Vertical | 3.6 |
| Rotate/Flip canvas › Rotate/Flip commit a pending transform and cancel a pending crop first | 3.6, quirk 10.12 |
| Transform › Box › Transform box drawn in the accent color | 4.2 |
| Transform › Box › Rotation handle | 4.2 |
| Transform › Box › Hit zones | 4.2 |
| Transform › Box › Move | 4.3 |
| Transform › Box › Resize | 4.3 |
| Transform › Box › Option-resize scales from the center | 4.3 |
| Transform › Box › Dragging a handle past the opposite side flips | 4.3 |
| Transform › Box › Rotate | 4.3 |
| Transform › Box › Drags land on whole pixels and whole degrees | 4.3, quirk 10.7 |
| Transform › Box › Handle drags apply on mouse-up … "Transform Layer" | 4.1, 4.3 |
| Transform › Box › Non-destructive | 1.1, 4.3, 4.5 |
| Transform › Box › Shape layers redraw | 4.5, D2 |
| Transform › Box › Linked masks follow the layer | 4.5, D1 |
| Transform › Box › Transform targets only layers with pixels | 4.1 |
| Transform › Snapping › Moving snaps … within 10 screen points | 1.2, 1.3, 4.4 |
| Transform › Snapping › Resizing snaps the dragged edge(s) | 1.3, 4.4 |
| Transform › Distort › Cmd-drag a transform handle starts free distortion | 4.7 |
| Transform › Distort › Corner handle moves its corner … | 4.7 |
| Transform › Distort › Shift locks the dragged corner(s) | 4.7 |
| Transform › Distort › Distortion waits for Apply / Cancel | 4.7, 4.8 |
| Transform › Distort › Live preview at up to 2048 px | 4.7, 7.2 |
| Transform › Distort › Apply resamples pixels | 4.7, 9.2 |
| Transform › Distort › 16-bit layers | 4.7 |
| Transform › Distort › Masks | 4.7, 7.2 |
| Transform › Distort › Multi-layer/folder distort | 4.7 |
| Transform › Group › Several selected layers, or a selected folder | 4.6 |
| Transform › Group › Each member follows the box | 4.6 |
| Transform › Group › Press inside the group box | 4.6 |
| Transform › Group › Scale % of a group | 4.6, 4.8 |
| Transform › Move bar › X field / Y field / W field / H field | 4.8 |
| Transform › Move bar › Link (lock aspect ratio) toggle button | 4.8 |
| Transform › Move bar › Scale field | 4.8 |
| Transform › Move bar › Angle (°) field | 4.8 |
| Transform › Move bar › Sampling picker | 4.8 |
| Transform › Move bar › Flip H button / Flip V button | 4.8, quirk 10.8, 10.14 |
| Transform › Move bar › Field label scrubbing | 4.8 |
| Transform › Move bar › Field arrow stepping | 4.8 |
| Transform › Move bar › Live field edits | 4.8 |
| Transform › Move bar › Number formatting | 4.8, 8.6 |
| Transform › Move bar › Fields disabled … | 4.8 |
| Transform › Move bar › Cancel (Escape) and Apply (Return) buttons | 4.8 |
| Transform › Commands › Layer › Transform Layer (Cmd-T) | 4.9, 6 |
| Transform › Commands › Return/Enter applies and Escape cancels | 4.1, 4.9 |
| Transform › Commands › Selecting another layer or tool commits | 4.1, 4.9 |
| Transform › Commands › While a persistent transform is pending, Undo/Redo … | 4.9, 6 |
| Transform › Keyboard › Arrow keys with the Move tool nudge | 4.10, D10 |
| Transform › Flip Layer › Flip Layer Horizontal / Vertical | 4.11 |
| View › Snapping › Snap master toggle / Snap To targets / distance / Control / feedback lines (the parts that govern transforms and crop) | 1.2 |
