# Compositor Filters: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3). All `file:line` references are relative to
`upstream/Compositor/` unless they start with `engine/`, `media/` (that is `vscode-extension/media/`) or
`CompositorTests/`. Code excerpts are verbatim. Modifier glyphs follow `ui.md`: `⌘` Command, `⌥` Option, `⇧` Shift,
`⌃` Control, `⎋` Escape, `↩` Return.

Scope: the Filter menu and its panel (every filter except Camera Raw and Content-Aware Fill, which only appear here
where they share the machinery), plus the Image-menu destructive adjustments **only** as far as they reuse the same
panel. Adjustment math (Curves, Exposure, Gradient Map, Grain, Black & White, Color Balance) belongs to the
adjustments spec; Camera Raw has its own spec.

Files read in full: `Document/Filters.swift` (1034 lines), `UI/FilterSheet.swift` (426), `Document/Dither.swift`
(184), `Document/Scanlines.swift` (98), `Document/SubjectRemoval.swift` (143), `Rendering/DitherPixels.h` (88),
`Rendering/DitherPixels.c` (546), `Rendering/NoisePixels.c` (49), `Rendering/LensPixels.c` (37),
`Document/AdjustmentEditing.swift` (131), `UI/NumericScrub.swift`, `UI/FloatingPanel.swift` (placement part),
`Document/ContentFill.swift`, and the tests `CompositorTests/FilterTests.swift`, `ProgressiveBlurTests.swift`,
`ScanlinesTests.swift`, `FinishingFilterTests.swift`. Read in part (targeted): `CompositorApp.swift` (Image and Filter
menus), `ContentView.swift` (filter panel wiring, alerts), `Document/EditorSession.swift` (session state,
`ImageLayer`, `displayedTransform`), `Document/HueSaturation.swift` (`canAdjustColors`, `canVignette`),
`Document/ColorPalette.swift` (filter color pickers), `Document/ImageAdjustments.swift` (settings structs),
`Document/LayerMask.swift` (`clipImage`, `displayedMaskPlacement`), `Document/PixelAdjust.swift`,
`Document/SelectionEdits.swift` (Invert), `Rendering/AdjustPixels.c` (`adjust_colored_vignette`,
`adjust_tonal_contrast`), `Rendering/EditorCanvas.swift` (Progressive Blur drag), `Rendering/TransformOverlay.swift`
(Progressive Blur overlay), `UI/CameraRawSlider.swift` (colored tracks), `UI/ToolHeaderStyle.swift` (`unitSuffix`),
`Document/DocumentLimits.swift`, `IO/ProjectStore.swift` (error texts). Port side: `engine/Sources/*.swift`,
`engine/build.sh`, `media/filters.js`, `media/board.js` (panel, menus, keys, engine calls), `media/render.js`
(overrides, masks), `media/picker.js`, `vscode-extension/extension.js` (`runEngine`), `core/engine-client.js`.

Note: the checklist mentions `Document/PixelFilter*.swift`; there is no such file. `PixelFilter` is an enum inside
`Document/Filters.swift:205-423`.

**Empirical checks.** Facts marked **(measured)** were produced on this machine (macOS 26, Darwin 25.6) by scratch
programs that were deleted afterwards: a C harness linked against upstream's own `Rendering/DitherPixels.c`,
`Rendering/LensPixels.c` and `Rendering/NoisePixels.c` (section 21), a Node calculation of the Swift arithmetic for
preview sizes, snapping and logarithmic sliders (section 21.5), and a Swift timing of `CGImageDestination` PNG encoding
(section 23).

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| Model | One `FilterSettings` struct holds every filter's settings; each filter reads only its own fields. It is **not Codable** (its nested `DitherSettings`, `ScanlinesSettings`, `CameraRawSettings` are not either); the adjustment sub-structs are | `Document/Filters.swift:62-163` |
| Session state | `filterEdit` (the open filter), `filterSettings` (what the next panel starts from), `lastFilter`, all per project tab, in memory only | `Document/EditorSession.swift:254-258` |
| Menu | Last Filter (⌃⌘F), divider, then 12 filters in `FilterKind` order with `…` | `CompositorApp.swift:329-340` |
| Enabling | `canAdjustColors` (Vignette: `canVignette`, also allows an empty layer) and Hue/Saturation closed | `Document/HueSaturation.swift:445-462` |
| Panel | Non-modal floating panel titled with the filter name, 380 pt wide, padding 24, rows 16 apart; one shared position for all filters, remembered per app session | `UI/FilterSheet.swift:19-204`, `UI/FloatingPanel.swift:35-106` |
| Slider row | Scrubbable title, slider (logarithmic for radius/size/distance/amount), 56 pt numeric field with unit suffix | `UI/FilterSheet.swift:346-375` |
| Preview | Background render; changes arriving mid-render **wait** (the running render finishes, then the newest settings render); never cancelled | `Document/Filters.swift:770-844` |
| Preview size | From a copy at most 2048 px on its long side, except Camera Raw, Add Noise, Grain, Dither, Scanlines, Content-Aware Fill, Remove Background (full size) | `Document/Filters.swift:532, 619-633` |
| Growth | Gaussian, Motion, Progressive Blur and Bloom pad the layer by their reach (only ever grow while the panel is open); OK trims the result to its non-empty pixels | `Document/Filters.swift:564-615, 957-971` |
| OK | One undo step named `FilterKind.rawValue`; preview stays up until the result lands; some zero amounts close like Cancel | `Document/Filters.swift:861-996` |
| Random seed | `FilterEdit.seed = UInt32.random` per panel: Add Noise, Grain and Content-Aware Fill are stable while the panel is open and committed with the **same** seed as previewed | `Document/Filters.swift:457-458, 906-910` |
| Last Filter | Re-applies the last committed Filter-menu filter with its settings, no panel | `Document/Filters.swift:746-759` |
| Engine consequence | The port needs a **persistent** filter edit in compositor-engine (begin / update / commit / cancel). The current one-shot `filter.preview` + `filter.apply` re-create the edit, so seeds differ between preview and result, the Vision mask cache never hits, and settings cannot be passed | section 18 |

---

## 1. Conventions used below

- "pt" is a macOS point; on the board read it as a CSS pixel.
- "Layer pixels" are the layer image's own pixels (`asset.image`), "document" coordinates are canvas pixels with
  y down.
- `FilterKind.rawValue` is the panel title, the menu title without "…", and the undo-step name.
- Every slider value the panel produces is rounded to the control's `decimals`; typed values and title scrubs are not
  (section 4.2). Normalization (`FilterSettings.normalized`) clamps; it rounds only where section 17 says so.

---

## 2. Model and lifecycle (upstream)

### 2.1 `FilterKind` (`Document/Filters.swift:7-53`)

| Case | rawValue (title, undo name) | Menu | Automatic | Last Filter | Preview size | 16-bit / HDR commit path |
|---|---|---|---|---|---|---|
| `gaussianBlur` | Gaussian Blur | Filter | no | yes | ≤2048 | Core Image once at 16 bits |
| `motionBlur` | Motion Blur | Filter | no | yes | ≤2048 | Core Image once at 16 bits |
| `progressiveBlur` | Progressive Blur | Filter | no | yes | ≤2048 | Core Image once at 16 bits |
| `addNoise` | Add Noise | Filter | no | yes | full | `DeepLayer.run`, per channel |
| `vignette` | Vignette | Filter | no | yes | ≤2048 | `DeepLayer.run`, per channel |
| `bloomGlow` | Bloom / Glow | Filter | no | yes | ≤2048 | Core Image once at 16 bits |
| `dither` | Dither | Filter | no | yes | full | **rasterized to 8-bit** |
| `scanlines` | Scanlines | Filter | no | yes | full | `DeepLayer.run`, mixing channels |
| `tonalContrast` | Tonal Contrast | Filter | no | yes | ≤2048 | `DeepLayer.run`, mixing channels |
| `lensCorrection` | Lens Correction | Filter | no | yes | ≤2048 | `DeepLayer.run`, per channel |
| `cameraRaw` | Camera Raw Filter | Filter | no | yes | full | Camera Raw spec |
| `removeBackground` | Remove Background | Filter | **yes** | yes | full | writes a mask (pixels untouched) |
| `contentAwareFill` | Content-Aware Fill | Edit (⇧⌫) | **yes** | **no** | full | rasterized to 8-bit |
| `curves` | Curves | Image ⌘M | no | no | ≤2048 | `DeepLayer.run`, per channel |
| `exposure` | Exposure | Image | no | no | ≤2048 | exact on HDR (`DeepLayer.exposure`) |
| `gradientMap` | Gradient Map | Image | no | no | ≤2048 | 16-bit color lookup |
| `grain` | Grain | Image | no | no | full | `DeepLayer.run`, per channel |
| `blackWhite` | Black & White | Image | no | no | ≤2048 | 16-bit color lookup |
| `colorBalance` | Color Balance | Image | no | no | ≤2048 | 16-bit color lookup |

`isAutomatic` (`:27`): Content-Aware Fill and Remove Background: OK waits for the preview and commits it (or, for Remove
Background, recomputes the mask at full size). `repeatsAsLastFilter` (`:29`): everything but Content-Aware Fill and the
Image-menu adjustments. `runsAtSixteenBits` (`:32`), `mixesChannels` (`:35`), `sixteenBitLookup` (`:38-47`),
rasterizing set (`:918`).

### 2.2 State that outlives a panel (`Document/EditorSession.swift:254-258`)

```swift
    /// The open filter (Filter menu), and the settings the next one starts from.
    var filterEdit: FilterEdit?
    var filterSettings = FilterSettings()
    /// What Filter › Last Filter runs again.
    var lastFilter: FilterKind?
```

One `EditorSession` per project tab (`Document/ProjectWorkspace.swift:12-16`). Nothing here is saved; opening another
project in the same tab does not reset it. On the board: keep `filterSettings` and `lastFilter` per board instance.

### 2.3 Opening: `beginFilter(_:repeating:)` (`Document/Filters.swift:694-744`)

1. Content-Aware Fill returns silently unless `canContentAwareFill`.
2. `guard filterEdit == nil, hueSaturation == nil, kind == .vignette ? canVignette : canAdjustColors else { beep }`.
3. A pending gradient is committed first, then `beginFilter` re-runs (`:697-700`).
4. `commitTransform(); cancelCrop(); cancelLasso()` (`:701`).
5. An empty layer (`asset == nil`, only reachable for Vignette) gets a clear image of
   `max(1, round(transform.size))` pixels (`:705-710`).
6. `var settings = filterSettings` (`:711`), then:
   - Progressive Blur, not repeating: the default line (`:714-720`, section 8.3).
   - Gradient Map, **always**: `GradientMapSettings(shadows: foreground, highlights: background)` (`:722-724`).
7. Growth area: Content-Aware Fill grows to the selection's bounds on the canvas; Vignette on an empty layer grows to
   the whole canvas and sets `edit.canvas` (`:727-734`).
8. `FilterEdit(kind:layer:selection:settings:growingTo:canvas:)` (`:536-562`): normalizes the settings, prepares the
   preview copy, measures `canvasSides` (blurs only), grows for the area, then `growForBlur()`.
9. `updateFilter(edit.settings, preview: !repeating || kind.isAutomatic)` (`:742`): the first preview render.
10. Any thrown error goes to `brushError`, which the app shows as an alert titled "Couldn’t paint"
    (`ContentView.swift:297-300`).

### 2.4 Changing settings: `updateFilter` and the render loop (`Document/Filters.swift:770-844`)

```swift
    func updateFilter(_ settings: FilterSettings, preview: Bool) {
        guard let edit = filterEdit, !edit.committing else { return }
        edit.settings = settings.normalized
        edit.preview = preview
        // A bigger blur needs more room around the layer than it was given.
        if FilterEdit.blurMargin(edit.kind, edit.settings) > edit.grownMargin {
            do { try edit.growForBlur() }
            catch { brushError = error.localizedDescription }
        }
        if previewAdjustmentEditing(preview: preview) { return }
        if edit.kind.isAutomatic, edit.preparedPreview != nil, edit.preparedSettings == edit.settings { brushRevision += 1; return }
        guard preview else {
            edit.pending = nil; edit.preparedPreview = nil; brushRevision += 1
            return
        }
        edit.pending = edit.previewJob
        edit.pendingTransform = edit.grownTransform
        renderFilterPreview(edit)
    }
```

`renderFilterPreview` (`:792-844`) starts a render only if none is running (`edit.previewTask == nil`); otherwise the
newest job waits in `edit.pending` and is started when the running one finishes (`:842`). So a drag produces renders
for the first value and then for whatever value is newest each time a render ends. The result is kept only if
`edit.preview || kind.isAutomatic`, and for automatic filters only when it was made from the current padded grid
(`:836-841`). A render made before the layer grew still shows, at the place it was made for, until the next one lands
(`CompositorTests/FilterTests.swift:167-193`). Errors become `edit.previewError` (orange text in the panel).

`edit.preparing` is true while a render runs; the panel only shows it for automatic filters (section 3, "Working…").

### 2.5 Preview geometry

- `FilterEdit.previewLimit = 2048` (`:532`). `prepared` (`:619-633`):
  `factor = min(1, 2048 / max(width, height))` except for the full-size kinds; `w = max(1, Int(width × factor))`,
  `h = max(1, Int(height × factor))` (**truncation**); `previewScale = w / width`;
  `previewMapping = BrushRaster.pixelToDocument(placed, w, h)`. A downscaled copy is drawn with the default
  interpolation of `BrushRaster.draw`.
- Filters scale their pixel-sized parameters by `job.scale` (= `previewScale` in previews, 1 on OK): Gaussian sigma,
  Motion radius, Progressive radius, Bloom radius, Tonal Contrast radius, Grain units. Lens Correction and Vignette are
  relative to the image, so they need no scaling.
- Growth (`:564-615`): `blurMargin` is `3·radius + 2` (Gaussian; 0 with Preserve Transparency), `distance/2 + 2`
  (Motion), `3·max(From, To) + 2` (Progressive), `3·bloomRadius + 2` (Bloom). `growForBlur` pads by
  `ceil(margin)` on every side **not** in `canvasSides`, only when the margin exceeds the current one, so easing the
  amount back never rebuilds. `grow` redraws the original into the bigger grid, computes `grownTransform` (same
  pixels-per-document-unit, centered on the padded rect) and re-prepares the preview copy (`previewSourceVersion += 1`).
  It throws `ProjectError.tooLarge` past 30 000 px a side or 200 MP.
- `canvasSides` (`:549-556`): only for Gaussian, Motion and Progressive Blur on an **unrotated** layer; a side whose
  edge is at or past the canvas edge (±0.5 px) is in the set, gets no padding, and its edge pixels are carried on
  (`PixelFilter.extending`, `:245-255`).
- Placement of a preview: `edit.preparedTransform` (the grown transform it was made from) or, when nil, the layer's
  own transform (`Document/EditorSession.swift:549-554`). While a grown preview shows, the layer's mask stays on the
  layer's old bounds (`Document/LayerMask.swift:331-334`: `mask.placement ?? layer.transform`).

### 2.6 OK: `commitFilter()` (`Document/Filters.swift:861-996`)

1. A filter color still in the color picker is committed (`:862-864`); adjustment-layer editing short-circuits
   (`:865`).
2. Automatic filters await the running preview; OK does nothing unless a preview exists without error (`:867-871`).
3. **No-op close** (`:876-884`): Lens Correction distortion 0; Vignette amount 0; Bloom amount 0; Tonal Contrast amount
   0 or all three tones 0; Exposure equal to defaults; Grain amount 0; Camera Raw identity → `cancelFilter()`. No undo
   step, `filterSettings` **not** updated, `lastFilter` **not** updated (Camera Raw updates `filterSettings` before
   this check, `:875`).
4. `edit.committing = true` (the panel disables itself), the preview task is cancelled, `filterSettings =
   edit.settings`, `lastFilter = kind` if `repeatsAsLastFilter`, `isProjectBusy = true` (`:885-889`).
5. Remove Background branches to `commitBackgroundMask` (section 16.4).
6. Gaussian Blur with Preserve Transparency runs on the **original** image and mapping (no padding) (`:902-907`);
   every other filter runs on `grownImage ?? original` at scale 1, with the same `seed`, `canvas` and `canvasSides`.
   Automatic filters reuse the cached preview if it was made from the same settings (`:910`).
7. 16-bit / HDR paths (`:913-964`, table 2.1). Spreading filters (Gaussian, Motion, Progressive, Bloom) are trimmed to
   their non-empty pixels and the transform adjusted (`PixelFilter.trimmed`, `:208-233`).
8. **Stale guard** (`:975-978`): discarded silently unless the layer still has the very same image (or was empty and
   still is) and the same transform.
9. A mask on a grown layer (unplaced, larger than 1×1) is re-laid onto the new grid, enabled for the computation,
   extending its edge tone (`:979-988`).
10. `beginEdit(kind.rawValue)`; the layer is rebuilt with the new asset and transform, keeping id, name, visibility,
    parent, opacity, blend mode, mask, clipping source and effects (`:989-994`). It does **not** keep `shape` or
    `text` (see quirk 22.8).
11. `defer`: `filterEdit = nil`, `isProjectBusy = false` (`:891-896`). The preview stays drawn until then, so the
    canvas never flashes the original.

### 2.7 Cancel (`Document/Filters.swift:846-859`)

Closes a filter color picker (discarding), ends adjustment editing if any, does nothing while committing, cancels the
render, `filterEdit = nil`. Nothing is remembered.

### 2.8 Last Filter (`Document/Filters.swift:746-759`)

```swift
    var canRepeatLastFilter: Bool {
        guard let lastFilter, filterEdit == nil, hueSaturation == nil else { return false }
        return lastFilter == .vignette ? canVignette : canAdjustColors
    }
    func repeatLastFilter() async {
        guard let kind = lastFilter, canRepeatLastFilter else { NSSound.beep(); return }
        if gradientEdit != nil { await commitGradient() }
        beginFilter(kind, repeating: true)
        guard let edit = filterEdit, edit.repeating else { return }
        await commitFilter()
        // Nothing to apply (a zero amount), or it couldn't be: don't leave it open with no panel to close it.
        if filterEdit === edit { cancelFilter() }
    }
```

`repeating` skips the panel (`ContentView.swift:270-279`), skips the preview for non-automatic filters, and keeps the
Progressive Blur line from `filterSettings`. Gradient Map is never repeatable, so its forced reset does not matter. A
new `FilterEdit` means a new random seed (Add Noise grain differs on every repeat).

### 2.9 Filter colors through the app color picker (`Document/ColorPalette.swift:141-221, 262-285`)

| Swatch | Target | Picker title |
|---|---|---|
| Vignette › Color | `.vignette` | Color Picker (Vignette Color) |
| Dither / Scanlines › Dark | `.dither(light: false)` | Color Picker (Dark Color) |
| Dither / Scanlines › Light | `.dither(light: true)` | Color Picker (Light Color) |
| Gradient Map › Shadows / Highlights | `.gradientMap(highlights:)` | Color Picker (Gradient Map Shadows) / (Gradient Map Highlights) |

Opening requires `canEditPalette`, no picker already open, the matching filter open and not committing. While open, the
panel's `onChange(of: colorPicker?.color)` pushes the working color into the settings via `updateFilter` (live
preview, `UI/FilterSheet.swift:198-203`). Picker OK keeps the working color, picker Cancel restores the original
(`:124-130`). Filter OK with the picker open commits the picked color first; filter Cancel discards it
(`Document/Filters.swift:846-864`). Picking a color never makes an undo step by itself.

---

## 3. Filter menu and dialog behaviour (checklist lines)

**"Filter menu items, in order"** (`CompositorApp.swift:329-340`):

```
Last Filter            ⌃⌘F     ("Last Filter: <rawValue>" once something was applied)
──────────
Gaussian Blur…
Motion Blur…
Progressive Blur…
Add Noise…
Vignette…
Bloom / Glow…
Dither…
Scanlines…
Tonal Contrast…
Lens Correction…
Camera Raw Filter…
Remove Background…
```

Built as `FilterKind.allCases.filter { $0 != .contentAwareFill && !$0.isImageAdjustment }`. Each item is disabled when
`!(kind == .vignette ? canVignette : canAdjustColors) || hueSaturation != nil`.

**"Last Filter (Ctrl-Cmd-F)"**: title `session.lastFilter.map { "Last Filter: " + $0.rawValue } ?? "Last Filter"` (no
ellipsis). Shortcut `configuredKeyboardShortcut("f", modifiers: [.command, .control])`, remappable ("⌘F is the command
palette"; the doc comment at `Document/Filters.swift:746` says ⌘F, the menu wins). Disabled by `!canRepeatLastFilter`.
Re-applies with the same settings, no panel, no preview (section 2.8). Content-Aware Fill and the Image-menu
adjustments are never recorded (`repeatsAsLastFilter`). A no-op (zero amount) closes silently. `NSSound.beep()` when
unavailable.

**"Enabling (canAdjustColors)"** (`Document/HueSaturation.swift:453-462`): document open; an active layer;
`levels == nil`, `filterEdit == nil`, `textDraft == nil`, `!isProjectBusy`, `!isImporting`, `brushStroke == nil`,
`pixelMove == nil`, `renamingLayerID == nil`, no New Document or importer sheet; `selectedLayerIDs.count == 1`; not a
folder; `!isMaskSelected`; `layer.asset != nil` (adjustment layers have none); effectively visible; `selection?.isEmpty
!= true`. The Filter menu also requires `hueSaturation == nil`.

**"Vignette on an empty layer (canVignette)"** (`:445-452`): `canAdjustColors`, or an active layer with
`asset == nil`, `adjustment == nil`, not a folder, passing the same checks with the empty-asset test relaxed.

**"Opening a filter commits pending work"**: section 2.3 steps 3-4.

**"Filter panel"**: `filterPanel = FloatingPanelController(name: "filterPanel")` (`ContentView.swift:16`), shown when
`filterEdit` is set and not repeating, titled `kind.rawValue`, `onClose = { session.cancelFilter() }`
(`ContentView.swift:270-279`). The `NSPanel` is `[.titled, .closable]`, floating, `hidesOnDeactivate = true`
(`UI/FloatingPanel.swift:87-96`). Placement `.automatic`: if already visible it keeps its top-left while content
changes; else the remembered top-left for "filterPanel" (static, app-wide, shared by every filter); else centered on
the canvas view (`:60-69, 97-117`). Width 380 (Camera Raw: docked 440). Height fits the content and changes as rows
appear (Dither).

**"Slider control pattern"**: section 4.2.

**"Live preview"**: section 2.4.

**"Preview toggle"**: `Toggle("Preview", ...)` after the filter's controls, default on (`FilterEdit.preview = true`).
Off: `updateFilter(settings, preview: false)` drops the pending render and the prepared preview, so the layer shows its
own pixels; slider changes while off render nothing; on again renders the current settings. OK with Preview off still
applies the settings (non-automatic filters).

**"Preview resolution"**: section 2.5.

**"Preview error"**: `Text(error).foregroundStyle(.orange)` under the Preview toggle (`UI/FilterSheet.swift:167-169`).
Texts come from `error.localizedDescription`: e.g. "The canvas could not be rendered. Try a smaller canvas."
(`ExportError.render`), "This is not a valid Compositor project, or its metadata is damaged." (`ProjectError.invalid`,
an out-of-range adjustment), the Remove Background and Content-Aware Fill failures (sections 16.5 and the selection
spec).

**"Limited to the selection"**: `if session.adjustmentOriginal == nil && session.selection != nil { Text("Limited to the
selection").font(.callout).foregroundStyle(.secondary) }`. Every filter result passes through
`PixelAdjust.blend(result, over: original, through: selection, ...)` (`Document/Filters.swift:359-361`): coverage
rasterized on the image's own grid (exact fill, soft edges kept), `CIBlendWithMask` in unmanaged color
(`Document/PixelAdjust.swift:22-47`).

**"Cancel (Esc) / OK (Return)"**: `Button("Cancel") { session.cancelFilter() }.configuredNativeShortcut(.escape)`;
`Button("OK") { Task { await session.commitFilter() } }.configuredNativeShortcut(.return).buttonStyle(.borderedProminent)`.
The whole panel is `.disabled(edit?.committing == true)`. Undo step `kind.rawValue`.

**"Working… / Applying… indicator"** (`UI/FilterSheet.swift:177-188`):

```swift
                if edit?.committing == true || (edit?.preparing == true && edit?.kind.isAutomatic == true) {
                    ProgressView().controlSize(.small)
                    Text(edit?.committing == true ? "Applying…" : "Working…")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Button("OK") { Task { await session.commitFilter() } }
                    .configuredNativeShortcut(.return).buttonStyle(.borderedProminent)
                    .disabled(edit?.kind.isAutomatic == true && (edit?.preparing == true || edit?.previewError != nil))
```

Quick filters never show "Working…" (it would make the panel flicker at every slider step).

**"No-op OK closes like Cancel (no undo step)"**: section 2.6 step 3.

**"Settings remembered"**: section 2.2 and 2.6 step 4. Gradient Map restarts from the foreground/background colors on
every open. Camera Raw: Camera Raw spec.

**"Blurs spread past the layer"**: section 2.5 and 2.6 step 7.

**"Canvas-edge carry-on"**: section 2.5 (`canvasSides`); Bloom has none (quirk 22.7).

**"Layer mask carried onto a grown layer"**: section 2.6 step 9.

**"Empty layer start"**: section 2.3 step 5 and 7; Vignette then frames and fills the whole canvas (section 10).

**"Filter colors via the app color picker"**: section 2.9.

**"16-bit and HDR layers"**: table 2.1. Previews of an HDR layer are made from its HDR pixels at preview size
(`hdrPreviewSource`) and shown clipped and dithered to 8 bits (`Document/Filters.swift:368-384, 810-814`). The engine
does all of this; the board only ever receives 8-bit PNG previews.

**"Stale-result guard"**: section 2.6 step 8.

---

## 4. Panel layout grammar (verbatim)

### 4.1 Frame (`UI/FilterSheet.swift:19-204`)

```
VStack(alignment: .leading, spacing: 16)          padding 24, width 380, height fits content
  <filter controls>                               (sections 5-16)
  [ ] Preview                                     checkbox
  <preview error>                                 orange, wraps
  Limited to the selection                        callout, secondary (only with a selection)
  ─────────── Divider
  HStack: [Cancel]  <spacer>  [spinner + "Applying…"/"Working…"]  [OK]   (OK = prominent default button)
```

### 4.2 Slider row (`control(...)`, `UI/FilterSheet.swift:346-375`)

```swift
        let step = pow(10, Double(decimals))
        ...
        return HStack(spacing: 10) {
            Text(title).fixedSize()
                ...
                .frame(width: labelWidth, alignment: .leading)
                .onTapGesture(count: 2) { if track != nil { reset() } }
                .scrubbable(sensitivity: 1 / step, value: ..., range: range)
            if let track {
                CameraRawSlider(value: ..., range: range, track: track, help: "\(title). Double-click to reset.", ...)
            } else {
                Slider(value: Binding(get: { logarithmic ? log(settings[keyPath: key]) : settings[keyPath: key] },
                                      set: { value in update { $0[keyPath: key] = ((logarithmic ? exp(value) : value) * step).rounded() / step } }),
                       in: logarithmic ? log(range.lowerBound)...log(range.upperBound) : range)
            }
            TextField(title, value: ..., format: .number.precision(.fractionLength(0...decimals)))
                .frame(width: 56).textFieldStyle(.roundedBorder).multilineTextAlignment(.trailing)
                .unitSuffix(unit)
        }
```

- **Title**: one width for every slider title in the panel, `labelWidth = max(60, widest title)` (preference key,
  `:191, 423-426`). Hovering shows the left-right resize cursor; dragging scrubs `value = start + Δx · 10^−decimals`
  per point, clamped to the range, **linear even for logarithmic sliders and never rounded** (`UI/NumericScrub.swift:29-37`,
  `step` is nil here). Double-click resets to the `FilterSettings()` default **only** for colored-track sliders.
- **Slider**: continuous. Logarithmic: the track runs over `ln(lo)…ln(hi)`, the value is `exp(position)`; every slider
  value is rounded to `decimals`.
- **Field**: 56 pt, right-aligned, shows 0 to `decimals` fraction digits (`fractionLength(0...decimals)`: 5 shows "5",
  12.5 shows "12.5"), with the locale's grouping ("2,000"). A typed value is stored as typed (then clamped by
  normalization).
- **Unit suffix**: `HStack(spacing: 2) { field; Text(unit) }` (`UI/ToolHeaderStyle.swift:13-18`): "px", "%", "°" or
  nothing.
- **Colored track** (Black & White, Color Balance only): `CameraRawSlider` with the track colors of
  `UI/CameraRawSlider.swift:5-45`; help "<Title>. Double-click to reset."; double-click on title or knob resets.

### 4.3 Other controls

| Control | Upstream form | Notes |
|---|---|---|
| Checkbox | `Toggle("Label", isOn:)` | macOS checkbox |
| Segmented | `Picker(...).pickerStyle(.segmented).labelsHidden()` | Progressive Shape: preceded by `Text("Shape")`, `.fixedSize()`. Add Noise Distribution: `Text("Distribution")`, fills the row. Remove Background Quality: no visible label, fills the row |
| Pop-up menu | `Picker("Label", selection:)` default style | Dither Style (full width, dividers between groups), Colors (`.fixedSize()`), Pixel Shape (`.fixedSize()`) |
| Swatch | 24×24 rounded rect (radius 6, continuous), fill = color, inner 1.5 pt white border inset 1, outer 1 pt black border, plain button with help | `UI/FilterSheet.swift:129-143, 315-326` |
| Text | `Text(...)` wrapping (`fixedSize(horizontal: false, vertical: true)`) | secondary or callout as noted per filter |

---

## 5. Image-menu adjustments that reuse the panel

**"Image › Curves… (Cmd-M)"**, **"Image › Black & White…"**, **"Image › Color Balance…"**, **"Image › Exposure…"**,
**"Image › Gradient Map…"**, **"Image › Grain…"**: Image menu (`CompositorApp.swift:294-304`):

```
Curves…            ⌘M   beginFilter(.curves)       disabled: !canAdjustColors || hueSaturation != nil
Levels…            ⌘L   beginLevels()              (own panel, not this spec)
Hue/Saturation…    ⌘U   beginHueSaturation()       (own panel, disabled only by !canAdjustColors)
Black & White…          beginFilter(.blackWhite)   disabled: !canAdjustColors || hueSaturation != nil
Color Balance…          beginFilter(.colorBalance)
Exposure…               beginFilter(.exposure)
Gradient Map…           beginFilter(.gradientMap)
Grain…                  beginFilter(.grain)
Invert / Invert Mask ⌘I
──────────
Canvas Size… …
```

These open the same panel, with the same Preview / error / "Limited to the selection" / Cancel / OK, undo step named
`rawValue`. Panel bodies (`UI/FilterSheet.swift:22-67, 378-421`):

| Kind | Rows (label, range, unit, decimals, log, track, help) |
|---|---|
| Curves | `CurvesControls` (adjustments spec) |
| Exposure | Exposure −20…20, "", 2, linear · Offset −0.5…0.5, "", 4, linear · Gamma 0.01…9.99, "", 2, **log** |
| Gradient Map | 20 pt gradient bar (dark end → light end, radius 4, border black 35%); HStack(spacing 20) of two swatch + label pairs "Shadows" (help "Choose the shadows color") and "Highlights" (help "Choose the highlights color"); Toggle "Reverse" |
| Black & White | Reds, Yellows, Greens, Cyans, Blues, Magentas: −200…300, "%", 0, track luminance(0/60/120/180/240/300) · Toggle "Tint" (help "Color the result while keeping its tones, for a sepia or a cyanotype") · if Tint: Hue 0…360 "°" 0 track plain; Saturation 0…100 "%" 0 track saturation(tintHue) |
| Color Balance | headline "Shadows", then Cyan / Red, Magenta / Green, Yellow / Blue (−100…100, "", 0, opposing tracks); headline "Midtones" + same three; headline "Highlights" + same three; Toggle "Preserve Luminosity" (help "Put each pixel's brightness back afterwards, so only the color moves") |
| Grain | Amount 0…100 "" 0 · Size 0.5…20 "px" 1 **log** · Roughness 0…100 "" 0 |

Opposing track colors (`UI/FilterSheet.swift:339-344`, sRGB): Cyan / Red (0.10, 0.72, 0.80) → (0.86, 0.18, 0.20);
Magenta / Green (0.80, 0.22, 0.70) → (0.24, 0.70, 0.30); Yellow / Blue (0.95, 0.82, 0.18) → (0.22, 0.40, 0.92).

Specific rows of the checklist:

- **"Image › Levels…"**, **"Image › Hue/Saturation…"**: separate panels, not covered here.
- **"Image › Exposure…"**: OK at `ExposureSettings()` closes like Cancel.
- **"Image › Gradient Map…"**: every open starts from foreground → background (section 2.3 step 6).
- **"Image › Grain…"**: the grain is baked with the panel's `edit.seed` (`Document/Filters.swift:275`), fixed while
  the panel is open, new at every open; OK at amount 0 closes like Cancel.
- **"Image › Invert (Cmd-I)"** (done) and **"Image › Invert Mask"**: no panel. `canInvert` + `invertPixels()`
  (`Document/SelectionEdits.swift:95-154`): with the mask targeted the menu reads "Invert Mask", inverts the enabled
  mask inside the selection or wholly, expands a uniform 1×1 mask to the layer grid first when a selection exists, undo
  "Invert Mask". The engine's existing `selection.invertPixels` runs it when the board sends `isMaskSelected: true`;
  the board has no mask target yet (risk 23.6).
- **"Not repeatable"**: `repeatsAsLastFilter` is false for all six.

The same panel also edits **adjustment layers** of kind Curves, Exposure, Gradient Map, Grain, Black & White, Color
Balance, Gaussian Blur, Motion Blur and Add Noise (`Document/AdjustmentEditing.swift:42-57`); then "Limited to the
selection" is hidden and OK writes layer metadata. That flow belongs to the adjustments spec; the declarative control
lists of section 19 should be shared with it.

---

## 6. Gaussian Blur

Panel (`UI/FilterSheet.swift:88-91`):

| # | Control | Label | Range | Default | Unit | Decimals | Log | Help |
|---|---|---|---|---|---|---|---|---|
| 1 | slider | Radius | 0.1…250 | 5 | px | 1 | yes | (none) |
| 2 | checkbox | Preserve Transparency | — | off | — | — | — | Blur only the colors, keeping the layer's outline and transparency as they are |

- **"Radius"**: the Gaussian standard deviation in layer pixels; `source.applyingGaussianBlur(sigma: radius × scale)`
  on the unclamped image, so edges soften into the padding (`Document/Filters.swift:282-294`). Sides in `canvasSides`
  are carried on (`extending`).
- **"Preserve Transparency toggle"**: blur of the unextended image, then `unpremultiplyingAlpha().settingAlphaOne(in:)`
  and `CIBlendWithAlphaMask` with the original as mask: colors come from the layer's own pixels only (not darkened by
  clear neighbors), alpha is exactly the original's. `blurMargin` 0, OK runs on the original grid (layer size and
  transform unchanged, `CompositorTests/FilterTests.swift:50-84`), selection blending happens on that grid (`:86-115`).
  The panel may have grown the preview grid before the toggle was turned on; the padding stays clear.

---

## 7. Motion Blur

| # | Control | Label | Range | Default | Unit | Decimals | Log |
|---|---|---|---|---|---|---|---|
| 1 | slider | Angle | −90…90 | 0 | ° | 0 | no |
| 2 | slider | Distance | 1…2000 | 10 | px | 0 | yes |

- **"Angle"**: degrees counterclockwise from horizontal as on screen; `CIMotionBlur` angle = `angle·π/180` (Core
  Image's y axis points up, so the sense matches Photoshop's) (`:297-303`). 45° streaks up-right and down-left
  (`CompositorTests/FilterTests.swift:195-219`).
- **"Distance"**: streak length in layer pixels; Core Image radius = `distance × scale / √12`
  (`motionRadiusPerPixel`, `:235-238`), so a Gaussian-tapered streak has the spread of an even one. Margin
  `distance/2 + 2`; canvas sides carried on.

---

## 8. Progressive Blur

### 8.1 Panel (`UI/FilterSheet.swift:92-109`)

| # | Control | Label | Values | Default | Help |
|---|---|---|---|---|---|
| 1 | text, secondary | Click and drag two points on canvas | — | — | — |
| 2 | "Shape" + segmented (fixed size) | Linear / Radial | `progressiveRadial` false/true | Linear | Linear blurs along the line; Radial keeps the start sharp and blurs outwards |
| 3 | slider | From | 0…250 px, 1 decimal, linear | 0 | The blur where the line starts |
| 4 | slider | To | 0…250 px, 1 decimal, linear | 20 | The blur where the line ends, and past it |
| 5 | checkbox | Invert | — | off | Swap From and To: blur the start and sharpen toward the end |

### 8.2 Rendering (`Document/Filters.swift:386-415`)

1. The line's ends are document points; they are mapped into the job image's pixels with `job.mapping⁻¹` and flipped to
   Core Image's y-up. A nil end defaults to the image's top-center / bottom-center. If the ends are less than 1 px
   apart, `end = start` moved 1 px down in the image.
2. `from`, `to` (swapped when Invert); `strongest = max(from, to)`; `strongest == 0` returns the image unchanged.
3. Mask: gray `radius / strongest` at each end; Linear = `CILinearGradient(point0: start, point1: end)`, Radial =
   `CIRadialGradient(center: start, radius0: 0, radius1: |end − start|)`.
4. `CIMaskedVariableBlur(inputMask: mask, inputRadius: strongest × scale)` over the image extended past `canvasSides`.
5. Margin `3·max(From, To) + 2`.

Checks (`CompositorTests/ProgressiveBlurTests.swift`): Linear is sharp before the start, softer halfway, blurred past
the end; From 1.5 / To 6 blurs both ends, more at To's; Radial is sharp at the center and blurred past the circle;
Radial + Invert is the reverse; the filter keeps a 16-bit layer 16-bit.

### 8.3 Default line (checklist **"Default line"**, `Document/Filters.swift:712-720`)

```swift
            if kind == .progressiveBlur, !repeating {
                let shown = CGRect(origin: layer.transform.origin, size: layer.transform.size)
                    .intersection(CGRect(origin: .zero, size: document.size))
                let area = shown.isNull || shown.isEmpty ? CGRect(origin: .zero, size: document.size) : shown
                settings.progressiveStart = CGPoint(x: area.midX, y: area.minY + area.height * 0.35)
                settings.progressiveEnd = CGPoint(x: area.midX, y: area.maxY)
            }
```

Vertical, from 35% down the layer's visible part (its unrotated rect clipped to the canvas, or the canvas when nothing
shows) to its foot. Last Filter keeps the previous line (document coordinates, even on another layer).

### 8.4 Canvas drag (checklist **"Canvas drag"** and **"Shift constrains…"**)

`Rendering/EditorCanvas.swift:1777-1780, 1875-1882, 2088-2093, 2488-2519`:

- Any primary press on the canvas while Progressive Blur is open, unless Space is held (whatever the tool), goes to
  `beginProgressiveDrag`. It runs after the Camera Raw samplers and before every tool.
- Hit test in **view points**: within 10 pt of the **end** handle → drag the end; else within 10 pt of the start →
  drag the start; else a new line: `moveProgressiveBlur(start: p, end: p)` (sharp at the press) and drag its end.
- Each drag event: the pointer's document point (not rounded, not clamped to the canvas); with ⇧ held,
  `snapped(point, around: otherEnd)`:

```swift
    private static func snapped(_ point: CGPoint, around anchor: CGPoint) -> CGPoint {
        let dx = point.x - anchor.x, dy = point.y - anchor.y
        let length = hypot(dx, dy)
        let angle = (atan2(dy, dx) / (.pi / 4)).rounded() * (.pi / 4)
        return CGPoint(x: anchor.x + cos(angle) * length, y: anchor.y + sin(angle) * length)
    }
```

  then `moveProgressiveBlur` → `updateFilter(settings, preview: edit.preview)` (coalesced renders, section 2.4).
- Release: the drag ends and the filter panel gets the keyboard back (Return / Escape).
- Refused while committing (`moveProgressiveBlur` guard, `Document/Filters.swift:762-768`).

### 8.5 Overlay (checklist **"Overlay"**, `Rendering/TransformOverlay.swift:90-96, 190, 406-448`)

Drawn instead of crop, gradient and transform handles, whenever the Progressive Blur panel is open (Preview on or off),
in view points:

1. Radial only: the circle centered on the start through the end, dashed `[4, 4]` phase 0: first 2 pt black at 50%,
   then 1 pt white at 80%.
2. The line start → end: 3 pt black at 70%, then 1 pt white.
3. Start ("sharp") handle: 12 pt circle, filled white, 1 pt black stroke.
4. End ("blurred") handle: 12 pt circle filled gray 0.6 at 90%, 2 pt white ring inset 1, 1 pt black stroke.

The handles do not swap with Invert (quirk 22.5).

---

## 9. Add Noise

| # | Control | Label | Range | Default | Unit | Decimals | Log |
|---|---|---|---|---|---|---|---|
| 1 | slider | Amount | 0.1…400 | 10 | % | 1 | yes |
| 2 | "Distribution" + segmented (fills row) | Uniform / Gaussian | `gaussian` false/true | Uniform | | | |
| 3 | checkbox | Monochromatic | | off | | | |

No help strings. Rendering: `noise_add_at` (C, `Rendering/NoisePixels.c:20-49`), on full-size pixels (no padding):

- `spread = amount / 100 × 127.5`. Uniform: `n = (u·2 − 1)·spread`; Gaussian (Box-Muller): `n = √(−2 ln(1 − u1))·cos(2π u2)·spread·2/3`.
- Per pixel `base = hash(seed ^ hash(x·0x9e3779b9 ^ hash(y·0x85ebca6b)))`; per channel key `base + c·0x9e3779b9`,
  Monochromatic uses `base` for all three (same offset on R, G, B).
- Applied to the unpremultiplied value, clamped 0…255, re-premultiplied; alpha unchanged; clear pixels skipped.
- **"Stable grain while the panel is open"**: `seed` is `FilterEdit.seed` (random per panel, `:457-458`); the
  noise origin is 0, so the pattern is tied to the layer's pixel grid. OK uses the same seed as the preview.

Check (`CompositorTests/FilterTests.swift:221-246`): same seed → same pixels; on mid gray at amount 10 every opaque
channel stays in 112…144; alpha untouched; color noise differs per channel; Monochromatic keeps R = G = B.

---

## 10. Vignette

| # | Control | Label | Range | Default | Unit | Decimals | Help |
|---|---|---|---|---|---|---|---|
| 1 | "Color" (95 pt wide label) + swatch | | sRGB | black | | | Choose the vignette color |
| 2 | slider | Amount | 0…100 | 35 | % | 0 | Blend the chosen color into the edges while keeping the center unchanged |
| 3 | slider | Midpoint | 0…100 | 50 | % | 0 | |
| 4 | slider | Roundness | −100…100 | 100 | (none) | 0 | |
| 5 | slider | Feather | 0…100 | 60 | % | 0 | |
| 6 | slider | Highlights | 0…100 | 25 | % | 0 | Protect bright areas near the edge |

All linear. Rendering: `adjust_colored_vignette` (`Rendering/AdjustPixels.c:829-871`, mask `:764-778`):

- Frame = the job image (the layer's own pixels) or, for a layer that started empty, the canvas mapped into the image's
  pixels (`Document/Filters.swift:314-326`).
- `nx, ny ∈ [−1, 1]` across the frame; `dist = circle + (square − circle)·(1 − roundness/100)/2` with
  `square = max(|nx|, |ny|)`, `circle = hypot(nx, ny)/√2`; `t = clamp((dist − 0.85·midpoint/100) / max(0.05,
  feather/100))`; `mask = t²(3 − 2t)`.
- `bright = clamp((Rec.709 luma − 0.45) / 0.55)`; `effect = amount/100 × mask × (1 − highlights/100 × bright)`;
  color `c + (vignetteColor − c)·effect` on straight sRGB; alpha kept.
- **"Framing"**: a layer with pixels recolors only its non-clear pixels; a layer that started empty paints clear
  pixels too (`out alpha = a + effect·(1 − a)`), framing and filling the whole canvas.
- **"Color swatch"**: section 2.9.

Checks (`CompositorTests/FinishingFilterTests.swift:23-52`): on 0.8 gray at amount 80 the center stays 204 (±2), the
corner is ≥ 50 darker, alpha 255 everywhere; a red vignette at amount 100, highlights 0 over 0.5 gray reddens the corner
(R − G > 80) and leaves the center gray 128 (±2).

---

## 11. Bloom / Glow

| # | Control | Label | Range | Default | Unit | Decimals | Log |
|---|---|---|---|---|---|---|---|
| 1 | slider | Amount | 0…100 | 40 | % | 0 | no |
| 2 | slider | Radius | 1…150 | 24 | px | 0 | yes |

- **"Amount"**: `CIBloom` intensity `bloomAmount / 50` (40 → 0.8). 0 closes like Cancel.
- **"Radius"**: `CIBloom` radius `bloomRadius × scale` on the unclamped image (`:327-332`); margin `3·radius + 2` on
  every side (no canvas carry-on), trimmed on OK. A bright patch on a clear layer glows into the clear area
  (`CompositorTests/FinishingFilterTests.swift:54-77`).

---

## 12. Dither

### 12.1 Panel (`UI/FilterSheet.swift:206-273`), in order, with visibility

| # | Control | Label | Range / options | Default | Unit | Visible when | Help |
|---|---|---|---|---|---|---|---|
| 1 | pop-up (full width) | Style | groups: Atkinson (Classic Mac), Floyd–Steinberg ‖ Bayer 2 × 2, Bayer 4 × 4, Bayer 8 × 8 ‖ Halftone Dots, Halftone Lines, Halftone Diamonds ‖ Mac Patterns, ASCII | Atkinson (Classic Mac) | | always | |
| 2 | slider | Pixel Size | 1…32, 0 dec | 2 | px | style ≠ ASCII | Make each dithered pixel this many pixels across, for a chunky old-screen look |
| 3 | slider | Text Size | 6…64, 0 dec | 14 | px | ASCII | The height of each line of characters |
| 4 | slider | Cell Size | 4…64, 0 dec | 8 | px | halftone | |
| 5 | slider | Angle | −90…90, 0 dec | 45 | ° | halftone | |
| 6 | "Characters" + text field (rounded border, monospaced) | Characters | any text | ` .:-=+*#%@` | | ASCII | The characters to draw with, in any order: each spot gets the one whose ink best matches its tone |
| 7 | slider | Tones | 2…8, 0 dec | 2 | (none) | diffusion or Bayer | Tones per channel: 2 is pure black and white |
| 8 | slider | Diffusion | 0…100, 0 dec | 100 | % | Atkinson, Floyd–Steinberg | How much of each pixel's error spreads to its neighbors. Less gives flatter areas |
| 9 | slider | Density | −100…100, 0 dec | 0 | (none) | always | More ink (darker) or less before dithering |
| 10 | slider | Contrast | −100…100, 0 dec | 0 | (none) | always | |
| 11 | pop-up (fixed size) | Colors | Black & White, Two Colors, Original | Black & White | | always | |
| 12 | "Dark" swatch, "Light" (10 pt leading) swatch | | sRGB | black / white | | Colors = Two Colors | Choose the dark color / Choose the light color |
| 13 | pop-up (fixed size) | Pixel Shape | Square, Dot | Square | | Pixel Size > 1 and style ≠ ASCII | Draw each chunky pixel as a solid square, or as a round dot like a dot-matrix screen |
| 14 | checkbox | Light on Dark | | on | | halftone, Mac Patterns, ASCII | Draw the marks for the light tones on the dark color, like a glowing screen |

All sliders linear. Style predicates (`Document/Dither.swift:17-32`): diffusion = group 0; `hasTones` = groups 0-1;
halftone = group 2; `drawsMarks = !hasTones`; `usesPixelSize = style != .ascii`. The pop-up separates groups with
dividers.

### 12.2 Rendering (`Document/Dither.swift:96-183`, `Rendering/DitherPixels.c:128-292`)

1. `block = usesPixelSize ? pixelSize : 1`. Block > 1: draw the image into a `ceil(w/block) × ceil(h/block)` context
   with high interpolation (averaging), dither that, draw it back at `block×` without smoothing; Pixel Shape Dot then
   runs `dither_dots` (radius `0.42·block`, antialiased edge, gap color = dark color for Two Colors else black).
2. Per pixel (unpremultiplied): tone = `adjust_tone(Rec.709 luma)` (Original: per channel), with
   `gamma = 2^(1.5·density/100)`, `v' = clamp((v^gamma − 0.5)·k + 0.5)`, `k = 1/(1 − 0.95·c)` for `c = contrast/100 ≥ 0`,
   else `1 + c`.
3. Diffusion (Atkinson taps (1,0) (2,0) (−1,1) (0,1) (1,1) (0,2) each 1/8; Floyd–Steinberg 7/16, 3/16, 5/16, 1/16),
   serpentine rows, error × diffusion/100, quantized to `levels` tones; clear pixels skipped.
4. Bayer: `floor(v·(levels − 1) + threshold)` with thresholds `(m + 0.5)/n²` from the 2×2 `{0,2,3,1}`, 4×4
   `{0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5}` or the 8×8 table (`:62-80`).
5. Marks: halftone cell = `cellSize` pixels rotated by `angle`; spot functions Dots `π(u² + v²)`, Lines `2|v|`,
   Diamonds `|u| + |v|`; a pixel is ink when the tone (light on dark) or `1 − tone` exceeds the spot. Mac Patterns: 17
   8×8 patterns, index `round(coverage·16)`. ASCII: bold monospaced system font at `textSize/1.2` pt in cells
   `textSize` tall and one "M" wide, distinct characters sorted by ink; each cell gets the character whose ink is
   closest to the cell's average tone × the inkiest character's coverage.
6. Colors: Black & White = black/white; Two Colors = dark/light; Original = the image's own colors (marks in the pixel's
   color on black (light on dark) or white).
7. Alpha kept; clear pixels untouched. Commit rasterizes 16-bit layers to 8-bit by design.

---

## 13. Scanlines

### 13.1 Panel (`UI/FilterSheet.swift:275-313`)

| # | Label | Range | Default | Unit | Help |
|---|---|---|---|---|---|
| 1 | Line Spacing | 2…32 | 4 | px | How far apart the screen's lines are |
| 2 | Thickness | 5…100 | 70 | % | How much of the gap a bright line fills; dimmer parts draw it thinner |
| 3 | Glow | 0…100 | 0 | % | Light blooming around the lines, like a CRT's phosphors |
| 4 | Dots | 0…100 | 0 | % | Break the lines into beads where the picture is darker than this, blending into solid lines where it's brighter |
| 5 | Displace | −100…100 | 0 | px | Lift the lines where the picture is bright, or lower them when negative, so they swell into its shapes |
| 6 | Smoothness | 0…100 | 50 | % | How far the brightness is smoothed before it displaces the lines, from sharp ridges to rounded hills |
| 7 | Threshold | 0…100 | 0 | % | Draw no line where the picture is darker than this, leaving the screen dark |
| 8 | Wobble | 0…64 | 0 | px | Make the lines waver sideways down the screen, like a CRT losing sync |
| 9 | Color Split | 0…16 | 0 | px | Move the red and blue apart, for colored fringes on the lines |
| 10 | Density | −100…100 | 0 | (none) | Darker or lighter before the lines are drawn |
| 11 | Contrast | −100…100 | 0 | (none) | |
| 12 | Black Level | 0…100 | 0 | % | How bright the lines are where the picture is black, so they show even over black |
| 13 | Colors (pop-up, fixed size) | Black & White, Two Colors, Original | Black & White | | |
| 14 | "Dark" swatch, "Light" swatch (Two Colors only) | | black / white | | Choose the screen's color / Choose the lines' color |

All sliders linear, 0 decimals. The swatches use the Dither picker targets (titles "Color Picker (Dark Color)" /
"(Light Color)").

### 13.2 Rendering (`Document/Scanlines.swift:58-97`, `Rendering/DitherPixels.c:345-546`)

- `lines = ceil(height / spacing)`; each line's tone along x is the average of the rows it covers, read from
  `x − round(wobble·(0.7 sin(0.45·line) + 0.3 sin(1.7·line + 1.3)))`.
- Displace: brightness blurred along the line (three box passes, radius `round(smoothness·spacing·2)`) and across
  lines (`round(smoothness·2)` passes of 1-2-1); a line's center is `line·spacing + spacing/2 − displace·lift`;
  nearer lines (bottom first when rising) hide those behind.
- Line half-height `beam = spacing/2 · thickness · (0.29 + 0.71·√level)`, `level = blackLevel + (1 − blackLevel)·t`;
  Dots beads below the Dots level; Threshold fades the line out over 0.04 below its level.
- Color = dark → light by level (Original: the picture's colors), driven ×1.35, over the dark screen; Color Split moves
  red right and blue left by `round(split)` px; Glow blurs the result (sigma `3·spacing + 3`, at 1/`floor(sigma/4)`
  scale) and adds it with `dither_glow` (`amount = glow/100 × 2.5`, easing off toward full brightness).
- Alpha kept; clear pixels untouched.

---

## 14. Tonal Contrast

| # | Label | Range | Default | Unit | Decimals | Log |
|---|---|---|---|---|---|---|
| 1 | Amount | 0…100 | 50 | % | 0 | no |
| 2 | Shadows | −100…100 | 40 | % | 0 | no |
| 3 | Midtones | −100…100 | 60 | % | 0 | no |
| 4 | Highlights | −100…100 | 30 | % | 0 | no |
| 5 | Radius | 1…100 | 16 | px | 0 | **yes** |

No help strings. Rendering (`Document/Filters.swift:333-347`, `Rendering/AdjustPixels.c:1012-1048`): base =
Gaussian blur sigma `radius × scale`; per pixel `w_s = 1 − smooth(0.15, 0.5, baseLum)`, `w_h = smooth(0.5, 0.85,
baseLum)`, `w_m = 1 − w_s − w_h`, `weight = (shadows·w_s + midtones·w_m + highlights·w_h)/100`,
`delta = 0.18·tanh(6·(lum − baseLum))·weight·(amount/50)·4·lum·(1 − lum)` added to R, G, B; alpha kept. Amount 0 or all
three tones 0 closes like Cancel. Check: midtones 100 on 0.4/0.6 stripes darkens the dark and lightens the light
stripe (`CompositorTests/FinishingFilterTests.swift:79-99`).

---

## 15. Lens Correction

| # | Control | Label | Range | Default | Decimals |
|---|---|---|---|---|---|
| 1 | slider | Remove Distortion | −100…100 | 0 | 0 |
| 2 | text, callout, secondary | Positive straightens lines that bow outward (barrel); negative, lines that bow inward (pincushion). | | | |

Rendering (`Rendering/LensPixels.c`): `k = distortion/100 × 0.35`; for each output pixel center, offset `(dx, dy)` from
the image center, `scale = 1 − k·(dx² + dy²)/(cx² + cy²)`, sample the source bilinearly at `center + (dx, dy)·scale`;
samples outside the image contribute nothing (pincushion correction opens transparent corners). Same size, no growth;
relative to the image, so previews at reduced size bend identically. 0 closes like Cancel.

---

## 16. Remove Background

### 16.1 Panel (`UI/FilterSheet.swift:68-84`)

| # | Control | Label | Range | Default | Unit | Visible | Help |
|---|---|---|---|---|---|---|---|
| 1 | text | Hide the background behind a layer mask, keeping the foreground subjects. The pixels stay, so the background can be painted back at any time. | | | | always | |
| 2 | segmented, label hidden, full width | Basic / Advanced | | Basic | | always | Basic is quick; Advanced refines the mask against the layer's own detail, for hair and fur |
| 3 | slider | Refine | 0…40 | 12 | px | Advanced | Pull the mask onto the image's own edges, which recovers hair and fur |
| 4 | slider | Contrast | 0…100 | 25 | % | Advanced | Clear the haze that leaves background showing through thin areas |
| 5 | slider | Shift Edge | −10…10 | 0 | px | Advanced | Shrink the mask to drop the rim of background color around the subject, or grow it |

All linear, 0 decimals. Automatic: "Working…" while a preview renders; OK disabled until a preview exists without
error.

### 16.2 Mask (`Document/SubjectRemoval.swift:29-83`)

`VNGenerateForegroundInstanceMaskRequest` on the image, all instances, scaled to the image, cached by CGImage identity
while the panel is open (so a slider move only redoes the refining). Basic returns it as is. Advanced: Refine > 0 →
`GuidedMatte.refine(mask, guide: image, radius: refine, limit:)`; Shift Edge ≠ 0 → blur sigma `|shift|/2` then a hard
step at 0.75 (contract) or 0.25 (expand); Contrast > 0 → slope `1/max(0.02, 1 − 0.98·contrast/100)` about 0.5.

### 16.3 Preview (`:100-110`)

The layer with its background made transparent (`CIBlendWithMask` over clear), full size, the refine step limited to
1400 px for responsiveness.

### 16.4 Commit as layer mask (`Document/Filters.swift:897-899, 998-1033`)

Recomputed from the full-size original (no size limit). An existing mask in the layer's own grid and size is combined
by multiply (either one hides). With a selection only the selected part changes: blended over the existing mask, or
over opaque white when there was none. Undo "Remove Background"; the mask is enabled and **selected**
(`isMaskSelected = true`); pixels are untouched. Stale guard as other filters.

### 16.5 Error

**"No-subject error"**: "No foreground subject was detected in this layer. Try an image with a more distinct subject."
(`Document/SubjectRemoval.swift:6-9`), shown orange in the panel; OK stays disabled.

---

## 17. JSON ↔ FilterSettings mapping

`FilterSettings` (`Document/Filters.swift:63-126`) is not Codable, nor are `DitherSettings` and `ScanlinesSettings`.
The engine maps them by hand. JSON keys are the Swift property names. All numbers are JSON numbers, flags are JSON
booleans, colors are `{ "red": r, "green": g, "blue": b }` in 0…1 (the `AdjustmentColor` Codable shape, also used by
the manifest's adjustment layers), points are `[x, y]` in document coordinates (the `CGPoint` Codable shape), enums
are the Swift **case names** (ASCII; the raw values contain "–" and "×").

### 17.1 Top level

| JSON key | Type | Range after `normalized` | Default | Normalization | Filter |
|---|---|---|---|---|---|
| `radius` | number | 0.1…250 | 5 | clamp, non-finite → default | Gaussian |
| `preserveTransparency` | bool | | false | | Gaussian |
| `angle` | number | −90…90 | 0 | clamp | Motion |
| `distance` | number | 1…2000 | 10 | clamp | Motion |
| `progressiveFrom` | number | 0…250 | 0 | clamp | Progressive |
| `progressiveTo` | number | 0…250 | 20 | clamp | Progressive |
| `progressiveStart` | `[x, y]` or null | any | null | none | Progressive |
| `progressiveEnd` | `[x, y]` or null | any | null | none | Progressive |
| `progressiveRadial` | bool | | false | | Progressive |
| `progressiveInverted` | bool | | false | | Progressive |
| `amount` | number | 0.1…400 | 10 | clamp | Add Noise |
| `gaussian` | bool | | false | | Add Noise |
| `monochromatic` | bool | | false | | Add Noise |
| `vignetteAmount` | number | 0…100 | 35 | clamp | Vignette |
| `vignetteColor` | color | each 0…1 | black | `clamped` (non-finite → 0) | Vignette |
| `vignetteMidpoint` | number | 0…100 | 50 | clamp | Vignette |
| `vignetteRoundness` | number | −100…100 | 100 | clamp | Vignette |
| `vignetteFeather` | number | 0…100 | 60 | clamp | Vignette |
| `vignetteHighlights` | number | 0…100 | 25 | clamp | Vignette |
| `bloomAmount` | number | 0…100 | 40 | clamp | Bloom |
| `bloomRadius` | number | 1…150 | 24 | clamp | Bloom |
| `tonalAmount` | number | 0…100 | 50 | clamp | Tonal Contrast |
| `tonalRadius` | number | 1…100 | 16 | clamp | Tonal Contrast |
| `tonalShadows` | number | −100…100 | 40 | clamp | Tonal Contrast |
| `tonalMidtones` | number | −100…100 | 60 | clamp | Tonal Contrast |
| `tonalHighlights` | number | −100…100 | 30 | clamp | Tonal Contrast |
| `distortion` | number | −100…100 | 0 | clamp | Lens Correction |
| `backgroundQuality` | `"basic"` \| `"advanced"` | | `"basic"` | | Remove Background |
| `refineEdges` | number | 0…40 | 12 | clamp | Remove Background |
| `matteContrast` | number | 0…100 | 25 | clamp | Remove Background |
| `shiftEdge` | number | −10…10 | 0 | clamp | Remove Background |
| `dither` | object | 17.2 | | `DitherSettings.normalized` | Dither |
| `scanlines` | object | 17.3 | | `ScanlinesSettings.normalized` | Scanlines |
| `curves` | `CurvesSettings` Codable | | identity curves | **not normalized**; `isValid` at apply | Curves |
| `exposure` | `ExposureSettings` Codable `{exposure, offset, gamma}` | −20…20, −0.5…0.5, 0.01…9.99 | 0, 0, 1 | clamp | Exposure |
| `gradientMap` | `GradientMapSettings` Codable `{shadows, highlights, reversed}` | colors 0…1 | black, white, false | colors clamped | Gradient Map |
| `grain` | `GrainSettings` Codable `{amount, size, roughness, seed}` | 0…100, 0.5…20, 0…100 | 25, 1.5, 50, 0 | clamp | Grain |
| `blackWhite` | `BlackWhiteSettings` Codable | −200…300 each; tintHue 0…360; tintSaturation 0…100 | 40, 60, 40, 60, 20, 80, false, 40, 20 | **not normalized** | Black & White |
| `colorBalance` | `ColorBalanceSettings` Codable | −100…100 each | 0 …, preserveLuminosity true | **not normalized** | Color Balance |
| `cameraRaw` | Camera Raw spec | | | | Camera Raw |

Integer-looking controls are **not** rounded by normalization (e.g. `angle` 12.5 is legal); only the panel's slider
rounds.

### 17.2 `dither` (`Document/Dither.swift:48-94`)

| JSON key | Type | Range | Default | Normalization |
|---|---|---|---|---|
| `style` | enum | `atkinson`, `floydSteinberg`, `bayer2`, `bayer4`, `bayer8`, `dots`, `lines`, `diamonds`, `patterns`, `ascii` | `atkinson` | |
| `pixelSize` | number | 1…32 | 2 | clamp, **rounded** |
| `pixelShape` | enum | `square`, `dot` | `square` | |
| `cellSize` | number | 4…64 | 8 | clamp, **rounded** |
| `textSize` | number | 6…64 | 14 | clamp, **rounded** |
| `angle` | number | −90…90 | 45 | clamp |
| `levels` (panel "Tones") | number | 2…8 | 2 | clamp, **rounded** |
| `diffusion` | number | 0…100 | 100 | clamp |
| `density` | number | −100…100 | 0 | clamp |
| `contrast` | number | −100…100 | 0 | clamp |
| `colors` | enum | `blackWhite`, `twoColors`, `original` | `blackWhite` | |
| `dark` | color | | black | clamped |
| `light` | color | | white | clamped |
| `lightOnDark` | bool | | true | |
| `characters` | string | | `" .:-=+*#%@"` | newlines removed, first 64 Characters (grapheme clusters); empty draws with the default set |

Display labels: `atkinson` "Atkinson (Classic Mac)", `floydSteinberg` "Floyd–Steinberg", `bayer2` "Bayer 2 × 2",
`bayer4` "Bayer 4 × 4", `bayer8` "Bayer 8 × 8", `dots` "Halftone Dots", `lines` "Halftone Lines", `diamonds` "Halftone
Diamonds", `patterns` "Mac Patterns", `ascii` "ASCII"; `square` "Square", `dot` "Dot"; `blackWhite` "Black & White",
`twoColors` "Two Colors", `original` "Original". `backgroundQuality`: `basic` "Basic", `advanced` "Advanced".

### 17.3 `scanlines` (`Document/Scanlines.swift:6-56`)

| JSON key (panel label) | Range | Default | Normalization |
|---|---|---|---|
| `lineSpacing` (Line Spacing) | 2…32 | 4 | clamp, **rounded** |
| `thickness` | 5…100 | 70 | clamp |
| `glow` | 0…100 | 0 | clamp |
| `dots` | 0…100 | 0 | clamp |
| `wobble` | 0…64 | 0 | clamp |
| `displace` | −100…100 | 0 | clamp |
| `smoothness` | 0…100 | 50 | clamp |
| `threshold` | 0…100 | 0 | clamp |
| `split` (Color Split) | 0…16 | 0 | clamp, **rounded** |
| `density` | −100…100 | 0 | clamp |
| `contrast` | −100…100 | 0 | clamp |
| `blackLevel` (Black Level) | 0…100 | 0 | clamp |
| `colors` | `blackWhite`, `twoColors`, `original` | `blackWhite` | |
| `dark`, `light` | color | black, white | clamped |

### 17.4 Decoding and encoding rules (engine)

1. **Base.** `filter.begin`: `FilterSettings()`. `filter.update` / `filter.commit`: the open edit's `edit.settings`.
2. **Overlay.** Every present key replaces the base value; absent keys keep it (partial updates are allowed).
   `progressiveStart: null` clears the point. Unknown keys are ignored. A wrong type is an error
   `"settings.<key> must be a number"` (`… a boolean`, `… one of <case names>`). Distinguish JSON booleans from numbers
   (`CFGetTypeID(value) == CFBooleanGetTypeID()`), since `JSONSerialization` returns both as `NSNumber`.
3. **Codable sub-objects** (`curves`, `exposure`, `gradientMap`, `grain`, `blackWhite`, `colorBalance`): synthesized
   Codable needs every key, so encode the base sub-struct to a dictionary, merge the given keys, decode.
4. **No normalization by hand.** Hand the result to `updateFilter` (which normalizes and grows) or put it in
   `session.filterSettings` before `beginFilter` (the `FilterEdit` initializer normalizes). Never assign
   `edit.settings` directly: growth would be skipped.
5. **Encoding back.** Every answer that carries settings returns the complete normalized object with every key, so the
   board can show clamped values and remember them.

Engine helper shape (sketch):

```swift
func filterSettings(_ json: Any?, base: FilterSettings) throws -> FilterSettings      // overlay, rules 2-3
func filterSettingsJSON(_ s: FilterSettings) -> [String: Any]                         // rule 5
```

---

## 18. Engine API to add

### 18.1 Why the existing operations are not enough

`engine/Sources/FilterOps.swift` builds a new `EditorSession` per request: `filter.preview` begins the filter with
`FilterSettings()` and cancels it; `filter.apply` begins it again and commits. Consequences:

- No settings can be passed (every filter would run at its defaults).
- `FilterEdit.seed` is `UInt32.random` per edit: Add Noise, Grain and **Content-Aware Fill** commit with a different
  seed than the one previewed. Content-Aware Fill on the board is affected today (`ContentFill.run` passes `job.seed`
  to `patch_fill`, `Document/ContentFill.swift:21-22`).
- Remove Background's Vision cache is keyed by CGImage identity, so every request re-runs Vision.
- Each request re-prepares the preview copy (downscale, growth, HDR copy) and, for Remove Background, the mask.

### 18.2 Persistent filter edits

`EngineOperations` keeps `openFilters: [String: OpenFilter]`, `OpenFilter { session, url, edit, stamp: DiskStamp?,
before: CanvasDocument? }`, at most one per project path (a new `filter.begin` on the same project cancels the old
one). An engine restart (idle stop after 5 minutes, `core/engine-client.js:12`, or a crash) loses them; requests for an
unknown id fail with `"This filter is no longer open."` and the board re-begins with its current settings.

Requests run one at a time (`EngineMain.swift` awaits each line), so the engine never sees two renders of one edit at
once; each handler waits for the render chain to drain (`while let task = edit.previewTask { await task.value }`).

### 18.3 Operations

| Op | Args (besides `project`, added by the host) | Does | Returns |
|---|---|---|---|
| `filter.begin` | `kind` (rawValue), `settings` (17), `activeLayerID`, `selection`, `isMaskSelected`, `foreground`, `background`, `out` (png) | `session(args)`; `configure`; `session.filterSettings = decode(settings, base: FilterSettings())`; `session.beginFilter(kind)`; on nil edit return `error` (`brushError` or "\<kind\> can't be applied to this layer."); wait for renders; store | `edit` (id), `settings` (normalized, incl. the default Progressive line and Gradient Map ends), `layerID`, `layerTransform`, `automatic`, plus the preview fields below |
| `filter.update` | `edit`, `settings` (partial ok), `preview` (bool), `out` (png, only when `preview`) | `session.updateFilter(decode(settings, base: edit.settings), preview:)`; wait for renders | preview fields; `settings` |
| `filter.commit` | `edit`, `settings` (optional, final) | if the final settings differ: `updateFilter(final, preview: edit.preview \|\| automatic)` and wait; stale check (18.5); `await session.commitFilter()`; if `session.filterEdit === edit` afterwards (automatic filter without a usable preview) keep it open; else drop it and save like `withSession` | `outcome(...)` fields (`saved`, `editName`, `selection`, `isMaskSelected`, `error`) plus `open` (true when still open), `noop` (closed without change), `lastFilter`, `filterSettings` (`session.filterSettings`, JSON) |
| `filter.cancel` | `edit` | `session.cancelFilter()`; drop | `{}` |
| `filter.repeat` | `kind`, `settings`, usual session args | `withSession`: `session.filterSettings = decode(settings)`, `session.lastFilter = kind`, `await session.repeatLastFilter()`; if nothing changed and `brushError` is nil, `error` = "Last Filter can't be applied to this layer." only when `canRepeatLastFilter` was false | `outcome` + `lastFilter`, `filterSettings` |

Preview fields (`filter.begin` and `filter.update`), written only when `edit.preview || automatic` and
`edit.preparedPreview != nil`:

| Field | Value |
|---|---|
| `out` file | PNG of `edit.preparedPreview` (8-bit sRGB premultiplied; HDR already clipped and dithered) |
| `size` | `[w, h]` of the PNG (≤2048 on the long side unless a full-size kind; may be 2047, section 21.5) |
| `transform` | `edit.preparedTransform ?? edit.transform`, LayerTransform JSON: where the PNG goes in the document |
| `previewScale` | `edit.previewScale` (PNG pixels per layer pixel, informational) |
| `grown` | `edit.preparedTransform != nil` |
| `error` | `edit.previewError` (orange panel text) |
| `alert` | `session.brushError` (e.g. growth past the size limit: `ProjectError.tooLarge`, "This project exceeds the supported canvas, layer, file-size, or N-megapixel document limit.") |

The board places the PNG with `Transform.pixelToDocument(transform, w, h)` (`media/geometry.js:104-115`), which is the
same as upstream's `previewMapping`; no separate scale handling is needed. Without a preview (`preview: false`), the
answer has no `out` and the board shows the layer's own pixels.

### 18.4 Settings before `beginFilter` versus through `updateFilter`

- Put the board's remembered settings into `session.filterSettings` **before** `beginFilter`, so the initial growth
  margin, the first render and Last Filter use them; `beginFilter` then overrides only the Progressive line
  (non-repeating) and the Gradient Map ends, as upstream.
- Every later change goes through `updateFilter`, which normalizes, grows the grid when a blur's reach increases, and
  coalesces renders.
- For an automatic filter, `filter.commit` must leave a fresh preview in place before `commitFilter` (it commits the
  cached preview, or, for Remove Background, needs one to exist).

### 18.5 Stale project guard (adaptation)

Upstream compares in memory (section 2.6 step 8); the persistent session cannot see a write by the Compositor app, an
MCP client or another board while the panel is open, and saving it would overwrite that write. At `filter.commit`:
compare `DiskStamp(url)` with the stamp taken at begin. Equal → commit and save. Different → reload the snapshot; if
the target layer's manifest record (image file and size, transform) changed, answer `{ saved: false, discarded:
"stale" }` (upstream silently drops the result); otherwise re-run the commit in a fresh session from the new snapshot
with the same settings (deterministic filters give the same result; seeded ones get a new seed).

### 18.6 Keep, or reduce, the one-shot operations

Keep `filter.apply` for MCP automation, extended with an optional `settings` (begin with settings,
`updateFilter(settings, preview: automatic)`, wait, commit). Move the board's Content-Aware Fill onto
`filter.begin` / `filter.commit` to fix the seed mismatch. `filter.preview` becomes unnecessary.

### 18.7 Host side (`extension.js` `runEngine`)

`filter.begin` and `filter.repeat` need the usual flush of unsaved strokes. `filter.update` and `filter.cancel` should
pass `stateless: true` (no flush; they do not read the project). `filter.commit` flushes (nothing should be unsaved:
the board blocks edits while a filter is open) and pushes the saved change as one undo step named `editName`.

---

## 19. Board: generalising `media/filters.js`

### 19.1 Declarative control lists

One table drives both the Filter-menu panel and (later) adjustment-layer editing. Keys are JSON paths into the
settings object of section 17.

```js
// type: 'slider' { key, label, min, max, unit, decimals, log, help, track?, visible? }
//       'toggle' { key, label, help, visible? }
//       'segmented' { key, label|null, options: [[value, 'Label'], ...], fill: bool, help }
//       'menu' { key, label, groups: [[[value, 'Label'], ...], ...], fixed: bool, help }
//       'swatch' { key, label, labelWidth?, pickerTitle, help }        (one swatch row)
//       'swatches' { items: [{ key, label, pickerTitle, help }, ...] } (Dark / Light row)
//       'text' { text, tone: 'body'|'secondary'|'callout' }
//       'textField' { key, label, monospaced, help }
//       'heading' { text } / 'gradientBar' / 'custom' { render }        (Color Balance, Gradient Map, Curves)
const HALFTONE = ['dots', 'lines', 'diamonds'];
const FILTERS = {
    'Gaussian Blur': [
        { type: 'slider', key: 'radius', label: 'Radius', min: 0.1, max: 250, unit: 'px', decimals: 1, log: true },
        { type: 'toggle', key: 'preserveTransparency', label: 'Preserve Transparency', help: "Blur only the colors, keeping the layer's outline and transparency as they are" },
    ],
    'Motion Blur': [
        { type: 'slider', key: 'angle', label: 'Angle', min: -90, max: 90, unit: '°', decimals: 0 },
        { type: 'slider', key: 'distance', label: 'Distance', min: 1, max: 2000, unit: 'px', decimals: 0, log: true },
    ],
    'Progressive Blur': [
        { type: 'text', text: 'Click and drag two points on canvas', tone: 'secondary' },
        { type: 'segmented', key: 'progressiveRadial', label: 'Shape', options: [[false, 'Linear'], [true, 'Radial']], fill: false, help: 'Linear blurs along the line; Radial keeps the start sharp and blurs outwards' },
        { type: 'slider', key: 'progressiveFrom', label: 'From', min: 0, max: 250, unit: 'px', decimals: 1, help: 'The blur where the line starts' },
        { type: 'slider', key: 'progressiveTo', label: 'To', min: 0, max: 250, unit: 'px', decimals: 1, help: 'The blur where the line ends, and past it' },
        { type: 'toggle', key: 'progressiveInverted', label: 'Invert', help: 'Swap From and To: blur the start and sharpen toward the end' },
    ],
    'Add Noise': [
        { type: 'slider', key: 'amount', label: 'Amount', min: 0.1, max: 400, unit: '%', decimals: 1, log: true },
        { type: 'segmented', key: 'gaussian', label: 'Distribution', options: [[false, 'Uniform'], [true, 'Gaussian']], fill: true },
        { type: 'toggle', key: 'monochromatic', label: 'Monochromatic' },
    ],
    'Vignette': [
        { type: 'swatch', key: 'vignetteColor', label: 'Color', labelWidth: 95, pickerTitle: 'Color Picker (Vignette Color)', help: 'Choose the vignette color' },
        { type: 'slider', key: 'vignetteAmount', label: 'Amount', min: 0, max: 100, unit: '%', decimals: 0, help: 'Blend the chosen color into the edges while keeping the center unchanged' },
        { type: 'slider', key: 'vignetteMidpoint', label: 'Midpoint', min: 0, max: 100, unit: '%', decimals: 0 },
        { type: 'slider', key: 'vignetteRoundness', label: 'Roundness', min: -100, max: 100, unit: '', decimals: 0 },
        { type: 'slider', key: 'vignetteFeather', label: 'Feather', min: 0, max: 100, unit: '%', decimals: 0 },
        { type: 'slider', key: 'vignetteHighlights', label: 'Highlights', min: 0, max: 100, unit: '%', decimals: 0, help: 'Protect bright areas near the edge' },
    ],
    'Bloom / Glow': [
        { type: 'slider', key: 'bloomAmount', label: 'Amount', min: 0, max: 100, unit: '%', decimals: 0 },
        { type: 'slider', key: 'bloomRadius', label: 'Radius', min: 1, max: 150, unit: 'px', decimals: 0, log: true },
    ],
    'Dither': [
        { type: 'menu', key: 'dither.style', label: 'Style', fixed: false, groups: [
            [['atkinson', 'Atkinson (Classic Mac)'], ['floydSteinberg', 'Floyd–Steinberg']],
            [['bayer2', 'Bayer 2 × 2'], ['bayer4', 'Bayer 4 × 4'], ['bayer8', 'Bayer 8 × 8']],
            [['dots', 'Halftone Dots'], ['lines', 'Halftone Lines'], ['diamonds', 'Halftone Diamonds']],
            [['patterns', 'Mac Patterns'], ['ascii', 'ASCII']]] },
        { type: 'slider', key: 'dither.pixelSize', label: 'Pixel Size', min: 1, max: 32, unit: 'px', decimals: 0, visible: (s) => s.dither.style !== 'ascii', help: 'Make each dithered pixel this many pixels across, for a chunky old-screen look' },
        { type: 'slider', key: 'dither.textSize', label: 'Text Size', min: 6, max: 64, unit: 'px', decimals: 0, visible: (s) => s.dither.style === 'ascii', help: 'The height of each line of characters' },
        { type: 'slider', key: 'dither.cellSize', label: 'Cell Size', min: 4, max: 64, unit: 'px', decimals: 0, visible: (s) => HALFTONE.includes(s.dither.style) },
        { type: 'slider', key: 'dither.angle', label: 'Angle', min: -90, max: 90, unit: '°', decimals: 0, visible: (s) => HALFTONE.includes(s.dither.style) },
        { type: 'textField', key: 'dither.characters', label: 'Characters', monospaced: true, visible: (s) => s.dither.style === 'ascii', help: 'The characters to draw with, in any order: each spot gets the one whose ink best matches its tone' },
        { type: 'slider', key: 'dither.levels', label: 'Tones', min: 2, max: 8, unit: '', decimals: 0, visible: (s) => ['atkinson', 'floydSteinberg', 'bayer2', 'bayer4', 'bayer8'].includes(s.dither.style), help: 'Tones per channel: 2 is pure black and white' },
        { type: 'slider', key: 'dither.diffusion', label: 'Diffusion', min: 0, max: 100, unit: '%', decimals: 0, visible: (s) => ['atkinson', 'floydSteinberg'].includes(s.dither.style), help: "How much of each pixel's error spreads to its neighbors. Less gives flatter areas" },
        { type: 'slider', key: 'dither.density', label: 'Density', min: -100, max: 100, unit: '', decimals: 0, help: 'More ink (darker) or less before dithering' },
        { type: 'slider', key: 'dither.contrast', label: 'Contrast', min: -100, max: 100, unit: '', decimals: 0 },
        { type: 'menu', key: 'dither.colors', label: 'Colors', fixed: true, groups: [[['blackWhite', 'Black & White'], ['twoColors', 'Two Colors'], ['original', 'Original']]] },
        { type: 'swatches', visible: (s) => s.dither.colors === 'twoColors', items: [
            { key: 'dither.dark', label: 'Dark', pickerTitle: 'Color Picker (Dark Color)', help: 'Choose the dark color' },
            { key: 'dither.light', label: 'Light', pickerTitle: 'Color Picker (Light Color)', help: 'Choose the light color' }] },
        { type: 'menu', key: 'dither.pixelShape', label: 'Pixel Shape', fixed: true, groups: [[['square', 'Square'], ['dot', 'Dot']]], visible: (s) => s.dither.pixelSize > 1 && s.dither.style !== 'ascii', help: 'Draw each chunky pixel as a solid square, or as a round dot like a dot-matrix screen' },
        { type: 'toggle', key: 'dither.lightOnDark', label: 'Light on Dark', visible: (s) => [...HALFTONE, 'patterns', 'ascii'].includes(s.dither.style), help: 'Draw the marks for the light tones on the dark color, like a glowing screen' },
    ],
    'Scanlines': [
        { type: 'slider', key: 'scanlines.lineSpacing', label: 'Line Spacing', min: 2, max: 32, unit: 'px', decimals: 0, help: "How far apart the screen's lines are" },
        { type: 'slider', key: 'scanlines.thickness', label: 'Thickness', min: 5, max: 100, unit: '%', decimals: 0, help: 'How much of the gap a bright line fills; dimmer parts draw it thinner' },
        { type: 'slider', key: 'scanlines.glow', label: 'Glow', min: 0, max: 100, unit: '%', decimals: 0, help: "Light blooming around the lines, like a CRT's phosphors" },
        { type: 'slider', key: 'scanlines.dots', label: 'Dots', min: 0, max: 100, unit: '%', decimals: 0, help: "Break the lines into beads where the picture is darker than this, blending into solid lines where it's brighter" },
        { type: 'slider', key: 'scanlines.displace', label: 'Displace', min: -100, max: 100, unit: 'px', decimals: 0, help: 'Lift the lines where the picture is bright, or lower them when negative, so they swell into its shapes' },
        { type: 'slider', key: 'scanlines.smoothness', label: 'Smoothness', min: 0, max: 100, unit: '%', decimals: 0, help: 'How far the brightness is smoothed before it displaces the lines, from sharp ridges to rounded hills' },
        { type: 'slider', key: 'scanlines.threshold', label: 'Threshold', min: 0, max: 100, unit: '%', decimals: 0, help: 'Draw no line where the picture is darker than this, leaving the screen dark' },
        { type: 'slider', key: 'scanlines.wobble', label: 'Wobble', min: 0, max: 64, unit: 'px', decimals: 0, help: 'Make the lines waver sideways down the screen, like a CRT losing sync' },
        { type: 'slider', key: 'scanlines.split', label: 'Color Split', min: 0, max: 16, unit: 'px', decimals: 0, help: 'Move the red and blue apart, for colored fringes on the lines' },
        { type: 'slider', key: 'scanlines.density', label: 'Density', min: -100, max: 100, unit: '', decimals: 0, help: 'Darker or lighter before the lines are drawn' },
        { type: 'slider', key: 'scanlines.contrast', label: 'Contrast', min: -100, max: 100, unit: '', decimals: 0 },
        { type: 'slider', key: 'scanlines.blackLevel', label: 'Black Level', min: 0, max: 100, unit: '%', decimals: 0, help: 'How bright the lines are where the picture is black, so they show even over black' },
        { type: 'menu', key: 'scanlines.colors', label: 'Colors', fixed: true, groups: [[['blackWhite', 'Black & White'], ['twoColors', 'Two Colors'], ['original', 'Original']]] },
        { type: 'swatches', visible: (s) => s.scanlines.colors === 'twoColors', items: [
            { key: 'scanlines.dark', label: 'Dark', pickerTitle: 'Color Picker (Dark Color)', help: "Choose the screen's color" },
            { key: 'scanlines.light', label: 'Light', pickerTitle: 'Color Picker (Light Color)', help: "Choose the lines' color" }] },
    ],
    'Tonal Contrast': [
        { type: 'slider', key: 'tonalAmount', label: 'Amount', min: 0, max: 100, unit: '%', decimals: 0 },
        { type: 'slider', key: 'tonalShadows', label: 'Shadows', min: -100, max: 100, unit: '%', decimals: 0 },
        { type: 'slider', key: 'tonalMidtones', label: 'Midtones', min: -100, max: 100, unit: '%', decimals: 0 },
        { type: 'slider', key: 'tonalHighlights', label: 'Highlights', min: -100, max: 100, unit: '%', decimals: 0 },
        { type: 'slider', key: 'tonalRadius', label: 'Radius', min: 1, max: 100, unit: 'px', decimals: 0, log: true },
    ],
    'Lens Correction': [
        { type: 'slider', key: 'distortion', label: 'Remove Distortion', min: -100, max: 100, unit: '', decimals: 0 },
        { type: 'text', tone: 'callout', text: 'Positive straightens lines that bow outward (barrel); negative, lines that bow inward (pincushion).' },
    ],
    'Remove Background': [
        { type: 'text', tone: 'body', text: 'Hide the background behind a layer mask, keeping the foreground subjects. The pixels stay, so the background can be painted back at any time.' },
        { type: 'segmented', key: 'backgroundQuality', label: null, options: [['basic', 'Basic'], ['advanced', 'Advanced']], fill: true, help: "Basic is quick; Advanced refines the mask against the layer's own detail, for hair and fur" },
        { type: 'slider', key: 'refineEdges', label: 'Refine', min: 0, max: 40, unit: 'px', decimals: 0, visible: (s) => s.backgroundQuality === 'advanced', help: "Pull the mask onto the image's own edges, which recovers hair and fur" },
        { type: 'slider', key: 'matteContrast', label: 'Contrast', min: 0, max: 100, unit: '%', decimals: 0, visible: (s) => s.backgroundQuality === 'advanced', help: 'Clear the haze that leaves background showing through thin areas' },
        { type: 'slider', key: 'shiftEdge', label: 'Shift Edge', min: -10, max: 10, unit: 'px', decimals: 0, visible: (s) => s.backgroundQuality === 'advanced', help: 'Shrink the mask to drop the rim of background color around the subject, or grow it' },
    ],
    // Image menu (section 5): 'Exposure', 'Gradient Map', 'Black & White', 'Color Balance', 'Grain' in the same form;
    // 'Curves' as { type: 'custom' } from the adjustments spec.
};
```

Per-kind metadata: `AUTOMATIC = {'Content-Aware Fill', 'Remove Background'}`; `canvasTool = 'progressive'` for Progressive
Blur; `noop(settings)` mirroring section 2.6 step 3 (the engine decides, the board only uses it to skip a request if
desired).

### 19.2 Rendering the panel

- One CSS grid for the body: `grid-template-columns: minmax(60px, max-content) 1fr 56px auto` (title, slider, field,
  unit). Slider rows use the four columns; every other row spans `1 / -1`. This reproduces the shared title width.
- Re-render rows whose `visible` changes after every settings change; the panel height follows the content and its
  top-left stays put (upstream keeps the top-left while visible).
- Slider: `<input type=range step="any">` with `min/max = ln(lo)/ln(hi)` for `log`, else `lo/hi`; on input,
  `v = round((log ? exp(pos) : pos) · 10^d) / 10^d`. Field: format with `toLocaleString(undefined,
  { minimumFractionDigits: 0, maximumFractionDigits: d })`; on change parse the typed number, clamp to the range, keep
  its precision. Title: scrubbable (reuse the board's `data-scrub-*` helper) with `Δx · 10^−d` per CSS px, clamped,
  unrounded, `ew-resize` cursor.
- Help strings become `title` attributes on the row.
- Footer: `Preview` checkbox, error text in orange (`#ff9f0a`, as `.cr-error`; the current `.filter-error` uses
  `--danger`), "Limited to the selection" (callout, secondary) when the board has a selection, then Cancel · spacer ·
  status · OK.
- Panel width 380, padding 24, gap 14-16 (already in `media/board.css:101`). Remember the panel's top-left in a single
  per-webview variable shared by every filter kind; first open centers it on the stage.

### 19.3 Preview requests: one in flight, newest wins

```js
// edit: { kind, id, settings, preview, inFlight, dirty, committing, error, shown }
requestPreview() {
    const edit = this.edit;
    if (!edit || edit.committing) return;
    edit.dirty = true;
    if (edit.inFlight) return;               // the running request finishes first, then the newest settings go
    this.pump(edit);
}
async pump(edit) {
    while (edit.dirty && this.edit === edit && !edit.committing) {
        edit.dirty = false;
        edit.inFlight = true; this.refresh();
        const preview = edit.preview;
        let answer;
        try {
            answer = await this.board.engine('filter.update', { edit: edit.id, settings: edit.settings, preview },
                { files: preview ? { out: 'png' } : {}, stateless: true });
        } catch (error) { answer = { error: error.message }; }
        edit.inFlight = false;
        if (this.edit !== edit) return;
        if (/no longer open/.test(answer.error || '')) { await this.rebegin(edit); continue; }
        await this.receive(edit, answer);   // decode PNG, set edit.shown, edit.error, then show()
    }
    this.refresh();
}
```

- Never cancel a request; never send a second one while one is out (the engine is serial anyway, and queued requests
  would all render). This is upstream's coalescing.
- Every control change, color-picker change and Progressive Blur drag event updates `edit.settings` locally (the panel
  and overlay redraw at once) and calls `requestPreview()`.
- Adopt the engine's normalized `settings` echo only when `!edit.dirty` (otherwise it would undo a newer local change).
- Preview toggle: off → remove the renderer override immediately and `requestPreview()` (sends `preview: false`, cheap,
  no PNG); on → `requestPreview()`.
- Show the preview with `renderer.overrides.set(layerID, { canvas, toDocument: Transform.pixelToDocument(t, w, h),
  transform: t })` as today. While a grown preview shows (`grown`), apply the layer mask at the **original** layer
  transform (as upstream's `displayedMaskPlacement`), not at the override's grown transform: `media/render.js:153-173`
  currently stretches a linked mask over `src.transform`.

### 19.4 Status, OK and Cancel

- `Working…` only for automatic kinds while `inFlight || dirty`; `Applying…` while committing (spinner + text in the
  footer, `.filter-status`).
- OK disabled: `committing`, or automatic and (`inFlight || dirty || error || !shown`).
- OK: read any focused field's typed value first (Return arrives before its `change` event), close the color picker
  with commit, set `committing`, disable every input (Cancel included), drop `dirty`, send `filter.commit { edit,
  settings }` through `selectionOp` (label = kind). Answer:
  - `open: true` → back to editable, show `error`.
  - `saved` → keep the override until the layer's new image from the external reload is decoded (so the canvas never
    flashes the original), then remove it and close the panel.
  - `noop` or `discarded` → remove the override and close (a toast for `discarded`).
  - Store `lastFilter` and `filterSettings` from the answer.
- Cancel / Escape: refused while committing; else close the color picker without commit, `filter.cancel`, remove the
  override, close.

### 19.5 Colors

`media/picker.js` has `open({ title, color, onCommit })` only. Add `onChange(rgb)` (called from `update()`) and keep the
original to restore on Cancel. Swatch click: `picker.open({ title: control.pickerTitle, color, onChange: (rgb) => {
set(key, rgb); requestPreview(); }, onCommit: (rgb) => set(key, rgb), onCancel: () => { set(key, original);
requestPreview(); } })`. Convert between the board's `[r, g, b]` and `{ red, green, blue }`. Filter OK with the picker
open → `picker.close(true)` first; filter Cancel → `picker.close(false)`.

### 19.6 Progressive Blur on the canvas

In `media/view.js` pointer handling, before any tool, when the filter panel is open on Progressive Blur, the button is
primary and Space is not held:

```js
const line = edit.settings, s = view.toScreen(line.progressiveStart), e = view.toScreen(line.progressiveEnd);
if (dist(p, e) <= 10) drag = 'end';
else if (dist(p, s) <= 10) drag = 'start';
else { const d = view.toDocument(p); set({ progressiveStart: d, progressiveEnd: d }); drag = 'end'; }
// move: d = view.toDocument(p); if (event.shiftKey) d = snap45(d, drag === 'end' ? start : end); set({ [drag]: d })
// up: drag = null; focus the filter panel so Return / Escape reach it
```

Distances in CSS px; document points unrounded and unclamped. Draw the overlay of section 8.5 on the overlay canvas
(it replaces the transform handles while the panel is open). Other filters keep the canvas inert apart from panning
and zooming (`media/board.js:1255-1259`).

### 19.7 Menus and keys

- Filter menu (section 3) and the five Image-menu adjustments plus Curves (section 5) built from `FILTERS`.
- Enabling: port `canAdjustColors` from the active layer record: not a folder, not an adjustment layer, has an image,
  effectively visible, no explicit-empty selection, no floating selection, no filter / Color Range / other panel open,
  engine not committing. Vignette also allows a layer with no image (`!record.isGroup && !record.adjustment`).
- Opening: commit a floating selection, cancel marquee / lasso drafts, then `filter.begin`.
- Last Filter: label `lastFilter ? 'Last Filter: ' + lastFilter : 'Last Filter'`, shortcut ⌃⌘F; enabled when
  `lastFilter` is set, no panel open, and the same enabling rule; runs `filter.repeat { kind, settings: filterSettings }`
  through `selectionOp` (label = kind).
- Keys: ⌃⌘F handled in the board's keydown with `preventDefault()` and `stopPropagation()` (risk 23.4). While a panel
  is open, ↩ = OK and ⎋ = Cancel (already in `board.panel`).

---

## 20. Not applicable in VS Code / adaptations

| Upstream | Port |
|---|---|
| `NSPanel` floating window, `hidesOnDeactivate`, close button = Cancel | DOM panel inside the board's stage; no close button (Cancel / ⎋); hides with the webview |
| Panel position remembered app-wide across windows | Remembered per webview (one position for all filters) |
| `NSSound.beep()` on refused begin / Last Filter | Nothing, or a short toast; menus are disabled anyway |
| "Couldn’t paint" alert for `brushError` | Board toast (`answer.alert` / `answer.error`) |
| `configuredKeyboardShortcut` remapping | Fixed chords; ⌃⌘F may need a fallback (risk 23.4) |
| SwiftUI `Slider`, segmented `Picker`, pop-up `Picker`, `Toggle` | `<input type=range>`, button group, `<select>` with `<hr>`-like `<optgroup>` separators (or the board's own menu), checkbox |
| `CameraRawSlider` colored tracks (Black & White, Color Balance) | CSS linear-gradient track; double-click title or knob resets |
| ASCII glyphs from the bold monospaced **system** font | Rendered by the engine on macOS, so identical; nothing to port |
| Vision, Core Image, Metal | Engine only; the board never computes filter pixels |
| Live preview from in-memory renders | PNG round trip per render (risk 23.2) |
| Settings and Last Filter per project tab, lost on quit | Per board, in memory (optionally mirrored to `vscode.setState` so a webview reload keeps them) |
| Stale guard by CGImage identity | Disk-stamp check at commit (section 18.5) |
| Mask selected after Remove Background | Needs the board's mask target (risk 23.6); until then ignore `isMaskSelected` |

---

## 21. Test vectors and checks

### 21.1 Dither kernel (measured)

Produced by upstream's `dither_apply` on an opaque gray image, Black & White, `levels 2`, `diffusion 1`, `density 0`,
`contrast 0`, `cell 8`, angle 45°, `lightOnDark 1` unless noted. Through the engine use `dither.pixelSize = 1` (the
default 2 averages first) on an opaque layer filled with sRGB gray `v`; the preview is full size, so the PNG must
equal these bytes (R = G = B; `#` = 255, `.` = 0).

```
Bayer 2×2, v=128 (8×4)       Bayer 4×4, v=64 (8×4)        Bayer 4×4, v=128, levels 4
.#.#.#.#                     ........                     85 170 85 170 …
#.#.#.#.                     #.#.#.#.                     170 85 170 85 …
.#.#.#.#                     ........                     (repeats)
#.#.#.#.                     #.#.#.#.

Bayer 8×8, v=128: same checkerboard as Bayer 2×2 (row 0 starts '.').
Bayer 2×2, v=128, density +50 (8×2): row 0 "........", row 1 "#.#.#.#."

Atkinson, v=128 (8×8)        Atkinson, v=64 (8×8)         Floyd–Steinberg, v=128 (8×8)
#..##..#                     ........                     #.#.#.#.
..##..##                     ........                     .#.#.#.#
##..##..                     .#..#..#                     (alternating; diffusion 50 gives
#..##..#                     ........                      the same 8×4 pattern)
.##..##.                     ..#..#..
.##..##.                     #.......
#..##..#                     ...#..#.
#..##..#                     .#......

Mac Patterns, v=128, light on dark (index 8)      Mac Patterns, v=64, light on dark (index 4)
#...#...                                          #...#...
.#.#.#.#                                          ..#...#.
..#...#.                                          (repeats every 2 rows)
.#.#.#.#
(repeats every 4 rows)
Mac Patterns, v=64, dark on light (index 12): byte-identical to the v=128 light-on-dark output above.

Halftone Lines, v=128, cell 4, angle 0 (8×8)      Halftone Diamonds, v=128, cell 4, angle 0
........                                          .##..##.
########                                          ########
########                                          ########
........                                          .##..##.
(repeats every 4 rows)                            (repeats every 4 rows)

Halftone Dots, v=128, cell 8, angle 45 (16×16), rows 0-3:
..#######.....##
...#####......##
#...####...#...#
##.......#####..

dither_dots, block 4, on opaque white, gap black (8×4 values):
 15 153 153  15  15 153 153  15
153 255 255 153 153 255 255 153
153 255 255 153 153 255 255 153
 15 153 153  15  15 153 153  15
```

Bayer 2×2 by hand: tone `128/255 = 0.50196`; thresholds `(m + 0.5)/4` for `m = {0, 2, 3, 1}` are 0.125, 0.625, 0.875,
0.375; `floor(0.50196 + t)` gives 0, 1, 1, 0: row 0 `0 255`, row 1 `255 0`.

### 21.2 Scanlines geometry (measured)

`scanlines_apply` on an opaque flat gray, Black & White, `thickness 0.70`, `smoothness 0.5`, everything else 0, column
5 (values are R = G = B). Glow 0 keeps the whole filter in C, so the engine's full-size preview must match.

| Input | Spacing | Rows 0…15 |
|---|---|---|
| white | 8 | 0 255 255 255 255 255 255 0 · 0 255 255 255 255 255 255 0 |
| gray 89 (0.35) | 8 | 0 0 119 120 120 119 0 0 · 0 0 119 120 120 119 0 0 |
| black | 8 | all 0 |
| black, Black Level 40 | 8 | 0 10 138 138 138 138 10 0 · (repeats) |
| white, Thickness 100 | 8 | all 255 |
| white, Thickness 5 | 8 | 0 0 0 69 69 0 0 0 · (repeats) |
| gray 77 (0.30), Threshold 60 | 8 | all 0 |
| white | 4 (default) | 138 255 255 138 · 138 255 255 138 (8 rows) |

Dots 70 on gray 102 (0.40), spacing 8, row 4 across x 0…23: `0 3 136 138 138 136 3 0` repeated (beads every 8 px).
Color Split 2 on a white bar at x 8…15 over black, row 4: R lit at x 10…17, G at x 8…15, B at x 6…13 (all 255).
Wobble 12: per-line sideways shift for lines 0…7 = `3 4 3 9 12 5 0 2` px.

Upstream checks to mirror (`CompositorTests/ScanlinesTests.swift`): white lines lit through their middle with dark gaps;
a 0.35 gray line under half the brightness of a white one; Glow 100 lifts the gap by > 40; Dots 70 keeps white solid
and beads gray every 8 px; Wobble 12 gives ≥ 3 distinct edge positions; Displace 6 lifts the line over white above its
middle; a line lifted 40 hides the one behind; Threshold 60 blanks 0.3 gray.

### 21.3 Lens Correction (measured)

40×30 opaque white: Remove Distortion −100 (`k = −0.35`) → row 0 alpha all 0, (3, 3) alpha 67, center 255;
+100 → corner (0, 0) alpha 255. Upstream: the center pixel is unchanged at −100
(`CompositorTests/FilterTests.swift:248-276`).

### 21.4 Add Noise (measured, kernel only)

`noise_add_at` on gray 128, seed 7, origin 0: Uniform amount 10, row 0 → `(124,136,128) (130,129,117) (136,140,125)
(118,124,127)`; Gaussian + Monochromatic → `(133,133,133) (136,136,136) (127,127,127) (126,126,126)`. The panel's seed
is random, so through the engine test properties instead: two `filter.update` calls with the same settings in one edit
return identical PNGs; reopening gives a different pattern; the committed layer equals the last preview.

### 21.5 Geometry and controls (computed with the Swift arithmetic)

| Check | Input | Expected |
|---|---|---|
| Preview size | layer 4000×3000 | 2048×1536, scale 0.512 |
| Preview size | 4034×3034 (4000×3000 padded by 17) | **2047**×1540, scale 0.50744 (`4034 · (2048/4034)` truncates) |
| Preview size | 5000×2500 / 1200×800 / 2048×100 | 2048×1024 / 1200×800 (scale 1) / 2048×100 (scale 1) |
| Margins | Gaussian r 5 / Motion d 10 / Progressive To 20 / Bloom r 24 | 17 / 7 / 62 / 74 px (ceil) |
| Motion radius | distance 10 / 100 | 2.8868 / 28.8675 |
| Bloom intensity | amount 40 | 0.8 |
| Lens k | +100 / −50 | 0.35 / −0.175 |
| Default line | doc 200×100, layer = canvas | start (100, 35), end (100, 100) (`ProgressiveBlurTests.swift:81`) |
| Default line | doc 200×100, layer origin (−50, 20) size 300×200 | start (100, 48), end (100, 100) |
| Default line | layer entirely off the canvas | start (100, 35), end (100, 100) |
| ⇧ snap | point (10, 3) around (0, 0) | (10.4403, 0) |
| ⇧ snap | point (10, 6) around (0, 0) | (8.2462, 8.2462) |
| ⇧ snap | point (−3, −10) around (0, 0) | (0, −10.4403) |
| Log slider middle | Radius 0.1…250 / Distance 1…2000 / Amount 0.1…400 / Bloom 1…150 / Tonal 1…100 / Gamma 0.01…9.99 / Grain Size 0.5…20 | 5.0 / 45 / 6.3 / 12 / 10 / 0.32 / 3.2 |
| Log slider position of default | Radius 5 / Distance 10 / Amount 10 / Bloom 24 / Tonal 16 | 0.5000 / 0.3029 / 0.5552 / 0.6343 / 0.6021 of the track |
| Field text | Radius 5 / 12.25 typed / Distance 2000 | "5" / "12.3" shown (value kept 12.25) / "2,000" |

### 21.6 Integration checks through the engine (mirroring upstream tests)

1. Gaussian r 3 on a 40×20 half-white layer in an 80×60 canvas: OK makes one undo step "Gaussian Blur"; the layer
   grows taller than 20 and narrower than 40, origin moves up-left (`FilterTests.swift:7-48`).
2. Gaussian r 3 + Preserve Transparency: same size and transform, every alpha unchanged, green to the very edge
   (`:50-84`).
3. A picture filling the canvas, Gaussian r 4 and Motion d 30: transform unchanged, alpha 255 everywhere (`:117-146`).
4. A layer against the left, top and bottom canvas edges: origin stays 0, height 20, width > 40 (`:148-165`).
5. While dragging Radius 2 → 12, the preview answer for 12 has a larger `transform` than for 2 (`:167-193`).
6. Vignette, Bloom, Tonal Contrast keep layer effects and make one undo step (`FinishingFilterTests.swift:101-121`).
7. Dither on a 16-bit layer leaves an 8-bit layer (`DeepLayerTests.swift:292-299`); Progressive Blur keeps it 16-bit.
8. No-op OK (Lens 0, Vignette amount 0, Bloom amount 0, Tonal amount 0 or tones 0, Exposure default, Grain 0):
   `saved: false`, no undo step, `lastFilter` and `filterSettings` unchanged.
9. Last Filter after Gaussian r 7: same result as the panel at r 7, undo "Gaussian Blur".

---

## 22. Upstream quirks a faithful port inherits

1. The Last Filter doc comment says ⌘F (`Document/Filters.swift:746`); the menu binds ⌃⌘F (`CompositorApp.swift:334`).
2. Title scrubbing is linear and unrounded, even on logarithmic and whole-number sliders (`UI/NumericScrub.swift:34-36`).
3. Remove Background with Preview off: changing a setting drops the prepared preview and renders nothing, so OK (still
   enabled) does nothing until Preview is turned back on (`Document/Filters.swift:780-784, 867-869`).
4. A no-op OK remembers neither the settings nor Last Filter (Camera Raw excepted).
5. The Progressive Blur overlay always draws the solid "sharp" handle at the start, even with Invert on.
6. A preview's long side can be 2047 instead of 2048 (truncation, 21.5).
7. Bloom has no canvas-edge carry-on: it pads every side, even at the canvas edge.
8. OK rebuilds the layer without `shape` or `text` (`Document/Filters.swift:990-993`): a filter on a Shape or Type
   layer turns it into plain pixels.
9. Editing a Gaussian Blur adjustment layer shows the Preserve Transparency checkbox, which the adjustment ignores
   (`Document/AdjustmentEditing.swift:86`).
10. `FilterSettings.normalized` does not normalize Black & White, Color Balance or Curves; out-of-range values surface
    as the preview error "This is not a valid Compositor project, or its metadata is damaged." The board must clamp
    those itself.
11. Scanlines normalization rounds only Line Spacing and Color Split; Wobble and Displace stay fractional.
12. Scanlines' swatches reuse Dither's picker targets and titles ("Dark Color" / "Light Color").
13. Remove Background's Quality control has no visible label.
14. During a grown preview the layer mask stays on the layer's old bounds; on OK it is extended to the new grid
    (`Document/LayerMask.swift:333-334`, `Document/Filters.swift:979-988`).
15. Suspected: on OK the carried mask is laid over `edit.grownTransform` at the **trimmed** image's pixel size
    (`Document/Filters.swift:985-986`) while the layer moves to the trimmed transform; when trimming removes rows or
    columns, the mask may be offset. Not verified by a test; the engine reproduces whatever upstream does.
16. "Limited to the selection" shows whenever a selection exists, even one that misses the layer.

---

## 23. Risks and blockers

1. **Persistent engine edit is a prerequisite.** Without `filter.begin` / `update` / `commit`, settings cannot be
   applied, the committed Add Noise, Grain and Content-Aware Fill differ from their previews (random seed per
   `FilterEdit`), and Remove Background re-runs Vision on every request. Content-Aware Fill on the board already has
   the seed mismatch today.
2. **Full-size previews of large layers.** Add Noise, Grain, Dither, Scanlines and Remove Background preview at full
   size by design. PNG encoding **(measured)**: 2048×1536 smooth 27 ms / 189 KiB, noisy 60 ms / 3.7 MiB; 6000×4000
   noisy 431 ms / 27 MiB, before host-to-webview transfer and decode. Slider drags on a 24 MP layer will update a few
   times a second at best. Options: accept (parity), send the PNG with low compression, or add an optional
   `region` / `maxSide` to `filter.update` that crops the transfer to the visible viewport (the computation stays full
   size, so the visible pixels are unchanged).
3. **Serial engine.** A slow render (Remove Background Advanced, a 24 MP Dither) blocks every other engine request,
   including other boards, until it ends. Coalescing must stay on the board side (19.3); do not queue updates.
4. **⌃⌘F** is VS Code's Toggle Full Screen on macOS (`ui.md` 12.2). The webview handler must consume it; if the native
   menu accelerator still fires, contribute a `keybindings` entry with a `when` clause for the board or choose a
   fallback chord. **⌘M** (Curves) collides with the native Minimize item.
5. **Color picker hooks.** `media/picker.js` lacks live `onChange` and cancel-restore; filters need both (19.5).
6. **Mask target.** The board has no mask-target state; Remove Background's "mask selected" and Image › Invert Mask
   depend on it.
7. **Mask during grown previews.** `media/render.js` would stretch a linked mask over the grown override; it must use
   the original layer rect (19.3).
8. **Flash on OK.** The current `media/filters.js` removes the override as soon as `filter.apply` answers; the new layer
   image may not be decoded yet. Wait for the external reload before removing it.
9. **External writes while a panel is open.** Saving the persistent session could overwrite them; the disk-stamp check
   of 18.5 is required.
10. **Engine idle stop** (5 minutes) silently drops open edits; the board must re-begin on "This filter is no longer
    open." without losing the user's settings (Add Noise / Grain then get a new seed).
