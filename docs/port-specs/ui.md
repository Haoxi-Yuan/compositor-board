# Compositor UI, Shortcuts, Layers Panel, Move/Eyedropper/Viewport: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only). All `file:line` references are relative to
`upstream/Compositor/` unless they start with `VSCode:` (see section 12). Modifier glyphs follow macOS: `⌘` Command,
`⌥` Option, `⇧` Shift, `⌃` Control, `⌫` Delete (Backspace), `⎋` Escape, `↩` Return.

Scope: the window chrome and the v1 board features (Brush, Eraser, Move/Transform, Shape, Eyedropper, foreground and
background colors, the Layers panel, undo/redo, zoom and pan). Brush stroke internals are in `brush.md`. This file
only covers the brush header, keys and cursor where they touch the UI.

Files read in full: `ContentView.swift`, `CompositorApp.swift`, `UI/KeyboardShortcuts.swift`, `UI/LayersPanel.swift`,
`UI/LayerAppearanceControls.swift`, `UI/BlendModePicker.swift`, `UI/ColorPickerSheet.swift`,
`UI/ColorPaletteControls.swift`, `UI/TransformInspector.swift`, `UI/ToolHeaderStyle.swift`, `UI/NumericScrub.swift`,
`UI/NavigationToolHeader.swift`, `UI/HeldModifiers.swift`, `UI/NewCanvasSheet.swift`, `UI/ShapeControls.swift`,
`UI/BrushControls.swift`, `Document/LayerTransform.swift`, `Rendering/CanvasViewport.swift`,
`Rendering/SampleRingOverlay.swift`.
Read in part (targeted): `UI/NativeLayerList.swift` (1-1489), `Rendering/EditorCanvas.swift`,
`Rendering/TransformOverlay.swift`, `Document/EditorSession.swift`, `Document/ColorPalette.swift`,
`Document/LayerAppearance.swift`, `Document/SelectionClipboard.swift`, `Document/SelectionEdits.swift`,
`Document/LiveLayerMask.swift`, `Document/LayerGroups.swift`, `Document/DocumentHistory.swift`,
`Document/EditorSession+Brush.swift`, `Document/Crop.swift` (snapping), `Document/ShapeTool.swift`,
`UI/CanvasThumbnail.swift`.

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| Appearance | Always dark: `.preferredColorScheme(.dark)`, whatever the system setting | `ContentView.swift:175` |
| Default tool on open | Move / Transform (`tool: NavigationTool = .move`) | `Document/EditorSession.swift:172` |
| Default colors | Foreground black `#000000`, background white `#FFFFFF`; `D` resets to these | `Document/BrushStroke.swift:12-14`, `Document/EditorSession.swift:228`, `Document/ColorPalette.swift:52-56` |
| New canvas | 1920 x 1080 px, 72 DPI, Transparent. One blank layer "Layer 1", selected | `UI/NewCanvasSheet.swift:62-68`, `Document/EditorSession.swift:1040-1067` |
| New layer | Named "Layer N" (lowest free N). Inserted directly above the active layer and made active. Blank (no pixels yet), with a full-canvas transform | `Document/EditorSession.swift:703-731, 36-41` |
| Delete layer | No confirmation. The new active layer is the one directly above the deleted one, or the new top layer if the deleted layer was on top | `Document/LiveLayerMask.swift:131-147` |
| Eyedropper | One document pixel of the **merged visible composite**. Sets the foreground color only. ⌥-click in Brush or Eraser is a temporary eyedropper | `Document/ColorPalette.swift:239-260`, `Rendering/EditorCanvas.swift:93, 2521-2534` |
| Move tool | Auto Select **off** by default (⌘ flips it while held). Aspect lock **on** by default (⇧ flips it). ⌥ means "from center" when resizing and "duplicate" when moving. Arrow keys nudge 1 px (⇧ 10 px). Rotation uses a stick handle (⇧ snaps to 15°) | sections 5.x |
| Zoom | 0.1%–3200%. Fit leaves a 48 pt margin and may go above 100%. 100% = one document pixel per **device** pixel | `Rendering/CanvasViewport.swift:4-41` |
| Checkerboard | 10 pt squares of gray 0.30/0.35, fixed in screen space (they do not scale with zoom), drawn on a 0.105 gray surround | `Rendering/EditorCanvas.swift:866-922` |

---

## 1. Window layout

### 1.1 Regions

`ContentView.swift:80-136` (the `editorStack`), plus the window toolbar from `ContentView.swift:181-223`:

```
+------------------------------------------------------------------------------------------+
| [traffic lights] [+] [project tabs ..............................] [Fit] [100%] [(+)(-)] |  window toolbar (unified compact, no title)
+------------------------------------------------------------------------------------------+
| Tool header / options bar  (height 42, spans the FULL window width)                     |  ContentView.swift:82 (toolHeaders)
+----+-------------------------------------------------------------+-+--------------------+
|tool| (optional rulers)                                           |||  Layers   [count]  |
|rail|                                                             |||--------------------|
| 56 |                    canvas (EditorCanvas)                    |||  Blend [Normal v]  |
| pt |                                                             |||  Opacity ---o- 100%|
|    |                                                             |||--------------------|
|    |                                                             |||  layer rows        |
|[FG]|                                                             |||  ...               |
|[BG]|                                                             |||--------------------|
|    |                                                             |||  [+][F][M][A][S] [T]|  footer icons
+----+-------------------------------------------------------------+-+--------------------+
| 100%   1920 x 1080 px   sRGB · Transparent                 <tool hint text>              |  status bar, height 30
+------------------------------------------------------------------------------------------+
```

- The tool header sits above both the rail and the Layers panel, not only above the canvas
  (`ContentView.swift:81-82`: a `VStack` whose first child is `toolHeaders`, followed by the `HStack` of rail,
  canvas and panel).
- Dividers: header | `Divider()` | rail | `Divider()` | canvas | `PanelResizeEdge` (a divider with an 8 pt drag area) |
  Layers panel | `Divider()` | status bar (`ContentView.swift:85-133, 374-394`).
- Canvas-only mode (`F`) hides the header, rail, panel and status bar, and paints the surround black
  (`ContentView.swift:82,84,123,129`; `Rendering/EditorCanvas.swift:866`).

### 1.2 Dimensions

| Element | Value | Ref |
|---|---|---|
| Window default size | 1180 x 780. On first launch it fills the screen's visible area | `CompositorApp.swift:14, 20-22` |
| Window minimum | 800 x 520 | `ContentView.swift:147` |
| Tool rail width | 56 pt. Buttons 36 x 36 with 10 pt spacing, 16 pt top and 12 pt bottom padding. Scrolls when the window is short | `ContentView.swift:310-343` |
| Tool header height | 42 pt. Title font 13 semibold, control font 12, 18 pt horizontal padding | `UI/ToolHeaderStyle.swift:5-7, 37-42` |
| Layers panel width | Default 252. Draggable from 222 to 352 via its left divider (drag left to widen). The width is persisted (`@AppStorage("layersPanelWidth")`) | `ContentView.swift:6, 124-126, 374-394`; `UI/LayersPanel.swift:6-9` |
| Layer row height | 52 pt, plus 24 pt per layer effect, with 2 pt between rows | `UI/NativeLayerList.swift:15-16, 363-365` |
| Status bar | 30 pt high, 18 pt horizontal padding, 11 pt system font with monospaced digits, secondary color | `ContentView.swift:349-371` |

### 1.3 Colors and fonts

Every color is either an explicit gray or a macOS dark-mode semantic color. Hex values are 8-bit conversions of
`NSColor(white:)`. The semantic colors are approximate macOS dark values.

| Use | Value | Ref |
|---|---|---|
| Window chrome background | white 0.14 = `#242424` | `ContentView.swift:141` |
| Canvas surround | white 0.105 = `#1B1B1B` (black `#000000` in canvas-only mode) | `Rendering/EditorCanvas.swift:866, 873` |
| Document underlay | white 0.26 = `#424242`, with shadow offset (0, 3), blur 14, `rgba(0,0,0,0.35)` | `Rendering/EditorCanvas.swift:883-886` |
| Checkerboard | base white 0.30 = `#4D4D4D`; squares where `(row+col)` is even are white 0.35 = `#595959` (so the top-left square is the lighter one); 10 pt tiles | `Rendering/EditorCanvas.swift:890-907, 2743-2755` |
| Document edge | 1 device pixel, `rgba(255,255,255,0.13)` | `Rendering/EditorCanvas.swift:919-921` |
| Selected tool button | fill `rgba(255,255,255,0.12)`, 1 pt border `rgba(255,255,255,0.14)`, corner radius 7 | `ContentView.swift:325-330` |
| Accent (transform box, handle outlines, snap lines, targeted thumbnail border, selected row) | `NSColor.controlAccentColor` (the user's system accent; the default blue is about `#0A84FF` in dark mode) | `Rendering/TransformOverlay.swift:275, 360-364`; `UI/NativeLayerList.swift:1081-1084` |
| Layer row hairline | 1 device pixel `rgba(255,255,255,0.06)` along the bottom of each row | `UI/NativeLayerList.swift:1409-1417` |
| Layers thumbnail checkerboard | gray 0.22 = `#383838` and 0.32 = `#525252`, 6 pt tiles | `UI/CanvasThumbnail.swift:20-33` |
| Disabled footer icon | `rgba(255,255,255,0.5)`, which SwiftUI halves again | `UI/LayersPanel.swift:79-89` |
| Text | labelColor (about white at 85%), secondary (about 55%), tertiary (about 25%) | n/a |

Fonts are the system font (SF Pro) throughout:
- Tool header titles: 13 semibold. Controls: 12.
- "Layers" title: 12 semibold. Layer count: caption, monospaced digits, tertiary color.
- Layer name: 13. Layer size line: 10, secondary color. Effect names: 11. Depth tag: 9 medium.
- Status bar: 11, monospaced digits.

Refs: `UI/ToolHeaderStyle.swift:6-7`, `UI/LayersPanel.swift:14-16`, `UI/NativeLayerList.swift:915-918, 1221, 1446`,
`ContentView.swift:368`.

Controls: bordered buttons and pop-up menus are drawn as capsules throughout the app (`ContentView.swift:396-400`,
`UI/BlendModePicker.swift:19-20`).

### 1.4 Window toolbar

Refs: `ContentView.swift:181-223`, `CompositorApp.swift:24`.

| Item | Icon or label | Action | Tooltip |
|---|---|---|---|
| New canvas | SF `plus` | New canvas sheet | "New canvas (⌘N)" |
| Project tabs | (strip) | Switch projects | n/a |
| Fit | text "Fit" | `session.fit()` | "Fit canvas in window (⌘0)" |
| 100% | text "100%" | `zoom(to: 1)` | "Actual pixels (⌘1)" |
| Zoom in / out | SF `plus.magnifyingglass` / `minus.magnifyingglass` | `zoomKeyboard(by: ±1)` | "Zoom in (⌘+)" / "Zoom out (⌘−)" |

### 1.5 Tool rail

The rail lists `NavigationTool.allCases` in declaration order, minus `.idle` (`ContentView.swift:314`;
`Document/EditorSession.swift:90-91`). Icons are SF Symbols at 17 pt (`ContentView.swift:322`). The icon names are in
`Document/EditorSession.swift:98`, and the tooltips (also the accessibility labels) in `Document/EditorSession.swift:99`.

| # | Tool | SF Symbol | Tooltip | v1 |
|---|---|---|---|---|
| 1 | move | `arrow.up.left.and.arrow.down.right` | "Move / Transform (V)" | yes |
| 2 | marquee | `rectangle.dashed` (`circle.dashed` in Ellipse mode) | "Marquee (M)" | no |
| 3 | lasso | `lasso` (custom icon when Polygonal) | "Lasso (L)" | no |
| 4 | wand | `wand.and.stars` (custom icon in Object mode) | "Magic (W) · Tab switches Wand and Object" | no |
| 5 | crop | `crop` | "Crop (C)" | no |
| 6 | brush | `paintbrush.pointed`; **`eraser` while in Erase mode** | "Brush (B) · Eraser (E)" | yes |
| 7 | spotHealing | `bandage` | "Spot Healing Brush (J)" | no |
| 8 | cloneStamp | custom stamp (`seal` fallback) | "Clone Stamp (S) · Option-click sets the source" | no |
| 9 | blur (Smear) | `drop` | "Smear (R)" | no |
| 10 | gradient | custom (`square.bottomhalf.filled` fallback) | "Gradient (G)" | no |
| 11 | shape | `square.on.circle` | "Shape (U) · Shift-U switches Rectangle/Ellipse" | yes |
| 12 | type | `textformat` | "Type (T)" | no |
| 13 | eyedropper | `eyedropper` | "Eyedropper (I)" | yes |
| 14 | hand | `hand.draw` | "Hand (H)" | yes (pan) |
| 15 | zoom | `magnifyingglass` | "Zoom (Z)" | yes (zoom) |

**Eraser is not a separate rail button.** It is the Brush tool in `brushMode == .erase`, and the brush button's icon
switches to `eraser` (`Document/EditorSession.swift:208-213`). `B` selects Brush in Paint mode and `E` selects Brush
in Erase mode (`Rendering/EditorCanvas.swift:2290-2291`).

Color swatches sit under the tools with 8 pt of top padding (`ContentView.swift:337`; `UI/ColorPaletteControls.swift`):

- The foreground swatch is 24 x 24 at (0, 0). The background swatch is 24 x 24, offset by (12, 12) and drawn behind
  it. The whole group is a 36 x 36 frame (`UI/ColorPaletteControls.swift:8-13, 38`).
- Swatch style: rounded rectangle, radius 6 (continuous), with a 1.5 pt white inner stroke inset 1 and a 1 pt black
  outer stroke (`UI/ColorPaletteControls.swift:58-73`).
- Swap button: SF `arrow.left.and.right` at 9 pt, rotated 45°, at (27, -3). Tooltip "Swap foreground and background (X)"
  (`UI/ColorPaletteControls.swift:14-25`).
- Reset button: SF `arrow.counterclockwise` at 7.5 pt, at (-1, 27). Tooltip "Default colors (D)"
  (`UI/ColorPaletteControls.swift:26-36`).
- Clicking a swatch opens the color picker for that color (section 8).

### 1.6 Tool header (options bar), v1 tools

`ContentView.swift:27-78` picks one header per tool. All headers use `toolHeaderBar()` (42 pt high).

**Move: "Transform"** (`UI/TransformInspector.swift:10-61`). From left to right:
- Title "Transform" (or "Transform Mask").
- `Auto Select` toggle.
- `Show Controls` toggle (⌘H).
- A horizontally scrolling row:
  - Fields `X` and `Y` (85 pt each, range -30000…30000).
  - Fields `W` and `H` (85 pt, range 1…30000).
  - An aspect-lock toggle button with SF `link`.
  - `Scale` field with a `%` suffix (110 pt, range 0.1…30000, scales about the center).
  - `°` rotation field (75 pt, range -360…360, stored mod 360).
  - `Sampling` picker: Nearest / Smooth / High quality. The default is High quality (`Document/LayerTransform.swift:24`).
  - `Flip H` and `Flip V` buttons.
- `Cancel` and `Apply` buttons on the right. They are visible only while a *persistent* edit is pending (⌘T or a
  distort). Otherwise they are invisible but still answer `⎋` and `↩`.

While ⌘ is held, the Auto Select toggle shows its flipped state. While ⇧ is held, the lock toggle does too
(`UI/TransformInspector.swift:14-15, 27-28`; `UI/HeldModifiers.swift:4-6`).

Typed, stepped or scrubbed values preview live. They apply as one undo step when the field loses focus or the scrub
ends. No Apply is needed for them (`UI/TransformInspector.swift:71-88`). Number formatting: whole numbers have no
decimals, anything else shows two (`UI/TransformInspector.swift:141-144`). With aspect lock on, typing W or H scales
the other side too (`UI/TransformInspector.swift:89-100`).

**Brush / Eraser** (`UI/BrushControls.swift:7-121`):
- Title "Brush" or "Eraser".
- Segmented `Paint | Erase`.
- `Size` field (48 pt, px, 1…2000).
- `Hardness` slider (100 pt) plus a field (%).
- `Opacity` slider (1–100%) plus a field. Tooltip "Press 1–9 for 10–90%, 0 for 100%".
- `Smoothing` slider (0–100) plus a field.
- `Color` swatch (34 x 18), which opens the foreground picker.

Details are in `brush.md`.

**Shape** (`UI/ShapeControls.swift:7-66`):
- Title "Shape".
- Segmented `Rectangle | Ellipse | Line`.
- Fill swatch (36 x 18, foreground color; it opens the foreground picker).
- In Line mode: `Width` (1–5000 px; the slider covers 1–100).
- In Rectangle mode: `Radius` (0–5000 px; the slider covers 0–200) and a `Smooth Corners` checkbox.

**Eyedropper**: title "Eyedropper" and a `Sample Ring` checkbox, which defaults to on (`ContentView.swift:53-60`;
`Document/EditorSession.swift:107`).

**Hand** shows the title "Pan". **Zoom** shows the title "Zoom" plus a 72 pt percentage field that is right-aligned,
takes 0.1–3200, and applies on ↩ or blur. Its `%` suffix can be scrubbed (`UI/NavigationToolHeader.swift:10-65`).

**No tool (A)** shows the title "Select a tool", so the canvas does not jump (`ContentView.swift:69-76`).

Shared field behaviors:
- **Scrub labels.** Dragging horizontally on a field's label changes its value at the given sensitivity per point,
  with a left-right resize cursor. A `step` value snaps the result (`UI/NumericScrub.swift:16-43`).
- **Arrow steps.** ↑ and ↓ step 1, or 10 with ⇧ (`ContentView.swift:411-420`).
- **Focus release.** ↩ or ⎋ in a field hands keyboard focus back to the canvas, so tool keys work again
  (`ContentView.swift:402-408`).

### 1.7 Status bar

Refs: `ContentView.swift:349-371`.

- Left side, with a document open: the zoom percentage (0–1 decimals, 62 pt wide), then `"{W} × {H} px"`, then the
  fixed text `"sRGB · Transparent"`. With no document: "Ready when you are".
- Right side: a spinner with "Working…" or "Importing images…" while busy. Otherwise a per-tool hint
  (`ContentView.swift:365`):
  - Brush: "Drag to paint · [ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan"
    (Eraser: "Drag to erase · …").
  - Shape: "Drag to draw a shape on a new layer · Shift {square|circle|45°} · Option from center · Shift-U or Tab for
    the next shape · Escape cancel · Space to pan".
  - Move: "Drag to move · Handles to resize · Circle to rotate · 1–0 layer opacity · Space to pan".
  - Hand: "Drag to pan · Pinch to zoom".
  - Zoom: "Click to zoom in · Option-click to zoom out · Drag right or left to zoom smoothly · Space to pan".
  - Idle: "No tool selected · Press a tool's key to pick one · Space to pan".
  - **Upstream quirk:** Eyedropper has no case of its own and falls through to the Zoom hint. The port should give it
    a proper hint, for example "Click to sample · Option-click in Brush samples too".

### 1.8 Welcome screen

With no document, the `NewCanvasSheet` fills the canvas area (`ContentView.swift:103, 344-348`;
`UI/NewCanvasSheet.swift:92-180`). It contains:
- The title "New canvas" with a "⋯" presets menu.
- `Width × Height` fields: default `1920` x `1080`, prefilled from the size of an image on the clipboard if there is one.
- Three cycle-pills: "Transparent canvas" (then White, then Black), "Pixels" (then in, cm, mm), and "72 DPI" (toggles
  with 300).
- Buttons `Open project`, `Import image`, and `Create canvas` (↩, the prominent button). Maximum width 500, padding 28.

The Layers panel shows its empty state at the same time: SF `square.3.layers.3d` (25 pt, light), "No layers yet", and
"Create a canvas or import an image." (`UI/LayersPanel.swift:24-33`).

---

## 2. Default keyboard shortcuts

The full list of definitions is in `UI/KeyboardShortcuts.swift:83-143`. Its modifier bits are 1 = ⌘, 2 = ⌥, 4 = ⌃,
8 = ⇧ (`UI/KeyboardShortcuts.swift:11-15`). Users can rebind them in Edit › Keyboard Shortcuts…, persisted as
UserDefaults `keyboardShortcuts.v1` (`UI/KeyboardShortcuts.swift:151, 192-197`). ⌘Q, ⌘, and ⌥⌘M are reserved
(`UI/KeyboardShortcuts.swift:207-209`).

Where keys are handled:
- **Single-key tool and option keys** work when the canvas has focus (`Rendering/EditorCanvas.swift:2200-2322`) and
  when the Layers list has focus (`UI/NativeLayerList.swift:782-817`).
- **Window-wide keys.** A window-wide monitor also takes ⌘ zoom, ⇧+ / ⇧−, and brush `[ ] { }`, wherever focus sits,
  **except while a text field has focus** (`Rendering/EditorCanvas.swift:776-795`, guard at `:780`).
- **Shift + letter.** A tool letter also works with ⇧ unless ⇧ has its own meaning, such as ⇧U
  (`UI/KeyboardShortcuts.swift:226-234`). With no custom bindings, `charactersIgnoringModifiers.lowercased()` gives the
  same result (`Rendering/EditorCanvas.swift:2286-2287`).

### 2.1 Tools (v1 set first)

Reference shorthand in the tables of section 2: a bare `:N` in the first position of a Ref cell is
`UI/KeyboardShortcuts.swift:N`. A bare `:N` in the second position is `Rendering/EditorCanvas.swift:N`. Any other
file is named in full.

| Action | Key | Ref |
|---|---|---|
| Move / Transform | `V` | `UI/KeyboardShortcuts.swift:116`; `Rendering/EditorCanvas.swift:2316` |
| Brush (Paint mode) | `B` | `:117`; `:2290` |
| Eraser (Brush in Erase mode) | `E` | `:117`; `:2291` |
| Shape | `U`. With Shape active, `⇧U` cycles Rectangle → Ellipse → Line | `:118, 129`; `:2296-2298`; `Document/ShapeTool.swift:149-153` |
| Eyedropper | `I` | `:119`; `:2299` |
| Hand | `H` | `:116`; `:2317` |
| Zoom | `Z` | `:117`; `:2318` |
| Temporary Hand | hold `Space` | `:122`; `:2281-2285, 2323-2330` |
| No tool (deselect the tool) | `A` | `:116`; `:2313` |
| Cycle the current tool's mode (Brush Paint/Erase, Shape kind, …) | `Tab` | `:121`; `:2276-2280`; `Document/EditorSession.swift:424-443` |
| Not v1: Marquee `M`, Lasso `L`, Magic `W`, Crop `C`, Spot Healing `J`, Clone `S`, Smear `R`, Gradient `G`, Type `T` | | `:116-120` |
| Not v1: canvas-only fullscreen | `F` (⎋ also leaves) | `CompositorApp.swift:112-115` |

### 2.2 Colors and brush

| Action | Key | Ref |
|---|---|---|
| Swap foreground and background | `X` | `UI/KeyboardShortcuts.swift:121`; `Rendering/EditorCanvas.swift:2288`; `Document/ColorPalette.swift:43-51` |
| Default colors (black / white) | `D` | `:121`; `:2289`; `Document/ColorPalette.swift:52-56` |
| Brush size − / + | `[` / `]` (brush tools only). Each step is ×1.2 or ÷1.2, rounded, but always at least 1 px; clamped to 1…2000 | `:124`; `:2308-2309`; `Document/EditorSession+Brush.swift:261-268` |
| Brush hardness − / + | `⇧[` / `⇧]`, in steps of 25% | `:127`; `:2311-2312`; `Document/EditorSession+Brush.swift:253-260` |
| Opacity | `1`…`9` = 10…90%, `0` = 100%. Two digits within 0.6 s give an exact value (`4`,`5` = 45%; `0`,`5` = 5%; the floor is 1%). Active in Brush tools and Gradient (brush opacity) and **in Move (sets the opacity of the selected layers)** | `:130`; `:2306-2307`; `Document/EditorSession+Brush.swift:233-252` |
| Brush size / hardness by mouse | right-drag left/right (size); `⇧` + right-drag (hardness, full range over 200 pt) | `Rendering/EditorCanvas.swift:1715-1746` |

### 2.3 Layers

| Action | Key | Ref |
|---|---|---|
| New Blank Layer | `⇧⌘N` | `UI/KeyboardShortcuts.swift:107`; `CompositorApp.swift:368-369` |
| Duplicate Layer (Layer via Copy when a selection exists) | `⌘J` | `:104`; `CompositorApp.swift:353-354` |
| Delete layer | `⌫` or `⌦` with no pixel selection (with a selection it clears the selected pixels). The Layer menu item has **no** shortcut | `:122`; `Rendering/EditorCanvas.swift:2273-2275`; `Document/SelectionEdits.swift:76-88`; `CompositorApp.swift:390-393` |
| Move Layer Up / Down (swap with the adjacent sibling) | `⌘]` / `⌘[` | `:107-108`; `CompositorApp.swift:376-379`; `Document/EditorSession.swift:795-810` |
| Merge Down / Merge Layers (noted only, not v1) | `⌘E` | `:108`; `CompositorApp.swift:381-382` |
| Next / previous blend mode of the active layer (wraps around) | `⇧=` (`+`) / `⇧-` (`_`), any tool | `:128`; `Rendering/EditorCanvas.swift:784-788`; `Document/LayerAppearance.swift:122-129` |
| Hide / Show Layer | **no default key** (Layer menu item only) | `CompositorApp.swift:372-374` |
| Rename Layer | **no default key** (menu "Rename Layer…", or double-click the name) | `CompositorApp.swift:370-371` |
| Not v1: Group `⌘G`, Ungroup `⇧⌘G`, Clipping Mask `⌥⌘G` | | `:105-106` |

### 2.4 Edit, history and pending operations

| Action | Key | Ref |
|---|---|---|
| Undo | `⌘Z` (the menu reads "Undo {step name}") | `UI/KeyboardShortcuts.swift:88`; `CompositorApp.swift:26-47` |
| Redo | `⇧⌘Z` | same |
| Apply the current canvas operation (pending transform, crop, gradient, …) | `↩` | `:123`; `Rendering/EditorCanvas.swift:2252-2254` |
| Cancel the current canvas operation | `⎋` | `:123`; `Rendering/EditorCanvas.swift:2249-2251` |
| Select All (canvas pixels, never "all layers") / Deselect | `⌘A` / `⌘D` | `:99`; `CompositorApp.swift:259-269`; `UI/NativeLayerList.swift:550-555` |
| Not v1: Cut/Copy/Copy Merged/Paste `⌘X ⌘C ⇧⌘C ⌘V`; Fill FG `⌥⌫`; Fill BG `⌘⌫`; Content-Aware Fill `⇧⌫`; Inverse `⇧⌘I` | | `:95-100` |

### 2.5 View, zoom and pan

| Action | Key / gesture | Ref |
|---|---|---|
| Zoom In | `⌘=`. `⌘+` and keypad `+` also work. Steps through the fixed level list (6.3), anchored at the view center; repeats while held | `UI/KeyboardShortcuts.swift:93`; `CompositorApp.swift:124-128`; `Rendering/EditorCanvas.swift:799-816` |
| Zoom Out | `⌘-` (keypad `-` too) | `:94`; `CompositorApp.swift:129-133` |
| Fit Canvas | `⌘0` | `:92`; `CompositorApp.swift:118-120` |
| Actual Pixels (100%) | `⌘1` | `:93`; `CompositorApp.swift:121-123` |
| Show Transform Controls (Move tool only) | `⌘H`. This replaces macOS "Hide app": Hide keeps its menu place but gets no key | `:94`; `CompositorApp.swift:137-139, 195-202` |
| Pan | Space-drag; Hand-tool drag; middle-button drag in any tool; plain scroll or two-finger swipe | 6.4 |
| Zoom by gesture | pinch; `⌘`-scroll or `⌥`-scroll; `⌘`/`⌃` + middle-drag; Zoom-tool click or drag | 6.4 |
| Not v1: Grid `⌘'`, Guides `⌘;`, Rulers `⌘R`, Snap `⇧⌘;`, Lock Guides `⌥⌘;`, Search Commands `⌘F` | | `:92, 109-111` |

### 2.6 Move / Transform

| Action | Key | Ref |
|---|---|---|
| Nudge the active (or selected) layer by 1 px | arrows (Move tool, or any tool while a transform is pending) | `UI/KeyboardShortcuts.swift:131-133`; `Rendering/EditorCanvas.swift:2268-2272`; `UI/NativeLayerList.swift:809-813` |
| Nudge by 10 px | `⇧` + arrows | same |
| Transform Layer (persistent box with Apply/Cancel) | `⌘T` | `:104`; `CompositorApp.swift:351-352` |
| Move selected pixels (selection only, not v1) | `⌘` + arrows (10 px with `⇧`) | `:133`; `Rendering/EditorCanvas.swift:2255-2261` |

### 2.7 Other menu shortcuts (listed only to avoid collisions)

`⌘N` New Canvas, `⌘O` Open, `⌘S` Save, `⇧⌘S` Save As, `⌥⇧⌘S` Export JPEG, `⇧⌘E` Export PNG, `⌥⇧⌘W` Export As,
`⌘W` Close Project, `⌘F` Search Commands, `⌃⌘F` Last Filter, `⌘M` Curves, `⌘L` Levels, `⌘U` Hue/Saturation,
`⌘I` Invert, `⌥⌘C` Canvas Size, `⌥⌘I` Image Size, `⌥⌘A` Select Subject, `⌥⌘H` Hide Others.
Refs: `UI/KeyboardShortcuts.swift:88-111`; `CompositorApp.swift:49-99, 105-110, 197-202, 294-340`.

(Labeling quirk: the list names `⌥⌘H` "Hide Compositor" (`UI/KeyboardShortcuts.swift:95`), but the menu attaches it to
"Hide Others" (`CompositorApp.swift:198-200`).)

### 2.8 Mouse and modifier gestures (these are fixed and cannot be rebound)

The user-facing summary is at `UI/KeyboardShortcuts.swift:308`. v1-relevant parts:
- **⌥ temporary eyedropper.** ⌥ in Brush (both Paint and Erase), Spot Healing and Gradient turns the pointer into the
  eyedropper (`Rendering/EditorCanvas.swift:93`). Clone Stamp uses ⌥-click to set its source instead
  (`:1822-1828`).
- **Move tool modifiers.** ⇧ constrains (axis, aspect, 15°). ⌥ duplicates on move and works from the center on
  resize. ⌃ bypasses snapping. ⌘ flips Auto Select. ⌘⇧-click adds the layer under the pointer to the selection.
  ⌘-dragging a handle distorts (not v1). See section 5.
- **Shape modifiers.** ⇧ makes a square, circle or 45° line. ⌥ draws from the center (`Document/ShapeTool.swift:125`).
- **Layers panel.** ⌥-drag a row duplicates it. ⌥-click the bottom strip of a row toggles clipping. ⌘-click a
  thumbnail loads that layer's pixels as a selection. Drag across eyes to swipe visibility. See section 7.

---

## 3. Tool switching

`selectTool(_:)` is at `Document/EditorSession.swift:395-421`:

1. **Text in progress.** If the tool changes while text is being edited, `finishText()` runs first. If it refuses, the
   switch is aborted.
2. **Blocked states.** No switch happens while the project is busy, a brush stroke or warp stroke is in progress, or
   Levels is open.
3. **Pending work.** On an actual change of tool, the session `commitTransform()`s a pending transform (applies it),
   then cancels crop, resolves a pending gradient, cancels the lasso, and cancels a shape draft.
4. **Brush tips per family.** Brush, Spot Healing and Eraser share one tip (size, hardness, opacity). Clone Stamp and
   Smear each keep their own, both starting at 40 px, hardness 0, opacity 1. Switching families swaps tips
   (`Document/EditorSession.swift:220-225, 399-407`).
5. **Rail and status bar.** Clicking a rail button calls the same function (`ContentView.swift:315`). The rail
   highlights the current tool and the status-bar hint follows it.

`Tab` cycles the current tool's mode: Brush Paint ↔ Erase, Shape Rectangle → Ellipse → Line, and so on. Tools without
modes (Move, Crop, Type, Eyedropper, Hand, Zoom) ignore it (`Document/EditorSession.swift:422-443`).

Cursors per tool (`Rendering/EditorCanvas.swift:1454-1465`):

| Tool | Cursor |
|---|---|
| Hand, or Space held | open hand (closed hand while dragging) |
| Move | depends on what is under the pointer (5.6) |
| Type | I-beam |
| Idle | arrow |
| Zoom | zoom-in magnifier (zoom-out with ⌥) |
| Others | crosshair |
| Eyedropper | the SF `eyedropper` glyph, black over a dilated white outline, 24 x 24, hotspot at the tip (3, 21) (`:432-459`) |

Brush tools also draw a circle overlay at the brush diameter: a 2.5 pt white stroke under a 1 pt black stroke
(`Rendering/BrushCursorOverlay.swift:59-64`; see `brush.md` section 15).

---

## 4. Eyedropper

| Question | Answer | Ref |
|---|---|---|
| What is sampled? | The **merged composite of all visible layers**, exactly as drawn on the canvas: opacity, blend modes, masks, adjustments, effects, and even a pending transform or blend preview. Not just the current layer. The tool has no "current layer" option | `Document/ColorPalette.swift:237-260` (`drawLiveComposite`) |
| Sample size | **One document pixel**: `floor(x), floor(y)` rendered into a 1x1 context. No 3x3 or 5x5 averaging option | `Document/ColorPalette.swift:243-252` |
| Alpha | Fully transparent pixels return `nil` and leave the color unchanged. Partially transparent pixels are un-premultiplied (`min(alpha, c) / alpha`), so their color is taken without compositing over the checkerboard or white | `Document/ColorPalette.swift:256-259` |
| Outside the canvas | Nothing happens (`nil`) | `Document/ColorPalette.swift:240-242` |
| Which color is set? | Always the **foreground**. ⌥ does not set the background (no code path). With the color picker open, the sample goes into the picker's working color instead and commits only on OK | `Rendering/EditorCanvas.swift:2521-2528`; `Document/ColorPalette.swift:232-235` |
| Click and drag | Mouse-down samples. Dragging keeps sampling live. Mouse-up ends sampling and hides the ring | `Rendering/EditorCanvas.swift:1794-1798, 1901, 2115-2120` |
| Sample ring | Shown while sampling if "Sample Ring" is on (the default). A 116 x 116 pt view centered on the pointer: a gray (0.45 = `#737373`) ring 24 pt wide, inset 15, overlaid with a 16 pt colored ring. The **top half shows the new sample** and the **bottom half the color from before the drag** | `Rendering/EditorCanvas.swift:2529-2533`; `Rendering/SampleRingOverlay.swift:3-28` |
| ⌥-click with Brush? | **Yes.** ⌥ held in Brush (Paint *and* Erase mode), Spot Healing or Gradient makes the press sample instead of paint (sets the foreground). Not in Shape, Move, Smear, or Clone Stamp (where ⌥ sets the source). A stroke already in progress is not interrupted | `Rendering/EditorCanvas.swift:93, 1794-1804, 1822-1828` |
| Space | Space-drag pans even with the eyedropper (`!spaceHeld` guard) | `Rendering/EditorCanvas.swift:1794` |
| Picker sampling from any tool | While the color picker panel is open, a click on the canvas samples in **any** tool (`picking` includes `colorPicker != nil`). Afterwards focus goes back to the picker panel | `Rendering/EditorCanvas.swift:94-96, 2118` |

---

## 5. Move / Transform tool

### 5.1 Preconditions

- A layer can be transformed only if it is selected, has pixels (`asset != nil`), is not a folder, and is effectively
  visible (`Document/EditorSession.swift:356-361`; `Rendering/TransformOverlay.swift:75`).
- **A freshly added blank layer has no pixels, so it shows no transform box and cannot be moved until something is
  painted on it.**
- Several selected layers, or a folder, transform together inside one upright box around them
  (`Document/EditorSession.swift:362-386`).

### 5.2 What a press does (hit-test order)

`Rendering/EditorCanvas.swift:1853-1857, 2610-2646`:

1. A plain double-click on live text edits it (not v1). A press on a guide drags the guide (not v1).
2. **Transform handles**, when the box is shown. `TransformOverlayGeometry.hit` (`Rendering/TransformOverlay.swift:26-41`)
   uses a 10 pt radius (view points) and checks, in this order:
   - the **rotation handle**;
   - the **8 handles** (`Document/LayerTransform.swift:96-98` order: TL, T, TR, R, BR, B, BL, L);
   - **anywhere along an edge** within 10 pt, which counts as that edge's midpoint handle.
   The box interior is **not** a handle hit. It falls through to step 3.
3. **Otherwise, choose a layer to drag** with `transformPressLayer` (`Rendering/EditorCanvas.swift:1679-1711`):
   - `underPointer` is the **topmost** visible layer with pixels whose **transform rectangle** contains the point. This
     is a bounds test, not an alpha test.
   - Auto Select in effect = `transformAutoSelect XOR ⌘ held`. The stored default is **false**
     (`Document/EditorSession.swift:198-199`, persisted).
   - ⌘⇧-click: add `underPointer` to the layer selection, or remove it (`extendSelection`).
   - Auto Select off (the default):
     - A press inside the active layer drags it.
     - **A press anywhere else, even on empty canvas, also drags the active layer.** The press does not need to land
       inside the layer's bounds.
   - Auto Select on:
     - A press inside the active layer drags `underPointer` if that layer sits above the active one in the stack.
       Otherwise it drags the active layer.
     - A press outside the active layer selects `underPointer` and drags it. With nothing under the pointer, it drags
       the active layer.
   - Selection happens on press (`session.selectLayer`), before any movement.
4. **Begin the edit.** If no transform edit is pending, a non-persistent one begins, and mouse-up commits it as **one
   undo step**, "Transform Layer" (`Rendering/EditorCanvas.swift:2166-2170`; `Document/EditorSession.swift:484-525`).
   No-op edits leave no history entry (`Document/DocumentHistory.swift:67-68`).

With "Show Controls" off (⌘H), no box or handles are drawn and every press is a move (`Document/EditorSession.swift:200-202`;
`Rendering/TransformOverlay.swift:65`).

### 5.3 Drag math

`Document/LayerTransform.swift:126-214`, applied at `Rendering/EditorCanvas.swift:1998-2032`. All results are rounded
to whole pixels and whole degrees after each drag update (`LayerTransform.rounded()`,
`Document/LayerTransform.swift:51-59`). Typed values stay exact.

| Mode | Behavior | Modifiers |
|---|---|---|
| Move (body) | `origin += pointer delta` in document pixels | **⇧**: constrain to the dominant axis (`|dx| >= |dy|` keeps x). **⌥ at press**: on the first drag event the selected layers are duplicated and the copies are dragged ("Duplicate Layer"); ⎋ removes the copies again (`Rendering/EditorCanvas.swift:2001-2004`; `Document/EditorSession.swift:466-483, 530-537`). **⌃**: no snapping |
| Resize (handle or edge) | The anchor is the opposite handle. The handle position is the initial handle plus the pointer delta (no jump on grab), worked out in the layer's rotated frame. Dragging past the opposite side **flips** that axis instead of stopping. Minimum size 1 px | **Aspect lock** = `locksTransformRatio XOR ⇧`. The stored default is locked (`Document/EditorSession.swift:197`), so a **corner or edge drag scales uniformly by default and ⇧ frees it**. Corners project onto the diagonal; edges use that axis's factor. **⌥**: scale about the center (the span doubles). **⌃**: no snapping |
| Rotate (stick handle) | `rotation += angle(pointer − center) − angle(start − center)`, about the box center, clockwise in degrees | **⇧**: round to multiples of 15° |
| Distort (not v1) | ⌘-drag on a handle moves corners freely | |

There is **no rotate-by-dragging-outside-a-corner** (Photoshop style). Rotation is only available through the stick
handle.

### 5.4 Snapping (on by default)

- Moving snaps the box's left, center or right to the nearest target within a tolerance, and the same for top, center
  or bottom. Each axis is snapped on its own. Resizing snaps the dragged edges, but only on unrotated layers
  (`Document/Crop.swift:116-170`).
- Targets: canvas edges and center, and other layers' edges and centers. Moving layers are excluded. Guides and grid
  count too when they are enabled.
- The tolerance is **10 screen points**, converted to document pixels (`Document/LayerTransform.swift:219-221`;
  `Rendering/EditorCanvas.swift:2012`).
- Active snap lines are drawn as 1 pt accent-colored lines across the full document
  (`Rendering/TransformOverlay.swift:270-287`).
- Defaults: snap on, snap-to-layers on, snap-to-bounds on (`Document/EditorSession.swift:330-340`). ⌃ while dragging
  bypasses snapping.

### 5.5 Keyboard

- Arrow nudge: 1 px, or 10 px with ⇧. Each press is its own undo step, unless a ⌘T edit is pending, in which case it
  nudges the draft (`Document/EditorSession.swift:570-579`). Works with focus on the canvas or in the Layers list.
- `1`…`0` set the opacity of the selected layers (2.2).
- `↩` applies and `⎋` cancels a pending transform (`Rendering/EditorCanvas.swift:2249-2254`;
  `UI/NativeLayerList.swift:785-788`).
- `⌘T` starts a persistent transform: the box stays until Apply or Cancel, and the Layers panel grays out.
- Switching tools applies a pending transform (section 3).

### 5.6 Visuals and cursors

- **Box** (`Rendering/TransformOverlay.swift:348-375`): a 1 pt accent-colored outline through handles 0, 2, 4, 6,
  plus a stick from the top-center handle to the rotation handle. Handles are 7 x 7 squares with white fill and an
  accent stroke. The rotation handle is an 8 x 8 circle, also white fill with an accent stroke.
- **Rotation handle position**: 28 view points beyond the top-center handle along the box's rotated "up" direction
  (`Rendering/TransformOverlay.swift:11-12`).
- **Cursors** (`Rendering/EditorCanvas.swift:1645-1666`):

| Where | Cursor |
|---|---|
| Over a handle or edge | a resize cursor oriented to the box angle (`Rendering/TransformOverlay.swift:43-49`) |
| Over the rotation handle | SF `arrow.triangle.2.circlepath`, 24 pt (`Rendering/EditorCanvas.swift:412-427`) |
| Where a press would drag a layer | the Move cursor: an arrow with a small 4-way-arrow badge (`:202-204`) |
| The same, with ⌥ held | the duplicate cursor: a double arrow (`:199`) |
| Anywhere else | the arrow |

The cursor stays locked to the drag's cursor for the whole drag.

---

## 6. Viewport, zoom and pan

### 6.1 Model

`Rendering/CanvasViewport.swift:4-33`:

- `zoom = 1` means one **document pixel per device pixel**. `pointsPerPixel = zoom / backingScale`, so on a 2x Retina
  display, 100% shows the image at half its CSS-pixel size.
- The document is centered in the view, offset by `pan` in view points. Pan is **not clamped** (`translate`,
  `:75-79`).

### 6.2 Limits and fit

- Zoom range: `0.001…32`, which is 0.1%–3200% (`Rendering/CanvasViewport.swift:11`;
  `UI/NavigationToolHeader.swift:26`).
- **Fit**: `zoom = min((viewW − 96) / docW, (viewH − 96) / docH) × backingScale`, then clamped. This leaves a 48 pt
  margin on every side. The result is **not capped at 100%**, so small images fill the view. Fit resets pan to zero
  (`Rendering/CanvasViewport.swift:35-41`).
- **Re-fit on resize.** While in fit mode (`followsFit`), resizing the window fits again. Any zoom or pan leaves fit
  mode (`Rendering/CanvasViewport.swift:43-64`).
- **Fit happens automatically** in these cases:
  - creating a canvas (`Document/EditorSession.swift:1051`);
  - the first imported image creating the document (`:943`);
  - a PSD opened as a document (`:1010`);
  - undo or redo to a different canvas or canvas size (`:672-678`);
  - the Fit toolbar button and `⌘0`.

### 6.3 Keyboard zoom

- `⌘=` and `⌘-` step to the next or previous entry of
  `[12.5%, 16.7%, 25%, 33.3%, 50%, 66.7%, 100%, 125%, 150%, 200%, 300%, 400%, 500%, 600%, 800%, 1200%, 1600%]`
  (`Rendering/CanvasViewport.swift:12-14, 66-73`).
- At either end of the list nothing happens. Above 1600% the keys do not zoom further.
- The anchor is the view center (`Document/EditorSession.swift:1082-1087`).
- `⌘1` sets 100%, anchored at the view center (`:1074-1077`).

### 6.4 Gestures

| Input | Behavior | Ref |
|---|---|---|
| Plain scroll or two-finger swipe | Pan by the scroll delta. Precise (trackpad) deltas are used ×1; line-based (wheel) deltas ×12 | `Rendering/EditorCanvas.swift:2188-2193` |
| `⌘`-scroll or `⌥`-scroll | Zoom about the pointer: `zoom *= exp(−scrollingDeltaY × 0.015)` | `:2185-2187` |
| Trackpad pinch | Zoom about the pointer: `zoom *= 1 + magnification` | `:2195-2199` |
| Scroll or pinch while dragging a transform, crop or guide, or during a brush or warp stroke | ignored | `:2183, 2196` |
| Space held + left-drag | Pan. Open hand while Space is held, closed hand during the drag. Space release is matched by physical key code. Space is cleared when focus leaves | `:1812-1819, 2033-2036, 2281-2285, 2323-2330, 2347` |
| Hand tool drag | Pan (same code path) | same |
| Middle-button drag | Pan in any tool | `:2042-2076` |
| `⌘`/`⌃` + middle-drag | Zoom about the press point: up zooms in, ×2 per 100 pt | `:2045-2047, 2056-2070` |
| Zoom tool click | ×2 at the point, or ×0.5 with `⌥`. Applied on mouse-up when the pointer moved less than 3 pt | `:1858-1860, 2100-2108` |
| Zoom tool drag left/right | `zoom = startZoom × 2^(dx / 100)`, anchored at the press point. The cursor follows the direction | `:1885-1899` |
| Trackpad rotate | not handled: the view never rotates | (no `rotate(with:)` override) |

### 6.5 Rendering by zoom

- Below 200%, layers are resampled smoothly. From 200% (`crispZoom`), document pixels are drawn as hard-edged
  squares (nearest neighbor). The pixel grid appears from 800% (`pixelGridZoom`), if it is enabled; it is on by
  default (`Rendering/EditorCanvas.swift:924-927`; `Document/EditorSession.swift:280`).
- The Navigator minimap appears only at 300% and above, and is off by default (`ContentView.swift:114-118`).

### 6.6 Canvas appearance

See the colors in 1.3.

- The **transparent canvas is the checkerboard**. Its squares are 10 view points regardless of zoom and are anchored at
  the document's top-left corner.
- Compositor documents are always transparent-capable (the status bar reads "sRGB · Transparent"). A "white canvas" is
  simply a filled layer named "Background" (section 9).
- There is no separate canvas background color.

---

## 7. Layers panel

### 7.1 Structure (top to bottom)

`UI/LayersPanel.swift:11-72`:

1. **Header.** "Layers" (12 semibold) on the left, and on the right the total layer count (caption, monospaced,
   tertiary), padding 18.
2. **Appearance controls** for the active layer (`UI/LayerAppearanceControls.swift:9-41`; padding 12, spacing 8):
   - Row 1: caption `Blend` plus a pop-up of blend modes.
   - Row 2: caption `Opacity` (scrubbable, 1% per pt), a slider over 0–1, a 44 pt `%` field (↑ / ↓ ±1, ⇧ ±10;
     ↩ / ⎋ give focus back to the canvas).
   - Blend is disabled for folders and for multi-selection. Opacity is disabled for multi-selection
     (`Document/LayerAppearance.swift:85-88`).
   - A slider or scrub drag is one undo step, "Layer Opacity" (`Document/LayerAppearance.swift:89-107`).
3. **Layer list** (`NativeLayerList`, an `NSTableView`). Rows run **top of the stack first** (`Document/LayerGroups.swift:254-256`).
4. **Footer**, padding h8/v4, each icon with an 8 x 12 pt hit area (`UI/LayersPanel.swift:36-65`):

| Icon (SF Symbol) | Action | Tooltip | v1 |
|---|---|---|---|
| `plus.square` | New blank layer | "New blank layer (⇧⌘N)" | yes |
| `folder.badge.plus` | Group selected layers | "Group selected layers (⌘G)" | no |
| `rectangle.inset.filled` (menu) | Add layer mask | "Add layer mask (Option-click for a black mask)" (`UI/LayerMaskMenu.swift:11-12`) | no |
| `circle.lefthalf.filled` (menu) | New adjustment layer | "New adjustment layer" | no |
| `sparkles` (menu) | Add layer effect | "Add layer effect" | no |
| (spacer) | | | |
| `trash` | `deleteLayerOrMask()` | "Delete selected layer" / "Delete selected layers" / "Delete layer mask" / "Delete selected effect" | yes |

Empty state: SF `square.3.layers.3d` (25 pt, light), "No layers yet", and then "Create a canvas or import an image."
when there is no document, or "Import an image or add a blank layer." when there is a document with no layers
(`UI/LayersPanel.swift:24-33`).

### 7.2 Blend mode pop-up

Refs: `UI/BlendModePicker.swift`; `Document/LayerAppearance.swift:4-24`.

- 26 modes, with separators between groups:
  - Normal
  - Darken, Multiply, Color Burn, Linear Burn
  - Lighten, Screen, Color Dodge, Linear Dodge (Add)
  - Overlay, Soft Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix
  - Difference, Exclusion, Subtract, Divide
  - Hue, Saturation, Color, Luminosity
- Darker Color and Lighter Color are omitted (`Document/LayerAppearance.swift:71-72`).
- **Hover preview**: while the menu is open, the highlighted item is previewed live on the canvas. Closing without a
  choice restores the original mode (`UI/BlendModePicker.swift:46-76`; `Document/LayerAppearance.swift:76-84`).
- Choosing an item is one undo step, "Layer Blend Mode" (`Document/LayerAppearance.swift:130-137`).
- ⇧+ / ⇧− cycle through `LayerBlendMode.allCases` in this same order, wrapping around
  (`Document/LayerAppearance.swift:122-129`).

### 7.3 Row content

`UI/NativeLayerList.swift:820-1064`. A bare `:N` in this table and in 7.4 refers to `UI/NativeLayerList.swift`. From
left to right:

| Element | Detail |
|---|---|
| Eye button | 20 x 32 at x = 8, SF `eye` when visible and `eye.slash` when hidden (`:941-943, 1058`) |
| Disclosure | Folders only: SF `chevron.down` when open, `chevron.right` when collapsed, 16 x 24 (`:945-946, 996-998`) |
| Indent | 24 pt per folder depth (at most 8 levels), plus 24 pt for a clipped layer (`:995`) |
| Layer thumbnail | Fits in a 36 pt box. Pixel layers show **the whole canvas**: the layer drawn where it sits on a 0.22/0.32 checkerboard, with the canvas's aspect ratio. Text, adjustment and folder layers show a square icon (`textformat`, the adjustment's symbol, `folder`). Corner radius 3 (`:936-937, 999-1014`; `UI/CanvasThumbnail.swift:10-33`) |
| Mask thumbnail | Only when there is a mask: 30 pt box, with a link chain (`link`, rotated 45°) between it and the layer thumbnail. A red "╱" over it marks a disabled mask (`:938-939, 1015-1037, 907-909`) |
| Name | 13 pt, one line, truncated at the tail, 9 pt from the top. A clipped layer's name is prefixed `"↳ "` (`:911-916, 1046`) |
| Second line (10 pt, secondary) | `"{w} × {h} px"`, followed by `" · {scale}%"` when the layer is scaled (`:1474-1481`). Otherwise "Folder", "Text · Double-click to edit", "Adjustment · Double-click to edit", or "Clipped to {source}" (`:1047, 1053-1057`) |
| Depth tag | A capsule tag "16-Bit" or "HDR" after the size (9 pt medium, quaternary fill) (`:1442-1457, 1048-1052`) |
| Effects | One 24 pt sub-row per effect: eye toggle and name (11 pt), indented under the layer (`:1199-1238`) |
| Dimming | Rows that are effectively hidden (the layer itself or an ancestor folder) draw at **alpha 0.35** (`:1063`; `Document/LayerGroups.swift:13-18`) |
| Targeted thumbnail | A **2 pt accent border** around the layer thumbnail (or the mask thumbnail when the mask is targeted), only when exactly one layer is selected (`:1071-1087`) |
| Selected row | The standard NSTableView selection highlight: the accent color when the list has focus, gray otherwise (multiple selection is allowed, `:17`) |

**Badges** for mask, clipping, effects, adjustment and text: Compositor uses **no icon badges**. Each is shown as in
the table above: a second thumbnail and chain for a mask, `↳` plus indent plus "Clipped to …" for clipping, sub-rows
for effects, and an icon thumbnail plus a subtitle for adjustment and text layers.

### 7.4 Interactions

- **Select.**
  - Selection happens on mouse-down, with no double-click delay (`UI/NativeLayerList.swift:755-781`).
  - ⌘-click toggles a row in or out of the selection, and ⇧-click selects a range (standard table behavior). An empty
    selection is allowed (`:17-18`).
  - Selecting is **not** an undo step (`Document/DocumentHistory.swift:67`).
  - Changing the selection commits a pending transform (`Document/LayerGroups.swift:149`).
- **Inline rename.**
  - Starts on a double-click on the name, from the context menu "Rename…", or from Layer › Rename Layer…
    (`UI/NativeLayerList.swift:26, 105-111, 392-405`).
  - The name label becomes editable in place, with a quaternary background and all of the text selected (`:1089-1101`).
  - **↩ or clicking away keeps** the new name; **⎋ restores** the old one (`:1109-1130`).
  - The name is trimmed. An empty or whitespace-only name is ignored. Names are not checked for uniqueness. One undo
    step, "Rename Layer" (`Document/EditorSession.swift:754-760`).
  - Focus returns to the list afterwards (`UI/NativeLayerList.swift:1120-1123`).
  - Double-clicking a *thumbnail* opens a text or adjustment layer for editing instead (`:396-403`).
- **Visibility.**
  - Clicking the eye toggles visibility as one undo step, "Hide Layer" or "Show Layer".
  - **Eye swipe**: press an eye and drag up or down the list, and every eye passed over takes the same state. The whole
    swipe is one undo step (`UI/NativeLayerList.swift:1418-1441`; `Document/EditorSession.swift:762-783`).
- **Drag reorder** (`UI/NativeLayerList.swift:406-497`):
  - Drop **between** rows to place the layers above the row below the drop line, in that row's parent.
  - Drop **on** a folder row to put the layers inside that folder, on top.
  - Drop past the last row to place them at the very bottom.
  - **⌥-drag copies** instead of moving (`:432-438, 456`).
  - Dragged layers stay selected. One undo step, "Move Layer(s)" or "Duplicate Layer(s)".
  - The keyboard equivalents are ⌘] and ⌘[, which swap with the adjacent sibling only
    (`Document/EditorSession.swift:795-810`).
- **Context menu** (right-click; a row that is not yet selected gets selected first) (`UI/NativeLayerList.swift:119-248, 557-593`):
  1. Duplicate Layer
  2. Rename…
  3. Delete Layer (or "Delete Selected Layers", or "Delete Mask")
  4. separator
  5. Create/Release Clipping Mask
  6. Group Selected Layers
  7. Ungroup Layers (folders only)
  8. Move Out of Folder
  9. Merge Down / Merge Layers / Merge Group
  10. Convert to 16-Bit / 8-Bit
  11. separator
  12. Add Mask ▸ (Reveal All (White), Hide All (Black))
  13. Enable/Disable Mask
  14. Delete Mask
  15. Link/Unlink Mask
  16. separator
  17. Hide Layer / Show Layer

  The v1 subset is Duplicate, Rename, Delete, Merge Down (noted only), and Hide/Show.
- **Keys with the list focused** (`UI/NativeLayerList.swift:782-817`):
  - ⎋ and ↩ cancel or apply a pending transform.
  - Tab, X, D, and the tool letters behave as on the canvas. The digits set opacity.
  - **Arrows nudge the layer with the Move tool**; they do not move the row selection.
  - ⌫ / ⌦ act like the Delete key on the canvas (`deleteKeyPressed`).
  - ⌘A selects the canvas pixels, not all layers (`:550-555`).
- Middle-drag scrolls the list without selecting anything (`UI/NativeLayerList.swift:521-548`).
- ⌥-click on the bottom strip of a row toggles a clipping mask (not v1) (`:755-766`).

### 7.5 New layer

`addBlankLayer`, at `Document/EditorSession.swift:703-731`:

- Name: `"Layer \(n)"` with the **smallest n ≥ 1 not used by any existing layer name**. After deleting "Layer 2", the
  next new layer is "Layer 2" again.
- Insertion: at `index(active) + 1` in the bottom-to-top array, so **directly above the active layer** and in the same
  parent folder. With no active layer it goes on top. With a folder selected it goes to the top of that folder.
- The new layer becomes active (and the only one selected). One undo step, "New Blank Layer".
- Initial state: `asset = nil`, so pixels are allocated when painting begins. The transform has
  `origin = (0, 0)`, `size = document size`, rotation 0, no flips, and High quality sampling. It is visible, at
  opacity 1, with blend Normal (`Document/EditorSession.swift:14-18, 36-41`; `Document/LayerTransform.swift:18-24`).
- Other operations that add a layer insert it the same way, directly above the active layer:
  - Shape and paste use `addPixelLayer` (`Document/SelectionClipboard.swift:296-310`).
  - Duplicate inserts the copy directly above the original, named `"{name} copy"`. The copy becomes active
    (`Document/SelectionClipboard.swift:225-278`, name at `:267`).
  - Image import is the exception: it **appends at the top** and centers the image
    (`Document/EditorSession.swift:938-954`).

### 7.6 Delete

- **Delete key (`deleteKeyPressed`).** With a pixel selection, ⌫ clears the selected pixels. Otherwise it deletes the
  targeted mask, or the selected layer(s) (`Document/SelectionEdits.swift:76-88`).
- **Trash button.** It calls `deleteLayerOrMask()` directly (`UI/LayersPanel.swift:58`).
- **No confirmation dialog.** Deletion is one undo step, "Delete Layer" or "Delete Layers". A folder takes its
  descendants with it.
- **Active layer afterwards.** The code is `activeLayerID = layers[min(index, layers.count − 1)]`, where `index` is the
  deleted layer's former position in the bottom-to-top array (`Document/LiveLayerMask.swift:142-145`). The new active
  layer is therefore **the layer directly above the deleted one**. When the top layer is deleted it is the new top
  layer, which was the one below. With no layers left it is `nil`. (Photoshop selects the layer below; Compositor
  selects the one above.)
- **Multi-delete.** The selection is deleted in document order as a single undo step
  (`Document/EditorSession.swift:745-752`; `Document/LiveLayerMask.swift:149-154`).

---

## 8. Colors and the color picker

### 8.1 Defaults

- Foreground black `#000000` (the brush settings' r, g, b = 0, `Document/BrushStroke.swift:12-14`). Background white
  `#FFFFFF` (`Document/EditorSession.swift:228`).
- Colors are opaque sRGB with no alpha channel (`Document/ColorPalette.swift:4-18`).
- Swap (`X`) and reset (`D`) are not undo steps. They are ignored while a stroke is in progress or the project is
  busy (`Document/ColorPalette.swift:25, 43-56`).
- With a mask targeted, the swatches become black or white only ("Black · Hide" and "White · Reveal"), and clicking a
  swatch shows a small popover instead of the picker (`UI/ColorPaletteControls.swift:40-48, 62`) (not v1).

### 8.2 Picker

Style: a **Photoshop-style HSB picker with RGB and hex entry** (`UI/ColorPickerSheet.swift:4-6`). It lives in a
movable floating panel. The panel title is "Color Picker (Foreground Color)" or "Color Picker (Background Color)"
(`Document/ColorPalette.swift:275-285`). It opens centered on the canvas the first time, then wherever it was left.
Closing it with the title-bar button cancels (`UI/ColorPickerSheet.swift:168-190`).

Layout (`UI/ColorPickerSheet.swift:20-150`; padding 20, spacing 14):

| Part | Detail |
|---|---|
| Saturation/brightness field | 256 x 256. Horizontal: white to the pure hue (saturation 0 to 1). Vertical: transparent to black overlay (brightness 1 to 0). The marker is a 12 pt circle, white 1.5 pt with a black 0.75 pt halo. 1 pt `rgba(0,0,0,0.6)` border. Drag anywhere in it (`:52-72`) |
| Hue strip | 20 x 256, **red at the top (360°)**, then magenta, blue, cyan, green, yellow, and red at the bottom (0°). Two 7 x 10 triangular arrows on either side mark the hue (`:74-97`) |
| Right column (180 pt) | 64 x 64 preview of the **new** color (no "current" swatch is shown). `OK` (↩) and `Cancel` (⎋) buttons, 90 pt wide, large (`:24-34, 99-105`) |
| Fields | `R`, `G`, `B` integers 0–255 (52 pt fields; the labels can be scrubbed; ↑/↓ step). `#` hex field, 84 pt, monospaced. It accepts `RRGGBB` or `RGB` with or without `#`, and displays uppercase without `#` (`:107-150`; `Document/ColorPalette.swift:363-373`) |
| Caption | "Click the canvas to sample" (`:38-41`) |

- **There are no numeric HSB fields** and no alpha. HSB is the internal state, kept so the hue survives grays
  (`Document/ColorPalette.swift:308-322`).
- The working color applies to the palette **only on OK** (`Document/ColorPalette.swift:101-105`).
- Other ways to open the picker: the color swatch in the Brush header and the fill swatch in the Shape header, both for
  the foreground color (`UI/BrushControls.swift:107-121`; `UI/ShapeControls.swift:17-25`).

---

## 9. Defaults on open and new canvas

| Item | Default | Ref |
|---|---|---|
| Tool | Move | `Document/EditorSession.swift:172` |
| Brush | 40 px, hardness 100%, opacity 100%, smoothing 0, Paint mode | `Document/BrushStroke.swift:10-19`; `Document/EditorSession.swift:209` |
| Shape | Rectangle, radius 0, line width 4 px | `Document/EditorSession.swift:236-241` |
| Move options | Auto Select off, Show Controls on (both persisted as `tool.autoSelect` and `tool.transformControls`). Aspect lock on (not persisted) | `Document/EditorSession.swift:197-202`; `Document/ToolDefaults.swift` |
| Snapping | Snap on; to layers, document bounds and guides on; to grid off | `Document/EditorSession.swift:330-340` |
| Rulers, grid, navigator | off, off, off. Pixel grid on (shown from 800%) | `Document/EditorSession.swift:280, 289, 328`; `CompositorApp.swift:8` |
| New canvas sheet | 1920 x 1080 px, 72 DPI, Transparent. Prefilled from the clipboard image size if there is one. Presets: 4K, 1440p, 1080p, iPhone 18 Pro (1206 x 2622), iPhone 18 Pro Max (1320 x 2868), MacBook Pro 14"/16", Studio Display, Instagram Square/Portrait/Story, YouTube Thumb (1080 x 608). Maximum side 30000 px | `UI/NewCanvasSheet.swift:62-68, 169-179, 244-263`; `Document/DocumentLimits.swift:18` |
| First layer | **Transparent**: a blank "Layer 1" (no pixels; full-canvas transform). **White or Black**: a layer named **"Background"**, filled with full-size pixels. It is an ordinary layer, not locked. Either way the first layer is active, and the view fits | `Document/EditorSession.swift:1038-1067` |
| History | 100 entries or 256 MB, snapshot-based, with named steps | `Document/DocumentHistory.swift:28` |

---

## 10. Undo and redo (UI-facing)

- `⌘Z` and `⇧⌘Z`. The menu titles are "Undo {name}" and "Redo {name}" (`CompositorApp.swift:43-46`).
- Undo and redo are disabled while text is being edited, a modal dialog is open, a rename is in progress, or a
  persistent transform is pending (`CompositorApp.swift:29`; `Document/EditorSession.swift:650-655`).
- While a gradient is pending, the first Undo discards it (`Document/EditorSession.swift:657-662`).
- Undo restores the active layer from the snapshot (`:669-679`).
- Step names used by the v1 features:
  - New Blank Layer, Delete Layer(s), Rename Layer
  - Hide Layer / Show Layer, Reorder Layers, Move Layer(s)
  - Duplicate Layer(s), Layer Opacity, Layer Blend Mode
  - Transform Layer(s), New Canvas
  - The brush steps are covered in `brush.md`.

---

## 11. Compositor-faithful but questionable behaviors (decide explicitly in the port)

1. **Destructive Delete key.** ⌫ with no selection deletes the layer in *any* tool, without confirmation
   (`Document/SelectionEdits.swift:76-80`). Because undo exists, this is acceptable. Do not let it fire while an input
   field has focus.
2. **Blank layers cannot be moved.** A new blank layer shows no transform box until it has been painted on
   (`Document/EditorSession.swift:360`). Users may expect to be able to move it.
3. **Bounds-based auto-select.** Auto-select picks layers by their transform rectangle, not by alpha
   (`Rendering/EditorCanvas.swift:1681`). A full-canvas blank layer that has been painted on catches clicks over its
   whole extent.
4. **Eyedropper status hint.** It falls through to the Zoom text (`ContentView.swift:365`).
5. **"00" opacity.** Typing `0`,`0` gives 1%, not 0% (`Document/EditorSession+Brush.swift:241`).

---

## 12. Porting notes for a VS Code webview

`VSCode:` references point to the locally installed VS Code 1.142.0 (`/Applications/Visual Studio Code.app`):
`VSCode:pre/index.html` is `Contents/Resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html`, and
"bundle" means `out/vs/workbench/workbench.desktop.main.js`, which was grepped for its default `keybinding` entries.

### 12.1 How keys reach VS Code from a webview

- **Every key is forwarded.** The webview preload adds `keydown` and `keyup` listeners to the webview's content
  `window`, in the **bubble** phase. It forwards *every* key to the workbench as `did-keydown` / `did-keyup`, where
  VS Code's keybinding service dispatches it (`VSCode:pre/index.html:603-650, 921-922, 1187`).
- **Some keys lose their browser default.** Before forwarding, it calls `preventDefault()` on Cmd/Ctrl + `Z`, `Y`, `P`,
  `F`, `S`. On Electron it does the same for Cmd/Ctrl + `C`, `V`, `X`. Copy and paste are then dispatched back into the
  webview through `execCommand` (`VSCode:pre/index.html:608-613, 656-705, 1271-1276`).
- **Consequence.** A chord the board handles will **also** run the VS Code command bound to it, unless the board
  stops the event before it bubbles to `window`.
- **Recommended handler.** Install a single `keydown` handler on `document` (bubble phase, or capture phase on
  `window`). For every chord the board consumes, call both `preventDefault()` and `stopPropagation()`. Let unknown
  chords through, so VS Code shortcuts such as ⌘P and ⌘⇧P keep working.
  *This rests on standard DOM propagation semantics. Verify it in a real VS Code build before relying on it.*
- **Native menu keys.** macOS app-menu items such as `⌘H` (Hide), `⌥⌘H` (Hide Others), `⌘M` (Minimize) and `⌘Q`
  belong to Electron's native menu. Assume the webview **cannot** pre-empt them, and test before depending on that.
- **Context menu and dragging.**
  - The preload shows VS Code's own context menu unless the event is `defaultPrevented`
    (`VSCode:pre/index.html:1188-1195`). Call `preventDefault()` on `contextmenu` for the layer-row and canvas menus.
  - The preload `preventDefault`s `dragover` and `drop` on `window`, and treats drags of *files* specially
    (`VSCode:pre/index.html:792-833`). Implement layer-row reordering with pointer events, not HTML5 drag and drop.
- **Wheel events.** Wheel events are forwarded too (`did-scroll-wheel`, `VSCode:pre/index.html:747-759, 1132`). This
  is harmless. Register the wheel listener with `{ passive: false }` and `preventDefault()` it, at least when ctrl,
  meta or alt is held (pinch arrives as `wheel` with `ctrlKey = true` in Chromium).

### 12.2 Clash table (macOS defaults; Windows and Linux are the same with Ctrl)

"Verified" means the binding was found in the 1.142 bundle. "Known" means it is a standard VS Code default that the
grep heuristic could not isolate. Confirm with *Preferences: Open Default Keyboard Shortcuts (JSON)*.

| Chord | Compositor action | VS Code default | Status | Risk | Suggestion |
|---|---|---|---|---|---|
| ⌘W | Close Project | Close Editor (`closeActiveEditor`, 2101) | verified | **high**: closes the board | Never bind. Leave it to VS Code |
| ⌘N | New Canvas | New Untitled Text File (`newUntitledFile`, desktop 2092) | verified | high | Do not bind. Offer "Board: New Canvas" in the command palette or the board's own "+" button |
| ⇧⌘N | **New Blank Layer** (v1) | New Window (`newWindow`, desktop 3116) | verified | **high** | Consume with `stopPropagation`. If a window still opens in testing, fall back to ⌥⇧⌘N (Photoshop's "new layer without dialog"). Keep the footer `+` button |
| ⌘= / ⌘- (also ⇧⌘=, keypad ±) | **Zoom In / Out** (v1) | View: Zoom In / Out of the whole window (`zoomIn` 2134, secondary 3158, 2157; `zoomOut` 2136, 2159) | verified | **high**: zooms all of VS Code | Must be consumed whenever the board has focus |
| ⌘0 | **Fit** (v1) | Focus Side Bar (`focusSideBar`, 2069) | verified | high | Consume |
| ⌘1 | **Actual Pixels** (v1) | Focus First Editor Group (2070) | verified | medium | Consume |
| ⌘J | **Duplicate Layer** (v1) | Toggle Panel (`togglePanel`, 2088) | verified | **high**: resizes the webview | Consume |
| ⌘T | Transform Layer | Go to Symbol in Workspace (`showAllSymbols`, 2098) | verified | medium | Consume, or skip ⌘T in v1 (the Move tool already transforms) |
| ⌘H | Show Transform Controls | macOS "Hide Visual Studio Code" (native menu) | known | **high**: hides the app | Do not bind. Use the header checkbox only in v1. Do not remap it to ⇧H, which selects the Hand tool through the Shift+letter rule |
| ⌘Z / ⇧⌘Z | **Undo / Redo** (v1) | `undo` (2104) / `redo` (mac 3128). The preload preventDefaults and forwards them | verified | **high**: double undo | Choose one: (a) implement a `CustomEditorProvider` and report edits through `onDidChangeCustomDocument` with `undo`/`redo` callbacks, so VS Code owns ⌘Z and the dirty state; or (b) consume ⌘Z/⇧⌘Z in the webview with `stopPropagation`. Never both |
| ⌘S / ⇧⌘S / ⌘O | Save / Save As / Open | Save / Save As (3121, verified) / Open File (2093, verified) | verified/known | n/a | Leave to VS Code (CustomEditor save and saveAs) |
| ⌘[ / ⌘] | **Move Layer Down / Up** (v1) | Outdent / Indent Lines (text editor only) | verified (editor-scoped) | low | Consume anyway |
| ⌘E | Merge Down (noted) | Find With Selection (editor-scoped) | verified | low | Consume if implemented |
| ⌘A / ⌘D | Select All / Deselect | `editor.action.selectAll`, `list.selectAll` / Add Selection to Next Find Match (editor) | verified | low | Not v1. If added, consume |
| ⌘F | Search Commands | Find. The preload preventDefaults it; webview find widget | verified | low | Not v1. Leave to VS Code |
| ⌃⌘F | Last Filter | Toggle Full Screen (`toggleFullScreen`, mac 2340) | verified | n/a | Not v1 |
| ⇧⌘E | Export PNG | Show Explorer (3107) | verified | n/a | Not v1 |
| ⌘C / ⌘V / ⌘X | clipboard | handled by VS Code, then `execCommand` back into the webview | verified | medium | Not v1. If added, listen for DOM `copy`/`paste` events instead of keydown |
| ⌘I / ⇧⌘; / ⌘G | Invert / Snap / Group | Inline Chat (editor), Focus Breadcrumbs, Find Next | heuristic | n/a | Not v1 |
| `Tab` | Cycle tool mode | browser focus traversal | n/a | medium | `preventDefault` while the canvas is focused |
| `Space` | Temporary Hand | page scroll, button activation | n/a | medium | `preventDefault`. Track keyup by `event.code`. Reset on `blur` and `visibilitychange` (Compositor clears it on resign, `Rendering/EditorCanvas.swift:2347`) |
| plain letters, digits, `[ ] X D`, arrows, `⌫`, `↩`, `⎋` | tools and options | no global VS Code bindings while the webview has focus | n/a | low | Handle them, but **suppress all single-key shortcuts while an `<input>` or `[contenteditable]` has focus** (Compositor: `!(window.firstResponder is NSText)`, `Rendering/EditorCanvas.swift:780`) |
| `F` | Canvas-only fullscreen | none | n/a | low | Optional: post a message to the extension to run `workbench.action.toggleMaximizeEditorGroup` or Zen Mode |

### 12.3 Other porting notes

- **Key identity.** Compositor matches `charactersIgnoringModifiers` and folds `{→[`, `}→]`, `+→=`, `_→-`
  (`UI/KeyboardShortcuts.swift:27-28`). In the browser, use `event.code` (`KeyV`, `BracketLeft`, `Equal`, `Minus`,
  `Digit0`, `Space`, `Tab`, `Backspace`, `Delete`, `Numpad*`). `event.key` is unreliable with ⌥ on macOS: ⌥[ gives
  "“", for example.
- **Modifiers by platform.** Use `metaKey` on macOS and `ctrlKey` elsewhere for "⌘". ⌥ is `altKey`. Track ⌥ on
  every key and pointer event, because a lost `keyup` left the temporary eyedropper stuck in Compositor too
  (`Rendering/EditorCanvas.swift:2206-2208`).
- **Focus.** Give the canvas `tabIndex=0` and call `focus()` on `pointerdown`, as Compositor makes the canvas first
  responder on mouse-down (`Rendering/EditorCanvas.swift:1750`). VS Code only delivers keys while the webview is
  focused.
- **Device pixels.** Use `window.devicePixelRatio` as `backingScale` and keep "100% = one document pixel per device
  pixel". Listen for `matchMedia('(resolution: …dppx)')` changes; VS Code's own window zoom changes
  `devicePixelRatio`. Alternatively, declare 100% = one CSS pixel. Pick one deliberately and document it.
- **Wheel normalization.** Trackpad deltas arrive in pixels (`deltaMode` 0, small values). Mouse wheels arrive as
  `deltaMode` 1, or as large, uniform pixel steps. DOM `deltaY` has the opposite sign of AppKit's `scrollingDeltaY`, so
  pan by `(−deltaX, −deltaY)` (with one wheel notch at about 12 pt), and zoom with `zoom *= exp(deltaY × 0.015)`
  for ⌘/⌥-wheel to keep AppKit's direction. Pinch arrives as `ctrlKey` wheel; approximate `1 + magnification` with `exp(−deltaY / 100)`, then tune.
- **Theme.** Compositor forces dark mode. To feel like Compositor, hard-code the grays from 1.3 rather than following
  the VS Code theme. Take the accent from `--vscode-focusBorder`, or fix it at `#0A84FF`. Fonts:
  `-apple-system, BlinkMacSystemFont, "SF Pro Text", var(--vscode-font-family)`.
- **Icons.** SF Symbols cannot be redistributed outside Apple-platform apps; check the license. Use
  `@vscode/codicons` (CC BY 4.0) or Lucide (ISC) equivalents. Suggested Lucide names:

  | Compositor (SF Symbol) | Lucide |
  |---|---|
  | `arrow.up.left.and.arrow.down.right` | `move` |
  | `paintbrush.pointed` | `paintbrush` |
  | `eraser` | `eraser` |
  | `square.on.circle` | `shapes` |
  | `eyedropper` | `pipette` |
  | `hand.draw` | `hand` |
  | `magnifyingglass` | `zoom-in` |
  | `eye` / `eye.slash` | `eye` / `eye-off` |
  | `plus.square` | `square-plus` |
  | `trash` | `trash-2` |
  | `link` | `link` |
  | `arrow.left.and.right` (swap) | `arrow-left-right` |
  | `arrow.counterclockwise` (reset) | `rotate-ccw` |
  | `plus.magnifyingglass` / `minus.magnifyingglass` | `zoom-in` / `zoom-out` |
  | `square.3.layers.3d` | `layers` |

  Custom cursors (eyedropper with hotspot (3, 21), move-badge, rotate) can be built with CSS
  `cursor: url(data:…) x y, crosshair`.
- **Layout without a window toolbar.** A webview has no AppKit toolbar. Put "Fit", "100%" and the zoom buttons on the
  right end of the board's own top strip, or of the options bar. Keep the options bar full width above the rail and
  the panel, as in 1.1.
- **Floating color picker.** Make it a draggable in-webview panel that keeps the canvas clickable for sampling
  (section 4). Remember its position in `vscode.setState()`.
- **Persisted preferences.** Compositor stores Auto Select, Show Controls, snapping and the panel width in
  UserDefaults (`Document/ToolDefaults.swift`; `ContentView.swift:6`). Use `vscode.getState()` / `setState()` for
  per-webview state, or the extension's `globalState` (sent over `postMessage`) so they survive across documents.
- **Text-field behavior.** Return or Escape in a numeric field should blur it and refocus the canvas
  (`ContentView.swift:402-408`). ↑ / ↓ in fields step by 1, or 10 with ⇧.
