# Compositor Paint Tools and Color: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only). All `file:line` references are relative to
`upstream/Compositor/` unless they start with `CompositorTests/`. Code excerpts are verbatim.

Scope: Spot Healing, Clone Stamp, Smear (Blur / Smudge / Liquify), Gradient, Eyedropper, Color (swatches and the Color
Picker panel), and the Brush checklist lines that `brush.md` leaves open (mask painting, refusal alerts, 16-bit layers,
live effects while painting, pixel budget, shared tips, busy header). The Brush/Eraser engine itself (coverage kernel,
path, smoothing, growth, commit) is specified in `docs/port-specs/brush.md` and is not repeated here.

Files read in full: `Document/EditorSession+Brush.swift` (269), `Document/BrushStroke.swift` (1126),
`Document/CloneStamp.swift` (49), `Document/BlurTool.swift` (74), `Document/SmudgeLiquify.swift` (265),
`Rendering/MetalWarp.swift` (271), `Document/Gradient.swift` (126), `UI/BrushControls.swift` (152),
`UI/GradientControls.swift` (108), `UI/ColorPickerSheet.swift` (218), `UI/ColorPaletteControls.swift` (79),
`Document/ColorPalette.swift` (374), `Rendering/HealPixels.c` (288), `Rendering/HealPixels.h`,
`Rendering/BrushCursorOverlay.swift` (95), `Rendering/SampleRingOverlay.swift` (29), `Document/DocumentLimits.swift` (42).
Read in part: `Rendering/EditorCanvas.swift` (85-110, 400-480, 990-1110, 1285-1330, 1450-1600, 1700-1990, 2100-2140,
2196-2345, 2495-2535, 2820-3000), `Rendering/TransformOverlay.swift` (80-95, 185-195, 445-492),
`Document/EditorSession.swift` (60-135, 195-250, 340-445, 545-560, 650-705), `Rendering/PatchPixels.c` (1-60, 437-509),
`Rendering/RasterSnapshot.swift` (34-110), `Document/DeepLayers.swift` (1-90), `Rendering/LayerEffectsSurface.swift`
(1-60), `Rendering/GPUCanvas.swift` (10-70, 340-365), `ContentView.swift` (27-70, 285-345, 419-485), `UI/FloatingPanel.swift`
(1-80), `UI/NumericScrub.swift`, `IO/ProjectStore.swift` (66-80). Tests read: `CompositorTests/CloneStampTests.swift`,
`SpotHealingTests.swift`, `GradientTests.swift`, `MetalWarpTests.swift`, `BlurBrushTests.swift`, `ColorPickerTests.swift`.
Board code read: `vscode-extension/media/{brush,view,board,picker}.js`, `vscode-extension/extension.js` (`runEngine`),
`engine/Sources/*.swift`.

**[measured]** marks behaviour reproduced on this Mac (Darwin 25.6) by calling the same Core Graphics API the app calls
(a throwaway Swift probe, deleted afterwards).

---

## 0. Summary of key facts

- Every brush-family tool (Brush, Spot Healing, Clone Stamp, Smear) is driven by the same three calls:
  `EditorSession.beginBrush(at:)`, `continueBrush(at:)`, `finishBrushImmediately()` (`Document/EditorSession+Brush.swift:50-152`).
  The canvas passes them document points: the press (or, for Shift-click, the last stroke end followed by the click),
  every drag point after the Shift axis lock, and the **raw** release point (`Rendering/EditorCanvas.swift:1830-1836,
  1957-1981, 2121-2126`). Replaying that point list in a fresh `EditorSession` reproduces the stroke exactly. This is the
  commit path for every tool in this spec (section 8).
- Spot Healing, Clone Stamp and Blur use the Brush's **coverage engine unchanged** (same `BrushStroke`, same GPU kernel);
  only what is painted through the coverage differs: a dark wash (heal preview), a shifted image (clone), a blurred copy
  (blur). Coverage is therefore exact in the board already (`brush.js`).
- Smudge and Liquify do **not** use the coverage engine while painting. They run dab kernels on a document-sized working
  copy (`WarpStroke`, `MetalWarp`), then on release paint that copy back into the layer through a hard brush along the
  dab path (`finishWarp`). The Metal kernels are small and are given verbatim (section 4.5-4.6); a JS preview can be
  near-exact.
- Spot Healing is **not deterministic**: `heal()` seeds the C kernel with `UInt32.random(in:)` (`BrushStroke.swift:921`).
  Only the dark-wash preview is exact; the result must come from the engine.
- Gradient previews on the GPU canvas with `CILinearGradient` / `CIRadialGradient`, but the commit draws a Core Graphics
  `CGGradient` into 8-bit tiles. Core Graphics **dithers** the ramp **[measured]**: deviations of ±1 level from the
  ideal per-pixel formula (±2 for ramps steeper than about 4 levels per pixel; radial up to ±4 for very short radii).
  So no JS preview can be bit-exact; the engine commits.
- Tip families: Brush and Spot Healing share one (size, hardness, opacity); Clone Stamp and Smear each park their own,
  both starting at (40 px, 0 %, 100 %) (`Document/EditorSession.swift:224-225, 399-407`).
- Refusals have exact texts and appear in an alert titled **"Couldn’t paint"** (`ContentView.swift:297-300`).
- Undo names: "Brush Stroke", "Erase", "Paint Mask", "Blur", "Clone Stamp", "Spot Healing", "Smudge", "Liquify",
  "Gradient", "Gradient Mask". A Blur stroke on a mask is named **"Paint Mask"** (the mask test comes first,
  `EditorSession+Brush.swift:171`).
- The Color Picker keeps HSB as the source of truth and **quantizes to 8-bit** on read (`ColorPalette.swift:297, 360`);
  there is no alpha, no swatch library, no recent colors.

---

## 1. Shared brush-tool behaviour (Brush lines still open)

### 1.1 Tools, keys, rail and header titles

| Tool (`NavigationTool`) | Key | Rail label (help) | Rail icon | Header title (`BrushControls.swift:7`) |
|---|---|---|---|---|
| `.brush` | B (Paint), E (Erase) | "Brush (B) · Eraser (E)" | SF `paintbrush.pointed`, `eraser` in Erase mode (`EditorSession.swift:211-213`) | "Brush" / "Eraser" |
| `.spotHealing` | J | "Spot Healing Brush (J)" | SF `bandage` | "Spot Healing" |
| `.cloneStamp` | S | "Clone Stamp (S) · Option-click sets the source" | custom `CloneStampToolIcon` | "Clone Stamp" |
| `.blur` | R | "Smear (R)" | SF `drop` | "Smear" |
| `.gradient` | G | "Gradient (G)" | custom `GradientToolIcon` | "Gradient" (`GradientControls.swift:8`) |
| `.eyedropper` | I | "Eyedropper (I)" | SF `eyedropper` | "Eyedropper" (`ContentView.swift:54`) |

Keys: `EditorCanvas.swift:2290-2314` (only with no Command/Control/Option). B and E are
`session.selectTool(.brush); session.brushMode = .paint/.erase`. Rail order (`ContentView.swift:314`, `EditorSession.swift:91`):
move, marquee, lasso, wand, crop, brush, spotHealing, cloneStamp, blur, gradient, shape, type, eyedropper, hand, zoom; each
button 36x36 pt, icons 17 pt (custom ones 18x18 frame), selected background white 12 % and border white 14 %, corner 7.

`CloneStampToolIcon` (`BrushControls.swift:138-151`), in a w x h box, one filled path: ellipse (0.33w, 0.02h, 0.34w,
0.30h); rect (0.43w, 0.28h, 0.14w, 0.28h); rounded rect (0.12w, 0.54h, 0.76w, 0.22h) corner 0.08w; rect (0.06w, 0.82h,
0.88w, 0.12h).

`GradientToolIcon` (`GradientControls.swift:70-107`): a 16x16 Floyd-Steinberg dither of a left-to-right ramp
`x/15` (threshold 0.5, weights 7/16, 3/16, 5/16, 1/16), dots of 1 pt inside a frame inset 1 pt, clipped to a rounded rect
(radius 3.5) that is also stroked at 1.4 pt.

### 1.2 Tip families ("Tools › Brush › Shared tip")

```swift
@ObservationIgnored var parkedBrushTips: [Int: (diameter: CGFloat, hardness: CGFloat, opacity: CGFloat)] = [1: (40, 0, 1), 2: (40, 0, 1)]
private static func tipFamily(_ tool: NavigationTool) -> Int { tool == .cloneStamp ? 1 : tool == .blur ? 2 : 0 }
```
(`EditorSession.swift:224-225`). In `selectTool` (`:399-407`), when the family changes, the current
(diameter, hardness, opacity) is parked under the old family and the new family's parked values are swapped in. Family 0
(Brush, Spot Healing, and every non-brush tool) starts with `BrushSettings()` = (40, 1, 1). Color, smoothing and
`blurRadius` are **not** parked: they are shared by all tools. Nothing is persisted across launches. Test:
`CloneStampTests.swift:65-77` (Brush at 30 px hard; Clone Stamp shows 40 px, 0 %; Clone changed to 50 % hardness;
Spot Healing gets 30 px / 100 % back; Clone Stamp gets 40 px / 50 % back).

Board: replace the single `board.brush` with three tips keyed by family and swap them in `selectTool` exactly as above.

### 1.3 Options bar (`UI/BrushControls.swift`)

One HStack (spacing 12): title (tool header title font), then a horizontal ScrollView (no indicators) holding, in order:

1. Mode/type picker (segmented, label hidden), only for the tool that has one:
   - Brush: "Paint" | "Erase", help "Paint with the foreground color (B), or erase pixels away (E)" (`:10-16`).
   - Smear: "Liquify" | "Blur" | "Smudge", help "Liquify pushes pixels · Blur softens · Smudge drags color along"
     (`:17-23`).
   - Spot Healing: "Content-Aware" | "Create Texture" | "Proximity Match", **no help string** (`:24-30`).
   - Clone Stamp: checkbox "Aligned", help "Keep the source moving with the brush between strokes; off starts every
     stroke at the source point"; then segmented "This Layer" | "All Layers", help "Copy from the active layer only, or
     from every visible layer as shown" (`:31-40`).
2. "Size": label scrub 1.0 per point, range 1...2000, no step; field width 48, 0 decimals, unit "px"; Up/Down 1 (Shift
   10); typed or changed values clamp to 1...2000, non-finite becomes 40 (`:41-51`).
3. "Hardness": label scrub 0.01 per point, 0...1; slider 0...1 width 100; field width 42 in %, 0 decimals, clamp
   0...100, non-finite becomes 100 %; unit "%" (`:52-60`).
4. "Opacity", or **"Strength" for Smear** (all three Smear modes): label scrub 0.01, 0.01...1; slider 0.01...1 width 100;
   field width 42, 0 decimals, clamp 1...100, non-finite becomes 100 %; help "Press 1–9 for 10–90%, 0 for 100%";
   unit "%" (`:61-71`).
5. Smear in Blur mode only: "Radius": label scrub 0.1 per point, 0.5...50; slider 0.5...20 (shows `min(20, value)`),
   width 100; field width 42, format 0...1 decimals, clamp 0.5...50, non-finite becomes 5; Up/Down step 1 (Shift 10);
   help "How far the blur softens, in pixels"; unit "px" (`:73-86`). Default 5 (`BrushStroke.swift:21`).
6. Brush only: "Smoothing" (see `brush.md` section 5) (`:88-99`).
7. Mask selected: pop-up "Paint" with "Black · Hide" / "White · Reveal", frame width 180 (shown for **every** brush
   tool, including Spot Healing, Clone Stamp and Smear) (`:100-104`).
   Otherwise, unless the tool is Clone Stamp or Smear: "Color" label plus a 34x18 swatch (rounded 4, continuous) filled
   with the foreground, white 1 pt inner stroke (inset 1), black 1 pt border; click opens the foreground Color Picker;
   disabled when `!canEditPalette`; help and accessibility "Foreground color" (`:105-122`).
8. `Spacer`, then Clone Stamp with no source: "Option-click to set the source" (secondary) (`:124-126`); mask
   selected: "Mask" (secondary) (`:127`).

The whole bar is `.disabled(session.showsBusy)` ("Tools › Brush › Header disabled while busy", `:133`).
`showsBusy` turns true only after `isProjectBusy` has lasted 250 ms (`EditorSession.swift:120-130`), so quick commits
never dim it. Board: dim the bar (and the swatches, section 7.1) when an engine commit has been in flight for 250 ms.

### 1.4 Shared input (pointers to `brush.md`)

The following apply to **all** brush tools (`isBrushTool` = brush, spotHealing, cloneStamp, blur) and are specified in
`brush.md` section 14-15: `[`/`]` size steps, `{`/`}` hardness quarters, digit opacity keys (Smear: strength; Gradient:
gradient opacity, `EditorSession+Brush.swift:247-251`), right-drag resize / Shift right-drag hardness ring, Shift-drag
axis lock (3 px), Shift-click line from `lastBrushPoint` (also set by Smudge/Liquify, `SmudgeLiquify.swift:227`; tied to
the same layer **and** the same pixels-or-mask target), Escape cancels (Smudge/Liquify too, `EditorCanvas.swift:2221-2223`),
brush outline cursor (white 2.5 pt then black 1 pt circle of `max(1, diameter * pointsPerPixel)` points; Smear uses the
unclamped options-bar diameter). Tab cycles each tool's own mode (`EditorSession.swift:423-445`):

| Tool | Tab cycle |
|---|---|
| Brush | Paint → Erase → Paint |
| Smear | Liquify → Blur → Smudge → Liquify |
| Spot Healing | Content-Aware → Create Texture → Proximity Match → Content-Aware |
| Clone Stamp | toggles This Layer / All Layers |
| Gradient | Linear ↔ Radial |

Tab needs no modifiers and no text being edited (`EditorCanvas.swift:2276-2280`), and does nothing during a stroke.

Option as a temporary eyedropper (`palettePicking`, `EditorCanvas.swift:93`):
```swift
session.tool == .eyedropper || (optionHeld && (session.tool == .brush || session.tool == .spotHealing || session.tool == .gradient)
    && session.brushStroke == nil && gradientDrag == nil)
```
Not Clone Stamp (Option-click sets its source) and not Smear (Option does nothing there: the press starts a stroke).

### 1.5 Refusals ("Tools › Brush › Refusal alert" lines)

`canPaint` (`EditorSession+Brush.swift:5-11`) and the text chosen by `paintRefusal` (`:14-33`), first match wins.
The guard `canEditLayers, let layer = activeLayer, !canPaint` returns nil when the editor is busy, so a press while busy
does nothing and shows nothing.

| # | Condition | Message (verbatim; curly quotes U+201C/U+201D, apostrophes U+2019) |
|---|---|---|
| 1 | `selectedLayerIDs.count > 1` | `Several layers are selected. Select just one to paint on it.` |
| 2 | folder, mask not selected | `“<name>” is a folder, which has no pixels of its own. Paint on a layer inside it, or on the folder’s mask.` |
| 3 | not effectively visible | `“<name>” is hidden, or inside a hidden folder. Show it to paint on it.` |
| 4 | mask selected but disabled | `The layer mask is turned off. Shift-click its thumbnail to turn it on, then paint.` |
| 5 | adjustment layer, mask not selected | `“<name>” is an adjustment layer, with no pixels to paint. Paint on its mask instead.` |
| 6 | selection explicitly empty | `Nothing is selected, so there’s nowhere to paint. Choose Select › Deselect (⌘D) to paint anywhere.` |

Tool-specific messages (all shown in the same alert):

- Clone Stamp without a source: `Option-click where Clone Stamp should copy from first.` (`:56-60`, checked **after**
  `canPaint`).
- Smudge or Liquify on a selected mask: `Smudge and Liquify work on a layer's pixels, not its mask.` (straight
  apostrophe, `SmudgeLiquify.swift:217`); otherwise their refusal is `paintRefusal`.
- Spot Healing and Clone Stamp on a selected mask: **no message**, nothing happens (`EditorSession+Brush.swift:51-53`).
- A thrown error during a stroke shows `error.localizedDescription` (section 1.6).

Gradient uses the same `canPaint` / `paintRefusal` (`Gradient.swift:55, 63`).

Alert (`ContentView.swift:297-300`): title `Couldn’t paint`, message = the text, one button "OK". Board: a modal alert
in the webview with that title and an OK button (the current board shows a toast and different texts:
`board.paintRefusal`, `document.pixelLock`; replace them with the table above).

### 1.6 Pixel budget ("Tools › Brush › Pixel budget")

`makeRasterEdit` (`EditorSession+Brush.swift:35-49`):

```swift
let used = document.layers.filter { $0.id != layer.id }.reduce(0) { total, layer in
    let image = isMaskSelected ? layer.mask?.asset.image : layer.asset?.image
    return total + (image.map { $0.width * $0.height } ?? 0)
}
stroke.pixelLimit = DocumentLimits.documentPixelBudget - used
...
if !isMaskSelected, layer.mask != nil {
    let maskPixels = document.layers.filter { $0.id != layer.id }.reduce(0) { $0 + ($1.mask.map { $0.asset.image.width * $0.asset.image.height } ?? 0) }
    stroke.pixelLimit = min(stroke.pixelLimit, DocumentLimits.documentPixelBudget - maskPixels)
}
```

`DocumentLimits.documentPixelBudget = min(800_000_000, max(200_000_000, physicalMemory / 16))`
(`DocumentLimits.swift:36-37`); this 24 GB Mac gets 800,000,000. Each new 256 px tile is checked in `allocateTile`
(`BrushStroke.swift:666-668`): the union of the source rect and all allocated tiles must have width and height
≤ 30,000 and area ≤ `pixelLimit`, else `ProjectError.tooLarge`, whose text is
`This project exceeds the supported canvas, layer, file-size, or 800-megapixel document limit.`
(`IO/ProjectStore.swift:76`, the number is `documentBudgetMegapixels`). The stroke is cancelled (`cancelBrush`) and the
alert "Couldn’t paint" shows that text. `BrushStroke.init` also throws `tooLarge` for diameter outside 1...2100, hardness
outside 0...1, opacity outside 0.01...1 or a grid side outside 1...1e9 (`:231-235`).

Board: the budget is per machine. Compute it in the extension host exactly:
`Math.min(800e6, Math.max(200e6, Math.floor(os.totalmem() / 16)))` (or ask the engine, section 8.5), and use the
`tooLarge` text above (the board's `PIXEL_BUDGET = 200000000` and its own message differ).

### 1.7 Painting a mask ("Paint on mask", "Paint on folder mask", "Mask paint picker")

- Target: `isMaskSelected` (the mask thumbnail is the paint target). Colors: `settings.red = green = blue =
  maskPaintWhite ? 1 : 0` (`EditorSession+Brush.swift:69`); Erase mode on a mask paints that color too (`erasing` is
  false on masks, `:67`), so "Erase" on a mask is ordinary painting with the mask color.
- Which tools act on a mask: Brush (Paint and Erase), Smear in **Blur** mode, Gradient. Spot Healing and Clone Stamp do
  nothing (silently). Smudge and Liquify alert (1.5).
- Growth: only the Brush tool (and Gradient) passes `growsMask: true` (`:70`, `Gradient.swift:66`). A Blur stroke on a mask
  stays inside the mask's own pixels.
- Folder masks: `canPaint` allows a folder when its mask is selected (`:7`). The grid is the folder's transform (or the
  mask's placement).
- Mask background, growth in whole tiles, placement on grow, and the rest of the mask math: `brush.md` sections 11 and
  12.3. Undo name "Paint Mask" for every stroke kind on a mask (including Blur).
- `lastBrushPoint` remembers `mask: Bool`; a Shift-click line only continues on the same target.

Board: the board has no mask target yet (no `isMaskSelected` anywhere in `media/*.js`). Needed: a mask-target state set
from the Layers panel thumbnail, the "Paint" picker and "Mask" label in the header, the black/white swatches (7.1), and
mask strokes. Preview in JS with `brush.js` coverage over a gray grid using `M' = G*a + M*(1 - a)` with
`a = cov/255 * opacity * sel/255` (`brush.md` section 9); commit through the engine (`paint.stroke` with
`isMaskSelected: true`, section 8.1), which applies Compositor's own growth and placement rules.

### 1.8 16-bit layers ("Tools › Brush › 16-bit layers")

A layer whose `ImportedImage.deep` is set keeps 16-bit pixels; `image` is a dithered 8-bit copy every tool reads
(`DeepLayers.swift:3-6`). After a Brush, Spot Healing or Clone Stamp stroke, `paintSnapshot` keeps `deep` as long as the
new raster's base is still the old one (`BrushStroke.swift:966-969`): the 16-bit pixels stay as the base and the stroke's
tiles are 8-bit patches over them, flattened to 16 bits on save (`DeepLayer.flattened`, `DeepLayers.swift:50-58`).
Blur paints a softened copy made from the 16-bit pixels (`deepRender`, `BlurTool.swift:49-71`), and Smudge/Liquify work
on a 16-bit (or half-float HDR) working copy (`SmudgeLiquify.swift:59-63`), both committed through `deepPainted` at 16
bits (`BrushStroke.swift:962-964, 975-997`). Gradients are redrawn at 16 bits (`deepPaint`, `:999-1018, 1102-1108`).

Board: it refuses deep layers today (`document.pixelLock`: "This is a 16-bit layer. Paint it in Compositor..."). Replace
that with: preview on the 8-bit copy the board shows, commit every stroke on a 16-bit PNG layer through the engine
(`paint.stroke`, `paint.gradient`). Keep refusing HDR (OpenEXR) layers, which the board cannot decode or preview.

### 1.9 Live layer effects while painting ("Tools › Brush › Live layer effects while painting")

While a stroke (or gradient, or pixel move) is in progress on a layer with visible, valid effects, the canvas draws a
`LayerEffectsSurface` (`EditorCanvas.swift:1081-1091, 1285-1311`): the layer's grid plus an effects margin, kept at full
resolution and recomputed only within `reach` of changed tiles (`LayerEffectsSurface.swift:33-41`: stroke size + 2,
shadow distance + 3·blur + 2, glow size·3 + 2), with the stroke's tiles in place of the old pixels. A mask stroke rebuilds
the effects from the mask as the stroke leaves it (`:1292-1306`). Smudge/Liquify do **not** show effects during the
stroke (the warp branch returns first, `:1017-1023`).

Board: layer effects are not rendered at all in v1 (`compositing.md` section 9), so this line is not applicable until
effects are drawn. When they are: rebuild the effects image for the stroke's grid from the stroke's working canvas,
limited to the dirty tiles grown by the same `reach`.

---

## 2. Spot Healing

### 2.1 Checklist lines

- **"Tool selection"**: J; rail "Spot Healing Brush (J)"; header "Spot Healing" (1.1).
- **"Type picker"**: segmented "Content-Aware" / "Create Texture" / "Proximity Match", default Content-Aware
  (`BrushStroke.swift:3-7`, `EditorSession.swift:206`). No help string.
- **"Content-Aware mode"**, **"Create Texture mode"**, **"Proximity Match mode"**: section 2.3.
- **"Tab cycles type"**: 1.4.
- **"Size / Hardness / Opacity"**: Brush's fields and ranges, shared Brush tip (family 0). Opacity is the amount the heal
  is laid in (`amount = coverage / 255 * opacity`, `HealPixels.c:132, 261`). No Smoothing (field hidden and `smoothed()`
  only runs for `.brush`, `EditorSession+Brush.swift:108`).
- **"Dark wash preview"**: section 2.2.
- **"Pixels only"**: on a selected mask `beginBrush` returns without a stroke or a message (`:51-53`).
- **"Color swatch"**: the header shows the foreground swatch (not used for healing) and Option samples a color (1.4).

### 2.2 Gesture, preview and commit

- Press/drag/release are the Brush's (coverage path, Catmull-Rom, Shift line, Shift axis lock, right-drag, Escape). The
  stroke settings come from `brushSettings` with `healing = true`, `healingMode = spotHealingMode` (`:66-68`).
- While dragging, each touched tile is redrawn as the original tile, then (`BrushStroke.swift:520-523`):
  ```swift
  BrushRaster.fill(Self.healingWash, coverage: mask, in: local, alpha: 0.45, context: tile.context)
  // healingWash = CGColor(srgbRed: 0.12, green: 0.12, blue: 0.12, alpha: 1)   (:593)
  ```
  i.e. source-over of sRGB gray 0.12 (8-bit 31) at alpha `0.45 * cov/255`, through the selection clip, independent of
  the Opacity setting. Over transparent pixels the wash is visible too.
- Release: `finishBrushImmediately` → `stroke.flush()` → `stroke.heal()` → `commitPaintSnapshot` (one undo step
  "Spot Healing", `EditorSession+Brush.swift:147-149, 171`).
- `heal()` (`BrushStroke.swift:890-943`):
  1. `painted` = union of nonzero-coverage bounds of every coverage tile (`heal_coverage_bounds`).
  2. `reach = (max(painted.w, painted.h) + 32) * 3.2`; `region = painted` grown by `reach`, ∩ grid, integral.
  3. `pixels` = the layer's **original** pixels placed at `sourceRect` in that region (transparent elsewhere); `painting` =
     the 8-bit coverage of all tiles in the same region.
  4. `spot_heal(pixels, painting, w, h, stride, opacity, mode, UInt32.random)`; -1 (out of memory) throws `tooLarge`.
  5. Every coverage tile is rebuilt: original tile, then the healed region drawn with `.copy` through the selection clip.
- The layer can grow (healed pixels are written wherever coverage reached inside the grid; `paintSnapshot` crops to
  `sourceRect ∪ nonzero alpha`, `brush.md` 12.1).

### 2.3 The heal kernel (engine-only; summary for understanding)

`spot_heal` (`Rendering/HealPixels.c:120-288`), on premultiplied RGBA:

- **Content-Aware (mode 0)**: copy the region, run `patch_fill` (multi-scale PatchMatch, 7x7 patches, color + texture
  channels, texture weight 6, sharp final vote 8; only fully opaque pixels outside the hole are sources; working box =
  hole bounds grown by `max(64, size)`; `PatchPixels.c:437-509`), then for each covered pixel
  `t = t + (f - t) * amount` per channel with `amount = cov/255 * opacity`, alpha first, colors clamped to `[0, alpha]`.
  If there is no opaque image to copy from (`patch_fill` returns 0), it falls through to Create Texture.
- **Create Texture (mode 1)** and **Proximity Match (mode 2)**: `ring = clamp(size / 8, 2, 16)` (size = longer side of
  the spot bounds); roles HOLE (covered), RING (within `ring` px, square dilation), OUTSIDE. Proximity Match picks a
  source offset among 24 angles × 2 distance factors {1.05, 1.35} × box size (Content-Aware's fallback never searches,
  since it arrives as mode 1), scoring the mean squared RGBA difference over the ring, penalised `× (1 + 0.6 f)` so nearer
  wins, then refined ±3 px. A membrane (successive over-relaxation, ω = 1.8, 300 iterations, or 40 after a coarse-to-fine
  start) spreads `ring difference` (original − source, or original alone without a source) across the hole. Create
  Texture adds Gaussian grain `N(0,1) · 0.9 · rms(local detail of the ring)` per color channel from a hash of the seed and
  pixel index. Result = `t + (healed - t) * amount`, alpha clamped to 0...255, colors to `[0, alpha]`.
- Patch search reach is why `heal()` reads `(spot + 32) * 3.2` px around the spot.

### 2.4 Preview vs commit

| | Board (JS) | Exact? |
|---|---|---|
| Live | `brush.js` coverage (unchanged), then per tile: original pixels, then `rgb(31,31,31)` source-over at `globalAlpha = 0.45` through `cov * sel`. Use the Brush compositing path with color `[0.12, 0.12, 0.12]`, opacity 0.45, never erasing. | yes (±1 rounding) |
| After release | keep the wash on screen, send `paint.stroke` (`tool: "spotHealing"`), replace with the engine's saved layer when it arrives. | engine = Compositor |

Content-Aware on a large spot can take seconds (PatchMatch over the region): show the busy state after 250 ms and block
further edits until the answer (section 8.6).

---

## 3. Clone Stamp

### 3.1 Checklist lines

- **"Tool selection"**: S; rail "Clone Stamp (S) · Option-click sets the source"; custom icon; header "Clone Stamp".
- **"Option-click sets source"**: an Option press with Clone Stamp calls `setCloneSource(pixel)` and returns without
  painting (`EditorCanvas.swift:1822-1828`). `setCloneSource` stores the fractional document point and clears
  `cloneOffset` (`CloneStamp.swift:14-18`). Works on a selected mask too (only painting is skipped there).
- **"No-source hint and error"**: header shows "Option-click to set the source" while `cloneSource == nil`; painting
  without one alerts `Option-click where Clone Stamp should copy from first.` (only if `canPaint` passed first).
- **"Aligned toggle"**: default on (`CloneStamp.swift:7`). Section 3.2.
- **"Sample picker"**: "This Layer" (default) / "All Layers" (`CloneStamp.swift:9`). Section 3.3.
- **"Tab toggles sample"**: `cloneSettings.sampleAllLayers.toggle()` (`EditorSession.swift:439`).
- **"Size / Hardness / Opacity"**: Brush's fields; own tip family starting (40 px, 0 %, 100 %); no color swatch, no
  Smoothing.
- **"Source crosshair"**: 3.4. **"Hover preview"**: 3.5. **"Pixels only"**: silently nothing on a selected mask.

### 3.2 Source and offset

```swift
func cloneStrokeOffset(at point: CGPoint) -> CGSize? {
    guard let cloneSource else { return nil }
    return (cloneSettings.aligned ? cloneOffset : nil)
        ?? CGSize(width: (cloneSource.x - point.x).rounded(), height: (cloneSource.y - point.y).rounded())
}
func cloneSamplePoint(for point: CGPoint) -> CGPoint? {
    guard let cloneSource else { return nil }
    guard let cloneOffset, cloneSettings.aligned || brushStroke != nil else { return cloneSource }
    return CGPoint(x: point.x + cloneOffset.width, y: point.y + cloneOffset.height)
}
```
(`CloneStamp.swift:23-35`). `.rounded()` is half away from zero (JS: `Math.sign(v) * Math.round(Math.abs(v))`, already in
`brush.js` as `roundHalfAway`). `beginBrush` sets `cloneOffset = offset` at every stroke start (`EditorSession+Brush.swift:73`).
So:
- Aligned: the first stroke after a new source fixes the whole-pixel offset `round(source − press)`; later strokes reuse it.
- Not aligned: every stroke recomputes `round(source − press)`, i.e. starts copying at the source again.
- The offset is in **document pixels**, whole numbers; the source sample moves with the brush within a stroke.

### 3.3 What a stroke paints

At stroke start (`cloneSample`, `CloneStamp.swift:39-48`), taken once:
- **This Layer**: `(image: layer.asset.image, placed: stroke.gridRect(stroke.sourceRect, copyingFrom: offset), inGrid: true)`
  where `gridRect` shifts by the offset carried into the grid's linear part
  (`shift = offset.applying(pixelToDocument.inverted())`, `BrushStroke.swift:875-878`; `CGSize.applying` ignores
  translation). A blank layer (no asset) returns nil and the press does nothing (no message).
- **All Layers**: the live composite of the document drawn at document size (`drawLiveComposite`: every visible layer
  as shown, masks, blend modes, adjustments, effects, the active layer included, at stroke start), placed at
  `(-offset.width, -offset.height, W, H)` in document coordinates, `inGrid: false`.

Per touched tile, after the original pixels (`publish`, `BrushStroke.swift:514-519`, `drawClone` `:544-565`):

```swift
context.clip(to: local, mask: coverage)        // 8-bit brush coverage of this tile
context.setAlpha(settings.opacity)
if replacesWithClone { context.setBlendMode(.copy) }   // false for Clone Stamp
context.interpolationQuality = .medium
// into the grid (inGrid) or document space (!inGrid) and draw the sample piece at `placed`
```

So, for grid pixel `g` with document point `P = M·(g + 0.5)`:

- This Layer: `src = layerImage[g − sourceRect.min + shift]` (an exact copy when `shift` is integral, i.e. unrotated layers
  at integer scale 1; bilinear-like `.medium` resampling otherwise).
- All Layers: `src = composite[P + offset]`.
- `out = src · k + base · (1 − k·src.a)` (premultiplied source-over) with `k = cov/255 · opacity`, then through the
  selection clip. Where the sample has no pixels (outside the source layer or the canvas) nothing is painted.

Commit: `commitPaintSnapshot`, undo "Clone Stamp", layer growth as Brush. Test vector: section 10.2.

### 3.4 Source crosshair (`BrushCursorOverlay.swift:78-93`)

At `viewPoint(cloneSamplePoint(for: pointerDocPoint))`, two arms of reach 7 pt (horizontal and vertical, total 14 pt),
round caps, stroked white 3 pt then black 1 pt. Shown while the brush circle shows (`isBrushTool && !spaceHeld && !picking
&& no middle-button navigation`) and the pointer is over the canvas (`EditorCanvas.swift:1509-1534`).

### 3.5 Hover preview and cursor

- Cursor: with a source set, no Option and no Space, the system cursor is **hidden** (`EditorCanvas.swift:1477-1481`);
  holding Option brings back the crosshair; without a source the crosshair shows.
- Between strokes (`brushStroke == nil`, no Option, an offset exists), the brush circle is filled with what a click would
  stamp (`EditorCanvas.swift:1519-1533, 1536-1590`; `BrushCursorOverlay.swift:39-58`):
  1. `center = pointerDoc + offset` (offset from `cloneStrokeOffset(at: pointerDoc)`).
  2. Render the source around `center` into a `side x side` image, `side = min(1024, ceil(diameter * scale))`,
     `scale = pointsPerPixel * backingScale` (device px per document px), mapping the `diameter`-wide square centered on
     `center` onto it, interpolation `.medium`: All Layers → the live composite; This Layer → the active layer alone drawn
     with its displayed transform (no mask, no layer opacity).
  3. Tip: one click of the real brush engine (`BrushStroke` on a blank `ceil(d) x ceil(d)` layer, white, click at
     `(side/2, side/2)`), white with alpha = coverage.
  4. Draw into the circle: clip to the ellipse, `setAlpha(brushSettings.opacity)`, transparency layer: draw the source
     image into the circle rect, then the tip with `.destinationIn`; end the layer. Then the usual white/black rings.
- Cache key: center, diameter, scale, brush revision, undo count, All Layers flag, active layer.

Board: CSS `cursor: none` in that state; draw the preview on the overlay canvas: the source (This Layer: the active
layer's canvas through its transform; All Layers: the board composite) × single-click coverage from
`brush.js` (`CoverageField` with one sample at the center) × opacity, clipped to the circle. Exact for This Layer; All
Layers is as exact as the board composite (no adjustments/effects in v1).

### 3.6 Preview vs commit

| | Board (JS) | Exact? |
|---|---|---|
| Live | `brush.js` coverage; per tile: original pixels, then the shifted source drawn through `cov·sel` at `globalAlpha = opacity`, source-over. Implement as a "source image" variant of `PaintStroke.publish`: copy the source piece into the scratch tile, `destination-in` with the coverage alpha, then draw at `opacity`. Take the source when the stroke starts (This Layer: the layer's own canvas; All Layers: a snapshot of the board composite). | This Layer, unrotated scale-1 layer: yes (±1); scaled/rotated layers and All Layers: close |
| Commit | `paint.stroke` with `tool: "cloneStamp"`, `cloneSource`, `cloneOffset` (the aligned offset kept from the previous stroke, or omitted), `aligned`, `sampleAllLayers`. The answer returns the `cloneOffset` the stroke used; store it (the engine session is new for every request, so the board owns `cloneSource` and `cloneOffset`). | engine = Compositor |

---

## 4. Smear: Blur, Smudge, Liquify

### 4.1 Checklist lines

- **"Tool selection"**: R; rail "Smear (R)"; header "Smear"; icon SF `drop`.
- **"Mode picker"**: Liquify (default, `EditorSession.swift:207`) / Blur / Smudge; help as 1.3.
- **"Tab cycles mode"**: Liquify → Blur → Smudge.
- **"Size / Hardness"**: Brush fields; own tip family (40 px, 0 %); Smudge/Liquify use `diameter = max(2, d)`,
  `hardness = min(0.98, max(0, h))`, `strength = min(1, max(0.01, opacity))` (`SmudgeLiquify.swift:54-56`). The options
  bar keeps showing the unclamped values.
- **"Strength"**: the opacity control labelled "Strength" (1...100 %, default 100 %); digits set it.
- **"Blur Radius"**: 1.3 item 5.
- **"Blur stroke"**: 4.2. **"Blur on masks"**: 4.2.
- **"Smudge stroke"**: 4.4-4.5. **"Liquify stroke"**: 4.4, 4.6.
- **"Smudge/Liquify pixels only"**: alert on a selected mask (1.5).
- **"Smudge/Liquify commit"**: 4.7.
- **"No color swatch"**: no swatch (`BrushControls.swift:105`) and Option does nothing.

### 4.2 Blur (coverage engine with a blurred source)

`beginBrush` with `tool == .blur && blurMode == .blur` builds a normal `BrushStroke` (`growsMask: false`) and sets
`stroke.clone = blurSample.sample`, `stroke.cloneRender = blurSample.render`, `stroke.isBlur = true`
(`EditorSession+Brush.swift:77-86`). Painting is then Clone Stamp's `drawClone` (source-over at `opacity` through
coverage; `isBlur` lets it run on masks too, `BrushStroke.swift:514`).

`blurSample` (`Document/BlurTool.swift:11-73`), taken at stroke start:

```swift
let map = stroke.pixelToDocument
let perPixel = max(1e-6, abs(map.a * map.d - map.b * map.c).squareRoot())       // document px per grid px
let sidePixels = max(stroke.sourceRect.width, stroke.sourceRect.height)
let sigma = min(Double(min(50, max(0.5, brushSettings.blurRadius))) / perPixel, sidePixels / 2)   // in grid px
let margin = ceil(3 * sigma)
let region = stroke.sourceRect.insetBy(dx: -margin, dy: -margin)
let canvas = (document?.width ?? 0) * (document?.height ?? 0)
let budget = Double(min(DocumentLimits.maxSurfacePixels, max(16_000_000, 4 * canvas)))
let fit = min(1, (budget / Double(region.width * region.height)).squareRoot())
let width = max(1, Int((region.width * fit).rounded(.up))), height = max(1, Int((region.height * fit).rounded(.up)))
let placed = CGRect(x: margin * fit, y: margin * fit, width: stroke.sourceRect.width * fit, height: stroke.sourceRect.height * fit)
// mask: context first filled with LayerMask.background(of: thumbnail) (the mask's edge tone)
BrushRaster.draw(image, in: placed, mask: stroke.isMask, context: context)
let soft = (stroke.isMask ? source.clampedToExtent() : source).applyingGaussianBlur(sigma: sigma * fit).cropped(to: extent)
return ((sharp, region, true), render, deepRender)     // clone placed at `region` in grid px, inGrid
```

- Radius is measured on the canvas (document px), converted into the layer's pixels; a layer scaled down gets a wider
  sigma in its own pixels. Capped at half the layer's longer side.
- Pixel layers blur against transparency (not clamped), so softening **spreads past the layer's edges** by up to
  `3·sigma`; the layer grows to hold it. Masks are padded with their edge tone and clamped, so blurring near a mask edge
  does not pull in the wrong tone.
- The sample is taken from the layer as it is at stroke start, so a second stroke over the same area softens further;
  overlapping passes within one stroke do not compound (the source is fixed; only coverage accumulates).
- Compositing is source-over of the blurred copy: `out = blur·k + base·(1 − k·blur.a)`, `k = cov/255 · opacity`. An
  opaque pixel therefore stays opaque even next to transparency (quirk: Blur never makes pixels more transparent).
- Undo "Blur" on pixels, "Paint Mask" on a mask.

Board preview: compute a separable Gaussian (σ = `sigma` in grid px, kernel truncated at `ceil(3σ)`) of the layer grid
(transparent outside; masks: edge-tone padded and clamped) lazily per 256 px tile as the brush reaches it (the upstream
`cloneRender` does the same), then paint it like a clone source. Not bit-exact (Core Image's Gaussian implementation and
any `fit` downscale differ), close visually. Commit: `paint.stroke` with `tool: "smear", smearMode: "Blur"`.

### 4.3 Smudge and Liquify: the working copy

`beginWarp` (`SmudgeLiquify.swift:215-230`): needs `canPaint`, mask not selected, `layer.asset` present (a blank layer
does nothing). It builds `WarpStroke(layer, image, deep: DeepLayer.flattened(asset), transform: displayedTransform(layer),
canvas: document.size, mode: blurMode, settings: brushSettings)` and appends the press point.

- The working copy `C` is **document-sized** (W x H), RGBA **premultiplied**, top-left rows, holding the layer's pixels
  drawn through its displayed transform (`LayerRenderer.draw`, no mask, no opacity). 8-bit (`rgba8Unorm`), or 16-bit
  (`rgba16Unorm`) / half float for a deep layer on the GPU.
- Display during the stroke (`EditorCanvas.swift:1017-1023`, GPU `:2999`): `C` is drawn **in place of the layer**, over
  the whole canvas, with the layer's mask (resampled onto the canvas, at most 2048 px), effective opacity and blend
  mode; **no effects**; not clipped by the selection.

### 4.4 Dab generation (`WarpStroke.append`, `SmudgeLiquify.swift:91-124`)

```swift
func append(_ point: CGPoint) {
    guard let from = last else {
        last = point
        if mode == .smudge { pickUp(at: point) }          // GPU: gpu.pickUp(at:radius:)
        return
    }
    let distance = hypot(point.x - from.x, point.y - from.y)
    let spacing = max(1, diameter * (mode == .smudge ? 0.005 : 0.025))
    guard distance >= spacing else { return }            // `last` is NOT advanced
    let steps = Int((distance / spacing).rounded(.up))
    var previous = from
    for step in 1...steps {
        let t = CGFloat(step) / CGFloat(steps)
        let next = CGPoint(x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t)
        if mode == .smudge { smudge(at: next) } else { push(from: previous, to: next) }
        points.append(next)
        previous = next
    }
    last = point
}
radius r = Int((diameter / 2).rounded(.up))
```

Weight (identical in Swift and Metal):

```metal
static inline float weight(float u, float hardness) {
    if (u >= 1.0f) return 0.0f;
    if (u <= hardness) return 1.0f;
    float t = (1.0f - u) / (1.0f - hardness);
    return t * t * (3.0f - 2.0f * t);
}
```
with `u = sqrt(dx² + dy²) · (1 / (diameter / 2))` for integer offsets `(dx, dy)` from the dab center.

The GPU path runs whenever Metal is available (every supported Mac, and the engine). **Port the GPU kernels**
(4.5, 4.6); the CPU `push` resamples pixels and softens them, which the GPU path deliberately avoids
(`MetalWarpTests.swift:46-73`).

### 4.5 Smudge kernels (verbatim, `MetalWarp.swift:196-221`)

`steps` = 255 for an 8-bit copy, 65535 for 16-bit, 0 for HDR. `carried` is an `rgba32Float` (2r+1)² square.

```metal
kernel void warp_pick_up(texture2d<float, access::read> canvas [[texture(0)]],
                         texture2d<float, access::write> carried [[texture(1)]],
                         constant Dab &d [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
    int side = 2 * d.radius + 1;
    if (int(gid.x) >= side || int(gid.y) >= side) return;
    int2 p = d.center + int2(gid) - d.radius;
    bool inside = p.x >= 0 && p.y >= 0 && p.x < d.size.x && p.y < d.size.y;
    carried.write(inside ? canvas.read(uint2(p)) * max(d.steps, 1.0f) : float4(0.0f), gid);
}

kernel void warp_smudge(texture2d<float, access::read_write> canvas [[texture(0)]],
                        texture2d<float, access::read_write> carried [[texture(1)]],
                        constant Dab &d [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
    int side = 2 * d.radius + 1;
    if (int(gid.x) >= side || int(gid.y) >= side) return;
    int2 offset = int2(gid) - d.radius, p = d.center + offset;
    if (p.x < 0 || p.y < 0 || p.x >= d.size.x || p.y >= d.size.y) return;
    float w = weight(sqrt(float(offset.x * offset.x + offset.y * offset.y)) * d.inverseRadius, d.hardness);
    if (w <= 0.0f) return;
    float4 under = canvas.read(uint2(p)) * max(d.steps, 1.0f), held = carried.read(gid);
    float4 painted = under + (held - under) * w * d.keep;
    canvas.write(d.steps > 0 ? clamp(round(painted), 0.0f, d.steps) / d.steps : painted, uint2(p));
    carried.write(painted, gid);
}
```

Dab parameters: `center = (Int32(x.rounded()), Int32(y.rounded()))` (half away from zero), `radius = r`,
`inverseRadius = 1 / Float(diameter / 2)`, `hardness`, `keep = strength`. In JS, per 8-bit premultiplied channel:

```js
// pickUp at the press: carried[(dy+r)*side + dx+r][k] = inside ? C[p][k] : 0          (float, 0..255)
// each dab at `next`:
painted = under + (held - under) * w * strength;   // under = C[p][k], held = carried[k] (unrounded float)
C[p][k] = clamp(roundHalfAway(painted), 0, 255);   // Metal round() = half away from zero
carried[k] = painted;                               // keep the unrounded value
```

Pixels outside the canvas are skipped; they keep the carried value (and are 0 = transparent at pick-up, so smudging
from the canvas edge drags transparency in). Within one dab every pixel reads and writes only itself, so the order of
pixels does not matter; dabs run strictly in sequence.

### 4.6 Liquify kernels (verbatim, `MetalWarp.swift:132-158, 223-269`)

State: `O` (the copy as it was at the first push, full size), `F` (`rg32Float` source offsets per pixel, all zero at the
first push), `S` (scratch). Host side, per dab from `a` to `b`:

```swift
let move = SIMD2<Float>(Float(b.x - a.x), Float(b.y - a.y)) * Float(strength)
let margin = Int(ceil(max(abs(move.x), abs(move.y)))) + 2
let cx = Int(b.x.rounded()), cy = Int(b.y.rounded())
let x0 = max(0, cx - r - margin), x1 = min(width - 1, cx + r + margin)
let y0 = max(0, cy - r - margin), y1 = min(height - 1, cy + r + margin)
guard x0 <= x1, y0 <= y1 else { return }
let cw = x1 - x0 + 1, ch = y1 - y0 + 1
if original == nil { copy C → O; clear F }                 // first push only
dispatch("warp_copy", dab, textures: [offsets, scratch])   // S = F[x0...x1, y0...y1], local coordinates
dispatch("warp_push", dab, textures: [offsets, scratch, original, texture])
```

```metal
kernel void warp_push(texture2d<float, access::write> offsets [[texture(0)]],
                      texture2d<float, access::read> before [[texture(1)]],
                      texture2d<float, access::read> original [[texture(2)]],
                      texture2d<float, access::write> canvas [[texture(3)]],
                      constant Dab &d [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
    int side = 2 * d.radius + 1;
    if (int(gid.x) >= side || int(gid.y) >= side) return;
    int2 offset = int2(gid) - d.radius, p = d.center + offset;
    int2 last = d.origin + d.area - 1;
    if (p.x < d.origin.x || p.y < d.origin.y || p.x > last.x || p.y > last.y) return;
    float w = weight(sqrt(float(offset.x * offset.x + offset.y * offset.y)) * d.inverseRadius, d.hardness);
    if (w <= 0.0f) return;
    float sx = min(float(d.area.x - 1), max(0.0f, float(p.x - d.origin.x) - d.move.x * w));
    float sy = min(float(d.area.y - 1), max(0.0f, float(p.y - d.origin.y) - d.move.y * w));
    int ix = min(d.area.x - 2, int(sx)), iy = min(d.area.y - 2, int(sy));
    if (ix < 0 || iy < 0) return;
    float fx = sx - float(ix), fy = sy - float(iy);
    float2 o00 = before.read(uint2(ix, iy)).xy, o10 = before.read(uint2(ix + 1, iy)).xy;
    float2 o01 = before.read(uint2(ix, iy + 1)).xy, o11 = before.read(uint2(ix + 1, iy + 1)).xy;
    float2 moved = mix(mix(o00, o10, fx), mix(o01, o11, fx), fy) - d.move * w;
    offsets.write(float4(moved, 0.0f, 0.0f), uint2(p));
    float2 source = clamp(float2(p) + moved, float2(0.0f), float2(d.size - 1));
    int2 i = min(int2(source), d.size - 2);
    float2 f = source - float2(i);
    float4 c00 = original.read(uint2(i)), c10 = original.read(uint2(i + int2(1, 0)));
    float4 c01 = original.read(uint2(i + int2(0, 1))), c11 = original.read(uint2(i + int2(1, 1)));
    float4 color = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
    canvas.write(d.steps > 0 ? clamp(round(color * d.steps), 0.0f, d.steps) / d.steps : color, uint2(p));
}
```

In words: each dab moves the **offset field** (bilinear sample of the previous offsets from behind the travel, minus the
travel scaled by the weight), and each touched pixel is redrawn from the **untouched original** through its offset by a
single bilinear sample of premultiplied RGBA, rounded to 8 bits. Pixels stay sharp because they are never resampled
twice. `mix(a, b, t) = a + (b − a)·t`. `int()` truncates (all arguments are ≥ 0 here).

JS port notes:
- Keep `C` and `O` as premultiplied `Uint8ClampedArray` (convert the board's straight `ImageData` once:
  `round(c * a / 255)`), `F` as `Float32Array` (2 per pixel). For large documents, store `O` and `F` sparsely in 256 px
  tiles allocated when a dab first reaches them (`F` is 0 and `O` equals `C` elsewhere).
- Cost per dab is `(2r+1)²` pixels. Typical brushes are cheap (40 px: 1,681 px per dab, spacing 1 px). A 1000 px Liquify
  brush is 1 M px per dab every 25 px; run the kernels in a Worker or as WebGL2 fragment passes (`RG32F` offsets need
  `EXT_color_buffer_float`) when `r > 150`.
- Precision: Metal is float32; using `Math.fround` for `w`, `sx`, `sy` and the products makes the JS port match the GPU
  except at rare rounding ties (upstream accepts ≤ 8 levels on < 0.1 % of values between its own CPU and GPU paths).

### 4.7 Commit (`finishWarp`, `SmudgeLiquify.swift:233-264`)

On release (`continueBrush(release)` then `finishBrushImmediately` → `finishWarp`):

```swift
guard !warp.points.isEmpty, let result = warp.image, current layer image and transform unchanged else { return }
var settings = brushSettings
settings.diameter = warp.diameter + 4      // hard tip a little wider than the brush
settings.hardness = 1
settings.opacity = 1
let stroke = try makeRasterEdit(for: current, settings: settings)    // pixel budget + selection clip apply here
stroke.clone = (result, CGRect(x: 0, y: 0, width: result.width, height: result.height), false)   // document space
if result.bitsPerComponent == 16 { stroke.deepClone = stroke.clone }
stroke.replacesWithClone = true            // .copy: replace what is under the tip, can clear pixels
stroke.editName = warp.mode.rawValue       // "Liquify" or "Smudge"
let spacing = max(1, warp.diameter * 0.05)
var kept: CGPoint?
for (index, point) in warp.points.enumerated() {
    if let kept, index < warp.points.count - 1, hypot(point.x - kept.x, point.y - kept.y) < spacing { continue }
    try stroke.append(point)
    kept = point
}
try stroke.flush()
if !stroke.patches.isEmpty { try commitPaintSnapshot(stroke) }
```

- A stroke with no dabs (a click, or movement under one spacing) commits nothing.
- The working copy is pasted back with `.copy` through the hard coverage (a soft clip at its antialiased rim gives
  `dst + (src − dst)·cov`) and **through the selection clip**, although the live preview ignored the selection (quirk).
- The copy is at document resolution, so on a scaled or rotated layer the area under the path is resampled once.
- One undo step "Liquify" or "Smudge"; 16-bit layers keep 16 bits.

### 4.8 Preview vs commit

| Mode | Board (JS) | Exact? |
|---|---|---|
| Blur | coverage × JS Gaussian copy (4.2) | close |
| Smudge | doc-size premultiplied copy + 4.4/4.5 kernels; display the copy in place of the layer (mask, opacity, blend; no effects, no selection clip) | near-exact (float32 ties) |
| Liquify | 4.4/4.6 kernels with offsets field | near-exact |
| Commit (all) | `paint.stroke`, `tool: "smear"`, `smearMode`, raw point list | engine = Compositor |

---

## 5. Gradient

### 5.1 Checklist lines

- **"Tool selection"**: G; rail "Gradient (G)"; dithered custom icon (1.1). Cursor: crosshair.
- **"Shape picker"**: segmented "Linear" / "Radial", default Linear (`Gradient.swift:9-15`), help "Linear runs along the
  line; Radial spreads out from the start point" (`GradientControls.swift:11-15`). Radial is centered on the start with
  the end on its rim.
- **"Tab cycles shape"**: 1.4.
- **"Color preview swatch"**: 5.2.
- **"Colors picker"**: pop-up (label hidden) "Foreground to Background" / "Foreground to Transparent", default
  **Foreground to Transparent** (`Gradient.swift:3-6, 16`).
- **"Reverse toggle"**: checkbox "Reverse", default off; reverses the two colors (`Gradient.swift:97`).
- **"Opacity"**: "Opacity" label scrub 0.01/pt (0.01...1), slider 0.01...1 width 100, field width 42 (0 decimals,
  clamp 1...100, non-finite 100 %), help "Press 1–9 for 10–90%, 0 for 100%", unit "%", default 100 %
  (`GradientControls.swift:22-31`). Digits set it (`EditorSession+Brush.swift:249`).
- **"Draw line"**, **"Adjust endpoints"**, **"Shift 45°"**: 5.3.
- **"Live re-render"**: 5.4. **"Line overlay"**: 5.5. **"Apply / Cancel"**, **"Auto-apply"**: 5.6.
- **"Gradient on mask"**: 5.7. **"Destructive result"**: the commit rasterizes into the layer's (or mask's) pixels;
  there is no gradient layer. **"Option eyedropper"**: 1.4 (`gradientDrag == nil`).

### 5.2 Header (`UI/GradientControls.swift:6-65`)

HStack(spacing 12): title "Gradient"; scrolling HStack(spacing 12): Shape picker, swatch, Colors pop-up, "Reverse"
checkbox, Opacity group; then `Spacer`; "Mask" (secondary) when a mask is selected; "Cancel" and "Apply" buttons while
`gradientEdit != nil`. Disabled while `showsBusy` or with no document. There is **no** mask Paint picker in this header;
the mask colors come from the swatches (X, D) or the Brush header.

Swatch: 56x18, rounded 3 (continuous); white background with a checkerboard of 4 pt squares where
`(row + column)` is even, gray 45 % opacity; overlay `LinearGradient(gradientColors(mask: false))` leading → trailing
(reversal included; black/white when a mask is selected, since `paletteColor` returns the mask colors); border black
50 %, 1 pt.

### 5.3 Gestures (`EditorCanvas.swift:1844-1845, 1948-1955, 2128-2131, 2502-2519`)

- Press: if a line is pending, a press within **10 view points** of the end grabs the end; else within 10 pt of the start
  grabs the start (end checked first). Otherwise `beginGradient(at: docPoint)` and the drag moves the **end**.
- `beginGradient` (`Gradient.swift:54-69`): needs `tool == .gradient` and `canPaint || gradientEdit != nil`. A pending
  gradient on the same layer and same target (pixels vs mask) restarts with `start = end = point` (replacing the pending
  line). Otherwise `canPaint` is required (refusal alert as 1.5) and a new `GradientEdit` is made with
  `makeRasterEdit(for: layer, growsMask: true)` (pixel budget and selection clip as Brush).
- Drag: `moveGradient(start:)` or `(end:)` with the dragged end at the document point; with **Shift** the dragged end is
  snapped around the other end:
  ```swift
  let dx = point.x - anchor.x, dy = point.y - anchor.y
  let length = hypot(dx, dy)
  let angle = (atan2(dy, dx) / (.pi / 4)).rounded() * (.pi / 4)
  return CGPoint(x: anchor.x + cos(angle) * length, y: anchor.y + sin(angle) * length)
  ```
- Release: `endGradientDrag()` cancels the edit when `hypot(end − start) < 0.5` (`hasLine`, `Gradient.swift:32, 101-103`).
  So a click without a drag leaves nothing pending, and a click (no drag) on the same target while a gradient is
  pending **discards** the pending gradient (it restarted the line at the click).
- Endpoints are fractional document points; nothing snaps to guides or pixels.

### 5.4 What is drawn and when it re-renders

`refreshGradient()` (`Gradient.swift:79-86`) runs on every `moveGradient` and on any change of `gradientSettings`,
`brushSettings` (the foreground color lives there), `backgroundColor` or `maskPaintWhite` (`EditorSession.swift:205,
227-229`): with a line, `fill = (shape, start, end, colors: gradientColors(mask: isMask), opacity)`.

```swift
func gradientColors(mask: Bool) -> [CGColor] {
    let space = mask ? CGColorSpaceCreateDeviceGray() : CGColorSpace(name: CGColorSpace.sRGB)!
    func color(_ value: PaletteColor, alpha: CGFloat) -> CGColor {
        CGColor(colorSpace: space, components: mask ? [value.red, alpha] : [value.red, value.green, value.blue, alpha])!
    }
    let foreground = paletteColor(background: false)
    let colors = gradientSettings.style == .foregroundToBackground
        ? [color(foreground, alpha: 1), color(paletteColor(background: true), alpha: 1)]
        : [color(foreground, alpha: 1), color(foreground, alpha: 0)]
    return gradientSettings.reversed ? colors.reversed() : colors
}
```
`paletteColor` on a mask: foreground = white if `maskPaintWhite` else black; background = the opposite
(`ColorPalette.swift:26-29`).

**Committed raster** (`BrushStroke.fillGradient` + `paintCanvas`, `BrushStroke.swift:707-775`), for every 256 px tile of
the stroke grid covering `canvas ∩ selection.rect`: clear, draw the original tile, then in document coordinates clip to
the canvas and the selection coverage, `setAlpha(clamp(opacity, 0, 1))`, and

```swift
case .linear:
    context.drawLinearGradient(gradient, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
case .radial:
    context.drawRadialGradient(gradient, startCenter: start, startRadius: 0, endCenter: start,
                               endRadius: hypot(end.x - start.x, end.y - start.y),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
```
with `CGGradient(colorsSpace: sRGB or DeviceGray, colors, locations: [0, 1])`. Ideal math per grid pixel center mapped to
document point `P`:

- Linear: `t = clamp(((P − S)·(E − S)) / |E − S|², 0, 1)`. Radial: `t = clamp(|P − S| / |E − S|, 0, 1)`.
- `c = c0 + (c1 − c0)·t` per **gamma-encoded sRGB** component and alpha (straight colors; for both styles the
  premultiplied and straight interpolations coincide, because either both ends are opaque or both have the same RGB).
- Premultiply, 8-bit, then source-over onto the original at `opacity`, through the selection clip.

**[measured]** Core Graphics dithers the 8-bit ramp deterministically (same output for the same call; neighbouring rows
differ): versus `round(255 · ideal)` the error is ±1 for 512 px ramps of any style (about 20 % of samples off by one),
±2 for a 64 px black-to-white ramp, and for radial ramps ±1-2 at radius 200 and up to ±3/+4 at radius 40. A gray mask
context dithers too (±1). Upstream's own tests allow ±3 (±5 for radial) (`GradientTests.swift:33-35, 64`).

**GPU canvas preview** (`EditorCanvas.swift:2935-2976`): `CILinearGradient` (`inputPoint0 = start`, `inputPoint1 = end`)
or `CIRadialGradient` (`center = start`, `radius0 = 0`, `radius1 = |E − S|`) with the two colors (sRGB, or the gray value
for masks), masked by the canvas and the selection, faded by `opacity`, composited over the old pixels in the layer's
grid. The Core Image working space is extended sRGB (gamma-encoded, `GPUCanvas.swift:57`), so it interpolates like the
commit, without the dither.

Commit (`commitGradient`, `Gradient.swift:111-119`): `applyFill()` then `commitRasterEdit(edit.raster, name: isMask ?
"Gradient Mask" : "Gradient")` (`EditorSession+Brush.swift:190-230`), async on the `BrushCommit` actor with
`isProjectBusy` set:
- Pixel layer: the whole committed area (source rect ∪ all allocated tiles, i.e. the canvas ∩ selection in grid space)
  is rendered and **cropped to its tight nonzero-alpha bounds** (`BrushCommit.render`, `BrushStroke.swift:1067-1083`).
  Unlike a brush stroke this can also **shrink** a layer that had fully transparent margins (quirk). A Foreground to
  Transparent gradient leaves the layer ending where the alpha reaches 0. An unplaced layer mask is re-rasterised to the
  new bounds with new area white (`expandMask`); its enabled state is kept from the current layer.
- Mask: grows to every allocated tile (the canvas ∩ selection, whole 256 px tiles) and becomes placed when it grew.
- 16-bit: the same drawing is redone at 16 bits (`deepPaint`).
- The commit is skipped if the layer's image, transform or mask changed meanwhile.

### 5.5 Line overlay (`TransformOverlay.swift:84-88, 450-488`)

Drawn in view points when the edit has a line (`hasLine`), and only if no Progressive Blur line is shown and the tool is
not Crop:

1. Radial only: the rim circle (center = start, radius = |end − start| in view points), dash `[4, 4]`, black 50 % 2 pt,
   then white 80 % 1 pt.
2. The line start → end: black 70 % 3 pt, then white 1 pt.
3. At start and end: a 12 pt circle (radius 6) filled white, stroked black 1 pt; inside it a circle inset 2.5 pt (7 pt)
   filled gray `white: 0.75`, then filled with that end's color from `gradientColors(mask: false)` (so a transparent end
   shows plain light gray, not a checkerboard; on a mask the ends are black/white).

### 5.6 Apply, cancel, auto-apply, undo

- Header "Cancel" → `cancelGradient()`; "Apply" → `commitGradient()`. Return or keypad Enter (key codes 36, 76) applies,
  Escape (53) cancels (`EditorCanvas.swift:2234-2239`).
- Auto-apply (`resolveGradient`, `Gradient.swift:122-125`) when switching tools (`EditorSession.swift:398`), active layer
  (`:391`), layer selection (`LayerGroups.swift:149`) or paint target (`LayerMask.swift:225`); before Invert, Levels,
  Hue/Saturation, any filter, and before quitting/closing (`ProjectWorkspace.swift:137`).
- Undo (⌘Z) with a pending gradient discards it instead of undoing (`EditorSession.swift:657-660`); `canUndo` is true
  while one is pending.
- While a gradient is pending, `canEditLayers` is false (`EditorSession.swift:698-700`), which blocks most layer edits.

### 5.7 Gradient on a mask

Same gesture; colors are DeviceGray `[v, alpha]` with `v` = 1 or 0 from `maskPaintWhite` (foreground) and its opposite
(background). Source-over in gray: `M' = g·a + M·(1 − a)`. The mask grows past its layer (`growsMask: true`).
Header shows "Mask". Undo "Gradient Mask". Test vector 10.4.

### 5.8 Preview vs commit

| | Board (JS) | Exact? |
|---|---|---|
| Pending preview | For the target's grid (layer pixels, or mask gray), redraw: original pixels, then a Canvas 2D `createLinearGradient(S, E)` or `createRadialGradient(S, 0, S, R)` with stops 0 and 1 (`rgba()` of the two colors; Canvas pads beyond the ends like `drawsBefore/After`), drawn in document space through the inverse grid mapping, `globalAlpha = opacity`, clipped to the canvas and the selection coverage, source-over. Masks: draw gray colors into an RGBA scratch and take R, then `M' = g·a + M(1 − a)`. Redraw on every endpoint move and on any setting/palette change. Overlay as 5.5. | ±1 (±2-4 for steep ramps) against the commit, from Core Graphics' dither |
| Apply | `paint.gradient` (section 8.2); keep the preview until the saved layer arrives. Cancel/Esc/⌘Z: drop the preview, no request. Auto-apply before tool/layer/target switches and before any other edit or save. | engine = Compositor |

---

## 6. Eyedropper

Fully specified in `ui.md` section 4; summary per checklist line:

- **"Header"**: title "Eyedropper" and checkbox "Sample Ring", default on; `showsSampleRing` is a plain session property,
  **not persisted** (`EditorSession.swift:107`, `ContentView.swift:53-60`). (The board stores it in its webview state;
  upstream resets it to on at every launch.)
- **"Click or drag samples..."**: mouse-down samples, drag keeps sampling, mouse-up ends (`EditorCanvas.swift:1794-1798,
  1901, 2115-2120`). `sampleCompositeColor` (`ColorPalette.swift:239-260`) renders the live composite into a 1x1
  premultiplied sRGB context at `(floor(x), floor(y))`; nil outside the canvas or when alpha is 0; else
  `channel(v) = (min(a, v) / a * 255).rounded() / 255`. Writes `session.foregroundColor` only if `canEditPalette`
  (with a mask selected this changes the hidden RGB foreground, not the mask color: quirk).
- **"Sample ring"**: a 116x116 pt view centered on the pointer; gray 0.45 ring 24 pt wide on an oval inset 15 pt; over it
  a 16 pt ring whose top half is the new sample and bottom half the color before the drag (`samplingOriginal` = the
  picker's working color if open, else the foreground); hidden on mouse-up; not shown when Sample Ring is off
  (`SampleRingOverlay.swift:15-28`, `EditorCanvas.swift:2521-2533`).
- **"With the color picker open..."**: while the picker is open (not for a dialog target), a click in **any** tool
  samples into the picker (`hsb.setRGB`), and focus returns to the picker on mouse-up (`EditorCanvas.swift:94-96, 1794-1798,
  2118`, `ColorPalette.swift:232-235`).
- **"Eyedropper cursor"**: a 24x24 image: the SF Symbol `eyedropper` drawn black in a 20x20 rect at (2, 2) over the same
  glyph drawn white at 16 offsets of 1.25 pt (a halo); hot spot (3, 21), the dropper tip at the bottom left
  (`EditorCanvas.swift:432-458`). Board: replace `cursor: copy` with a CSS `url()` cursor of that image, hot spot 3 21.

Exactness: the board samples its own composite, which lacks adjustment layers and effects in v1. For documents that
contain them, refine the final value on mouse-up with `color.sample` (section 8.3), which runs Compositor's own
`sampleCompositeColor`.

---

## 7. Color

### 7.1 Foreground / background swatches (`UI/ColorPaletteControls.swift`)

- **"Tool-rail swatches"**: below the last rail tool, top padding 8 (`ContentView.swift:337`). A 36x36 box: background
  swatch at offset (12, 12), foreground swatch at (0, 0) on top; each 24x24, rounded 6 (continuous), filled with
  `paletteColor(background:)`, white 1.5 pt inner stroke (inset 1), black 1 pt border; help/accessibility "Background
  color" / "Foreground color". Defaults black / white (`BrushStroke.swift:12-14`, `EditorSession.swift:228`).
- **"Click opens picker"**: `openColorPicker(background:)` on that color (`ColorPalette.swift:58-67`), unless a mask is
  selected.
- **"Swap"**: a 12x12 button at offset (27, −3) with SF `arrow.left.and.right` (9 pt, medium) rotated 45°, secondary
  color, help "Swap foreground and background (X)"; X key. `swapPaletteColors` (`:43-51`): on a mask toggles
  `maskPaintWhite`; otherwise swaps (through `setPaletteColor`, so Type text being edited follows).
- **"Reset"**: 12x12 button at (−1, 27), SF `arrow.counterclockwise` (7.5 pt, medium), help "Default colors (D)"; D key.
  On a mask `maskPaintWhite = false`; otherwise black foreground, white background.
- **"Mask mode"**: with a mask selected the swatches show black/white (foreground white iff `maskPaintWhite`); clicking
  either opens a popover: headline "Mask foreground" or "Mask background", buttons "Black · Hide" and "White · Reveal"
  (`:40-48`). Choosing sets `maskPaintWhite` so that the chosen swatch shows that color (`setPaletteColor`, `:30-36`). The
  popover closes when the mask selection changes, and an open picker is **cancelled** when a mask becomes selected
  (`:53-56`).
- **"Disabled while busy"**: the whole control is disabled when `!canEditPalette` = `isProjectBusy || brushStroke != nil`
  (`ColorPalette.swift:25`); `setPaletteColor`, swap and reset also refuse then.
- **"No swatch library"**: there are no saved swatches, recent colors or palettes.

### 7.2 Color Picker panel (`UI/ColorPickerSheet.swift`, `Document/ColorPalette.swift:263-356`)

Panel ("Floating panel"): `FloatingPanelController(name: "colorPickerPanel")`, a non-modal floating panel titled by the
target; first opening centered on the canvas, afterwards at the top-left where it was last left (for the app session; also
kept when its content changes while open); the title-bar close button **cancels** (`ColorPickerSheet.swift:168-190`,
`FloatingPanel.swift:35-75`). Opening another target while open reuses the panel in place.

Layout (fixed size, padding 20): `HStack(alignment: .top, spacing: 14)`:

1. **Saturation/brightness field** 256x256: horizontal gradient white → pure hue (`PickerHSB(hue, 1, 1)`), over it a
   vertical gradient clear (top) → black (bottom); border black 60 % 1 pt; marker: a 12x12 circle with a white 1.5 pt
   stroke inside and a black 0.75 pt ring just outside, centered at `(s·256, (1 − b)·256)`. Drag (minimum distance 0):
   `s = clamp(x/256, 0, 1)`, `b = 1 − clamp(y/256, 0, 1)`.
2. **Hue strip**: 20x256 gradient of hues 360, 300, 240, 180, 120, 60, 0 top to bottom (red, magenta, blue, cyan, green,
   yellow, red), border black 60 % 1 pt, 7 pt padding each side (frame 34x256); two 7x10 triangles (filled with the
   primary label color) pointing inward from both sides at `y = (1 − hue/360)·256 − 5`. Drag:
   `hue = (1 − clamp(y/256, 0, 1))·360`. Accessibility value "N degrees".
3. **Right column** (180 x 256, top-leading): an HStack(top, spacing 16) of the **new-color preview** (64x64, rounded 5,
   filled with the working color, border black 60 % 1 pt) and a VStack(spacing 8, width 90, large controls) of
   **"OK"** (Return) and **"Cancel"** (Escape), both full width; a spacer (min 12); the fields grid (horizontal spacing 8,
   vertical 6):
   - Rows "R", "G", "B": label (width 14) scrubbable 1 unit per point over 0...255 (rounded to integers); integer field
     width 52; Up/Down ±1, Shift ±10 (`ContentView.swift:419-427`); setting a channel builds
     `rgb = color` (quantized) with that channel `clamp(v, 0, 255)/255` and calls `hsb.setRGB(rgb)`.
   - Row "#": monospaced field width 84. It shows `color.hex` (uppercase `RRGGBB`) and follows the color unless it has
     focus. On Return (`onSubmit`) or focus loss: `PaletteColor(hex:)` (trim spaces, optional `#`, 3-digit shorthand
     doubled, must be 6 hex digits) → `setRGB`; then the field is reset to `color.hex` (so invalid input reverts).
   - Below, unless the target is a dialog: caption "Click the canvas to sample" (secondary, top padding 8).

Model (verbatim, `ColorPalette.swift:297, 310-373`):

```swift
var color: PaletteColor { hsb.rgb.quantized }   // working color; nothing is written until OK

var rgb: PaletteColor {
    let h = (hue.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
    let c = brightness * saturation
    let x = c * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1))
    let m = brightness - c
    let (r, g, b): (CGFloat, CGFloat, CGFloat)
    switch Int(h) {
    case 0: (r, g, b) = (c, x, 0)
    case 1: (r, g, b) = (x, c, 0)
    case 2: (r, g, b) = (0, c, x)
    case 3: (r, g, b) = (0, x, c)
    case 4: (r, g, b) = (x, 0, c)
    default: (r, g, b) = (c, 0, x)
    }
    return PaletteColor(red: r + m, green: g + m, blue: b + m)
}
/// Updates from RGB while keeping the previous hue for grays and the previous saturation for black.
mutating func setRGB(_ color: PaletteColor) {
    let high = max(color.red, color.green, color.blue)
    let low = min(color.red, color.green, color.blue)
    let delta = high - low
    brightness = high
    if high > 0 { saturation = delta / high }
    guard delta > 0 else { return }
    var h: CGFloat
    if high == color.red { h = (color.green - color.blue) / delta }
    else if high == color.green { h = (color.blue - color.red) / delta + 2 }
    else { h = (color.red - color.green) / delta + 4 }
    h *= 60
    hue = h < 0 ? h + 360 : h
}
var quantized: PaletteColor { (each channel * 255).rounded() / 255 }
var hex: String { String(format: "%02X%02X%02X", ...rounded bytes) }
```

- **"8-bit quantization"**: the working color, preview, fields and the committed color are all `quantized`. No alpha.
- **"OK / Cancel"**: `closeColorPicker(commit:)` (`ColorPalette.swift:101-139`). Keys are the app's remappable "native"
  shortcuts (`KeyboardShortcuts.swift:251-254`).
- **"Canvas sampling"** / **"Composite sampling rule"**: section 6.
- **"Window titles by target"** (`ColorPalette.swift:275-284`): "Color Picker (Foreground Color)", "Color Picker
  (Background Color)", "Color Picker (Text Color)", "Color Picker (<kind> Color)" with kind "Stroke", "Drop Shadow",
  "Color Overlay", "Inner Shadow", "Outer Glow", "Inner Glow" (`LayerEffects.swift:226-228`), "Color Picker (Gradient Map
  Highlights)", "Color Picker (Gradient Map Shadows)", "Color Picker (Vignette Color)", "Color Picker (Light Color)",
  "Color Picker (Dark Color)" (Dither and Scanlines), "Color Picker (<dialog title>)" with the titles "Extension Color"
  (Canvas Size), "Export Background" (Export As), "Grid Color" (Grid settings).

Targets:

| Checklist line | Opens from | Live preview while open | OK | Cancel |
|---|---|---|---|---|
| "Target: Foreground / Background color" | swatches, Brush/Spot Healing "Color" swatch, Shape swatch (`ShapeControls.swift:17`); refused with a mask selected | none (only the picker preview; text being edited previews the foreground) | `setPaletteColor` | restore edited text colors |
| "Target: Text color" | Type bar swatch (`openTextColorPicker`, only with the Type tool) | the text being edited | recolor selection (or set text defaults when nothing is open) and also set the foreground | restore |
| "Target: layer effect color" | Effects panel | `changeEffects` with the working color on every change | keep | put the original back |
| "Target: Gradient Map Shadows / Highlights" | Gradient Map panel | `updateFilter` | keep | original |
| "Target: Vignette color" | Vignette panel | `updateFilter` | keep | original |
| "Target: Dither / Scanlines dark and light colors" | Dither / Scanlines panels | `updateFilter` | keep | original |
| "Target: dialog colors" | `DialogColorSwatch` (34x18 like the brush swatch) | the dialog follows the working color | keep | original; the picker closes **with commit** when the dialog disappears (`ColorPickerSheet.swift:211-216`) and has no canvas sampling |
| "Brush / Shape header swatches" | open the foreground picker (`BrushControls.swift:109`, `ShapeControls.swift:17`) | | | |

Board status (`media/picker.js`) and changes needed for parity:
1. Move OK/Cancel to the right of the 64x64 preview at the top (the board has them in a row at the bottom), add the
   title-bar close button that cancels.
2. Commit `quantized` values: round each channel `Math.round(v * 255) / 255` before `onCommit` (Swift `.rounded()` and
   `Math.round` agree for non-negative values).
3. `rgbToHsv` must keep the previous **saturation** for black (`if (max > 0) s = d / max`), not reset it to 0.
4. Marker style (12 pt circle, white 1.5 inside + black 0.75 outside) and two hue arrows (triangles) instead of one.
5. Mask selected: swatch click opens the black/white popover, the picker never opens, and an open picker cancels.
6. Return in the hex field: upstream applies the hex on submit; whether AppKit also fires the OK key equivalent from a
   focused field was not verified. The board's current behaviour (apply the field, then commit) keeps the typed value,
   which is the safe choice.

---

## 8. Engine API to add

All operations follow the existing pattern (`engine/Sources/SelectionOps.swift` `withSession` / `configure` /
`outcome`): load the saved project into a fresh `EditorSession`, set the board's state, call upstream methods, save if
the document changed, answer `{saved, editName, error, selection, activeLayerID, ...}`. The extension flushes the
board's unsaved strokes first (`runEngine`, `stateless: false`) and turns a save into one external undo step named
`editName`. Put them in a new `engine/Sources/PaintOps.swift` and route from `EngineOperations.run`.

Common arguments (already read by `session()` / `configure()`): `project`, `activeLayerID`, `selection`,
`isMaskSelected`, `foreground` `[r,g,b]` 0...1, `background`, `maskPaintWhite`.

Important: `configure()` sets `session.foregroundColor`, which writes `brushSettings.red/green/blue`
(`ColorPalette.swift:21-24`). Build the new `BrushSettings` from `session.brushSettings` after `configure()` so the color is
kept. Set `session.tool` directly (not `selectTool`, which would swap parked tips and resolve pending edits).

### 8.1 `paint.stroke`

Arguments:

| key | type | meaning |
|---|---|---|
| `tool` | `"brush"` \| `"spotHealing"` \| `"cloneStamp"` \| `"smear"` | `NavigationTool` `.brush/.spotHealing/.cloneStamp/.blur` |
| `mode` | `"Paint"` \| `"Erase"` | Brush only (`brushMode`) |
| `healingType` | `"Content-Aware"` \| `"Create Texture"` \| `"Proximity Match"` | `spotHealingMode` |
| `smearMode` | `"Liquify"` \| `"Blur"` \| `"Smudge"` | `blurMode` |
| `diameter`, `hardness`, `opacity` | numbers (px, 0...1, 0.01...1) | `brushSettings` |
| `smoothing` | 0...100 | Brush only |
| `zoom` | device px per document px | `viewport.setZoom(zoom, anchoredAt: .zero, documentSize:)`; used only by smoothing |
| `blurRadius` | 0.5...50 | Blur |
| `aligned`, `sampleAllLayers` | bool | `cloneSettings` |
| `cloneSource` | `[x, y]` | `cloneSource` (required for Clone Stamp) |
| `cloneOffset` | `[dx, dy]` or absent | `cloneOffset` (the aligned offset from the previous stroke) |
| `points` | `[[x, y], ...]`, ≥ 1 | exactly the points the canvas would pass: press (Shift-click: last stroke end, then the click), each drag point after the axis lock, then the raw release point |

Body:

```swift
session.tool = tool
session.brushMode = mode == "Erase" ? .erase : .paint
session.spotHealingMode = SpotHealingMode(rawValue: healingType) ?? .contentAware
session.blurMode = BlurToolMode(rawValue: smearMode) ?? .liquify
var s = session.brushSettings          // keeps configure()'s foreground
s.diameter = diameter; s.hardness = hardness; s.opacity = opacity; s.smoothing = smoothing; s.blurRadius = blurRadius
session.brushSettings = s
session.viewport.setZoom(zoom, anchoredAt: .zero, documentSize: document.size)
session.cloneSettings = CloneSettings(aligned: aligned, sampleAllLayers: sampleAllLayers)
session.cloneSource = cloneSource; session.cloneOffset = cloneOffset
session.beginBrush(at: points[0])
if session.brushStroke != nil || session.warpStroke != nil {
    for p in points.dropFirst() { session.continueBrush(at: p) }
    _ = session.finishBrushImmediately()        // synchronous: heal / warp commit / commitPaintSnapshot
}
// answer: outcome(...) plus "cloneOffset": [session.cloneOffset.width, .height] for Clone Stamp
```

- Refusals come back as `error` (the exact `brushError` text, 1.5); Spot Healing / Clone Stamp on a mask come back
  `saved: false` with no error.
- `editName` is the upstream undo name (1.5 / section 0).
- Deterministic for Brush, Clone Stamp, Blur, Smudge, Liquify (GPU float32 on the same Mac); Spot Healing is not.
- Brush strokes on 8-bit pixel layers stay in JS (`brush.md`); use this op for mask strokes, 16-bit layers and as an
  oracle in tests.
- Alternative for Brush: send the board's post-smoothing samples with `smoothing: 0` and the final release appended;
  the raw form above is preferred because it reproduces the release handling of `finishBrushImmediately`
  (`EditorSession+Brush.swift:143-146`).

### 8.2 `paint.gradient`

Arguments: `shape` (`"Linear"`/`"Radial"`), `colors` (`"Foreground to Background"`/`"Foreground to Transparent"`),
`reverse` (bool), `opacity` (0.01...1), `start`, `end` (`[x, y]` document points), plus the common ones.

```swift
session.tool = .gradient
session.gradientSettings = GradientSettings(shape: GradientShape(rawValue: shape) ?? .linear,
                                            style: GradientStyle(rawValue: colors) ?? .foregroundToTransparent,
                                            reversed: reverse, opacity: min(1, max(0.01, opacity)))
session.beginGradient(at: start)
guard session.gradientEdit != nil else { return }       // brushError holds the refusal or the budget error
session.moveGradient(end: end)
await session.commitGradient()                          // async (BrushCommit actor); no-op when |end - start| < 0.5
```
Answer `editName` "Gradient" or "Gradient Mask".

### 8.3 `color.sample`

`{point: [x, y]}` → `{color: [r, g, b] | null, hex}` from `session.sampleCompositeColor(at:)`. Needs the flushed project
(`stateless: false`). Used to refine Eyedropper / picker samples where the board composite is not exact.

### 8.4 Optional: `paint.blurSample`

`{layerID, isMaskSelected, blurRadius}` → a PNG of the softened sample (`blurSample(for:)` on a `makeRasterEdit` stroke)
and its `placed` rect in grid pixels, so the board's Blur preview can use Compositor's own Gaussian. Only worth it if the
JS Gaussian preview looks wrong; costs one round trip at stroke start.

### 8.5 `paint.limits` (stateless)

`{documentPixelBudget, documentBudgetMegapixels, maxSide: 30000, maxSurfacePixels: 200000000, maxBrushDiameter: 2100}`
from `DocumentLimits` and `BrushStroke.maxDiameter`, so the board's budget and error text match this Mac.

### 8.6 Sequencing on the board

Upstream commits synchronously, so the next stroke always starts on the committed pixels. With the engine:
1. On release, keep the preview override for the layer, send the request, and treat the document as busy (dim headers
   after 250 ms, as `showsBusy`).
2. Do not start another edit that writes the document (JS Brush commit, another engine op, save) until the answer has
   been applied (`pushExternal` reloads the saved images); otherwise a flush could write the board's stale pixels over
   the engine's result. A press while busy does nothing, as upstream's press waits while `isProjectBusy`.
3. On `error`: show the "Couldn’t paint" alert, drop the preview. On `saved: false` without error: drop the preview.
4. Possible later improvement: queue engine-only strokes (Clone, Heal, Smear) with stacked previews, since a commit by
   points does not depend on the preview's base; still keep JS writes out of the queue window.

---

## 9. Not applicable in VS Code / adaptations

- **Option** is Alt in the webview; macOS Option-click sets the clone source (Alt-click), Option eyedropper is Alt-hold.
  Right-drag resize needs `contextmenu` prevented.
- **Hidden cursor** for Clone Stamp: CSS `cursor: none`; eyedropper: a custom `url()` cursor (6). There is no
  `NSCursor.setHiddenUntilMouseMoves`.
- **Floating NSPanel** → an absolutely positioned, draggable `div` inside the board; it cannot leave the webview; the
  remembered position is per board (upstream: per app session). Picker key remapping (`ShortcutSettings`) has no board
  equivalent; use Return/Escape.
- **Alerts**: an in-webview modal with title "Couldn’t paint" and OK (VS Code notifications would lose the title and
  modality).
- **GPU canvas vs Core Graphics canvas**: upstream shows Core Image previews on the GPU canvas; the board previews with
  Canvas 2D / JS kernels. Exactness per tool is in the tables of sections 2.4, 3.6, 4.8, 5.8.
- **Live layer effects while painting**: not applicable until the board renders effects (1.9).
- **16-bit**: the board previews on the 8-bit copy and commits through the engine; **HDR (OpenEXR)** layers stay
  refused on the board (no decoder, no preview).
- **Color Picker targets** for effects, Gradient Map, Vignette, Dither/Scanlines, dialog swatches and Text apply only once
  those panels exist on the board; until then only Foreground/Background (and the Brush/Spot Healing/Shape swatches) open
  it.
- **Spot Healing randomness**: two commits of the same stroke differ; tests must compare statistics, not pixels.
- **Pixel budget** depends on the machine's RAM; compute it as 1.6 or ask `paint.limits`.

---

## 10. Test vectors

### 10.1 Weights, spacing and offsets (deterministic)

- `weight(u, h)`: (0.5, 0.3) → 0.801749; (0.75, 0.3) → 0.291545; (0.9, 0) → 0.028; (0.5, 0) → 0.5;
  (0.99, 0.98) → 0.5; (0.5, 0.98) → 1; any u ≥ 1 → 0.
- Dab spacing `max(1, d·0.025)` Liquify / `max(1, d·0.005)` Smudge / commit thinning `max(1, d·0.05)`:
  d = 40 → 1 / 1 / 2; d = 200 → 5 / 1 / 10; d = 1000 → 25 / 5 / 50; d = 2000 → 50 / 10 / 100. Radius r: d = 40 → 20,
  d = 41 → 21.
- Liquify single dab, strength 1, travel (4, 0), first push: every pixel with `u ≤ hardness` takes **exactly** the
  original color 4 px to its left (`moved = 0 − (4, 0)`, integral, so the bilinear sample is a copy); with strength 0.5,
  2 px. Offsets there become (−4, 0) / (−2, 0).
- Smudge one pixel: `under = 100`, `held = 200`, `w = 1`, strength 0.5 → `painted = 150`, stored 150, carried 150.
- Clone offset: source (15, 20), press (60, 20) → (−45, 0); source (10, 10), press (12.5, 9.5) → (round(−2.5),
  round(0.5)) = (−3, 1) (half away from zero).

### 10.2 Clone Stamp (`CloneStampTests.swift:22-62`)

80x40 document, one layer: left half red (x 0...39), right half blue, green square x 10-19, y 15-24. Clone Stamp,
`BrushSettings(diameter: 6, hardness: 1)` (black), stroke = press P then P + (0.5, 0) then finish.
1. No source: press (60, 20) → no stroke, error `Option-click where Clone Stamp should copy from first.`
2. Source (15, 20), stroke at (60, 20) → one undo step; pixel (60, 20) = [0, 255, 0, 255]; (70, 5) = [0, 0, 255, 255].
3. Aligned (offset stays (−45, 0)), stroke at (66, 20) → (66, 20) = [255, 0, 0, 255] (copied from (21, 20)).
4. `aligned = false`, stroke at (50, 10) → (50, 10) = [0, 255, 0, 255] (starts at the source again).

### 10.3 Gradient (`GradientTests.swift`, tolerance ±3, radial ±5)

101x4 document, blank layer, Foreground to Background, black → white:
- Linear (0.5, 2) → (100.5, 2): x 0 ≈ [0,0,0,255], x 100 ≈ [255,255,255,255], x 50 ≈ 128 with R = G, A = 255; one undo
  step; undo restores the blank layer.
- Radial on 101x101, (50.5, 50.5) → (90.5, 50.5): center ≈ black; (70,50), (30,50), (50,70), (50,30) ≈ 128 (±5) and
  within 1 of each other; (100, 50) and (0, 0) ≈ white.
- Reverse + opacity 0.5: x 0 alpha ≈ 128 with R ≈ alpha (white at 50 %), x 100 R ≈ 0, alpha ≈ 128.
- Foreground to Transparent over solid red (first a red F→B line from (100.5,2) to (101,2) fills everything before the
  start), then black F→T (0.5,2) → (100.5,2): x 0 ≈ black opaque, x 100 ≈ red, x 50 R ≈ 128, G = 0, A = 255.
- Click without a drag → nothing pending; Cancel → document unchanged; ⌘Z with pending → discarded, document unchanged.
- Redrag replaces the pending line (no accumulation): (0.5→100.5) then (100.5→0.5) → x 0 ≈ white, x 100 ≈ black.
- **[measured]** dither bounds for the board's comparison: 512 px linear ramps ±1; 64 px black→white ±2; radial
  R = 200 ±2, R = 40 up to +4/−3.

### 10.4 Gradient on a mask (`GradientTests.swift:128-143`)

Opaque black layer, `addLayerMask(revealing: true)`, mask selected, black → white (default mask colors) (0.5,2) →
(100.5,2): rendered alpha x 0 ≈ 0, x 100 ≈ 255, x 50 ≈ 128.

### 10.5 Spot Healing (statistical, `SpotHealingTests.swift`)

120x80 vertical gray stripes (100 and 112, 2 px wide), red blemish x 55-64, y 35-44; diameter 24, hardness 1, click at
(60, 40) + (0.5, 0): for every mode, pixels (60,40), (56,36), (64,44) have `R − G < 30`, `G` in 80...130, alpha 255;
pixels (10,10), (90,40), (30,40), (60,10), (60,70) unchanged; one undo step. On the 320x200 "ridge" scene with a red disc
(radius 22), Content-Aware's mean absolute error inside the disc is < 12 levels and less than half Proximity Match's.

### 10.6 Blur (`BlurBrushTests.swift`)

200x100, black left half, white right half; Smear Blur, hardness 1, strength 1, stroke (100,20) → (100,80): the number of
columns on row 50 with 10 < value < 245 is more than twice as large at Radius 12 as at Radius 2, and identical for
diameter 60 and 80 at Radius 12.

### 10.7 Smudge / Liquify (`MetalWarpTests.swift`)

- Liquify, d 60, h 0.3, strength 0.7, stroke x 60 → 200 → 60 step 4 at y 100 on a 300x200 image: the mean absolute
  change from the original is less than half of the CPU (pixel-resampling) path's.
- Smudge, d 40, h 0.5, strength 0.6, a white 16 px dot at (60, 50) on 0.1 gray, stroke x 60 → 240 step 3: along row 50
  (x 70...239) no "ghost" peaks (`row[i] > row[i±2] + 2`), and `row[70] > row[239] + 20`.

### 10.8 Color

- `PaletteColor(hex:)`: "#FF8000" → (1, 128/255, 0); "0f0" → (0, 1, 0); " 00ff00 " → (0, 1, 0); "12345" → nil;
  "GGGGGG" → nil; (1, 128/255, 0).hex = "FF8000".
- `PickerHSB(color).rgb.quantized.hex` round-trips 000000, FFFFFF, FF0000, 00FF00, 0000FF, FF8000, 7F3FA2, 123456.
- From FF8000, `setRGB(808080)` keeps the hue, saturation 0; then `saturation = 0.5; setRGB(black)` keeps hue and
  saturation 0.5, brightness 0.
- HSB (30°, 1, 1) → (1, 0.5, 0) → quantized FF8000.
- `sampleCompositeColor` un-premultiply: premultiplied (64, 0, 0, 128) → 64/128·255 = 127.5 → 128 → "800000".
- 4x4 document, top two rows red, bottom two blue: sample (1.5, 0.5) → FF0000, (1.5, 3.5) → 0000FF, (−1, 1) → nil;
  sampling into an open foreground picker then Cancel leaves the foreground black; background picker + sample (2, 0) +
  OK sets background FF0000 (`ColorPickerTests.swift:31-63`).

---

## 11. Upstream quirks a faithful port inherits

1. A Blur stroke on a mask is recorded as "Paint Mask", not "Blur".
2. Smudge/Liquify previews ignore the selection; the commit is clipped to it.
3. Blur is source-over of the softened copy: it spreads color and alpha outward but never makes an opaque pixel more
   transparent.
4. A click (no drag) on the same target while a gradient is pending discards the pending gradient.
5. Gradient commits crop a pixel layer to its nonzero-alpha bounds, which can shrink layers with transparent margins.
6. The gradient endpoint circles show light gray under a transparent end, not a checkerboard.
7. Spot Healing and Clone Stamp on a selected mask do nothing without any message, while the header still offers the
   mask "Paint" picker.
8. Clone Stamp "This Layer" on a blank layer does nothing, silently.
9. The Smudge/Liquify clamps (≥ 2 px, ≤ 98 % hardness) are not reflected in the options bar.
10. The eyedropper with a mask selected changes the hidden RGB foreground, not the mask paint color.
11. Spot Healing results vary between runs (random seed).
12. Smear's Option key does nothing (no eyedropper, no source).
