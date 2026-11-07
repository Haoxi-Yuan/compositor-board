# Compositor Chrome (Rail, View, Search Commands, Shortcuts, Preferences, App, Status Bar): Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3). All `file:line` references are relative to
`upstream/Compositor/` unless they start with `media/` (= `vscode-extension/media/`), `extension.js`, `package.json`,
`engine/`, `docs/` or `VSCode:`. `VSCode:` points into the locally installed VS Code 1.142.0
(`/Applications/Visual Studio Code.app/Contents/Resources/app/out/`): `VSCode:workbench` is
`vs/workbench/workbench.desktop.main.js`, `VSCode:main` is `mainImpl.js`, `VSCode:pre` is
`vs/workbench/contrib/webview/browser/pre/index.html`. Modifier glyphs: `⌘` Command, `⌥` Option, `⇧` Shift, `⌃`
Control, `⌫` Delete, `⎋` Escape, `↩` Return. Code excerpts are verbatim.

Scope: every checklist line of `docs/parity/features.md` in "Tool rail and tool switching" (50-67), "No tool (A)"
(341-345), "## View" (1368-1488), "Search Commands" (1792-1832), "## Keyboard shortcuts" (1833-1967),
"## Preferences/persisted settings" (1968-2012), "## App-level" (2013-2104) and "## Status bar and hints"
(2105-2145; the Help-text list after it gets an approach note, section 19.4). Behaviour that another spec already owns
is referenced, not repeated: `ui.md` (layout, colors, zoom, keys in VS Code), `selection.md`, `brush.md`, `shapes.md`,
`compositing.md` (render pipeline, downsampling, crisp zoom), `manifest.md` (guides on disk).

Files read in full: `UI/CanvasRulers.swift` (185 lines), `Document/Guides.swift` (315), `UI/GridSettingsSheet.swift`
(125), `UI/NavigatorMinimap.swift` (78), `Rendering/NavigatorGeometry.swift` (52), `Document/EditorSession+Navigator.swift`
(45), `UI/CommandPalette.swift` (253), `UI/CommandPaletteView.swift` (144), `UI/KeyboardShortcuts.swift` (366),
`IO/CMYK.swift` (190), `ContentView.swift` (493), `CompositorApp.swift` (407), `UI/FloatingPanel.swift` (176),
`UI/ProjectTabs.swift` (435), `UI/ProjectTabLayout.swift` (78), `IO/CompositorApplicationDelegate.swift` (223),
`UI/ProjectWindowBridge.swift` (62), `IO/RecentProjects.swift` (33), `IO/ImageFileDrop.swift` (60),
`UI/HeldModifiers.swift` (39), `UI/NumericScrub.swift` (63), `UI/SliderSnap.swift` (42),
`Rendering/CanvasViewport.swift` (84), `Rendering/CanvasLinesOverlay.swift` (12), `Document/ToolDefaults.swift` (42).
Read in part: `Rendering/EditorCanvas.swift` (key monitor `:770-816`, draw `:855-935`, pixel grid `:1395-1445`, guide
press/drag `:1655-1668, 1848-1862, 1980-1990, 2108-2116, 2568-2612`, scroll/magnify/keyDown/keyUp `:2176-2350`, GPU
frame and proof `:2740-2780`), `Rendering/TransformOverlay.swift` (`:160-295`), `Document/EditorSession.swift`
(`:86-345, 395-445, 1066-1092`), `Document/ProjectWorkspace.swift` (`:1-200`), `UI/LayerMaskMenu.swift` (`:30-103`),
`IO/ProjectController.swift` (`:170-215, 336-356`), `IO/UpdateDriver.swift` (strings), `Document/CanvasRotation.swift`,
`Rendering/DownsampleCache.swift` (head), `upstream/Config/Info.plist`, `upstream/Compositor.xcodeproj/project.pbxproj`
(bundle id `com.wonderassembly.compositor`, sandboxed). Board side: `media/board.js` (constructor, layout, rail,
options bar, `updateStatus`, `menus()`, `keydown`/`keyup`), `media/menus.js`, `media/view.js`, `media/board.css`,
`media/transform.js` (snap targets), `media/document.js` (snapshot), `extension.js`, `package.json`,
`engine/Sources/EngineMain.swift`, `engine/Sources/FilterOps.swift`, `engine/build.sh`.

**Measured.** Facts marked **(measured)** were produced on this Mac (Darwin 25.6, VS Code 1.142.0): a scratch Swift
program compiled from upstream's `CommandPaletteSearch` (verbatim) and the ruler step function, a scratch Swift program
running `CMYK.proofLookups`' exact Core Graphics calls against `/System/Library/ColorSync/Profiles/Generic CMYK
Profile.icc`, and Python scans of the VS Code bundles for default keybindings and native menu accelerators. The scratch
programs were deleted afterwards.

**Classification used for macOS-only items** (requirement: be conservative):

- **(a) Webview** — reproduced faithfully inside the board's webview (DOM, Canvas 2D, WebGL).
- **(b) VS Code** — mapped to the closest VS Code equivalent; the exact API, command, context key or setting is named.
- **(c) N/A** — genuinely not applicable, with the reason. Used only where no sensible equivalent exists.

---

## 0. Summary of key facts

| Topic | Compositor behaviour | Ref |
|---|---|---|
| View menu | Search Commands… ⌘F, Toggle Fullscreen (F), Fit Canvas ⌘0, Actual Pixels ⌘1, Zoom In ⌘=, Zoom Out ⌘-, Navigator (300% and above), Pixel Grid (800% and above), Show Transform Controls ⌘H, CMYK ▸, Show ▸ (Grid ⌘', Guides ⌘;), Grid Settings…, Rulers ⌘R, Snap ⇧⌘;, Snap To ▸ (Guides, Grid, Layers, Document Bounds), Lock Guides ⌥⌘;, Clear Guides | `CompositorApp.swift:105-194` |
| Persisted toggles | UserDefaults `tool.*` (rulers off, guides on, grid off, snap on, snap guides/layers/bounds on, snap grid off, lock guides off, pixel grid on, auto select off, transform controls on, grid 64/8, Light Gray, Lines, 45%), `navigator.visible` off, `layersPanelWidth` 252, `cmykProfile`, `jpegExportQuality` 0.85, `keyboardShortcuts.v1` | `Document/EditorSession.swift:198-202, 280-341`, `ContentView.swift:6-7`, `IO/CMYK.swift:101-110` |
| Rulers | 18 pt, document pixels only, origin at the document's top-left, ~70 pt between numbered ticks, 1-2-5 steps (min step 5 px reachable), labels 8 pt; drag out a guide | `UI/CanvasRulers.swift` |
| Guides | cyan 90 %, 1 device px, whole view; 5 pt hit; create from rulers, move with the Move tool, delete by dropping on a ruler; undo "New Guide" / "Move Guide" / "Delete Guide" / "Clear Guides"; saved in the manifest (v8) | `Document/Guides.swift` |
| Grid | major every 64 px, 8 subdivisions; subdivisions dotted at 28/45 of the opacity and only when >= 4 pt apart; settings sheet "Grid" | `Document/Guides.swift:34-120`, `UI/GridSettingsSheet.swift` |
| Navigator | top-right minimap, 126 x 90 pt box, only at zoom >= 300 %, accent 2.5 pt view box, click/drag centres the view | `UI/NavigatorMinimap.swift` |
| Pixel grid | from zoom 800 % (device px per document px >= 8), gray 0.55 at 45 %, 1 device px | `Rendering/EditorCanvas.swift:927, 1404-1445` |
| Canvas Only | F; hides every bar and panel, black surround, Esc leaves when nothing to cancel | `IO/CompositorApplicationDelegate.swift:55-154` |
| CMYK proof | 33³ RGB→RGB lookup computed by ColorSync through the profile (relative colorimetric, on white paper); gamut warning = moved > 10/255 → 50 % gray; applied with `CIColorCubeWithColorSpace` in sRGB to the on-screen picture | `IO/CMYK.swift:132-184`, `Rendering/EditorCanvas.swift:2762-2771` |
| Search Commands | 460 x 290 panel; entries = every actionable menu item by path + 2 layer-mask commands + 23 tool entries; launcher-style fuzzy scoring with 5 tiers | `UI/CommandPalette*.swift` |
| Shortcuts | 119 remappable definitions (Menus 51, Canvas & Layers 59, Text Editing 9); overrides JSON in `keyboardShortcuts.v1`; canvas keys translated back to their original chord | `UI/KeyboardShortcuts.swift` |
| Status bar | 30 pt, 11 pt monospaced digits, zoom (0-1 decimals, locale percent), `W × H px`, `sRGB · Transparent`, per-tool hint; spinner + "Working…" after 250 ms | `ContentView.swift:349-371` |

**Board today.** Read on 2026-10-20 at 00:20; another change set to `media/board.js`, `media/view.js` and
`extension.js` landed while this spec was being written, so board references use function names rather than line
numbers, and section 22.2 should be re-checked before fixing. The board has a menu bar (`media/menus.js`; Edit, Image,
Layer, Select, View; View holds Show Transform Controls and the four zoom items, `Board.menus()`), hard-coded chords in
`Board.keydown`, a No-tool state (`'none'`, key A), and person-level preferences for Auto Select, Show Controls and the
panel width in `globalState` `compositorBoard.preferences` (`extension.js`). It has no rulers, guides UI, grid,
Navigator, pixel grid, Canvas Only, CMYK proof, palette or shortcut editor. Section 22.2 lists the deviations still
present.

**Decisions the user should confirm** (each is explained where it arises):

1. Canvas Only in VS Code: in-webview only, or also run a workbench command (section 11.3; recommendation:
   in-webview plus `workbench.action.toggleMaximizeEditorGroup`, controlled by a new setting).
2. Preferences across open boards: read once per board as Compositor does per tab (faithful), or broadcast every change
   to every open board (section 17.3; recommendation: faithful).
3. Remapping "Toggle Fullscreen": upstream's remap does not take effect (quirk Q3, section 22); implement the evident
   intent or keep the quirk (recommendation: implement the intent).
4. ⌘H "Show Transform Controls": keep ⌘H as default and test whether the webview can pre-empt macOS Hide, or ship it
   unassigned in the board (section 16.5; recommendation: test first, fall back to unassigned).
5. Tab title: contribute `workbench.editor.customLabels.patterns` as a configuration default so a board tab reads
   `X.comp` instead of `manifest.json` (section 18.1).

---

## 1. Platform constraints (apply to every section)

### 1.1 What the webview can and cannot do

| Concern | Fact | Consequence for the port |
|---|---|---|
| Keys | The preload forwards every `keydown`/`keyup` that reaches the webview's `window` (bubble phase) to the workbench, which runs VS Code keybindings for it (`VSCode:pre:603-650`). It `preventDefault`s ⌘Z/Y/P/F/S and, on Electron, ⌘C/V/X first (`VSCode:pre:608-613`) | The board's single `document` `keydown` listener must call `preventDefault()` **and** `stopPropagation()` on every chord it consumes (already done in `Board.keydown`); anything it lets through still runs VS Code's binding |
| Native accelerators | VS Code's macOS app menu registers real accelerators: `role:"hide", accelerator:"Command+H"`, `role:"hideOthers", accelerator:"Command+Alt+H"`, `role:"minimize", accelerator:"Command+M"` **(measured, `VSCode:main`)**. Other menu items get accelerators through `withKeybinding` when `isNative !== false` | Chromium on macOS offers ⌘-key equivalents to the renderer first and redispatches unhandled ones to the menu, so a `preventDefault`ed chord *may* not reach the native menu. This is **unverified for role items**: assume ⌘H, ⌥⌘H, ⌘M and ⌘Q cannot be pre-empted until tested in a real VS Code build (same stance as `ui.md` 12.1) |
| Drag and drop | The preload `preventDefault`s `dragover`/`drop` on `window` and posts file drags to the workbench, which shows its own "open in editor" overlay **unless Shift is held** (`VSCode:pre:792-833`, `postMessage('drag', { shiftKey })`) | External file drops onto the canvas need Shift held (VS Code's rule for webviews). Drops from the VS Code Explorer carry `text/uri-list` |
| Windows | A webview is one rectangle inside a VS Code editor or view; it cannot open native windows, panels, sheets or alerts, or draw outside itself | Floating panels, the palette, sheets and pills are in-page DOM (a); native dialogs go through `vscode.window.*` (b) |
| Menus | Extensions cannot add top-level menus to the native menu bar | Compositor's menu bar is the board's in-webview menu bar (`media/menus.js`) (a); selected commands are also contributed to VS Code's Command Palette (b) |
| Sound | No access to the system alert sound (`NSSound.beep`) and no extension API for VS Code's accessibility signals | A short Web Audio tone (sine 880 Hz, 60 ms, gain 0.08) stands in for the beep (a, approximated) |
| Storage | `vscode.setState` is per webview; `ExtensionContext.globalState` is per user across windows and workspaces; `globalStorageUri` is a per-extension folder | UserDefaults maps to `globalState`, Application Support to `globalStorageUri` (section 17) |
| Colour management | The webview canvas is 8-bit sRGB; no ICC conversion API in the browser | CMYK proof cubes come from the engine (ColorSync), section 12 |

### 1.2 Classification of the macOS-app-only items

| Item (upstream) | Class | Port |
|---|---|---|
| `NSPanel` floating tool dialogs (`UI/FloatingPanel.swift`) | (a) | In-webview draggable panels (`Board.panel()`), position remembered per panel name for the session (section 18.6) |
| Docked-right panel (Camera Raw, 440 pt, full height) | (a) | In-webview panel docked to the board's right edge, full board height, 440 px, not remembered |
| Command palette `PalettePanel` (borderless, key, hides on resign) | (a) | In-webview overlay, section 15 |
| Keyboard Shortcuts floating panel and `NSButton` recorder | (a) | In-webview panel, section 16.4 |
| Grid Settings window-modal sheet | (a) | In-webview modal sheet, section 7.2 |
| `NSView` rulers, `CanvasLinesOverlay` | (a) | Canvas 2D, sections 5 and 10 |
| Canvas Only: hiding header, rail, rulers, panel, status bar, Navigator, toolbar | (a) | CSS state `#app.canvas-only`, section 11 |
| Canvas Only: `NSApp.presentationOptions = [.hideDock, .hideMenuBar]`, window set to the screen frame, animation-free | (b) | Optional workbench commands: `workbench.action.toggleMaximizeEditorGroup` (default), `workbench.action.toggleZenMode` or `workbench.action.toggleFullScreen`; instant fullscreen needs the user's `window.nativeFullScreen: false` (section 11.3) |
| Canvas Only: black click-through frame window outside the window's rounded interior (radius 26) | (c) | A webview cannot draw outside its rectangle; the frame only hides the screen around a window that covers the screen, which VS Code's own fullscreen already does |
| Canvas Only: "inside macOS full screen it only hides the toolbar" | (c) | No extension API reports whether VS Code is in full screen (`isFullscreen` is a context key, unreadable by extensions), so the board cannot branch on it; the in-webview part behaves the same either way |
| Custom `NSCursor`s | (a) | CSS cursors (`ui.md` 12.3) |
| `SliderSnap` swizzle (track click jumps) | (a) | Chromium's `<input type=range>` already moves the thumb to the press point at once and keeps dragging |
| `IndicatorlessScrollView` (rail) | (a) | `scrollbar-width: none` and `::-webkit-scrollbar { display: none }` on `.rail` |
| Always dark (`NSApp.appearance = darkAqua`) | (a) for the board, (b) for dialogs | Board chrome is hard-coded dark (`:root` tokens and `color-scheme: dark` in `media/board.css`). Native dialogs (`showOpenDialog`, `showErrorMessage`, save prompts) follow VS Code's theme: VS Code has no per-extension appearance override |
| `NSSound.beep()` | (a) approximated | Web Audio tone, section 1.1 |
| `NSAlert` errors ("Import couldn’t finish", "Couldn’t paint", …) | (b) | `vscode.window.showErrorMessage(title, { modal: true, detail: message }, 'OK')` |
| `NSAlert` "Save changes to <name>?" | (b) | VS Code's own dirty-editor prompt on close/quit for a `CustomEditorProvider` document (`onDidChangeCustomDocument` makes it dirty, `BoardProvider.recordEdit`) |
| `NSOpenPanel` / `NSSavePanel` | (b) | `vscode.window.showOpenDialog` / `showSaveDialog` (already used by `newBoard` and `pickPackage` in `extension.js`) |
| Project tab strip, overflow pill, reorder, close button, unsaved dot | (b) | VS Code editor tabs of the custom editor `compositorBoard.board` (section 18.1) |
| Single `Window("Compositor", id: "editor")`, default 1180 x 780, first-launch fill, restored frame (`NSWindow Frame editor`) | (b) | The VS Code window; VS Code restores its own windows and editors (`window.restoreWindows`) |
| Window minimum content 800 x 520 | (c) | VS Code owns the window's minimum size; the board instead switches to its compact layout below 560 px (the `ResizeObserver` in `Board.buildDom()`) |
| Unified compact window toolbar (New canvas +, tabs, Fit, 100 %, zoom) | (b) + (a) | "+" → `editor/title` contribution running `compositorBoard.new`; Fit/100 %/zoom live at the right end of the board's options bar (`Board.renderOptions()`, already) |
| Window proxy (`representedURL`, edited dot on the close button) | (b) | VS Code's window title (`window.title`, `${activeEditorShort}` and `${dirty}`) and the tab's dirty dot |
| Title-bar drag area beside the tabs | (c) | VS Code's title bar handles window dragging; the board has no title bar |
| `NSDocumentController` recent list (shared with the Dock menu) | (b) | Extension `globalState` key `compositorBoard.recent` (8 entries, filtered to existing packages, `remember()` and `SidebarBoard.showEmpty()` in `extension.js`); shown in the board's File › Open Recent and the side-bar welcome |
| App menu: About, Check for Updates…, Hide Compositor, Hide Others ⌥⌘H, Show All, Quit ⌘Q | (b) / (c) | Hide/Hide Others/Show All/Quit are VS Code's own app-menu items (same chords). Check for Updates… → "Extensions: Check for Extension Updates" (`workbench.extensions.action.checkForUpdates`) when the extension is installed from a gallery; (c) for this locally built VSIX (`package.json`: `"publisher": "haoxi-local"`, `"private": true`), which has no update feed |
| Sparkle updater (feed, EdDSA, installer launcher, first-run prompt, update alert, "What’s new", buttons, auto-install checkbox, `UpdateFeedURL`, appcast) | (b) / (c) | (b) VS Code's extension update flow: `extensions.autoUpdate`, `extensions.autoCheckUpdates`, per-extension "Auto Update" toggle and the CHANGELOG in the Extensions view, when published. (c) for everything Sparkle-specific: the extension does not update the Compositor app, whose own Sparkle keeps working for "Open in Compositor App" |
| Removing Writing Tools, AutoFill, Start Dictation, Emoji & Symbols, Enter Full Screen from the menus; `NSDisabledDictationMenuItem` / `NSDisabledCharacterPaletteMenuItem` | (c) | Those are AppKit items in the host app's native menu bar; the native menu bar belongs to VS Code and extensions cannot edit it. The board's in-webview menus never contain them |
| Dock icon click reopens the editor; launched by opening a file sends itself a reopen event | (c) | VS Code's app lifecycle, not the extension's |
| Files opened from Finder or dropped on the Dock icon | (b) | Explorer context menu "Open Board in Editor" (`compositorBoard.open`, exists), and `code path/X.comp/manifest.json` (the custom editor is the default for `**/*.comp/manifest.json`, `package.json`) |
| UserDefaults keys | (b) | `ExtensionContext.globalState`, keys in section 17.2 |
| `~/Library/Application Support/CMYK Profiles` | (b) | `context.globalStorageUri` + `/CMYK Profiles` (section 12.6) |
| `CompositorCPUCanvas` (Metal vs Core Graphics) | (c) | The board has one Canvas 2D renderer (plus a WebGL pass for the proof); there is nothing to switch |
| Under XCTest, compiled defaults and no writes | (a) | The board's prefs store is injectable; tests pass an in-memory store |
| ⌃⌘F macOS full screen ("stays standard") | (b) | VS Code's `workbench.action.toggleFullScreen` (mac ⌃⌘F, **(measured)** `primary:2340`). Note the clash with Last Filter (Q7) |
| Window tabbing (macOS "Show Tab Bar") | (c) | Compositor uses its own tab strip; VS Code has its own tabs |

---

## 2. Tool rail and tool switching (checklist 50-67) and No tool (341-345)

Exact layout, icons and tooltips are in `ui.md` 1.5; tool-switch semantics in `ui.md` 3. This section states what each
checklist line requires and what the board must change.

### 2.1 Rail

| Checklist line | Exact behaviour | Port plan |
|---|---|---|
| "Rail layout" | `IndicatorlessScrollView { VStack(spacing: 10) { … } .padding(.top, 16).padding(.bottom, 12).frame(width: 56) }`; one 36 x 36 button per `NavigationTool.allCases` minus `.idle`: Move, Marquee, Lasso, Magic, Crop, Brush, Spot Healing, Clone Stamp, Blur/Smear, Gradient, Shape, Type, Eyedropper, Hand, Zoom. Selected: fill `white 0.12` in a radius-7 rounded rect plus a 1 pt `white 0.14` border. Hidden in Canvas Only (`ContentView.swift:84-87, 310-343`) | (a). `.rail` already has 56 px, gap 10, padding 16/12 and the selected style (`.rail`, `.tool.on` in `media/board.css`). Add the six missing tools in this order as they ship (Crop after Magic; Spot Healing, Clone Stamp, Blur/Smear, Gradient after Brush; Type after Shape). The board-only "Note for Claude (N)" button stays after Eyedropper as a documented extension. Hide the scrollbar (`scrollbar-width: none; &::-webkit-scrollbar { display: none }`); today `overflow-y: auto` shows one. Hide the rail in Canvas Only (section 11) |
| "Tooltips/accessibility labels" | `NavigationTool.label` verbatim: "Move / Transform (V)", "Marquee (M)", "Lasso (L)", "Magic (W) · Tab switches Wand and Object", "Crop (C)", "Brush (B) · Eraser (E)", "Spot Healing Brush (J)", "Clone Stamp (S) · Option-click sets the source", "Smear (R)", "Gradient (G)", "Shape (U) · Shift-U switches Rectangle/Ellipse", "Type (T)", "Eyedropper (I)", "Hand (H)", "Zoom (Z)"; used for `.help` and `.accessibilityLabel`; static, so the Brush label does not change in Erase mode (`Document/EditorSession.swift:99`, `ContentView.swift:333`) | (a). Done for the ported tools (`TOOLS` in `media/board.js`, verbatim and static). Add `aria-label` next to `title`. Keep the Shape text verbatim although it is inaccurate (features.md "Where the code and the README disagree") |
| "Mode-following icons" | Brush shows SF `eraser` in Erase mode; Marquee shows `circle.dashed` in Ellipse mode; Lasso a custom polygonal icon in Polygonal mode; Magic a custom object-selection icon in Object mode; Gradient and Clone Stamp always custom; the rest SF Symbols at 17 pt; custom icons 18 x 18 (`ContentView.swift:316-323`) | (a). Done for Brush, Marquee, Lasso, Magic (`Board.renderRail()`). Gradient and Clone Stamp need custom SVGs when those tools ship (SF Symbols cannot be redistributed, `ui.md` 12.3) |
| "Color palette under the tools" | `ColorPaletteControls(session:).padding(.top, 8)` after the tools (`ContentView.swift:337`) | Done (`Board.buildRail()`; `ui.md` 1.5) |

### 2.2 Tool switching

| Checklist line | Exact behaviour | Port plan |
|---|---|---|
| "Single-key tool selection" | With no ⌘/⌃/⌥ held: V Move, M Marquee, L Lasso, W Magic, C Crop, B Brush + Paint, E Brush + Erase, J Spot Healing, S Clone Stamp, R Blur/Smear, G Gradient, U Shape, T Type, I Eyedropper, H Hand, Z Zoom, A No tool. Handled by the canvas `keyDown` (`Rendering/EditorCanvas.swift:2286-2319`) and the Layers list; never while an `NSText` (text field or text view) is first responder; header toggles, pop-up buttons and sliders do not block them. Remappable (section 16) | The board handles V M L W B E U I H Z A (+ N for notes) in `Board.keydown`; add C J S R G T with their tools. `isTyping` in `media/board.js` already lets checkboxes, sliders and buttons through, but still counts a focused `<select>` as typing; Compositor's pop-up buttons are not `NSText`, so drop `SELECT` from `isTyping` |
| "M / W / L ignore key repeat" (ticked) | M re-selects the Marquee in its last shape and L the Lasso in its last mode; W the Magic tool; key repeat ignored (`Rendering/EditorCanvas.swift:2300-2305`) | done (`!e.repeat` in `Board.keydown`) |
| "Shift+letter also selects the tool" | `charactersIgnoringModifiers.lowercased()` makes ⇧V = V, unless ⇧ has its own command (⇧U Cycle shape kind, ⇧[ / ⇧] hardness, ⇧- / ⇧= blend mode); with overrides, the explicit rule of `canvasEvent` (section 16.3) | The board's letter map ignores Shift already. Keep it through the remapping pipeline (section 16.3, rule 3) |
| "Tab cycles the current tool's mode" | Only when ⌘⌃⌥⇧ are all up and no text draft is open (`Rendering/EditorCanvas.swift:2276`); ignored while busy or during a stroke (`Document/EditorSession.swift:424-425`). Marquee Rectangle↔Ellipse, Magic Wand↔Object, Lasso Freehand↔Polygonal, Shape next kind, Brush Paint↔Erase, Smear next mode, Spot Healing next mode, Clone Stamp toggles Sample All Layers, Gradient next shape; no-op for the others | Done for the ported tools (`Board.cycleMode()`, ⇧Tab ignored); `preventDefault` Tab so focus does not move. Add the remaining modes with their tools |
| "Switching tools finishes any text…" | `selectTool`: `finishText()` first (abort if it refuses); no switch while busy, during a brush/warp stroke or with Levels open; on an actual change: commit transform, cancel crop, resolve gradient, cancel lasso, cancel shape draft (`Document/EditorSession.swift:395-398`) | Board: `Board.selectTool()` refuses while `view.busy` or an engine call runs, cancels drags and drafts, commits a floating selection. Add text, Levels, crop and gradient steps as those tools ship |
| "Brush-tip families" | Brush (Paint and Erase) and Spot Healing share one tip; Clone Stamp and Smear each keep their own (start 40 px, hardness 0, opacity 100 %); leaving a family parks its size/hardness/opacity and entering one restores the parked values (`Document/EditorSession.swift:220-225, 399-407`) | Board keeps one `this.brush`. Add `parkedTips = { brush, clone: {40,0,1}, smear: {40,0,1} }` swapped in `selectTool` when Clone Stamp / Smear ship |
| "Default tool at launch/new session is Move; the current tool is not persisted" | `var tool: NavigationTool = .move` (`Document/EditorSession.swift:172`) | Done (the `Board` constructor). Do not add the tool to any persisted state |
| "Temporary Hand" | Space down (no repeat) sets `spaceHeld`, open hand; drag pans with closed hand; released on key-up of **the same physical key code** (`panPhysicalKey`); cleared when the canvas resigns focus (`Rendering/EditorCanvas.swift:2281-2285, 2323-2347`). Remappable as "Temporary Hand tool (hold)" | Done for Space (`Board.keydown`, `Board.keyup`, the window `blur` handler). With a remap, remember `e.code` of the press that started the hold and release on keyup of that code |
| "Temporary Eyedropper" | ⌥ held with Brush, Spot Healing or Gradient, not mid-stroke or mid-drag: clicks sample, eyedropper cursor (`Rendering/EditorCanvas.swift:93, 1794-1798`) | Done for Brush (`media/view.js` `down`); extend to Spot Healing and Gradient when they ship |
| "Tool header bar" | Every tool has a 42 pt header (`toolHeaderBar()`), title 13 pt semibold, controls 12 pt; hidden in Canvas Only (`UI/ToolHeaderStyle.swift:3-8, 37-42`, `ContentView.swift:82`) | Done (the 42 px row of the `#app` grid in `media/board.css`). Hide in Canvas Only |
| "Held-modifier indicator" | `HeldModifiers` follows ⌘⇧⌥⌃ from `flagsChanged`, `keyDown`, mouse down/up; reports nothing while an `NSText` is first responder; resets to none when the app resigns active; re-reads on activation and when a menu closes. Header toggles show the flipped state while held: Auto Select with ⌘, aspect lock with ⇧ (`UI/HeldModifiers.swift:4-38`, `UI/TransformInspector.swift:14-15, 27-28`) | (a). One `window` capture listener for `keydown`, `keyup`, `pointerdown`, `pointerup` storing `{meta, shift, alt, ctrl}` (empty while typing per the corrected test above); `blur` and `visibilitychange` reset it; the board menu's `close()` re-reads it from the next event. The Move header re-renders the two toggles from it. The selection tools already do this (`SelectTools.heldModifiers`) |

### 2.3 No tool (A)

| Checklist line | Exact behaviour | Port plan |
|---|---|---|
| "Pressing A deselects every tool" | `selectTool(.idle)`: no rail button highlighted, arrow cursor (`Rendering/EditorCanvas.swift:1462`), canvas presses do nothing, Space and middle-drag still pan; status hint "No tool selected · Press a tool's key to pick one · Space to pan" (`Document/EditorSession.swift:92-93`, `ContentView.swift:365`) | Done as tool `'none'` (not in `TOOLS`): A in `Board.keydown`, `View.down()` ignores primary presses, `View.cursor()` shows `default`, hint in `Board.updateStatus()`. Make it the target of the "Select tool" definition (16.2) |
| "Header keeps its height with the title "Select a tool"" | `HStack(spacing: 16) { Text("Select a tool").font(ToolHeaderStyle.titleFont); Spacer() }.padding(.horizontal, 18).toolHeaderBar()` (`ContentView.swift:69-76`) | Done (`Board.renderOptions()`) |

---

## 3. The menu model the board needs

### 3.1 Menu bar order

Compositor's menu bar is: the app menu, File, Edit, View, then the `CommandMenu`s in declaration order (Select, Image,
Filter, Layer), then Window and Help. SwiftUI places custom command menus between View and Window
(`CompositorApp.swift:25-395`). The board shows `Edit, Image, Layer, Select, View` (`Board.menus()`).

Port: reorder to **File, Edit, View, Select, Image, Filter, Layer** (Filter once `media/filters.js` items move into a
menu). File is new and (b): its items run VS Code commands through the extension:

| File item | Compositor | Board action |
|---|---|---|
| New Canvas… ⌘N | new tab with the New canvas screen | post `{type:'command', command:'compositorBoard.new'}` |
| Open Project… ⌘O | open panel | `compositorBoard.open` (picks a `.comp`) |
| Open Recent ▸ names…, ─, Clear Menu | `RecentProjects` | items from the extension's `compositorBoard.recent` list (sent with `load`), Clear Menu empties it |
| Import Images… | file importer | owned by the File spec |
| Save ⌘S / Save As… ⇧⌘S | save panels | `workbench.action.files.save` / `workbench.action.files.saveAs` (side bar: the board's own save in `Board.keydown`) |
| Export JPEG… ⌥⇧⌘S, Export PNG… ⇧⌘E, Export As… ⌥⇧⌘W | Export As sheet | owned by the File spec |
| Close Project ⌘W | close tab | `workbench.action.closeActiveEditor` (side bar: `compositorBoard.sidebar.close`) |

Shortcut labels in every menu come from the shortcut registry (section 16), never from literals, so a remapped chord
shows. Default chords for the File items stay unconsumed by the board (VS Code runs its own ⌘N/⌘O/⌘S/⇧⌘S/⌘W).

### 3.2 View menu (exact order, `CompositorApp.swift:105-194`)

| # | Item | Kind, chord | Enabled when | Board handler |
|---|---|---|---|---|
| 1 | Search Commands… | button, ⌘F (definition "Search Commands") | always | `palette.toggle()` (section 15) |
| 2 | Toggle Fullscreen | toggle (checked = `canvasOnly`), plain F | `canToggleCanvasOnly`: document, no text draft, filter, Hue/Saturation, Levels, color picker, adjustment editing, effects panel, Color Range or selection-amount panel (`Document/EditorSession.swift:321-327`) | section 11 |
| — | separator | | | |
| 3 | Fit Canvas | ⌘0 | document | `previewZoom?.('fit') ?? view.fit()` |
| 4 | Actual Pixels | ⌘1 | document | `previewZoom?.('actual') ?? view.zoomTo(1)` |
| 5 | Zoom In | ⌘= | document; does nothing while a text field has focus | `previewZoom?.('zoomIn') ?? view.zoomStep(1)` |
| 6 | Zoom Out | ⌘- | same | `…zoomStep(-1)` |
| 7 | Navigator (300% and above) | toggle | always | section 9 |
| 8 | Pixel Grid (800% and above) | toggle | always | section 10 |
| 9 | Show Transform Controls | toggle, ⌘H | Move tool and a document | `toggleTransformControls()` (prefs `showControls`) |
| — | separator | | | |
| 10 | CMYK ▸ Proof Colors / Gamut Warning / ─ / Profile ▸ (one toggle per profile, ─, Load Profile…) | toggles; no default chords (assignable "CMYK Proof Colors", "CMYK Gamut Warning") | document (Profile ▸ always) | section 12 |
| — | separator | | | |
| 11 | Show ▸ Grid ⌘', Guides ⌘; | toggles | document | sections 7, 6 |
| 12 | Grid Settings… | button | document | section 7.2 |
| 13 | Rulers | toggle, ⌘R | document | section 5 |
| — | separator | | | |
| 14 | Snap | toggle, ⇧⌘; | document | section 8 |
| 15 | Snap To ▸ Guides, Grid, Layers, Document Bounds | toggles | document | section 8 |
| — | separator | | | |
| 16 | Lock Guides | toggle, ⌥⌘; | document | section 6 |
| 17 | Clear Guides | button | `canClearGuides` (any guide exists) | section 6 |

The board's View menu today lists Show Transform Controls first, then Zoom In, Zoom Out, Fit Canvas, Actual Pixels (`Board.menus()`); use the order above. AppKit adds its own toolbar items to View ("Hide Toolbar", "Customize Toolbar…"; Enter Full Screen is removed by the
delegate). They are (c) for the board, which has no window toolbar. Verify the exact list on the running app
(`/Applications/Compositor.app`) before ticking the palette lines.

### 3.3 Edit menu addition

`CommandGroup(after: .pasteboard)` starts with a divider and **Keyboard Shortcuts…** before the fill items
(`CompositorApp.swift:234-236`). Insert it after Paste's separator in `Board.menus()`, before "Fill with Foreground
Color". It opens the editor of section 16.4.

### 3.4 Item model

Extend each item in `menus()` with `id` (stable, e.g. `view.rulers`) and `def` (the `ShortcutDefinition` title it uses,
e.g. `"Show Rulers"`); keep `label`, `enabled`, `checked`, `run`, `submenu`. `menus.js` renders
`CB.Shortcuts.labelFor(item.def)` in the shortcut column (empty for an unassigned chord). The palette (section 15.2)
walks the same structure.

---

## 4. Zoom (View › Zoom, checklist 1370-1388)

The viewport model is in `ui.md` 6. Per-line status:

| Checklist line | Exact behaviour | Board status and port plan |
|---|---|---|
| "Fit Canvas" | `zoom = clamp(min(max(1, viewW − 96) / docW, max(1, viewH − 96) / docH) × backingScale)`, `pan = 0`, `followsFit = true`; ⌘0; disabled with no document (`Rendering/CanvasViewport.swift:35-41`) | `View.fit()` omits `max(1, …)`: a stage under 96 px gives a negative ratio clamped to 0.1 %. Use `Math.max(1, w - 96)` |
| "Fit follows window resizes" | while `followsFit`, every resize or backing-scale change refits; any zoom or pan clears it (`:43-54`) | Done (`resize()` refits; backing-scale changes go through `View.watchDisplay()`) |
| "Actual Pixels" | zoom 1 = one document pixel per device pixel; ⌘1 | Done (`ppp = zoom / dpr`) |
| "Zoom In" | next level above `zoom + max(1e-9, zoom·1e-9)`, anchored at the view centre; ⌘=; ⌘+ and keypad + also, with key repeat, **only while Zoom In keeps its default chord**; nothing while a text field has focus (`CompositorApp.swift:124-128`, `Rendering/EditorCanvas.swift:798-816`) | Done in `zoomStep`. Fix the chord test (section 16.3): require ⌘ (on macOS `metaKey`) with no ⌃/⌥; accept `Equal` with or without ⇧ and `NumpadAdd` |
| "Zoom Out" | previous level; ⌘- and keypad -; **⇧⌘- does not zoom** (`isZoomOut = [27, 78].contains(keyCode) && !shift`) | Board zooms on ⇧⌘- and on ⌃- too (`Board.keydown` accepts `metaKey` or `ctrlKey` and ignores Shift). Fix as above |
| "Keyboard zoom levels" | `[12.5, 16.7, 25, 33.3, 50, 66.7, 100, 125, 150, 200, 300, 400, 500, 600, 800, 1200, 1600] %` (exact fractions 1/6, 1/3, 2/3) | Identical (`ZOOM_LEVELS` in `media/view.js`) |
| "Zoom range clamp" | 0.001…32 for every path | Identical (`MIN_ZOOM`, `MAX_ZOOM`) |
| "Toolbar Fit button" | "Fit", help "Fit canvas in window (⌘0)", disabled with no document | Done (`Board.renderOptions()`) |
| "Toolbar 100% button" | "100%", help "Actual pixels (⌘1)" | Done |
| "Toolbar zoom in / zoom out" | SF `plus.magnifyingglass` then `minus.magnifyingglass` (in-button first), help "Zoom in (⌘+)" / "Zoom out (⌘−)" (U+2212 in the source) | Done (`Board.renderOptions()`) |
| "Pinch to zoom" | `zoom *= 1 + magnification` at the pointer; ignored during a transform drag, crop drag, guide drag, brush or warp stroke (`:2195-2199`) | Board ignores wheel during `view.busy` (stroke, transform, shape, pixel move). Match upstream: block during transform, crop, guide drag and stroke only; shape drafts and pixel moves may zoom |
| "⌘ or ⌥ + scroll wheel" | `zoom *= exp(−scrollingDeltaY × 0.015)` at the pointer (`:2185-2187`) | **Direction check.** Chromium's DOM `deltaY` is the negated AppKit `scrollingDeltaY`, so the faithful formula is `exp(+deltaY × line × 0.015)` (as `ui.md` 12.3 says). The board uses `exp(−deltaY …)` which zooms the opposite way (`View.wheel()`). Verify on a trackpad against the app (⌘ + two-finger swipe) and flip |
| "Scroll to pan" | precise deltas ×1, line-based ×12 (`:2188-2193`) | Done (`View.wheel()`) |
| "Middle mouse button drag pans" | any tool, closed-hand cursor | Done (`View.down()`) |
| "⌘ or ⌃ + middle mouse drag zooms" | about the press point, up = in, ×2 per 100 pt; zoom-in/zoom-out cursor follows the direction | Done (`View.down()`, `View.cursor()`) |
| "Preview-zoom redirect" | while a dialog with its own zoomable preview is open (Export As), the four zoom commands act on it (`session.previewZoom`) | Board: an optional `this.previewZoom(command)` hook that the Export As panel (File spec) installs and removes; the View items and their chords call it first |
| "Moving between displays" | on a backing-scale change without `followsFit`, `pan *= newPointsPerPixel / oldPointsPerPixel` so the centred document point stays (`:43-54`) | Done (`View.watchDisplay()`: a re-armed `matchMedia('(resolution: …dppx)')` listener scales the pan by old/new `devicePixelRatio` unless fitting, then `resize()`); VS Code's window zoom changes `devicePixelRatio` the same way |
| "High-quality downsampling when zoomed out" | Lanczos halvings, up to 6 levels, LRU | `compositing.md` (render pipeline); the board uses `imageSmoothingQuality = 'high'` |
| "Crisp pixels from 200%" | at zoom >= 2, 1:1 composite enlarged nearest-neighbour | Done (`imageSmoothingEnabled = zoom < CRISP_ZOOM` in `View.draw()`) |

---

## 5. Rulers (checklist 1390-1397)

### 5.1 Behaviour

| Checklist line | Exact behaviour |
|---|---|
| "Rulers toggle" | View › Rulers, ⌘R, default off, persisted `tool.rulers`; drawn only with a document and not in Canvas Only (`ContentView.swift:89-100`) |
| "Layout" | top ruler `CanvasRulerView(axis: .horizontal)` 18 pt high, preceded by an 18 x 18 corner; left ruler `axis: .vertical` 18 pt wide; both inside the canvas column, so the canvas view shrinks by 18 pt on top and left. Background `NSColor(white: 0.2)` = `#333333`; a hairline (1/backingScale pt) of `white 0.08` = `#141414` along the edge next to the canvas (bottom of the top ruler, right of the left ruler) (`UI/CanvasRulers.swift:4-6, 58-60, 124-129`) |
| "Units and origin" | document pixels only, 0 at the document's top-left, negative to the left/above; values from `viewport.documentPoint` of the ruler's two ends (`:74-83`) |
| "Tick spacing" | `step = majorStep(pointsPerPixel)` = first of `[1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000]` that is `>= 70 / ppp`, else 50000; `minor = step / 10`; each minor value gets a tick: major 8 pt (numbered), mid (multiple of step/2) 5 pt, other 3 pt; ticks `white 0.62` = `#9E9E9E`, one hairline wide, anchored to the canvas edge (`:63-65, 95-104, 174-179`) |
| "Labels" | `NSFont.monospacedDigitSystemFont(ofSize: 8)`, `white 0.78` = `#C7C7C7`; text = the value rounded, "0" for zero (no "-0"); top ruler: drawn at (tick + 2, 0); left ruler: `translate(1, tick + 2)`, `rotate(−90°)`, drawn at (−width, 0), so the label sits below its tick and reads bottom-to-top (`:69-72, 105-121, 181-184`) |
| "Rulers redraw live while panning/zooming" | `updateNSView` reads `session.viewport`, so every viewport change redraws both rulers; scroll calls `redrawRulers()` (`Rendering/EditorCanvas.swift:641, 2192`) |
| "Ruler corner" | `Rectangle().fill(Color(white: 0.2))` with a 1 pt line `white 0.28` from (5, 14) to (14, 5) in the 18 x 18 square; no action (`UI/CanvasRulers.swift:8-21`) |
| "Drag from a ruler creates a guide" | mouse-down: the canvas becomes first responder; if `canEditGuides`, `beginGuideCreation(axis: rulerAxis, at: documentPosition)` (top ruler → horizontal guide at document y; left ruler → vertical guide at document x); drag: `moveGuideDrag`; up: `finishGuideDrag(delete: isOverRuler)`. Cursor over the top ruler `resizeUpDown`, over the left ruler `resizeLeftRight`. Accessibility labels "Horizontal ruler" / "Vertical ruler" (`:51, 132-153`) |

Measured step values **(measured)**: ppp 32 → 5, 16 → 5, 8 → 10, 4 → 20, 1 → 100, 0.5 → 200, 0.25 → 500, 0.1 → 1000,
0.05 → 2000, 0.0005 → 50000. Steps 1 and 2 are unreachable because ppp never exceeds 32.

### 5.2 Port (a)

DOM: when rulers show, wrap the stage in a 2 x 2 grid `18px 1fr` / `18px 1fr`: corner, top ruler `<canvas>`, left ruler
`<canvas>`, stage. The stage's `ResizeObserver` refits as usual. Hide the rulers in Canvas Only and with no document.

Drawing (device-pixel canvases, `dpr = devicePixelRatio`, `hair = 1 / dpr` CSS px):

```js
function drawRuler(ctx, axis, lengthCss, view /* media/view.js View */) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#333333'; ctx.fillRect(0, 0, axis === 'h' ? lengthCss : 18, axis === 'h' ? 18 : lengthCss);
    const ppp = view.ppp, step = majorStep(ppp), minor = step / 10;
    const a = view.toDoc({ x: 0, y: 0 }), b = view.toDoc(axis === 'h' ? { x: lengthCss, y: 0 } : { x: 0, y: lengthCss });
    const start = axis === 'h' ? a.x : a.y, end = axis === 'h' ? b.x : b.y;   // ruler x/y == stage x/y
    const first = Math.floor(Math.min(start, end) / minor) * minor, last = Math.ceil(Math.max(start, end) / minor) * minor;
    const rem = (v, d) => v - d * Math.round(v / d);                          // Swift remainder(dividingBy:)
    ctx.font = '8px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    for (let value = first; value <= last + 0.001; value += minor) {         // accumulates like the Swift loop
        const at = axis === 'h' ? view.toScreen({ x: value, y: 0 }).x : view.toScreen({ x: 0, y: value }).y;
        const r = Math.abs(rem(value, step));
        const major = r < 0.001 || Math.abs(r - step) < 0.001;
        const mid = !major && Math.abs(rem(value, step / 2)) < 0.001;
        const len = major ? 8 : mid ? 5 : 3;
        ctx.fillStyle = '#9e9e9e';
        if (axis === 'h') ctx.fillRect(at - hair / 2, 18 - len, hair, len); else ctx.fillRect(18 - len, at - hair / 2, len, hair);
        if (major) drawLabel(ctx, axis, at, Math.round(value) === 0 ? '0' : String(Math.round(value)));
    }
    ctx.fillStyle = '#141414';
    if (axis === 'h') ctx.fillRect(0, 18 - hair, lengthCss, hair); else ctx.fillRect(18 - hair, 0, hair, lengthCss);
}
```

`drawLabel`: colour `#c7c7c7`, `textBaseline = 'alphabetic'`, `y = ascent` where `ascent =
measureText('0').fontBoundingBoxAscent` (AppKit's `draw(at:)` places the line's top at the point). Tabular digits: Canvas
has no `font-variant-numeric`, so advance each character by `measureText('0').width` (digits) or its own width ("-").
Horizontal: `x = at + 2`. Vertical: `save(); translate(1, at + 2); rotate(-Math.PI / 2); fillText at (-w, ascent);
restore()` where `w` is the label's laid-out width. `Math.round` rounds half up while Swift `rounded()` rounds half away
from zero; they differ only for negative halves (−2.5 → −2 vs −3), which a major tick never hits because majors are
integers.

Redraw: call from `View.draw()` (every pan, zoom, resize) when rulers show.

Interaction: `pointerdown` on a ruler → `stage.focus()`; if `canEditGuides()` begin a guide drag (section 6.3) with
`axis = top ? 'horizontal' : 'vertical'` and `position = view.toDoc(stagePoint)[top ? 'y' : 'x']`, where `stagePoint` is
the pointer relative to the stage (negative over the rulers); capture the pointer; `pointermove` moves the drag;
`pointerup` finishes with `delete = rulersShown && (stagePoint.x < 0 || stagePoint.y < 0)`. CSS `cursor: ns-resize` on the
top ruler, `ew-resize` on the left one.

---

## 6. Guides (checklist 1401-1413)

### 6.1 Model and persistence

`CanvasGuide { id: UUID, axis: "horizontal" | "vertical", position: Double }`: horizontal guides sit at a document y,
vertical at a document x; positions are fractional and never rounded except by snapping (`Document/Guides.swift:4-11`).
Saved in the manifest (`guides`, only when non-empty, needs format v8, at most 1,000, unique ids, finite, `abs <=
1_000_000`; `manifest.md` 7.5; `core/manifest.js:169-218` already validates and bumps the version). Undo covers them:
the board's `doc.snapshot()` is the manifest JSON (`BoardDocument.snapshot()`), so a guide edit is one
`history.push({ label, metaBefore, metaAfter, pixels: [] })`.

### 6.2 Toggles

| Checklist line | Exact behaviour | Port |
|---|---|---|
| "Show Guides" | View › Show › Guides, ⌘;, default on, persisted `tool.guides`; hidden guides are not hit, not moved and do not snap (`hitGuide` and `alignmentSnapTargets` test `showsGuides`) | prefs `guides` |
| "Lock Guides" | View › Lock Guides, ⌥⌘;, default off, persisted `tool.lockGuides`; `canEditGuides` and `hitGuide` are false while locked (no create, no move; locked guides still snap) | prefs `lockGuides` |
| "Clear Guides" | removes all guides as one undo step "Clear Guides"; disabled when there are none | menu item; `history.push` |

### 6.3 Editing

| Checklist line | Exact behaviour |
|---|---|
| "Create guide" | from a ruler (5.1). `beginGuideCreation` sets `showsGuides = true` (persisted), starts `GuideDrag(isNew: true)` at the **snapped** position; the drag shows it live; release (not over a ruler) appends it as undo step "New Guide" |
| "Cancel a new guide" | releasing a new guide over a ruler discards it (no undo step) |
| "Move guide" | Move tool only. Press order in the Move tool: double-click on live text → guide within 5 pt (`hitGuide`: nearest displayed guide whose view distance <= 5, requires `showsGuides && !locksGuides`) → transform handles/body (`Rendering/EditorCanvas.swift:1853-1856`). Hover: `resizeLeftRight` over a vertical guide, `resizeUpDown` over a horizontal one, but only where no transform handle is hit (`:1645-1663`). Drag: `moveGuideDrag(to: pointerDoc[axis])`, snapped; release: undo step "Move Guide" only if the position changed |
| "Delete guide" | release an existing guide over a ruler: undo step "Delete Guide". `isOverRuler(p) = showsRulers && (p.x < 0 \|\| p.y < 0)` in canvas coordinates (`:2600-2602`): **with rulers hidden a guide cannot be deleted by dragging** |
| "Escape cancels a guide drag" | ⎋ during a guide drag: `cancelGuideDrag()` (a new guide vanishes, a moved one returns), before transform cancel in the keyDown chain (`:2246-2248`) |
| "Guide placement snaps" | `snappedGuidePosition` (`Document/Guides.swift:287-314`): only when `snapEnabled`; tolerance `10 / ppp` document px; targets: grid lines incl. subdivisions (if `snapToGrid && showsGrid`), same-axis displayed guides except itself (if `snapToGuides && showsGuides`), `[0, length/2, length]` (if `snapToDocumentBounds`), each layer with pixels: min, centre and max of its displayed (transformed/distorted) corners on that axis, each `.rounded()` (if `snapToLayers`); nearest target within tolerance wins, the earlier target on ties. **No ⌃ bypass** for guides |
| "Guide model" | as 6.1 |
| "Guide appearance" | `CGColor(srgbRed: 0, green: 1, blue: 1, alpha: 0.9)`, line width `1 / backingScale` pt, each guide spans the **whole canvas view** including the pasteboard, drawn at its exact (unsnapped-to-pixel) view position (`Rendering/TransformOverlay.swift:244-266`) |
| "Guides follow canvas operations" | Canvas Size: `position += offset` on its axis; Image Size: `position *= scale`; Flip Canvas: mirror perpendicular guides `2·centre − position`; Rotate 90°: vertical cw → horizontal at x; vertical ccw → horizontal at `width − x`; horizontal cw → vertical at `height − y`; horizontal ccw → vertical at y (`Document/Guides.swift:12-31`, `Document/CanvasRotation.swift:18-26`) |
| "Guides cannot be edited while…" | `canEditGuides = document && !locksGuides && !isProjectBusy && !isImporting && !showsNewDocument && levels == nil && hueSaturation == nil && filterEdit == nil && renamingLayerID == nil` |

### 6.4 Port (a)

- State on the board: `this.guideDrag = { id, axis, position, isNew, original }`; `displayedGuides()` merges it into
  `doc.manifest.guides` exactly as `Document/Guides.swift:144-154`.
- `canEditGuides()`: `doc.manifest && !prefs.lockGuides && !this.working && !this.filters.isOpen && !renaming`
  (+ Levels, Hue/Saturation, import and New-canvas states when they exist).
- Move tool press (`media/view.js` `beginTransform` path): test `hitGuide` first; if hit, start a `guide` drag and set
  `drag.cursor`. `cursor()`: after the transform-handle test, show `ew-resize` / `ns-resize` over a guide.
- `pointerup`: `delete = rulersShown && (p.x < 0 || p.y < 0)` with `p` relative to the stage (pointer capture keeps
  events flowing over the rulers).
- Escape: in `keydown`'s Escape branch, cancel a guide drag before `view.cancel()`'s other work.
- New ids: `crypto.randomUUID().toUpperCase()` (Swift `UUID().uuidString` is upper case).
- Board-side canvas operations (if any are done in JS rather than the engine) apply the 6.3 formulas; engine
  operations already do (they run upstream code).
- Drawing: section 14 order; `ctx.strokeStyle = 'rgba(0,255,255,0.9)'`, `lineWidth = 1` on the device-pixel transform,
  positions `view.toScreen(...) * dpr` without rounding (Core Graphics anti-aliases the same way).
- 1,000-guide limit: upstream creates the 1,001st and then fails to save (`manifest.md`: tooLarge). Port: same, or
  refuse with the beep; listed as Q5.

---

## 7. Grid and Grid Settings (checklist 1417-1427)

### 7.1 Grid

| Checklist line | Exact behaviour |
|---|---|
| "Show Grid" | View › Show › Grid, ⌘', default off, persisted `tool.grid`; independent of the pixel grid; drawn over the document rectangle only |
| "Rendering" | `LayoutGrid(spacing, subdivisions)`, `step = spacing / subdivisions`; `lines(along: L) = (0...floor(L/step + 0.001)).map { (k·step).rounded() }`; `isMajor(v) = abs(v.rounded() mod spacing) < 0.001`. Drawn in document space with line width = one device pixel. Subdivisions (non-major lines) first, only if `step × ppp >= 4` pt, dash `[1, 2]` **pt**, colour × `subdivisionAlpha = majorAlpha × 28/45`; then majors with the style's dashes (`Lines` solid, `Dashed Lines` `[4, 3]` pt, `Dots` `[1, 2]` pt) at `majorAlpha = clamp(opacity, 1, 100) / 100`. Lines run from 0 to the document's width/height (`Document/Guides.swift:51-61, 115-119`, `Rendering/TransformOverlay.swift:199-242`) |

Example: spacing 10, subdivisions 3, length 20 → step 3.333…, `floor(6.001) = 6`, lines `[0, 3, 7, 10, 13, 17, 20]`,
majors 0, 10, 20 (Swift `rounded()` = half away from zero; use `Math.sign(v) * Math.round(Math.abs(v))`).

Port (a): draw in the overlay (section 14) with `ctx.setLineDash(dashPt.map(d => d * dpr))` on the device-pixel
transform, `lineWidth = 1`, `strokeStyle = rgba(r, g, b, alpha)` from the appearance; skip lines outside the visible
part for speed (positions are integers, so `Math.ceil(first/step)` … range).

### 7.2 Grid Settings… (window-modal sheet)

Exact content (`UI/GridSettingsSheet.swift:53-124`; `VStack(alignment: .leading, spacing: 18)`, padding 24, width 360,
`.textFieldStyle(.roundedBorder)`, rounded (capsule) buttons):

1. `Text("Grid").font(.title2.bold())` (17 pt bold). The sheet window's title is also "Grid".
2. Row "Color" (label 110 pt wide): pop-up of presets, labels hidden — "Light Gray", "Light Blue", "Light Red", "Green",
   "Medium Blue", "Yellow", "Magenta", "Cyan", "Black", "Custom"; then a dialog swatch titled "Grid Color", help
   "Choose a custom grid color".
3. Row "Style": pop-up "Lines", "Dashed Lines", "Dots".
4. Row "Opacity" (label scrubbable, sensitivity 0.5, 1…100), slider 1…100 (rounds to integers), number field 48 pt,
   trailing, ↑/↓ steps (⇧ ×10), unit suffix "%".
5. Divider.
6. Row "Gridline every" (scrubbable, sensitivity 1, 2…4096), number field, then "pixels" in secondary colour.
7. Row "Subdivisions" (scrubbable, sensitivity 0.2, 1…64), number field.
8. Info text (callout, wraps): valid → `"A subdivision every \(step formatted with 0–2 fraction digits) pixels."`
   (secondary); invalid → orange `"Use gridlines every 2–4,096 pixels and 1–64 subdivisions, no more than the pixels
   between gridlines."` (the upper bound is locale-formatted, "4,096" in English).
9. Buttons: "Cancel" (⎋, follows the Cancel canvas assignment), "Restore Defaults", spacer, "OK" (↩, prominent,
   disabled while invalid).

Behaviour: opening sets `showsGrid = true`; every appearance change previews at once, spacing/subdivision changes only
while valid; Cancel restores the original grid, appearance and shown state; OK keeps the new values and restores the
original shown state (so with the grid off, OK leaves it off); Restore Defaults resets spacing 64, subdivisions 8,
preset Light Gray, style Lines, opacity 45 and keeps the Custom colour (`IO/ProjectController.swift:181-205`,
`UI/GridSettingsSheet.swift:96-123`). Valid = spacing in 2…4096, subdivisions in 1…64 and `subdivisions <= spacing`;
the stored `LayoutGrid` also clamps subdivisions to the spacing. Colour swatch: opens the color picker on the current
colour; picking a colour different from the current one stores it as `customColor` and selects Custom, remembering the
preset it came from; picking that preset's colour again restores the preset; choosing a preset from the menu ends that
memory (`:31-45, 121`). Upstream writes each preview straight to UserDefaults (didSet) and writes the originals back on
Cancel.

Port (a): an in-webview **modal** sheet (blocks pointer and key input to the board, no dimming, attached at the top centre
of the board under the options bar, 360 px wide), built from the same controls as other panels (scrub labels,
`fieldKey` stepping). Preview by assigning the board's grid state and redrawing the overlay; write prefs only on OK
(deviation: no transient writes; harmless). The swatch uses `media/picker.js` with a dialog target.

Checklist lines covered above: "Grid Settings…" (opening, temporary grid, live preview, restored shown state),
"Grid Settings › Color preset" (item 2; preset values in 7.3), "Grid Settings › Color swatch" (the swatch rules),
"Grid Settings › Style" (item 3), "Grid Settings › Opacity" (item 4), "Grid Settings › Gridline every" (item 6),
"Grid Settings › Subdivisions" (item 7), "Grid Settings › Info line" (item 8), "Grid Settings › Cancel (Esc) restores the
previous grid; Restore Defaults …; OK (Return) commits" (item 9 and the behaviour paragraph), "Rendering" (7.1).

### 7.3 Preset colours (`Document/Guides.swift:67-88`)

Light Gray (0.7, 0.7, 0.7) = `#B3B3B3`, Light Blue (0.29, 0.78, 1) = `#4AC7FF`, Light Red (1, 0.4, 0.4) = `#FF6666`,
Green (0.25, 0.8, 0.25) = `#40CC40`, Medium Blue (0.2, 0.4, 1) = `#3366FF`, Yellow (1, 1, 0) = `#FFFF00`, Magenta
(1, 0, 1) = `#FF00FF`, Cyan (0, 1, 1) = `#00FFFF`, Black `#000000`, Custom = the stored custom colour (default 0.7 gray).
Hex values use `PaletteColor.hex` rounding (`round(c · 255)`, half away from zero).

---

## 8. Snapping (checklist 1431-1439)

| Checklist line | Exact behaviour |
|---|---|
| "Snap master toggle" | View › Snap, ⇧⌘;, default on, persisted `tool.snap`; turning it off clears `snapGuides` (feedback lines); governs move, resize, crop, selection moves, marquee/shape corners and guide placement |
| "Snap To › Guides" | default on, `tool.snapGuides`; only while guides show |
| "Snap To › Grid" | default off, `tool.snapGrid`; only while the grid shows; subdivision lines count |
| "Snap To › Layers" | default on, `tool.snapLayers`; other layers' bounding boxes from their transformed/distorted corners, edges `.rounded()`, centres too when the caller asks (`includeCenters`) |
| "Snap To › Document Bounds" | default on, `tool.snapBounds`; 0 and the size, plus the centre when `includeCenters` |
| "Snap distance" | `TransformSnap.distance = 10` pt → `10 / ppp` document px |
| "Control bypasses snapping" | ⌃ held while dragging: layer move/resize, selection move, marquee and shape corners, crop edges (not guides) |
| "Snap feedback lines" | accent colour, 1 pt (not device px), from document (x, 0) to (x, height) and (0, y) to (width, y), drawn last in the overlay (`Rendering/TransformOverlay.swift:269-288`) |
| "Rotation is never snapped" | rotation drags snap to whole degrees only (⇧ 15°); moves/resizes land on whole pixels |

Upstream target builder (`Document/Guides.swift:247-285`), to port verbatim into `media/transform.js` `snapTargets`:

```text
guard snapEnabled else { xs = [], ys = [] }
if snapToDocumentBounds: xs += [0, W] (+ W/2 if includeCenters); ys likewise
if snapToLayers: for layers with pixels, not moving: corners → min/max (and centre if includeCenters), each .rounded()
if snapToGrid && showsGrid: xs += grid.lines(along: W); ys += grid.lines(along: H)
if snapToGuides && showsGuides: displayed guides by axis
```

The board's snap targets (`snapTargets` in `media/transform.js`, called from `Board.snapTargets()`) always add bounds,
layers and every guide, never the grid, and ignore all five toggles. Pass the prefs in and follow the order above. Feedback lines are
drawn first in `View.drawOverlay()` today; move them to the end (section 14) and use `lineWidth = 1`
CSS px.

---

## 9. Navigator (checklist 1443-1448)

| Checklist line | Exact behaviour |
|---|---|
| "Navigator toggle" | View › Navigator (300% and above), default off, `@AppStorage("navigator.visible")` |
| "Visibility" | shown when on, not Canvas Only, and `viewport.zoom >= 3` (device px per document px); top-right of the canvas with 12 pt padding (`ContentView.swift:114-118`) |
| "Size" | `size(for: doc) = round(doc × min(126 / W, 90 / H))`; background `white 0.11` = `#1C1C1C`; clipped to a continuous rounded rect radius 4; inner 1 pt border `white 0.25`; shadow black 40 %, radius 6, y 2 (`UI/NavigatorMinimap.swift:13-22, 29, 42-45`) |
| "Picture" | `navigatorImage(maxSide: 300)`: the live composite (adjustments, masks, clipping) drawn by a fresh session, so transforms, previews and drafts in progress are **not** shown; scale `min(1, 300 / max(W, H))`, never enlarged; drawn with `.interpolation(.medium)`; first picture at once, later ones 250 ms after the layers stop changing; the render key is document id, size, layers and `brushRevision`, so selection and guide changes do not redraw it (`:15, 54-77`; `Document/EditorSession+Navigator.swift:4-22`) |
| "View box" | `thumbnailRect(visibleDocumentRect) ∩ imageRect`, `strokeBorder(accent, 2.5)` (inside the frame), at least 3 x 3 pt; not hit-testable (`:33-40`; `Rendering/NavigatorGeometry.swift:19-23, 34-42`) |
| "Click or drag in the minimap" | `DragGesture(minimumDistance: 0)` → `centerView(on: documentPoint(for: location))`, where the document point is clamped to `[0, W] x [0, H]`; implemented as a pan translation, so `followsFit` ends; pointer stays the arrow (`:47-50`; `Rendering/NavigatorGeometry.swift:25-31, 44-51`) |

Geometry (verbatim math):

```js
const box = { w: Math.round(W * Math.min(126 / W, 90 / H)), h: Math.round(H * Math.min(126 / W, 90 / H)) };
const s = Math.min(box.w / W, box.h / H);
const image = { x: (box.w - W * s) / 2, y: (box.h - H * s) / 2, w: W * s, h: H * s };
const toThumb = (r) => ({ x: image.x + r.x * s, y: image.y + r.y * s, w: r.w * s, h: r.h * s });
const toDoc = (p) => ({ x: clamp((p.x - image.x) / s, 0, W), y: clamp((p.y - image.y) / s, 0, H) });
// visible document rect: toDoc of the stage's (0,0) and (w,h), normalised
// centreOn(d): pan = { x: W·ppp/2 − d.x·ppp, y: H·ppp/2 − d.y·ppp }; followsFit = false
```

Port (a): an absolutely positioned `<div class="navigator">` in the stage (right 12, top 12) containing a `<canvas>` of
`box` size × dpr. The picture comes from the board's committed composite (not `compositeCanvas()` while a draft or
transform override is live: keep a second cache rendered without `renderer.overrides`), scaled into a 300 px canvas with
`imageSmoothingQuality = 'medium'`, refreshed 250 ms after the last committed edit (debounce; immediate when no picture
yet). CSS: `border-radius: 4px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.4)` (SwiftUI radius 6 ≈ CSS blur
12; tune by eye) and an inner `box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25)` overlay. Pointer: `pointerdown` +
capture, every `pointermove` recentres; `cursor: default`. The picture is not proofed (upstream uses
`drawLiveComposite`, not the proof lookup).

---

## 10. Pixel grid (checklist 1452-1453)

| Checklist line | Exact behaviour |
|---|---|
| "Pixel Grid toggle" | View › Pixel Grid (800% and above), default on, `tool.pixelGrid` |
| "Rendering" | when `showsPixelGrid && zoom >= 8` (`pixelGridZoom`, device px per document px): in the lines overlay (above the pixels, below every other overlay), over the document rectangle ∩ visible area only, a filled rect `1/backingScale` pt wide centred on every document pixel boundary from `ceil(first)` to `floor(last)` in both axes, colour `NSColor(white: 0.55, alpha: 0.45)` = `rgba(140,140,140,0.45)` (`Rendering/EditorCanvas.swift:927, 1404-1445`) |

Port (a): first thing drawn on the overlay canvas (section 14). On the device-pixel canvas: for each column `c` in range,
`x = (origin.x + c·ppp)·dpr`, `fillRect(x − 0.5, top, 1, height)`; rows likewise. At 800 % on a 2x display that is one
line every 8 device px; the loop count is bounded by the visible area.

---

## 11. Fullscreen / Canvas Only (checklist 1457-1463)

### 11.1 Behaviour

| Checklist line | Exact behaviour |
|---|---|
| "Toggle Fullscreen" | View › Toggle Fullscreen, a toggle on plain F (`.keyboardShortcut("f", modifiers: [])`); `toggleCanvasOnly()`; F again restores |
| "Hides" | tool header, rail, rulers, Layers panel and its resize edge, status bar, Navigator, toolbar, traffic lights, menu bar and Dock (`ContentView.swift:82-87, 89, 97, 114, 123, 129`; delegate `:108-117`) |
| "Black surround" | canvas pasteboard `white 0` instead of `0.105`; plus a click-through black window covering the screen outside the window's interior (inset 2, radius 26) |
| "Instant" | the window takes the screen frame without animation; inside macOS full screen only the toolbar hides; exit restores frame, title-bar settings and presentation options exactly |
| "Escape leaves Canvas Only" | a local monitor: ⎋ with no modifiers, Canvas Only on, `escapeHasNothingToCancel` (no text draft, Levels, brush/warp stroke, lasso draft, shape draft, gradient, crop, guide drag, transform edit, pixel move), the editor window key and no `NSText` first responder → leave (`:58-65`; `Document/EditorSession.swift:314-320`) |
| "Enabled only with a document and no text being typed, filter, …" | `canToggleCanvasOnly` (section 3.2 row 2) |
| "An F typed into a text field…" | a second monitor hands plain/⇧ F to the focused `NSText` before the menu sees it (`:66-72`) |

### 11.2 Port (a): inside the webview

- State `this.canvasOnly`; `#app.canvas-only` CSS: `grid-template-rows: 0 0 minmax(0,1fr) 0`, `.menubar, .options,
  .status, .rail, .resizer, .panel, .rulers, .navigator { display: none }`, stage `background: #000`;
  `View.draw()` fills the surround `#000000` instead of `#1b1b1b`.
- F: definition "Toggle Fullscreen…" (section 16); runs only when `canToggleCanvasOnly()`. The typing test already
  sends F to text fields first (the board's `keydown` returns early while typing).
- Escape: in the Escape branch, after the board's own cancel chain finds nothing to cancel
  (`!view.drag && !st.draft && !st.floating && !guideDrag && !openPanel …`), leave Canvas Only and consume.
- The Layers panel, menus and palette stay reachable through their chords (⌘F still opens the palette over the canvas).

### 11.3 Port (b): the workbench around it (decision 1)

New setting `compositorBoard.canvasOnly.workbench`: `"none" | "maximizeGroup" | "zenMode" | "fullScreen"`, default
`"maximizeGroup"`. On entering, the board posts `{type: 'canvasOnly', on: true}`; the extension runs:

| Value | Command on enter and again on exit (all are toggles) | Effect |
|---|---|---|
| `none` | — | the board area only |
| `maximizeGroup` | `workbench.action.toggleMaximizeEditorGroup` | the board's editor group takes the editor area |
| `zenMode` | `workbench.action.toggleZenMode` | hides activity bar, side bar, panel and status bar; enters full screen when `zenMode.fullScreen` (default true); also centres the layout when `zenMode.centerLayout` (default true), which narrows the board |
| `fullScreen` | `workbench.action.toggleFullScreen` | VS Code full screen; instant (no new Space) only when the user sets `window.nativeFullScreen: false` |

The extension remembers what it toggled per board and toggles back on exit or when the board is disposed. It cannot
read whether VS Code already is maximized or full screen, so a manual change in between leaves the workbench toggled
(accepted limitation). In the side bar the workbench step is skipped.

---

## 12. CMYK proofing (checklist 1467-1473)

### 12.1 Behaviour

| Checklist line | Exact behaviour |
|---|---|
| "Embedded profile naming" | a profile from a file is named by `ColorSyncProfileCopyDescriptionString` (trimmed), else "Embedded CMYK Profile" (`IO/CMYK.swift:64-71`) |
| "Proof Colors" | View › CMYK › Proof Colors; the canvas as printed through the chosen profile on white paper; relative colorimetric; 33³ lookup; default off, **not persisted** (a session variable, so per project tab); no default chord, assignable "CMYK Proof Colors"; turning it on with no profile chosen picks `CMYK.chosen` |
| "Gamut Warning" | View › CMYK › Gamut Warning; colours whose round trip moves any channel by more than 10 of 255 show 50 % gray, over the proof (both on) or over the document's own colours (warning only); default off, not persisted; assignable "CMYK Gamut Warning" |
| "Profile submenu" | View › CMYK › Profile: one toggle per CMYK profile (`.icc`/`.icm` whose `CGColorSpace(iccData:).model == .cmyk`) in `/System/Library/ColorSync/Profiles`, `/Library/ColorSync/Profiles` and the app's `Application Support/CMYK Profiles`, named by file name without extension, a later folder winning a name clash, sorted with `localizedStandardCompare`; checkmark on `proofProfile ?? CMYK.chosen`; choosing one sets `proofProfile` (and `cmykProfile`) |
| "Load Profile…" | `NSOpenPanel` for `icc`/`icm`, message "Choose a CMYK ICC profile, such as the one your printer gave you"; a CMYK profile is copied (atomically, keeping its file name) into `Application Support/CMYK Profiles` and chosen; otherwise the alert "Import couldn’t finish" says "That profile isn’t a CMYK output profile." (`CompositorApp.swift:398-406`; `IO/CMYK.swift:52-62, 187-190`; `ContentView.swift:292-296`) |
| "Chosen profile" | UserDefaults `cmykProfile` = name; read as the stored name, else "Generic CMYK Profile", else the first installed; shared with CMYK export; opening a CMYK file adopts its profile (an installed profile with identical data is chosen; otherwise the data is written as `<name with / → ->.icc` into the loaded folder and chosen) (`IO/CMYK.swift:74-110`; `Document/EditorSession.swift:286-287, 861-867`) |
| "Proof badges" | see 12.4 |

### 12.2 How the canvas applies it (GPU path)

`Rendering/EditorCanvas.swift:2762-2771`:

```swift
if session.proofsColors || session.showsGamutWarning, let profile = session.proofProfile,
   let lookups = CMYK.proofLookups(profile) {
    let lookup = session.proofsColors ? session.showsGamutWarning ? lookups.warning : lookups.proof : lookups.marked
    picture = picture.composited(over: gray(1).cropped(to: rect)).applyingFilter("CIColorCubeWithColorSpace", parameters: [
        "inputCubeDimension": CMYK.dimension,
        "inputCubeData": lookup,
        "inputColorSpace": CGColorSpace(name: CGColorSpace.sRGB)!,
    ])
}
```

- `picture` is the on-screen picture of the layers (already placed, scaled or crisp-enlarged), cropped to the document
  rectangle; it goes **over opaque white** (paper: transparency shows white, the checkerboard is hidden), then through
  the cube in sRGB-encoded values. The cube interpolates between lattice points (Core Image: trilinear), so the gamut
  gray blends softly at the boundary.
- The document edge line, the pixel grid and every overlay (grid, guides, selection, handles) are drawn after or above
  it and are not proofed. The Navigator is not proofed.
- The Core Graphics fallback canvas has no proof (quirk Q6).

### 12.3 The lookup (computed once per profile)

`IO/CMYK.swift:143-184`: build the 35,937-colour lattice (`level(i) = round(i · 255 / 32)`, red fastest, then green,
then blue), flatten over white in sRGB, draw into an 8-bit CMYK context of the profile with
`setRenderingIntent(.relativeColorimetric)`, draw that back into sRGB (relative colorimetric), and for each lattice
point produce three RGBA Float32 tables (alpha 1): `proof = shown / 255`; `off = max_c |shown_c − lattice_c|`;
`warning = off > 10 ? 0.5 : proof`; `marked = off > 10 ? 0.5 : lattice / 255`. Cached by profile **name**.

Measured with Generic CMYK Profile **(measured)**: the cube builds in 8 ms; 24,870 of 35,937 lattice points are out of
gamut. Test vectors (sRGB in → proof, max offset):

| Colour | In | Proof | Off | Gamut |
|---|---|---|---|---|
| white | 255,255,255 | 255,255,254 | 1 | in |
| black | 0,0,0 | 15,12,12 | 15 | **out** (warning shows black as gray) |
| red | 255,0,0 | 220,76,49 | 76 | out |
| green | 0,255,0 | 148,200,131 | 148 | out |
| blue | 0,0,255 | 46,85,149 | 106 | out |
| mid gray | 128,128,128 | 127,128,129 | 1 | in |
| cyan | 0,255,255 | 148,208,207 | 148 | out |
| skin | 239,175,143 | 231,175,145 | 8 | in |

### 12.4 Badges

`ContentView.swift:104-113`, `UI/LayerMaskMenu.swift:37-102`. At the foot of the canvas: `VStack(spacing: 8)` of
fixed-size pills (proof, then gamut warning, then the mask-alone badge), 14 pt above the bottom edge, centred. Each pill:
height 26, corner radius 13, background black 75 %, 1 pt border white 14 %, content insets left 11 / right 8,
spacing 7: icon (SF `printer` for the proof, `exclamationmark.triangle` for the warning; 11 pt, white), title 12 pt
semibold white ("CMYK Proof" / "CMYK Gamut Warning"), profile name 12 pt white 60 % (max 220 pt, tail truncation;
empty when no profile), close button SF `xmark` 9 pt bold white, tooltip "Show the document's own colors again" /
"Stop marking colors the profile can't print", accessibility label "Stop proofing" / "Hide the gamut warning";
clicking it turns that mode off.

Port (a): DOM pills in a `.canvas-badges` column (`position: absolute; bottom: 14px; left: 50%; transform:
translateX(-50%)`), Lucide `printer`, `triangle-alert`, `x`.

### 12.5 Port

- **Engine (macOS ColorSync, exact):** new ops `cmyk.profiles`, `cmyk.lookups`, `cmyk.validate` (section 20). The
  board asks for the lookups when proof or warning turns on (or the profile changes) through the existing
  `vscode.postMessage({type: 'engine', op, stateless: true, files: { out: 'bin' }})` path (`Board`'s engine call and
  `BoardProvider.runEngine`), gets 3 x 574,992 bytes back, and keeps them per profile name for the board's lifetime.
- **Board (WebGL2):** a `proof.js` module owning an offscreen WebGL2 context with a 33³ `RGBA16F` 3D texture per table
  (`texImage3D` with width = red, height = green, depth = blue, matching the red-fastest layout; the Float32 data is
  uploaded with type `FLOAT`, which WebGL2 accepts for `RGBA16F`; `LINEAR` min/mag filter, `CLAMP_TO_EDGE`; half-float
  linear filtering is core in WebGL2). Upload the picture with `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` and
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false` so the sRGB values reach the shader unchanged. Per frame,
  `View.draw()` renders the document rectangle ∩ visible area into a 2D scratch canvas exactly as now but with a white
  fill instead of the checkerboard, uploads it as a texture, runs the shader below into the GL canvas, and `drawImage`s
  the result back onto the stage canvas before the edge line and overlays.

  ```glsl
  #version 300 es
  precision highp float; precision highp sampler3D;
  uniform sampler2D picture; uniform sampler3D cube; in vec2 uv; out vec4 color;
  void main() {
      vec3 c = texture(picture, uv).rgb;                       // already over white, sRGB-encoded, opaque
      color = vec4(texture(cube, c * (32.0 / 33.0) + 0.5 / 33.0).rgb, 1.0);   // lattice centres
  }
  ```

- **Fallback without WebGL2:** apply the same trilinear lookup on the CPU to the document-resolution composite once per
  composite change and draw that (slower for large documents; colours identical up to resampling order).
- Order of resampling: upstream applies the cube after placing/scaling the picture; the WebGL pass above does the same.

### 12.6 Profiles in VS Code (b)

- Loaded profiles folder: `context.globalStorageUri.fsPath + '/CMYK Profiles'` (replaces the app's Application Support
  folder). The extension also scans, read-only, the Compositor app's own folder
  `~/Library/Containers/com.wonderassembly.compositor/Data/Library/Application Support/CMYK Profiles` when it exists, so
  profiles loaded in the app are offered too.
- Load Profile…: `vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'ICC profiles': ['icc', 'icm'] },
  title: 'Choose a CMYK ICC profile, such as the one your printer gave you' })` → engine `cmyk.validate` → on success
  copy into the folder (keeping the file name) and set prefs `cmykProfile`; on failure
  `showErrorMessage('Import couldn’t finish', { modal: true, detail: 'That profile isn’t a CMYK output profile.' })`.
- Chosen profile: prefs `cmykProfile` (section 17), resolved with the upstream rule (stored name → "Generic CMYK
  Profile" → first). Proof toggles are board-instance state, never persisted.

---

## 13. Canvas display (checklist 1477-1483)

| Checklist line | Exact behaviour | Board |
|---|---|---|
| "Pasteboard color" | `white 0.105` = `#1B1B1B` around the document, `#000` in Canvas Only; window background `white 0.14` = `#242424`; app always dark | Done (`View.draw()`, `--chrome`); add the Canvas Only black |
| "Document shadow" | 35 % black, offset (0, 3), blur 14 (CG) / Gaussian σ 7 (GPU), over a `white 0.26` underlay | Done (`View.draw()`) |
| "Transparency checkerboard" | 10 pt squares, `white 0.30` base with `0.35` where `(row+col)` is even, anchored at the document's top-left, fixed in screen space | Done; hidden (white) while proofing |
| "Document edge" | one device pixel `rgba(255,255,255,0.13)` centred on the document edge | Done |
| "Marching ants" | ticked, `selection.md` 6 | — |
| "GPU canvas" | Metal + Core Image, CG fallback, blending in sRGB | `compositing.md`; the board's Canvas 2D blends gamma-encoded sRGB like Core Image's sRGB working space |
| "Display dithering" | 16-bit/HDR frames get sub-level noise dithering | `compositing.md` 16-bit notes; the board shows deep layers as 8-bit today ("not shown here" chip); add dithering when deep layers are displayed |

---

## 14. Overlay stacking (one order for every on-canvas drawing)

Upstream layers, bottom to top: canvas pixels (surround, shadow, checkerboard or proof paper, picture, proof, document
edge) → `CanvasLinesOverlay` (pixel grid, text-box draft) → `TransformOverlay.draw` in this order: layout grid, guides,
then one of {progressive line, crop, gradient line, transform handles}, selection (ants), lasso draft, snap feedback
lines (`Rendering/TransformOverlay.swift:186-195`) → SwiftUI overlays (badges, Navigator) → floating panels.

Board order for `View.drawOverlay()`: pixel grid → layout grid → guides (with drag) → transform box
(or crop/gradient when they ship) → ants and lasso draft → snap lines → board-only extras (notes, brush circle, sample
ring). The badges and Navigator are DOM above the canvases.

---

## 15. Search Commands (checklist 1792-1832)

### 15.1 Behaviour

| Checklist line | Exact behaviour | Port (a) |
|---|---|---|
| "Open/close" | View › Search Commands…, ⌘F; `CommandPaletteController.toggle`: closes when already open (`UI/CommandPaletteView.swift:81-104`) | Item `view.searchCommands`, def "Search Commands". The palette's own field is a text field, so the toggle chord must be checked **before** the typing test while the palette has focus |
| "Panel" | 460 x 290 pt, titled panel with hidden transparent title bar and no window buttons (so it looks borderless), floating, centred on the editor window (`frame.midX − 230, midY − 145`); search field "Search commands and tools", 17 pt, plain style, padding 16 x 13, focused one run-loop turn after it appears; closes when it resigns key or the app deactivates (`:13-16, 49, 93-102, 119-133`) | `<div class="palette" role="dialog">` 460 x 290 CSS px (max `calc(100% − 16px)` in narrow boards), centred on the **board** (`#app`), dark window background with a 10-12 px radius and a window-like shadow (approximate macOS dark panel); `<input placeholder="Search commands and tools">` 17 px; focus it in `requestAnimationFrame`. Close on `focusout` to outside the palette, on a `pointerdown` outside it, and on `window` `blur` |
| "Rows" | full path title (one line), current shortcut right-aligned in callout monospaced secondary, a 12 pt-wide caption-semibold checkmark only on toggles that are on (other rows start at the edge), disabled rows in tertiary colour; the chosen row has `accentColor` at 35 % in a radius-6 rounded rect; rows padded 10 x 6, list padded 6 on the sides and top, no bottom padding; "No commands match" (secondary, centred) when empty (`:36, 52-66`) | DOM rows; `aria-selected` on the chosen one; monospaced shortcut `font: 12px ui-monospace, "SF Mono", monospace` |
| "Keyboard" | ↑/↓ move the choice and wrap (`((sel + step) % n + n) % n`); ↩ runs the chosen entry; ⎋ closes; a **changed** query resets the choice to row 0 (re-assigning the same text does not); the list scrolls the chosen row into view (`UI/CommandPalette.swift:236, 247-252`; `UI/CommandPaletteView.swift:17-20, 38-40`) | `keydown` on the input: ArrowUp/ArrowDown/Enter/Escape with `preventDefault` + `stopPropagation`; `input` event resets only when the value changed; `scrollIntoView({ block: 'nearest' })` |
| "Mouse" | clicking (tap) a row runs it | `click` on a row |
| "Run semantics" | disabled entry → beep, nothing runs, the palette stays open; otherwise close, make the editor window key, then `Task { @MainActor in entry.perform() }` (`:110-117`) | disabled → beep (1.1); else close, `stage.focus()`, `setTimeout(perform, 0)` |
| "Fuzzy match" / "Ranking tiers" | 15.3 | 15.3 |
| "Menu-bar entries" | every actionable item of every top-level menu and submenu, titled `Menu › Submenu › Item` (separator `" › "`), read afresh at each open after asking each menu's delegate to update and validating it, so state-dependent titles ("Undo Brush Stroke", "Last Filter: Gaussian Blur") and enabled/checked states are current; disabled items are listed greyed (`UI/CommandPalette.swift:101-144`) | 15.2 |
| "Exclusions" | the first top-level menu (the app menu) entirely; any item or submenu titled "Search Commands…", "Window", "Help" or "Services"; hidden items, separators and empty titles (`:105-125`; `UI/CommandPaletteView.swift:74-75`) | the board has no app/Window/Help menus; skip "Search Commands…" and separators |
| "Duplicate titles disambiguated" | the **id** (not the shown title) of the second identical full path gets " (2)", the third " (3)"…; running re-locates the item by its path and its occurrence among same-titled non-submenu items in its menu; missing → beep (`:5-7, 128-156`) | same: rows show the plain title; `id` keeps uniqueness; run = re-resolve in a fresh `menus()` |
| "Shortcut labels rendered as the menu shows them" | `ShortcutChord(key, bits).label` from the item's key equivalent; an uppercase key equivalent implies ⇧; AppKit's Delete (U+0008) shows as "Delete" (`:158-168`) | `CB.Shortcuts.labelFor(def)` (16.1) |
| "Layer › Add Layer Mask" … "(Hide All)" | two extra entries: "Layer › Add Layer Mask" (or "Layer › Add Layer Mask from Selection" with a selection) → `addMask(revealing: true)`; "Layer › Add Layer Mask (Hide All)" (or "Layer › Add Layer Mask Hiding Selection") → `addMask(revealing: false)`; both enabled when `canEditMask && activeLayer.mask == nil`; no shortcut (`:175-185`) | add when masks ship (masks spec) |
| 23 "Tool ›" lines | 15.4 | 15.4 |
| "Tool entries disabled with no document…" | enabled = a document is open; `perform`: `selectTool(tool)`, then the mode setup **only if** `session.tool == tool` afterwards (a refused switch changes no mode) (`:218-226`) | same |

### 15.2 Entries from the board's menu model

```js
// Mirrors CommandPaletteMenu.entries + layerCommands + tools (UI/CommandPalette.swift:104-227).
function paletteEntries(board) {
    const menus = board.menus();                     // fresh: labels, enabled() and checked() are evaluated now
    const out = [], seen = new Map();
    const walk = (items, path) => {
        const sameTitle = new Map();
        for (const item of items) {
            if (!item) continue;                             // separator
            const title = typeof item.label === 'function' ? item.label() : item.label;
            if (!title || item.hidden || title === 'Search Commands…') continue;
            if (item.submenu) { walk(item.submenu, [...path, title]); continue; }
            const titles = [...path, title], full = titles.join(' › ');
            const occurrence = sameTitle.get(title) || 0; sameTitle.set(title, occurrence + 1);
            const count = seen.get(full) || 0; seen.set(full, count + 1);
            out.push({
                id: count === 0 ? full : `${full} (${count + 1})`, title: full,
                shortcut: CB.Shortcuts.labelFor(item.def) || null,
                isEnabled: item.enabled ? Boolean(item.enabled()) : true,
                isOn: Boolean(item.checked && item.checked()),
                perform: () => { const found = locate(board.menus(), titles, occurrence); if (found) found.run(); else beep(); },
            });
        }
    };
    for (const menu of menus) walk(menu.items, [menu.title]);
    return [...out, ...layerCommands(board), ...toolEntries(board)];
}
// locate: descend by submenu titles, then the occurrence-th non-submenu item whose label equals the last title.
```

### 15.3 Fuzzy matching (verbatim rules)

Upstream (`UI/CommandPalette.swift:33-98`), verbatim:

```swift
static func score(_ query: String, in text: String) -> Int? {
    let wanted = Array(query.lowercased().filter { !$0.isWhitespace })
    guard !wanted.isEmpty else { return 0 }
    let letters = Array(text.lowercased())
    var total = 0, from = 0, previous = -2
    for character in wanted {
        guard let found = letters[from...].firstIndex(of: character) else { return nil }
        let wordStart = found == 0 || !(letters[found - 1].isLetter || letters[found - 1].isNumber)
        total += 1 + (wordStart ? 8 : 0) + (found == previous + 1 ? 5 : 0)
        previous = found
        from = found + 1
    }
    let title = String(letters), phrase = query.lowercased().trimmingCharacters(in: .whitespaces)
    let words = phrase.split(separator: " ").map(String.init)
    let tier: Int
    if wordsStartWords([phrase], in: title) { tier = 5 }
    else if words.count > 1, wordsStartWords(words, in: title) { tier = 4 }
    else if title.contains(phrase) { tier = 3 }
    else if title.replacingOccurrences(of: " ", with: "").contains(String(wanted)) { tier = 2 }
    else { tier = 1 }
    return tier * 1_000_000 + (tier == 1 ? total * 100 : 0) - letters.count / 4
}
// wordsStartWords: each word, in order, occurs in title at an index whose previous character is not a letter
// (digits count as a boundary here, unlike the letter score); the search for the next word starts at the end of the
// previous match; for each word, occurrences preceded by a letter are skipped and the search goes on from the next index.
// rank: entries whose score is non-nil, sorted: enabled before disabled; then, if the query is empty (the raw string)
// or the two scores are equal, original order; otherwise higher score first.
```

JS translation (keep the semantics, including the asymmetric word-boundary tests):

```js
const isLetter = (c) => /\p{L}/u.test(c), isNumber = (c) => /\p{N}/u.test(c), isSpace = (c) => /\s/u.test(c);
function score(query, text) {
    const wanted = Array.from(query.toLowerCase()).filter((c) => !isSpace(c));
    if (!wanted.length) return 0;
    const letters = Array.from(text.toLowerCase());
    let total = 0, from = 0, previous = -2;
    for (const ch of wanted) {
        const found = letters.indexOf(ch, from);
        if (found < 0) return null;
        const wordStart = found === 0 || !(isLetter(letters[found - 1]) || isNumber(letters[found - 1]));
        total += 1 + (wordStart ? 8 : 0) + (found === previous + 1 ? 5 : 0);
        previous = found; from = found + 1;
    }
    const title = letters.join(''), phrase = query.toLowerCase().replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');
    const words = phrase.split(' ').filter(Boolean);
    let tier;
    if (wordsStartWords([phrase], title)) tier = 5;
    else if (words.length > 1 && wordsStartWords(words, title)) tier = 4;
    else if (title.includes(phrase)) tier = 3;
    else if (title.replaceAll(' ', '').includes(wanted.join(''))) tier = 2;
    else tier = 1;
    return tier * 1000000 + (tier === 1 ? total * 100 : 0) - Math.floor(letters.length / 4);
}
function wordsStartWords(words, title) {
    let from = 0;
    for (const word of words) {
        let found = -1, search = from;
        for (let at = title.indexOf(word, search); at >= 0; at = title.indexOf(word, search)) {
            if (at === 0 || !isLetter(title[at - 1])) { found = at + word.length; break; }
            search = at + 1;
        }
        if (found < 0) return false;
        from = found;
    }
    return true;
}
function rank(entries, query) {
    return entries.map((e, i) => ({ e, s: score(query, e.title), i })).filter((r) => r.s !== null)
        .sort((a, b) => (a.e.isEnabled !== b.e.isEnabled ? (a.e.isEnabled ? -1 : 1)
            : (query === '' || a.s === b.s) ? a.i - b.i : b.s - a.s)).map((r) => r.e);
}
```

(`String.indexOf` works on UTF-16 units; the palette's titles are BMP-only, so indices match the `Array.from` arrays.
`title.indexOf('')` cannot happen: an empty phrase returns 0 earlier.)

Test vectors from upstream's own code **(measured)**:

| Query | Title → score |
|---|---|
| `lasso` | Tool › Lasso 4999997; Tool › Polygonal Lasso 4999995; Layer › New Adjustment Layer › Hue/Saturation… 1002589 |
| `gb` | Filter › Gaussian Blur… 1001795; View › Pixel Grid (800% and above) 1000992 |
| `new layer` | Layer › New Blank Layer 3999995; Layer › New Adjustment Layer › Hue/Saturation… 3999989 |
| `grid` | View › Show › Grid 4999996; View › Snap To › Grid 4999995; View › Grid Settings… 4999995; View › Pixel Grid (800% and above) 4999992 |
| `zoom` | Tool › Zoom 4999998; View › Zoom In 4999997; View › Zoom Out 4999997 |
| `hue` | Image › Hue/Saturation… 4999995; Layer › New Adjustment Layer › Hue/Saturation… 4999989 |
| `rul` | View › Rulers 4999997; Tool › Rectangular Marquee 1001594; … Hue/Saturation… 1001089; Filter › Gaussian Blur… 1000295 |
| `marq` | Tool › Rectangular Marquee 4999994; Tool › Elliptical Marquee 4999994 (tie → menu order) |
| `fs` | Filter › Gaussian Blur… 1000995; View › Toggle Fullscreen 1000994; View › CMYK › Proof Colors 1000194 |
| `zoom in` | View › Zoom In 4999997 (only match among these) |
| `cmyk proof` | View › CMYK › Proof Colors 3999994 (tier 4: the words start words but "cmyk proof" is not contiguous) |
| `"  "` (spaces) | every title 0 (all match; original order, since the raw query is not empty but the scores tie) |
| `px grid` | View › Pixel Grid (800% and above) 1003692 |
| `inv` | Select › Inverse 4999996; View › Pixel Grid (800% and above) 1000292 |

### 15.4 Tool entries

`UI/CommandPalette.swift:193-217`, in this order, title `Tool › <name>`, shortcut shown = the letter:

| Entry | Key | Tool | Mode applied after the switch |
|---|---|---|---|
| Move / Transform | V | move | — |
| Rectangular Marquee | M | marquee | `marqueeKind = .rectangle` |
| Elliptical Marquee | M | marquee | `.ellipse` |
| Lasso | L | lasso | `lassoKind = .freehand` |
| Polygonal Lasso | L | lasso | `.polygonal` |
| Magic Wand | W | wand | `wandMode = .wand` |
| Object Selection | W | wand | `.object` |
| Crop | C | crop | — |
| Brush | B | brush | `brushMode = .paint` |
| Eraser | E | brush | `.erase` |
| Spot Healing Brush | J | spotHealing | — |
| Clone Stamp | S | cloneStamp | — |
| Liquify | R | blur | `blurMode = .liquify` |
| Blur | R | blur | `.blur` |
| Smudge | R | blur | `.smudge` |
| Gradient | G | gradient | — |
| Rectangle | U | shape | `shapeKind = .rectangle` |
| Ellipse | U | shape | `.ellipse` |
| Line | U | shape | `.line` |
| Type | T | type | — |
| Eyedropper | I | eyedropper | — |
| Hand | H | hand | — |
| Zoom | Z | zoom | — |

The shown key is the literal letter, not the remapped chord (upstream passes `shortcut: key`). The board lists only
tools it implements (others join as they ship) and may add "Tool › Note for Claude" (N) as a documented extension.
The board's mode setters: `st.options.marqueeKind`, `lassoKind`, `wandMode`, `this.brushMode`, `this.shape.kind`.

### 15.5 VS Code side (b)

Contribute command `compositorBoard.searchCommands` ("Compositor Board: Search Commands…") shown in VS Code's Command
Palette only `when` a board is active (`activeCustomEditorId == 'compositorBoard.board' || focusedView ==
'compositorBoard.sidebar'`), with **no** default keybinding; it posts `{type: 'openPalette'}` to the active board. VS
Code's own Command Palette (⇧⌘P) and Quick Open (⌘P) are never consumed by the board.

---

## 16. Keyboard shortcuts (checklist 1833-1967)

### 16.1 Chord model (`UI/KeyboardShortcuts.swift:4-74`)

`ShortcutChord { key: String, modifiers: Int }`, bits `1 = ⌘, 2 = ⌥, 4 = ⌃, 8 = ⇧`; `key == ""` means None.
Key from an event: Delete and Forward Delete → U+007F; Return and keypad Enter → `\r`; Escape → U+001B; Tab → `\t`;
Space → `" "`; ← U+F702, → U+F703, ↓ U+F701, ↑ U+F700; anything else `charactersIgnoringModifiers.lowercased()` (the
character the key types with Shift alone: ⇧1 is `!`, ⇧' is `"`) folded `{`→`[`, `}`→`]`, `+`→`=`, `_`→`-`.
Label: `"None"` when empty, else `⌃` `⌥` `⇧` `⌘` (that order, each if set) + `Delete` / `Return` / `Esc` / `Tab` /
`Space` / `←` / `→` / `↓` / `↑`, or `key.uppercased()`.

JS:

```js
const SPECIAL = { Backspace: '\x7f', Delete: '\x7f', Enter: '\r', NumpadEnter: '\r', Escape: '\x1b', Tab: '\t', Space: ' ',
    ArrowLeft: '\uf702', ArrowRight: '\uf703', ArrowDown: '\uf701', ArrowUp: '\uf700' };
const FOLD = { '{': '[', '}': ']', '+': '=', '_': '-' };
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);
// layout: navigator.keyboard.getLayoutMap() when available (unshifted characters per code), else a US table that also
// covers Numpad0-9, NumpadAdd '+', NumpadSubtract '-', NumpadMultiply '*', NumpadDivide '/', NumpadDecimal '.'.
function chordFromEvent(e, layout) {
    if (MODIFIER_KEYS.has(e.key)) return null;                        // AppKit sends flagsChanged, not keyDown
    const modifiers = (e.metaKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    let key = SPECIAL[e.code];
    if (key === undefined) {
        const base = (layout && layout.get(e.code)) || US_BASE[e.code] || '';
        const typed = e.shiftKey ? (US_SHIFTED[base] ?? base.toUpperCase()) : base;   // ⌥, ⌘, ⌃ ignored
        key = typed.toLowerCase();
        key = FOLD[key] ?? key;
    }
    return { key, modifiers };
}
const LABEL = { '\x7f': 'Delete', '\r': 'Return', '\x1b': 'Esc', '\t': 'Tab', ' ': 'Space', '\uf702': '←', '\uf703': '→', '\uf701': '↓', '\uf700': '↑' };
const label = (c) => (!c.key ? 'None' : (c.modifiers & 4 ? '⌃' : '') + (c.modifiers & 2 ? '⌥' : '') + (c.modifiers & 8 ? '⇧' : '')
    + (c.modifiers & 1 ? '⌘' : '') + (LABEL[c.key] ?? c.key.toUpperCase()));
```

On Windows/Linux the board maps "⌘" to `ctrlKey` and "⌃" to `metaKey` when it ever runs there; this extension is
`extensionKind: ui` on macOS today. `e.key` is not used for characters because ⌥ changes it on macOS (⌥[ gives "“").
Non-US layouts: `getLayoutMap` gives the right unshifted character; shifted punctuation falls back to the US table
(small, documented deviation).

### 16.2 Definitions (`ShortcutDefinition.all`, `UI/KeyboardShortcuts.swift:83-143`)

`id = "\(group):\(title)"`. Order matters (conflict messages, editor rows, first-match lookups). "Board" says how the
port handles the chord at its **current** value; "VS Code 1.142" is the default binding found in `VSCode:workbench`
(**measured**; editor-scoped bindings do not fire in a webview) or in `VSCode:main`.

**Menus** (51; all `group: "Menus"`):

| # | Title | Default | Owner | Board | VS Code 1.142 |
|---|---|---|---|---|---|
| 1 | Undo | ⌘Z | ui.md 10 | editor tab: not consumed (VS Code's `undo` runs the CustomEditor undo); side bar: consumed | `undo` |
| 2 | Redo | ⇧⌘Z | ui.md 10 | same | `redo` |
| 3 | New Canvas | ⌘N | File | not consumed at default | New Untitled Text File |
| 4 | Open Project | ⌘O | File | not consumed at default | Open File… |
| 5 | Save | ⌘S | File | editor: not consumed; side bar: consumed (`saveNow`) | Save |
| 6 | Save As | ⇧⌘S | File | not consumed at default | Save As… |
| 7 | Export JPEG | ⌥⇧⌘S | File | consume once Export ships | none |
| 8 | Export PNG | ⇧⌘E | File | consume once Export ships | Show Explorer (high) |
| 9 | Export As | ⌥⇧⌘W | File | consume once Export ships | none |
| 10 | Close Project | ⌘W | App 18.1 | not consumed at default | Close Editor |
| 11 | Fit Canvas | ⌘0 | 4 | consume | `workbench.action.focusSideBar` |
| 12 | Search Commands | ⌘F | 15 | consume | Find (`kbExpr: null`, weight 100), webview find |
| 13 | Actual Pixels | ⌘1 | 4 | consume | `workbench.action.focusFirstEditorGroup` |
| 14 | Zoom In | ⌘= (+ ⌘+, keypad +, key repeat, while default) | 4 | consume | `workbench.action.zoomIn` (zooms all of VS Code) |
| 15 | Zoom Out | ⌘- (+ keypad -) | 4 | consume | `workbench.action.zoomOut` |
| 16 | Show Transform Controls | ⌘H | 3.2 | consumed today in the Move tool (`Board.keydown`); decision 4 | none in the renderer; **native app-menu Hide** (`Command+H`) |
| 17 | Hide Compositor | ⌥⌘H | 18.5 | never consumed; VS Code's native Hide Others runs | none in the renderer; native `Command+Alt+H` |
| 18 | Cut | ⌘X | selection.md | DOM clipboard events | editor/clipboard |
| 19 | Copy | ⌘C | selection.md | same | same |
| 20 | Copy Merged | ⇧⌘C | selection.md | consume | see selection.md |
| 21 | Paste | ⌘V | selection.md | DOM `paste` | clipboard |
| 22 | Fill with Foreground | ⌥⌫ | selection.md | consume | `deleteWordLeft` (editor) |
| 23 | Fill with Background | ⌘⌫ | selection.md | consume | `deleteAllLeft` (editor) |
| 24 | Content-Aware Fill | ⇧⌫ | selection.md | consume | `deleteLeft` (editor) |
| 25 | Select All | ⌘A | selection.md | consume | `editor.action.selectAll` (editor) |
| 26 | Deselect | ⌘D | selection.md | consume | Add Selection to Next Find Match (editor) |
| 27 | Inverse Selection | ⇧⌘I | selection.md | consume | Format Document (editor) |
| 28 | Select Subject | ⌥⌘A | selection.md | consume | none |
| 29 | Last Filter | ⌃⌘F | Filters | consume once it ships (Q7) | `workbench.action.toggleFullScreen` |
| 30 | Curves | ⌘M | Adjustments | as #16 when it ships | native app-menu Minimize (`Command+M`) |
| 31 | Levels | ⌘L | Adjustments | consume | Expand Line Selection (editor) |
| 32 | Hue/Saturation | ⌘U | Adjustments | consume | Cursor Undo (editor) |
| 33 | Invert Pixels / Mask | ⌘I | Image | consume (done) | Trigger Suggest (editor) |
| 34 | Canvas Size | ⌥⌘C | Image | consume | Copy Path (Explorer-scoped) |
| 35 | Image Size | ⌥⌘I | Image | consume | Toggle Developer Tools |
| 36 | Transform Layer / Selection | ⌘T | Transform | consume (done) | Go to Symbol in Workspace |
| 37 | Duplicate / Layer via Copy | ⌘J | Layers | consume (done) | Toggle Panel |
| 38 | Toggle Clipping Mask | ⌥⌘G | Masks | consume | none |
| 39 | Group Layers | ⌘G | Layers | consume | Find Next |
| 40 | Ungroup Layers | ⇧⌘G | Layers | consume | Find Previous |
| 41 | New Blank Layer | ⇧⌘N | Layers | consume (done) | New Window (`ui.md` 12.2) |
| 42 | Move Layer Up | ⌘] | Layers | consume (done) | Indent Line (editor) |
| 43 | Move Layer Down | ⌘[ | Layers | consume (done) | Outdent Line (editor) |
| 44 | Merge Layers | ⌘E | Layers | consume | Find with Selection (editor) |
| 45 | Show Grid | ⌘' | 7 | consume | none |
| 46 | Show Guides | ⌘; | 6 | consume | none |
| 47 | Show Rulers | ⌘R | 5 | consume | Developer: Reload Window (development builds only); integrated browser Hard Reload (when that browser has focus) |
| 48 | Snap | ⇧⌘; | 8 | consume | `breadcrumbs.focus` when breadcrumbs are possible |
| 49 | Lock Guides | ⌥⌘; | 6 | consume | none |
| 50 | CMYK Proof Colors | None (Photoshop's ⌘Y avoided) | 12 | assignable | — |
| 51 | CMYK Gamut Warning | None (⇧⌘Y avoided) | 12 | assignable | — |

**Canvas & Layers** (59 definitions, plain keys; they work wherever focus is except text entry. VS Code has no global
bindings for them while the webview has focus, but Tab and Space have browser defaults the board must
`preventDefault`). One row per checklist line; "Definition" is the exact registry title (`UI/KeyboardShortcuts.swift:116-141`):

| Checklist line | Definition (default) | Board |
|---|---|---|
| "Toggle Fullscreen" | "Toggle Fullscreen: the canvas alone on black (Esc also leaves)" (F) | section 11 (not yet) |
| "Select tool (no tool)" | "Select tool" (A) | done (`'none'`) |
| "Move / Transform tool" | "Move / Transform tool" (V) | done |
| "Hand tool" | "Hand tool" (H) | done |
| "Zoom tool" | "Zoom tool" (Z) | done |
| "Brush tool" | "Brush tool" (B, Paint mode) | done |
| "Eraser" | "Eraser" (E, Brush in Erase mode) | done |
| "Spot Healing" | "Spot Healing" (J) | with the tool |
| "Clone Stamp" | "Clone Stamp" (S) | with the tool |
| "Type tool" | "Type tool" (T) | with the tool |
| "Gradient tool" | "Gradient tool" (G) | with the tool |
| "Shape tool" | "Shape tool" (U) | done |
| "Eyedropper tool" | "Eyedropper tool" (I) | done |
| "Marquee / cycle shape" (ticked) | "Marquee / cycle shape" (M, repeat ignored) | done |
| "Magic" (ticked) | "Magic" (W, repeat ignored) | done |
| "Lasso / cycle mode" (ticked) | "Lasso / cycle mode" (L, repeat ignored) | done |
| "Blur / Smudge / Liquify" | "Blur / Smudge / Liquify" (R) | with the tool |
| "Crop tool" | "Crop tool" (C) | with the tool |
| "Swap foreground/background" | "Swap foreground/background" (X) | done |
| "Reset colors" | "Reset colors" (D) | done |
| "Cycle tool mode" | "Cycle tool mode" (Tab, no modifiers, not while editing text) | done for the ported tools |
| "Temporary Hand tool" | "Temporary Hand tool (hold)" (Space; released on key-up of the same physical key) | done |
| "Delete selection / layer / effect / lasso point" | "Delete selection / layer / effect / lasso point" (Delete or Forward Delete, no ⌘⌃⌥) | done for pixels, layers and lasso corners; effects with layer effects |
| "Apply current canvas operation" | "Apply current canvas operation" (Return or keypad Enter; also the default button of floating dialogs) | done for floating pixels, lasso and panels; crop, gradient, Levels and transforms with those features |
| "Cancel current canvas operation" | "Cancel current canvas operation" (Esc; also floating dialogs' Cancel) | done for drags, drafts, floating pixels and panels; text, Levels, crop, gradient and guide drags with those features |
| "Decrease brush size" / "Increase brush size" | "Decrease brush size" ([) / "Increase brush size" (]): `max(1 px, /1.2)` / `max(+1 px, ×1.2)`, clamped 1…2000, any focus but text | done for Brush; all brush tools as they ship |
| "Decrease brush hardness" / "Increase brush hardness" | "Decrease brush hardness" (⇧[) / "Increase brush hardness" (⇧]), 25 % steps | done |
| "Previous blend mode" / "Next blend mode" | "Previous blend mode" (⇧-) / "Next blend mode" (⇧= or ⇧+), menu order, wrapping, one undo step, any tool | done |
| "Cycle shape kind" | "Cycle shape kind" (⇧U, Shape tool) | done |
| "Opacity digits 0-9" | "Opacity digit 0 (type two for exact %)" … "Opacity digit 9 (type two for exact %)" (0…9; 1 = 10 % … 0 = 100 %; two digits within 0.6 s exact, min 1 %) | done for Brush and Move; Gradient opacity and Smear strength with those tools |
| "Nudge Left/Right/Up/Down 1 px" (ticked) | "Nudge Left 1 px" … "Nudge Down 1 px" (arrows) | done |
| "Nudge Left/Right/Up/Down 10 px" (ticked) | "Nudge Left 10 px" … (⇧ arrows) | done |
| "Move selected pixels Left/Right/Up/Down 1 px" (ticked) | "Move selected pixels Left 1 px" … (⌘ arrows) | done |
| "Move selected pixels Left/Right/Up/Down 10 px" (ticked) | "Move selected pixels Left 10 px" … (⇧⌘ arrows) | done |
| "Toggle Levels preview" | "Toggle Levels preview" (⌥P while Levels is open; appended last, so listed last in this group) | with Levels |

The registry order of this group (it drives first-match lookups and the editor rows) is: Toggle Fullscreen…, Select
tool, Move / Transform tool, Hand tool, Zoom tool, Brush tool, Eraser, Spot Healing, Clone Stamp, Type tool, Gradient
tool, Shape tool, Eyedropper tool, Marquee / cycle shape, Magic, Lasso / cycle mode, Blur / Smudge / Liquify, Crop
tool, Swap foreground/background, Reset colors, Cycle tool mode, Temporary Hand tool (hold), Delete selection / layer /
effect / lasso point, Apply current canvas operation, Cancel current canvas operation, Decrease brush size, Increase
brush size, Decrease brush hardness, Increase brush hardness, Previous blend mode, Next blend mode, Cycle shape kind,
Opacity digit 0…9, then for Left, Right, Up, Down in turn: Nudge 1 px, Nudge 10 px, Move selected pixels 1 px, Move
selected pixels 10 px; Toggle Levels preview.

**Text Editing** (9, `group: "Text Editing"`, used inside the inline text editor only): Finish editing text ⌘↩;
Decrease tracking ⌥←; Decrease tracking by 10 ⌥⇧←; Increase tracking ⌥→; Increase tracking by 10 ⌥⇧→; Decrease
leading ⌥↑; Decrease leading by 10 ⌥⇧↑; Increase leading ⌥↓; Increase leading by 10 ⌥⇧↓ (`:135-140`). These belong
to the Type tool spec; the registry and the editor list them now.

**Fixed (not remappable)** — checklist "Fixed keys":

- "Shift+letter tool keys": rule 3 of 16.3.
- "Modifier and mouse gestures": fixed; listed as help text in the editor (16.4).
- "System keys": ⌘Q quit and ⌃⌘F full screen are described as standard; `problem()` reserves ⌘Q, ⌘, and ⌥⌘M.
- "Dialog Apply/Cancel buttons": dialog buttons bound with `configuredNativeShortcut(.return / .escape)` follow the
  **current chords of "Apply current canvas operation" and "Cancel current canvas operation"** (`native()` looks up the
  non-menu definition whose original is Return / Esc): Color Picker, Canvas Size, Image Size, Trim, Filter, Effects,
  Transform Apply/Cancel, Color Range, Hue/Saturation, Levels, Export As, Grid Settings, Selection amount, New canvas
  Create. RAW develop, PSD conversion and the Keyboard Shortcuts editor use `.defaultAction` / `.cancelAction`
  (always ↩ / ⎋). Port: `Board.panel()`'s `keydown` compares the event's chord with those
  two current chords instead of `e.key === 'Enter' / 'Escape'`; the shortcut editor keeps ↩/⎋.

### 16.3 Dispatch pipeline in the webview

Upstream order for a key press: local event monitors (canvas-only ⎋, F-to-text-field, window-wide canvas keys) → menu
key equivalents → the first responder's `keyDown` (`Rendering/EditorCanvas.swift:776-795, 2200-2321`). Port, one
`document` `keydown` handler:

1. **Recorder** (16.4) recording → it takes the event; consume.
2. **Palette open** → the palette handles ↑ ↓ ↩ ⎋; the current "Search Commands" chord closes it; consume.
3. `chord = chordFromEvent(e)`; `null` (modifier key alone) → only update held modifiers.
4. **Text entry focused** (corrected test of 2.2): let the field have it, except menu items whose chord has ⌘ and that
   are not text-editing commands (Undo, Redo, Cut, Copy, Paste, Select All, the three Fill items, Zoom In/Out keep
   their text meaning, as upstream's text-first rules and `NSText` guards do). Plain keys never leave the field.
5. **Menu key equivalents**: find the menu item whose definition's current chord equals `chord` (plus the two
   assignable CMYK items and the View › Toggle Fullscreen item). Found and enabled → run, consume. Found and disabled
   → consume and beep (AppKit's unhandled key beeps). Items owned by VS Code at their default chord (Undo/Redo in an
   editor tab, New Canvas, Open Project, Save, Save As, Close Project) are skipped so VS Code handles them; **when
   remapped**, the board consumes the new chord and posts `{type:'command', command}` (`undo`, `redo`,
   `compositorBoard.new`, `compositorBoard.open`, `workbench.action.files.save`, `workbench.action.files.saveAs`,
   `workbench.action.closeActiveEditor`).
6. **Window-wide keys** (`:776-795`): with Zoom In/Out at their defaults, ⌘ + `Equal` (any ⇧) / `NumpadAdd` zooms in
   and ⌘ + `Minus` (no ⇧) / `NumpadSubtract` zooms out, ⌃ and ⌥ up, key repeat allowed; ⇧+ / ⇧− step the blend mode;
   `[ ] { }` change brush size/hardness for brush tools (any focus but text).
7. **Canvas translation** (`canvasEvent`, `:218-236`), only when overrides exist:

   ```js
   const same = (a, b) => a.key === b.key && a.modifiers === b.modifiers;
   const current = (d) => overrides[d.id] ?? d.original;
   function canvasChord(input) {
       if (!Object.keys(overrides).length || !input.key) return input;
       const hit = DEFS.find((d) => d.group === 'Canvas & Layers' && same(current(d), input));
       if (hit) return hit.original;                                          // rule 1: run what the key now means
       if (DEFS.some((d) => d.group !== 'Text Editing' && same(d.original, input) && !same(current(d), input))) return null; // rule 2: a moved original is swallowed
       if (input.modifiers === 8) {                                           // rule 3: Shift + a remapped letter
           const plain = { key: input.key, modifiers: 0 };
           const base = DEFS.find((d) => d.group !== 'Menus' && d.original.modifiers === 0 && same(current(d), plain));
           if (base) return { key: base.original.key, modifiers: 8 };
           if (DEFS.some((d) => d.group !== 'Menus' && same(d.original, plain) && !same(current(d), plain))) return null;
       }
       return input;
   }
   ```

   `null` → consume and do nothing.
8. **Handlers** keyed by the translated chord (the existing `keydown` body, rewritten to switch on `{key, modifiers}`
   instead of `e.code`; letters accept `modifiers ∈ {0, 8}` unless a ⇧ definition exists for that key). Consume what
   is handled; let everything else bubble to VS Code.

Text Editing translation (`textEvent`, `:238-247`) runs inside the inline text editor with the definitions of the Text
Editing group plus the ones whose original is Esc (so a remapped Cancel works there too); same rules 1-2, no rule 3.

### 16.4 Keyboard Shortcuts editor (Edit › Keyboard Shortcuts…)

| Checklist line | Exact behaviour |
|---|---|
| "Open" | floating panel titled "Keyboard Shortcuts" (panel name `keyboardShortcuts`, position remembered for the session), content `VStack(alignment: .leading, spacing: 10)`, padding 24, width 660, fixed size |
| "Instructions line" | secondary: "Click a shortcut, then press its new key combination, or ⊗ to remove it. Changes apply when you save." |
| "Search field" | rounded text field, placeholder "Search shortcuts"; a row shows when the search is empty or its title contains the search (`localizedCaseInsensitiveContains`); group headlines always show, even when empty |
| "Groups" | a scroll view 465 pt high: for "Menus", "Canvas & Layers", "Text Editing": headline (`.headline`, 13 pt semibold, 8 pt top padding) then rows `HStack { title; Spacer; recorder 150 x 26 }`, 6 pt apart |
| "Recorder button" | rounded bezel button titled with the chord label (draft override or original; "None" when cleared); click → recording, title "Press keys…", accessibility "Press a shortcut"; while recording it takes **every** key including ↩ and ⎋ (they become the chord); a key whose character is not exactly one character beeps and keeps recording; any other key press ends recording with that chord |
| "Remove button (⊗)" | only on the row being recorded and only when its chord is not None: borderless SF `xmark.circle.fill`, secondary, 7 pt from the right inside the recorder, help "Remove this shortcut"; sets the draft to None and stops recording |
| "Contextual keys & mouse gestures" | after the groups: Divider (8 pt vertical padding), headline "Contextual keys & mouse gestures", then two paragraphs verbatim: "Text fields keep standard macOS editing keys. Dialogs share the Apply/Cancel assignments above. Numeric fields use Up/Down, with Shift for larger steps. Standard macOS commands include ⌘Q to quit and ⌃⌘F for full screen. The shortcut editor itself always uses Return to save and Esc to cancel when not recording." and "Option temporarily selects the eyedropper in painting tools. Shift constrains shapes/movement or adds to a selection; Option subtracts from selections or draws from center. Command-drag moves selected pixels; Command-Option-drag copies them. Option-drag duplicates layers/folders/effects; Option-click at a layer boundary toggles clipping. Command-click a thumbnail loads its selection. Control bypasses snapping. Right-drag adjusts brush size. Modifier-and-mouse gestures are fixed." |
| "Conflict message in orange" | orange callout, at most 2 lines, 22 pt high, shown only when `problem(draft)` is not nil (no empty line otherwise) |
| "Restore Defaults" | stops recording, `draft = {}` |
| "Cancel / Save" | Divider, then `HStack { Restore Defaults; Spacer; Cancel (⎋, cancelAction); Save (↩, defaultAction, prominent) }`; Save disabled while recording or with a problem; Save stores the draft and closes; Cancel closes without saving |
| "Persistence" | JSON of `[String: ShortcutChord]` (`{"Menus:Show Rulers": {"key": "r", "modifiers": 3}, …}`, special keys as their code points, None as `{"key": "", "modifiers": 0}`); on load, saved entries sorted by id are accepted one at a time when the id still exists and the trial set has no problem |
| "Remapping mechanism" | 16.3 |
| "Menu items show the current chord" | menus bind `configuredKeyboardShortcut` (the definition found by its original chord) and `assignableShortcut(title)` for keyless items; the board's menus render `labelFor(def)` |

`problem(values)` verbatim (`:198-214`), iterating definitions in order:

```js
function problem(values) {
    const assigned = new Map();
    for (const d of DEFS) {
        const c = values[d.id] ?? d.original;
        if (!c.key) continue;
        if (Array.from(c.key).length !== 1 || !(c.modifiers >= 0 && c.modifiers <= 15)) return 'Choose a single key with optional modifiers.';
        if (d.group === 'Text Editing' && (c.modifiers & 7) === 0) return 'Text-editing shortcuts need Command, Option, or Control so they do not replace normal typing.';
        if ([['q', 1], [',', 1], ['m', 3]].some(([k, m]) => c.key === k && c.modifiers === m)) return `${label(c)} is reserved by macOS.`;
        const k = `${c.key}\u0000${c.modifiers}`;
        if (assigned.has(k)) return `${label(c)} is assigned to both ${assigned.get(k)} and ${d.title}.`;
        assigned.set(k, d.title);
    }
    return null;
}
```

Port (a): an in-webview panel (a `Board.panel()`-style floating panel, `max-width: calc(100% − 16px)`), recorder buttons
that focus themselves and handle `keydown` with `preventDefault` + `stopPropagation` while recording (step 1 of 16.3,
so neither the board nor VS Code sees the key). Storage (b): `globalState` key `compositorBoard.keyboardShortcuts.v1`
holding the same JSON text; the extension sends it with `load` and saves it on `{type: 'shortcuts', json}`, then
broadcasts it to every open board (shortcuts are app-wide in Compositor: `ShortcutSettings.shared`).

### 16.5 Board shortcuts versus VS Code keybindings

- **The board's registry is authoritative inside the board** (faithful to Compositor). VS Code's Keyboard Shortcuts
  editor cannot see or remap chords the board consumes, because consumed events never reach the workbench.
- **What VS Code still intercepts**: native macOS app-menu accelerators (⌘H Hide, ⌥⌘H Hide Others, ⌘M Minimize, and
  likely ⌘Q) until proven otherwise; system chords (⌘Tab, ⌘`, ⌃↑ Mission Control, ⌘Space). Everything the board does
  not consume runs VS Code's binding (⌘P, ⇧⌘P, ⌘B, ⌘W, …).
- **Decision 4 (⌘H)**: test in a real VS Code build whether `preventDefault` on ⌘H in the webview stops "Hide Visual
  Studio Code". If it does, keep ⌘H as the default for Show Transform Controls. If not, ship the definition with its
  original ⌘H (so stored JSON and conflict checks stay compatible) but treat it as **unassigned in the board** unless
  the user assigns another chord, and show no chord on the menu item. ⌘M (Curves) gets the same test.
- **Optional VS Code commands** (b): contribute `compositorBoard.searchCommands`, `compositorBoard.keyboardShortcuts`,
  and one command per View toggle (`compositorBoard.view.rulers`, `.grid`, `.guides`, `.snap`, `.lockGuides`,
  `.pixelGrid`, `.navigator`, `.canvasOnly`, `.proofColors`, `.gamutWarning`, `.fit`, `.actualPixels`), visible in
  VS Code's Command Palette only when a board is active (when clause of 15.5) and **without default keybindings**.
  They post the matching menu `id` to the active board. A user may bind them in VS Code; such a binding fires only for
  chords the board does not consume (clear the chord in the board's editor first).
- Context keys: `activeCustomEditorId` (editor tab) and `focusedView` (side bar) already exist; no custom context key
  is needed.

---

## 17. Preferences and persisted settings (checklist 1968-2012)

### 17.1 No Preferences window

Compositor has no Settings scene; ⌘, is reserved and unused; settings live in menus, tool headers and the shortcut
editor, persisted in UserDefaults (`CompositorApp.swift:10-25`, `UI/KeyboardShortcuts.swift:207`). Port (b): the board
adds no preferences page either. Board-only options that Compositor does not have stay VS Code settings
(`compositorBoard.autosaveDelay`, `.bridge`, `.checkerboard`, and the new `.canvasOnly.workbench`), reachable through
VS Code's Settings (⌘, — the same chord Compositor reserves).

### 17.2 Key mapping

All person-level keys go into the existing `globalState` object `compositorBoard.preferences` (`PREFERENCES_KEY` in
`extension.js`), which already holds `autoSelect`, `showControls` and `panelWidth`: the extension sends it as
`preferences` with `load`, and merges every `{type: 'preferences', preferences}` patch the board posts from
`Board.persist()`. New fields are the UserDefaults key without the `tool.` prefix (`rulers`, `guides`, `grid`,
`gridSpacing`, `gridSubdivisions`, `gridColor`, `gridCustomColor`, `gridStyle`, `gridOpacity`, `snap`, `snapGuides`,
`snapGrid`, `snapLayers`, `snapBounds`, `lockGuides`, `pixelGrid`), plus `navigatorVisible`, `cmykProfile` and
`jpegExportQuality`. "prefs" below means this object. `setKeysForSync` is **not** called (UserDefaults are per Mac, not
synced).

| Checklist line (key) | Default | Read rule (upstream) | Board today | Port |
|---|---|---|---|---|
| "tool.* prefix" | — | `ToolDefaults`: stored value of the right type or the compiled default; under XCTest never read or written (`Document/ToolDefaults.swift:3-41`) | — | (a) prefs store is injectable; tests use an in-memory one |
| tool.autoSelect | false | Bool | `autoSelect` in `compositorBoard.preferences` | done |
| tool.transformControls | true | Bool | `showControls` in `compositorBoard.preferences` | done |
| tool.pixelGrid | true | Bool | — | prefs |
| tool.grid | false | Bool | — | prefs |
| tool.gridSpacing | 64 | Int, then `LayoutGrid` clamps to 2…4096 | — | prefs |
| tool.gridSubdivisions | 8 | Int, clamped to 1…64 and to the spacing | — | prefs |
| tool.gridColor | "Light Gray" | preset raw value; unknown → Light Gray | — | prefs |
| tool.gridCustomColor | "B3B3B3" (0.7 gray: `round(0.7·255) = 179`) | `PaletteColor(hex:)`: `RRGGBB` or `RGB`, optional `#`; invalid → 0.7 gray | — | prefs |
| tool.gridStyle | "Lines" | raw value "Lines" / "Dashed Lines" / "Dots"; unknown → Lines | — | prefs |
| tool.gridOpacity | 45 | Int (clamped to 1…100 when drawn) | — | prefs |
| tool.guides | true | Bool | — | prefs |
| tool.rulers | false | Bool | — | prefs |
| tool.snap | true | Bool | — | prefs |
| tool.snapGuides | true | Bool | — | prefs |
| tool.snapGrid | false | Bool | — | prefs |
| tool.snapLayers | true | Bool | — | prefs |
| tool.snapBounds | true | Bool | — | prefs |
| tool.lockGuides | false | Bool | — | prefs |
| layersPanelWidth | 252 | `@AppStorage` Double; drag sets `round(start − dx)` clamped 222…352; a stored value outside the range is clamped when used (`ContentView.swift:6, 124-126, 374-394`) | `panelWidth` in `compositorBoard.preferences`, rounded and clamped | done |
| navigator.visible | false | `@AppStorage` Bool | — | prefs |
| cmykProfile | (none) → "Generic CMYK Profile" → first installed | name lookup among installed profiles | — | prefs (section 12.6) |
| jpegExportQuality | 0.85 | Double 0…1, last JPEG quality used in Export As | — | prefs (File spec uses it) |
| keyboardShortcuts.v1 | {} | JSON, validated entry by entry (16.4) | — | separate key `compositorBoard.keyboardShortcuts.v1` (same JSON text) |
| CompositorCPUCanvas | false | hidden debug switch | — | (c), section 1.2 |
| UpdateFeedURL | — | DEBUG builds only | — | (c) |
| NSDisabledDictationMenuItem / NSDisabledCharacterPaletteMenuItem | true (registered) | AppKit switches | — | (c) |
| Sparkle state | automatic checks on; auto-download from the alert's checkbox | Sparkle | — | (b) `extensions.autoCheckUpdates` / `extensions.autoUpdate` when published; (c) for the local VSIX |

Board-only state that stays in `vscode.setState`: `drawerOpen` (compact drawer). `lockRatio` (`locksTransformRatio`) and
`sampleRing` (`showsSampleRing`) are session variables in Compositor (`Document/EditorSession.swift:107, 197`); the board
now resets them per session as well (`persist()` still writes them into `setState`, where nothing reads them back).

### 17.3 Scope across open boards (decision 2)

Each Compositor tab's `EditorSession` reads `ToolDefaults` when it is created; a toggle writes UserDefaults and changes
only that session, so other already-open tabs keep their values until reopened (and new tabs pick up the latest).
Faithful port: each board takes `prefs` at `load`; its changes are written to `globalState` but not pushed to other open
boards. Alternative (not faithful, arguably nicer side by side): the extension broadcasts every patch. Shortcuts are the
exception: `ShortcutSettings.shared` is app-wide, so saved shortcuts are broadcast (16.4).

### 17.4 Other persisted state

| Checklist line | Upstream | Port |
|---|---|---|
| "Recent projects" | `NSDocumentController.recentDocumentURLs`, filtered to existing files, refreshed when the app becomes active; shared with the Dock menu (`IO/RecentProjects.swift:4-33`) | (b) `globalState` `compositorBoard.recent` (8, most recent first, `remember()` in `extension.js`), filtered with `fs.existsSync(…/manifest.json)` each time it is shown; the board's File › Open Recent gets the list with `load` and after each open; "Clear Menu" empties it |
| "Loaded CMYK profiles copied to Application Support" | `~/Library/Containers/com.wonderassembly.compositor/Data/Library/Application Support/CMYK Profiles` (sandboxed) | (b) `globalStorageUri/CMYK Profiles` (12.6) |
| "Floating panel positions" | top-left per panel name (`levelsPanel`, `adjustmentPanel`, `selectionAmountPanel`, `colorRangePanel`, `filterPanel`, `effectsPanel`, `colorPickerPanel`, `keyboardShortcuts`), app session only | (a) a `Map(name → {left, top})` kept by the extension for the window's lifetime (so all boards share it, as Compositor's static dictionary does) and sent with `load`; never written to `globalState` |
| "Window size/position restored by macOS" | after the first launch | (b) VS Code restores its windows; nothing for the extension |
| "Not persisted (reset each launch)" | brush/tool options outside `tool.*`, current tool (Move), Proof Colors and Gamut Warning | (a) keep them out of prefs and out of `setState` |

---

## 18. App-level (checklist 2013-2104)

### 18.1 Project tabs → VS Code editor tabs (b)

| Checklist line | Upstream | Port |
|---|---|---|
| "Tab strip in the toolbar" | capsule pills after the "+" button, strip width `max(200, windowWidth − 352)`, height 34 | (b) VS Code's tab bar shows one tab per open board (custom editor) |
| "Tab title" | project file name without extension, else "Untitled"; new tabs take the lowest free "Untitled", "Untitled 2", … | (b) a custom editor tab shows `manifest.json`. Contribute `"configurationDefaults": { "workbench.editor.customLabels.patterns": { "**/*.comp/manifest.json": "${dirname}" } }` so the tab reads `X.comp` (decision 5; VS Code has no variable that strips the folder's extension; verify that a configuration default for this object setting takes effect). `newBoard` should propose the lowest free `Untitled.comp`, `Untitled 2.comp`, … in the target folder |
| "New tab" | ⌘N or "+" opens a new tab with the New canvas screen | (b) `compositorBoard.new` (exists) from the board's File menu, VS Code's Command Palette, the side-bar title (exists) and a new `editor/title` action (`"when": "activeCustomEditorId == compositorBoard.board"`, icon `$(add)`) |
| "Opening a project opens it in a new tab; …" | new tab; already open → select it; a lone blank tab is replaced; a failed open never leaves a broken tab | (b) `vscode.openWith` reveals an existing editor for the same resource. On a load failure the board shows "fatal" in its tab (`BoardProvider.load`); close that tab and show `showErrorMessage` instead, so no broken tab remains |
| "Switch tabs by clicking; blocked while…; a pending transform is committed" | `canSwitch` blocks while a dialog, filter, Hue/Saturation, gradient, pixel move or colour picker is open; switching commits a pending transform | (b) VS Code cannot block tab switches. The board keeps its state (`retainContextWhenHidden: true`), so an open dialog is still there on return; on `onDidChangeViewState` (inactive) the extension posts `deactivate` and the board commits a pending ⌘T transform as Compositor's `select` does |
| "Close button" | × with help "Close <title>"; hidden for the only, blank tab; asks to save; closing the last tab leaves a fresh blank one; the selection moves to the neighbour at the same index | (b) VS Code's tab close with its dirty prompt; (c) the "fresh blank tab" (VS Code shows its empty editor area or the side-bar welcome instead) |
| "File › Close Project (⌘W)" | closes the current tab | (b) `workbench.action.closeActiveEditor` (VS Code's own ⌘W) |
| "Unsaved indicator" | 5 pt dot before the title, accessibility "Unsaved changes" | (b) VS Code's dirty dot, driven by `onDidChangeCustomDocument` |
| "Active tab styling" | semibold, brighter fill/border; inactive medium; label 35-155 pt | (b) VS Code theme |
| "Reorder by dragging a tab" | ≥ 3 pt drag, others slide with 0.15 s ease-out, not undoable | (b) VS Code tab drag |
| "Overflow" | "N more tabs ⌄" pill ("1 more tab" singular), menu of hidden tabs with "• " for unsaved, selected tab never hidden | (b) VS Code scrolls tabs (or `workbench.editor.wrapTabs`); "View: Show All Editors" (`workbench.action.showAllEditors`) lists them with dirty markers |
| "Drop onto a tab" | files, images, layer rows dropped on a tab are added to that project; tab highlights, help "Add to <title>" | (b) drop onto that board's canvas (18.4). VS Code tabs accept file drops only to open them as editors |
| ""New" drop slot" | appears while an external drag is in the air; "New" with `plus`, help "Drop to open in a new canvas", accessibility "Drop into new canvas"; one project per image | (b) new command `compositorBoard.newFromImages` ("New Board from Image"), in `explorer/context` for image files (`resourceExtname` in png/jpg/jpeg/heic/heif/tif/tiff/webp/psd/psb), one board per image through the engine importer (File spec) |
| "New canvas toolbar button is also a drop target" | help "New canvas (⌘N) · Drop images here for new tabs" / "Open in a new project tab" while targeted | (c) for the drop target itself (VS Code title actions are not drop targets); covered by `compositorBoard.newFromImages` |
| "Layer rows dragged onto another tab/canvas/new slot copy those layers" | one undo step "Copy Layers from Project"; new project sized to the dragged pixels; unbased clipped layers baked; megapixel-budget error | (b) copy whole layers with ⌘C (no selection) in one board and ⌘V in another: Compositor's own `pasteCopiedLayer` path, with the extension's per-window clipboard (`this.clipboard` in `BoardProvider.runEngine`). HTML5 drag between two webviews is untested; do not rely on it |
| "A layer cannot be dropped back onto its own tab…; Option-dragging stays inside" | — | follows from the copy/paste mapping |
| "Empty title-bar area beside the tabs drags the window" | `TitleBarDragView.performDrag` | (c) VS Code's title bar |
| "No tab context menu" | click, drag, close, drop only | (b) VS Code shows its standard tab context menu; the extension adds nothing to `editor/title/context` |

### 18.2 Windows

| Checklist line | Port |
|---|---|
| "Single editor window" (`Window("Compositor", id: "editor")`, files never spawn windows) | (b) boards open as editors in the current VS Code window |
| "Default size 1180 x 780 pt; first launch fills…" | (b) VS Code's window (nothing to do) |
| "Minimum content size 800 x 520 pt" | (c), section 1.2 |
| "Unified compact toolbar without a window title" | (b) the tab carries the name; no window title change |
| "Toolbar contents: New canvas (+), tab strip, flexible space, Fit, 100%, zoom in/out" | (b) "+" as an `editor/title` action; (a) Fit / 100% / zoom at the right of the options bar (done) |
| "Main layout" | (a) done (`ui.md` 1.1), plus the board's 26 px menu bar row standing in for the native menu bar |
| "Layers panel resize" | (a) done (`.resizer`, 8 px, `col-resize`; rounded, clamped, persisted as `panelWidth`). Fix the tooltip to "Drag to resize the panel" (`Board.buildDom()` says "Drag to resize") |
| "Window proxy" | (b) VS Code window title and tab dirty dot |
| "Closing the window (red button)" | (b) VS Code's window close with its dirty-editor prompts / hot exit; (c) "leaves one fresh blank tab; reopen via Dock" |

### 18.3 Auto update

| Checklist line | Port |
|---|---|
| "Check for Updates…" | (b) "Extensions: Check for Extension Updates" (`workbench.extensions.action.checkForUpdates`) for a gallery-installed build; (c) for the local VSIX |
| "Sparkle updater started 1 s after launch…" | (c) VS Code updates extensions; EdDSA, appcast URL and installer launcher are Sparkle internals |
| "Update-found alert", "What's new list", "Buttons", "Checkbox", "Every other update step" | (b) VS Code's Extensions view: "Update" button, release notes from `CHANGELOG.md`, per-extension "Auto Update" toggle, `extensions.autoUpdate`; Compositor's texts are not reproduced |
| "Appcast content" (1.5.3, build 49, macOS 26.0, DMG) | (c) describes the macOS app's releases. The installed Compositor app keeps updating itself; the engine is rebuilt from `upstream/` (`engine/build.sh`) when upstream changes |

### 18.4 Drag and drop

| Checklist line | Upstream | Port |
|---|---|---|
| "Drop onto the canvas" | file URLs, image data and layer rows; images become layers centred at the drop point in document coordinates when over the canvas; with no document the first image sets the canvas size wherever dropped (`ContentView.swift:149-165`) | (a)+(b): the webview gets external drops only with **Shift held** (1.1); drags from VS Code's Explorer carry `text/uri-list`. On `drop`: `point = view.toDoc(local(e))` when inside the stage; post `{type: 'dropFiles', point, files: [{name, bytes}], uris: [...]}`; the extension writes byte payloads to `os.tmpdir()/<uuid>/<name>` (name kept, "Dropped" + extension when empty) and calls the engine importer (File spec) |
| "Drop highlight" | 3 pt accent rounded rectangle, radius 8, inset 3 from the canvas frame, while a valid drag hovers; none for a layer of this same project | (a) toggle a `.drop-target` outline on `dragenter`/`dragover` (with `preventDefault`), remove on `dragleave`/`drop` |
| "Drops refused while…" | Levels open, project busy, New canvas screen, importer, layer rename | (a) `dropEffect = 'none'` and ignore the drop |
| "Non-file image data…" | copied to a temp file keeping its name; types PNG, JPEG, HEIC, HEIF, TIFF, WebP, PSD, PSB, RAW, any image | (a) `DataTransferItem.kind === 'file'` gives a `File` with name and bytes for both cases; same temp-folder rule |
| "Unreadable drop message" | "Some dropped items couldn’t be read. Drag JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) files from Finder." appended (blank line between) to the import error | (b) `showErrorMessage('Import couldn’t finish', { modal: true, detail })` |
| "Dropped folders" | images directly inside, in name order; an empty folder: "“<name>” has no images to import." (one line per folder) | (b) Explorer folder drops give a path: the extension lists it. Finder folder drops give no path inside the sandboxed webview; read them with `webkitGetAsEntry()` directory readers and send the files' bytes |
| "Dropped .comp packages open as projects" | own tab, or switch to it | (b) an Explorer drop of a `.comp` folder → `vscode.openWith(…/manifest.json, 'compositorBoard.board')`. A Finder drop of a package has no path in the webview; reply with the hint to open it from the Explorer or File › Open Project… |
| "Files opened from Finder or dropped on the Dock icon" | reopen the window, activate, open `.comp` as tabs, each image as a new tab | (b)/(c), section 1.2 |

### 18.5 App delegate behaviours

| Checklist line | Port |
|---|---|
| "Launched by opening a file" | (c) |
| "Dock icon click…" | (c) |
| "Quit (⌘Q)" — settle edits (finish text, apply gradient and pixel move, cancel dialogs), then unsaved prompts current tab first, beep if something must finish | (b) VS Code's quit asks about dirty editors (or hot-exit backs them up, `files.hotExit`). Before the extension writes in `saveCustomDocument`/`flush`, it posts `settle`; the board then commits a pending gradient, pixel move or transform and cancels open panels (Cancel semantics), matching `settlePendingEdits` (`Document/ProjectWorkspace.swift:135-146`). The 800 ms autosave means most quits find nothing dirty |
| "Unsaved-changes alert" — "Save changes to <name>?" / "Your changes will be lost if you don’t save them." / Save, Cancel, Don’t Save; waits for a running save | (b) VS Code's prompt ("Do you want to save the changes you made to …?"); its wording is VS Code's |
| "Always dark" | (a)/(b), section 1.2 |
| "System menu extras removed" | (c), section 1.2 |
| "App menu visibility items" — Hide Compositor (no key), Hide Others ⌥⌘H (through the definition titled "Hide Compositor"), Show All | (b) VS Code's app menu already has "Hide Visual Studio Code" ⌘H, "Hide Others" ⌥⌘H and "Show All"; the board adds nothing and never consumes ⌥⌘H |
| "Slider track clicks installed globally" | (a) native Chromium behaviour |

### 18.6 Floating panels

| Checklist line | Upstream | Port (a) |
|---|---|---|
| "Non-modal floating panels…" | `NSPanel` titled + closable, floating, never dims the editor, hides when the app deactivates | in-webview panels (`Board.panel()`); add a title-bar × button (today only Cancel/OK). "Hides on deactivate" is (c): an in-page panel cannot float over other apps, so there is nothing to hide |
| "Placement automatic" | first open centred on the canvas; afterwards the remembered top-left (per panel name, session); content changes keep the top-left of an open panel | `Board.panel()` centres horizontally but puts the top at `min(60, centred)`; centre on the stage instead, then use the session map (17.4); on re-render keep `left/top` |
| "Placement docked right (Camera Raw)" | full window height, 440 pt, flush right, follows the window; not remembered | `.floating-panel.docked { top: 0; right: 0; bottom: 0; width: 440px; border-radius: 0 }` inside `#app`, not remembered |
| "Closing a panel with its close button acts as Cancel" | `windowWillClose` → `onClose` | × runs the panel's Cancel |
| "Panel titles" | "Levels", "Color Range", "Hue/Saturation", the effect's name, "<Expand\|Contract\|Feather> Selection", the filter's name | same titles |
| "Keyboard focus returns to a panel after a canvas click" | `FloatingPanelController.refocus` | focus the panel's first control after a sampling click (done for the picker in `View.up()`) |

### 18.7 Shared controls

| Checklist line | Upstream | Port (a) |
|---|---|---|
| "Scrubbable labels" | horizontal drag on a label or unit (min distance 1 pt), `resizeLeftRight` cursor on hover and during the drag, `value = start + dx · sensitivity`, optional `round(v / step) · step`, clamped; Int fields round (`UI/NumericScrub.swift:4-63`) | generalise the brush-only scrub (the `data-scrub` and `data-scrub-shape` handlers in `Board.bindOptions()`) into `scrub(label, { get, set, sensitivity, range, step })` with `cursor: ew-resize` (`.scrub` exists) |
| "Slider track click" | knob jumps to the press, then drags | native `<input type=range>` |
| "Arrow-key stepping" | ↑/↓ step (default 1), ⇧ ×10, only while the field is being edited (`ContentView.swift:411-485`) | done (`Board.fieldKey()`); give it a `step` parameter |
| "Return or Escape in a property field gives focus back to the canvas" | `releasesFocusOnCommit` | done (`fieldKey`) |
| "Unit suffixes kept tight" | `unitSuffix` | `.unit` right after the input with no gap (check `gap` in `.group`; use a wrapper with `gap: 2px`) |
| "Tool rail scrolls … without a scrollbar" | `IndicatorlessScrollView` | CSS fix, 2.1 |
| "Capsule-shaped bordered buttons and pop-up menus" | `buttonBorderShape(.capsule)` | done (`.pill`, `select.pop` with `border-radius: 999px`) |

### 18.8 Busy and errors

| Checklist line | Upstream | Port (a) |
|---|---|---|
| "Busy gate" | `isProjectBusy` blocks overlapping edits at once; `showsBusy` only after 250 ms → controls dim and the status bar shows a mini spinner and "Working…"; "Importing images…" while importing | done: the `working` counter blocks at once and `busyTimer` sets `busyShown` after 250 ms (spinner + "Working…", options bar dimmed); add "Importing images…" with imports |
| "File requests … wait" | open, import and drops wait until no dialog, stroke, rename or operation is in progress, then run (`waitForFileRequest`) | a promise queue in the board, released by the same conditions |

---

## 19. Status bar and hints (checklist 2105-2145)

### 19.1 Layout (`ContentView.swift:349-371`)

`HStack(spacing: 16)`, font 11 pt system with monospaced digits, secondary colour, horizontal padding 18, height 30,
`fixedSize` vertically, hidden in Canvas Only.

| Checklist line | Exact | Board |
|---|---|---|
| "Bar" | as above | `.status` in `media/board.css` has gap 14: use 16; hide in Canvas Only |
| "Zoom readout" | `Text(zoom, format: .percent.precision(.fractionLength(0...1)))`, 62 pt, leading: locale percent with grouping, 0-1 decimals: 0.667 → "66.7%", 1 → "100%", 16 → "1,600%", 0.125 → "12.5%" | `Board.updateStatus()` still prints `number(zoom)` ("66.70%", no grouping). The `zoomText` helper defined beside `isTyping` in `media/board.js` (`Intl.NumberFormat`, at most one fraction digit, grouping) is the right formatter: use it there. The webview's locale is VS Code's display language, not the macOS region: (b) |
| "Canvas dimensions" | `"\(width) × \(height) px"` (U+00D7, no grouping) | done |
| "Color mode label" | "sRGB · Transparent" | done |
| "Empty state" | "Ready when you are" with no document | done (`Board.updateStatus()`) |
| "Busy indicator" | mini spinner + "Working…" after 250 ms, replacing the hint | done (18.8) |
| "Import indicator" | mini spinner + "Importing images…" | when imports run (File spec) |
| "Tool hint" | right-aligned single line, replaced by the two indicators | done (`.hint`); the board's extra chips ("N not shown here", notes count, save state) are documented board-only additions |

### 19.2 Tool hints (exact text, `ContentView.swift:365`)

The six selection hints are ticked. The rest, verbatim:

| Tool / mode | Text |
|---|---|
| Brush Paint | "Drag to paint · [ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan" |
| Brush Erase | "Drag to erase · [ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan" |
| Smear Blur / Smudge / Liquify | "Drag to soften" / "Drag to smudge" / "Drag to push pixels", then " · [ ] size · Shift-[ ] hardness · 1–0 strength · Space to pan" |
| Clone Stamp | "Option-click to set the source · Drag to clone · [ ] size · Shift-[ ] hardness · 1–0 opacity · Space to pan" |
| Spot Healing | "Drag over blemishes to heal · [ ] size · Shift-[ ] hardness · Escape cancel · Space to pan" |
| Type | "Drag a text box · Click text to edit · Drag box handles to resize · ⌘Return finish · Escape cancel" |
| Shape | "Drag to draw a shape on a new layer · Shift " + ("45°" for Line, "square" for Rectangle, "circle" otherwise) + " · Option from center · Shift-U or Tab for the next shape · Escape cancel · Space to pan" |
| Gradient | "Drag to draw · Drag ends to adjust · Shift 45° · 1–0 opacity · Enter apply · Escape cancel" |
| Crop | "Drag to crop · Enter apply · Escape cancel · Space to pan" |
| Move | "Drag to move · Handles to resize · Circle to rotate · 1–0 layer opacity · Space to pan" |
| Hand | "Drag to pan · Pinch to zoom" |
| No tool | "No tool selected · Press a tool's key to pick one · Space to pan" |
| Zoom, and Eyedropper (no case of its own) | "Click to zoom in · Option-click to zoom out · Drag right or left to zoom smoothly · Space to pan" |

Board: the Move, Brush, Shape, Hand, Zoom and No-tool hints match, and the Eyedropper falls back to the Zoom text as
upstream does (`Board.updateStatus()`); the `ui.md` 1.7 suggestion of an Eyedropper hint of its own is therefore not
used.

### 19.3 Canvas badges

"Foot-of-canvas badges stack": section 12.4 (proof, gamut warning, then the mask-alone badge owned by the masks spec),
`VStack(spacing: 8)`, 14 pt above the bottom edge, centred, clear of the rotate handle.

### 19.4 Help-text lines (approach)

The ~250 "Help text" lines (2146-2399) are tooltips, captions, accessibility labels and messages of controls owned by
other areas. Approach:

1. Each area's spec and implementation owns its strings; this spec does not duplicate them.
2. Mapping: SwiftUI `.help` → `title`; `.accessibilityLabel` → `aria-label`; captions → visible text; alert and error
   messages → the board's panel text or `showErrorMessage(…, { modal: true, detail })`; undo names → the `label` of
   `history.push`.
3. Characters are copied exactly (’ “ ” … · – × °), never normalised to ASCII.
4. A small checker (`scripts/check-help-text.js`, to add with the first batch) extracts the quoted string of every
   Help-text line from `docs/parity/features.md` and reports which ones occur nowhere in `vscode-extension/media/` or
   `extension.js`, so those lines can be ticked mechanically once present and verified in context.

---

## 20. Engine API to add

Nothing in rulers, guides, grid, snapping, Navigator, pixel grid, palette, shortcuts, status bar or app chrome needs the
engine. CMYK proofing does (ColorSync), and it must not use the engine process's own preferences.

**Why not call `CMYK.chosen`, `CMYK.load`, `CMYK.adopt` or `CMYK.installed` as they are.** In the engine (a
non-sandboxed command-line tool), `UserDefaults.standard` is the `compositor-engine` domain and
`applicationSupportDirectory` is `~/Library/Application Support`, not the app's container
(`~/Library/Containers/com.wonderassembly.compositor/…`). Those calls would read and write state that neither the app
nor the board uses. The extension owns the choice and the folder; the engine only reads files it is given.

New file `engine/Sources/CMYKOps.swift`, dispatched from `EngineOperations.run` (`engine/Sources/EngineMain.swift:83-92`)
like `filterOperation`:

| Op | Args | Result | Upstream code used |
|---|---|---|---|
| `cmyk.profiles` | `folders: [String]` (the board's folder and, if present, the app container folder) | `{ profiles: [{ name, path }] }`: every `.icc`/`.icm` file in `/System/Library/ColorSync/Profiles`, `/Library/ColorSync/Profiles`, then `folders`, for which `CMYKProfile(name: fileNameWithoutExtension, data:)` succeeds; a later folder wins a name clash; sorted by `localizedStandardCompare` | `CMYKProfile.init?(name:data:)` (`IO/CMYK.swift:15-20`), the loop of `installed()` (`:39-50`) re-implemented over the given folders |
| `cmyk.lookups` | `path` (profile file), `name`, `out` (temp file from `files: { out: 'bin' }`) | writes `proof`, `warning`, `marked` back to back, each 33·33·33·4 little-endian Float32 (RGBA, red fastest, then green, then blue; 574,992 bytes); returns `{ dimension: 33, tables: ['proof', 'warning', 'marked'], bytesPerTable: 574992 }` | `CMYK.proofLookups(_:)` (`:143-184`) on a `CMYKProfile` built from the file |
| `cmyk.validate` | `path` | `{ name }` (file name without extension) or the error `That profile isn’t a CMYK output profile.` | `CMYKProfile.init?` + `CMYKError.notCMYK.errorDescription` (`:187-190`) |
| `cmyk.embedded` (File spec) | `path` (image) | `{ name, out }` for a CMYK image: `CMYK.profile(ofImageAt:)` naming (`ColorSyncProfileCopyDescriptionString`, else "Embedded CMYK Profile", else Generic) with the ICC bytes written to `out`; `null` otherwise | `IO/CMYK.swift:64-71, 88-96` |

Sketch:

```swift
extension EngineOperations {
    func cmykOperation(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "cmyk.lookups":
            let url = try url(args, "path")
            guard let profile = CMYKProfile(name: url.deletingPathExtension().lastPathComponent, data: try Data(contentsOf: url)),
                  let lookups = CMYK.proofLookups(profile), let out = args["out"] as? String else {
                throw EngineError.bad(CMYKError.notCMYK.errorDescription ?? "")
            }
            try (lookups.proof + lookups.warning + lookups.marked).write(to: URL(fileURLWithPath: out))
            return ["dimension": CMYK.dimension, "tables": ["proof", "warning", "marked"], "bytesPerTable": lookups.proof.count]
        // cmyk.profiles, cmyk.validate, cmyk.embedded: as in the table
        default: return nil
        }
    }
}
```

`proofLookups` caches by profile **name** (Q13): two different files with the same name in one engine process return
the first cube. `cmyk.profiles` yields one file per name, so this only bites when a profile file is replaced on disk
under the same name; it keeps its old cube until the engine restarts (accepted). The board keys its own cache by
profile path and modification time.

Extension side (`BoardProvider.runEngine` in `extension.js`): treat `op.startsWith('cmyk.')` as `stateless` (no flush, no
project), and add `folders: [globalStorage + '/CMYK Profiles', appContainerFolder]` to the args. New messages from the
board: `loadCMYKProfile` (open dialog → `cmyk.validate` → copy → prefs), `cmykProfiles` (list, for the Profile submenu).

---

## 21. Implementation notes (board, extension, package)

Suggested order; each step leaves the board working.

1. **Shortcut registry and dispatch** — new `media/shortcuts.js`: `DEFS` (16.2, in upstream order), `chordFromEvent`,
   `label`, `labelFor(title)`, `problem`, `loadOverrides`, `canvasChord`, `textChord`, `current(def)`. Rewrite
   `Board.keydown` as the pipeline of 16.3: menu dispatch by definition, then a handler
   table keyed by translated chords. Drop `SELECT` from `isTyping` (2.2) and fix the zoom modifiers (4).
2. **Menu model** — `id` + `def` on every item; File and View menus (3.1, 3.2); Edit › Keyboard Shortcuts…; menu bar
   order; labels from the registry.
3. **Prefs** — extend `compositorBoard.preferences` (17.2) with the View toggles, grid, Navigator, CMYK and JPEG
   fields; the board reads them from `load` and posts patches through `Board.persist()`.
4. **Overlay renderer** — in `media/view.js` `drawOverlay`, the order of section 14: pixel grid (10), layout grid (7),
   guides (6), transform box, ants, snap lines last; `snapTargets` gated by prefs and including the grid (8).
5. **Rulers and guides** — new `media/rulers.js` (5.2); guide hit/drag in `view.js`; ruler-drag creation; Escape;
   undo entries; menu items Show Guides, Lock Guides, Clear Guides.
6. **Grid Settings sheet** — `media/grid-sheet.js` (7.2), reusing the picker for the swatch.
7. **Navigator** — `media/navigator.js` (9) with a committed-state composite cache.
8. **Search Commands** — `media/palette.js` (15).
9. **Keyboard Shortcuts editor** — in `media/shortcuts.js` or `media/shortcut-editor.js` (16.4); extension storage key
   `compositorBoard.keyboardShortcuts.v1`, broadcast on save.
10. **No tool, status bar, hints** — 2.3, 19.
11. **Canvas Only** — `#app.canvas-only` (11.2); extension command runner + setting (11.3).
12. **CMYK** — engine ops (20), `media/proof.js` WebGL2 pass (12.5), Profile submenu, Load Profile…, badges (12.4).
13. **App-level mappings** — `package.json`: `editor/title` "+" (`compositorBoard.new`), `compositorBoard.newFromImages`
    in `explorer/context`, `configurationDefaults` for custom labels (decision 5), the optional View commands with
    `menus.commandPalette` when clauses (16.5), setting `compositorBoard.canvasOnly.workbench`; drop handling (18.4);
    `settle`/`deactivate` messages (18.1, 18.5); panel × button, centring and position memory (18.6); busy delay (18.8).

New board files must be added to `SCRIPTS` in `extension.js` (load order: `shortcuts.js` before `menus.js`;
`rulers.js`, `navigator.js`, `proof.js`, `palette.js` before `board.js`).

---

## 22. Upstream quirks and board deviations

### 22.1 Upstream quirks a faithful port inherits (decide explicitly)

| # | Quirk | Ref | Recommendation |
|---|---|---|---|
| Q1 | Over a guide that lies within a transform handle's hit radius, the cursor shows the handle cursor but a press drags the guide (handles are tested first for the cursor, guides first for the press) | `Rendering/EditorCanvas.swift:1645-1663, 1853-1856` | keep |
| Q2 | With rulers hidden, a guide cannot be deleted by dragging (`isOverRuler` requires rulers) | `:2600-2602` | keep (Clear Guides still works) |
| Q3 | Remapping "Toggle Fullscreen…" has no effect: the menu item hard-codes plain F (`.keyboardShortcut("f", modifiers: [])`, not `configuredKeyboardShortcut`), and the remapped key is translated back to F, which the canvas `keyDown` does not handle | `CompositorApp.swift:112-115`, `UI/KeyboardShortcuts.swift:116, 218-236` | decision 3: bind the View item to the definition's current chord |
| Q4 | Grid Settings writes every preview to UserDefaults and writes the originals back on Cancel | `IO/ProjectController.swift:181-205`, `Document/EditorSession.swift:291-307` | write only on OK |
| Q5 | Creating the 1,001st guide is allowed; the next save fails validation | `manifest.md` 7.5 | refuse with the beep at 1,000 (deviation) or keep |
| Q6 | The Core Graphics canvas (`CompositorCPUCanvas`) shows no CMYK proof | `Rendering/EditorCanvas.swift:861-922` vs `:2762-2771` | n/a (board has one path) |
| Q7 | ⌃⌘F is Last Filter, while the shortcut editor's help paragraph says "⌃⌘F for full screen" (Enter Full Screen was removed from the menu) | `CompositorApp.swift:330-334`, `UI/KeyboardShortcuts.swift:307` | keep the text verbatim; note that the board consuming ⌃⌘F also blocks VS Code's toggleFullScreen while a board has focus |
| Q8 | The Eyedropper shows the Zoom tool's status hint | `ContentView.swift:365` | see 19.2 |
| Q9 | The Shape tooltip says "Rectangle/Ellipse" but ⇧U cycles every kind | `Document/EditorSession.swift:99` | keep verbatim |
| Q10 | Palette tool entries show the literal letter even after a remap | `UI/CommandPalette.swift:219` | keep |
| Q11 | The shortcut editor's search keeps group headlines with no rows | `UI/KeyboardShortcuts.swift:277-279` | keep |
| Q12 | Person-level toggles are read per tab at creation; other open tabs do not follow a change | `Document/EditorSession.swift:198-341` | decision 2 |
| Q13 | Proof lookups are cached by profile name | `IO/CMYK.swift:144, 182` | one file per name (20) |
| Q14 | The definition titled "Hide Compositor" drives Hide Others | `UI/KeyboardShortcuts.swift:95`, `CompositorApp.swift:197-201` | keep the definition; VS Code's Hide Others answers ⌥⌘H |
| Q15 | Pinch and scroll keep working during shape drafts and pixel moves | `Rendering/EditorCanvas.swift:2183, 2196` | follow upstream (section 4) |
| Q16 | With Generic CMYK, pure black is out of gamut (round trip 15,12,12), so Gamut Warning grays black **(measured)** | 12.3 | keep (it is ColorSync's answer) |

### 22.2 Board deviations still present (checked 2026-10-20 00:20; re-check, the board is being edited in parallel)

| # | Where | Deviation | Fix |
|---|---|---|---|
| D1 | `isTyping` (`media/board.js`) | a focused `<select>` counts as typing and blocks tool keys | 2.2 |
| D2 | `Board.keydown` (`mod` branch) | ⌃= / ⌃- zoom; ⇧⌘- zooms out | 4 |
| D3 | `View.wheel()` | ⌘/⌥-wheel zoom direction likely reversed | 4 (verify) |
| D4 | `View.fit()` | no `max(1, …)` | 4 |
| D5 | `Board.updateStatus()`, `.status` | zoom readout via `number()` ("66.70%", no grouping); gap 14 | 19.1 |
| D6 | `.rail` in `media/board.css` | the rail shows a scrollbar | 2.1 |
| D7 | `snapTargets` (`media/transform.js`), `View.drawOverlay()` | snap targets ignore the five toggles and the grid; snap lines drawn first | 8, 14 |
| D8 | `Board.menus()` | literal shortcut labels ("⌘−" with U+2212 for Zoom Out; the registry label is "⌘-"); View order differs; menu bar order Edit, Image, Layer, Select, View | 3, 16.1 |
| D9 | `Board.panel()` | top at `min(60, …)`, no × button, positions not remembered; Enter/Escape do not follow the Apply/Cancel assignments | 18.6, 16.2 "Fixed" |
| D10 | `Board.buildDom()` | resizer tooltip "Drag to resize" | 18.2 |
| D11 | `View.busy` / `View.wheel()` | wheel and pinch blocked during shape drafts and pixel moves | Q15 |
| D12 | `Board.keydown` | ⌘H consumed (Move tool) before decision 4's test | 16.5 |

Fixed while this spec was written (no action): verbatim static rail tooltips, ⇧Tab ignored, No tool (A), zoom button
order and tooltips, backing-scale changes (`View.watchDisplay()`), "Ready when you are", the 250 ms busy delay, the
Brush and Eyedropper hints, the ⌘/⌃ middle-drag zoom cursor, the typing test for checkboxes and sliders, and the
person-level Auto Select / Show Controls / panel width.

---

## 23. To verify in a real VS Code build before relying on it

1. Does `preventDefault` + `stopPropagation` on ⌘H, ⌥⌘H, ⌘M in the webview stop VS Code's native Hide / Hide Others /
   Minimize? (Decision 4.)
2. ⌘F, ⌘R, ⇧⌘;, ⌘0, ⌘1, ⌘=, ⌘- consumed by the board never trigger Find, Reload, Focus Breadcrumbs, Focus Side Bar,
   Focus First Editor Group or window zoom.
3. Wheel and pinch directions match Compositor on the same trackpad and mouse (D3).
4. External file drop with Shift held reaches the board with names and bytes; Explorer drag delivers `text/uri-list`.
5. WebGL2 with `RGBA16F` 3D textures and `LINEAR` filtering is available in the webview (falls back to the CPU path).
6. `navigator.keyboard.getLayoutMap()` resolves inside the webview iframe (else the US table is used).
7. A `configurationDefaults` entry for `workbench.editor.customLabels.patterns` relabels board tabs, and a user-level
   value for that setting overrides it as expected.
8. `devicePixelRatio` changes when moving the VS Code window between displays fire the `matchMedia` listener.
