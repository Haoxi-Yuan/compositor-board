# Compositor File Menu, Import and Export: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3, `MARKETING_VERSION = 1.5.3`, commit
`365b574`). All `file:line` references are relative to `upstream/Compositor/` unless they start with `engine/`,
`core/`, `vscode-extension/`, `docs/`, `Config/` or `CompositorTests/`. Code excerpts and user-visible strings are
verbatim, including typographic quotes (`’ “ ” …`). Modifier glyphs follow `ui.md`: `⌘` Command, `⌥` Option, `⇧`
Shift, `⌃` Control, `⌫` Delete, `⎋` Escape, `↩` Return.

Files read in full: `IO/ProjectController.swift` (428 lines), `IO/ProjectController+ExternalChanges.swift` (112),
`IO/ProjectStore.swift` (297), `IO/ImageImporter.swift` (147), `IO/ImageExporter.swift` (292), `IO/RawImporter.swift`
(182), `IO/CMYK.swift` (190), `IO/RecentProjects.swift` (33), `IO/ImageFileDrop.swift` (60),
`IO/PSD/PSDDocumentBuilder.swift` (171), `IO/PSD/PSDTypes.swift` (106), `Document/ProjectWorkspace.swift` (290),
`Document/EditorSession+Projects.swift` (89), `Document/DocumentLimits.swift` (42), `UI/NewCanvasSheet.swift` (265),
`UI/ExportAsSheet.swift` (402), `UI/RawDevelopSheet.swift` (119), `UI/PSDConversionSheet.swift` (69),
`Config/Info.plist`, `Config/Compositor.entitlements`. Read in part (targeted): `IO/PSD/PSDReader.swift` (1-430,
adjustment parser skimmed), `IO/PSD/PSDChannelCoder.swift` (1-80), `IO/PSD/PSDText.swift` and `IO/PSD/PSDVector.swift`
(conversion notes), `IO/CompositorApplicationDelegate.swift` (open-file and quit paths), `CompositorApp.swift` (File,
Edit and View menus), `ContentView.swift` (drop, importer, alerts, welcome, status bar), `Document/EditorSession.swift`
(busy gate 100-175, sheet state 580-660, import pipeline 811-1067), `Document/SelectionClipboard.swift` (paste as new
canvas 172-202), `Document/DocumentHistory.swift` (nesting), `Document/DeepLayers.swift` (`wideAsset`, `asset`),
`UI/KeyboardShortcuts.swift` (menu chords), `UI/ColorPickerSheet.swift` (`DialogColorSwatch`), and the tests
`CompositorTests/NewCanvasUnitTests.swift`, `ImageImportTests.swift`, `ExportTests.swift`, `JPEGExportTests.swift`,
`PSDRoundTripTests.swift` (names and the cases quoted in section 17), `PSDFixture.swift` (header).
Port side read: `vscode-extension/extension.js` (852), `vscode-extension/package.json`, `core/package-io.js`,
`core/engine-client.js`, `core/manifest.js` (`createProject`, constants), `engine/build.sh`,
`engine/Sources/EngineMain.swift`, `engine/Sources/SelectionOps.swift` (`withSession`, copy and paste),
`engine/Sources/FilterOps.swift`, `vscode-extension/media/board.js` (welcome, menus, keys, messages), and the VS Code
1.142.0 webview preload and workbench bundle (drag and drop, open dialog).

**Empirical checks (measured on this Mac: macOS 26 / Darwin 25.6, 24 GB RAM, Apple Swift 6.4, VS Code 1.142.0).**
A scratch Swift program called the same Foundation, ImageIO and UniformTypeIdentifiers APIs with the same arguments
as upstream; the existing `engine/bin/compositor-engine` was run (`version`, `render` on `samples/parrot.comp`); the VS
Code bundle was grepped. Results are quoted below and marked **(measured)**. The scratch programs and their outputs
were deleted afterwards.

Companion specs: the package format, load validation, live reload and QuickLook recipe are in `manifest.md` (sections
1, 8-13); flattening (what an export composites) is in `compositing.md`; window layout, the welcome screen and the
VS Code key clash table are in `ui.md` (1.8, 12); the clipboard is in `selection.md` (5.6).

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| File menu | New Canvas… ⌘N, Open Project… ⌘O, Open Recent ▸, Import Images… (no key), Save ⌘S, Save As… ⇧⌘S, Export JPEG… ⌥⇧⌘S, Export PNG… ⇧⌘E, Export As… ⌥⇧⌘W, Close Project ⌘W | `CompositorApp.swift:49-99` |
| Gate | Every project command needs `canStart` = `canStartProjectOperation` (no dialog, stroke, rename, import, alert, busy) and no tab management in progress | `IO/ProjectController.swift:13-15`, `Document/EditorSession.swift:151-153` |
| Windows | One window, projects in tabs. New Canvas always opens a new tab; Open opens one tab per project (or selects the tab already showing it) | `Document/ProjectWorkspace.swift:72-107` |
| New canvas | Width/Height (default 1920 × 1080), presets (12), Transparent/White/Black, px/in/cm/mm, 72/300 DPI; whole pixels 1-30,000 per side; Create makes one undo step "New Canvas" | `UI/NewCanvasSheet.swift`, `Document/EditorSession.swift:1040-1067` |
| Save | First save asks (panel "Save Project", `Untitled.comp`); package written in the background by atomic package swap with `QuickLook/Preview.jpg`; version 14 | `IO/ProjectController.swift:26-38, 213-262`, `IO/ProjectStore.swift:89-141` |
| Import | JPEG, PNG, HEIC/HEIF, TIFF, WebP, OpenEXR, Radiance HDR, PSD/PSB (by `8BPS` magic), camera RAW (develop sheet first), SVG (rasterized once), folders (direct children, Finder order). One undo step per batch "Import Images" / "Import Photoshop File" | `IO/ProjectStore.swift:10-15`, `Document/EditorSession.swift:818-936` |
| Deep pixels | >8-bit sources become 16-bit layers (saved as 16-bit PNG); float sources brighter than white (peak > 1.001) become HDR layers (saved as EXR); others 8-bit sRGB | `IO/ImageImporter.swift:110-136`, `Document/DeepLayers.swift:166-187` |
| RAW | Sheet "Develop “<file>”": Exposure, Temperature, Tint, Boost, Noise Reduction, Lens Correction, Highlight Recovery; 800 px draft preview; import develops the full frame at 16 bits | `UI/RawDevelopSheet.swift`, `IO/RawImporter.swift` |
| PSD | 8-bit RGB/CMYK, raw and PackBits; layers, folders, masks, clipping, 24 blend modes, Levels/Curves/Hue-Sat, editable text, live rect/ellipse shapes; a report sheet "Open “<file>”?" lists every conversion before anything is applied. **Compositor never writes PSD** | `IO/PSD/*`, `UI/PSDConversionSheet.swift`, `CompositorTests/PSDFixture.swift:5` |
| Export PNG | Flattened 8-bit sRGB PNG with alpha and DPI, straight to a save panel | `IO/ProjectController.swift:44-54` |
| Export As | Sheet: JPEG/PNG + More (TIFF, PDF, EXR with an HDR layer), linked size + scale, Quality (JPEG, default 85 %, remembered), 16-bit (PNG), RGB/CMYK (JPEG, TIFF, PDF), Background (JPEG, PDF, CMYK TIFF), live re-encoded preview with byte size | `UI/ExportAsSheet.swift`, `IO/ImageExporter.swift` |
| Limits | 30,000 px per side; 200 MP per surface/export; document pixel budget `min(800 MP, max(200 MP, RAM/16))` = **800 MP on this 24 GB Mac** (measured) | `Document/DocumentLimits.swift` |
| Live reload | Kernel events, 300 ms coalescing, content digest; reload in place; "Revert / Keep Mine" when there are unsaved edits | `IO/ProjectWatcher.swift`, `IO/ProjectController+ExternalChanges.swift`; `manifest.md` 12 |
| Engine today | Has `render` (flatten to PNG) and session ops; **no import, export-format, PSD, RAW or project-create ops yet**, and it reports `String(describing: error)`, which turns every `LocalizedError` into its case name (`invalid`, `tooLarge`) instead of the message (measured) | `engine/Sources/EngineMain.swift:29` |
| Port today | `newBoard` (save dialog → InputBox "WxH" → QuickPick White/Transparent), Open (folder picker), Recent (8, side bar welcome only), autosave, polling reload. No File menu in the board, no import, no export, no drop handling | `vscode-extension/extension.js:670-719`, `media/board.js:1068-1126` |

---

## 1. Shared machinery

### 1.1 The gate

`ProjectController.canStart` (`IO/ProjectController.swift:13-15`) = `session.canStartProjectOperation && workspace?.isManaging != true`, where (`Document/EditorSession.swift:151-153`):

```swift
selectionAmountOperation == nil && colorRange == nil && textDraft == nil && !isProjectBusy && !isImporting && brushStroke == nil
&& warpStroke == nil && levels == nil && !showsNewDocument && !showsImporter && renamingLayerID == nil && importError == nil
&& adjustmentEditingID == nil && !showsConversionSheet
```

`begin()` (`IO/ProjectController.swift:18-24`) is the common prologue of Save, Export, Open (single-window path),
New and Close: it checks the gate, **cancels an active crop, commits an active transform**, and sets
`isProjectBusy = true` (the status bar shows "Working…" with a spinner only after 250 ms,
`Document/EditorSession.swift:131-148`).

File requests that arrive while the gate is closed (Finder opens, drops, imports) wait in `waitForFileRequest()`
(`Document/EditorSession.swift:155-159`) and run when it opens.

**Board equivalent.** One predicate `canStartFileOperation()` in `board.js`: a document is loaded, `!view.busy`, no
filter panel, Color Range, selection-amount panel, text edit, layer rename or File sheet open, no engine request of
kind import/export in flight, no alert showing. File-menu items and drops use it; the extension queues
Explorer-originated imports until the board reports it is free (a `fileReady` message).

### 1.2 Limits (`Document/DocumentLimits.swift`)

| Limit | Value | Where it bites |
|---|---|---|
| `maxSide` | 30,000 px | canvas, layer, mask, import, export, RAW, SVG, PSD canvas |
| `maxSurfacePixels` | 200,000,000 | export render (`IO/ImageExporter.swift:27-28`), Export As scale, PSD canvas (`IO/PSD/PSDReader.swift:41-44`) |
| `documentPixelBudget` | `min(800_000_000, max(200_000_000, physicalMemory / 16))` | sum of layer asset pixels (masks counted separately on load) for imports and loads |
| this Mac | 25,769,803,776 B RAM → budget **800,000,000**, message says "800-megapixel" **(measured)** | an 8 GB Mac gives 536,870,912 → "536-megapixel" |
| PSD | ≤ 10,000 layer records, ≤ 56 channels per layer | `IO/PSD/PSDReader.swift:84-86, 153-154` |
| QuickLook | canvas ≤ 50,000,000 px | `IO/ImageExporter.swift:92` |
| Package | manifest ≤ 4 MiB, each image file ≤ 512 MiB, ≤ 10,000 layers, ≤ 1,000 guides | `IO/ProjectStore.swift:119, 157, 175, 221, 274` |

The board itself is further bounded by Chromium: a 2D canvas above about 268 MP (16,384²) or 32,767 px per side
cannot be allocated. The existing `parseSize` cap of 100 MP area (`extension.js:707`) is a board limit, not
Compositor's (Compositor has no area cap on New Canvas). Keep a board cap, but state it as the board's, see 16.

### 1.3 Alerts and messages (all verbatim)

| Context | Title | Text | Buttons | Ref |
|---|---|---|---|---|
| Open fails | Couldn’t open the project | the error's `localizedDescription` | OK (warning style) | `IO/ProjectController.swift:307-310, 356-363` |
| Open, project deleted | Couldn’t open the project | `The file “<name>.comp” doesn’t exist.` **(measured** for `CocoaError(.fileNoSuchFile, NSFilePathErrorKey:)`**)** | OK | `IO/ProjectController.swift:284-289` |
| Several `.comp` in one delivery (single-window path only) | Open one project at a time | This is not a valid Compositor project, or its metadata is damaged. | OK | `IO/ProjectController.swift:398-400` |
| Save fails | Couldn’t save the project | reason | OK | `IO/ProjectController.swift:253-256` |
| Export PNG fails | Couldn’t export PNG | reason | OK | `IO/ProjectController.swift:53` |
| Export As fails | Couldn’t export | reason | OK | `IO/ProjectController.swift:91` |
| Unsaved changes | Save changes to <file name or "Untitled">? | Your changes will be lost if you don’t save them. | Save, Cancel, Don’t Save | `IO/ProjectController.swift:341-354` |
| External change with unsaved edits | “<file name>” was changed on disk. | Another app changed this project. You can revert to the version on disk, losing your unsaved changes, or keep what you have. | Revert, Keep Mine | `IO/ProjectController+ExternalChanges.swift:89-96` |
| Import errors | Import couldn’t finish | `session.importError` (lines joined) | OK | `ContentView.swift:292-296` |

`ProjectError` texts (`IO/ProjectStore.swift:69-80`):

| Case | Text |
|---|---|
| `invalid` | This is not a valid Compositor project, or its metadata is damaged. |
| `version(N)` | This project uses format version N. This app supports versions 1–14. |
| `missingImage` | An image inside the project is missing or damaged. The current document has not been replaced. |
| `tooLarge` | This project exceeds the supported canvas, layer, file-size, or 800-megapixel document limit. |
| `encode` | An image could not be saved. The previous project has not been replaced. |

`ImageImportError` (`IO/ImageImporter.swift:45-54`): `unreadable` "The image could not be read. It may be damaged or
unavailable."; `unsupported` "Choose a JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) file."; `tooLarge` "This
import exceeds the current 800-megapixel document budget or 30,000-pixel side limit." (`formatted()` gives
"30,000", measured).

`PSDError` (`IO/PSD/PSDTypes.swift:5-16`): `truncated` "The Photoshop file could not be read. It may be damaged or
incomplete."; `unsupportedVersion` "This Photoshop file uses a format version Compositor can’t read.";
`unsupportedColorMode` and `unsupportedDepth` "Only 8-bit RGB and CMYK Photoshop files can be imported.";
`unsupportedCompression` "This Photoshop file uses a layer compression method that isn’t supported."

`ExportError` (`IO/ImageExporter.swift:6-15`): `tooLarge` "Image export supports canvases up to 200 megapixels and
30,000 pixels per side."; `render` "The canvas could not be rendered. Try a smaller canvas."; `encode` "The image
could not be encoded."

`CMYKError.notCMYK` "That profile isn’t a CMYK output profile." (`IO/CMYK.swift:187-190`).

**Board equivalent.** Modal warnings: `vscode.window.showWarningMessage(title, { modal: true, detail: text })` for
the OK-only alerts (VS Code supplies the dismiss button), and `showWarningMessage(title, { modal: true, detail },
'Save', 'Don’t Save')` (VS Code adds Cancel) for the unsaved prompt; `'Revert', 'Keep Mine'` for the conflict.
The engine must hand back `localizedDescription` (section 15.1), or none of the texts above reach the board.

### 1.4 Undo names

`DocumentHistory.begin` records the **outermost** name only (`Document/DocumentHistory.swift:54-75`); an edit that
changes nothing records no step. File-related names: "New Canvas" (`Document/EditorSession.swift:1043`), "Import
Images" / "Import Photoshop File" (batch, `:855-856`; the inner "Import Image" at `:939` and "Import Photoshop File"
at `:1002` never show), "Copy Layers from Project" (`Document/ProjectWorkspace.swift:281`), "Paste". Opening, saving
and exporting are not undoable; opening or reloading clears history (`Document/EditorSession+Projects.swift:33`).

---

## 2. The File menu and its shortcuts

`CompositorApp.swift:49-99`. Every chord is remappable in Edit › Keyboard Shortcuts (`configuredKeyboardShortcut`,
definitions `UI/KeyboardShortcuts.swift:88-92`; modifier codes 1 = ⌘, 9 = ⇧⌘, 11 = ⌥⇧⌘).

| Item | Default | Enabled when | Action | Checklist |
|---|---|---|---|---|
| New Canvas… | ⌘N | `projects.canStart` | `showEditor()`, then `projects.newCanvas()` → `workspace.newCanvas()`: commits a transform, adds a tab (never reusing the current one) | "New Canvas… menu item", "Keyboard shortcuts › Menus › New Canvas: ⌘N" |
| Open Project… | ⌘O | `canStart` | `projects.open()` → `workspace.open()` (section 4) | "Open Project… menu item", "Keyboard shortcuts › Menus › Open Project: ⌘O" |
| Open Recent ▸ | – | submenu disabled unless `canStart` | one item per recent project, titled `url.deletingPathExtension().lastPathComponent`; divider; "Clear Menu" (disabled when empty) | "Open Recent › Submenu", "Clear Menu" |
| Import Images… | none | `levels == nil && !showsBusy && !isImporting && !showsNewDocument` (not the full gate) | `session.showsImporter = true` | "Import Images… menu item" |
| Save | ⌘S | `document != nil && canStart` | `projects.save()` | "Save menu item", "Keyboard shortcuts › Menus › Save: ⌘S" |
| Save As… | ⇧⌘S | same | `projects.save(asNew: true)` | "Save As… menu item", "Keyboard shortcuts › Menus › Save As: ⇧⌘S" |
| — | | | | |
| Export JPEG… | ⌥⇧⌘S | same | `projects.exportAs(start: .jpeg)` | "Export JPEG… menu item", "Keyboard shortcuts › Menus › Export JPEG" |
| Export PNG… | ⇧⌘E | same | `projects.exportPNG()` | "Export PNG… menu item", "Keyboard shortcuts › Menus › Export PNG: ⇧⌘E" |
| Export As… | ⌥⇧⌘W | same | `projects.exportAs()` | "Export As… menu item", "Keyboard shortcuts › Menus › Export As: ⌥⇧⌘W" |
| — | | | | |
| Close Project | ⌘W | `canStart` | `projects.close(window)` → `workspace.close(tab)` | "Close Project menu item", "Keyboard shortcuts › Menus › Close Project: ⌘W" |

Note that "Disabled with no document or while busy" in the checklist for the export items means exactly
`document == nil || !canStart`. Import Images… uses `showsBusy` (the 250 ms-delayed flag), so a quick operation does
not flicker it off.

Two View items are File-related because Export As borrows them (`CompositorApp.swift:117-133`): **"Fit Canvas: ⌘0;
zooms a dialog's preview instead when one is open (Export As)"** and **"Actual Pixels: ⌘1; redirects to dialog
preview when open"**; Zoom In ⌘= and Zoom Out ⌘- likewise, except when a text field is first responder.

**"Keyboard shortcuts › Menus › Paste: ⌘V; order: …"** and **"Edit › Clipboard › Paste (⌘V) priority"**
(`CompositorApp.swift:223-232`):

```swift
if session.canPasteImageAsNewCanvas { Task { await session.pasteImageAsNewCanvas() } }
else if NSApp.keyWindow?.firstResponder is NSTextView { NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil) }
else if applicationDelegate.workspace.pasteCopiedLayer() { }
else if session.canPaste { session.paste() }
else { NSSound.beep() }
```

The first branch is section 3.10; the rest is `selection.md` 5.6.

The board's key handling for these chords is in 14.6.

---

## 3. New canvas

### 3.1 Where it appears

- **"Welcome screen: the New canvas sheet fills the canvas area whenever the tab has no document"**
  (`ContentView.swift:103, 344-348`). It is not a modal sheet: it is the content of an empty tab.
- **"New Canvas… menu item"**: opens a **new tab** showing it, never reusing the current tab
  (`Document/ProjectWorkspace.swift:72-76` calls `addTab(reuseEmpty: false)`); blocked unless `canSwitch`
  (`:26-30`: `canStart`, and no Hue/Saturation, filter, gradient, pixel move or color picker).
- **"Toolbar "+" New canvas button"**: leftmost toolbar item, SF `plus`, label "New canvas", tooltip
  "New canvas (⌘N)", accessibility id `newCanvasToolbar`; same action; disabled when
  `session.isImporting || session.showsBusy || session.levels != nil` (`ContentView.swift:182-186`). It is also a
  drop target for new tabs (App-level, not in this spec).
- The first tab at launch skips the clipboard size suggestion (`Document/ProjectWorkspace.swift:31-36`,
  `skipsInitialClipboardCanvasSize`).

### 3.2 Layout (`UI/NewCanvasSheet.swift:92-180`)

```
┌──────────────────────────── max width 500, padding 28, spacing 24 ────────────────────────────┐
│ New canvas                                                                          ⋮          │  title2 semibold; ⋮ = presets
│                                                                                                 │
│ Width                                   ×        Height                                         │  labels: callout medium
│ ┌────────────────────────────┐                  ┌────────────────────────────┐                  │  field: plain text, padding 12,
│ │1920                     px │                  │1080                     px │                  │  quaternary 50 %, radius 7
│ └────────────────────────────┘                  └────────────────────────────┘                  │  × = SF multiply, tertiary
│ Transparent canvas · Pixels · 72 DPI                                                            │  callout, secondary; pills
│ Enter whole numbers from 1 to 30,000 pixels.                                                    │  orange, only when invalid
│ [Open project] [Import image]                                              [Create canvas]      │  bordered / borderedProminent
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **"Title "New canvas""** (`:96`), `.title2.weight(.semibold)`.
- Presets button: three vertical dots (2.5 pt circles, 2.5 spacing), 28 × 28 frame aligned trailing, plain menu
  button without indicator; tooltip "Preset sizes for screens and common formats"; accessibility label
  "Preset sizes" (`:99-121`).
- **"Width field"**: `TextField("Width")` (the placeholder is the title), default `"1920"`, unit suffix
  (`unit.rawValue`: `px`, `in`, `cm`, `mm`) in secondary color; focused on appear (`:178`); accessibility id
  `widthInput`. **"Height field"**: default `"1080"`, id `heightInput`; the `×` glyph sits between, padded 20 pt from
  the top so it lines up with the fields (`:126`).
- The whole sheet is disabled while `session.isImporting || session.showsBusy` (`:168`), **"Sheet disabled while an
  import or long operation runs"**.

### 3.3 Parsing and units (`UI/NewCanvasSheet.swift:6-42`)

```swift
func pixels(_ text: String, resolution: Double) -> Int? {
    guard let value = Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")),
          value.isFinite, value > 0 else { return nil }
    let pixels = perInch.map { (value / $0 * resolution).rounded() } ?? value
    guard pixels == pixels.rounded(), (1...Double(DocumentLimits.maxSide)).contains(pixels) else { return nil }
    return Int(pixels)
}
func text(_ pixels: Int, resolution: Double) -> String {
    guard let perInch else { return String(pixels) }
    return (Double(pixels) / resolution * perInch).formatted(.number.precision(.fractionLength(0...2)).grouping(.never)
        .locale(Locale(identifier: "en_US_POSIX")))
}
```

`perInch`: px nil, in 1, cm 2.54, mm 25.4. "," is accepted as the decimal separator (every comma replaced, so
"1,920" reads as 1.92). Pixels must be whole (`"19.5"` fails); print units are rounded to whole pixels.
Swift's `Double(String)` also accepts `"1e3"` (1000) and `"0x10"` (16) **(measured)**; a JS port using `Number()`
matches those, but must reject what Swift rejects: `"0b11"`, `"0o7"`, `"1_000"`, empty strings (`Number("") === 0`
fails the `> 0` test anyway).

Measured `text()` outputs: 1920 px @72 → in `"26.67"`, cm `"67.73"`; 1080 px @72 → mm `"381"`; 30000 px @300 → in
`"100"`; 2550 @300 → in `"8.5"`; 2480 @300 → mm `"209.97"` (upstream test).

### 3.4 Validation

- **"Size validation"**: valid when both fields parse (`valid = pixelWidth != nil && pixelHeight != nil`, `:72-74`).
  There is no area limit.
- **"Validation message"** (`:149-153`), callout, orange, shown only while invalid:
  - pixels: `Enter whole numbers from 1 to 30,000 pixels.`
  - in/cm/mm: `Enter a size up to 30,000 pixels at this DPI.`
- Create canvas is disabled while invalid (`:164`).

### 3.5 Presets (`UI/NewCanvasSheet.swift:237-265`)

**"Preset sizes menu"**: an inline picker: "Custom" (tag nil), then three groups, each preceded by a divider. The
checked item is the preset whose pixel size equals the current fields' pixel size (so 1920 × 1080 shows "1080p"
checked at start); choosing one fills both fields **in the current unit** (`setPixels`, `:88-91, 182-185`).
Choosing "Custom" does nothing.

| Group | Title | W × H |
|---|---|---|
| Resolutions | **"Preset "4K""** | 3840 × 2160 |
| | **"Preset "1440p""** | 2560 × 1440 |
| | **"Preset "1080p""** | 1920 × 1080 |
| Apple screens | **"Preset "iPhone 18 Pro""** | 1206 × 2622 |
| | **"Preset "iPhone 18 Pro Max""** | 1320 × 2868 |
| | **"Preset "MacBook Pro 14\"""** | 3024 × 1964 |
| | **"Preset "MacBook Pro 16\"""** | 3456 × 2234 |
| | **"Preset "Studio Display""** | 5120 × 2880 |
| Social | **"Preset "Instagram Square""** | 1080 × 1080 |
| | **"Preset "Instagram Portrait""** | 1080 × 1350 |
| | **"Preset "Instagram Story""** | 1080 × 1920 |
| | **"Preset "YouTube Thumb""** | 1080 × 608 |

### 3.6 Pills (`UI/NewCanvasSheet.swift:129-147, 217-235`)

`CyclePill`: plain text in secondary color, monospaced digits, padding 6 × 2; a quaternary capsule appears on hover;
a click steps to the next value. Separated by `·`.

- **"Background pill"**: `Transparent canvas` → `White canvas` → `Black canvas` → (title is
  `"\(rawValue.capitalized) canvas"`); default Transparent; tooltip "Start see-through, or with a white or black
  Background layer. Click to switch."; id `canvasBackground`. Colors: white `CGColor(srgbRed: 1, 1, 1, 1)`, black
  `(0, 0, 0, 1)`.
- **"Units pill"**: `Pixels` → `Inches` → `Centimeters` → `Millimeters` → Pixels; always starts at Pixels
  (`@State unit = .pixels`, `:64-66`); tooltip "Units: pixels, inches, centimeters or millimeters. Click to
  switch."; id `canvasUnit`. **Switching converts the typed values** so the canvas is unchanged (`switchUnit`,
  `:80-86`; only when both fields are currently valid, otherwise the texts stay as typed).
- **"Resolution pill"**: `72 DPI` ⇄ `300 DPI` (`resolution == 300 ? 72 : 300`), default 72; id
  `canvasResolution`. Tooltip `Resolution: 72 for screens, 300 for print. Click to switch.` plus, in print units
  with valid fields, ` · 300 DPI: 2550 × 3300 pixels` (`:75-78`). In print units the DPI changes the pixel count
  (the typed text stays); in pixels it is only stored.
- **"Stored resolution"**: `createDocument` clamps: `(1...9600).contains(resolution) ? resolution : 72`
  (`Document/EditorSession.swift:1045`); written as `resolution` in the manifest.

### 3.7 **"Clipboard size suggestion"** (`UI/NewCanvasSheet.swift:169-202`)

Once per sheet instance, on appear (unless it is the launch tab): for the pasteboard types PNG then TIFF, read
`kCGImagePropertyPixelWidth/Height`; EXIF orientation 5-8 swaps them; each side must pass
`CanvasDocument.validDimension` (an integer 1-30,000); the first that passes fills the fields via `setPixels` (in
the current unit, which is Pixels on appear). The width field is then focused.

### 3.8 Buttons

- **""Open project" button"**: `onOpen` → `projects.open()` (`ContentView.swift:347`).
- **""Import image" button"**: `session.showsImporter = true` (the Import Images picker, section 6.1).
- **""Create canvas" button"**: `.configuredNativeShortcut(.return)` (the remappable "Apply current canvas operation"
  assignment), `.borderedProminent`, id `createCanvas`, disabled while invalid. Runs
  `session.createNewProject(width:height:resolution:background:)` (`Document/EditorSession+Projects.swift:69-73`):
  refuses when busy or importing or a side is out of range; `clearProject()` (history reset); then
  `createDocument(…, emptyLayer: true, …)` inside `beginEdit("New Canvas")`, fits the viewport,
  `showsNewDocument = false`.

### 3.9 **"First layer"** (`Document/EditorSession.swift:1057-1067`)

- Transparent: `ImageLayer(name: "Layer 1", blankSize: size)`: no pixels allocated (manifest: no `imageFile`),
  selected (`activeLayerID`).
- White or Black: a full-size RGBA8 sRGB raster filled with the color, layer named **"Background"**, with asset;
  if allocation fails it falls back to the blank "Layer 1".
- The document has no file yet; the tab title stays "Untitled" / "Untitled N" until saved.
- Quirk: the step is undoable; "Undo New Canvas" brings back the welcome screen (document nil).

### 3.10 Paste on the New canvas screen

**"Edit › Clipboard › Paste on the New canvas screen"** (`Document/SelectionClipboard.swift:172-202`):

```swift
var canPasteImageAsNewCanvas: Bool {
    guard document == nil, !isProjectBusy, !isImporting else { return false }
    let pasteboard = Self.pasteboard
    if let text = pasteboard.string(forType: .string), CanvasDocument.validDimension(text) != nil { return false }
    return !copiedImageFiles(pasteboard).isEmpty || pasteboard.availableType(from: [.png, .tiff]) != nil
}
```

- A copied size number (a string that is an integer 1-30,000 after trimming spaces) wins: the paste goes to the
  focused text field instead.
- Finder-copied files: `readObjects(forClasses: [NSURL], .urlReadingFileURLsOnly)`, kept when the extension's UTType
  conforms to `public.image` or the extension is `psd`; all of them go through `importImages(files)` (so several
  copied images become one canvas sized by the first, with the rest as layers; RAW files get the develop sheet,
  PSDs the report).
- Raw PNG or TIFF data: written to `<tmp>/<UUID>/Pasted Image.png|tiff`, imported (16 bits kept, color converted,
  layer named **"Pasted Image"**), the folder removed afterwards. A write failure sets `importError` to the error
  text.
- The canvas gets the image's size at 72 DPI and one undo step "Import Images".

### 3.11 Port: the New Canvas form

Replace the InputBox/QuickPick flow in `newBoard` (`extension.js:674-701`) with the form above, rendered in a
webview:

- **Editor area**: `compositorBoard.new` opens a plain `WebviewPanel` titled "New Canvas" (viewType
  `compositorBoard.newCanvas`) in the active column, showing the form; ⌘V in it runs 3.10.
- **Side bar**: the welcome view (`board.js:156-172`, `showWelcome`) shows the same form above the Recent list,
  keeping its "Open Project…" button (renamed "Open project" to match) and adding "Import image".
- **Create canvas** posts `{ type: 'createCanvas', width, height, resolution, background: 'transparent'|'white'|'black' }`.
  The extension asks where to put it (14.3, "Save Project", default the lowest free `Untitled.comp`,
  `Untitled 2.comp`, … in the workspace folder, matching `Document/ProjectWorkspace.swift:39-43`), calls
  `manifests.createProject(root, { width, height, resolution, background: [r,g,b,255] | null })` (it already writes
  "Layer 1"/"Background" exactly as 3.9, version 14, `colorSpace` sRGB), then opens the board in the same column and
  disposes the form panel. The side-bar form shows the board in the side bar instead.
- Clipboard size suggestion and paste-as-canvas need the macOS pasteboard (PNG/TIFF properties, file URLs), which a
  webview cannot read: use engine `clipboard.inspect` and `project.fromClipboard` (15.2). Skip the suggestion the very
  first time the side bar welcome shows after activation (the launch-tab rule).
- Validation, presets, pill cycling and unit conversion run in the webview (pure JS, section 3.3 formulas).
- Decision for the user: whether to keep "ask the location at Create" (recommended; boards are always backed by a
  package that autosave writes) or to create untitled boards in `context.globalStorageUri` and ask on first ⌘S
  (closer to upstream, but the tab shows a storage path and Save must be intercepted). See 16.

---

## 4. Open, Open Recent, Close Project, tabs

### 4.1 Open Project (`Document/ProjectWorkspace.swift:77-107`, `IO/ProjectController.swift:264-311`)

- **"Open panel"**: `NSOpenPanel`, `allowedContentTypes = [.compositorProject]`,
  `allowsMultipleSelection = true`, `treatsFilePackagesAsDirectories = false` (so `.comp` packages show as files),
  no title in the tabbed path. Each chosen URL goes through `loadProject` in order.
- **"Already-open project"**: a tab whose `projectURL` resolves (symlinks resolved) to the same path is selected
  instead of loading again (`:96-99`).
- **"Validate before replacing"**: the project loads into an **unattached** new tab first
  (`tab.controller.open(url)`), which runs `ProjectStore.load` (full validation, off the main actor) before anything
  changes; a failure shows the alert and the tab is discarded, so **no broken tab** (`:100-103`). The live document of
  any other tab is never touched.
- **"Blank start tab replaced"**: when the window's only tab is empty (`document == nil`), it is removed after the
  successful load (`:104`).
- **"Missing file"** (`IO/ProjectController.swift:284-289`): when the path no longer exists (an Open Recent entry
  deleted in Finder): `RecentProjects.shared.refresh()`, then the alert "Couldn’t open the project" /
  `The file “<name>.comp” doesn’t exist.` (measured text).
- **"Error alert"** and the four **"Error text"** lines: 1.3. Which error fires: not a directory, unreadable or
  non-JSON manifest, wrong `format`, failed decode or validation → `invalid`; version outside 1-14 →
  `version(N)`; an image file missing, not PNG/EXR as declared, wrong bit depth, more than one frame → `missingImage`;
  size, layer count, guide count, file size or pixel budget exceeded, or a symlink / path outside the package →
  `tooLarge` (`IO/ProjectStore.swift:154-296`, details in `manifest.md` 9).
- **"After opening"** (`Document/EditorSession+Projects.swift:21-35`): `collapsedGroupIDs = []` (all folders
  expanded), mask target off, crop cancelled, transform dropped, `CanvasDocument` built with the manifest's
  `documentID`, size, layers, `resolution ?? 72`, `guides ?? []`; `activeLayerID` from the manifest;
  `projectURL` set (tab title becomes the file name); history reset; viewport fitted.
- **"Recorded in Open Recent and the project starts being watched"**: `RecentProjects.shared.note(url)`,
  `rememberProjectDigest`, `watchProject` (`IO/ProjectController.swift:302-305`).
- **"Confirm replacing (single-window path)"** (`:295-301`): only in the non-workspace path (a controller without a
  workspace). There the "Save changes…" prompt runs before replacing, and if that save rewrote the very file being
  opened, it is loaded again. In the tabbed app a new tab is always used, so the prompt never appears on Open.
- **"Several .comp files delivered in one request … "Open one project at a time""** (`:393-401`): also only the
  single-window path; the tabbed app's `workspace.receive` opens each `.comp` in its own tab
  (`Document/ProjectWorkspace.swift:174-175`). Dead in 1.5.3; see quirks.

### 4.2 Open Recent (`IO/RecentProjects.swift`)

- **"Source of the list"**: `NSDocumentController.shared.recentDocumentURLs` (the system list also shown in the Dock
  menu); its length is the system's recent-items setting; no app key.
- **"Missing projects hidden"**: filtered with `FileManager.fileExists`; refreshed at init, on every note/clear and on
  every `didBecomeActiveNotification`.
- **"Updated on every successful open and save"**: `note(url)` after a successful load
  (`IO/ProjectController.swift:303`) and after every successful save (`:249`).
- **"Submenu"**: titles without `.comp`; choosing one runs `projects.open(url)` (which in the tabbed app is
  `workspace.open(url)`).
- **"Clear Menu"**: `clearRecentDocuments(nil)`; disabled when the filtered list is empty; the whole submenu is
  disabled unless `canStart`.
- Persisted-settings line **"Recent projects: kept by macOS NSDocumentController…"** is the same mechanism.

### 4.3 Close Project (`Document/ProjectWorkspace.swift:44-47, 108-121`, `IO/ProjectController.swift:321-354`)

- **"Close Project menu item"**: `workspace.close(current tab)`; requires `canSwitch` and `canClose(tab)`;
  `isManaging = true` while it runs; then `controller.confirmQuit()` (`begin()`, `confirmReplacement()`).
- **"Last blank tab can't close"**: `canClose` is false for the only tab when it has no document and was never saved.
- **"Closing the last tab leaves a fresh empty "Untitled" tab"** (`removeTab`: `addTab(reuseEmpty: false)` when the
  array becomes empty; otherwise the selection moves to the tab now at the same index, or the last).
- **"Unsaved-changes prompt"**: when `isModified && document != nil`; texts in 1.3; Save runs a normal save (Save
  panel when the project has no file) and the tab closes only if it succeeded; Cancel and a failed save keep it;
  Don’t Save closes.
- **"Waits for an in-flight background save before prompting or closing"**: `confirmReplacement` first awaits
  `finishWriting()`.

### 4.4 Port

| Upstream | VS Code |
|---|---|
| Open Project… | `compositorBoard.open` (exists; retitle "Open Project…" in the board's File menu). Use the dialog in 14.3 (files **and** folders, `canSelectMany: true`), then for each root: engine `project.inspect` first; on error show "Couldn’t open the project" with the message and open nothing; otherwise `provider.moveToEditor(root)` (exists; `vscode.openWith` reveals an open tab, `supportsMultipleEditorsPerDocument: false`) |
| Already-open | already satisfied by `openWith` and by the side-bar → editor move (`extension.js:477-480`) |
| Validate before replacing | replace the in-board `fatal` message (`extension.js:294`) by the pre-open `project.inspect`; keep `fatal` as a fallback for a package that breaks between the check and the load |
| Missing file | `fs.existsSync(manifest)` false → modal "Couldn’t open the project" / `The file “<name>.comp” doesn’t exist.`, remove it from the recent list |
| After opening | the board's `load` must fit the view, expand all folders, take `activeLayerID`, guides and resolution from the manifest, and start with an empty history (it does most of this today; check folder expansion) |
| Open Recent | `compositorBoard.openRecent` QuickPick: one item per existing entry, label = name without `.comp`, description = parent folder; a last item `$(clear-all) Clear Menu` (hidden when empty). The side bar welcome keeps its list. Store in `globalState['compositorBoard.recent']` (exists), **10** entries (macOS default recent-items count; today 8), updated on open (`track`, exists) **and** on Save As and on create. It cannot share the Compositor app's list: that list lives in the sandboxed app's shared-file-list store, written by `NSDocumentController` in the app's process |
| Close Project | VS Code's own ⌘W closes the tab. The board's File › Close Project posts `closeBoard`: editor → `tabGroups.close(tab)`; side bar → `sidebar.release()` (exists). With autosave the document is clean; with `autosaveDelay` 0 and a dirty board, show the upstream prompt (1.3) ourselves before closing: Save → `flush`, Don’t Save → `revertCustomDocument` then close |
| Last blank tab / fresh Untitled tab | not applicable (no blank board tabs); the side bar's welcome is the empty state |

---

## 5. Save and Save As

### 5.1 Save (`IO/ProjectController.swift:26-38, 207-262`)

- **"Save menu item"**: ⌘S; disabled with no document or unless `canStart`.
- **"Serialized saves"**: `save()` first awaits a write still running (`finishWriting()`); so do close, quit and
  replace.
- **"Pending canvas edits settled first"**: `begin()` cancels crop and commits transform.
- **"First save asks where"** (`prepareSave`, `:213-233`): `NSSavePanel`, `allowedContentTypes = [.compositorProject]`,
  `canCreateDirectories = true`, `isExtensionHidden = false`, `nameFieldStringValue =
  projectURL?.lastPathComponent ?? "Untitled.comp"`, title `"Save Project"` (or `"Save Project As"` for Save As),
  as a sheet on the window.
- **"Background save"**: the revision (`history.currentRevision`) and `projectSnapshot()` are captured, `isProjectBusy`
  is released, and a `Task` writes the package while editing continues.
- **"Package written"** (`IO/ProjectStore.swift:89-129`): `validate(manifest)`; for each layer, image then mask:
  masks must be valid 8-bit gray (`LayerMask.isValid`), sizes within side and budget; images encoded as PNG, or
  OpenEXR when the file name ends `.exr` (HDR layers, `ImportedImage.file(for:)`), from `DeepLayer.flattened(asset)`
  (16-bit / HDR full pixels) or the 8-bit image; manifest JSON `[.prettyPrinted, .sortedKeys]`, version 14,
  `colorSpace` "sRGB", at most 4 MiB. Layout and key list: `manifest.md` 8.
- **"Save-time limits"**: any failure throws before the package is replaced; the previous file stays.
- **"Atomic replace"**: `NSFileCoordinator(writingItemAt:options: .forReplacing)` + `FileWrapper.write(…, .atomic)`:
  Foundation stages a sibling package and swaps it in. **Every other file in the package is deleted** by the swap.
- **"QuickLook preview written into the package on every save"**: section 12.
- **"Saved state"**: on success `history.markSaved(revision)` (the captured one); edits made during the write keep the
  document modified; undoing back to the saved revision reads as unmodified (`Document/DocumentHistory.swift:38-44`).
- **"After save"**: `projectURL = destination` (tab title), `RecentProjects.note`, digest remembered, watch
  (re)started; `externalChanges.saving` suppresses the watch during the write.
- **"Error alert "Couldn’t save the project""** with the reason (e.g. `ProjectError.encode`).

### 5.2 Save As

- **"Save As… menu item"**: ⇧⌘S; always shows the panel, titled "Save Project As", prefilled with the current file
  name; afterwards `projectURL` is the new location, so later saves go there. The old package keeps its last saved
  state.

### 5.3 Port

- ⌘S in an editor board is VS Code's Save → `saveCustomDocument` → `write()` (exists). The side bar posts `saveNow`
  (exists). Autosave (`compositorBoard.autosaveDelay`, default 800 ms) writes long before a user would press ⌘S;
  that is a deliberate adaptation (Claude and Compositor read the disk).
- "First save asks where": not applicable while every board is created with a location (3.11).
- "Background save", "Serialized saves": `document.saving` promise chain (exists).
- "Package written": `core/package-io.writeProject` writes images (temp + rename each), then the manifest, removes
  unreferenced images **and the `QuickLook` folder**, under a sibling `.lock` file (`core/package-io.js:127-154`).
  This differs from Compositor's package swap; it is the safe protocol for writing while Compositor watches
  (`upstream/docs/writing-comp-files.md`). Keep it, and restore QuickLook as in 12.2.
- "Save-time limits": `manifests.validate` before writing (exists, `extension.js:444-449`); its message today is
  "Compositor would refuse this project, so it was not saved: …". Use the upstream title for the modal:
  "Couldn’t save the project" with that detail.
- **Save As**: VS Code's built-in Save As offers a path ending in `manifest.json`; `saveCustomDocumentAs`
  (`extension.js:160-164`) copies the package to `packageRoot(destination)`, which **throws** when the user types any
  path not inside a `*.comp` folder. Add `compositorBoard.saveAs` ("Save Project As…"): flush, `showSaveDialog`
  (14.3) with title "Save Project As", default `<current name>.comp` beside the current package, filter `comp`;
  the native dialog asks before replacing an existing target (then remove it first, closing its board if one is
  open); copy the package (`fs.cpSync`) and, as a port choice, the notes sidecar `<root>.notes.json` to
  `<target>.notes.json`; `remember(target)`; then open the new package in the same column and close the old tab.
  The copy keeps `documentID`, as Compositor's Save As does (the snapshot carries `document.id`). Bind ⇧⌘S to it while a board is active (14.6).
  Make `saveCustomDocumentAs` accept only destinations ending in `.comp` or `.comp/manifest.json` (append `.comp`
  when the user typed a bare name) and otherwise reject with "Save a Compositor project as a .comp package."
  (port text, not upstream).

---

## 6. Import Images

### 6.1 Entry points

- **"Import Images… menu item"**: section 2; no default shortcut.
- **"File picker"** (`ContentView.swift:284-291`): SwiftUI `.fileImporter`, `allowedContentTypes:
  UTType.importableImages + [.folder]`, `allowsMultipleSelection: true`; success → `session.importImages(urls)`
  (no point); a non-cancel failure sets `importError`.
- New canvas "Import image" button, drops (App-level), Finder Open With / Dock, paste as canvas: same pipeline.

### 6.2 **"Folders"** (`IO/ImageImporter.swift:23-43`, `Document/EditorSession.swift:818-834`)

`ImageFolder.matches`: a file URL whose extension is not `comp`, that is a directory and not a package. Its
**direct** regular, non-hidden files whose extension's UTType conforms to one of `importableImages`, sorted by
`localizedStandardCompare` ("2 Two" before "10 Ten"). Subfolders are ignored. **"Empty folder message"**:
`“<folder>” has no images to import.`, one line per empty folder, joined with "\n", appended to any existing
`importError` with "\n\n".

### 6.3 Formats (`IO/ProjectStore.swift:10-15`, `IO/ImageImporter.swift:91-138`)

`importableImages = [.jpeg, .png, .heic, .heif, .tiff, .webP, .openEXR, .radianceHDR, .photoshopImage,
.photoshopLargeImage, .rawImage, .svg]`. Dispatch order per file (`Document/EditorSession.swift:876-919`): RAW by
extension → SVG by extension → PSD by `8BPS` magic → everything else decoded by content.

| Checklist | Type id | Extensions on this Mac **(measured)** | Path |
|---|---|---|---|
| **"Format JPEG"** | public.jpeg | jpeg, jpg, jpe | decode |
| **"Format PNG, including 16-bit PNG"** | public.png | png | decode |
| **"Format HEIC and HEIF, including 10-bit HEIF"** | public.heic / public.heif | heic / heif, hif | decode |
| **"Format TIFF, including 16-bit and float TIFF"** | public.tiff | tiff, tif | decode |
| **"Format WebP"** | org.webmproject.webp | webp | decode |
| **"Format OpenEXR"** | com.ilm.openexr-image | exr | decode |
| **"Format Radiance HDR"** | public.radiance | hdr, pic | decode |
| **"Format Photoshop PSD and PSB"** | com.adobe.photoshop-image / -large-image | psd / psb | PSD reader (section 8), by magic, not extension |
| **"Format camera RAW"** | conforms to public.camera-raw-image | dng cr2 cr3 crw nef nrw arw srf sr2 raf orf rw2 raw rwl pef srw 3fr fff iiq mos mrw erf dcr (23) | develop sheet (section 7) |
| **"Format SVG"** | public.svg-image | svg, svgz | rasterized once (below) |

- **"Unsupported formats"**: `decode` reads the source's actual type and throws `unsupported` unless it conforms to
  JPEG, PNG, HEIC, HEIF, TIFF, WebP, OpenEXR or Radiance HDR (plus PSD/PSB when flattening a background-only PSD).
  GIF, BMP, ICO and so on fail with "Choose a JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) file." The
  picker does not offer them, but drops and folders can still deliver them (folders filter by extension first).
- **SVG** (`IO/ImageImporter.swift:69-88`): `NSImage(contentsOf:)`; scale = `min(canvasW / svgW, canvasH / svgH)`
  when a document exists (fitted, up or down), else 1 (declared size); size rounded, ≥ 1; side and remaining-budget
  checks; drawn flipped into an RGBA8 sRGB raster; an ordinary pixel layer named after the file.
- Decoding: `CGImageSourceCreateWithURL` (no cache), pixel size from properties, size checks **before** decoding,
  then decode.

### 6.4 Pixels

- **"EXIF orientation applied and colors converted to 8-bit sRGB"**: `CIImage.oriented(forExifOrientation:)`, then
  `createCGImage(format: .RGBA8, colorSpace: sRGB)`; 96 px thumbnail.
- **"More than 8 bits a channel"**: `bitsPerComponent > 8` → rendered RGBA16 sRGB through a half-float linear
  context, `DeepLayer.asset` → 16-bit layer shown through a dithered 8-bit copy; saved as a 16-bit PNG (manifest
  version ≥ 12).
- **"Float images"**: `floatComponents` → RGBAh in extended sRGB → `DeepLayer.wideAsset`: an HDR layer (saved as
  `.exr`, version ≥ 13) **only when its peak exceeds 1.001**; otherwise a 16-bit layer
  (`Document/DeepLayers.swift:166-178`). The checklist line says "kept as an HDR layer"; the threshold is the
  precise rule.
- **"CMYK JPEG/TIFF (or CMYK PSD) that starts a new document"** (`Document/EditorSession.swift:861-869`,
  `IO/CMYK.swift:76-96`): for the file that created the document, `CMYK.profile(ofImageAt:)` (color model CMYK →
  embedded ICC, named by its ColorSync description, else "Embedded CMYK Profile"; no ICC → "Generic CMYK Profile")
  or the PSD's profile is `CMYK.adopt`ed: matched against installed profiles by data, else copied to
  `<Application Support>/CMYK Profiles/<name>.icc`; it becomes `CMYK.chosen` (UserDefaults `cmykProfile`) and the
  session's `proofProfile`. Pixels are converted to sRGB on import as usual.

### 6.5 Placement and history

- **"First image makes the canvas"**: with no document, the request's drop point is discarded for **every** file in
  that request (`let point = document == nil ? nil : request.point`, `:858`); `insert` creates
  `CanvasDocument(width:height:)` at the first successful image's size, **72 DPI**, and fits the viewport.
- **"Placement"** (`insert`, `:938-954`): origin `floor(center − size / 2)` with center = point or canvas center;
  native pixel size; layer named after the file without extension; `parentID` = the active layer if it is a folder,
  else the active layer's parent (that folder is expanded); appended **at the top of the stack** (end of the array,
  not above the active layer); becomes active. Test vector: 64 × 32 into 128 × 128 → origin (32, 48).
- **"One undo step per import batch"**: "Import Photoshop File" when every file in the request is a PSD by magic,
  else "Import Images" (`:855-856`). A batch where nothing changed (all cancelled or failed) records nothing.
- **"Queued imports"** (`:818-849`): a stroke in progress is finished, crop cancelled, transform committed, then the
  request waits for `waitForProjectAccess()` and joins `pendingImports`; one drain loop processes requests in order,
  each a separate undo step; later requests are never lost (test `queuedImportsAreNotLost`).
- **"Size limits"**: `remainingPixels = documentPixelBudget − Σ layer asset pixels` per file; side ≤ 30,000; message
  `tooLarge` (1.3).
- **"Unreadable file error"**: `unreadable`.
- **"Per-file failures collected and shown together"**: each failure appends `"<file name with extension>: <reason>"`;
  after the loop, `importError = failures.joined(separator: "\n\n")`; the alert "Import couldn’t finish" / OK.
  Successful files still import.

### 6.6 Port

- Picker: `compositorBoard.importImages` → `showOpenDialog` (14.3, files and folders, multi, filters from engine
  `import.types`). Folders and files are passed to the engine **by path**; the engine's `ImageFolder` does the
  listing and ordering.
- Target: the current board (14.1). With no board open (side bar welcome, New Canvas form), "Import image" creates a
  new project from the images (`project.fromImages`, after asking where, default `Untitled.comp`), then opens it.
- Flow per batch: for each RAW file run the develop sheet (7.4), for each PSD the report sheet (8.4); drop cancelled
  files; then **one** `import.images` request with the remaining files, their RAW settings, `point`, the board's
  `activeLayerID` and selection (as other engine ops send them). This keeps "one undo step per batch". The engine
  result is saved by `withSession` and comes back through `pushExternal` with the edit name, exactly like filters.
- `importError` → modal "Import couldn’t finish" with the joined text.
- The board must also show what it imports: 16-bit PNG layers decode in Chromium (8-bit), but EXR layers are drawn
  hatched today (`media/document.js:46, 172-175`). An HDR import therefore needs a display image from the engine
  (DeepLayer's dithered copy) before it is useful on the board. Flag as a dependency of this spec.
- Busy text: the board's status bar shows "Importing images…" with a spinner while an import request runs (App-level
  line, `ContentView.swift:358-363`).

---

## 7. Camera RAW develop

### 7.1 Flow (`Document/EditorSession.swift:600-624, 876-888`)

- **"Size checked first"**: `RawImporter.pixelSize(url)` from ImageIO properties (nil → `unreadable`); side ≤ 30,000
  and `w × h ≤ remaining budget`, else `tooLarge`, **before** the sheet.
- **"Develop sheet"**: `developRaw(url)`: settings start from `RawImporter.asShot(url)` (or defaults); the sheet is
  presented with `rawDevelop = (url, asShot)`; `showsRawDevelop = true` closes the gate.
- **"Cancel button"**: Esc (`.cancelAction`), `finishRawDevelop(nil)` → the file is skipped (`continue`), no error.
- **"Import button"**: Return (`.defaultAction`) → `rawImporting = true`, the full frame develops off the main actor
  through `RawImporter.Queue.shared.develop(url, settings:, limit: nil, sixteenBit: true)`, becomes a 16-bit layer
  named after the file (`DeepLayer.asset`), inserted like any image (6.5).
- **"Camera Raw… button"**: tooltip "Import, then open the Camera Raw Filter"; imports the same way, then after the
  batch selects the new layer and runs `beginFilter(.cameraRaw)` (`:929-935`).
- **"Importing state"**: while `rawImporting`, an overlay "Importing…" with a spinner on the preview, every control
  disabled, `interactiveDismissDisabled`; the sheet closes in `endRawDevelop` once the layer is in (or on failure).
  `endRawDevelop` also releases the cached decoder.
- The develop failing → `unreadable` collected as a per-file failure.

### 7.2 Layout (`UI/RawDevelopSheet.swift:20-78`)

```
Develop “IMG_0420.CR3”                                         title2 bold; padding 24, fixed size
┌──────────────────────── 560 × 340, black 35 %, radius 6 ────────────────────────┐
│                 preview, aspect fit; small spinner while developing             │
└──────────────────────────────────────────────────────────────────────────────────┘
Exposure          [────────●────────] 0.00 EV        label 110 pt, slider 300 pt,
Temperature       [────────●────────] 5200 K          value 80 pt right-aligned,
Tint              [────────●────────] 3               monospaced, secondary
Boost             [────────────────●] 1.00
Noise Reduction   [───●─────────────] 0.40
                  [✓] Lens Correction   [✓] Highlight Recovery     (indented 120, spacing 20)
[Reset]                                     [Cancel] [Camera Raw…] [Import]
```

| Checklist | Control | Range | Default | Format (`String(format:)`) | Disabled / tooltip |
|---|---|---|---|---|---|
| **"Exposure slider"** | `exposure` | −3…3 EV | 0 | `%.2f EV` | – |
| **"Temperature slider"** | `temperature` | 2000…12000 K | camera `neutralTemperature` | `%.0f K` | – |
| **"Tint slider"** | `tint` | −150…150 | camera `neutralTint` | `%.0f` | – |
| **"Boost slider"** | `boost` (`boostAmount`) | 0…1 | 1 (Apple's full curve; 0 flat) | `%.2f` | – |
| **"Noise Reduction slider"** | `noiseReduction` | 0…1 | engine's `luminanceNoiseReductionAmount` (0 if unsupported) | `%.2f` | disabled unless supported; tooltip "Smooths grain, at the cost of fine detail" / "Not available for this camera" |
| **"Lens Correction toggle"** | `lensCorrection` | – | `isLensCorrectionSupported && isLensCorrectionEnabled` | – | disabled unless supported; "Removes the lens's distortion and vignetting" / "This file has no lens profile" |
| **"Highlight Recovery toggle"** | `highlightRecovery` | – | supported && enabled | – | "Brings back detail in bright areas the camera partly clipped" / "Not available for this camera" |
| **"Reset button"** | – | – | – | – | disabled when `isAsShot` (exposure 0, boost 1, all others equal their as-shot values); resets to those (`IO/RawImporter.swift:36-49`) |

`render` applies exposure, temperature, tint and boost always, the three optional ones only when supported
(`IO/RawImporter.swift:138-152`).

### 7.3 **"Live preview"** and **"8-bit path dithered"**

- `.task(id: revision)`: after the first render, waits 60 ms (coalescing slider bursts), then
  `Queue.develop(url, settings:, limit: 800)`; a newer change cancels the wait. The `Queue` actor keeps one
  `CIRAWFilter` for `(url, limit)`, created with `scaleFactor = 800 / longest` and draft mode when the frame is
  larger, so later renders only re-apply settings (`IO/RawImporter.swift:68-93`).
- The preview path (8-bit) is dithered: rendered RGBA16 sRGB then quantized in C with about one step of noise
  (`dither_quantize16`, `:154-171`). The import itself is 16-bit, so "8-bit path dithered" only concerns previews
  (and any 8-bit develop callers).

### 7.4 Port

- A board sheet (modal overlay in the board webview, same layout and texts). Values and toggles from engine
  `raw.asShot`; previews from `raw.preview` (PNG, ≤ 800 px long edge) posted to the webview as a blob URL; debounce
  60 ms and keep at most one request in flight plus the latest pending (the engine runs requests one at a time).
- Import / Camera Raw… store the settings for that file; Cancel drops the file; after the batch, `raw.release`.
- Camera Raw…: after the import result arrives, select the returned `activeLayerID` and open the board's Camera Raw
  filter panel (`board.filters.open('Camera Raw Filter')`) once that filter is ported; until then hide the button.
- Esc/Return map to Cancel/Import (system default/cancel actions, not the remappable canvas assignments,
  `UI/KeyboardShortcuts.swift:321-322` line "Fixed › Dialog Apply/Cancel buttons").
- RAW develop at full size can take several seconds; give `import.images` a long timeout (15.1).

---

## 8. Photoshop PSD/PSB import

### 8.1 Reader (`IO/PSD/PSDReader.swift`)

- **"PSD (version 1) and PSB large-document (version 2) files read"**; other versions → `unsupportedVersion`;
  signature must be `8BPS` (else `unreadable`). PSB uses 64-bit lengths for the layer section, channel lengths and
  the large additional-info keys (`LMsk Lr16 Lr32 Layr Mt16 Mt32 Mtrn Alph FMsk lnk2 FEid FXid PxSD`, `:136-138`).
- **"8 bits per channel only"** (`depth == 8`) and **"RGB and CMYK color modes accepted"** (mode 3 or 4); else
  "Only 8-bit RGB and CMYK Photoshop files can be imported."
- **"CMYK files converted to RGB"**: ICC from resource 1039 (`CMYK.embedded`), else Generic CMYK, else
  `unsupportedColorMode`; inverted ink planes → profile → sRGB, relative colorimetric
  (`IO/PSD/PSDChannelCoder.swift:58-75`); the profile is adopted (6.4) when the PSD starts the document.
- **"Layer compression"**: 0 raw, 1 PackBits; anything else (ZIP 2/3) on a channel that is decoded → "This Photoshop
  file uses a layer compression method that isn’t supported." Channels other than −1 (alpha), 0-2 (or 0-3 CMYK), −2
  (user mask) are skipped **before** decoding, so an unsupported compression on a spot channel is harmless.
- **"Other read errors"**: truncated data anywhere → `truncated`.
- **"Canvas limits"**: canvas sides 1-30,000 and ≤ 200 MP (`maxSurfacePixels`), else `tooLarge`; ≤ 10,000 layer
  records; ≤ 56 channels per layer.
- **"Resolution read from the file (resource 1005)"**: 16.16 fixed; non-finite or < 1 → 72; clamped 1-9600.
- **"Background-only file"**: a layer section shorter than 4 bytes → no records → imported as one layer through
  `decode(url, flattenedPhotoshop: true)` (ImageIO's merged image), the report sheet taken down.
- **"Too-large file cropped to canvas"**: if the layers (and masks) exceed the remaining budget, every layer and mask
  rectangle is cropped to the canvas and decoded cropped; still too large → `tooLarge`. Each cropped layer is
  reported.
- **"Layer names"**: Pascal name decoded Mac Roman (else Latin-1, else "Layer"); a `luni` block replaces it (NULs
  trimmed); empty → "Layer".
- **"Visibility kept"**: flag bit 1.
- **"Opacity"**: `opacity/255 × fill/255` (`iOpa`), except layers with effects (`lfx2`, `lrFX`, `lmfx`) and a fill
  below 255, which keep only the layer opacity (`:368-373`).
- **"Folders (groups)"**: section dividers (`lsct`/`lsdk` type 3) open a folder, type 1/2 records close it, so
  nesting follows Photoshop's bottom-to-top order; folder opacity kept (clamped 0-1); folder blend modes other than
  `pass`/`norm` reported and made pass-through.
- **"Blend modes mapped (24)"**: `norm mul  scrn over sLit dark lite diff div  idiv hue  sat  colr lum  lbrn lddg
  hLit vLit lLit pLit hMix smud fsub fdiv` → Normal, Multiply, Screen, Overlay, Soft Light, Darken, Lighten,
  Difference, Color Dodge, Color Burn, Hue, Saturation, Color, Luminosity, Linear Burn, Linear Dodge, Hard Light,
  Vivid Light, Linear Light, Pin Light, Hard Mix, Exclusion, Subtract, Divide (`IO/PSD/PSDTypes.swift:70-102`).
- **"Unmapped blend modes"**: `diss`, `dkCl`, `lgCl` and others → Normal, reported.
- **"Layer masks"**: placed on the layer's own pixel grid: a gray canvas the layer's size filled with the stored
  default value, the patch drawn where it sits (nearest neighbor); enabled (flag bit 1 clear) and linked (bit 0
  clear) kept; a mask flagged "from rendering other data" (bit 3, vector masks) is dropped silently
  (`IO/PSD/PSDReader.swift:394-399`, `IO/PSD/PSDDocumentBuilder.swift:147-170`).
- **"Clipping masks"**: kept as `maskSourceID` to the nearest preceding non-clipped sibling when that base is a
  plain pixel layer (not a folder, not an adjustment).
- **"Adjustment layers kept"**: `levl` → Levels, `curv` → Curves, `hue2`/`hue ` → Hue/Saturation (Colorize too);
  **"Other adjustment layers"** (`expA grdm brit blnc nvrt thrs post mixr selc blwh phfl vibA`) skipped entirely.
- **"Editable text"**, **"Text that can't map"**, **"Text notes"**, **"Missing font"**: `PSDText` (see the
  checklist lines and `IO/PSD/PSDText.swift:10-84, 134-179`); text renders through Core Text.
- **"Live shapes"** and **"Other vector shapes rasterized"**: `PSDVector.live` / `.raster`.
- **"Smart objects rasterized"**, **"Layer effects discarded"**, **"Unknown layer types imported as pixels"**: kinds
  from the additional-info keys (`:403-421`).

### 8.2 Conversion messages (verbatim, one row per layer and note, in layer order)

| Trigger | Message | Ref |
|---|---|---|
| layer or mask cropped | Cropped to the canvas so the file fits in memory. Pixels outside the canvas weren't imported. | `IO/PSD/PSDDocumentBuilder.swift:29-30` |
| text kept editable | each of: Only the first text style was kept. / The Photoshop text warp was omitted. / Faux bold or faux italic was omitted. / Full justification was imported as left alignment. | `IO/PSD/PSDText.swift:24-27` |
| font not installed | The font “<name>” isn’t installed, so the text was drawn with the system font. | `IO/PSD/PSDText.swift:31` |
| text not mappable | Editable Photoshop text becomes pixels and can’t be retyped. | `IO/PSD/PSDText.swift:23` |
| smart object | The smart object was rasterized. Linked contents can’t be edited. | `IO/PSD/PSDDocumentBuilder.swift:43` |
| effects | Layer effects were discarded, so the appearance may differ. | `IO/PSD/PSDDocumentBuilder.swift:46` |
| live shape with a stroke | The Photoshop stroke isn’t supported on shape layers and was omitted. | `IO/PSD/PSDVector.swift:36` |
| other vector | Vector shape was rasterized to pixels. | `IO/PSD/PSDDocumentBuilder.swift:52` |
| other kind | This Photoshop layer type isn’t supported and was imported as pixels. | `IO/PSD/PSDDocumentBuilder.swift:56` |
| folder blend | Folder blend mode “<key>” isn’t supported. The folder will be pass-through. (the raw 4-char key, untrimmed, e.g. “mul ”) | `IO/PSD/PSDDocumentBuilder.swift:60` |
| layer blend | Blend mode “<key>” isn’t supported and will be applied as Normal. (the 4-char key trimmed, e.g. “diss”) | `IO/PSD/PSDDocumentBuilder.swift:63` |
| unsupported adjustment | This adjustment type isn’t supported and was skipped. | `IO/PSD/PSDDocumentBuilder.swift:67` |
| supported adjustment | Adjustment parameters may not match Photoshop exactly. | `IO/PSD/PSDDocumentBuilder.swift:69` |
| mask not convertible | The layer mask couldn’t be converted to 8-bit grayscale and was skipped. | `IO/PSD/PSDDocumentBuilder.swift:116` |
| clipping base unsupported | This clipping mask’s base isn’t supported, so clipping was skipped. | `IO/PSD/PSDDocumentBuilder.swift:130` |

### 8.3 Insertion (`Document/EditorSession.swift:893-915, 1001-1036`)

- **"New document from a PSD"**: canvas = file size and resolution; layers as built; active = the last root-level
  layer (topmost), else the last layer.
- **"PSD into an open document"**: refused (`tooLarge`) past 10,000 total layers; a new folder named after the file
  (without extension), canvas-sized transform, inside the active folder (or the active layer's folder); with a drop
  point the incoming layers are moved so the union of their non-folder rectangles is centered on it; root records are
  re-parented into the folder; folder and its parent expanded; the folder becomes active.
- **"Conversion report sheet"**: `beginPSDReading` shows the sheet **before** reading (title, reading state); after
  parsing, `finishPSDReading(conversions)`: cancelled while reading → nothing; no conversions → sheet removed, import
  proceeds silently; otherwise the list is shown and the import waits for the answer. A read error removes the sheet
  and becomes a per-file failure.

### 8.4 Sheet (`UI/PSDConversionSheet.swift`)

```
Open “Poster.psd”?                                                     title2 bold
Compositor will convert these Photoshop features. Nothing is applied until you continue.     secondary
┌──────────────────────────────── list, min height 180 ────────────────────────────────┐
│ Sky                     (headline)                                                    │
│ Blend mode “diss” isn’t supported and will be applied as Normal.                      │
│ …                                                                                     │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                                                     [Cancel] [Import]
```

- **"Report title"**: `Open “<file name with extension>”?`; **"Report subtitle"** as above; while reading the subtitle
  is "Reading the file to see what needs converting." and the list is replaced by a small spinner with "Reading the
  Photoshop file…" (min height 180).
- **"Report list"**: rows with the layer name (`.headline`) above the message, vertical padding 4; sheet padding 24,
  **min 520 × 360**, rounded controls.
- **"Report Cancel button"**: Esc (`.cancelAction`); skips the file; pressed while reading it sets
  `conversionCancelled`, the read still finishes in the background, and the result is discarded.
- **"Report "Import" confirm button"**: Return (`.defaultAction`); disabled while reading.

### 8.5 Port

- Board modal sheet with the same texts. Show it at once in the reading state, call engine `psd.inspect` (15.2), then
  show the list or, if empty, close it and include the file. Cancel during reading marks the file skipped; the engine
  request still runs to completion and its answer is ignored.
- PSD files with many layers can take a while to parse twice (inspect, then import). Optional optimization: the
  engine caches the last `PSDImport` per `(path, size, mtime)` and `import.images` inserts it directly.
- There is no PSD export in Compositor; do not add one under this checklist.

---

## 9. Export PNG

`IO/ProjectController.swift:44-54, 97-110`, `IO/ImageExporter.swift:25-87, 138-142, 225-228, 265-273`.

- **"Export PNG… menu item"**: ⇧⌘E; `begin()` (busy, crop cancelled, transform committed), snapshot captured, then
  the save panel, then `ImageExporter.exportPNG(snapshot, to:)` = `render(snapshot)` (8-bit sRGB premultiplied,
  canvas size) → PNG with DPI → `write` (coordinated atomic write). Always 8-bit, even with 16-bit layers.
- **"Save panel titled "Export PNG""**: `allowedContentTypes = [.png]`, can create folders, extension shown, name
  `"<project file name without extension, or Untitled>.png"`; directory: the panel's default.
- **"DPI metadata"**: `kCGImagePropertyDPIWidth/Height = resolution`. Measured on a 300 DPI encode: chunks `IHDR,
  sRGB, eXIf, pHYs (11811 px/m), IDAT, IEND` **(measured)**.
- **"Flattening"**: `render` composites visible layers with effective opacity (folder opacity multiplied), masks,
  folder masks, live clipping, adjustment layers, effects and blend modes through `LiveMaskRenderer`, exactly as the
  canvas (`compositing.md`); missing assets → `missingImage`.
- **"Export never marks the project as saved"**: no history call.
- **"Size limit"** and **"Error alert "Couldn’t export PNG""**: 1.3.

**Port**: `compositorBoard.exportPNG` → flush → `showSaveDialog` ("Export PNG", default
`<package parent>/<name>.png`, filter PNG) → engine `export.png { project, path }` → done (an information toast
"Exported <file>" is a port addition; upstream says nothing on success). The board's dirty state is untouched.

---

## 10. Export As and Export JPEG

### 10.1 Opening (`IO/ProjectController.swift:56-95`)

- **"Export As… menu item"**: ⌥⇧⌘W. `begin()`; snapshot; `raster = render(snapshot)`; `deepRaster =
  render(snapshot, sixteenBit: true)` only if some layer has `deep` pixels; `hdrRaster = render(snapshot,
  sixteenBit: true, hdr: true)` only if some layer is HDR. Then a titled, full-size-content `NSWindow` sheet titled
  "Export As" hosting `ExportAsSheet`. **`isProjectBusy` stays true for the whole time the sheet is up** (the status
  bar shows "Working…").
- Initial format: `start ?? lastExportFormat`; `lastExportFormat` is per controller (per tab), in memory, PNG at
  first, updated to the exported format after the sheet returns; EXR requested without an HDR raster becomes PNG.
- **"Export JPEG… menu item"**: ⌥⇧⌘S → `exportAs(start: .jpeg)`.
- After Export…: `savePanel(for: format)` (title `"Export " + rawValue` → "Export JPEG", "Export PNG", "Export
  TIFF", "Export PDF", "Export EXR"; `allowedContentTypes = [format.type]`; name `"<project or Untitled>.<ext>"`
  with `preferredFilenameExtension`: **jpeg**, png, tiff, pdf, exr (measured; JPEG defaults to `.jpeg`, not `.jpg`)),
  then `ImageExporter.write(chosen.data, to:)`: the **exact bytes the preview was made from**.
- **"Error alert "Couldn’t export""** for render and write failures.

### 10.2 Layout (`UI/ExportAsSheet.swift:78-196`)

```
Export As                                                   [Fit] [⊕] [⊖]       title2 bold; buttons: Fit disabled at Fit
┌────────────────────────── preview 560 × 330, gray 0.12 ──────────────────────────┐
│   checkerboard behind the image; spinner in a material rounded box while updating │
└──────────────────────────────────────────────────────────────────────────────────┘
Format      [ JPEG | PNG ]  ( More ▾ )        segmented; More is bordered, prominent when one of its formats is chosen
Size        [ 1920] × [ 1080] px  ( 100% ▾ )  fields 64 pt, trailing, no grouping
Quality     [──────────●───] 85%              JPEG only; slider 300 pt; percent 45 pt
Depth       [ ] 16 bits per channel           PNG only, and only with a 16-bit layer
Color       ( RGB ▾ )  [Load Profile…]        JPEG, TIFF, PDF; Load Profile only with CMYK
Page        26.67 × 15 in at 72 DPI           PDF only, secondary
Background  [■■]                              JPEG, PDF, or TIFF with CMYK; 34 × 18 swatch
sRGB                                 1.2 MB   [Cancel] [Export…]
```

Grid: leading first-text-baseline alignment, 12 pt spacing; sheet padding 24, spacing 16.

| Checklist | Behavior | Ref |
|---|---|---|
| **"Format segmented control: JPEG \| PNG"** | `Picker` over `[.jpeg, .png]`, segmented, labels hidden | `:104-115` |
| **"More formats menu beside it"** | `others = formats − {png, jpeg}` = TIFF, PDF (+ EXR when `hdrRaster != nil`); label = chosen format's name when one of them is chosen, else "More"; `.borderedProminent` when chosen; tooltip "Other formats: TIFF and PDF" + ", and EXR to keep light brighter than white" when EXR is offered | `:262-276` |
| **"Size fields"** | width, `×`, height, `px`; tooltips "Width in pixels; the height follows, keeping the proportions" / "Height in pixels; the width follows, keeping the proportions"; editing one calls `setScale(value / rasterSide)`, which recomputes **both** | `:116-122, 278-291` |
| **"Scale menu"** | title `"\(scalePercent)%"` with `scalePercent = round(width / rasterWidth × 100)`; items 25%, 50%, 75%, 100%, 200%; tooltip "Scale the export: the document stays as it is" | `:123-128, 292` |
| **"Scale limits"** | `largest = min(30000 / longSide, sqrt(200 MP / (w × h)))`; `clamped = min(largest, max(0.01, scale))` (non-finite → 1); `width = max(1, round(w × clamped))`, same for height; resampled with high-quality interpolation, resolution unchanged | `:285-291`, `IO/ImageExporter.swift:144-165` |
| **"JPEG Quality slider"** | 0…1 step 0.01, shown `"\(Int((q × 100).rounded()))%"`; initial value `UserDefaults` `jpegExportQuality` clamped 0…1 when finite, else 0.85; saved only when Export… is pressed with JPEG chosen | `:21, 30-34, 131-139, 189` |
| **"PNG Depth toggle"** | "Depth" / "16 bits per channel", off each time; tooltip "Keep the 16-bit layers' full precision, in a file about twice the size"; only counts when format is PNG and `deepRaster != nil` | `:65-66, 140-146, 56` |
| **"Color menu (JPEG, TIFF, PDF)"** | menu button "RGB"/"CMYK" with toggles RGB and CMYK; off (RGB) each time the sheet opens; tooltip "CMYK writes a printer's inks through the profile in View › CMYK › Profile"; profile = `session.proofProfile ?? CMYK.chosen` | `:59-64, 147-160, 242-251` |
| **"Load Profile… button"** | shown with CMYK; tooltip "Use a CMYK ICC profile, such as the one your printer gave you"; `NSOpenPanel` (types icc, icm; message "Choose a CMYK ICC profile, such as the one your printer gave you"), run modally; `CMYK.load(url)` copies it into `<Application Support>/CMYK Profiles/`, sets `CMYK.chosen` and `session.proofProfile`; failure puts the error text in the sheet's error slot | `:154-157, 253-260`, `IO/CMYK.swift:52-62` |
| **"PDF Page row"** | `"\(w/dpi) × \(h/dpi) in at \(Int(dpi.rounded())) DPI"`, inches with 0-2 fraction digits (current locale), dpi = resolution or 72; e.g. "26.67 × 15 in at 72 DPI" (measured) | `:161-166, 293-298` |
| **"Background color swatch"** | label "Background"; `DialogColorSwatch(title: "Export Background")` opens the app's color picker titled so; tooltip "Color that fills transparent areas"; default white (`JPEGOptions` red = green = blue = 1); shown for JPEG, PDF, and TIFF with CMYK | `:167-174, 303-306` |
| **"Status line"** | EXR: "Brighter than white kept · Transparency kept"; CMYK (JPEG/TIFF/PDF): "CMYK – <profile name or "No profile">"; PNG or RGB TIFF: "Transparency kept · sRGB"; else (JPEG, RGB PDF) "sRGB"; secondary | `:177-180` |
| **"Estimated file size"** | when ready: `ByteCountFormatter.string(fromByteCount:, countStyle: .file)`, monospaced; error → red text instead; else "Updating…" secondary | `:182-185` |
| **"Cancel button"** | Esc (remappable canvas cancel); closes the color picker (committing it), then `finish(nil)` | `:186` |
| **"Export… button"** | Return (remappable canvas apply); disabled until `isReady` (`result?.settings == settings && error == nil`) | `:187-193` |

Measured `ByteCountFormatter` file style: 0 → "Zero KB", 1 → "1 byte", 532 → "532 bytes", 1000 → "1 KB", 1234 → "1 KB",
12,345 → "12 KB", 123,456 → "123 KB", 1,234,567 → "1.2 MB", 12,345,678 → "12.3 MB", 1,234,567,890 → "1.23 GB".
(Decimal units; KB with 0 decimals, MB 1, GB 2.)

### 10.3 Encoding per format (`.task(id: settings)`, `UI/ExportAsSheet.swift:206-239`)

On any settings change: error cleared, 200 ms sleep (cancelled by a newer change), source = `hdrRaster` (EXR) or
`deepRaster` (PNG with 16-bit on) or `raster`; `resized(source, width:, height:)`; then:

| Checklist | Format | Data | Preview |
|---|---|---|---|
| **"JPEG output"** | JPEG | `jpeg(sized, options:, cmyk:)`: drawn over the matte into RGB8 (no alpha); CMYK → `CMYK.convert(…, over: matte)` (relative colorimetric, profile embedded by ImageIO from the color space); quality `min(1, max(0, q))`; DPI. Measured: JFIF X/YDensity 300 at a 300 DPI encode with DensityUnit 0, read back by ImageIO as DPI 300 | decoded thumbnail of the encoded JPEG at full size, capped at 8,192 px (so artifacts show) |
| **"PNG output"** | PNG | `pngData(sized)`: lossless, alpha, sRGB, DPI; 16-bit when the deep raster was used | `sized.image` |
| **"TIFF output"** | TIFF | `tiffData(sized, cmyk:, matte:)`: LZW (`TIFFCompression 5`, measured), DPI; RGB keeps alpha (8-bit only); CMYK flattened over the matte, profile embedded | the RGB image or the CMYK image |
| **"PDF output"** | PDF | `pdfData(sized, background: matte, cmyk:)`: one page `w × 72/dpi` by `h × 72/dpi` points; page filled with the background color (Export As always passes one, so transparency is filled); image drawn losslessly (`/FlateDecode`, never `/DCTDecode`, upstream test); CMYK image converted over the background | `flattened(sized, over: background)` or the CMYK conversion |
| **"EXR output"** | EXR | `exrData(sized)` from the half-float HDR flattening, DPI; keeps values above 1 and alpha | `DeepLayer.dithered(sized.image)`: brighter than white shown as white |

### 10.4 Preview (`UI/ExportAsSheet.swift:93-102, 197-205, 309-402`)

- **"Live preview"**: 200 ms debounce; spinner overlay (material, radius 8) while `!isReady && error == nil`.
- **"Preview area"**: 560 × 330 pt, background gray 0.12, clipped; **checkerboard** tile 20 × 20 pt (gray 0.30 with
  two 10 pt squares of gray 0.35) behind the image; **Fit** button (tooltip "Show the whole image (⌘0)", disabled at
  Fit); zoom buttons SF `plus.magnifyingglass` / `minus.magnifyingglass`, tooltips "Zoom in (⌘+), now N%. At 100% each
  pixel of the export is one pixel of the screen" and "Zoom out (⌘−), now N%", disabled when there is no further step.
- **"Preview zoom steps"**: `[0.25, 0.5, 1, 2, 4, 8]`; zoom 1 = one export pixel per **device** pixel (sizes divided
  by `displayScale`); fit zoom = `min(560 / (w/scale), 330 / (h/scale))`; the next step is the first above
  `zoom × 1.001` (or last below `zoom × 0.999`); nearest-neighbor interpolation from 100 % up, high quality below;
  zoom keeps the view's middle on the same image point (from Fit it starts centered).
- **"Preview gestures"**: when zoomed: drag pans (grab cursor), scroll pans; double-click returns to Fit. At Fit,
  double-click goes to 100 %. Tooltip "Drag or scroll to move around; double-click switches between Fit and 100%".
- **"View-menu zoom redirected"**: `session.previewZoom` is set while the sheet is up; Fit Canvas → Fit, Actual
  Pixels → 100 %, Zoom In/Out → next step.

### 10.5 Port

- `compositorBoard.exportAs` / `exportJPEG`: flush, then the board shows an **Export As sheet** as a modal overlay in
  its webview (same layout, texts, tooltips). The extension keeps `lastExportFormat` per board in memory (PNG at
  first), and `globalState['compositorBoard.jpegExportQuality']` (default 0.85) and
  `globalState['compositorBoard.cmykProfile']` (default "Generic CMYK Profile"); these are the board's own, not the
  app's (the app's UserDefaults live in its sandbox container).
- Engine session: `export.begin` once when the sheet opens (renders the three rasters once, as upstream);
  `export.preview` per settings change (debounced 200 ms, one in flight, newest wins; stale answers dropped by a
  serial number); `export.write` after the save dialog; `export.end` on close. The preview arrives as a file:
  for JPEG the encoded bytes themselves (the browser decodes them, artifacts included; cap 8,192 px handled by the
  engine sending a decoded PNG only when larger), for the others a PNG.
- Preview in the webview: `<canvas>` or `<img>` with `image-rendering: pixelated` at zoom ≥ 1; 100 % uses
  `devicePixelRatio`; CSS checkerboard `#4d4d4d` / `#595959` 10 px squares (gray 0.30 / 0.35); wheel and drag pan.
- While the sheet is open the board routes ⌘0 / ⌘1 / ⌘= / ⌘- to the preview, Return to Export… (when ready) and Esc
  to Cancel; size fields swallow keys (no tool shortcuts).
- Background swatch: the board's color picker (`media/picker.js`) titled "Export Background".
- Load Profile…: `showOpenDialog` (14.3) → engine `cmyk.load` → store the returned name in
  `globalState['compositorBoard.cmykProfile']`; error text into the sheet's error slot.
- Export…: save `jpegExportQuality` if JPEG, close the sheet, run `showSaveDialog` (title "Export <FORMAT>", default
  `<package parent>/<name>.<ext>` with `jpeg/png/tiff/pdf/exr`), then `export.write`; failure → modal
  "Couldn’t export" with the reason.

---

## 11. Project format and live reload

Format, versions and limits: `manifest.md` 1-11; this section only covers the File-menu behavior.

- **"`.comp` package"**: a folder of type `com.compositor.project` (conforms to `com.apple.package`, extension
  `comp`) holding `manifest.json`, `images/`, `QuickLook/`; Finder and open panels show it as one file
  (`Config/Info.plist:77-93`). On this Mac `mdls` reports `com.compositor.project, com.apple.package,
  public.directory` for `samples/parrot.comp` **(measured)**, because Compositor.app is installed.
- **"Versions"**: writes 14, reads 1-14 with per-feature gates (`manifest.md` 9.6).
- **"Load limits"**: `manifest.md` 9 and 11.
- **"Live reload"**, **"Change detection by content"**, **"Reload in place"**, **"Waits for edits"**,
  **"Half-written or invalid package ignored silently"**, **"Watching stops when the tab gets a new canvas or is
  closed"**: `manifest.md` 12.
- **"Unsaved-changes conflict"**: alert in 1.3, a sheet on the window; Revert reloads; Keep Mine stores the new digest
  so that version is not asked about again.
- **"Background tab conflict deferred"**: a change to a hidden tab with unsaved edits sets `pending` and is checked
  when the tab is selected (`resumeExternalChangeCheck`, `Document/ProjectWorkspace.swift:70`).

**Port** (exists, differs on purpose): the extension polls every 400 ms the manifest hash and `images/` name, size
**and mtime** (`extension.js:316-348`; mtime also counts, unlike Compositor), and `pushExternal` hands the disk version
to the board, which merges it with local strokes and records it as an undo step. That replaces the Revert / Keep Mine
prompt for the normal case (autosave keeps the board almost always clean). When the board is dirty and the merge
cannot keep both (the board reports a conflict), show the upstream alert texts as a modal with Revert / Keep Mine.
A package that fails validation during the poll is skipped silently, as upstream.

---

## 12. QuickLook

### 12.1 Upstream

- **"Preview.jpg"**: every app save writes `QuickLook/Preview.jpg`: `render(snapshot)` (only when `w × h ≤ 50 MP`),
  scaled so the long side ≤ 1,024 px (never enlarged), drawn over opaque white with high interpolation, JPEG quality
  0.8, sRGB (`IO/ImageExporter.swift:89-113`). Loading ignores it; the digest ignores it. Above 50 MP the package has
  no QuickLook folder.
- **"No QuickLook extension"**: the Xcode project has only the app and two test targets
  (`upstream/Compositor.xcodeproj/project.pbxproj:124, 147, 170`); Finder's previews come from that file alone.

### 12.2 Port

QuickLook still matters: Finder's previews of `.comp` packages come only from this file, and the board writes far
more often than the app. Today `writeProject` deletes `QuickLook/` on every board write (`core/package-io.js:151`),
so a project edited in VS Code loses its Finder preview until Compositor saves it again. Engine ops that save through
`ProjectStore.save` (`engine/Sources/EngineMain.swift:77-82`) do write one.

Add engine `project.quickLook { project, out }` (15.2): returns the JPEG at `out`, or `{ none: true }` above 50 MP.
The extension calls it after a board write once the board has been idle for a few seconds (and on close), then
writes `QuickLook/Preview.jpg` itself inside `io.withLock`, temp file + rename, **only if the manifest hash is still
the one it rendered** (otherwise skip; the next idle period retries). This keeps the lock protocol in one place.

---

## 13. Document types

`Config/Info.plist`:

- **"Compositor Project"**: `CFBundleDocumentTypes` entry "Compositor Project", role Editor, rank Owner,
  `LSTypeIsPackage`, content type `com.compositor.project`; exported UTType `com.compositor.project`, conforms to
  `com.apple.package`, extension `comp`, description "Compositor Project".
- **"Images"**: "Images", role Viewer, rank Alternate: public.jpeg, public.png, public.heic, public.heif, public.tiff,
  org.webmproject.webp, com.ilm.openexr-image, public.radiance, com.adobe.photoshop-image,
  com.adobe.photoshop-large-image, public.camera-raw-image, public.svg-image. Opening one (Finder Open With, Dock
  drop) makes a new project tab per image (`Document/ProjectWorkspace.swift:166-184`).
- **"Folders"**: "Folders", role Viewer, rank Alternate, `public.folder`: a dropped or opened folder imports its
  images.
- **"Imported UTTypes"**: "Adobe Photoshop Document" `com.adobe.photoshop-image` (psd) and "Adobe Photoshop Large
  Document" `com.adobe.photoshop-large-image` (psb), both conforming to `public.image`.
- **"Exported UTType "Compositor Layer""**: `com.compositor.layer-row`, conforms to `public.data`: the drag type
  carrying a layer's UUID as UTF-8 between tabs (`Document/ProjectWorkspace.swift:185-199`).

**Port.** Info.plist registrations stay the Compositor app's job (the extension cannot register macOS document
types). Their VS Code analogues:

| Upstream | VS Code |
|---|---|
| Compositor Project, Editor/Owner | `contributes.customEditors` selector `**/*.comp/manifest.json` (exists) + Explorer context items on `.comp` folders (exist) |
| Images, Viewer/Alternate | Explorer context on image files: "New Board from Image" (`compositorBoard.newFromImages`) and "Import into Board" (`compositorBoard.importImages` with the URIs); `when: !explorerResourceIsFolder && resourceExtname =~ /^\.(jpe?g\|jpe\|png\|heic\|heif\|hif\|tiff?\|webp\|exr\|hdr\|pic\|psd\|psb\|svgz?\|dng\|cr2\|cr3\|crw\|nef\|nrw\|arw\|srf\|sr2\|raf\|orf\|rw2\|raw\|rwl\|pef\|srw\|3fr\|fff\|iiq\|mos\|mrw\|erf\|dcr)$/i`. Do **not** register a custom editor for images (it would replace VS Code's image preview) |
| Folders, Viewer/Alternate | Explorer context on folders that are not `.comp`: the same two commands |
| Imported PSD/PSB types | nothing to declare; the engine identifies PSD by magic |
| Compositor Layer drag type | between boards use a webview drag MIME `application/vnd.compositor.layer-row` (App-level work, not this spec) |

---

## 14. Mapping to VS Code

### 14.1 Commands

"Current board" = the active custom editor whose `viewType` is `compositorBoard.board`
(`vscode.window.tabGroups.activeTabGroup.activeTab.input`), else the side-bar board when its view is visible, else
none (commands that need one show "Open a board first." and stop; port text). Set a context key
`compositorBoard.hasBoard` for `when` clauses.

| Command id | Title (category "Compositor Board") | Upstream item | Surfaces | Implementation |
|---|---|---|---|---|
| `compositorBoard.new` (exists) | New Board… | New Canvas… | palette, side-bar title (exists), board File menu, editor title `$(add)` when a board is active | New Canvas form (3.11) |
| `compositorBoard.open` (exists) | Open Board in Editor (File menu label "Open Project…") | Open Project… | palette, Explorer `.comp` (exists), File menu, welcome | 4.4 |
| `compositorBoard.openRecent` | Open Recent Board… | Open Recent | palette, File menu ("Open Recent…") | QuickPick (4.4) |
| `compositorBoard.clearRecent` | Clear Recently Opened Boards | Clear Menu | palette, last QuickPick item | empty the list |
| `compositorBoard.importImages` | Import Images… | Import Images… | palette (`compositorBoard.hasBoard`), File menu, New Canvas "Import image", Explorer images/folders ("Import into Board") | 6.6 |
| `compositorBoard.newFromImages` | New Board from Image | Finder Open With (Images, Folders) | Explorer images/folders | ask location (default `<image name>.comp` beside the image is a port choice; upstream would make "Untitled"), `project.fromImages`, open |
| VS Code Save | Save | Save | ⌘S, File menu "Save" (posts `saveNow`) | 5.3 |
| `compositorBoard.saveAs` | Save Project As… | Save As… | ⇧⌘S (scoped), File menu | 5.3 |
| `compositorBoard.exportJPEG` | Export JPEG… | Export JPEG… | ⌥⇧⌘S (scoped), File menu | 10.5 with JPEG |
| `compositorBoard.exportPNG` | Export PNG… | Export PNG… | ⇧⌘E (scoped), File menu | 9 |
| `compositorBoard.exportAs` | Export As… | Export As… | ⌥⇧⌘W (scoped), File menu, editor title `$(export)` | 10.5 |
| `compositorBoard.closeBoard` | Close Project | Close Project | File menu only (⌘W stays VS Code's) | 4.4 |
| `compositorBoard.openInCompositor` (exists) | Open in Compositor App | – | unchanged | flush, `open -a Compositor` |

### 14.2 The board's File menu

Add a first menu `File` to `board.menus()` (`media/board.js:1072-1126`), items posting messages the extension turns
into the commands above:

```
New Canvas…            (no chord shown; ⌘N is VS Code's, see 14.6)
Open Project…
Open Recent…
Import Images…
─────
Save                   ⌘S
Save As…               ⇧⌘S
─────
Export JPEG…           ⌥⇧⌘S
Export PNG…            ⇧⌘E
Export As…             ⌥⇧⌘W
─────
Close Project
```

Enabled: New, Open, Open Recent, Import when `canStartFileOperation()` (Import also needs a document, or creates one);
Save, Save As, exports when a document is loaded and the gate is open; Close always unless a File sheet is open.
The menu wrapper that disables everything while a filter panel or Color Range is open (`board.js:1120-1125`) applies.

### 14.3 Dialogs

| Purpose | API | Options |
|---|---|---|
| Open Project | `showOpenDialog` | `title: 'Open Project'`, `openLabel: 'Open'`, `canSelectFiles: true`, `canSelectFolders: true`, `canSelectMany: true`, `filters: { 'Compositor Project': ['comp'] }` |
| New board / project from images | `showSaveDialog` | `title: 'Save Project'`, `saveLabel: 'Create'`, `defaultUri: <folder>/Untitled.comp` (lowest free "Untitled N"), `filters: { 'Compositor Project': ['comp'] }` |
| Save As | `showSaveDialog` | `title: 'Save Project As'`, `defaultUri: <parent>/<name>.comp`, same filter |
| Import | `showOpenDialog` | `title: 'Import Images'`, `openLabel: 'Import'`, files + folders, many, `filters: { 'Images': <import.types> }` |
| Export | `showSaveDialog` | `title: 'Export ' + FORMAT`, `defaultUri: <package parent or last export folder>/<name>.<ext>`, `filters: { FORMAT: [ext] }` |
| Load Profile | `showOpenDialog` | `title: 'Choose a CMYK ICC profile, such as the one your printer gave you'`, `filters: { 'ICC Profile': ['icc', 'icm'] }` |

**Measured from the 1.142 bundle:** the extension-API open dialog builds Electron properties from
`canSelectFiles → openFile`, `canSelectFolders → openDirectory`, `canSelectMany → multiSelections` and never adds
`treatPackageAsDirectory` (only VS Code's own pickers do). On a Mac with Compositor installed `.comp` is a package, so
the native panel treats it as a **file**. The current `pickPackage` (`extension.js:711-719`, folders only, no files)
therefore probably cannot select `.comp` packages there (greyed out); verify, and switch to files + folders with the
`comp` filter as above. Folders remain needed on Macs without Compositor, where `.comp` is a plain folder. With
`files.simpleDialog.enable` VS Code's own dialog treats it as a folder either way.

### 14.4 Tabs, windows and recent

- Compositor's single window with project pills becomes VS Code's editor tabs (any group, splits allowed) plus the
  one side-bar board. A project is open in one place at a time (exists).
- Tab title: a custom editor tab shows its resource's base name, i.e. **"manifest.json"** (VS Code adds the folder,
  `parrot.comp`, as a description when two tabs share a name). There is no API to rename a custom editor tab; the
  board should show the project name in its own top strip. Upstream titles: file name without `.comp`, else
  "Untitled", new tabs "Untitled N".
- Unsaved dot: VS Code's dirty indicator from `onDidChangeCustomDocument` (exists); the side bar can append " ●" to
  `view.description`.
- Tab reordering, overflow, closing, quit prompts: VS Code's own. VS Code's close prompt reads "Do you want to save the
  changes you made to manifest.json?" with the same detail line as Compositor ("Your changes will be lost if you
  don’t save them.") and Save / Don’t Save / Cancel; it only appears when autosave is off.
- New Canvas creates a "New Canvas" webview panel, which becomes the board tab on Create (3.11).
- Recent: 4.4.

### 14.5 Drag and drop onto the board

How VS Code 1.142 routes drags (measured from `pre/index.html:792-833` and the workbench bundle):

- The preload listens on the webview window for `dragenter`; if the event is **not** `defaultPrevented`, Shift is not
  held, and every item is a file, it posts `drag-start` and the workbench sets `pointer-events: none` on the webview
  iframe, so the drop goes to VS Code (which opens the files as editors). It always `preventDefault`s `dragover` and
  `drop`.
- A drag that starts inside the workbench (Explorer, editor tabs) blocks the iframe on `dragstart`, and keeps it
  blocked on `drag`/`dragover` **unless Shift is held** (minified class `pue` in the 1.142 bundle, which calls
  `windowDidDragStart` / `windowDidDragEnd`: `n.shiftKey ? i() : t()`).

Therefore:

1. In the board, register `dragenter`, `dragover`, `dragleave`, `drop` on `document` (they run before the preload's
   window listeners). On `dragenter`/`dragover` with `types` containing `Files`, `text/uri-list` or
   `application/vnd.code.uri-list`, call `preventDefault()` (this stops `drag-start`) and set `dropEffect = 'copy'`,
   or `'none'` when `canStartFileOperation()` is false (**"Drops refused while Levels is open, the project is busy…"**).
2. **"Drop highlight"**: a 3 px accent (`--vscode-focusBorder` or `#0A84FF`) rounded rectangle, radius 8, inset 3 px
   inside the canvas area, while a valid drag hovers; removed on `dragleave` (with an enter/leave counter) and `drop`.
3. Drop point: when a document exists and the pointer is over the canvas, `view.documentPoint(clientX, clientY)`;
   otherwise `null` (**"Drop onto the canvas"**: centered at the drop point; with no document the first image sets the
   size regardless).
4. **From Finder / Desktop / other apps** (`dataTransfer.files`): the webview gets `File` objects without paths. For
   each file, `arrayBuffer()` and post `{ type: 'importDrop', files: [{ name, bytes }], point }`. The extension
   writes each to `<engine temp>/<uuid>/<name>` (name kept, as `IO/ImageFileDrop.swift:43-51`; "Dropped" + an
   extension from the MIME type when nameless), runs 6.6 with those paths, then deletes the folders. Directories:
   `item.webkitGetAsEntry()` (call it synchronously inside the `drop` handler; the items are gone afterwards) with
   `isDirectory` → read its direct child files (skip names starting with "."), sort
   with `localeCompare(…, { numeric: true })`, import those; nothing readable → the empty-folder message. A dropped
   `.comp` from Finder has no path to open: show "Open Compositor projects with Open Project…" (port text).
   Items with no file (a web image) → **"Unreadable drop message"** verbatim: "Some dropped items couldn’t be read.
   Drag JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) files from Finder." (appended to the import errors).
5. **From the VS Code Explorer**: only with **Shift held** (VS Code's documented "hold Shift to drop into a
   webview" behavior). Read `text/uri-list` (or `application/vnd.code.uri-list`); verify which types 1.142 provides.
   `file:` URIs give real paths: `.comp` → open that board (**"Dropped .comp packages open as projects"**); folders
   and images → 6.6 by path, no copy. Without Shift VS Code opens the file in an editor instead; the Explorer
   context commands (13) are the reliable path.
6. Onto the side-bar welcome (no project): images make a new project (`project.fromImages`, asking where).
7. Large drops: posting hundreds of MB through `postMessage` works but is slow; show the busy status while bytes move.

Everything in this subsection is inferred from source; test each case in a real VS Code build.

### 14.6 Keyboard

The preload forwards every key to the workbench unless the board stops it (`ui.md` 12.1). Contributed keybindings
with `when` clauses run in the workbench, so they work for keys pressed inside the webview without the board
handling them.

| Chord | Upstream | VS Code default | Proposal |
|---|---|---|---|
| ⌘N | New Canvas | New Untitled Text File | leave to VS Code (`ui.md` 12.2); New Board via palette, File menu, `+`. **Decision for the user**: optionally bind it with `when: activeCustomEditorId == 'compositorBoard.board' \|\| focusedView == 'compositorBoard.sidebar'` |
| ⌘O | Open Project | Open File | leave to VS Code |
| ⌘S | Save | Save | VS Code Save (editor); `saveNow` (side bar, exists) |
| ⇧⌘S | Save As | Save As (built-in dialog, `manifest.json`) | `keybindings`: `shift+cmd+s` → `compositorBoard.saveAs`, `when` as above |
| ⌥⇧⌘S | Export JPEG | none known (⌥⌘S is Save All) | bind → `compositorBoard.exportJPEG`, same `when` |
| ⇧⌘E | Export PNG | Show Explorer (verified, `ui.md`) | bind → `compositorBoard.exportPNG`, same `when` (Explorer stays reachable elsewhere) |
| ⌥⇧⌘W | Export As | none known | bind → `compositorBoard.exportAs`, same `when` |
| ⌘W | Close Project | Close Editor | VS Code's (same effect) |
| ⌘V | paste as new canvas on the New Canvas form | paste (dispatched back into the webview as a DOM `paste` event) | the form listens for `paste`; unless a size field has focus and the clipboard text is a valid size, call engine `clipboard.inspect` → `project.fromClipboard` |
| ⌘0 ⌘1 ⌘= ⌘- | Fit / Actual / Zoom, redirected to the Export As preview | consumed by the board already | route to the preview while the sheet is open |
| ↩ / ⎋ in sheets | Create canvas, Export…, Import / Cancel | – | handled in the sheet; stop propagation |

Windows/Linux: the same with Ctrl; but RAW and PSD conversion, CMYK and the engine are macOS-only anyway.

### 14.7 Messages between the board and the extension (new)

| Webview → extension | Payload | Extension does |
|---|---|---|
| `fileCommand` | `{ command: 'new'\|'open'\|'openRecent'\|'importImages'\|'saveAs'\|'exportPNG'\|'exportJPEG'\|'exportAs'\|'closeBoard' }` | runs the command for this board |
| `createCanvas` | `{ width, height, resolution, background }` | 3.11 |
| `importDrop` | `{ files: [{ name, bytes }], point }` or `{ uris: [...], point }` | 14.5 |
| `engine` (exists) | ops of section 15 | `runEngine` (exists) with longer timeouts |

| Extension → webview | Payload |
|---|---|
| `fileSheet` | `{ kind: 'raw'\|'psd'\|'export', … }` opens a sheet with engine data |
| `importDone` | `{ errors, activeLayerID, editName }` (through `engineResult`) |
| `alert` | `{ title, text }` when the extension wants the board's own alert style instead of a VS Code modal |

---

## 15. Engine API to add

### 15.1 Changes to the engine and its client

1. **Error text.** `EngineMain.swift:29` answers `String(describing: error)`. For upstream's `LocalizedError` enums
   that is the case name: `ProjectError.invalid` → `"invalid"`, while `localizedDescription` gives "This is not a
   valid Compositor project, or its metadata is damaged." **(measured)**; for `CocoaError` it is the debug string.
   Answer `(error as? LocalizedError)?.errorDescription ?? (error as NSError).localizedDescription` for
   non-`EngineError` errors. Every verbatim message in this spec depends on it.
2. **Timeouts.** `EngineClient.request` defaults to 120 s and `runEngine` passes none. Imports (RAW full develop,
   large PSD) and exports (200 MP renders, PDF/TIFF encodes) can exceed it: let `runEngine` accept a `timeout`
   (suggest 10 min for `import.*`, `project.fromImages`, `export.*`).
3. **Long-lived state.** `raw.preview` relies on `RawImporter.Queue`'s cached decoder, and `export.*` on cached
   rasters, both living in the engine process; the client stops the engine after 5 idle minutes
   (`core/engine-client.js:12`), which simply drops them (requests must then fail cleanly with "expired session",
   and the board re-begins).
4. **Memory.** An export session holds up to three canvas-size rasters (8-bit 4 B/px, 16-bit 8 B/px, HDR 8 B/px): a
   200 MP canvas is about 4 GB. Render the deep/HDR rasters lazily (only when 16-bit PNG or EXR is chosen) as a port
   optimization; release on `export.end`.
5. **CMYK and UserDefaults domain.** The engine is an unsandboxed command-line tool: `UserDefaults.standard` is its
   own domain and `CMYK.loadedFolder` is `~/Library/Application Support/CMYK Profiles` (not the app's container,
   `~/Library/Containers/com.wonderassembly.compositor/Data/…`). Profiles loaded or adopted by the app are invisible
   to the engine and vice versa. The board passes the profile **name** with each export; `cmyk.profiles` lists what
   the engine can see. Do not read the app's container (macOS may show an "access data from other apps" prompt).
6. **Excluded UI code to re-implement in Swift inside `engine/Sources/`.** `ExportAsSheet` (its `.task` encoding
   body and `setScale`), `NewCanvasSheet.clipboardDimensions` and `RawDevelopSheet` are not compiled into the engine
   (`engine/build.sh`, `UI_KEEP` only keeps `PSDConversionSheet` among the File sheets). Everything they call
   (`ImageExporter`, `CMYK`, `DeepLayer`, `RawImporter`, `EditorSession`) is compiled.
7. **Hooks for headless import.** `EditorSession.confirmConversions` and `confirmRawDevelop` exist for tests
   (`Document/EditorSession.swift:586-598`); upstream tests drive `importImages` headless with them
   (`PSDRoundTripTests.swift:238-272`). The engine sets them per request; it must never let `developRaw` or the PSD
   sheet wait on a continuation nobody resumes.

### 15.2 Operations

All ops answer `{ id, ok, result }` as today. Paths are absolute. `withSession` ops also take the usual
`activeLayerID`, `selection`, `isMaskSelected` and return the usual outcome (`saved`, `editName`, `activeLayerID`,
`selection`, `error`).

| Op | Args | Upstream calls | Result |
|---|---|---|---|
| `import.types` | – | `UTType.importableImages` tags + RAW extensions conforming to `.rawImage` | `{ extensions: [...], raw: [...] }` (on this Mac 23 RAW + 17 others, measured) |
| `project.inspect` | `{ project }` | `ProjectStore.shared.load(from:)` | `{ width, height, resolution, version, layers }`; error = `ProjectError` text, or the missing-file text when the package is gone |
| `project.create` (optional; `core.createProject` already does it) | `{ target, width, height, resolution, background }` | `EditorSession().createNewProject` + `save` | `{ width, height }` |
| `project.fromImages` | `{ target, files: [path], raw: { path: settings }, point: null }` | new `EditorSession`; `confirmRawDevelop = { url, _ in raw[url.path] }`; `confirmConversions = { _ in true }` (the board only sends PSDs it confirmed); `await importImages(urls)`; `projectSnapshot` + `save(to: target)` (with QuickLook) | `{ width, height, layers, errors: importError, cmykProfile: proofProfile?.name }`; `errors` and no document → fail with the import text |
| `project.fromClipboard` | `{ target }` | `canPasteImageAsNewCanvas`, `pasteImageAsNewCanvas()` (hooks as above), save | as `project.fromImages`; `{ none: true }` when there is nothing to paste |
| `clipboard.inspect` | – | re-implemented `clipboardDimensions` (PNG then TIFF, orientation 5-8 swap, `validDimension`), `canPasteImageAsNewCanvas` on a blank session, `NSPasteboard.general.string(forType: .string)` | `{ imageSize: [w, h] \| null, canPasteAsCanvas, sizeText: string \| null, hasRaw, hasPSD }` |
| `import.images` | `withSession` + `{ files, point: [x, y] \| null, raw: { path: settings } }` | hooks as above; `await session.importImages(urls, at: point)` | outcome + `{ errors: importError, cmykProfile }`; `editName` "Import Images" / "Import Photoshop File" |
| `psd.inspect` | `{ file, project? }` | `remaining = budget − used pixels of project`; `PSDReader.read(from:remainingPixels:)`; `PSDDocumentBuilder.makeImport` | `{ conversions: [{ layerName, message }], width, height, resolution, layers, backgroundOnly, cmykProfile }`; errors verbatim |
| `raw.asShot` | `{ file, project? }` | `RawImporter.pixelSize` (+ side and budget check → `tooLarge`), `RawImporter.asShot` | `{ exposure, temperature, tint, boost, noiseReduction, lensCorrection, highlightRecovery, asShot…, supports…, width, height }` |
| `raw.preview` | `{ file, settings, out }` | `RawImporter.Queue.shared.develop(url, settings:, limit: 800)` | PNG at `out`, `{ width, height }` |
| `raw.release` | – | `RawImporter.Queue.shared.release()` | `{}` |
| `export.begin` | `{ project }` | `load`; `render(snapshot)`; `render(…, sixteenBit: true)` if any `deep`; `render(…, sixteenBit: true, hdr: true)` if any HDR | `{ token, width, height, resolution, hasDeep, hasHDR }` |
| `export.preview` | `{ token, format, quality, matte: [r, g, b], width, height, sixteenBit, cmykProfile: name \| null, out }` | the `.task` body of `UI/ExportAsSheet.swift:211-230` (`resized`, `jpeg`, `tiffData`, `pngData`, `exrData`, `pdfData`, `flattened`, `CMYK.convert`, `DeepLayer.dithered`); profile by name from `CMYK.installed()` | preview at `out` (`previewType: 'jpeg' \| 'png'`), `{ bytes, previewWidth, previewHeight }`; keeps the encoded data in the session |
| `export.write` | `{ token, path }` | `ImageExporter.shared.write(data, to:)` | `{ bytes }` |
| `export.end` | `{ token }` | drop the session | `{}` |
| `export.png` | `{ project, path }` | `load` + `ImageExporter.shared.exportPNG(snapshot, to:)` | `{ width, height }` |
| `cmyk.profiles` | – | `CMYK.installed()`, `CMYK.chosen` | `{ profiles: [name], chosen }` |
| `cmyk.load` | `{ path }` | `CMYK.load(url)` | `{ name }`; `CMYKError` text |
| `project.quickLook` | `{ project, out }` | `load` + `ImageExporter.shared.quickLookImages(snapshot)` | JPEG at `out`, or `{ none: true }` |

The Claude Code plugin can reuse `export.png`, `export.*` and `import.images` for MCP tools later; they need no board.

---

## 16. Not applicable in VS Code, and adaptations

| Upstream | Status | Notes |
|---|---|---|
| Finder Open With, Dock drop, reopen window on file open, single editor window | N/A | the Compositor app keeps these; "Open in Compositor App" (exists) hands a project over |
| Info.plist document and UTType declarations | N/A (stay the app's) | VS Code analogues in 13 |
| Sandbox, security-scoped URLs | N/A | the extension and engine are unsandboxed |
| `NSDocumentController` recent list | Adapted | extension's own list (4.4); cannot be shared with the app |
| Untitled projects, "First save asks where", "Last blank tab can't close", "Closing the last tab leaves a fresh empty Untitled tab", "Blank start tab replaced" | Adapted / N/A | boards always have a location (decision in 3.11) |
| Save panels as window sheets | Adapted | VS Code dialogs |
| Background save with captured revision | Adapted | `document.saving` chain + autosave |
| Package swap on save | Adapted | per-file atomic writes under a lock (5.3); engine ops still swap |
| Live reload by kernel events, Revert / Keep Mine | Adapted | polling + merge (11) |
| QuickLook | **Still needed** | the board must restore `Preview.jpg` (12.2) |
| "Undo New Canvas" back to the welcome screen | N/A | creation is on disk, not an undo step |
| UserDefaults `jpegExportQuality`, `cmykProfile` | Adapted | `globalState` keys of the extension (10.5) |
| Export As holding the project busy | Adapted | the sheet is modal inside the board; other boards stay usable |
| Remappable menu chords (Keyboard Shortcuts editor) | Adapted | VS Code keybindings (`keybindings.json`) replace them |
| Canvas area cap | Adapted | the board keeps a Chromium-safe cap (1.2); say "This board can't show canvases over N megapixels." when refusing, and point to Compositor |
| Windows/Linux | N/A | the engine (ImageIO, Core Image RAW, ColorSync) is macOS-only; File import/export ops are unavailable there |

---

## 17. Test checks

Run engine ops directly (`printf '{"id":1,"op":"…","args":{…}}\n' | engine/bin/compositor-engine`) and through the
extension. Fixtures: `samples/parrot.comp` (512 × 512, one layer; `render` measured `{ documentWidth: 512, width: 256,
scale: 0.5 }` at `maxSize` 256), small generated PNG/JPEG/GIF/16-bit PNG/EXR files, PSDs produced by a port of
`CompositorTests/PSDFixture.swift` (or real PSDs), one DNG.

**New canvas (pure JS + core)**
1. `pixels("8.5", in, 300) = 2550`, `("11", in, 300) = 3300`, `("210", mm, 300) = 2480`, `("2,54", cm, 72) = 72`,
   `("1920", px, 300) = 1920`, `("19.5", px) = null`, `("200", in, 300) = null`, `("0", in, 300) = null`
   (`NewCanvasUnitTests.swift:7-17`); `text(1920, in, 72) = "26.67"`, `text(2550, in, 300) = "8.5"`,
   `text(2480, mm, 300) = "209.97"`; round trip for every print unit at 2550 @300; cycles px→in→cm→mm→px and
   transparent→white→black→transparent.
2. Presets: each fills its size in the current unit; 1920 × 1080 checks "1080p"; any other size checks "Custom".
3. Create: transparent → manifest one layer "Layer 1", no `imageFile`, `activeLayerID` = it, `resolution` 72; white /
   black → "Background" PNG of the canvas size, every pixel (255,255,255,255) / (0,0,0,255); 300 DPI stored as 300.
4. Validation texts appear exactly as 3.4, and Create is disabled.

**Open**
5. `project.inspect` on: `format` changed → invalid text; `version: 15` → "This project uses format version 15. This
   app supports versions 1–14."; a deleted image → `missingImage` text; `width: 30001` → `tooLarge` text with
   "800-megapixel" on this Mac; a deleted package → "The file “X.comp” doesn’t exist." Board: nothing opens and the
   modal shows the text.
6. Open the same project twice → one tab. Open from the side bar while open in a tab → moves (exists).
7. Recent: open, create and Save As add entries; a deleted entry disappears from the QuickPick and welcome list;
   Clear Menu empties it; at most 10.

**Save / Save As**
8. Save As to `Copy.comp` → new package with an identical manifest (same `documentID`), the new board open, old
   package unchanged; Save As to a plain path through VS Code's built-in Save As → clear error, no exception.
9. After board writes: `QuickLook/Preview.jpg` exists, long side ≤ 1024, white where the canvas is transparent; a
   60 MP canvas has no `QuickLook/`.

**Import**
10. 64 × 32 PNG into 128 × 128 → origin (32, 48), layer named after the file, on top, active, one undo step "Import
    Images"; into no document → canvas 64 × 32 at 72 DPI; two files at a drop point with no document → both centered.
11. Point (100, 100) on a 1000 × 800 canvas with the 64 × 32 PNG → origin (68, 84).
12. Folder with `10 Ten.png`, `2 Two.jpeg`, `.Hidden.png`, `More/Nested.png`, `Notes.txt`, `Project.comp/` → layers
    "2 Two", "10 Ten"; empty folder → `“<name>” has no images to import.`
13. GIF → "<name>.gif: Choose a JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) file."; a text file named
    `.png` → unreadable text; a good PNG in the same batch still imports; two failures joined by a blank line.
14. 16-bit PNG → layer saved as 16-bit PNG, manifest version ≥ 12; EXR with values up to 4.0 → `.exr` layer
    (version ≥ 13); EXR with values ≤ 1.0 → 16-bit PNG.
15. Over budget: a 30,001-px-wide PNG → `tooLarge` text.
16. CMYK JPEG starting a document → result `cmykProfile` is its profile name (or "Generic CMYK Profile").
17. SVG 100 × 50 into a 400 × 400 canvas → 400 × 200 layer; with no document → 100 × 50 canvas.

**PSD**
18. Fixture "Sky" 4 × 2 → new document 4 × 2, one layer "Sky"; again into it → a folder named after the file holding
    "Sky" (`PSDRoundTripTests.swift:238-256`).
19. Blend `diss` → one conversion "Blend mode “diss” isn’t supported and will be applied as Normal."; cancelling it
    leaves the board unchanged; `sLit` (Soft Light) → no conversion (`PSDRoundTripTests.swift:186-211`).
20. Layer counts and order for a fixture with a folder (divider, children, folder record): folder parent ids match;
    hidden layer stays hidden; opacity = opacity × fill.
21. Header version 3 → version text; depth 16 → "Only 8-bit RGB and CMYK Photoshop files can be imported."; mode 1
    (gray) → same; ZIP compression on a color channel → compression text; PSB fixture → same content as PSD.
22. Background-only PSD → one layer from the merged image, no sheet.

**RAW**
23. `raw.asShot` on a DNG: temperature/tint equal `CIRAWFilter` neutral values; `supports…` flags; Reset disabled at
    as-shot. `raw.preview` long edge ≤ 800. Import → 16-bit layer named after the file; Cancel → nothing; a RAW over
    the budget → `tooLarge` before the sheet.

**Export**
24. Export PNG of parrot: 512 × 512, alpha kept, `pHYs` 2835 px/m at 72 DPI (computed; 11811 at 300 measured),
    chunks as measured; the
    board stays clean (no dirty flag, no history step).
25. JPEG: quality 0.1 bytes < quality 1 bytes; transparent canvas with matte (0, 0, 1) decodes to blue ± 0.03, alpha 255,
    sRGB (`JPEGExportTests.swift:8-30`); default quality 0.85 then remembered after an export at 0.6.
26. TIFF RGB: compression 5, alpha present; TIFF CMYK: color model CMYK, embedded profile, no alpha.
27. PDF of a 6 × 6 canvas at 150 DPI → one page 2.88 × 2.88 pt, `/FlateDecode` present, `/DCTDecode` absent
    (`ExportTests.swift:66-90`); Export As PDF fills transparency with the background.
28. EXR offered only with an HDR layer; exported EXR keeps values > 1.
29. Scale clamp: 10,000 × 10,000 canvas, choose 200 % → 141 % (14,142 × 14,142); 20 % typed width → height follows;
    1 % minimum.
30. Status line and byte-size strings exactly as 10.2 (use the measured formatter table).
31. A 30,000 × 30,000 canvas → "Image export supports canvases up to 200 megapixels and 30,000 pixels per side."

**Drag and drop (manual, real VS Code)**
32. Finder PNG onto a board → layer at the drop point; onto the side bar welcome → new project; a Finder folder → its
    images; a web image → the unreadable message; Explorer image without Shift → VS Code opens it, with Shift → imports;
    Explorer `.comp` with Shift → opens the board; highlight appears and disappears; refused while a filter panel is
    open.

**Round trip with Compositor (manual)**
33. Create, import a PSD, export: open the package in Compositor 1.5.3: same layers, no validation error; Compositor's
    Export PNG and the engine's `export.png` produce byte-identical pixels (compare decoded RGBA).

---

## 18. Upstream quirks a faithful port inherits (or deliberately drops)

1. `showsNewDocument` is never set to `true` in 1.5.3 (only cleared, `Document/EditorSession.swift:1052`), so every
   gate that tests it ("disabled … on the New Document screen", "Drops refused while … the New canvas screen") is
   inert: on the welcome screen Import Images… is enabled and drops are accepted (they create the canvas).
2. "Open one project at a time" exists only in the single-window controller path; the tabbed app opens each `.comp`
   in its own tab. Its informative text is the unrelated "This is not a valid Compositor project, or its metadata is
   damaged."
3. The unsupported-format message names only JPEG, PNG, HEIC, HEIF, TIFF, WebP and PSD, though EXR, HDR, PSB, RAW and
   SVG import too; the unreadable-drop message has the same list.
4. Float sources become HDR layers only when brighter than white (peak > 1.001); others become 16-bit layers.
5. With no document, the drop point is ignored for every file of that request, not just the first.
6. Imports append at the top of the stack (not above the active layer) but parent into the active folder.
7. PSD blend notes quote the 4-character key ("diss", "dkCl", "lgCl"), and the folder note does not trim it ("mul ").
8. Cancelling the PSD sheet while reading does not stop the read; it finishes and is discarded.
9. Export As keeps `isProjectBusy` for the whole sheet, so the status bar shows "Working…" behind it.
10. The JPEG save panel suggests `.jpeg` (measured `preferredFilenameExtension`), not `.jpg`.
11. A failed Load Profile… leaves its error in the sheet and Export… disabled until any setting changes.
12. Export As PDF always fills the page with the background, so its transparency is never kept (the plain `pdfData`
    path would keep it).
13. Double-click in a zoomed preview goes to Fit, not back to the previous zoom; double-click at Fit goes to 100 %.
14. Export PNG… is always 8-bit; only Export As offers 16-bit PNG.
15. The New Canvas parser accepts anything Swift's `Double` accepts, including `1e3` and `0x10`, and turns every comma
    into a decimal point.
16. "Undo New Canvas" and undoing the first import return the tab to the welcome screen.
17. The RAW "8-bit dithered" path only serves previews; imported RAWs are always 16-bit layers.
18. The pixel budget, and so the "N-megapixel" in messages, depends on the Mac's RAM (800 here; 536 on 8 GB).
19. JPEG export writes JFIF X/YDensity 300 with DensityUnit 0 ("aspect ratio only") at 300 DPI, yet ImageIO reads
    300 DPI back (measured); check what other apps (Photoshop, Preview) report before relying on it.

---

## 19. Checklist coverage

Every checklist line of the File section and the related Edit / Keyboard / Preferences / App-level lines, by short
title. Status: **Port** (reproduce), **Adapt** (VS Code form, see section), **N/A**.

| Checklist line (short title) | Section | Status |
|---|---|---|
| New canvas › New Canvas… menu item | 2, 3.1, 14.1 | Adapt |
| New canvas › Toolbar "+" New canvas button | 3.1, 14.1 | Adapt (editor-title `+`, side-bar title) |
| New canvas › Welcome screen | 3.1, 3.11 | Adapt (side-bar welcome, New Canvas panel) |
| New canvas › Title "New canvas" | 3.2 | Port |
| New canvas › Width field | 3.2, 3.3 | Port |
| New canvas › Height field | 3.2 | Port |
| New canvas › Size validation | 3.3, 3.4 | Port |
| New canvas › Validation message | 3.4 | Port |
| New canvas › Preset sizes menu | 3.5 | Port |
| New canvas › Preset "4K" … "YouTube Thumb" (12 lines) | 3.5 | Port |
| New canvas › Background pill | 3.6 | Port |
| New canvas › First layer | 3.9, 3.11 | Port (core `createProject`) |
| New canvas › Units pill | 3.6 | Port |
| New canvas › Resolution pill | 3.6 | Port |
| New canvas › Stored resolution | 3.6 | Port |
| New canvas › Clipboard size suggestion | 3.7, 15.2 `clipboard.inspect` | Port via engine |
| New canvas › "Open project" button | 3.8 | Port |
| New canvas › "Import image" button | 3.8, 6.6 | Port |
| New canvas › "Create canvas" button | 3.8, 3.11 | Adapt (asks location) |
| New canvas › Sheet disabled while an import or long operation runs | 3.2 | Port |
| Open › Several .comp files … "Open one project at a time" | 4.1, 18.2 | N/A (dead path) |
| Open › Open Project… menu item | 2, 4.4 | Adapt |
| Open › Open panel | 4.1, 14.3 | Adapt (files + folders) |
| Open › Already-open project | 4.1, 4.4 | Port (exists) |
| Open › Blank start tab replaced | 4.1 | N/A |
| Open › Validate before replacing | 4.1, 4.4 | Port (`project.inspect`) |
| Open › Missing file | 4.1, 4.4 | Port |
| Open › Error alert | 1.3 | Port |
| Open › Error text (4 lines) | 1.3 | Port (needs 15.1 item 1) |
| Open › After opening | 4.1, 4.4 | Port |
| Open › Recorded in Open Recent and watched | 4.1, 4.4, 11 | Adapt |
| Open › Confirm replacing (single-window path) | 4.1 | N/A |
| Open Recent › Submenu | 4.2, 4.4 | Adapt (QuickPick) |
| Open Recent › Source of the list | 4.2, 4.4 | Adapt |
| Open Recent › Missing projects hidden | 4.2, 4.4 | Port |
| Open Recent › Updated on every successful open and save | 4.2, 4.4 | Port |
| Open Recent › Clear Menu | 4.2, 4.4 | Port |
| Save › Save menu item | 2, 5.3 | Adapt (VS Code Save) |
| Save › First save asks where | 5.1, 5.3 | N/A while boards are created with a location |
| Save › Pending canvas edits settled first | 5.1 | Port (board commits its transform/crop before writing) |
| Save › Background save | 5.1, 5.3 | Adapt |
| Save › Serialized saves | 5.1, 5.3 | Port (exists) |
| Save › Saved state | 5.1 | Port (VS Code dirty state) |
| Save › Package written | 5.1, 5.3 | Adapt (core writer) |
| Save › Atomic replace | 5.1, 5.3 | Adapt |
| Save › Save-time limits | 5.1, 5.3 | Port (`manifests.validate`) |
| Save › QuickLook preview written into the package on every save | 12 | Port (12.2) |
| Save › After save | 5.1, 4.4 | Adapt |
| Save › Error alert "Couldn’t save the project" | 1.3, 5.3 | Port |
| Save As › Save As… menu item | 5.2, 5.3 | Port (`compositorBoard.saveAs`) |
| Close Project › Close Project menu item | 4.3, 4.4 | Adapt |
| Close Project › Last blank tab can't close | 4.3 | N/A |
| Close Project › Closing the last tab leaves a fresh empty "Untitled" tab | 4.3 | N/A |
| Close Project › Unsaved-changes prompt | 1.3, 4.4 | Adapt |
| Close Project › Waits for an in-flight background save | 4.3, 4.4 | Port (`flush`) |
| Import Images › Import Images… menu item | 2, 6.6 | Port |
| Import Images › File picker | 6.1, 14.3 | Adapt |
| Import Images › Folders | 6.2 | Port (engine) |
| Import Images › Empty folder message | 6.2 | Port |
| Import Images › Format JPEG … Format SVG (10 lines) | 6.3 | Port (engine) |
| Import Images › Unsupported formats | 6.3 | Port |
| Import Images › First image makes the canvas | 6.5, 6.6 | Adapt (asks location) |
| Import Images › Placement | 6.5 | Port (engine) |
| Import Images › EXIF orientation applied and colors converted to 8-bit sRGB | 6.4 | Port (engine) |
| Import Images › More than 8 bits a channel | 6.4, 6.6 | Port (display limits on board) |
| Import Images › Float images | 6.4, 6.6 | Port (board needs an EXR display image) |
| Import Images › CMYK JPEG/TIFF … starts a new document | 6.4, 15.1 item 5 | Adapt |
| Import Images › One undo step per import batch | 6.5, 6.6 | Port |
| Import Images › Queued imports | 6.5 | Adapt (board serializes requests) |
| Import Images › Size limits | 6.5, 1.2 | Port |
| Import Images › Unreadable file error | 6.5 | Port |
| Import Images › Per-file failures collected and shown together | 6.5, 6.6 | Port |
| Camera RAW develop › Develop sheet | 7.1, 7.4 | Port |
| Camera RAW develop › Size checked first | 7.1 | Port |
| Camera RAW develop › Live preview | 7.3, 7.4 | Port |
| Camera RAW develop › Exposure / Temperature / Tint / Boost / Noise Reduction sliders | 7.2 | Port |
| Camera RAW develop › Lens Correction toggle | 7.2 | Port |
| Camera RAW develop › Highlight Recovery toggle | 7.2 | Port |
| Camera RAW develop › Reset button | 7.2 | Port |
| Camera RAW develop › Cancel button | 7.1 | Port |
| Camera RAW develop › Camera Raw… button | 7.1, 7.4 | Port when the Camera Raw filter exists |
| Camera RAW develop › Import button | 7.1 | Port |
| Camera RAW develop › Importing state | 7.1, 7.4 | Port |
| Camera RAW develop › 8-bit path dithered | 7.3 | Port (engine) |
| Photoshop PSD/PSB import › PSD (version 1) and PSB (version 2) | 8.1 | Port (engine) |
| … › 8 bits per channel only | 8.1 | Port |
| … › RGB and CMYK color modes accepted | 8.1 | Port |
| … › CMYK files converted to RGB | 8.1 | Port |
| … › Layer compression | 8.1 | Port |
| … › Other read errors | 8.1 | Port |
| … › Canvas limits | 8.1 | Port |
| … › Resolution read from the file | 8.1 | Port |
| … › Background-only file | 8.1 | Port |
| … › Too-large file cropped to canvas | 8.1, 8.2 | Port |
| … › Layer names | 8.1 | Port |
| … › Visibility kept | 8.1 | Port |
| … › Opacity | 8.1 | Port |
| … › Folders (groups) | 8.1, 8.2 | Port |
| … › Blend modes mapped (24) | 8.1 | Port |
| … › Unmapped blend modes | 8.1, 8.2 | Port |
| … › Layer masks | 8.1 | Port |
| … › Unconvertible mask skipped | 8.2 | Port |
| … › Clipping masks | 8.1, 8.2 | Port |
| … › Adjustment layers kept | 8.1, 8.2 | Port |
| … › Other adjustment layers skipped | 8.1, 8.2 | Port |
| … › Editable text | 8.1 | Port |
| … › Text that can't map | 8.2 | Port |
| … › Text notes | 8.2 | Port |
| … › Missing font | 8.2 | Port |
| … › Live shapes | 8.1, 8.2 | Port |
| … › Other vector shapes rasterized | 8.2 | Port |
| … › Smart objects rasterized | 8.2 | Port |
| … › Layer effects discarded | 8.2 | Port |
| … › Unknown layer types imported as pixels | 8.2 | Port |
| … › New document from a PSD | 8.3 | Port |
| … › PSD into an open document | 8.3 | Port |
| … › Conversion report sheet | 8.3, 8.5 | Port |
| … › Report title | 8.4 | Port |
| … › Report subtitle | 8.4 | Port |
| … › Report list | 8.4 | Port |
| … › Report Cancel button | 8.4 | Port |
| … › Report "Import" confirm button | 8.4 | Port |
| Export PNG › Export PNG… menu item | 9 | Port |
| Export PNG › Save panel titled "Export PNG" | 9, 14.3 | Adapt |
| Export PNG › DPI metadata | 9 | Port |
| Export PNG › Flattening | 9 | Port (engine) |
| Export PNG › Export never marks the project as saved | 9 | Port |
| Export PNG › Size limit | 1.3, 9 | Port |
| Export PNG › Error alert "Couldn’t export PNG" | 1.3 | Port |
| Export JPEG › Export JPEG… menu item | 10.1, 10.5 | Port |
| Export As › Export As… menu item | 10.1, 10.5 | Port (sheet in the board) |
| Export As › Format segmented control | 10.2 | Port |
| Export As › More formats menu | 10.2 | Port |
| Export As › Size fields | 10.2 | Port |
| Export As › Scale menu | 10.2 | Port |
| Export As › Scale limits | 10.2 | Port |
| Export As › JPEG Quality slider | 10.2, 10.5 | Adapt (globalState) |
| Export As › PNG Depth toggle | 10.2 | Port |
| Export As › Color menu | 10.2, 10.5 | Adapt (profile by name) |
| Export As › Load Profile… button | 10.2, 10.5 | Adapt |
| Export As › PDF Page row | 10.2 | Port |
| Export As › Background color swatch | 10.2, 10.5 | Port |
| Export As › JPEG / PNG / TIFF / PDF / EXR output (5 lines) | 10.3 | Port (engine) |
| Export As › Status line | 10.2 | Port |
| Export As › Live preview | 10.4, 10.5 | Port |
| Export As › Estimated file size | 10.2 | Port |
| Export As › Preview area | 10.4 | Port |
| Export As › Preview zoom steps | 10.4 | Port |
| Export As › Preview gestures | 10.4 | Port |
| Export As › View-menu zoom redirected | 10.4, 14.6 | Port |
| Export As › Cancel button | 10.2 | Port |
| Export As › Export… button | 10.1, 10.2 | Port |
| Export As › Error alert "Couldn’t export" | 1.3 | Port |
| Project format › `.comp` package | 11 | Port (core) |
| Project format › Versions | 11 | Port (core) |
| Project format › Load limits | 11 | Port (core) |
| Project format › Live reload | 11 | Adapt (polling) |
| Project format › Change detection by content | 11 | Adapt |
| Project format › Reload in place | 11 | Port |
| Project format › Waits for edits | 11 | Adapt |
| Project format › Unsaved-changes conflict | 11 | Adapt |
| Project format › Background tab conflict deferred | 11 | Adapt |
| Project format › Half-written or invalid package ignored silently | 11 | Port |
| Project format › Watching stops when the tab gets a new canvas or is closed | 11 | Port (poll cleared on dispose) |
| QuickLook › Preview.jpg | 12 | Port (12.2) |
| QuickLook › No QuickLook extension | 12 | N/A |
| Document types › Compositor Project | 13 | N/A (app) / VS Code analogue |
| Document types › Images | 13 | Adapt (Explorer commands) |
| Document types › Folders | 13 | Adapt |
| Document types › Imported UTTypes | 13 | N/A |
| Document types › Exported UTType "Compositor Layer" | 13 | Adapt (App-level) |
| Edit › Clipboard › Paste (⌘V) priority | 2, 3.10 | Port (first branch here) |
| Edit › Clipboard › Paste on the New canvas screen | 3.10, 14.6 | Port via engine |
| Keyboard shortcuts › Menus › New Canvas ⌘N, Open Project ⌘O, Close Project ⌘W | 2, 14.6 | Adapt (VS Code keeps the chords) |
| Keyboard shortcuts › Menus › Save ⌘S | 2, 14.6 | Port |
| Keyboard shortcuts › Menus › Save As ⇧⌘S, Export JPEG ⌥⇧⌘S, Export PNG ⇧⌘E, Export As ⌥⇧⌘W | 2, 14.6 | Port (scoped keybindings) |
| Keyboard shortcuts › Menus › Fit Canvas ⌘0 / Actual Pixels ⌘1 (preview redirect) | 2, 10.4 | Port |
| Keyboard shortcuts › Menus › Paste ⌘V | 2, 14.6 | Port |
| Keyboard shortcuts › Fixed › Dialog Apply/Cancel buttons (New canvas Create, Export As, RAW, PSD) | 3.8, 7.4, 8.4, 10.2 | Port |
| Preferences › Persisted keys › jpegExportQuality | 10.2, 10.5 | Adapt |
| Preferences › Persisted keys › cmykProfile | 10.2, 10.5 | Adapt |
| Preferences › Other persisted state › Recent projects | 4.2, 4.4 | Adapt |
| Preferences › Other persisted state › Loaded CMYK profiles | 10.2, 15.1 item 5 | Adapt (engine's own folder) |
| App-level › Drag and drop (8 lines) | 14.5 | Adapt |
| App-level › Busy and errors › File requests wait | 1.1 | Port |
