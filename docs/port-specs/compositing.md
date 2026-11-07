# Compositor Render Pipeline: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only). `file:line` references are relative to
`upstream/Compositor/` unless they start with `docs/` (then relative to `upstream/`). Code excerpts are verbatim.

Files read in full: `Rendering/LayerRenderer.swift` (176 lines), `Rendering/TiledLayerRenderer.swift` (419),
`Rendering/SeparableBlend.swift` (60), `Document/LayerAppearance.swift` (138), `Document/LayerMask.swift` (426),
`Document/LiveLayerMask.swift` (245), `Rendering/LiveMaskRenderer.swift` (196), `Document/LayerGroups.swift` (324),
`IO/ImageExporter.swift` (292; `render` is `:25-87`). Supporting code read: `Document/LayerTransform.swift`,
`Document/BrushStroke.swift:35-117` (`BrushRaster`), `Rendering/BrushPixels.c:23-50`, `Rendering/DownsampleCache.swift`,
`Rendering/AdjustmentSurface.swift`, `Document/LayerEffects.swift:388-513`, `Rendering/GPUCanvas.swift:497-530`,
`Rendering/EditorCanvas.swift` (background and checkerboard, `:866-905`, `:2727-2780`), `UI/NewCanvasSheet.swift:45-68`.

**[verified]** marks numbers I measured on this Mac (Darwin 25.6) by running the app's exact Core Graphics / Core Image
calls on test pixels. I used an sRGB `CIContext` with `.workingColorSpace: sRGB`, 8-bit premultiplied RGBA contexts,
81 opaque and 30 translucent source/backdrop pairs per mode, and compared the results with candidate formulas. The
probe was deleted afterwards.

**Reference path.** `ImageExporter.render(_:)` (`IO/ImageExporter.swift:25-87`) flattens a document for PNG/JPEG/TIFF/PDF
export and for `QuickLook/Preview.jpg`. The on-screen canvas uses the same structure. `EditorSession.drawLiveComposite`
(`Document/LiveLayerMask.swift:161-207`) is the Core Graphics version. The GPU canvas (`Rendering/EditorCanvas.swift:2787+`,
`Rendering/GPUCanvas.swift:497-530`) redoes the same steps in Core Image: the same clipping stacks and folder masks,
with Core Image filters for every blend mode. This spec follows the export path.

---

## 1. Target surface and color math

```swift
guard let space = hdr ? DeepLayer.hdrSpace : CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: width, height: height,
                              bitsPerComponent: sixteenBit ? 16 : 8, bytesPerRow: width * (sixteenBit ? 8 : 4), space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue ...
context.clear(CGRect(x: 0, y: 0, width: width, height: height))
context.translateBy(x: 0, y: CGFloat(height))
context.scaleBy(x: 1, y: -1)
```
(`IO/ImageExporter.swift:31-41`.)

- The surface is document-sized, 8-bit (16-bit only for 16-bit exports), sRGB, premultiplied RGBA, cleared to
  **transparent**, flipped to a **top-left, y-down** coordinate system ("Draws into a top-left coordinate system,
  shared by the canvas and export", `Rendering/LayerRenderer.swift:3`). One unit = one document pixel.
- All blending happens on **gamma-encoded sRGB values**, never linear light: "Blending happens in sRGB, not linear
  light, as it does on the canvas and in Photoshop" (`Rendering/GPUCanvas.swift:10-12`). See also the
  `SeparableBlend` comment in section 5.3.

---

## 2. Draw order and visibility

```swift
static func visibleLayers(_ layers: [ProjectLayerRecord]) -> [ProjectLayerRecord] {
    entries(layers).filter { $0.visible && $0.layer.isGroup != true }.map(\.layer)
}
```
(`Document/LayerGroups.swift:27-29`.) `entries` groups records by `parentID`, keeping array order inside each group, and
walks depth first from the root. Each folder is expanded at its own position, and `effective = visible &&
layer.isVisible` is passed down (`Document/LayerGroups.swift:9-26`):

```swift
func visit(_ parent: UUID?, depth: Int, visible: Bool) {
    guard depth <= 64 else { return }
    let siblings = children[parent] ?? []
    for layer in topFirst ? Array(siblings.reversed()) : siblings {
        let effective = visible && layer.isVisible
        result.append(Entry(layer: layer, depth: depth, visible: effective))
        if layer.isGroup == true, !collapsed.contains(layer.id) {
            visit(layer.id, depth: depth + 1, visible: effective)
        }
    }
}
```

Rules:

1. Draw order = pre-order traversal; siblings in array order (bottom first). Folders are never drawn themselves.
2. A layer draws only if it **and every ancestor folder** has `isVisible: true`. Child flags are not changed
   (`docs/project-format.md:15`).
3. The drawn list holds pixel layers, blank layers (which draw nothing) and adjustment layers
   (`IO/ImageExporter.swift:78-83`).
4. Each id in that list goes through `FolderMaskClip.draw` (folder masks, section 7) and then
   `LiveMaskRenderer.drawComposite` (clipping stacks, adjustments, section 8).
5. A hidden layer can still act as a clipping **source** (section 8.2).

---

## 3. Placing a layer: transform

```swift
static func draw(_ image: CGImage, transform: LayerTransform, center: CGPoint,
                 scale: CGFloat = 1, opacity: Double = 1, blendMode: LayerBlendMode = .normal, mask: CGImage? = nil, in context: CGContext) {
    let width = transform.size.width * scale
    let height = transform.size.height * scale
    // Large reductions draw from sharp halvings; Core Graphics then only does the last 2× or less.
    let device = deviceScale(of: context)
    let source = reduced(image, width: width, device: device, sampling: transform.sampling)
    let clip = mask.map { reduced($0, width: width, device: device, sampling: transform.sampling) }
    context.saveGState()
    context.setAlpha(opacity)
    context.setBlendMode(blendMode.cgMode)
    context.interpolationQuality = interpolation(transform.sampling,
        finalFactor: width * device / CGFloat(max(1, image.width)) * CGFloat(1 << source.level),
        upright: transform.radians == 0)
    context.setShouldAntialias(transform.sampling != .nearest)
    context.translateBy(x: center.x, y: center.y)
    context.rotate(by: transform.radians)
    context.scaleBy(x: transform.flipX ? -1 : 1, y: transform.flipY ? 1 : -1)
    let bounds = CGRect(x: -width / 2, y: -height / 2, width: width, height: height)
    if let clip { context.clip(to: coverage(of: clip, in: bounds), mask: clip.image) }
    context.draw(source.image, in: coverage(of: source, in: bounds))
    context.restoreGState()
}
```
(`Rendering/LayerRenderer.swift:5-27`; export calls it with `center: layer.transform.center`, `scale` 1,
`IO/ImageExporter.swift:61-62`.)

- `center = (origin.x + size.width/2, origin.y + size.height/2)`; `radians = rotation.truncatingRemainder(dividingBy:
  360) * .pi / 180` (`Document/LayerTransform.swift:25-26`).
- In a y-down space a positive `rotate` turns +x toward +y, which is **clockwise on screen**. The `y: flipY ? 1 : -1`
  term only cancels Core Graphics' bottom-up image drawing, so an unflipped image comes out upright and `flipY`
  mirrors it top to bottom. Flips are in layer-local axes (applied before rotation).
- The image is stretched to `size` whatever its pixel dimensions.

Exact pixel-to-document mapping, image `W x H` pixels, pixel coordinates y-down (`Document/BrushStroke.swift:110-116`):

```swift
static func pixelToDocument(_ transform: LayerTransform, width: Int, height: Int) -> CGAffineTransform {
    CGAffineTransform(translationX: transform.center.x, y: transform.center.y)
        .rotated(by: transform.radians)
        .scaledBy(x: transform.size.width / CGFloat(width) * (transform.flipX ? -1 : 1),
                  y: transform.size.height / CGFloat(height) * (transform.flipY ? -1 : 1))
        .translatedBy(x: -CGFloat(width) / 2, y: -CGFloat(height) / 2)
}
```
i.e. `doc = center + R(theta) * diag(sx*fx, sy*fy) * (p - (W/2, H/2))`, where `R = [[cos, -sin], [sin, cos]]`,
`sx = size.width / W`, `sy = size.height / H`, and `fx`, `fy` are -1 when flipped.

### 3.1 Sampling to interpolation

```swift
var quality: CGInterpolationQuality {
    switch self {
    case .nearest: return .none
    case .smooth: return .low
    case .high: return .high
    }
}
```
(`Document/LayerTransform.swift:8-14`), refined per draw (`Rendering/LayerRenderer.swift:44-47`):

```swift
static func interpolation(_ sampling: LayerSampling, finalFactor: CGFloat, upright: Bool = false) -> CGInterpolationQuality {
    if sampling == .nearest || (upright && abs(finalFactor - 1) < 0.001) { return .none }
    return finalFactor <= 1 ? .low : sampling.quality
}
```

| `sampling` | Enlarging (more than 1 device px per image px) | Exactly 1:1 and rotation 0 | Shrinking |
|---|---|---|---|
| `Nearest` | `.none` (nearest), edges not antialiased (`:19`) | `.none` | `.none`, no pre-reduction (`:49`) |
| `Smooth` | `.low` (bilinear) | `.none` | sharp halvings, then `.low` |
| `High quality` | `.high` | `.none` | sharp halvings, then `.low` |

"Sharp halvings": for a scale factor below 0.5, the image is first halved `floor(log2(1/factor))` times (at most 6,
`Rendering/DownsampleCache.swift:18`, `:32-35`) with `vImageScale_ARGB8888(..., kvImageHighQualityResampling)`
(Lanczos-class) at exactly 50% (`Rendering/DownsampleCache.swift:82-111`). Core Graphics then does the remaining
factor of 2 or less. Halved copies round their size up, so they reach a fraction of a pixel past the right and bottom
edge (`Rendering/LayerRenderer.swift:29-31`, `:57-60`); this is negligible.

`TiledLayerRenderer` (`Rendering/TiledLayerRenderer.swift`) only serves layers being painted in a live session (a
committed `RasterSnapshot` or a brush stroke in progress, held as a base image plus tiles). It is built to look
exactly like `LayerRenderer.draw` of the whole image (`:4-13`). A layer loaded from a file is one image, so a file
renderer never needs it.

---

## 4. Opacity

```swift
static func effective(_ own: Double, parent: UUID?,
                      folder: (UUID) -> (opacity: Double, parentID: UUID?)?) -> Double {
    var opacity = own, id = parent, depth = 0
    while let current = id, depth < 64, let node = folder(current) {
        opacity *= node.opacity
        id = node.parentID
        depth += 1
    }
    return opacity
}
```
(`Document/LayerGroups.swift:53-63`.) "a layer at 50% in a folder at 50% shows at 25%" (`:49-52`). The effective opacity
is passed as `opacity` to `LayerRenderer.draw` (`IO/ImageExporter.swift:51`) and applied with `context.setAlpha`
(`Rendering/LayerRenderer.swift:14`). It multiplies the source alpha, before the blend formula. Adjustment layers use
the same effective opacity (`IO/ImageExporter.swift:72`).

---

## 5. Blend modes

### 5.1 Which engine draws which mode

```swift
var cgMode: CGBlendMode {
    switch self {
    case .normal: .normal
    case .multiply: .multiply
    case .screen: .screen
    case .overlay: .overlay
    case .softLight: .softLight
    case .hardLight: .hardLight
    case .darken: .darken
    case .lighten: .lighten
    case .difference: .difference
    case .exclusion: .exclusion
    case .colorDodge: .colorDodge
    case .colorBurn: .colorBurn
    case .hue: .hue
    case .saturation: .saturation
    case .color: .color
    case .luminosity: .luminosity
    // Drawn through Core Image or by hand; never reaches Core Graphics.
    case .linearBurn, .linearDodge, .vividLight, .linearLight, .pinLight, .hardMix, .subtract, .divide: .normal
    }
}
```
(`Document/LayerAppearance.swift:28-49`.)

```swift
/// The Core Image filter that computes this mode, for the ones Core Graphics has no equivalent
/// for — or computes wrongly, as it does for Color Burn and Color Dodge, and for Soft Light, whose formula is up to
/// 25 levels off Photoshop's with a light blend color (Core Image's is within 5).
var coreImageFilter: String? {
    switch self {
    case .colorBurn: "CIColorBurnBlendMode"
    case .colorDodge: "CIColorDodgeBlendMode"
    case .softLight: "CISoftLightBlendMode"
    case .linearBurn: "CILinearBurnBlendMode"
    case .linearDodge: "CILinearDodgeBlendMode"
    case .vividLight: "CIVividLightBlendMode"
    case .linearLight: "CILinearLightBlendMode"
    case .pinLight: "CIPinLightBlendMode"
    case .hardMix: "CIHardMixBlendMode"
    case .subtract: "CISubtractBlendMode"
    case .divide: "CIDivideBlendMode"
    default: nil
    }
}
```
(`Document/LayerAppearance.swift:51-69`.) `static func needsSurface(_ mode: LayerBlendMode) -> Bool {
mode.coreImageFilter != nil }` (`Rendering/SeparableBlend.swift:12`). So **13 modes go straight to Core Graphics**
(Normal, Multiply, Screen, Overlay, Hard Light, Darken, Lighten, Difference, Exclusion, Hue, Saturation, Color,
Luminosity) and **11 go through Core Image**. Those 11 are the three Core Graphics gets wrong (Color Burn, Color Dodge,
Soft Light) and the eight it lacks (Linear Burn, Linear Dodge (Add), Vivid Light, Linear Light, Pin Light, Hard Mix,
Subtract, Divide). All 11 filters exist on this macOS [verified]. A missing filter would fall back to drawing Normal
(`IO/ImageExporter.swift:66-67`).

| Mode (manifest string) | Engine | Engine name | Canvas 2D `globalCompositeOperation` |
|---|---|---|---|
| `Normal` | CG | `.normal` | `source-over` |
| `Darken` | CG | `.darken` | `darken` |
| `Multiply` | CG | `.multiply` | `multiply` |
| `Color Burn` | CI | `CIColorBurnBlendMode` | `color-burn` (CI = W3C, [verified]) |
| `Linear Burn` | CI | `CILinearBurnBlendMode` | per-pixel |
| `Lighten` | CG | `.lighten` | `lighten` |
| `Screen` | CG | `.screen` | `screen` |
| `Color Dodge` | CI | `CIColorDodgeBlendMode` | `color-dodge` (CI = W3C, [verified]) |
| `Linear Dodge (Add)` | CI | `CILinearDodgeBlendMode` | per-pixel (**not** `lighter`, see 12.3) |
| `Overlay` | CG | `.overlay` | `overlay` |
| `Soft Light` | CI | `CISoftLightBlendMode` | `soft-light` (CI = W3C, [verified]) |
| `Hard Light` | CG | `.hardLight` | `hard-light` |
| `Vivid Light` | CI | `CIVividLightBlendMode` | per-pixel |
| `Linear Light` | CI | `CILinearLightBlendMode` | per-pixel |
| `Pin Light` | CI | `CIPinLightBlendMode` | per-pixel |
| `Hard Mix` | CI | `CIHardMixBlendMode` | per-pixel |
| `Difference` | CG | `.difference` | `difference` |
| `Exclusion` | CG | `.exclusion` | `exclusion` |
| `Subtract` | CI | `CISubtractBlendMode` | per-pixel |
| `Divide` | CI | `CIDivideBlendMode` | per-pixel |
| `Hue` | CG | `.hue` | `hue` |
| `Saturation` | CG | `.saturation` | `saturation` |
| `Color` | CG | `.color` | `color` |
| `Luminosity` | CG | `.luminosity` | `luminosity` |

[verified] The 13 Core Graphics modes match the W3C Compositing and Blending Level 1 formulas (the ones Canvas 2D
implements) to within 2/255 on all 65 test pairs, translucent ones included. Non-separable modes use `Lum = 0.3R +
0.59G + 0.11B` with W3C `ClipColor`/`SetLum`/`SetSat`. Core Graphics' **own** `.softLight`, `.colorDodge` and
`.colorBurn` did **not** match W3C (38, 15 and 13 of 65 pairs off by 3-40 levels). The app never uses them, and
Canvas 2D's `soft-light` / `color-dodge` / `color-burn` equal what the app does draw (Core Image).

### 5.2 How a Core Image mode is composited (`Rendering/SeparableBlend.swift:22-46`)

```swift
guard let name = mode.coreImageFilter, context.data != nil, context.width > 0, context.height > 0,
      let filter = CIFilter(name: name),
      let backdrop = context.makeImage(),
      let surface = CGContext(data: nil, width: context.width, height: context.height, bitsPerComponent: 8,
                              bytesPerRow: context.width * 4, space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
else { return false }
// The same placement as the canvas it will be blended into.
surface.concatenate(context.ctm)
body(surface)
guard let source = surface.makeImage() else { return false }
filter.setValue(CIImage(cgImage: source), forKey: kCIInputImageKey)
filter.setValue(CIImage(cgImage: backdrop), forKey: kCIInputBackgroundImageKey)
...
context.saveGState()
context.concatenate(context.ctm.inverted())
context.setBlendMode(.copy)
context.setAlpha(1)
context.draw(blended, in: frame)
context.restoreGState()
```

1. Snapshot the whole target as `backdrop`.
2. Draw the layer **Normal** into a fresh transparent surface with the same transform (`body` = `drawLayer(.normal,
   $0)`, `IO/ImageExporter.swift:66`). Its own mask and its effective opacity are applied there, so the source alpha
   already includes opacity and the raster mask.
3. `filter(inputImage: source, inputBackgroundImage: backdrop)` in an sRGB working space, 8-bit output.
4. Write the result back with `.copy`. The target's current clip still applies (folder masks, independent clipping
   coverage), so where clip coverage is `m` the result is `m * blended + (1 - m) * backdrop`. For every formula in
   5.3 this equals multiplying `m` into the source alpha first (proof in 12.4).

### 5.3 Exact math of the Core Image modes

Notation: straight (un-premultiplied) sRGB-encoded values in 0...1. `s` = source (layer) channel, `b` = backdrop
channel; `as`, `ab` alphas; `cs = s*as`, `cb = b*ab` premultiplied.

**Alpha handling (all 11 filters, [verified] within 2/255 on 30 translucent pairs per mode).** This is the PDF / W3C
"basic compositing formula" that Apple's descriptions refer to ("...and then blends the result with the background
according to the PDF basic compositing formula"):

```
ao = as + ab - as*ab
co = cs*(1 - ab) + cb*(1 - as) + as*ab*B(b, s)        (premultiplied; straight out = co / ao)
```

**Channel functions `B(b, s)`, applied per R, G, B ([verified] exact to 1/255 on the 81 opaque pairs per mode, after
accounting for 8-bit input quantization):**

| Filter | Apple's description (`CIFilter.localizedDescription`) | `B(b, s)` |
|---|---|---|
| `CILinearBurnBlendMode` | "Inverts the unpremultiplied source and background image sample color, inverts the sum, and then blends the result with the background according to the PDF basic compositing formula." | `max(0, b + s - 1)` |
| `CILinearDodgeBlendMode` | "Unpremultiplies the source and background image sample colors, adds them, and then blends the result with the background according to the PDF basic compositing formula." | `min(1, b + s)` |
| `CIVividLightBlendMode` | "A blend mode that is a combination of color burn and color dodge blend modes." | `s <= 0.5 ? burn(b, 2s) : dodge(b, 2s - 1)` |
| `CILinearLightBlendMode` | "A blend mode that is a combination of linear burn and linear dodge blend modes." | `clamp01(b + 2s - 1)` |
| `CIPinLightBlendMode` | "...combines them according to the relative difference, and then blends the result with the background according to the PDF basic compositing formula." | `s <= 0.5 ? min(b, 2s) : max(b, 2s - 1)` |
| `CIHardMixBlendMode` | "Hard Mix Blend Mode" | `(b + s > 1) ? 1 : 0` (strictly greater: 8-bit pairs summing to exactly 255 give 0) |
| `CISubtractBlendMode` | "...subtracts the source from the background, and then blends the result with the background according to the PDF basic compositing formula." | `max(0, b - s)` |
| `CIDivideBlendMode` | "Divides the background image sample color from the source image sample color." | `s == 0 ? (b > 0 ? 1 : 0) : min(1, b / s)` (backdrop divided by source, Photoshop's Divide) |
| `CIColorBurnBlendMode` | "Darkens the background image samples to reflect the source image samples. Source image sample values that specify white do not produce a change." | `burn(b, s)` = W3C color-burn |
| `CIColorDodgeBlendMode` | "Brightens the background image samples to reflect the source image samples. Source image sample values that specify black do not produce a change." | `dodge(b, s)` = W3C color-dodge |
| `CISoftLightBlendMode` | "Either darkens or lightens colors, depending on the source image sample color..." | W3C soft-light (below). Not Photoshop's formula (3 of 81 pairs off by 3-4) and not Pegtop (25 of 81 off) |

```
burn(b, s)  = b >= 1 ? 1 : (s <= 0 ? 0 : 1 - min(1, (1 - b) / s))
dodge(b, s) = b <= 0 ? 0 : (s >= 1 ? 1 : min(1, b / (1 - s)))
softLight(b, s) = s <= 0.5 ? b - (1 - 2s) * b * (1 - b)
                           : b + (2s - 1) * (D(b) - b),  D(b) = b <= 0.25 ? ((16b - 12)b + 4)b : sqrt(b)
```

**The sRGB comment** (`Rendering/SeparableBlend.swift:14-17`):

```swift
// Core Image works in a linear space unless told otherwise, and these two modes are not separable from
// the gamma they are computed in: over 40% grey, an 80% grey layer dodges to 62% instead of Photoshop's
// 100%, and burns to 0% instead of 25%. The blend has to happen in the same sRGB the canvas is in.
private static let ciContext = CIContext(options: [.cacheIntermediates: false, .workingColorSpace: space])
```
Check with the formulas on encoded values: `dodge(0.4, 0.8) = min(1, 0.4/0.2) = 1` (100%) and `burn(0.4, 0.8) =
1 - 0.6/0.8 = 0.25` (25%). These are Photoshop's numbers, and only come out this way when the math runs on
sRGB-encoded values. A JS port must **not** linearize.

`SeparableBlend.blend(_:over:mode:)` (`:50-59`) is the same filter applied to whole images (adjustment layers in a
blend mode, `Rendering/LiveMaskRenderer.swift:63`).

---

## 6. Raster masks (layer masks)

### 6.1 Coverage

- Mask PNG = 8-bit gray without alpha (`Document/LayerMask.swift:23-26`). Coverage = sample / 255, white reveals
  (`Document/LayerMask.swift:4-5`). The sample is used **raw**: Core Graphics `clip(to:mask:)` takes gray samples as
  alpha with no gamma or ICC step ([verified]: samples 0/128/200/255 -> alpha 0/128/200/255; comment "Resample
  coverage as coverage, bypassing grayscale color conversion", `Rendering/LayerRenderer.swift:68`).
- Applied as a clip in the layer's own placed rect, `context.clip(to: coverage(of: clip, in: bounds), mask:
  clip.image)` (`Rendering/LayerRenderer.swift:24`). The mask image is **stretched over the same rect as the layer
  image**, whatever its pixel size (1x1 = uniform). It is resampled with the layer's interpolation and halvings.
- Disabled (`maskEnabled: false`): `var enabledImage: CGImage? { isEnabled ? asset.image : nil }`
  (`Document/LayerMask.swift:14`), so no clip.
- The effective result is `layer alpha * opacity * maskCoverage` before blending.

### 6.2 Linked vs unlinked: `maskPlacement`

Export passes `snapshot.mask(for: layer).flatMap { $0.clipImage(placement: $0.placement, over: layer.transform, width:
image.width, height: image.height) }` (`IO/ImageExporter.swift:52`):

```swift
func clipImage(placement: LayerTransform?, over layer: LayerTransform, width: Int, height: Int, limit: CGFloat? = nil) -> CGImage? {
    guard let image = enabledImage else { return nil }
    guard let placement, !placement.samePlacement(as: layer), width > 0, height > 0 else { return image }
    ...
            return try? Self.placed(width: w, height: h, layer: layer, placement: placement, maskWidth: image.width,
                                    maskHeight: image.height, background: Self.background(of: thumbnail)) { context in
                Self.drawSmooth(source, in: CGRect(x: 0, y: 0, width: image.width, height: image.height), context: context)
            }
```
(`Document/LayerMask.swift:110-125`.)

- `maskPlacement` missing, or the same rect as the layer (sampling ignored, `samePlacement`,
  `Document/LayerTransform.swift:91-95`): the mask covers the layer rect (6.1).
- `maskPlacement` differs: the mask is resampled into a gray grid the size of the **layer image** (`width x height`)
  covering the layer rect. The grid is first filled with a **background** value, then the mask is drawn through
  `pixelToDocument(placement) * inverse(pixelToDocument(layer))` with `.high` interpolation
  (`Document/LayerMask.swift:80-91`, `:94-105`). That grid then clips the layer as in 6.1.
- The background is pure white or pure black, decided from the mask's 96 px thumbnail border pixels
  (`Document/LayerMask.swift:63-76`):

  ```swift
  return total * 2 >= count * 255 ? 1 : 0
  ```
  If the average border sample is at least 127.5, it is white (a reveal-all mask keeps revealing); otherwise black.
- `maskLinked` does **not** affect rendering. It only decides whether later moves of the layer carry the mask
  (`Document/LayerMask.swift:52-59`).
- Blank layers (no image) draw nothing, so their masks show nothing.

### 6.3 Masks that ignore `maskPlacement`

Folder masks (`FolderMaskClip(image: image, transform: folder.transform)`, `IO/ImageExporter.swift:80-82`) and
adjustment-layer masks (`FolderMaskClip(image: image, transform: layer.transform)`, `IO/ImageExporter.swift:73-76`) are
placed with the record's own `transform` only. Any `maskPlacement` on those records is ignored when compositing.

---

## 7. Folders (groups): pass-through

```swift
/// A folder's mask, clipping the layers inside the folder. Folders are pass-through — the
/// layers inside are drawn straight onto what is below, never composited as a unit — so a
/// folder mask applies to each of those layers, multiplied with the layer's own mask and the
/// masks of any folders further out (Core Graphics multiplies nested mask clips).
nonisolated struct FolderMaskClip {
    let image: CGImage
    let transform: LayerTransform

    func apply(scale: CGFloat = 1, center: CGPoint, in context: CGContext) {
        let width = transform.size.width * scale, height = transform.size.height * scale
        let placement = CGAffineTransform(translationX: center.x, y: center.y)
            .rotated(by: transform.radians)
            .scaledBy(x: transform.flipX ? -1 : 1, y: transform.flipY ? 1 : -1)
        context.interpolationQuality = transform.sampling.quality
        context.concatenate(placement)
        context.clip(to: CGRect(x: -width / 2, y: -height / 2, width: width, height: height), mask: image)
        context.concatenate(placement.inverted())
    }
```
(`Document/LayerMask.swift:168-187`.) `FolderMaskClip.draw` (`:191-209`) walks up to 64 ancestors of each drawn id and
applies every ancestor's enabled mask as a nested clip before `drawComposite(id)`.

- Folders are **never composited as a unit**. Each descendant is drawn straight onto the document.
- Folder **opacity** multiplies into every descendant's opacity (section 4).
- Folder **blend mode** is always Normal (the loader rejects anything else, `IO/ProjectStore.swift:250`).
- Folder **masks**: the mask image is stretched over the folder's `transform` rect (by default the canvas size when
  the folder was made, `docs/project-format.md:27`). Coverage multiplies with the layer's own mask and every
  enclosing folder's mask. Outside the folder mask rect, coverage is 0, because a clip to a mask hides everything
  outside the mask's rect ("past the mask's edges too, as a Core Graphics clip to a mask does",
  `Rendering/GPUCanvas.swift:525-526`).
- Folder masks clip adjustment layers inside the folder too; they do not affect clipping coverage
  (`docs/project-format.md:27`; coverage is built without folder clips, section 8.2).
- Folder `effects`, `shape` and so on are ignored (folders are not drawn).
- Visibility: a hidden folder hides all its descendants (section 2).

---

## 8. Clipping masks (`maskSourceID`) and adjustment layers

`LiveMaskRenderer` (`Rendering/LiveMaskRenderer.swift`) is created over the document bounds. `drawOwn(id, ctx)` is
the per-layer closure of section 3 (`IO/ImageExporter.swift:48-68`). It draws the layer's pixels, or its effects
image, with its effective opacity, raster mask and blend mode.

### 8.1 Clipping stacks (the normal case)

```swift
for (index, base) in ids.enumerated() where source(base) == nil && adjustment(base) == nil {
    var children: [UUID] = []
    for child in ids.dropFirst(index + 1) {
        guard source(child) == base, parent(child) == parent(base) else { break }
        children.append(child)
    }
    guard !children.isEmpty else { continue }
    stacks[base] = children
    stackModes[base] = blend(base)
    stacked.formUnion(children)
}
```
(`Rendering/LiveMaskRenderer.swift:90-104`; `ids` = the visible drawn list of section 2.) A **stack** is a visible base
(not clipped itself, not an adjustment) followed **immediately** in draw order by one or more visible layers with
`maskSourceID == base` and the same `parentID`. The stack is drawn when the base is reached (`:105-162`):

1. Allocate a transparent document-sized surface; `drawOwn(base)` (base pixels x base effective opacity x base mask,
   effects included).
2. Save the base alpha, then `layer_unpremultiply_opaque`: every pixel becomes its straight color with alpha 255
   (fully transparent pixels become opaque black) (`Rendering/BrushPixels.c:23-35`).
3. Draw each child onto that opaque surface with its own opacity, mask, blend mode (through Core Image when needed)
   and effects. An adjustment-layer child is applied to the surface (`:131-134`).
4. `layer_restore_alpha`: alpha = saved base alpha, colors premultiplied by it (`p[c] = (p[c] * a + 127) / 255`,
   `Rendering/BrushPixels.c:36-45`).
5. Draw the stack image onto the document in the **base's blend mode**, through Core Image when needed, inside any
   folder clips (`:143-160`).

So clipped children blend against the base's colors only, never against what lies below the base. Their result is
clipped to the base's alpha, base opacity included, and the group is composited once in the base's mode. This is
Photoshop's default "Blend Clipped Layers as Group". Children in a stack are skipped when their own turn comes
(`guard !stacked.contains(id) else { return }`, `:106`).

### 8.2 Independent links (everything else)

When a clipped layer is not in a stack (the base is hidden, a non-matching layer sits between them, or the parents
differ), it is drawn with its source's coverage as a clip (`Rendering/LiveMaskRenderer.swift:166-179`):

```swift
if let sourceID = source(id) {
    guard let coverage = coverage(sourceID) else { return }
    ...
    context.clip(to: bounds, mask: coverage)
    ...
}
drawOwn(id, context)
```
The coverage of a source (`:180-195`) is the **alpha channel** of `draw(sourceID)` rendered alone into a transparent
document-sized surface. Its terms multiply: source pixel alpha x source effective opacity (folders included) x source
raster mask x (its effects) x the coverage of the source's own `maskSourceID`, recursively, cached, at most 256 deep.
**Not** included: the source's visibility, its RGB, and its folders' masks. "Coverage uses source alpha including its
own masks, independent of source visibility and color" (`:5-6`). The clipped layer then blends against the full
composite below it, in its own mode.

Consequences worth testing:

- A layer clipped to a **hidden** base still shows, clipped by that base's alpha. Photoshop would hide it.
- A clip source that is a blank layer (no pixels) hides its targets completely.
- An adjustment layer with `maskSourceID` that is not part of a stack is skipped entirely
  (`if source(id) == nil { adjust(id, in: context) }; return`, `:107-110`).

### 8.3 Adjustment layers (not rendered in v1; where they apply)

`drawComposite` -> `adjust(id, in: context)` (`Rendering/LiveMaskRenderer.swift:39-87`), in draw order:

1. Input = `context.makeImage()`: **everything composited so far on the whole document** (or on the stack surface when
   the adjustment is a stack child). Folders do not isolate it; only folder masks clip it.
2. `settings.apply(original, region:scale:)`: Levels, Curves, Hue/Saturation, Exposure, Gradient Map, Grain,
   Black & White, Color Balance, Invert, Gaussian Blur, Motion Blur, Add Noise (`Document/LayerAdjustment.swift:
   164-204`). Grain and Add Noise patterns are anchored to document coordinates.
3. If its blend mode is not Normal: blend the adjusted image over the original at full coverage (Core Image modes
   via `SeparableBlend.blend`), then restore the original alpha (`:46-71`).
4. If effective opacity < 1: `CIBlendWithMask` mix of adjusted and original by opacity (`:72-82`).
5. Draw the result back with `.copy` (`BrushRaster.draw`, `Document/BrushStroke.swift:73-90`), clipped by the
   adjustment's own enabled mask placed with its `transform` (`adjustmentClip`, `IO/ImageExporter.swift:73-77`) and by
   the ancestor folder masks.

The layer's `transform` is used only to place its mask. The adjustment covers the whole document.

---

## 9. Layer effects (not rendered in v1; where they apply)

`LayerEffectsRenderer.cached(image, mask:, effects:)` (`Document/LayerEffects.swift:417-422`) runs inside `drawOwn`
before blending (`IO/ImageExporter.swift:53-60`). Only enabled effects count, and only if every one is valid;
otherwise the layer draws without effects. It returns one image: the layer's pixels already **through its own raster
mask** plus all effects, on a canvas grown by `inset = ceil(max(outside stroke size, shadow distance + 3 * blur, 3 *
outer glow size)) + 2` px per side (`:435-446`). It is drawn with the layer transform grown in proportion
(`placed`, `:425-433`), with the layer's effective opacity and blend mode, and `mask: nil` (already applied). Order on
that canvas (CPU path, `:450-513`; the Metal path builds the same result):

1. Drop shadow (blurred alpha offset away from the light, filled with color x opacity).
2. Outer glow.
3. Stroke when `inside == false`.
4. The layer's masked pixels, recolored source-atop by color overlay, then inner glow, then inner shadow (alpha
   kept).
5. Stroke when `inside == true`, drawn on top.

Opacity and blend mode apply to the whole result (pixels and effects together). There is no separate Photoshop-style
"fill opacity".

---

## 10. Text, shape, 16-bit and HDR layers

- **Text and shape layers render from their PNG only.** `drawOwn` reads `snapshot.images[id]` and never looks at
  `text` or `shape` (`IO/ImageExporter.swift:49-62`). The style records only serve re-editing; the PNG "remains the
  display and export fallback" (`docs/project-format.md:48`).
- 16-bit layers (v12) are composited on canvas and in 8-bit exports from a dithered 8-bit copy made on load
  (`docs/project-format.md:54`); the 16-bit pixels are used only for 16-bit exports. A browser decodes a 16-bit PNG
  to 8 bits, which is close enough.
- EXR layers (v13) cannot be decoded by a browser. Show a placeholder and preserve the file untouched.

---

## 11. Background and display

- **The document is transparent.** Export clears to transparent (`IO/ImageExporter.swift:39`); PNG, TIFF and PDF keep
  the transparency (`:119-120`, `:230-231`).
- A new canvas defaults to **"Transparent canvas"** (`@State private var background =
  NewCanvasBackground.transparent`, `UI/NewCanvasSheet.swift:68`): one blank `Layer 1` with no pixels. "White canvas"
  or "Black canvas" instead adds a `Background` layer of full-size filled pixels (`UI/NewCanvasSheet.swift:44-55`,
  `Document/EditorSession.swift:1057-1067`). White is just a layer, not a document property.
- On screen, transparency shows as a **dark checkerboard**: 10-point squares from the document's top-left corner,
  gray 0.35 where `(row + column)` is even (the top-left square) and 0.30 elsewhere
  (`Rendering/EditorCanvas.swift:888-905`; GPU path `:2743-2755`). The surround around the document is gray 0.105
  (`:866`), and the document casts a drop shadow (black 35%, offset 3 pt, blur 14; GPU path sigma 7) (`:882-886`). Squares are in screen
  points, so they keep their size at every zoom.
- From 200% zoom (`static let crispZoom: CGFloat = 2`, `:926`) the canvas composites at document resolution and
  enlarges it as crisp nearest-neighbor squares (`:2756-2759`); below that it composites at screen resolution.
- **JPEG export** is composited over a matte, white by default (`JPEGOptions red/green/blue = 1`,
  `IO/ImageExporter.swift:178-190`, `:283-288`).
- **`QuickLook/Preview.jpg`** = `render(snapshot)` drawn over **opaque white**, long side at most 1024 px, `.high`
  interpolation, JPEG quality 0.8, only for canvases up to 50 MP (`IO/ImageExporter.swift:89-113`).

---

## 12. Porting notes (VS Code webview, Canvas 2D)

### 12.1 Setup

- `canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })` for every surface (the main document
  canvas, plus offscreen layer, mask and stack surfaces of the document size, or of a tile of it). Blend on encoded
  sRGB values, which is what Canvas 2D does natively.
- Decode **layer images** with `createImageBitmap(blob)` (defaults: color-managed to sRGB, as Core Graphics does).
- Decode **masks** with `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`, so gray
  PNGs with a Gray Gamma 2.2 `iCCP` (what the app writes for re-saved masks) keep their raw samples. Draw once into a
  canvas, read the R channel and build an **alpha mask**, an RGBA image with `A = gray` (RGB irrelevant). Cache it per
  mask file.
- `transform.rotation` in JS: `(rotation % 360) * Math.PI / 180` (JS `%` truncates like `truncatingRemainder`).

### 12.2 Per-layer algorithm (mirrors section 2-8)

```js
function placeImage(ctx, img, t, imgW, imgH, devicePerDoc = 1) {
  const cx = t.origin[0] + t.size[0] / 2, cy = t.origin[1] + t.size[1] / 2;
  const factor = t.size[0] * devicePerDoc / Math.max(1, imgW);
  const rad = (t.rotation % 360) * Math.PI / 180;
  const nearest = t.sampling === 'Nearest' || (rad === 0 && Math.abs(factor - 1) < 0.001);
  ctx.imageSmoothingEnabled = !nearest;
  // App: enlarging -> Smooth=.low, High=.high; shrinking -> halvings + .low for both.
  ctx.imageSmoothingQuality = factor > 1 ? (t.sampling === 'High quality' ? 'high' : 'low') : 'high';
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);                                   // clockwise in y-down canvas space, like the app
  ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
  ctx.drawImage(img, -t.size[0] / 2, -t.size[1] / 2, t.size[0], t.size[1]);
  ctx.restore();
}
```
For shrinking, `imageSmoothingQuality = 'high'` stands in for the app's Lanczos halvings plus bilinear. For closer
pixels, pre-halve with an offscreen canvas `floor(log2(1/factor))` times (at most 6) and finish with `'low'`.

For each id in the drawn list (section 2):

1. `surface = layerSurface(id)`: clear; `placeImage(image)`. If an enabled mask exists, apply the mask alpha image
   with `globalCompositeOperation = 'destination-in'`, placed per section 6. For a placed (unlinked) mask, first build
   a coverage canvas the size of the layer's rect area: fill it with the background (alpha 1 or 0, section 6.2) inside
   the layer rect, then draw the mask alpha image at `maskPlacement` with `'source-over'` (the mask image is opaque,
   so it replaces the background), then `'destination-in'` that onto the surface.
2. If the layer is the base of a clipping stack (8.1): run the stack algorithm below, and skip the children when
   their turn comes.
3. Else if it has `maskSourceID`: `'destination-in'` with `coverage(source)` (8.2), computed as `layerSurface(source)`
   with `globalAlpha = effectiveOpacity(source)` and its own clip, recursively, ignoring visibility. Cache it per
   render.
4. For each ancestor folder with an enabled mask: `'destination-in'` with that mask placed at the **folder's**
   `transform` (coverage 0 outside the rect).
5. Composite onto the document: for the 16 native modes, `ctx.globalAlpha = effectiveOpacity; ctx.
   globalCompositeOperation = map[mode]; ctx.drawImage(surface, 0, 0)`. For the 8 per-pixel modes, see 12.3, with
   `as` = surface alpha x effectiveOpacity.
6. Adjustment layers and effects: skip in v1, but keep their records (and draw the layer's own pixels for a layer with
   effects).

Doing the clips as `destination-in` on the source surface before compositing is exactly equivalent to the app's
lerp-by-clip (12.4).

**Clipping stack in Canvas 2D** (reproduces `Rendering/BrushPixels.c:23-45`):

```js
// sctx holds the base drawn as in step 1 (pixels + own mask) at globalAlpha = effectiveOpacity(base).
// A base never has a maskSourceID of its own (prepareStacks requires source(base) == nil).
const img = sctx.getImageData(0, 0, w, h); const d = img.data; const alpha = new Uint8ClampedArray(w * h);
for (let i = 0, p = 0; p < d.length; i++, p += 4) {        // getImageData already returns straight color
  alpha[i] = d[p + 3];
  if (d[p + 3] === 0) { d[p] = d[p + 1] = d[p + 2] = 0; }  // app: transparent -> opaque black
  d[p + 3] = 255;
}
sctx.putImageData(img, 0, 0);
for (const child of children) compositeLayerInto(sctx, child); // each child: step 1 only (pixels + own mask), then its
                                                               // own effectiveOpacity and blend mode; NO coverage clip,
                                                               // NO folder masks (the app draws children with drawOwn)
const out = sctx.getImageData(0, 0, w, h); const o = out.data;
for (let i = 0, p = 0; p < o.length; i++, p += 4) o[p + 3] = alpha[i]; // straight color + base alpha
sctx.putImageData(out, 0, 0);                                  // browser premultiplies, like layer_restore_alpha
// Then apply the base's ancestor folder masks to sctx (destination-in) ONCE and composite sctx.canvas onto the
// document in the BASE's blend mode with globalAlpha 1 (base opacity is already in the alpha).
```

### 12.3 Per-pixel blend for the 8 modes Canvas 2D lacks

`putImageData` ignores clip, `globalAlpha` and the composite operation, so fold every coverage term into the source
alpha first (12.2 steps 1-4, times opacity). Work on the bounding box of the layer surface only.

```js
const burn  = (b, s) => b >= 1 ? 1 : (s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const dodge = (b, s) => b <= 0 ? 0 : (s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const B = {
  'Linear Burn':        (b, s) => Math.max(0, b + s - 1),
  'Linear Dodge (Add)': (b, s) => Math.min(1, b + s),
  'Vivid Light':        (b, s) => s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1),
  'Linear Light':       (b, s) => clamp01(b + 2 * s - 1),
  'Pin Light':          (b, s) => s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
  'Hard Mix':           (b, s) => (b + s > 1) ? 1 : 0,   // with 8-bit ints: (B8 + S8 > 255)
  'Subtract':           (b, s) => Math.max(0, b - s),
  'Divide':             (b, s) => s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s),
};
// src, dst: Uint8ClampedArray from getImageData (straight RGBA) over the same rect. src alpha already holds the
// layer's own mask, clipping coverage and folder masks; `opacity` = effective opacity (pass 1 for a stack image).
function blendPixels(dst, src, f, opacity) {
  for (let p = 0; p < dst.length; p += 4) {
    const as = src[p + 3] / 255 * opacity; if (as === 0) continue;
    const ab = dst[p + 3] / 255, ao = as + ab - as * ab;
    for (let c = 0; c < 3; c++) {
      const s = src[p + c] / 255, b = dst[p + c] / 255;
      const co = s * as * (1 - ab) + b * ab * (1 - as) + as * ab * f(b, s);   // premultiplied
      dst[p + c] = Math.round(co / ao * 255);
    }
    dst[p + 3] = Math.round(ao * 255);
  }
}
```

Notes:

- Do **not** use `globalCompositeOperation = 'lighter'` for Linear Dodge. `lighter` is Porter-Duff "plus"
  (`co = cs + cb`, `ao = as + ab`). It agrees with `min(1, b + s)` only for opaque pixels. With a translucent source
  and `b + s > 1` it gives `min(1, b + s*as)` instead of `b + as*(1 - b)`.
- `getImageData` returns un-premultiplied 8-bit values, so very low-alpha pixels lose color precision. The app's 8-bit
  premultiplied contexts have the same limitation, so the results match within about 1-2 levels.
- A clipping stack whose **base** uses one of these 8 modes composites the stack image with `blendPixels` too.

### 12.4 Why clip-after equals alpha-before

The app writes `R = m*Blend(S over D) + (1 - m)*D` (a clip mask `m` on a draw or a `.copy`). Per channel, the formula
of 5.3 gives `m*[cs(1-ab) + cb(1-as) + as*ab*B] + (1-m)*cb`, which simplifies to
`(m*cs)(1-ab) + cb(1 - m*as) + (m*as)*ab*B`. That is the same formula with the source alpha (and the premultiplied
source) scaled by `m`, so multiplying every mask, folder-mask and coverage term into the source alpha before
blending is exact. The same identity holds for `source-over` and for every W3C separable and non-separable mode.

### 12.5 Display niceties (optional)

- Checkerboard under the document: 10 CSS px squares anchored at the document's top-left on screen, `#595959`
  (0.35) at even `(row + col)` and `#4D4D4D` (0.30) at odd; surround `#1B1B1B` (0.105). Draw it in the webview, never
  into the document composite.
- At zoom >= 200%, show the 1:1 composite with `imageSmoothingEnabled = false` to match the app's crisp squares.
- For an exported flat image or a regenerated `Preview.jpg`, composite over white, as the app does.
