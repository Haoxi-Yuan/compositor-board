# Compositor Camera Raw Filter: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3, commit `365b574`). All `file:line` references
are relative to `upstream/Compositor/` unless they start with `engine/`, `media/`, `vscode-extension/` or
`CompositorTests/`. Code excerpts are verbatim. Modifier glyphs follow `ui.md`: `⌘` Command, `⌥` Option, `⇧` Shift,
`⌃` Control, `↩` Return, `⎋` Escape.

Files read in full: `UI/CameraRawControls.swift` (443 lines), `UI/CameraRawColorControls.swift` (537),
`UI/CameraRawDetailOpticsControls.swift` (189), `UI/CameraRawGeometryCalibrationControls.swift` (147),
`UI/CameraRawSlider.swift` (206), `UI/SliderSnap.swift` (42), `UI/FilterSheet.swift` (426), `UI/NumericScrub.swift`,
`Document/CameraRaw.swift` (618), `Document/CameraRawColor.swift` (327), `Document/CameraRawDetailOptics.swift` (126),
`Document/CameraRawGeometryCalibration.swift` (254), `Document/CameraRawReset.swift` (124),
`Document/CameraRawShadows.swift` (72), `Document/CameraRawTables.swift` (294), `Document/Filters.swift` (1034),
`Rendering/MetalCameraRawLookup.swift` (120), `Rendering/AdjustPixels.h` (129), and the Camera Raw parts of
`Rendering/AdjustPixels.c` (lines 200-480, 580-1205, 1530-1570). Read in part (targeted): `Rendering/EditorCanvas.swift`
(cursor, mouse routing), `UI/FloatingPanel.swift` (docking), `ContentView.swift:270-279`, `Document/Curves.swift`
(spline), `Document/Levels.swift` (histogram scale), `Document/DeepLayers.swift` (16-bit path),
`Document/HueSaturation.swift` (`canAdjustColors`), `Document/EditorSession.swift` (edit guards), the tests
`CompositorTests/CameraRawTests.swift`, `CameraRawGPUTests.swift`, `CameraRawResetTests.swift`,
`CameraRawSliderTests.swift`, and this repo's `engine/Sources/*.swift`, `engine/build.sh`,
`vscode-extension/extension.js`, `vscode-extension/core/engine-client.js`, `media/filters.js`, `media/render.js`,
`media/board.js` (engine and panel helpers).

**Empirical checks.** Facts marked **(measured)** were measured on this machine (Apple M5, macOS 26, Darwin 25.6):
a C harness linked against upstream's `AdjustPixels.c` and `LensPixels.c`, with `Resources/CameraRawTables.bin`
decoded exactly as `CameraRawTables.load()` does and the stages built exactly as `CameraRawTables.stages(for:)` builds
them; a C timing harness on a 12 MP buffer; a Swift program that encodes a 12 MP image as PNG through ImageIO (as
`engine/Sources/EngineMain.swift:writePNG` does); and the built `engine/bin/compositor-engine` timed on
`samples/parrot.comp`. All scratch programs were deleted afterwards.

There is **no "Load Profile" control in Camera Raw.** The only profile control is the checkbox "Enable Lens Profile
Corrections" (section 13). The two "Load Profile…" buttons in upstream belong to View › CMYK › Profile
(`CompositorApp.swift:159`) and Export As (`UI/ExportAsSheet.swift:155`) and are out of scope here.

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| Entry | Filter › Camera Raw Filter… on the active image layer. Destructive only: there is no Camera Raw adjustment layer | `CompositorApp.swift:336-338`, `Document/Filters.swift:18` |
| Panel | Floating `NSPanel` titled "Camera Raw Filter", **docked** full height against the right edge of the document window, 440 pt wide, 24 pt padding | `ContentView.swift:270-279`, `UI/FloatingPanel.swift:125-136`, `UI/FilterSheet.swift:192-195` |
| Layout | Histogram (fixed) + readout, then ten collapsible sections in a scroll view: Light, Color, Color Grading, Effects, Curve, Color Mixer, Detail, Optics, Geometry, Calibration; then Preview, error, "Limited to the selection", Cancel / OK | `UI/CameraRawControls.swift:14-28, 416-427`, `UI/FilterSheet.swift:165-189` |
| Model | `CameraRawSettings` (28 top-level scalars and choices + 7 nested structs), **not Codable**. Defaults are identity | `Document/CameraRaw.swift:47-162` |
| Normalization | Every change goes through `updateFilter`, which stores `settings.normalized`: clamps, non-finite to default, hue ranges swapped, curve points repaired, short guides dropped | `Document/Filters.swift:770-772` |
| Preview | Native resolution (Camera Raw never downscales to the 2048 preview limit). One render at a time; changes during a render wait (latest wins) instead of cancelling it. The last preview stays up meanwhile | `Document/Filters.swift:619-633, 790-844` |
| Speed tricks | Brightness for Contrast/Highlights measured once per session; Light, Color, Calibration primaries, parametric curve, Mixer and Grading composed into **one 33³ table** (one lookup per pixel); Metal for the lookup at ≥ 8,000,001 px with CPU repair (bit-exact) | `Document/Filters.swift:517-526, 683`, `Document/CameraRaw.swift:215-254`, `Rendering/MetalCameraRawLookup.swift` |
| Overlays | Option clipping view, sharpen-mask view, Visualize Range and the two histogram clipping indicators are **painted into the preview** by the engine kernels and are never committed | `Document/CameraRaw.swift:372-395`, `Document/Filters.swift:190-202` |
| Eyes | Ten section eyes zero that section in preview **and** on OK, without clearing its sliders | `Document/CameraRaw.swift:165-199`, `Document/Filters.swift:659-670` |
| OK | Renders the full-size result from the layer's own pixels (16-bit/HDR through the deep path), one undo step named **"Camera Raw Filter"**. An identity grade closes like Cancel (no undo step) | `Document/Filters.swift:861-996` |
| Memory | The rendered settings (hidden groups at defaults) seed the next open in the session; Last Filter (⌃⌘F) re-applies them without the panel | `Document/Filters.swift:872-888, 747-760` |
| Tables | `CameraRawTables.bin` ("CRT3", 763 tables of 17³, xz/LZMA) and `CameraRawShadows.bin` ("CRS2") must ship next to the engine binary. `engine/build.sh` already copies them | `Document/CameraRawTables.swift:36-64`, `engine/build.sh:66-67` |
| Port plan | Keep a **live filter session** in compositor-engine (the `EditorSession` and its `FilterEdit` stay open across requests). The board coalesces changes (one request in flight, latest state wins) and receives view-sized raw RGBA tiles plus the scope as JSON | section 18 |

---

## 1. How upstream renders Camera Raw (what the port must keep)

### 1.1 Data flow

1. `EditorSession.beginFilter(.cameraRaw)` (`Document/Filters.swift:694-744`) checks `filterEdit == nil`,
   `hueSaturation == nil` and `canAdjustColors` (else `NSSound.beep()`), commits a pending transform, cancels crop and
   lasso, and builds a `FilterEdit` from `filterSettings` (the session's remembered settings). For Camera Raw the
   preview source **is** the layer's own `CGImage` (`factor = 1`, `Document/Filters.swift:622-626`); there is no
   padding (`blurMargin` is 0). At ≥ 8,000,001 preview pixels it warms `MetalCameraRawLookup.shared` on a utility task
   (`Document/Filters.swift:738-740`). It then calls `updateFilter(edit.settings, preview: true)`.
2. Every panel control builds new `FilterSettings` and calls `updateFilter(_:preview:)`
   (`Document/Filters.swift:770-788`), which stores `settings.normalized`, then queues `edit.previewJob` as `pending`
   and calls `renderFilterPreview`.
3. `renderFilterPreview` (`Document/Filters.swift:790-844`) returns at once when a render is running. Otherwise it takes
   `pending`, renders it on a detached task, and when done stores `preparedPreview`, `cameraRawScope` and the measured
   brightness, then calls itself again, so the newest pending job renders next. Intermediate jobs are dropped, never
   cancelled mid-render. The comment reads: "Renders the newest settings; changes that arrive mid-render wait for it
   rather than cancelling it, so dragging a slider keeps the canvas updating."
4. `CameraRawScope.preview(job)` (`Document/CameraRaw.swift:379-395`) renders the **grade** (overlays off), counts the
   scope from it, then, if an Option view or sharpen mask is on, renders the job again with it; else if a clipping
   indicator is on, paints `adjust_camera_raw_clip_overlay` over the grade. So the histogram never shows overlay paint.
5. OK (`commitFilter`, `Document/Filters.swift:861-996`) and Cancel (`cancelFilter`, `:846-859`), see section 2.

### 1.2 The render pipeline (`CameraRawSettings.apply`, `Document/CameraRaw.swift:208-276`)

Order, verbatim from the code, each step skipped when it changes nothing:

1. Identity short cut: `if settings.isIdentity && clipping == nil && visualizePointColor < 0 && !sharpenMask { return image }`.
   Then `guard settings.isValid else { throw ProjectError.invalid }` (after normalization, only reachable with
   non-finite values that `normalized` already replaced, so in practice never).
2. **Geometry** warp (`CIPerspectiveTransform`), only when no Option view, no sharpen mask and no visualize.
3. Into an 8-bit premultiplied RGBA buffer (`ImageAdjustmentPixels.run`). Brightness for the adaptive sliders, when
   Contrast or Highlights is non-zero: the session's cached value, else measured here (`camera_raw_statistics`).
4. **Calibration Shadows Tint** (`adjust_camera_raw_calibration`, the primaries' sliders passed as 0).
5. Composed **table stages before Shadows**: Calibration primaries (each non-zero slider one stage), Exposure, White
   Balance (Temperature and Tint together), Contrast, Highlights. Only when Shadows ≠ 0.
6. **Shadows** region-adaptive pass (`adjust_camera_raw_shadows`, coefficients from `CameraRawShadows.bin`).
7. The **remaining table stages**: Whites, Blacks, Saturation, Vibrance, then the parametric curve's four amounts
   (only while the dividers are 25/50/75 and Refine Saturation is 0). When Shadows is 0 this is one table with all
   stages of steps 5 and 7.
8. **Folding**: when there are no point colors, Refine Saturation is 0 and no overlay is on, the Curve (tone and
   channel LUTs), Color Mixer stages and Color Grading stages are composed onto the same 33³ table
   (`foldingColor`, `Document/CameraRawColor.swift:274-287`). One `adjust_camera_raw` lookup per pixel, on Metal when
   `usesGPU`.
9. Otherwise the **curve/color pass** `adjust_camera_raw_curve_color` (curve LUTs, Refine Saturation, Mixer table,
   point colors, Grading table, Visualize Range dimming).
10. **Effects**: `adjust_camera_raw_effects` (Texture, Clarity, Dehaze, Glow, post-crop Vignette), then
    `adjust_grain` with the session seed.
11. **Optics** (`adjust_camera_raw_optics`), then **Detail** (`adjust_camera_raw_detail`); or, with the sharpen-mask
    view, only `adjust_camera_raw_sharpen_mask_overlay`.

With an Option clipping view (`clipping` 1 or 2) the pipeline skips geometry, calibration, color, effects, detail and
optics: it runs the table stages (and Shadows) and then thresholds the result (section 5.3).

### 1.3 Cost profile (measured, CPU, 12 MP, Apple M5)

| Step | Time |
|---|---|
| Compose an identity 33³ table | 0.1 ms |
| One composed-table lookup over 12 MP (`adjust_camera_raw`) | 23-33 ms |
| Scope, step 8 (`camera_raw_scope`) | 0.4-0.6 ms |
| Brightness statistics (`camera_raw_statistics`) | 6 ms |
| Clarity 30 (`adjust_camera_raw_effects`, guided filter) | 104-118 ms |
| Post-crop vignette −30 | 80-83 ms |
| **PNG encode of the 12 MP result through ImageIO** | **230-240 ms (13.3 MB)** |
| Raw RGBA write of the same 12 MP | 9-11 ms (48 MB) |
| Engine `filter.preview` (load project + begin + identity preview + PNG) on the 512² sample | 42 ms first, 10-11 ms after |

Consequences for the port: the per-request project reload is acceptable for small projects but grows with the
project; PNG encoding alone would cost more than most renders; a full-resolution transfer per slider tick (48 MB at
12 MP) is wasteful when the board can only show a view-sized part. Section 18 is built on these numbers.

---

## 2. Panel

- **"Open from Filter menu"**: menu item `Camera Raw Filter…` in the Filter menu (after "Lens Correction…", before
  "Remove Background…"). Enabled when `canAdjustColors` and `hueSaturation == nil`
  (`CompositorApp.swift:336-338`). `canAdjustColors` (`Document/HueSaturation.swift:453-462`) requires: no Levels, no
  filter, no text being typed, a document, an active layer, project not busy, not importing, no brush stroke, no pixel
  move, no rename, no New/Import sheet, **exactly one selected layer**, not a group, **not the mask**, the layer has
  pixels, it is effectively visible, and the selection is not explicitly empty. If another filter is already open,
  `beginFilter` beeps (`Document/Filters.swift:696`). Board: same predicate; the menu item disabled otherwise; when
  invoked anyway (shortcut, palette), no-op plus the board's beep equivalent.
  - Related entry point: the RAW develop sheet's "Camera Raw…" button imports and then opens Camera Raw on the new
    layer (`UI/RawDevelopSheet.swift:67`, help "Import, then open the Camera Raw Filter"). It belongs to the File/RAW
    import area; when that is ported it must call the same open path.
- **"Docked placement"**: `FloatingPanelPlacement.dockedToMainWindowRight`: frame
  `x = window.maxX − 440, y = window.minY, width 440, height = window height`, re-applied on every move/resize of the
  document window; the position is never remembered (`UI/FloatingPanel.swift:125-136, 146-160, 100-103`). The panel
  is `[.titled, .closable]`, floating, hides on app deactivation; its close button reports as Cancel
  (`UI/FloatingPanel.swift:87-97`, `ContentView.swift:274`). It overlaps the window's right edge (the Layers panel and
  part of the canvas). Content: `FilterSheet` with `padding(24)`, `width 440`, full height (`UI/FilterSheet.swift:192-195`).
- **"Scrolling column"**: `VStack(spacing: 10) { histogram; ScrollView { VStack(spacing: 12) { ten sections } } }`;
  the scroll content is padded 20 pt on the right and the scroll view pulled 20 pt right, so the scroller sits outside
  the content (`UI/CameraRawControls.swift:14-28`). Below it, outside the scroll view: Preview checkbox, preview error
  (orange), "Limited to the selection" (callout, secondary) when a selection exists, a divider, then
  `Cancel` (⎋) … spacer … [`ProgressView` + "Applying…" while committing] `OK` (↩, prominent)
  (`UI/FilterSheet.swift:165-189`). The whole sheet is disabled while committing (`UI/FilterSheet.swift:197`).

```
+------------------------------------------ 440 ------------------------------------------+
| Camera Raw Filter                                                                    [x] |  panel title bar
|  24 pt padding                                                                           |
|  +--------------------------- histogram 110 pt -------------------------------------+   |
|  | /\ (shadow clip)                                                (highlight clip) /\|   |
|  |                         R, G, B ribbons at 55% opacity                            |   |
|  +-----------------------------------------------------------------------------------+   |
|  R 128   G 64   B 32                                   (caption, monospaced, secondary)  |
|  +----------------------------- scroll view ------------------------------------------+  |
|  | v Light                                                         [eye] [reset]      |  |
|  |     Exposure    [============o============]  [ 0.25]                              |  |
|  |     ...                                                                            |  |
|  | v Color   ...   v Color Grading ...   > Effects   > Curve   > Color Mixer          |  |
|  | > Detail   > Optics   > Geometry   > Calibration                                   |  |
|  +------------------------------------------------------------------------------------+  |
|  [x] Preview                                                                             |
|  (error text)                                                                            |
|  Limited to the selection                                                                |
|  ------------------------------------------------------------------------------------   |
|  [Cancel]                                                   (spinner Applying…)  [ OK ] |
+------------------------------------------------------------------------------------------+
```

- **"Full-resolution live preview"**: Camera Raw's `prepared` factor is 1 (`Document/Filters.swift:622-626`), so
  `previewSource === original.image`, `previewScale == 1`, `previewMapping == mapping`
  (`CameraRawTests.swift:968-969`). The engine keeps this. The board's transport is view-sized (section 18.5); this
  changes what crosses the process boundary, not what is rendered.
- **"OK with no change"**: `commitFilter` computes `rendered = edit.renderSettings()` (eyes applied), stores it as
  `filterSettings`, then `if rendered.cameraRaw.isIdentity { cancelFilter(); return }`: panel closes, no undo step,
  `lastFilter` unchanged (`Document/Filters.swift:872-884`).
- **"Hidden groups dropped on OK"**: the commit job uses `edit.renderSettings()` (`Document/Filters.swift:907`), so a
  section whose eye is off is at its defaults in the result.
- **"Settings remembered"**: `filterSettings = rendered` (before the identity check) for Camera Raw only, so the next
  open starts from the rendered grade with hidden groups reset; eyes, pages and other panel state start fresh. In
  memory for the session (window) only. Cancel remembers nothing (`Document/Filters.swift:872-875`,
  `CameraRawTests.swift:346-370`). Board: keep `rememberedCameraRaw` per board instance, in memory; pass it to open.
- **"Last Filter"**: after a non-identity OK, `lastFilter = .cameraRaw` (`Document/Filters.swift:888`). Filter › Last
  Filter (⌃⌘F, title "Last Filter: Camera Raw Filter") calls `beginFilter(.cameraRaw, repeating: true)`, which renders
  no preview (`updateFilter(…, preview: false)`), then `commitFilter()`; an identity grade closes silently
  (`Document/Filters.swift:747-760`). Board: engine `filter.apply` with `repeating: true` and the remembered settings
  (section 20.3).
- **"16-bit / HDR layers"**: on OK a 16-bit layer runs through `DeepLayer.run(input, mixesChannels: true)`: ten 8-bit
  runs (base, then each channel stepped by 1, 2 and 4) merged back into 16 bits (`Document/Filters.swift:942-963`,
  `Document/DeepLayers.swift:189-225`). An HDR layer is normalized around that. The preview of an HDR layer is made
  from `hdrPreviewSource` and shown clipped and dithered to 8 bits (`Document/Filters.swift:809-814`). All engine-side;
  the board does nothing special.
- **"GPU lookup for large previews"**: `job.cameraRawUsesGPU = previewSource.width * previewSource.height >=
  MetalCameraRawLookup.minimumPixels` (8,000,001), preview only. `applyTable` tries Metal only for the grade
  (`clipping == 0`) and falls back to `adjust_camera_raw`. The Metal kernel marks pixels within 0.01 of a rounding
  boundary and `camera_raw_repair_lookup` recomputes them on the CPU, so GPU output is **byte-identical** to the CPU
  (`CameraRawGPUTests.swift:35-165`). Buffers are discarded on Cancel/OK. Engine-side; Metal compute works in a
  command-line process (runtime-compiled source, no Xcode). Verify once at ≥ 8 MP in the engine.
- **"Canvas pick cursor"**: `picking` includes `samplesWhiteBalance`, `samplesPointColor`, `samplesDefringe` and
  `drawingCameraRawGeometryGuide` (`Rendering/EditorCanvas.swift:94-99`): the canvas shows the pick cursor; Space
  still pans (each mouse-down branch checks `!spaceHeld`, `Rendering/EditorCanvas.swift:1753-1775`). The targeted
  adjustment tools are **not** in `picking`: they keep the current tool's cursor. Board: CSS cursor of the board's
  eyedropper (the same one its Eyedropper tool uses) while any of the four is armed; Space-pan unchanged.

### 2.1 Canvas mouse routing while Camera Raw is open

`mouseDown` (`Rendering/EditorCanvas.swift:1747-1776`), in this order, each only without Space held:

1. White Balance eyedropper armed → `sampleCameraRawWhiteBalance(at:)`, refocus the panel, stop.
2. Point Color eyedropper armed → `sampleCameraRawPointColor(at:)`, refocus, stop.
3. Defringe eyedropper armed → `sampleCameraRawDefringe(at:)`, refocus, stop.
4. Draw Guides armed → `beginCameraRawGeometryGuide(at:)`, stop.
5. Curve or Mixer Targeted Adjustment armed → `beginCameraRawDrag(at:)`, stop.

`mouseDragged`: a guide draft in progress → `continueCameraRawGeometryGuide(to:)`; a targeted drag → `dragCameraRaw(to:)`
(`:1866-1873`). `mouseUp`: a draft → `commitCameraRawGeometryGuide()`; the targeted drag ends (`:2093-2097`).
`mouseMoved` over the canvas → `updateCameraRawReadout(at:)`; `mouseExited` → readout `nil` (`:1593-1609`).
All points are **document** coordinates (`viewport.documentPoint`). Everything else on the canvas is inert because
`canEditLayers` and `canEditSelection` are false while `filterEdit != nil` (`Document/EditorSession.swift:696-701`,
`Document/Selection.swift:120`); Hand, Zoom and Space-pan keep working. Several tools can be armed at once; the order
above decides which one a click goes to.

---

## 3. Histogram and readout

- **"RGB histogram"** (`UI/CameraRawControls.swift:34-49, 85-122`): a `Canvas`, height 110, background black 35%
  opacity, rounded corners 4. Scope from the graded preview (`CameraRawScope.make`, `Document/CameraRaw.swift:349-369`):
  256 bins per channel, transparent pixels skipped, each pixel weighted `alpha / 255`, straight value
  `min(1, c / alpha)` binned at `lround(v * 255)`. Sampling `step = width * height <= 4_000_000 ? 4 : 8`, **per band**:
  the image is split into 16 row bands of `ceil(height / 16)` rows; inside each band `y` starts at the band's first
  row and advances by `step`, `x` advances by `step` from 0 (`Rendering/AdjustPixels.c:379-419`). So the row phase
  restarts at every band; a port must not recompute the scope itself.
  - Shared vertical scale `peak = max(scale(red), scale(green), scale(blue))` with
    `LevelsHistogramDisplay.scale(bins) = min(maxPositive, 4 * interior95)` where `interior95` is the 95th percentile
    (index `Int(Double(n - 1) * 0.95)` of the sorted positive values of bins 1…254), or the max when that list is empty,
    or 0 when nothing is positive (`Document/Levels.swift:47-56`). Nothing is drawn when `peak <= 0`.
  - Each channel is one filled path: start `(0, h)`, then for bin `i` the point
    `(i * w / 256, h - h * min(1, max(0, bins[i] / peak)))`, then `(w, h)`, closed, filled with the channel color at
    55% opacity, drawn red, then green, then blue.
- **"Vectorscope mode"**: context menu (Control-click / right-click) on the graph: "Histogram", "Vectorscope"
  (`UI/CameraRawControls.swift:50-53`). No re-render: the scope always carries both. Vectorscope data: 64×64 cells; for
  each sampled pixel with `chroma > 1e-4` and `max > 1e-4`, hue angle `h * 2π` (HSV hue), `s = chroma / max`,
  `column = Int((0.5 + cos(angle) * s * 0.48) * 64)`, `line = Int((0.5 + sin(angle) * s * 0.48) * 64)`, clamped
  0…63, `scope[line * 64 + column] += alpha / 255`. Drawing: `peak = max(scope)`; cell side `w / 64`; cell `i` at
  `x = (i % 64) * cell`, `y = h − (i / 64 + 1) * cell`, size `cell + 0.2` square, white at opacity
  `0.15 + 0.85 * min(1, v / peak)` (`UI/CameraRawControls.swift:95-106`). **Quirk**: cells are squares of `w / 64`
  (6.125 pt for the 392 pt wide graph) on a 110 pt high graph, so only rows 0-17 (strongly saturated cyan to magenta,
  `sin(angle) * s ≤ −0.456`) are visible; the center of the scope is far above the graph (section 22, Q1).
  - Help text (verbatim, `UI/CameraRawControls.swift:54-56`): Histogram mode: "Tones from black on the left to white on
    the right: blacks, shadows, midtones, highlights, whites. Control-click to show the vectorscope." Vectorscope mode:
    "Hue around the wheel, saturation outward from the center. Control-click to show the histogram."
    Accessibility label "RGB histogram" / "Vectorscope".
- **"Shadow clipping indicator"**: `triangle.fill` (caption2) at the graph's top-left, 4 pt inset. Off: white 55%;
  on: blue. Click toggles `showsShadowClipping` and re-renders (`updateFilter`). Help "Show clipped shadows in blue on
  the preview."; accessibility "Shadow Clipping Indicator" (`UI/CameraRawControls.swift:69-83`).
- **"Highlight clipping indicator"**: same at the top-right; on: red. Help "Show clipped highlights in red on the
  preview."; accessibility "Highlight Clipping Indicator".
  - The paint (`adjust_camera_raw_clip_overlay`, `Rendering/AdjustPixels.c:870-890`) works on straight values
    `min(1, c / alpha)`: shadows when **any** channel `<= 0.5/255` → `r *= 0.35; g *= 0.35; b = b * 0.35 + 0.65`;
    then highlights when any channel `>= 254.5/255` (tested on the already-tinted values) →
    `r = r * 0.35 + 0.65; g *= 0.35; b *= 0.35`. Alpha kept, written premultiplied with rounding. Preview only.
- **"RGB readout"**: caption, monospaced digits, secondary: `"R \(r)   G \(g)   B \(b)"` (three spaces), or
  `"R —   G —   B —"` (em dashes) when there is no value. Help "Red, green, and blue of the pixel under the pointer."
  Value (`Document/CameraRaw.swift:490-507`): the pixel of `preparedPreview ?? previewSource` (the adjusted preview
  with any overlay paint; the original when Preview is off) under the pointer, through `previewMapping⁻¹`, floored;
  `nil` outside the image or when alpha is 0; else straight `min(255, (c * 255 + a / 2) / a)` (integer math). Updated
  on mouse move over the canvas only (not during drags, not after a re-render); cleared when the pointer leaves the
  canvas.

---

## 4. Section headers

- **"Section order and disclosure"**: ten sections, `Section.allCases` order: **Light, Color, Color Grading, Effects,
  Curve, Color Mixer, Detail, Optics, Geometry, Calibration** (`UI/CameraRawControls.swift:416-427`). Header:
  `chevron.down` / `chevron.right` (caption, semibold, 12 pt wide frame), 6 pt gap, title in `.headline`; the whole
  chevron+title is the toggle button (accessibility label = title). Initially expanded: Light, Color, Color Grading.
  `@State` of the controls view, so reset at every panel open and never persisted. Expanded content is indented 18 pt;
  each section is a `VStack(spacing: 8)`.
- **"Eye toggle per section"**: right-aligned in the header, shown **only while that section adjusts** (stored
  settings, table below). `eye` when shown, `eye.slash` when hidden; borderless. Click toggles the matching
  `showsCameraRaw…` flag and re-renders. Help `"Hide \(name) in the preview"` / `"Show \(name) in the preview"`;
  accessibility `"Hide \(name)"` / `"Show \(name)"`, where name is the section title ("Color Mixer", "Color Grading",
  …) (`UI/CameraRawControls.swift:141-180, 304-325`). A hidden section's controls stay live (edits are stored but not
  previewed).
- **Reset buttons** (`arrow.counterclockwise`, borderless, after the eye, same visibility, disabled while committing;
  help `"Reset \(group.rawValue) to its defaults"`, accessibility `"Reset \(group.rawValue)"`). Action
  `resetCameraRaw(group)` (`Document/CameraRawReset.swift:112-123`): copies the group's fields from
  `CameraRawSettings()`, turns that section's eye back on, and re-renders. Fields per group
  (`Document/CameraRawReset.swift:35-76`):
  - **"Reset Light"**: exposure, contrast, highlights, shadows, whites, blacks.
  - **"Reset Color"**: whiteBalance (→ Custom), temperature, tint, vibrance, saturation.
  - **"Reset Effects"**: texture, clarity, dehaze, glow, glowStyle, glowRange, glowSpread, glowWarmth, vignetteAmount,
    vignetteStyle, vignetteMidpoint, vignetteRoundness, vignetteFeather, vignetteHighlights, grainAmount, grainSize,
    grainRoughness.
  - **"Reset Curve"**: the whole `curve` struct (four amounts, three dividers, four point curves, Refine Saturation).
  - **"Reset Color Mixer"**: the whole `mixer` (HSL arrays and every point color); also `cameraRawPointIndex = 0`.
  - **"Reset Color Grading"**: the whole `grading` (four wheels, Blending 50, Balance 0).
  - **"Reset Detail"**: the whole `detail`.
  - **"Reset Optics"**: the whole `optics`.
  - **"Reset Geometry"**: the whole `geometry` (Upright Off, Perspective, sliders, Constrain Crop off, guides); also
    the guide draft. **Quirk**: "Draw Guides" stays armed (section 22, Q7).
  - **"Reset Calibration"**: the whole `calibration` (Process → Version 6, seven sliders).
  - **"Reset re-shows section"**: `edit.setShows(group, true)`.

| Section | Eye/reset visible while (`adjusts…`) | Ref |
|---|---|---|
| Light | exposure, contrast, highlights, shadows, whites or blacks ≠ 0 | `Document/CameraRaw.swift:97-99` |
| Color | temperature, tint, vibrance or saturation ≠ 0 (White Balance mode alone does not count) | `:100-102` |
| Effects | texture, clarity, dehaze, glow, vignetteAmount or grainAmount ≠ 0 (styles, shape sliders, grain size/roughness alone do not count) | `:103-105` |
| Curve | any amount ≠ 0, refineSaturation ≠ 0, or any of the four point curves not exactly `[(0,0),(1,1)]` (dividers alone do not count) | `Document/CameraRawColor.swift:39-46` |
| Color Mixer | any HSL value ≠ 0, or any point color with a non-zero shift (a picked color with zero shifts does not count) | `:166-169` |
| Color Grading | any wheel with saturation ≠ 0 or luminance ≠ 0 (hue alone, Blending, Balance do not count) | `:242` |
| Detail | sharpenAmount ≠ 0 or noiseLuminance ≠ 0 or noiseColor ≠ 0 | `Document/CameraRawDetailOptics.swift:19-21` |
| Optics | removeChromaticAberration, enableLensProfile, distortion ≠ 0, purpleAmount ≠ 0, greenAmount ≠ 0 or vignetteAmount ≠ 0 | `:65-68` |
| Geometry | Guided with at least one guide longer than 0.01, or vertical, horizontal, rotate, aspect, scale, offsetX, offsetY ≠ 0 | `Document/CameraRawGeometryCalibration.swift:41-49` |
| Calibration | any of the seven sliders ≠ 0 (Process alone does not count) | `:224-227` |

`isIdentity` is "no section adjusts" (`Document/CameraRaw.swift:113-116`).

---

## 5. Shared slider behaviour

### 5.1 The control (`UI/CameraRawSlider.swift`)

`CameraRawSlider` is an `NSSlider` subclass (`CameraRawSliderView`), continuous, height 22, width as proposed
(120 when unconstrained), tooltip and accessibility label = the help text.

- **"Knob double-click resets"**: `mouseDown` with `clickCount >= 2` on the knob (knob frame inset by −2 pt, i.e. 2 pt
  larger each side) calls `onReset` (the slider's default) and returns (`:131-136, 174-180`).
- **"Track click glides"**: a press off the knob computes
  `fraction = clamp((x − track.minX − knob.width / 2) / (track.width − knob.width), 0, 1)` (mirrored in RTL),
  `value = min + fraction * (max − min)`, publishes it **once** through the change handler (with that control's
  rounding), and animates the knob there in 0.18 s ease-out. **The press does not start a drag**: moving before release
  changes nothing (`:139-171`). `CameraRawSliderTests.swift:63-72`: the far left gives −100, the center ≈ 0, the far
  right 100.
- Knob press: the system tracking loop; continuous changes while dragging (each through the change handler, so each
  is rounded as listed per section).
- **"Gradient tracks"**: when the track has colors, `GradientSliderCell.drawBar` replaces the system bar with a 4 pt
  tall rounded bar (radius 2) across the **whole** bar rect, a linear left-to-right gradient of the colors
  (`:194-205`). Plain tracks keep the system bar (accent fill from the left end to the knob). Colors, sRGB 0…1
  (`:21-49`); `HSB(d, s, b)` is `NSColor(hue: d/360 wrapped to 0…1, saturation: s, brightness: b)`:

| Track | Left | Right | Used by |
|---|---|---|---|
| `temperature` | (0.22, 0.46, 0.95) | (0.98, 0.82, 0.18) | Temperature |
| `tint` | (0.28, 0.70, 0.34) | (0.70, 0.40, 0.64) | Tint |
| `chroma` | (0.62, 0.62, 0.64) | (0.86, 0.18, 0.20) | Vibrance, Saturation |
| `hue(d)` | HSB(d − 50, 0.85, 0.9) | HSB(d + 50, 0.85, 0.9) | Mixer Hue (family center), Point Hue Shift (picked hue) |
| `saturation(d)` | (0.55, 0.55, 0.56) | HSB(d, 0.9, 0.9) | Mixer Saturation, Point Saturation Shift |
| `luminance(d)` | HSB(d, 0.55, 0.18) | HSB(d, 0.35, 0.95) | Mixer Luminance, Point Luminance Shift |
| `plain` | system | system | everything else |

### 5.2 The row (`slider(...)`, `UI/CameraRawControls.swift:338-360`, and the per-section variants)

`HStack(spacing: 10) { label; CameraRawSlider; field }`.

- **"Label double-click resets"**: only in Light, Color and Effects (`onTapGesture(count: 2)` on the label,
  `:346`). Resets to that row's `reset` value and clears any Option view. Labels elsewhere do not reset.
- **"Label scrub"**: dragging a label horizontally (minimum distance 1) sets `start + translationX * sensitivity`,
  clamped to the range, **not rounded** (`step` is nil in every Camera Raw call), with the `resizeLeftRight` cursor on
  hover and during the drag (`UI/NumericScrub.swift:5-55`). Sensitivity `1 / 10^decimals`: 1 unit per point, Exposure
  0.01 per point. A scrub always passes `clipping: nil`, so it clears an Option view. Rows that scrub: Light, Color,
  Effects, Curve amounts and Refine Saturation, HSL family rows, Detail, Optics (not the hue-range sliders), Geometry,
  Calibration. No scrub: Color-page sliders, point-color sliders, Grading (Blending, Balance, wheel luminance),
  Optics hue ranges.
- **"Numeric field"**: `TextField` with `.number.precision(.fractionLength(0...decimals))` (shows up to `decimals`
  fraction digits, trailing zeros dropped), committed on ↩ or focus loss. Typed values are stored unrounded; because
  `updateFilter` stores `settings.normalized`, an out-of-range value is clamped **immediately** (typing 150 in
  Contrast shows 100). A typed value clears an Option view. Widths and styles: 56 pt, rounded border, right-aligned in
  Light/Color/Effects/Detail/Optics/Geometry/Calibration; 48 pt, default style, left-aligned in Curve and HSL family
  rows; no field in Color-page, point-color, Grading and hue-range rows.
- Labels: `minWidth 96` (`CameraRawControls.labelWidth`, `:414`) in Light, Color, Effects, Detail, Optics, Geometry,
  Calibration (a longer title widens its own row); fixed 88 in Curve and Color-page rows; 78 in HSL family rows and
  Grading rows; 110 in point-color rows.
- Rounding on slider drag and track click (the change handler):

| Rows | Rounded to | Ref |
|---|---|---|
| Light, Color, Effects | `decimals` (Exposure 2, the rest 0) | `UI/CameraRawControls.swift:351` |
| Detail | 0 decimals | `UI/CameraRawDetailOpticsControls.swift:55` |
| Optics with range starting at 0 (profile Distortion/Vignetting, Purple/Green Amount, Midpoint) and hue ranges | whole numbers | `:154, 172, 177` |
| Optics Manual Distortion, Vignetting (−100…100) | **not rounded** | `:154` |
| Geometry, Calibration | whole numbers | `UI/CameraRawGeometryCalibrationControls.swift:74, 133` |
| Curve amounts, Refine Saturation, HSL family, Color page, point colors, Grading sliders and wheels | **not rounded** | `UI/CameraRawColorControls.swift:130, 310, 324, 405, 481, 491, 531` |

- **"Option clipping view"** (`assign`, `UI/CameraRawControls.swift:372-379`, and `installOptionMonitor`, `:394-407`):
  every slider-handler change on Exposure, Highlights or Whites sets
  `cameraRawClipping = ⌥ held ? .highlights : nil`; Shadows and Blacks `⌥ held ? .shadows : nil`; any other Light,
  Color or Effects change, scrub, typed value or reset sets it to `nil`. Releasing ⌥ (a `flagsChanged` without ⌥)
  clears both the clipping view and the sharpen-mask view and re-renders. Holding ⌥ alone shows nothing until the next
  slider change. The view is preview-only (section 5.3).
- **"Help tooltips"**: every label, slider and field of a row carries the row's help text (verbatim per section below).

### 5.3 Rendering of the Option clipping view

`adjust_camera_raw(…, clipping)` after the table (`Rendering/AdjustPixels.c:421-451`), on straight values:
- `1` highlights: each channel becomes 1 if `>= 254.5/255`, else 0 ("clipped channels lit on black").
- `2` shadows: if any channel `<= 0.5/255`, each channel becomes 0 if clipped, else 1; otherwise white
  ("dark on white").

---

## 6. Light

All `−100…100`, default 0, 0 decimals, track plain, label double-click and knob double-click reset to 0, unless noted
(`UI/CameraRawControls.swift:199-214`; model `Document/CameraRaw.swift:48-63`).

| Item | Range · default · decimals | ⌥ view | Help (verbatim) |
|---|---|---|---|
| **"Exposure"** | −5…5 stops · 0 · 2 (scrub 0.01/pt) | highlights | "Brightens or darkens the whole picture, in stops of light. Hold Option to see clipped highlights." |
| **"Contrast"** | −100…100 · 0 | none | "Makes light and dark tones more or less different, mostly around the middle." |
| **"Highlights"** | −100…100 · 0 | highlights | "Adjusts the bright parts of the picture. Hold Option to see clipped highlights." |
| **"Shadows"** | −100…100 · 0 | shadows | "Adjusts the dark parts of the picture. Hold Option to see clipped shadows." |
| **"Whites"** | −100…100 · 0 | highlights | "Sets the brightest point. Hold Option to see clipped highlights." |
| **"Blacks"** | −100…100 · 0 | shadows | "Sets the darkest point. Hold Option to see clipped shadows." |

Rendering: Exposure is a measured table run (`exposureStart`, 21 tables −5…5 by 0.5). Contrast blends the 7×7
tables at the picture's mean brightest channel (`brightness.brightest`), Highlights at its log-average brightest
channel; both brightnesses in sRGB levels from `camera_raw_statistics` on the source, measured once per session
(`Document/CameraRawTables.swift:125-143, 172-175`). Shadows uses the region-adaptive pass with two coefficient sets:
the set is chosen by the **layer's** long side `max(w, h) / scale >= normalFrom` (1020 in the shipped file,
**(measured)**) (`Document/CameraRawShadows.swift:61-71`). Whites, Blacks: tables −100…100 by 25.

---

## 7. Color

`UI/CameraRawControls.swift:216-250`; model `Document/CameraRaw.swift:52-65`.

- **"White Balance picker"**: row `Text("White Balance")` (minWidth 96) + pop-up (labels hidden) with "Custom", "Auto"
  + eyedropper button. Help on label and picker: "Auto balances the average color. Custom follows Temperature and
  Tint." Choosing **Custom** only stores the mode. Choosing **Auto** (`applyCameraRawAutoWhiteBalance`,
  `Document/CameraRaw.swift:425-439`): stores `.auto` and re-renders at once (the pop-up moves on the click), then
  computes `autoBalance(of: original layer)` off the main thread: the unweighted mean of every pixel with alpha > 0, in **linear** light
  (`srgb_decode(min(1, c/a))`), re-encoded, then `neutralize`. When it finishes, it applies Temperature/Tint **only if
  the panel is still open, not committing, and the mode is still Auto**; a layer with no pixel above alpha 0 leaves
  the sliders alone (mode stays Auto). Moving Temperature or Tint (slider, scrub, field, reset) sets the mode back to
  Custom (`:377`). There are no Kelvin presets ("As Shot", "Daylight"… do not exist).
- **"White Balance Selector"**: `eyedropper` button (borderless; accent tint while armed, secondary otherwise;
  accessibility "White Balance Selector"; help "Click a pixel that should be neutral."). Click toggles
  `samplesWhiteBalance` (stays armed until clicked again). While armed a caption (caption, secondary) shows:
  "Click the original layer. Click the eyedropper again to stop." A canvas click inside the document
  (`sampleCameraRawWhiteBalance`, `Document/CameraRaw.swift:400-421`) reads the **original** layer pixel
  (`point · mapping⁻¹`, floored; ignored outside the layer or when alpha is 0), straight `min(1, c / a)`, solves
  `neutralize(r, g, b)` and stores Temperature, Tint and mode Custom. `neutralize`
  (`Document/CameraRawTables.swift:273-293`): nil when a channel is `<= 1e-4`; otherwise a grid search of the White
  Balance stage minimizing `max − min` of the result: step 10 over ±100, then step 2 over ±10, then 0.5 over ±2 around
  the best, skipping |value| > 100, strict improvement only.
- **"Temperature"**: −100…100 relative (not Kelvin), default 0, positive warmer, 0 decimals, track `temperature`
  (blue → yellow). Help "Shifts the picture from blue to yellow."
- **"Tint"**: −100…100, default 0, positive magenta, track `tint` (green → mauve). Help "Shifts the picture from green
  to mauve." Temperature and Tint render together through the 9×9 grid of tables (4 blended).
- **"Vibrance"**: −100…100, default 0, track `chroma`. Help "Strengthens quiet colors more than colors that are already
  strong, and protects skin tones."
- **"Saturation"**: −100…100, default 0, track `chroma`. Help "Strengthens or weakens every color by the same amount."

---

## 8. Color Grading

`UI/CameraRawColorControls.swift:426-537`; model `Document/CameraRawColor.swift:231-269`.

- **"View menu"**: pop-up (menu style, labels hidden, fixed size) with "Three-Way" (default), "Shadows", "Midtones",
  "Highlights", "Global". Help "Three-Way shows shadows, midtones, and highlights. The other choices show one wheel."
  The page is panel state (`cameraRawGradePage`), not a setting. A menu because "Five segments spelled out want 453
  points and the docked panel has 374" (`:433-434`). Global is reachable only here.
- Layout: Three-Way = `HStack(spacing: 30) { Shadows wheel; Midtones wheel; Highlights wheel }`; a single page shows
  one wheel titled with the page name. Then Blending and Balance rows.
- **"Wheel interaction"** (`GradeWheel`, `:502-537`), per wheel a `VStack(spacing: 4)`:
  1. Title (caption), help "Drag inside the wheel. Angle sets hue, distance sets saturation."
  2. Wheel 86×86. `radius = side / 2 − 6` (37). Fill: an angular gradient of `HSB(h, 1, 1)` for h = 360, 330, …, 0
     (so hue runs **counterclockwise from red at the right**), 85% opacity; a white 80% 1 pt ring; a white 10 pt dot at
     `(cos(hue) * d, −sin(hue) * d)` from the center with `d = saturation / 100 * radius`. Hit area: the circle.
     Drag (minimum distance 0, so a plain press counts) sets both on every move:
     `dx = x − side/2`, `dy = side/2 − y`, `hue = atan2(dy, dx)` in degrees (+360 if negative),
     `saturation = min(100, hypot(dx, dy) / radius * 100)`, unrounded; a drag continuing outside the circle keeps
     updating. Double-click resets hue and saturation to 0 (luminance kept). Help "Drag to set hue and saturation.
     Double-click to reset this wheel."
  3. Readout `"\(Int(hue.rounded()))°  \(Int(saturation.rounded()))"` (two spaces), caption2 monospaced, help
     "Hue and saturation of this wheel."
  4. Luminance slider, plain track, 96 pt wide, no label or field, double-click knob → 0, help "Brightness added by
     this wheel."
- **"Shadows wheel"**, **"Midtones wheel"**, **"Highlights wheel"**, **"Global wheel"**: hue 0…360, saturation
  0…100, default 0/0.
- **"Shadows luminance"**, **"Midtones luminance"**, **"Highlights luminance"**, **"Global luminance"**: −100…100,
  default 0, under each wheel.
- **"Blending"**: label (78 pt) + slider 0…100, default 50 (knob double-click → 50), help "Controls how much the three
  tonal wheels overlap."
- **"Balance"**: −100…100, default 0, help "Shifts the wheels toward shadows or highlights." Negative favors shadows.
- Rendering: entirely from the measured tables (`gradingStages`, `Document/CameraRawTables.swift:204-241`): luminance
  stages (−100…100 by 50), then global, midtones, highlights, shadows wheels; each wheel blends tables at its two
  nearest hues (30° apart) and saturations {0, 25, 50, 100} (below 25 the lower one is "no change"); shadow and
  highlight wheels also blend between Blending 0, 50, 100; Balance scales their saturation:
  `highlightShare = max(0, b < 0 ? 1 + 1.4b : 1 + 2b)`, `shadowShare = max(0, b < 0 ? 1 − 1.2b : 1 − 1.4b)`,
  `b = balance / 100`. The formula path in `adjust_camera_raw_curve_color` gets zeroed wheels; only Blending/Balance
  reach it, unused.

---

## 9. Effects

`UI/CameraRawControls.swift:252-302`; model `Document/CameraRaw.swift:66-88`. Rows are Light-style (label minWidth 96,
scrub, label and knob double-click reset, 56 pt field, 0 decimals). Sub-headings in `.subheadline`; nested rows are
indented 16 pt.

| Item | Range · default (reset) | Help (verbatim) |
|---|---|---|
| **"Texture"** | −100…100 · 0 | "Adds or softens small detail." |
| **"Clarity"** | −100…100 · 0 | "Adds or softens contrast along broader shapes." |
| **"Dehaze"** | −100…100 · 0 | "Clears haze when raised, and adds haze when lowered." |
| *"Glow"* sub-heading | | |
| **"Glow amount"** (row title "Glow") | 0…100 · 0 | "Spreads a glow from the bright areas." |
| **"Glow Style"** (pop-up titled "Style") | Diffusion (default) / Bloom / Halation | "Diffusion is soft and wide, Bloom is tighter, and Halation is a red fringe." |
| **"Glow Range"** (nested, "Range") | −100…100 · 0 | "Chooses how bright an area must be to glow. Has no effect until Glow is raised." |
| **"Glow Spread"** (nested, "Spread") | −100…100 · 0 | "Sets how far the glow reaches. Has no effect until Glow is raised." |
| **"Glow Warmth"** (nested, "Warmth") | −100…100 · 0 | "Shifts the glow from cool to warm. Halation stays red. Has no effect until Glow is raised." |
| *"Vignette"* sub-heading | | |
| **"Vignette Amount"** ("Amount") | −100…100 · 0 | "Darkens or lightens the edges. The center does not change." |
| **"Vignette Style"** (pop-up "Style") | Highlight Priority (default) / Color Priority / Paint Overlay | "Highlight Priority protects bright edges. Color Priority also reduces color. Paint Overlay covers the edges evenly." |
| **"Vignette Midpoint"** (nested) | 0…100 · **50** | "Sets where the vignette begins, from the center outward." |
| **"Vignette Roundness"** (nested) | −100…100 · 0 | "Makes the vignette rounder or more square." |
| **"Vignette Feather"** (nested) | 0…100 · **50** | "Softens the edge of the vignette." |
| **"Vignette Highlights"** (nested) | 0…100 · 0 | "Protects bright pixels while a dark vignette is applied. Used by Highlight Priority." |
| *"Grain"* sub-heading | | |
| **"Grain Amount"** ("Amount") | 0…100 · 0 | "Adds film grain, strongest in the middle tones." |
| **"Grain Size"** ("Size") | 0…100 · **25** | "Makes the grain coarser or finer." |
| **"Grain Roughness"** ("Roughness") | 0…100 · **50** | "Makes the grain smoother or more uneven." |

Notes: Range/Spread/Warmth stay enabled while Glow is 0 (they just do nothing). The grain kernel size is
`0.5 + grainSize / 100 * 19.5` px (`Document/CameraRaw.swift:202`); the pattern is fixed by `FilterEdit.seed`, a
random `UInt32` per panel open, shared by preview and OK (`Document/Filters.swift:458, 907`). Texture and Clarity
radii scale with the picture: `max(1, lround(side * 8 / 1456))` and `max(2, lround(side * 32 / 1456))`
(`Rendering/AdjustPixels.c:928-938`). Pop-ups are the default macOS picker style (title on the left, pop-up button).

---

## 10. Curve

`UI/CameraRawColorControls.swift:3-260`; model `Document/CameraRawColor.swift:19-155`.

- **"Mode"**: segmented, labels hidden: "Parametric" (default) / "Point". Help "Parametric lifts tonal regions. Point
  places anchors on the curve." Panel state (`cameraRawCurvePage`).
- **"Point channel"** (Point mode only): segmented "RGB" (default) / "Red" / "Green" / "Blue". Help "RGB changes
  brightness. Red, green, and blue also shift the color." Changing it clears the selected point and any drag.
- **"Curve graph"**: height 150, full width, background black 35%, corner radius 4. Diagonal from bottom-left to
  top-right, white 25%, 1 pt. Curve stroke white, 1.5 pt.
  - Parametric: 64 samples `curve.parametric(i / 63)` (the **formula**, section 10.1), plus three divider ticks at
    `x = split / 100 * width`, from `y = height − 8` to the bottom, white, 3 pt.
  - Point: 256 samples `channelTable(points)` of the current channel, plus each point as an 8×8 circle at
    `(x * w, (1 − y) * h)`, accent color when selected, else white.
  - Help: Parametric "Drag up or down to lift or lower those tones. Drag a divider along the bottom to change which
    tones each region covers." Point "Drag a point. Click to add one. Double-click a point to remove it."
  - One drag gesture (minimum distance 0) picks what it moves at the press and keeps it until release.
- **"Parametric region drag"**: a press not within 18 pt of the bottom takes the region of
  `tone = x / width * 100`: `< shadowSplit` Shadows, `< darkSplit` Darks, `< lightSplit` Lights, else Highlights,
  and its starting amount. Moving sets `amount = clamp(start − translationY / height * 200, −100, 100).rounded()`
  (200 units per graph height, up is positive).
- **"Parametric dividers"**: a press with `y > height − 18` takes the divider nearest to `tone` (by
  `|split − tone|`, first wins on ties). Moving sets `value = clamp(x / width * 100, 2, 98)` and:
  shadow `= min(value, darkSplit − 2)`; dark `= min(lightSplit − 2, max(shadowSplit + 2, value))`;
  light `= max(value, darkSplit + 2)`. Then normalization clamps the stored values to shadow 5…90,
  dark `shadow + 2…95`, light `dark + 2…98` (`Document/CameraRawColor.swift:124-126`), so a shadow divider dragged
  to 2 stores 5. Defaults 25/50/75.
- **"Highlights"**, **"Lights"**, **"Darks"**, **"Shadows"** (shown in Parametric mode, in that order): label 88 pt
  (scrub 1/pt, no label reset), slider −100…100 default 0 (knob double-click → 0), field 48 pt, **unrounded**. Help:
  Highlights "Lifts or lowers the brightest tones."; Lights "Lifts or lowers the light tones."; Darks "Lifts or lowers
  the dark tones."; Shadows "Lifts or lowers the darkest tones."
- **"Add point"** (Point mode): with `x = px / width`, `y = 1 − py / height` at the press: if the nearest point is
  closer than 0.055 (Euclidean in 0…1 units) it is selected and dragged; else, if there are fewer than 16 points,
  `0.01 < x < 0.99` and every point is more than 0.01 away in x, a point `(x, clamp(y, 0, 1))` is added, the list
  sorted, stored, selected and dragged; else nothing.
- **"Drag point"**: moving sets `y = clamp(1 − py / height, 0, 1)`; inner points also
  `x = min(next.x − 0.01, max(prev.x + 0.01, px / width))`; the end points keep x. Every move stores the list, which
  normalization repairs (section 17.3). **Quirk**: pushing a point against a neighbor lands it exactly 0.01 away,
  which the repair's strict `>` drops (section 22, Q5).
- **"Remove point"**: a double-click removes the inner point (not the ends) nearest in x when it is within 0.04 of the
  click's x; the selection clears.
- **"In/Out readout"**: Point mode with a selected point: `"In \(Int((x * 255).rounded()))   Out \(Int((y * 255).rounded()))"`
  (three spaces), caption monospaced secondary, help "Input and output of the selected curve point."
- **"Preset"**: pop-up titled "Preset": "Custom", "Linear", "Medium Contrast", "Strong Contrast". Shows the preset
  whose point list equals the current channel's exactly, else Custom. Choosing one replaces the current channel's
  points (Custom does nothing). Linear `[(0,0),(1,1)]`; Medium `[(0,0),(0.25,0.18),(0.75,0.82),(1,1)]`; Strong
  `[(0,0),(0.25,0.10),(0.75,0.90),(1,1)]`. Help "Replaces this curve with a straight line or a contrast curve."
- **"Refine Saturation"**: Point mode, RGB channel only: label 88, slider −100…100 default 0, field 48, unrounded.
  Help "How much the curve also changes color strength. Zero matches Photoshop; lower keeps it to brightness, higher
  adds more color." Non-zero disables table folding and the measured parametric tables (the curve pass draws the
  formula).
- **"Targeted Adjustment"**: bordered button `Label("Targeted Adjustment", systemImage: "scope")`, accent tint while
  armed. Toggles `targetsCameraRawCurve` and turns off the mixer's. Help "Drag on the picture to move the curve for the
  tone under the pointer." On the canvas (`Document/CameraRaw.swift:509-540, 589-617`): the press samples the
  **preview** pixel (`preparedPreview ?? previewSource`), straight `min(1, c / a)`: `tone = Rec.709 luma`,
  `hue` (HSV, degrees), `saturation = chroma / max`, `luminance = (max + min) / 2`; no drag on a clear pixel or outside
  the image. Each move sets `delta = (startY − y) * 0.35` with `y` in **document pixels** (so the sensitivity depends
  on zoom), from the settings at the press: Parametric → the region of `tone` gets `clamp(start + delta, −100, 100)`
  (unrounded); Point → `nudged(channel, near: tone, by: delta / 100)`: the point nearest in x (end points included)
  gets `y = clamp(y + delta/100, 0, 1)`.

### 10.1 Curve math the board must port (for drawing)

- Spline (`CurvesSettings.value`, `Document/Curves.swift:18-31`), points in 0…255: `i = clamp(lastIndex(p.x <= x) ?? 0,
  0, n − 2)`; secant slopes `d[k]`; tangent `m[0] = d[0]`, `m[n−1] = d[n−2]`, inner `m[j] = 0` if
  `d[j−1] * d[j] <= 0` else the harmonic mean `2 / (1/d[j−1] + 1/d[j])`; cubic Hermite on `t = clamp((x − x_i)/h, 0, 1)`;
  result clamped to 0…255. `point(x, pts)` scales 0…1 points by 255.
- `channelTable(points)` = `point(i / 255)` for i = 0…255.
- `parametric(tone)` (`Document/CameraRawColor.swift:52-74`): identity when all four amounts are 0; else 33 anchors
  `x = i / 32`, `y = bend(bend(x, lower: shadowSplit/100, shadows, upper: lightSplit/100, highlights), lower:
  darkSplit/100, darks, upper: darkSplit/100, lights)`, then the spline through them. `bend` (strength 1.66): below
  `lower` (if `lower > 0`) `lower * (tone/lower)^(2^(−low/100 * 1.66))`; above `upper` (if `upper < 1`)
  `1 − (1 − upper) * ((1 − tone)/(1 − upper))^(2^(high/100 * 1.66))`; else unchanged.
- Rendering uses the measured parametric tables while the dividers are 25/50/75 and Refine Saturation is 0
  (`hasMeasuredDividers`), so the drawn formula curve and the rendered result can disagree (section 22, Q10).

---

## 11. Color Mixer

`UI/CameraRawColorControls.swift:262-424`; model `Document/CameraRawColor.swift:157-228`.

- **"Mode"**: segmented "HSL" (default) / "Color" / "Point Color". Help "HSL lists every color. Color edits one family.
  Point Color adjusts a color you pick." Panel state (`cameraRawMixerPage`).
- **"HSL component"** (HSL page): segmented "Hue" (default) / "Saturation" / "Luminance". Help "Hue shifts the color,
  Saturation its strength, and Luminance its brightness." Panel state (`cameraRawMixerTab`), also read by the mixer's
  targeted adjustment on every page.
- Eight family rows (HSL page): label (78 pt, scrub 1/pt), slider −100…100 default 0 (knob double-click → 0),
  field 48, **unrounded**. Track: Hue → `hue(center)`, Saturation → `saturation(center)`, Luminance →
  `luminance(center)`. Help `"\(Component) of \(Family)."`, e.g. "Hue of Reds.":
  - **"Reds"** center 0°, **"Oranges"** 30°, **"Yellows"** 60°, **"Greens"** 120°, **"Aquas"** 180°, **"Blues"** 240°,
    **"Purples"** 270°, **"Magentas"** 300° (`names`, `centers`, `:159-160`).
- **"Color page swatches"**: eight 18 pt circles `HSB(center, 0.8, 0.9)` (Reds `#E62E2E`, Oranges `#E68A2E`, Yellows
  `#E6E62E`, Greens `#2EE62E`, Aquas `#2EE6E6`, Blues `#2E2EE6`, Purples `#8A2EE6`, Magentas `#E62EE6`), plain
  buttons; the selected one (`cameraRawMixerSwatch`, default 0) ringed white 2 pt. Help `"Edit \(Family)."`.
- **"Color page Hue"**, **"Color page Saturation"**, **"Color page Luminance"**: label 88, slider −100…100 default 0,
  track as the HSL page, **no field, no scrub**, unrounded; they edit the same arrays as the HSL page. Help:
  "Shifts the selected color family around the wheel." / "Makes the selected color family stronger or quieter." /
  "Makes the selected color family lighter or darker."
- **"Point Color eyedropper"**: `eyedropper` button (default bordered style, accent tint while armed). Help "Click the
  picture to save a color. Up to eight colors." Toggles `samplesPointColor` (stays armed, also when the page changes).
  A canvas click (`sampleCameraRawPointColor`, `Document/CameraRaw.swift:542-556`) samples the **preview** pixel as the
  targeted tool does (HSV hue in degrees, `saturation = chroma / max`, `luminance = (max + min) / 2`). If
  `points[pointIndex]` exists it is **replaced** by the new color keeping its three shifts (ranges and Visualize go back
  to defaults); else if fewer than 8 points, the color is appended and `pointIndex` set to it. Because `pointIndex`
  starts at 0 and only ever points at an existing color, in practice there is at most one point color (section 22, Q4).
- **"Point Color swatches"**: one 16 pt circle per color, `Color(hue: h/360, saturation: s, brightness: luminance)`
  (HSB with the HSL lightness as brightness), white 2 pt ring on the selected one; click selects. Help "Select this
  picked color."
- Point sliders (shown when `points[pointIndex]` exists): label 110, slider, no field, no scrub, unrounded:
  - **"Hue Shift"** −100…100 · 0, track `hue(point.hue)`: "Shifts the picked color around the color wheel."
  - **"Saturation Shift"** −100…100 · 0, track `saturation(point.hue)`: "Makes the picked color stronger or quieter."
  - **"Luminance Shift"** −100…100 · 0, track `luminance(point.hue)`: "Makes the picked color lighter or darker."
  - **"Hue Range"** 5…180 · 30 (degrees, half-width): "How far in hue the adjustment reaches."
  - **"Saturation Range"** 0.05…1 · 0.4: "How far in saturation the adjustment reaches."
  - **"Luminance Range"** 0.05…1 · 0.4: "How far in brightness the adjustment reaches."
- **"Visualize Range"**: checkbox bound to `points[pointIndex].visualize` (a stored setting). Help "Dims the picture
  outside this color's range. It is not kept when you press OK." While on, the preview darkens (×0.35) pixels whose
  point weight on the **source** HSL is `<= 0.05`; the commit job never sets `visualizesPointColor`, but the flag
  itself is remembered with the settings and dims again at the next open (`Document/Filters.swift:481-485`,
  `Rendering/AdjustPixels.c:1183-1185`).
- **"Targeted Adjustment"** (mixer): same button as the curve's; toggles `targetsCameraRawMixer` and turns off the
  curve's. Help "Drag a color in the picture. Nearby color families move together." On the canvas: the press samples
  `hue`; each move, for each family `i` with `w_i = max(0, 1 − circularDistance(hue, center_i) / 40) > 0`, sets the
  current component's value to `clamp(start_i + delta * w_i, −100, 100)` (unrounded), `delta` as in section 10.
- Rendering: the eight families come from the measured tables (luminance, then saturation, then hue stages, −100…100
  by 50); point colors from the formula (`point_weight` with HSL saturation and lightness; hue shift 30° per unit,
  saturation `× (1 + shift·w)`, lightness `+ shift·w·0.25`).

---

## 12. Detail

`UI/CameraRawDetailOpticsControls.swift:4-84`; model `Document/CameraRawDetailOptics.swift:4-39`. Rows: label
minWidth 96 with scrub (1/pt, no label reset), slider (rounded to whole numbers), 56 pt right-aligned field;
sub-headings "Sharpening" and "Noise Reduction" (`.subheadline`).

| Item | Range · default | Help (verbatim) |
|---|---|---|
| **"Sharpening Amount"** ("Amount") | 0…150 · 0 | "Controls how strong the sharpening is." |
| **"Sharpening Radius"** ("Radius") | 0…100 · 10 | "How far from each edge the sharpening reaches, in pixels." |
| **"Sharpening Detail"** ("Detail") | 0…100 · 25 | "Emphasizes fine texture over broader edges." |
| **"Sharpening Masking"** ("Masking") | 0…100 · 0 | "Limits sharpening to stronger edges. Hold Option to see the mask." |
| **"Noise Reduction Luminance"** ("Luminance") | 0…100 · 0 | "Smooths grain and noise in brightness." |
| **"Luminance Detail"** | 0…100 · 50 | "Preserves fine texture while luminance noise is reduced." |
| **"Luminance Contrast"** | 0…100 · 0 | "Keeps local contrast after luminance smoothing." |
| **"Noise Reduction Color"** ("Color") | 0…100 · 0 | "Smooths colored speckles." |
| **"Color Detail"** | 0…100 · 50 | "Preserves colored edges while color noise is reduced." |
| **"Color Smoothness"** | 0…100 · 50 | "Makes the color smoothing softer or tighter." |

- Luminance Detail and Luminance Contrast are at 45% opacity and disabled while `noiseLuminance <= 0`; Color Detail and
  Color Smoothness while `noiseColor <= 0`.
- Masking ⌥ view: a Masking slider change with ⌥ held sets `cameraRawSharpenMask = true`; any other Detail change,
  scrub, field or reset sets it false; releasing ⌥ clears it. The preview then shows
  `adjust_camera_raw_sharpen_mask_overlay` (grayscale: white where sharpening lands, black where masking protects)
  instead of Detail/Optics, after the color grade.

---

## 13. Optics

`UI/CameraRawDetailOpticsControls.swift:86-189`; model `Document/CameraRawDetailOptics.swift:43-96`.

- **"Remove Chromatic Aberration"**: checkbox, default off. Help "Pulls red and blue fringes apart toward the center to
  reduce color edging."
- **"Enable Lens Profile Corrections"**: checkbox, default off. Help "Applies generic profile strength when camera
  metadata is not available." While on: caption (secondary) "No lens metadata on this layer. Profile sliders set
  generic correction strength." and the two profile sliders below.
- **"Profile Distortion"** (row "Distortion"): 0…100 · 100, rounded. Help "How much of the profile distortion
  correction is applied."
- **"Profile Vignetting"** (row "Vignetting"): 0…100 · 100, rounded. Help "How much of the profile vignetting
  correction is applied."
- Sub-heading "Manual".
- **"Manual Distortion"** (row "Distortion"): −100…100 · 0, **unrounded**, same sign as the Lens Correction filter
  (positive straightens barrel). Help "Straightens barrel or pincushion bending." Render:
  `distortionK = distortion/100 * 0.35 + (profile ? profileDistortion/100 * 0.35 : 0)`.
- **"Defringe eyedropper"**: row `Text("Defringe")` (minWidth 96) + borderless `eyedropper` (accent while armed),
  help on both "Click a purple or green fringe to set its hue range."; toggles `samplesDefringe`; caption while armed
  "Click the fringe on the layer. Click the eyedropper again to stop." A canvas click
  (`sampleCameraRawDefringe`, `Document/CameraRaw.swift:442-474`) reads the **original** layer pixel, computes its
  HSV hue in degrees (0 for gray); if `|hue − 290| < |hue − 90|` it sets purple low/high to `hue ∓ 25` and Purple
  Amount to 50 if it was 0, else the same for green; then normalizes (clamps to 0…360, swaps if crossed).
- **"Purple Amount"**: 0…100 · 0. Help "Weakens purple fringes inside the purple hue range."
- **"Purple Hue range"**: caption "Purple Hue" (secondary, help "Hue range where purple defringe runs.") over a row
  `"Low" [slider] "High" [slider]` (caption2 labels), both 0…360, rounded, plain track, defaults 270 / 310 (knob
  double-click), no field, indented 106 pt (`labelWidth + 10`). Low help "Start of the hue range, in degrees.", High
  help "End of the hue range, in degrees." Normalization swaps them when Low > High.
- **"Green Amount"**: 0…100 · 0. Help "Weakens green fringes inside the green hue range."
- **"Green Hue range"**: caption "Green Hue" (help "Hue range where green defringe runs."), defaults 60 / 120.
- **"Lens Vignetting"** (row "Vignetting"): −100…100 · 0, **unrounded**. Help "Brightens or darkens the corners to
  counter lens falloff."
- **"Vignetting Midpoint"** (row "Midpoint"): 0…100 · 50, rounded. Help "Moves the vignette correction inward or
  outward."
- Optics rows: label minWidth 96 with scrub, slider, 56 pt field with `fractionLength(0)` (an unrounded value shows
  rounded).

---

## 14. Geometry

`UI/CameraRawGeometryCalibrationControls.swift:4-88`; model `Document/CameraRawGeometryCalibration.swift:4-173`.

- Sub-heading "Upright".
- **"Upright"**: segmented, labels hidden: "Off" (default) / "Guided". Help "Off leaves the picture as it is. Guided
  straightens from lines you draw on the picture." Choosing Off also disarms Draw Guides.
- **"Draw Guides"** (Guided only): button `Label("Draw Guides", systemImage: "line.diagonal")`, accent tint while
  armed; help "Draw two or more lines on the preview that should be level or vertical."; toggles
  `drawingCameraRawGeometryGuide`; caption while armed "Drag on the layer to place a guide. Draw at least two lines."
  On the canvas (`Document/CameraRaw.swift:558-587`): the press starts a draft only when it lands inside the layer's
  pixel grid; the point is normalized `n = (pixel.x / width, pixel.y / height)` with
  `pixel = point · previewMapping⁻¹` (layer pixels, **top-left origin**, despite the struct comment "from the
  lower-left"). Drags update the end, ignoring points outside the grid (the end stays at the last inside point).
  Mouse-up appends `{startX, startY, endX, endY}` and sets Upright to Guided, even for a zero-length line (which
  normalization then drops). **Upstream draws neither the draft nor the stored guides on the canvas** (only
  `Document/CameraRaw.swift` and `EditorCanvas`'s mouse handlers reference them).
  Corrections (`guidedCorrections`, `:112-132`): first guide `angle = atan2(dy, dx)` in normalized units;
  `rotate = −angle`, wrapped by ±90 into −45…45. A second guide with length > 1e-4 adds a fixed ±25: vertical when
  `|a2| > 45°` (sign of `a2`), else horizontal (sign of `a2`). Further guides are ignored. These add to the sliders
  (the sum is not re-clamped).
- **"Clear Guides"**: push button (Guided only, shown when any guide exists), help "Remove every guide line.";
  empties `guides` (Upright stays Guided, drawing stays armed).
- **"Projection"**: pop-up titled "Projection": "Perspective" (default) / "Rectilinear". Help "Perspective allows
  stronger keystone. Rectilinear keeps the warp gentler." Strength 1.0 / 0.55 on Vertical and Horizontal.
- Sliders (label minWidth 96 with scrub, rounded to whole numbers, 56 pt field, knob double-click → 0):

| Item | Range · default | Help (verbatim) | Effect on the four output corners (`outputCorners`, `:135-172`) |
|---|---|---|---|
| **"Vertical"** | −100…100 · 0 | "Straightens vertical lines toward the center." | top corners move out by `v = vertical/100 * width * 0.18 * strength` |
| **"Horizontal"** | −100…100 · 0 | "Straightens horizontal lines toward the center." | bottom corners move out by `hz = horizontal/100 * height * 0.18 * strength` (the layer's **height**) |
| **"Rotate"** | −45…45 · 0 | "Rotates the picture around its center." | rotation by `rotate` degrees about the (shifted) center |
| **"Aspect"** | −100…100 · 0 | "Stretches width relative to height." | x × `1 + aspect/200`, y ÷ the same |
| **"Scale"** | −100…100 · 0 | "Zooms the transformed picture within the frame." | zoom `1 + scale/100` |
| **"Offset X"** | −100…100 · 0 | "Moves the picture left or right." | shift `offsetX/100 * w * 0.15` |
| **"Offset Y"** | −100…100 · 0 | "Moves the picture up or down." | shift `offsetY/100 * h * 0.15` |

- **"Constrain Crop"**: checkbox, default off. Help "Crops empty edges after the transform and fits the result back
  into the frame." After the warp, crops to the alpha bounds and scales that crop to fit the layer frame, centered.
- Output size always equals the input size.

---

## 15. Calibration

`UI/CameraRawGeometryCalibrationControls.swift:90-147`; model `Document/CameraRawGeometryCalibration.swift:175-254`.

- **"Process"**: pop-up titled "Process": "Version 1" … "Version 6" (default Version 6). Help "Chooses how strongly the
  calibration sliders below are applied. Version 6 is the current default." Under it a caption (secondary, also its
  own help) with the summary:
  - Version 1: "Earliest response. Hue, saturation, and shadow tint move about half as far as Version 6."
  - Version 2: "A little stronger than Version 1. The sliders below still fall well short of the current look."
  - Version 3: "Firmer color than Version 2. Primary shifts stay gentler than the current process."
  - Version 4: "The 2012 response. Calibration reaches most of the strength used by Version 6."
  - Version 5: "Close to the current process, with slightly softer primary and shadow shifts."
  - Version 6: "Current default. The calibration sliders below apply at full strength."
  In code Process only scales **Shadows Tint** (0.55, 0.65, 0.75, 0.85, 0.92, 1.0 for versions 1-6); the primaries
  always come from the measured tables at full strength (`Rendering/AdjustPixels.c:1534-1536`,
  `Document/CameraRawGeometryCalibration.swift:245-253`).
- Sub-headings "Shadows", "Red Primary", "Green Primary", "Blue Primary"; rows: label minWidth 96 with scrub, slider
  −100…100 default 0 rounded, 56 pt field.
  - **"Shadows Tint"** ("Tint"): "Adds green or magenta to the darkest tones." Render: pixels with HSL lightness
    `< 0.35` get hue `+ tint/100 * scale * 0.06` turns (gray pixels have no hue, so they do not change).
  - **"Red Primary Hue"** ("Hue"): "Shifts how red is interpreted."
  - **"Red Primary Saturation"** ("Saturation"): "Strengthens or weakens the red primary."
  - **"Green Primary Hue"**: "Shifts how green is interpreted."
  - **"Green Primary Saturation"**: "Strengthens or weakens the green primary."
  - **"Blue Primary Hue"**: "Shifts how blue is interpreted."
  - **"Blue Primary Saturation"**: "Strengthens or weakens the blue primary."

---

## 16. Rendering (parity-critical behaviour)

- **"Pipeline order"**: section 1.2. The port does not reimplement any of it: every pixel comes from the engine
  running upstream's `CameraRawSettings.apply`, `CameraRawScope.preview` and `commitFilter`.
- **"Photoshop-measured lookup tables"**: `CameraRawTables.bin`: header "CRT3", u16 size (17), u16 count (763), u16
  step (3, **(measured)**), then xz (LZMA2) data that Python's `lzma` also decodes **(measured)** to 763 × 17³ × 3
  planes of running int8 differences from the identity lattice, ×step. Layout of the 763 tables
  (`Document/CameraRawTables.swift:14-28`): 0-80 White Balance 9×9 (Temperature rows, Tint columns, −100…100 by 25);
  81-101 Exposure −5…5 by 0.5; 102 Whites, 111 Blacks, 120 Saturation, 129 Vibrance (9 each, −100…100 by 25);
  138 Contrast and 187 Highlights (7 brightnesses {53, 80, 104, 130, 160, 190, 224} × 7 values
  {−100, −50, −25, 0, 25, 50, 100}); 236-284 Shadows (no longer read); 285 Mixer (luminance, saturation, hue × 8
  colors × 5 values); 405 Calibration (red hue, red sat, green hue, green sat, blue hue, blue sat × 5); 435 parametric
  (shadows, darks, lights, highlights × 5); 455 Grading wheels; 743 Grading luminance (shadows, midtones, highlights,
  global × 5). `CameraRawShadows.bin`: "CRS2", 2 sets × 5 amounts {−100, −50, 25, 50, 100} × 35 x × 6 K × 3 terms,
  `normalFrom` 1020 **(measured)**. Both files ship in `engine/bin` (`engine/build.sh:66-67`); without them
  `CameraRawTables.tables` is nil and every table stage silently does nothing.
- **"Identity passthrough"**: at defaults with no overlay, `apply` returns the **same `CGImage`**; the preview equals the
  layer and OK closes like Cancel. Invalid values cannot reach rendering because `normalized` replaces non-finite
  values with defaults and clamps everything (the `isValid` throw is defensive).
- Preview and OK agree byte for byte for an 8-bit layer (same code, same seed, GPU repaired to CPU), with one
  exception: with Geometry active **and** Contrast or Highlights non-zero, the preview's adaptive brightness is measured
  on the unwarped source while OK measures the warped pixels (section 22, Q9).

---

## 17. JSON ↔ CameraRawSettings mapping

`CameraRawSettings` and its nested structs are not `Codable`; the engine needs an explicit mapping
(`engine/Sources/CameraRawJSON.swift`, section 20). The JSON uses **the Swift property names** and **the enum raw
values** (the strings shown in the UI). The same shape is used in both directions.

### 17.1 Decoding rules (engine and board alike)

1. Start from `CameraRawSettings()`; a missing key keeps its default, so `{}` is identity and partial objects are fine.
2. Numbers must be JSON numbers (reject booleans: `JSONSerialization` bridges both to `NSNumber`; test with
   `CFGetTypeID(value) == CFBooleanGetTypeID()`); booleans must be JSON booleans; enums must be one of the listed
   strings. A wrong type or an unknown enum string is an error `"bad camera raw setting <path>"`.
3. Arrays of eight (`mixer.hue`, `.saturation`, `.luminance`) must have exactly 8 numbers (upstream indexes them
   0…7 and the kernels read 24 floats; a short array would crash).
4. Unknown keys are ignored (forward compatibility).
5. Then apply `normalized` (upstream's own; the engine calls `updateFilter`, which does it). The board runs the same
   normalization in JS (section 19.3) so its displayed state equals the engine's.

### 17.2 Field table

Top level (`Document/CameraRaw.swift:52-95, 127-162`):

| JSON key | Type | Range (clamp) | Default / identity | Notes |
|---|---|---|---|---|
| `whiteBalance` | string | "Custom" \| "Auto" | "Custom" | mode only; does not affect identity |
| `temperature` | number | −100…100 | 0 | |
| `tint` | number | −100…100 | 0 | |
| `exposure` | number | −5…5 | 0 | stops |
| `contrast` | number | −100…100 | 0 | |
| `highlights` | number | −100…100 | 0 | |
| `shadows` | number | −100…100 | 0 | |
| `whites` | number | −100…100 | 0 | |
| `blacks` | number | −100…100 | 0 | |
| `vibrance` | number | −100…100 | 0 | |
| `saturation` | number | −100…100 | 0 | |
| `texture` | number | −100…100 | 0 | |
| `clarity` | number | −100…100 | 0 | |
| `dehaze` | number | −100…100 | 0 | |
| `glow` | number | 0…100 | 0 | |
| `glowStyle` | string | "Diffusion" \| "Bloom" \| "Halation" | "Diffusion" | |
| `glowRange` | number | −100…100 | 0 | |
| `glowSpread` | number | −100…100 | 0 | |
| `glowWarmth` | number | −100…100 | 0 | |
| `vignetteAmount` | number | −100…100 | 0 | |
| `vignetteStyle` | string | "Highlight Priority" \| "Color Priority" \| "Paint Overlay" | "Highlight Priority" | |
| `vignetteMidpoint` | number | 0…100 | 50 | |
| `vignetteRoundness` | number | −100…100 | 0 | |
| `vignetteFeather` | number | 0…100 | 50 | |
| `vignetteHighlights` | number | 0…100 | 0 | |
| `grainAmount` | number | 0…100 | 0 | |
| `grainSize` | number | 0…100 | 25 | |
| `grainRoughness` | number | 0…100 | 50 | |
| `curve` | object | | | 17.2.1 |
| `mixer` | object | | | 17.2.2 |
| `grading` | object | | | 17.2.3 |
| `detail` | object | | | 17.2.4 |
| `optics` | object | | | 17.2.5 |
| `geometry` | object | | | 17.2.6 |
| `calibration` | object | | | 17.2.7 |

Clamping is `isFinite ? min(hi, max(lo, v)) : default` (`ImageAdjustmentPixels.clamp`,
`Document/ImageAdjustments.swift:14-16`).

#### 17.2.1 `curve` (`Document/CameraRawColor.swift:19-155`)

| Key | Type | Range | Default |
|---|---|---|---|
| `shadows`, `darks`, `lights`, `highlights` | number | −100…100 | 0 |
| `shadowSplit` | number | 5…90 | 25 |
| `darkSplit` | number | `shadowSplit + 2`…95 (after `shadowSplit` is clamped) | 50 |
| `lightSplit` | number | `darkSplit + 2`…98 | 75 |
| `rgb`, `red`, `green`, `blue` | array of `{"x": number, "y": number}` (0…1) | repaired (17.3) | `[{"x":0,"y":0},{"x":1,"y":1}]` |
| `refineSaturation` | number | −100…100 | 0 |

#### 17.2.2 `mixer` (`:157-228`)

| Key | Type | Range | Default |
|---|---|---|---|
| `hue`, `saturation`, `luminance` | array of exactly 8 numbers, order Reds, Oranges, Yellows, Greens, Aquas, Blues, Purples, Magentas | −100…100 each | eight 0 |
| `points` | array of point colors | first 8 kept | `[]` |

Point color:

| Key | Type | Range | Default |
|---|---|---|---|
| `hue` | number | 0…360 | 0 |
| `saturation` | number | 0…1 | 0 |
| `luminance` | number | 0…1 | 0 |
| `hueShift`, `saturationShift`, `luminanceShift` | number | −100…100 | 0 |
| `hueRange` | number | 5…180 | 30 |
| `saturationRange` | number | 0.05…1 | 0.4 |
| `luminanceRange` | number | 0.05…1 | 0.4 |
| `visualize` | boolean | | false |

#### 17.2.3 `grading` (`:231-269`)

| Key | Type | Range | Default |
|---|---|---|---|
| `shadows`, `midtones`, `highlights`, `global` | `{"hue", "saturation", "luminance"}` | hue 0…360, saturation 0…100, luminance −100…100 | 0, 0, 0 |
| `blending` | number | 0…100 | 50 |
| `balance` | number | −100…100 | 0 |

#### 17.2.4 `detail` (`Document/CameraRawDetailOptics.swift:4-36`)

| Key | Range | Default |
|---|---|---|
| `sharpenAmount` | 0…150 | 0 |
| `sharpenRadius` | 0…100 | 10 |
| `sharpenDetail` | 0…100 | 25 |
| `sharpenMasking` | 0…100 | 0 |
| `noiseLuminance` | 0…100 | 0 |
| `noiseLuminanceDetail` | 0…100 | 50 |
| `noiseLuminanceContrast` | 0…100 | 0 |
| `noiseColor` | 0…100 | 0 |
| `noiseColorDetail` | 0…100 | 50 |
| `noiseColorSmoothness` | 0…100 | 50 |

#### 17.2.5 `optics` (`:43-86`)

| Key | Type | Range | Default |
|---|---|---|---|
| `removeChromaticAberration` | boolean | | false |
| `enableLensProfile` | boolean | | false |
| `profileDistortion` | number | 0…100 | 100 |
| `profileVignetting` | number | 0…100 | 100 |
| `distortion` | number | −100…100 | 0 |
| `purpleAmount` | number | 0…100 | 0 |
| `purpleHueLow`, `purpleHueHigh` | number | 0…360, swapped when low > high | 270, 310 |
| `greenAmount` | number | 0…100 | 0 |
| `greenHueLow`, `greenHueHigh` | number | 0…360, swapped when low > high | 60, 120 |
| `vignetteAmount` | number | −100…100 | 0 |
| `vignetteMidpoint` | number | 0…100 | 50 |

#### 17.2.6 `geometry` (`Document/CameraRawGeometryCalibration.swift:25-64`)

| Key | Type | Range | Default |
|---|---|---|---|
| `upright` | string | "Off" \| "Guided" | "Off" |
| `projection` | string | "Perspective" \| "Rectilinear" | "Perspective" |
| `vertical`, `horizontal`, `aspect`, `scale`, `offsetX`, `offsetY` | number | −100…100 | 0 |
| `rotate` | number | −45…45 | 0 |
| `constrainCrop` | boolean | | false |
| `guides` | array of `{"startX","startY","endX","endY"}` (numbers, normalized, top-left origin) | kept only when `hypot(endX − startX, endY − startY) > 0.01`; coordinates not clamped | `[]` |

(`CameraRawGeometryGuide` is already `Codable` with exactly these keys.)

#### 17.2.7 `calibration` (`:212-242`)

| Key | Type | Range | Default |
|---|---|---|---|
| `process` | string | "Version 1" … "Version 6" | "Version 6" |
| `shadowTint`, `redHue`, `redSaturation`, `greenHue`, `greenSaturation`, `blueHue`, `blueSaturation` | number | −100…100 | 0 |

### 17.3 Curve point repair (`repair`, `Document/CameraRawColor.swift:141-154`)

1. Drop points with a non-finite coordinate; sort by x.
2. Fewer than 2 left → linear `[(0,0),(1,1)]`.
3. First point becomes `(0, clamp(y))`, last `(1, clamp(y))`.
4. For each inner point in order: `x = clamp(x, 0.01, 0.99)`; keep it only if `x > lastKept.x + 0.01` (strict), with
   `y` clamped to 0…1.
5. Append the last point `(1, y)`.

### 17.4 Identity object and an edited example

`cameraRawJSON(CameraRawSettings())`, which the engine returns for defaults:

```json
{
  "whiteBalance": "Custom", "temperature": 0, "tint": 0, "exposure": 0, "contrast": 0, "highlights": 0,
  "shadows": 0, "whites": 0, "blacks": 0, "vibrance": 0, "saturation": 0, "texture": 0, "clarity": 0, "dehaze": 0,
  "glow": 0, "glowStyle": "Diffusion", "glowRange": 0, "glowSpread": 0, "glowWarmth": 0,
  "vignetteAmount": 0, "vignetteStyle": "Highlight Priority", "vignetteMidpoint": 50, "vignetteRoundness": 0,
  "vignetteFeather": 50, "vignetteHighlights": 0, "grainAmount": 0, "grainSize": 25, "grainRoughness": 50,
  "curve": {"shadows": 0, "darks": 0, "lights": 0, "highlights": 0, "shadowSplit": 25, "darkSplit": 50,
            "lightSplit": 75, "rgb": [{"x": 0, "y": 0}, {"x": 1, "y": 1}], "red": [{"x": 0, "y": 0}, {"x": 1, "y": 1}],
            "green": [{"x": 0, "y": 0}, {"x": 1, "y": 1}], "blue": [{"x": 0, "y": 0}, {"x": 1, "y": 1}],
            "refineSaturation": 0},
  "mixer": {"hue": [0,0,0,0,0,0,0,0], "saturation": [0,0,0,0,0,0,0,0], "luminance": [0,0,0,0,0,0,0,0], "points": []},
  "grading": {"shadows": {"hue": 0, "saturation": 0, "luminance": 0}, "midtones": {"hue": 0, "saturation": 0, "luminance": 0},
              "highlights": {"hue": 0, "saturation": 0, "luminance": 0}, "global": {"hue": 0, "saturation": 0, "luminance": 0},
              "blending": 50, "balance": 0},
  "detail": {"sharpenAmount": 0, "sharpenRadius": 10, "sharpenDetail": 25, "sharpenMasking": 0, "noiseLuminance": 0,
             "noiseLuminanceDetail": 50, "noiseLuminanceContrast": 0, "noiseColor": 0, "noiseColorDetail": 50,
             "noiseColorSmoothness": 50},
  "optics": {"removeChromaticAberration": false, "enableLensProfile": false, "profileDistortion": 100,
             "profileVignetting": 100, "distortion": 0, "purpleAmount": 0, "purpleHueLow": 270, "purpleHueHigh": 310,
             "greenAmount": 0, "greenHueLow": 60, "greenHueHigh": 120, "vignetteAmount": 0, "vignetteMidpoint": 50},
  "geometry": {"upright": "Off", "projection": "Perspective", "vertical": 0, "horizontal": 0, "rotate": 0, "aspect": 0,
               "scale": 0, "offsetX": 0, "offsetY": 0, "constrainCrop": false, "guides": []},
  "calibration": {"process": "Version 6", "shadowTint": 0, "redHue": 0, "redSaturation": 0, "greenHue": 0,
                  "greenSaturation": 0, "blueHue": 0, "blueSaturation": 0}
}
```

Example partial input `{"exposure": 0.5, "curve": {"darks": -20, "rgb": [{"x":0,"y":0},{"x":0.5,"y":0.6},{"x":1,"y":1}]},
"mixer": {"saturation": [0,-60,0,0,0,0,0,0]}, "geometry": {"upright": "Guided", "guides": [{"startX":0.1,"startY":0.15,
"endX":0.9,"endY":0.8}]}}` decodes to defaults plus those values; it adjusts Light, Curve, Color Mixer and Geometry.

---

## 18. Engine protocol: a live Camera Raw session

### 18.1 Why a session

Each stateless engine request reloads the whole project and rebuilds `EditorSession` and `FilterEdit` (10-40 ms on a
512² sample **(measured)**, much more for large multi-layer projects), re-measures the adaptive brightness of the full
layer, re-warms Metal, and returns a PNG (230-240 ms just to encode 12 MP **(measured)**). Upstream's responsiveness
rests on state that lives as long as the panel: the `FilterEdit` (native-resolution source, `previewBrightness` cache,
`seed`, `preparedPreview`, `MetalCameraRawLookup` buffers) and the single-flight/latest-wins render queue. The port
keeps exactly that state alive **inside compositor-engine**, keyed by a session id, and moves the latest-wins queue to
the board (the engine's stdin loop is strictly serial: `EngineMain.swift:21-28` awaits each request before reading
the next, so coalescing must happen before a request is sent).

### 18.2 Lifecycle

```
board                                  extension host                         compositor-engine
  | open (not stateless: flush first)  |                                        |
  |----------------------------------->| flush; record manifestHash H0          |
  |                                    |--- filter.session.open --------------->| load project, beginFilter(.cameraRaw),
  |                                    |                                        | wait for the first preview, keep session S
  |<------------------- {session S, settings, size, transform, tile, scope} ----|
  | update (stateless), one in flight  |--- filter.session.update ------------->| set flags/settings, updateFilter,
  |<------------------- {serial, settings, patch, tile, scope, error} ----------| await preview, write tile
  | sample (stateless)                 |--- filter.session.sample ------------->| read preview pixel
  | fetch (stateless)                  |--- filter.session.fetch -------------->| tile of the last preview, no render
  | commit (stateless, H0 check)       | disk hash != H0 → {error, stale}       |
  |                                    |--- filter.session.commit ------------->| set settings/eyes, commitFilter, save
  |<------------------- {saved, editName, rendered, lastFilter} ----------------| session S removed
  | close (Cancel, stateless)          |--- filter.session.close -------------->| cancelFilter, session S removed
```

- **One session per board** at a time (Camera Raw is modal in upstream). The engine may hold several (one per open
  board) in a dictionary.
- **All ops after `open` are `stateless: true`** in `runEngine` (no flush: nothing on the board can change while the
  panel is open, section 2.1). `commit` is preceded by the extension's stale check (18.7).
- The extension tracks open sessions per document and sends `filter.session.close` when the webview is disposed or the
  board reloads; `EngineClient.armIdle` must not stop the engine while any session is open (today it stops after 5 min
  without requests, `vscode-extension/core/engine-client.js:76-83`).
- Every op that names a session answers `{"error": "unknown session", "unknownSession": true}` when the engine does
  not have it (engine restarted, crashed, or closed it). The board then re-opens with its current state and repeats the
  op (18.8).

### 18.3 Requests and answers

Common: images travel as files named by the extension (`files: { out: 'rgba' }`, a new extension for
`EngineClient.tempFile`), read back and posted to the webview as bytes, as today.

**`filter.session.open`** (not stateless)

```json
{ "project": "...", "activeLayerID": "UUID", "selection": <selection JSON or null>,
  "foreground": [r,g,b], "background": [r,g,b],
  "settings": <CameraRawSettings JSON or null>,          // the board's remembered settings; null = defaults
  "eyes": {"light": true, "color": true, "colorGrading": true, "effects": true, "curve": true,
           "colorMixer": true, "detail": true, "optics": true, "geometry": true, "calibration": true},
  "view": {"x": 0, "y": 0, "width": 4000, "height": 3000, "scale": 0.25},
  "out": "<tmp>.rgba" }
```

Engine: `session(args)` + `configure` (as `filterPreview` does), then
`session.filterSettings.cameraRaw = decoded` (when given), `session.beginFilter(.cameraRaw)`. If `filterEdit` is nil:
`{"error": session.brushError ?? "Camera Raw Filter can't be applied to this layer."}` and no session. Else apply the
eyes, wait for the preview chain (`while let task = edit.previewTask { await task.value }`), register
`S = UUID().uuidString`, and answer like `update` plus `session`, `layerID`, `size: [w, h]` (the preview grid = the
layer's pixel size), `transform` (`edit.preparedTransform ?? edit.transform`, as `filterPreview` encodes it) and
`limitedToSelection: selection != nil`.

**`filter.session.update`** (stateless)

```json
{ "session": "S", "serial": 17,
  "settings": <full CameraRawSettings JSON>,               // the board's current state; the board is the source of truth
  "eyes": { ...ten booleans... },
  "preview": true,
  "overlay": {"clipping": null | "highlights" | "shadows", "sharpenMask": false,
              "shadowClipping": false, "highlightClipping": false, "pointIndex": 0},
  "action": null
          | {"kind": "whiteBalance", "point": [docX, docY]}
          | {"kind": "autoWhiteBalance"}
          | {"kind": "defringe", "point": [docX, docY]}
          | {"kind": "pointColor", "point": [docX, docY]},
  "view": {"x": ..., "y": ..., "width": ..., "height": ..., "scale": ...},
  "out": "<tmp>.rgba" }
```

Engine, in order:
1. Look up `S`. Set `edit.preview = preview` (the actions' own `updateFilter` calls read it), `edit.showsCameraRaw…` from `eyes`, `edit.cameraRawClipping` (`highlights` = 1, `shadows` = 2),
   `edit.cameraRawSharpenMask`, `edit.showsShadowClipping`, `edit.showsHighlightClipping`,
   `edit.cameraRawPointIndex = pointIndex`.
2. `var settings = edit.settings; settings.cameraRaw = try cameraRawSettings(from: args["settings"])`;
   `edit.settings = settings.normalized` (no render yet).
3. If `action`: arm the matching flag (`samplesWhiteBalance`, `samplesDefringe`, `samplesPointColor`), call the
   upstream function with the document point (`sampleCameraRawWhiteBalance(at:)`, `sampleCameraRawDefringe(at:)`,
   `sampleCameraRawPointColor(at:)`) or, for `autoWhiteBalance`, run the body of
   `applyCameraRawAutoWhiteBalance()` and **await** the average (the engine is serial anyway); restore the flag. These
   call `updateFilter` themselves. Compute `patch` = the fields the action changed (17.2 paths) and
   `pointIndex` after the action.
4. If no render was started (no action, or the action returned early on a clear or outside pixel, i.e.
   `edit.previewTask == nil`): `session.updateFilter(edit.settings, preview: preview)`.
5. Await the preview chain. Write the tile (18.5) from `edit.preparedPreview` when `preview` is true.
6. Answer:

```json
{ "serial": 17,
  "settings": <normalized JSON actually rendered>,
  "patch": null | {"temperature": -19, "tint": -6, "whiteBalance": "Custom"},   // only for actions
  "pointIndex": 0,
  "solved": null | {"temperature": .., "tint": ..},       // autoWhiteBalance only (null when no opaque pixels)
  "rendered": true,                                        // false when preview is off (no tile, no scope)
  "tile": {"x": 0, "y": 0, "width": 4000, "height": 3000, "pixelWidth": 1000, "pixelHeight": 750} | null,
  "scope": {"red": [256], "green": [256], "blue": [256], "vectorscope": [4096],
            "peak": <shared histogram peak>, "vectorPeak": <max of vectorscope>} | null,
  "error": null | "<edit.previewError>",
  "ms": {"render": 41, "tile": 6} }
```

Scope values are the doubles of `CameraRawScope` rounded to 4 decimals (they are `alpha/255`-weighted counts);
`peak` is `CameraRawScope.peak` (upstream's `LevelsHistogramDisplay.scale` rule), so the board does not re-implement
it. About 45 KB of JSON per answer; acceptable at drag rates.

**`filter.session.sample`** (stateless): `{"session", "point": [docX, docY]}` →
`{"readout": [r, g, b] | null, "sample": {"tone", "hue", "saturation", "luminance"} | null}` from
`updateCameraRawReadout(at:)` and the body of `cameraRawSample(at:)` (`Document/CameraRaw.swift:490-507, 589-617`;
`cameraRawSample` is private, so the engine reimplements its 20 lines verbatim or calls `beginCameraRawDrag` and reads
`edit.cameraRawDrag`). No render.

**`filter.session.fetch`** (stateless): `{"session", "view", "out"}` → `{"serial", "tile"}` from the current
`preparedPreview` (no render). Used after pan/zoom.

**`filter.session.commit`** (stateless, after the extension's stale check):
`{"session", "settings", "eyes"}`. Engine: set `edit.settings` (normalized) and the eyes, clear every overlay flag,
`let before = session.document`, `await session.commitFilter()`; if `session.document != before`, save the package
(`save(session, to: url)`); answer
`{"saved": Bool, "editName": "Camera Raw Filter" (when saved), "rendered": <JSON of the rendered settings, i.e.
session.filterSettings.cameraRaw>, "lastFilter": "Camera Raw Filter" | null, "error": session.brushError}` and remove
the session. **No `selection` key** (so `board.selectionOp` leaves the board's selection alone). `rendered` is
returned even for the identity case (no save), because upstream remembers it then too.

**`filter.session.close`** (stateless): `{"session"}` → `session.cancelFilter()` (discards Metal buffers), remove;
`{"closed": true}`. Idempotent.

### 18.4 The board's request pump (latest wins, never cancel)

State: `inFlight` (at most one session request), `dirty` (local settings, eyes, preview or overlay changed since the
last `update` was sent), `actions` (FIFO of eyedropper clicks), `viewDirty`, `readoutAt` (latest pointer document
point or null), `dragSample` (a pending targeted-adjustment press).

```
pump():
  if inFlight or state != 'open': return
  if dragSample:            send sample(dragSample.point) → on answer: start the targeted drag (section 19.4); pump()
  elif actions or dirty:    send update(current local state, action = actions.shift() or null); dirty = false
  elif viewDirty:           send fetch(currentView); viewDirty = false
  elif readoutAt != sent:   send sample(readoutAt) → set readout; pump()
on update answer:
  if session changed or answer.serial != lastSentSerial: drop
  merge answer.patch into local settings (autoWhiteBalance: only if local whiteBalance is still "Auto")
  if answer.pointIndex differs: local pointIndex = answer.pointIndex
  draw tile; set scope; show error; pump()
```

This reproduces `renderFilterPreview`'s semantics: a change during a render waits, intermediate states are skipped,
the newest state is rendered next, and the previous preview stays on screen meanwhile. Because every `update` carries
the **full** current state (not deltas), skipping intermediate ones is always correct, and targeted drags compute
from the settings captured at the press (upstream does the same), so dropping intermediate pointer positions is
lossless.

### 18.5 Preview transport: view tiles

The engine always renders the full-resolution preview (upstream's job). Only the visible part crosses the process
boundary, at display resolution:

- Board → `view`: the part of the layer's pixel grid that is on screen. Map the viewport's document rectangle through
  `pixelToDocument⁻¹` of the layer (`Transform.pixelToDocument(transform, w, h)`, `media/render.js`), take the
  bounding box, expand by 32 px, intersect with `[0, w] × [0, h]`, round outward. `scale = min(1, zoom ×
  devicePixelRatio × max(|∂doc/∂pixel|))` (document pixels per layer pixel from the layer transform).
- Engine: crop `preparedPreview` to the rect; if `scale < 1`, draw it into a `ceil(width × scale) × ceil(height ×
  scale)` premultiplied sRGB context with `.high` interpolation (as `EngineOperations.scaled` does); unpremultiply each
  pixel with upstream's rounding `min(255, (c * 255 + a / 2) / a)` (0 when `a == 0`); write the raw bytes
  (`pixelWidth × pixelHeight × 4`, straight RGBA, row-major, top row first, no header) to `out`. A 4 MP view costs about
  10 ms; a 12 MP PNG would cost 230-240 ms **(measured)**.
- Board: keeps one **work canvas** per session, the layer's pixel size, initialized from the layer's current pixels.
  Each tile is put into an `ImageData`, then `drawImage(tile, 0, 0, pw, ph, x, y, width, height)` into the work canvas
  (`imageSmoothingQuality = 'high'`). The layer is drawn from the work canvas through the existing override mechanism:
  `board.renderer.overrides.set(layerID, {canvas: work, toDocument: Transform.pixelToDocument(t, w, h), transform: t})`
  (`media/render.js:104-125`, `media/filters.js:85-94`). Areas outside the last view keep older content until the next
  `fetch`.
- After pan or zoom (debounced 100 ms, only when idle), the board sets `viewDirty` → `fetch` for the new view.
- **Preview off**: `update` with `preview: false`: upstream drops `preparedPreview` and renders nothing
  (`Document/Filters.swift:781-784`); the board removes the override (the layer shows its own pixels), keeps the last
  scope, and the readout reads the original (the engine does this, since `preparedPreview` is nil).
- **Overlays** (clip indicators, ⌥ clipping view, sharpen mask, Visualize Range) are painted by the engine into the
  preview; the board draws nothing of its own for them. They disappear from the canvas on the next render without
  them and never reach the layer (commit clears every overlay flag).
- **Histogram**: drawn by the board from `scope` (section 19.2); never computed on the board.

### 18.6 Ordering with OK and Cancel

- **OK**: disable the panel and show "Applying…"; wait for `inFlight`; do not send the pending `update` (commit carries
  the latest state); send `commit`. The work-canvas override stays until the answer arrives. The extension's
  `runEngine` already pushes the saved change to the board (one undo step labelled `editName`) **before** replying
  (`vscode-extension/extension.js:265-268`), so removing the override after the answer never flashes the original
  (same as `media/filters.js:112-123`). Then: `remembered = answer.rendered`; if `answer.lastFilter`, record
  Last Filter; close the panel; toast `answer.error` if any (upstream closes the panel even when the render failed,
  because `commitFilter`'s `defer` clears `filterEdit`).
- **Cancel** (button, ⎋, panel close box): close the panel and remove the override immediately; send `close`
  (queued behind any in-flight request by the engine's serial loop; the late answer is dropped). Nothing remembered.
- While committing, Cancel is refused (as `media/filters.js:128-131`).

### 18.7 Staleness

At `open` the extension records the project's manifest hash `H0` (`document.knownHash` after the flush). Before
`commit` it re-reads the manifest hash from disk; if it differs, it answers
`{"error": "The project changed on disk while Camera Raw was open.", "stale": true}` without calling the engine. The
board then closes the session, reloads the project through its normal external-change path, re-opens Camera Raw with
the same settings, eyes and panel state if the layer still exists (otherwise cancels with a toast), and asks the user
to press OK again. When an external change reloads the board while the panel is open, the same re-open happens
immediately. (Upstream cannot hit this case: the panel blocks every edit, and external changes are deferred.)

### 18.8 Engine restarts

On `unknownSession` (or `compositor-engine stopped`): re-open with the current state (settings, eyes, view), then
repeat the op. The grain seed changes with the new `FilterEdit` (visible only with Grain > 0). If the engine dies
**during** `commit`, the board does not retry: it compares the disk hash with `H0` (changed → the result was saved;
reload) and reports the error.

---

## 19. Board UI plan

### 19.1 Files

| File | Contents |
|---|---|
| `media/camera-raw-model.js` | Pure functions, no DOM: defaults, `normalize`, `adjusts(group)`, `isIdentity`, `renderSettings(eyes)`, `resetting(group)`, curve spline, `parametric`, `channelTable`, `repair`, `nudged`, `region`, mixer `weights`, presets, track colors (HSB→sRGB), point-swatch colors. Unit-tested in Node against section 23 |
| `media/camera-raw-controls.js` | Components: `CRSlider`, `CRWheel`, `CRCurve`, `CRHistogram`, `CRSegmented`, `CRPopup`, `CRSection`, `CRSwatches` |
| `media/camera-raw.js` | `CameraRawPanel`: docked column, the ten sections, Preview/OK/Cancel, the request pump (18.4), work canvas and override, canvas tool routing (2.1), ⌥ tracking, remembered settings and Last Filter |
| `media/board.css` | Panel styles (dark, matching `ui.md` 1.3) |
| `media/menus.js` | Filter › "Camera Raw Filter…" and "Last Filter: Camera Raw Filter" (⌃⌘F conflicts with VS Code's full screen, `ui.md` 12.2: menu/palette only unless consumed) |

### 19.2 Components and their upstream counterparts

| Board component | Upstream | Spec |
|---|---|---|
| Docked column `div.cr-panel` (absolute, right 0, top 0, bottom 0, width 440 px, padding 24, title "Camera Raw Filter" with a close box) | `FloatingPanelController` docked `NSPanel` + `FilterSheet` | 2 |
| `CRHistogram` (`<canvas>` 110 px high, two triangle buttons, custom context menu with `preventDefault`, readout line) | `CameraRawControls.histogram`, `graph`, `ribbon`, `clipButton` | 3 |
| `CRSection` (chevron + title button, eye, reset) | `disclosure`, `eye`, `resetButton` | 4 |
| `CRSlider` (label with scrub and optional double-click reset; track; knob; optional field) | `CameraRawSlider` + `slider(...)` rows + `NumericScrub` | 5 |
| `CRWheel` (`<canvas>` 86×86, conic gradient, dot, readout, luminance `CRSlider` 96 px) | `GradeWheel` + `wheel(...)` | 8 |
| `CRCurve` (`<canvas>` 150 px high) | `CameraRawCurveControls.curveGraph` and drags | 10 |
| `CRSegmented` | `Picker(...).pickerStyle(.segmented)` | 10, 11, 14 |
| `CRPopup` (`<select>` styled as a macOS pop-up, optional leading title) | `Picker` default/menu style | 7, 8, 9, 10, 13, 14, 15 |
| `CRSwatches` | mixer family and point-color swatches | 11 |
| Checkbox | `Toggle` | 11, 13, 14 |
| Eyedropper / Targeted / Draw Guides toggle buttons | `Button` with accent tint while armed | 7, 10, 11, 13, 14 |

`CRSlider` behavior (section 5): knob 14 px round (board choice; upstream uses the system knob), track 4 px; gradient
tracks are a CSS `linear-gradient(to right, left, right)` across the full track; plain tracks fill with the accent
color from the left end to the knob. Pointer down on the knob (hit area +2 px): capture and drag (value from pointer x
relative to the grab offset). Pointer down elsewhere on the track: compute the target with the fraction formula of 5.1,
publish once, animate the knob in 180 ms ease-out, and **ignore moves until release**. `dblclick` on the knob: reset.
`title` = help on label, track and field; `aria-label` = help on the track. Field: `<input class="num">`, commit on
Enter/blur, display with up to `decimals` fraction digits without trailing zeros; invalid text reverts. Label scrub:
`pointerdown` + horizontal move ≥ 1 px, `cursor: ew-resize`, `value = clamp(start + dx × sensitivity)` unrounded.

`CRWheel` drawing: `ctx.createConicGradient(0, cx, cy)` with stops so that hue increases **counterclockwise** from
the +x axis (stop at clockwise angle θ gets hue `(360 − θ) mod 360`), at 85% opacity; ring white 80% 1 px; dot 10 px.

### 19.3 Model ports (exact)

- `normalize(s)`: section 17 (clamp rule, curve dividers in order, `repair`, eight-element arrays, `points.slice(0, 8)`,
  hue-range swap, guide filter). Run after every local change, before display and before sending.
- `adjusts(group)` / `isIdentity`: section 4 table.
- `renderSettings(eyes)`: `applying(...)` (`Document/CameraRaw.swift:165-199`): Light/Color zero their sliders (Color
  keeps the White Balance mode), Effects zeroes texture, clarity, dehaze, glow, vignetteAmount and grainAmount only
  (styles and shape sliders stay), the other seven groups become their struct defaults.
- `resetting(group)`: section 4 field lists.
- Curve: 10.1. Mixer weights: `max(0, 1 − d/40)` with `d = |deg − center|`, `360 − d` when `d > 180`.
- Normalized guide point: `p = docPoint · pixelToDocument⁻¹`, inside iff `0 ≤ p.x < w && 0 ≤ p.y < h`,
  `n = (p.x / w, p.y / h)`.

### 19.4 Canvas tools on the board

While the panel is open, the board's canvas pointer handler first applies section 2.1's order (each skipped with Space
held, which pans):

- Eyedroppers: push `{kind, point}` to `actions`; keep the armed state (they stay armed). Refocus the panel.
- Draw Guides: track the draft locally with the normalized-point rule (19.3); on release append the guide to local
  `geometry.guides`, set `upright = "Guided"`, normalize, `dirty = true`. Optionally draw the draft (section 22, Q2).
- Targeted adjustment: on press set `dragSample = {point, settingsAtPress}`; the pump sends `sample`; when it answers
  with a sample, store `{startY, settingsAtPress, tone, hue}`; on each move compute the settings exactly as
  `dragCameraRaw` (10, 11) from `settingsAtPress`, normalize, `dirty = true`. No sample → no drag.
- Pointer move without a drag: `readoutAt = point` (rAF-throttled); pointer leave: readout "R —   G —   B —".
- All other tools are inert; Hand, Zoom and Space-pan work; layer, selection and history commands are disabled.
- ⌥ tracking: read `altKey` on every pointer event and on `keydown`/`keyup` (`event.key === 'Alt'`); on ⌥ release clear
  `overlay.clipping` and `overlay.sharpenMask` and mark dirty (upstream's `flagsChanged` monitor). Reset on `blur`.

---

## 20. Engine API to add

### 20.1 New engine sources (no change to `upstream/`)

- `engine/Sources/CameraRawJSON.swift`:
  - `func cameraRawSettings(from json: Any?) throws -> CameraRawSettings` (17.1 rules; nested helpers for curve
    points, point colors, wheels, guides).
  - `func cameraRawJSON(_ settings: CameraRawSettings) -> [String: Any]` (every field, as 17.4).
  - `func scopeJSON(_ scope: CameraRawScope) -> [String: Any]` (with `peak`, `vectorPeak`).
- `engine/Sources/CameraRawOps.swift`:
  - `@MainActor enum FilterSessions { static var open: [String: FilterSessionState] = [:] }` with
    `final class FilterSessionState { let session: EditorSession; let url: URL; var serial = 0 }` (a static store, so
    `EngineOperations` needs no stored property).
  - `extension EngineOperations { func cameraRawOperation(_ op: String, _ args: [String: Any]) async throws -> Any? }`
    handling `filter.session.open`, `.update`, `.sample`, `.fetch`, `.commit`, `.close` (18.3).
  - `func writeRGBATile(_ image: CGImage, view: [String: Any], to path: String) throws -> [String: Any]` (18.5).
  - Eye mapping `eyes` keys → `FilterEdit.showsCameraRawLight/Color/Grading/Effects/Curve/Mixer/Detail/Optics/
    Geometry/Calibration`.
- `engine/Sources/EngineMain.swift`: one line in `run`'s default branch:
  `if let result = try await cameraRawOperation(op, args) { return result }`.
- `engine/Sources/FilterOps.swift`, `filter.apply`: when `kind == "Camera Raw Filter"`, decode `args["settings"]`
  into `session.filterSettings.cameraRaw`; when `args["repeating"] == true`, set `session.lastFilter = .cameraRaw` and
  `await session.repeatLastFilter()` (no preview), else the current begin/wait/commit path. Answer as today via
  `withSession` (`saved`, `editName`).

### 20.2 Extension and client

- `core/engine-client.js`: `tempFile('rgba')` already works for any extension; add `openSessions` (a counter or set)
  so `armIdle` never stops the engine while a session is open.
- `extension.js` `runEngine`: record `H0` on `filter.session.open`; stale check before `filter.session.commit`;
  track `{documentRoot → sessionID}` and send `filter.session.close` on webview dispose and before a board reload;
  pass `rgba` attachments as `Uint8Array` (unchanged mechanism).

### 20.3 Board

- New `media/camera-raw*.js` (19.1). `FilterPanel` stays for the simple filters; `filters.open('Camera Raw Filter')`
  routes to `CameraRawPanel`.
- Last Filter: `board.selectionOp('filter.apply', {kind: 'Camera Raw Filter', repeating: true, settings:
  remembered}, 'Camera Raw Filter')`.

---

## 21. Not applicable in VS Code / adaptations

| Upstream | Board | Why |
|---|---|---|
| Separate docked `NSPanel` window over the document window's right edge, re-docked on window move/resize | A full-height 440 px column inside the webview, over the right side of the board (Layers panel and part of the canvas); it follows the webview's size by CSS | No child windows in a webview |
| `hidesOnDeactivate` | Nothing | The webview is hidden by VS Code with its editor |
| `NSSlider` tracking, macOS 26 glide, `SliderSnap` swizzle | `CRSlider` imitation (5.1) | No AppKit |
| ⌥ via `NSEvent.modifierFlags` and a `flagsChanged` monitor | `altKey` on pointer events + Alt `keydown`/`keyup`; on Windows/Linux a lone Alt may focus VS Code's menu bar: `preventDefault` Alt keydown while the panel or canvas has focus | Platform keys |
| Control-click context menu | `contextmenu` event (right-click and ⌃-click) with `preventDefault` (else VS Code shows its own menu, `ui.md` 12.1) | Webview |
| SF Symbols `eye`, `eye.slash`, `arrow.counterclockwise`, `chevron.down/right`, `eyedropper`, `scope`, `line.diagonal`, `triangle.fill` | codicons `eye`, `eye-closed`, `discard`, `chevron-down/right`, `target` for scope; inline SVG for eyedropper, diagonal line and triangle | Icon set |
| `.help` tooltips, accessibility labels | `title` and `aria-label`, verbatim text | |
| `NSSound.beep()` | The board's existing beep equivalent (toast or nothing) | |
| `pickCursor`, `resizeLeftRight` | The board's eyedropper cursor; `ew-resize` | |
| Full-resolution preview image on the main thread | Full-resolution render in the engine; view-sized raw tiles to the board (18.5) | Process boundary; PNG cost |
| `FilterEdit` in-process | Live engine session (18) | Process boundary |
| `filterSettings` per window session | `rememberedCameraRaw` per board instance, in memory | Same lifetime idea |
| ↩ / ⎋ go to the key panel; a canvas click makes the main window key (only eyedroppers refocus the panel) | ↩ = OK and ⎋ = Cancel while focus is in the panel **or** on the canvas | Single webview focus |
| ⌃⌘F Last Filter | Menu and command palette; consume ⌃⌘F only if the board decides to (VS Code: Toggle Full Screen) | `ui.md` 12.2 |
| Metal ≥ 8 MP | Engine-side, unchanged | |
| RAW develop "Camera Raw…" | Same open path once RAW import is ported | Other area |

---

## 22. Upstream quirks to decide (default: keep, for parity)

- **Q1 Vectorscope cut off.** Square cells of `width / 64` on a 110 pt graph show only the bottom 18 rows (section 3).
  Keep, or fit the 64×64 grid into the graph (`cell = min(w, h) / 64`, centered). Recommendation: ask the user.
- **Q2 Guides not drawn.** Upstream draws neither the draft nor the stored guides. Keep, or draw them on the board's
  overlay (accent 1 px lines in normalized-to-layer coordinates). Ask.
- **Q3 Guided Upright direction (suspected, unverified).** Guides are measured with y down (top-left normalized
  coordinates) but the rotation is applied to Core Image corners with y up, so a drawn tilt may be doubled rather than
  removed; also the angle is taken in normalized units, so on a non-square layer it is not the drawn line's visual
  angle. The engine reproduces whatever upstream does. Verify with a test image (a line at +10° in pixels, one guide
  on it, check the output line angle) before deciding.
- **Q4 One point color.** `pointIndex` starts at 0 and always refers to an existing color, so every eyedropper click
  after the first replaces it; "Up to eight colors" is unreachable.
- **Q5 Curve point dropped against a neighbor.** The drag clamps to `neighbor ± 0.01` and the repair keeps only
  `x > previous + 0.01`, so the point disappears and the drag continues with the next index.
- **Q6 Targeted sensitivity per document pixel.** 0.35 per document pixel, so it depends on zoom (the checklist says
  "per pt").
- **Q7 Draw Guides stays armed** after Reset Geometry (the button is then hidden because Upright is Off), and a canvas
  drag sets Upright back to Guided. Eyedroppers stay armed across page switches and collapsed sections.
- **Q8 Hidden section editing.** Controls of a section whose eye is off stay live; when its values return to defaults
  the eye disappears while still off, and the next change is made unseen until reset.
- **Q9 Adaptive brightness with Geometry.** Preview measures Contrast/Highlights brightness on the unwarped layer, OK on
  the warped pixels.
- **Q10 Parametric graph vs result.** The graph always draws the formula; rendering uses the measured tables at the
  default dividers (e.g. Darks −60: graph keeps 130 at 0.51, render gives 104).
- **Q11 Histogram sampling restarts per band** (section 3). Engine-side; nothing to decide.

---

## 23. Deterministic test vectors

All pixel vectors below were produced **(measured)** by the C harness: upstream's `AdjustPixels.c` kernels on
premultiplied RGBA built as `round(c × a / 255)`, with stages built exactly as `CameraRawTables.stages(for:)` builds
them from the shipped `CameraRawTables.bin`. Outputs are straight RGBA with the tests' rounding
`min(255, (c × 255 + a/2) / a)`. The engine runs the same code, so for these inputs the engine's preview tile at
`scale 1` (and the committed layer) must match **exactly** for an opaque layer. Photoshop's numbers from upstream's
tests (tolerance ±4, `CameraRawTests.swift:136-190`) are given for context.

### 23.1 Identity and eyes

| Case | Expected |
|---|---|
| `{}` (defaults) on any layer | output bytes identical to input; OK → no undo step, `saved: false`, `rendered` = 17.4 object, `lastFilter: null` |
| Only `curve.shadowSplit: 40` (dividers moved, no amounts) | identity (no section adjusts) |
| Only `grading.blending: 80, grading.balance: 30` | identity |
| Only `mixer.points: [{"hue": 120, "saturation": 0.5, "luminance": 0.5}]` (no shifts) | identity |
| `exposure: 1, temperature: 40` with eye Light off and eye Color off | identity on OK; `rendered` has exposure 0 and temperature 0 |
| `exposure: 1, temperature: 40` with eye Light off | OK changes the layer; next open starts from `exposure 0, temperature 40` (`CameraRawTests.swift:346-370`) |

### 23.2 Normalization (board JS and engine must agree)

| Input (partial) | Normalized |
|---|---|
| `temperature: 400` | 100 |
| `exposure: -9` | −5 |
| `curve: {shadowSplit: 2, darkSplit: 3, lightSplit: 4}` | 5, 7, 9 |
| `curve: {rgb: [{"x": 0.5, "y": 0.5}]}` | rgb linear `[(0,0),(1,1)]` |
| `curve: {rgb: [{"x":0.2,"y":0},{"x":0,"y":0.1},{"x":0.205,"y":0.5},{"x":1,"y":2}]}` | `[(0,0.1),(0.2,0),(1,1)]` (0.205 is not > 0.21) |
| `optics: {purpleHueLow: 320, purpleHueHigh: 300}` | 300, 320 |
| `geometry: {guides: [{"startX":0.5,"startY":0.5,"endX":0.505,"endY":0.505}]}` | `guides: []` (length 0.00707 ≤ 0.01) |
| `mixer: {points: [9 colors]}` | first 8 |
| `mixer: {points: [{"hueRange": 1, "saturationRange": 0}]}` | `hueRange 5, saturationRange 0.05` |
| `grading: {shadows: {hue: 400, saturation: 150}}` | hue 360, saturation 100 |

### 23.3 Light and Color (one stage each, 4×4 or 2×1 opaque images unless noted)

| Settings | Input → output (straight RGB) | Photoshop (upstream test) |
|---|---|---|
| exposure +1 | 128,128,128 → **182,182,182** | 181 |
| exposure +1, alpha 128 | 128,128,128 a128 → **181,181,181** a128 (alpha kept) | |
| exposure −1 | 128 → **83** | |
| exposure +0.25 | 128 → **142** | |
| temperature +100 | 128 gray → **236,188,117** | 235,189,117 |
| temperature −50 | 128 gray → **102,146,210** | 102,146,210 |
| tint +100 | 128 gray → **158,125,215** | 159,125,215 |
| tint −100 | 128 gray → **98,197,120** | 98,198,120 |
| contrast +100 (2×1 image 64 \| 192, brightest = 146.41) | 64 → **37**, 192 → **215** | 36, 213 |
| contrast −100 (same image) | 64 → **87**, 192 → **171** | 88, 174 |
| highlights −100 (2×1 230 \| 128, logBrightest = 172.15) | 230 → **217,217,218**, 128 → **125** | 209, 128 |
| whites +100 (230 \| 128) | 230 → **255**, 128 → **183** | |
| whites +100 with ⌥ view (clipping 1) | 230 → **255,255,255**, 128 → **0,0,0** | same (`CameraRawTests.swift:99`) |
| blacks −100 (20 \| 128) | 20 → **0**, 128 → **90** | 0, 91 |
| blacks −100 with ⌥ view (clipping 2) | 20 → **0,0,0**, 128 → **255,255,255** | same |
| shadows +100 (2×1 20 \| 128, small set) | 20 → **40**, 128 → **131** | 33 (test comment; the test only requires > 22) |
| saturation +100 | 160,120,120 → **181,110,108** | |
| vibrance +100 | 153,107,107 → **167,97,98** | 167,98,98 |
| vibrance −100 | 92,92,230 → **165,165,209** | 164,164,210 |
| exposure +1 then temperature +50 (one composed table) | 128 gray → **241,213,177** | |

### 23.4 Mixer, Calibration, Curve (folded table / table stage)

| Settings | Input → output | Photoshop |
|---|---|---|
| `mixer.saturation[1] = −60` (Oranges) | 230,115,0 → **187,131,105** | 189,130,107 |
| `mixer.hue[0] = 60` (Reds) | 230,92,92 → **226,124,84** | 227,125,83 |
| `calibration.blueSaturation = −60` | 92,92,230 → **148,148,226** | 149,149,226 |
| `curve.darks = −60` (measured table) | 130 gray → **104** | 101 |
| `calibration.shadowTint = 100`, Version 6 | 60,30,30 → **60,41,30**; 40 gray → **40** (unchanged) | |
| same, Version 1 | 60,30,30 → **60,36,30** | |

### 23.5 Effects and Optics (300×200 opaque 128 gray)

| Settings | Pixel → output | Photoshop |
|---|---|---|
| `vignetteAmount −60`, Highlight Priority, midpoint 50, feather 50 | corner (0,0) → **32**; center (150,100) → **128**; (0,100) → **72** | 30 at the corner |
| same, Paint Overlay | corner → **51** | |
| `optics.vignetteAmount +100`, midpoint 50 | corner → **219**; center → **128** | 223 |

### 23.6 Overlays (exact formulas, no tables)

| Case | Input → output |
|---|---|
| Both clip indicators | 0,0,0 → **0,0,166**; 255,255,255 → **255,89,89**; 255,0,0 → **89,0,166**; 128 → **128** |
| Shadow indicator only | 0,0,0 → 0,0,166; 255,255,255 → unchanged; 255,0,0 → 89,0,166 |
| Highlight indicator only | 0,0,0 → unchanged; 255,255,255 → 255,89,89; 255,0,0 → unchanged |
| ⌥ highlight view with no table stage | 0,128,255 → **0,0,255**; 255 → 255; 10 → 0 |
| ⌥ shadow view with no table stage | 0,128,255 → **0,255,255**; 255 → 255; 10 → 255 |

### 23.7 Scope, readout, white balance

| Case | Expected |
|---|---|
| 4×4 opaque 255,0,0, step 4 | `red[255] = 4`, `green[0] = 4`, `blue[0] = 4` (each of the 4 rows is its own band); vectorscope total 4 at index **2110** (row 32, column 62) |
| 8×8 0,0,255 alpha 128, step 4 | `red[0] = blue[255] = 8.0314` (16 samples × 128/255); vectorscope total 8.0314 at index **336** (row 5, column 16), i.e. visible in upstream's cut-off graph |
| Readout of premultiplied 64,32,16 a128 | **128, 64, 32** |
| Readout of a clear pixel / outside the layer | `null` → "R —   G —   B —" |
| White Balance eyedropper on 160,140,120 | `temperature −19, tint −6, whiteBalance "Custom"`; that pixel renders **148,148,149** |
| Auto on a solid 160,140,120 layer | the eyedropper's solution, up to floating-point rounding of the linear round trip (gray-world of one color; `CameraRawTests.swift:236-240`) |
| Auto on a fully clear layer | mode "Auto", temperature and tint unchanged, `solved: null` |

### 23.8 Curve math (board `camera-raw-model.js`)

| Call | Expected (6 decimals) |
|---|---|
| `parametric(x)` with darks −60, dividers 25/50/75 | x 0.10 → 0.020145; 0.25 → 0.125481; 0.50 → 0.500000; 0.75 → 0.750000; 0.90 → 0.900000 |
| `parametric(x)` with shadows +100, highlights −100 | 0.10 → 0.187096; 0.25 → 0.250000; 0.90 → 0.812904 |
| `parametric(0.30)` with darks −60, darkSplit 40 | 0.225363 |
| `channelTable(Medium Contrast)[i]` | i 32 → 0.084028; 64 → 0.180906; 128 → 0.502861; 191 → 0.819094; 224 → 0.918593 |
| `channelTable(Strong Contrast)[i]` | 32 → 0.042667; 64 → 0.100633; 128 → 0.504078; 191 → 0.899367; 224 → 0.958661 |
| `parametric(x)` with all amounts 0 | x |

### 23.9 Interaction math

| Case | Expected |
|---|---|
| Slider −100…100, track click at the far left / center / far right | −100 / ≈0 / 100 (`CameraRawSliderTests.swift:63-72`) |
| Parametric region drag starting at amount 0, moved up by half the graph height | exactly +100 (`0 − (−0.5) × 200`), then clamped to −100…100 for longer drags |
| Mixer targeted drag on hue 15°, Saturation tab, 20 document px up | delta 7; Reds weight 0.625 → +4.375, Oranges 0.625 → +4.375, Magentas 0 |
| Wheel press at (+37, 0) from the center | hue 0, saturation 100; at (0, −37) (above) hue 90, saturation 100 |
| First guide (0.1,0.15)→(0.9,0.8) | rotate −39.09 |
| Second guide (0.5,0.1)→(0.52,0.9) | `a2` 88.57° → vertical +25; second guide (0.2,0.5)→(0.8,0.45): `a2` −4.76° → horizontal −25 |
| Defringe eyedropper on a pixel of hue 280° | purple 255…305, Purple Amount 50 if it was 0 |

---

## 24. Checklist cross-reference (`docs/parity/features.md`, "## Camera Raw")

- Panel: "Open from Filter menu", "Docked placement", "Scrolling column", "Full-resolution live preview",
  "OK with no change", "Hidden groups dropped on OK", "Settings remembered", "Last Filter", "16-bit / HDR layers",
  "GPU lookup for large previews", "Canvas pick cursor" → section 2 (+ 18 for the transport, 20.3 for Last Filter).
- Histogram and readout: "RGB histogram", "Vectorscope mode", "Shadow clipping indicator", "Highlight clipping
  indicator", "RGB readout" → section 3 (+ 18.3 `scope`, `sample`).
- Section headers: "Section order and disclosure", "Eye toggle per section", "Reset Light", "Reset Color",
  "Reset Effects", "Reset Curve", "Reset Color Mixer", "Reset Color Grading", "Reset Detail", "Reset Optics",
  "Reset Geometry", "Reset Calibration", "Reset re-shows section" → section 4.
- Slider behaviour: "Knob double-click resets", "Track click glides", "Gradient tracks", "Label double-click resets",
  "Label scrub", "Numeric field", "Option clipping view", "Help tooltips" → section 5.
- Light: "Exposure", "Contrast", "Highlights", "Shadows", "Whites", "Blacks" → section 6.
- Color: "White Balance picker", "White Balance Selector", "Temperature", "Tint", "Vibrance", "Saturation" →
  section 7.
- Color Grading: "View menu", "Wheel interaction", "Shadows wheel", "Shadows luminance", "Midtones wheel",
  "Midtones luminance", "Highlights wheel", "Highlights luminance", "Global wheel", "Global luminance", "Blending",
  "Balance" → section 8.
- Effects: "Texture", "Clarity", "Dehaze", "Glow amount", "Glow Style", "Glow Range", "Glow Spread", "Glow Warmth",
  "Vignette Amount", "Vignette Style", "Vignette Midpoint", "Vignette Roundness", "Vignette Feather",
  "Vignette Highlights", "Grain Amount", "Grain Size", "Grain Roughness" → section 9.
- Curve: "Mode", "Point channel", "Curve graph", "Parametric region drag", "Parametric dividers", "Highlights",
  "Lights", "Darks", "Shadows", "Add point", "Drag point", "Remove point", "In/Out readout", "Preset",
  "Refine Saturation", "Targeted Adjustment" → section 10.
- Color Mixer: "Mode", "HSL component", "Reds", "Oranges", "Yellows", "Greens", "Aquas", "Blues", "Purples",
  "Magentas", "Color page swatches", "Color page Hue", "Color page Saturation", "Color page Luminance",
  "Point Color eyedropper", "Point Color swatches", "Hue Shift", "Saturation Shift", "Luminance Shift", "Hue Range",
  "Saturation Range", "Luminance Range", "Visualize Range", "Targeted Adjustment" → section 11.
- Detail: "Sharpening Amount", "Sharpening Radius", "Sharpening Detail", "Sharpening Masking",
  "Noise Reduction Luminance", "Luminance Detail", "Luminance Contrast", "Noise Reduction Color", "Color Detail",
  "Color Smoothness" → section 12.
- Optics: "Remove Chromatic Aberration", "Enable Lens Profile Corrections", "Profile Distortion",
  "Profile Vignetting", "Manual Distortion", "Defringe eyedropper", "Purple Amount", "Purple Hue range",
  "Green Amount", "Green Hue range", "Lens Vignetting", "Vignetting Midpoint" → section 13.
- Geometry: "Upright", "Draw Guides", "Clear Guides", "Projection", "Vertical", "Horizontal", "Rotate", "Aspect",
  "Scale", "Offset X", "Offset Y", "Constrain Crop" → section 14.
- Calibration: "Process", "Shadows Tint", "Red Primary Hue", "Red Primary Saturation", "Green Primary Hue",
  "Green Primary Saturation", "Blue Primary Hue", "Blue Primary Saturation" → section 15.
- Rendering: "Pipeline order", "Photoshop-measured lookup tables", "Identity passthrough" → sections 1.2 and 16.

Corrections to the checklist found while writing this spec: the targeted adjustments move 0.35 per **document pixel**,
not per point (Q6); "Draw Guides … guides are not drawn on the canvas" is accurate, and the guide coordinates are
top-left normalized despite the struct comment; "Numeric field … typed values are clamped at render" is stricter in
code: they are clamped when stored (`updateFilter` normalizes).
