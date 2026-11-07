# Compositor `.comp` Project Format: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only). `file:line` references are relative to
`upstream/Compositor/` unless they start with `docs/`, `CompositorTests/` or `Config/` (then relative to `upstream/`).
Code excerpts are verbatim.

Files read in full: `IO/ProjectStore.swift` (297 lines), `IO/ProjectDigest.swift` (32), `IO/ProjectWatcher.swift` (85),
`IO/ProjectController+ExternalChanges.swift` (112), `Document/DocumentLimits.swift` (42), `Document/LayerTransform.swift`
(246), `Document/LayerAppearance.swift` (138), `Document/LayerGroups.swift` (324), `Document/LayerMask.swift` (426),
`Document/LiveLayerMask.swift` (245), `Document/EditorSession+Projects.swift` (89), `docs/project-format.md`,
`docs/writing-comp-files.md`. Model types read: `ProjectManifest`/`ProjectLayerRecord` (`IO/ProjectStore.swift`),
`LayerTransform`/`LayerSampling`, `LayerBlendMode`, `LayerAdjustment` (`Document/LayerAdjustment.swift:1-141`),
`LevelsSettings` (`Document/Levels.swift`), `CurvesSettings` (`Document/Curves.swift`), `HueSaturationSettings`
(`Document/HueSaturation.swift`), `ExposureSettings`/`GradientMapSettings`/`GrainSettings`/`BlackWhiteSettings`/
`ColorBalanceSettings` (`Document/ImageAdjustments.swift`), `LayerEffects` (`Document/LayerEffects.swift:1-224`),
`LayerTextStyle` (`Document/TypeTool.swift:1-212`), `LayerShapeStyle` (`Document/ShapeTool.swift:1-92`), `CanvasGuide`
(`Document/Guides.swift`). Save/open flow: `IO/ProjectController.swift:207-306`; QuickLook: `IO/ImageExporter.swift:89-113`;
tests: `CompositorTests/ProjectTests.swift`, `CompositorTests/ExternalChangeTests.swift`.

**[verified]** marks behavior I reproduced on this Mac (Darwin 25.6, Swift 6.4) by calling the same Foundation /
ImageIO / Core Graphics APIs the app calls (`JSONEncoder` with `[.prettyPrinted, .sortedKeys]`, `JSONDecoder`,
`CGImageSourceCreateWithData`, `CGImageDestinationAddImage`). The probe was deleted afterwards.

Current format version: `static let current = 14` (`IO/ProjectStore.swift:20`); the loader accepts
`static let supported = 1...ProjectManifest.current` (`IO/ProjectStore.swift:23`).

---

## 0. The rules a writer must never break

The app rejects a bad package **silently** during live reload (`IO/ProjectController+ExternalChanges.swift:81`) and with
a generic error on open. Every one of these is fatal:

1. `manifest.json` is valid JSON with every required key (section 2) and `"format": "com.compositor.project"`,
   `"colorSpace": "sRGB"`, `"version"` in 1...14.
2. Layer image file = `"<ID>.png"` (or `"<ID>.exr"` from v13), mask file = `"<ID>.mask.png"`, where `<ID>` is the
   layer id **uppercased** exactly as `UUID.uuidString` prints it. Every named file exists in `images/` as a regular
   file (not a symlink).
3. Layer images are PNG (sniffed by content) with bit depth <= 8 (16 only from v12); masks are 8-bit grayscale PNG
   **without** alpha or tRNS.
4. Every feature used is allowed by the declared `version` (section 9, table of version gates).
5. `parentID` points to a folder, no cycles; `maskSourceID` points to a non-folder, non-adjustment layer, no cycles.
6. Ids unique; names not blank; transforms finite with sizes in 1...300,000.

---

## 1. Package layout

```
Name.comp/                       a directory; UTType com.compositor.project, conforms to com.apple.package,
|                                extension "comp" (Config/Info.plist:77-93, LSTypeIsPackage Config/Info.plist:41-42)
+-- manifest.json                UTF-8 JSON, <= 4 MiB
+-- images/
|   +-- <ID>.png                 a layer's pixels (or <ID>.exr, HDR layer, v13+)
|   +-- <ID>.mask.png            that layer's (or folder's) mask
+-- QuickLook/
    +-- Preview.jpg              written by the app on save; never read by the loader
```

- The package must be a directory: `guard try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true`
  (`IO/ProjectStore.swift:155`).
- The loader never lists any directory. It opens `manifest.json` and then exactly the files the manifest names, at
  `url.appendingPathComponent("images").appendingPathComponent(filename)` (`IO/ProjectStore.swift:174`).
- Blank layers (an empty layer, which allocates pixels only when painted), folders and adjustment layers have no
  `imageFile` and no asset (`docs/project-format.md:5`, `Document/EditorSession.swift:36-41`).

---

## 2. How the JSON is decoded (applies to every object below)

Every model type uses compiler-synthesized `Codable`. There is no custom `init(from:)`, `encode(to:)` or `CodingKeys`
anywhere in `Compositor/` (grep returns nothing). Consequences:

| JSON situation | Result |
|---|---|
| Non-optional Swift property, **even one with a default value** (`var rotation: CGFloat = 0`, `var format = "..."`) | Key is **required**. Missing key -> decode error. Source defaults are never applied when decoding. [verified] |
| Optional property (`T?`) | Key optional; missing or `null` -> nil. [verified] |
| Unknown keys at any level | Ignored. [verified] |
| Duplicate key in one object | JSONDecoder keeps the **first** value [verified]; JavaScript `JSON.parse` keeps the last. Reject duplicates in the Node lib. |
| `Int` fields (`width`, `height`, `version`, run `location`/`length`, `noiseSeed`, grain `seed`) | Integral numbers accepted, including `1920.0` and `1e3`; `1920.5` and `"1920"` rejected. [verified] `noiseSeed`/`seed` are `UInt32`: 0...4294967295. |
| `Bool` | Only `true` / `false`; `1` / `0` rejected. [verified] |
| `Double` / `CGFloat` | Any JSON number (JSON cannot carry NaN or Infinity). |
| `UUID` | String in canonical hyphenated 8-4-4-4-12 form, **case-insensitive** (lowercase accepted and normalized to uppercase); braces or missing hyphens rejected. [verified] |
| `CGPoint` / `CGSize` | JSON array `[x, y]` / `[width, height]`; at least two numbers (extra elements ignored); object form `{"x":..}` rejected. [verified] |
| String-backed enums | Exact, case-sensitive raw strings (lists in section 6). Unknown string -> decode error. |
| Dictionary keyed by an enum (only `hsvSettings.adjustments` / `.bands`) | Encoded as a **flat array alternating key and value**: `["Master", {...}, "Reds", {...}]`; the object form `{"Master": {...}}` is rejected. [verified] |
| UTF-8 BOM before the JSON | Accepted. Trailing non-whitespace after the JSON value: rejected. [verified] |

Any decode failure becomes `ProjectError.invalid`. The loader first decodes a header struct
`Header { let format: String; let version: Int }`, checks the format, then the version (unsupported version ->
`ProjectError.version`), then decodes the full manifest (`IO/ProjectStore.swift:84-87`, `:160-166`):

```swift
do { header = try JSONDecoder().decode(Header.self, from: metadata) }
catch { throw ProjectError.invalid }
guard header.format == "com.compositor.project" else { throw ProjectError.invalid }
guard ProjectManifest.supported.contains(header.version) else { throw ProjectError.version(header.version) }
do { manifest = try JSONDecoder().decode(ProjectManifest.self, from: metadata) }
catch { throw ProjectError.invalid }
```

---

## 3. Document-level keys (`ProjectManifest`, `IO/ProjectStore.swift:18-36`)

| JSON key | Type | Req? | Default when missing | Valid values / rule (file:line) | Since | App writes on save |
|---|---|---|---|---|---|---|
| `format` | String | required | - | must equal `"com.compositor.project"` (`IO/ProjectStore.swift:163`, `:214`) | v1 | always |
| `version` | Int | required | - | `1...14`, else `ProjectError.version` (`:164`, `:215`) | v1 | always `14` (`var version = ProjectManifest.current`, `:26`) |
| `colorSpace` | String | required | - | must equal `"sRGB"` (`:216`) | v1 | always `"sRGB"` |
| `documentID` | UUID | required | - | any UUID; keep it when editing (`docs/writing-comp-files.md:61`) | v1 | always |
| `width` | Int | required | - | `1...30000` (`:220`, `DocumentLimits.maxSide`, `Document/DocumentLimits.swift:18`) | v1 | always |
| `height` | Int | required | - | `1...30000` (`:220`) | v1 | always |
| `resolution` | Double? | optional | `72` (`Document/EditorSession+Projects.swift:29`) | finite and `1...9600` (`:217-219`) | additive, valid at every version (`docs/project-format.md:13`) | always (the document's resolution is non-optional, `Document/EditorSession+Projects.swift:15`) |
| `activeLayerID` | UUID? | optional | no active layer | must equal the `id` of some layer, folders included (`:264`) | v1 | whenever a layer is active |
| `layers` | [Layer] | required | - | at most 10,000 records (`:221`); array order is bottom-to-top sibling order (section 4.1) | v1 | always (may be `[]`) |
| `guides` | [Guide]? | optional | `[]` | v1-7: must be missing or empty (`:270-272`); v8+: at most 1,000 (`:274`), unique `id`s, `position` finite with `abs <= 1_000_000` (`:277`) | v8 | only when non-empty (`guides: document.guides.isEmpty ? nil : document.guides`, `Document/EditorSession+Projects.swift:17`) |

---

## 4. Layer-level keys (`ProjectLayerRecord`, `IO/ProjectStore.swift:38-61`)

| JSON key | Type | Req? | Default when missing | Valid values / rule (file:line) | Since | App writes on save |
|---|---|---|---|---|---|---|
| `id` | UUID | required | - | unique among layers (`IO/ProjectStore.swift:258`, `Document/LayerGroups.swift:33`, `Document/LiveLayerMask.swift:7`) | v1 | always (uppercase) |
| `name` | String | required | - | not empty after trimming whitespace and newlines; at most 16,384 UTF-8 bytes (`:259-260`) | v1 | always |
| `isVisible` | Bool | required | - | - | v1 | always |
| `transform` | Transform | required | - | `transform.isValid` (`:258`; section 5) | v1 | always |
| `imageFile` | String? | optional | no pixels (blank layer) | exactly `"<ID>.png"`, or from v13 `"<ID>.exr"` (`:261-262`); forbidden on folders (`Document/LayerGroups.swift:34`) and adjustment layers (`:234`); required on text layers (`:231`) | v1 (`.exr` v13) | when the layer has pixels: `layer.asset?.file(for: layer.id)` (`IO/ImageImporter.swift:20`) |
| `parentID` | UUID? | optional | root level | must name a record with `isGroup: true`; no cycles; depth limits (section 9.3); forbidden in v1 (`:255`) | v2 | when inside a folder |
| `isGroup` | Bool? | optional | `false` | a folder: no `imageFile`, no `adjustment`, no `text`, no `maskSourceID`, cannot be a clipping source; `true` forbidden in v1 (`:255`) | v2 | always (`true`/`false`) |
| `opacity` | Double? | optional | `1` | finite, `0...1` (`:248`); v1-2 must be 1 (`:249`); a folder must be 1 before v8 (`:250`) | v3 (folders v8) | always |
| `blendMode` | String? | optional | `"Normal"` | one of the 24 strings (section 6); v1-2 must be Normal (`:249`); a folder must **always** be Normal (`:250`) | v3 | always |
| `maskFile` | String? | optional | no mask | exactly `"<ID>.mask.png"` (`:241`); layers from v4, folders from v6 (`:240`) | v4 / v6 | iff the layer has a mask (`Document/EditorSession+Projects.swift:13`) |
| `maskEnabled` | Bool? | optional | `true` (`layer.maskEnabled ?? true`, `Document/LayerMask.swift:215`) | requires `maskFile` (`:242`) | v4 | iff mask |
| `maskSourceID` | UUID? | optional | not clipped | the clipping base: must exist, not itself, not a folder, not an adjustment layer; the target is not a folder; chain at most 256 nodes, acyclic (`Document/LiveLayerMask.swift:9-18`); forbidden before v5 (`:254`) | v5 | iff clipped |
| `adjustment` | Adjustment? | optional | not an adjustment layer | v7+, not a folder, no `imageFile`, `adjustment.isValid` (`:234`); kinds `Gaussian Blur` / `Motion Blur` / `Add Noise` need v9 (`:235-237`) | v7 | adjustment layers |
| `maskPlacement` | Transform? | optional | the mask covers the layer's own rect | requires `maskFile` and `isValid` (`:243`) | additive (no version gate, `docs/project-format.md:41-43`) | only when the mask sits apart from the layer (`layer.mask?.placement`, `Document/LayerMask.swift:9-11`) |
| `maskLinked` | Bool? | optional | `true` (`layer.maskLinked ?? true`, `Document/LayerMask.swift:215`) | **not validated** (the docs say it needs `maskFile`; the code never checks) | additive | iff mask |
| `shape` | Shape? | optional | not a shape layer | only check: `smoothing == true` needs v14 (`:223-225`) | additive (`smoothing` v14) | while the PNG is still the Shape tool's own raster (`layer.liveShape?.style`, `Document/ShapeTool.swift:89-92`) |
| `effects` | Effects? | optional | none | **not validated at load**; out-of-range effects are silently not drawn (`guard let effects = effects?.visible, !effects.isEmpty, effects.isValid else { return nil }`, `Document/LayerEffects.swift:418`) | additive | whenever the layer has an effects record |
| `text` | Text? | optional | not a text layer | `text.isValid`, `colorRuns` needs v10, `fontRuns` needs v11, needs `imageFile`, not a folder, no `adjustment` (`:226-232`) | additive (runs v10/v11) | while the PNG is still the text's own raster (`layer.liveText?.style`, `Document/TypeTool.swift:216-220`) |

### 4.1 Order, hierarchy and kinds of layer

- `layers` runs bottom to top. Folders are **not** drawn as contiguous array ranges: the hierarchy is rebuilt by
  grouping records by `parentID` (keeping array order inside each group) and walking it depth first from the root
  (`Document/LayerGroups.swift:9-26`, `:119-140`). A child's array position matters only relative to its siblings.
- Kinds: pixel layer (`imageFile`), blank layer (no `imageFile`, no `adjustment`, not a folder), folder
  (`isGroup: true`), adjustment layer (`adjustment`, no `imageFile`), text layer (pixel layer + `text`), shape layer
  (pixel layer + `shape`).

---

## 5. Transform object (`LayerTransform`, `Document/LayerTransform.swift:17-31`)

Used by `transform` and `maskPlacement`. All six keys are **required** (non-optional properties, section 2):

| Key | Type | Meaning |
|---|---|---|
| `origin` | `[x, y]` | top-left corner of the **unrotated** rect, document pixels |
| `size` | `[width, height]` | rect size in document pixels; the image (any pixel size) is stretched to it |
| `rotation` | number | degrees, **clockwise**, around the rect's center; used modulo 360 (`rotation.truncatingRemainder(dividingBy: 360)`, `:26`) |
| `flipX`, `flipY` | Bool | mirror in the layer's own axes, before rotation |
| `sampling` | String | `"Nearest"`, `"Smooth"` or `"High quality"` (`:4-7`) |

```swift
/// Unrotated bounds in document pixels; rotation is clockwise around their center.
var isValid: Bool {
    [origin.x, origin.y, size.width, size.height, rotation].allSatisfy(\.isFinite)
        && (1...300_000).contains(size.width) && (1...300_000).contains(size.height)
        && abs(origin.x) <= 1_000_000 && abs(origin.y) <= 1_000_000
}
```
(`Document/LayerTransform.swift:17`, `:27-31`). Fractional values are legal; the app rounds only after interactive
drags (`rounded()`, `:53-59`). The exact pixel-to-document mapping is in `compositing.md` section 3.

---

## 6. Enumerations (exact strings)

| Field | Values (file:line) |
|---|---|
| `blendMode` | `Normal`, `Darken`, `Multiply`, `Color Burn`, `Linear Burn`, `Lighten`, `Screen`, `Color Dodge`, `Linear Dodge (Add)`, `Overlay`, `Soft Light`, `Hard Light`, `Vivid Light`, `Linear Light`, `Pin Light`, `Hard Mix`, `Difference`, `Exclusion`, `Subtract`, `Divide`, `Hue`, `Saturation`, `Color`, `Luminosity` (`Document/LayerAppearance.swift:4-13`) |
| `transform.sampling` | `Nearest`, `Smooth`, `High quality` (`Document/LayerTransform.swift:4-7`) |
| `adjustment.kind` | `Hue/Saturation`, `Levels`, `Curves`, `Exposure`, `Gradient Map`, `Grain`, `Add Noise`, `Gaussian Blur`, `Motion Blur`, `Invert`, `Black & White`, `Color Balance` (`Document/LayerAdjustment.swift:4-9`) |
| `levels.channel`, `curves.channel` | `RGB`, `Red`, `Green`, `Blue` (`Document/Levels.swift:4-5`) |
| `hsvSettings` ranges | `Master`, `Reds`, `Yellows`, `Greens`, `Cyans`, `Blues`, `Magentas` (`Document/HueSaturation.swift:5-7`) |
| `text.alignment` | `Left`, `Center`, `Right` (`Document/TypeTool.swift:3-5`) |
| `shape.kind` | `Rectangle`, `Ellipse`, `Line` (`Document/ShapeTool.swift:3-6`) |
| `guides[].axis` | `horizontal`, `vertical` (`Document/Guides.swift:6`) |

---

## 7. Sub-objects

Recommendation for the Node lib: **preserve `adjustment`, `effects`, `text`, `shape` verbatim** when rewriting a
manifest you did not author (the app re-reads them exactly), and validate them with the rules below only when you
create or edit them. "req" = required key (section 2).

### 7.1 `adjustment` (`Document/LayerAdjustment.swift:45-71`)

| Key | Type | Req? | Notes |
|---|---|---|---|
| `kind` | String | req | section 6 |
| `hue`, `saturation`, `lightness` | number | req | `abs(hue) <= 360`, `abs(saturation) <= 100`, `abs(lightness) <= 100`, finite |
| `colorize` | Bool | req | |
| `levels` | object | req | `{ "channel": ..., "ranges": [4 x {black, gamma, white, outputBlack, outputWhite}] }`, all keys req, order RGB, red, green, blue (`Document/Levels.swift:8-34`) |
| `curves` | object | req | `{ "channel": ..., "channels": [4 x [{x, y}, ...]] }`, all keys req (`Document/Curves.swift:3-9`) |
| `hsvSettings` | object? | opt | `{range, colorize, invertRange, adjustments, bands}` all req; `adjustments` = `[Range, {hue, saturation, lightness}, ...]`, `bands` = `[Range, {falloffStart, rangeStart, rangeEnd, falloffEnd}, ...]` (flat key/value arrays, section 2) (`Document/HueSaturation.swift:26-30`, `:162-177`) |
| `exposureSettings` | object? | opt | `{exposure, offset, gamma}` (`Document/ImageAdjustments.swift:37-47`) |
| `gradientMapSettings` | object? | opt | `{shadows:{red,green,blue}, highlights:{red,green,blue}, reversed}` (`:20-28`, `:75-79`) |
| `grainSettings` | object? | opt | `{amount, size, roughness, seed}` (`:180-191`) |
| `blackWhiteSettings` | object? | opt | `{reds, yellows, greens, cyans, blues, magentas, tint, tintHue, tintSaturation}` (`:114-131`) |
| `colorBalanceSettings` | object? | opt | `{shadowCyanRed, shadowMagentaGreen, shadowYellowBlue, midCyanRed, midMagentaGreen, midYellowBlue, highlightCyanRed, highlightMagentaGreen, highlightYellowBlue, preserveLuminosity}` (`:146-163`) |
| `blurRadius`, `motionAngle`, `motionDistance`, `noiseAmount` | number? | opt | defaults 10, 0, 10, 10 (`Document/LayerAdjustment.swift:92-107`) |
| `noiseGaussian`, `noiseMonochromatic` | Bool? | opt | default false |
| `noiseSeed` | UInt32? | opt | default 0 |

`isValid` (`Document/LayerAdjustment.swift:128-141`), checked for every kind, with the defaults standing in for missing
optional blocks:

- hue/saturation/lightness as above; every `hsvSettings.adjustments` value in the same ranges; every band handle
  finite.
- `levels.ranges.count == 4` and every range equals its own `normalized` form, i.e. already inside: `black` 0...254,
  `white` (black+1)...255, `gamma` 0.1...9.99, `outputBlack` / `outputWhite` 0...255, all finite
  (`Document/Levels.swift:14-25`). Out-of-range values are **rejected**, not clamped.
- `curves`: exactly 4 channels; each 2...32 points; first `x == 0`, last `x == 255`; every x, y finite in 0...255;
  x strictly increasing (`Document/Curves.swift:10-16`).
- exposure: `exposure` -20...20, `offset` -0.5...0.5, `gamma` 0.01...9.99 (`Document/ImageAdjustments.swift:38-47`).
- gradient map colors: each component finite in 0...1 (`:28`, `:79`).
- grain: `amount` 0...100, `size` 0.5...20, `roughness` 0...100 (`:181-191`).
- black & white: six weights -200...300, `tintHue` 0...360, `tintSaturation` 0...100 (`:115`, `:127-131`).
- color balance: nine values -100...100 (`:147`, `:163`).
- `blurRadius` 0.1...250, `motionAngle` -90...90, `motionDistance` 1...2000, `noiseAmount` 0.1...400.

Every kind carries identity `levels` and `curves` blocks (`docs/writing-comp-files.md:102`); the identity values are
`{black 0, gamma 1, white 255, outputBlack 0, outputWhite 255}` and the points `[{x 0, y 0}, {x 255, y 255}]`.

### 7.2 `effects` (`Document/LayerEffects.swift:6-139`)

`{ stroke?, shadow?, colorOverlay?, innerShadow?, outerGlow?, innerGlow? }`; a missing key means the layer does not
have that effect. Inside each record every key is required except `enabled` (missing = visible):

| Record | Keys (all req except `enabled`) | Ranges used by `isValid` |
|---|---|---|
| `stroke` | `enabled?`, `size`, `red`, `green`, `blue`, `opacity`, `inside` | size 0...500, opacity 0...1, rgb 0...1 (`:6-23`) |
| `shadow` | `enabled?`, `angle`, `distance`, `blur`, `red`, `green`, `blue`, `opacity` | angle -360...360 (degrees counterclockwise from the right; 90 = light from above, shadow falls down), distance 0...5000, blur 0...500 (`:25-51`) |
| `colorOverlay` | `enabled?`, `red`, `green`, `blue`, `opacity` | (`:53-65`) |
| `innerShadow` | same keys as `shadow` | same ranges (`:67-90`) |
| `outerGlow` | `enabled?`, `size`, `red`, `green`, `blue`, `opacity` | size 0...500 (`:92-107`) |
| `innerGlow` | same keys as `outerGlow` | (`:109-123`) |

### 7.3 `text` (`Document/TypeTool.swift:7-62`, `:190-202`)

Keys `content`, `fontName`, `fontSize`, `red`, `green`, `blue`, `alignment`, `tracking`, `leading` are required;
`boxSize` (`[w, h]`), `colorRuns`, `fontRuns` optional. `leading` is baseline-to-baseline in layer pixels, 0 = auto
(120% of the font size). `isValid`: `content` at most 100,000 UTF-16 units; `fontSize` 1...2000; rgb 0...1; `tracking`
-100...1000; `leading` 0...5000; `boxSize` each side 16...30000 and area <= 200,000,000. Runs (`colorRuns`:
`{location, length, red, green, blue}`; `fontRuns`: `{location, length, fontName}`) in UTF-16 offsets, sorted,
non-overlapping, `length > 0`, ending within `content`, array non-empty; a run `fontName` is non-empty, at most 200
characters, no newlines. The PNG stays the display and export source; the style is only used for editing.

### 7.4 `shape` (`Document/ShapeTool.swift:57-71`)

Required `kind`, `red`, `green`, `blue`, `cornerRadius` (document pixels); optional `smoothing` (Bool, `true` needs
v14), `lineWidth`, `start`, `end` (`[x, y]` as fractions 0-1 of the layer box, lines only). No range checks at load.

### 7.5 `guides[]` (`Document/Guides.swift:5-10`)

`{ "id": UUID, "axis": "horizontal" | "vertical", "position": number }`, all required. `position` is a document y for
horizontal guides and a document x for vertical ones.

---

## 8. What the app writes on save

`ProjectStore.save` (`IO/ProjectStore.swift:89-141`), fed by `EditorSession.projectSnapshot()`
(`Document/EditorSession+Projects.swift:5-18`).

### 8.1 Encoder settings

```swift
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let metadata = try encoder.encode(snapshot.manifest)
guard metadata.count <= 4 * 1024 * 1024 else { throw ProjectError.tooLarge }
```
(`IO/ProjectStore.swift:116-119`). Observed output format [verified]:

- Keys sorted; two-space indent; `"key" : value` (a space on both sides of the colon); arrays one element per line.
- Optional properties that are nil are **omitted**, never written as `null`.
- Numbers: integral doubles print without a fraction (`1`, `0`, `72`, `1920`); others use the shortest round-trip form
  (`0.5`, `10.25`, `0.30000000000000004`). Do not expect a `.0` to tell doubles from ints.
- UUIDs uppercase (`6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F`).
- Strings: `/` is escaped as `\/`; non-ASCII is written raw UTF-8; control characters as `\u0001`.
- NaN or Infinity in any number makes the encode throw, so the save fails.
- `origin`, `size`, `boxSize`, `start`, `end` are JSON arrays of two numbers.

### 8.2 Keys always written

The record is built as (`Document/EditorSession+Projects.swift:12-13`):

```swift
return ProjectLayerRecord(id: layer.id, name: layer.name, isVisible: layer.isVisible,
    transform: layer.transform, imageFile: layer.asset?.file(for: layer.id), parentID: layer.parentID, isGroup: layer.isGroup, opacity: layer.opacity, blendMode: layer.blendMode, maskFile: layer.mask == nil ? nil : "\(layer.id.uuidString).mask.png", maskEnabled: layer.mask?.isEnabled, maskSourceID: layer.maskSourceID, adjustment: layer.adjustment, maskPlacement: layer.mask?.placement, maskLinked: layer.mask?.isLinked, shape: layer.liveShape?.style, effects: layer.effects, text: layer.liveText?.style)
```

- Document: `colorSpace`, `documentID`, `format`, `height`, `layers`, `resolution`, `version` (= 14), `width`;
  `activeLayerID` when set; `guides` when non-empty.
- Every layer: `blendMode`, `id`, `isGroup`, `isVisible`, `name`, `opacity`, `transform` (all six keys).
- Conditionally: `imageFile`, `parentID`, `maskFile` + `maskEnabled` + `maskLinked` (together), `maskPlacement`,
  `maskSourceID`, `adjustment`, `shape`, `effects`, `text`.
- `adjustment` always contains `kind`, `hue`, `saturation`, `lightness`, `colorize`, `levels`, `curves`, plus whichever
  optional blocks are set.

Illustrative output (built from the encoder rules above, not copied from a real file):

```json
{
  "activeLayerID" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
  "colorSpace" : "sRGB",
  "documentID" : "0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D",
  "format" : "com.compositor.project",
  "height" : 1080,
  "layers" : [
    {
      "blendMode" : "Normal",
      "id" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
      "imageFile" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png",
      "isGroup" : false,
      "isVisible" : true,
      "maskEnabled" : true,
      "maskFile" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.mask.png",
      "maskLinked" : true,
      "name" : "Background",
      "opacity" : 1,
      "transform" : {
        "flipX" : false,
        "flipY" : false,
        "origin" : [
          0,
          0
        ],
        "rotation" : 0,
        "sampling" : "High quality",
        "size" : [
          1920,
          1080
        ]
      }
    }
  ],
  "resolution" : 72,
  "version" : 14,
  "width" : 1920
}
```

### 8.3 The package the app writes

```swift
var contents = [
    "manifest.json": FileWrapper(regularFileWithContents: metadata),
    "images": FileWrapper(directoryWithFileWrappers: images)
]
// Quick Look's Space-bar preview reads this by name; loading ignores it.
if let quickLook {
    contents["QuickLook"] = FileWrapper(directoryWithFileWrappers: [
        "Preview.jpg": FileWrapper(regularFileWithContents: quickLook.preview),
    ])
}
let package = FileWrapper(directoryWithFileWrappers: contents)
...
NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { destination in
    do {
        // Foundation stages a sibling package and atomically replaces the
        // destination only once the complete package has been written.
        try package.write(to: destination, options: .atomic, originalContentsURL: nil)
```
(`IO/ProjectStore.swift:120-137`). Consequences:

- The whole package is rebuilt from memory: `manifest.json`, `images/` holding **only** the referenced assets (`:93-115`),
  and `QuickLook/Preview.jpg` when it could be rendered. **Every other file or folder in the package is deleted** by an
  app save (sidecars, `.git`, unreferenced PNGs, leftover temp files). Unknown manifest keys are dropped too, because
  the manifest is re-encoded from structs. `CompositorTests/ProjectTests.swift:96-112` asserts that removed assets
  disappear.
- With `originalContentsURL: nil`, every PNG is re-encoded and rewritten on every save, changed or not.
- The package directory is swapped in from a staged sibling, so it is a **new inode**: anything watching the old
  directory's file descriptor must re-arm by path (the app's own watcher does, section 12).
- The app validates the manifest and every mask before writing (`:90`, `:98`) and never replaces the old package when
  something fails (`CompositorTests/ProjectTests.swift:114-140`).
- There is no autosave (no `autosave` anywhere in `Compositor/`); the app writes only on Save / Save As
  (`IO/ProjectController.swift:207-262`).

---

## 9. Load validation checklist

`ProjectStore.load` -> `readPackage` -> `validate` (`IO/ProjectStore.swift:143-266`). Load happens under
`NSFileCoordinator` (`:146`), which writers that skip coordination (Node) are not blocked by. Steps in execution order:

### 9.1 Package and manifest file

| # | Check | file:line | Error |
|---|---|---|---|
| 1 | package URL is a directory | `IO/ProjectStore.swift:155` | invalid |
| 2 | `manifest.json`: resolved path inside the package, regular file, not a symlink, <= 4 MiB (missing file throws a Cocoa error) | `:157`, `:290-296` | tooLarge / Cocoa |
| 3 | header decodes (`format` String, `version` Int) | `:161-162` | invalid |
| 4 | `format == "com.compositor.project"` | `:163` | invalid |
| 5 | `version` in 1...14 | `:164` | version |
| 6 | full manifest decodes (section 2; every required key, enum strings, types) | `:165-166` | invalid |

### 9.2 `validate(manifest)` (`IO/ProjectStore.swift:213-266`)

| # | Check | file:line |
|---|---|---|
| 7 | format / version again | `:214-215` |
| 8 | `colorSpace == "sRGB"` | `:216` |
| 9 | `resolution`, if present, finite and 1...9600 | `:217-219` |
| 10 | `width`, `height` in 1...30000; `layers.count <= 10_000` (tooLarge) | `:220-221` |
| 11 | per layer: `shape.smoothing == true` needs v14 | `:223-225` |
| 12 | per layer with `text`: `text.isValid`, `colorRuns == nil` or v10+, `fontRuns == nil` or v11+, `imageFile != nil`, not a folder, no `adjustment` | `:226-232` |
| 13 | per layer with `adjustment`: v7+, not a folder, `imageFile == nil`, `adjustment.isValid`; blur/noise kinds v9+ | `:233-238` |
| 14 | per layer: `maskFile` nil, or (v >= 4 for layers / v >= 6 for folders, and equals `"<ID>.mask.png"`); `maskEnabled` needs `maskFile`; `maskPlacement` needs `maskFile` and `isValid` | `:239-243` |
| 15 | per layer: opacity finite in 0...1; v < 3 needs opacity 1 and Normal; folders need Normal always and opacity 1 before v8 | `:244-250` |
| 16 | hierarchy (section 9.3) | `:252` |
| 17 | clipping graph (section 9.4) | `:253` |
| 18 | v < 5: no `maskSourceID` anywhere | `:254` |
| 19 | v == 1: no `parentID`, no `isGroup: true` | `:255` |
| 20 | per layer: unique `id`; `transform.isValid`; name not blank and <= 16,384 UTF-8 bytes; `imageFile` nil or `"<ID>.png"` or (v13+) `"<ID>.exr"` | `:256-263` |
| 21 | `activeLayerID`, if present, names a layer | `:264` |
| 22 | guides: v < 8 must be empty; else <= 1,000 (tooLarge), unique ids, finite, abs <= 1,000,000 | `:268-281` |

The id comparison uses `layer.id.uuidString`, which is uppercase. A lowercase id in the manifest decodes fine, but its
`imageFile` / `maskFile` must still be spelled with the **uppercase** id.

### 9.3 Folder hierarchy (`Document/LayerGroups.swift:30-46`)

```swift
for layer in layers {
    guard byID.updateValue(layer, forKey: layer.id) == nil,
          layer.isGroup != true || layer.imageFile == nil else { throw ProjectError.invalid }
}
for layer in layers {
    var seen: Set<UUID> = [layer.id]
    var parent = layer.parentID
    while let id = parent {
        guard seen.count <= 64, seen.insert(id).inserted,
              let node = byID[id], node.isGroup == true else { throw ProjectError.invalid }
        parent = node.parentID
    }
    if layer.isGroup == true, seen.count > 64 { throw ProjectError.invalid }
}
```
Duplicate ids and folders with images are rejected. Every parent must exist and be a folder, with no cycles. A leaf
may have at most **64** ancestors and a folder at most **63** (so a leaf still fits below the deepest folder).

### 9.4 Clipping graph (`Document/LiveLayerMask.swift:4-19`)

```swift
while let id = current {
    guard path.count < 256, path.insert(id).inserted, let record = records[id] else { throw ProjectError.invalid }
    if let source = record.maskSourceID {
        guard !((record.isGroup ?? false)), records[source] != nil, records[source]?.isGroup != true, records[source]?.adjustment == nil else { throw ProjectError.invalid }
    }
    current = record.maskSourceID
}
```
The `maskSourceID` chain from any layer is acyclic (self-links included) and at most 256 nodes. A source exists and is
neither a folder nor an adjustment layer. A target is not a folder; an adjustment layer can be a target.

### 9.5 Assets (`IO/ProjectStore.swift:168-209`), for each layer, image first then mask

| # | Check | file:line | Error |
|---|---|---|---|
| 23 | `images/<name>`: resolved path (symlinks resolved) inside the package, regular file, not a symlink, <= 512 MiB | `:174-175`, `:290-296` | invalid / tooLarge |
| 24 | whole file read into memory | `:180` | |
| 25 | `.exr` only for images and only v13+ | `:182-183` | missingImage |
| 26 | content sniffed: `CGImageSourceGetType` is `public.png` (`com.ilm.openexr-image` for `.exr`); the extension alone is not enough | `:185` | missingImage |
| 27 | `CGImageSourceGetCount == 1` (a multi-frame APNG would likely fail here; not tested) | `:186` | missingImage |
| 28 | pixel width and height readable | `:187-189` | missingImage |
| 29 | `kCGImagePropertyDepth` (default 8): <= 8 always; 16 only for images at v12+; EXR any | `:191-192` | missingImage |
| 30 | sides 1...30000 and running pixel total within the budget, counted **separately** for images and masks | `:193-194`, `:283-288` | tooLarge |
| 31 | full decode plus a 96 px thumbnail succeed | `:195-201` | missingImage |
| 32 | masks: `LayerMask.isValid` (8-bit gray, no alpha; section 10.2) | `:202` | invalid |

### 9.6 Version gates in one table

| Feature | Minimum `version` | file:line |
|---|---|---|
| `parentID`, `isGroup: true` | 2 | `IO/ProjectStore.swift:255` |
| `opacity != 1`, `blendMode != Normal` (layers) | 3 | `:249` |
| `maskFile` on a layer | 4 | `:240` |
| `maskSourceID` | 5 | `:254` |
| `maskFile` on a folder | 6 | `:240` |
| `adjustment` | 7 | `:234` |
| folder `opacity != 1`; non-empty `guides` | 8 | `:250`, `:270` |
| adjustment kinds Gaussian Blur, Motion Blur, Add Noise | 9 | `:235-237` |
| `text.colorRuns` | 10 | `:229` |
| `text.fontRuns` | 11 | `:230` |
| 16-bit PNG layer image | 12 | `:192` |
| `.exr` layer image | 13 | `:183`, `:262` |
| `shape.smoothing: true` | 14 | `:224` |
| `resolution`, `maskPlacement`, `maskLinked`, `shape`, `effects`, `text` | any (additive) | `docs/project-format.md:13`, `:39-52` |

---

## 10. Image assets

### 10.1 Layer images: what loads

Loading uses `CGImageSourceCreateWithData` on the bytes and keeps the decoded image as it is (`ImportedImage(image:
image, ...)`, `IO/ProjectStore.swift:205`). It does not convert to RGBA. PNG color types tested through that exact path
[verified]:

| PNG | Decodes as | Accepted as a layer image (v <= 11) |
|---|---|---|
| RGBA 8-bit (type 6) | sRGB, straight alpha (`CGImageAlphaInfo.last`) | yes |
| RGB 8-bit (type 2) | sRGB, `noneSkipLast` | yes |
| Gray 1/8-bit (type 0) | Generic Gray Gamma 2.2, 8 bpc | yes |
| Gray + alpha (type 4) or gray + tRNS | gray with alpha | yes |
| Palette (type 3), with or without tRNS | indexed / sRGB with alpha | yes |
| 16-bit gray or RGBA | 16 bpc | only v12+ (else missingImage) |

So "layer images are RGBA" (`docs/writing-comp-files.md:71`) is advice, not a rule. Core Graphics color-manages each
type into the sRGB canvas when drawing. For a JS writer, RGBA 8-bit is the right choice.

### 10.2 Masks: what loads

```swift
static func isValid(_ image: CGImage) -> Bool {
    !image.isMask && image.colorSpace?.model == .monochrome
        && image.bitsPerComponent == 8 && image.alphaInfo == .none
}
```
(`Document/LayerMask.swift:23-26`.) [verified] per PNG type: gray type 0 at 8-bit, or 1-bit (ImageIO expands it to 8
bpc), passes, with or without an `sRGB` / gray `iCCP` chunk. Gray + tRNS fails (the decoded image gets alpha), as do
gray + alpha (type 4), RGB, RGBA and palette. 16-bit gray is rejected earlier by the depth rule (`missingImage`).

- Name `"<ID>.mask.png"`, always PNG, even for an EXR layer (`IO/ProjectStore.swift:181-182`).
- Coverage = raw sample / 255, white reveals and black hides. Core Graphics' clip-to-mask uses the samples as they
  are, with **no gamma or ICC conversion** [verified: samples 0, 128, 200, 255 gave alpha 0, 128, 200, 255].
- Pixel size is **not** checked against the image. The mask is stretched over the layer's transform rect (or over
  `maskPlacement`). Convention: the same pixel size as the layer image (`docs/writing-comp-files.md:98`), or 1x1 for a
  uniform reveal-all or hide-all mask. The app makes 1x1 masks for Add Mask: `LayerMask.solid(revealing:)`
  (`Document/LayerMask.swift:27-34`). For a blank layer or folder the app sizes painted masks
  `Int(layer.size.width.rounded())` x `Int(layer.size.height.rounded())` (`Document/LayerMask.swift:245-246`).
- `maskEnabled: false`: kept, but not composited.
- `maskLinked` only affects editing (whether the mask follows later moves); rendering looks only at `maskPlacement`.
  See `compositing.md` section 6.

### 10.3 How the app writes PNGs

`CGImageDestinationAddImage(destination, image, nil)` with no properties, PNG type, one image (`IO/ProjectStore.swift:
101-112`). In memory, layers the app created, imported or edited are sRGB RGBA8 premultiplied-last
(`BrushRaster.context`, `Document/BrushStroke.swift:36-44`; imports via `format: .RGBA8, colorSpace: sRGB`,
`IO/ImageImporter.swift:128`). [verified] on this macOS:

| In memory | Written PNG |
|---|---|
| sRGB RGBA8 premultiplied (app-made, imported or edited layers) | color type **6**, 8-bit, non-interlaced, **straight (un-premultiplied) alpha**: premultiplied (128,64,0,128) was written as (255,128,0,128). `sRGB` chunk, no `iCCP`/`gAMA`, plus an `eXIf` chunk. Fully opaque layers are still type 6. |
| DeviceGray 8-bit (app-made masks) | color type **0**, 8-bit, no color chunk, `eXIf` |
| A layer or mask loaded from disk and never edited | re-encoded in its decoded layout: RGB -> type 2 + `sRGB`; gray -> type 0 + `iCCP` "kCGColorSpaceGenericGrayGamma2_2" (3,332-byte profile); plain palette -> type 3; palette + tRNS -> type 6; gray + alpha -> type 4 + `iCCP` |
| 16-bit layer (v12) | 16-bit PNG of the full-precision pixels (`DeepLayer.flattened`, `:108-109`) |
| HDR layer (v13) | OpenEXR (`:103-104`) |

Fully transparent pixels lose their RGB (premultiplied storage stores 0) once the layer passes through an RGBA8
context. Do not rely on byte-identical PNGs across macOS versions.

---

## 11. Limits (`Document/DocumentLimits.swift`)

| Limit | Value | Where enforced |
|---|---|---|
| Canvas, image or mask side | 1...30,000 px (`maxSide`, `:18`) | `IO/ProjectStore.swift:220`, `:284` |
| Image pixels per document (sum of w*h over layer images) | `documentPixelBudget` | `:194`, `:284` |
| Mask pixels per document (sum over masks, a separate counter) | `documentPixelBudget` | `:193`, `:284` |
| `documentPixelBudget` | `min(800_000_000, max(maxSurfacePixels, Int(clamping: ProcessInfo.processInfo.physicalMemory / 16)))` (`:36-37`), with `maxSurfacePixels = 200_000_000` (`:25`). About 537 MP on an 8 GB Mac, 800 MP from 16 GB. **Portable safe value: 200,000,000.** | |
| Layers | 10,000 | `IO/ProjectStore.swift:221` |
| Manifest | 4 MiB (load `:157`; save `:119`) | |
| One asset file | 512 MiB | `:175` |
| Guides | 1,000 | `:274` |
| Transform | size 1...300,000; abs(origin) <= 1,000,000 | `Document/LayerTransform.swift:27-31` |
| Export / Preview | export needs w*h <= 200 MP (`IO/ImageExporter.swift:27-28`); Preview.jpg only up to 50 MP (`:92`) | |

`docs/project-format.md:9` still says "100 million total source pixels"; the code above is what runs.

---

## 12. External-change detection (live reload)

### 12.1 Watching (`IO/ProjectWatcher.swift`)

- It watches three paths with kernel vnode events (`DispatchSource.makeFileSystemObjectSource`, `open(path,
  O_EVTONLY)`): the package directory, `manifest.json` and `images/` (`:34-36`, `:38-52`). Event mask
  `[.write, .extend, .delete, .rename, .link, .attrib]` (`:44`). There is no polling and no `NSFilePresenter`, so
  writers need not use file coordination.
- On every event: (a) re-arm by path after 100 ms, retrying every 100 ms up to 20 times until all three paths open
  again, which follows an atomic package swap (`:69-77`); (b) debounce: cancel the pending delivery and schedule a new
  one **300 ms** after this event (`static let coalescing: Duration = .milliseconds(300)`, `:18`, `:78-83`). A burst
  of writes therefore produces one check, 300 ms after the last event.
- What fires: adding, removing or renaming entries in the package root or in `images/` (directory writes); writing,
  extending or replacing `manifest.json`; attribute changes on those three. Overwriting an **existing** PNG in place
  (same inode, no directory change) fires **nothing** by itself (kqueue vnode semantics; inferred, not tested). Write PNGs by temp-file + rename, or rewrite the
  manifest afterwards (you should anyway).
- If the package directory is missing for more than about 2 s (20 x 100 ms), the watch is lost. Never delete and
  re-create the package.

### 12.2 Digest (`IO/ProjectDigest.swift:17-31`)

```swift
var hasher = SHA256()
let manifest = try Data(contentsOf: url.appendingPathComponent("manifest.json"))
hasher.update(data: manifest)
let images = url.appendingPathComponent("images", isDirectory: true)
let names = ((try? FileManager.default.contentsOfDirectory(atPath: images.path)) ?? []).sorted()
for name in names {
    let values = try images.appendingPathComponent(name).resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true else { continue }
    hasher.update(data: Data(name.utf8))
    let count = UInt64(values.fileSize ?? 0)
    withUnsafeBytes(of: count) { hasher.update(bufferPointer: $0) }
}
```
SHA-256 over the exact manifest bytes, then for every **regular** file in `images/` (sorted by name, hidden files such
as `.DS_Store` and temp files included, unreferenced files included): its name in UTF-8, then its size as a
little-endian UInt64. Nothing outside `images/` counts (QuickLook, sidecars). Modification dates do not count, so a
touch or identical bytes written back cause no reload (`CompositorTests/ExternalChangeTests.swift:121-139`). A PNG
replaced by one of the **same byte size** goes unnoticed unless the manifest bytes change too
(`docs/writing-comp-files.md:94`).

### 12.3 Deciding to reload (`IO/ProjectController+ExternalChanges.swift:33-87`)

1. While the app's own save is running (`externalChanges.saving`, `IO/ProjectController.swift:241`), checks return
   at once and the event is dropped (`:44`). After saving, the app stores the digest of what it wrote (`:250`) and
   re-watches (`:251`). An external write that lands during an app save is lost.
2. Compute the digest off the main thread. Unreadable or equal to `knownDigest` -> ignore (`:46-47`).
3. Session busy (an operation running, a transform being edited, the workspace managing tabs) -> retry with
   exponential backoff `250 ms * 2^attempt`, attempt capped at 7, about 32 s at most (`:49-51`, `:63-73`).
4. Unsaved user edits -> only for the frontmost tab, ask "Revert / Keep Mine" (background tabs wait until shown,
   `:28-31`). "Keep Mine" stores the new digest, so that version is skipped (`:52-55`).
5. `ProjectStore.load` (full validation). **Failure is ignored silently** and `knownDigest` stays as it was, so the next
   change is checked again (`:79-81`). A half-written package recovers on the next good write
   (`CompositorTests/ExternalChangeTests.swift:141-156`).
6. Success: `session.reloadProject(snapshot)` keeps viewport, collapsed folders, active and selected layers that still
   exist; it clears undo history (`Document/EditorSession+Projects.swift:40-54`). Then the digest is taken again
   **after** the load (`:84-85`).

---

## 13. QuickLook folder

- Written on each save when the canvas is at most 50,000,000 px and rendering works: `render(snapshot)`, scaled so
  the long side is at most 1,024 px (never enlarged), drawn over **opaque white** with `.high` interpolation, encoded
  as JPEG quality 0.8 in sRGB (`IO/ImageExporter.swift:89-113`, called at `IO/ProjectController.swift:244`). Otherwise
  the saved package has **no** QuickLook folder (the whole package is replaced).
- Never read by the loader (comment at `IO/ProjectStore.swift:124`) and not part of the digest.
- External writers should delete `QuickLook/` after changing a project so Finder does not show a stale preview
  (`docs/writing-comp-files.md:86`), or write their own `Preview.jpg` with the same recipe.

---

## 14. Where the docs and the code disagree

| Docs say | Code does |
|---|---|
| 100 M image pixels and 100 M mask pixels (`docs/project-format.md:9`, `:21`) | `documentPixelBudget`, 200-800 M per counter, depends on RAM (section 11) |
| `maskPlacement` **and** `maskLinked` require `maskFile` (`docs/project-format.md:43`) | only `maskPlacement` and `maskEnabled` are checked (`IO/ProjectStore.swift:242-243`) |
| Layer images are 8-bit RGBA PNGs (`docs/writing-comp-files.md:71`) | any PNG type with depth <= 8 loads (section 10.1) |
| Adjustment layers "affect everything composited below them within their folder" (`docs/project-format.md:29`) | they process the whole composite so far; folders only clip them through folder masks (`compositing.md` section 9) |
| Folder masks cover the folder's transform | yes, and a folder's or adjustment layer's `maskPlacement` is **ignored** when rendering (`compositing.md` section 6) |

---

## 15. Porting notes (Node.js reader / validator / writer)

**Reading**

- Read `manifest.json` as bytes; strip a UTF-8 BOM; parse with a parser that **rejects duplicate keys**; reject
  trailing junk. Apply section 2 type rules strictly (integral checks for Int fields, `true`/`false` only, UUID regex
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, `[x, y]` arrays with at least 2 numbers).
- Run sections 9.1-9.5 in the same order and report the first failure with its upstream `file:line`. This mirrors
  what the app does, since it gives no message.
- PNG checks without decoding: signature, IHDR (width, height, bit depth, color type), presence of `tRNS` and `acTL`
  (APNG: treat as invalid). Mask = color type 0, bit depth 1/2/4/8, no `tRNS`. Image = bit depth <= 8, or 16 when
  version >= 12. Track the two pixel totals separately against 200,000,000.
- Keep unknown keys and the four opaque sub-objects (`adjustment`, `effects`, `text`, `shape`) verbatim for
  round-tripping. The app drops unknown keys on its next save anyway, so never store state you need in them; use a
  sidecar **outside** the package (the app deletes anything inside it that it does not know).

**Writing** (`docs/writing-comp-files.md:75-84` plus the watcher facts above)

1. Generate ids with `crypto.randomUUID().toUpperCase()`; filenames `${id}.png` and `${id}.mask.png`.
2. Write each new or changed PNG to a temp file **inside `images/`** (e.g. `.tmp-<random>.png`) and `rename` it to
   its final name. Same-directory rename is atomic, and it fires the `images/` watcher.
3. Write the manifest to `<package>/.manifest.json.tmp`, `fsync`, then `rename` it over `manifest.json`. This must be
   the last step. Do it within about 300 ms of the PNG writes, or the app may reload in between (harmless, since ids
   are stable: it shows new pixels with the old manifest, then the final state).
4. After the manifest swap, delete images the manifest no longer references, and delete (or regenerate)
   `QuickLook/`.
5. Never replace the package directory itself. `rename` onto a non-empty directory fails with ENOTEMPTY on POSIX, and
   a delete-and-recreate gap can drop the app's watch (section 12.1).
6. PNG encoding: layers as 8-bit RGBA (color type 6) with straight alpha and an `sRGB` chunk (matches the app). Masks
   as 8-bit grayscale (color type 0), no `tRNS`, no alpha, ideally no `iCCP` (sample values are used raw anyway).
7. Numbers: finite only (`Number.isFinite`); `width`/`height`/`version` integral; keep `opacity` within 0..1 after
   float math (clamp `1.0000000002` and the like).
8. Version: write `max(versionReadFromDisk, minimumVersionFor(content))`, using the table in section 9.6. For a new
   project use `minimumVersionFor(content)`. An older Compositor build rejects newer versions outright, and the app
   itself always saves 14.
9. To force a reload when a PNG's size happens not to change, change the manifest bytes as well
   (`docs/writing-comp-files.md:94`).
10. If the user has unsaved edits in the app, it asks them to Revert or Keep Mine (section 12.3 step 4). If they keep
    theirs and save later, the app's save **replaces** your write. The lib cannot detect this, so the VS Code side
    should watch for the package being swapped (new inode) and re-read.

**Watching from VS Code**: the app swaps the whole package on save, so watch by path, debounce around 300 ms, and
compare with the same digest recipe (section 12.2: manifest bytes + sorted regular-file names + UInt64 LE sizes in
`images/`). Remember the digest right after your own write so it does not trigger a reload of your own change.
