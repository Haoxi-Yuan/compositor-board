# Adjustment Layers, Layer Effects and Image-menu Adjustments: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3). `file:line` references are relative to
`upstream/Compositor/` unless they start with `docs/`, `engine/` or `media/` (`vscode-extension/media/`). Code excerpts
from upstream are verbatim; JavaScript blocks are this spec's ports.

Files read in full: `Document/LayerAdjustment.swift` (235 lines), `Document/AdjustmentEditing.swift` (131),
`Document/ImageAdjustments.swift` (210), `Document/Curves.swift` (42), `Document/Levels.swift` (239),
`Document/LevelsAutomatic.swift` (84), `Document/HueSaturation.swift` (647), `Document/LayerEffects.swift` (665),
`Document/PixelInvert.swift` (46), `Document/PixelAdjust.swift` (67), `Rendering/LiveMaskRenderer.swift` (196),
`Rendering/AdjustmentSurface.swift` (34), `Rendering/LevelsPixels.c` (60), `Rendering/NoisePixels.c` (49),
`Rendering/GPUNoise.swift` (171), `Rendering/MetalLayerEffects.swift` (397), `Rendering/LayerEffectsSurface.swift` (192),
`Rendering/EffectsPreviewCache.swift` (164), `UI/FilterSheet.swift` (426), `UI/LevelsSheet.swift` (146),
`UI/HueSaturationSheet.swift` (210), `UI/CurvesControls.swift` (69), `UI/EffectsSheet.swift` (193). Read in part:
`Rendering/AdjustPixels.c:1-207`, `Rendering/GPUCanvas.swift:1-120, 480-657`, `Rendering/EditorCanvas.swift` (GPU
composite `:2785-3233`, CPU adjustment setup `:975-995, 1165-1200`, sampling `:1775-1815, 1895-1910`),
`Rendering/BrushPixels.c:1-51`, `Rendering/SeparableBlend.swift:40-60`, `Document/Filters.swift` (all but Camera Raw),
`Document/ColorPalette.swift:85-260`, `Document/SelectionEdits.swift:70-160`, `Document/DocumentHistory.swift:1-80`,
`Document/EditorSession.swift:1-45, 680-700`, `IO/ImageExporter.swift:20-90`, `UI/LayersPanel.swift`,
`UI/NativeLayerList.swift` (adjustment rows, effect rows), `UI/NumericScrub.swift`, `UI/CameraRawSlider.swift:1-55`,
`CompositorApp.swift:285-395`, `ContentView.swift:225-285, 440-490`, and this repo's `engine/Sources/*.swift`,
`media/render.js`, `media/filters.js`, `media/board.js`, `docs/port-specs/compositing.md`, `manifest.md`,
`selection.md`.

**[verified]** marks results measured on this Mac (Darwin 25.6). A scratch harness wrote small `.comp` projects (a
swatch layer of 2,048 opaque and translucent test colors under one adjustment layer, or a 50x40 shape with effects),
rendered them with this repo's `engine/bin/compositor-engine` `render` op (Compositor's own `ImageExporter.render`,
the export path), decoded the PNGs and compared them, pixel by pixel, with the JavaScript ports printed in this spec
(run in Node 26). A second scratch Swift program checked how `CIColorCube` and `CIColorCurves` interpolate. Both were
deleted afterwards. "Bit-exact" means 0 of 2,048 swatch pixels (or 0 of 12,000 effect pixels) differ in any channel.

---

## 0. Summary of key facts

| Topic | Fact | Ref |
|---|---|---|
| Reference path | Export (`ImageExporter.render` -> `LiveMaskRenderer.adjust`, `LayerEffectsRenderer` -> `MetalLayerEffects`) is what the engine's `render` op runs. The app's own GPU canvas approximates it with lookups (section 1.1). The board should match **export**. | `IO/ImageExporter.swift:25-87`, `Rendering/GPUCanvas.swift:545-656` |
| Adjustment input | Everything composited so far on the **whole document** (or on the clipping-stack surface for a stack child). Folders do not isolate it. | `Rendering/LiveMaskRenderer.swift:39-44` |
| Order per adjustment | kernel -> (non-Normal mode: blend over the original at full coverage, original alpha restored) -> opacity mix `round(o + (a - o) * opacity)` -> drawn back with `.copy` through own mask and folder masks: `round((a*m + o*(255-m))/255)` | `Rendering/LiveMaskRenderer.swift:39-87` [verified] |
| Kernels | Levels, Curves, Exposure (256-entry float tables, linear between entries), Invert, Gradient Map, Black & White, Color Balance (per-pixel C), Hue/Saturation (33x33x33 cube, trilinear), Grain and Add Noise (integer hashes, document-anchored) are portable to JS **bit-exactly** | section 3 [verified] |
| Blurs | Gaussian Blur = Core Image Gaussian, sigma = radius, transparent outside the document (a full-canvas image gets translucent edges). Motion Blur = a Gaussian along the angle with sigma = distance / sqrt(12). A plain JS Gaussian matches within 1.8 levels, the line Gaussian within 3.4 (7.8 on one hard diagonal edge). | section 3.11-3.12 [verified] |
| Effects | Six records, rendered in **layer pixels** on a canvas grown by `ceil(margin) + 2`; the Metal path is plain float math and ports to JS **bit-exactly** | section 5 [verified] |
| Recommendation | (b) Port the math to the board for every kind and every effect (exact except blurs). (a) Engine lookup tables only as a conformance test. (c) Engine pixels only for the Levels histogram of the underlying composite, destructive commits, and the reference render. | section 1.2 |
| Not Codable | `FilterSettings` is not Codable. `LayerAdjustment`, `LevelsSettings`, `CurvesSettings`, `HueSaturationSettings`, `ExposureSettings`, `GradientMapSettings`, `GrainSettings`, `BlackWhiteSettings`, `ColorBalanceSettings` and every effect record **are** Codable (the manifest format, `docs/port-specs/manifest.md` sections 2 and 7) | `Document/Filters.swift:63`, section 10.1 |
| Undo | New layer: "New <Kind> Adjustment". Editor session: one step "Edit <Kind> Adjustment" (none if nothing changed). Effects: **every** change is its own step ("Add Stroke", "Edit Stroke", "Cancel Stroke", "Hide/Show Stroke", "Remove Stroke", "Copy Stroke"). Destructive: "Levels", "Hue/Saturation", "Curves", "Exposure", ... | sections 7-9 |

---

## 1. How the board shows adjustments and effects live

### 1.1 Which upstream path to match

Compositor draws adjustment layers three ways:

1. **Export and merge** (`IO/ImageExporter.swift:70-77` feeding `Rendering/LiveMaskRenderer.swift:39-87`):
   `LayerAdjustment.apply(_:region:scale:)` (`Document/LayerAdjustment.swift:164-204`) runs the CPU kernels on an 8-bit
   premultiplied copy of the composite. This is the engine's `render` op (`engine/Sources/EngineMain.swift:106-117`).
2. **Core Graphics canvas** (`Rendering/EditorCanvas.swift:983-992`, `:1174-1196`): the same `LiveMaskRenderer`, on an
   `AdjustmentSurface` at screen resolution (`adjustmentScale = scale * deviceScale`), so it equals export at 100 %.
3. **GPU canvas** (`Rendering/EditorCanvas.swift:3116-3165`, `Rendering/GPUCanvas.swift:545-601`), used for most
   frames: Levels through `CIColorCurves` (1,024 samples), Hue/Saturation through `CIColorCube` (the same 33-point cube),
   Curves / Black & White / Color Balance / Exposure / Gradient Map / Invert through a 33-point cube **built by running
   the CPU kernel on 8-bit lattice colors** (`GPUAdjustment.cube(for:)`, `:630-656`), blurs through Core Image, Grain
   and Add Noise through Metal ports of the C hashes (`Rendering/GPUNoise.swift:4-8`).

The board should reproduce **path 1** (export), for three reasons:

- It is what the engine renders, so every board frame can be checked against `render`.
- Path 3 is itself an approximation of path 1. [verified] On 20,000 random opaque colors, the GPU canvas's 33-point
  cubes differ from export by at most: Curves 1, Black & White 1, Gradient Map 2, Color Balance 11, **Exposure 14**
  levels (steep shadows), Invert 0. On the GPU canvas Add Noise is one value per *screen* pixel (`GPUNoise.swift:7-8`),
  so it differs from export at any zoom other than 100 %.
- Every path-1 kernel is plain arithmetic that ports to JavaScript bit-exactly (section 3).

For reference, the two Core Image interpolations used by path 3 [verified]: `CIColorCube` is **trilinear** (a cube
whose red output is `r*g*b` at the corners returns `0.125` for `(0.5, 0.5, 0.5)`, where tetrahedral interpolation would
give `0.5`; a 33-point cube of a smooth function matches a trilinear evaluation within 0.48 levels). `CIColorCurves`
is **linear between samples**, sample index `x * (count - 1)` over `inputCurvesDomain` (4 samples `[0, .8, .2, 1]` give
`0.24` at `x = 0.1`, `0.3193` at `x = 0.6`; linear predicts 0.24 / 0.32, the rest is half-float precision).

### 1.2 Per-kind decision

(a) = engine computes a table, board applies it; (b) = board ports the math; (c) = engine renders pixels.

| Kind / effect | Upstream export kernel | Board method | Fidelity vs engine `render` | JS cost (Node 26, this Mac) |
|---|---|---|---|---|
| Levels | 3 x 256 float tables + `levels_apply` | (b) tables in JS (section 3.1); apply through an exact 2-D lookup `[alpha][value]` | bit-exact [verified] | 1.9 ms/MP (2-D lookup), 12 ms/MP direct |
| Curves | tables from monotone Hermite + `levels_apply` | (b) section 3.2 | bit-exact [verified] | as Levels |
| Exposure | one table x 3 + `levels_apply` | (b) section 3.3 | bit-exact [verified] | as Levels |
| Invert | premultiplied `c' = a - c` | (b) section 3.4 | bit-exact [verified] | 1.1 ms/MP |
| Gradient Map | 256 x 3 byte table on integer Rec. 709 luma | (b) section 3.5 | bit-exact [verified] | 3.3 ms/MP |
| Black & White | per-pixel float32 (`adjust_black_white`) | (b) section 3.6 | bit-exact [verified] | 8.4 ms/MP |
| Color Balance | per-pixel float32 (`adjust_color_balance`) | (b) section 3.7 | bit-exact [verified] | 28 ms/MP with the math inlined (94 as printed in 3.7, which allocates small arrays per pixel) |
| Hue/Saturation | 33-point cube built in double, applied trilinear in float32 (`cube_apply`) | (b) build the cube in JS (2.3 ms) and apply it (section 3.8) | bit-exact [verified] | 44 ms/MP; WebGL2 for large documents |
| Grain | `adjust_grain` (hash lattice, smoothstep) | (b) section 3.9; cache the noise field per settings | bit-exact [verified] | 65 ms/MP uncached |
| Add Noise | `noise_add_at` (hash, Box-Muller) | (b) section 3.10 | bit-exact [verified] | 15 ms/MP |
| Gaussian Blur | `CIGaussianBlur` sigma = radius | (b) separable Gaussian, zero outside the document; WebGL2 for large sigma | within 1.8 levels [verified] | O(sigma) per pixel |
| Motion Blur | `CIMotionBlur` radius = distance / sqrt(12) | (b) Gaussian along the angle, sigma = distance / sqrt(12) | within 3.4 levels (7.8 at one hard diagonal edge) [verified] | O(distance) per pixel; WebGL2 |
| Stroke, Drop Shadow, Color Overlay, Inner Shadow, Outer Glow, Inner Glow | `MetalLayerEffects` compute kernels | (b) section 5.3 (per layer, cached, recomputed only where paint changed) | bit-exact [verified] | blur passes dominate: O(blur) per layer pixel |
| Levels histogram of the underlying composite | `ImageExporter.render` of the layers below + `levels_histogram` | (c) engine `levels.histogram` once per editor open (section 10.3); board port as fallback | exact | n/a |
| Destructive Image-menu adjustments | same kernels on the layer's pixels | board previews with (b); OK runs in the engine (c) (16-bit layers, selection blend, undo) | preview bit-exact for 8-bit layers | n/a |

### 1.3 Why the board ports the math rather than asking the engine

- An engine request takes 10-300 ms and needs the project saved first. A slider drag changes the settings every
  frame, and a stroke changes the input every frame. Engine pixels cannot be live.
- Every lookup table is a few hundred to 36,000 entries of double-precision math (the Hue/Saturation cube takes 2.3 ms
  in JS). Shipping it from the engine saves nothing and adds a round trip.
- The JavaScript in section 3 reproduces the engine's output exactly, including its float32 rounding, so there is no
  fidelity reason to prefer engine tables. Keep an engine op that returns the tables (`adjustment.lut`, section 10.6)
  for a conformance test.

### 1.4 Pixel access in Canvas 2D

Compositor's kernels read **premultiplied** 8-bit RGBA (`BrushRaster.context`, `Document/BrushStroke.swift:35-41`) and
each unpremultiplies in its own way (sections 3.x). Canvas 2D `getImageData` returns **straight** 8-bit color. Rebuild
the premultiplied bytes, run the kernel, convert back, `putImageData`:

```js
// Straight -> premultiplied, as Core Graphics stores a pixel drawn at alpha a: p = round(s * a / 255).
function toPremultiplied(d) {           // d: Uint8Array copy of ImageData.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    d[i] = Math.round(d[i] * a / 255); d[i + 1] = Math.round(d[i + 1] * a / 255); d[i + 2] = Math.round(d[i + 2] * a / 255);
  }
  return d;
}
function toStraight(p, out) {           // out: ImageData.data
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    for (let c = 0; c < 3; c++) out[i + c] = a ? Math.min(255, Math.round(p[i + c] * 255 / a)) : 0;
    out[i + 3] = a;
  }
}
```

- The round trip is lossless when the browser's unpremultiply rounds to nearest: `s = round(p*255/a)` gives
  `round(s*a/255) = p` for every `p <= a < 255` (the error `0.5*a/255` stays under one half). Opaque pixels, the
  common case, never change. Check Chromium's rounding once in the webview with a translucent ramp.
- **Do the kernel math in `Uint8Array`, never `Uint8ClampedArray`.** Assigning a fraction to a clamped array rounds
  half to even (2.5 -> 2), while the C code uses `roundf` (half away from zero), `lroundf`, `(int)(x + 0.5)` or integer
  `(x + 127) / 255` in different places. Every port below rounds explicitly.
- The composite the board feeds an adjustment differs from Core Graphics' by up to 1-2 levels where blend modes are
  involved (`docs/port-specs/compositing.md` section 5.1). The adjustment then transforms that small difference; steep
  curves can widen it.

### 1.5 Renderer changes (`media/render.js`)

The current renderer skips adjustment layers (`render`, `:323`; `drawStack`, `:290`) and draws a layer with effects as
plain pixels. Changes:

1. **Adjustment step in draw order.** In `render()`, a record with `adjustment` and no `maskSourceID` calls
   `drawAdjustment(ctx, record, info, region)` (section 2.8). A record with `adjustment` **and** `maskSourceID` that is
   not a stack child is skipped (section 2.6). In `drawStack`, an adjustment child calls `drawAdjustment` on the stack
   surface (own mask only, no folder masks).
2. **Effects as the layer's source.** `source(record)` returns the effects image (section 5) when the record has valid
   visible effects: `{ canvas: effects.canvas, toDocument: pixelToDocument(grown, W, H), transform: grown, masked: true }`
   with `grown` from `LayerEffectsRenderer.placed` (section 5.2). When `masked` is set, `drawLeaf`, `drawStack` and
   `drawCoverage` must **not** apply the layer's own mask again (export passes `mask: nil`, `IO/ImageExporter.swift:57`).
   Coverage of a clipping source then includes its effects, as upstream (`Rendering/LiveMaskRenderer.swift:180-195`).
3. **`unrendered()`** (`:306-316`) stops listing adjustments and effects (keep HDR).
4. **Region rendering.** `render(ctx, { region })` restricts every draw (a clip rect) and every `getImageData` to
   `region`. Needed for live painting and dragging (section 1.6).

### 1.6 Staying live: caches, regions, budgets

The board already caches `below` (everything under the live layer, `media/board.js:776-784`) and re-renders the rest
each frame. Add:

| Situation | What changes per frame | What to recompute |
|---|---|---|
| Painting or moving a layer **above** every adjustment | the live layer | nothing new: `below` already holds the adjusted result |
| Painting or moving a layer **below** an adjustment | the live layer's dirty rect `D` (stroke tiles changed since the last frame, or old union new bounds for a move, plus its effects margin) | render layers `[split, end)` only inside `R = D` grown by the **sum** of `samplingMargin`s of the blur adjustments above (Gaussian `3*radius + 2`, Motion `distance/2 + 2`, `Document/LayerAdjustment.swift:121-127`), run each adjustment's kernel on `R` only, copy back `D`. Upstream uses the max (`Rendering/EditorCanvas.swift:986-988`); with two blurs in a row the sum is the exact halo. |
| Dragging an adjustment's slider | the adjustment's settings | cache `input[adjID]` = the composite just before this adjustment (premultiplied bytes) when its editor opens; per change: kernel on the cached input, mix, write, then draw the layers above. Coalesce: if a pass is running, keep only the newest settings (upstream does the same, `Document/Filters.swift:790-844`) |
| Painting a layer **with effects** | its pixels in `D` | effects only in a window around `D` (section 5.5) |
| Changing an effect's settings | that layer's effects image | rebuild it (Worker), keep showing the previous image until the new one is ready (upstream `Rendering/EffectsPreviewCache.swift:99-110`) |
| Moving, scaling or rotating a layer with effects | placement only | reuse the cached effects image; only the grown transform changes (`EffectsPreviewCache.swift:25-27`) |

Per-pixel kinds (everything but the blurs) are pointwise, except that Grain and Add Noise also read the pixel's
document position: pass the region's document origin (sections 3.9, 3.10). Budget guide at 4 MP: 2-D-lookup kinds ~8 ms
plus `getImageData`/`putImageData`; Hue/Saturation ~180 ms full frame in JS, so use regions or WebGL2 while painting.

### 1.7 Accelerators, and why no WebAssembly

- The C kernels (`Rendering/AdjustPixels.c`, `LevelsPixels.c`, `NoisePixels.c`) could become WebAssembly, but this Mac
  has no `wasm-ld`/`emcc`, and the JS ports are already bit-exact. **No WebAssembly is needed.**
- **Web Worker** (from a `blob:` URL; the webview CSP must allow `worker-src blob:`): effects images, Hue/Saturation
  full frames and blurs off the UI thread, with the coalescing rule above.
- **WebGL2** (optional, phase 2): every kernel here maps to GLSL ES 3.00 (`uint` arithmetic wraps mod 2^32, so the
  hashes port; do trilinear by hand with `texelFetch` on an `RGBA32F` 3-D texture, which needs no float-filtering
  extension; round with `floor(x + 0.5)`, since GLSL `round` is implementation-defined at .5). Float32 shader math
  can differ by one level at rounding boundaries; measure it against the JS reference. Uploading a 4 MP software canvas
  and reading it back costs roughly 10-20 ms whatever the kernel, so WebGL2 pays off for Hue/Saturation, blurs and
  effect blurs, not for the lookup kinds.

---

## 2. Where an adjustment layer applies (scope and order)

All formulas in this section were [verified] bit-exact against the engine on opaque and translucent pixels.

### 2.1 Draw order and visibility

Adjustment layers are ordinary records in the draw list (`LayerHierarchy.visibleLayers`,
`docs/port-specs/compositing.md` section 2): pre-order through folders, drawn only if the record and every ancestor
folder are visible. A hidden adjustment does nothing.

### 2.2 Input

```swift
private func adjust(_ id: UUID, in context: CGContext) {
    guard let settings = adjustment(id), let original = context.makeImage() else { return }
    let region = adjustmentRegion?(bounds) ?? bounds, scale = adjustmentScale
    let deep = sixteenBit && original.bitsPerComponent == 16
    guard var adjusted = try? deep ? settings.applySixteenBit(original, region: region, scale: scale)
                                   : settings.apply(original, region: region, scale: scale) else { return }
```
(`Rendering/LiveMaskRenderer.swift:39-44`.) `original` is the **whole document composite so far**, not the folder's
contents: folders are pass-through. [verified] An Invert inside a folder at 50 % opacity inverts the layer outside the
folder below it, at 50 %. `docs/project-format.md:29` says "within their folder"; the code says otherwise.

### 2.3 Kernel

`settings.apply(original, region:, scale:)` (`Document/LayerAdjustment.swift:164-204`), section 3. In export,
`region` = the document rect and `scale` = 1.

### 2.4 Blend mode (not Normal)

```swift
if blendMode(id) != .normal {
    // Blend colors at full coverage, then restore the original alpha.
    // Source-over of two translucent copies would thicken soft edges.
    ...
    layer_extract_alpha(pixels, base.bytesPerRow, coverage, alpha.bytesPerRow, w, h)
    layer_unpremultiply_opaque(pixels, base.bytesPerRow, w, h)
    layer_unpremultiply_opaque(top.data!.assumingMemoryBound(to: UInt8.self), top.bytesPerRow, w, h)
    guard let foreground = top.makeImage() else { return }
    // Core Graphics has no Linear Dodge and the like, and gets Color Burn and Dodge wrong (see SeparableBlend).
    if !SeparableBlend.blend(foreground, over: base, mode: blendMode(id)) {
        base.setBlendMode(blendMode(id).cgMode)
        ...
        base.draw(foreground, in: rect)
    }
    layer_restore_alpha(pixels, base.bytesPerRow, coverage, alpha.bytesPerRow, w, h)
```
(`Rendering/LiveMaskRenderer.swift:46-71`; helpers `Rendering/BrushPixels.c:23-51`.) Per pixel, with `o` the original
premultiplied pixel and `t` the adjusted one:

```
b = a_o ? min(255, (o_c*255 + a_o/2) / a_o) : 0        (integer division; transparent -> black)
s = a_t ? min(255, (t_c*255 + a_t/2) / a_t) : 0
v = round(255 * B(b/255, s/255))                         (opaque over opaque; B from compositing.md 5.1/5.3)
out_c = (v * a_o + 127) / 255,  out_a = a_o               (integer division)
```

In Canvas 2D: build two opaque canvases (`b` and `s` with alpha 255), composite `s` over `b` with the existing
`composite(..., mode, 1)` (native or `blendPixels`), read back, restore alpha with `(v*a + 127) / 255`. Consequences:
the adjusted alpha is discarded, so a Gaussian Blur adjustment in Multiply mode does not spread past the original
coverage; and a no-op adjustment in a mode still blends the composite with itself (a Levels layer at identity in
Multiply darkens: `b*b`).

### 2.5 Opacity

```swift
let opacity = adjustmentOpacity(id)
let image: CGImage
if opacity < 1 {
    let blend = CIImage(cgImage: adjusted).applyingFilter("CIBlendWithMask", parameters: [
        kCIInputBackgroundImageKey: CIImage(cgImage: original),
        kCIInputMaskImageKey: CIImage(color: CIColor(red: opacity, green: opacity, blue: opacity)).cropped(to: CIImage(cgImage: original).extent)])
```
(`Rendering/LiveMaskRenderer.swift:72-82`.) Rendered by `PixelAdjust.ciContext`, which has no color management
(`Document/PixelAdjust.swift:8`), so it is a lerp on premultiplied bytes: `out = round(o + (t - o) * opacity)` per
channel, alpha included [verified; `floor` instead of `round` is off by up to 64]. `opacity` is the **effective**
opacity: the layer's own times every ancestor folder's (`docs/port-specs/compositing.md` section 4).

### 2.6 Own mask, folder masks, clipping

```swift
context.saveGState()
adjustmentClip(id, context)
BrushRaster.draw(image, in: bounds, mask: false, context: context)
context.restoreGState()
```
(`Rendering/LiveMaskRenderer.swift:83-86`.) `BrushRaster.draw` is a `.copy` draw (`Document/BrushStroke.swift:87-89`)
inside the clip, so with clip coverage `m` (0-255): `out = round((t*m + o*(255 - m)) / 255)`, all four channels
[verified]. The clip is:

- the adjustment's own enabled mask, stretched over the **layer's `transform`** (`maskPlacement` ignored), coverage 0
  outside that rect (`IO/ImageExporter.swift:73-77`, `FolderMaskClip.apply`);
- times every ancestor folder's enabled mask, for an adjustment drawn at top level (`FolderMaskClip.draw` wraps
  `drawComposite`, `IO/ImageExporter.swift:80-84`). A stack child gets only its own mask; folder masks apply to the
  whole stack afterwards.

Opacity is applied before the mask, so the two multiply: `out = o + (t - o)*opacity*m/255` up to rounding [verified,
sequentially rounded as written].

Clipping (`Rendering/LiveMaskRenderer.swift:105-110`, `:93`):

- An adjustment **cannot be a base**: `prepareStacks` skips bases with an adjustment, and `LiveMaskGraph` rejects
  `maskSourceID` pointing at an adjustment (`docs/port-specs/manifest.md` section 9.4).
- An adjustment **in a clipping stack** (visible base directly below, same parent, `maskSourceID == base`) adjusts the
  stack surface only: the base made opaque, the children so far (`:131-133`). [verified] It never touches what lies
  below the base. The stack surface is **document-sized** and opaque black outside the base, so a blur inside a stack
  pulls black in at the base's edges; the board's `drawStack`, which works on the base's bounding box, must pad its
  surface by the blur's `samplingMargin` (filled opaque black) for blur children.
- An adjustment with `maskSourceID` that is **not** in a stack (its base hidden, or another layer between them) is
  **skipped entirely** [verified].

### 2.7 Placement, spatial kinds, noise anchoring

- The adjustment's `transform` only places its mask; the adjustment covers the whole document. New adjustment layers
  get `origin (0, 0)`, `size` = canvas (`ImageLayer(name:blankSize:)`, `Document/EditorSession.swift:36-41`).
- Blurs read past the region they write: Gaussian `3*radius + 2`, Motion `distance/2 + 2` document pixels
  (`samplingMargin`). Outside the **document** they read transparent (the composite is document-sized and the blur is
  not clamped, `Document/Filters.swift:261-263`, `Rendering/GPUCanvas.swift:586`). [verified] A Gaussian Blur
  adjustment over a full-canvas opaque image makes the corner pixel about 27 % opaque (alpha 69 at radius 10).
- Grain and Add Noise depend on the pixel's document position (export: origin (0, 0), one unit per pixel), so a region
  render must pass its document origin.

### 2.8 Board implementation (`drawAdjustment`)

```js
// target: the document composite (or a stack surface); region: integer rect in target pixels;
// docOrigin: target pixel (0,0) in document pixels (0,0 for the document composite).
function drawAdjustment(target, record, info, region, docOrigin = { x: 0, y: 0 }, inStack = false) {
  const img = target.getImageData(region.x, region.y, region.width, region.height);
  const orig = toPremultiplied(new Uint8Array(img.data));
  let out = orig.slice();
  runKernel(record.adjustment, out, region.width, region.height,
            { x: docOrigin.x + region.x, y: docOrigin.y + region.y });            // section 3
  const mode = record.blendMode || 'Normal';
  if (mode !== 'Normal') out = blendAtFullCoverage(orig, out, mode);               // 2.4
  const o = info.opacityOf(record);                                              // effective opacity
  if (o < 1) for (let i = 0; i < out.length; i++) out[i] = Math.round(orig[i] + (out[i] - orig[i]) * o);
  const m = adjustmentCoverage(record, info, region, inStack);                   // own mask x folder masks; null = all 255
  if (m) for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    const k = m[p];
    if (k === 255) continue;
    for (let c = 0; c < 4; c++) out[i + c] = Math.round((out[i + c] * k + orig[i + c] * (255 - k)) / 255);
  }
  toStraight(out, img.data);
  target.putImageData(img, region.x, region.y);
}
```

`adjustmentCoverage`: a region-sized canvas, `fillRect` opaque, then `destination-in` the mask alpha canvas placed at
`record.transform` (`applyMask`, `media/render.js:143-151`) and, unless `inStack`, each ancestor folder's mask at the
folder's transform (`applyFolderMasks`); read its alpha channel. Kinds that change nothing skip the whole function:
Levels at identity (`LevelsFilter.run` returns the input, `Document/Levels.swift:66`), Color Balance at identity
(`ImageAdjustments.swift:167`), Grain at amount 0 (`:203`); but with a non-Normal mode the blend still runs (2.4).

---

## 3. Adjustment kernels, exact math

Conventions: `p` is a premultiplied RGBA `Uint8Array`, row-major, top row first. `f32 = Math.fround` reproduces C
`float` arithmetic; where the Swift side computes in `Double`, the port uses plain JS numbers. Every block here is the
code that was [verified] bit-exact against the engine.

### 3.1 Levels

```swift
func apply(_ value: Double) -> Double {
    let s = normalized
    let input = min(1, max(0, (value * 255 - s.black) / (s.white - s.black)))
    return (s.outputBlack + pow(input, 1 / s.gamma) * (s.outputWhite - s.outputBlack)) / 255
}
...
/// Individual channels, followed by the composite RGB adjustment.
func apply(_ value: Double, channel: LevelsChannel) -> Double {
    ranges[0].apply(ranges[channel.index].apply(value))
}
```
(`Document/Levels.swift:26-30`, `:41-43`; `normalized` `:14-25`: black 0...254, white (black+1)...255, gamma
0.1...9.99, outputs 0...255.) Tables: `(0...255).map { Float(settings.apply(Double($0) / 255, channel: c)) }` for red,
green, blue (`:68-70`), applied by `levels_apply` (`Rendering/LevelsPixels.c:3-16`):

```c
float x = fminf(255, p[channel]*255.0f/alpha);
int lo = (int)x, hi = lo < 255 ? lo+1 : 255;
const float *table = tables + channel*256;
float result = table[lo] + (table[hi]-table[lo])*(x-lo);
p[channel] = (uint8_t)fminf(alpha, fmaxf(0, roundf(result*alpha)));
```

```js
const f32 = Math.fround;
function clampN(n, lo, hi, fb) { return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb; }
function normalizedRange(r) {
  const black = clampN(r.black, 0, 254, 0);
  return { black, white: clampN(r.white, black + 1, 255, 255), gamma: clampN(r.gamma, 0.1, 9.99, 1),
           outputBlack: clampN(r.outputBlack, 0, 255, 0), outputWhite: clampN(r.outputWhite, 0, 255, 255) };
}
function rangeApply(r0, v) {
  const s = normalizedRange(r0);
  const input = Math.min(1, Math.max(0, (v * 255 - s.black) / (s.white - s.black)));
  return (s.outputBlack + Math.pow(input, 1 / s.gamma) * (s.outputWhite - s.outputBlack)) / 255;
}
function levelsTables(levels) {               // levels.ranges: [RGB, Red, Green, Blue]
  const t = new Float32Array(768);
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++)
    t[c * 256 + i] = rangeApply(levels.ranges[0], rangeApply(levels.ranges[c + 1], i / 255));
  return t;
}
function levelsApply(p, tables) {             // levels_apply; also used by Curves and Exposure
  for (let i = 0; i < p.length; i += 4) {
    const alpha = p[i + 3];
    if (!alpha) continue;
    for (let c = 0; c < 3; c++) {
      const x = f32(Math.min(255, f32(f32(p[i + c] * 255) / alpha)));
      const lo = Math.trunc(x), hi = lo < 255 ? lo + 1 : 255;
      const t0 = tables[c * 256 + lo], t1 = tables[c * 256 + hi];
      const result = f32(t0 + f32(f32(t1 - t0) * f32(x - lo)));
      p[i + c] = Math.min(alpha, Math.max(0, Math.round(f32(result * alpha))));
    }
  }
}
```

Fast exact path: the output of `levelsApply` for a channel depends only on `(value, alpha)`, so precompute
`lut[c][alpha][value]` (3 x 65,536 bytes, 2.9 ms) with `levelsApply` itself and look pixels up (7.8 ms per 4.2 MP
[measured]). Identity (`isIdentity`: every range normalizes to the default) returns the input unchanged.

### 3.2 Curves

```swift
/// Shape-preserving cubic Hermite interpolation avoids overshoot between handles.
func value(_ x: Double, channel: Int) -> Double {
    let p = channels[channel]
    let i = min(p.count - 2, max(0, p.lastIndex(where: { $0.x <= x }) ?? 0))
    let d = zip(p, p.dropFirst()).map { ($1.y - $0.y) / ($1.x - $0.x) }
    func slope(_ j: Int) -> Double {
        if j == 0 { return d[0] }
        if j == p.count-1 { return d.last! }
        if d[j-1] * d[j] <= 0 { return 0 }
        return 2 / (1/d[j-1] + 1/d[j])
    }
    let h = p[i+1].x-p[i].x, t = min(1, max(0, (x-p[i].x)/h))
    let y = (2*t*t*t-3*t*t+1)*p[i].y + (t*t*t-2*t*t+t)*h*slope(i)
        + (-2*t*t*t+3*t*t)*p[i+1].y + (t*t*t-t*t)*h*slope(i+1)
    return min(255, max(0, y))
}
...
let table = (1...3).flatMap { channel in (0...255).map { Float(value(value(Double($0), channel: channel), channel: 0)/255) } }
levels_apply(ctx.data!.assumingMemoryBound(to: UInt8.self), image.width*image.height, table)
```
(`Document/Curves.swift:17-38`.) Channel 0 is RGB, 1-3 red, green, blue: the channel's own curve first, then RGB.
Points are doubles in 0...255 (the editor does not round them). The slope at an interior point is the harmonic mean of
the neighbouring secants, 0 where they change sign (Fritsch-Carlson style, no overshoot).

```js
function curveValue(p, x) {
  let last = -1;
  for (let k = 0; k < p.length; k++) if (p[k].x <= x) last = k;
  const i = Math.min(p.length - 2, Math.max(0, last));
  const d = [];
  for (let k = 0; k + 1 < p.length; k++) d.push((p[k + 1].y - p[k].y) / (p[k + 1].x - p[k].x));
  const slope = (j) => j === 0 ? d[0] : j === p.length - 1 ? d[d.length - 1]
    : d[j - 1] * d[j] <= 0 ? 0 : 2 / (1 / d[j - 1] + 1 / d[j]);
  const h = p[i + 1].x - p[i].x, t = Math.min(1, Math.max(0, (x - p[i].x) / h));
  const y = (2*t*t*t - 3*t*t + 1) * p[i].y + (t*t*t - 2*t*t + t) * h * slope(i)
          + (-2*t*t*t + 3*t*t) * p[i + 1].y + (t*t*t - t*t) * h * slope(i + 1);
  return Math.min(255, Math.max(0, y));
}
function curvesTables(curves) {
  const t = new Float32Array(768);
  for (let c = 1; c <= 3; c++) for (let i = 0; i < 256; i++)
    t[(c - 1) * 256 + i] = curveValue(curves.channels[0], curveValue(curves.channels[c], i)) / 255;
  return t;
}
// apply with levelsApply(p, curvesTables(curves))
```

### 3.3 Exposure

```swift
/// Each channel's output (0–1) for each input byte, decoded to linear light and encoded back.
var table: [Float] {
    let scale = pow(2, exposure)
    return (0...255).map { index in
        let encoded = Double(index) / 255
        var linear = encoded <= 0.04045 ? encoded / 12.92 : pow((encoded + 0.055) / 1.055, 2.4)
        linear = pow(max(0, linear * scale + offset), 1 / gamma)
        let output = linear <= 0.0031308 ? linear * 12.92 : 1.055 * pow(linear, 1 / 2.4) - 0.055
        return Float(min(1, max(0, output)))
    }
}
```
(`Document/ImageAdjustments.swift:54-63`; the same table on all three channels, `levels_apply`, `:66-69`.) Offset is
added in **linear light** before the gamma. The port is the same expression in JS doubles stored into a
`Float32Array(256)` and repeated three times.

### 3.4 Invert

```swift
// Premultiplied RGBA: each color becomes alpha − color, so transparency is kept.
let matrix: [Int16] = [-256,    0,    0,   0,
                          0, -256,    0,   0,
                          0,    0, -256,   0,
                        256,  256,  256, 256]
error = vImageMatrixMultiply_ARGB8888(&source, &target, matrix, 256, nil, nil, vImage_Flags(kvImageNoFlags))
```
(`Document/PixelInvert.swift:29-36`.) JS: `p[i+c] = p[i+3] - p[i+c]` for c = 0, 1, 2. Exact.

### 3.5 Gradient Map

```swift
let (dark, light) = ends                      // reversed ? (highlights, shadows) : (shadows, highlights)
func channel(_ from: Double, _ to: Double, _ t: Double) -> UInt8 {
    let value: Double = from + (to - from) * t
    let scaled: Double = (value * 255).rounded()
    return UInt8(min(255.0, max(0.0, scaled)))
}
for index in 0...255 {
    let t: Double = Double(index) / 255
    table.append(channel(dark.red, light.red, t)) ...
```
(`Document/ImageAdjustments.swift:87-104`), applied by `adjust_gradient_map` (`Rendering/AdjustPixels.c:17-39`):

```c
if (a < 255) {
    r = (r * 255u + a / 2) / a;   ...  if (r > 255) r = 255; ...
}
unsigned level = (2126u * r + 7152u * g + 722u * b + 5000u) / 10000u;
const uint8_t *color = table + (level > 255 ? 255 : level) * 3;
p[0] = (uint8_t)((color[0] * a + 127u) / 255u);
```

```js
const swiftRound = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));   // .rounded(): half away from zero
function gradientMapTable(g) {
  const [dark, light] = g.reversed ? [g.highlights, g.shadows] : [g.shadows, g.highlights];
  const ch = (from, to, t) => Math.min(255, Math.max(0, swiftRound((from + (to - from) * t) * 255)));
  const table = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    table[i*3] = ch(dark.red, light.red, t); table[i*3+1] = ch(dark.green, light.green, t); table[i*3+2] = ch(dark.blue, light.blue, t);
  }
  return table;
}
function gradientMapApply(p, table) {
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    if (a === 0) continue;
    let r = p[i], g = p[i + 1], b = p[i + 2];
    if (a < 255) {
      r = Math.min(255, Math.floor((r * 255 + (a >> 1)) / a));
      g = Math.min(255, Math.floor((g * 255 + (a >> 1)) / a));
      b = Math.min(255, Math.floor((b * 255 + (a >> 1)) / a));
    }
    const k = Math.min(255, Math.floor((2126 * r + 7152 * g + 722 * b + 5000) / 10000)) * 3;
    p[i] = Math.floor((table[k] * a + 127) / 255);
    p[i + 1] = Math.floor((table[k + 1] * a + 127) / 255);
    p[i + 2] = Math.floor((table[k + 2] * a + 127) / 255);
  }
}
```

### 3.6 Black & White

Weights are the six sliders / 100 in the order red, yellow, green, cyan, blue, magenta
(`Document/ImageAdjustments.swift:135`); tint saturation is passed / 100 (`:138`). `adjust_black_white`
(`Rendering/AdjustPixels.c:120-162`):

```c
float r = p[0] * 255.0f / alpha, g = p[1] * 255.0f / alpha, b = p[2] * 255.0f / alpha;
r = fminf(255.0f, r) / 255.0f; g = fminf(255.0f, g) / 255.0f; b = fminf(255.0f, b) / 255.0f;
float mx = fmaxf(r, fmaxf(g, b)), mn = fminf(r, fminf(g, b));
float md = r + g + b - mx - mn;
// weights: 0 red, 1 yellow, 2 green, 3 cyan, 4 blue, 5 magenta
int primary, secondary;
if (mx == r)      { primary = 0; secondary = (g >= b) ? 1 : 5; }
else if (mx == g) { primary = 2; secondary = (r >= b) ? 1 : 3; }
else              { primary = 4; secondary = (g >= r) ? 3 : 5; }
float gray = mn + (md - mn) * weights[secondary] + (mx - md) * weights[primary];
gray = fminf(1.0f, fmaxf(0.0f, gray));
...
if (tint && tintSaturation > 0) {
    double c = (1.0 - fabs(2.0 * gray - 1.0)) * tintSaturation;
    double hp = fmod(tintHue, 360.0) / 60.0;
    double xx = c * (1.0 - fabs(fmod(hp, 2.0) - 1.0));
    ... (HSL sector table) ...
    double m = gray - c / 2.0;
    outR = (float)fmin(1.0, fmax(0.0, r1 + m)); ...
}
p[0] = (uint8_t)fminf(alpha, fmaxf(0.0f, roundf(outR * alpha)));
```

```js
function blackWhiteApply(p, bw) {
  const w = [bw.reds, bw.yellows, bw.greens, bw.cyans, bw.blues, bw.magentas].map((v) => f32(v / 100));
  const tintSat = bw.tintSaturation / 100;
  for (let i = 0; i < p.length; i += 4) {
    const alpha = p[i + 3];
    if (!alpha) continue;
    let r = f32(f32(p[i] * 255) / alpha), g = f32(f32(p[i + 1] * 255) / alpha), b = f32(f32(p[i + 2] * 255) / alpha);
    r = f32(Math.min(255, r) / 255); g = f32(Math.min(255, g) / 255); b = f32(Math.min(255, b) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const md = f32(f32(f32(f32(r + g) + b) - mx) - mn);
    let primary, secondary;
    if (mx === r) { primary = 0; secondary = g >= b ? 1 : 5; }
    else if (mx === g) { primary = 2; secondary = r >= b ? 1 : 3; }
    else { primary = 4; secondary = g >= r ? 3 : 5; }
    let gray = f32(f32(mn + f32(f32(md - mn) * w[secondary])) + f32(f32(mx - md) * w[primary]));
    gray = Math.min(1, Math.max(0, gray));
    let oR = gray, oG = gray, oB = gray;
    if (bw.tint && tintSat > 0) {
      const c = (1 - Math.abs(2 * gray - 1)) * tintSat, hp = (bw.tintHue % 360) / 60;
      const xx = c * (1 - Math.abs((hp % 2) - 1));
      let r1 = 0, g1 = 0, b1 = 0;
      if (hp < 1) { r1 = c; g1 = xx; } else if (hp < 2) { r1 = xx; g1 = c; } else if (hp < 3) { g1 = c; b1 = xx; }
      else if (hp < 4) { g1 = xx; b1 = c; } else if (hp < 5) { r1 = xx; b1 = c; } else { r1 = c; b1 = xx; }
      const m = gray - c / 2;
      oR = f32(Math.min(1, Math.max(0, r1 + m))); oG = f32(Math.min(1, Math.max(0, g1 + m))); oB = f32(Math.min(1, Math.max(0, b1 + m)));
    }
    p[i]     = Math.min(alpha, Math.max(0, Math.round(f32(oR * alpha))));
    p[i + 1] = Math.min(alpha, Math.max(0, Math.round(f32(oG * alpha))));
    p[i + 2] = Math.min(alpha, Math.max(0, Math.round(f32(oB * alpha))));
  }
}
```

### 3.7 Color Balance

Each channel moves by its **own** tonal weights (computed from that channel's value, not from the pixel's
brightness), so without Preserve Luminosity the kind is three independent 1-D curves; with it, channels mix.
`adjust_color_balance` and `tonal_weights` (`Rendering/AdjustPixels.c:166-206`):

```c
static void tonal_weights(float v, float *shadow, float *mid, float *highlight) {
    const float a = 0.25f, b = 0.333f, scale = 0.7f;
    float s = (v - b) / -a + 0.5f;
    float h = (v + b - 1.0f) / a + 0.5f;
    s = fminf(1.0f, fmaxf(0.0f, s));
    h = fminf(1.0f, fmaxf(0.0f, h));
    float m1 = fminf(1.0f, fmaxf(0.0f, (v - b) / a + 0.5f));
    float m2 = fminf(1.0f, fmaxf(0.0f, (v + b - 1.0f) / -a + 0.5f));
    *shadow = s * scale;
    *mid = m1 * m2 * scale;
    *highlight = h * scale;
}
...
for (int i = 0; i < 3; ++i) c[i] = fminf(255.0f, p[i] * 255.0f / alpha) / 255.0f;
float before = 0.299f * c[0] + 0.587f * c[1] + 0.114f * c[2];
for (int i = 0; i < 3; ++i) {
    float s, m, h;
    tonal_weights(c[i], &s, &m, &h);
    c[i] += shadows[i] * s + midtones[i] * m + highlights[i] * h;
    c[i] = fminf(1.0f, fmaxf(0.0f, c[i]));
}
if (preserveLuminosity) {
    float after = 0.299f * c[0] + 0.587f * c[1] + 0.114f * c[2];
    if (after > 0.0001f) {
        float ratio = before / after;
        for (int i = 0; i < 3; ++i) c[i] = fminf(1.0f, fmaxf(0.0f, c[i] * ratio));
    }
}
for (int i = 0; i < 3; ++i) p[i] = (uint8_t)fminf(alpha, fmaxf(0.0f, roundf(c[i] * alpha)));
```

The nine sliders are passed / 100 as `shadows`, `midtones`, `highlights` triples (cyan/red, magenta/green,
yellow/blue) (`Document/ImageAdjustments.swift:168-173`); all nine zero returns the input (`:167`).

```js
function tonalWeights(v) {
  const a = f32(0.25), b = f32(0.333), scale = f32(0.7);
  const s = Math.min(1, Math.max(0, f32(f32(f32(v - b) / -a) + 0.5)));
  const h = Math.min(1, Math.max(0, f32(f32(f32(f32(v + b) - 1) / a) + 0.5)));
  const m1 = Math.min(1, Math.max(0, f32(f32(f32(v - b) / a) + 0.5)));
  const m2 = Math.min(1, Math.max(0, f32(f32(f32(f32(v + b) - 1) / -a) + 0.5)));
  return [f32(s * scale), f32(f32(m1 * m2) * scale), f32(h * scale)];
}
function colorBalanceApply(p, cb) {
  const all = [cb.shadowCyanRed, cb.shadowMagentaGreen, cb.shadowYellowBlue, cb.midCyanRed, cb.midMagentaGreen,
               cb.midYellowBlue, cb.highlightCyanRed, cb.highlightMagentaGreen, cb.highlightYellowBlue];
  if (all.every((v) => v === 0)) return;
  const S = all.slice(0, 3).map((v) => f32(v / 100)), M = all.slice(3, 6).map((v) => f32(v / 100)),
        H = all.slice(6, 9).map((v) => f32(v / 100));
  const luma = (c) => f32(f32(f32(f32(0.299) * c[0]) + f32(f32(0.587) * c[1])) + f32(f32(0.114) * c[2]));
  for (let i = 0; i < p.length; i += 4) {
    const alpha = p[i + 3];
    if (!alpha) continue;
    const c = [0, 1, 2].map((k) => f32(Math.min(255, f32(f32(p[i + k] * 255) / alpha)) / 255));
    const before = luma(c);
    for (let k = 0; k < 3; k++) {
      const [s, m, h] = tonalWeights(c[k]);
      c[k] = Math.min(1, Math.max(0, f32(c[k] + f32(f32(f32(S[k] * s) + f32(M[k] * m)) + f32(H[k] * h)))));
    }
    if (cb.preserveLuminosity) {
      const after = luma(c);
      if (after > f32(0.0001)) { const ratio = f32(before / after); for (let k = 0; k < 3; k++) c[k] = Math.min(1, Math.max(0, f32(c[k] * ratio))); }
    }
    for (let k = 0; k < 3; k++) p[i + k] = Math.min(alpha, Math.max(0, Math.round(f32(c[k] * alpha))));
  }
}
```

For speed, inline `tonalWeights` and reuse one `Float64Array(3)` for `c`: same output on 4.2 MP (0 differences), 28
instead of 94 ms/MP [measured]. Without Preserve Luminosity each channel depends only on its own `(value, alpha)`, so
the exact 2-D lookup of 3.1 applies.

### 3.8 Hue/Saturation

Both the CPU path and the GPU canvas use the same 33-point cube (`HueSaturationFilter.dimension = 33`,
`Document/HueSaturation.swift:234`); the CPU applies it with `cube_apply` (`:236-249`), red varying fastest, then
green, then blue (`:302-313`). The cube entry for lattice `(r, g, b)/32` is `adjust(...)` (`:318-339`):

```swift
var (hue, saturation, lightness) = toHSL(red: red, green: green, blue: blue)
var lightnessAmount = 0.0
if settings.colorize {
    hue = settings.hue.truncatingRemainder(dividingBy: 360)
    saturation = min(1, max(0, settings.saturation / 100))
    lightnessAmount = settings.lightness / 100
} else {
    // Every range contributes, weighted by how strongly it claims the original hue.
    let table = response ?? hueResponse(settings)
    let sampled = table[min(table.count - 1, max(0, Int(hue.rounded())))]
    lightnessAmount = sampled.lightness / 100
    hue = (hue + sampled.shift).truncatingRemainder(dividingBy: 360)
    if hue < 0 { hue += 360 }
    saturation = adjustedSaturation(saturation, by: sampled.saturation)
}
// Lightness pulls toward white above 0 and toward black below, reaching either at ±100.
let amount = min(1, max(-1, lightnessAmount))
lightness = amount >= 0 ? lightness + (1 - lightness) * amount : lightness * (1 + amount)
return toRGB(hue: hue, saturation: saturation, lightness: min(1, max(0, lightness)))
```

- `hueResponse` (`:266-278`): for each integer degree 0...360, the sum over every range with a non-zero adjustment of
  `adjustment * weight(range, degree)`; `weight` is 1 for Master, else the band weight, inverted (`1 - w`) for the
  selected range when "Apply outside this range instead" is on (`:209-213`).
- `HueBand.weight` (`:40-51`): measured forward from `falloffStart` modulo 360: linear ramp up to `rangeStart`, 1 to
  `rangeEnd`, linear ramp down to `falloffEnd`, 0 beyond; a zero span (Master) is 1.
- `adjustedSaturation` (`:344-348`): `amount = clamp(sat/100, -1, 1)`; `amount <= 0` -> `max(0, s*(1 + amount))`;
  `amount >= 1` -> `s > 0 ? 1 : 0`; else `min(1, s / (1 - amount))`.
- `toHSL` / `toRGB` (`:359-391`): standard HSL; hue in degrees; `toRGB` picks the sector with `Int(hue / 60)`, the
  `default` case covering 5 and 6.
- In Colorize, `settings.hue` etc. read the **selected** range's adjustment (`:186-198`); Colorize always starts with
  range Master (`colorizeStart`, `:205`).

```js
const DEFAULT_BANDS = { Master: [0, 0, 360, 360], Reds: [315, 345, 15, 45], Yellows: [15, 45, 75, 105],
  Greens: [75, 105, 135, 165], Cyans: [135, 165, 195, 225], Blues: [195, 225, 255, 285], Magentas: [255, 285, 315, 345] };
const fwd = (from, to) => { const d = (to - from) % 360; return d < 0 ? d + 360 : d; };
function bandWeight([fs, rs, re, fe], hue) {
  const span = fwd(fs, fe);
  if (!(span > 0)) return 1;
  const position = fwd(fs, hue);
  if (position > span) return 0;
  const rampIn = fwd(fs, rs), plateauEnd = fwd(fs, re);
  if (position < rampIn) return rampIn > 0 ? position / rampIn : 1;
  if (position <= plateauEnd) return 1;
  const rampOut = span - plateauEnd;
  return rampOut > 0 ? (span - position) / rampOut : 1;
}
// s: { range, colorize, invertRange, adjustments: {Range: {hue, saturation, lightness}}, bands: {Range: [4 numbers]} }
function hsWeight(s, range, hue) {
  if (range === 'Master') return 1;
  const w = bandWeight(s.bands[range] || DEFAULT_BANDS[range], hue);
  return s.invertRange && range === s.range ? 1 - w : w;
}
function hueResponse(s) {
  const out = [];
  for (let degree = 0; degree <= 360; degree++) {
    let shift = 0, sat = 0, light = 0;
    for (const [range, a] of Object.entries(s.adjustments)) {
      if (a.hue === 0 && a.saturation === 0 && a.lightness === 0) continue;
      const w = hsWeight(s, range, degree);
      if (!(w > 0)) continue;
      shift += a.hue * w; sat += a.saturation * w; light += a.lightness * w;
    }
    out.push([shift, sat, light]);
  }
  return out;
}
function adjustedSaturation(sat, amount0) {
  const amount = Math.min(1, Math.max(-1, amount0 / 100));
  if (!(amount > 0)) return Math.max(0, sat * (1 + amount));
  return amount >= 1 ? (sat > 0 ? 1 : 0) : Math.min(1, sat / (1 - amount));
}
function toHSL(r, g, b) {
  const high = Math.max(r, g, b), low = Math.min(r, g, b), l = (high + low) / 2, delta = high - low;
  if (!(delta > 0)) return [0, 0, l];
  const sat = delta / (1 - Math.abs(2 * l - 1));
  let hue = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue *= 60; if (hue < 0) hue += 360;
  return [hue, Math.min(1, sat), l];
}
function toRGB(hue, sat, l) {
  if (!(sat > 0)) return [l, l, l];
  const chroma = (1 - Math.abs(2 * l - 1)) * sat, sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1)), base = l - chroma / 2;
  const [r, g, b] = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second], [0, second, chroma],
                     [second, 0, chroma]][Math.trunc(sector)] || [chroma, 0, second];
  const c = (v) => Math.min(1, Math.max(0, v + base));
  return [c(r), c(g), c(b)];
}
function hsAdjust(r, g, b, s, response) {
  let [hue, sat, light] = toHSL(r, g, b), amountL;
  if (s.colorize) {
    const a = s.adjustments[s.range] || { hue: 0, saturation: 0, lightness: 0 };
    hue = a.hue % 360; sat = Math.min(1, Math.max(0, a.saturation / 100)); amountL = a.lightness / 100;
  } else {
    const sampled = response[Math.min(response.length - 1, Math.max(0, swiftRound(hue)))];
    amountL = sampled[2] / 100;
    hue = (hue + sampled[0]) % 360; if (hue < 0) hue += 360;
    sat = adjustedSaturation(sat, sampled[1]);
  }
  const amount = Math.min(1, Math.max(-1, amountL));
  light = amount >= 0 ? light + (1 - light) * amount : light * (1 + amount);
  return toRGB(hue, sat, Math.min(1, Math.max(0, light)));
}
function hsCube(s) {                          // Float32Array(33*33*33*4), red fastest, alpha 1
  const n = 33, response = hueResponse(s), cube = new Float32Array(n * n * n * 4);
  let k = 0;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const c = hsAdjust(r / 32, g / 32, b / 32, s, response);
    cube[k] = c[0]; cube[k + 1] = c[1]; cube[k + 2] = c[2]; cube[k + 3] = 1; k += 4;
  }
  return cube;
}
function cubeApply(p, cube, n) {              // cube_apply, Rendering/LevelsPixels.c:31-60
  const scale = f32((n - 1) / 255), sy = n * 4, sz = n * n * 4;
  const pos = [0, 0, 0], fr = [0, 0, 0], lo = [0, 0, 0];
  for (let i = 0; i < p.length; i += 4) {
    const alpha = p[i + 3];
    if (!alpha) continue;
    for (let c = 0; c < 3; c++) {
      pos[c] = f32(f32(Math.min(255, f32(f32(p[i + c] * 255) / alpha))) * scale);
      lo[c] = Math.min(n - 2, Math.trunc(pos[c]));
      fr[c] = f32(pos[c] - lo[c]);
    }
    const base = (lo[0] + lo[1] * n + lo[2] * n * n) * 4;
    for (let c = 0; c < 3; c++) {
      const o = base + c, C = (k) => cube[o + k];
      const x00 = f32(C(0) + f32(f32(C(4) - C(0)) * fr[0]));
      const x10 = f32(C(sy) + f32(f32(C(sy + 4) - C(sy)) * fr[0]));
      const x01 = f32(C(sz) + f32(f32(C(sz + 4) - C(sz)) * fr[0]));
      const x11 = f32(C(sz + sy) + f32(f32(C(sz + sy + 4) - C(sz + sy)) * fr[0]));
      const y0 = f32(x00 + f32(f32(x10 - x00) * fr[1])), y1 = f32(x01 + f32(f32(x11 - x01) * fr[1]));
      p[i + c] = Math.min(alpha, Math.max(0, Math.round(f32(f32(y0 + f32(f32(y1 - y0) * fr[2])) * alpha))));
    }
  }
}
```

The manifest stores `hsvSettings` with dictionaries as flat key/value arrays (`docs/port-specs/manifest.md` section 2);
convert to the object form above. A record without `hsvSettings` uses the legacy `hue`/`saturation`/`lightness`/
`colorize` on Master (`resolvedHSV`, `Document/LayerAdjustment.swift:53-55`). Identity settings still go through the
cube (the cube of an identity is exact, so pixels do not change).

### 3.9 Grain

`GrainSettings.apply(image, origin:, unitsPerPixel:)` -> `adjust_grain` (`Document/ImageAdjustments.swift:201-209`,
`Rendering/AdjustPixels.c:41-106`). For an adjustment layer, `origin` is the region's document origin and
`unitsPerPixel` = region width / image width (1 in export and on the board) (`Document/LayerAdjustment.swift:176-178`).

```c
static inline uint32_t mix32(uint32_t x) { x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x; }
static inline float lattice(int64_t ix, int64_t iy, uint32_t seed) {
    uint32_t h = mix32((uint32_t)ix * 0x9E3779B1U ^ mix32((uint32_t)iy * 0x85EBCA77U ^ seed));
    return (float)(h & 0xFFFFU) / 65535.0f + (float)(h >> 16) / 65535.0f - 1.0f;
}
static inline float grain_field(double u, double v, double scale, uint32_t seed) {
    double cellX = floor(u / scale), cellY = floor(v / scale);
    float tx = (float)(u / scale - cellX), ty = (float)(v / scale - cellY);
    tx = tx * tx * (3.0f - 2.0f * tx);
    ty = ty * ty * (3.0f - 2.0f * ty);
    ...bilinear of the four lattice values...
    return (top + (bottom - top) * ty) * 1.6f;
}
...
float strength = (float)(amount > 100 ? 1.0 : amount / 100.0) * 0.35f * 255.0f;
float rough = (float)(roughness < 0 ? 0.0 : roughness > 100 ? 1.0 : roughness / 100.0);
uint32_t fineSeed = mix32(seed ^ 0xA511E9B3U);
double detailSize = fmax(0.5, size * 0.35);
...
float noise = smooth + (fine - smooth) * rough;
float unpremultiply = a == 255 ? 1.0f : 255.0f / (float)a;
float r = p[0] * unpremultiply, ...;
float level = (0.2126f * r + 0.7152f * g + 0.0722f * b) / 255.0f;  if (level > 1) level = 1;
// Film grain shows most in the midtones.
float delta = noise * strength * (0.4f + 2.4f * level * (1.0f - level));
float coverage = (float)a / 255.0f;
p[0] = (uint8_t)(clamp255(r + delta) * coverage + 0.5f);
```

```js
function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
function lattice(ix, iy, seed) {
  const h = mix32((Math.imul(ix >>> 0, 0x9E3779B1) ^ mix32((Math.imul(iy >>> 0, 0x85EBCA77) ^ seed) >>> 0)) >>> 0);
  return f32(f32(f32((h & 0xFFFF) / 65535) + f32((h >>> 16) / 65535)) - 1);
}
function grainField(u, v, scale, seed) {
  const cellX = Math.floor(u / scale), cellY = Math.floor(v / scale);
  let tx = f32(u / scale - cellX), ty = f32(v / scale - cellY);
  tx = f32(f32(tx * tx) * f32(3 - f32(2 * tx))); ty = f32(f32(ty * ty) * f32(3 - f32(2 * ty)));
  const n00 = lattice(cellX, cellY, seed), n10 = lattice(cellX + 1, cellY, seed);
  const n01 = lattice(cellX, cellY + 1, seed), n11 = lattice(cellX + 1, cellY + 1, seed);
  const top = f32(n00 + f32(f32(n10 - n00) * tx)), bottom = f32(n01 + f32(f32(n11 - n01) * tx));
  return f32(f32(top + f32(f32(bottom - top) * ty)) * f32(1.6));
}
function grainApply(p, w, h, g, originX = 0, originY = 0, unitsPerPixel = 1) {
  if (!(g.amount > 0)) return;
  const size = g.size > 0 ? g.size : 1, seed = g.seed >>> 0;
  const strength = f32(f32(f32(g.amount > 100 ? 1 : g.amount / 100) * f32(0.35)) * 255);
  const rough = f32(g.roughness < 0 ? 0 : g.roughness > 100 ? 1 : g.roughness / 100);
  const fineSeed = mix32((seed ^ 0xA511E9B3) >>> 0), detail = Math.max(0.5, size * 0.35);
  const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < h; y++) {
    const v = originY + (y + 0.5) * unitsPerPixel;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = p[i + 3];
      if (a === 0) continue;
      const u = originX + (x + 0.5) * unitsPerPixel;
      const smooth = grainField(u, v, size, seed), fine = grainField(u, v, detail, fineSeed);
      const noise = f32(smooth + f32(f32(fine - smooth) * rough));
      const un = a === 255 ? 1 : f32(255 / a);
      const r = f32(p[i] * un), gg = f32(p[i + 1] * un), b = f32(p[i + 2] * un);
      let level = f32(f32(f32(f32(f32(0.2126) * r) + f32(f32(0.7152) * gg)) + f32(f32(0.0722) * b)) / 255);
      if (level > 1) level = 1;
      const delta = f32(f32(noise * strength) * f32(f32(0.4) + f32(f32(f32(2.4) * level) * f32(1 - level))));
      const cov = f32(a / 255);
      p[i]     = Math.trunc(f32(f32(cl(f32(r + delta)) * cov) + 0.5));
      p[i + 1] = Math.trunc(f32(f32(cl(f32(gg + delta)) * cov) + 0.5));
      p[i + 2] = Math.trunc(f32(f32(cl(f32(b + delta)) * cov) + 0.5));
    }
  }
}
```

`noise` depends only on position and settings; caching it as a `Float32Array` per (seed, size, roughness) leaves a
cheap per-pixel step for live use.

### 3.10 Add Noise

`LayerAdjustment.apply` builds a `FilterJob(kind: .addNoise, seed: noiseSeed, noiseOrigin: region origin in image
pixels)` (`Document/LayerAdjustment.swift:179-199`); `PixelFilter.run` clamps `amount` to 0.1...400
(`Document/Filters.swift:132`) and calls `noise_add_at(..., origin = floor(noiseOrigin))` (`:304-313`,
`Rendering/NoisePixels.c:20-49`):

```c
float spread = amount / 100.0f * 127.5f;
...
uint32_t px = (uint32_t)(origin_x + (int64_t)x);
uint32_t py = (uint32_t)(origin_y + (int64_t)y);
uint32_t base = noise_hash(seed ^ noise_hash(px * 0x9e3779b9U ^ noise_hash(py * 0x85ebca6bU)));
for (int c = 0; c < 3; ++c) {
    uint32_t key = monochromatic ? base : base + (uint32_t)c * 0x9e3779b9U;
    float n;
    if (gaussian) {
        // Box–Muller: two uniform values make one normally distributed one.
        float u1 = noise_unit(key), u2 = noise_unit(key ^ 0x68e31da4U);
        n = sqrtf(-2.0f * logf(1.0f - u1)) * cosf(6.2831853f * u2) * spread * (2.0f / 3.0f);
    } else {
        n = (noise_unit(key) * 2.0f - 1.0f) * spread;
    }
    float value = (float)p[c] * 255.0f / (float)alpha + n;
    value = value < 0 ? 0 : value > 255 ? 255 : value;
    p[c] = (uint8_t)lroundf(value * (float)alpha / 255.0f);
}
```
(`noise_hash` is `mix32`; `noise_unit(key) = (float)(noise_hash(key) >> 8) * (1.0f / 16777216.0f)`.)

```js
const noiseUnit = (key) => f32((mix32(key) >>> 8) * f32(1 / 16777216));
function addNoiseApply(p, w, h, amount0, gaussian, mono, seed, ox = 0, oy = 0) {
  const spread = f32(f32(f32(Math.min(400, Math.max(0.1, amount0))) / 100) * f32(127.5));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, alpha = p[i + 3];
    if (!alpha) continue;
    const px = (ox + x) >>> 0, py = (oy + y) >>> 0;
    const base = mix32((seed ^ mix32((Math.imul(px, 0x9e3779b9) ^ mix32(Math.imul(py, 0x85ebca6b) >>> 0)) >>> 0)) >>> 0);
    for (let c = 0; c < 3; c++) {
      const key = mono ? base : (base + Math.imul(c, 0x9e3779b9)) >>> 0;
      let n;
      if (gaussian) {
        const u1 = noiseUnit(key), u2 = noiseUnit((key ^ 0x68e31da4) >>> 0);
        n = f32(f32(f32(f32(Math.sqrt(f32(-2 * Math.log(f32(1 - u1))))) * f32(Math.cos(f32(f32(6.2831853) * u2)))) * spread) * f32(2 / 3));
      } else n = f32(f32(f32(noiseUnit(key) * 2) - 1) * spread);
      let value = f32(f32(f32(p[i + c] * 255) / alpha) + n);
      value = value < 0 ? 0 : value > 255 ? 255 : value;
      p[i + c] = Math.round(f32(f32(value * alpha) / 255));
    }
  }
}
```

`Math.log`/`Math.cos` are double where C uses `logf`/`cosf`; after 8-bit rounding this gave no difference on 2,048
pixels [verified], but a rare one-level difference at a rounding boundary is possible.

### 3.11 Gaussian Blur

`PixelFilter.run(.gaussianBlur)` with `canvasSides = []` and `preserveTransparency = false` (the adjustment does not
store it, `Document/AdjustmentEditing.swift:86`): `CIImage(cgImage: composite).applyingGaussianBlur(sigma: radius *
scale)`, not clamped, rendered without color management (`Document/Filters.swift:282-294`, `:418-422`). So: a
Gaussian with **standard deviation = radius** (document pixels) on premultiplied, gamma-encoded values, with
transparent pixels assumed outside the document.

Board: a separable Gaussian, kernel `exp(-i^2 / (2 sigma^2))` normalized over `|i| <= ceil(4 sigma)`, taps outside the
document read as 0, on premultiplied floats. [verified] Against the engine: max 1.5 / 1.6 / 1.4 levels (radius 2 / 10 /
30, full-canvas image), max 1.0-1.8 on an isolated shape; mean under 0.4. Core Image downsamples internally for large
radii, which explains the residue. For large radii in JS, blur a 2^k-reduced copy (k = floor(log2(sigma / 4))) and
upsample; check the result stays within 2 levels of the engine. Canvas 2D `ctx.filter = 'blur(<sigma>px)'` is a
quick fallback whose exactness was not measured.

### 3.12 Motion Blur

```swift
// Core Image's y axis points up, so its counterclockwise angle matches Photoshop's.
let streaked = extending(edges, past: job.canvasSides, of: extent).applyingFilter("CIMotionBlur", parameters: [
    kCIInputRadiusKey: settings.distance * job.scale * motionRadiusPerPixel,
    kCIInputAngleKey: settings.angle * .pi / 180,
])
```
(`Document/Filters.swift:297-303`; `motionRadiusPerPixel = 1 / 12.0.squareRoot()`, `:235-238`: "Core Image tapers like
a Gaussian whose spread is about its radius".) Board: for each pixel, a 1-D Gaussian with **sigma = distance /
sqrt(12)** along `(cos a, -sin a)` in y-down document pixels (counterclockwise on screen), taps at unit spacing for
`|t| <= ceil(4 sigma)`, bilinear samples, 0 outside the document. [verified] Angle 0 / distance 40: max 1.1 levels;
-90 / 20: 0.9; 30 / 60: 3.4 on an isolated shape, 7.8 on a striped full canvas; the opposite rotation sense gives 122,
and sigma x 0.9 or x 1.1 gives 12-15, so the direction and the spread are right.

---

## 4. Adjustment test vectors

All [verified]: produced by the engine's `render` and reproduced exactly by the ports in section 3. Input colors are
straight sRGB 0-255 bytes on an opaque swatch layer at full opacity, Normal, with nothing else in the document;
outputs are straight bytes as `getImageData` returns them. "@a128" is the same color at alpha 128 (output alpha 128).
Settings are given as manifest JSON (`docs/port-specs/manifest.md` section 7.1); the identity `levels`/`curves`
blocks every kind carries are omitted.

| Kind and settings | Input -> output |
|---|---|
| Levels: RGB `{black 20, gamma 1.4, white 230, outputBlack 10, outputWhite 245}`, Red `{gamma 0.8}`, Green `{black 30}`, Blue `{white 200, outputBlack 40}` | 0,0,0 -> 10,10,54 · 64,64,64 -> 62,51,137 · 128,128,128 -> 136,139,201 · 255,255,255 -> 245,245,245 · 255,0,0 -> 245,10,54 · 200,100,50 -> 211,105,121 · 50,100,200 -> 43,105,245 · 240,200,170 -> 245,214,239 · 200,100,50@a128 -> 209,106,122 |
| Curves: RGB `[(0,0),(64,40),(190,220),(255,255)]`, Red `[(0,20),(128,150),(255,255)]`, Blue `[(0,0),(100,60),(255,230)]` | 0,0,0 -> 11,0,0 · 64,64,64 -> 66,40,20 · 128,128,128 -> 170,133,63 · 192,192,192 -> 230,222,179 · 255,255,255 -> 255,255,243 · 200,100,50 -> 233,86,16 · 240,200,170 -> 249,227,137 · 200,100,50@a128 -> 233,86,16 |
| Exposure `{exposure 0.75, offset -0.02, gamma 1.2}` | 64 -> 91 · 128 -> 172 · 192 -> 242 · 200,100,50 -> 250,138,69 · 50,100,200 -> 69,138,250 · 17,200,140 -> 0,250,185 · 200,100,50@a128 -> 249,137,68 |
| Invert | 128,128,128 -> 127,127,127 · 200,100,50 -> 55,155,205 · 240,200,170 -> 15,55,85 · 200,100,50@a128 -> 56,155,205 |
| Gradient Map `{shadows (0.1, 0.05, 0.3), highlights (1, 0.85, 0.4), reversed false}` | 0 -> 26,13,77 · 64 -> 83,64,83 · 128 -> 141,115,89 · 255 -> 255,217,102 · 255,0,0 -> 74,56,82 · 0,255,0 -> 189,158,95 · 200,100,50 -> 132,107,88 · 200,100,50@a128 -> 131,106,88 |
| Black & White, defaults (40, 60, 40, 60, 20, 80, no tint) | grays unchanged · 255,0,0 -> 102 · 0,255,0 -> 102 · 0,0,255 -> 51 · 200,100,50 -> 120 · 50,100,200 -> 100 · 240,200,170 -> 204 · 17,200,140 -> 115 |
| Black & White `{reds -50, yellows 150, greens 40, cyans 60, blues 250, magentas 80, tint true, tintHue 40, tintSaturation 20}` | 64 -> 77,68,51 · 128 -> 153,136,103 · 255,0,0 -> 0,0,0 · 0,0,255 -> 255,255,255 · 200,100,50 -> 90,80,60 · 240,200,170 -> 207,199,183 |
| Color Balance: shadows (30, -20, 10), midtones (-40, 25, 50), highlights (15, 0, -35), Preserve Luminosity **on** | 64 -> 96,42,94 · 128 -> 51,154,194 · 192 -> 200,196,151 · 255 -> 255,255,198 · 255,0,0 -> 248,0,17 · 200,100,50 -> 189,104,57 · 200,100,50@a128 -> 187,104,58 |
| Same, Preserve Luminosity **off** | 0 -> 54,0,18 · 128 -> 57,173,217 · 255 -> 255,255,193 · 200,100,50 -> 224,123,68 · 200,100,50@a128 -> 221,124,68 |
| Hue/Saturation: Master (hue 30, sat 20, light -10), Reds (hue -20, sat 40), Blues (sat -60, light 25), default bands | 64 -> 59,59,59 · 128 -> 117,117,117 · 192 -> 176,175,174 · 255,0,0 -> 230,38,0 · 0,0,255 -> 147,82,212 · 200,100,50 -> 225,125,0 · 50,100,200 -> 106,90,188 · 240,200,170 -> 255,215,114 · 200,100,50@a128 -> 225,124,0 |
| Hue/Saturation Colorize: Master (hue 200, sat 25, light 10) | 0 -> 19,28,32 · 128 -> 112,150,169 · 255,0,0 -> 112,150,169 · 200,100,50 -> 109,148,167 · 240,200,170 -> 199,214,221 |
| Hue/Saturation: range Greens, band 60/100/140/170, hue 90, sat -100, **Apply outside** | 255,0,0 -> 128,128,128 · 0,255,0 -> 0,255,0 · 200,100,50 -> 125,125,125 · 17,200,140 -> 79,98,138 |
| Grain `{amount 60, size 1.5, roughness 50, seed 123456789}`, input at document (x, 1) where x = the palette index below; gray ramp on row 0 at x = value | (x 2) 128 -> 139 · (x 5) 255,0,0 -> 255,15,15 · (x 11) 200,100,50 -> 201,101,51 · (x 12) 50,100,200 -> 33,83,183 · row 0: (64,0) 64 -> 55 · (128,0) 128 -> 119 · (192,0) 192 -> 158 |
| Add Noise `{noiseAmount 25, uniform, color, noiseSeed 987654321}`, same positions | (x 0) 0,0,0 -> 0,11,0 · (x 2) 128 -> 144,154,105 · (x 11) 200,100,50 -> 225,99,74 · row 0: (0,0) 0 -> 20,21,6 · (128,0) 128 -> 112,110,154 |
| Add Noise `{noiseAmount 40, gaussian, monochromatic, noiseSeed 42}` | (x 2) 128 -> 120 · (x 11) 200,100,50 -> 186,86,36 · row 0: (64,0) 64 -> 85 · (128,0) 128 -> 173 |

The swatch for the position-dependent rows: document 256 x 8; row 0 holds the gray ramp (x = value), row 1 the
palette `[0,0,0] [255,255,255] [128,128,128] [64,64,64] [192,192,192] [255,0,0] [0,255,0] [0,0,255] [255,255,0]
[0,255,255] [255,0,255] [200,100,50] [50,100,200] [30,160,90] [240,200,170] [90,40,120] [10,20,30] [250,240,230]
[128,64,32] [17,200,140]` repeated (palette index k at x = k, k + 20, ...).

Scope vectors (formulas of section 2, all [verified] on 256 random pixels at alpha 255 / 200 / 100 / ramp): Invert at
opacity 0.4 = `round(o + (a - o)*0.4)`; Invert through a horizontal mask ramp `m = round(x*255/63)` =
`round((a*m + o*(255-m))/255)`; Levels in Multiply, Linear Dodge (Add) and Difference = section 2.4; Invert in a 50 %
folder = 50 % mix of the whole composite; Invert clipped to a base `(200,120,40)@a180` = base color inverted
(`55,135,215`) premultiplied by 180 with `(v*a + 127)/255`, then Normal over the swatch; the same with the base hidden
= no change.

Blur vectors (tolerance 2 levels; engine values, straight): Gaussian Blur radius 10 over an opaque `255,200,0` square
`x 50..109, y 30..89` in a transparent 160 x 120 document -> `(50,60) = 255,199,0 @132`, `(45,60) @83`, `(40,60) @44`,
`(80,60) @253`, `(50,30) @69`. Motion Blur angle 0, distance 40, same square -> `(50,60) @132`, `(45,60) @89`,
`(40,60) @52`, `(80,30) @253`.

---

## 5. Layer effects rendering

### 5.1 Records and validity

`LayerEffects { stroke?, shadow?, colorOverlay?, innerShadow?, outerGlow?, innerGlow? }` (`Document/LayerEffects.swift:
127-139`), each with optional `enabled` (missing = visible). Defaults and ranges:

| Effect | Fields (model default) | `isValid` | Ref |
|---|---|---|---|
| Stroke | `size 4`, `red/green/blue 0`, `opacity 1`, `inside false` | size 0...500, opacity 0...1, rgb 0...1 | `:6-22` |
| Drop Shadow (`shadow`) | `angle 90`, `distance 20`, `blur 20`, rgb 0, `opacity 0.5` | angle -360...360, distance 0...5000, blur 0...500 | `:25-50` |
| Color Overlay | rgb 0, `opacity 1` | | `:53-64` |
| Inner Shadow | `angle 90`, `distance 10`, `blur 10`, rgb 0, `opacity 0.5` | as Drop Shadow | `:67-89` |
| Outer Glow | `size 20`, rgb 1, `opacity 0.75` | size 0...500 | `:92-106` |
| Inner Glow | `size 10`, rgb 1, `opacity 0.75` | size 0...500 | `:109-123` |

`offset` of both shadows, in layer pixels, y down: `(-cos(angle) * distance, sin(angle) * distance)`, angle in degrees
counterclockwise from the right; 90 drops the shadow straight down (`:38-43`, `:78-82`). The manifest does not
validate effects at load; an invalid record (any visible effect out of range) makes the layer draw **without** effects
(`cached`, `:417-422`).

### 5.2 Where effects apply and how they are placed

```swift
let mask = snapshot.mask(for: layer).flatMap { $0.clipImage(placement: $0.placement, over: layer.transform, width: image.width, height: image.height) }
let effects = LayerEffectsRenderer.cached(image, mask: mask, effects: layer.effects)
func drawLayer(_ mode: LayerBlendMode, _ into: CGContext) {
    if let effects {
        let grown = LayerEffectsRenderer.placed(layer.transform, image: effects.image, inset: effects.inset)
        LayerRenderer.draw(effects.image, transform: grown, center: grown.center,
            opacity: opacity, blendMode: mode, mask: nil, in: into)
        return
    }
```
(`IO/ImageExporter.swift:52-60`.)

- Effects are computed in the **layer's pixel grid** from the pixels **through the layer's own mask** (`masked`,
  `Document/LayerEffects.swift:526-537`; a placed mask is first resampled onto that grid,
  `docs/port-specs/compositing.md` section 6.2). Sizes, distances and blurs are layer pixels, so a layer scaled 2x
  shows a 4 px stroke 8 document pixels wide.
- The result is a canvas grown by `inset` on every side:

  ```swift
  static func margin(for effects: LayerEffects) -> CGFloat {
      let effects = effects.visible
      var margin: CGFloat = 0
      if let stroke = effects.stroke, !stroke.inside { margin = max(margin, stroke.size) }
      if let shadow = effects.shadow {
          margin = max(margin, shadow.distance + shadow.blur * 3)
      }
      if let glow = effects.outerGlow {
          margin = max(margin, glow.size * 3)
      }
      return ceil(margin) + 2
  }
  ```
  (`:435-446`.) The canvas is `(w + 2*inset) x (h + 2*inset)`, the pixels at `(inset, inset)`.
- `placed` grows the transform about its center by the same proportion (`:425-433`):
  `grown.size = size * W / (W - 2*inset)` per axis, `grown.origin = center - grown.size / 2`, rotation and flips kept.
- The grown image is then an ordinary layer image: drawn with the layer's effective opacity and blend mode, mask `nil`,
  clipped by clipping coverage and folder masks as any layer. Opacity applies to pixels and effects together (no
  separate fill opacity). Folders, adjustment layers and blank layers never have effects drawn.

### 5.3 The algorithm (Metal path, the one export uses on a Mac)

`render` (`:450-467`) tries `MetalLayerEffects.shared.render(padded, effects:)` first and falls back to Core
Graphics / Core Image only without Metal. Every pass of the Metal path (`Rendering/MetalLayerEffects.swift:59-208`,
kernels `:220-395`) works on one float per pixel of the grown canvas:

1. `first` = alpha / 255 (the shape).
2. **Stroke** (enabled, size > 0, opacity > 0): `reach = max(1, Int(size.rounded()))`; a square max filter (min for
   inside) over `[-reach, reach]` along rows then columns, samples past the canvas edge read 0; `ring = clamp(inside ?
   shape - eroded : dilated - shape, 0, 1)`.
3. **Drop shadow** (enabled, opacity > 0): `shift` = bilinear sample of `first` at `(x - dx, y - dy)`, 0 when the
   sample point is outside `[0, W-1] x [0, H-1]`; then if `sigma = blur / 2 > 0.01`, a separable Gaussian with
   `radius = max(1, Int((sigma * 3).rounded()))`, weights `exp(-o^2 / (2 sigma^2))` normalized, samples **clamped to
   the edge**.
4. **Inner shadow** (enabled, opacity > 0): the same shift and blur of `first` by its own offset; `inner = clamp(1 -
   moved, 0, 1)`.
5. **Outer glow** (enabled, size > 0, opacity > 0): `first` blurred with `sigma = size / 2` (no shift).
6. **Inner glow** (enabled, size > 0, opacity > 0): `first` blurred with `sigma = size / 2`; `innerGlow = clamp(1 -
   blurred, 0, 1)`.
7. **Compose** per pixel (premultiplied floats; `source` = the layer pixel / 255):

```metal
if (settings.flags.z == 1) {
    float coverage = clamp(shadow[index] * settings.shadowColor.w, 0.0, 1.0);
    color = settings.shadowColor.xyz * coverage;
    alpha = coverage;
}
if (settings.more.y == 1) {
    float glowCoverage = clamp(glow[index] * (1.0 - shape[index]) * settings.glowColor.w, 0.0, 1.0);
    color = settings.glowColor.xyz * glowCoverage + color * (1.0 - glowCoverage);
    alpha = glowCoverage + alpha * (1.0 - glowCoverage);
}
float strokeCoverage = settings.flags.x == 1 ? clamp(ring[index] * settings.strokeColor.w, 0.0, 1.0) : 0.0;
if (settings.flags.x == 1 && settings.flags.y == 0) {
    color = settings.strokeColor.xyz * strokeCoverage + color * (1.0 - strokeCoverage);
    alpha = strokeCoverage + alpha * (1.0 - strokeCoverage);
}
float4 source = float4(pixels[index]) / 255.0;
if (settings.more.x == 1) {
    source.xyz = mix(source.xyz, settings.overlayColor.xyz * source.w, settings.overlayColor.w);
}
if (settings.more.z == 1) {
    float amount = clamp(innerGlow[index] * settings.innerGlowColor.w, 0.0, 1.0);
    source.xyz = mix(source.xyz, settings.innerGlowColor.xyz * source.w, amount);
}
if (settings.flags.w == 1) {
    float amount = clamp(inner[index] * settings.innerColor.w, 0.0, 1.0);
    source.xyz = mix(source.xyz, settings.innerColor.xyz * source.w, amount);
}
color = source.xyz + color * (1.0 - source.w);
alpha = source.w + alpha * (1.0 - source.w);
if (settings.flags.x == 1 && settings.flags.y == 1) {
    color = settings.strokeColor.xyz * strokeCoverage + color * (1.0 - strokeCoverage);
    alpha = strokeCoverage + alpha * (1.0 - strokeCoverage);
}
result[index] = uchar4(uchar(clamp(color.x, 0.0, 1.0) * 255.0 + 0.5), ... uchar(clamp(alpha, 0.0, 1.0) * 255.0 + 0.5));
```
(`:353-394`.) Order: shadow behind, outer glow (only outside the shape), outside stroke, the pixels recolored by color
overlay, then inner glow, then inner shadow (each keeps the pixel's alpha, so a translucent pixel takes the color
fully), inside stroke on top. The result is premultiplied 8-bit.

JS port, [verified] bit-exact on 10 cases (each effect alone, an inside stroke at size 3.4, a sharp shadow, all six
together, a hidden effect beside a visible one) over a shape with a hole and a translucent strip:

```js
const enabled = (e) => e && e.enabled !== false;
function effectsMargin(fx) {
  let m = 0;
  if (enabled(fx.stroke) && !fx.stroke.inside) m = Math.max(m, fx.stroke.size);
  if (enabled(fx.shadow)) m = Math.max(m, fx.shadow.distance + fx.shadow.blur * 3);
  if (enabled(fx.outerGlow)) m = Math.max(m, fx.outerGlow.size * 3);
  return Math.ceil(m) + 2;
}
const shadowOffset = (e) => { const r = e.angle * Math.PI / 180; return [-Math.cos(r) * e.distance, Math.sin(r) * e.distance]; };
function spread(src, W, H, reach, smallest, rows) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = smallest ? 1 : 0;
    for (let o = -reach; o <= reach; o++) {
      const sx = rows ? x + o : x, sy = rows ? y : y + o;
      const v = (rows ? sx < 0 || sx >= W : sy < 0 || sy >= H) ? 0 : src[sy * W + sx];
      best = smallest ? Math.min(best, v) : Math.max(best, v);
    }
    out[y * W + x] = best;
  }
  return out;
}
function shift(src, W, H, dx, dy) {
  const out = new Float32Array(W * H);
  dx = f32(dx); dy = f32(dy);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = f32(x - dx), sy = f32(y - dy);
    if (!(sx >= 0 && sy >= 0 && sx <= W - 1 && sy <= H - 1)) continue;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
    const fx = f32(sx - x0), fy = f32(sy - y0), mix = (a, b, t) => a + (b - a) * t;
    out[y * W + x] = mix(mix(src[y0 * W + x0], src[y0 * W + x1], fx), mix(src[y1 * W + x0], src[y1 * W + x1], fx), fy);
  }
  return out;
}
function blur(src, W, H, sigma) {
  sigma = f32(sigma);
  const radius = Math.max(1, Math.trunc(swiftRound(f32(sigma * 3))));
  const w = [];
  for (let o = -radius; o <= radius; o++) w.push(f32(Math.exp(-(o * o) / (2 * sigma * sigma))));
  const pass = (input, rows) => {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let total = 0, sum = 0;
      for (let o = -radius; o <= radius; o++) {
        const s = rows ? input[y * W + Math.min(W - 1, Math.max(0, x + o))] : input[Math.min(H - 1, Math.max(0, y + o)) * W + x];
        total += w[o + radius] * s; sum += w[o + radius];
      }
      out[y * W + x] = total / sum;
    }
    return out;
  };
  return pass(pass(src, true), false);
}
// shown: the layer's pixels through its mask, premultiplied RGBA8, w x h. Returns the grown premultiplied image.
function renderEffects(shown, w, h, fx) {
  const inset = effectsMargin(fx), W = w + 2 * inset, H = h + 2 * inset, n = W * H;
  const px = new Uint8Array(n * 4);
  for (let y = 0; y < h; y++) px.set(shown.subarray(y * w * 4, (y + 1) * w * 4), ((y + inset) * W + inset) * 4);
  const first = new Float32Array(n);
  for (let i = 0; i < n; i++) first[i] = px[i * 4 + 3] / 255;
  const on = (e, sized) => enabled(e) && e.opacity > 0 && (!sized || e.size > 0);
  const cl = (v) => Math.min(1, Math.max(0, v));
  const stroke = on(fx.stroke, true) ? fx.stroke : null, shadow = on(fx.shadow) ? fx.shadow : null;
  const overlay = on(fx.colorOverlay) ? fx.colorOverlay : null, inner = on(fx.innerShadow) ? fx.innerShadow : null;
  const glow = on(fx.outerGlow, true) ? fx.outerGlow : null, iglow = on(fx.innerGlow, true) ? fx.innerGlow : null;
  const ring = new Float32Array(n);
  if (stroke) {
    const reach = Math.max(1, Math.trunc(swiftRound(stroke.size)));
    const moved = spread(spread(first, W, H, reach, stroke.inside, true), W, H, reach, stroke.inside, false);
    for (let i = 0; i < n; i++) ring[i] = cl(stroke.inside ? first[i] - moved[i] : moved[i] - first[i]);
  }
  const softened = (e) => { const [dx, dy] = shadowOffset(e); const m = shift(first, W, H, dx, dy); return e.blur / 2 > 0.01 ? blur(m, W, H, e.blur / 2) : m; };
  const shadowCov = shadow ? softened(shadow) : null;
  const innerCov = inner ? softened(inner).map((v) => cl(1 - v)) : null;
  const glowCov = glow ? (glow.size / 2 > 0.01 ? blur(first, W, H, glow.size / 2) : first) : null;
  const iglowCov = iglow ? (iglow.size / 2 > 0.01 ? blur(first, W, H, iglow.size / 2) : first).map((v) => cl(1 - v)) : null;
  const col = (e) => [f32(e.red), f32(e.green), f32(e.blue)];
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    let color = [0, 0, 0], alpha = 0;
    const over = (k, c) => { color = color.map((v, j) => k[j] * c + v * (1 - c)); alpha = c + alpha * (1 - c); };
    if (shadow) { const c = cl(shadowCov[i] * shadow.opacity); color = col(shadow).map((v) => v * c); alpha = c; }
    if (glow) over(col(glow), cl(glowCov[i] * (1 - first[i]) * glow.opacity));
    const sc = stroke ? cl(ring[i] * stroke.opacity) : 0;
    if (stroke && !stroke.inside) over(col(stroke), sc);
    const src = [px[i*4] / 255, px[i*4 + 1] / 255, px[i*4 + 2] / 255, px[i*4 + 3] / 255];
    const recolor = (k, t) => { for (let j = 0; j < 3; j++) src[j] = src[j] + (k[j] * src[3] - src[j]) * t; };
    if (overlay) recolor(col(overlay), f32(overlay.opacity));
    if (iglow) recolor(col(iglow), cl(iglowCov[i] * iglow.opacity));
    if (inner) recolor(col(inner), cl(innerCov[i] * inner.opacity));
    color = color.map((v, j) => src[j] + v * (1 - src[3])); alpha = src[3] + alpha * (1 - src[3]);
    if (stroke && stroke.inside) over(col(stroke), sc);
    for (let j = 0; j < 3; j++) out[i * 4 + j] = Math.trunc(cl(color[j]) * 255 + 0.5);
    out[i * 4 + 3] = Math.trunc(cl(alpha) * 255 + 0.5);
  }
  return { pixels: out, W, H, inset };
}
```

`margin` uses `effects.visible`, so a shadow at opacity 0 still widens the canvas; the passes skip it. With every
visible effect at opacity 0 the image is just the pixels on a larger canvas, which looks the same.

### 5.4 The CPU fallback is not the same

Without Metal, `render` builds coverage images with `CIGaussianBlur` at `sigma = blur / 2` on a **clamped-to-extent**
8-bit gray image, and the deque max filter `extreme` (`:568-657`); every intermediate is quantized to 8 bits
(`GuidedMatte.levels/image`). It approximates the Metal result. The engine runs on a Mac with Metal, so the Metal path
is the reference.

### 5.5 Live behaviour upstream, and the board's plan

- **Canvas previews** (`Rendering/EffectsPreviewCache.swift`): one serial worker, 60 ms after a request
  (`:111`); the previous result stays on screen until the new one lands (`:99-110`, `:127`); the last 3 results per
  layer are kept for undo/redo (`:48-51`); results are reused across moves/scales/rotations of the same pixels
  (`:24-33`). Previews are capped at `sideLimit = min(1536, max(32, Int(sqrt(16,777,216 / layersWithEffects))))`
  pixels per side (`:76-79`) and scale only `stroke.size`, `shadow.distance` and `shadow.blur` by the reduction
  (`:157-160`), **not** the inner shadow or the glows, so on a layer larger than the cap the app's canvas shows those
  three relatively too large. Export is always full size. The board should render at full size (Worker or WebGL2); if
  it must reduce, scale every size, distance and blur (and say so in section 12).
- **Painting a layer with effects** (`Rendering/LayerEffectsSurface.swift`): the effects surface is updated only around
  the changed tiles. For a dirty rect `D` in layer pixels: `inner = (D grown by margin) ∩ surface`, `outer = inner
  grown by reach`, where `reach = ceil(max(1, stroke.size + 2, shadow.distance + shadow.blur*3 + 2, outerGlow.size*3 +
  2, innerGlow.size*3 + 2))` over enabled effects (`:32-40`); the effects are rendered on the window `outer` of the
  current pixels (through the mask, paint past the old pixel bounds unmasked, `:138-182`) and the window's `inner` part
  replaces the surface there (`:84-99`). The reach is wider than any pass's footprint, so the window result equals the
  full render inside `inner`. Board: the same, with `renderEffects` on the window.
- **Board cache key**: (layer image identity or version, mask version and placement-vs-transform when the mask is placed
  apart, the visible effects JSON). Moving, scaling or rotating reuses the image.

### 5.6 Effect test vectors

[verified] Document 120 x 100, one layer of 50 x 40 pixels at origin (35, 30), scale 1, Normal, 100 %. Its pixels:
straight `230,120,30` inside `x 5..44, y 5..34` of the layer, alpha 255 except alpha 128 for layer `x >= 40`, with a
transparent hole `x 18..27, y 14..23`. In document coordinates the shape is `x 40..79, y 35..64`, the hole
`x 53..62, y 44..53`, the translucent strip `x 75..79`. Outputs are straight RGBA (`getImageData` form).

| Effects | Document pixel -> RGBA |
|---|---|
| Stroke outside, size 4, color (0, 0.2, 1), opacity 1 | (37,50) 0,51,255,255 · (40,50) 230,120,30,255 · (53,50) 0,51,255,255 · (77,50) 154,97,104,191 · (80,50) 0,52,255,128 · (60,66) 0,51,255,255 · (60,70) 0,0,0,0 |
| Stroke inside, size 3.4 (reach 3), white, opacity 0.8 | (40,50) 250,228,210,255 · (50,50) 250,228,210,255 · (77,50) 244,197,158,179 · (53,50) 0,0,0,0 |
| Drop shadow, angle 120, distance 6, blur 8, black, opacity 0.6 (inset 32) | (37,50) 0,0,0,13 · (39,50) 0,0,0,29 · (53,50) 0,0,0,127 · (57,50) 0,0,0,93 · (77,50) 159,83,21,184 · (80,50) 0,0,0,76 · (60,66) 0,0,0,122 · (60,70) 0,0,0,72 · (78,40) 189,99,25,155 |
| Color overlay (0.1, 0.6, 0.9), opacity 0.7 | (40,50) 87,143,170,255 · (77,50) 86,143,169,128 |
| Inner shadow, angle 45, distance 4, blur 6, black, opacity 0.75 | (40,50) 207,108,27,255 · (42,50) 223,116,29,255 · (50,50) 148,77,19,255 · (45,36) 114,60,15,255 · (77,50) 100,52,14,128 |
| Outer glow, size 7, (1, 1, 0.5), opacity 0.75 (inset 23) | (37,50) 255,255,130,45 · (39,50) 255,255,126,85 · (53,50) 255,255,129,105 · (77,50) 233,141,45,152 · (82,50) 255,255,128,24 · (60,70) 255,255,116,11 |
| Inner glow, size 5, white, opacity 0.75 | (40,50) 238,163,101,255 · (42,50) 233,136,56,255 · (45,36) 235,149,78,255 · (77,50) 239,169,114,128 |
| All six: stroke 2 black; shadow 90/8/10 black 0.5; overlay (0.9,0.9,0.2) 0.4; inner shadow 90/3/4 black 0.5; outer glow 5 (1,0.5,0) 0.6; inner glow 4 white 0.5 (inset 40) | (37,50) 107,54,0,57 · (39,50) 0,0,0,255 · (40,50) 188,146,65,255 · (50,50) 220,160,47,255 · (57,50) 48,26,0,100 · (77,50) 160,119,52,172 · (80,50) 27,13,0,160 · (60,70) 6,3,0,86 · (45,36) 142,106,38,255 |

---

## 6. Shared panel controls

All panels are non-modal floating panels; the close button means Cancel (`ContentView.swift:228-279`). The board's
`board.panel(...)` already provides title, body and Cancel / OK (`media/filters.js:35-54`).

- **Filter-panel slider row** (`UI/FilterSheet.swift:348-375`): title (fixed size; all titles share the widest title's
  width, at least 60 pt, `:16-17`, `:191`); drag the title to scrub at `1 / 10^decimals` per point, clamped to the
  range (`UI/NumericScrub.swift:29-37`, resize-left-right cursor); a slider, logarithmic when marked (the slider runs
  over `log(range)` and writes `round(exp(v) * 10^d) / 10^d`); a 56 pt right-aligned field showing 0...`decimals`
  fraction digits followed by the unit (`unitSuffix`: 2 pt gap). The field writes the typed value **unclamped**;
  `updateFilter` then normalizes only the kinds that have a `normalized` form (section 7.3).
- **Colored-track rows** (Black & White, Color Balance) use `CameraRawSlider` with tooltip "`<Title>`. Double-click to
  reset."; a double-click on the title or knob puts that one value back to its `FilterSettings()` default
  (`:332-337`, `:356`, `:360-364`). Tracks (`UI/CameraRawSlider.swift:21-55`): `luminance(h)` = HSB(h, 0.55, 0.18) to
  HSB(h, 0.35, 0.95); `saturation(h)` = sRGB (0.55, 0.55, 0.56) to HSB(h, 0.9, 0.9); `spectrum(h)` = 13 stops HSB(h +
  k*30, 0.85, 0.9) for k = -6...6; `chroma` = (0.62, 0.62, 0.64) to (0.86, 0.18, 0.20); `opposing(a, b)` = a to b; Color
  Balance pairs: cyan (0.10, 0.72, 0.80) / red (0.86, 0.18, 0.20), magenta (0.80, 0.22, 0.70) / green (0.24, 0.70,
  0.30), yellow (0.95, 0.82, 0.18) / blue (0.22, 0.40, 0.92) (`UI/FilterSheet.swift:339-344`).
- **Filter panel frame**: 24 pt padding, 380 pt wide, height fits content; "Preview" toggle; an orange error line when
  the preview failed; "Limited to the selection" (callout, secondary) only for destructive use with a selection;
  divider; Cancel (Esc) left, OK (Return, prominent) right; spinner + "Applying…" while committing
  (`:165-195`). The whole panel is disabled while committing (`:197`).
- **Effects slider row** (`UI/EffectsSheet.swift:170-192`): 64 pt title (scrub 1 unit per point over the *field*
  range); 130 pt slider over the *slider* range (a larger typed value pins the knob at the end); 48 pt field, no
  decimals, clamped to the field range; Up/Down step 1, Shift 10 (`ContentView.swift:442-469`); unit suffix.

---

## 7. Adjustment layers: behaviour by checklist line

Split notation: **Board** = JS in the webview; **Engine** = an `EditorSession` call through a request of section 10.

### 7.1 Creating and editing

- **"Layer › New Adjustment Layer submenu"** — Items in `AdjustmentKind.allCases` order: Hue/Saturation…, Levels…,
  Curves…, Exposure…, Gradient Map…, Grain…, Add Noise…, Gaussian Blur…, Motion Blur…, Invert, Black & White…, Color
  Balance… (`kind.rawValue + (kind.isEditable ? "…" : "")`, `CompositorApp.swift:342-346`). Disabled when
  `!canEditLayers || document == nil`. The Layers-panel footer has the same list **without** ellipses
  (`UI/LayersPanel.swift:45-49`), icon `circle.lefthalf.filled`, tooltip "New adjustment layer", disabled unless
  `layersLookEditable`. **Board**: menu and footer items; **Engine**: `adjustment.add` (10.2).
- **"New adjustment layer placement"** — `addAdjustment` (`Document/LayerAdjustment.swift:208-229`): refuses at 10,000
  layers or `!canEditLayers`; new record named `kind.rawValue`, transform = canvas rect, no image; `parentID` = the
  active layer when it is a folder, else the active layer's parent; inserted at **array index(active) + 1** (or at
  the end with no active layer); the parent folder is expanded; becomes active; one undo step "New `<Kind>`
  Adjustment". Note the array position: with a folder active, the record goes right after the folder record, which
  differs from the board's `insertAbove` (top of the folder). Use the engine op, or copy this rule exactly.
- **"Editor opens on creation"** — `if kind.isEditable { adjustmentEditingID = layer.id }` (`:227-228`): every kind
  except Invert opens its editor (7.1 "Live preview").
- **"New Gradient Map defaults"** — shadows = foreground, highlights = background (`:214-216`). **Engine** reads
  `foreground`/`background` from the request (`configure`, `engine/Sources/SelectionOps.swift:113-120`).
- **"New Grain / Add Noise layer seed"** — `grain.seed = .random(in: UInt32)` / `noiseSeed = .random` (`:217-218`).
- **"Layer › Edit Adjustment…"** — sets `adjustmentEditingID = activeLayerID`; disabled unless `canEditLayers` and the
  active layer has `adjustment` (`CompositorApp.swift:347-349`). For Invert it is enabled, but `beginAdjustmentEditing`
  opens no panel (`case .invert: break`, `Document/AdjustmentEditing.swift:26`) while still setting
  `adjustmentOriginal` and beginning the edit (`:58-59`). Nothing then calls `finishAdjustmentEditing` except closing
  or quitting the project (`settlePendingEdits`, `Document/ProjectWorkspace.swift:135-142`), so layer commands and file
  operations stay blocked. The board should disable the item for Invert (section 12).
- **"Double-click to edit"** — a double-click on the row's thumbnail (or another control in the row) of an editable
  adjustment opens its editor; on the name it renames (`UI/NativeLayerList.swift:396-404`).
- **"Layers-panel row look"** — square 36 x 36 SF Symbol icon per kind (`Document/LayerAdjustment.swift:10-25`):
  Curves `point.topleft.down.to.point.bottomright.curvepath` (rotated a quarter turn clockwise), Levels
  `slider.horizontal.3`, Hue/Saturation `circle.lefthalf.filled`, Exposure `plusminus.circle`, Gradient Map
  `paintpalette`, Grain `circle.grid.3x3`, Gaussian Blur `drop.fill`, Motion Blur `wind`, Add Noise `circle.dotted`,
  Invert `circle.righthalf.filled`, Black & White `circle.filled.pattern.diagonalline.rectangle`, Color Balance
  `scale.3d`; subtitle "Adjustment · Double-click to edit" (replaced by "Clipped to `<base>`" when clipped); no
  mask-link button on adjustment rows (`UI/NativeLayerList.swift:1009-1047`). **Board**: inline SVG or codicon
  stand-ins (section 11).
- **"Editors reuse the destructive panels"** — Levels -> Levels panel, Hue/Saturation -> Hue/Saturation panel, the
  rest -> the Filter panel with `FilterKind` = `kind.filterKind` (`Document/AdjustmentEditing.swift:25-57`). The
  settings are copied into a fresh `FilterSettings` (`:43-55`).
- **"Editor input is the composite underneath"** — `beginAdjustmentEditing` renders the project with every non-folder
  layer from the adjustment upward (in `LayerHierarchy.entries` order) hidden (`:12-21`); that image is the Levels
  histogram source, the Levels eyedroppers' "original layer", and nothing else. **Engine**: `levels.histogram`
  (10.3). **Board**: eyedroppers sample `input[adjID]` (its own composite below the adjustment).
- **"Live preview into layer settings"** — each control change calls `previewAdjustmentEditing(preview:)`, which
  writes the edited value (or the original when Preview is off) into the layer with `updateAdjustment` (no undo step;
  refused when `!value.isValid`) (`:100-106`, `Document/LayerAdjustment.swift:230-234`). **Board**: write
  `record.adjustment` in memory, `composite.dirty`, redraw (section 1.6 slider row); no history entry.
- **"OK / Cancel semantics"** — `finishAdjustmentEditing(commit:)` writes the edited (OK) or original (Cancel, Esc,
  close button) value and ends the edit begun at open, named "Edit `<Kind>` Adjustment"; unchanged = no step
  (`Document/AdjustmentEditing.swift:59`, `:108-130`, `Document/DocumentHistory.swift:62-74`). **Board**: snapshot
  the manifest at open; OK pushes one history entry `{label: 'Edit <Kind> Adjustment', metaBefore, metaAfter}` if the
  JSON changed (as `commitOpacity`, `media/board.js:1636-1646`); Cancel restores the snapshot, no entry.
- **"No selection limit when editing"** — editors are built with `selection: nil` (`:28`, `:39`, `:56`); "Limited to
  the selection" is hidden when `adjustmentOriginal != nil` (`UI/FilterSheet.swift:170-172`,
  `UI/HueSaturationSheet.swift:61-63`); the Levels caption reads "Underlying pixels · alpha-weighted histogram"
  (`UI/LevelsSheet.swift:75`).
- **"Editing blocks file operations"** — `canStart`-style checks include `adjustmentEditingID == nil`
  (`Document/EditorSession.swift:153`); setting it back to nil resumes queued requests (`:109`). Also blocks
  `canEditLayers` (`:700`), so the Layers panel is gray. **Board**: while an adjustment editor is open, defer saves
  and external reloads, and disable layer commands.
- **"Settings validation"** — `LayerAdjustment.isValid` (`Document/LayerAdjustment.swift:128-141`, listed in
  `docs/port-specs/manifest.md` section 7.1): `|hue| <= 360`, `|saturation|, |lightness| <= 100` (also inside every
  `hsvSettings.adjustments` value), band handles finite, levels ranges equal their normalized form, curves valid,
  exposure / gradient map / grain / B&W / color balance valid, `blurRadius` 0.1...250, `motionAngle` -90...90,
  `motionDistance` 1...2000, `noiseAmount` 0.1...400. **Board**: port `isValid`; never write an invalid record (the
  engine would refuse to load the project).

### 7.2 Where adjustments apply

- **"Whole-composite input"**, **"Blend mode"**, **"Opacity"**, **"Mask and folder-mask clip"**, **"Clipped
  adjustment"**, **"Not a clipping base"** — section 2, all [verified].
- **"Document-anchored noise"** — section 2.7, 3.9, 3.10. The board composites in document pixels, so the pattern is
  the export's at every zoom (the app's GPU canvas differs at zooms other than 100 %, section 1.1).
- **"Blur halo"** — section 1.6 (use the sum of margins for chained blurs).
- **"GPU canvas path"** — documented in 1.1 as the app's approximation; the board does not copy it.
- **"16-bit / HDR below"** — the board composites 8-bit (16-bit PNGs decode to 8 bits; HDR layers are placeholders,
  `docs/port-specs/compositing.md` section 10). Adjustments over them show the 8-bit result. Not applicable beyond that.

### 7.3 Settings flow common to Filter-panel kinds

`updateFilter(settings, preview:)` normalizes (`FilterSettings.normalized`, `Document/Filters.swift:127-162`: clamps
`radius`, `angle`, `distance`, `amount`; `exposure.normalized`, `gradientMap.normalized`, `grain.normalized`), then for
an adjustment layer goes straight to `previewAdjustmentEditing` (`:779`). Curves, Black & White and Color Balance have
**no** normalization: a typed value outside the range is kept in the panel, the layer silently keeps its last valid
settings (`isValid` fails), and the destructive preview shows "This is not a valid Compositor project, or its metadata
is damaged." in orange (`ProjectError.invalid`, `IO/ProjectStore.swift:73`, thrown by `apply`). Port that, or clamp
(section 12).

### 7.4 Hue/Saturation

- **"Panel"** — floating "Hue/Saturation", 24 pt padding, 460 pt wide (`UI/HueSaturationSheet.swift:72`), close =
  Cancel (`ContentView.swift:242-248`); ⌘U opens the destructive variant (section 9).
- **"Range picker"** — menu picker, 160 pt, label hidden: Master, Reds, Yellows, Greens, Cyans, Blues, Magentas;
  disabled while Colorize is on (`:36-39`). Each range keeps its own `{hue, saturation, lightness}`; the sliders edit
  the selected range (`Document/HueSaturation.swift:186-198`).
- **"Default hue bands"** — falloff start / range start / range end / falloff end: Master 0/0/360/360, Reds
  315/345/15/45, Yellows 15/45/75/105, Greens 75/105/135/165, Cyans 135/165/195/225, Blues 195/225/255/285, Magentas
  255/285/315/345 (`:10-20`).
- **Slider rows** (`:125-142`): 76 pt title (double-click resets that value; drag scrubs 1 per point within the
  slider range), `CameraRawSlider` (writes `value.rounded()`, double-click resets, tooltip "`<Title>`. Double-click to
  reset."), 48 pt field, no decimals, unit suffix.
- **"Hue slider"** — −180…180 °, or 0…360 ° with Colorize (`:10`); track `spectrum(Colorize ? 180 : rangeHue)` where
  `rangeHue` = 60 x (index of the range among Reds…Magentas), Master 0 (`:16-18`); reset value 0.
- **"Saturation slider"** — −100…100, or 0…100 with Colorize (`:11`); track `saturation(hue)` in Colorize,
  `chroma` for Master, `saturation(rangeHue)` otherwise (`:19-22`); reset 0 (25 in Colorize). Math: section 3.8.
- **"Lightness slider"** — −100…100, track black to white, reset 0; pulls toward white above 0, black below (3.8).
- **"Field Return commits"** — `onSubmit`: clamp the value to the slider range, then OK (`:136-140`).
- **"Spectrum editor"** — shown for a color range without Colorize (`:48-51`): a 16 pt "before" bar of 72 hue slices
  (HSB(h, 1, 1), h = slice/72 x 360), a 12 pt handle strip, a 16 pt "after" bar where each slice shows
  `shiftedHue(h)` (hue shifts only), then the four handles' degrees rounded and joined by three spaces, e.g.
  "`315°   345°   15°   45°`" for Reds (caption, monospaced digits) (`:147-174`). Handles: outer marks 7 x 5 at mid-height, inner bars 2 pt wide full
  height (`:177-188`); a drag grabs the nearest handle by circular distance (`:203-209`) and keeps it for the drag;
  `setHandle` refuses changes that break the order or make the band span ≤ 1 or > 350 degrees
  (`Document/HueSaturation.swift:117-131`).
- **"Apply outside this range instead"** — toggle, default off, shown with the spectrum (`:50`); inverts the selected
  range's weight (3.8).
- **"Colorize"** — toggle: on -> `colorizeStart` (Master, hue 0, sat 25, light 0, colorize); off -> identity
  (`:53-56`).
- **"Preview toggle"** — default on; off shows the unadjusted pixels (destructive) or the original settings (layer).
- **"Reset button"** — identity, or `colorizeStart` while colorizing (`:58`).
- **"Sample eyedropper"**, **"Add eyedropper"**, **"Remove eyedropper"** — three `eyedropper` buttons (Add / Remove
  with `plus.circle.fill` / `minus.circle.fill` badges), shown only with the spectrum; click toggles which is armed,
  disarming the targeted tool; armed background = accent at 25 %; tooltips "Click the image to center this range on
  that color", "Click the image to widen this range to include that color", "Click the image to narrow this range to
  exclude that color" (`:76-94`, `Document/HueSaturation.swift:146-152`). A canvas click (not with Space) calls
  `sampleHueRange` (`Rendering/EditorCanvas.swift:1794-1803`): `centered(on:)`, `include(_:)` or `exclude(_:)` on the
  selected range's band (`Document/HueSaturation.swift:56-101`, quoted math there), then the panel regains focus.
- **"Eyedropper sampling source"** — `sampledHue`: the visible composite at `floor(point)` (`sampleCompositeColor`,
  `Document/ColorPalette.swift:239-260`, which includes the adjustment being edited), HSB hue in degrees, nil when HSB
  saturation ≤ 0.02 -> beep, nothing changes (`Document/HueSaturation.swift:569-579`). **Board**: sample its own
  composite.
- **"Targeted adjustment tool"** — `hand.point.up.left` button, hidden in Colorize; tooltip "Targeted adjustment: drag
  on the image to change that color's saturation, or its hue with Command held" (`:95-107`). Press: the range with the
  largest weight for the sampled hue becomes the selected range (`:590-602`); drag: saturation (or hue with ⌘) =
  start value + horizontal view-point delta / 2, clamped ±100 / ±180 (`:605-616`); resize-left-right cursor.
- **"Live preview"** — destructive: up to 8000 px on the long side (`previewLimit`, `:416`), coalescing renders
  (`:479-511`). Layer: through the layer settings.
- **"Cancel (Esc) / OK (Return)"** — OK on identity changes nothing; otherwise one undo step "Hue/Saturation"
  (destructive, `:515-565`) or "Edit Hue/Saturation Adjustment" (layer).

### 7.5 Levels

- **"Panel"** — floating "Levels", 24 pt padding, 440 pt wide (`UI/LevelsSheet.swift:86`), close = Cancel; ⌘L
  destructive.
- **"Channel picker"** — RGB, Red, Green, Blue, 180 pt wide (`:19-21`); each channel keeps a `LevelRange`; output =
  `RGB(channel(v))` (3.1).
- **"Histogram"** — 150 pt high, black 25 % background; bars per bin, height `min(1, bin / scale)` with
  `scale = min(peak, 4 x the 95th-percentile non-zero interior bin)` (`Document/Levels.swift:47-56`); gray / red /
  green / blue by channel; "Loading histogram…" (caption, 8 pt inset) until ready; tooltip "Linear histogram with
  automatic vertical scaling. Tall spikes may extend beyond the graph; all tones from 0 to 255 remain included."
  (`:22-28`, `:99-114`). Bins: `levels_histogram` (`Rendering/LevelsPixels.c:17-28`) — per pixel with alpha > 0,
  weight = `alpha/255 x selectionCoverage/255`, value = `(int)fmin(255, round(p*255.0/a))`, channel bin += weight, RGB
  bin += weight / 3 (so RGB is the mean of the three channel histograms). **Engine**: `levels.histogram` (10.3);
  board port as fallback.
- **"Input handles"** — three `triangle.fill` handles, 12 pt, 22 x 20 hit box, black / gray / white, under the
  histogram (`:115-145`). Black = `min(white - 1, round(x))`; white = `max(black + 1, round(x))`; the gamma handle sits
  at `black + (white - black) x 0.5^gamma` and sets `gamma = log(f) / log(0.5)` with `f = clamp((x - black) / (white -
  black), 0.001, 0.999)`; `x` = pointer position / width x 255, clamped 0...255.
- **"Input black field"**, **"Gamma field"**, **"Input white field"**, **"Output black field"**, **"Output white
  field"** — 80 pt right-aligned fields under captions "Input black", "Gamma", "Input white", "Output black", "Output
  white"; gamma with 2 decimals, the rest integers; captions scrub (1 per point, gamma 0.01 per point, over 0…255 /
  0.1…9.99) (`:29-44`, `:89-98`). Every write goes through `LevelRange.normalized` (`Document/Levels.swift:36-38`):
  black 0…254, white black+1…255, gamma 0.1…9.99, outputs 0…255; output black may exceed output white (inverts).
- **"Output gradient bar"** — 14 pt black-to-white gradient, then two handles (output black, output white).
- **"Sample eyedroppers Black / Gray / White"** — caption "Sample", three `eyedropper` buttons labelled Black, Gray,
  White, accent tint when armed; click again to disarm; hint "Click the original layer to set black. Click the
  eyedropper again to stop." (`:45-59`). A canvas click (not with Space) samples the **original** layer pixel at
  `floor(point)` (destructive: the layer's own pixels; adjustment: the underlying composite), unpremultiplied, and
  sets that point on Red, Green and Blue together, resets RGB to identity and outputs to 0/255 (`sampling`,
  `Document/LevelsAutomatic.swift:41-59`, `:68-83`). While Levels is open other canvas clicks do nothing except with
  Hand, Zoom or Space (`Rendering/EditorCanvas.swift:1781-1786`).
- **"Auto: Contrast"**, **"Auto: Color"**, **"Auto: Color + neutral midtones"** — caption "Auto", buttons "Contrast",
  "Color", "Color + neutral midtones", disabled until the histogram is ready (`:60-67`). `LevelsAuto.settings`
  (`Document/LevelsAutomatic.swift:6-36`): endpoints = first bin from each end where the running sum exceeds 0.1 % of
  the total (need low < high); Contrast: RGB range black = min of the channel lows, white = max of the highs; Color:
  per channel; neutral also sets `gamma = clamp(log(mean) / log(0.5), 0.1, 9.99)` where `mean` = the bin-weighted mean
  of `range.apply(i/255)`. Pure functions of the bins: port to JS.
- **"Preview toggle"** — default on; ⌥P (remappable "Toggle Levels preview", `UI/KeyboardShortcuts.swift:141`).
  While Levels is open the canvas also takes Esc (Cancel), Return or Enter (OK) and ⌥P itself, and passes every other
  key except Space up instead of running canvas shortcuts (`Rendering/EditorCanvas.swift:2213-2219`).
- **"Reset button"** — all channels identity, eyedropper disarmed (`:73`).
- **"Source caption"** — "Original pixels · alpha-weighted histogram", "Original pixels · selection and
  alpha-weighted histogram" with a selection, "Underlying pixels · alpha-weighted histogram" for a layer (`:75`).
- **"Cancel (Esc) / OK (Return)"** — spinner while committing; identity OK = Cancel (no step); destructive OK one step
  "Levels" (`Document/Levels.swift:205-238`).
- **"Preview resolution"** — full size up to 8000 px on the long side (`:129-141`).

### 7.6 Curves

- **"Panel"** — the Filter panel titled "Curves" containing `CurvesControls` (`UI/FilterSheet.swift:22-23`); ⌘M
  destructive.
- **"Channel picker"** — RGB, Red, Green, Blue (default RGB); changing it clears the selected and dragged point
  (`UI/CurvesControls.swift:10-12`). Math: 3.2.
- **"Graph"** — 260 pt high, black 35 % background, 4 x 4 grid of 1 pt white 12 % lines, the curve sampled at x =
  0…255 as a 2 pt white polyline, points as 8 pt circles (accent when selected) (`:13-33`).
- **"Click to add a point"** — with no point within 14 **levels** (Euclidean, in 0…255 units) of the press: add one if
  the channel has fewer than 32 points, `1 < x < 254`, and every point is more than 1 level away in x; it becomes the
  dragged point (`:40-47`). x and y are not rounded.
- **"Drag a point"** — the nearest point within 14 levels; y = pointer (0…255, y up); interior points' x is limited to
  `[prev.x + 1, next.x - 1]`; endpoints move only in y; the dragged point becomes selected (`:41-54`).
- **"Selected point readout"** — "Input `N` · Output `N`" with `Int()` truncation, monospaced digits (`:58-60`).
- **"Remove point button"** — "Remove point", removes the selected interior point; disabled for none or an endpoint.
- **"Reset curve button"** — "Reset curve": this channel back to `[(0,0), (255,255)]` (`:66`).
- **"Hint text"** — "Click to add a point. Drag to adjust." (caption, secondary) (`:56`).

### 7.7 Exposure

- **"Exposure slider"** — "Exposure", −20…20, 2 decimals, linear slider, no unit, default 0 (`UI/FilterSheet.swift:
  25`). Math 3.3.
- **"Offset slider"** — "Offset", −0.5…0.5, 4 decimals, default 0 (`:26`).
- **"Gamma Correction slider"** — titled **"Gamma"** in the panel, 0.01…9.99, logarithmic, 2 decimals, default 1
  (`:27`).
- **"HDR exactness"** — not applicable on the board (HDR not displayed).

### 7.8 Gradient Map

- **"Gradient preview bar"** — 20 pt linear gradient dark end -> light end (after Reverse), 4 pt corners, 35 % black
  border (`UI/FilterSheet.swift:387-392`).
- **"Shadows swatch"**, **"Highlights swatch"** — 24 x 24 swatches (6 pt corners, 1.5 pt white inner and 1 pt black
  outer border) with labels "Shadows" / "Highlights", tooltips "Choose the shadows color" / "Choose the highlights
  color" (`:394-420`). A click opens the app's color picker (`openGradientMapColorPicker`,
  `Document/ColorPalette.swift:141-146`); the canvas follows the working color live (`previewGradientMapColor`,
  `:172-175`); picker OK keeps it, Cancel restores (`:121-123`). **Board**: `media/picker.js` with a live callback.
- **"Reverse toggle"** — "Reverse", default off: swaps which end maps to dark (`Document/ImageAdjustments.swift:87`).
- **"Mapping"** — 3.5.

### 7.9 Grain

- **"Amount slider"** — "Amount", 0…100, integer, linear, default 25; 0 = no effect (`UI/FilterSheet.swift:65`).
- **"Size slider"** — "Size", 0.5…20 px, logarithmic, 1 decimal, default 1.5 (`:66`).
- **"Roughness slider"** — "Roughness", 0…100, integer, default 50 (`:67`).
- **"Character"** — 3.9.

### 7.10 Add Noise

- **"Amount"** — "Amount", 0.1…400 %, logarithmic, 1 decimal; adjustment-layer default 10 (`UI/FilterSheet.swift:
  114`, `Document/LayerAdjustment.swift:104-107`).
- **"Distribution"** — label "Distribution" + segmented "Uniform" / "Gaussian", default Uniform (`:115-122`).
- **"Monochromatic toggle"** — "Monochromatic", default off (`:123`). Math 3.10.

### 7.11 Gaussian Blur

- **"Radius"** — "Radius", 0.1…250 px, logarithmic, 1 decimal; adjustment default 10 (`UI/FilterSheet.swift:89`,
  `Document/LayerAdjustment.swift:92-95`). Math 3.11.
- **"Preserve Transparency toggle is shown in the editor but not stored"** — the toggle appears ("Preserve
  Transparency", tooltip "Blur only the colors, keeping the layer's outline and transparency as they are") but only
  the radius goes back to the layer (`Document/AdjustmentEditing.swift:86`). **Board**: show it, ignore it for layers
  (or hide it; section 12).

### 7.12 Motion Blur

- **"Angle"** — "Angle", −90…90 °, integer, linear, default 0, counterclockwise from horizontal
  (`UI/FilterSheet.swift:111`).
- **"Distance"** — "Distance", 1…2000 px, logarithmic, integer, default 10 (`:112`). Math 3.12.

### 7.13 Invert

- **"Invert adjustment layer"** — no settings, no editor, not double-click editable; inverts everything below (3.4).

### 7.14 Black & White

- **"Reds"**, **"Yellows"**, **"Greens"**, **"Cyans"**, **"Blues"**, **"Magentas"** sliders — −200…300 %, integer,
  colored tracks `luminance(0 / 60 / 120 / 180 / 240 / 300)`, defaults 40 / 60 / 40 / 60 / 20 / 80, double-click
  resets (`UI/FilterSheet.swift:33-38`).
- **"Tint toggle"** — "Tint", default off, tooltip "Color the result while keeping its tones, for a sepia or a
  cyanotype" (`:39-40`).
- **"Tint Hue slider"** — "Hue", 0…360 °, integer, plain track, default 40, only with Tint (`:41-42`).
- **"Tint Saturation slider"** — "Saturation", 0…100 %, integer, track `saturation(tintHue)`, default 20 (`:43-44`).
  Math 3.6.

### 7.15 Color Balance

- **Nine sliders** under headline titles "Shadows", "Midtones", "Highlights", each row titled "Cyan / Red", "Magenta /
  Green", "Yellow / Blue": −100…100, integer, no unit, opposing tracks, default 0, double-click resets
  (`UI/FilterSheet.swift:50-61`).
- **"Preserve Luminosity toggle"** — "Preserve Luminosity", default on, tooltip "Put each pixel's brightness back
  afterwards, so only the color moves" (`:62-63`). Math 3.7.

---

## 8. Layer effects: behaviour by checklist line

Effects are manifest metadata (no pixels change), so every edit below is a **board-side manifest edit**
(`board.edit(label, fn)`, `media/board.js:629-638`) with upstream's exact undo label, validated with the ranges of 5.1
before writing. No engine request is needed (the engine reads them on any later load).

- **"Six kinds, listed and rendered in this order"** — Stroke, Drop Shadow, Color Overlay, Inner Shadow, Outer Glow,
  Inner Glow (`LayerEffectKind.allCases`, `Document/LayerEffects.swift:226-228`); one of each per layer; rendering
  order is section 5.3.
- **"Add from the footer effects menu"** — footer `sparkles` menu (tooltip "Add layer effect"), items "`<Effect>`…"
  (`UI/LayersPanel.swift:50-57`); disabled when `!layersLookEditable`, the active layer is a folder, or it has no
  pixels. `addEffect` (`:247-276`): if that effect's panel is already open for this layer, nothing; else close any
  other effect panel as Cancel, add the effect if missing (Stroke and Color Overlay take the **background** color;
  others their model defaults), record "Add `<Effect>`" (only if it was missing), select it and open its panel with
  Cancel restoring the state before the add.
- **"Only for layers with pixels"** — `canEditEffects = canEditLayers && !isGroup && asset != nil` (`:236`);
  `setEffects` re-checks (`:315-319`). Text and shape layers qualify (they have pixels).
- **"Effect sub-rows"** — one 24 pt row per present effect under the layer row, indented `38 + min(depth, 8)*24 (+24
  when clipped)` pt; an eye button (`eye` / `eye.slash`, 20 x 22, secondary tint, accessibility "Hide/Show
  `<Effect>`") toggles `enabled` with undo "Hide `<Effect>`" / "Show `<Effect>`" (`toggleEffect`, `:364-369`); the
  11 pt label is dimmed when hidden; a click selects the effect (accent 30 % background, also selects its layer, mask
  target off), a double-click opens its panel; tooltip "Click to select; double-click to edit; Option-drag to copy
  `<effect lowercased>`" (`UI/NativeLayerList.swift:984-991`, `:1199-1291`). Option-drag (3 pt threshold) onto another
  layer row copies the effect (`copyEffect`, undo "Copy `<Effect>`", `:336-362`; the target must have pixels; an open
  panel for that target effect is committed first).
- **"Delete a selected effect"** — Delete key, footer trash (tooltip "Delete selected effect") or Layer › "Delete
  `<Effect>`" remove it, undo "Remove `<Effect>`"; closes its panel if open (`:371-382`,
  `Document/SelectionEdits.swift:76-88`, `CompositorApp.swift:390`).
- **"Effect panel"** — floating panel titled with the effect name, 20 pt padding, 340 pt wide (`UI/EffectsSheet.swift:
  26`); Cancel (Esc) and OK (Return) both right-aligned after a spacer, OK without the `.borderedProminent` style the
  other panels give it (`:18-24`). Cancel restores only this
  effect to its value at open (removing a just-added one) with undo "Cancel `<Effect>`" when that changes anything
  (`:293-313`); OK keeps. The panel closes itself if the effect disappears (undo, another delete)
  (`ContentView.swift:256-262`).
- **"Panel edits are live"** — every change calls `changeEffects`, bound to the layer that opened the panel
  (`:326-334`), which records **one undo step per change**, "Edit `<Effect>`". A slider drag therefore leaves many
  steps (section 12).
- **"Every slider row"** — section 6 (effects row).
- **"Color swatch"** — 36 x 18, 3 pt corners, white 1 pt inner and black 1 pt outer borders, tooltip "`<Effect>`
  color"; opens the app's color picker; the layer follows the working color live (`previewEffectColor`, one "Edit"
  step per picker change); picker OK keeps, Cancel restores the original color (`UI/EffectsSheet.swift:154-168`,
  `Document/ColorPalette.swift:96-100`, `:119-121`, `:153-157`).
- **"Composite order"** — 5.3.
- **"Rendered on the GPU … results cached; painting updates effects only where the paint changed"** — 5.5.
- **"Image Size scales every effect"** — `scaled(by:)` multiplies stroke size, both shadows' distance and blur and both
  glow sizes, capped at their maxima (`:140-153`); applied by Image Size (`IO/ImageResizer.swift:101`, outside this
  area).
- **"Stroke › Position"** — headline "Stroke" with a segmented "Outside" / "Inside" picker on the right (default
  Outside) (`UI/EffectsSheet.swift:33-44`).
- **"Stroke › Color swatch"** — row "Color" (64 pt) + swatch; default background color when added (model default
  black).
- **"Stroke › Size"** — "Size", slider 0…20, field 0…500 px, default 4; square reach (5.3).
- **"Stroke › Opacity"** — "Opacity", 0…100 %, default 100 (stored 0…1).
- **"Drop Shadow › Color swatch"** — swatch at the right of the "Drop Shadow" headline; default black.
- **"Drop Shadow › Opacity"** 0…100 %, default 50; **"Angle"** −180…180 °, default 90 (the model accepts ±360);
  **"Distance"** slider 0…100, field 0…5000 px, default 20; **"Blur"** slider 0…100, field 0…500 px, default 20
  (`:60-81`).
- **"Color Overlay › Color swatch"** (default background color when added) and **"Opacity"** 0…100 %, default 100.
- **"Inner Shadow"** — swatch (default black); Opacity 50; Angle −180…180, default 90; Distance slider 0…50, field
  0…5000, default 10; Blur slider 0…100, field 0…500, default 10 (`:97-118`).
- **"Outer Glow"** — swatch (default white); Size slider 0…100, field 0…500, default 20; Opacity 75 (`:120-135`).
- **"Inner Glow"** — swatch (default white); Size slider 0…100, field 0…500, default 10; Opacity 75 (`:137-152`).

Slider values are continuous (CGFloat, not rounded); the field shows them with no decimals.

---

## 9. Image-menu adjustments (destructive)

Image menu (`CompositorApp.swift:294-307`): "Curves…" ⌘M, "Levels…" ⌘L, "Hue/Saturation…" ⌘U, then "Black &
White…", "Color Balance…", "Exposure…", "Gradient Map…", "Grain…" (no shortcuts), then "Invert" / "Invert Mask" ⌘I.
Enabled: `canAdjustColors` (`Document/HueSaturation.swift:453-462`: one selected, visible, non-folder layer with
pixels, pixels targeted not mask, a non-empty selection if any, no other dialog, stroke, text edit, import or rename),
and except for Hue/Saturation and Invert also `hueSaturation == nil`.

Board flow (all kinds): open the panel (sections 7.4-7.15 controls) on the active layer; the **preview** is computed in
JS from the layer's own pixels with the section 3 kernel (no position dependence except Grain, which uses layer pixels
from origin 0 with `unitsPerPixel = 1`), blended through the selection coverage on the layer grid when there is a
selection (`docs/port-specs/selection.md` section 5.9: `out = adjusted*cov + original*(1 - cov)`), and shown as a
renderer override of the layer (as `media/filters.js:91-96`), coalescing renders. OK sends the settings to the
engine (10.4, 10.5), keeps the preview up until the saved result lands, then removes the override. Cancel removes the
override. The commit replaces the layer image and **drops live text and shape** (the new `ImageLayer` is built
without them, `Document/Filters.swift:990-993`, `Levels.swift:232-235`, `HueSaturation.swift:559-563`).

- **"Image › Curves…"** — Filter panel with Curves controls; undo "Curves". No no-op guard: OK always records a step,
  even at identity (a new image object counts as a change, `Document/EditorSession.swift:5-7`).
- **"Image › Levels…"** — Levels panel; the histogram is the layer's pixels (preview source up to 8000 px) weighted by
  alpha and selection coverage (`Document/Levels.swift:149-168`, `:86-101`); identity OK = Cancel; undo "Levels".
- **"Image › Hue/Saturation…"** — disabled only by `canAdjustColors`; identity OK changes nothing; undo
  "Hue/Saturation".
- **"Image › Black & White…"**, **"Image › Color Balance…"** — undo named after the kind; no no-op guard.
- **"Image › Exposure…"** — OK with all three at defaults closes like Cancel (`Document/Filters.swift:882`).
- **"Image › Gradient Map…"** — every open starts from foreground -> background (`:721-724`), whatever was used last.
- **"Image › Grain…"** — the pattern sits in layer pixels (origin 0, one unit per layer pixel at full size; the 2048
  px preview cap does not apply to Grain, `:624`) and each open gets a fresh random seed fixed while the panel is open
  (`FilterEdit.seed`, `:458`); amount 0 OK = Cancel. The board must pass its preview seed to the engine (10.5).
- **"Image › Invert"** — already done ([x]): `selection.invertPixels`.
- **"Image › Invert Mask"** — menu title "Invert Mask" while the mask is targeted; inverts the enabled mask (or a
  folder's) inside the selection or wholly; a 1 x 1 uniform mask is expanded to the layer's grid first; undo "Invert
  Mask"; enabled when the mask is enabled (`canInvert`, `Document/SelectionEdits.swift:95-154`). **Engine**: the
  existing `selection.invertPixels` with `isMaskSelected: true` (`engine/Sources/SelectionOps.swift:51`, `:113`); the
  board only needs the title switch and the flag.
- **"Not repeatable"** — Image-menu kinds never become Last Filter (`repeatsAsLastFilter`, `:29`). Session memory:
  after a destructive OK the settings become the session's `filterSettings` and the next open of the same kind starts
  from them (`:887`), except Gradient Map. The engine is per-request, so the **board** keeps this memory.

---

## 10. Engine API to add

All new ops follow `withSession` (`engine/Sources/SelectionOps.swift:96-113`): load the project into an
`EditorSession`, apply `configure` (active layer, selection, foreground/background, `isMaskSelected`), run, save if the
document changed, answer `{saved, editName?, selection, activeLayerID, error?, ...}`.

### 10.1 JSON decoding of settings

- `LayerAdjustment` and every settings struct it holds are `Codable`: decode a manifest-format `adjustment` object
  with `JSONDecoder().decode(LayerAdjustment.self, from:)`. All non-optional keys are required (`kind`, `hue`,
  `saturation`, `lightness`, `colorize`, `levels`, `curves`), dictionaries in `hsvSettings` are flat arrays
  (`docs/port-specs/manifest.md` sections 2, 7.1).
- `FilterSettings` is **not** Codable (`Document/Filters.swift:63`). Decode the request's `settings` object field by
  field onto `session.filterSettings` (defaults) using the Codable sub-structs:

| JSON key | Swift target | JSON shape |
|---|---|---|
| `curves` | `settings.curves: CurvesSettings` | `{channel: "RGB", channels: [[{x,y},...] x 4]}` |
| `exposure` | `settings.exposure: ExposureSettings` | `{exposure, offset, gamma}` |
| `gradientMap` | `settings.gradientMap: GradientMapSettings` | `{shadows: {red,green,blue}, highlights: {...}, reversed}` |
| `grain` | `settings.grain: GrainSettings` | `{amount, size, roughness, seed}` (`seed` ignored, see 10.5) |
| `blackWhite` | `settings.blackWhite: BlackWhiteSettings` | `{reds, yellows, greens, cyans, blues, magentas, tint, tintHue, tintSaturation}` |
| `colorBalance` | `settings.colorBalance: ColorBalanceSettings` | the ten keys of `docs/port-specs/manifest.md` 7.1 |
| `radius`, `angle`, `distance`, `amount` | `Double` fields | numbers (Filter-menu kinds; listed for completeness) |
| `preserveTransparency`, `gaussian`, `monochromatic` | `Bool` fields | booleans |

```swift
func filterSettings(_ json: Any?, base: FilterSettings) throws -> FilterSettings {
    var s = base
    guard let o = json as? [String: Any] else { return s }
    func sub<T: Decodable>(_ key: String, _ type: T.Type) throws -> T? {
        guard let v = o[key] else { return nil }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: v))
    }
    if let v = try sub("curves", CurvesSettings.self) { s.curves = v }
    if let v = try sub("exposure", ExposureSettings.self) { s.exposure = v }
    if let v = try sub("gradientMap", GradientMapSettings.self) { s.gradientMap = v }
    if let v = try sub("grain", GrainSettings.self) { s.grain = v }
    if let v = try sub("blackWhite", BlackWhiteSettings.self) { s.blackWhite = v }
    if let v = try sub("colorBalance", ColorBalanceSettings.self) { s.colorBalance = v }
    if let v = double(o["radius"]) { s.radius = v }  // ... angle, distance, amount, booleans
    return s
}
```
A decode failure answers `{ok: false, error: "bad settings: <key>"}`.

### 10.2 `adjustment.add`

Args: `project`, `activeLayerID`, `kind` (an `AdjustmentKind` raw value), `foreground`, `background` (`[r, g, b]`
0...1). Body: `session.addAdjustment(AdjustmentKind(rawValue: kind)!)` (`Document/LayerAdjustment.swift:208-229`;
preconditions `canEditLayers`, < 10,000 layers). Answer adds `layerID` (= `session.activeLayerID`) and `opensEditor:
kind != "Invert"`; `editName` = "New `<Kind>` Adjustment". The session's `adjustmentEditingID` is discarded; the board
opens its own editor.

### 10.3 `levels.histogram`

Args: `project`, `activeLayerID`, `selection?`, `layerID?`. Stateless (no save).

```swift
let (session, _) = try await session(args); configure(session, args)
if let id = uuid(args["layerID"]), session.document?.layers.first(where: { $0.id == id })?.adjustment?.kind == .levels {
    session.adjustmentEditingID = id
    await session.beginAdjustmentEditing(id)          // renders the layers underneath (AdjustmentEditing.swift:12-37)
} else {
    session.beginLevels()                             // the active layer's pixels, selection-weighted (Levels.swift:149-168)
}
guard let edit = session.levels else { return ["error": session.brushError ?? "Levels can't be used on this layer."] }
await edit.histogramTask?.value
return ["bins": edit.histogram, "ready": edit.histogramReady]   // [[256 x Double] x 4]: RGB, Red, Green, Blue
```
Optional `out`: also write the underlying composite PNG (`ImageExporter.render` of the edited snapshot) for the board's
eyedroppers. Cost: one render, as upstream's "Loading histogram…".

### 10.4 `levels.apply` and `hueSaturation.apply`

Args: `project`, `activeLayerID`, `selection?`, and `levels` (a `LevelsSettings` JSON, as the manifest's) or
`hueSaturation` (a `HueSaturationSettings` JSON, as `hsvSettings`).

```swift
// levels.apply
session.beginLevels()                                   // canAdjustColors, no other dialog
guard let edit = session.levels else { throw EngineError.bad(session.brushError ?? "Levels can't be applied to this layer.") }
edit.settings = decoded                                 // normalized by LevelRange on use
await session.commitLevels()                            // identity = no step; else "Levels"
// hueSaturation.apply
session.beginHueSaturation()
guard session.hueSaturation != nil else { throw ... }
session.updateHueSaturation(decoded, preview: false)
await session.commitHueSaturation()                     // identity = no step; else "Hue/Saturation"
```

### 10.5 `adjust.apply` (Image › Curves, Black & White, Color Balance, Exposure, Gradient Map, Grain)

Args: `project`, `activeLayerID`, `selection?`, `kind` (`FilterKind` raw value with `isImageAdjustment`), `settings`
(10.1), `seed?` (Grain).

```swift
session.beginFilter(kind)                               // Filters.swift:694-744; Gradient Map resets to FG/BG here
guard let edit = session.filterEdit else { throw EngineError.bad(session.brushError ?? "\(kind.rawValue) can't be applied to this layer.") }
session.updateFilter(try filterSettings(args["settings"], base: edit.settings), preview: false)
await session.commitFilter()                            // no-op rules: Exposure at defaults, Grain amount 0 (:876-884)
```
**Grain seed.** `FilterEdit.seed` is a `let` drawn at random when the edit begins (`Document/Filters.swift:458`), so a
new engine session cannot reproduce the board's preview pattern through `commitFilter`. For `kind == "Grain"` with a
`seed`, run the same steps `commitFilter` takes for a non-spreading kind, with the board's seed: build
`FilterJob(kind: .grain, image: edit.original.image, settings: edit.settings, scale: 1, selection: edit.selection,
mapping: edit.mapping, seed: seed)`; for a 16-bit layer `DeepLayer.run(deep, mixesChannels: false) { PixelFilter.run(job
on half) }` then `DeepLayer.asset`, else `PixelFilter.run(job)`; check `current.asset?.image === edit.original.image`
and the transform; `beginEdit("Grain")`, replace the layer as `commitFilter` does (`:975-994`), `endEdit()`;
`cancelFilter()`. Without this the committed grain differs from the preview.

`docs/port-specs/filters.md` (section 18) proposes a persistent engine filter edit (`filter.begin` / `filter.update` /
`filter.commit`) that keeps one `FilterEdit`, and so one seed, between preview and commit. If that is adopted, the
Image-menu kinds can commit through it (`filter.begin` with the board's settings, `filter.commit`) and `adjust.apply`
with its Grain workaround is unnecessary; the board's JS preview stays as specified here, but its Grain preview must
then use the open edit's `seed`, which `filter.begin` would have to return (filters.md does not list it yet).

### 10.6 `adjustment.lut` (conformance tests only)

Args: `adjustment` (a `LayerAdjustment` JSON). Answer, by kind: Levels `{tables: [768 Float]}` from
`levels.apply(Double(i)/255, channel:)`; Curves the same from `curves.value`; Exposure `{tables}` from
`exposure.table` x 3; Gradient Map `{table: [768 UInt8]}`; Hue/Saturation `{dimension: 33, cube: [Float]}` from
`HueSaturationFilter.cube(resolvedHSV)`. The board's test compares these with its own section 3 tables.

### 10.7 `effects.render` (optional fallback, tests)

Args: `project`, `layerID`, `out`. Body: `LayerEffectsRenderer.cached(image, mask:, effects:)` exactly as
`IO/ImageExporter.swift:52-53`; write the PNG; answer `{inset, size: [W, H], transform: placed(...)}`. Use for
conformance tests of section 5.3 and as a last-resort renderer for a huge layer the board cannot process in time.

### 10.8 Not needed

Adjustment settings edits and every effects edit are manifest JSON and stay board-side (sections 7.1, 8), as layer
opacity, blend mode and visibility already are. `render` (existing) remains the reference for whole-document checks.

---

## 11. Not applicable in VS Code / adaptations

- **Floating NSPanels** (`UI/FloatingPanel.swift`): webview-floating panels via `board.panel`; remember each panel's
  position for the session; the close box = Cancel.
- **Shortcuts** ⌘M, ⌘L, ⌘U, ⌥P: reach the webview only while it has focus; ⌘M (minimize) and ⌘U/⌘L may be taken by
  VS Code or the OS (`docs/port-specs/ui.md` sections 12.1-12.2). Offer the commands from the board's Image menu and
  the command palette as well.
- **SF Symbols** (row icons, eyedroppers, targeted-adjustment hand, `sparkles`, `triangle.fill`): replace with codicons
  or inline SVG of similar shape; keep the Curves icon rotation.
- **`NSCursor.resizeLeftRight`** for scrubbing and targeted adjustment: CSS `cursor: ew-resize`.
- **`NSSound.beep`** (neutral eyedropper sample, unavailable command): a short toast or nothing.
- **App color picker** for Gradient Map ends and effect colors: `media/picker.js`, with live preview and restore on
  cancel.
- **Option-drag to copy an effect** (`NSDraggingSource`): HTML drag and drop inside the Layers panel with a custom MIME
  type `application/x-compositor-effect` carrying `layerID:kind`.
- **Metal / Core Image rendering**: JS (section 3, 5), optionally WebGL2 (1.7).
- **HDR and 16-bit precision paths** (`applySixteenBit`, `DeepLayer`): the board displays 8-bit; destructive commits
  keep 16-bit through the engine.
- **The app's GPU canvas lookups** (section 1.1): deliberately not reproduced; the board matches export.

---

## 12. Upstream quirks to decide, and risks

Quirks (port literally unless decided otherwise):

1. Every effects-panel change is its own undo step ("Edit Stroke" per slider tick, per picker move). Proposal: keep
   the labels but coalesce one continuous drag into one step, as the board already does for opacity.
2. Effects canvas preview on large layers scales only stroke size and drop-shadow distance/blur (5.5). The board
   renders full size; mention it as an intended difference.
3. Curves, Black & White and Color Balance accept typed out-of-range values; layers silently ignore them, destructive
   previews show a misleading "not a valid Compositor project" error (7.3). Proposal: clamp to the slider range on
   commit of the field.
4. Gaussian Blur adjustment editor shows a Preserve Transparency toggle that is never saved (7.11).
5. Destructive Curves / Black & White / Color Balance / Gradient Map OK records a step even when nothing changes (9).
6. A destructive adjustment turns a text or shape layer into plain pixels (9).
7. A Gaussian Blur adjustment over a full-canvas image makes the document edges translucent (2.7), unlike Photoshop.
8. "Edit Adjustment…" is enabled for Invert, opens nothing, and leaves the session stuck in adjustment editing until
   the project closes (7.1). Proposal: disable it for Invert (a bug fix, not a parity choice).
9. `docs/project-format.md:29` says adjustments affect what is below "within their folder"; the code applies them to
   the whole composite (2.2).

Risks:

- **Performance**: Hue/Saturation, Grain (uncached) and both blurs are too slow for full-frame JS at 60 fps on large
  documents; the region pipeline (1.6) is required for painting under an adjustment, and WebGL2 or a Worker for big
  slider drags. Effects with large blur on large layers need a Worker (seconds in JS at 4 MP x 61 taps).
- **Input differences**: the board's own composite can differ from Core Graphics by 1-2 levels in some blend modes
  (`docs/port-specs/compositing.md` section 5.1); steep adjustments widen that. Exactness is only guaranteed for the
  kernels themselves.
- **Premultiplied round trip** depends on Chromium's `getImageData` unpremultiply rounding (1.4); test once in the
  webview.
- **Blurs** are approximate by construction (within ~2 levels Gaussian, ~3-8 Motion); exact parity would need the
  engine (`render`) per change.
- **Grain destructive commit** needs the engine-side seed path of 10.5, which duplicates part of `commitFilter`.
- **Region rendering** is a refactor of `media/render.js` (clip rects in `drawLeaf`, `drawStack`, per-pixel blends);
  clipping-stack surfaces must also grow for blur children (2.6).
