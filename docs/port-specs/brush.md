# Compositor Brush and Eraser Engine: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only). All `file:line` references are relative to
`upstream/Compositor/`. Code excerpts are verbatim.

Files read in full: `Document/BrushStroke.swift` (1126 lines), `Document/EditorSession+Brush.swift` (269),
`Rendering/MetalBrushCoverage.swift` (162), `UI/BrushControls.swift` (152), `Document/ToolDefaults.swift` (42),
`Rendering/BrushCursorOverlay.swift` (95), `Rendering/BrushPixels.c` (50). Searched: `Rendering/EditorCanvas.swift`
(3233). Supporting definitions came from `Document/EditorSession.swift`, `Rendering/CanvasViewport.swift`,
`Document/LayerTransform.swift`, `Document/LayerMask.swift`, `Document/Selection.swift`, `Rendering/RasterSnapshot.swift`,
`Document/ColorPalette.swift`, `Document/TypeTool.swift`, `Document/ShapeTool.swift`, `ContentView.swift`,
`UI/NumericScrub.swift` and `CompositorTests/BrushIntersectionTests.swift`.

`ToolDefaults.swift` holds no brush settings. It only persists Bool, Int and String toggles (auto-select, rulers, grid,
snapping). **Brush settings are not persisted** across launches (see section 2).

---

## 0. Conventions

- **Document space**: document pixels, origin at the top-left, y pointing down. The document canvas is the rect
  `[0, W) x [0, H)`, and pixel `(i, j)` covers `[i, i+1) x [j, j+1)`.
- **Grid**: the pixel grid of the paint target. This is the layer's own image pixels, or the mask's pixels for a mask
  stroke. A layer has a `LayerTransform`, so one grid pixel can be larger or smaller than one document pixel, and can
  be rotated or flipped.
- **Coverage**: a per-pixel value in [0, 1] that says how strongly the stroke reaches that grid pixel. One coverage
  value covers the whole stroke.
- There are two engines. The **GPU continuous engine** (`MetalBrushCoverage`) runs whenever Metal is available
  (`gpu = useGPU ? MetalBrushCoverage.shared : nil`, `BrushStroke.swift:202`, and `useGPU` defaults to `true`). That
  covers every real session on a supported Mac. The **CPU dab engine** is only a fallback used by tests and machines
  without Metal. **The port should reproduce the GPU engine.** The CPU engine is summarised in section 16.

---

## 1. Pipeline overview

```
NSEvent (view points)
  -> EditorCanvas.mouseDown / mouseDragged / mouseUp
       -> CanvasViewport.documentPoint            (view point -> document point, fractional)
       -> Shift axis lock / Shift-click line      (EditorCanvas)
  -> EditorSession.beginBrush / continueBrush     (EditorSession+Brush.swift)
       -> smoothed(): lazy-string stabiliser      (Brush tool only)
  -> BrushStroke.append(point)                    (sliding window of 4 samples)
       -> settled piece: centripetal Catmull-Rom, adaptively split into chords (<= 0.2 px error)
       -> provisional tail: straight chord to the newest sample (preview only)
  -> MetalBrushCoverage kernel, per grid pixel of touched 256 px tiles:
       hard: permanent = max(permanent, cov(settled)); preview = max(permanent, cov(tail))
       soft: permanent += density integral; preview = 1 - exp(-(permanent + tail density))
       -> 8-bit coverage per tile
  -> publish(): each touched tile = ORIGINAL tile pixels, then color through coverage at `opacity`
                (source-over), or destination-out for Erase
  -> mouse-up: flush() -> paintSnapshot() (layer grows to fit the paint) -> commitPaintSnapshot() (one undo step)
```

---

## 2. Parameters

`BrushSettings` (`Document/BrushStroke.swift:9-27`):

```swift
var diameter: CGFloat = 40
var hardness: CGFloat = 1
var red: CGFloat = 0
var green: CGFloat = 0
var blue: CGFloat = 0
/// Caps the whole stroke, as in Photoshop: overlapping dabs never exceed it.
var opacity: CGFloat = 1
/// 0–100. The brush trails the pointer on a string of this length, so a shaky hand
/// draws a smooth line; 0 follows the pointer exactly.
var smoothing: CGFloat = 0
...
var erasing = false
```

| Parameter | Meaning and units | Default | UI range | Engine validation |
|---|---|---|---|---|
| `diameter` | Tip **diameter** in **document pixels**. It does not depend on zoom or on layer scale. Radius = `diameter / 2`. | 40 | 1...2000 (`BrushControls.swift:41-51`) | `1...2100` (`maxDiameter`, `BrushStroke.swift:147`, checked at `:233`), else throws `tooLarge` |
| `hardness` | Fraction of the radius painted at full strength, 0...1 | 1 (Brush family); Clone Stamp and Smear park their own tip at 0 | 0...100 % (`:52-60`) | `0...1` (`:234`) |
| `opacity` | Cap on the whole stroke, 0.01...1 | 1 | 1...100 % (`:61-71`) | `0.01...1` (`:235`) |
| `smoothing` | Length of the lazy string, 0...100. Units: device pixels on screen (see section 5) | 0 | 0...100, Brush tool only (`:88-99`) | not checked |
| `red, green, blue` | Foreground color, sRGB 0...1 (`ColorPalette.swift:21-24`). Overridden for masks (section 11) | black | color well | n/a |
| `erasing` | Erase mode | false | Paint/Erase picker (`:10-16`) | set in `beginBrush` |

Things the engine does **not** have: flow, user-set spacing, pressure, tilt, jitter, angle or roundness, scatter, or
texture.

- **Pressure**: none. A search of every `.swift` file finds no `pressure`, `tablet` or coalesced-event code for
  brushes. The only `pressure` match is a memory-pressure source in `GPUCanvas.swift:68-78`.
- **Spacing** is a fixed internal constant: `spacingFraction` (`BrushStroke.swift:470`):
  ```swift
  static func spacingFraction(_ hardness: CGFloat) -> CGFloat { hardness >= 1 ? 0.015 : 0.025 }
  ```
  The value is `spacing = max(0.25, diameter * spacingFraction(hardness))` in document pixels
  (`BrushStroke.swift:474`, `MetalBrushCoverage.swift:50`). In the GPU engine it only matters for soft tips, where it
  normalises the deposition integral (section 8).
- **Diameter can be fractional.** Scrubbing the "Size" label has no step (`scrubbable(sensitivity: 1.0, ...)`, with
  `step` nil in `NumericScrub.swift:35`). The text field shows 0 decimals. The `[`/`]` keys and right-drag round to
  whole pixels.
- **UI scrub sensitivities** (`BrushControls.swift`): size 1 px per point, hardness 0.01 per point, opacity 0.01 per
  point, smoothing 1 per point. The Up/Down keys in a focused field step by 1 display unit (px or %), and by 10 with
  Shift (`ContentView.swift:427`).
- **Tip families** (`EditorSession.swift:220-221, 399-408`): Brush (Paint and Erase) and Spot Healing share one tip.
  Clone Stamp and Smear each keep their own `(diameter, hardness, opacity)`, which start at `(40, 0, 1)`:
  ```swift
  @ObservationIgnored var parkedBrushTips: [Int: (diameter: CGFloat, hardness: CGFloat, opacity: CGFloat)] = [1: (40, 0, 1), 2: (40, 0, 1)]
  ```
  Switching tools swaps the tips. Color and smoothing are shared by all tools.
- **Persistence**: `brushSettings` is a plain session property (`EditorSession.swift:205`), not stored in
  `ToolDefaults`. It resets to the defaults on every launch.
- **Settings are copied at stroke start** (`var settings = brushSettings`, `EditorSession+Brush.swift:65`). Changes
  during a stroke have no effect, and the size, hardness and opacity keys are blocked while `brushStroke != nil`.

### How size relates to zoom

- The paint footprint is always `diameter` document pixels, at any zoom.
- The on-screen cursor circle is `max(1, diameter * viewport.pointsPerPixel)` view points
  (`EditorCanvas.swift:1526`).
- `CanvasViewport` (`Rendering/CanvasViewport.swift:8,15`) defines `zoom` as device (backing) pixels per document
  pixel, so `pointsPerPixel = zoom / backingScale`. "Zoom 1 means actual display pixels."

---

## 3. Coordinates and the stroke grid

### 3.1 View to document

`CanvasViewport.swift:18-28`:

```swift
func documentRect(_ size: CGSize) -> CGRect {
    let scaled = CGSize(width: size.width * pointsPerPixel, height: size.height * pointsPerPixel)
    return CGRect(x: center.x - scaled.width / 2 + pan.width,
                  y: center.y - scaled.height / 2 + pan.height,
                  width: scaled.width, height: scaled.height)
}
func documentPoint(from point: CGPoint, documentSize: CGSize) -> CGPoint {
    let origin = documentRect(documentSize).origin
    return CGPoint(x: (point.x - origin.x) / pointsPerPixel, y: (point.y - origin.y) / pointsPerPixel)
}
```

Samples are **fractional** document coordinates. They are not snapped to pixel centres.

### 3.2 Grid pixel to document

`BrushRaster.pixelToDocument` (`BrushStroke.swift:110-116`):

```swift
CGAffineTransform(translationX: transform.center.x, y: transform.center.y)
    .rotated(by: transform.radians)
    .scaledBy(x: transform.size.width / CGFloat(width) * (transform.flipX ? -1 : 1),
              y: transform.size.height / CGFloat(height) * (transform.flipY ? -1 : 1))
    .translatedBy(x: -CGFloat(width) / 2, y: -CGFloat(height) / 2)
```

`LayerTransform` (`LayerTransform.swift:18-26`) holds `origin`, `size` (unrotated bounds in document pixels), `rotation`
(degrees, clockwise in y-down space), `flipX`, `flipY` and `sampling`. It derives
`center = origin + size/2` and `radians = rotation.truncatingRemainder(dividingBy: 360) * .pi / 180`. The composition
order is the same as Canvas 2D:
`ctx.translate(cx,cy); ctx.rotate(rad); ctx.scale(sx*fx, sy*fy); ctx.translate(-w/2,-h/2)`.

### 3.3 Grid extent, growth room and paint transform

`BrushStroke.init` (`BrushStroke.swift:201-230`) builds the grid like this:

```swift
let placedMask = mask ? layer.mask.flatMap { mask in mask.placement.map { (mask.asset.image, $0) } } : nil
let base = placedMask?.1 ?? layer.transform
let solidPlaced = placedMask.map { $0.0.width <= 2 && $0.0.height <= 2 } == true
let originalWidth = solidPlaced ? max(1, Int(base.size.width.rounded()))
    : placedMask?.0.width ?? layer.asset?.image.width ?? Int(layer.size.width.rounded())
...
let originalMapping = BrushRaster.pixelToDocument(base, width: originalWidth, height: originalHeight)
let originalBounds = CGRect(x: 0, y: 0, width: originalWidth, height: originalHeight)
let extent = mask && !growsMask ? originalBounds : originalBounds.union(self.canvas.applying(originalMapping.inverted()).integral)
...
width = Int(extent.width)
height = Int(extent.height)
sourceRect = originalBounds.offsetBy(dx: -extent.minX, dy: -extent.minY)
pixelToDocument = originalMapping.translatedBy(x: extent.minX, y: extent.minY)
var expanded = base
expanded.size = CGSize(width: CGFloat(width) * base.size.width / CGFloat(originalWidth),
                       height: CGFloat(height) * base.size.height / CGFloat(originalHeight))
let center = CGPoint(x: extent.midX, y: extent.midY).applying(originalMapping)
expanded.origin = CGPoint(x: center.x - expanded.size.width / 2, y: center.y - expanded.size.height / 2)
paintTransform = expanded
```

Rules:

1. The grid is the target's **own pixel resolution**. A layer scaled to 10 % is painted in its full-resolution pixels
   (test `NativeResolutionPaintTests.swift:41-56`). A blank layer (no `asset`) uses `Int(layer.size.width.rounded())`,
   so it is always painted at 1 grid pixel per document pixel, however it was scaled (test `:137-152`).
2. **Growth room**: the grid is the layer's pixel rect **unioned with the bounding box of the whole document canvas
   mapped into layer-pixel space**. `CGRect.applying` returns the axis-aligned bounding box, and `.integral` floors
   the minimum and ceils the maximum. A rotated layer gets an axis-aligned box in its own rotated pixel space. A mask
   only gets this room when `growsMask` is true, which is the case for the Brush tool (`growsMask: tool == .brush`,
   `EditorSession+Brush.swift:70`).
3. Only pixels whose **centre maps inside the document canvas** receive paint (section 7). Paint never lands outside
   `[0,W)x[0,H)`. Existing layer pixels outside the canvas are kept.
4. The grid is stored as **256 x 256 tiles** (`tileSize = 256`, `:194`). Tile `(tx, ty)` covers grid rect
   `(tx*256, ty*256, min(256, width - tx*256), min(256, height - ty*256))` (`:665`). Tile keys are
   `ty * columns + tx`, with `columns = ceil(width / 256)`. A tile is created on first touch from the original pixels:
   transparent outside `sourceRect`, or the mask background colour for masks (`:662-702`).
5. **Size limits** (`allocateTile`, `:666-668`): the union of `sourceRect` and the allocated tiles must stay within
   30000 px per side and within `pixelLimit`, which is the document pixel budget minus every other layer's pixels.
   Otherwise the edit throws `tooLarge` and the stroke is cancelled with an error.

---

## 4. Pointer events to samples (EditorCanvas)

### 4.1 Press (`EditorCanvas.swift:1820-1840`)

```swift
} else if session.tool.isBrushTool, let document = session.document {
    let pixel = session.viewport.documentPoint(from: point, documentSize: document.size)
    ...
    brushPointer = point
    // Shift paints a straight line on from where the last stroke ended, as in Photoshop.
    if event.modifierFlags.contains(.shift), let from = session.shiftLineStart() {
        session.beginBrush(at: from)
        session.continueBrush(at: pixel)
    } else {
        session.beginBrush(at: pixel)
    }
    brushAxisAnchor = event.modifierFlags.contains(.shift) ? pixel : nil
    brushAxisHorizontal = nil
    brushLastPixel = pixel
```

`beginBrush` (`EditorSession+Brush.swift:50-94`) works in this order:

1. It checks `canPaint`. On failure it sets `brushError = paintRefusal` (section 12.6).
2. It copies the settings, then sets `settings.erasing = tool == .brush && brushMode == .erase && !isMaskSelected`
   (`:67`).
3. For a mask target it sets `settings.red/green/blue = maskPaintWhite ? 1 : 0` (`:69`).
4. It makes a `BrushStroke` with `growsMask: tool == .brush`.
5. It calls `stroke.append(point)`, which is the first sample.
6. It sets `brushAnchor = point`, `brushPointer = point` and `lastBrushPoint = (point, layer.id, isMaskSelected)`.

### 4.2 Drag (`EditorCanvas.swift:1957-1981`): Shift axis lock

```swift
var pixel = session.viewport.documentPoint(from: point, documentSize: document.size)
// Shift keeps the stroke straight, horizontal or vertical, from wherever it was pressed; letting go carries
// on freehand. The axis is settled by the first few pixels of movement, so it doesn't flip mid-line.
if event.modifierFlags.contains(.shift) {
    let anchor = brushAxisAnchor ?? brushLastPixel ?? pixel
    if brushAxisAnchor == nil { brushAxisAnchor = anchor; brushAxisHorizontal = nil }
    if brushAxisHorizontal == nil, hypot(pixel.x - anchor.x, pixel.y - anchor.y) >= 3 {
        brushAxisHorizontal = abs(pixel.x - anchor.x) >= abs(pixel.y - anchor.y)
    }
    if let horizontal = brushAxisHorizontal {
        pixel = horizontal ? CGPoint(x: pixel.x, y: anchor.y) : CGPoint(x: anchor.x, y: pixel.y)
    } else {
        pixel = anchor
    }
} else {
    brushAxisAnchor = nil
    brushAxisHorizontal = nil
}
brushLastPixel = pixel
session.continueBrush(at: pixel)
```

- The axis is chosen once the pointer has moved **at least 3 document pixels** from the anchor (Euclidean). It is
  horizontal when `|dx| >= |dy|`, so a tie counts as horizontal. Until then the sample is pinned to the anchor, which
  is a duplicate and is dropped by `append`.
- Pressing Shift mid-stroke anchors at `brushLastPixel`, the last constrained point. Releasing Shift resets the anchor
  and axis. Pressing it again re-anchors at the current point.
- Shift held at the press anchors at the pressed pixel. This also applies after a Shift-click line.

### 4.3 Release (`EditorCanvas.swift:2121-2126`)

```swift
if session.brushStroke != nil || session.warpStroke != nil, !session.isProjectBusy {
    if let document = session.document {
        session.continueBrush(at: session.viewport.documentPoint(from: convert(event.locationInWindow, from: nil), documentSize: document.size))
    }
    session.finishBrushImmediately()
```

**Upstream quirk:** the release point is passed in **raw**, without the Shift axis lock. If the hand drifted off the
locked axis, the stroke ends with one chord from the last locked point to the raw release point. When the release
happens where the last drag event was and no lock is active, the point is a duplicate and is ignored. Reproduce this
only if strict fidelity is wanted. It looks unintended.

`finishBrushImmediately` (`EditorSession+Brush.swift:132-152`):

```swift
// Smoothing leaves the brush short of the pointer; the stroke ends where the hand did.
if let pointer = brushPointer, let anchor = brushAnchor, pointer != anchor,
   tool == .brush, brushSettings.smoothing > 0 {
    try stroke.append(pointer)
}
try stroke.flush()
if stroke.settings.healing { try stroke.heal() }
if !stroke.patches.isEmpty { try commitPaintSnapshot(stroke) }
```

### 4.4 Event cadence, coalescing and pressure

- Each `mouseDragged` event gives exactly one sample. There is no `coalescedTouches`, no `isMouseCoalescingEnabled`
  change and no historical-event replay. AppKit's default drag coalescing applies, which is roughly one event per
  display refresh.
- There is no pressure, tilt or tablet handling at all. Tablet input behaves exactly like a mouse.
- Accumulation is integrated over distance travelled, so the result hardly depends on how many events arrive (section
  8). The test `accumulationDependsOnDistanceNotEventCount` requires sparse and dense sampling of one line to differ
  by at most 2 of 255 in alpha.

### 4.5 Cancel and other in-stroke input

- **Escape** during a stroke calls `cancelBrush()`. The stroke is discarded and no undo entry is made
  (`EditorCanvas.swift:2221-2223`). Every other key is swallowed while a stroke is in progress.
- Losing first responder also cancels the stroke (`:2331-2334`).
- `cancelBrush` (`EditorSession+Brush.swift:123-129`) clears `brushStroke`, `brushAnchor` and `brushPointer`. It
  does **not** clear `lastBrushPoint`.

---

## 5. Smoothing (lazy string, or "pulled string")

`EditorSession+Brush.swift:103-117`:

```swift
private func smoothed(_ point: CGPoint) -> CGPoint? {
    guard tool == .brush, brushSettings.smoothing > 0, let anchor = brushAnchor else { return point }
    let radius = brushSettings.smoothing / max(0.01, viewport.zoom)
    let delta = CGPoint(x: point.x - anchor.x, y: point.y - anchor.y)
    let distance = hypot(delta.x, delta.y)
    guard distance > radius else { return nil }
    let step = (distance - radius) / distance
    let moved = CGPoint(x: anchor.x + delta.x * step, y: anchor.y + delta.y * step)
    brushAnchor = moved
    return moved
}
```

- Smoothing applies only to `tool == .brush`, which covers both Paint and Erase. Clone, Heal and Smear are not
  smoothed.
- The string length in document pixels is `smoothing / max(0.01, zoom)`. **`zoom` is device pixels per document
  pixel**, not points. On a 2x Retina screen, a smoothing of 100 is a 100 device-pixel string, which is 50 points,
  even though the comment says "screen points".
- While the pointer is within the string length of the anchor, no sample is produced. Once it is further away, the
  anchor moves along the pointer direction until it is exactly `radius` behind. There is no time-based easing or
  catch-up.
- At release, the raw pointer is appended so the stroke ends where the hand stopped (section 4.3).
- `continueBrush` (`:95-102`) records `lastBrushPoint.point = painted`, the smoothed point. That point becomes the
  next Shift-click start.

---

## 6. Path interpolation

### 6.1 Sample window, settled piece and provisional tail

GPU path (`BrushStroke.swift:282-285, 313-334`):

```swift
func append(_ point: CGPoint) throws {
    guard point.x.isFinite, point.y.isFinite, abs(point.x) <= 10_000_000, abs(point.y) <= 10_000_000 else { return }
    guard samples.last != point else { return }
    if gpu != nil { try appendContinuous(point); return }
...
private func appendContinuous(_ point: CGPoint) throws {
    samples.append(point)
    if samples.count > 4 { samples.removeFirst() }
    let n = samples.count
    var settled: [SIMD4<Float>] = []
    if n == 1 { settled = [segment(point, point)] }
    else if n >= 3 {
        settled = continuousCurve(from: samples[n - 3], to: samples[n - 2],
            before: samples[max(0, n - 4)], after: point)
    }
    let tail = n >= 2 ? [segment(samples[n - 2], point)] : []
    try renderContinuous(settled: settled, tail: tail)
}

private func flushContinuous() throws {
    let n = samples.count
    guard n >= 2 else { return }
    let settled = continuousCurve(from: samples[n - 2], to: samples[n - 1],
        before: samples[max(0, n - 3)], after: samples[n - 1])
    try renderContinuous(settled: settled, tail: [])
    samples = [samples[n - 1]]
}
```

For samples `s0` (the press), `s1`, `s2`, and so on:

| Call | Window | Settled (permanent) | Tail (preview only) |
|---|---|---|---|
| append s0 | [s0] | zero-length segment (s0,s0): the click dab | none |
| append s1 | [s0,s1] | none | chord s0 to s1 |
| append s2 | [s0,s1,s2] | CR(s0 to s1; before=s0, after=s2) | chord s1 to s2 |
| append s3 | [s0..s3] | CR(s1 to s2; before=s0, after=s3) | chord s2 to s3 |
| append s4 | [s1..s4] | CR(s2 to s3; before=s1, after=s4) | chord s3 to s4 |
| flush | [..,a,b] | CR(a to b; before=prev, after=b) | none, which clears the old tail |

Notes:

- Only an exact duplicate of the **last** sample is dropped.
- The first and last pieces duplicate an endpoint as the missing neighbour.
- `flush` can be called twice safely, because the second call sees `n < 2`.
- A tap with no movement gives only the click dab.

### 6.2 Centripetal Catmull-Rom with adaptive chords

`BrushStroke.swift:342-370`:

```swift
func knot(_ t: CGFloat, _ a: CGPoint, _ b: CGPoint) -> CGFloat { t + max(0.0001, sqrt(hypot(b.x - a.x, b.y - a.y))) }
func mix(_ a: CGPoint, _ b: CGPoint, _ ta: CGFloat, _ tb: CGFloat, _ t: CGFloat) -> CGPoint {
    let wa = (tb - t) / (tb - ta), wb = (t - ta) / (tb - ta)
    return CGPoint(x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb)
}
let t0: CGFloat = 0, t1 = knot(t0, before, start), t2 = knot(t1, start, end), t3 = knot(t2, end, after)
func point(_ u: CGFloat) -> CGPoint {
    if u == 0 { return start }; if u == 1 { return end }
    let t = t1 + (t2 - t1) * u
    let a = mix(before, start, t0, t1, t), b = mix(start, end, t1, t2, t), c = mix(end, after, t2, t3, t)
    return mix(mix(a, b, t0, t2, t), mix(b, c, t1, t3, t), t1, t2, t)
}
...
func subdivide(_ a: CGPoint, _ b: CGPoint, _ lo: CGFloat, _ hi: CGFloat, _ depth: Int) {
    let dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy
    func error(_ p: CGPoint) -> CGFloat {
        let t = lengthSquared > 0 ? min(1, max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0
        return hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
    }
    let mid = (lo + hi) / 2, m = point(mid)
    let deviation = max(error(m), error(point((lo + mid) / 2)), error(point((mid + hi) / 2)))
    if deviation <= 0.2 || depth >= 10 { result.append(segment(a, b)); return }
    subdivide(a, m, lo, mid, depth + 1)
    subdivide(m, b, mid, hi, depth + 1)
}
subdivide(start, end, 0, 1, 0)
```

- This is the Barry-Goldman pyramid form of **centripetal** Catmull-Rom (alpha = 0.5). Knot spacing is
  `sqrt(chord length)`, with a minimum of 1e-4.
- Each piece is split recursively until the curve stays within **0.2 document pixels** of the chord. The test points
  are the mid point and both quarter points of the parameter range. Recursion stops at depth 10, so a piece has at
  most 1024 chords.
- The chords are stored as `Float` (float32) quads `(x0, y0, x1, y1)`.

---

## 7. Tip shape and coverage function

### 7.1 Metal kernel uniforms (`MetalBrushCoverage.swift:46-51`)

```swift
let origin = rect.origin.applying(mapping)
var uniforms = Uniforms(
    mapping: SIMD4(Float(mapping.a), Float(mapping.b), Float(mapping.c), Float(mapping.d)),
    geometry: SIMD4(Float(origin.x), Float(origin.y), Float(settings.diameter / 2), Float(settings.hardness)),
    canvas: SIMD4(Float(canvas.width), Float(canvas.height), Float(max(0.001, min(hypot(mapping.a, mapping.b), hypot(mapping.c, mapping.d)))), Float(max(0.25, settings.diameter * BrushStroke.spacingFraction(settings.hardness)))),
    counts: SIMD4(UInt32(rect.width), UInt32(rect.height), UInt32(settled.count), UInt32(segments.count)))
```

| Uniform | Value |
|---|---|
| `radius` | `diameter / 2`, in document pixels |
| `hardness` | `h` |
| `aa` (anti-alias width) | the document-pixel length of one grid pixel along its shorter axis: `max(0.001, min(|(a,b)|, |(c,d)|))`. It is 1 for an unscaled layer, 0.1 for a layer at 10 % and 4 for a layer at 400 %. |
| `spacing` | `max(0.25, diameter * spacingFraction(h))` |

The **pixel sample point** is the document position of the grid pixel's centre (`:142-144`). Pixels outside the
canvas get coverage 0, and their permanent buffer is left as it was:

```c
float2 local = float2(pixel) + 0.5f;
float2 p = u.geometry.xy + local.x * u.mapping.xy + local.y * u.mapping.zw;
if (any(p < 0.0f) || any(p >= u.canvas.xy)) { preview[index] = 0; return; }
```

### 7.2 Coverage of one tip at distance d (`MetalBrushCoverage.swift:88-96`)

```c
float brushCoverage(float distanceSquared, constant BrushUniforms &u) {
    float distance = sqrt(distanceSquared);
    float radius = u.geometry.z;
    if (u.geometry.w >= 1.0f) {
        return clamp((radius - distance) / u.canvas.z + 0.5f, 0.0f, 1.0f);
    }
    float t = clamp((distance / radius - u.geometry.w) / (1.0f - u.geometry.w), 0.0f, 1.0f);
    return max(0.0f, (exp(-2.5f * t * t) - exp(-2.5f)) / (1.0f - exp(-2.5f)));
}
```

- **Hard tip** (`hardness >= 1`, exactly 100 %): a linear anti-aliasing ramp one grid pixel wide (`aa`), centred on
  the rim. Coverage is 1 for `d <= r - aa/2`, 0.5 at `d = r`, and 0 for `d >= r + aa/2`. Hardness 0.99 already takes
  the soft branch.
- **Soft tip** (`hardness < 1`): full strength inside `h * r`. Between `h*r` and `r`, `t = (d/r - h)/(1 - h)` runs
  from 0 to 1, and coverage is a **normalised Gaussian** `(e^(-2.5 t^2) - e^(-2.5)) / (1 - e^(-2.5))` that reaches
  exactly 0 at the rim. There is no extra anti-aliasing on soft tips. The CPU fallback uses the same function
  (`BrushRaster.falloff`, `BrushStroke.swift:104-109`, `k = 2.5`).
- Constants: `e^(-2.5) = 0.0820849986`, `1 - e^(-2.5) = 0.9179150014`.

Single-tip coverage for reference (`u = d/r`):

| u | 0 | 0.25 | 0.5 | 0.75 | 0.9 | 1.0 |
|---|---|---|---|---|---|---|
| h = 0 | 1.0000 | 0.8424 | 0.4937 | 0.1775 | 0.0544 | 0 |
| h = 0.5 | 1.0000 | 1.0000 | 1.0000 | 0.4937 | 0.1305 | 0 |

---

## 8. Accumulation within one stroke

### 8.1 Kernel (`MetalBrushCoverage.swift:81-86, 98-160`)

```c
float segmentDistanceSquared(float2 p, float4 segment) {
    float2 v = segment.zw - segment.xy;
    float t = clamp(dot(p - segment.xy, v) / max(dot(v, v), 1e-12f), 0.0f, 1.0f);
    float2 delta = p - (segment.xy + t * v);
    return dot(delta, delta);
}
// Integrate paint deposition by distance travelled, not pointer-event count or
// spline subdivision count. Optical density adds; coverage is 1 - exp(-density).
// This is the continuous form of source-over soft dabs at the shared deposition spacing.
float tipDensity(float distanceSquared, constant BrushUniforms &u) {
    return -log(max(1.0f - brushCoverage(distanceSquared, u), 0.001f));
}
float segmentDensity(float2 p, float4 segment, constant BrushUniforms &u) {
    float2 v = segment.zw - segment.xy;
    float length = metal::length(v);
    if (length < 1e-6f) return tipDensity(dot(p - segment.xy, p - segment.xy), u); // initial click
    float2 direction = v / length;
    float projection = dot(p - segment.xy, direction);
    float2 perpendicular = p - segment.xy - projection * direction;
    float perpendicularSquared = dot(perpendicular, perpendicular);
    float radiusSquared = u.geometry.z * u.geometry.z;
    if (perpendicularSquared >= radiusSquared) return 0.0f;
    float reach = sqrt(radiusSquared - perpendicularSquared);
    float lo = max(0.0f, projection - reach), hi = min(length, projection + reach);
    if (hi <= lo) return 0.0f;
    float midpoint = (lo + hi) * 0.5f, halfLength = (hi - lo) * 0.5f;
    constexpr float nodes[4] = {0.1834346425f, 0.5255324099f, 0.7966664774f, 0.9602898565f};
    constexpr float weights[4] = {0.3626837834f, 0.3137066459f, 0.2223810345f, 0.1012285363f};
    float integral = 0.0f;
    for (uint i = 0; i < 4; ++i) {
        float a = midpoint - halfLength * nodes[i] - projection;
        float b = midpoint + halfLength * nodes[i] - projection;
        integral += weights[i] * (tipDensity(perpendicularSquared + a * a, u)
                                + tipDensity(perpendicularSquared + b * b, u));
    }
    return integral * halfLength / u.canvas.w;
}
kernel void continuousBrush(...) {
    ...
    if (u.geometry.w >= 1.0f) {
        float settled = INFINITY, tail = INFINITY;
        for (uint i = 0; i < u.counts.z; ++i) settled = min(settled, segmentDistanceSquared(p, segments[i]));
        for (uint i = u.counts.z; i < u.counts.w; ++i) tail = min(tail, segmentDistanceSquared(p, segments[i]));
        float value = max(permanent[index], brushCoverage(settled, u));
        permanent[index] = value;
        preview[index] = uchar(round(255.0f * max(value, brushCoverage(tail, u))));
    } else {
        float value = permanent[index], tail = 0.0f;
        for (uint i = 0; i < u.counts.z; ++i) value += segmentDensity(p, segments[i], u);
        for (uint i = u.counts.z; i < u.counts.w; ++i) tail += segmentDensity(p, segments[i], u);
        permanent[index] = min(value, 20.0f);
        preview[index] = uchar(round(255.0f * (1.0f - exp(-min(value + tail, 20.0f)))));
    }
}
```

### 8.2 Hard tips: maximum of coverage

`C(p) = max over the stroke of cov(distance from p to the stroke polyline)`. The result is a union of capsules with a
1-grid-pixel anti-aliased edge. There is no dab scalloping and no build-up. A pixel can never exceed coverage 1.

### 8.3 Soft tips: additive optical density

Per pixel, the stroke stores a density `D`:

```
D(p) = D_click(p) + sum over settled chords [ (1/spacing) * integral over the chord of tipDensity(|p - x(s)|^2) ds ]
tipDensity(d^2) = -ln( max(1 - cov(d), 0.001) )      // capped at -ln(0.001) = 6.9078 per tip
D_click(p) = tipDensity(|p - s0|^2)                   // first sample only, NOT divided by spacing
permanent = min(D, 20)
C(p) = 1 - exp(-min(D + D_tail, 20))
```

- This is the continuous limit of soft dabs laid every `spacing` document pixels and composited source-over.
  N dabs of coverage c give `1 - (1 - c)^N = 1 - exp(N * ln(1 - c))`. Self-crossings therefore blend like
  screen: `1 - (1 - a)(1 - b)`. The test `selfCrossingsBlendInsteadOfTakingTheStrongestEdge` checks this to within
  3 of 255.
- The integral uses **8-point Gauss-Legendre** quadrature over the part of the chord where the tip reaches,
  `[max(0, proj - reach), min(len, proj + reach)]` with `reach = sqrt(r^2 - perp^2)`.
- The density cap of 20 makes saturated pixels stay at coverage 1, about `1 - 2e-9`.
- The initial click deposits exactly one tip. Its coverage equals `cov(d)`, except that it saturates at 0.999.
- Soft strokes become solid quickly, because the spacing is 2.5 % of the diameter. For diameters of 10 px and up,
  `spacing = 0.05 r` and the cross-section of a long straight stroke does not depend on scale. Reference values,
  computed with the kernel formulas (scratch script, diameter 100):

| perpendicular d/r | 0 | 0.25 | 0.5 | 0.75 | 0.9 | 0.95 | 0.99 |
|---|---|---|---|---|---|---|---|
| h = 0, coverage (8-bit) | 1.0 (255) | 1.0 (255) | 1.0 (255) | 0.9501 (242) | 0.4594 (117) | 0.1833 (47) | 0.0170 (4) |
| h = 0.5 | 1.0 (255) | 1.0 (255) | 1.0 (255) | 0.9999 (255) | 0.7712 (197) | 0.3580 (91) | 0.0342 (9) |

  Below 10 px the spacing is clamped to 0.25, so small soft brushes are relatively less dense.

### 8.4 Permanent buffer versus tail

- The settled chords update the **permanent** buffer, which is `Float32` per grid pixel and starts at 0. It holds the
  maximum coverage for hard tips and the density for soft tips.
- The tail only goes into the 8-bit **preview**, which is the coverage actually used. "Tail previews are never
  accumulated into permanent paint" (`:133-134`).
- Each render covers the tiles of `settled ∪ tail ∪ previous tail` (`renderContinuous`, `BrushStroke.swift:393-411`),
  so the old tail disappears exactly.
- Tile selection, `continuousKeys` (`:372-391`): the segment's bounding box, inflated by
  `reach = diameter/2 + 2` **document pixels**, intersected with the canvas, mapped to the grid with `.integral`,
  clipped to the grid, then rounded out to whole 256 px tiles. Every pixel of a selected tile is evaluated against
  every segment in the call.
- The 8-bit preview is copied into each tile's gray coverage context (`memcpy`, `MetalBrushCoverage.swift:62-66`).
  **Coverage is quantised to 8 bits**, `round(255 * C)`, before compositing.

---

## 9. Compositing the stroke onto the layer

`publish` (`BrushStroke.swift:493-541`). For every changed tile it does the following:

```swift
tile.context.saveGState()
tile.context.clip(to: dirty)
tile.context.clear(dirty)
if let base = tile.base { BrushRaster.draw(base, in: local, mask: isMask, context: tile.context) }
if let selectionClip { ... selectionClip.apply(to: tile.context) ... }
if let clone, !isMask || isBlur { ... }
else if settings.healing, !isMask { ... }
else if settings.erasing, !isMask {
    // Erasing takes the coverage out of the layer's alpha, leaving the pixels under it transparent.
    tile.context.saveGState()
    tile.context.setBlendMode(.destinationOut)
    BrushRaster.fill(Self.eraseColor, coverage: mask, in: local, alpha: settings.opacity, context: tile.context)
    tile.context.restoreGState()
} else {
    BrushRaster.fill(paintColor, coverage: mask, in: local, alpha: settings.opacity, context: tile.context)
}
```

`BrushRaster.fill` (`:92-103`) clips to the gray coverage image used as an alpha mask, then sets the global alpha to
`opacity` and fills a solid color. `BrushRaster.draw` for the base uses `.copy` (`:86`).
`eraseColor = sRGB(0,0,0,1)` (`:592`).

**Key property: the stroke is applied once, Photoshop-style.** On every update the tile is rebuilt from the
**original** pixels (`tile.base` is the snapshot taken when the tile was created), and the whole-stroke coverage is
applied once at `opacity`. Overlapping parts of one stroke never go above `opacity`. The test
`softCrossingsRespectStrokeOpacityAndFlushIsIdempotent` expects a maximum alpha of exactly 102 = 0.4 x 255 for a
self-crossing stroke at opacity 0.4 on an empty layer.

Pixel format (`BrushRaster.context`, `:36-44`): 8-bit **premultiplied** RGBA (`premultipliedLast`, `byteOrder32Big`)
in **sRGB**, with no linearisation. Masks are 8-bit DeviceGray with no alpha.

Per grid pixel, with `k = cov8 / 255`, `sel` = selection coverage at the pixel (1 when there is no selection), and
`a = k * opacity * sel`:

```
Paint  (premultiplied, P = (r,g,b) premultiplied, A = alpha, S = straight sRGB foreground color):
    P' = S * a + P * (1 - a)
    A' = a     + A * (1 - a)
  same thing in straight form:  A' = a + A(1 - a);   C' = (S*a + C*A*(1 - a)) / A'
Erase  (destination-out):
    P' = P * (1 - a);   A' = A * (1 - a)      -> straight color unchanged, alpha reduced
Mask   (gray, no alpha, G = 0 or 1 from maskPaintWhite):
    M' = G * a + M * (1 - a)
```

The results are stored back as 8-bit values. Core Graphics' exact rounding is internal (section 17.6).

- **Selection** (`Selection.swift:53-65`): `SelectionClip.apply` clips with the selection's gray coverage image
  (feathered or anti-aliased) in document space, mapped onto the grid. A clip mask scales the source coverage, so it
  multiplies into `a` for both Paint and Erase. With an explicit empty selection painting is refused (`canPaint`).
- The layer's own opacity, blend mode, effects and mask are **not** applied to the stroke. They are applied when the
  layer is displayed.

---

## 10. Erase mode

- It is the Brush tool with `brushMode == .erase` (keys B and E, or Tab to toggle). The title bar says "Eraser"
  (`BrushControls.swift:7`) and the tool icon becomes `"eraser"`.
- Engine: `settings.erasing = tool == .brush && brushMode == .erase && !isMaskSelected`.
- On pixels it reduces alpha multiplicatively by `coverage * opacity * selection` (destination-out). Straight color is
  unchanged, and the result can reach full transparency. Coverage, accumulation, smoothing and Shift work exactly as
  for Paint.
- **On a mask, Erase is not an erase.** `erasing` is forced to false and the stroke paints the mask color: black
  (hide) or white (reveal) from `maskPaintWhite`. Erase mode on a mask therefore behaves exactly like Paint mode.
- Erasing never shrinks the layer, because the commit crop always includes the old `sourceRect` (section 12).
- The undo name is `"Erase"`.

---

## 11. Painting a layer mask

- The mask is selected with `isMaskSelected`. Painting requires the mask to be enabled (`canPaint`,
  `EditorSession+Brush.swift:9`).
- Color: `settings.red = green = blue = maskPaintWhite ? 1 : 0` (`:69`). The swatches show black or white. X swaps
  them and D resets to black (`ColorPalette.swift:27-55`). The UI picker reads "Black · Hide" / "White · Reveal"
  (`BrushControls.swift:100-104`).
- Grid:
  - An **unplaced** mask (`placement == nil`) is painted in the **layer's** pixel grid. Its width is
    `layer.asset.image.width`, not the mask image's own size. The old mask image is stretched into `sourceRect`. A
    uniform 1x1 mask is drawn whole and stretched.
  - A **placed** mask (`placement` set) is painted in its own grid at its placement. A placed solid mask (2x2 or
    smaller) gets one pixel per document pixel.
- **Mask background** (`maskBackground`, `BrushStroke.swift:220`, `LayerMask.background`, `LayerMask.swift:63-77`):
  new mask area starts white (1) or black (0), whichever most of the old mask's thumbnail **edge** pixels are:
  `total * 2 >= count * 255 ? 1 : 0`.
- Growth: with the Brush tool (`growsMask: true`) a mask can be painted anywhere on the canvas. On commit, the mask
  grows to **all allocated tiles** (section 12.3).
- Compositing: `M' = G*a + M*(1 - a)` (section 9). The undo name is `"Paint Mask"`.

---

## 12. Layer bounds, growth and transform on commit

### 12.1 Pixel layers (`paintSnapshot`, `BrushStroke.swift:945-971`)

```swift
var bounds: CGRect? = source == nil ? nil : sourceRect
for tile in tiles.values where !isMask {
    ...
    brush_alpha_bounds(bytes..., Int(tile.rect.width), Int(tile.rect.height), tile.context.bytesPerRow, &edges)
    guard edges[2] > edges[0], edges[3] > edges[1] else { continue }
    let rect = CGRect(x: edges[0], y: edges[1], width: edges[2] - edges[0], height: edges[3] - edges[1])
        .offsetBy(dx: tile.rect.minX, dy: tile.rect.minY)
    bounds = bounds.map { $0.union(rect) } ?? rect
}
let crop = isMask ? committedBounds : bounds ?? committedBounds
```

`brush_alpha_bounds` (`BrushPixels.c:3-21`) returns the tight bounding box of pixels with **alpha != 0** in 8 bits.

- **Crop** = the old pixel rect `sourceRect` unioned with the tight bounding box of every nonzero-alpha pixel in the
  touched tiles. The layer **grows** to fit new paint, even partly transparent soft edges, and **never shrinks**.
- A **blank layer** (no asset, for example a fresh "Layer N" with `blankSize = document.size`) has no `sourceRect`
  contribution. After the first stroke it becomes **tightly cropped** to the painted pixels. If nothing has nonzero
  alpha (for example Erase on an empty layer), the crop falls back to `committedBounds`, which is all allocated tiles.
- New image = the old pixels with the touched tiles replaced (`RasterSnapshot.replacing`), cropped to `crop` in grid
  coordinates.

### 12.2 New transform (`transform(for:)`, `BrushStroke.swift:879-886`)

```swift
func transform(for bounds: CGRect) -> LayerTransform {
    let center = CGPoint(x: bounds.midX, y: bounds.midY).applying(pixelToDocument)
    var result = paintTransform
    result.size = CGSize(width: bounds.width * paintTransform.size.width / CGFloat(width),
                         height: bounds.height * paintTransform.size.height / CGFloat(height))
    result.origin = CGPoint(x: center.x - result.size.width / 2, y: center.y - result.size.height / 2)
    return result
}
```

- Rotation, flips and sampling come from the original transform. The per-pixel document scale is kept
  (`size = crop.size * scale`).
- The crop's centre is mapped through the full `pixelToDocument`, including rotation and flips. The new `origin` is
  the centre minus half the size, because `LayerTransform.origin` describes the unrotated bounds around the centre.
- Unrotated, unflipped layer with scale `s`: `newOrigin = oldOrigin + (crop.min - sourceRect.min) * s` and
  `newSize = crop.size * s`.
- **Scaled layers**: they are painted at native resolution. Growth adds native-resolution pixels, and the scale stays
  the same.
- **Rotated layers**: growth happens in the layer's own rotated pixel space, as an axis-aligned rect in that space.
  The rotation angle is kept, and the centre and size change. The growth room is the bounding box of the canvas in
  that rotated space, so the grid can be much larger than the canvas. Only touched tiles are allocated.
- `commitPaintSnapshot` (`EditorSession+Brush.swift:158-186`) discards the commit silently if
  `!result.transform.isValid`, or if the layer's image or transform changed during the stroke.

### 12.3 Masks

- Mask crop = `committedBounds = (allocatedBounds ?? sourceRect).integral` (`:871`). `allocatedBounds` is
  `sourceRect ∪` every allocated tile, including tiles reached only by a provisional tail, because tiles are
  allocated for every changed key (`renderContinuous`, `:399-401`).
- **A mask grows in whole 256 px tiles** of the stroke grid, aligned to the grid origin `extent.min` and clipped to
  the grid. New area takes `maskBackground`.
- Commit (`EditorSession+Brush.swift:172-179`):

```swift
var painted = mask.replacing(result.asset)
// Grown past its layer, or already placed on its own: the mask keeps its place on the document. A linked
// one still moves with its layer.
if mask.placement != nil || result.bounds != stroke.sourceRect { painted.placement = result.transform }
```

  A grown unplaced mask becomes a **placed** mask at `transform(for: crop)`. Its `isLinked` and `isEnabled` values
  are kept.

### 12.4 Layer mask when a pixel stroke grows the layer (`EditorSession+Brush.swift:164-170`)

```swift
if !stroke.isMask, let original = mask, original.placement == nil, result.bounds != stroke.sourceRect {
    let raster = RasterSnapshot.replacing(source: original.asset, sourceRect: stroke.sourceRect,
        patches: [], crop: result.bounds, isMask: true)
```

An unplaced mask is re-rasterised to the new layer bounds. The old mask is stretched into the old pixel rect, and the
new area is **white** (`fill` defaults to 1), which means revealed. A placed mask is not touched.

### 12.5 Undo

There is one undo step per stroke: `beginEdit(...)` then `endEdit()`. The step names are `"Paint Mask"`, `"Erase"`,
`"Brush Stroke"` (or Blur, Clone Stamp, Spot Healing for those tools) (`:171`). Nothing is committed when
`stroke.patches` is empty.

### 12.6 When painting is refused (`canPaint`, `paintRefusal`, `EditorSession+Brush.swift:5-33`)

Painting needs:

- exactly one selected layer;
- a layer that is not a folder, unless its mask is selected;
- an effectively visible layer;
- an enabled mask, when painting the mask;
- a layer that is not an adjustment layer, unless its mask is selected;
- a selection that is not explicitly empty.

Each case has its own alert text, for example *"Several layers are selected. Select just one to paint on it."*
There is no locked "Background" layer concept, so erasing any layer always gives transparency.

---

## 13. Metadata dropped when a layer is painted

When pixels are painted, the layer is rebuilt (`EditorSession+Brush.swift:181-183`):

```swift
document?.layers[index] = ImageLayer(id: current.id, asset: result.asset, name: current.name,
    isVisible: current.isVisible, transform: result.transform, parentID: current.parentID, isGroup: false,
    opacity: current.opacity, blendMode: current.blendMode, mask: mask, maskSourceID: current.maskSourceID, effects: current.effects)
```

- The init (`EditorSession.swift:43`) defaults `adjustment`, `shape` and `text` to nil.
- **Dropped**: `text` (`LayerText`, live editable text), `shape` (`LayerShape`, live vector shape) and `adjustment`.
  Adjustment layers cannot be painted anyway. Painting rasterises text and shape layers. Even without the explicit
  drop, `liveText` and `liveShape` require `asset.image === text.image` / `shape.image`
  (`TypeTool.swift:216-220`, `ShapeTool.swift:88-92`), so any pixel edit kills them.
- **Kept**: id, name, visibility, parent, opacity, blend mode, mask (possibly re-rasterised as in 12.4), maskSourceID
  and **effects** (stroke and shadow). `isGroup` is forced to false. The transform is replaced as in 12.2.
- **Painting a mask** only replaces `layers[index].mask` (`:173-179`). Text, shape and effects stay, and a text layer
  stays editable.

---

## 14. Keyboard and mouse controls

| Input | Effect | Source |
|---|---|---|
| `B` | Brush tool, Paint mode | `EditorCanvas.swift:2290` |
| `E` | Brush tool, Erase mode | `:2291` |
| `Tab` (no modifiers) | Toggle Paint/Erase (`cycleToolMode`) | `:2276-2280`, `EditorSession.swift:436` |
| `[` / `]` | Size down / up | `:2308-2309`; window monitor `:789-793` |
| `Shift-[` / `Shift-]` (`{` `}`) | Hardness down / up in 25 % steps | `:2311-2312` |
| `1`...`9`, `0` | Opacity 10...90 %, 100 %, with two-digit entry | `:2306-2307` |
| Shift-click | Straight line from the end of the last stroke | `:1831-1833` |
| Shift-drag | Lock to horizontal or vertical | `:1963-1977` |
| Option (Brush or Eraser, no stroke) | Eyedropper: click samples the foreground color | `:93` |
| Space (held) | Pan. The brush circle is hidden | `:2281-2284` |
| Escape during a stroke | Cancel the stroke, discard, no undo | `:2221-2223` |
| Right-drag | Resize from the press size; with Shift, change hardness | `:1712-1746` |

**Size steps** (`EditorSession+Brush.swift:261-268`):

```swift
let current = brushSettings.diameter
let stepped = increase ? max(current + 1, (current * 1.2).rounded()) : min(current - 1, (current / 1.2).rounded())
brushSettings.diameter = min(2000, max(1, stepped))
```

Each step is a fifth (x1.2 or /1.2, rounded half away from zero), but always at least 1 px, and the result is clamped
to 1...2000.

**Hardness steps** (`:254-260`):

```swift
let quarter = brushSettings.hardness * 4
let step = increase ? floor(quarter + 0.001) + 1 : ceil(quarter - 0.001) - 1
brushSettings.hardness = min(4, max(0, step)) / 4
```

The value snaps to the next quarter, so 80 % goes up to 100 % or down to 75 %.

**Opacity digits** (`:237-252`):

```swift
var percent = digit == 0 ? 100 : digit * 10
if let pending = pendingOpacityDigit, time - pending.time < 0.6 {
    percent = max(1, pending.digit * 10 + digit)
    pendingOpacityDigit = nil
} else {
    pendingOpacityDigit = (digit, time)
}
```

- The first digit applies immediately. A second digit within **0.6 s** replaces it with the two-digit value:
  4 then 5 gives 45 %, 0 then 5 gives 5 %, and 0 then 0 gives 1 %.
- The keys work only when `brushStroke == nil`. They apply to `brushSettings.opacity` for Brush, Spot Healing, Clone
  and Smear.
- Digits are only read with no Command, Control or Option held. Shift turns digits into symbols.

**Right-drag** (`EditorCanvas.swift:1724-1739`):

```swift
if event.modifierFlags.contains(.shift) {
    // The full range across 200 points.
    session.brushSettings.hardness = min(1, max(0, drag.hardness + dx / 200))
    session.brushSettings.diameter = drag.diameter
} else {
    // The circle's edge follows the pointer: each point moved widens the radius by a point on screen.
    let perPixel = max(0.0001, session.viewport.pointsPerPixel)
    session.brushSettings.diameter = min(2000, max(1, (drag.diameter + 2 * dx / perPixel).rounded()))
    session.brushSettings.hardness = drag.hardness
}
brushPointer = drag.start
```

- `dx` is the horizontal offset from the press, in view points. The circle stays at the press point.
- The Shift state is re-read on every drag event. Switching mode resets the other value to its press value.
- The hardness inner ring is shown only while Shift is held.

**Shift-click line details** (`EditorSession+Brush.swift:119-122`):

```swift
guard let last = lastBrushPoint, last.layerID == activeLayerID, last.mask == isMaskSelected else { return nil }
return last.point
```

- `lastBrushPoint` is the last **painted** sample. With smoothing that is the smoothed anchor, not the raw release
  point.
- It is updated by `beginBrush`, by `continueBrush` and by Smudge/Liquify (`SmudgeLiquify.swift:227`). It is never
  cleared, so it survives cancel and tool switches, and it is tied to the same layer and the same pixels-or-mask
  target.
- The line is `beginBrush(at: from)` followed by `continueBrush(at: click)`. For a soft tip, `from` therefore gets a
  second click dab, which shows as extra density at the joint. The line then goes through smoothing like any sample.

---

## 15. Brush cursor

- **System cursor**: `NSCursor.crosshair` for every brush tool (`toolCursor` falls through to `.crosshair`,
  `EditorCanvas.swift:1454-1465`). The exception is Clone Stamp with a source set, where the cursor is hidden
  (`:1477-1481`). The crosshair is always shown together with the circle. There is no small-brush special case
  beyond the 1-point minimum.
- **Overlay circle** (`BrushCursorOverlay.swift:17-19, 59-64`). It is centred on the **raw pointer**, not on the
  smoothed brush position. Its diameter is `max(1, diameter * pointsPerPixel)` points. During a stroke it uses the
  stroke's diameter.

```swift
context.setStrokeColor(NSColor.white.cgColor)
context.setLineWidth(2.5)
context.strokeEllipse(in: circle)
context.setStrokeColor(NSColor.black.cgColor)
context.setLineWidth(1)
context.strokeEllipse(in: circle)
```

  A white 2.5 pt ring is drawn first, then a black 1 pt ring on top, on the same ellipse.
- **Hardness ring** (Shift right-drag only, `:65-76`): `inset = circle.width * (1 - hardness) / 2`, drawn with the
  same white 2.5 / black 1 pair and dash `[4, 3]`. It is not drawn at hardness 0.
- **When the circle shows** (`EditorCanvas.swift:1510`):
  `isBrushTool && !spaceHeld && !picking && middlePanPoint == nil && middleZoom == nil`. It is hidden when the
  pointer leaves the view (`mouseExited` sets `brushPointer = nil`, `:1593-1596`), while Option-picking, and while
  Space is held. It updates on mouse moves and drags.
- There is no line preview while Shift is held before a Shift-click.
- The circle is the same in Erase mode.

---

## 16. CPU fallback engine (reference only)

Used only when `gpu == nil` (`append`, `BrushStroke.swift:286-298`, `curve` `:452-466`, `walk` `:473-491`, `dab`
`:595-660`):

- **Path**: the same 4-sample window and centripetal Catmull-Rom, but each piece is split into
  `max(1, ceil(chord/2))` equal parameter steps. Dabs are walked along the polyline every `spacing`, with the leftover
  distance carried over (`distanceToNext`). The first sample places a dab and sets `distanceToNext = spacing`.
- **Tail**: drawn as a straight walk. The affected tiles' coverage and the walk state are saved first and restored
  exactly by `removeTail()`.
- **Dabs**:
  - Hard tips use an anti-aliased CG `fillEllipse`.
  - Soft tips use a CG radial gradient from `r*h` to `r` with 25 stops sampled from `falloff(u)` at `u = i/24`, plus
    `.drawsBeforeStartLocation`, which fills the core.
  - Dabs combine with `.lighten` (maximum) for hard tips and `.screen` (`1 - (1-a)(1-b)`) for soft tips. These are
    the discrete forms of section 8.
  - Pre-rendered tips (`gridTip` for axis-aligned, evenly scaled layers up to 3000 px; `stamp` up to 160 px) are
    optimisations only.
- Results differ from the GPU engine by small amounts: CG anti-aliasing versus the linear ramp, and 8-bit screen
  accumulation versus a float density.

---

## 17. Porting notes for Canvas 2D

### 17.1 What to reproduce

Reproduce the **GPU continuous engine**: settled/tail chords, the analytic per-pixel coverage, and recomposition from
the original pixels at every update. Do not use `ctx.arc` dabs or Canvas shadow blur. Canvas only displays the
result and, optionally, does the final source-over or destination-out.

### 17.2 Per-stroke state (in the target's grid)

```js
// grid = target layer's own pixels (native resolution) + growth room (canvas bbox in grid space)
const T = 256;                                      // emulate tiles: needed for exact mask growth
stroke = {
  M,               // grid->document affine {a,b,c,d,e,f}, = pixelToDocument (section 3.2-3.3)
  Minv,
  gridW, gridH, sourceRect,
  paintTransform,  // LayerTransform for the expanded grid
  r: diameter / 2, h: hardness,
  aa: Math.max(0.001, Math.min(Math.hypot(M.a, M.b), Math.hypot(M.c, M.d))),
  spacing: Math.max(0.25, diameter * (hardness >= 1 ? 0.015 : 0.025)),
  tiles: new Map(), // key -> { rect, perm: Float32Array, cov: Uint8Array, base: Uint8ClampedArray|Uint8Array }
  prevTailKeys: new Set(),
  samples: [],      // window of <= 4 document points
};
```

`perm` starts at 0. `base` is a copy of the original tile pixels: transparent outside `sourceRect`, or
`maskBackground` for masks. Keep it unchanged for the whole stroke.

### 17.3 Kernel in JS (exact transliteration)

```js
const E25 = Math.exp(-2.5), NORM = 1 - E25;
const GL_N = [0.1834346425, 0.5255324099, 0.7966664774, 0.9602898565];
const GL_W = [0.3626837834, 0.3137066459, 0.2223810345, 0.1012285363];
function cov(d2, s) {                         // brushCoverage
  const d = Math.sqrt(d2);
  if (s.h >= 1) return Math.min(1, Math.max(0, (s.r - d) / s.aa + 0.5));
  const t = Math.min(1, Math.max(0, (d / s.r - s.h) / (1 - s.h)));
  return Math.max(0, (Math.exp(-2.5 * t * t) - E25) / NORM);
}
const tipDensity = (d2, s) => -Math.log(Math.max(1 - cov(d2, s), 0.001));
function segDist2(px, py, g) { /* g = [x0,y0,x1,y1] */
  const vx = g[2]-g[0], vy = g[3]-g[1];
  const t = Math.min(1, Math.max(0, ((px-g[0])*vx + (py-g[1])*vy) / Math.max(vx*vx + vy*vy, 1e-12)));
  const dx = px - (g[0] + t*vx), dy = py - (g[1] + t*vy);
  return dx*dx + dy*dy;
}
function segDensity(px, py, g, s) {
  const vx = g[2]-g[0], vy = g[3]-g[1], len = Math.hypot(vx, vy);
  if (len < 1e-6) { const dx = px-g[0], dy = py-g[1]; return tipDensity(dx*dx + dy*dy, s); } // click
  const ux = vx/len, uy = vy/len, proj = (px-g[0])*ux + (py-g[1])*uy;
  const qx = px-g[0]-proj*ux, qy = py-g[1]-proj*uy, perp2 = qx*qx + qy*qy, r2 = s.r*s.r;
  if (perp2 >= r2) return 0;
  const reach = Math.sqrt(r2 - perp2), lo = Math.max(0, proj-reach), hi = Math.min(len, proj+reach);
  if (hi <= lo) return 0;
  const mid = (lo+hi)/2, half = (hi-lo)/2; let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = mid - half*GL_N[i] - proj, b = mid + half*GL_N[i] - proj;
    sum += GL_W[i] * (tipDensity(perp2 + a*a, s) + tipDensity(perp2 + b*b, s));
  }
  return sum * half / s.spacing;
}
function renderContinuous(s, settled, tail) {
  const tailKeys = keysFor(s, tail);           // continuousKeys: bbox +- (r+2) doc px, ∩ canvas, -> grid, -> tiles
  const keys = union(keysFor(s, settled), tailKeys, s.prevTailKeys);
  for (const key of keys) {
    const tile = allocate(s, key);             // creates perm/cov/base on first touch (also grows bounds)
    for (let y = 0; y < tile.h; y++) for (let x = 0; x < tile.w; x++) {
      const gx = tile.x + x + 0.5, gy = tile.y + y + 0.5;
      const px = s.M.a*gx + s.M.c*gy + s.M.e, py = s.M.b*gx + s.M.d*gy + s.M.f;
      const i = y*tile.w + x;
      if (px < 0 || py < 0 || px >= docW || py >= docH) { tile.cov[i] = 0; continue; }
      if (s.h >= 1) {
        let ds = Infinity, dt = Infinity;
        for (const g of settled) ds = Math.min(ds, segDist2(px, py, g));
        for (const g of tail)    dt = Math.min(dt, segDist2(px, py, g));
        const v = Math.max(tile.perm[i], cov(ds, s)); tile.perm[i] = v;
        tile.cov[i] = Math.round(255 * Math.max(v, cov(dt, s)));
      } else {
        let v = tile.perm[i], t = 0;
        for (const g of settled) v += segDensity(px, py, g, s);
        for (const g of tail)    t += segDensity(px, py, g, s);
        tile.perm[i] = Math.min(v, 20);
        tile.cov[i] = Math.round(255 * (1 - Math.exp(-Math.min(v + t, 20))));
      }
    }
  }
  s.prevTailKeys = tailKeys;
  recomposite(s, keys);
}
```

`cov(Infinity)` returns 0 for hard tips, because the clamp goes to 0. Use float64 in JS. Section 17.6 covers the small
differences from Metal float32. Keep the sample window, Catmull-Rom and `subdivide` code exactly as in 6.1-6.2.

**Performance.** Per pixel the cost is (number of segments) x 8 `exp`/`log` pairs. A 2000 px soft brush touches about
4 M pixels per event, which is too slow in plain JS. In order of preference:

- (a) Restrict the per-pixel loop to each segment's inflated bounding box. The results are identical, because density
  is 0 beyond `r`. The one difference is hard tips on layers scaled up past 4x, where `aa/2 > 2` can put coverage
  just outside the tile set Compositor would pick; tile emulation reproduces Compositor's clipping there.
- (b) Precompute `tipDensity` as a lookup table over `q = d^2/r^2` in [0, 1], for example 4096 to 16384 entries with
  linear interpolation. The value depends only on `d/r` and `h`. Keep an exact mode for tests.
- (c) Run the kernel in a Web Worker on transferable buffers.
- (d) If exactness and speed both matter, port the Metal kernel to a WebGL2 fragment shader with `R32F` ping-pong
  textures. It is a near one-to-one translation. Canvas 2D stays the display path.

### 17.4 Compositing (`recomposite`)

Option A uses Canvas 2D and is the most faithful to CG, since both are 8-bit premultiplied internally:

```js
// Per touched tile, in grid space with identity transform (no resampling):
tileCtx.globalCompositeOperation = 'copy';  tileCtx.drawImage(baseCanvas, ...);   // original pixels
// stroke image: rgb = foreground color (straight sRGB), alpha = cov8 (selection already multiplied in)
tileCtx.globalAlpha = opacity;
tileCtx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
tileCtx.drawImage(strokeTileCanvas, 0, 0);
tileCtx.globalAlpha = 1; tileCtx.globalCompositeOperation = 'source-over';
```

This matches CG: a fill clipped by the gray coverage mask, with global alpha `opacity`, then source-over or
destination-out. `putImageData` of the stroke tile premultiplies color by `cov8`. The extra rounding is invisible
because the color is uniform. The selection can be applied by drawing its coverage onto the stroke tile with
`destination-in` before compositing. That adds one 8-bit rounding step, where CG multiplies in float.

Option B is manual arithmetic on Uint8 arrays, and it is required for masks (Canvas has no gray-only surface). Use
the formulas in section 9 with `a = (cov8/255) * opacity * (sel8/255)`, computed in float. Keep layer pixels
**premultiplied** if you want CG-like quantisation at low alpha. Note that `getImageData` and `putImageData` are
straight-alpha and lossy at low alpha.

Display during the stroke draws the layer's grid (`paintTransform`) as the original image with the recomposited tiles
on top, through the layer's transform, opacity, blend mode and mask. Compositor shows an unplaced layer mask over the
old pixel rect and treats the area outside it as revealed (white).

### 17.5 Commit

1. Call `flush()`. If smoothing is on and the pointer is not at the anchor, append the raw pointer first.
2. Pixel layer: `crop = sourceRect ∪ bbox(alpha8 != 0 over touched tiles)`. With no source, use only the bounding box,
   or all tiles if that is empty.
3. Mask: `crop = sourceRect ∪ all allocated tiles`.
4. Build the new image cropped to `crop`. Compute the new `LayerTransform` with `transform(for: crop)` (section 12.2).
   Re-rasterise an unplaced layer mask, filling the new area white (12.4). A grown or placed mask gets
   `placement = transform(for: crop)` (12.3).
5. Pixel layer: drop `text`, `shape` and `adjustment`; keep effects, opacity, blend mode and mask. Mask stroke: change
   only the mask.
6. Push one undo step: "Brush Stroke", "Erase" or "Paint Mask".
7. Refuse painting in the `canPaint` cases (12.6). Discard on Escape.

### 17.6 Input mapping in the browser

- Use `pointerdown`, `pointermove` and `pointerup` with `setPointerCapture`. Convert to document points with the same
  formula as `documentPoint`. Points stay fractional.
- **Do not use** `getCoalescedEvents()` or `pressure`, to match Compositor, which uses one sample per (AppKit-
  coalesced) drag event and no pressure. Chrome's `pointermove` is already rAF-aligned, which is close to AppKit's
  cadence. Because the engine integrates over distance, using coalesced events would change the result very little
  (the curve shape between samples), but it would no longer match.
- Smoothing radius in document pixels = `smoothing / max(0.01, cssPxPerDocPx * devicePixelRatio)`, to match
  Compositor's device-pixel semantics. Use `smoothing / cssPxPerDocPx` only if the product team prefers the documented
  "screen points" intent.
- Shift axis lock: 3 document pixels, and `|dx| >= |dy|` means horizontal. The raw release point quirk is in 4.3.
- Cursor: CSS `cursor: crosshair`. On an overlay, draw a circle of diameter `max(1, diameter * cssPxPerDocPx)` CSS px:
  white `lineWidth 2.5` first, then black `lineWidth 1`. Draw the dashed `[4,3]` hardness ring during a
  Shift+right-drag. Hide the circle while Space-panning, while Alt/Option-picking and when the pointer leaves the
  canvas. Map macOS Option to Alt and right-drag to `button === 2` with `contextmenu` prevented.
- Keys: `[`, `]`, `{`, `}`, digits (0.6 s two-digit window), B, E, Tab and Escape, using the exact formulas in
  section 14. Ignore keys while a stroke is in progress, except Escape.

### 17.7 What cannot be reproduced exactly

1. **Float precision**: Metal float32, likely compiled with fast-math `exp`/`log`, against JS float64. Expect at most
   about 1 of 255 in 8-bit coverage, mostly at soft edges.
2. **Core Graphics 8-bit rounding** in the clip-mask fill, `setAlpha` and destination-out, against browser
   (Skia/CoreGraphics/Direct2D) rounding: about 1 of 255 per channel. Premultiplied storage loses straight-color
   precision at low alpha in both systems, but not identically.
3. **Event cadence**: AppKit drag coalescing (60 or 120 Hz) against browser `pointermove`. Coverage depends on
   distance, so the effect is small (2 of 255 or less in the upstream test), but the Catmull-Rom path between sparse
   samples and the smoothing behaviour follow the event stream.
4. **Selection clip resampling** on rotated or scaled grids, where CG interpolates the clip mask. It is exact only
   for unrotated 1:1 layers.
5. **16-bit and HDR "deep" layers** (`deepSource`, `DeepLayer`) have no Canvas 2D equivalent. Port them as 8-bit.
6. **Retina semantics**: `zoom` and `pointsPerPixel` map to `devicePixelRatio`. Decide this once (17.6).
7. The CPU fallback (section 16) differs from the GPU engine. Port only the GPU behaviour.

### 17.8 Test vectors (from upstream tests and section 7-8 tables)

- Single click, `h = 0`: `cov8 = round(255 * cov(d))`. At `d = r/2` this is 126 (0.4937), at `d = 0.75 r` it is 45.
- Long straight soft stroke, diameter 100, `h = 0`: cross-section 8-bit values from the table in 8.3.
- Opacity 0.4, self-crossing soft stroke on a blank layer: maximum alpha is exactly 102
  (`BrushIntersectionTests.swift:69-81`). Calling `flush()` again changes nothing.
- Self-crossing soft strokes: crossing alpha ≈ `255 - (255-a)(255-b)/255` within 3, and more than `max(a, b) + 10`
  (`:37-53`).
- A line sampled every 1000 px against every 5 px: alpha differs by at most 2 (`:55-67`), for diameters
  12, 120 and 520.
- Hard click, diameter 40, red, on a blank 20x20 layer scaled into a 200x200 document: the layer image ends up
  1 grid pixel per document pixel and at least 38 px wide (`NativeResolutionPaintTests.swift:137-152`).
