# Port spec: Compositor Shape tool (Rectangle, rounded Rectangle, Ellipse, Line)

Source of truth: the read-only upstream clone at `~/Projects/compositor-board/upstream`. Every
`file:line` below is relative to that directory. Excerpts are verbatim unless marked "paraphrased".
Behaviour marked **[verified]** was checked on this Mac (macOS 26, Swift 6.4) by compiling the
upstream `ShapeKind` code and a copy of `LayerShapeStyle` against CoreGraphics/Foundation.

Primary files:

| File | What it holds |
|---|---|
| `Compositor/Document/ShapeTool.swift` (266 lines) | `ShapeKind` geometry, `LayerShapeStyle` (manifest), draft/finish/redraw logic, rasterizer `shapeImage` |
| `Compositor/UI/ShapeControls.swift` (69 lines) | Tool options bar |
| `Compositor/Document/EditorSession.swift` | Tool state defaults, tool switching, `commitTransform` (calls the redraw) |
| `Compositor/Rendering/EditorCanvas.swift` | Mouse/keyboard handling and the live preview |
| `Compositor/Document/SelectionClipboard.swift` | `addPixelLayer` (where the new layer goes) |
| `Compositor/Document/Selection.swift` | `DragBox.rect` (Shift / Option box math, shared with the Marquee) |
| `Compositor/IO/ProjectStore.swift` | Manifest record, version gate for `smoothing` |
| `docs/project-format.md` | Format prose: "Additive layer fields" (line 44) and Version 14 (line 58) |

`Compositor/Rendering/TransformOverlay.swift` contains no shape-specific code (its only "shape"
hit is the gradient's `.radial` at line 453); the scaled redraw lives in
`EditorSession.commitTransform` -> `redrawShape` (section 9).

---

## 1. Mental model (TL;DR)

- There are exactly **three kinds**: `"Rectangle"`, `"Ellipse"`, `"Line"`. A "rounded rectangle" is
  a `Rectangle` with `cornerRadius > 0`; a "smooth (squircle) rectangle" is a `Rectangle` with
  `cornerRadius > 0` and `smoothing: true`.
- Each drag creates **one new ordinary raster layer** (an 8-bit RGBA PNG at 1 PNG px = 1 document
  px), placed directly above the active layer, named `"<Kind> <n>"`, with a `shape` style object
  in the manifest so the shape can be **re-rasterized** (not resampled) when the layer is scaled.
- Rectangles/ellipses are **filled only** (no stroke), anti-aliased, in the foreground color, and
  exactly fill their box (layer transform = drag box, no padding).
- Lines are **stroked only** with **round caps**, thickness `lineWidth` document px; the layer box
  is the endpoints' bounding box grown by `lineWidth/2` on every side; the endpoints are stored as
  fractions (0-1) of that box.
- The PNG is the truth for display. The `shape` style is only consulted when the layer is scaled
  (and for the rounded-rect resize preview). As soon as the layer's pixels change by any other
  means, the style is no longer "live" and the next save omits `shape`.

---

## 2. Shape kinds

`Compositor/Document/ShapeTool.swift:3-6`

```swift
nonisolated enum ShapeKind: String, CaseIterable, Codable, Sendable {
    case rectangle = "Rectangle"
    case ellipse = "Ellipse"
    case line = "Line"
```

- JSON spelling is the raw value, **case-sensitive, capitalized**: `"Rectangle"`, `"Ellipse"`,
  `"Line"`. Anything else (e.g. `"ellipse"`, `"RoundedRectangle"`) fails decoding of the whole
  manifest **[verified]**: `Cannot initialize ShapeKind from invalid String value ellipse`, which
  `ProjectStore.readPackage` turns into `ProjectError.invalid` (`ProjectStore.swift:165-166`), i.e.
  Compositor refuses the entire project.
- `CaseIterable` order (Rectangle, Ellipse, Line) is the cycling order of Shift-U / Tab
  (`ShapeTool.swift:149-153`) and the segment order of the picker (`ShapeControls.swift:13`).

---

## 3. Manifest JSON (`shape` on a layer record)

### 3.1 The struct

`Compositor/Document/ShapeTool.swift:56-72`

```swift
/// What a shape layer draws, kept so the shape can be drawn again at a new size.
nonisolated struct LayerShapeStyle: Codable, Equatable, Sendable {
    var kind: ShapeKind
    var red: CGFloat
    var green: CGFloat
    var blue: CGFloat
    /// Document pixels, whatever size the shape is scaled to.
    var cornerRadius: CGFloat
    /// Nil in older projects means ordinary circular corners. True uses 60% smoothing.
    var smoothing: Bool? = nil
    /// A line's thickness, and its two ends as fractions of the layer's box (0–1), so the line lands on exactly the
    /// points it was dragged between and still redraws correctly at another size. Nil on other shapes.
    var lineWidth: CGFloat? = nil
    var start: CGPoint? = nil
    var end: CGPoint? = nil
    var color: PaletteColor { PaletteColor(red: red, green: green, blue: blue) }
}
```

It is stored on the layer record as an optional field, `Compositor/IO/ProjectStore.swift:56-57`:

```swift
    /// A shape layer's shape, drawn again when the layer is scaled. Older versions ignore it and keep the pixels.
    var shape: LayerShapeStyle? = nil
```

Synthesized `Codable`: non-optional properties are **required keys** on decode; optionals are
written only when non-nil (`encodeIfPresent`) and may be absent. `color` is computed and never
encoded. The manifest is written with `JSONEncoder` `[.prettyPrinted, .sortedKeys]`
(`ProjectStore.swift:116-117`).

### 3.2 Keys

| Key | JSON type | Required on decode | Written by Compositor | Range / meaning |
|---|---|---|---|---|
| `kind` | string | yes | always | `"Rectangle"` \| `"Ellipse"` \| `"Line"` |
| `red`, `green`, `blue` | number | yes | always | sRGB, **0-1** floats (the foreground color, `PaletteColor`, clamped to 0-1 when it comes from an `NSColor`, `ColorPalette.swift:14-17`). Not range-checked on load. |
| `cornerRadius` | number | **yes, for every kind** | always | Document px, UI range 0-5000. Ellipses and lines always write `0` (`ShapeTool.swift:115`). Not range-checked on load; geometry clamps it to `[0, min(w,h)/2]`. |
| `smoothing` | bool | no | only as `true` (never `false`) | Rectangle only. `true` = Figma 60 % squircle corners. Absent/`false` = circular corners. `true` requires manifest `version >= 14`. |
| `lineWidth` | number | no | Lines only | Document px, UI range 1-5000; rendering uses `max(1, lineWidth)`. |
| `start`, `end` | `[x, y]` array of 2 numbers | no | Lines only | Endpoints as fractions of the layer box (x of width, y of height), y down. Within (0, 1) for lines Compositor draws. |

Decoding strictness **[verified]** (copy of the struct + upstream `ShapeKind`, `JSONDecoder`):

- `{"kind":"Ellipse","red":0,"green":0,"blue":0}` -> **fails**: `keyNotFound 'cornerRadius'`.
- `{"kind":"Ellipse",...,"cornerRadius":0,"smoothing":false}` -> OK.
- `"start":{"x":0.1,"y":0.2}` -> **fails** (`typeMismatch`, expected array). `CGPoint` is coded as
  `[x, y]`, exactly like `transform.origin` (`docs/writing-comp-files.md:48`).
- `{"kind":"Rectangle","red":2,"green":-1,"blue":0,"cornerRadius":-5}` -> OK (no range validation).

A failed decode of any layer's `shape` rejects the whole project (silently on live reload,
`docs/writing-comp-files.md:68`).

### 3.3 Version requirements

- The `shape` object itself is **not version-gated**: "Later fields are optional and not gated on
  the version, so older readers ignore them and keep the pixels" (`docs/project-format.md:41-44`).
  `kind`, colors, `cornerRadius`, `lineWidth`, `start`, `end` are accepted in a manifest of any
  supported version (1-14).
- `smoothing: true` requires **version 14**. `Compositor/IO/ProjectStore.swift:223-225`:

  ```swift
            if layer.shape?.smoothing == true {
                guard manifest.version >= 14 else { throw ProjectError.invalid }
            }
  ```

  and `docs/project-format.md:58`: "Files declaring versions 1–13 cannot enable smoothing, and
  older app builds reject v14." `smoothing: false` passes at any version (the check is `== true`).
- Compositor always saves `version = ProjectManifest.current = 14` (`ProjectStore.swift:20, 26`).
  The port should also write `14` (and must, if any layer has `smoothing: true`).
- Shape PNGs are always 8-bit (made by `BrushRaster.context`, section 4.3); 16-bit PNG needs v12,
  EXR v13 - irrelevant for shapes.

### 3.4 Save / load pairing

Save (`Compositor/Document/EditorSession+Projects.swift:13`, inside the `ProjectLayerRecord(...)`
call): `shape: layer.liveShape?.style` - only a *live* shape is written (section 10).

Load (`EditorSession+Projects.swift:84`): `shape: LayerShape.loaded($0.shape, image: images[$0.id]?.image)`,
with `ShapeTool.swift:81-84`:

```swift
    static func loaded(_ style: LayerShapeStyle?, image: CGImage?) -> LayerShape? {
        guard let style, let image else { return nil }
        return LayerShape(style: style, image: image)
    }
```

So on load the style is paired with **whatever PNG is in the package**; nothing checks that the
PNG matches the style. A `shape` on a layer without `imageFile` (folder, adjustment, blank layer)
is silently discarded.

### 3.5 Complete layer-record examples (what Compositor itself writes)

Keys are sorted (Compositor sorts; it does not require sorting on read). `LayerTransform` has no
custom `Codable`, so `origin`, `size`, `rotation`, `flipX`, `flipY`, `sampling` are all required
on decode (`Compositor/Document/LayerTransform.swift:18-24`); always write all six. Compositor's
own save also writes `isGroup`, `opacity`, `blendMode` for every layer (`EditorSession+Projects.swift:13`).

Rectangle, drag (10,10) -> (40,30), radius 8, red foreground (matches
`CompositorTests/ShapeToolTests.swift:36-41`, which asserts origin (10,10) and size 30x20):

```json
{
  "blendMode" : "Normal",
  "id" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
  "imageFile" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png",
  "isGroup" : false,
  "isVisible" : true,
  "name" : "Rectangle 1",
  "opacity" : 1,
  "shape" : {
    "blue" : 0,
    "cornerRadius" : 8,
    "green" : 0,
    "kind" : "Rectangle",
    "red" : 1
  },
  "transform" : {
    "flipX" : false,
    "flipY" : false,
    "origin" : [10, 10],
    "rotation" : 0,
    "sampling" : "High quality",
    "size" : [30, 20]
  }
}
```

Smooth-corner rectangle: same, plus `"smoothing" : true` inside `shape` (manifest `version` 14).
Exact encoder output for such a style **[verified]**:

```json
{
  "blue" : 0,
  "cornerRadius" : 12,
  "green" : 0.5,
  "kind" : "Rectangle",
  "red" : 1,
  "smoothing" : true
}
```

Ellipse: `"kind" : "Ellipse"`, `"cornerRadius" : 0`, no other optional keys.

Line, thickness 4, dragged from document point (20, 30) to (60.5, 50.25) (see 4.2 for the math):

```json
"shape" : {
  "blue" : 0,
  "cornerRadius" : 0,
  "end" : [0.9550561797752809, 0.9175257731958762],
  "green" : 0,
  "kind" : "Line",
  "lineWidth" : 4,
  "red" : 0,
  "start" : [0.0449438202247191, 0.08247422680412371]
},
"transform" : { "flipX" : false, "flipY" : false, "origin" : [18, 28], "rotation" : 0,
                "sampling" : "High quality", "size" : [44, 24] }
```

with a 44 x 24 px PNG. (Swift prints the shortest round-trip decimal, the same digits as
`JSON.stringify`.)

---

## 4. How the shape layer is created

### 4.1 Session state and the drag draft

Defaults, `Compositor/Document/EditorSession.swift:236-243`:

```swift
    var shapeKind = ShapeKind.rectangle
    /// Corner radius in pixels for rectangles the Shape tool draws; 0 keeps the corners square.
    var shapeCornerRadius: Double = 0
    var shapeSmoothing = false
    /// A Line shape's thickness in document pixels.
    var shapeLineWidth: Double = 4
    /// The shape being dragged out with the Shape tool, before it becomes a layer.
    var shapeDraft: ShapeDraft?
```

These are plain session properties (not `ToolDefaults`), so they reset with each editor session.
The color is the shared foreground color, `foregroundColor` = `brushSettings.red/green/blue`
(`ColorPalette.swift:21-24`), default black (`BrushStroke.swift:12-14`).

Draft, `ShapeTool.swift:95-105`:

```swift
struct ShapeDraft: Equatable {
    let kind: ShapeKind
    let anchor: CGPoint
    var rect: CGRect
    /// Where a line is being dragged to, so its ends stay exactly where they were put.
    var end: CGPoint? = nil
    /// Document pixels, fixed when the drag starts; rectangles only.
    var cornerRadius: CGFloat = 0
    var smoothing = false
}
```

Press, `ShapeTool.swift:111-117`:

```swift
    func beginShape(at point: CGPoint) {
        guard tool == .shape, canEditLayers, point.x.isFinite, point.y.isFinite else { return }
        let anchor = CGPoint(x: point.x.rounded(), y: point.y.rounded())
        shapeDraft = ShapeDraft(kind: shapeKind, anchor: anchor, rect: CGRect(origin: anchor, size: .zero),
                                cornerRadius: shapeKind == .rectangle ? CGFloat(shapeCornerRadius) : 0,
                                smoothing: shapeKind == .rectangle && shapeSmoothing)
    }
```

- The anchor is rounded to the nearest pixel **corner** (integer document coordinate; document
  coordinate `x` is the left edge of pixel column `x`).
- **Captured at press**: kind, anchor, cornerRadius, smoothing (test:
  `ShapeToolTests.swift:139` "the draft keeps the choice made at the start of the drag").
- **Read at release**: `shapeLineWidth` and `foregroundColor` (`finishShape`, below). The live
  preview also reads them live (section 6.4).
- `canEditLayers` (`EditorSession.swift:698-701`) is false during a transform, crop, gradient
  edit, text editing, an open filter/levels/hue-saturation, a pixel move, a busy project, etc.

### 4.2 The layer box (transform) relative to the drag

Rectangles and ellipses: the box is `draft.rect` from `DragBox.rect`
(`Compositor/Document/Selection.swift:91-105`):

```swift
/// The box a drag from `anchor` to `point` spans, in whole pixels. `square` evens the sides;
/// `fromCenter` grows the box around the anchor. Shared by the Marquee and the Shape tool.
nonisolated enum DragBox {
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
}
```

So the box is always whole pixels, and **the layer transform is exactly the drag box**: no padding
for anti-aliasing (the AA fringe of an ellipse or rounded corner falls inside the box; a plain
rectangle's edges sit on pixel boundaries and are fully opaque).

Lines: `finishShape` replaces the box, `ShapeTool.swift:160-170`:

```swift
        var rect = draft.rect
        let thickness = CGFloat(shapeLineWidth)
        // A line keeps the two points it was dragged between; the layer is their box with room for the stroke's own
        // thickness (and its round ends) around them.
        var ends: (start: CGPoint, end: CGPoint)?
        if draft.kind == .line {
            let from = draft.anchor, to = draft.end ?? draft.anchor
            rect = CGRect(x: min(from.x, to.x), y: min(from.y, to.y),
                          width: abs(to.x - from.x), height: abs(to.y - from.y)).insetBy(dx: -thickness / 2, dy: -thickness / 2)
            ends = (from, to)
        }
```

- `from` = rounded anchor (integer); `to` = `draft.end`, which is the **unrounded** (snapped)
  pointer position, or the Shift-snapped point (section 6.2). So the line box is generally
  **fractional**: origin = `min(from,to) - t/2`, size = `|to - from| + t`.
- Padding is exactly `t/2` on all four sides: the round caps reach `t/2` beyond each endpoint in
  every direction, so this box is the stroke's exact bounding box. There is no extra AA margin.
- Worked example (section 3.5): from (20, 30), to (60.5, 50.25), t = 4 -> rect = (18, 28,
  44.5, 24.25).

Endpoint fractions, `ShapeTool.swift:177-182` (relative to the **fractional** `rect`, not the
truncated PNG size):

```swift
            // The ends as fractions of the box, so a scaled line still runs between the same two places.
            func unit(_ point: CGPoint) -> CGPoint {
                CGPoint(x: rect.width > 0 ? (point.x - rect.minX) / rect.width : 0.5,
                        y: rect.height > 0 ? (point.y - rect.minY) / rect.height : 0.5)
            }
            let start = ends.map { unit($0.start) }, finish = ends.map { unit($0.end) }
```

Example: start = (2/44.5, 2/24.25), end = (42.5/44.5, 22.25/24.25). `start`/`end` are `nil` (so
omitted) for rectangles and ellipses.

### 4.3 The PNG: pixel size, format, anti-aliasing

Rasterizer entry, `ShapeTool.swift:238-242`:

```swift
    /// The shape filling its box, anti-aliased where it curves.
    nonisolated static func shapeImage(_ kind: ShapeKind, size: CGSize, color: PaletteColor, cornerRadius: CGFloat = 0, smoothing: Bool = false,
                           lineWidth: CGFloat = 0, start: CGPoint? = nil, end: CGPoint? = nil) throws -> CGImage {
        let context = try BrushRaster.context(width: Int(size.width), height: Int(size.height), mask: false)
        let bounds = CGRect(origin: .zero, size: size)
```

- Called from `finishShape` with `size: rect.size` (`ShapeTool.swift:183`).
- **PNG pixel size = `Int(width) x Int(height)`** - truncation toward zero. For rectangles and
  ellipses the box is integral, so the PNG is exactly the box. For a line with a fractional box
  (44.5 x 24.25) the PNG is 44 x 24 while `bounds` and the endpoints still use 44.5 x 24.25, so up
  to <1 px of the right/bottom cap may be clipped.
- 1 PNG pixel = 1 document pixel. The document `resolution` (ppi) plays no part. Zoom plays no
  part (the preview is vector, the result is not).
- Raster format, `Compositor/Document/BrushStroke.swift:36-44`:

  ```swift
    static func context(width: Int, height: Int, mask: Bool) throws -> CGContext {
        guard let result = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * (mask ? 1 : 4),
            space: mask ? CGColorSpaceCreateDeviceGray() : CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: mask ? CGImageAlphaInfo.none.rawValue : (CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)) else { throw ExportError.render }
        result.translateBy(x: 0, y: CGFloat(height))
        result.scaleBy(x: 1, y: -1)
        return result
    }
  ```

  8-bit sRGB RGBA, premultiplied, starting fully transparent, **flipped to y-down with the origin
  at the top-left** - the same coordinate system as Canvas 2D.
- Anti-aliasing: Core Graphics default (on); nothing in the shape code changes it. Fill rule:
  `fillPath()` = non-zero winding (single closed subpath, so even-odd would be identical).
- Color: `CGColor(srgbRed:green:blue:alpha: 1)` into an sRGB context, no conversion; 8-bit
  quantization rounds to nearest **[verified]**: 0.5 -> 128, 0.2 -> 51, 0.998 -> 254.
- Saved as PNG by ImageIO (`ProjectStore.swift:101-111`), which un-premultiplies.

### 4.4 Fill vs stroke

`ShapeTool.swift:243-264` (full listing in 5.1): lines are stroked (`setLineCap(.round)`, width
`max(1, lineWidth)`), everything else is filled (`addPath(kind.path(...))` + `fillPath()`). There
is **no stroke for rectangles/ellipses and no fill for lines**, and no opacity control (alpha is 1;
layer opacity is the ordinary layer property, default 1).

### 4.5 The layer record: name, stack position, undo, selection

`ShapeTool.swift:171-191` (after the line-box code above):

```swift
        guard canEditLayers, document != nil, rect.width >= 1, rect.height >= 1 else { return }
        guard Int(rect.width) * Int(rect.height) <= Self.maxShapePixels else {
            brushError = "That shape is too large. A shape can cover up to \(DocumentLimits.maxSurfaceMegapixels) megapixels."
            return
        }
        do {
            ...
            let image = try Self.shapeImage(draft.kind, size: rect.size, color: foregroundColor, cornerRadius: draft.cornerRadius, smoothing: draft.smoothing,
                                            lineWidth: thickness, start: start, end: finish)
            let style = LayerShapeStyle(kind: draft.kind, red: foregroundColor.red, green: foregroundColor.green,
                                        blue: foregroundColor.blue, cornerRadius: draft.cornerRadius, smoothing: draft.smoothing ? true : nil,
                                        lineWidth: draft.kind == .line ? thickness : nil, start: start, end: finish)
            addPixelLayer(image, at: rect.origin, name: nextShapeName(draft.kind), editName: draft.kind.rawValue,
                          dropsSelection: false, shape: LayerShape(style: style, image: image))
        } catch { brushError = error.localizedDescription }
```

- `smoothing` is stored as `true` or omitted. Note it is stored whenever the draft had it, even
  if `cornerRadius` is 0 (possible: the checkbox keeps its value while disabled); such a shape
  renders square and still needs v14.
- `lineWidth` is the raw `shapeLineWidth` (not `max(1, ...)`, but the UI keeps it >= 1).

Name, `ShapeTool.swift:193-199`:

```swift
    /// "Rectangle 1", "Ellipse 2", … skipping names already in the document.
    func nextShapeName(_ kind: ShapeKind) -> String {
        let names = Set(document?.layers.map(\.name) ?? [])
        var number = 1
        while names.contains("\(kind.rawValue) \(number)") { number += 1 }
        return "\(kind.rawValue) \(number)"
    }
```

Lowest unused number per kind, across all layers and folders. Rounded rectangles are still
`"Rectangle N"`. The undo action name is the bare kind (`"Rectangle"`, `"Ellipse"`, `"Line"`).

Placement, `Compositor/Document/SelectionClipboard.swift:294-311`:

```swift
    /// Inserts pixels as a new layer above the active one (inside its folder), all in one undo
    /// step. Pasting drops the selection, as in Photoshop; a drawn shape keeps it.
    func addPixelLayer(_ image: CGImage, at origin: CGPoint, name: String, editName: String, dropsSelection: Bool = true, shape: LayerShape? = nil, text: LayerText? = nil) {
        guard let document, let thumbnail = try? PixelInvert.thumbnail(of: image) else { return }
        var layer = ImageLayer(asset: ImportedImage(image: image, thumbnail: thumbnail, name: name), origin: origin)
        layer.name = name
        layer.shape = shape
        layer.text = text
        layer.parentID = activeLayer?.isGroup == true ? activeLayerID : activeLayer?.parentID
        let index = document.layers.firstIndex { $0.id == activeLayerID }.map { $0 + 1 } ?? document.layers.count
        finishOpacityEdit()
        beginEdit(editName)
        self.document?.layers.insert(layer, at: index)
        if dropsSelection { self.document?.selection = nil }
        activeLayerID = layer.id
        endEdit()
    }
```

- **One new layer per shape**, inserted at array index `activeIndex + 1` (array is bottom-to-top),
  or on top when there is no active layer. Parent: the active layer itself if it is a folder,
  otherwise the active layer's parent.
- `ImageLayer(asset:origin:)` (`EditorSession.swift:29-34`) sets
  `transform = LayerTransform(origin: origin, size: <PNG width, height>)` -> rotation 0, no
  flips, sampling `"High quality"` (`LayerTransform.swift:19-24`); visible, opacity 1, Normal,
  no mask, no effects.
  - So `transform.size` = the **truncated integer PNG size**, and `transform.origin` = `rect.origin`
    which is **fractional for lines with odd thickness or a fractional end** (e.g. t = 5 ->
    origin x = anchor - 2.5). Fractional origins are valid (`LayerTransform.isValid`,
    `LayerTransform.swift:27-31`). The layer is then drawn 1:1 but at a sub-pixel offset with
    high-quality interpolation.
- The new layer becomes active; it is one undo step; **the selection is kept and does not clip
  the shape** (`ShapeToolTests.swift:42`). Shapes are not clipped to the canvas either (document
  points are not clamped; `CanvasViewport.swift:25-28`), so origins can be negative or beyond
  the canvas.

### 4.6 Size limits

- `maxShapePixels = DocumentLimits.maxSurfacePixels` = 200,000,000 (`ShapeTool.swift:109`,
  `DocumentLimits.swift:25`), tested on `Int(w) * Int(h)`; over -> error text
  `"That shape is too large. A shape can cover up to 200 megapixels."` and no layer.
- Not checked at creation but enforced at **save and load**: every PNG side must be 1-30,000
  (`DocumentLimits.maxSide`, `ProjectStore.swift:283-288`). A shape wider than 30,000 px can be
  drawn upstream but then the project cannot be saved. The port must never write such a PNG
  (recommend refusing at creation with the same error).

---

## 5. Exact geometry

### 5.1 The rasterizer

`ShapeTool.swift:243-264`:

```swift
        if kind == .line {
            // Corner to corner, inset by half the thickness so the stroke stays inside the layer.
            let thickness = max(1, lineWidth)
            context.setStrokeColor(CGColor(srgbRed: color.red, green: color.green, blue: color.blue, alpha: 1))
            context.setLineWidth(thickness)
            context.setLineCap(.round)
            // The ends sit where they were dragged, as fractions of the box. Older lines (no ends stored) ran corner
            // to corner, inset by half their thickness.
            let inset = bounds.insetBy(dx: min(thickness, size.width) / 2, dy: min(thickness, size.height) / 2)
            let from = start.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) } ?? CGPoint(x: inset.minX, y: inset.minY)
            let to = end.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) } ?? CGPoint(x: inset.maxX, y: inset.maxY)
            context.move(to: from)
            context.addLine(to: to)
            context.strokePath()
            guard let image = context.makeImage() else { throw ExportError.render }
            return image
        }
        context.setFillColor(CGColor(srgbRed: color.red, green: color.green, blue: color.blue, alpha: 1))
        context.addPath(kind.path(in: bounds, cornerRadius: cornerRadius, smoothing: smoothing))
        context.fillPath()
```

Path selection, `ShapeTool.swift:7-18`:

```swift
    func path(in rect: CGRect, cornerRadius: CGFloat = 0, smoothing: Bool = false) -> CGPath {
        if self == .ellipse { return CGPath(ellipseIn: rect, transform: nil) }
        let radius = min(max(0, cornerRadius), rect.width / 2, rect.height / 2)
        guard radius > 0 else { return CGPath(rect: rect, transform: nil) }
        if self == .rectangle, smoothing {
            return smoothedRectangle(in: rect, radius: radius)
        }
        return CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    }
```

(The doc comment above it mentions a `linePath` that does not exist; lines never go through
`path(in:)`.)

### 5.2 Rectangle and rounded rectangle

- Radius `r = min(max(0, cornerRadius), w/2, h/2)`. A radius >= half the shorter side gives a
  pill (`ShapeToolTests.swift:83-97`: radius 500 on 40 x 20 -> radius 10).
- `r == 0`: plain `CGPath(rect:)` - the whole PNG opaque.
- `r > 0`, no smoothing: `CGPath(roundedRect:cornerWidth:cornerHeight:)`, circular corners.
  Elements **[verified]** (dumped for rect (0,0,100,60), r = 10): Core Graphics builds each
  quarter circle as **one cubic Bezier with k = 4/3 tan(pi/8) = 0.5522847498** and starts at the
  middle of the right edge, going clockwise on screen (y down):

  ```
  move  (100, 30)
  line  (100, 50)
  curve (100, 55.52285) (95.52285, 60) (90, 60)
  line  (10, 60)
  curve (4.47715, 60) (0, 55.52285) (0, 50)
  line  (0, 10)
  curve (0, 4.47715) (4.47715, 0) (10, 0)
  line  (90, 0)
  curve (95.52285, 0) (100, 4.47715) (100, 10)
  close
  ```

- The radius is in document pixels and **stays fixed when the layer is scaled** (the scaled
  redraw re-uses `cornerRadius` unchanged, section 9).

### 5.3 Smooth corners (Figma 60 % squircle)

`ShapeTool.swift:20-53`, verbatim:

```swift
    /// Figma's cubic–arc–cubic corner construction at 60% smoothing (the iOS squircle match).
    /// https://www.figma.com/blog/desperately-seeking-squircles/
    /// Back off smoothing when the corners run out of room, keeping the requested radius.
    private func smoothedRectangle(in rect: CGRect, radius: CGFloat) -> CGPath {
        let smoothing = min(CGFloat(0.6), max(0, min(rect.width, rect.height) / (2 * radius) - 1))
        guard smoothing > 0 else {
            return CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
        }
        let reach = (1 + smoothing) * radius
        let angle = smoothing * .pi / 4
        let tangent = radius * tan(angle / 2)
        let c = tangent * cos(angle)
        let d = tangent * sin(angle)
        let arcLength = radius * sqrt(2) * sin((1 - smoothing) * .pi / 4)
        let b = (reach - arcLength - c - d) / 3
        let a = 2 * b
        let path = CGMutablePath()
        let corners = [CGPoint(x: rect.maxX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.maxY),
                       CGPoint(x: rect.minX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.minY)]
        for (index, corner) in corners.enumerated() {
            let rotation = CGFloat(index) * .pi / 2
            let transform = CGAffineTransform(translationX: corner.x, y: corner.y).rotated(by: rotation)
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y).applying(transform) }
            let start = point(-reach, 0)
            if index == 0 { path.move(to: start) } else { path.addLine(to: start) }
            path.addCurve(to: point(-reach + a + b + c, d),
                          control1: point(-reach + a, 0), control2: point(-reach + a + b, 0))
            path.addArc(center: CGPoint(x: -radius, y: radius), radius: radius,
                        startAngle: -.pi / 2 + angle, endAngle: -angle, clockwise: false, transform: transform)
            path.addCurve(to: point(0, reach), control1: point(0, reach - a - b), control2: point(0, reach - a))
        }
        path.closeSubpath()
        return path
    }
```

Translation, step by step (`r` = the already-clamped radius from 5.1, `s` = effective smoothing):

1. **Smoothing back-off.** `s = min(0.6, max(0, min(w, h) / (2r) - 1))`.
   Each corner's transition reaches `(1 + s) r` along each edge; the formula picks the largest
   `s <= 0.6` with `(1 + s) r <= min(w, h) / 2`, so the two transitions on the shorter side meet at
   most in its middle. The radius `r` is never reduced; only the smoothing is.
   - Full 60 % when `r <= min(w, h) / 3.2`.
   - Partial between that and `r = min(w, h) / 2`, e.g. 100 x 80, r = 30 -> s = 1/3 **[verified]**.
   - `s == 0` (r = min/2, i.e. a pill, e.g. 100 x 80 with r >= 40) -> falls back to the ordinary
     circular rounded rect. (`ShapeToolTests.swift:127-128`: smoothing with radius 500 equals the
     non-smoothed path; `:126` smoothing with radius 0 equals the plain rect.)
   This equals the figma-squircle reference's default (non-"preserveSmoothing") clamp,
   `maxSmoothing = budget / r - 1` with `budget = min(w, h) / 2`.
2. **Constants** (Figma's notation in comments):
   - `reach = (1 + s) r` - distance from the corner along each edge where the corner starts (Figma `p`).
   - `angle = s * pi/4` - both Figma's alpha and beta (45 deg * s).
   - `tangent = r * tan(angle / 2)` (Figma `p3ToP4Distance`).
   - `c = tangent * cos(angle)`, `d = tangent * sin(angle)`.
   - `arcLength = r * sqrt(2) * sin((1 - s) * pi/4)` - the chord of the circular arc (Figma `arcSectionLength`).
   - `b = (reach - arcLength - c - d) / 3`, `a = 2b`.
   - The circular arc spans `(1 - s) * 90 deg` (36 deg at s = 0.6), from local angle
     `-pi/2 + angle` to `-angle`.
3. **Local corner frame.** Corners are visited top-right, bottom-right, bottom-left, top-left
   (screen, y down). For corner `i`, the local frame is the corner point rotated by `i * 90 deg`:
   `global = corner + R(i*pi/2) * local`, `R(t)(x, y) = (x cos t - y sin t, x sin t + y cos t)`.
   In the local frame the incoming edge runs along +x towards the corner at (0, 0) and the rect
   interior is +y; the outgoing edge runs along +y.
4. **Per corner** (local coordinates):
   - `lineTo` (or `moveTo` for i = 0) `(-reach, 0)`.
   - cubic: control1 `(-reach + a, 0)`, control2 `(-reach + a + b, 0)`, end `(-reach + a + b + c, d)`.
   - circular arc, center `(-r, r)`, radius `r`, from angle `-pi/2 + angle` to `-angle`,
     **increasing angle** (`clockwise: false` in CG's math sense). Its start point equals the
     previous cubic's end (`-r + r sin(angle) = -(arcLength + d)`, `r - r cos(angle) = d`); checked
     numerically. Global arc angles = local angles + `i * pi/2`.
   - cubic: control1 `(0, reach - a - b)`, control2 `(0, reach - a)`, end `(0, reach)`.
5. `closeSubpath` (closes from the top-left corner's end `(minX + reach, minY)` back to the start
   `(maxX - reach, minY)`).

Test vector, rect (0, 0, 100, 80), r = 20 -> s = 0.6 **[verified]**:
`reach = 32`, `angle = 0.47123889803846897`, `tangent = 4.80157518160232`,
`c = 4.2782348131886145`, `d = 2.1798695162326425`, `arcLength = 8.74032048897642`,
`a = 11.201050121068214`, `b = 5.600525060534107`. First elements as Core Graphics stores them:

```
move  (68.0000, 0.0000)
curve (79.2011, 0.0000) (84.8016, 0.0000) (89.0798, 2.1799)
line  (89.0798, 2.1799)                      <- CG's addArc emits a zero-length line to the arc start
curve (92.8431, 4.0973) (95.9027, 7.1569) (97.8201, 10.9202)   <- the 36 deg arc as ONE cubic
curve (100.0000, 15.1984) (100.0000, 20.7989) (100.0000, 32.0000)
line  (100.0000, 48.0000)
... (21 elements in total)
```

The arc cubic uses the standard `k = 4/3 * tan(sweep / 4)` (sweep 36 deg -> k = 0.21117925376604835),
control points `P0 + k r T0` and `P3 - k r T3` with unit tangents in the increasing-angle
direction; checked against the dump above. `ShapeToolTests.swift:113-116`: at 60 % "the
transition reaches 32 px along each edge instead of the circular corner's 20".

### 5.4 Ellipse

`CGPath(ellipseIn: rect)` - the ellipse inscribed in the box, `cornerRadius` ignored. Elements
**[verified]** for (0, 0, 100, 60): four cubics, k = 0.5522847498, starting at the right-middle
and going clockwise on screen:

```
move  (100, 30)
curve (100, 46.56854) (77.61424, 60) (50, 60)
curve (22.38576, 60) (0, 46.56854) (0, 30)
curve (0, 13.43146) (22.38576, 0) (50, 0)
curve (77.61424, 0) (100, 13.43146) (100, 30)
close
```

Shift makes the box square, so a circle (`ShapeToolTests.swift:54-64`: Shift + Option from
(50, 40) to (60, 45) -> origin (40, 30), size 20 x 20).

### 5.5 Line

- Stroke width `max(1, lineWidth)` document px, **round caps** (`.round`); single segment, so the
  join is irrelevant; no dash.
- Endpoint mapping: `from = (start.x * size.width, start.y * size.height)`, same for `to`, in the
  y-down PNG space (0, 0) = top-left corner of the top-left pixel. At creation `size` is the
  fractional box (`rect.size`), so the ends land exactly on the dragged points relative to
  `rect.origin`; at a scaled redraw `size` is the new integer pixel size (section 9).
- Legacy lines without `start`/`end`: from `(min(t, W)/2, min(t, H)/2)` to
  `(W - min(t, W)/2, H - min(t, H)/2)` - always top-left to bottom-right.
- Zero-length line (from == to): Core Graphics draws the round cap as a filled disc of diameter
  `t` **[verified]**: t = 4 in a 4 x 4 PNG gives alpha rows
  `[73,227,227,73] [227,255,255,227] [227,255,255,227] [73,227,227,73]`. This is what a Line click
  produces (section 7).

---

## 6. Interaction (EditorCanvas)

### 6.1 Mouse down / drag / up

Down, `Compositor/Rendering/EditorCanvas.swift:1848-1850`:

```swift
        } else if session.tool == .shape, let document = session.document {
            session.beginShape(at: snappedCorner(session.viewport.documentPoint(from: point, documentSize: document.size),
                                                 flags: event.modifierFlags))
```

Drag, `EditorCanvas.swift:1940-1946`:

```swift
        if session.shapeDraft != nil, lastDragPoint == nil, let document = session.document {
            // Unlike the Marquee, Option has no other job here, so it draws from the center as in Photoshop.
            session.dragShape(to: snappedCorner(session.viewport.documentPoint(from: point, documentSize: document.size),
                                                flags: event.modifierFlags),
                              square: event.modifierFlags.contains(.shift), fromCenter: event.modifierFlags.contains(.option))
            synchronizeDisplay()
            return
        }
```

Up, `EditorCanvas.swift:2132-2135`:

```swift
        if session.shapeDraft != nil {
            session.finishShape()
            synchronizeDisplay()
        }
```

- Document points are continuous (fractional) and unclamped:
  `CanvasViewport.swift:25-28` `((point - docOrigin) / pointsPerPixel)`.
- Modifiers are sampled **per drag event**. There is no `flagsChanged` handling for shapes, so
  pressing/releasing Shift or Option without moving the mouse changes nothing until the next
  move. (The Marquee's "Shift-at-press must be re-pressed" arming, `EditorCanvas.swift:124-126`,
  does **not** apply to shapes: Shift held at the press squares immediately.)
- Mouse up does not take a new point: the shape is the last dragged draft.
- While Space-panning (`lastDragPoint != nil`) drag events don't reshape the draft.

### 6.2 Shift and Option

`ShapeTool.swift:125-142`:

```swift
    /// Shift makes a square or circle; Option grows the shape from its center, as in Photoshop.
    func dragShape(to point: CGPoint, square: Bool, fromCenter: Bool) {
        guard var draft = shapeDraft, point.x.isFinite, point.y.isFinite else { return }
        // Shift on a line snaps its angle to eighths of a turn — flat, upright, or 45° — rather than squaring a box.
        if draft.kind == .line, square {
            let dx = point.x - draft.anchor.x, dy = point.y - draft.anchor.y
            let angle = (atan2(dy, dx) / (.pi / 4)).rounded() * (.pi / 4)
            let length = hypot(dx, dy)
            let snapped = CGPoint(x: draft.anchor.x + cos(angle) * length, y: draft.anchor.y + sin(angle) * length)
            draft.end = snapped
            draft.rect = DragBox.rect(from: draft.anchor, to: snapped, square: false, fromCenter: fromCenter)
            shapeDraft = draft
            return
        }
        if draft.kind == .line { draft.end = point }
        draft.rect = DragBox.rect(from: draft.anchor, to: point, square: square, fromCenter: fromCenter)
        shapeDraft = draft
    }
```

- **Shift, Rectangle/Ellipse**: square box, side = `max(|dx|, |dy|)` of the rounded deltas,
  keeping each delta's sign (so the square grows toward the pointer's quadrant). Rectangle ->
  square, Ellipse -> circle.
- **Shift, Line**: the angle is rounded to the nearest multiple of 45 deg (`.rounded()` = half
  away from zero), the **length is kept** (`hypot` of the unrounded delta). The end is fractional
  (e.g. a 45 deg line has `dx = dy = length / sqrt(2)`); a "vertical" line can carry a ~1e-16 x
  offset from `cos(pi/2)`.
- **Option, Rectangle/Ellipse**: the anchor is the center; box = anchor +/- |dx|, |dy| (so sides
  are always even). Combined with Shift: centered square/circle.
- **Option, Line: no effect.** It only changes `draft.rect`, but for lines `finishShape`
  rebuilds the box from `anchor` and `end` (4.2) and the preview draws `anchor -> end`
  (`shapeLineEnds`, `ShapeTool.swift:120-123`). (The status bar still says "Option from center"
  for every kind.)

### 6.3 Snapping, Control, Escape, tool switches

- Both the press point and each drag point go through `snappedCorner`
  (`EditorCanvas.swift:2412-2416`):

  ```swift
    /// A Marquee or shape corner at `pixel` (document pixels), snapped to View > Snap To targets unless Control is held.
    private func snappedCorner(_ pixel: CGPoint, flags: NSEvent.ModifierFlags) -> CGPoint {
        guard !flags.contains(.control) else { session.snapGuides = ([], []); return pixel }
        return session.snappedPoint(pixel, tolerance: TransformSnap.distance / max(session.viewport.pointsPerPixel, 0.0001))
    }
  ```

  Each axis independently snaps to the nearest target within 10 screen points
  (`TransformSnap.distance`, `LayerTransform.swift:221`); targets are `alignmentSnapTargets(includeCenters: false)`
  (`Crop.swift:209-211`, `Guides.swift:247-284`): canvas edges, rounded edges of other pixel
  layers' bounding boxes, visible grid lines, visible guides - each toggleable in View > Snap To
  (all default on). Control disables snapping. Snapping happens before the anchor rounding and
  before Shift's angle snap.
- Escape cancels the draft (`EditorCanvas.swift:2231-2233`); so do switching tools
  (`EditorSession.swift:398`), changing the kind in the picker (`ShapeControls.swift:9-12`),
  Shift-U / Tab (`toggleShapeKind` calls `cancelShape`, `ShapeTool.swift:150`), and the canvas
  losing focus (`EditorCanvas.swift:2337`).
- Keys: `U` selects the Shape tool; `Shift-U` (when already in Shape) or `Tab` cycles
  Rectangle -> Ellipse -> Line (`EditorCanvas.swift:2296-2298`, `EditorSession.swift:435`). The
  command palette has "Rectangle", "Ellipse", "Line" entries that select the tool and set the kind
  (`CommandPalette.swift:210-212`).
- Status-bar hint (`ContentView.swift:365`): `"Drag to draw a shape on a new layer · Shift <45°|square|circle> · Option from center · Shift-U or Tab for the next shape · Escape cancel · Space to pan"`.

### 6.4 Live preview

`EditorCanvas.swift:1246-1270` (Core Graphics canvas; the GPU canvas rasterizes the same function
into a small bitmap, `EditorCanvas.swift:2714-2725`):

```swift
    /// The shape being dragged out with the Shape tool, drawn in the color it will be made in.
    private func drawShapeDraft(scale: CGFloat, center: (CGPoint) -> CGPoint, in context: CGContext) {
        // A flat or upright line has a box with no height or width, which is not "empty" for this purpose.
        guard let draft = session.shapeDraft,
              draft.kind == .line ? (draft.rect.width > 0 || draft.rect.height > 0) : !draft.rect.isEmpty else { return }
        let middle = center(CGPoint(x: draft.rect.midX, y: draft.rect.midY))
        let rect = CGRect(x: middle.x - draft.rect.width * scale / 2, y: middle.y - draft.rect.height * scale / 2,
                          width: draft.rect.width * scale, height: draft.rect.height * scale)
        context.saveGState()
        context.setFillColor(session.foregroundColor.nsColor.cgColor)
        if draft.kind == .line {
            guard let ends = session.shapeLineEnds else { context.restoreGState(); return }
            let thickness = max(1, CGFloat(session.shapeLineWidth) * scale)
            context.setStrokeColor(session.foregroundColor.nsColor.cgColor)
            context.setLineWidth(thickness)
            context.setLineCap(.round)
            // Exactly the two points being dragged between, so the start never shifts.
            context.move(to: center(ends.start))
            context.addLine(to: center(ends.end))
            context.strokePath()
        } else {
            context.addPath(draft.kind.path(in: rect, cornerRadius: draft.cornerRadius * scale, smoothing: draft.smoothing))
            context.fillPath()
        }
        context.restoreGState()
    }
```

- The preview is **vector, drawn in screen space** at the current zoom (`scale` = screen px per
  document px): rect mapped to screen, radius x scale, thickness `max(1, t * scale)`. Same path
  code as the final raster, so smoothing/reduction match.
- It uses the **current** foreground color and line width.
- Nothing is previewed until the box is non-empty (rect/ellipse need width and height > 0; a line
  needs either > 0).
- Z-order: "The shape being dragged out previews where its layer will go — above the active layer —
  rather than over everything, so the layers above it cover it as they will once it is made."
  (`EditorCanvas.swift:1158-1164`, GPU `:3174-3181`). The draw hook runs right after the active
  layer is drawn; if the active layer is not drawn (hidden, a folder, none) the code path that
  draws the draft is not reached for shapes (new text has a fallback, shapes do not).

---

## 7. Click without drag, minimum sizes

- Rectangle / Ellipse: a click (no drag event) leaves `rect` 0 x 0; `finishShape`'s guard
  `rect.width >= 1, rect.height >= 1` makes nothing. Same for any drag whose rounded delta is 0 on
  either axis (e.g. a perfectly horizontal drag), unless Shift squares it. Test:
  `ShapeToolTests.swift:67-81` (click, Escape and tool switch all make no layer).
- Line: there is **no minimum**. A click without a drag gives `to = draft.end ?? draft.anchor`
  = anchor, so the box is `t x t` and the guard passes: Compositor creates a `"Line N"` layer
  containing a **round dot of diameter t** centered on the clicked pixel corner (start = end =
  (0.5, 0.5)). Derived from the code and the CG zero-length-cap behavior **[verified]**; upstream's
  doc comment ("A click without a drag makes nothing", `ShapeTool.swift:156`) is only true for
  rectangles/ellipses, and the test only covers a rectangle.
- Maximum: 200 MP per shape (4.6), and 30,000 px per side for anything that is saved.

---

## 8. Tool options UI

`Compositor/UI/ShapeControls.swift` (shown when `tool == .shape`, `ContentView.swift:49-51`):

| Control | Lines | Shown for | Default | Behavior |
|---|---|---|---|---|
| Title "Shape" | 8 | all | - | header font |
| Segmented picker Rectangle / Ellipse / Line | 9-16 | all | Rectangle | setting it cancels a draft; help "Shift-U (or Tab) steps through Rectangle, Ellipse and Line" |
| Color swatch 36 x 18 (rounded 3, black 50 % border) | 17-25 | all | foreground (black) | opens the foreground color picker; accessibility "Fill color"; help "Shapes fill with the foreground color; click to change it" (also the line's stroke color) |
| "Width" scrub label + slider + field (`px`) | 26-40 | Line | 4 | slider 1-100, rounds to whole px, shows `min(100, value)`; field 1-5000, 0 decimals shown, non-finite -> 4; Up/Down arrows +/-1; label scrub 1 px per point, 1-5000 (not rounded) |
| "Radius" scrub label + slider + field (`px`) | 41-55 | Rectangle | 0 | slider 0-200 whole px, shows `min(200, value)`; field 0-5000, non-finite -> 0; arrows +/-1; scrub 0-5000; help "Round the rectangle's corners by this many pixels; 0 keeps them square" |
| Checkbox "Smooth Corners" | 56-62 | Rectangle | off | disabled while radius <= 0 (keeps its value); help "Set a radius above 0 to use smooth corners." / "Use smooth squircle corners at 60% smoothing, matching Figma's iOS setting" |

The whole bar is disabled while busy or without a document (line 67). There is no opacity,
stroke-for-fills, fill-for-lines, anti-alias, or per-corner-radius control. Tool rail: icon
`square.on.circle`, tooltip "Shape (U) · Shift-U switches Rectangle/Ellipse"
(`EditorSession.swift:98-99`; the tooltip predates Line).

---

## 9. Scaling: "redraws cleanly when scaled"

Trigger: `commitTransform` (`EditorSession.swift:484-525`) - after setting the new transform it
calls `redrawShape(at:)` for the single layer (`:522-523`) or for each member of a multi-layer
transform (`:511-512`), inside the same undo step ("Transform Layer(s)"). Transform drags commit
whole-pixel sizes (`EditorCanvas.swift:2022-2023`, `.rounded()`, `LayerTransform.swift:53-59`);
typed values from the Transform inspector can stay fractional.

`ShapeTool.swift:201-216`:

```swift
    /// A shape layer scaled to a new size draws its shape again at that size, so a rounded corner keeps its radius
    /// instead of stretching. Part of the edit that changed the size.
    func redrawShape(at index: Int) {
        guard let layer = document?.layers[index], let shape = layer.liveShape, let asset = layer.asset else { return }
        let width = max(1, Int(layer.transform.size.width.rounded())), height = max(1, Int(layer.transform.size.height.rounded()))
        guard width != asset.image.width || height != asset.image.height, width * height <= Self.maxShapePixels,
              let image = try? Self.shapeImage(shape.style.kind, size: CGSize(width: width, height: height),
                                               color: shape.style.color, cornerRadius: shape.style.cornerRadius, smoothing: shape.style.smoothing == true,
                                               lineWidth: shape.style.lineWidth ?? 0,
                                               start: shape.style.start, end: shape.style.end),
              let thumbnail = try? PixelInvert.thumbnail(of: image) else { return }
        // A mask that follows the layer's pixel grid stays exactly where it is while that grid changes size.
        if let mask = layer.mask, mask.placement == nil { document?.layers[index].mask?.placement = layer.maskTransform }
        document?.layers[index].asset = ImportedImage(image: image, thumbnail: thumbnail, name: asset.name)
        document?.layers[index].shape = LayerShape(style: shape.style, image: image)
    }
```

Rules:

- New PNG size = `round(transform.size)` (min 1). If that equals the current PNG size (a move,
  rotation, flip, or a sub-0.5 px change) nothing is redrawn. Over 200 MP: not redrawn, the old
  pixels just stretch and the shape stays live.
- The transform itself is unchanged; rotation and flips stay in the transform (the PNG is always
  drawn upright and unflipped).
- What stays constant in **document pixels**: `cornerRadius` and `lineWidth`. What scales:
  the box, and therefore the line's endpoints (fractions of the box) and also the line's padding
  (the padding is part of the box, so it scales while the stroke width does not).
  Smoothing is recomputed for the new box (it may back off or recover).
- A redrawn line uses the integer pixel size for `start * W`, whereas creation used the
  fractional box; the endpoints can move by a fraction of a pixel on the first redraw. Replicate.
- Masked shape layer: a mask with no own placement gets `placement = layer.maskTransform` (the new
  layer transform), so the saved record gains `maskPlacement` equal to `transform`.
- After a redraw the PNG pixel size equals the transform size again, so Transform's scale %
  reads 100 % (`LayerTransform.swift:43`).

Live preview while scaling, `ShapeTool.swift:218-236`, used by both canvases
(`EditorCanvas.swift:1081-1083`, `:3094-3095`):

```swift
    func shapeTransformPreview(for layer: ImageLayer, transform: LayerTransform) -> CGImage? {
        guard transformEdit != nil, let shape = layer.liveShape, shape.style.kind == .rectangle, shape.style.cornerRadius > 0 else {
            ...
            return nil
        }
        let size = transform.size
        guard size.width >= 1, size.height >= 1,
              abs(size.width - CGFloat(shape.image.width)) >= 0.5 || abs(size.height - CGFloat(shape.image.height)) >= 0.5 else { return nil }
        let factor = min(1, 2048 / max(size.width, size.height))
        let drawn = CGSize(width: max(1, (size.width * factor).rounded()), height: max(1, (size.height * factor).rounded()))
        ...
        guard let image = try? Self.shapeImage(.rectangle, size: drawn, color: shape.style.color,
                                               cornerRadius: shape.style.cornerRadius * factor, smoothing: shape.style.smoothing == true) else { return nil }
```

- Only **rounded rectangles** (radius > 0, smooth or not) get a re-rasterized preview during the
  drag, at most 2048 px on the long side (radius scaled by the same factor), stretched onto the
  draft transform. Ellipses, lines and square rectangles just stretch their existing pixels until
  the commit redraw. `ShapeToolTests.swift:133-162` asserts the preview, the committed redraw and
  a fresh `shapeImage` at the new size are byte-identical.

Other size changes: Image Size with new pixel dimensions resamples every layer and **drops**
`shape` ("Live text and shapes are resampled into plain pixels", `ImageResizer.swift:29`; the
record at `:98` has no `shape:`). Canvas Size, Crop and Trim go through `CanvasResizer`, which only
offsets transforms and **keeps** `shape` (`CanvasResizer.swift:31`).

---

## 10. When shape metadata is dropped (or kept)

Liveness is by **image identity**, `ShapeTool.swift:74-93`:

```swift
/// A layer made with the Shape tool. Its pixels are an ordinary raster, so it clips, masks, blends and filters like
/// any layer; `image` is the raster the shape drew. Once anything else changes those pixels (painting, a filter),
/// the layer's image is no longer this one and the layer is plain pixels from then on.
...
extension ImageLayer {
    /// The shape this layer still is: nil once its pixels were edited some other way.
    var liveShape: LayerShape? {
        guard let shape, let image = asset?.image, image === shape.image else { return nil }
        return shape
    }
}
```

Nothing ever sets `shape = nil` explicitly; the stale `shape` simply stops being live, and the next
save writes `shape: layer.liveShape?.style` = omitted. Undo that restores the old image restores
liveness (image and style are restored as a pair).

Dropped (pixels replaced): painting/erasing/any brush, blur/smudge/liquify, clone/heal, filters
and destructive adjustments, deleting/filling selected pixels, pixel moves, distort
(perspective) apply, merges (new layer), Image Size resample.

Kept (pixels untouched): move, rotate, flip (`LayerFlip.swift` changes only the transform), scale
(redrawn, still live), duplicate layer (copies share the image, `SelectionClipboard.swift:271`),
mask add/paint/link/unlink, effects, opacity, blend mode, rename, visibility, reorder, grouping,
clipping, Canvas Size / Crop / Trim, Image Size with unchanged pixel dimensions, save/reload.

Port rule: whenever the port changes a shape layer's pixels by anything other than a shape
redraw, remove `shape` from that layer's record. Whenever it writes `shape`, the PNG must be the
rasterization of that style at `PNG size == round(transform.size)`; otherwise Compositor shows the
foreign PNG and, at the first transform commit whose rounded size differs from the PNG size,
silently replaces it with its own rasterization.

---

## 11. Porting notes for Canvas 2D

### 11.1 Raster setup

```js
// One shape raster. w, h: the (possibly fractional) box size; the canvas truncates like Swift's Int().
function makeRaster(w, h) {
  const W = Math.trunc(w), H = Math.trunc(h);
  const canvas = new OffscreenCanvas(W, H);
  // willReadFrequently forces Chromium's CPU (Skia raster) backend: deterministic AA, no GPU MSAA.
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  return { canvas, ctx, W, H };
}
const q = v => Math.round(Math.min(1, Math.max(0, v)) * 255); // CG rounds to nearest: 0.5 -> 128
const css = s => `rgb(${q(s.red)}, ${q(s.green)}, ${q(s.blue)})`;
```

- Canvas 2D is already y-down with (0, 0) at the top-left pixel corner, matching the flipped CG
  context; draw with **no** extra transform and **no** devicePixelRatio scaling.
- Guard like upstream: rect/ellipse need `w >= 1 && h >= 1`; `Math.trunc(w) * Math.trunc(h) <= 200e6`;
  additionally refuse sides > 30,000.
- Export with `canvas.convertToBlob({ type: 'image/png' })` (8-bit RGBA). Name it
  `<UPPERCASE-UUID>.png`.

### 11.2 Paths (emit the same Beziers Core Graphics uses)

Using explicit cubics instead of `ctx.ellipse` / `ctx.roundRect` / `ctx.arc` removes the
geometric difference (Skia draws arcs as exact conics, CG as cubics with k = 0.5523; the radial
error is about 0.027 % of the radius, i.e. ~0.27 px at r = 1000).

```js
const K90 = 0.5522847498307936; // 4/3 * tan(pi/8)

function rectPath(ctx, x, y, w, h, cornerRadius, smoothing) {   // ShapeKind.rectangle.path(in:...)
  const r = Math.min(Math.max(0, cornerRadius), w / 2, h / 2);
  ctx.beginPath();
  if (!(r > 0)) { ctx.rect(x, y, w, h); return; }
  if (smoothing) { smoothedRectPath(ctx, x, y, w, h, r); return; }
  roundedRectPath(ctx, x, y, w, h, r);
}

function roundedRectPath(ctx, x, y, w, h, r) {   // CGPath(roundedRect:) element order, 5.2
  const k = K90 * r, X = x + w, Y = y + h;
  ctx.moveTo(X, y + h / 2);
  ctx.lineTo(X, Y - r);
  ctx.bezierCurveTo(X, Y - r + k, X - r + k, Y, X - r, Y);
  ctx.lineTo(x + r, Y);
  ctx.bezierCurveTo(x + r - k, Y, x, Y - r + k, x, Y - r);
  ctx.lineTo(x, y + r);
  ctx.bezierCurveTo(x, y + r - k, x + r - k, y, x + r, y);
  ctx.lineTo(X - r, y);
  ctx.bezierCurveTo(X - r + k, y, X, y + r - k, X, y + r);
  ctx.closePath();
}

function ellipsePath(ctx, x, y, w, h) {         // CGPath(ellipseIn:) element order, 5.4
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, kx = K90 * rx, ky = K90 * ry;
  ctx.beginPath();
  ctx.moveTo(x + w, cy);
  ctx.bezierCurveTo(x + w, cy + ky, cx + kx, y + h, cx, y + h);
  ctx.bezierCurveTo(cx - kx, y + h, x, cy + ky, x, cy);
  ctx.bezierCurveTo(x, cy - ky, cx - kx, y, cx, y);
  ctx.bezierCurveTo(cx + kx, y, x + w, cy - ky, x + w, cy);
  ctx.closePath();
}

function smoothedRectPath(ctx, x, y, w, h, radius) {   // ShapeTool.swift:23-53, r already clamped
  const s = Math.min(0.6, Math.max(0, Math.min(w, h) / (2 * radius) - 1));
  if (!(s > 0)) { roundedRectPath(ctx, x, y, w, h, radius); return; }
  const reach = (1 + s) * radius;
  const angle = s * Math.PI / 4;
  const tangent = radius * Math.tan(angle / 2);
  const c = tangent * Math.cos(angle), d = tangent * Math.sin(angle);
  const arcLength = radius * Math.SQRT2 * Math.sin((1 - s) * Math.PI / 4);
  const b = (reach - arcLength - c - d) / 3, a = 2 * b;
  const a0 = -Math.PI / 2 + angle, a1 = -angle;            // arc, local frame, increasing angle
  const kr = (4 / 3) * Math.tan((a1 - a0) / 4) * radius;   // CG turns the <= 90 deg arc into one cubic
  const ox = -radius, oy = radius;                         // arc center, local
  const p0 = [ox + radius * Math.cos(a0), oy + radius * Math.sin(a0)];
  const p3 = [ox + radius * Math.cos(a1), oy + radius * Math.sin(a1)];
  const c1 = [p0[0] - kr * Math.sin(a0), p0[1] + kr * Math.cos(a0)];
  const c2 = [p3[0] + kr * Math.sin(a1), p3[1] - kr * Math.cos(a1)];
  const corners = [[x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  corners.forEach(([cx, cy], i) => {
    const t = i * Math.PI / 2, cos = Math.cos(t), sin = Math.sin(t);
    const P = (px, py) => [cx + px * cos - py * sin, cy + px * sin + py * cos];
    const start = P(-reach, 0);
    if (i === 0) ctx.moveTo(...start); else ctx.lineTo(...start);
    ctx.bezierCurveTo(...P(-reach + a, 0), ...P(-reach + a + b, 0), ...P(-reach + a + b + c, d));
    ctx.bezierCurveTo(...P(...c1), ...P(...c2), ...P(...p3));
    ctx.bezierCurveTo(...P(0, reach - a - b), ...P(0, reach - a), ...P(0, reach));
  });
  ctx.closePath();
}
```

**[verified]** These four functions were run in Node against a recording mock context and
compared point by point with the Core Graphics paths built by upstream `ShapeKind.path(in:)`:
rounded rect and ellipse match the 5.2 / 5.4 dumps exactly; the smooth rect matches for
(3, 5, 100, 80) r = 20 (s = 0.6), r = 30 (s = 1/3, partial back-off) and (3, 5, 37, 91) r = 11.5,
max difference < 1e-6 px (CG's extra zero-length `line` elements aside, which do not affect a
fill). For (0, 0, 100, 80), r = 20 the first corner is `(68,0)`,
`(79.2011,0) (84.8016,0) (89.0798,2.1799)`, `(92.8431,4.0973) (95.9027,7.1569) (97.8201,10.9202)`,
`(100,15.1984) (100,20.7989) (100,32)`; use it as a unit test. `ctx.arc(...)`
would also be acceptable (same circle, same direction: Canvas `arc(..., false)` sweeps
increasing angles in y-down space exactly like CG's `clockwise: false`), at the cost of the
conic-vs-cubic difference.

Fill: `ctx.fillStyle = css(style); ctx.fill('nonzero')` over the whole box
`(0, 0, w, h)` where `w, h` = box size (integral for rect/ellipse).

### 11.3 Lines

```js
function drawLine(ctx, w, h, style) {            // w, h: fractional box at creation, integer at redraw
  const t = Math.max(1, style.lineWidth ?? 0);
  const ix = Math.min(t, w) / 2, iy = Math.min(t, h) / 2;
  const from = style.start ? [style.start[0] * w, style.start[1] * h] : [ix, iy];
  const to   = style.end   ? [style.end[0] * w,   style.end[1] * h]   : [w - ix, h - iy];
  ctx.fillStyle = ctx.strokeStyle = css(style);
  ctx.beginPath();
  if (from[0] === to[0] && from[1] === to[1]) {
    // CG draws a zero-length round-capped segment as a disc; the HTML canvas spec prunes
    // zero-length segments, so draw the disc explicitly instead of relying on the engine.
    ctx.arc(from[0], from[1], t / 2, 0, 2 * Math.PI);
    ctx.fill();
    return;
  }
  ctx.lineWidth = t;
  ctx.lineCap = 'round';
  ctx.moveTo(...from);
  ctx.lineTo(...to);
  ctx.stroke();
}
```

Creation math to replicate exactly (4.2): `from = anchor` (rounded), `to = lastDragPoint`
(unrounded, after snapping / Shift angle snap), `box = bbox(from, to) grown by t/2`,
`start/end = (p - box.min) / box.size` (0.5 when a size is 0, which cannot happen since t >= 1),
raster `Math.trunc(box.size)`, render with the **fractional** box size, layer
`transform.origin = box.min` (may be fractional), `transform.size = [trunc(w), trunc(h)]`.

### 11.4 Where Canvas 2D and Core Graphics can differ

Expected differences, all confined to edge pixels:

1. **Coverage anti-aliasing.** CG's rasterizer and Skia's (analytic AA or supersampling) estimate
   partial coverage differently: typically +/-1-3 alpha levels on edge pixels, occasionally more
   on nearly horizontal/vertical curve tangents. Interior pixels are exactly 255, exterior
   exactly 0, and plain rectangles (`r == 0`, integral box) are identical.
2. **GPU canvases.** A GPU-accelerated 2D canvas may use MSAA or different coverage math; use
   `willReadFrequently: true` (CPU) for the PNG that is written.
3. **Round caps.** Both strokers approximate the semicircular cap with curves; sub-pixel.
4. **Arcs/ellipses** if `ctx.arc` / `ctx.ellipse` / `ctx.roundRect` are used instead of 11.2's cubics:
   up to ~0.027 % of the radius.
5. **Premultiplication.** Both store 8-bit premultiplied pixels and un-premultiply when encoding
   the PNG; rounding conventions differ, so RGB of low-alpha edge pixels may differ by 1-2 levels
   (alpha unaffected). Invisible when composited.
6. **Color quantization.** Use `Math.round(v * 255)` (CG rounds to nearest). Passing fractional
   CSS `rgb()` values lets the browser round, which may differ at exact halves.
7. **Display placement.** Line layers with fractional origins are drawn by Compositor with
   high-quality interpolation at a sub-pixel offset; in the board use `drawImage` at the
   fractional origin with `imageSmoothingEnabled = true`, `imageSmoothingQuality = 'high'`. This
   affects only on-screen compositing, not the PNG.

Core Graphics reference values for port tests **[verified]**, black fill/stroke, alpha channel;
accept |delta| <= 4 on edge pixels and exact 0/255 elsewhere:

| Case | Alpha |
|---|---|
| Ellipse in 10 x 10, row 0 | `0, 0, 77, 190, 243, 243, 190, 77, 0, 0` |
| Ellipse in 10 x 10, row 4 | `243, 255, 255, 255, 255, 255, 255, 255, 255, 243` |
| Rounded rect 20 x 20, r = 6, rows 0-2, x 0-7 | `0,0,6,109,200,243,255,255` / `0,27,207,255,255,255,255,255` / `6,207,255,255,255,255,255,255` |
| Smooth rect 20 x 20, r = 6 (s = 0.6), rows 0-2, x 0-9 | `0,0,6,106,188,227,246,253,255,255` / `0,28,209,255,...` / `6,209,255,...` |
| Line t = 3, (1.5, 2.5) -> (10.5, 2.5) in 12 x 5, rows 0-4 | `0 x12` / `133,249,255 x8,249,133` / `243,255 x10,243` / `133,249,255 x8,249,133` / `0 x12` |
| Zero-length line (dot) t = 4 in 4 x 4 | `73,227,227,73` / `227,255,255,227` / `227,255,255,227` / `73,227,227,73` |

Also reproduce upstream's own assertions (`ShapeToolTests.swift:43-45, 62-64, 90-97, 111-118`),
e.g. 40 x 30 at (10, 10) with r = 8: pixels (10,10) and (11,11) transparent, (13,13) opaque,
(30,10) opaque; smooth 100 x 80 with r = 20 at (10, 20): (35, 20.01) outside, (43, 20.01) inside.

### 11.5 Behavior checklist for the board

- Kinds Rectangle / Ellipse / Line; Shift-U and Tab cycle; U selects the tool.
- Options: Radius 0-5000 (Rectangle), Smooth Corners (Rectangle, disabled at radius 0), Width
  1-5000 default 4 (Line), foreground swatch. Capture kind/radius/smoothing at press; read width
  and color at release.
- Anchor = round(snapped press); rect/ellipse box = `DragBox.rect` with Shift = square, Option =
  from center; Line: Shift = 45 deg angle snap keeping length, Option = no effect.
- Preview: vector, screen space, current color/width, composited just above the active layer.
- Release: rect/ellipse need a >= 1 x 1 box; a Line click makes a dot. New layer above the
  active one (inside its folder / inside the active folder), named `"<Kind> <n>"`, active,
  selection kept, one undo step.
- Scale commit: re-rasterize at `round(size)` with constant radius and line width; keep the style.
- Any other pixel edit: drop `shape`.
- Manifest: `version` 14; `shape` keys exactly as in 3.2 (always include `cornerRadius`; points
  as `[x, y]`; `smoothing` only as `true`); transform with all six keys.

---

## 12. Upstream quirks a faithful port inherits

1. Line click without drag creates a dot layer (section 7), despite the comment at `ShapeTool.swift:156`.
2. Option has no effect on lines (6.2), though the hint says "Option from center".
3. Line endpoint fractions are computed against the fractional box but the PNG and transform are
   truncated, so the first scaled redraw can shift the ends by < 1 px (9).
4. `smoothing: true` is stored even when the radius is 0 (4.5), forcing v14 for a square rectangle.
5. Shapes larger than 30,000 px on a side can be drawn but make the project unsaveable (4.6);
   the port should refuse them instead.
6. Stale texts: the `linePath` reference (`ShapeTool.swift:8-9`) and the tool tooltip
   "Shift-U switches Rectangle/Ellipse" (`EditorSession.swift:99`).
7. No range validation of shape values on load; the port should still write in-range values
   (colors 0-1, radius 0-5000, width 1-5000, ends 0-1).
