# Compositor feature parity checklist

Every user-facing capability of Compositor 1.5.3 (`MARKETING_VERSION = 1.5.3`, upstream/Compositor.xcodeproj/project.pbxproj:433), the macOS editor being brought into VS Code. The VS Code port reaches parity when every box below is ticked.

**Source.** `~/Projects/compositor-board/upstream` (read-only; nothing there was changed).

**References.** `(path:line)` is relative to `upstream/Compositor/` unless it starts with `upstream/`. A bare number after a path, as in `(Rendering/EditorCanvas.swift:1812-1819, 2033-2036)`, is another line in the same file.

**Line format.** `- [ ] <Area> › <Subsection> › <Feature>: what it does, options with ranges/defaults/units, shortcut (path:line)`. Each line is one atomic feature: one control, option, gesture, modifier behaviour, menu item, message or help string. Tick a line only when the port reproduces it and the behaviour has been checked against the cited code.

**How it was built and checked.**
- Every file named in the task was read, plus the rest of `Compositor/`. Large files (Rendering/EditorCanvas.swift, Document/EditorSession.swift, UI/NativeLayerList.swift) were searched per tool and feature.
- Duplicates between areas were removed in favour of the owning area.
- All checklist references were checked mechanically: each cited file exists and each cited line is within the file.
- Four completeness probes were run against the finished list:
  - every menu, submenu and menu-item title in CompositorApp.swift appears;
  - every option value of every string-backed enum (tools, modes, blend modes, filters, adjustments, effects, units, Camera Raw pages, and so on) appears;
  - every tooltip, accessibility label and sentence-length string literal (14 or more characters) in `UI/`, `Document/`, `IO/` and `Rendering/` is either quoted in its area or listed under Status bar and hints › Help text;
  - every `ShortcutDefinition` entry is covered. Generated families share one line each: the ten opacity digits, and the sixteen nudge entries as four lines.

**Total: 1837 checklist lines.** The per-area count table is at the end.

## Contents

- Tools (242)
- Selections (48)
- Layers panel and layer operations (92)
- Masks and clipping (28)
- Adjustment layers (112)
- Layer effects (34)
- Filters (103)
- Camera Raw (163)
- Image/Canvas commands (39)
- Transform (52)
- Text (33)
- Color (26)
- View (89)
- File (202)
- Edit (78)
- Keyboard shortcuts (115)
- Preferences/persisted settings (34)
- App-level (66)
- Status bar and hints (281)
- Apple-framework dependencies
- Where the code and the README disagree
- Where the board differs on purpose
- Checklist line count

## Tools

### Tool rail and tool switching

- [x] Tools › Tool rail › Rail layout: vertical 56-pt rail left of the canvas, one 36x36 button per tool in this order: Move, Marquee, Lasso, Magic, Crop, Brush, Spot Healing, Clone Stamp, Blur/Smear, Gradient, Shape, Type, Eyedropper, Hand, Zoom (No tool is not shown); selected tool gets a lighter rounded background and border; rail scrolls without indicators when the window is too short; hidden in Toggle Fullscreen (ContentView.swift:310-343, Document/EditorSession.swift:91)
- [x] Tools › Tool rail › Tooltips/accessibility labels: "Type (T)", "Eyedropper (I)", "Marquee (M)", "Lasso (L)", "Magic (W) · Tab switches Wand and Object", "Brush (B) · Eraser (E)", "Spot Healing Brush (J)", "Clone Stamp (S) · Option-click sets the source", "Smear (R)", "Gradient (G)", "Shape (U) · Shift-U switches Rectangle/Ellipse", "Crop (C)", "Move / Transform (V)", "Hand (H)", "Zoom (Z)" (Document/EditorSession.swift:99, ContentView.swift:333)
- [x] Tools › Tool rail › Mode-following icons: Brush shows an eraser icon in Erase mode; Marquee shows a dashed circle in Ellipse mode; Lasso shows a custom polygonal-lasso icon in Polygonal mode; Magic shows a custom object-selection icon in Object mode; Gradient and Clone Stamp use custom-drawn icons; others use SF Symbols (ContentView.swift:316-322, Document/EditorSession.swift:98, 211-213)
- [x] Tools › Tool rail › Color palette under the tools: foreground/background swatches sit at the foot of the rail (details owned by Color) (ContentView.swift:337)
- [x] Tools › Tool switching › Single-key tool selection (canvas focus, no Cmd/Ctrl/Opt): V Move, M Marquee, L Lasso, W Magic, C Crop, B Brush (forces Paint mode), E Brush (forces Erase mode), J Spot Healing, S Clone Stamp, R Blur/Smear, G Gradient, U Shape, T Type, I Eyedropper, H Hand, Z Zoom, A No tool; also work when focus is in the Layers panel or a header control, but not while typing in a text field; remappable in Keyboard Shortcuts (Rendering/EditorCanvas.swift:2286-2319, 776-783, UI/KeyboardShortcuts.swift:116-121)
- [x] Tools › Tool switching › Shift+letter also selects the tool (letter shortcuts accept Shift unless Shift has its own command, e.g. Shift-U) (UI/KeyboardShortcuts.swift:226-234)
- [x] Tools › Tool switching › M / W / L ignore key repeat; M re-selects the Marquee in its last shape and L the Lasso in its last mode (they do not cycle, despite the shortcut list naming them "Marquee / cycle shape" and "Lasso / cycle mode") (Rendering/EditorCanvas.swift:2300-2305, Document/Selection.swift:184-205, UI/KeyboardShortcuts.swift:119-120)
- [x] Tools › Tool switching › Tab cycles the current tool's mode: Marquee rectangle/ellipse, Magic wand/object, Lasso freehand/polygonal, Shape next kind, Brush paint/erase, Blur/Smear next mode, Spot Healing next mode, Clone Stamp toggles Sample All Layers, Gradient next shape; no effect for Move, Crop, Type, Eyedropper, Hand, Zoom, No tool; ignored while a text draft is open or during a stroke/busy (Rendering/EditorCanvas.swift:2276-2280, Document/EditorSession.swift:422-443)
- [x] Tools › Tool switching › Switching tools finishes any text being edited first (blocked if the text can't finish), is refused during a brush/warp stroke, open Levels, or a busy operation, and commits a pending transform, cancels a crop, resolves a pending gradient, cancels a lasso draft and a shape draft (Document/EditorSession.swift:395-398)
- [x] Tools › Tool switching › Brush-tip families: Clone Stamp and Blur/Smear each keep their own size/hardness/opacity (both start 40 px, hardness 0, opacity 100%); Brush, Spot Healing share one tip; switching family parks and restores the tip (Document/EditorSession.swift:220-225, 399-407)
- [x] Tools › Tool switching › Default tool at launch/new session is Move; the current tool is not persisted (Document/EditorSession.swift:172)
- [x] Tools › Tool switching › Temporary Hand: hold Space in any tool to pan (open/closed hand cursor), released on key-up; remappable "Temporary Hand tool (hold)" (Rendering/EditorCanvas.swift:2281-2285, 2323-2330, 1812-1819, UI/KeyboardShortcuts.swift:122)
- [x] Tools › Tool switching › Temporary Eyedropper: holding Option with Brush, Spot Healing or Gradient (when not mid-stroke/drag) turns clicks into color sampling with the eyedropper cursor (Rendering/EditorCanvas.swift:93, 1794-1798)
- [x] Tools › Tool switching › Tool header bar: every tool shows a 42-pt header strip above the canvas (title 13 pt semibold, controls 12 pt); the header is hidden in Toggle Fullscreen (UI/ToolHeaderStyle.swift:3-8, 37-42, ContentView.swift:27-82)
- [x] Tools › Tool switching › Held-modifier indicator: header toggles show the temporarily flipped state while Cmd (Auto Select) or Shift (aspect lock) is held, ignoring keys held while typing in a text field and resetting when the app deactivates or a menu closes (UI/HeldModifiers.swift:4-38)

### Move / Transform

- [x] Tools › Move / Transform › Header title: "Transform", or "Transform Mask" when an unlinked mask is targeted (UI/TransformInspector.swift:11)
- [ ] Tools › Move / Transform › Auto Select toggle: default off, persisted (tool.autoSelect); on = a press picks the topmost layer under the pointer; holding Cmd flips it for that click and the checkbox shows the flipped state (UI/TransformInspector.swift:13-17, Document/EditorSession.swift:198-199, Rendering/EditorCanvas.swift:1674-1711) — the board differs on purpose, see Where the board differs on purpose
- [x] Tools › Move / Transform › Show Controls toggle: default on, persisted (tool.transformControls); hides the transform box and handles so a drag anywhere just moves the layer; a pending Cmd-T edit still shows its box; same as View › Show Transform Controls (Cmd-H) (UI/TransformInspector.swift:18-19, Document/EditorSession.swift:200-202, Rendering/TransformOverlay.swift:65, CompositorApp.swift:137-139)
- [ ] Tools › Move / Transform › Press-to-drag target: a press that misses the handles drags the active layer even on empty canvas; with Auto Select it drags the topmost layer containing the press when that is above the active one (a full-canvas background never hides a foreground layer) (Rendering/EditorCanvas.swift:1679-1711) — the board differs on purpose, see Where the board differs on purpose
- [x] Tools › Move / Transform › Cmd-click picks the layer under the pointer (when Auto Select off); Cmd-Shift-click adds/removes the layer under the pointer to the layer selection regardless of Auto Select (Rendering/EditorCanvas.swift:1687-1689, 2614-2621)
- [x] Tools › Move / Transform › Option-drag duplicates: dragging the body with Option duplicates the selected layers/folders (with descendants, stacked above the topmost original) and drags the copies; undo step "Duplicate Layer(s)"; Escape mid-drag removes the copies and restores the selection (Rendering/EditorCanvas.swift:2625, 2001-2004, Document/EditorSession.swift:465-483, 526-537)
- [x] Tools › Move / Transform › Double-click live text with the Move tool opens the inline Type editor on the topmost visible text layer under the pointer, without switching tools (Rendering/EditorCanvas.swift:1854-1855, 2584-2597)
- [x] Tools › Move / Transform › Dragging an existing guide with the Move tool moves it (guide hit-test before layer drag); released over a ruler deletes it (Rendering/EditorCanvas.swift:1856, 2573-2582, 2111-2114)
- [x] Tools › Move / Transform › Cursors: four-arrow move cursor over draggable content, double-arrow duplicate cursor with Option, oriented resize cursors on handles/edges, rotate cursor on the rotation handle, white-arrow distort cursor with Cmd or once distorted, resize-left-right/up-down over guides, arrow when nothing would move; cursor locked for the whole drag (Rendering/EditorCanvas.swift:1643-1666, 2637-2645, 199-204, 412-427, Rendering/TransformOverlay.swift:43-49)
- [x] Tools › Move / Transform › Opacity digit keys: 1-9 set the selected layers' opacity to 10-90%, 0 to 100%; two digits within 0.6 s set an exact value (4,5 = 45%; 0,5 = 5%); applies to every selected layer/folder as one undo step "Layer Opacity" (Document/EditorSession+Brush.swift:231-252, Document/LayerAppearance.swift:108-121, Rendering/EditorCanvas.swift:2306-2307)
- [x] Tools › Move / Transform › Arrow-key nudge of the layer: see Transform › Keyboard (Rendering/EditorCanvas.swift:2268-2272)

### Selection tools (shared: Marquee, Lasso, Magic)

- [x] Tools › Selection tools › Selection mode picker: segmented New | Add | Subtract (no Intersect), default New; sets the mode for the next outline/click; live-highlights the mode implied by held Shift/Option, or the in-progress outline's own mode (UI/LassoControls.swift:41-47, Document/Selection.swift:85-89, Document/Selection.swift:127-139, Document/EditorSession.swift:244-246)
- [x] Tools › Selection tools › Shift adds: Shift held at the press combines the new outline/click as Add for that one outline (Document/Selection.swift:122-125, Rendering/EditorCanvas.swift:2442)
- [x] Tools › Selection tools › Option subtracts: Option held at the press subtracts for that one outline; Option wins when Shift is also held (Document/Selection.swift:122-125)
- [x] Tools › Selection tools › Combine rules: New replaces; Add unions with the current selection (or starts one); Subtract with no selection does nothing; every outline is clipped to the canvas first (Document/Selection.swift:233-247)
- [x] Tools › Selection tools › Modifier tracking app-wide: Shift/Option changes update the mode picker and cursor badge even when another control has focus (Rendering/EditorCanvas.swift:730-732, Rendering/EditorCanvas.swift:765-767)
- [x] Tools › Selection tools › Expand button + amount field: grows the selection by N px, 1...500, step 1, default 1; label/unit scrubbable, Up/Down arrow-step (Shift x10); disabled without a non-empty selection (UI/LassoControls.swift:56-58, UI/LassoControls.swift:145-160, Document/EditorSession.swift:344)
- [x] Tools › Selection tools › Contract button + amount field: shrinks by N px, 1...500, step 1, default 1; same scrub/arrow behaviour and disabling (UI/LassoControls.swift:59-61, UI/LassoControls.swift:145-160, Document/EditorSession.swift:345)
- [x] Tools › Selection tools › Feather button + amount field: softens the edge by N px, 1...250, step 1, default 2; non-finite input resets to 2; scrubbable px suffix (UI/LassoControls.swift:62-75, Document/EditorSession.swift:277)
- [x] Tools › Selection tools › Empty-selection indicator and Deselect button: right end of the header shows "Empty selection" when the selection is explicitly empty, plus a Deselect button whenever any selection exists (UI/LassoControls.swift:80-83)
- [x] Tools › Selection tools › Header disabled while the app is busy or with no document; header scrolls horizontally when narrow (UI/LassoControls.swift:9, UI/LassoControls.swift:78, UI/LassoControls.swift:86)
- [x] Tools › Selection tools › Drag inside selection moves the outline: in New mode a press inside a non-empty selection drags the outline only (never pixels), one undo step "Move Selection", move cursor (arrow + dashed box) (Rendering/EditorCanvas.swift:2443-2448, Document/Selection.swift:256-283, Rendering/EditorCanvas.swift:241-242)
- [x] Tools › Selection tools › Outline move constrain: Shift locks the move to whichever axis the drag has gone further along (Rendering/EditorCanvas.swift:2385-2394)
- [x] Tools › Selection tools › Outline move snapping: selection bounds' edges and middle snap to View › Snap To targets per axis; Control held bypasses snapping; snap guides drawn (Rendering/EditorCanvas.swift:2395-2400, Document/Crop.swift:197-206)
- [x] Tools › Selection tools › Outline move whole-pixel offsets and not re-clipped, so it can leave the canvas and come back intact (Document/Selection.swift:270-277)
- [x] Tools › Selection tools › Outline move autoscroll when the pointer passes the view edge (Rendering/EditorCanvas.swift:2373-2382)
- [x] Tools › Selection tools › Click inside selection without dragging: Marquee/Lasso deselect; Wand/Object re-select afresh from that pixel (Rendering/EditorCanvas.swift:2144-2159)
- [x] Tools › Selection tools › Arrow keys nudge the outline: 1 px, Shift 10 px, each press one "Move Selection" undo step (only with a selection tool, no draft, non-empty selection) (Rendering/EditorCanvas.swift:2262-2267, Document/Selection.swift:285-290)
- [x] Tools › Selection tools › Cmd-drag inside selection: cuts and moves the active layer's selected pixels (Photoshop's temporary Move); scissors cursor; beeps on a mask target or no pixels (Rendering/EditorCanvas.swift:2434-2440, Rendering/EditorCanvas.swift:135, Document/SelectionEdits.swift:166-178)
- [x] Tools › Selection tools › Cmd-Option-drag inside selection: duplicates the selected pixels instead of cutting; copy (double-arrow) cursor (Rendering/EditorCanvas.swift:2436-2438, Rendering/EditorCanvas.swift:199, Rendering/EditorCanvas.swift:839-840)
- [x] Tools › Selection tools › Shift during a pixel drag constrains to the dominant axis (Rendering/EditorCanvas.swift:1908-1916)
- [x] Tools › Selection tools › Cursors: crosshair with the tool's icon (freehand lasso, polygonal lasso, rectangle, ellipse, object) and a "+" (Add) or "−" (Subtract) badge (Rendering/EditorCanvas.swift:263-270, Rendering/EditorCanvas.swift:823-837)
- [x] Tools › Selection tools › Cursor over selection: move-outline cursor in New mode; holding Cmd shows scissors, Cmd-Option the copy cursor (Rendering/EditorCanvas.swift:820-831)
- [x] Tools › Selection tools › Switching tool cancels any outline in progress (Document/EditorSession.swift:398)
- [x] Tools › Selection tools › Canvas losing focus cancels freehand/marquee drafts and outline/pixel drags; a polygonal draft is kept (Rendering/EditorCanvas.swift:2338-2340)

### Marquee (Rectangle / Ellipse)

- [x] Tools › Marquee › Select tool with M: picks the Marquee in whichever shape it was last set to (does not cycle the shape; key repeat ignored) (Rendering/EditorCanvas.swift:2300-2302, Document/Selection.swift:182-186, UI/NativeLayerList.swift:799)
- [x] Tools › Marquee › Tool-rail icon follows shape: dashed rectangle, dashed circle in Ellipse mode (ContentView.swift:321-322)
- [x] Tools › Marquee › Header title "Marquee" (UI/LassoControls.swift:8)
- [x] Tools › Marquee › Shape picker: segmented Rectangle | Ellipse, default Rectangle, kept while the project is open; changing it cancels a draft; its tooltip says "Press M to switch" although M only selects the tool (stale help) (UI/LassoControls.swift:11-19, Document/EditorSession.swift:233)
- [x] Tools › Marquee › Tab toggles Rectangle/Ellipse (Document/EditorSession.swift:431-432, Document/Selection.swift:188-191, Rendering/EditorCanvas.swift:2276-2280)
- [x] Tools › Marquee › Anti-alias toggle shown only in Ellipse mode (rectangles snap to whole pixels), default on (UI/LassoControls.swift:50-54, Document/EditorSession.swift:266)
- [x] Tools › Marquee › Drag draws a box from the press corner, both corners rounded to whole document pixels (Document/Selection.swift:91-105, Document/Selection.swift:141-162)
- [x] Tools › Marquee › Shift mid-drag constrains to square / circle; a Shift already held at the press means Add and only squares after it is released and pressed again; the box reshapes as Shift changes without moving the mouse (Rendering/EditorCanvas.swift:2409-2431, Rendering/EditorCanvas.swift:746-749)
- [x] Tools › Marquee › Option at the press subtracts; the Marquee never draws from the center (unlike the Shape tool) (Rendering/EditorCanvas.swift:2409-2411, Document/Selection.swift:152-155)
- [x] Tools › Marquee › Corner snapping: the start corner and the dragged corner snap to View › Snap To targets (edges, no centers) within the snap distance; Control bypasses (Rendering/EditorCanvas.swift:2412-2416, Rendering/EditorCanvas.swift:2457, Document/Crop.swift:184-195, Document/Crop.swift:208-211)
- [x] Tools › Marquee › Autoscroll while dragging past the view edge: 12 pt margin, speed 2 + 0.4 x overshoot up to 40 pt per frame at 60 Hz; the corner follows the scrolled document (Rendering/EditorCanvas.swift:2352-2384)
- [x] Tools › Marquee › Release commits; a zero-area box in New mode deselects; undo names "Rectangular Marquee" / "Elliptical Marquee" (Rendering/EditorCanvas.swift:2160-2164, Document/Selection.swift:209-231)
- [x] Tools › Marquee › Draft drawn as a 2 px 80% black line under a 1 px white line (box or oval) (Rendering/TransformOverlay.swift:314-336)
- [x] Tools › Marquee › Esc during the drag cancels the draft (Rendering/EditorCanvas.swift:2225-2226)

### Lasso (Freehand / Polygonal)

- [x] Tools › Lasso › Select tool with L: picks the Lasso in its last mode (does not cycle; key repeat ignored) (Rendering/EditorCanvas.swift:2304-2305, Document/Selection.swift:198-202, UI/NativeLayerList.swift:800)
- [x] Tools › Lasso › Header title "Lasso" (UI/LassoControls.swift:8)
- [x] Tools › Lasso › Mode picker: segmented Freehand | Polygonal, default Freehand; changing cancels a draft; tooltip says "Press L to switch" although L only selects the tool (stale help) (UI/LassoControls.swift:31-39, Document/EditorSession.swift:232)
- [x] Tools › Lasso › Tab toggles Freehand/Polygonal (Document/EditorSession.swift:434, Document/Selection.swift:204-207)
- [x] Tools › Lasso › Tool-rail icon switches to a straight-segment polygonal lasso in Polygonal mode (ContentView.swift:319, UI/LassoControls.swift:163-184)
- [x] Tools › Lasso › Anti-alias toggle, default on (UI/LassoControls.swift:51-54, Document/EditorSession.swift:266)
- [x] Tools › Lasso › Freehand: drag traces the outline; points closer than 0.25 px are skipped; release closes it; undo "Lasso" (Document/Selection.swift:164-170, Rendering/EditorCanvas.swift:1931, Rendering/EditorCanvas.swift:2160-2164, Document/Selection.swift:229)
- [x] Tools › Lasso › Polygonal: each click adds a corner; a rubber-band segment follows the pointer (on move and drag) (Rendering/EditorCanvas.swift:2461-2466, Rendering/EditorCanvas.swift:1615-1617, Rendering/EditorCanvas.swift:1932)
- [x] Tools › Lasso › Polygonal close: click within 8 pt of the first corner (3+ corners) or double-click; undo "Polygonal Lasso" (Rendering/EditorCanvas.swift:2461-2463, Document/Selection.swift:229)
- [x] Tools › Lasso › Polygonal Return/Enter closes the outline (Rendering/EditorCanvas.swift:2225-2227)
- [x] Tools › Lasso › Polygonal Delete/Backspace removes the last corner; removing the only corner cancels (Rendering/EditorCanvas.swift:2228, Document/Selection.swift:174-178)
- [x] Tools › Lasso › Polygonal Esc cancels the outline (Rendering/EditorCanvas.swift:2226)
- [x] Tools › Lasso › Polygonal first corner drawn as an 8 pt white square handle to click (Rendering/TransformOverlay.swift:337-344)
- [x] Tools › Lasso › Mode fixed at the first click: modifiers at the first press choose Add/Subtract for the whole outline (Rendering/EditorCanvas.swift:2424-2426, Document/Selection.swift:127-131)
- [x] Tools › Lasso › Degenerate outline (under 3 points or zero area) in New mode deselects, as in Photoshop (Document/Selection.swift:223-226)

### Magic (Wand / Object)

- [x] Tools › Magic › Select tool with W (key repeat ignored) (Rendering/EditorCanvas.swift:2303, Document/Selection.swift:193-196, UI/NativeLayerList.swift:805)
- [x] Tools › Magic › Header title "Magic"; Mode picker segmented Wand | Object, default Wand; changing cancels a draft (UI/LassoControls.swift:8, UI/LassoControls.swift:21-29, Document/Selection.swift:68-73, Document/EditorSession.swift:215)
- [x] Tools › Magic › Tab toggles Wand/Object (Document/EditorSession.swift:433)
- [x] Tools › Magic › Tool-rail icon switches to the corner-brackets-plus-pointer object icon in Object mode (ContentView.swift:320, UI/LassoControls.swift:247-270)
- [x] Tools › Magic › Anti-alias toggle, default on; Wand: smooth selection edges; Object: smooth the traced outline (off gives the raw pixel mask) (UI/LassoControls.swift:51-54)
- [x] Tools › Magic › Wand Tolerance: 0...255 integer, default 32; scrubbable label, field, Up/Down steps; per-channel distance from the clicked color (UI/LassoControls.swift:92-102, Document/MagicWand.swift:12-13)
- [x] Tools › Magic › Wand Sample Size: Point Sample | 3 by 3 Average | 5 by 5 Average, default Point Sample (UI/LassoControls.swift:103-107, Document/MagicWand.swift:3-8, Document/MagicWand.swift:14)
- [x] Tools › Magic › Wand Sample: segmented This Layer | All Layers, default This Layer; All reads every visible layer as shown, This reads the active layer's own pixels without its mask; a folder/blank layer reads transparent (UI/LassoControls.swift:108-113, Document/MagicWand.swift:17-18, Document/MagicWand.swift:125-137)
- [x] Tools › Magic › Wand Contiguous toggle, default on: 4-connected flood from the clicked pixel (nothing if the seed itself fails); off selects every matching pixel anywhere (UI/LassoControls.swift:114-115, Document/MagicWand.swift:15-16, Rendering/WandPixels.h:5-12)
- [x] Tools › Magic › Wand match rule: every channel, alpha included, within Tolerance of the reference color (premultiplied RGBA), outline traced along pixel edges (Rendering/WandPixels.h:5-12, Rendering/WandPixels.h:20-27, Document/MagicWand.swift:54-80)
- [x] Tools › Magic › Wand click: selects similar pixels combined by mode, off the main thread; nothing matched in New mode deselects; undo "Magic Wand" (Rendering/EditorCanvas.swift:2453-2455, Document/MagicWand.swift:94-123)
- [x] Tools › Magic › Wand errors: "That selection is too detailed to outline. Try a different Tolerance, or turn on Contiguous." and out-of-memory message (Document/MagicWand.swift:24-31)
- [x] Tools › Magic › Wand cursor: a wand whose sparkle is the hot spot, with +/− mode badges (Rendering/EditorCanvas.swift:372-373, Rendering/EditorCanvas.swift:832)
- [x] Tools › Magic › Object Sample: segmented This Layer | All Layers, default All Layers (UI/LassoControls.swift:119-126, Document/ObjectSelection.swift:5-7)
- [x] Tools › Magic › Object Edge: -10...10 px integer, default 0; positive erodes the detected mask inward, negative dilates outward, 1 px per step (UI/LassoControls.swift:127-141, Document/ObjectSelection.swift:8-9, Document/ObjectSelection.swift:84-124)
- [x] Tools › Magic › Object click: selects the foreground object instance under the pointer, mask upsampled edge-preserving to image resolution, thresholded at 50%, traced, optionally smoothed (Douglas-Peucker 1.6 px + 3 Chaikin passes); undo "Object Selection" (Rendering/EditorCanvas.swift:2449-2451, Document/ObjectSelection.swift:37-51, Document/ObjectSelection.swift:126-166, Document/ObjectSelection.swift:270-297)
- [x] Tools › Magic › Object click on background / no object found in New mode deselects (Document/ObjectSelection.swift:288-291)
- [x] Tools › Magic › Object error: "Object Selection requires macOS 14 or later." / "The object mask could not be rendered." (Document/ObjectSelection.swift:15-25)
- [x] Tools › Magic › Object cursor: crosshair with the object icon and +/− badges (Rendering/EditorCanvas.swift:833-836)

### Crop

- [x] Tools › Crop › Entering the tool: selecting Crop resets ratio to Free and starts the frame at the full canvas, or at the selection's pixel bounds (clipped to the canvas) when a selection exists, so C then Return crops to the selection (Document/EditorSession.swift:410-420)
- [x] Tools › Crop › Ratio picker: Free (default), Original (canvas aspect), 1:1, 4:3, 3:4, 16:9, 9:16; choosing a ratio refits the frame keeping its width and vertical center (UI/CropControls.swift:11-14, Document/Crop.swift:218-235)
- [x] Tools › Crop › Size readout: live "W × H px" of the frame in the header (UI/CropControls.swift:15-17)
- [x] Tools › Crop › Cancel button (disabled with no frame change) and Apply Crop button; header disabled while busy or with no document (UI/CropControls.swift:19-22)
- [x] Tools › Crop › Drag outside the frame (or inside a full-canvas frame) draws a new frame; drag inside a non-full frame moves it; corner handles and entire edges (10-pt hit zones) resize it (Rendering/EditorCanvas.swift:2542-2552, Rendering/TransformOverlay.swift:383-405)
- [x] Tools › Crop › Option = symmetric: creating grows from the press point as center; resizing keeps the frame's center fixed; updates live as Option is pressed/released mid-drag (Document/Crop.swift:15-26, 34-44, Rendering/EditorCanvas.swift:2561-2566, 750-754)
- [x] Tools › Crop › Fixed ratio constrains creating and resizing; with a fixed ratio only moves snap so the ratio stays exact (Document/Crop.swift:18-21, 42, 65-67)
- [x] Tools › Crop › Edge snapping: frame edges snap to canvas edges, layer edges, visible grid lines and visible guides (no centers) within 8 screen points; follows View › Snap / Snap To; Control bypasses (Rendering/EditorCanvas.swift:123, 2553-2554, 2567-2569, Document/Crop.swift:48-112, 208-211, Document/Guides.swift:247-285)
- [x] Tools › Crop › Whole-pixel frames: frame corners round to whole pixels; size 1...30,000 px per side; frame may extend beyond the canvas (content outside is drawn while cropping) (Document/Crop.swift:4-14, Rendering/EditorCanvas.swift:2536-2540)
- [x] Tools › Crop › Overlay: area outside the frame darkened 60%, white frame border, rule-of-thirds lines at 40% white, 8 square handles (Rendering/TransformOverlay.swift:492-519)
- [x] Tools › Crop › Return/Enter applies, Escape cancels (Rendering/EditorCanvas.swift:2240-2245)
- [x] Tools › Crop › Leaving the tool, a canvas rotate/flip, an undo/redo, or starting a transform cancels the pending frame (Document/EditorSession.swift:398, 446, 670, Document/CanvasRotation.swift:36, Document/LayerFlip.swift:57)

### Brush (Paint / Erase)

- [x] Tools › Brush › Tool selection: B selects Brush in Paint mode, E selects Brush in Erase mode; rail label "Brush (B) · Eraser (E)"; rail icon switches to an eraser in Erase mode; header title reads "Brush" or "Eraser" (Rendering/EditorCanvas.swift:2290, Rendering/EditorCanvas.swift:2291, Document/EditorSession.swift:99, Document/EditorSession.swift:211, UI/BrushControls.swift:7)
- [x] Tools › Brush › Mode picker: segmented Paint / Erase, default Paint; help "Paint with the foreground color (B), or erase pixels away (E)" (UI/BrushControls.swift:10, Document/SmudgeLiquify.swift:5, Document/EditorSession.swift:209)
- [x] Tools › Brush › Tab cycles mode: Tab toggles Paint and Erase (no modifiers, not while typing text) (Document/EditorSession.swift:436, Rendering/EditorCanvas.swift:2276)
- [x] Tools › Brush › Size: label scrub (1 px per point dragged), field 1...2000 px, integer, default 40 px, Up/Down step 1 (Shift 10), non-finite falls back to 40 (UI/BrushControls.swift:41, Document/BrushStroke.swift:10)
- [x] Tools › Brush › Hardness: label scrub (0.01 per point), slider 0...100 %, field 0...100 %, default 100 % for Brush/Spot Healing (UI/BrushControls.swift:52, Document/BrushStroke.swift:11)
- [x] Tools › Brush › Opacity: label scrub, slider 1...100 %, field 1...100 %, default 100 %; caps the whole stroke so overlapping dabs never exceed it; help "Press 1–9 for 10–90%, 0 for 100%" (UI/BrushControls.swift:61, Document/BrushStroke.swift:15)
- [x] Tools › Brush › Smoothing: Brush only (Paint and Erase), label scrub, slider 0...100, field 0...100, default 0; brush trails the pointer on a string of that length in screen points (zoom independent), stroke catches up to the pointer on release (UI/BrushControls.swift:88, Document/EditorSession+Brush.swift:107, Document/EditorSession+Brush.swift:142, Document/BrushStroke.swift:19)
- [x] Tools › Brush › Color swatch: shows foreground color; click opens the Color Picker on the foreground; hidden for Clone Stamp and Smear and when a mask is selected; disabled while busy/painting (UI/BrushControls.swift:105)
- [x] Tools › Brush › Mask paint picker: when the layer mask is selected, header shows "Paint" picker Black · Hide / White · Reveal (default Black · Hide) in place of the color swatch, plus a "Mask" label (UI/BrushControls.swift:100, UI/BrushControls.swift:127, Document/EditorSession.swift:227)
- [x] Tools › Brush › Paint stroke: drag paints the foreground color through a round tip with Gaussian soft falloff, dabs follow a centripetal Catmull-Rom curve through mouse samples (Document/EditorSession+Brush.swift:50, Document/BrushStroke.swift:104, Document/BrushStroke.swift:278, Document/BrushStroke.swift:450)
- [x] Tools › Brush › Erase stroke: Erase mode clears layer alpha under the tip at the brush opacity (destination-out); on a selected mask Erase paints the chosen mask color instead of erasing (Document/BrushStroke.swift:524, Document/EditorSession+Brush.swift:67)
- [x] Tools › Brush › Paint past layer edges: a stroke may cover the whole canvas; the pixel layer grows to the painted bounds; an empty (blank) layer allocates pixels on first paint (Document/BrushStroke.swift:218, Document/BrushStroke.swift:945, Document/EditorSession.swift:38)
- [x] Tools › Brush › Paint on mask: with the mask selected, paints black or white; the brush (and gradient) may grow the mask past its layer onto the canvas (Document/EditorSession+Brush.swift:69, Document/EditorSession+Brush.swift:70, Document/BrushStroke.swift:199)
- [x] Tools › Brush › Paint on folder mask: a folder has no pixels but its mask can be painted (Document/EditorSession+Brush.swift:6)
- [x] Tools › Brush › Selection clip: painting is limited to the active selection (Document/EditorSession+Brush.swift:43, Document/BrushStroke.swift:149)
- [x] Tools › Brush › 16-bit layers: painting a 16-bit layer keeps it 16-bit (Document/BrushStroke.swift:966)
- [x] Tools › Brush › Live layer effects while painting: the layer's effects follow the wet paint during the stroke (Rendering/EditorCanvas.swift:1085)
- [x] Tools › Brush › Shift-click straight line: Shift-click paints a straight line from the end of the last stroke when the same layer/mask is the target (Rendering/EditorCanvas.swift:1830, Document/EditorSession+Brush.swift:119)
- [x] Tools › Brush › Shift-drag axis lock: holding Shift during a drag keeps the stroke horizontal or vertical, axis settled after 3 px of movement; releasing Shift continues freehand (applies to all brush tools) (Rendering/EditorCanvas.swift:1961)
- [x] Tools › Brush › [ and ] size keys: [ shrinks / ] grows the tip by a fifth (x1.2), at least 1 px per step, clamped 1...2000; works with focus in the canvas or elsewhere (all brush tools) (Document/EditorSession+Brush.swift:261, Rendering/EditorCanvas.swift:2308, Rendering/EditorCanvas.swift:789)
- [x] Tools › Brush › Shift-[ / Shift-] hardness keys: steps hardness through 0/25/50/75/100 %, snapping to the next quarter (all brush tools) (Document/EditorSession+Brush.swift:254, Rendering/EditorCanvas.swift:2311)
- [x] Tools › Brush › Digit opacity keys: 1–9 = 10–90 %, 0 = 100 %; two digits within 0.6 s set an exact value (4,5 = 45 %; 0,5 = 5 %); applies to Brush, Spot Healing, Clone Stamp, Smear (strength) and Gradient (Document/EditorSession+Brush.swift:233, Document/EditorSession+Brush.swift:237, Rendering/EditorCanvas.swift:2306)
- [x] Tools › Brush › Right-drag tip resize: right-drag left/right changes diameter (circle edge follows the pointer, clamped 1...2000); Shift-right-drag changes hardness (full range over 200 pt) and shows an inner dashed hardness ring; circle stays at the press point (all brush tools) (Rendering/EditorCanvas.swift:1712, Rendering/BrushCursorOverlay.swift:65)
- [x] Tools › Brush › Option temporary eyedropper: holding Option with Brush (and Spot Healing, Gradient) turns the pointer into the eyedropper; click/drag samples the composite color into the foreground (with the sample ring if enabled) (Rendering/EditorCanvas.swift:93, Rendering/EditorCanvas.swift:1797, Rendering/EditorCanvas.swift:2521)
- [x] Tools › Brush › Brush outline cursor: a white-over-black circle at the tip's on-screen diameter follows the pointer; hidden while Space-panning, picking a color or middle-button navigating (all brush tools) (Rendering/EditorCanvas.swift:1509, Rendering/BrushCursorOverlay.swift:59)
- [x] Tools › Brush › Escape cancels stroke: Esc during a stroke discards it (all brush tools incl. Smudge/Liquify) (Rendering/EditorCanvas.swift:2221)
- [x] Tools › Brush › Commit on release: mouse-up commits the stroke as one undo step; undo names "Brush Stroke", "Erase", "Paint Mask", "Blur", "Clone Stamp", "Spot Healing" (Rendering/EditorCanvas.swift:2121, Document/EditorSession+Brush.swift:132, Document/EditorSession+Brush.swift:171)
- [x] Tools › Brush › Refusal alert: several layers selected: "Several layers are selected. Select just one to paint on it." (alert "Couldn't paint"; all brush tools and Gradient) (Document/EditorSession+Brush.swift:16, ContentView.swift:297)
- [x] Tools › Brush › Refusal alert: folder target without its mask selected: "is a folder, which has no pixels of its own..." (Document/EditorSession+Brush.swift:17)
- [x] Tools › Brush › Refusal alert: hidden layer or inside a hidden folder: "...is hidden, or inside a hidden folder. Show it to paint on it." (Document/EditorSession+Brush.swift:20)
- [x] Tools › Brush › Refusal alert: mask turned off: "The layer mask is turned off. Shift-click its thumbnail to turn it on, then paint." (Document/EditorSession+Brush.swift:23)
- [x] Tools › Brush › Refusal alert: adjustment layer pixels: "...is an adjustment layer, with no pixels to paint. Paint on its mask instead." (Document/EditorSession+Brush.swift:26)
- [x] Tools › Brush › Pixel budget: a stroke that would exceed the document pixel budget fails with an error alert (Document/EditorSession+Brush.swift:42)
- [x] Tools › Brush › Shared tip: Brush and Spot Healing share one size/hardness/opacity; Clone Stamp and Smear each keep their own (both start 40 px, 0 % hardness, 100 %), swapped in when the tool changes (Document/EditorSession.swift:222, Document/EditorSession.swift:399)
- [x] Tools › Brush › Header disabled while busy: brush headers dim during long operations (UI/BrushControls.swift:133)

### Spot Healing

- [x] Tools › Spot Healing › Tool selection: J; rail label "Spot Healing Brush (J)"; header title "Spot Healing" (Rendering/EditorCanvas.swift:2292, Document/EditorSession.swift:99, UI/BrushControls.swift:7)
- [x] Tools › Spot Healing › Type picker: segmented Content-Aware / Create Texture / Proximity Match, default Content-Aware (UI/BrushControls.swift:24, Document/BrushStroke.swift:3, Document/EditorSession.swift:206)
- [x] Tools › Spot Healing › Content-Aware mode: rebuilds the painted spot patch-by-patch from surrounding image so edges and patterns continue; falls back to smooth fill when nothing to rebuild from (Rendering/HealPixels.c:120)
- [x] Tools › Spot Healing › Create Texture mode: smooth membrane fill from the surrounding ring plus synthesized grain matching nearby detail (Rendering/HealPixels.c:191, Rendering/HealPixels.c:233)
- [x] Tools › Spot Healing › Proximity Match mode: fills from the best nearby source patch, nearer patches favoured, aligned to texture (Rendering/HealPixels.c:188, Rendering/HealPixels.c:201)
- [x] Tools › Spot Healing › Tab cycles type: Tab steps Content-Aware → Create Texture → Proximity Match (Document/EditorSession.swift:438)
- [x] Tools › Spot Healing › Size / Hardness / Opacity: same fields and ranges as Brush (1...2000 px, 0...100 %, 1...100 %); opacity sets how strongly the heal is laid in; no Smoothing (UI/BrushControls.swift:41, UI/BrushControls.swift:52, UI/BrushControls.swift:61, Document/BrushStroke.swift:921)
- [x] Tools › Spot Healing › Dark wash preview: while dragging, the area to heal shows as a dark (0.12 gray, 45 %) wash; healing runs on release from the layer's original pixels, as one undo step (Document/BrushStroke.swift:521, Document/BrushStroke.swift:887, Document/EditorSession+Brush.swift:148)
- [x] Tools › Spot Healing › Pixels only: does nothing on a selected mask (Document/EditorSession+Brush.swift:51)
- [x] Tools › Spot Healing › Color swatch: header shows the foreground swatch (not used for healing) and Option eyedropper works (UI/BrushControls.swift:105, Rendering/EditorCanvas.swift:93)

### Clone Stamp

- [x] Tools › Clone Stamp › Tool selection: S; rail label "Clone Stamp (S) · Option-click sets the source"; custom stamp rail icon; header title "Clone Stamp" (Rendering/EditorCanvas.swift:2293, Document/EditorSession.swift:99, UI/BrushControls.swift:138, UI/BrushControls.swift:7)
- [x] Tools › Clone Stamp › Option-click sets source: Option-click on the canvas sets the document point to copy from; a new source resets alignment (Rendering/EditorCanvas.swift:1822, Document/CloneStamp.swift:14)
- [x] Tools › Clone Stamp › No-source hint and error: header shows "Option-click to set the source" until a source exists; painting without one alerts "Option-click where Clone Stamp should copy from first." (UI/BrushControls.swift:124, Document/EditorSession+Brush.swift:56)
- [x] Tools › Clone Stamp › Aligned toggle: default on; on keeps the brush-to-source offset across strokes, off restarts every stroke at the source point (UI/BrushControls.swift:32, Document/CloneStamp.swift:7, Document/CloneStamp.swift:23)
- [x] Tools › Clone Stamp › Sample picker: segmented This Layer / All Layers, default This Layer; All Layers copies the visible composite as shown, This Layer copies the active layer's own pixels at its own resolution (UI/BrushControls.swift:34, Document/CloneStamp.swift:9, Document/CloneStamp.swift:39)
- [x] Tools › Clone Stamp › Tab toggles sample: Tab flips This Layer / All Layers (Document/EditorSession.swift:439)
- [x] Tools › Clone Stamp › Size / Hardness / Opacity: same ranges as Brush; own tip defaults 40 px, hardness 0 %, opacity 100 %; no color swatch, no Smoothing (UI/BrushControls.swift:41, Document/EditorSession.swift:224)
- [x] Tools › Clone Stamp › Source crosshair: a white/black crosshair marks where it copies from, moving with the brush once aligned (Rendering/BrushCursorOverlay.swift:78, Document/CloneStamp.swift:31)
- [x] Tools › Clone Stamp › Hover preview: between strokes, the brush circle previews what a click would stamp, shaped by hardness and at the brush opacity; system cursor hidden while a source exists (Option brings the crosshair cursor back) (Rendering/EditorCanvas.swift:1516, Rendering/EditorCanvas.swift:1568, Rendering/BrushCursorOverlay.swift:39, Rendering/EditorCanvas.swift:1479)
- [x] Tools › Clone Stamp › Pixels only: does nothing on a selected mask (Document/EditorSession+Brush.swift:51)

### Blur / Smudge / Liquify (Smear)

- [x] Tools › Smear › Tool selection: R; rail label "Smear (R)"; header title "Smear" (Rendering/EditorCanvas.swift:2314, Document/EditorSession.swift:99, UI/BrushControls.swift:7)
- [x] Tools › Smear › Mode picker: segmented Liquify / Blur / Smudge, default Liquify; help "Liquify pushes pixels · Blur softens · Smudge drags color along" (UI/BrushControls.swift:17, Document/SmudgeLiquify.swift:10, Document/EditorSession.swift:207)
- [x] Tools › Smear › Tab cycles mode: Liquify → Blur → Smudge (Document/EditorSession.swift:437)
- [x] Tools › Smear › Size / Hardness: same fields as Brush; own tip defaults 40 px, 0 % hardness; Smudge/Liquify clamp hardness to 98 % and size to at least 2 px (UI/BrushControls.swift:41, Document/EditorSession.swift:224, Document/SmudgeLiquify.swift:54)
- [x] Tools › Smear › Strength: the opacity slider is labelled "Strength", 1...100 %, default 100 %; digits 1–0 set it (UI/BrushControls.swift:61, Document/SmudgeLiquify.swift:56)
- [x] Tools › Smear › Blur Radius: Blur mode only; label scrub 0.1/pt, slider 0.5...20 px, field 0.5...50 px (one decimal), default 5 px; help "How far the blur softens, in pixels" (UI/BrushControls.swift:73, Document/BrushStroke.swift:21)
- [x] Tools › Smear › Blur stroke: paints a Gaussian-softened copy of the layer (radius measured on the canvas) through the tip; each new stroke over an area softens further; softening spreads past the layer's edges (Document/BlurTool.swift:6, Document/BlurTool.swift:19, Document/BlurTool.swift:21)
- [x] Tools › Smear › Blur on masks: Blur works on a selected mask, keeping the mask's edge tone past its pixels (Document/BlurTool.swift:32, Document/EditorSession+Brush.swift:53)
- [x] Tools › Smear › Smudge stroke: picks up color at the press and drags it along, mixing at the strength; dab spacing 0.5 % of diameter (Document/SmudgeLiquify.swift:94, Document/SmudgeLiquify.swift:103, Document/SmudgeLiquify.swift:157)
- [x] Tools › Smear › Liquify stroke: forward warp, pixels under the tip move with it, most at the center fading to the rim; pixels stay sharp (offset field, not resampled per dab) (Document/SmudgeLiquify.swift:169, Rendering/MetalWarp.swift:19)
- [x] Tools › Smear › Smudge/Liquify pixels only: on a selected mask alerts "Smudge and Liquify work on a layer's pixels, not its mask." (Document/SmudgeLiquify.swift:216)
- [x] Tools › Smear › Smudge/Liquify commit: on release the warped result is painted into the layer along the stroke path as one undo step named "Liquify" or "Smudge"; 16-bit layers keep 16-bit precision (Document/SmudgeLiquify.swift:233, Document/SmudgeLiquify.swift:251, Document/SmudgeLiquify.swift:48)
- [x] Tools › Smear › No color swatch: Smear shows no foreground swatch and no Option eyedropper (UI/BrushControls.swift:105, Rendering/EditorCanvas.swift:93)

### Gradient

- [x] Tools › Gradient › Tool selection: G; rail label "Gradient (G)"; dithered custom rail icon (Rendering/EditorCanvas.swift:2295, Document/EditorSession.swift:99, UI/GradientControls.swift:70)
- [x] Tools › Gradient › Shape picker: segmented Linear / Radial, default Linear; radial is centered on the start with the end on its rim; help text (UI/GradientControls.swift:11, Document/Gradient.swift:9, Document/Gradient.swift:15)
- [x] Tools › Gradient › Tab cycles shape: Tab toggles Linear / Radial (Document/EditorSession.swift:440)
- [x] Tools › Gradient › Color preview swatch: 56x18 swatch of the current colors over a checkerboard (UI/GradientControls.swift:47)
- [x] Tools › Gradient › Colors picker: Foreground to Background / Foreground to Transparent, default Foreground to Transparent (UI/GradientControls.swift:17, Document/Gradient.swift:3, Document/Gradient.swift:16)
- [x] Tools › Gradient › Reverse toggle: default off; swaps the gradient's ends (UI/GradientControls.swift:21, Document/Gradient.swift:97)
- [x] Tools › Gradient › Opacity: label scrub, slider 1...100 %, field 1...100 %, default 100 %; digits 1–0 set it (UI/GradientControls.swift:22, Document/Gradient.swift:18, Document/EditorSession+Brush.swift:249)
- [x] Tools › Gradient › Draw line: drag on the canvas draws a pending gradient line over the whole canvas (or the selection) on the active layer or mask; a click without a line leaves nothing pending (Document/Gradient.swift:54, Document/Gradient.swift:101, Document/BrushStroke.swift:704)
- [x] Tools › Gradient › Adjust endpoints: drag either endpoint (10 pt hit radius) to move it; dragging elsewhere on the same target starts a new line replacing the pending one (Rendering/EditorCanvas.swift:2502, Document/Gradient.swift:57)
- [x] Tools › Gradient › Shift 45°: Shift constrains the line to 45° steps while dragging an endpoint (Rendering/EditorCanvas.swift:1950, Rendering/EditorCanvas.swift:2513)
- [x] Tools › Gradient › Live re-render: changing shape, colors, reverse, opacity, foreground/background or mask paint color re-renders the pending gradient (Document/Gradient.swift:79, Document/EditorSession.swift:205, Document/EditorSession.swift:228)
- [x] Tools › Gradient › Line overlay: line drawn with endpoint circles filled with each end's color (checkerboard for transparent); Radial adds a dashed rim circle (Rendering/TransformOverlay.swift:84, Rendering/TransformOverlay.swift:450)
- [x] Tools › Gradient › Apply / Cancel: header shows Cancel and Apply buttons while pending; Return applies, Esc cancels; undo name "Gradient" or "Gradient Mask" (UI/GradientControls.swift:37, Rendering/EditorCanvas.swift:2234, Document/Gradient.swift:111)
- [x] Tools › Gradient › Auto-apply: switching tools, layers or target applies the pending gradient (Document/Gradient.swift:122, Document/EditorSession.swift:391, Document/EditorSession.swift:398)
- [x] Tools › Gradient › Gradient on mask: on a selected mask paints black/white per the mask paint color, may grow the mask; header shows "Mask" (Document/Gradient.swift:88, Document/Gradient.swift:66, UI/GradientControls.swift:36)
- [x] Tools › Gradient › Destructive result: the applied gradient is rasterized into the layer's pixels (not a live gradient layer) (Document/Gradient.swift:116)
- [x] Tools › Gradient › Option eyedropper: Option samples a color into the foreground (Rendering/EditorCanvas.swift:93)

### Shape

- [x] Tools › Shape › Tool selection: U; rail label "Shape (U) · Shift-U switches Rectangle/Ellipse"; header title "Shape" (Rendering/EditorCanvas.swift:2296, Document/EditorSession.swift:99, UI/ShapeControls.swift:8)
- [x] Tools › Shape › Kind picker: segmented Rectangle / Ellipse / Line, default Rectangle; changing kind cancels a draft; help "Shift-U (or Tab) steps through Rectangle, Ellipse and Line" (UI/ShapeControls.swift:9, Document/ShapeTool.swift:3, Document/EditorSession.swift:236)
- [x] Tools › Shape › Shift-U / Tab cycles kind: Rectangle → Ellipse → Line (Rendering/EditorCanvas.swift:2297, Document/ShapeTool.swift:149, Document/EditorSession.swift:435)
- [x] Tools › Shape › Fill color swatch: shows the foreground color; click opens the foreground Color Picker; shapes fill (or stroke, for lines) with the foreground (UI/ShapeControls.swift:17)
- [x] Tools › Shape › Line Width: Line only; label scrub, slider 1...100 px, field 1...5000 px, default 4 px (UI/ShapeControls.swift:26, Document/EditorSession.swift:241)
- [x] Tools › Shape › Corner Radius: Rectangle only; label scrub, slider 0...200 px, field 0...5000 px, default 0 (square); capped at half the shorter side (pill) (UI/ShapeControls.swift:41, Document/EditorSession.swift:238, Document/ShapeTool.swift:12)
- [x] Tools › Shape › Smooth Corners: Rectangle checkbox, default off, disabled at radius 0; Figma-style squircle corners at 60 % smoothing (UI/ShapeControls.swift:56, Document/ShapeTool.swift:20, Document/EditorSession.swift:239)
- [x] Tools › Shape › Drag to draw: drag draws the shape live in the foreground color; release makes a new layer above the active one (inside its folder), named "Rectangle 1", "Ellipse 2", "Line 1"…; one undo step named after the kind; selection kept (Rendering/EditorCanvas.swift:1849, Rendering/EditorCanvas.swift:1246, Document/ShapeTool.swift:157, Document/ShapeTool.swift:194, Document/SelectionClipboard.swift:296)
- [x] Tools › Shape › Shift constrain: Shift makes a square or circle; on a Line snaps the angle to 45° steps (Rendering/EditorCanvas.swift:1944, Document/ShapeTool.swift:129)
- [x] Tools › Shape › Option from center: Option grows the shape from its center (Rendering/EditorCanvas.swift:1944, Document/ShapeTool.swift:125)
- [x] Tools › Shape › Snapping: the press and drag corners snap to View › Snap To targets unless Control is held (Rendering/EditorCanvas.swift:2413)
- [x] Tools › Shape › Line geometry: a line keeps its exact two endpoints with round caps; its layer is the endpoints' box padded by half the thickness (Document/ShapeTool.swift:165, Document/ShapeTool.swift:243)
- [x] Tools › Shape › Click or cancel: a click without a drag makes nothing; Esc cancels the draft (Document/ShapeTool.swift:171, Rendering/EditorCanvas.swift:2231)
- [x] Tools › Shape › Size limit: a shape over the surface megapixel limit alerts "That shape is too large..." (Document/ShapeTool.swift:172)
- [x] Tools › Shape › Live shape on resize: scaling a shape layer redraws the shape at the new size so corner radius and line width are kept; rounded rectangles preview at the dragged size during the transform (up to 2048 px) (Document/ShapeTool.swift:203, Document/ShapeTool.swift:221, Document/EditorSession.swift:512, Document/EditorSession.swift:523)
- [x] Tools › Shape › Becomes pixels once edited: painting or filtering a shape layer turns it into plain pixels; shape style is saved in the project while live (Document/ShapeTool.swift:74, Document/ShapeTool.swift:89, Document/EditorSession+Projects.swift:13)

### Type

- [x] Tools › Type › Tool selection: T; rail label "Type (T)"; I-beam cursor; header title "Type" (Rendering/EditorCanvas.swift:2294, Document/EditorSession.swift:99, Rendering/EditorCanvas.swift:1461, UI/TypeControls.swift:18)
- [x] Tools › Type › Font picker: pop-up of every installed font, each name drawn in its own face (symbol fonts in the menu font), sorted; 210 pt wide, long names truncated; help "Font face, including bold and italic variants" (UI/TypeControls.swift:21, UI/TypeControls.swift:105, UI/TypeControls.swift:211)
- [x] Tools › Type › Font live preview: hovering a face in the open menu previews it on the text being edited; closing without choosing reverts (UI/TypeControls.swift:236, UI/TypeControls.swift:225, Document/TypeTool.swift:365)
- [x] Tools › Type › Font per selection: the chosen face applies to the selected letters (or all text with just a caret); "(Multiple)" shows when the selection spans several faces (UI/TypeControls.swift:21, UI/TypeControls.swift:143, Document/TypeTool.swift:107)
- [x] Tools › Type › Size: field 1...2000 px, default 72 px, "px" unit is a scrub handle (1/pt, step 1), Up/Down steps (UI/TypeControls.swift:40, Document/TypeTool.swift:10)
- [x] Tools › Type › Text color swatch: shows the selected letters' color (or letter before the caret, or foreground when not editing); click opens the Color Picker (Text Color) (UI/TypeControls.swift:44, Document/ColorPalette.swift:72, Document/ColorPalette.swift:77)
- [x] Tools › Type › Alignment buttons: Left / Center / Right, default Left (UI/TypeControls.swift:52, Document/TypeTool.swift:14)
- [x] Tools › Type › Tracking: label scrub (1/pt, step 1), field, range -100...1000, default 0 (UI/TypeControls.swift:71, Document/TypeTool.swift:15, Document/TypeTool.swift:39)
- [x] Tools › Type › Leading: label scrub, field 0...5000 px, empty/0 = Auto (120 % of size) with "Auto" placeholder; baseline-to-baseline line height (UI/TypeControls.swift:75, Document/TypeTool.swift:16, Document/TypeTool.swift:18)
- [x] Tools › Type › Cancel / Done buttons: shown while editing; Done commits, Cancel discards (UI/TypeControls.swift:90)
- [x] Tools › Type › Edit Text button: shown when not editing; opens the active layer's live text for editing; disabled unless it is live text (UI/TypeControls.swift:94, Document/TypeTool.swift:264)
- [x] Tools › Type › Style changes on selected text layer: changing a header field while a live text layer is merely selected opens it for editing and applies; with no text, it sets defaults for the next text (Document/TypeTool.swift:383)
- [x] Tools › Type › Click for point text: click on empty canvas starts point text with the first baseline on the pointer; layer size follows what is typed (Rendering/InlineTextEditor.swift:539, Document/TypeTool.swift:235, Document/TypeTool.swift:256)
- [x] Tools › Type › Drag for paragraph box: drag draws an accent-colored box outline; release creates a fixed-size wrapping text box exactly there (min 16 px; drags under 4 px make point text) (Rendering/InlineTextEditor.swift:532, Rendering/InlineTextEditor.swift:548, Document/TypeTool.swift:332)
- [x] Tools › Type › Click existing text: clicking a visible live text layer selects it, opens it and places the caret where clicked (Rendering/InlineTextEditor.swift:516)
- [x] Tools › Type › Esc during box drag: cancels the box draft (Rendering/EditorCanvas.swift:2204)
- [x] Tools › Type › Header disabled: Type header disabled with no document or while busy (UI/TypeControls.swift:98)

### Eyedropper

- [x] Tools › Eyedropper › Header: title "Eyedropper" and "Sample Ring" checkbox, default on, not persisted (ContentView.swift:53-60, Document/EditorSession.swift:107)
- [x] Tools › Eyedropper › Click or drag samples the composited color of the visible layers at the document pixel into the foreground color; outside the canvas or over fully transparent pixels nothing is sampled (Rendering/EditorCanvas.swift:1794-1798, 1901, 2521-2528, Document/ColorPalette.swift:237-260)
- [x] Tools › Eyedropper › Sample ring: a 116-pt ring around the pointer while sampling, top half the new sample, bottom half the color before the drag; hidden on release; suppressed when Sample Ring is off (Rendering/EditorCanvas.swift:2529-2533, 2115-2119, Rendering/SampleRingOverlay.swift:3-28)
- [x] Tools › Eyedropper › With the color picker open, sampling writes into the picker instead of the palette (Rendering/EditorCanvas.swift:2525)
- [x] Tools › Eyedropper › Eyedropper cursor over the canvas (Rendering/EditorCanvas.swift:428, 2523)

### Hand

- [x] Tools › Hand › Header: title "Pan", no controls (UI/NavigationToolHeader.swift:12)
- [x] Tools › Hand › Drag pans the view; open hand cursor, closed hand held for the whole drag (Rendering/EditorCanvas.swift:1812-1819, 2033-2036, 1458, 2174)

### Zoom

- [x] Tools › Zoom › Header: title "Zoom" plus a zoom-percentage field, 0.1...3200 %, shown with up to 2 decimals; Return or Escape applies and returns focus to the canvas; losing focus applies; disabled with no document or while busy (UI/NavigationToolHeader.swift:12-31, 46-65)
- [x] Tools › Zoom › Zoom field stepping: Up/Down +/-1 %, Shift +/-10 %; dragging the "%" suffix scrubs the zoom (sensitivity 1, range 0.1...3200) (UI/NavigationToolHeader.swift:22-30, 41-45)
- [x] Tools › Zoom › Click zooms in 2x about the click point; Option-click zooms out 0.5x (Rendering/EditorCanvas.swift:2100-2104)
- [x] Tools › Zoom › Scrubby zoom: drag right to zoom in, left to zoom out, continuously, doubling per 100 points dragged, anchored at the press point; 3-pt dead zone before it counts as a drag (Rendering/EditorCanvas.swift:1858-1860, 1885-1899)
- [x] Tools › Zoom › Cursor: magnifier with + (zoom in) or - (Option held, or dragging left) (Rendering/EditorCanvas.swift:1455-1463, 484-508, 1889-1892)

### No tool (A)

- [x] Tools › No tool › Pressing A deselects every tool: nothing highlighted in the rail, arrow cursor, canvas clicks do nothing; Space still pans (Document/EditorSession.swift:92-93, Rendering/EditorCanvas.swift:2313, 1462)
- [x] Tools › No tool › Header keeps its height with the title "Select a tool" so the canvas does not jump (ContentView.swift:69-76)

## Selections

### Select menu

- [x] Selections › Select menu › All (⌘A): selects the whole canvas, undo "Select All"; never disabled because it carries ⌘A for text fields, which get their own Select All first (CompositorApp.swift:259-267, Document/Selection.swift:344-347)
- [x] Selections › Select menu › Deselect (⌘D): removes the selection, undo "Deselect"; disabled without a selection (CompositorApp.swift:268-269, Document/Selection.swift:349-352)
- [x] Selections › Select menu › Inverse (⇧⌘I): canvas minus the selection, keeping its feather and anti-alias; the inverse of everything becomes no selection rather than an empty one; disabled without a selection (CompositorApp.swift:270-272, Document/Selection.swift:354-362)
- [x] Selections › Select menu › Layer's Pixels: the active layer's pixels at least 50% opaque, ignoring its mask, undo "Load Layer Selection"; disabled when the layer has no pixels (CompositorApp.swift:273-276, Document/MaskTracing.swift:11-12, Document/MaskTracing.swift:85-94)
- [x] Selections › Select menu › Subject (⌥⌘A): finds the foreground subject(s) in the visible composite, traces mask pixels >= 50% white as the selection (replace), undo "Select Subject"; runs off the main thread (CompositorApp.swift:277-279, Document/SubjectRemoval.swift:114-142, Document/SubjectRemoval.swift:27-38)
- [x] Selections › Select menu › Subject error: "No foreground subject was detected in this layer. Try an image with a more distinct subject." (Document/SubjectRemoval.swift:6-9)
- [x] Selections › Select menu › Color Range…: opens the Color Range panel; disabled when already open or layers can't be edited (CompositorApp.swift:280-281, Document/ColorRangeSelection.swift:44-49)
- [x] Selections › Select menu › Mask's Black Areas: the active layer mask's pixels darker than 50% gray become the selection, undo "Load Mask Selection"; disabled without a mask (CompositorApp.swift:282-285, Document/MaskTracing.swift:5-6, Document/MaskTracing.swift:73-83)
- [x] Selections › Select menu › Expand… / Contract… / Feather…: open the amount panel; disabled without a non-empty selection or while an outline is being drawn (CompositorApp.swift:287-292, Document/Selection.swift:292-303)

### Expand / Contract / Feather panel

- [x] Selections › Amount panel › Floating panel titled "Expand Selection" / "Contract Selection" / "Feather Selection" (ContentView.swift:263-269)
- [x] Selections › Amount panel › Amount slider: step 1; 1...500 px for Expand/Contract, 1...250 px for Feather; starts at the last amount used (UI/LassoControls.swift:193-205, UI/LassoControls.swift:219-221)
- [x] Selections › Amount panel › Amount text field (px suffix) and scrubbable "Amount" label; field focused on open (UI/LassoControls.swift:215-226, UI/LassoControls.swift:243)
- [x] Selections › Amount panel › Validation hint "Enter a whole number from 1 to N px." shown when the input is invalid (UI/LassoControls.swift:227-229)
- [x] Selections › Amount panel › Cancel (Esc) closes; OK (Return) applies and remembers the amount for the header field; OK disabled while invalid (UI/LassoControls.swift:231-239, Document/Selection.swift:305-314)
- [x] Selections › Amount panel › Expand algorithm: outline grows by N px with round joins/caps, clipped to the canvas; undo "Expand Selection" (Document/Selection.swift:316-317, Document/Selection.swift:333-342)
- [x] Selections › Amount panel › Contract algorithm: shrinks by N px including away from canvas edges; contracting past the middle leaves an explicit empty selection; undo "Contract Selection" (Document/Selection.swift:319-321, Document/Selection.swift:333-342)
- [x] Selections › Amount panel › Feather algorithm: soft edge of N px; applying again combines as sqrt(old² + new²), capped at 250 px; coverage = Gaussian blur sigma feather/2 either side of the outline; undo "Feather Selection" (Document/Selection.swift:323-331, Document/Selection.swift:15-29)

### Color Range panel

- [x] Selections › Color Range › Floating panel "Color Range" (340 pt wide); closing it cancels (ContentView.swift:235-241, UI/ColorRangeSheet.swift:47)
- [x] Selections › Color Range › Three eyedropper buttons: Sample (replace), Add (+ badge), Remove (− badge), default Sample; holding Shift/Option highlights the one a click will use (UI/ColorRangeSheet.swift:10-19, UI/ColorRangeSheet.swift:81-90, Document/HueSaturation.swift:135-145, Document/ColorRangeSelection.swift:13-17)
- [x] Selections › Color Range › Canvas click samples the 3x3-averaged straight color under the pointer from the visible composite; Sample replaces the color list, Add appends, Remove adds an excluded color (Document/ColorRangeSelection.swift:46-61, Document/ColorRangeSelection.swift:97-112, Rendering/EditorCanvas.swift:1787-1792)
- [x] Selections › Color Range › Shift-click adds a color and Option-click removes one, whichever eyedropper is chosen (Document/ColorRangeSelection.swift:51-55, UI/ColorRangeSheet.swift:23-25)
- [x] Selections › Color Range › Canvas cursor is an eyedropper with +/− badge following the effective mode (Rendering/EditorCanvas.swift:474-481, Rendering/EditorCanvas.swift:735-744)
- [x] Selections › Color Range › Black-and-white preview of the selection, canvas-shaped, fitting 292 x 200 pt, black until a color is picked (UI/ColorRangeSheet.swift:50-62, Document/ColorRangeSelection.swift:9-10)
- [x] Selections › Color Range › Hint text: "Click the image to pick the color to select." then "Shift-click adds a color, Option-click takes one away." (UI/ColorRangeSheet.swift:23-25)
- [x] Selections › Color Range › Fuzziness: 0...200, integer, default 40; slider, field and scrubbable label (UI/ColorRangeSheet.swift:26-33, UI/ColorRangeSheet.swift:64-71, Document/ColorRangeSelection.swift:8, Document/ColorRangeSelection.swift:11)
- [x] Selections › Color Range › Invert toggle, default off: selects everything except the picked colors (UI/ColorRangeSheet.swift:34-35, Document/ColorRangeSelection.swift:12)
- [x] Selections › Color Range › Match rule: each RGB channel within Fuzziness of any included color and of no excluded color; transparent pixels never match (Rendering/WandPixels.h:13-19)
- [x] Selections › Color Range › Live result: the canvas selection updates off the main thread on every change, with no undo step until OK; newer changes supersede older (Document/ColorRangeSelection.swift:63-80)
- [x] Selections › Color Range › Error text shown in orange in the panel (UI/ColorRangeSheet.swift:36-38)
- [x] Selections › Color Range › OK (Return): keeps the result as one undo step "Color Range" (nothing matched deselects); Cancel (Esc) restores the selection there was (UI/ColorRangeSheet.swift:39-45, Document/ColorRangeSelection.swift:82-95)
- [x] Selections › Color Range › Result uses the selection tools' Anti-alias setting (Document/ColorRangeSelection.swift:78)

### Load selection from Layers panel thumbnails

- [x] Selections › Thumbnails › Cmd-click a layer thumbnail: its >= 50% opaque pixels (mask ignored) become the selection; Cmd-Shift-click adds, Cmd-Option-click subtracts (Document/MaskTracing.swift:85-94, UI/NativeLayerList.swift:899, UI/NativeLayerList.swift:1141-1149, UI/NativeLayerList.swift:1369-1372)
- [x] Selections › Thumbnails › Cursor: pointing hand with a dashed box while Cmd is held over a thumbnail (UI/NativeLayerList.swift:1357, Rendering/EditorCanvas.swift:243-244)

### Display

- [x] Selections › Display › Marching ants: 1 px white line under a black 4-on/4-off dash, phase advancing every 0.12 s; animates only while a non-empty selection exists (Rendering/TransformOverlay.swift:296-311, Rendering/EditorCanvas.swift:2470-2486)
- [x] Selections › Display › Very detailed outlines (over 20,000 path elements) are retraced at a coarser step while zoomed out, in the background (Rendering/TransformOverlay.swift:108, Rendering/TransformOverlay.swift:118-143)
- [x] Selections › Display › Outline follows selected pixels being moved or transformed, live (Document/SelectionEdits.swift:188-197)

### Selection semantics

- [x] Selections › Semantics › Selection is part of the document: covered by undo/redo, not saved to disk (Document/EditorSession.swift:70-71)
- [x] Selections › Semantics › Explicit empty selection means "touch nothing" (never "everything"); painting into it shows "Nothing is selected, so there's nowhere to paint. Choose Select › Deselect (⌘D) to paint anywhere." (Document/Selection.swift:4-6, Document/EditorSession+Brush.swift:29-31)
- [x] Selections › Semantics › Painting, fills and clears are clipped to the selection with its soft edges (Document/EditorSession+Brush.swift:34-43, Document/BrushStroke.swift:149-150, Document/BrushStroke.swift:741-767)
- [x] Selections › Semantics › Filters and adjustments run only inside the selection; filter panels say "Limited to the selection" (Document/Filters.swift:5, UI/FilterSheet.swift:170-172)
- [x] Selections › Semantics › Each selection stores anti-alias (default on) and feather (px, 0 = hard); coverage is antialiased when either is set (Document/Selection.swift:7-29)

### Moving and duplicating selected pixels

- [x] Selections › Pixel move › Commit on release: pixels and moved outline commit together as one undo step "Move Pixels" or "Duplicate Pixels"; offsets are whole pixels (Document/SelectionEdits.swift:180-212, Rendering/EditorCanvas.swift:2140-2143)
- [x] Selections › Pixel move › Cmd-arrow (any tool): moves the selected pixels 1 px, Shift 10 px, one undo step each; beeps when there is nothing to move (Rendering/EditorCanvas.swift:2255-2261, Document/SelectionEdits.swift:220-225)
- [x] Selections › Pixel move › Only image pixels of the active layer move (not a mask target); the vacated area becomes transparent (Document/SelectionEdits.swift:166-178, Document/BrushStroke.swift:824-854)

### Transform Selection (floating pixels)

- [x] Selections › Transform Selection › ⌘T with a non-empty selection on a pixel layer (not a mask) lifts the selected pixels onto a temporary "Floating Selection" layer above the source (same folder, opacity, blend mode), switches to the Move tool with transform handles; menu reads "Transform Selection" instead of "Transform Layer" (CompositorApp.swift:351-352, Document/FloatingSelection.swift:14-60)
- [x] Selections › Transform Selection › Return merges the transformed (or distorted) pixels back into the source layer, growing it where they now extend past it; an unlinked-placement mask grows revealing the new area; the selection outline follows; 16-bit/HDR kept (Document/FloatingSelection.swift:70-115, Document/FloatingSelection.swift:124-173)
- [x] Selections › Transform Selection › Committing with no change restores the document exactly (no seam on soft edges) (Document/EditorSession.swift:493-496)
- [x] Selections › Transform Selection › Esc restores the document exactly; the whole operation is one undo step "Transform Selection" (Document/FloatingSelection.swift:3-5, Document/FloatingSelection.swift:117-121, Document/EditorSession.swift:538)

## Layers panel and layer operations

### Panel layout

- [x] Layers panel and layer operations › Panel layout › Docked panel on the right of the canvas: width 222...352 pt, default 252 pt, persisted across launches (`layersPanelWidth`), a saved width outside the range is clamped; hidden in Toggle Fullscreen (canvas-only) mode (UI/LayersPanel.swift:6, UI/LayersPanel.swift:9, ContentView.swift:6, ContentView.swift:123-126)
- [x] Layers panel and layer operations › Panel layout › Resize edge: dragging the panel's left divider (8 pt hit strip, column-resize cursor, tooltip "Drag to resize the panel") widens to the left / narrows to the right, rounded to whole points, clamped to the width range (ContentView.swift:375-394)
- [x] Layers panel and layer operations › Panel layout › Header: title "Layers" plus the total layer count (folders and adjustment layers included) at the right (UI/LayersPanel.swift:13-18)
- [x] Layers panel and layer operations › Panel layout › Empty state: layers icon, "No layers yet", and "Create a canvas or import an image." with no document or "Import an image or add a blank layer." with an empty document (UI/LayersPanel.swift:22-33)
- [x] Layers panel and layer operations › Panel layout › Whole panel grays out (layersLookEditable) while a dialog, persistent transform, crop, pending gradient, filter/Levels/Hue-Saturation/adjustment edit, text draft, rename, import or long (>250 ms) operation is open; not during a brush stroke or drag (Document/EditorSession.swift:692-697)
- [x] Layers panel and layer operations › Panel layout › Blend mode pop-up ("Blend" row, applies to the active layer): disabled for folders and when more than one layer is selected; capsule-shaped, shrinks to the panel width (min 60 pt) (UI/LayerAppearanceControls.swift:11-14, UI/BlendModePicker.swift:20-29, Document/LayerAppearance.swift:85)
- [x] Layers panel and layer operations › Panel layout › Blend mode list, 24 modes in 6 groups separated by lines: Normal | Darken, Multiply, Color Burn, Linear Burn | Lighten, Screen, Color Dodge, Linear Dodge (Add) | Overlay, Soft Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix | Difference, Exclusion, Subtract, Divide | Hue, Saturation, Color, Luminosity; default Normal (Photoshop's Darker Color and Lighter Color are deliberately absent) (Document/LayerAppearance.swift:4-24, Document/LayerAppearance.swift:71-72, UI/BlendModePicker.swift:11-14)
- [x] Layers panel and layer operations › Panel layout › Blend mode live preview: hovering/highlighting a mode in the open menu previews it on the canvas; closing without choosing restores the original; choosing commits one undo step "Layer Blend Mode" (UI/BlendModePicker.swift:46-76, Document/LayerAppearance.swift:76-84, Document/LayerAppearance.swift:130-137)
- [x] Layers panel and layer operations › Panel layout › Blend mode cycling: Shift-+ / Shift-− (Shift-= / Shift-minus) steps the active layer's blend mode forward/back through the menu order, wrapping around, in every tool, one undo step each (Rendering/EditorCanvas.swift:784-787, Document/LayerAppearance.swift:124-129)
- [x] Layers panel and layer operations › Panel layout › Opacity slider: 0...1 (0-100%), default 100%; one drag = one undo step "Layer Opacity"; enabled for single selection including folders (folder opacity dims its contents) (UI/LayerAppearanceControls.swift:22-24, Document/LayerAppearance.swift:88-107)
- [x] Layers panel and layer operations › Panel layout › Opacity percent field: 44 pt text field + "%", integer 0...100, applies on Return/Esc/focus loss (then hands focus back to the canvas), Up/Down step 1%, Shift-Up/Down 10%, values clamped (UI/LayerAppearanceControls.swift:25-35, UI/LayerAppearanceControls.swift:43-58)
- [x] Layers panel and layer operations › Panel layout › Opacity label scrub: dragging the "Opacity" label left/right scrubs the value (1% per point, 0...100, resize-left-right cursor), one undo step per drag (UI/LayerAppearanceControls.swift:16-21, UI/NumericScrub.swift:16-42)
- [x] Layers panel and layer operations › Panel layout › Footer button New blank layer (plus.square icon), tooltip "New blank layer (⇧⌘N)" (UI/LayersPanel.swift:37-39)
- [x] Layers panel and layer operations › Panel layout › Footer button New folder (folder.badge.plus), tooltip "Group selected layers (⌘G)"; with nothing selected it makes an empty "Folder N" at the top (UI/LayersPanel.swift:40-41, Document/LayerGroups.swift:180-225)
- [x] Layers panel and layer operations › Panel layout › Footer button Add layer mask (see Masks and clipping › Adding masks) (UI/LayersPanel.swift:42, UI/LayerMaskMenu.swift:6-18)
- [x] Layers panel and layer operations › Panel layout › Footer menu New adjustment layer (circle.lefthalf.filled): Hue/Saturation, Levels, Curves, Exposure, Gradient Map, Grain, Add Noise, Gaussian Blur, Motion Blur, Invert, Black & White, Color Balance; inserts above the active layer (inside its folder, or into the active folder) and opens its editor unless Invert; the same list is Layer › New Adjustment Layer (kinds' settings: see Adjustment layers) (UI/LayersPanel.swift:43-48, Document/LayerAdjustment.swift:4-9, Document/LayerAdjustment.swift:208-229, CompositorApp.swift:342-346)
- [x] Layers panel and layer operations › Panel layout › Footer menu Add layer effect (sparkles): Stroke…, Drop Shadow…, Color Overlay…, Inner Shadow…, Outer Glow…, Inner Glow…; disabled for folders and for layers without pixels (blank, adjustment) (UI/LayersPanel.swift:49-56)
- [x] Layers panel and layer operations › Panel layout › Footer trash button: deletes the selected effect, else the targeted mask, else the selected layer(s); tooltip/label switches between "Delete selected effect", "Delete layer mask", "Delete selected layers", "Delete selected layer" (UI/LayersPanel.swift:58-62, Document/SelectionEdits.swift:84-88)
- [x] Layers panel and layer operations › Panel layout › Footer icons dim to quarter-strength white when disabled; enlarged 8x12 pt hit areas (UI/LayersPanel.swift:79-100)

### Rows

- [x] Layers panel and layer operations › Rows › Native list, top layer first, row height 52 pt plus 24 pt per effect sub-row, 2 pt row spacing, faint 1-device-pixel hairline between rows (UI/NativeLayerList.swift:15-16, UI/NativeLayerList.swift:363-365, UI/NativeLayerList.swift:1410-1417)
- [x] Layers panel and layer operations › Rows › Click selects on mouse-down (no double-click delay); Shift-click extends a range and Cmd-click toggles rows (native multi-selection); the clicked row becomes the primary/active layer (UI/NativeLayerList.swift:17-18, UI/NativeLayerList.swift:373-379, UI/NativeLayerList.swift:773-780)
- [x] Layers panel and layer operations › Rows › A newly selected layer (e.g. picked on the canvas) is scrolled into view and its collapsed ancestor folders are expanded (UI/NativeLayerList.swift:95-97, Document/LayerGroups.swift:156-165)
- [x] Layers panel and layer operations › Rows › Visibility eye button (eye / eye.slash) toggles the layer, one undo step "Show Layer"/"Hide Layer" (UI/NativeLayerList.swift:1058-1062, Document/EditorSession.swift:762-767)
- [x] Layers panel and layer operations › Rows › Eye swipe: press an eye and drag up/down the list to give every eye passed the same state, with autoscroll, all one undo step (UI/NativeLayerList.swift:1420-1441, Document/EditorSession.swift:771-783)
- [x] Layers panel and layer operations › Rows › Rows of layers hidden through a hidden parent folder draw at 35% opacity (UI/NativeLayerList.swift:1063, Document/LayerGroups.swift:9-26)
- [x] Layers panel and layer operations › Rows › Folder disclosure chevron (chevron.down / chevron.right) collapses/expands the folder; collapsing a folder that holds the active layer selects the folder (UI/NativeLayerList.swift:996-998, UI/NativeLayerList.swift:1159, Document/LayerGroups.swift:283-290)
- [x] Layers panel and layer operations › Rows › Indentation: 24 pt per folder depth (visual cap 8 levels) plus 24 pt more for a clipped layer; effect sub-rows indent the same (UI/NativeLayerList.swift:984-995)
- [x] Layers panel and layer operations › Rows › Layer thumbnail (36 pt box): pixel layers show the whole canvas shape on a gray checkerboard (6 pt tiles, gray 0.22/0.32) with the layer's pixels where they sit; folders show a folder icon; adjustment layers their kind's symbol (Curves rotated 90°); editable text a "textformat" icon (UI/NativeLayerList.swift:999-1014, UI/NativeLayerList.swift:1162-1196, UI/CanvasThumbnail.swift:10-33)
- [x] Layers panel and layer operations › Rows › Layer thumbnail click targets the layer's pixels (accent 2 pt border); tooltip "Select image pixels" or "Editable text layer" (UI/NativeLayerList.swift:895, UI/NativeLayerList.swift:1038, UI/NativeLayerList.swift:1079-1084, UI/NativeLayerList.swift:1131)
- [x] Layers panel and layer operations › Rows › Cmd-click layer thumbnail loads the layer's visible (>=50% opaque) pixels as the selection, ignoring its mask; Cmd-Shift adds, Cmd-Option subtracts; Cmd over the thumbnail shows the load-selection cursor (UI/NativeLayerList.swift:899, UI/NativeLayerList.swift:1141-1149, UI/NativeLayerList.swift:1349-1358, UI/NativeLayerList.swift:1369-1373, Document/MaskTracing.swift:87-94)
- [x] Layers panel and layer operations › Rows › Double-click on a row's thumbnail opens what it holds: editable text goes into text editing, an editable adjustment opens its settings panel; double-click on the name renames (UI/NativeLayerList.swift:392-405, Document/TypeTool.swift:264)
- [x] Layers panel and layer operations › Rows › Clicking the row's name while its mask is targeted switches the target back to the layer pixels (so a transform moves layer and mask together) (UI/NativeLayerList.swift:380-391)
- [x] Layers panel and layer operations › Rows › Name label: single line, truncating; clipped layers prefixed "↳ " (UI/NativeLayerList.swift:911-915, UI/NativeLayerList.swift:1046)
- [x] Layers panel and layer operations › Rows › Subtitle line: "W × H px" (plus " · NN%" when the layer is scaled away from 100%, measured across the width), "Text · Double-click to edit", "Adjustment · Double-click to edit", "Folder", or "Clipped to <base name>" with tooltip "Clipping mask based on <name>. Option-click the bottom of its row to release." (UI/NativeLayerList.swift:1047, UI/NativeLayerList.swift:1053-1057, UI/NativeLayerList.swift:1474-1481)
- [x] Layers panel and layer operations › Rows › Depth tag pill "16-Bit" or "HDR" after the size, tooltips "16-bit layer: keeps 16 bits a channel" / "HDR layer: keeps light brighter than white, shown as white"; not on text, adjustment, folder or clipped rows (UI/NativeLayerList.swift:1048-1052, UI/NativeLayerList.swift:1443-1457, UI/NativeLayerList.swift:1485-1488)
- [x] Layers panel and layer operations › Rows › Inline rename: name becomes an editable field with all text selected; Return or clicking away keeps it, Esc restores the old name; name trimmed, blank names ignored; one undo step "Rename Layer"; focus returns to the list (UI/NativeLayerList.swift:1089-1130, Document/EditorSession.swift:754-760)
- [x] Layers panel and layer operations › Rows › Middle-mouse drag anywhere in the list scrolls it (closed-hand cursor) without selecting or dragging rows (UI/NativeLayerList.swift:522-548, UI/NativeLayerList.swift:739-741)
- [x] Layers panel and layer operations › Rows › Cmd-A with the list focused selects the whole canvas (Select › All), never every layer (UI/NativeLayerList.swift:550-555)
- [ ] Layers panel and layer operations › Rows › List keeps canvas keys working while focused: Esc cancels / Return applies a pending transform, Tab cycles tool mode, X swaps and D resets colors, tool letters (A V H Z B E G L M W J S U R I C T) pick tools, digits set opacity, Delete runs the Delete key action (UI/NativeLayerList.swift:782-817) — the board differs on purpose, see Where the board differs on purpose
- [x] Layers panel and layer operations › Rows › Arrow keys in the list nudge the selected layer 1 px (Shift 10 px) instead of moving the row selection when the Move tool or a transform is active (UI/NativeLayerList.swift:809-813)
- [x] Layers panel and layer operations › Rows › Option held over a row shows the duplicate cursor (Option-drag copies), over the bottom 10 pt strip the create/release-clipping cursor, over a mask thumbnail the show-mask (eye) cursor (UI/NativeLayerList.swift:594-638, UI/NativeLayerList.swift:660-705)

### Drag and drop

- [x] Layers panel and layer operations › Drag and drop › Drag rows to reorder: drop between rows places the layer(s) above the row under the drop line, in that row's folder; several dragged rows keep their order; one undo step "Move Layer"/"Move Layers"; moved layers stay selected (UI/NativeLayerList.swift:412-439, UI/NativeLayerList.swift:470-497)
- [x] Layers panel and layer operations › Drag and drop › Drop onto a folder row nests the layer(s) inside it, landing on top of its contents; the folder expands (UI/NativeLayerList.swift:434-437, UI/NativeLayerList.swift:474-484, Document/LayerGroups.swift:298-318)
- [x] Layers panel and layer operations › Drag and drop › Dragging a folder carries its whole subtree; a folder cannot be dropped into itself or its descendants (UI/NativeLayerList.swift:503-510, Document/LayerGroups.swift:291-296)
- [x] Layers panel and layer operations › Drag and drop › Option-drag duplicates instead of moving (copy-only operation), complete folder trees included; one undo step "Duplicate Layer(s)" (UI/NativeLayerList.swift:432-438, UI/NativeLayerList.swift:485-490, Document/SelectionClipboard.swift:283-292)
- [x] Layers panel and layer operations › Drag and drop › A layer dropped into the middle of a clipping stack is clipped to that base too; a layer moved out of its contiguous stack is released (UI/NativeLayerList.swift:470-497, Document/LiveLayerMask.swift:42-51, Document/LiveLayerMask.swift:232-244)
- [x] Layers panel and layer operations › Drag and drop › Option-drag an effect sub-row onto another layer row copies that effect, replacing the same kind there (not onto folders or pixel-less layers); one undo step "Copy <Effect>" (UI/NativeLayerList.swift:414-420, UI/NativeLayerList.swift:442-447, UI/NativeLayerList.swift:1254-1283, Document/LayerEffects.swift:336-362)
- [x] Layers panel and layer operations › Drag and drop › Option-drag a mask thumbnail onto another row copies the mask (see Masks and clipping) (UI/NativeLayerList.swift:421-427, UI/NativeLayerList.swift:448-452)

### Context menu

- [x] Layers panel and layer operations › Context menu › Right-click a row: selects it first if it was not selected (on a mask thumbnail it targets the mask, on an effect sub-row it selects the effect), then shows the menu (UI/NativeLayerList.swift:557-593, UI/NativeLayerList.swift:119-123)
- [x] Layers panel and layer operations › Context menu › Duplicate Layer: duplicates every selected layer (UI/NativeLayerList.swift:127-130, UI/NativeLayerList.swift:288-290)
- [x] Layers panel and layer operations › Context menu › Rename…: inline rename; enabled for a single selection only (UI/NativeLayerList.swift:133-136, UI/NativeLayerList.swift:254-255, UI/NativeLayerList.swift:292-295)
- [x] Layers panel and layer operations › Context menu › Delete Layer / Delete Selected Layers / Delete Mask (title follows the target) (UI/NativeLayerList.swift:139-150, UI/NativeLayerList.swift:297-299)
- [x] Layers panel and layer operations › Context menu › Create Clipping Mask / Release Clipping Mask (UI/NativeLayerList.swift:155-159, UI/NativeLayerList.swift:301-303)
- [x] Layers panel and layer operations › Context menu › Group Selected Layers (enabled with a selection and fewer than 10,000 layers) (UI/NativeLayerList.swift:162-165, UI/NativeLayerList.swift:260-261)
- [x] Layers panel and layer operations › Context menu › Ungroup Layers: only shown when the right-clicked row is a folder (UI/NativeLayerList.swift:168-173)
- [x] Layers panel and layer operations › Context menu › Move Out of Folder (enabled when the layer has a parent folder) (UI/NativeLayerList.swift:176-179, UI/NativeLayerList.swift:264-265)
- [x] Layers panel and layer operations › Context menu › Merge Down / Merge Layers / Merge Group (title from the merge plan) (UI/NativeLayerList.swift:182-185)
- [x] Layers panel and layer operations › Context menu › Convert to 16-Bit / Convert to 8-Bit; an HDR layer shows both Convert to 16-Bit and Convert to 8-Bit (UI/NativeLayerList.swift:188-199)
- [x] Layers panel and layer operations › Context menu › Add Mask › Reveal All (White) / Hide All (Black); with a selection active these become reveal/hide-selection masks; enabled when the single target has no mask (UI/NativeLayerList.swift:204-216, UI/NativeLayerList.swift:329-339)
- [x] Layers panel and layer operations › Context menu › Enable Mask / Disable Mask (UI/NativeLayerList.swift:219-223, UI/NativeLayerList.swift:341-345)
- [x] Layers panel and layer operations › Context menu › Delete Mask (UI/NativeLayerList.swift:226-229, UI/NativeLayerList.swift:347-351)
- [x] Layers panel and layer operations › Context menu › Link Mask / Unlink Mask (not for folders or adjustment layers) (UI/NativeLayerList.swift:232-236, UI/NativeLayerList.swift:276-277)
- [x] Layers panel and layer operations › Context menu › Hide Layer / Show Layer (UI/NativeLayerList.swift:241-245)

### Layer menu commands

- [x] Layers panel and layer operations › Layer menu commands › New Blank Layer ⇧⌘N: "Layer N" (first unused N), canvas-sized, pixels allocated on first paint, inserted above the active layer in its folder, or at the top of the active folder; undo "New Blank Layer" (CompositorApp.swift:368-369, Document/EditorSession.swift:703-731)
- [x] Layers panel and layer operations › Layer menu commands › Duplicate Layer ⌘J (no selection): copies every selected layer (folders with all contents), top copy named "<name> copy"; one copy sits just above its original, several stack above the topmost original in order; copies become the selection; keeps collapsed state; refuses past 10,000 layers (CompositorApp.swift:353-354, Document/SelectionClipboard.swift:225-278)
- [x] Layers panel and layer operations › Layer menu commands › Layer via Copy ⌘J (with a selection): the selected pixels (or mask values when the mask is targeted) become a new "Layer N" in place; not on folders (CompositorApp.swift:353-354, Document/SelectionClipboard.swift:206-215)
- [x] Layers panel and layer operations › Layer menu commands › Edit Adjustment…: opens the active adjustment layer's settings panel; enabled only on an adjustment layer; the panel samples only the layers beneath it; OK keeps, Cancel/closing restores (CompositorApp.swift:347-349, UI/LayersPanel.swift:69-71, Document/AdjustmentEditing.swift:6-65, Document/AdjustmentEditing.swift:108-130)
- [x] Layers panel and layer operations › Layer menu commands › Create/Release Clipping Mask ⌥⌘G (title toggles) (CompositorApp.swift:356-360)
- [x] Layers panel and layer operations › Layer menu commands › Group Selected Layers ⌘G: wraps the selection in a new "Folder N" placed at the topmost selected branch inside their common parent; a selected folder brings its subtree; the new folder becomes active; undo "Group Layers" (CompositorApp.swift:362-363, Document/LayerGroups.swift:180-225)
- [x] Layers panel and layer operations › Layer menu commands › Ungroup Layers ⇧⌘G: the folder's direct children take its place in order and become selected; the folder's own opacity, blend mode, mask and effects are discarded; detached clipping released; enabled only on a folder (CompositorApp.swift:364-365, Document/LayerGroups.swift:228-252)
- [x] Layers panel and layer operations › Layer menu commands › Move Out of Folder: places the layer just above its folder in the folder's parent (CompositorApp.swift:366-367, Document/LayerGroups.swift:319-323)
- [x] Layers panel and layer operations › Layer menu commands › Rename Layer…: starts inline rename in the row (CompositorApp.swift:370-371, UI/NativeLayerList.swift:105-111)
- [x] Layers panel and layer operations › Layer menu commands › Show Layer / Hide Layer (title toggles) (CompositorApp.swift:372-374)
- [x] Layers panel and layer operations › Layer menu commands › Move Layer Up ⌘] / Move Layer Down ⌘[: swaps with the adjacent sibling inside the same folder only; disabled at the ends; undo "Reorder Layers" (CompositorApp.swift:376-379, Document/EditorSession.swift:795-810)
- [x] Layers panel and layer operations › Layer menu commands › Merge Down ⌘E (one layer): merges with the next lower sibling in the same folder (not when that is a folder); result takes the lower layer's name (CompositorApp.swift:381-382, Document/LayerMerge.swift:24-30)
- [x] Layers panel and layer operations › Layer menu commands › Merge Layers ⌘E (several selected): merges them plus everything their selected folders hold; result named after and placed at the topmost selected layer (Document/LayerMerge.swift:10-17)
- [x] Layers panel and layer operations › Layer menu commands › Merge Group ⌘E (a folder active): merges the folder's contents into one layer named after the folder, which replaces it (Document/LayerMerge.swift:18-23)
- [x] Layers panel and layer operations › Layer menu commands › Merge result: composited as shown (blend modes, opacity, masks, clipping, adjustments baked), trimmed to its content, 16-bit if any merged layer is 16-bit, HDR kept if any is HDR; layers clipped to a merged layer re-clip to the result; one undo step (Document/LayerMerge.swift:34-104)
- [x] Layers panel and layer operations › Layer menu commands › Delete Layer / Delete Layers / Delete Layer Mask / Delete <Effect> (title follows the target): deletes the selected effect, else the targeted mask, else all selected layers (folders with contents) as one undo step; selection moves to the layer at the same position (CompositorApp.swift:390-393, Document/SelectionEdits.swift:84-88, Document/EditorSession.swift:733-752, Document/LiveLayerMask.swift:131-154)
- [ ] Layers panel and layer operations › Layer menu commands › Delete key (no pixel selection): removes the selected effect, the targeted mask or the selected layers; with a pixel selection it clears pixels instead (Document/SelectionEdits.swift:76-80) — the board differs on purpose, see Where the board differs on purpose
- [x] Layers panel and layer operations › Layer menu commands › Deleting a layer that is the base of clipped layers which stay asks "This layer supplies a live mask" / "These layers supply live masks" with Bake and Delete (bakes the clipped look into the dependents' pixels, in the background), Cancel, Remove Links and Delete (unclips them); undoable (Document/LiveLayerMask.swift:100-130)

### Folders

- [x] Layers panel and layer operations › Folders › Folders are pass-through: contents draw straight onto what is below; a folder's opacity multiplies into every layer inside (50% in 50% shows 25%; each layer still reads its own value) (Document/LayerGroups.swift:49-70)
- [x] Layers panel and layer operations › Folders › Folders take opacity and a mask but no blend mode, effects, painting or clipping; nesting is limited to 64 levels (Document/LayerAppearance.swift:85-88, Document/LayerGroups.swift:14, Document/LayerGroups.swift:36-45, Document/LiveLayerMask.swift:14)
- [x] Layers panel and layer operations › Folders › New layers and adjustment layers created with a folder active go inside it; adding into a collapsed folder expands it (Document/EditorSession.swift:709-726, Document/LayerAdjustment.swift:220-224)

### Deep layers (16-bit / HDR)

- [x] Layers panel and layer operations › Deep layers (16-bit / HDR) › 16-bit layers in 8-bit documents: 16 bits per channel kept, shown from a dithered 8-bit copy (fine-noise rounding, no banding) (Document/DeepLayers.swift:3-6, Document/DeepLayers.swift:36-48)
- [ ] Layers panel and layer operations › Deep layers (16-bit / HDR) › HDR layers: extended-sRGB half floats keep light brighter than white (shown clipped to white); images over 8 bits import as HDR when their peak exceeds 1.001, else 16-bit (Document/DeepLayers.swift:79-88, Document/DeepLayers.swift:164-178)
- [x] Layers panel and layer operations › Deep layers (16-bit / HDR) › Convert to 16-Bit (8-bit layer): keeps the pixels, later edits keep 16-bit precision; on a blank layer it creates clear canvas-sized 16-bit pixels to paint/fill into (Document/DeepLayers.swift:298-328)
- [x] Layers panel and layer operations › Deep layers (16-bit / HDR) › Convert to 8-Bit: dithers down, halving memory and file size (Document/DeepLayers.swift:315-326)
- [x] Layers panel and layer operations › Deep layers (16-bit / HDR) › HDR Convert to 16-Bit: clips highlights to white and stores 16-bit (Document/DeepLayers.swift:280-293)
- [x] Layers panel and layer operations › Deep layers (16-bit / HDR) › Conversion unavailable for text, adjustment and folder layers and for multi-selection (Document/DeepLayers.swift:272-278)
- [ ] Layers panel and layer operations › Deep layers (16-bit / HDR) › Painting on a 16-bit layer keeps the base at full depth (strokes are 8-bit patches over it); adjustment layers above a deep layer preview at full depth (Document/DeepLayers.swift:50-77, Document/DeepLayers.swift:122-138)

### Limits

- [x] Layers panel and layer operations › Limits › At most 10,000 layers (new folders, adjustment layers, duplicates refuse beyond it); any layer/mask side at most 30,000 px; one surface at most 200 MP; total raster per document scales with RAM (a quarter of memory at 4 B/px, between 200 MP and 800 MP) (Document/LayerGroups.swift:181, Document/LayerAdjustment.swift:209, Document/SelectionClipboard.swift:263, Document/DocumentLimits.swift:18-37)

## Masks and clipping

### Adding masks

- [x] Masks and clipping › Adding masks › Footer Add layer mask button, no selection: adds an all-white reveal mask (undo "Add Reveal-All Mask"); Option-click adds all-black hide mask ("Add Hide-All Mask"); the new mask becomes the target (UI/LayerMaskMenu.swift:9-11, Document/LayerMask.swift:240-241, Document/LayerMask.swift:270-278)
- [x] Masks and clipping › Adding masks › Footer button with a selection: Reveal Selection (white inside, black outside); Option-click Hide Selection; the selection is consumed (deselected) in the same undo step; tooltip text changes with the selection (UI/LayerMaskMenu.swift:12-13, Document/LayerMask.swift:237-267)
- [x] Masks and clipping › Adding masks › Button disabled when several layers are selected or the layer already has a mask (UI/LayerMaskMenu.swift:15-16)
- [x] Masks and clipping › Adding masks › Any layer kind takes a mask: pixel, text, shape, adjustment layers and folders; mask pixels cover the layer's own pixel grid; a uniform mask is stored as 1x1 (Document/LayerMask.swift:6-34, Document/LayerMask.swift:220-221)

### Mask target and painting

- [x] Masks and clipping › Mask target and painting › Mask thumbnail (30 pt, canvas-shaped, mask drawn where it sits; past its pixels it continues white or black, whichever most of its edge is): click targets the mask (accent border); tooltip lists Option/Shift/Cmd gestures (UI/NativeLayerList.swift:1015-1022, UI/NativeLayerList.swift:1039, UI/NativeLayerList.swift:1154-1158, UI/CanvasThumbnail.swift:38-44, Document/LayerMask.swift:61-76)
- [x] Masks and clipping › Mask target and painting › With the mask targeted, Brush, Blur, Gradient, Fill and Invert work on the mask; Spot Healing and Clone Stamp do nothing on masks; filters and color adjustments are unavailable (Document/EditorSession+Brush.swift:50-53, Document/HueSaturation.swift:454-461, Document/SelectionEdits.swift:95-101)
- [x] Masks and clipping › Mask target and painting › Brush and fills on a mask can paint anywhere on the canvas, growing the mask past the layer's own bounds (Document/BrushStroke.swift:199-218, Document/EditorSession+Brush.swift:70, Document/SelectionEdits.swift:230-231, Document/Gradient.swift:66)
- [x] Masks and clipping › Mask target and painting › While a mask is targeted the color swatches show only black/white (X swaps, D resets to black foreground / white background) and the color picker does not open (Document/ColorPalette.swift:26-28, Document/ColorPalette.swift:30-35, Document/ColorPalette.swift:43-55, Document/ColorPalette.swift:58-59)
- [x] Masks and clipping › Mask target and painting › Delete with a selection on a targeted mask fills the selection with the background color (Document/SelectionEdits.swift:65-72)
- [x] Masks and clipping › Mask target and painting › Image › Invert becomes "Invert Mask" (⌘I) when the mask is targeted; needs an enabled mask; inside the selection or whole mask (CompositorApp.swift:305-307, Document/SelectionEdits.swift:95-101)
- [x] Masks and clipping › Mask target and painting › Paint refusals (alert "Couldn't paint"): disabled mask "The layer mask is turned off. Shift-click its thumbnail to turn it on, then paint."; folder pixels "...Paint on a layer inside it, or on the folder's mask."; adjustment layer "...Paint on its mask instead." (Document/EditorSession+Brush.swift:14-33, ContentView.swift:297-300)

### Enable, delete, link

- [x] Masks and clipping › Enable, delete, link › Shift-click the mask thumbnail (or context menu Enable/Disable Mask) toggles the mask; a disabled mask is not applied and shows a red "╱" over its thumbnail; undo "Disable/Enable Layer Mask" (UI/NativeLayerList.swift:907-909, UI/NativeLayerList.swift:1027, UI/NativeLayerList.swift:1374-1377, Document/LayerMask.swift:279-286)
- [x] Masks and clipping › Enable, delete, link › Delete mask: trash button or Delete key with the mask targeted, context menu Delete Mask, Layer › Delete Layer Mask; undo "Delete Layer Mask" (Document/LayerMask.swift:287-295, Document/SelectionEdits.swift:84-88)
- [x] Masks and clipping › Enable, delete, link › Link button (chain icon) between layer and mask thumbnails toggles link; empty but clickable when unlinked; tooltips "Unlink layer and mask to move or transform them separately" / "Link layer and mask so they move together"; hidden for folders and adjustment layers; undo "Unlink/Link Layer Mask" (UI/NativeLayerList.swift:837-855, UI/NativeLayerList.swift:1030-1037, Document/LayerMask.swift:318-327)
- [x] Masks and clipping › Enable, delete, link › Linked mask follows every move/transform of its layer; unlinked, the layer moves without it and the mask stays where it was on the document (Document/LayerMask.swift:9-13, Document/LayerMask.swift:52-59)
- [x] Masks and clipping › Enable, delete, link › Transform an unlinked mask on its own: with the mask targeted, Move/Transform edits only the mask's placement (undo "Transform Layer Mask"); a free distort resamples the mask into the new shape ("Distort Layer Mask") (Document/EditorSession.swift:456-459, Document/LayerMask.swift:347-372)

### Mask alone view

- [x] Masks and clipping › Mask alone view › Option-click the mask thumbnail shows that mask alone on the canvas in grayscale (edge tone beyond its pixels), with live strokes/gradients; Option-click again returns to the composite; the mask stays the paint target (UI/NativeLayerList.swift:1150-1153, UI/NativeLayerList.swift:1386-1389, Document/LayerMask.swift:229-236, Rendering/EditorCanvas.swift:976-979, Rendering/EditorCanvas.swift:2869-2885)
- [x] Masks and clipping › Mask alone view › Canvas pill at the bottom "Layer Mask · <layer name>" with an × button ("Show the image again (or Option-click the mask thumbnail)"); mask thumbnail outlined white meanwhile; targeting the pixels or another layer ends it (UI/LayerMaskMenu.swift:20-33, ContentView.swift:104-113, UI/NativeLayerList.swift:1085-1086, Document/EditorSession.swift:631-639)

### Copy and load masks

- [x] Masks and clipping › Copy and load masks › Option-drag the mask thumbnail (>=3 pt) onto another layer row copies the mask, kept where it sits on the document, replacing any existing mask; not onto folders; undo "Copy Layer Mask"/"Replace Layer Mask" (UI/NativeLayerList.swift:1364-1368, UI/NativeLayerList.swift:1386-1407, Document/LayerMask.swift:296-317)
- [x] Masks and clipping › Copy and load masks › Cmd-click the mask thumbnail loads the mask's black (hidden) areas as the selection; Cmd-Shift adds, Cmd-Option subtracts (UI/NativeLayerList.swift:1137-1149, UI/NativeLayerList.swift:1369-1373, Document/MaskTracing.swift:74-83)

### Folder and adjustment masks

- [x] Masks and clipping › Folder and adjustment masks › A folder's mask clips every layer inside it, multiplied with each layer's own mask and outer folders' masks (Document/LayerMask.swift:168-210, Document/LiveLayerMask.swift:201-206)
- [x] Masks and clipping › Folder and adjustment masks › Layer effects are built from the masked pixels, so they follow the shape that is shown (Document/LayerEffects.swift:448-459)

### Clipping masks

- [x] Masks and clipping › Clipping masks › Create Clipping Mask: clips the layer to the next lower sibling in the same folder, or to that sibling's base if it is already clipped (one base per stack); undo "Create Clipping Mask" (Document/LiveLayerMask.swift:220-230, Document/LiveLayerMask.swift:31-38)
- [x] Masks and clipping › Clipping masks › Rules: folders cannot be clipped; the base cannot be a folder or an adjustment layer; no cycles; clip chains under 256 (Document/LiveLayerMask.swift:3-30, Document/LiveLayerMask.swift:212-219)
- [x] Masks and clipping › Clipping masks › Release Clipping Mask releases the layer and the clipped layers above it that share its base; lower siblings untouched; undo "Release Clipping Mask" (Document/LiveLayerMask.swift:53-71)
- [x] Masks and clipping › Clipping masks › Option-click the bottom strip of a row (min(10 pt, row height / 3), not on folders) toggles clipping; the cursor shows a create or release clipping badge (UI/NativeLayerList.swift:594-615, UI/NativeLayerList.swift:697-705, UI/NativeLayerList.swift:736-766)
- [x] Masks and clipping › Clipping masks › Clipped rows: indented 24 pt, "↳ " name prefix, subtitle "Clipped to <base>", no depth tag (UI/NativeLayerList.swift:995, UI/NativeLayerList.swift:1046, UI/NativeLayerList.swift:1051-1057)
- [x] Masks and clipping › Clipping masks › Text, shape and pixel layers can all be clipping bases (Document/LiveLayerMask.swift:23-26)

## Adjustment layers

### Creating and editing

- [x] Adjustment layers › Creating and editing › Layer › New Adjustment Layer submenu: lists every AdjustmentKind in this order: Hue/Saturation…, Levels…, Curves…, Exposure…, Gradient Map…, Grain…, Add Noise…, Gaussian Blur…, Motion Blur…, Invert, Black & White…, Color Balance… (trailing "…" on every kind except Invert); disabled with no document or when layers can't be edited (CompositorApp.swift:342-346, Document/LayerAdjustment.swift:4-9, Document/LayerAdjustment.swift:28)
- [x] Adjustment layers › Creating and editing › New adjustment layer placement: inserted directly above the active layer; inside the active folder when a folder is active, otherwise in the active layer's parent folder (which is expanded); becomes the active layer; named after its kind; one undo step "New <Kind> Adjustment"; refused at 10,000 layers (Document/LayerAdjustment.swift:208-226)
- [x] Adjustment layers › Creating and editing › Editor opens on creation: every editable kind opens its settings panel immediately; Invert applies at once with no panel (Document/LayerAdjustment.swift:227-228)
- [x] Adjustment layers › Creating and editing › New Gradient Map defaults: shadows = current foreground color, highlights = current background color (Document/LayerAdjustment.swift:212-216)
- [x] Adjustment layers › Creating and editing › New Grain / Add Noise layer seed: each new Grain or Add Noise adjustment layer gets its own random pattern seed (Document/LayerAdjustment.swift:217-218)
- [x] Adjustment layers › Creating and editing › Layer › Edit Adjustment…: reopens the active adjustment layer's settings panel; disabled unless the active layer is an adjustment layer (CompositorApp.swift:347-349, UI/LayersPanel.swift:69-70)
- [x] Adjustment layers › Creating and editing › Double-click to edit: double-clicking an adjustment layer's thumbnail (not its name, which renames) opens its editor; not for Invert (UI/NativeLayerList.swift:396-404)
- [x] Adjustment layers › Creating and editing › Layers-panel row look: square SF-symbol icon per kind instead of a thumbnail (Curves icon rotated a quarter turn) and the subtitle "Adjustment · Double-click to edit" (UI/NativeLayerList.swift:1009, UI/NativeLayerList.swift:1047, Document/LayerAdjustment.swift:10-25)
- [x] Adjustment layers › Creating and editing › Editors reuse the destructive panels: Levels uses the Levels panel, Hue/Saturation the Hue/Saturation panel, every other kind the Filter panel with that filter's controls (Document/AdjustmentEditing.swift:25-57, ContentView.swift:228-279)
- [x] Adjustment layers › Creating and editing › Editor input is the composite underneath: the Levels histogram and eyedroppers read a render of the visible layers below the adjustment (layers above and the adjustment itself hidden), never the layer's own pixels (Document/AdjustmentEditing.swift:13-24)
- [x] Adjustment layers › Creating and editing › Live preview into layer settings: moving a control writes the new settings straight to the adjustment layer so the canvas updates; Preview off shows the original settings (Document/AdjustmentEditing.swift:100-106)
- [x] Adjustment layers › Creating and editing › OK / Cancel semantics: OK keeps the edited settings; Cancel, Esc or the panel's close button restore the original settings; the whole edit is one undo step "Edit <Kind> Adjustment" (Document/AdjustmentEditing.swift:59, Document/AdjustmentEditing.swift:108-130)
- [x] Adjustment layers › Creating and editing › No selection limit when editing: an adjustment layer's editor ignores the current selection, and the "Limited to the selection" note is hidden; the Levels caption reads "Underlying pixels · alpha-weighted histogram" (Document/AdjustmentEditing.swift:28, UI/FilterSheet.swift:170-172, UI/LevelsSheet.swift:75)
- [ ] Adjustment layers › Creating and editing › Editing blocks file operations: while an adjustment editor is open, project operations (open/save/etc.) wait (Document/EditorSession.swift:153)
- [x] Adjustment layers › Creating and editing › Settings validation: out-of-range stored values are rejected (Hue ±360, Sat/Light ±100, Gaussian radius 0.1–250, motion angle −90–90, distance 1–2000, noise 0.1–400, curves/levels/exposure/etc. validity) (Document/LayerAdjustment.swift:128-141, Document/LayerAdjustment.swift:230-234)

### Where adjustments apply

- [x] Adjustment layers › Where adjustments apply › Whole-composite input: an adjustment layer changes everything composited below it in draw order across the whole document (folders do not isolate it) (Rendering/LiveMaskRenderer.swift:39-44, Rendering/LiveMaskRenderer.swift:105-110)
- [x] Adjustment layers › Where adjustments apply › Blend mode: a non-Normal blend mode blends the adjusted result over the original at full coverage, then restores the original alpha (Rendering/LiveMaskRenderer.swift:45-71)
- [x] Adjustment layers › Where adjustments apply › Opacity: effective opacity below 100% mixes adjusted and original by opacity (folder opacity included) (Rendering/LiveMaskRenderer.swift:72-82, Document/LiveLayerMask.swift:194)
- [x] Adjustment layers › Where adjustments apply › Mask and folder-mask clip: the result is drawn back clipped by the adjustment's own enabled layer mask and its ancestor folders' masks (Rendering/LiveMaskRenderer.swift:83-86, Document/LiveLayerMask.swift:195)
- [x] Adjustment layers › Where adjustments apply › Clipped adjustment: an adjustment clipped into a clipping stack adjusts only that stack (the base and the layers clipped to it) (Rendering/LiveMaskRenderer.swift:93-104, Rendering/LiveMaskRenderer.swift:131-132)
- [x] Adjustment layers › Where adjustments apply › Not a clipping base: an adjustment layer cannot be the source (base) of a clipping mask or live mask link (Document/LiveLayerMask.swift:14, Document/LiveLayerMask.swift:25)
- [x] Adjustment layers › Where adjustments apply › Document-anchored noise: Grain and Add Noise patterns stay fixed to document coordinates while panning, zooming and partial redraws (Document/LayerAdjustment.swift:142-143, Document/LayerAdjustment.swift:176-199, Rendering/GPUNoise.swift:4-8)
- [x] Adjustment layers › Where adjustments apply › Blur halo: Gaussian and Motion Blur adjustments sample beyond the redrawn region (3×radius+2 / distance/2+2 px) so partial redraws have no seams (Document/LayerAdjustment.swift:120-127, Rendering/AdjustmentSurface.swift:4-27)
- [ ] Adjustment layers › Where adjustments apply › GPU canvas path: on the GPU canvas Levels runs as CIColorCurves, Hue/Saturation as a 33³ CIColorCube, Curves/Black & White/Color Balance/Exposure/Gradient Map/Invert as cubes built by running the adjustment itself, blurs via Core Image, Noise/Grain via Metal kernels (Rendering/GPUCanvas.swift:545-600, Rendering/GPUCanvas.swift:630-656)
- [ ] Adjustment layers › Where adjustments apply › 16-bit / HDR below: adjustments keep 16-bit precision on merge/export (blurs in Core Image, Exposure exact on HDR, color-mixing kinds through a color lookup, others run per channel); on the GPU canvas HDR highlights are divided into range and multiplied back (Document/LayerAdjustment.swift:144-161, Rendering/GPUCanvas.swift:547-563)

### Hue/Saturation

- [x] Adjustment layers › Hue/Saturation › Panel: floating "Hue/Saturation" panel, 460 pt wide; close button = Cancel; Cmd-U (Image menu) for destructive use (ContentView.swift:242-248, UI/HueSaturationSheet.swift:72)
- [x] Adjustment layers › Hue/Saturation › Range picker: Master, Reds, Yellows, Greens, Cyans, Blues, Magentas (default Master); each range keeps its own Hue/Saturation/Lightness; Master applies everywhere; disabled while Colorize is on (UI/HueSaturationSheet.swift:36-39, Document/HueSaturation.swift:5-7, Document/HueSaturation.swift:170-214)
- [x] Adjustment layers › Hue/Saturation › Default hue bands (falloff start / range start / range end / falloff end, degrees): Reds 315/345/15/45, Yellows 15/45/75/105, Greens 75/105/135/165, Cyans 135/165/195/225, Blues 195/225/255/285, Magentas 255/285/315/345 (Document/HueSaturation.swift:10-20)
- [x] Adjustment layers › Hue/Saturation › Hue slider: −180…180° (0…360° when Colorize), step 1, default 0; spectrum-colored track; integer field with ° suffix; label drag-scrubs; double-click label or knob resets (UI/HueSaturationSheet.swift:10, UI/HueSaturationSheet.swift:43, UI/HueSaturationSheet.swift:125-141)
- [x] Adjustment layers › Hue/Saturation › Saturation slider: −100…100 (0…100 when Colorize), step 1, default 0 (25 when Colorize); chroma/saturation-colored track; Photoshop math (below 0 scales toward gray, above 0 divides by what is left, +100 fully saturates) (UI/HueSaturationSheet.swift:11, UI/HueSaturationSheet.swift:44-45, Document/HueSaturation.swift:344-348)
- [x] Adjustment layers › Hue/Saturation › Lightness slider: −100…100, step 1, default 0; black-to-white track; pulls toward white above 0, black below, reaching it at ±100 (UI/HueSaturationSheet.swift:46-47, Document/HueSaturation.swift:335-338)
- [x] Adjustment layers › Hue/Saturation › Field Return commits: pressing Return in a numeric field clamps the value and confirms the panel (as OK) (UI/HueSaturationSheet.swift:136-140)
- [x] Adjustment layers › Hue/Saturation › Spectrum editor: shown for a color range (not Master, not Colorize): "before" and "after" 72-slice hue bars, four draggable band handles (outer falloff marks, inner range bars; nearest handle grabbed; order kept; band ≤350°), degree readout of the four handles (UI/HueSaturationSheet.swift:48-51, UI/HueSaturationSheet.swift:147-210, Document/HueSaturation.swift:117-131)
- [x] Adjustment layers › Hue/Saturation › Apply outside this range instead: toggle (default off) that applies the selected range's change to every hue outside its band (UI/HueSaturationSheet.swift:50, Document/HueSaturation.swift:175, Document/HueSaturation.swift:209-213)
- [x] Adjustment layers › Hue/Saturation › Colorize: toggle (default off); switching on resets to hue 0, saturation 25, lightness 0 and sets an absolute hue; switching off resets to identity (UI/HueSaturationSheet.swift:53-56, Document/HueSaturation.swift:205, Document/HueSaturation.swift:322-325)
- [x] Adjustment layers › Hue/Saturation › Preview toggle: default on; off shows the unadjusted pixels (UI/HueSaturationSheet.swift:57, Document/HueSaturation.swift:479-495)
- [x] Adjustment layers › Hue/Saturation › Reset button: back to identity (or to the Colorize start when colorizing) (UI/HueSaturationSheet.swift:58)
- [x] Adjustment layers › Hue/Saturation › Sample eyedropper: armed toggle (shown only for a color range, not Colorize); click the canvas to center the range's band on that hue keeping its widths (UI/HueSaturationSheet.swift:79-94, Document/HueSaturation.swift:136, Document/HueSaturation.swift:56-67, Document/HueSaturation.swift:576-586, Rendering/EditorCanvas.swift:1794-1803)
- [x] Adjustment layers › Hue/Saturation › Add eyedropper (plus badge): click the canvas to widen the band to include that hue (nearer edge moves) (Document/HueSaturation.swift:136-145, Document/HueSaturation.swift:70-84)
- [x] Adjustment layers › Hue/Saturation › Remove eyedropper (minus badge): click the canvas to narrow the band so that hue falls outside, shoulder included (Document/HueSaturation.swift:136-145, Document/HueSaturation.swift:87-101)
- [x] Adjustment layers › Hue/Saturation › Eyedropper sampling source: samples the visible composite; near-neutral colors (HSB saturation ≤ 0.02) beep and do nothing (Document/HueSaturation.swift:569-573, Document/HueSaturation.swift:579)
- [x] Adjustment layers › Hue/Saturation › Targeted adjustment tool (hand icon, not in Colorize): drag left/right on the image to change the saturation of the range that owns the clicked hue (it becomes the selected range); Command-drag changes its hue instead; 1 unit per 2 view points, clamped ±100 / ±180; left-right resize cursor (UI/HueSaturationSheet.swift:95-107, Document/HueSaturation.swift:590-618, Rendering/EditorCanvas.swift:1805-1811, Rendering/EditorCanvas.swift:1902-1906, Rendering/EditorCanvas.swift:1447)
- [x] Adjustment layers › Hue/Saturation › Live preview: renders at up to 8000 px on the long side, coalescing (never cancelling) during drags; HDR layers preview from HDR pixels (Document/HueSaturation.swift:416, Document/HueSaturation.swift:479-511, Document/HueSaturation.swift:632-646)
- [x] Adjustment layers › Hue/Saturation › Cancel (Esc) / OK (Return): OK applies one undo step "Hue/Saturation"; identity settings change nothing (Cancel/OK keys remappable) (UI/HueSaturationSheet.swift:65-70, Document/HueSaturation.swift:515-565)

### Levels

- [x] Adjustment layers › Levels › Panel: floating "Levels" panel, 440 pt wide; close button = Cancel; Cmd-L (Image menu) for destructive use (ContentView.swift:228-234, UI/LevelsSheet.swift:86)
- [x] Adjustment layers › Levels › Channel picker: RGB, Red, Green, Blue (default RGB); each channel keeps its own input/gamma/output; channel then RGB composite applied (UI/LevelsSheet.swift:19-21, Document/Levels.swift:4-7, Document/Levels.swift:32-44)
- [x] Adjustment layers › Levels › Histogram: 150 pt, colored by channel (gray/red/green/blue), "Loading histogram…" until ready; RGB is the mean of the three channel histograms; alpha-weighted (and selection-weighted for destructive use); auto vertical scale caps isolated spikes at 4× the 95th-percentile bin; help text explains it (UI/LevelsSheet.swift:22-28, UI/LevelsSheet.swift:99-114, Document/Levels.swift:47-56, Document/Levels.swift:85-101)
- [x] Adjustment layers › Levels › Input handles: three draggable triangles under the histogram (black, gamma, white); black stays ≤ white−1, white ≥ black+1, gamma follows the midpoint fraction (0.001–0.999) (UI/LevelsSheet.swift:115-145)
- [x] Adjustment layers › Levels › Input black field: 0…254 (≤ white−1), integer, default 0; label drag-scrubs (UI/LevelsSheet.swift:30, UI/LevelsSheet.swift:89-98, Document/Levels.swift:19)
- [x] Adjustment layers › Levels › Gamma field: 0.1…9.99, 2 decimals, default 1.00; label scrubs at 0.01 (UI/LevelsSheet.swift:32, UI/LevelsSheet.swift:90-93, Document/Levels.swift:21)
- [x] Adjustment layers › Levels › Input white field: black+1…255, integer, default 255 (UI/LevelsSheet.swift:34, Document/Levels.swift:20)
- [x] Adjustment layers › Levels › Output gradient bar with two draggable handles (output black, output white) (UI/LevelsSheet.swift:36-39, UI/LevelsSheet.swift:131-132)
- [x] Adjustment layers › Levels › Output black field: 0…255, integer, default 0 (UI/LevelsSheet.swift:41, Document/Levels.swift:22)
- [x] Adjustment layers › Levels › Output white field: 0…255, integer, default 255 (output black may exceed output white, inverting) (UI/LevelsSheet.swift:43, Document/Levels.swift:23)
- [x] Adjustment layers › Levels › Sample eyedroppers Black / Gray / White: toggle buttons; click the original layer on the canvas to set that point for R, G and B together (RGB range reset, outputs reset to 0/255); hint "Click the original layer to set …"; panel keeps focus; other canvas clicks blocked while Levels is open (except Hand/Zoom) (UI/LevelsSheet.swift:45-59, Document/LevelsAutomatic.swift:3, Document/LevelsAutomatic.swift:41-59, Document/LevelsAutomatic.swift:68-83, Rendering/EditorCanvas.swift:1781-1786)
- [x] Adjustment layers › Levels › Auto: Contrast: one shared black/white point on the RGB channel from the channels' 0.1% clip points, keeping channel relationships (UI/LevelsSheet.swift:60-67, Document/LevelsAutomatic.swift:4-22)
- [x] Adjustment layers › Levels › Auto: Color: per-channel black/white points at 0.1% clipping (Document/LevelsAutomatic.swift:23-33)
- [x] Adjustment layers › Levels › Auto: Color + neutral midtones: per-channel points plus a per-channel gamma that moves each channel's mean to middle gray; Auto buttons disabled until the histogram is ready (Document/LevelsAutomatic.swift:27-31, UI/LevelsSheet.swift:66)
- [x] Adjustment layers › Levels › Preview toggle: default on; Option-P toggles it (remappable "Toggle Levels preview") (UI/LevelsSheet.swift:68-71, UI/KeyboardShortcuts.swift:141)
- [x] Adjustment layers › Levels › Reset button: all channels back to identity, eyedropper disarmed (UI/LevelsSheet.swift:73)
- [x] Adjustment layers › Levels › Source caption: "Original pixels · alpha-weighted histogram", "… selection and alpha-weighted histogram" with a selection, "Underlying pixels …" for adjustment layers (UI/LevelsSheet.swift:75)
- [x] Adjustment layers › Levels › Cancel (Esc) / OK (Return) with progress spinner while applying; identity OK = Cancel (no undo step); destructive OK is one undo step "Levels" (UI/LevelsSheet.swift:78-84, Document/Levels.swift:205-238)
- [x] Adjustment layers › Levels › Preview resolution: full size up to 8000 px on the long side; HDR layers preview through normalize-and-restore (Document/Levels.swift:129-142, Document/Levels.swift:181-198)

### Curves

- [x] Adjustment layers › Curves › Panel: Filter panel showing Curves controls; Cmd-M (Image menu) for destructive use (UI/FilterSheet.swift:22-23, CompositorApp.swift:295-296)
- [x] Adjustment layers › Curves › Channel picker: RGB, Red, Green, Blue (default RGB); separate curve per channel; per-channel curve applied, then the RGB curve (UI/CurvesControls.swift:10-12, Document/Curves.swift:8-9, Document/Curves.swift:37)
- [x] Adjustment layers › Curves › Graph: 260 pt tall, 4×4 grid, curve drawn with shape-preserving monotone cubic Hermite interpolation (no overshoot), output clamped 0–255 (UI/CurvesControls.swift:13-33, Document/Curves.swift:17-32)
- [x] Adjustment layers › Curves › Click to add a point: clicking empty graph adds a point (x within 1…254, more than 1 level from any existing point, max 32 points per channel) and starts dragging it (UI/CurvesControls.swift:40-47, Document/Curves.swift:12)
- [x] Adjustment layers › Curves › Drag a point: grabs the nearest point within 14 levels; interior points move in x between neighbors (±1) and y 0–255; the two endpoints move only in y; the dragged point becomes selected (highlighted) (UI/CurvesControls.swift:41-54)
- [x] Adjustment layers › Curves › Selected point readout: "Input N · Output N" (UI/CurvesControls.swift:58-60)
- [x] Adjustment layers › Curves › Remove point button: deletes the selected interior point; disabled for none or an endpoint (UI/CurvesControls.swift:62-64)
- [x] Adjustment layers › Curves › Reset curve button: resets the current channel to the straight line (0,0)–(255,255) (UI/CurvesControls.swift:66)
- [x] Adjustment layers › Curves › Hint text "Click to add a point. Drag to adjust." (UI/CurvesControls.swift:56)

### Exposure

- [x] Adjustment layers › Exposure › Exposure slider: −20…20 stops, 2 decimals, default 0; scales linear light by 2^exposure (UI/FilterSheet.swift:25, Document/ImageAdjustments.swift:38, Document/ImageAdjustments.swift:42, Document/ImageAdjustments.swift:54-63)
- [x] Adjustment layers › Exposure › Offset slider: −0.5…0.5, 4 decimals, default 0; added in linear light (negative deepens shadows) (UI/FilterSheet.swift:26, Document/ImageAdjustments.swift:39, Document/ImageAdjustments.swift:44)
- [x] Adjustment layers › Exposure › Gamma Correction slider: 0.01…9.99, logarithmic slider, 2 decimals, default 1; above 1 brightens midtones (UI/FilterSheet.swift:27, Document/ImageAdjustments.swift:40, Document/ImageAdjustments.swift:46)
- [ ] Adjustment layers › Exposure › HDR exactness: on HDR pixels Exposure works over the full range past white (bringing highlights into view when turned down) (Document/LayerAdjustment.swift:158, Rendering/GPUCanvas.swift:547, Rendering/GPUCanvas.swift:603-619)

### Gradient Map

- [x] Adjustment layers › Gradient Map › Gradient preview bar: 20 pt bar from the dark-end color to the light-end color (UI/FilterSheet.swift:387-392)
- [x] Adjustment layers › Gradient Map › Shadows swatch: opens the app's color picker on the shadows color (default black; foreground color for a new layer / filter); canvas previews live while picking (UI/FilterSheet.swift:394, Document/ColorPalette.swift:141-146, Document/ColorPalette.swift:172-175, Document/ImageAdjustments.swift:76)
- [x] Adjustment layers › Gradient Map › Highlights swatch: opens the color picker on the highlights color (default white; background color for a new layer / filter) (UI/FilterSheet.swift:395, Document/ImageAdjustments.swift:77)
- [x] Adjustment layers › Gradient Map › Reverse toggle: default off; swaps which color maps to dark and light (UI/FilterSheet.swift:398, Document/ImageAdjustments.swift:78, Document/ImageAdjustments.swift:87)
- [x] Adjustment layers › Gradient Map › Mapping: each pixel's brightness picks a color linearly between the two ends; alpha kept (Document/ImageAdjustments.swift:88-108)

### Grain

- [x] Adjustment layers › Grain › Amount slider: 0…100, integer, default 25; 0 = no effect (UI/FilterSheet.swift:65, Document/ImageAdjustments.swift:181, Document/ImageAdjustments.swift:185, Document/ImageAdjustments.swift:203)
- [x] Adjustment layers › Grain › Size slider: 0.5…20 px (document pixels), logarithmic, 1 decimal, default 1.5 (UI/FilterSheet.swift:66, Document/ImageAdjustments.swift:182, Document/ImageAdjustments.swift:187)
- [x] Adjustment layers › Grain › Roughness slider: 0…100, integer, default 50; irregular finer detail roughening the grain (UI/FilterSheet.swift:67, Document/ImageAdjustments.swift:183, Document/ImageAdjustments.swift:189)
- [x] Adjustment layers › Grain › Character: brightness noise strongest in the midtones, pattern fixed by a stored seed (Document/ImageAdjustments.swift:178-190)

### Add Noise

- [x] Adjustment layers › Add Noise › Amount: 0.1…400 %, logarithmic, 1 decimal, default 10 (adjustment-layer default) (UI/FilterSheet.swift:114, Document/LayerAdjustment.swift:104-107)
- [x] Adjustment layers › Add Noise › Distribution: segmented Uniform / Gaussian, default Uniform (UI/FilterSheet.swift:115-122, Document/LayerAdjustment.swift:108-111)
- [x] Adjustment layers › Add Noise › Monochromatic toggle: default off; brightness-only noise (UI/FilterSheet.swift:123, Document/LayerAdjustment.swift:112-115)

### Gaussian Blur

- [x] Adjustment layers › Gaussian Blur › Radius: 0.1…250 px, logarithmic, 1 decimal, default 10 for adjustment layers; blurs everything below, spreading past edges (UI/FilterSheet.swift:89, Document/LayerAdjustment.swift:92-95, Rendering/GPUCanvas.swift:585-587)
- [x] Adjustment layers › Gaussian Blur › Preserve Transparency toggle is shown in the editor but not stored on the adjustment layer (only the radius is carried back) (UI/FilterSheet.swift:90-91, Document/AdjustmentEditing.swift:86)

### Motion Blur

- [x] Adjustment layers › Motion Blur › Angle: −90…90°, integer, default 0, counterclockwise from horizontal (UI/FilterSheet.swift:111, Document/LayerAdjustment.swift:96-99)
- [x] Adjustment layers › Motion Blur › Distance: 1…2000 px, logarithmic, integer, default 10 (UI/FilterSheet.swift:112, Document/LayerAdjustment.swift:100-103)

### Invert

- [x] Adjustment layers › Invert › Invert adjustment layer: inverts the colors of everything below; no settings, no editor, not double-click editable (Document/LayerAdjustment.swift:28, Document/LayerAdjustment.swift:200-202, Document/AdjustmentEditing.swift:26)

### Black & White

- [x] Adjustment layers › Black & White › Reds slider: −200…300 %, integer, default 40; luminance track at hue 0; double-click title or knob resets (UI/FilterSheet.swift:33, Document/ImageAdjustments.swift:115-117)
- [x] Adjustment layers › Black & White › Yellows slider: −200…300 %, default 60; track hue 60 (UI/FilterSheet.swift:34, Document/ImageAdjustments.swift:118)
- [x] Adjustment layers › Black & White › Greens slider: −200…300 %, default 40; track hue 120 (UI/FilterSheet.swift:35, Document/ImageAdjustments.swift:119)
- [x] Adjustment layers › Black & White › Cyans slider: −200…300 %, default 60; track hue 180 (UI/FilterSheet.swift:36, Document/ImageAdjustments.swift:120)
- [x] Adjustment layers › Black & White › Blues slider: −200…300 %, default 20; track hue 240 (UI/FilterSheet.swift:37, Document/ImageAdjustments.swift:121)
- [x] Adjustment layers › Black & White › Magentas slider: −200…300 %, default 80; track hue 300 (UI/FilterSheet.swift:38, Document/ImageAdjustments.swift:122)
- [x] Adjustment layers › Black & White › Tint toggle: default off; colors the gray result keeping its tones (sepia, cyanotype) (UI/FilterSheet.swift:39-40, Document/ImageAdjustments.swift:124)
- [x] Adjustment layers › Black & White › Tint Hue slider: 0…360°, integer, default 40; shown only with Tint on (UI/FilterSheet.swift:41-42, Document/ImageAdjustments.swift:125)
- [x] Adjustment layers › Black & White › Tint Saturation slider: 0…100 %, integer, default 20; saturation track at the tint hue; shown only with Tint on (UI/FilterSheet.swift:43-44, Document/ImageAdjustments.swift:126)

### Color Balance

- [x] Adjustment layers › Color Balance › Shadows Cyan/Red slider: −100…100, integer, default 0; cyan-to-red track; double-click resets (UI/FilterSheet.swift:50-51, Document/ImageAdjustments.swift:147-148)
- [x] Adjustment layers › Color Balance › Shadows Magenta/Green slider: −100…100, default 0 (UI/FilterSheet.swift:52, Document/ImageAdjustments.swift:149)
- [x] Adjustment layers › Color Balance › Shadows Yellow/Blue slider: −100…100, default 0 (UI/FilterSheet.swift:53, Document/ImageAdjustments.swift:150)
- [x] Adjustment layers › Color Balance › Midtones Cyan/Red slider: −100…100, default 0 (UI/FilterSheet.swift:54-55, Document/ImageAdjustments.swift:151)
- [x] Adjustment layers › Color Balance › Midtones Magenta/Green slider: −100…100, default 0 (UI/FilterSheet.swift:56, Document/ImageAdjustments.swift:152)
- [x] Adjustment layers › Color Balance › Midtones Yellow/Blue slider: −100…100, default 0 (UI/FilterSheet.swift:57, Document/ImageAdjustments.swift:153)
- [x] Adjustment layers › Color Balance › Highlights Cyan/Red slider: −100…100, default 0 (UI/FilterSheet.swift:58-59, Document/ImageAdjustments.swift:154)
- [x] Adjustment layers › Color Balance › Highlights Magenta/Green slider: −100…100, default 0 (UI/FilterSheet.swift:60, Document/ImageAdjustments.swift:155)
- [x] Adjustment layers › Color Balance › Highlights Yellow/Blue slider: −100…100, default 0 (UI/FilterSheet.swift:61, Document/ImageAdjustments.swift:156)
- [x] Adjustment layers › Color Balance › Preserve Luminosity toggle: default on; restores each pixel's brightness so only color moves (UI/FilterSheet.swift:62-63, Document/ImageAdjustments.swift:157)

## Layer effects

### General

- [x] Layer effects › General › Six kinds, listed and rendered in this order: Stroke, Drop Shadow, Color Overlay, Inner Shadow, Outer Glow, Inner Glow; one of each per layer; kept with the layer, pixels never touched, editable any time (Document/LayerEffects.swift:125-139, Document/LayerEffects.swift:226-228)
- [x] Layer effects › General › Add from the footer effects menu: opens that effect's panel at once; adding a kind already present just reopens it; new Stroke and Color Overlay take the current background color; undo "Add <Effect>" (Document/LayerEffects.swift:247-276)
- [x] Layer effects › General › Only for layers with pixels (not folders, blank or adjustment layers) (Document/LayerEffects.swift:236, Document/LayerEffects.swift:315-319)
- [x] Layer effects › General › Effect sub-rows under the layer row (24 pt each): eye toggles the effect (dimmed label when hidden; undo "Hide/Show <Effect>"), click selects (accent background), double-click opens the editor; tooltip "Click to select; double-click to edit; Option-drag to copy <effect>" (UI/NativeLayerList.swift:1200-1291, Document/LayerEffects.swift:278-291, Document/LayerEffects.swift:364-369)
- [x] Layer effects › General › Delete a selected effect: Delete key, footer trash, or Layer › Delete <Effect>; undo "Remove <Effect>" (Document/LayerEffects.swift:371-382, Document/SelectionEdits.swift:76-88, CompositorApp.swift:390)
- [x] Layer effects › General › Effect panel: floating panel titled with the effect name, 340 pt wide; Cancel (Esc) restores only this effect (removes a just-added one), OK (Return) keeps; closes itself if the effect is removed (UI/EffectsSheet.swift:18-26, ContentView.swift:249-262, Document/LayerEffects.swift:293-313)
- [x] Layer effects › General › Panel edits are live on the canvas and stay bound to the layer that opened the panel even if the selection changes (Document/LayerEffects.swift:326-334)
- [x] Layer effects › General › Every slider row: label scrubs by dragging (1 unit/pt), slider, integer field with unit, Up/Down step 1 (Shift 10); typed values may exceed the slider's range up to the field limit, with the thumb pinned at the end (UI/EffectsSheet.swift:170-192)
- [x] Layer effects › General › Color swatch (36x18) opens the app's color picker on the effect's color, previewing live on the layer; Cancel in the picker restores (UI/EffectsSheet.swift:154-168, UI/EffectsSheet.swift:28, Document/ColorPalette.swift:96-100, Document/ColorPalette.swift:121-123, Document/ColorPalette.swift:153-157)
- [x] Layer effects › General › Composite order: drop shadow behind, outer glow, outside stroke, then the pixels with color overlay, inner glow and inner shadow (each keeping the pixels' alpha), inside stroke on top; layer bounds grow by the effect margin (Document/LayerEffects.swift:435-514)
- [x] Layer effects › General › Rendered on the GPU (Metal compute) when available, Core Graphics/Core Image otherwise; results cached; painting updates effects only where the paint changed (Document/LayerEffects.swift:388-422, Document/LayerEffects.swift:460-467, Rendering/LayerEffectsSurface.swift:4-7)
- [x] Layer effects › General › Image Size scales every effect size, distance and blur with the image (Document/LayerEffects.swift:140-153, IO/ImageResizer.swift:101)

### Stroke

- [x] Layer effects › Stroke › Position: segmented Outside / Inside, default Outside (UI/EffectsSheet.swift:37-42, Document/LayerEffects.swift:16)
- [x] Layer effects › Stroke › Color swatch: default the background color when added (model default black) (UI/EffectsSheet.swift:46-50, Document/LayerEffects.swift:255-258)
- [x] Layer effects › Stroke › Size: slider 0...20 px, field 0...500 px, default 4 px; square reach (sharp rectangle corners) (UI/EffectsSheet.swift:51-53, Document/LayerEffects.swift:8-11, Document/LayerEffects.swift:598-611)
- [x] Layer effects › Stroke › Opacity: 0...100%, default 100% (UI/EffectsSheet.swift:54-56, Document/LayerEffects.swift:15)

### Drop Shadow

- [x] Layer effects › Drop Shadow › Color swatch: default black (UI/EffectsSheet.swift:65, Document/LayerEffects.swift:33-35)
- [x] Layer effects › Drop Shadow › Opacity: 0...100%, default 50% (UI/EffectsSheet.swift:68-70, Document/LayerEffects.swift:36)
- [x] Layer effects › Drop Shadow › Angle: -180...180°, default 90° (light from above, shadow straight down; counterclockwise from the right) (UI/EffectsSheet.swift:71-73, Document/LayerEffects.swift:28-30, Document/LayerEffects.swift:39-43)
- [x] Layer effects › Drop Shadow › Distance: slider 0...100 px, field 0...5000 px, default 20 px (UI/EffectsSheet.swift:74-76, Document/LayerEffects.swift:31)
- [x] Layer effects › Drop Shadow › Blur: slider 0...100 px, field 0...500 px, default 20 px (UI/EffectsSheet.swift:77-79, Document/LayerEffects.swift:32)

### Color Overlay

- [x] Layer effects › Color Overlay › Color swatch: default the background color when added (UI/EffectsSheet.swift:88, Document/LayerEffects.swift:261-264)
- [x] Layer effects › Color Overlay › Opacity: 0...100%, default 100% (UI/EffectsSheet.swift:91-93, Document/LayerEffects.swift:59)

### Inner Shadow

- [x] Layer effects › Inner Shadow › Color swatch: default black (UI/EffectsSheet.swift:102, Document/LayerEffects.swift:73-75)
- [x] Layer effects › Inner Shadow › Opacity: 0...100%, default 50% (UI/EffectsSheet.swift:105-107, Document/LayerEffects.swift:76)
- [x] Layer effects › Inner Shadow › Angle: -180...180°, default 90° (UI/EffectsSheet.swift:108-110, Document/LayerEffects.swift:70)
- [x] Layer effects › Inner Shadow › Distance: slider 0...50 px, field 0...5000 px, default 10 px (UI/EffectsSheet.swift:111-113, Document/LayerEffects.swift:71)
- [x] Layer effects › Inner Shadow › Blur: slider 0...100 px, field 0...500 px, default 10 px (UI/EffectsSheet.swift:114-116, Document/LayerEffects.swift:72)

### Outer Glow

- [x] Layer effects › Outer Glow › Color swatch: default white (UI/EffectsSheet.swift:125, Document/LayerEffects.swift:96-98)
- [x] Layer effects › Outer Glow › Size: slider 0...100 px, field 0...500 px, default 20 px (UI/EffectsSheet.swift:128-130, Document/LayerEffects.swift:95)
- [x] Layer effects › Outer Glow › Opacity: 0...100%, default 75% (UI/EffectsSheet.swift:131-133, Document/LayerEffects.swift:99)

### Inner Glow

- [x] Layer effects › Inner Glow › Color swatch: default white (UI/EffectsSheet.swift:142, Document/LayerEffects.swift:113-115)
- [x] Layer effects › Inner Glow › Size: slider 0...100 px, field 0...500 px, default 10 px (UI/EffectsSheet.swift:145-147, Document/LayerEffects.swift:112)
- [x] Layer effects › Inner Glow › Opacity: 0...100%, default 75% (UI/EffectsSheet.swift:148-150, Document/LayerEffects.swift:116)

## Filters

### Filter menu and dialog behaviour

- [x] Filters › Filter menu and dialog behaviour › Filter menu items, in order: Last Filter, then Gaussian Blur…, Motion Blur…, Progressive Blur…, Add Noise…, Vignette…, Bloom / Glow…, Dither…, Scanlines…, Tonal Contrast…, Lens Correction…, Camera Raw Filter…, Remove Background… (FilterKind.allCases minus Content-Aware Fill and the Image-menu adjustments) (CompositorApp.swift:329-340, Document/Filters.swift:7-26, Document/Filters.swift:49-52)
- [x] Filters › Filter menu and dialog behaviour › Last Filter (Ctrl-Cmd-F): menu title reads "Last Filter: <name>"; re-applies the last committed Filter-menu filter with the same settings, no panel and no preview; Content-Aware Fill and Image-menu adjustments are never recorded; nothing to apply closes silently; beeps when unavailable (CompositorApp.swift:330-334, Document/Filters.swift:29, Document/Filters.swift:746-759, Document/Filters.swift:888)
- [x] Filters › Filter menu and dialog behaviour › Enabling (canAdjustColors): exactly one selected, visible, non-folder image layer with pixels, its pixels (not mask) targeted, a non-empty selection if any, no other dialog/stroke/text edit/import/rename in progress; also disabled while Hue/Saturation is open (Document/HueSaturation.swift:453-462, CompositorApp.swift:338)
- [x] Filters › Filter menu and dialog behaviour › Vignette on an empty layer (canVignette): Vignette alone is also enabled on an empty (never-painted) non-adjustment, non-folder layer (Document/HueSaturation.swift:445-452, CompositorApp.swift:338)
- [x] Filters › Filter menu and dialog behaviour › Opening a filter commits pending work: a pending gradient is committed, a transform committed, crop and lasso drafts cancelled before the filter opens (Document/Filters.swift:694-701)
- [x] Filters › Filter menu and dialog behaviour › Filter panel: non-modal floating panel titled with the filter's name, 380 pt wide, opens centered on the canvas the first time then where it was last left (per app session); close button = Cancel (ContentView.swift:271-279, UI/FilterSheet.swift:193, UI/FloatingPanel.swift:5-10, UI/FloatingPanel.swift:12-18)
- [x] Filters › Filter menu and dialog behaviour › Slider control pattern: title (drag to scrub the value), slider (logarithmic for radius/size/distance/amount-type values), numeric field with unit suffix and fixed decimals; colored-track sliders (Black & White, Color Balance) reset on double-click of title or knob (UI/FilterSheet.swift:346-375)
- [x] Filters › Filter menu and dialog behaviour › Live preview: renders on a background task; slider changes coalesce (the running render finishes, then the newest renders) so dragging keeps updating (Document/Filters.swift:770-844)
- [x] Filters › Filter menu and dialog behaviour › Preview toggle: default on; off shows the original layer (UI/FilterSheet.swift:165-166, Document/Filters.swift:453, Document/Filters.swift:781-784)
- [x] Filters › Filter menu and dialog behaviour › Preview resolution: previews render from a copy at most 2048 px on the long side, except Camera Raw, Add Noise, Grain, Dither, Scanlines, Content-Aware Fill and Remove Background, which preview at full size (Document/Filters.swift:532, Document/Filters.swift:619-633)
- [x] Filters › Filter menu and dialog behaviour › Preview error: a failed preview shows its message in orange in the panel (UI/FilterSheet.swift:167-169, Document/Filters.swift:834)
- [x] Filters › Filter menu and dialog behaviour › Limited to the selection: with a selection the result is blended through it (soft edges respected) and the panel says "Limited to the selection" (UI/FilterSheet.swift:170-172, Document/Filters.swift:359-361, Document/PixelAdjust.swift:36-48)
- [x] Filters › Filter menu and dialog behaviour › Cancel (Esc) / OK (Return): OK applies one undo step named after the filter, the preview stays up until the result lands; the panel is disabled while applying; keys remappable (UI/FilterSheet.swift:173-189, UI/FilterSheet.swift:197, Document/Filters.swift:861-996)
- [x] Filters › Filter menu and dialog behaviour › Working… / Applying… indicator: spinner with "Applying…" while committing, or "Working…" while a slow automatic filter (Remove Background, Content-Aware Fill) prepares; OK disabled for those until the preview is ready and error-free (UI/FilterSheet.swift:177-188, Document/Filters.swift:27)
- [x] Filters › Filter menu and dialog behaviour › No-op OK closes like Cancel (no undo step): Lens Correction at 0, Vignette amount 0, Bloom amount 0, Tonal Contrast amount 0 or all three tones 0, Exposure at defaults, Grain amount 0, Camera Raw identity (Document/Filters.swift:876-884)
- [x] Filters › Filter menu and dialog behaviour › Settings remembered: each filter opens with the settings last committed (shared FilterSettings for the session); Gradient Map always restarts from foreground/background colors; Camera Raw remembers the rendered grade (hidden groups dropped) (Document/EditorSession.swift:254-256, Document/Filters.swift:711, Document/Filters.swift:721-724, Document/Filters.swift:872-875, Document/Filters.swift:887)
- [x] Filters › Filter menu and dialog behaviour › Blurs spread past the layer: Gaussian, Motion, Progressive Blur and Bloom pad the layer by their reach (3×radius+2 or distance/2+2) and grow it as the amount rises; the result is trimmed back to non-empty pixels and the layer's transform adjusted (Document/Filters.swift:564-615, Document/Filters.swift:957-971)
- [x] Filters › Filter menu and dialog behaviour › Canvas-edge carry-on: for an unrotated layer, sides at or past the canvas edge are not padded and their edge pixels are extended (Photoshop-like solid edges) for Gaussian, Motion and Progressive Blur (Document/Filters.swift:242-255, Document/Filters.swift:548-556)
- [x] Filters › Filter menu and dialog behaviour › Layer mask carried onto a grown layer: when a filter enlarges the layer, its (unlinked-placement) mask is re-laid onto the new grid, extending its edge tone (Document/Filters.swift:979-988)
- [x] Filters › Filter menu and dialog behaviour › Empty layer start: a filter on an empty layer starts it from clear pixels (Vignette then fills and frames the whole canvas) (Document/Filters.swift:704-710, Document/Filters.swift:725-735)
- [x] Filters › Filter menu and dialog behaviour › Filter colors via the app color picker: Gradient Map, Vignette, Dither and Scanlines swatches open the app's own color picker; the canvas previews the working color live; OK commits the picked color, Cancel discards it (UI/FilterSheet.swift:198-203, Document/ColorPalette.swift:141-152, Document/ColorPalette.swift:191-221, Document/Filters.swift:846-850, Document/Filters.swift:861-864)
- [x] Filters › Filter menu and dialog behaviour › 16-bit and HDR layers: filters keep 16-bit precision (Core Image filters run once at 16 bits; Exposure exact on HDR; Black & White, Color Balance, Gradient Map through a 16-bit color lookup; others run per channel), HDR previews made from HDR pixels; Dither, Content-Aware Fill and Remove Background rasterize to 8-bit (Document/Filters.swift:30-47, Document/Filters.swift:364-384, Document/Filters.swift:913-964)
- [x] Filters › Filter menu and dialog behaviour › Stale-result guard: a filter result is discarded if the layer's pixels or transform changed meanwhile (Document/Filters.swift:975-978)

### Image-menu adjustments (destructive)

- [x] Filters › Image-menu adjustments (destructive) › Image › Curves… (Cmd-M): destructive Curves on the active layer's pixels in the Filter panel; same controls as the Curves adjustment layer; disabled unless canAdjustColors and Hue/Saturation closed (CompositorApp.swift:295-296)
- [x] Filters › Image-menu adjustments (destructive) › Image › Levels… (Cmd-L): destructive Levels in the Levels panel; same controls as the Levels adjustment layer; histogram limited to the selection (CompositorApp.swift:297-298, Document/Levels.swift:149-168)
- [x] Filters › Image-menu adjustments (destructive) › Image › Hue/Saturation… (Cmd-U): destructive Hue/Saturation in its panel; same controls as the adjustment layer; disabled only by canAdjustColors (CompositorApp.swift:299-300, Document/HueSaturation.swift:464-473)
- [x] Filters › Image-menu adjustments (destructive) › Image › Black & White…: destructive, same controls as the adjustment layer; no default shortcut (CompositorApp.swift:301-304)
- [x] Filters › Image-menu adjustments (destructive) › Image › Color Balance…: destructive, same controls as the adjustment layer (CompositorApp.swift:301-304)
- [x] Filters › Image-menu adjustments (destructive) › Image › Exposure…: destructive, same controls as the adjustment layer; OK at default values does nothing (CompositorApp.swift:301-304, Document/Filters.swift:882)
- [x] Filters › Image-menu adjustments (destructive) › Image › Gradient Map…: destructive, same controls; each open starts from foreground → background colors (CompositorApp.swift:301-304, Document/Filters.swift:721-724)
- [x] Filters › Image-menu adjustments (destructive) › Image › Grain…: destructive, same controls; differs from the layer: its pattern sits in layer pixels and each application gets a fresh random seed (fixed while the panel is open) (CompositorApp.swift:301-304, Document/Filters.swift:274-275, Document/Filters.swift:457-458)
- [x] Filters › Image-menu adjustments (destructive) › Image › Invert (Cmd-I): inverts the active layer's colors keeping transparency, inside the selection or the whole layer; one undo step "Invert"; available in every tool (pending gradient/transform applied first) (CompositorApp.swift:305-307, Document/SelectionEdits.swift:95-106, Document/SelectionEdits.swift:103-154, Document/PixelInvert.swift:16-42)
- [x] Filters › Image-menu adjustments (destructive) › Image › Invert Mask (Cmd-I with the mask selected): menu title changes to "Invert Mask"; inverts the enabled layer mask (or a folder's) inside the selection or wholly; a uniform 1×1 mask is expanded to the layer's grid first; undo "Invert Mask" (CompositorApp.swift:305, Document/SelectionEdits.swift:97-101, Document/SelectionEdits.swift:116-120, Document/SelectionEdits.swift:142-145)
- [x] Filters › Image-menu adjustments (destructive) › Not repeatable: Image-menu adjustments are not recorded as Last Filter (Document/Filters.swift:28-29)

### Gaussian Blur

- [x] Filters › Gaussian Blur › Radius: 0.1…250 px (Gaussian sigma), logarithmic, 1 decimal, default 5 (UI/FilterSheet.swift:89, Document/Filters.swift:64-65, Document/Filters.swift:132)
- [x] Filters › Gaussian Blur › Preserve Transparency toggle: default off; blurs only the colors from the layer's own pixels (alpha-normalized) and keeps the outline/alpha; no padding, layer size unchanged (UI/FilterSheet.swift:90-91, Document/Filters.swift:66-68, Document/Filters.swift:282-294, Document/Filters.swift:900-905)

### Motion Blur

- [x] Filters › Motion Blur › Angle: −90…90°, integer, default 0, counterclockwise from horizontal (UI/FilterSheet.swift:111, Document/Filters.swift:69-70, Document/Filters.swift:133)
- [x] Filters › Motion Blur › Distance: 1…2000 px, logarithmic, integer, default 10; Core Image radius = distance/√12 to match an even streak (UI/FilterSheet.swift:112, Document/Filters.swift:71-72, Document/Filters.swift:235-238, Document/Filters.swift:297-303)

### Progressive Blur

- [x] Filters › Progressive Blur › Hint "Click and drag two points on canvas" (UI/FilterSheet.swift:93-94)
- [x] Filters › Progressive Blur › Shape: segmented Linear / Radial, default Linear; Linear blurs along the line, Radial keeps the start sharp and blurs outward to the circle through the end (UI/FilterSheet.swift:95-103, Document/Filters.swift:81-82, Document/Filters.swift:405-411)
- [x] Filters › Progressive Blur › From: 0…250 px, 1 decimal, default 0 (blur at the line's start) (UI/FilterSheet.swift:104-105, Document/Filters.swift:73-75, Document/Filters.swift:135)
- [x] Filters › Progressive Blur › To: 0…250 px, 1 decimal, default 20 (blur at the end and beyond) (UI/FilterSheet.swift:106-107, Document/Filters.swift:76, Document/Filters.swift:136)
- [x] Filters › Progressive Blur › Invert toggle: default off; swaps From and To (UI/FilterSheet.swift:108-109, Document/Filters.swift:83-84, Document/Filters.swift:401)
- [x] Filters › Progressive Blur › Default line: vertical, from 35% down the layer's visible part (or canvas) to its foot; Last Filter keeps the previous line (Document/Filters.swift:712-720)
- [x] Filters › Progressive Blur › Canvas drag: pressing within 10 pt of the end or start handle drags that end; pressing elsewhere starts a new line there (sharp at the press); Space still pans (Rendering/EditorCanvas.swift:1777-1780, Rendering/EditorCanvas.swift:2488-2499, Document/Filters.swift:761-768)
- [x] Filters › Progressive Blur › Shift constrains the dragged end to 45° steps around the other end (Rendering/EditorCanvas.swift:1875-1882, Rendering/EditorCanvas.swift:2514-2519)
- [x] Filters › Progressive Blur › Overlay: line drawn black/white over the canvas, dashed circle for Radial, solid handle at the sharp start (Rendering/TransformOverlay.swift:90-96, Rendering/TransformOverlay.swift:408-433)
- [x] Filters › Progressive Blur › Rendering: CIMaskedVariableBlur through a linear or radial gradient mask; edge pixels carried on past the canvas edge (Document/Filters.swift:386-415)

### Add Noise

- [x] Filters › Add Noise › Amount: 0.1…400 %, logarithmic, 1 decimal, default 10 (UI/FilterSheet.swift:114, Document/Filters.swift:85-86, Document/Filters.swift:137)
- [x] Filters › Add Noise › Distribution: segmented Uniform / Gaussian, default Uniform (UI/FilterSheet.swift:115-122, Document/Filters.swift:87-88)
- [x] Filters › Add Noise › Monochromatic toggle: default off; same amount on every channel (brightness only) (UI/FilterSheet.swift:123, Document/Filters.swift:89-90)
- [x] Filters › Add Noise › Stable grain while the panel is open: the random seed is fixed for the panel session so changing Amount does not reshuffle it (Document/Filters.swift:457-458, Document/Filters.swift:304-313)

### Vignette

- [x] Filters › Vignette › Color swatch: opens the app color picker; default black; live preview (UI/FilterSheet.swift:129-143, Document/Filters.swift:93, Document/ColorPalette.swift:147-152)
- [x] Filters › Vignette › Amount: 0…100 %, integer, default 35; blends the color into the edges, center unchanged (UI/FilterSheet.swift:144-145, Document/Filters.swift:92, Document/Filters.swift:138)
- [x] Filters › Vignette › Midpoint: 0…100 %, default 50 (UI/FilterSheet.swift:146, Document/Filters.swift:94, Document/Filters.swift:140)
- [x] Filters › Vignette › Roundness: −100…100, default 100 (UI/FilterSheet.swift:147, Document/Filters.swift:95, Document/Filters.swift:141)
- [x] Filters › Vignette › Feather: 0…100 %, default 60 (UI/FilterSheet.swift:148, Document/Filters.swift:96, Document/Filters.swift:142)
- [x] Filters › Vignette › Highlights: 0…100 %, default 25; protects bright areas near the edge (UI/FilterSheet.swift:149-150, Document/Filters.swift:97, Document/Filters.swift:143)
- [x] Filters › Vignette › Framing: frames the layer's own pixels and recolors only those; on an empty layer it frames and fills the whole canvas (Document/Filters.swift:181-183, Document/Filters.swift:314-326)

### Bloom / Glow

- [x] Filters › Bloom / Glow › Amount: 0…100 %, integer, default 40 (CIBloom intensity = amount/50) (UI/FilterSheet.swift:152, Document/Filters.swift:98-99, Document/Filters.swift:144, Document/Filters.swift:327-332)
- [x] Filters › Bloom / Glow › Radius: 1…150 px, logarithmic, integer, default 24; glow spreads past the layer edge (UI/FilterSheet.swift:153, Document/Filters.swift:100, Document/Filters.swift:145, Document/Filters.swift:570)

### Dither

- [x] Filters › Dither › Style menu (grouped by dividers): Atkinson (Classic Mac), Floyd–Steinberg | Bayer 2 × 2, Bayer 4 × 4, Bayer 8 × 8 | Halftone Dots, Halftone Lines, Halftone Diamonds | Mac Patterns, ASCII; default Atkinson (UI/FilterSheet.swift:208-213, Document/Dither.swift:5-22, Document/Dither.swift:54)
- [x] Filters › Dither › Pixel Size: 1…32 px, integer, default 2; chunky pixels (averaged down, dithered, enlarged without smoothing); hidden for ASCII (UI/FilterSheet.swift:214-217, Document/Dither.swift:49, Document/Dither.swift:56, Document/Dither.swift:96-127)
- [x] Filters › Dither › Text Size: 6…64 px, integer, default 14; line height of ASCII characters; ASCII only (UI/FilterSheet.swift:218-221, Document/Dither.swift:51, Document/Dither.swift:61)
- [x] Filters › Dither › Cell Size: 4…64 px, integer, default 8; halftone styles only (UI/FilterSheet.swift:222-224, Document/Dither.swift:50, Document/Dither.swift:59)
- [x] Filters › Dither › Angle: −90…90°, integer, default 45; halftone screen angle; halftone styles only (UI/FilterSheet.swift:225-227, Document/Dither.swift:63, Document/Dither.swift:85)
- [x] Filters › Dither › Characters field: monospaced text field, default " .:-=+*#%@"; any order (sorted by ink coverage), newlines dropped, max 64 characters; drawn in bold monospaced system font; ASCII only (UI/FilterSheet.swift:228-235, Document/Dither.swift:53, Document/Dither.swift:78, Document/Dither.swift:92, Document/Dither.swift:159-183)
- [x] Filters › Dither › Tones: 2…8 per channel, integer, default 2 (2 = pure black and white); diffusion and Bayer styles only (UI/FilterSheet.swift:236-239, Document/Dither.swift:27, Document/Dither.swift:52, Document/Dither.swift:65)
- [x] Filters › Dither › Diffusion: 0…100 %, integer, default 100; error-diffusion styles only (UI/FilterSheet.swift:240-243, Document/Dither.swift:25, Document/Dither.swift:67)
- [x] Filters › Dither › Density: −100…100, integer, default 0; more or less ink before dithering (UI/FilterSheet.swift:244-245, Document/Dither.swift:69)
- [x] Filters › Dither › Contrast: −100…100, integer, default 0 (UI/FilterSheet.swift:246, Document/Dither.swift:70)
- [x] Filters › Dither › Colors menu: Black & White, Two Colors, Original; default Black & White (UI/FilterSheet.swift:249-252, Document/Dither.swift:42-46, Document/Dither.swift:71)
- [x] Filters › Dither › Dark / Light swatches (Two Colors only): open the app color picker; defaults black / white (UI/FilterSheet.swift:253-261, Document/Dither.swift:72-73, Document/ColorPalette.swift:191-199)
- [x] Filters › Dither › Pixel Shape menu: Square, Dot (round dots with the dark color in the gaps); default Square; shown when Pixel Size > 1 and not ASCII (UI/FilterSheet.swift:262-268, Document/Dither.swift:37-40, Document/Dither.swift:57, Document/Dither.swift:119-124)
- [x] Filters › Dither › Light on Dark toggle: default on; marks stand for light tones drawn in the light color on the dark; halftone, Mac Patterns and ASCII only (UI/FilterSheet.swift:269-272, Document/Dither.swift:30, Document/Dither.swift:74-76)

### Scanlines

- [x] Filters › Scanlines › Line Spacing: 2…32 px, integer, default 4 (UI/FilterSheet.swift:277-278, Document/Scanlines.swift:7, Document/Scanlines.swift:12)
- [x] Filters › Scanlines › Thickness: 5…100 %, integer, default 70; dimmer parts draw thinner (UI/FilterSheet.swift:279-280, Document/Scanlines.swift:14)
- [x] Filters › Scanlines › Glow: 0…100 %, integer, default 0; CRT phosphor bloom (blurred lines added back) (UI/FilterSheet.swift:281-282, Document/Scanlines.swift:16, Document/Scanlines.swift:79-97)
- [x] Filters › Scanlines › Dots: 0…100 %, integer, default 0; breaks lines into beads where darker than this (UI/FilterSheet.swift:283-284, Document/Scanlines.swift:18)
- [x] Filters › Scanlines › Displace: −100…100 px, integer, default 0; lifts lines where bright (negative lowers) (UI/FilterSheet.swift:285-286, Document/Scanlines.swift:9, Document/Scanlines.swift:23)
- [x] Filters › Scanlines › Smoothness: 0…100 %, integer, default 50; smoothing of brightness before displacement (UI/FilterSheet.swift:287-288, Document/Scanlines.swift:25)
- [x] Filters › Scanlines › Threshold: 0…100 %, integer, default 0; no line where darker than this (UI/FilterSheet.swift:289-290, Document/Scanlines.swift:27)
- [x] Filters › Scanlines › Wobble: 0…64 px, integer, default 0; lines waver sideways down the screen (UI/FilterSheet.swift:291-292, Document/Scanlines.swift:8, Document/Scanlines.swift:20)
- [x] Filters › Scanlines › Color Split: 0…16 px, integer, default 0; moves red and blue apart (UI/FilterSheet.swift:293-294, Document/Scanlines.swift:10, Document/Scanlines.swift:29)
- [x] Filters › Scanlines › Density: −100…100, integer, default 0 (UI/FilterSheet.swift:295-296, Document/Scanlines.swift:31)
- [x] Filters › Scanlines › Contrast: −100…100, integer, default 0 (UI/FilterSheet.swift:297, Document/Scanlines.swift:32)
- [x] Filters › Scanlines › Black Level: 0…100 %, integer, default 0; line brightness over black (UI/FilterSheet.swift:298-299, Document/Scanlines.swift:34)
- [x] Filters › Scanlines › Colors menu: Black & White, Two Colors, Original; default Black & White (UI/FilterSheet.swift:300-303, Document/Scanlines.swift:35)
- [x] Filters › Scanlines › Dark (screen) / Light (lines) swatches (Two Colors only): app color picker; defaults black / white (UI/FilterSheet.swift:304-312, Document/Scanlines.swift:36-37, Document/ColorPalette.swift:191-199)

### Tonal Contrast

- [x] Filters › Tonal Contrast › Amount: 0…100 %, integer, default 50 (UI/FilterSheet.swift:155, Document/Filters.swift:102, Document/Filters.swift:146)
- [x] Filters › Tonal Contrast › Shadows: −100…100 %, integer, default 40 (UI/FilterSheet.swift:156, Document/Filters.swift:104, Document/Filters.swift:148)
- [x] Filters › Tonal Contrast › Midtones: −100…100 %, integer, default 60 (UI/FilterSheet.swift:157, Document/Filters.swift:105, Document/Filters.swift:149)
- [x] Filters › Tonal Contrast › Highlights: −100…100 %, integer, default 30 (UI/FilterSheet.swift:158, Document/Filters.swift:106, Document/Filters.swift:150)
- [x] Filters › Tonal Contrast › Radius: 1…100 px, logarithmic, integer, default 16; local-detail blur radius (UI/FilterSheet.swift:159, Document/Filters.swift:103, Document/Filters.swift:147, Document/Filters.swift:333-347)

### Lens Correction

- [x] Filters › Lens Correction › Remove Distortion: −100…100, integer, default 0; positive straightens barrel, negative pincushion; ±100 moves corners 35% of their distance from center; help text shown (UI/FilterSheet.swift:161-163, Document/Filters.swift:107-109, Document/Filters.swift:239-240, Document/Filters.swift:348-357)

### Remove Background

- [x] Filters › Remove Background › Description text: "Hide the background behind a layer mask, keeping the foreground subjects…" (UI/FilterSheet.swift:69-70)
- [x] Filters › Remove Background › Quality: segmented Basic / Advanced, default Basic; Basic = Vision subject mask as is, Advanced refines it against the layer's detail (hair, fur) (UI/FilterSheet.swift:71-76, Document/Filters.swift:57-60, Document/Filters.swift:120, Document/SubjectRemoval.swift:45-47)
- [x] Filters › Remove Background › Refine (Advanced): 0…40 px, integer, default 12; guided-filter pull of the mask onto image edges (UI/FilterSheet.swift:78-79, Document/Filters.swift:121-122, Document/Filters.swift:152, Document/SubjectRemoval.swift:50-53)
- [x] Filters › Remove Background › Contrast (Advanced): 0…100 %, integer, default 25; pushes mask grays apart to clear haze (UI/FilterSheet.swift:80-81, Document/Filters.swift:123-124, Document/Filters.swift:153, Document/SubjectRemoval.swift:71-80)
- [x] Filters › Remove Background › Shift Edge (Advanced): −10…10 px, integer, default 0; contracts (negative) or expands the mask edge (UI/FilterSheet.swift:82-83, Document/Filters.swift:125-126, Document/Filters.swift:154, Document/SubjectRemoval.swift:54-70)
- [x] Filters › Remove Background › Preview: the layer with its background made transparent; mask refined on a copy ≤1400 px for responsiveness; the Vision mask is cached while the panel is open (Document/SubjectRemoval.swift:10-25, Document/SubjectRemoval.swift:100-110)
- [x] Filters › Remove Background › Commit as layer mask: OK adds (or replaces the pixels of) a layer mask, subject white and background black, from the full-size image; an existing same-grid mask is combined (either one hides); with a selection only the selected part of the mask changes; the mask is enabled and selected; pixels are kept (Document/Filters.swift:897-899, Document/Filters.swift:998-1033, Document/SubjectRemoval.swift:85-98)
- [x] Filters › Remove Background › No-subject error: "No foreground subject was detected in this layer. Try an image with a more distinct subject." (Document/SubjectRemoval.swift:6-9)

## Camera Raw

### Panel

- [x] Camera Raw › Panel › Open from Filter menu: Filter › Camera Raw Filter… opens the filter on the active layer (destructive filter only; there is no Camera Raw adjustment layer); disabled when colors can't be adjusted or Hue/Saturation is open; beeps if another filter is open (CompositorApp.swift:336-338, Document/Filters.swift:18, Document/Filters.swift:694-696)
- [x] Camera Raw › Panel › Docked placement: the panel is docked full-height flush against the right edge of the main document window, 440 pt wide, and re-docks when that window moves or resizes (never remembers a free position, unlike other filter panels) (ContentView.swift:275, UI/FloatingPanel.swift:125, UI/FloatingPanel.swift:127, UI/FloatingPanel.swift:146, UI/FilterSheet.swift:193-195)
- [x] Camera Raw › Panel › Scrolling column: histogram fixed at top, the ten sections below in a scroll view filling the panel height (UI/CameraRawControls.swift:14-28)
- [x] Camera Raw › Panel › Full-resolution live preview: the preview is rendered on the layer at native size (never downscaled to the preview limit), so detail stays exact during slider drags (Document/Filters.swift:622-624)
- [x] Camera Raw › Panel › OK with no change: if the rendered grade is identity (every visible group at defaults) OK closes like Cancel, with no undo step (Document/Filters.swift:884)
- [x] Camera Raw › Panel › Hidden groups dropped on OK: a section whose eye is off contributes nothing to the applied result (Document/Filters.swift:659-668, Document/Filters.swift:872-875)
- [x] Camera Raw › Panel › Settings remembered: the next Camera Raw open in the session starts from the last applied (rendered) settings, hidden groups reset (in memory only, not persisted) (Document/Filters.swift:711, Document/Filters.swift:875)
- [x] Camera Raw › Panel › Last Filter: after OK, Filter › Last Filter (⌃⌘F) re-applies Camera Raw with the same settings and no panel (Document/Filters.swift:29, Document/Filters.swift:888, Document/Filters.swift:747-760)
- [ ] Camera Raw › Panel › 16-bit / HDR layers: Camera Raw runs on a 16-bit or HDR layer channel-by-channel through the deep-layer path rather than flattening to 8-bit (Document/Filters.swift:35, Document/Filters.swift:951)
- [ ] Camera Raw › Panel › GPU lookup for large previews: previews of 8,000,001 px or more run the composed color table on a Metal compute kernel, falling back to the CPU kernel (Document/Filters.swift:683, Document/Filters.swift:738-739, Rendering/MetalCameraRawLookup.swift:9, Document/CameraRaw.swift:228-231)
- [x] Camera Raw › Panel › Canvas pick cursor: while any Camera Raw eyedropper or guide drawing is armed, the canvas shows the picking cursor; Space still pans (Rendering/EditorCanvas.swift:96-99, Rendering/EditorCanvas.swift:1753-1775)

### Histogram and readout

- [x] Camera Raw › Histogram › RGB histogram: 110 pt graph of red, green and blue ribbons (55% opacity) on a shared vertical scale, 256 bins, counted from the graded preview (excluding Option/indicator paint), sampling every 4th pixel each way up to 4 MP, every 8th above; transparent pixels skipped (UI/CameraRawControls.swift:34-49, UI/CameraRawControls.swift:85-122, Document/CameraRaw.swift:330-369, Document/CameraRaw.swift:380-395)
- [x] Camera Raw › Histogram › Vectorscope mode: Control-click (context menu) the graph to switch between "Histogram" and "Vectorscope" (64 x 64 hue/saturation density, white cells); help text describes each mode (UI/CameraRawControls.swift:50-56, UI/CameraRawControls.swift:95-106, Document/CameraRaw.swift:324-327)
- [x] Camera Raw › Histogram › Shadow clipping indicator: triangle button at the graph's top-left toggles painting clipped shadows blue on the preview (preview only, never baked in) (UI/CameraRawControls.swift:44, UI/CameraRawControls.swift:69-83, Document/CameraRaw.swift:372-377, Document/Filters.swift:498)
- [x] Camera Raw › Histogram › Highlight clipping indicator: triangle button at the graph's top-right toggles painting clipped highlights red on the preview (UI/CameraRawControls.swift:46, UI/CameraRawControls.swift:69-83, Document/Filters.swift:499)
- [x] Camera Raw › Histogram › RGB readout: "R n   G n   B n" (0-255, un-premultiplied) of the adjusted preview pixel under the pointer, "R —   G —   B —" off the layer or on transparent pixels, cleared when the pointer leaves the canvas (UI/CameraRawControls.swift:57-67, Document/CameraRaw.swift:490-507, Rendering/EditorCanvas.swift:1594, Rendering/EditorCanvas.swift:1606-1608)

### Section headers

- [x] Camera Raw › Section headers › Section order and disclosure: ten collapsible sections in this order: Light, Color, Color Grading, Effects, Curve, Color Mixer, Detail, Optics, Geometry, Calibration; chevron header toggles each; Light, Color and Color Grading start expanded (per panel open, not persisted) (UI/CameraRawControls.swift:8, UI/CameraRawControls.swift:124-140, UI/CameraRawControls.swift:416-427)
- [x] Camera Raw › Section headers › Eye toggle per section: an eye / eye.slash button on each of the ten section headers hides that section's effect from the preview (and from OK) without clearing its sliders; shown only while that section changes something (UI/CameraRawControls.swift:141-180, UI/CameraRawControls.swift:304-325, Document/Filters.swift:459-469, Document/CameraRaw.swift:165-199)
- [x] Camera Raw › Section headers › Reset Light: arrow.counterclockwise button resets Exposure, Contrast, Highlights, Shadows, Whites, Blacks; shown only while Light adjusts; disabled while applying (UI/CameraRawControls.swift:141-144, UI/CameraRawControls.swift:328-336, Document/CameraRawReset.swift:37-43)
- [x] Camera Raw › Section headers › Reset Color: resets White Balance mode (to Custom), Temperature, Tint, Vibrance, Saturation (UI/CameraRawControls.swift:145-148, Document/CameraRawReset.swift:44-49)
- [x] Camera Raw › Section headers › Reset Effects: resets Texture, Clarity, Dehaze, Glow amount/style/range/spread/warmth, Vignette amount/style/midpoint/roundness/feather/highlights, Grain amount/size/roughness (UI/CameraRawControls.swift:149-152, Document/CameraRawReset.swift:50-67)
- [x] Camera Raw › Section headers › Reset Curve: resets parametric amounts, dividers, all four point curves and Refine Saturation (UI/CameraRawControls.swift:153-156, Document/CameraRawReset.swift:68)
- [x] Camera Raw › Section headers › Reset Color Mixer: resets all HSL values and removes every point color; selected point index back to 0 (UI/CameraRawControls.swift:157-160, Document/CameraRawReset.swift:69, Document/CameraRawReset.swift:120)
- [x] Camera Raw › Section headers › Reset Color Grading: resets all four wheels, Blending and Balance (UI/CameraRawControls.swift:161-164, Document/CameraRawReset.swift:70)
- [x] Camera Raw › Section headers › Reset Detail: resets sharpening and noise reduction sliders (UI/CameraRawControls.swift:165-168, Document/CameraRawReset.swift:71)
- [x] Camera Raw › Section headers › Reset Optics: resets CA and lens-profile toggles, profile sliders, distortion, defringe and lens vignetting (UI/CameraRawControls.swift:169-172, Document/CameraRawReset.swift:72)
- [x] Camera Raw › Section headers › Reset Geometry: resets Upright, Projection, all sliders, Constrain Crop, removes guides and any guide being drawn (UI/CameraRawControls.swift:173-176, Document/CameraRawReset.swift:73, Document/CameraRawReset.swift:121)
- [x] Camera Raw › Section headers › Reset Calibration: resets Process (to Version 6) and all seven sliders (UI/CameraRawControls.swift:177-180, Document/CameraRawReset.swift:74)
- [x] Camera Raw › Section headers › Reset re-shows section: resetting a section turns its eye back on (Document/CameraRawReset.swift:112-123)

### Slider behaviour (shared by every Camera Raw slider)

- [x] Camera Raw › Slider behaviour › Knob double-click resets: double-clicking the knob restores that slider's default (CameraRawSlider is an NSSlider subclass) (UI/CameraRawSlider.swift:58-60, UI/CameraRawSlider.swift:131-136)
- [x] Camera Raw › Slider behaviour › Track click glides: clicking the track off the knob animates the knob to that value (0.18 s ease-out) and publishes the value once (UI/CameraRawSlider.swift:139-160)
- [x] Camera Raw › Slider behaviour › Gradient tracks: colored tracks replace the system bar across the whole width: Temperature blue to yellow, Tint green to mauve, Vibrance/Saturation gray to red, mixer Hue neighbouring hues ±50°, mixer Saturation gray to family color, mixer Luminance dark to light of family hue (UI/CameraRawSlider.swift:5-49, UI/CameraRawSlider.swift:194-205)
- [x] Camera Raw › Slider behaviour › Label double-click resets: in Light, Color and Effects, double-clicking a slider's title resets it (UI/CameraRawControls.swift:346)
- [x] Camera Raw › Slider behaviour › Label scrub: dragging a slider's title left/right scrubs its value (1 unit per point; Exposure 0.01 per point), with the resize cursor; available on Light, Color, Effects, Curve amounts, HSL family sliders, Detail, Optics, Geometry, Calibration (UI/CameraRawControls.swift:347-349, UI/NumericScrub.swift:5-55)
- [x] Camera Raw › Slider behaviour › Numeric field: a 56 pt right-aligned field beside each slider (48 pt in Curve and HSL) takes typed values; dragged values are rounded to the slider's precision (0 decimals; Exposure 2) while typed values are clamped at render (UI/CameraRawControls.swift:341, UI/CameraRawControls.swift:351-356, Document/CameraRaw.swift:127-162)
- [x] Camera Raw › Slider behaviour › Option clipping view: holding Option while dragging Exposure, Highlights or Whites shows clipped highlights (lit on black); Shadows or Blacks shows clipped shadows (dark on white); releasing Option ends it; never written into the layer (UI/CameraRawControls.swift:372-379, UI/CameraRawControls.swift:394-407, Document/CameraRaw.swift:38-44)
- [x] Camera Raw › Slider behaviour › Help tooltips: every slider, picker and button carries a descriptive help tooltip (e.g. "Brightens or darkens the whole picture, in stops of light. Hold Option to see clipped highlights.") (UI/CameraRawControls.swift:201-212)

### Light

- [x] Camera Raw › Light › Exposure: -5...5 stops, step 0.01 (2 decimals), default 0; Option shows highlight clipping (UI/CameraRawControls.swift:201-202, Document/CameraRaw.swift:48, Document/CameraRaw.swift:58)
- [x] Camera Raw › Light › Contrast: -100...100, step 1, default 0; adapts to the picture's measured brightness (Photoshop-measured tables) (UI/CameraRawControls.swift:203-204, Document/CameraRaw.swift:49, Document/CameraRaw.swift:59, Document/CameraRawTables.swift:172)
- [x] Camera Raw › Light › Highlights: -100...100, step 1, default 0; adaptive to log-brightness; Option shows highlight clipping (UI/CameraRawControls.swift:205-206, Document/CameraRaw.swift:60, Document/CameraRawTables.swift:173-175)
- [x] Camera Raw › Light › Shadows: -100...100, step 1, default 0; region-adaptive pass fitted to Photoshop (separate coefficient set for layers under ~1020 px long side); Option shows shadow clipping (UI/CameraRawControls.swift:207-208, Document/CameraRaw.swift:61, Document/CameraRawShadows.swift:12-71)
- [x] Camera Raw › Light › Whites: -100...100, step 1, default 0; Option shows highlight clipping (UI/CameraRawControls.swift:209-210, Document/CameraRaw.swift:62)
- [x] Camera Raw › Light › Blacks: -100...100, step 1, default 0; Option shows shadow clipping (UI/CameraRawControls.swift:211-212, Document/CameraRaw.swift:63)

### Color

- [x] Camera Raw › Color › White Balance picker: Custom (default; follows Temperature and Tint) or Auto (gray-world average of the original layer's opaque pixels, computed off the main thread, applied only if Auto is still selected); moving Temperature or Tint switches back to Custom; no Kelvin presets (UI/CameraRawControls.swift:219-225, UI/CameraRawControls.swift:362-370, UI/CameraRawControls.swift:377, Document/CameraRaw.swift:5-8, Document/CameraRaw.swift:285-288, Document/CameraRaw.swift:425-439)
- [x] Camera Raw › Color › White Balance Selector: eyedropper toggle; click a pixel of the original layer that should be neutral to solve Temperature/Tint (sets Custom); stays armed until clicked again; caption "Click the original layer. Click the eyedropper again to stop." (UI/CameraRawControls.swift:226-240, Document/CameraRaw.swift:400-421, Rendering/EditorCanvas.swift:1753-1756)
- [x] Camera Raw › Color › Temperature: -100...100 relative (not Kelvin), default 0, positive warmer; blue-to-yellow track (UI/CameraRawControls.swift:241-242, Document/CameraRaw.swift:53-54)
- [x] Camera Raw › Color › Tint: -100...100, default 0, positive magenta; green-to-mauve track (UI/CameraRawControls.swift:243-244, Document/CameraRaw.swift:55-56)
- [x] Camera Raw › Color › Vibrance: -100...100, default 0; boosts muted colors more, protects skin; gray-to-red track (UI/CameraRawControls.swift:245-246, Document/CameraRaw.swift:64)
- [x] Camera Raw › Color › Saturation: -100...100, default 0; uniform; gray-to-red track (UI/CameraRawControls.swift:247-248, Document/CameraRaw.swift:65)

### Color Grading

- [x] Camera Raw › Color Grading › View menu: pop-up menu Three-Way (default; Shadows, Midtones, Highlights side by side) / Shadows / Midtones / Highlights / Global (one wheel); Global is reachable only from this menu (UI/CameraRawColorControls.swift:435-450, Document/CameraRawColor.swift:7-9)
- [x] Camera Raw › Color Grading › Wheel interaction: 86 pt hue wheel; drag inside sets hue by angle (counterclockwise from red at the right, 0...360°) and saturation by distance (0...100); double-click resets hue and saturation; "h°  s" readout under each wheel (UI/CameraRawColorControls.swift:469-479, UI/CameraRawColorControls.swift:502-537)
- [x] Camera Raw › Color Grading › Shadows wheel: hue 0...360, saturation 0...100, default 0/0 (UI/CameraRawColorControls.swift:444, Document/CameraRawColor.swift:232, Document/CameraRawColor.swift:260-268)
- [x] Camera Raw › Color Grading › Shadows luminance: slider -100...100, default 0, under the wheel (96 pt) (UI/CameraRawColorControls.swift:481-484, Document/CameraRawColor.swift:263)
- [x] Camera Raw › Color Grading › Midtones wheel: hue 0...360, saturation 0...100, default 0/0 (UI/CameraRawColorControls.swift:445, Document/CameraRawColor.swift:233)
- [x] Camera Raw › Color Grading › Midtones luminance: -100...100, default 0 (UI/CameraRawColorControls.swift:481-484)
- [x] Camera Raw › Color Grading › Highlights wheel: hue 0...360, saturation 0...100, default 0/0 (UI/CameraRawColorControls.swift:446, Document/CameraRawColor.swift:234)
- [x] Camera Raw › Color Grading › Highlights luminance: -100...100, default 0 (UI/CameraRawColorControls.swift:481-484)
- [x] Camera Raw › Color Grading › Global wheel: hue 0...360, saturation 0...100, default 0/0 (UI/CameraRawColorControls.swift:449, Document/CameraRawColor.swift:235)
- [x] Camera Raw › Color Grading › Global luminance: -100...100, default 0 (UI/CameraRawColorControls.swift:481-484)
- [x] Camera Raw › Color Grading › Blending: 0...100, default 50; how much the three tonal wheels overlap (UI/CameraRawColorControls.swift:451-453, Document/CameraRawColor.swift:236-237)
- [x] Camera Raw › Color Grading › Balance: -100...100, default 0; negative favors shadows, positive highlights (UI/CameraRawColorControls.swift:454-456, Document/CameraRawColor.swift:238-239)

### Effects

- [x] Camera Raw › Effects › Texture: -100...100, default 0; fine-band local contrast (UI/CameraRawControls.swift:254-255, Document/CameraRaw.swift:66-67)
- [x] Camera Raw › Effects › Clarity: -100...100, default 0; broad-band local contrast (UI/CameraRawControls.swift:256-257, Document/CameraRaw.swift:68)
- [x] Camera Raw › Effects › Dehaze: -100...100, default 0; positive clears haze, negative adds it (UI/CameraRawControls.swift:258-259, Document/CameraRaw.swift:69-70)
- [x] Camera Raw › Effects › Glow amount: 0...100, default 0; Range/Spread/Warmth idle while 0 (UI/CameraRawControls.swift:260-262, Document/CameraRaw.swift:71-72)
- [x] Camera Raw › Effects › Glow Style: Diffusion (default, soft and wide) / Bloom (tighter) / Halation (red fringe) (UI/CameraRawControls.swift:263-266, Document/CameraRaw.swift:11-14)
- [x] Camera Raw › Effects › Glow Range: -100...100, default 0; brightness threshold to glow (UI/CameraRawControls.swift:268-269, Document/CameraRaw.swift:74)
- [x] Camera Raw › Effects › Glow Spread: -100...100, default 0; how far the glow reaches (UI/CameraRawControls.swift:270-271, Document/CameraRaw.swift:75)
- [x] Camera Raw › Effects › Glow Warmth: -100...100, default 0; cool to warm (Halation stays red) (UI/CameraRawControls.swift:272-273, Document/CameraRaw.swift:76)
- [x] Camera Raw › Effects › Vignette Amount: -100...100, default 0; negative darkens edges, positive lightens; center untouched (post-crop vignette) (UI/CameraRawControls.swift:276-278, Document/CameraRaw.swift:77-78)
- [x] Camera Raw › Effects › Vignette Style: Highlight Priority (default; protects bright edges) / Color Priority (also reduces color) / Paint Overlay (even cover) (UI/CameraRawControls.swift:279-282, Document/CameraRaw.swift:25-28)
- [x] Camera Raw › Effects › Vignette Midpoint: 0...100, default 50 (UI/CameraRawControls.swift:284-285, Document/CameraRaw.swift:80)
- [x] Camera Raw › Effects › Vignette Roundness: -100...100, default 0; rounder vs more square (UI/CameraRawControls.swift:286-287, Document/CameraRaw.swift:81)
- [x] Camera Raw › Effects › Vignette Feather: 0...100, default 50 (UI/CameraRawControls.swift:288-289, Document/CameraRaw.swift:82)
- [x] Camera Raw › Effects › Vignette Highlights: 0...100, default 0; protects bright pixels, only for Highlight Priority while darkening (UI/CameraRawControls.swift:290-291, Document/CameraRaw.swift:83-84)
- [x] Camera Raw › Effects › Grain Amount: 0...100, default 0; strongest in midtones; pattern fixed by a per-panel seed (UI/CameraRawControls.swift:294-296, Document/CameraRaw.swift:85-86, Document/CameraRaw.swift:266-269)
- [x] Camera Raw › Effects › Grain Size: 0...100, default 25; maps to kernel size 0.5 + size/100 x 19.5 px (UI/CameraRawControls.swift:297-298, Document/CameraRaw.swift:87, Document/CameraRaw.swift:202)
- [x] Camera Raw › Effects › Grain Roughness: 0...100, default 50 (UI/CameraRawControls.swift:299-300, Document/CameraRaw.swift:88)

### Curve

- [x] Camera Raw › Curve › Mode: segmented Parametric (default) / Point (UI/CameraRawColorControls.swift:15-20, Document/CameraRawColor.swift:3)
- [x] Camera Raw › Curve › Point channel: segmented RGB (default) / Red / Green / Blue, shown in Point mode; switching clears the selected point (UI/CameraRawColorControls.swift:21-29, Document/CameraRawColor.swift:4)
- [x] Camera Raw › Curve › Curve graph: 150 pt graph with diagonal reference; parametric shows the curve and three white divider ticks; point mode shows the channel's curve and its points (selected one in accent color) (UI/CameraRawColorControls.swift:30-34, UI/CameraRawColorControls.swift:65-107)
- [x] Camera Raw › Curve › Parametric region drag: dragging in the graph raises/lowers the tonal region under the press (Shadows/Darks/Lights/Highlights by divider), 200 units per graph height (UI/CameraRawColorControls.swift:150-159, UI/CameraRawColorControls.swift:197-199)
- [x] Camera Raw › Curve › Parametric dividers: pressing within 18 pt of the bottom drags the nearest of three dividers (defaults 25/50/75 %), kept in order 2 % apart; stored range shadow 5...90, dark shadow+2...95, light dark+2...98 (UI/CameraRawColorControls.swift:153-154, UI/CameraRawColorControls.swift:187-196, Document/CameraRawColor.swift:24-27, Document/CameraRawColor.swift:124-126)
- [x] Camera Raw › Curve › Highlights: -100...100, default 0 (parametric) (UI/CameraRawColorControls.swift:36, Document/CameraRawColor.swift:23)
- [x] Camera Raw › Curve › Lights: -100...100, default 0 (parametric) (UI/CameraRawColorControls.swift:37, Document/CameraRawColor.swift:22)
- [x] Camera Raw › Curve › Darks: -100...100, default 0 (parametric) (UI/CameraRawColorControls.swift:38, Document/CameraRawColor.swift:21)
- [x] Camera Raw › Curve › Shadows: -100...100, default 0 (parametric) (UI/CameraRawColorControls.swift:39, Document/CameraRawColor.swift:20)
- [x] Camera Raw › Curve › Add point: in Point mode, pressing off a point adds one there (max 16 points, x within 0.01...0.99 and at least 0.01 from others) and drags it (UI/CameraRawColorControls.swift:162-175)
- [x] Camera Raw › Curve › Drag point: pressing within 0.055 of a point selects and drags it; end points move vertically only; inner points keep order (UI/CameraRawColorControls.swift:166, UI/CameraRawColorControls.swift:180-186)
- [x] Camera Raw › Curve › Remove point: double-click an inner point (within 0.04 in x) to delete it (UI/CameraRawColorControls.swift:100-103, UI/CameraRawColorControls.swift:204-212)
- [x] Camera Raw › Curve › In/Out readout: "In n   Out n" (0-255) of the selected point (UI/CameraRawColorControls.swift:41-46)
- [x] Camera Raw › Curve › Preset: Custom / Linear / Medium Contrast ((0.25,0.18),(0.75,0.82)) / Strong Contrast ((0.25,0.10),(0.75,0.90)); replaces the current channel's curve; shows Custom when edited (UI/CameraRawColorControls.swift:47-53, UI/CameraRawColorControls.swift:244-260, Document/CameraRawColor.swift:35-37)
- [x] Camera Raw › Curve › Refine Saturation: -100...100, default 0, RGB channel of Point mode only; how much the composite curve also changes saturation (UI/CameraRawColorControls.swift:54-56, Document/CameraRawColor.swift:32-33)
- [x] Camera Raw › Curve › Targeted Adjustment: "Targeted Adjustment" (scope icon) toggle; then dragging up/down on the picture moves the parametric region (or nudges the nearest existing point of the current channel) for the tone under the press, 0.35 per pt; turning it on turns off the mixer's (UI/CameraRawColorControls.swift:58-61, UI/CameraRawColorControls.swift:230-235, Document/CameraRaw.swift:509-525, Rendering/EditorCanvas.swift:1772-1775, Rendering/EditorCanvas.swift:1871-1872)

### Color Mixer

- [x] Camera Raw › Color Mixer › Mode: segmented HSL (default) / Color / Point Color (UI/CameraRawColorControls.swift:274-279, Document/CameraRawColor.swift:5)
- [x] Camera Raw › Color Mixer › HSL component: segmented Hue (default) / Saturation / Luminance; the eight family sliders below edit that component (UI/CameraRawColorControls.swift:282-287, Document/CameraRawColor.swift:6)
- [x] Camera Raw › Color Mixer › Reds: hue/saturation/luminance -100...100, default 0, center 0° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-163)
- [x] Camera Raw › Color Mixer › Oranges: hue/saturation/luminance -100...100, default 0, center 30° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-160)
- [x] Camera Raw › Color Mixer › Yellows: hue/saturation/luminance -100...100, default 0, center 60° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-160)
- [x] Camera Raw › Color Mixer › Greens: hue/saturation/luminance -100...100, default 0, center 120° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-160)
- [x] Camera Raw › Color Mixer › Aquas: hue/saturation/luminance -100...100, default 0, center 180° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-160)
- [x] Camera Raw › Color Mixer › Blues: hue/saturation/luminance -100...100, default 0, center 240° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-160)
- [x] Camera Raw › Color Mixer › Purples: hue/saturation/luminance -100...100, default 0, center 270° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-160)
- [x] Camera Raw › Color Mixer › Magentas: hue/saturation/luminance -100...100, default 0, center 300° (UI/CameraRawColorControls.swift:316-331, Document/CameraRawColor.swift:159-160)
- [x] Camera Raw › Color Mixer › Color page swatches: eight colored circles (one per family) select the family to edit; selected ringed in white (UI/CameraRawColorControls.swift:288-289, UI/CameraRawColorControls.swift:340-354)
- [x] Camera Raw › Color Mixer › Color page Hue: -100...100, default 0, for the selected family (no field, no scrub) (UI/CameraRawColorControls.swift:290, UI/CameraRawColorControls.swift:306-314)
- [x] Camera Raw › Color Mixer › Color page Saturation: -100...100, default 0 (UI/CameraRawColorControls.swift:291)
- [x] Camera Raw › Color Mixer › Color page Luminance: -100...100, default 0 (UI/CameraRawColorControls.swift:292)
- [x] Camera Raw › Color Mixer › Point Color eyedropper: toggle; clicking the picture samples a color (hue, saturation, luminance) into the selected point color, or appends a new one if none is selected (cap 8; in practice the click replaces the selected one) (UI/CameraRawColorControls.swift:359-364, Document/CameraRaw.swift:542-556, Rendering/EditorCanvas.swift:1758-1761)
- [x] Camera Raw › Color Mixer › Point Color swatches: one circle per picked color; click to select it (UI/CameraRawColorControls.swift:365-374)
- [x] Camera Raw › Color Mixer › Hue Shift: -100...100, default 0; hue track around the picked color (UI/CameraRawColorControls.swift:377-378, Document/CameraRawColor.swift:207)
- [x] Camera Raw › Color Mixer › Saturation Shift: -100...100, default 0 (UI/CameraRawColorControls.swift:379-380, Document/CameraRawColor.swift:208)
- [x] Camera Raw › Color Mixer › Luminance Shift: -100...100, default 0 (UI/CameraRawColorControls.swift:381-382, Document/CameraRawColor.swift:209)
- [x] Camera Raw › Color Mixer › Hue Range: 5...180°, default 30 (UI/CameraRawColorControls.swift:383, Document/CameraRawColor.swift:210, Document/CameraRawColor.swift:223)
- [x] Camera Raw › Color Mixer › Saturation Range: 0.05...1, default 0.4 (UI/CameraRawColorControls.swift:384, Document/CameraRawColor.swift:211, Document/CameraRawColor.swift:224)
- [x] Camera Raw › Color Mixer › Luminance Range: 0.05...1, default 0.4 (UI/CameraRawColorControls.swift:385, Document/CameraRawColor.swift:212, Document/CameraRawColor.swift:225)
- [x] Camera Raw › Color Mixer › Visualize Range: toggle dims the preview outside the selected point color's range; not kept on OK (UI/CameraRawColorControls.swift:386-388, Document/Filters.swift:481-485)
- [x] Camera Raw › Color Mixer › Targeted Adjustment: toggle; dragging a color up/down on the picture moves the current HSL component of the families around that hue (40° falloff, neighbours move together), 0.35 per pt; turns off the curve's (UI/CameraRawColorControls.swift:296-302, Document/CameraRaw.swift:526-538, Document/CameraRawColor.swift:172-178)

### Detail

- [x] Camera Raw › Detail › Sharpening Amount: 0...150, default 0 (UI/CameraRawDetailOpticsControls.swift:12-13, Document/CameraRawDetailOptics.swift:5, Document/CameraRawDetailOptics.swift:16)
- [x] Camera Raw › Detail › Sharpening Radius: 0...100, default 10 (UI/CameraRawDetailOpticsControls.swift:14-15, Document/CameraRawDetailOptics.swift:6)
- [x] Camera Raw › Detail › Sharpening Detail: 0...100, default 25 (UI/CameraRawDetailOpticsControls.swift:16-17, Document/CameraRawDetailOptics.swift:7)
- [x] Camera Raw › Detail › Sharpening Masking: 0...100, default 0; holding Option while dragging shows the sharpening edge mask on the preview (UI/CameraRawDetailOpticsControls.swift:18-19, UI/CameraRawDetailOpticsControls.swift:70-77, Document/CameraRawDetailOptics.swift:8, Document/CameraRawDetailOptics.swift:103-107)
- [x] Camera Raw › Detail › Noise Reduction Luminance: 0...100, default 0 (UI/CameraRawDetailOpticsControls.swift:21-22, Document/CameraRawDetailOptics.swift:9)
- [x] Camera Raw › Detail › Luminance Detail: 0...100, default 50; dimmed and disabled until Luminance > 0 (UI/CameraRawDetailOpticsControls.swift:24-25, UI/CameraRawDetailOpticsControls.swift:29-30, Document/CameraRawDetailOptics.swift:10)
- [x] Camera Raw › Detail › Luminance Contrast: 0...100, default 0; disabled until Luminance > 0 (UI/CameraRawDetailOpticsControls.swift:26-27, Document/CameraRawDetailOptics.swift:11)
- [x] Camera Raw › Detail › Noise Reduction Color: 0...100, default 0 (UI/CameraRawDetailOpticsControls.swift:31-32, Document/CameraRawDetailOptics.swift:12)
- [x] Camera Raw › Detail › Color Detail: 0...100, default 50; disabled until Color > 0 (UI/CameraRawDetailOpticsControls.swift:34-35, UI/CameraRawDetailOpticsControls.swift:39-40, Document/CameraRawDetailOptics.swift:13)
- [x] Camera Raw › Detail › Color Smoothness: 0...100, default 50; disabled until Color > 0 (UI/CameraRawDetailOpticsControls.swift:36-37, Document/CameraRawDetailOptics.swift:14)

### Optics

- [x] Camera Raw › Optics › Remove Chromatic Aberration: checkbox, default off (UI/CameraRawDetailOpticsControls.swift:93-94, Document/CameraRawDetailOptics.swift:44)
- [x] Camera Raw › Optics › Enable Lens Profile Corrections: checkbox, default off; no lens metadata is read, so it applies a generic strength; shows the note "No lens metadata on this layer..." (UI/CameraRawDetailOpticsControls.swift:95-99, Document/CameraRawDetailOptics.swift:41-45)
- [x] Camera Raw › Optics › Profile Distortion: 0...100, default 100; visible only with the profile on (UI/CameraRawDetailOpticsControls.swift:100-101, Document/CameraRawDetailOptics.swift:46)
- [x] Camera Raw › Optics › Profile Vignetting: 0...100, default 100; visible only with the profile on (UI/CameraRawDetailOpticsControls.swift:102-103, Document/CameraRawDetailOptics.swift:47)
- [x] Camera Raw › Optics › Manual Distortion: -100...100, default 0; barrel/pincushion, same sign as Lens Correction filter (UI/CameraRawDetailOpticsControls.swift:105-107, Document/CameraRawDetailOptics.swift:48-49)
- [x] Camera Raw › Optics › Defringe eyedropper: toggle; click a fringe on the layer: centers the purple (near 290°) or green (near 90°) hue range ±25° on its hue and sets that Amount to 50 if it was 0; caption while armed (UI/CameraRawDetailOpticsControls.swift:108-124, Document/CameraRaw.swift:442-474, Rendering/EditorCanvas.swift:1763-1766)
- [x] Camera Raw › Optics › Purple Amount: 0...100, default 0 (UI/CameraRawDetailOpticsControls.swift:125-126, Document/CameraRawDetailOptics.swift:50)
- [x] Camera Raw › Optics › Purple Hue range: Low and High sliders 0...360°, step 1, defaults 270/310; swapped if crossed (UI/CameraRawDetailOpticsControls.swift:127-128, UI/CameraRawDetailOpticsControls.swift:164-182, Document/CameraRawDetailOptics.swift:51-53, Document/CameraRawDetailOptics.swift:83)
- [x] Camera Raw › Optics › Green Amount: 0...100, default 0 (UI/CameraRawDetailOpticsControls.swift:129-130, Document/CameraRawDetailOptics.swift:54)
- [x] Camera Raw › Optics › Green Hue range: Low and High 0...360°, defaults 60/120; swapped if crossed (UI/CameraRawDetailOpticsControls.swift:131-132, Document/CameraRawDetailOptics.swift:55-56, Document/CameraRawDetailOptics.swift:84)
- [x] Camera Raw › Optics › Lens Vignetting: -100...100, default 0; brightens/darkens corners (UI/CameraRawDetailOpticsControls.swift:133-134, Document/CameraRawDetailOptics.swift:57-58)
- [x] Camera Raw › Optics › Vignetting Midpoint: 0...100, default 50 (UI/CameraRawDetailOpticsControls.swift:135-136, Document/CameraRawDetailOptics.swift:59)

### Geometry

- [x] Camera Raw › Geometry › Upright: segmented Off (default) / Guided; leaving Guided stops guide drawing (UI/CameraRawGeometryCalibrationControls.swift:11-17, UI/CameraRawGeometryCalibrationControls.swift:54-59, Document/CameraRawGeometryCalibration.swift:4-7)
- [x] Camera Raw › Geometry › Draw Guides: toggle button (Guided only); drag on the layer to place a guide line (normalized coordinates); committing a line sets Upright to Guided; first guide sets rotation, a second sets a fixed ±25 vertical or horizontal correction; guides are not drawn on the canvas (UI/CameraRawGeometryCalibrationControls.swift:18-30, Document/CameraRaw.swift:558-579, Document/CameraRawGeometryCalibration.swift:112-132, Rendering/EditorCanvas.swift:1768-1770, Rendering/EditorCanvas.swift:1866-1868, Rendering/EditorCanvas.swift:2094-2095)
- [x] Camera Raw › Geometry › Clear Guides: removes every guide line; shown when any exist (UI/CameraRawGeometryCalibrationControls.swift:31-36)
- [x] Camera Raw › Geometry › Projection: Perspective (default, stronger keystone) / Rectilinear (gentler, 0.55 strength) (UI/CameraRawGeometryCalibrationControls.swift:38-41, Document/CameraRawGeometryCalibration.swift:9-12, Document/CameraRawGeometryCalibration.swift:137)
- [x] Camera Raw › Geometry › Vertical: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:42, Document/CameraRawGeometryCalibration.swift:28)
- [x] Camera Raw › Geometry › Horizontal: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:43, Document/CameraRawGeometryCalibration.swift:29)
- [x] Camera Raw › Geometry › Rotate: -45...45°, default 0 (UI/CameraRawGeometryCalibrationControls.swift:44, Document/CameraRawGeometryCalibration.swift:30, Document/CameraRawGeometryCalibration.swift:39)
- [x] Camera Raw › Geometry › Aspect: -100...100, default 0; stretches width vs height (UI/CameraRawGeometryCalibrationControls.swift:45, Document/CameraRawGeometryCalibration.swift:31)
- [x] Camera Raw › Geometry › Scale: -100...100, default 0 (zoom 1 + s/100) (UI/CameraRawGeometryCalibrationControls.swift:46, Document/CameraRawGeometryCalibration.swift:32, Document/CameraRawGeometryCalibration.swift:141)
- [x] Camera Raw › Geometry › Offset X: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:47, Document/CameraRawGeometryCalibration.swift:33)
- [x] Camera Raw › Geometry › Offset Y: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:48, Document/CameraRawGeometryCalibration.swift:34)
- [x] Camera Raw › Geometry › Constrain Crop: checkbox, default off; trims empty edges after the warp and fits the result back into the layer frame (UI/CameraRawGeometryCalibrationControls.swift:49-50, Document/CameraRawGeometryCalibration.swift:35, Document/CameraRawGeometryCalibration.swift:84-99)

### Calibration

- [x] Camera Raw › Calibration › Process: Version 1...Version 6 (default Version 6) with a one-line summary under it; only scales Shadows Tint in code (primaries use measured tables regardless) (UI/CameraRawGeometryCalibrationControls.swift:97-105, Document/CameraRawGeometryCalibration.swift:175-210, Document/CameraRawGeometryCalibration.swift:245-253)
- [x] Camera Raw › Calibration › Shadows Tint: -100...100, default 0; green to magenta in the darkest tones (UI/CameraRawGeometryCalibrationControls.swift:106-107, Document/CameraRawGeometryCalibration.swift:214)
- [x] Camera Raw › Calibration › Red Primary Hue: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:108-109, Document/CameraRawGeometryCalibration.swift:215)
- [x] Camera Raw › Calibration › Red Primary Saturation: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:110, Document/CameraRawGeometryCalibration.swift:216)
- [x] Camera Raw › Calibration › Green Primary Hue: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:111-112, Document/CameraRawGeometryCalibration.swift:217)
- [x] Camera Raw › Calibration › Green Primary Saturation: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:113, Document/CameraRawGeometryCalibration.swift:218)
- [x] Camera Raw › Calibration › Blue Primary Hue: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:114-115, Document/CameraRawGeometryCalibration.swift:219)
- [x] Camera Raw › Calibration › Blue Primary Saturation: -100...100, default 0 (UI/CameraRawGeometryCalibrationControls.swift:116, Document/CameraRawGeometryCalibration.swift:220)

### Rendering (parity-critical behaviour)

- [x] Camera Raw › Rendering › Pipeline order: Geometry warp, then Calibration Shadows Tint, then composed table stages (Calibration primaries, Exposure, White Balance, Contrast, Highlights), Shadows pass, remaining stages (Whites, Blacks, Saturation, Vibrance, parametric curve), Curve/Mixer/Grading (folded into the table unless point colors or Refine Saturation are used), Effects (texture, clarity, dehaze, glow, vignette), Grain, Optics, Detail (Document/CameraRaw.swift:208-276, Document/CameraRawTables.swift:153-187)
- [x] Camera Raw › Rendering › Photoshop-measured lookup tables: Light, Color, Mixer, Calibration primaries, parametric curve and Color Grading come from 763 bundled 17x17x17 color tables (Resources/CameraRawTables.bin, "CRT3", LZMA) blended between measured slider values on a 33-cell grid; Shadows from fitted coefficients (Resources/CameraRawShadows.bin, "CRS2"); a port must ship and decode both (Document/CameraRawTables.swift:4-64, Document/CameraRawShadows.swift:23-44)
- [x] Camera Raw › Rendering › Identity passthrough: settings at defaults (with no Option/visualize overlay) leave the image untouched; invalid (non-finite/out-of-range) values throw (Document/CameraRaw.swift:113-126, Document/CameraRaw.swift:210-212)

## Image/Canvas commands

### Image Size

- [x] Image/Canvas commands › Image Size › Image › Image Size… (Opt-Cmd-I) opens a sheet on the window; disabled with no document or while another project operation runs (CompositorApp.swift:312-314, IO/ProjectController.swift:133-147)
- [x] Image/Canvas commands › Image Size › "Current: W × H pixels" readout (UI/ImageSizeSheet.swift:108)
- [x] Image/Canvas commands › Image Size › Units picker: Pixels (default), Percent, Inches, Centimeters; Pixels and Percent are hidden when Resample is off (UI/ImageSizeSheet.swift:14-16, 109-111)
- [x] Image/Canvas commands › Image Size › Width field: in the chosen unit, up to 3 decimals; label scrubbable (range derived from 1...30,000 px and area limit, sensitivity per unit) (UI/ImageSizeSheet.swift:113-118, 65-102)
- [x] Image/Canvas commands › Image Size › Height field: same as Width (UI/ImageSizeSheet.swift:119-125)
- [x] Image/Canvas commands › Image Size › Lock aspect ratio toggle: default on; disabled (and forced on) when Resample is off (UI/ImageSizeSheet.swift:12, 126, 140-146)
- [x] Image/Canvas commands › Image Size › Resolution field: pixels/inch, 1...9,600, default the document's resolution (72 for new canvases); label scrubbable; with Resample on in Inches/cm, changing resolution rescales the pixel dimensions (UI/ImageSizeSheet.swift:23, 127-139, Document/EditorSession.swift:66)
- [x] Image/Canvas commands › Image Size › Resample toggle: default on; turning it off resets to the original pixel size, locks the ratio and switches units to Inches; then only print size/resolution change and pixels stay unchanged (UI/ImageSizeSheet.swift:13, 140-157, IO/ImageResizer.swift:21-24)
- [x] Image/Canvas commands › Image Size › Sampling picker (Resample on): Nearest, Smooth, High quality (default High quality) (UI/ImageSizeSheet.swift:15, 148-151)
- [x] Image/Canvas commands › Image Size › Explanatory text: "Resizes layer pixels and applies existing transforms. Undo restores the originals." / "Only print dimensions and resolution change. Pixels stay unchanged." (UI/ImageSizeSheet.swift:152-157)
- [x] Image/Canvas commands › Image Size › Result line "Result: W × H pixels", or orange validation "Use 1–30,000 pixels per side, up to 200 megapixels, and 1–9,600 pixels/inch." (UI/ImageSizeSheet.swift:27-31, 158-159, Document/DocumentLimits.swift:18-28)
- [x] Image/Canvas commands › Image Size › Cancel (Escape) / Resize (Return, disabled when invalid) (UI/ImageSizeSheet.swift:160-168)
- [x] Image/Canvas commands › Image Size › Resampling behaviour: every layer is rasterized at the new scale with its transform baked in (result axis-aligned, sampling stored on the layer); 16-bit/HDR layers resample at their depth; masks resample (uniform 1x1 masks and placed masks keep pixels, placement scaled); guides scale; layer effects scale by sqrt(sx*sy); live text and shape layers become plain pixels; per-document pixel budget enforced (IO/ImageResizer.swift:14-104, Document/DocumentLimits.swift:30-37)
- [x] Image/Canvas commands › Image Size › Applied as one undo step "Image Size" and the view refits; failure shows "Couldn’t resize the image" alert (IO/ImageResizer.swift:107-120, IO/ProjectController.swift:148-152)

### Canvas Size

- [x] Image/Canvas commands › Canvas Size › Image › Canvas Size… (Opt-Cmd-C) opens a sheet; disabled with no document or during a project operation (CompositorApp.swift:309-311, IO/ProjectController.swift:111-125)
- [x] Image/Canvas commands › Canvas Size › Current size readout and uncompressed RGBA memory (W*H*4 bytes) (UI/CanvasSizeSheet.swift:70-72, 49-51)
- [x] Image/Canvas commands › Canvas Size › Units picker: Pixels (default), Percent, Inches, Centimeters (inches/cm use the document resolution) (UI/CanvasSizeSheet.swift:74-76, Document/CanvasSize.swift:4-6, 16)
- [x] Image/Canvas commands › Canvas Size › Width field (up to 3 decimals, label scrubbable within 1...30,000 px) (UI/CanvasSizeSheet.swift:77-81, 25-48)
- [x] Image/Canvas commands › Canvas Size › Height field (same) (UI/CanvasSizeSheet.swift:82-86)
- [x] Image/Canvas commands › Canvas Size › "Relative to current dimensions" toggle: default off; fields show/enter the change rather than the total (UI/CanvasSizeSheet.swift:87, Document/CanvasSize.swift:14, 31-59)
- [x] Image/Canvas commands › Canvas Size › "Lock original aspect ratio" toggle: default off; turning on re-derives height from width (UI/CanvasSizeSheet.swift:88-91, Document/CanvasSize.swift:15, 52-58)
- [x] Image/Canvas commands › Canvas Size › New size line with memory, or orange "Final dimensions must be 1–30,000 pixels per side." (UI/CanvasSizeSheet.swift:92-98, Document/CanvasSize.swift:26-29)
- [x] Image/Canvas commands › Canvas Size › Anchor 3x3 grid: Top left, Top center, Top right, Middle left, Center (default), Middle right, Bottom left, Bottom center, Bottom right; name shown with "Keeps this point fixed. Artwork is not scaled; cropped content remains outside the canvas."; odd extra pixel goes right/bottom when growing (UI/CanvasSizeSheet.swift:9, 12, 99-124, Document/CanvasSize.swift:62-76)
- [x] Image/Canvas commands › Canvas Size › Canvas extension picker: Transparent (default), Foreground, Background, Black, White, Custom (UI/CanvasSizeSheet.swift:10, 52-64, 125-127)
- [x] Image/Canvas commands › Canvas Size › Custom extension color swatch (opens the color picker, default white) (UI/CanvasSizeSheet.swift:11, 128-134)
- [x] Image/Canvas commands › Canvas Size › Cancel (Escape) / OK (Return, disabled when invalid) (UI/CanvasSizeSheet.swift:135-143)
- [x] Image/Canvas commands › Canvas Size › Behaviour: layers, mask placements and guides are offset, never scaled; content past the new edges is kept off-canvas; a non-transparent extension (only when growing) is added as a bottom "Canvas Extension" layer filled with the color except over the old canvas area; pixel budget and 10,000-layer limits; undo "Canvas Size"; view refits; failure alert "Couldn’t change canvas size" (IO/CanvasResizer.swift:7-72, IO/ProjectController.swift:126-130, IO/ImageResizer.swift:112-120)

### Crop (command/apply)

- [x] Image/Canvas commands › Crop › Apply Crop (header button or Return with the Crop tool) resizes the canvas to the frame, shifting layers by the frame origin without resampling (content outside stays off-canvas, frame may also enlarge the canvas); one undo step "Crop"; view refits (Document/Crop.swift:236-248, UI/CropControls.swift:20-21)
- [x] Image/Canvas commands › Crop › Failure shows the "Couldn’t crop" alert (ContentView.swift:301-304, Document/Crop.swift:247)

### Trim

- [x] Image/Canvas commands › Trim › Image › Trim… (no default shortcut) opens a sheet; disabled with no document or during a project operation (CompositorApp.swift:315-316, IO/ProjectController.swift:155-169)
- [x] Image/Canvas commands › Trim › Based On (radio group): Transparent Pixels (default), Top Left Pixel Color, Bottom Right Pixel Color (UI/TrimSheet.swift:5, 17-26, Document/ImageTrim.swift:4-10)
- [x] Image/Canvas commands › Trim › Trim Away toggles Top, Bottom, Left, Right (all on by default); OK disabled when all are off (UI/TrimSheet.swift:6-9, 30-42, 62)
- [x] Image/Canvas commands › Trim › Cancel (Escape) / OK (Return) (UI/TrimSheet.swift:46-61)
- [x] Image/Canvas commands › Trim › Behaviour: trims by the flattened composite of the whole document; color modes match RGBA exactly (tolerance 0, not exposed); applied as a canvas resize (no resampling); a fully transparent / single-color image or nothing to trim leaves the document unchanged silently; undo "Trim"; failure alert "Couldn’t trim image" (Document/ImageTrim.swift:12-39, 55-209, IO/ProjectController.swift:170-176)

### Rotate/Flip canvas

- [x] Image/Canvas commands › Rotate/Flip canvas › Image › Rotate Canvas 90° Clockwise: width and height swap; every layer, folder and placed mask is re-placed (rotation +90°, no resampling); guides swap axis; the selection turns; view refits; one undo step; disabled unless layers editable (CompositorApp.swift:319-320, Document/CanvasRotation.swift:1-61)
- [x] Image/Canvas commands › Rotate/Flip canvas › Image › Rotate Canvas 90° Counterclockwise: same, -90° (CompositorApp.swift:321-322, Document/CanvasRotation.swift:30-61)
- [x] Image/Canvas commands › Rotate/Flip canvas › Image › Flip Canvas Horizontal: every layer, placed mask, the selection and the guides mirrored across the canvas's vertical middle (layers' flipX toggled, angle negated); undo "Flip Canvas Horizontal" (CompositorApp.swift:323-324, Document/LayerFlip.swift:53-79)
- [x] Image/Canvas commands › Rotate/Flip canvas › Image › Flip Canvas Vertical: same across the horizontal middle; undo "Flip Canvas Vertical" (CompositorApp.swift:325-326, Document/LayerFlip.swift:53-79)
- [x] Image/Canvas commands › Rotate/Flip canvas › Rotate/Flip commit a pending transform and cancel a pending crop first (Document/CanvasRotation.swift:35-36, Document/LayerFlip.swift:56-57)

## Transform

### Transform box and handles

- [x] Transform › Box › Transform box drawn in the accent color around the active pixel layer (visible, non-folder, has pixels), or around the whole multi-layer/folder selection; 8 white square handles (corners and edge midpoints) (Rendering/TransformOverlay.swift:64-81, 348-369)
- [x] Transform › Box › Rotation handle: round handle 28 pt beyond the top-middle handle, joined to it by a line; hidden while distorting (Rendering/TransformOverlay.swift:9-14, 354-357, 370-374)
- [x] Transform › Box › Hit zones: 10 pt around each handle and along each whole edge (edges resize as their midpoint handle) (Rendering/TransformOverlay.swift:26-41)
- [x] Transform › Box › Move: drag the body; Shift locks to the dominant axis (Document/LayerTransform.swift:157-163)
- [x] Transform › Box › Resize: drag a corner/edge handle; the opposite side is the anchor; lock-ratio state (link toggle) applies, Shift inverts it for the drag; corner proportional scaling projects onto the diagonal (Document/LayerTransform.swift:170-202)
- [x] Transform › Box › Option-resize scales from the center (Document/LayerTransform.swift:172, 179)
- [x] Transform › Box › Dragging a handle past the opposite side flips the layer on that axis instead of collapsing (Document/LayerTransform.swift:183-211)
- [x] Transform › Box › Rotate: drag the rotation handle; rotation is clockwise about the box center; Shift snaps to 15° steps (Document/LayerTransform.swift:164-169)
- [x] Transform › Box › Drags land on whole pixels and whole degrees; typed values stay exact (fractions allowed) (Rendering/EditorCanvas.swift:2022-2023, Document/LayerTransform.swift:51-59)
- [x] Transform › Box › Handle drags apply on mouse-up as one undo step "Transform Layer" (no Apply needed) (Rendering/EditorCanvas.swift:2166-2170, Document/EditorSession.swift:517-524)
- [x] Transform › Box › Non-destructive: move/scale/rotate/flip only change the layer's placement (origin, size, rotation, flipX/Y, sampling); pixels are never resampled, so scaling down and back keeps full resolution; transform validity 1...300,000 px per side, |origin| <= 1,000,000 (Document/LayerTransform.swift:17-31, UI/TransformInspector.swift:71-74)
- [x] Transform › Box › Shape layers redraw their shape at the new size after a transform so rounded corners keep their radius (Document/ShapeTool.swift:201-215, Document/EditorSession.swift:512, 523)
- [x] Transform › Box › Linked masks follow the layer; an unlinked mask stays where it is on the document (Document/EditorSession.swift:508-510, 519-521)
- [x] Transform › Box › Transform targets only layers with pixels that are visible and not folders (adjustment layers cannot be transformed); requires canEditLayers (Document/EditorSession.swift:356-361)

### Snapping during transform

- [x] Transform › Snapping › Moving snaps the layer's bounding box left/center/right and top/middle/bottom to targets within 10 screen points, each axis independently (Document/LayerTransform.swift:217-245, Document/Crop.swift:120-137)
- [x] Transform › Snapping › Resizing snaps the dragged edge(s) to targets for upright (unrotated) layers only; proportional resize snaps only the nearer edge (Document/Crop.swift:139-182, Rendering/EditorCanvas.swift:2016-2021)

### Free distort

- [x] Transform › Distort › Cmd-drag a transform handle starts free distortion: the four corners move independently; once distorted, plain handle drags keep distorting (Rendering/EditorCanvas.swift:2630-2634, Document/Distort.swift:262-268)
- [x] Transform › Distort › Corner handle moves its corner; edge-midpoint handle moves both corners of that edge; dragging the body moves the whole shape (Document/LayerTransform.swift:134-151)
- [x] Transform › Distort › Shift locks the dragged corner(s) to one axis (Document/LayerTransform.swift:139-142)
- [x] Transform › Distort › Distortion waits for Apply (Return) / Cancel (Escape) rather than applying on mouse-up; numeric fields disabled and rotation handle hidden while distorted (Document/Distort.swift:262-268, UI/TransformInspector.swift:45-46, Rendering/TransformOverlay.swift:16-24)
- [x] Transform › Distort › Live preview at up to 2048 px, with layer effects (stroke, shadow) warped along so they stay visible during the drag (Document/Distort.swift:292-346)
- [x] Transform › Distort › Apply resamples pixels: convex shapes warp in perspective; folded/dented shapes warp as two triangles; collapsed or twisted shapes are ignored; result cropped to visible pixels as an axis-aligned layer (Document/Distort.swift:4-7, 14-38, 86-180, 270-274)
- [x] Transform › Distort › 16-bit layers are warped at 16 bits and stay 16-bit (Document/Distort.swift:373-377)
- [x] Transform › Distort › Masks: a linked mask (own grid) is warped and cropped with the pixels; a linked placed mask takes the same perspective over its own bounds; an unlinked mask keeps its place (Document/Distort.swift:378-404)
- [x] Transform › Distort › Multi-layer/folder distort: every member takes the same perspective as the box; undo "Distort" or "Distort Layers" (Document/Distort.swift:276-290, 348-368)

### Multi-layer and folder transform

- [x] Transform › Group › Several selected layers, or a selected folder, transform together in one upright box around the visible pixel layers selected and inside selected folders (nested up to 64 levels) (Document/EditorSession.swift:362-386)
- [x] Transform › Group › Each member follows the box (move/scale/rotate/flip carried by the box mapping; shear dropped); masks follow; one undo step "Transform Layers" (Document/EditorSession.swift:501-515, Document/LayerTransform.swift:60-89)
- [x] Transform › Group › Press inside the group box drags all of them; outside it too unless Auto Select finds another layer there (Rendering/EditorCanvas.swift:1691-1696)
- [x] Transform › Group › Scale % of a group is relative to the group box at edit start (Document/EditorSession.swift:540-548)

### Move bar (TransformInspector)

- [x] Transform › Move bar › X field: layer box left edge in document px, range -30,000...30,000, step 1 (UI/TransformInspector.swift:22, 67-70)
- [x] Transform › Move bar › Y field: layer box top edge in document px, range -30,000...30,000, step 1 (UI/TransformInspector.swift:23, 67-70)
- [x] Transform › Move bar › W field: width px, 1...30,000; with the link on, height follows proportionally (UI/TransformInspector.swift:24, 89-100)
- [x] Transform › Move bar › H field: height px, 1...30,000; with the link on, width follows proportionally (UI/TransformInspector.swift:25, 89-100)
- [x] Transform › Move bar › Link (lock aspect ratio) toggle button: default on, not persisted; Shift held while dragging a handle flips it and the button shows the flipped state (UI/TransformInspector.swift:26-29, Document/EditorSession.swift:197)
- [x] Transform › Move bar › Scale field: percent of the layer's own pixel width (100% = 1:1), 0.1...30,000 %, scales both sides about the center; for a blank layer relative to its pre-edit size (UI/TransformInspector.swift:30-35, 64-66, Document/LayerTransform.swift:42-50)
- [x] Transform › Move bar › Angle (°) field: -360...360, wraps modulo 360, clockwise (UI/TransformInspector.swift:36)
- [x] Transform › Move bar › Sampling picker: Nearest, Smooth, High quality (default High quality); per-layer interpolation used when drawing the placed layer (UI/TransformInspector.swift:37-41, Document/LayerTransform.swift:4-15, 24)
- [x] Transform › Move bar › Flip H button: toggles horizontal flip of the layer/selection placement (UI/TransformInspector.swift:42)
- [x] Transform › Move bar › Flip V button: toggles vertical flip (UI/TransformInspector.swift:43)
- [x] Transform › Move bar › Field label scrubbing: drag a field's label (X, Y, W, H, Scale, °) to scrub its value, sensitivity 1, step 1 (UI/TransformInspector.swift:116-120, UI/NumericScrub.swift:47-52)
- [x] Transform › Move bar › Field arrow stepping: Up/Down step 1, Shift step 10 while the field has focus (UI/TransformInspector.swift:132-136)
- [x] Transform › Move bar › Live field edits: typed/stepped/scrubbed values preview on the canvas immediately and apply as one undo step when the field is left or the scrub released (no Apply needed); a pending Cmd-T/distort edit absorbs them instead (UI/TransformInspector.swift:71-88, 126-128)
- [x] Transform › Move bar › Number formatting: whole numbers without decimals, otherwise two decimals (UI/TransformInspector.swift:141-144)
- [x] Transform › Move bar › Fields disabled when nothing can be transformed or while distorted; the bar scrolls horizontally if narrow (UI/TransformInspector.swift:20, 45-48)
- [x] Transform › Move bar › Cancel (Escape) and Apply (Return) buttons appear only for edits that wait for them (Cmd-T, distortion, transformed selection); kept invisible otherwise so Return/Escape still reach a drag (UI/TransformInspector.swift:49-60)

### Commands and persistent edits

- [x] Transform › Commands › Layer › Transform Layer (Cmd-T): opens a persistent transform on the active layer (switches to Move tool), waiting for Apply/Cancel; disabled when nothing can be transformed (CompositorApp.swift:351-352, Document/EditorSession.swift:445-460, Document/FloatingSelection.swift:21-25)
- [x] Transform › Commands › Return/Enter applies and Escape cancels the pending transform (canvas keys) (Rendering/EditorCanvas.swift:2249-2254)
- [x] Transform › Commands › Selecting another layer or tool commits a pending transform (Document/EditorSession.swift:391, 398)
- [x] Transform › Commands › While a persistent transform is pending, Undo/Redo menu items act only on text fields, and the Layers panel greys out (CompositorApp.swift:29, Document/EditorSession.swift:692-697)

### Keyboard

- [x] Transform › Keyboard › Arrow keys with the Move tool nudge the layer (or selected layers/folder) 1 px; Shift+arrow 10 px; each nudge is its own undo step unless a transform is pending, where it moves the draft (and distortion corners) (Rendering/EditorCanvas.swift:2268-2272, Document/EditorSession.swift:570-579)

### Flip Layer

- [x] Transform › Flip Layer › Layer › Flip Layer Horizontal: mirrors the active layer about its own middle, or several selected layers / a folder's contents about the middle of their box; angle negated; linked masks flip with it, unlinked stay; undo "Flip Horizontal"; disabled unless the selection can be transformed (CompositorApp.swift:384-385, Document/LayerFlip.swift:3-51)
- [x] Transform › Flip Layer › Layer › Flip Layer Vertical: same about the horizontal middle; undo "Flip Vertical" (CompositorApp.swift:386-387, Document/LayerFlip.swift:20-51)

## Text

### Text layer model

- [x] Text › Model › Live text layer: text layers keep content, font, size, color, alignment, tracking, leading and optional box size; drawn as a raster that composites like any layer (Document/TypeTool.swift:7, Document/TypeTool.swift:204)
- [x] Text › Model › Defaults: content "Text", font Helvetica, 72 px, black, Left, tracking 0, leading Auto; last applied style (minus runs) becomes the default for new text (Document/TypeTool.swift:8, Document/TypeTool.swift:312)
- [x] Text › Model › New text color: new text starts in the foreground color (Document/TypeTool.swift:247)
- [x] Text › Model › Point vs paragraph text: point text has no box and grows with its content; box text wraps by word inside a fixed box; 12 px padding around text (Document/TypeTool.swift:20, Document/TypeTool.swift:24, Document/TypeTool.swift:420, Document/TypeTool.swift:412)
- [x] Text › Model › Per-letter color runs: selected letters can be colored differently; typing inherits the previous letter's color (Document/TypeTool.swift:30, Document/TypeTool.swift:71, Document/TypeTool.swift:123)
- [x] Text › Model › Per-letter font runs: selected letters can use a different face; typing inherits the previous letter's face (Document/TypeTool.swift:33, Document/TypeTool.swift:107, Document/TypeTool.swift:123)
- [x] Text › Model › Limits: up to 100,000 UTF-16 units; size 1...2000; tracking -100...1000; leading 0...5000; box 16 px up to the document side/surface limits (alert when exceeded) (Document/TypeTool.swift:35, Document/TypeTool.swift:25, Document/TypeTool.swift:336)
- [x] Text › Model › Layer naming: a new text layer is named from its first 40 characters on one line ("Text" if empty), undo "New Text Layer" (Document/TypeTool.swift:398, Document/TypeTool.swift:308)
- [x] Text › Model › Empty new text discarded: committing a new text that is only whitespace creates nothing (Document/TypeTool.swift:278)
- [x] Text › Model › Editing undo step: committing changes to an existing text layer is one undo step "Edit Text" (Document/TypeTool.swift:301)
- [x] Text › Model › Rasterize on pixel edit: painting/filtering a text layer turns it into plain pixels (no longer editable) (Document/TypeTool.swift:204, Document/TypeTool.swift:217)
- [x] Text › Model › Transform keeps text editable: move/scale/rotate/flip keep live text; re-editing keeps the upper-left corner, scale, rotation and flips; masks keep text live (Document/TypeTool.swift:204, Document/TypeTool.swift:290)
- [x] Text › Model › Fill recolors live text: Fill with Foreground/Background on a live text layer with no selection recolors all its letters, staying editable (undo "Fill Text") (Document/SelectionEdits.swift:58, Document/TypeTool.swift:346)
- [x] Text › Model › Text as clipping mask / blending: text layers clip, mask and blend like any pixel layer (raster participates in compositor) (Document/TypeTool.swift:204)
- [x] Text › Model › Saved in project: live text style is written to the project manifest (Document/EditorSession+Projects.swift:13)

### Inline editing

- [x] Text › Inline editor › On-canvas native text editing: multiline NSTextView-based editor over the canvas with selection, IME/marked text, clipboard; glyphs drawn as the layer's real pixels underneath so it looks identical at any zoom (Rendering/InlineTextEditor.swift:3)
- [x] Text › Inline editor › Translucent selection: text selection highlight drawn translucent (max 45 % alpha), focused or not (Rendering/InlineTextEditor.swift:7)
- [x] Text › Inline editor › Local undo: ⌘Z / ⇧⌘Z inside the box undo/redo typing since the box opened, separate from document history (Rendering/InlineTextEditor.swift:22)
- [x] Text › Inline editor › Paste as plain text: paste drops formatting (Rendering/InlineTextEditor.swift:68)
- [x] Text › Inline editor › Finish: ⌘Return (or ⌘Enter) commits; clicking elsewhere with the Type tool, switching tools or switching layers also commits (Rendering/InlineTextEditor.swift:58, Rendering/InlineTextEditor.swift:517, Document/EditorSession.swift:396, Document/EditorSession.swift:389)
- [x] Text › Inline editor › Cancel: Esc discards the edit (Rendering/InlineTextEditor.swift:43, Rendering/EditorCanvas.swift:2205)
- [x] Text › Inline editor › Option-Left/Right tracking: ⌥← / ⌥→ change tracking by 1, ⇧⌥ by 10 (Rendering/InlineTextEditor.swift:46, Rendering/InlineTextEditor.swift:50)
- [x] Text › Inline editor › Option-Up/Down leading: ⌥↑ closes lines up by 1 (min 1), ⌥↓ opens by 1, counting from Auto; ⇧⌥ by 10 (Rendering/InlineTextEditor.swift:53)
- [x] Text › Inline editor › Box frame and handles: accent-colored box with 8 square handles; edge bands (10 screen points) also grab; cursor shows rotated resize arrows on edges, I-beam inside (Rendering/InlineTextEditor.swift:415, Rendering/InlineTextEditor.swift:391, Rendering/InlineTextEditor.swift:374)
- [x] Text › Inline editor › Resize box: dragging a handle or edge resizes the paragraph box (min 16 px) instead of scaling text; dragging point text converts it to a box of its current size; works on rotated boxes (Rendering/InlineTextEditor.swift:443, Rendering/InlineTextEditor.swift:459)
- [x] Text › Inline editor › Overflow marker: a "+" in the bottom-right handle marks text that does not fit the box (Rendering/InlineTextEditor.swift:426)
- [x] Text › Inline editor › Flipped layers: editing a flipped text layer mirrors the editing surface to match (Rendering/InlineTextEditor.swift:278)
- [ ] Text › Inline editor › Pointer visible while typing: the pointer is not hidden during typing (Rendering/InlineTextEditor.swift:64)
- [x] Text › Color › Foreground follows text: while editing, changing the foreground swatch recolors the selected letters (or all); picking a text color also sets the foreground (Document/ColorPalette.swift:40, Document/ColorPalette.swift:119)
- [x] Text › Color › Live color preview: the picker's working color previews on the text being edited; Cancel restores the original colors (Document/ColorPalette.swift:159, Document/ColorPalette.swift:89, UI/TypeControls.swift:99)

### PSD text import (user-visible)

- [ ] Text › PSD import › Editable horizontal text: Photoshop type layers import as live text with font, size, color, tracking, leading and alignment; paragraph frames become boxes (IO/PSD/PSDText.swift:5, IO/PSD/PSDText.swift:67)
- [ ] Text › PSD import › Vertical / unrepresentable text rasterized: vertical text, shear or uneven scale stay pixels, with note "Editable Photoshop text becomes pixels and can't be retyped." (IO/PSD/PSDText.swift:42, IO/PSD/PSDText.swift:23, IO/PSD/PSDDocumentBuilder.swift:39)
- [ ] Text › PSD import › Conversion notes: "Only the first text style was kept.", "The Photoshop text warp was omitted.", "Faux bold or faux italic was omitted.", "Full justification was imported as left alignment.", missing font → drawn with system font (IO/PSD/PSDText.swift:24, IO/PSD/PSDText.swift:25, IO/PSD/PSDText.swift:26, IO/PSD/PSDText.swift:27, IO/PSD/PSDText.swift:29)

## Color

### Foreground / background swatches

- [x] Color › Swatches › Tool-rail swatches: overlapping 24 pt foreground (front) and background (offset) swatches at the bottom of the tool rail; default black foreground, white background (UI/ColorPaletteControls.swift:11, Document/BrushStroke.swift:12, Document/EditorSession.swift:228)
- [x] Color › Swatches › Click opens picker: clicking a swatch opens the Color Picker on that color (UI/ColorPaletteControls.swift:61, Document/ColorPalette.swift:58)
- [x] Color › Swatches › Swap: corner arrow button or X swaps foreground and background (UI/ColorPaletteControls.swift:14, Rendering/EditorCanvas.swift:2288, Document/ColorPalette.swift:43)
- [x] Color › Swatches › Reset: corner reset button or D sets black foreground / white background (UI/ColorPaletteControls.swift:26, Rendering/EditorCanvas.swift:2289, Document/ColorPalette.swift:52)
- [x] Color › Swatches › Mask mode: with a mask selected the swatches show black/white; clicking one opens a popover "Mask foreground/background" with Black · Hide / White · Reveal; X swaps, D resets to black foreground; an open picker closes when a mask is selected (UI/ColorPaletteControls.swift:40, UI/ColorPaletteControls.swift:53, Document/ColorPalette.swift:27, Document/ColorPalette.swift:45)
- [x] Color › Swatches › Disabled while busy: palette controls disabled during long operations or a stroke (UI/ColorPaletteControls.swift:39, Document/ColorPalette.swift:25)
- [x] Color › Swatches › No swatch library: there are no saved swatches, recents or palettes beyond foreground/background (Document/ColorPalette.swift:20)

### Color Picker panel

- [x] Color › Picker › Window titles by target: "Color Picker (Foreground Color)", "(Background Color)", "(Text Color)", "(<Effect> Color)" for Stroke/Drop Shadow/Color Overlay/Inner Shadow/Outer Glow/Inner Glow, "(Gradient Map Highlights)", "(Gradient Map Shadows)", "(Vignette Color)", "(Light Color)", "(Dark Color)" for Dither/Scanlines, or "(<dialog title>)" for dialog swatches such as Export and Canvas Size backgrounds and Grid color (Document/ColorPalette.swift:275-283)
- [x] Color › Picker › Floating panel: movable floating panel titled by target, first centered, then reopens where last left; closing via title bar cancels (UI/ColorPickerSheet.swift:168, UI/ColorPickerSheet.swift:177)
- [x] Color › Picker › Saturation/brightness field: 256x256 field, drag sets saturation (x) and brightness (y) with a ring marker (UI/ColorPickerSheet.swift:52)
- [x] Color › Picker › Hue strip: vertical 0...360° hue strip with arrow markers; HSB is source of truth so hue survives grays/black (UI/ColorPickerSheet.swift:74, Document/ColorPalette.swift:308)
- [x] Color › Picker › New-color preview: 64x64 preview of the working color (UI/ColorPickerSheet.swift:99)
- [x] Color › Picker › RGB fields: R, G, B integer fields 0...255, each label scrubbable, Up/Down steps (UI/ColorPickerSheet.swift:109, UI/ColorPickerSheet.swift:124)
- [x] Color › Picker › Hex field: monospaced, accepts RRGGBB or RGB shorthand with or without #; applied on Return or focus loss, invalid input reverts (UI/ColorPickerSheet.swift:112, UI/ColorPickerSheet.swift:147, Document/ColorPalette.swift:366)
- [x] Color › Picker › OK / Cancel: OK (Return) commits, Cancel (Esc) restores the original; keys remappable (UI/ColorPickerSheet.swift:28)
- [x] Color › Picker › Canvas sampling: "Click the canvas to sample": clicking/dragging the canvas loads the composite color into the picker (not for dialog targets) (UI/ColorPickerSheet.swift:38, Document/ColorPalette.swift:232, Rendering/EditorCanvas.swift:2525)
- [x] Color › Picker › 8-bit quantization: picked colors snap to 8-bit sRGB values; no alpha/opacity control (Document/ColorPalette.swift:297, Document/ColorPalette.swift:360)
- [x] Color › Picker › Composite sampling rule: samples the visible composite at one document pixel; transparent pixels sample nothing (Document/ColorPalette.swift:239)
- [x] Color › Picker › Target: Foreground / Background color (title "Color Picker (Foreground Color)" / "(Background Color)") (Document/ColorPalette.swift:265, Document/ColorPalette.swift:279)
- [x] Color › Picker › Target: Text color, from the Type bar (Document/ColorPalette.swift:272, Document/ColorPalette.swift:77)
- [x] Color › Picker › Target: layer effect color (Stroke, Shadow, Overlay, Glow…), live preview on canvas (Document/ColorPalette.swift:267, Document/ColorPalette.swift:97, Document/ColorPalette.swift:154)
- [x] Color › Picker › Target: Gradient Map Shadows / Highlights, live preview (Document/ColorPalette.swift:268, Document/ColorPalette.swift:141, Document/ColorPalette.swift:172)
- [x] Color › Picker › Target: Vignette color, live preview (Document/ColorPalette.swift:269, Document/ColorPalette.swift:147)
- [x] Color › Picker › Target: Dither / Scanlines dark and light colors, live preview (Document/ColorPalette.swift:271, Document/ColorPalette.swift:191)
- [x] Color › Picker › Target: dialog colors (e.g. Export background for transparency) via a dialog swatch; picker closes with the dialog, keeping the chosen color (Document/ColorPalette.swift:274, Document/ColorPalette.swift:178, UI/ColorPickerSheet.swift:194)
- [x] Color › Picker › Brush / Shape header swatches: the Brush (and Spot Healing) and Shape headers' swatches open the foreground picker (UI/BrushControls.swift:109, UI/ShapeControls.swift:17)

## View

### Zoom

- [x] View › Zoom › Fit Canvas: View menu item, fits the whole document in the canvas with a 96 pt total margin (48 pt each side), resets pan; ⌘0; disabled with no document (CompositorApp.swift:118-120) (Rendering/CanvasViewport.swift:35-41) (Document/EditorSession.swift:1069-1072)
- [x] View › Zoom › Fit follows window resizes: after Fit the view keeps re-fitting when the window or display changes, until the user zooms or pans (followsFit) (Rendering/CanvasViewport.swift:10,43-54)
- [x] View › Zoom › Actual Pixels: zoom 1 = one document pixel per physical screen pixel (not per point; pointsPerPixel = zoom / backingScale); ⌘1 (CompositorApp.swift:121-123) (Rendering/CanvasViewport.swift:4,15)
- [x] View › Zoom › Zoom In: steps to the next fixed level, anchored at the view center; ⌘= (⌘+ also works); ignored while a text field is being edited (CompositorApp.swift:124-128) (Document/EditorSession.swift:1082-1087)
- [x] View › Zoom › Zoom Out: steps to the previous fixed level, anchored at the view center; ⌘-; ignored while typing in a text field (CompositorApp.swift:129-133)
- [x] View › Zoom › Keyboard zoom levels: 12.5%, 16.7%, 25%, 33.3%, 50%, 66.7%, 100%, 125%, 150%, 200%, 300%, 400%, 500%, 600%, 800%, 1200%, 1600% (keyboard steps stop at 1600%) (Rendering/CanvasViewport.swift:12-14,66-73)
- [x] View › Zoom › Zoom range clamp: 0.1%–3200% for every zoom path (pinch, scroll, tool, Navigator) (Rendering/CanvasViewport.swift:11,81-83)
- [x] View › Zoom › Toolbar Fit button: "Fit", help "Fit canvas in window (⌘0)" (ContentView.swift:202-206)
- [x] View › Zoom › Toolbar 100% button: "100%", help "Actual pixels (⌘1)" (ContentView.swift:207-211)
- [x] View › Zoom › Toolbar zoom in / zoom out magnifier buttons, help "Zoom in (⌘+)" / "Zoom out (⌘−)" (ContentView.swift:212-222)
- [x] View › Zoom › Pinch to zoom: trackpad magnify gesture zooms continuously, anchored at the pointer; blocked during a transform, crop, guide drag or brush/warp stroke (Rendering/EditorCanvas.swift:2195-2199)
- [x] View › Zoom › ⌘ or ⌥ + scroll wheel zooms at the pointer (factor exp(-deltaY x 0.015)) (Rendering/EditorCanvas.swift:2182-2187)
- [x] View › Zoom › Scroll to pan: plain scroll/two-finger swipe pans the view (precise deltas 1x, line-based mouse wheels 12x); same blocking conditions as pinch (Rendering/EditorCanvas.swift:2188-2193)
- [x] View › Zoom › Middle mouse button drag pans from any tool (closed-hand cursor) (Rendering/EditorCanvas.swift:2038-2051,2071-2074)
- [x] View › Zoom › ⌘ or ⌃ + middle mouse drag zooms about the press point: up zooms in, down out, doubling every 100 pt; zoom-in/zoom-out cursor follows direction (Rendering/EditorCanvas.swift:2045-2047,2054-2070)
- [x] View › Zoom › Preview-zoom redirect: while a dialog with its own zoomable preview (Export As) is open, Fit / Actual Pixels / Zoom In / Zoom Out act on that preview instead of the canvas (CompositorApp.swift:117-133) (Document/EditorSession.swift:273-274,1080) (UI/ExportAsSheet.swift:197-205)
- [x] View › Zoom › Moving between displays keeps the document point at the view center when the backing scale changes (Rendering/CanvasViewport.swift:43-54)
- [ ] View › Zoom › High-quality downsampling when zoomed out: chain of exact 2x Lanczos (vImage) halvings, up to 6 levels, cached by image identity with an LRU pixel budget; color edges padded transparent, gray masks edge-repeated (Rendering/DownsampleCache.swift:5-18,32-35,44-111)
- [x] View › Zoom › Crisp pixels from 200%: at zoom >= 2 the document is composited 1:1 and enlarged with nearest-neighbour (hard-edged pixels) (Rendering/EditorCanvas.swift:924-926,908-909,2757-2759)

### Rulers

- [x] View › Rulers › Rulers toggle: View › Rulers, ⌘R; default off; persisted; shown only with a document and not in Canvas Only (CompositorApp.swift:172-173) (Document/EditorSession.swift:328) (ContentView.swift:89-100)
- [x] View › Rulers › Layout: horizontal ruler on top and vertical ruler on the left, 18 pt thick, gray 0.2 background, hairline edge (UI/CanvasRulers.swift:4-6,58-60,124-129)
- [x] View › Rulers › Units and origin: document pixels only (no unit choice), origin fixed at the document's top-left, negative values outside it (UI/CanvasRulers.swift:74-83,181-184)
- [x] View › Rulers › Tick spacing: numbered major ticks about 70 pt apart using steps 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000 (else 50000) px; minor ticks every step/10 (3 pt), mid ticks at step/2 (5 pt), majors 8 pt (UI/CanvasRulers.swift:63-65,95-98,174-179)
- [x] View › Rulers › Labels: monospaced-digit 8 pt numbers; vertical ruler labels rotated -90 degrees to read downward (UI/CanvasRulers.swift:69-72,105-121)
- [x] View › Rulers › Rulers redraw live while panning/zooming (Rendering/EditorCanvas.swift:641,2192) (UI/CanvasRulers.swift:31-38)
- [x] View › Rulers › Ruler corner: decorative square with a diagonal line where the rulers meet (no origin reset) (UI/CanvasRulers.swift:8-21) (ContentView.swift:91)
- [x] View › Rulers › Drag from a ruler creates a guide: top ruler makes a horizontal guide, left ruler a vertical guide; resize cursor over rulers; clicking a ruler gives the canvas keyboard focus (UI/CanvasRulers.swift:132-153)

### Guides

- [x] View › Guides › Show Guides: View › Show › Guides, ⌘;; default on; persisted; hidden guides cannot be hit or moved and do not snap (CompositorApp.swift:167-168) (Document/EditorSession.swift:311) (Document/Guides.swift:157,278)
- [x] View › Guides › Lock Guides: View › Lock Guides, ⌥⌘;; default off; persisted; blocks creating and moving guides (CompositorApp.swift:189-190) (Document/EditorSession.swift:341) (Document/Guides.swift:137-141,157)
- [x] View › Guides › Clear Guides: View › Clear Guides removes every guide as one undo step "Clear Guides"; disabled when there are none (CompositorApp.swift:191-192) (Document/Guides.swift:136,230-236)
- [x] View › Guides › Create guide: drag out of a ruler; the guide follows the pointer and is added on release as undo step "New Guide"; creating one turns Show Guides on (Document/Guides.swift:175-181,211-214) (UI/CanvasRulers.swift:132-149)
- [x] View › Guides › Cancel a new guide: releasing it back over a ruler discards it (Document/Guides.swift:196-204) (Rendering/EditorCanvas.swift:2599-2602)
- [x] View › Guides › Move guide: with the Move tool, press within 5 screen pt of a guide and drag (resize cursor on hover); undo step "Move Guide" only if the position changed (Rendering/EditorCanvas.swift:1661-1663,1853-1856,2573-2582,1983-1986) (Document/Guides.swift:134,183-194,215-221)
- [x] View › Guides › Delete guide: drag an existing guide onto a ruler and release; undo step "Delete Guide" (Document/Guides.swift:196-209) (Rendering/EditorCanvas.swift:2111-2113)
- [x] View › Guides › Escape cancels a guide drag in progress (Rendering/EditorCanvas.swift:2246-2248) (Document/Guides.swift:225-228)
- [x] View › Guides › Guide placement snaps (when Snap is on, within 10 screen pt) to grid lines (if grid shown and Snap To Grid), other guides on the same axis, document edges and center, and layer bounding-box edges and centers (Document/Guides.swift:287-314) (Document/LayerTransform.swift:221)
- [x] View › Guides › Guide model: horizontal guides at a document Y, vertical at a document X, fractional pixel positions; saved with the project; undo covers them (Document/Guides.swift:4-11) (Document/EditorSession.swift:68-69)
- [x] View › Guides › Guide appearance: cyan (0,1,1) at 90% alpha, one physical pixel wide, spanning the whole view including the pasteboard (Document/Guides.swift:132-133) (Rendering/TransformOverlay.swift:244-266)
- [x] View › Guides › Guides follow canvas operations: offset by Canvas Size, scaled by Image Size, mirrored by Flip Canvas, quarter-turned by Rotate Canvas (Document/Guides.swift:12-31) (IO/CanvasResizer.swift:18) (IO/ImageResizer.swift:31) (Document/LayerFlip.swift:77) (Document/CanvasRotation.swift:18,50)
- [x] View › Guides › Guides cannot be edited while busy, importing, on the New canvas screen, or with Levels, Hue/Saturation, a filter, or a rename open (Document/Guides.swift:137-141)

### Grid

- [x] View › Grid › Show Grid: View › Show › Grid, ⌘'; default off; persisted; independent of the pixel grid; drawn over the document only (CompositorApp.swift:165-166) (Document/EditorSession.swift:288-289) (Rendering/TransformOverlay.swift:199-242)
- [x] View › Grid › Grid Settings…: View menu item opening a window-modal sheet titled "Grid"; the grid is shown temporarily while it is open and every change previews live; afterwards the grid's previous shown/hidden state is restored (CompositorApp.swift:170-171) (IO/ProjectController.swift:181-205) (UI/GridSettingsSheet.swift:3,119-123)
- [x] View › Grid › Grid Settings › Color preset: Light Gray (0.7,0.7,0.7; default), Light Blue (0.29,0.78,1), Light Red (1,0.4,0.4), Green (0.25,0.8,0.25), Medium Blue (0.2,0.4,1), Yellow (1,1,0), Magenta (1,0,1), Cyan (0,1,1), Black, Custom (Document/Guides.swift:67-88,107) (UI/GridSettingsSheet.swift:56-60)
- [x] View › Grid › Grid Settings › Color swatch: opens the color picker; picking a color makes it the Custom color and selects Custom; picking the original preset's color again restores that preset; custom color default 0.7 gray (UI/GridSettingsSheet.swift:31-45,61-62) (Document/Guides.swift:108-109)
- [x] View › Grid › Grid Settings › Style: Lines (default, solid), Dashed Lines (4 on / 3 off pt), Dots (1 on / 2 off pt); applies to major lines only (Document/Guides.swift:90-103,110) (UI/GridSettingsSheet.swift:64-69)
- [x] View › Grid › Grid Settings › Opacity: 1–100%, default 45%, slider + number field with % suffix + scrubbable label (sensitivity 0.5) + Up/Down arrow steps (Document/Guides.swift:105,112) (UI/GridSettingsSheet.swift:70-79)
- [x] View › Grid › Grid Settings › Gridline every: 2–4096 pixels, default 64; scrubbable label (sensitivity 1) (Document/Guides.swift:37,46) (UI/GridSettingsSheet.swift:81-86)
- [x] View › Grid › Grid Settings › Subdivisions: 1–64, default 8, never more than the gridline spacing; scrubbable label (sensitivity 0.2) (Document/Guides.swift:38,46-49) (UI/GridSettingsSheet.swift:87-91)
- [x] View › Grid › Grid Settings › Info line: "A subdivision every N pixels." or, when invalid, an orange message giving the allowed ranges (UI/GridSettingsSheet.swift:92-95)
- [x] View › Grid › Grid Settings › Cancel (Esc) restores the previous grid; Restore Defaults resets spacing, subdivisions, preset, style and opacity (keeps the Custom color); OK (Return) commits, disabled while invalid (UI/GridSettingsSheet.swift:96-116)
- [x] View › Grid › Rendering: subdivisions always dotted (1/2 pt) at major opacity x 28/45 and drawn only when at least 4 screen pt apart; one-physical-pixel lines; lines counted from the origin and rounded to whole pixels (Document/Guides.swift:51-61,115-119) (Rendering/TransformOverlay.swift:209-241)

### Snapping

- [x] View › Snapping › Snap master toggle: View › Snap, ⇧⌘;; default on; persisted; turning it off clears snap lines; governs move, resize, crop, selection moves, marquee/shape corners and guide placement (CompositorApp.swift:175-176) (Document/EditorSession.swift:182-187,329-336)
- [x] View › Snapping › Snap To › Guides: default on; persisted; only while guides are shown (CompositorApp.swift:178-179) (Document/EditorSession.swift:337) (Document/Guides.swift:278-283)
- [x] View › Snapping › Snap To › Grid: default off; persisted; only while the grid is shown; snaps to subdivision lines too (CompositorApp.swift:180-181) (Document/EditorSession.swift:338) (Document/Guides.swift:274-277)
- [x] View › Snapping › Snap To › Layers: default on; persisted; edges (and centers) of other layers' bounding boxes, using their transformed/distorted corners (CompositorApp.swift:182-183) (Document/EditorSession.swift:339) (Document/Guides.swift:259-272)
- [x] View › Snapping › Snap To › Document Bounds: default on; persisted; canvas edges and center (CompositorApp.swift:184-186) (Document/EditorSession.swift:340) (Document/Guides.swift:251-258)
- [x] View › Snapping › Snap distance: 10 screen points at any zoom (converted to document pixels by the zoom) (Document/LayerTransform.swift:218-221) (Document/Guides.swift:289)
- [x] View › Snapping › Control bypasses snapping while dragging: layer move/resize, selection move, marquee and shape corners, crop edges (Rendering/EditorCanvas.swift:2013-2026,2395-2400,2413-2415,2564-2568)
- [x] View › Snapping › Snap feedback lines: while a drag is snapped, accent-colored lines are drawn across the canvas along the targets it landed on (Rendering/TransformOverlay.swift:269-288) (Document/EditorSession.swift:180-181)
- [x] View › Snapping › Rotation is never snapped; drags land on whole pixels and whole degrees (Rendering/EditorCanvas.swift:2013-2022)

### Navigator

- [x] View › Navigator › Navigator toggle: View › Navigator (300% and above); default off; persisted (navigator.visible) (CompositorApp.swift:8,134) (ContentView.swift:7)
- [x] View › Navigator › Visibility: shown in the canvas's top-right corner (12 pt inset) only at zoom >= 300% and not in Canvas Only (ContentView.swift:114-118) (UI/NavigatorMinimap.swift:11)
- [x] View › Navigator › Size: the whole document fitted inside 126 x 90 pt, proportions kept, rounded corners, 25% white border and drop shadow (UI/NavigatorMinimap.swift:13,18-22,42-45)
- [x] View › Navigator › Picture: live composite (adjustments, masks, clipping) at 300 px on the longer side, without transforms/previews in progress; redrawn 250 ms after layer edits settle, not for selection or guide changes (UI/NavigatorMinimap.swift:15,54-77) (Document/EditorSession+Navigator.swift:4-22)
- [x] View › Navigator › View box: accent-colored 2.5 pt rectangle around the visible part of the document (min 3 pt), clipped to the picture (UI/NavigatorMinimap.swift:33-40) (Rendering/NavigatorGeometry.swift:19-23,34-42)
- [x] View › Navigator › Click or drag in the minimap centers the view on that document point (held to the document's edges), keeping the zoom; ends Fit-following (UI/NavigatorMinimap.swift:47-49) (Rendering/NavigatorGeometry.swift:25-31,44-51)

### Pixel grid

- [x] View › Pixel grid › Pixel Grid toggle: View › Pixel Grid (800% and above); default on; persisted (tool.pixelGrid) (CompositorApp.swift:135-136) (Document/EditorSession.swift:280)
- [x] View › Pixel grid › Rendering: at zoom >= 800%, one-physical-pixel lines on every document pixel boundary, gray 0.55 at 45% alpha, over the image only, in a separate overlay layer (Rendering/EditorCanvas.swift:927,1404-1445) (Rendering/CanvasLinesOverlay.swift:3-12)

### Fullscreen / Canvas only

- [x] View › Fullscreen / Canvas only › Toggle Fullscreen: View menu toggle on plain F; the canvas alone on black over the whole screen; F again restores (CompositorApp.swift:112-115) (IO/CompositorApplicationDelegate.swift:99-154)
- [x] View › Fullscreen / Canvas only › Hides: tool header bar, tool rail, rulers, Layers panel, status bar, Navigator, toolbar, traffic-light buttons, menu bar and Dock (ContentView.swift:82-87,89,97,114,123,129) (IO/CompositorApplicationDelegate.swift:108-117)
- [x] View › Fullscreen / Canvas only › Black surround: canvas pasteboard turns black (gray 0.105 otherwise) and a click-through black frame window covers the screen outside the window's rounded interior (radius 26) (Rendering/EditorCanvas.swift:865-866) (IO/CompositorApplicationDelegate.swift:118-130,206-223)
- [ ] View › Fullscreen / Canvas only › Instant: covers the screen immediately rather than macOS full screen's animated new space; inside macOS full screen it only hides the toolbar; the original window frame, title bar and presentation options are restored on exit (IO/CompositorApplicationDelegate.swift:95-97,105-153)
- [x] View › Fullscreen / Canvas only › Escape leaves Canvas Only when nothing is in progress to cancel (text, Levels, stroke, lasso, shape, gradient, crop, guide drag, transform, pixel move) and no text field has focus (IO/CompositorApplicationDelegate.swift:58-65) (Document/EditorSession.swift:314-320)
- [x] View › Fullscreen / Canvas only › Enabled only with a document and no text being typed, filter, Hue/Saturation, Levels, color picker, adjustment editing, effects, Color Range or selection-amount panel open (Document/EditorSession.swift:321-327)
- [x] View › Fullscreen / Canvas only › An F typed into a text field (palette search, layer name, number field) goes to the field instead of toggling (IO/CompositorApplicationDelegate.swift:55-57,66-72)

### CMYK proofing

- [ ] View › CMYK proofing › Embedded profile naming: a CMYK profile taken from a file (e.g. a CMYK PSD) is named by its ColorSync description, or "Embedded CMYK Profile" when it has none (IO/CMYK.swift:64-71)
- [x] View › CMYK proofing › Proof Colors: View › CMYK › Proof Colors; shows the canvas as printed through the chosen CMYK profile on white paper (relative colorimetric, 33^3 color cube); default off, not persisted; no default shortcut (assignable "CMYK Proof Colors") (CompositorApp.swift:141-146) (Document/EditorSession.swift:281-282) (IO/CMYK.swift:112-130,134-184) (Rendering/EditorCanvas.swift:2762-2771)
- [x] View › CMYK proofing › Gamut Warning: View › CMYK › Gamut Warning; colors the profile can't print (moved more than 10 of 255 levels) shown as 50% gray, over the proof or the document's own colors; default off; assignable "CMYK Gamut Warning" (CompositorApp.swift:147-150) (Document/EditorSession.swift:283-285) (IO/CMYK.swift:166-179)
- [x] View › CMYK proofing › Profile submenu: lists every CMYK ICC profile (.icc/.icm) in /System/Library/ColorSync/Profiles, /Library/ColorSync/Profiles and the app's Application Support/CMYK Profiles, sorted by name, checkmark on the current (CompositorApp.swift:152-157) (IO/CMYK.swift:27-50)
- [x] View › CMYK proofing › Load Profile…: open panel for .icc/.icm ("Choose a CMYK ICC profile, such as the one your printer gave you"); copies it into Application Support/CMYK Profiles and selects it; non-CMYK profile error "That profile isn’t a CMYK output profile." (CompositorApp.swift:159,398-406) (IO/CMYK.swift:52-62,187-190)
- [ ] View › CMYK proofing › Chosen profile: persisted by name (cmykProfile); default macOS "Generic CMYK Profile"; shared with CMYK export; opening a CMYK file adopts and selects its embedded profile (IO/CMYK.swift:74-110) (Document/EditorSession.swift:286-287,861-867)
- [x] View › CMYK proofing › Proof badges: pill at the foot of the canvas "CMYK Proof" / "CMYK Gamut Warning" with the profile name and an x button that turns the mode off (UI/LayerMaskMenu.swift:37-51,55-77) (ContentView.swift:104-113)

### Canvas display

- [x] View › Canvas display › Pasteboard color: gray 0.105 around the document (black in Canvas Only); window background gray 0.14; app always in dark appearance (Rendering/EditorCanvas.swift:865-874) (ContentView.swift:141,175)
- [x] View › Canvas display › Document shadow: 35% black, 3 pt down, 14 pt blur (Rendering/EditorCanvas.swift:882-886,2743-2746)
- [x] View › Canvas display › Transparency checkerboard: 10 pt squares of gray 0.30 and 0.35 from the document's top-left (Rendering/EditorCanvas.swift:887-905,2747-2755)
- [x] View › Canvas display › Document edge: one-pixel 13% white outline (Rendering/EditorCanvas.swift:919-921,2772-2779)
- [x] View › Canvas display › Marching ants: selection outline dashed 4/4, phase advanced every 0.12 s while a non-empty selection exists (Rendering/EditorCanvas.swift:2470-2486) (Rendering/TransformOverlay.swift:98,307)
- [ ] View › Canvas display › GPU canvas: composited on Metal through Core Image with a Core Graphics fallback (used for snapshots or when a layer needs it); blending in sRGB (Rendering/GPUCanvas.swift:6-19,370-390) (Rendering/EditorCanvas.swift:2666-2682)
- [ ] View › Canvas display › Display dithering: frames containing 16-bit/HDR layers get sub-level noise dithering so gradients don't band on the 8-bit drawable (Rendering/GPUCanvas.swift:329-367) (Rendering/EditorCanvas.swift:2679-2680)

## File

### New canvas

- [x] File › New canvas › New Canvas… menu item: ⌘N; opens a new project tab showing the New canvas screen (never reuses the current tab); disabled while a project operation can't start (busy, modal edit, import) (CompositorApp.swift:50-54, Document/ProjectWorkspace.swift:72-76, IO/ProjectController.swift:313-319)
- [ ] File › New canvas › Toolbar "+" New canvas button: leftmost toolbar button, tooltip "New canvas (⌘N)", same action as the menu item; disabled while importing, busy, or Levels is open (ContentView.swift:182-186, ContentView.swift:306-309)
- [x] File › New canvas › Welcome screen: the New canvas sheet fills the canvas area whenever the tab has no document (ContentView.swift:103, ContentView.swift:344-348)
- [x] File › New canvas › Title "New canvas" (UI/NewCanvasSheet.swift:96)
- [x] File › New canvas › Width field: text field, default "1920", unit suffix shown after it, focused on appear; accepts "," as decimal separator (UI/NewCanvasSheet.swift:62, UI/NewCanvasSheet.swift:125, UI/NewCanvasSheet.swift:178, UI/NewCanvasSheet.swift:203-214, UI/NewCanvasSheet.swift:29-35)
- [x] File › New canvas › Height field: text field, default "1080", unit suffix shown after it; "×" glyph between the fields (UI/NewCanvasSheet.swift:63, UI/NewCanvasSheet.swift:126-127)
- [x] File › New canvas › Size validation: pixels must be a whole number 1–30,000 per side (`DocumentLimits.maxSide`); print units must convert to a whole pixel count in range at the DPI (UI/NewCanvasSheet.swift:29-35, Document/DocumentLimits.swift:18)
- [x] File › New canvas › Validation message: orange "Enter whole numbers from 1 to 30,000 pixels." (pixels) or "Enter a size up to 30,000 pixels at this DPI." (print units); Create canvas disabled while invalid (UI/NewCanvasSheet.swift:149-153, UI/NewCanvasSheet.swift:164)
- [x] File › New canvas › Preset sizes menu: three-dot button at top right, tooltip "Preset sizes for screens and common formats"; inline picker with "Custom" plus three divided groups; the preset matching the current fields is checked; choosing one fills both fields in the current unit (UI/NewCanvasSheet.swift:99-121, UI/NewCanvasSheet.swift:182-185)
- [x] File › New canvas › Preset "4K": 3840 × 2160 (UI/NewCanvasSheet.swift:246)
- [x] File › New canvas › Preset "1440p": 2560 × 1440 (UI/NewCanvasSheet.swift:247)
- [x] File › New canvas › Preset "1080p": 1920 × 1080 (UI/NewCanvasSheet.swift:248)
- [x] File › New canvas › Preset "iPhone 18 Pro": 1206 × 2622 (UI/NewCanvasSheet.swift:251)
- [x] File › New canvas › Preset "iPhone 18 Pro Max": 1320 × 2868 (UI/NewCanvasSheet.swift:252)
- [x] File › New canvas › Preset "MacBook Pro 14\"": 3024 × 1964 (UI/NewCanvasSheet.swift:253)
- [x] File › New canvas › Preset "MacBook Pro 16\"": 3456 × 2234 (UI/NewCanvasSheet.swift:254)
- [x] File › New canvas › Preset "Studio Display": 5120 × 2880 (UI/NewCanvasSheet.swift:255)
- [x] File › New canvas › Preset "Instagram Square": 1080 × 1080 (UI/NewCanvasSheet.swift:258)
- [x] File › New canvas › Preset "Instagram Portrait": 1080 × 1350 (UI/NewCanvasSheet.swift:259)
- [x] File › New canvas › Preset "Instagram Story": 1080 × 1920 (UI/NewCanvasSheet.swift:260)
- [x] File › New canvas › Preset "YouTube Thumb": 1080 × 608 (UI/NewCanvasSheet.swift:261)
- [x] File › New canvas › Background pill: click cycles "Transparent canvas" → "White canvas" → "Black canvas"; default Transparent; tooltip "Start see-through, or with a white or black Background layer. Click to switch." (UI/NewCanvasSheet.swift:45-56, UI/NewCanvasSheet.swift:68, UI/NewCanvasSheet.swift:131-134)
- [x] File › New canvas › First layer: Transparent makes an empty selected "Layer 1" (no pixels allocated); White/Black makes a full-size filled layer named "Background" (Document/EditorSession.swift:1038-1067)
- [x] File › New canvas › Units pill: click cycles Pixels → Inches → Centimeters → Millimeters (px/in/cm/mm suffixes); always starts at Pixels; switching converts the typed values so the canvas size is unchanged (print units shown to at most 2 decimals) (UI/NewCanvasSheet.swift:6-42, UI/NewCanvasSheet.swift:66, UI/NewCanvasSheet.swift:80-86, UI/NewCanvasSheet.swift:136-139)
- [x] File › New canvas › Resolution pill: "72 DPI" / "300 DPI" toggle on click, default 72; in print units it sets the pixel count, in pixels it is only stored with the document; tooltip "Resolution: 72 for screens, 300 for print. Click to switch." plus "· N DPI: W × H pixels" in print units (UI/NewCanvasSheet.swift:67, UI/NewCanvasSheet.swift:75-78, UI/NewCanvasSheet.swift:143-146)
- [ ] File › New canvas › Stored resolution: document resolution kept with the project, clamped to 1–9600 (else 72) (Document/EditorSession.swift:1045)
- [ ] File › New canvas › Clipboard size suggestion: on first appearance, if the clipboard holds a PNG or TIFF image, Width/Height are prefilled with its pixel size (EXIF orientations 5–8 swap them); skipped for the very first tab at launch (UI/NewCanvasSheet.swift:169-177, UI/NewCanvasSheet.swift:187-202, Document/ProjectWorkspace.swift:33)
- [ ] File › New canvas › "Open project" button: runs Open Project… (UI/NewCanvasSheet.swift:155, ContentView.swift:347)
- [ ] File › New canvas › "Import image" button: opens the Import Images file picker (UI/NewCanvasSheet.swift:156)
- [ ] File › New canvas › "Create canvas" button: default action (Return, remappable "Apply current canvas operation"); creates the document at the typed size/DPI/background, fits it in the window, one undo step "New Canvas" (UI/NewCanvasSheet.swift:158-164, Document/EditorSession+Projects.swift:69-73, Document/EditorSession.swift:1040-1053)
- [ ] File › New canvas › Sheet disabled while an import or long operation runs (UI/NewCanvasSheet.swift:168)

### Open

- [ ] File › Open › Several .comp files delivered in one request (Finder / Dock, single-project path) are refused with the error "Open one project at a time" (IO/ProjectController.swift:393-401)
- [x] File › Open › Open Project… menu item: ⌘O; disabled while a project operation can't start (CompositorApp.swift:55-59)
- [x] File › Open › Open panel: accepts only Compositor projects (`com.compositor.project`, `.comp` packages shown as files, not folders); multiple selection allowed, each project opens in its own tab (Document/ProjectWorkspace.swift:78-95)
- [ ] File › Open › Already-open project: opening a project already in a tab switches to that tab instead of loading again (Document/ProjectWorkspace.swift:96-99)
- [x] File › Open › Blank start tab replaced: opening into a window whose only tab is empty removes that empty tab (Document/ProjectWorkspace.swift:104)
- [x] File › Open › Validate before replacing: the package is fully loaded and validated off the main thread before anything changes; a corrupt project never discards the live document or leaves a broken tab (IO/ProjectController.swift:292-302, Document/ProjectWorkspace.swift:100-103)
- [x] File › Open › Missing file: a project deleted since (e.g. from Open Recent) shows "Couldn’t open the project" with a no-such-file error and refreshes the recent list (IO/ProjectController.swift:284-289)
- [x] File › Open › Error alert: warning alert "Couldn’t open the project" with the reason and an OK button (IO/ProjectController.swift:307-310, IO/ProjectController.swift:356-363)
- [ ] File › Open › Error text "This is not a valid Compositor project, or its metadata is damaged." (IO/ProjectStore.swift:73)
- [x] File › Open › Error text "This project uses format version N. This app supports versions 1–14." (IO/ProjectStore.swift:74)
- [ ] File › Open › Error text "An image inside the project is missing or damaged. The current document has not been replaced." (IO/ProjectStore.swift:75)
- [ ] File › Open › Error text "This project exceeds the supported canvas, layer, file-size, or N-megapixel document limit." (IO/ProjectStore.swift:76)
- [ ] File › Open › After opening: canvas fitted to the window, undo history cleared, folders expanded, active layer restored from the manifest, guides and resolution restored (Document/EditorSession+Projects.swift:21-35)
- [x] File › Open › Recorded in Open Recent and the project starts being watched for external changes (IO/ProjectController.swift:302-305)
- [ ] File › Open › Confirm replacing (single-window path): when the current document has unsaved changes the Save / Cancel / Don’t Save prompt runs before it is replaced; if that save rewrote the file being opened it is re-read (IO/ProjectController.swift:295-301)

### Open Recent

- [x] File › Open Recent › Submenu: one item per recent project, titled by file name without ".comp"; choosing one opens it (CompositorApp.swift:60-66)
- [ ] File › Open Recent › Source of the list: macOS's own recent-documents list (NSDocumentController, the same list as the Dock icon's menu), so its length is the system's recent-items setting; no app-specific persistence key (IO/RecentProjects.swift:4-6, IO/RecentProjects.swift:22-32)
- [x] File › Open Recent › Missing projects hidden: entries whose file no longer exists are left out; re-checked every time the app becomes active (IO/RecentProjects.swift:12-20, IO/RecentProjects.swift:30-32)
- [x] File › Open Recent › Updated on every successful open and save (IO/ProjectController.swift:249, IO/ProjectController.swift:303)
- [x] File › Open Recent › Clear Menu: clears the system list; disabled when empty; whole submenu disabled while a project operation can't start (CompositorApp.swift:67-71, IO/RecentProjects.swift:26-29)

### Save

- [ ] File › Save › Save menu item: ⌘S; disabled with no document or while a project operation can't start (CompositorApp.swift:76-77)
- [ ] File › Save › First save asks where: Save panel titled "Save Project", `.comp` only, default name "Untitled.comp" (or the current file name), extension shown, can create folders (IO/ProjectController.swift:213-233)
- [ ] File › Save › Pending canvas edits settled first: an active crop is cancelled and an active transform committed before the snapshot (IO/ProjectController.swift:18-24)
- [ ] File › Save › Background save: the document is captured, tools are released immediately, and the package is written while editing continues; only the captured version counts as saved (IO/ProjectController.swift:26-38, IO/ProjectController.swift:235-262)
- [ ] File › Save › Serialized saves: a new save, close, quit or replace waits for a save still writing to finish (IO/ProjectController.swift:29-31, IO/ProjectController.swift:40-42, IO/ProjectController.swift:341-344)
- [ ] File › Save › Saved state: marks the captured revision as saved; edits made during the write keep the document modified, and undoing back to the saved revision makes it unmodified again (IO/ProjectController.swift:247, Document/DocumentHistory.swift:38-44)
- [ ] File › Save › Package written: `manifest.json` (pretty-printed, sorted keys, format version 14, sRGB) plus `images/<LAYER-UUID>.png` per pixel layer (EXR for an HDR layer, 16-bit PNG for a 16-bit layer) and `images/<LAYER-UUID>.mask.png` per mask (IO/ProjectStore.swift:89-123, Document/EditorSession+Projects.swift:5-18, IO/ImageImporter.swift:19-20)
- [ ] File › Save › Atomic replace: written through file coordination as a staged sibling package that replaces the destination only when complete (IO/ProjectStore.swift:130-141)
- [ ] File › Save › Save-time limits: manifest at most 4 MiB, each surface within side and document pixel budget, masks must be valid 8-bit gray, else the save fails and the previous file is kept (IO/ProjectStore.swift:90-119, IO/ProjectStore.swift:77)
- [x] File › Save › QuickLook preview written into the package on every save (see QuickLook) (IO/ProjectController.swift:244-245, IO/ProjectStore.swift:124-129)
- [ ] File › Save › After save: project URL set (tab title becomes the file name), added to Open Recent, digest remembered and the project watched for outside changes (IO/ProjectController.swift:246-251)
- [ ] File › Save › Error alert "Couldn’t save the project" with the reason, e.g. "An image could not be saved. The previous project has not been replaced." (IO/ProjectController.swift:253-256, IO/ProjectStore.swift:77)

### Save As

- [x] File › Save As › Save As… menu item: ⇧⌘S; always shows the Save panel titled "Save Project As", prefilled with the current file name; later saves go to the new location (CompositorApp.swift:78-80, IO/ProjectController.swift:214-224)

### Close Project

- [ ] File › Close Project › Close Project menu item: ⌘W; closes the current project tab; disabled while a project operation can't start (CompositorApp.swift:94-98, IO/ProjectController.swift:321-333)
- [ ] File › Close Project › Last blank tab can't close: the only tab, when it is empty and never saved, is not closed (Document/ProjectWorkspace.swift:44-47, Document/ProjectWorkspace.swift:108-115)
- [ ] File › Close Project › Closing the last tab leaves a fresh empty "Untitled" tab (Document/ProjectWorkspace.swift:116-121)
- [ ] File › Close Project › Unsaved-changes prompt: alert "Save changes to <file name or Untitled>?" / "Your changes will be lost if you don’t save them." with buttons Save, Cancel, Don’t Save; Save runs a normal save (Save panel if never saved) and closes only if it succeeds; Cancel keeps the project (IO/ProjectController.swift:341-354)
- [ ] File › Close Project › Waits for an in-flight background save before prompting or closing (IO/ProjectController.swift:342-343)

### Import Images

- [x] File › Import Images › Import Images… menu item: no default shortcut; opens the file picker; disabled while Levels is open, busy, importing, or on the New Document screen (CompositorApp.swift:72-73)
- [ ] File › Import Images › File picker: multiple selection, accepts every importable image type plus folders (ContentView.swift:284-291)
- [x] File › Import Images › Folders: a plain folder brings in the importable images directly inside it (not subfolders, hidden files skipped), in Finder name order ("2" before "10"); `.comp` packages are not treated as folders (IO/ImageImporter.swift:23-43, Document/EditorSession.swift:819-830)
- [x] File › Import Images › Empty folder message: "“<folder>” has no images to import." (Document/EditorSession.swift:831-834)
- [x] File › Import Images › Format JPEG (public.jpeg) (IO/ProjectStore.swift:10, IO/ImageImporter.swift:97)
- [x] File › Import Images › Format PNG, including 16-bit PNG (IO/ProjectStore.swift:10, IO/ImageImporter.swift:97)
- [ ] File › Import Images › Format HEIC and HEIF, including 10-bit HEIF (IO/ProjectStore.swift:10, IO/ImageImporter.swift:97)
- [ ] File › Import Images › Format TIFF, including 16-bit and float TIFF (IO/ProjectStore.swift:10, IO/ImageImporter.swift:97)
- [ ] File › Import Images › Format WebP (IO/ProjectStore.swift:10, IO/ImageImporter.swift:97)
- [ ] File › Import Images › Format OpenEXR (.exr, com.ilm.openexr-image) (IO/ProjectStore.swift:10-13, IO/ImageImporter.swift:97)
- [ ] File › Import Images › Format Radiance HDR (.hdr, public.radiance) (IO/ProjectStore.swift:10-15, IO/ImageImporter.swift:97)
- [x] File › Import Images › Format Photoshop PSD and PSB (detected by the "8BPS" signature, not the extension; see Photoshop PSD/PSB import) (IO/ProjectStore.swift:8-11, IO/PSD/PSDReader.swift:10-22, Document/EditorSession.swift:893)
- [ ] File › Import Images › Format camera RAW: every type conforming to public.camera-raw-image that the system RAW engine can develop (Canon, Nikon, DNG, about 30 formats); goes through the develop sheet (IO/RawImporter.swift:95-100, Document/EditorSession.swift:876-888)
- [x] File › Import Images › Format SVG: drawn once into pixels by macOS's SVG renderer, fitted to the canvas when a document exists, else at the file's declared size; becomes an ordinary pixel layer (not vector) (IO/ImageImporter.swift:69-88, Document/EditorSession.swift:889-892)
- [x] File › Import Images › Unsupported formats: GIF, BMP and others are rejected with "Choose a JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) file." (IO/ImageImporter.swift:50, IO/ImageImporter.swift:96-99)
- [x] File › Import Images › First image makes the canvas: with no document, the first successful image sets the canvas size (72 DPI) and is fitted in the window (Document/EditorSession.swift:857-858, Document/EditorSession.swift:941-944)
- [x] File › Import Images › Placement: each image becomes a new layer at its native pixel size, centered on the canvas (or on the drop point), placed in the active folder (or the active layer's folder, which is expanded), and becomes the active layer (Document/EditorSession.swift:938-954)
- [ ] File › Import Images › EXIF orientation applied and colors converted to 8-bit sRGB (IO/ImageImporter.swift:110-136)
- [ ] File › Import Images › More than 8 bits a channel (16-bit PNG/TIFF, 10-bit HEIF): kept as a 16-bit layer, shown and edited through a dithered 8-bit copy (IO/ImageImporter.swift:119-127, Document/DeepLayers.swift:3-6)
- [ ] File › Import Images › Float images (EXR, Radiance HDR, float TIFF): kept as an HDR layer in half floats (extended sRGB), light brighter than white preserved (IO/ImageImporter.swift:112-118)
- [ ] File › Import Images › CMYK JPEG/TIFF (or CMYK PSD) that starts a new document: its embedded profile (or Generic CMYK) is adopted and chosen for proofing and CMYK export (Document/EditorSession.swift:861-869, IO/CMYK.swift:76-96)
- [x] File › Import Images › One undo step per import batch: "Import Images" (or "Import Photoshop File" when every file is a PSD) (Document/EditorSession.swift:855-856, Document/EditorSession.swift:924)
- [ ] File › Import Images › Queued imports: requests made while a decode runs wait their turn; a brush stroke in progress is finished, crop cancelled and transform committed first (Document/EditorSession.swift:836-849)
- [x] File › Import Images › Size limits: 30,000 px per side and the document pixel budget (a quarter of the Mac's RAM at 4 bytes/pixel, between 200 and 800 megapixels across all layers); error "This import exceeds the current N-megapixel document budget or 30,000-pixel side limit." (Document/DocumentLimits.swift:16-41, IO/ImageImporter.swift:51, IO/ImageImporter.swift:104-106)
- [x] File › Import Images › Unreadable file error "The image could not be read. It may be damaged or unavailable." (IO/ImageImporter.swift:49)
- [x] File › Import Images › Per-file failures collected and shown together ("<file>: <reason>") in the alert "Import couldn’t finish" with OK; other files still import (Document/EditorSession.swift:920-928, ContentView.swift:292-296)

### Camera RAW develop

- [ ] File › Camera RAW develop › Develop sheet: shown before a RAW is imported, titled "Develop “<file name>”" (UI/RawDevelopSheet.swift:20-22, Document/EditorSession.swift:600-609)
- [ ] File › Camera RAW develop › Size checked first: an oversized RAW (side or pixel budget) is refused before developing (Document/EditorSession.swift:877-879, IO/RawImporter.swift:174-181)
- [ ] File › Camera RAW develop › Live preview: 560 × 340 area, developed at most 800 px on the long edge in draft mode, refreshed about 60 ms after a slider stops, with a spinner while working; the decoded frame is cached so slider changes are fast (UI/RawDevelopSheet.swift:23-39, UI/RawDevelopSheet.swift:76-94, IO/RawImporter.swift:62-93)
- [ ] File › Camera RAW develop › Exposure slider: −3…3 EV, default 0, shown to 2 decimals with " EV" (UI/RawDevelopSheet.swift:42, IO/RawImporter.swift:12)
- [ ] File › Camera RAW develop › Temperature slider: 2000…12000 K, default the camera's as-shot white balance, 0 decimals with " K" (UI/RawDevelopSheet.swift:43, IO/RawImporter.swift:104-110)
- [ ] File › Camera RAW develop › Tint slider: −150…150, default the camera's as-shot tint, 0 decimals (UI/RawDevelopSheet.swift:44, IO/RawImporter.swift:106-111)
- [ ] File › Camera RAW develop › Boost slider: 0…1, default 1 (Apple's full tone curve; 0 is flat), 2 decimals (UI/RawDevelopSheet.swift:45, IO/RawImporter.swift:17-18)
- [ ] File › Camera RAW develop › Noise Reduction slider: 0…1 luminance noise reduction, default the engine's starting amount for that camera; disabled with tooltip "Not available for this camera" when unsupported, else "Smooths grain, at the cost of fine detail" (UI/RawDevelopSheet.swift:46-49, IO/RawImporter.swift:107)
- [ ] File › Camera RAW develop › Lens Correction toggle: removes the lens's distortion and vignetting from the file's profile; default as-shot; disabled with "This file has no lens profile" when unsupported (UI/RawDevelopSheet.swift:51-54, IO/RawImporter.swift:108)
- [ ] File › Camera RAW develop › Highlight Recovery toggle: recovers partly clipped highlights; default as-shot; disabled with "Not available for this camera" when unsupported (UI/RawDevelopSheet.swift:55-58, IO/RawImporter.swift:109)
- [ ] File › Camera RAW develop › Reset button: returns every control to as-shot (exposure 0, boost 1, camera WB/tint/NR/lens/highlights); disabled when already as-shot (UI/RawDevelopSheet.swift:63, IO/RawImporter.swift:36-49)
- [ ] File › Camera RAW develop › Cancel button: Esc; skips this file (UI/RawDevelopSheet.swift:65, Document/EditorSession.swift:880)
- [ ] File › Camera RAW develop › Camera Raw… button: imports, then selects the new layer and opens the Camera Raw Filter on it; tooltip "Import, then open the Camera Raw Filter" (UI/RawDevelopSheet.swift:66-68, Document/EditorSession.swift:887, Document/EditorSession.swift:929-935)
- [ ] File › Camera RAW develop › Import button: Return; develops the full frame at 16 bits a channel into a 16-bit layer named after the file (UI/RawDevelopSheet.swift:69, Document/EditorSession.swift:882-886)
- [ ] File › Camera RAW develop › Importing state: "Importing…" overlay with progress; all controls disabled and the sheet can't be dismissed until the layer is in (UI/RawDevelopSheet.swift:30-37, UI/RawDevelopSheet.swift:72-75, Document/EditorSession.swift:610-624)
- [ ] File › Camera RAW develop › 8-bit path dithered: when a RAW is developed to 8 bits it is rounded with about one step of noise so smooth gradients don't band (IO/RawImporter.swift:154-171)

### Photoshop PSD/PSB import

- [ ] File › Photoshop PSD/PSB import › PSD (version 1) and PSB large-document (version 2) files read (IO/PSD/PSDReader.swift:32-34)
- [x] File › Photoshop PSD/PSB import › 8 bits per channel only: 16- and 32-bit files rejected with "Only 8-bit RGB and CMYK Photoshop files can be imported." (IO/PSD/PSDReader.swift:45, IO/PSD/PSDTypes.swift:12)
- [ ] File › Photoshop PSD/PSB import › RGB and CMYK color modes accepted; Grayscale, Lab, Indexed, Bitmap, Duotone, Multichannel rejected with the same message (IO/PSD/PSDReader.swift:46-47, IO/PSD/PSDTypes.swift:11)
- [ ] File › Photoshop PSD/PSB import › CMYK files converted to RGB through the file's embedded ICC profile (or Generic CMYK), relative colorimetric; that profile is adopted for proofing/CMYK export (IO/PSD/PSDReader.swift:72-76, IO/PSD/PSDChannelCoder.swift:58-75, Document/EditorSession.swift:898)
- [x] File › Photoshop PSD/PSB import › Layer compression: raw and PackBits (RLE) supported; ZIP-compressed layers rejected with "This Photoshop file uses a layer compression method that isn’t supported." (IO/PSD/PSDChannelCoder.swift:11-44, IO/PSD/PSDTypes.swift:13)
- [x] File › Photoshop PSD/PSB import › Other read errors: "The Photoshop file could not be read. It may be damaged or incomplete." and "This Photoshop file uses a format version Compositor can’t read." (IO/PSD/PSDTypes.swift:9-10)
- [ ] File › Photoshop PSD/PSB import › Canvas limits: canvas up to 30,000 px per side and 200 megapixels; at most 10,000 layer records; at most 56 channels per layer (IO/PSD/PSDReader.swift:41-44, IO/PSD/PSDReader.swift:84-86, IO/PSD/PSDReader.swift:153-154)
- [ ] File › Photoshop PSD/PSB import › Resolution read from the file (resource 1005), clamped to 1–9600 DPI (IO/PSD/PSDReader.swift:62-66)
- [x] File › Photoshop PSD/PSB import › Background-only file (no layer records): imported as one layer from the merged image (IO/PSD/PSDReader.swift:79-81, Document/EditorSession.swift:899-907)
- [ ] File › Photoshop PSD/PSB import › Too-large file cropped to canvas: when layers exceed the memory budget, every layer and mask is cropped to the canvas instead of failing; reported per layer "Cropped to the canvas so the file fits in memory. Pixels outside the canvas weren't imported." (IO/PSD/PSDReader.swift:90-95, IO/PSD/PSDReader.swift:261-292, IO/PSD/PSDDocumentBuilder.swift:28-31)
- [ ] File › Photoshop PSD/PSB import › Layer names: Unicode names (luni) kept, else Mac Roman; empty name becomes "Layer" (IO/PSD/PSDReader.swift:190-192, IO/PSD/PSDReader.swift:209, IO/PSD/PSDReader.swift:360)
- [ ] File › Photoshop PSD/PSB import › Visibility kept (hidden layers stay hidden) (IO/PSD/PSDReader.swift:165, IO/PSD/PSDReader.swift:363)
- [ ] File › Photoshop PSD/PSB import › Opacity: layer opacity × fill opacity; for layers with effects only the layer opacity (IO/PSD/PSDReader.swift:368-373)
- [x] File › Photoshop PSD/PSB import › Folders (groups) kept with nesting and their opacity; folder blend modes other than Pass Through/Normal become pass-through, reported "Folder blend mode “…” isn’t supported. The folder will be pass-through." (IO/PSD/PSDReader.swift:353-364, IO/PSD/PSDDocumentBuilder.swift:58-61, IO/PSD/PSDDocumentBuilder.swift:77-82)
- [ ] File › Photoshop PSD/PSB import › Blend modes mapped (24): Normal, Multiply, Screen, Overlay, Soft Light, Darken, Lighten, Difference, Color Dodge, Color Burn, Hue, Saturation, Color, Luminosity, Linear Burn, Linear Dodge, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix, Exclusion, Subtract, Divide (IO/PSD/PSDTypes.swift:70-102)
- [x] File › Photoshop PSD/PSB import › Unmapped blend modes (Dissolve, Darker Color, Lighter Color, others) applied as Normal, reported "Blend mode “…” isn’t supported and will be applied as Normal." (IO/PSD/PSDTypes.swift:97-99, IO/PSD/PSDDocumentBuilder.swift:62-64)
- [ ] File › Photoshop PSD/PSB import › Layer masks kept on the layer's own pixel grid with Photoshop's default value outside the stored patch; enabled/disabled and linked/unlinked state kept (IO/PSD/PSDReader.swift:171-186, IO/PSD/PSDReader.swift:394-399, IO/PSD/PSDDocumentBuilder.swift:112-117, IO/PSD/PSDDocumentBuilder.swift:147-170)
- [ ] File › Photoshop PSD/PSB import › Unconvertible mask skipped, reported "The layer mask couldn’t be converted to 8-bit grayscale and was skipped." (IO/PSD/PSDDocumentBuilder.swift:115-117)
- [ ] File › Photoshop PSD/PSB import › Clipping masks kept (as live clipping to the base layer) when the base is a plain pixel layer; otherwise skipped, reported "This clipping mask’s base isn’t supported, so clipping was skipped." (IO/PSD/PSDDocumentBuilder.swift:120-137)
- [ ] File › Photoshop PSD/PSB import › Adjustment layers kept as live adjustment layers: Levels, Curves, Hue/Saturation (incl. Colorize); reported "Adjustment parameters may not match Photoshop exactly." (IO/PSD/PSDReader.swift:483-571, IO/PSD/PSDDocumentBuilder.swift:65-70, IO/PSD/PSDDocumentBuilder.swift:83-87)
- [ ] File › Photoshop PSD/PSB import › Other adjustment layers (Exposure, Gradient Map, Brightness/Contrast, Color Balance, Invert, Threshold, Posterize, Channel Mixer, Selective Color, Black & White, Photo Filter, Vibrance) skipped entirely, reported "This adjustment type isn’t supported and was skipped." (IO/PSD/PSDReader.swift:418-421, IO/PSD/PSDDocumentBuilder.swift:65-68, IO/PSD/PSDDocumentBuilder.swift:75)
- [ ] File › Photoshop PSD/PSB import › Editable text: horizontal Photoshop type (TySh) becomes a live text layer with text, font, size, color, tracking, leading, alignment (left/center/right), rotation/vertical flip, and paragraph box size (IO/PSD/PSDText.swift:34-84, IO/PSD/PSDText.swift:134-179, IO/PSD/PSDDocumentBuilder.swift:88-94)
- [ ] File › Photoshop PSD/PSB import › Text that can't map (vertical text, shear or uneven scale, unstorable box) stays pixels, reported "Editable Photoshop text becomes pixels and can’t be retyped." (IO/PSD/PSDText.swift:10, IO/PSD/PSDText.swift:23, IO/PSD/PSDText.swift:42-43, IO/PSD/PSDDocumentBuilder.swift:34-41)
- [ ] File › Photoshop PSD/PSB import › Text notes: "Only the first text style was kept.", "The Photoshop text warp was omitted.", "Faux bold or faux italic was omitted.", "Full justification was imported as left alignment." (IO/PSD/PSDText.swift:24-27, IO/PSD/PSDText.swift:46-49, IO/PSD/PSDText.swift:163-178)
- [ ] File › Photoshop PSD/PSB import › Missing font: text drawn with the system font, reported "The font “…” isn’t installed, so the text was drawn with the system font." (IO/PSD/PSDText.swift:29-32, IO/PSD/PSDDocumentBuilder.swift:37)
- [ ] File › Photoshop PSD/PSB import › Live shapes: solid-fill rectangle, rounded rectangle (uniform corner radii) and ellipse shape layers become editable Shape layers; a Photoshop stroke on them is dropped, reported "The Photoshop stroke isn’t supported on shape layers and was omitted." (IO/PSD/PSDVector.swift:20-40, IO/PSD/PSDVector.swift:106-135, IO/PSD/PSDDocumentBuilder.swift:48-50)
- [ ] File › Photoshop PSD/PSB import › Other vector shapes rasterized (fill and/or stroke drawn from the path), reported "Vector shape was rasterized to pixels." (IO/PSD/PSDVector.swift:42-82, IO/PSD/PSDDocumentBuilder.swift:51-53)
- [ ] File › Photoshop PSD/PSB import › Smart objects rasterized, reported "The smart object was rasterized. Linked contents can’t be edited." (IO/PSD/PSDReader.swift:412, IO/PSD/PSDDocumentBuilder.swift:42-44)
- [ ] File › Photoshop PSD/PSB import › Layer effects discarded, reported "Layer effects were discarded, so the appearance may differ." (IO/PSD/PSDReader.swift:413, IO/PSD/PSDDocumentBuilder.swift:45-47)
- [ ] File › Photoshop PSD/PSB import › Unknown layer types imported as pixels, reported "This Photoshop layer type isn’t supported and was imported as pixels." (IO/PSD/PSDDocumentBuilder.swift:55-57)
- [ ] File › Photoshop PSD/PSB import › New document from a PSD: canvas takes the file's size and resolution; the topmost root layer becomes active (Document/EditorSession.swift:1008-1012)
- [x] File › Photoshop PSD/PSB import › PSD into an open document: all its layers wrapped in a new expanded folder named after the file, inside the active folder, centered on the drop point when dropped; the folder becomes active; refused past 10,000 total layers (Document/EditorSession.swift:1001-1036)
- [ ] File › Photoshop PSD/PSB import › Conversion report sheet: put up immediately while the file is read ("Reading the file to see what needs converting." with spinner "Reading the Photoshop file…", confirm disabled), then lists each conversion; dismissed silently when nothing needs reporting (Document/EditorSession.swift:956-982, UI/PSDConversionSheet.swift:24-36)
- [x] File › Photoshop PSD/PSB import › Report title: "Open “<file>”?" (Document/EditorSession.swift:894, UI/PSDConversionSheet.swift:26)
- [x] File › Photoshop PSD/PSB import › Report subtitle: "Compositor will convert these Photoshop features. Nothing is applied until you continue." (UI/PSDConversionSheet.swift:27-29)
- [x] File › Photoshop PSD/PSB import › Report list: one row per conversion, layer name in bold above the message; min 520 × 360 sheet (UI/PSDConversionSheet.swift:37-43, UI/PSDConversionSheet.swift:53)
- [x] File › Photoshop PSD/PSB import › Report Cancel button: Esc; skips the file (cancelling during reading also aborts) (UI/PSDConversionSheet.swift:47, Document/EditorSession.swift:992-999, Document/EditorSession.swift:914)
- [x] File › Photoshop PSD/PSB import › Report "Import" confirm button: Return; disabled while reading; applies the import (Document/EditorSession.swift:894, UI/PSDConversionSheet.swift:48-49)

### Export PNG

- [x] File › Export PNG › Export PNG… menu item: ⇧⌘E; flattened canvas, lossless 8-bit sRGB PNG with transparency, straight to a save panel; disabled with no document or while busy (CompositorApp.swift:86-88, IO/ProjectController.swift:44-54)
- [x] File › Export PNG › Save panel titled "Export PNG", name "<project name or Untitled>.png", extension shown, can create folders (IO/ProjectController.swift:97-110)
- [x] File › Export PNG › DPI metadata from the document resolution written into the file (IO/ImageExporter.swift:138-142)
- [ ] File › Export PNG › Flattening: visible layers with opacity (incl. folder opacity), masks, folder masks, clipping, adjustment layers, layer effects and blend modes composited as on screen (IO/ImageExporter.swift:25-86)
- [ ] File › Export PNG › Export never marks the project as saved (IO/ProjectController.swift:44-54)
- [ ] File › Export PNG › Size limit: canvas up to 200 megapixels and 30,000 px per side, else "Image export supports canvases up to 200 megapixels and 30,000 pixels per side." (IO/ImageExporter.swift:6-14, IO/ImageExporter.swift:26-28)
- [x] File › Export PNG › Error alert "Couldn’t export PNG" (IO/ProjectController.swift:53)

### Export JPEG

- [x] File › Export JPEG › Export JPEG… menu item: ⇧⌥⌘S; opens Export As with JPEG chosen; disabled with no document or while busy (CompositorApp.swift:82-85, IO/ProjectController.swift:56-58)

### Export As

- [x] File › Export As › Export As… menu item: ⇧⌥⌘W; window sheet titled "Export As"; opens on the format used last in this session (PNG at first); disabled with no document or while busy (CompositorApp.swift:89-92, IO/ProjectController.swift:58-95)
- [x] File › Export As › Format segmented control: JPEG | PNG (IO/ProjectController.swift:416-428, UI/ExportAsSheet.swift:104-115)
- [x] File › Export As › More formats menu beside it: TIFF, PDF, and EXR (EXR only when the document has an HDR layer); shows the chosen format's name and turns prominent when one is chosen, else reads "More" (UI/ExportAsSheet.swift:13, UI/ExportAsSheet.swift:262-276)
- [x] File › Export As › Size fields: width and height in px, linked (editing one sets the other, proportions kept) (UI/ExportAsSheet.swift:116-122, UI/ExportAsSheet.swift:278-284)
- [x] File › Export As › Scale menu: shows current percent; choices 25%, 50%, 75%, 100%, 200%; tooltip "Scale the export: the document stays as it is" (UI/ExportAsSheet.swift:123-128, UI/ExportAsSheet.swift:292)
- [ ] File › Export As › Scale limits: min 1%, max where the long side reaches 30,000 px or 200 megapixels; resampled at high quality, keeping the document DPI (UI/ExportAsSheet.swift:285-291, IO/ImageExporter.swift:144-165)
- [x] File › Export As › JPEG Quality slider: 0–100% (0…1, step 0.01), default 85%, last used quality remembered across launches (UserDefaults "jpegExportQuality", saved only when exporting a JPEG) (UI/ExportAsSheet.swift:21, UI/ExportAsSheet.swift:30-34, UI/ExportAsSheet.swift:131-139, UI/ExportAsSheet.swift:189, IO/ImageExporter.swift:283-288)
- [ ] File › Export As › PNG Depth toggle "16 bits per channel": only shown when the document has a 16-bit layer; off by default; keeps 16-bit precision in a file about twice the size (UI/ExportAsSheet.swift:65-66, UI/ExportAsSheet.swift:140-146, IO/ProjectController.swift:64-66)
- [x] File › Export As › Color menu (JPEG, TIFF, PDF): RGB or CMYK, RGB each time the sheet opens; CMYK writes the inks of the View › CMYK › Profile profile (relative colorimetric) with the profile embedded (UI/ExportAsSheet.swift:59-64, UI/ExportAsSheet.swift:147-160, UI/ExportAsSheet.swift:242-251, IO/CMYK.swift:112-130)
- [ ] File › Export As › Load Profile… button (shown with CMYK): pick a CMYK .icc/.icm; it is copied into the app's "CMYK Profiles" folder and chosen; a non-CMYK profile errors "That profile isn’t a CMYK output profile." (UI/ExportAsSheet.swift:154-157, UI/ExportAsSheet.swift:253-260, IO/CMYK.swift:52-62, IO/CMYK.swift:189)
- [x] File › Export As › PDF Page row: read-only "W × H in at N DPI" from the export pixels and document resolution (UI/ExportAsSheet.swift:161-166, UI/ExportAsSheet.swift:293-298)
- [ ] File › Export As › Background color swatch (JPEG, PDF, CMYK TIFF): fills transparent areas, default white; opens the color picker; tooltip "Color that fills transparent areas" (UI/ExportAsSheet.swift:167-174, UI/ExportAsSheet.swift:303-306, IO/ImageExporter.swift:283-288)
- [x] File › Export As › JPEG output: flattened over the background color, chosen quality, DPI metadata, optional CMYK (IO/ImageExporter.swift:177-209)
- [x] File › Export As › PNG output: lossless with transparency, sRGB, DPI metadata; 16-bit when the Depth toggle is on (IO/ImageExporter.swift:138-142, UI/ExportAsSheet.swift:211, UI/ExportAsSheet.swift:221)
- [ ] File › Export As › TIFF output: LZW lossless, DPI metadata; RGB keeps transparency; CMYK flattened over the background with the profile embedded (IO/ImageExporter.swift:119-129, UI/ExportAsSheet.swift:218-220)
- [x] File › Export As › PDF output: one page at the document's print size (72 / DPI points per pixel) holding the full-resolution pixels losslessly; background fills the page; optional CMYK (IO/ImageExporter.swift:230-258, UI/ExportAsSheet.swift:224-229)
- [ ] File › Export As › EXR output: half-float flattening that keeps light brighter than white and transparency; preview shows it clipped to white (IO/ImageExporter.swift:131-136, UI/ExportAsSheet.swift:222-223, IO/ProjectController.swift:67-69)
- [x] File › Export As › Status line: "Brighter than white kept · Transparency kept" (EXR), "CMYK – <profile>" (CMYK), "Transparency kept · sRGB" (PNG/TIFF), or "sRGB" (UI/ExportAsSheet.swift:177-180)
- [ ] File › Export As › Live preview: re-encoded about 200 ms after any setting changes; spinner and "Updating…" until ready; JPEG preview decoded from the encoded file (up to 8,192 px) so artifacts show (UI/ExportAsSheet.swift:93-101, UI/ExportAsSheet.swift:206-239, IO/ImageExporter.swift:199-207)
- [x] File › Export As › Estimated file size: encoded byte count shown (e.g. "1.2 MB") when ready; errors shown in red instead (UI/ExportAsSheet.swift:182-185)
- [ ] File › Export As › Preview area: 560 × 330 pt, checkerboard behind transparency, Fit button (disabled at Fit), Zoom In / Zoom Out buttons with current percent in tooltips (UI/ExportAsSheet.swift:80-101, UI/ExportAsSheet.swift:311-313, UI/ExportAsSheet.swift:369-381)
- [ ] File › Export As › Preview zoom steps: 25%, 50%, 100%, 200%, 400%, 800% (100% = one export pixel per screen pixel); nearest-neighbor from 100% up; zoom keeps the view centered (UI/ExportAsSheet.swift:313, UI/ExportAsSheet.swift:329-332, UI/ExportAsSheet.swift:339-341, UI/ExportAsSheet.swift:388-401)
- [ ] File › Export As › Preview gestures: drag or scroll to pan when zoomed; double-click toggles Fit and 100% (UI/ExportAsSheet.swift:102, UI/ExportAsSheet.swift:345-365)
- [x] File › Export As › View-menu zoom redirected: while the sheet is open, Fit Canvas (⌘0), Actual Pixels (⌘1), Zoom In (⌘=) and Zoom Out (⌘-) act on the preview (UI/ExportAsSheet.swift:197-205, CompositorApp.swift:117-133)
- [ ] File › Export As › Cancel button: Esc (remappable), closes any open color picker (UI/ExportAsSheet.swift:186)
- [x] File › Export As › Export… button: Return (remappable); disabled until the preview matching the current settings is ready; then a save panel "Export <FORMAT>" named "<project>.<ext>" (UI/ExportAsSheet.swift:187-193, IO/ProjectController.swift:85-91, IO/ProjectController.swift:97-110)
- [ ] File › Export As › Error alert "Couldn’t export" (IO/ProjectController.swift:91)

### Project format and live reload

- [ ] File › Project format and live reload › `.comp` package: a folder (com.compositor.project, conforms to com.apple.package) holding manifest.json, images/ and QuickLook/; opened and shown as one file (IO/ProjectStore.swift:6-7, IO/ProjectStore.swift:120-130, upstream/Config/Info.plist:77-93)
- [ ] File › Project format and live reload › Versions: saves write version 14; opens versions 1–14, each feature gated by the version that introduced it (layer opacity/blend 3, masks 4, clipping 5, folder masks 6, adjustments 7, folder opacity and guides 8, blur/noise adjustments 9, per-letter colors 10, per-letter fonts 11, 16-bit PNG 12, EXR 13, shape smoothing 14) (IO/ProjectStore.swift:18-36, IO/ProjectStore.swift:213-266, IO/ProjectStore.swift:183-192)
- [ ] File › Project format and live reload › Load limits: 30,000 px per side, 10,000 layers, 4 MiB manifest, 512 MiB per image file, resolution 1–9600, 1,000 guides, non-blank names up to 16,384 bytes, document pixel budget; symlinks and paths outside the package rejected (IO/ProjectStore.swift:154-175, IO/ProjectStore.swift:213-296)
- [ ] File › Project format and live reload › Live reload: the open project is watched with kernel file-system events on the package, manifest.json and images/ (no polling), re-armed after atomic replacement; events coalesced for 300 ms (IO/ProjectWatcher.swift:3-85, IO/ProjectController+ExternalChanges.swift:10-13)
- [ ] File › Project format and live reload › Change detection by content: SHA-256 of the manifest bytes plus each image's name and size; touched-only packages and the app's own saves are ignored (IO/ProjectDigest.swift:4-31, IO/ProjectController+ExternalChanges.swift:39-47, IO/ProjectController.swift:240-242)
- [ ] File › Project format and live reload › Reload in place: same tab, viewport, collapsed folders, active and selected layers kept where they still exist; undo history cleared (Document/EditorSession+Projects.swift:37-54, IO/ProjectController+ExternalChanges.swift:75-87)
- [ ] File › Project format and live reload › Waits for edits: a change arriving mid-edit (busy, transform, modal) is rechecked with backoff 250 ms × 2^n (n up to 7) (IO/ProjectController+ExternalChanges.swift:48-51, IO/ProjectController+ExternalChanges.swift:62-73)
- [ ] File › Project format and live reload › Unsaved-changes conflict: alert "“<file>” was changed on disk." / "Another app changed this project. You can revert to the version on disk, losing your unsaved changes, or keep what you have." with Revert and Keep Mine; Keep Mine ignores that version (IO/ProjectController+ExternalChanges.swift:52-55, IO/ProjectController+ExternalChanges.swift:89-96)
- [ ] File › Project format and live reload › Background tab conflict deferred: a change to a hidden tab with unsaved work is asked about when that tab comes to the front (IO/ProjectController+ExternalChanges.swift:28-31, IO/ProjectController+ExternalChanges.swift:53, Document/ProjectWorkspace.swift:70)
- [ ] File › Project format and live reload › Half-written or invalid package ignored silently until the next change (IO/ProjectController+ExternalChanges.swift:79-82)
- [ ] File › Project format and live reload › Watching stops when the tab gets a new canvas or is closed (IO/ProjectController+ExternalChanges.swift:15-21, IO/ProjectController.swift:318, IO/ProjectController.swift:328-331)

### QuickLook

- [x] File › QuickLook › Preview.jpg: every save writes QuickLook/Preview.jpg inside the package (flattened on white, JPEG quality 0.8, at most 1,024 px on the long side) for Finder's Space-bar preview; skipped for canvases over 50 megapixels; loading ignores it (IO/ImageExporter.swift:89-113, IO/ProjectStore.swift:124-129)
- [ ] File › QuickLook › No QuickLook extension: the Xcode project has only the app, unit-test and UI-test targets; Finder previews come from the package's Preview.jpg alone (upstream/Compositor.xcodeproj/project.pbxproj:124, upstream/Compositor.xcodeproj/project.pbxproj:147, upstream/Compositor.xcodeproj/project.pbxproj:170)

### Document types

- [ ] File › Document types › Compositor Project: Editor role, Owner rank, package, `com.compositor.project` exported with extension `comp`, description "Compositor Project" (upstream/Config/Info.plist:30-43, upstream/Config/Info.plist:77-93)
- [ ] File › Document types › Images: Viewer role, Alternate rank, for JPEG, PNG, HEIC, HEIF, TIFF, WebP, OpenEXR, Radiance HDR, PSD, PSB, camera RAW and SVG (Open With / drop on the Dock icon) (upstream/Config/Info.plist:7-29)
- [ ] File › Document types › Folders: Viewer role, Alternate rank (public.folder), so a folder of images can be opened (upstream/Config/Info.plist:44-55)
- [ ] File › Document types › Imported UTTypes: "Adobe Photoshop Document" com.adobe.photoshop-image (.psd) and "Adobe Photoshop Large Document" com.adobe.photoshop-large-image (.psb) (upstream/Config/Info.plist:95-131)
- [ ] File › Document types › Exported UTType "Compositor Layer" com.compositor.layer-row (public.data): the drag/paste type for whole layers between projects (upstream/Config/Info.plist:67-76, Document/ProjectWorkspace.swift:199)

## Edit

### Undo / Redo

- [x] Edit › Undo / Redo › Undo (⌘Z): menu title "Undo <action name>" (e.g. "Undo Move Pixels"); disabled when nothing to undo (CompositorApp.swift:43-44, Document/DocumentHistory.swift:36)
- [x] Edit › Undo / Redo › Redo (⇧⌘Z): menu title "Redo <action name>" (CompositorApp.swift:45-46, Document/DocumentHistory.swift:37)
- [x] Edit › Undo / Redo › While text editing, Levels, a busy operation, the New canvas screen, the importer, a rename, or a persistent transform is active, Undo/Redo go to the focused text field's native undo instead of document history (CompositorApp.swift:26-41)
- [x] Edit › Undo / Redo › History unavailable during dialogs, strokes, transforms, imports and similar modal states (Document/EditorSession.swift:650-655)
- [x] Edit › Undo / Redo › First Undo discards a pending (uncommitted) gradient, as in Photoshop (Document/EditorSession.swift:654-659)
- [x] Edit › Undo / Redo › History limit: 100 steps and 256 MiB of pixel memory retained only by history; oldest steps dropped first (Document/DocumentHistory.swift:25-31, Document/DocumentHistory.swift:97-126)
- [x] Edit › Undo / Redo › Each step snapshots the whole document (layers, guides, selection) and the active layer; images are shared, not copied (Document/DocumentHistory.swift:5-17, Document/EditorSession.swift:62-71)
- [x] Edit › Undo / Redo › Selecting layers, navigating, and edits that change nothing create no step and keep redo history (Document/DocumentHistory.swift:62-74)
- [x] Edit › Undo / Redo › Whole gestures are one step (nestable transactions) (Document/DocumentHistory.swift:54-60, Document/EditorSession.swift:681-686)
- [x] Edit › Undo / Redo › Restoring a snapshot cancels crop/gradient, keeps the mask target if valid, and refits the view when the canvas size changed (e.g. a rotation) (Document/EditorSession.swift:669-679)
- [x] Edit › Undo / Redo › Modified state: tracked against the saved revision; undoing back to the saved state reads as unmodified (Document/DocumentHistory.swift:38-44)

### Clipboard

- [x] Edit › Clipboard › Cut (⌘X): in a text field cuts text; with a selection copies the selected pixels then clears them; otherwise beeps (CompositorApp.swift:209-214, Document/SelectionClipboard.swift:141-146)
- [x] Edit › Clipboard › Copy (⌘C) pixels: in a text field copies text; otherwise the active layer's pixels (or its mask as opaque gray) exactly as on the canvas, clipped to the selection with soft edges, at the selection's whole-pixel bounds (whole canvas without one); beeps when there is nothing (CompositorApp.swift:215-220, Document/SelectionClipboard.swift:27-72, Document/SelectionClipboard.swift:111-128)
- [x] Edit › Clipboard › Copy also writes a PNG to the system pasteboard for other apps (Document/SelectionClipboard.swift:130-139)
- [x] Edit › Clipboard › Copy with no selection copies the selected layer(s) whole (folder contents, mask, effects, editable text; adjustments and folders too) for Paste here or in another project (Document/SelectionClipboard.swift:12-19, Document/SelectionClipboard.swift:107-128, Document/SelectionClipboard.swift:217-222)
- [x] Edit › Clipboard › Copy Merged (⇧⌘C): every visible layer composited as shown (opacity, blend modes, masks), clipped to the selection; disabled with an empty selection or no pixel layers (CompositorApp.swift:221-222, Document/SelectionClipboard.swift:74-105)
- [ ] Edit › Clipboard › Paste (⌘V) priority: image as new canvas on the New canvas screen, then text-field paste, then a whole copied layer, then pixels; beeps when nothing applies (CompositorApp.swift:223-232)
- [x] Edit › Clipboard › Paste pixels copied in Compositor: new layer "Layer N" (lowest unused N) exactly where they were copied from (Document/SelectionClipboard.swift:154-160, Document/SelectionClipboard.swift:312-317)
- [x] Edit › Clipboard › Paste image from another app: converted to sRGB RGBA and centered on the canvas (Document/SelectionClipboard.swift:161-166, Document/SelectionClipboard.swift:319-325)
- [x] Edit › Clipboard › Pasted layer placement: above the active layer inside its folder (inside the folder when a folder is active); becomes active; the selection is dropped; undo "Paste" (Document/SelectionClipboard.swift:294-310)
- [x] Edit › Clipboard › Paste a whole copied layer in the same project: copies stack above the originals, selected, undo "Paste" (Document/ProjectWorkspace.swift:200-212, Document/SelectionClipboard.swift:229-255)
- [x] Edit › Clipboard › Paste a whole copied layer into another project tab: layers with descendants copied over, keeping relative positions centered on the canvas, one undo step there; refused with "The copied layers exceed this project's N-megapixel limit." (Document/ProjectWorkspace.swift:213-237)
- [x] Edit › Clipboard › Clipboard freshness: anything copied elsewhere since (pasteboard change count) replaces Compositor's remembered pixels/layers (Document/SelectionClipboard.swift:8-9, Document/SelectionClipboard.swift:17-18, Document/SelectionClipboard.swift:148-152)
- [ ] Edit › Clipboard › Paste on the New canvas screen: an image on the clipboard makes a canvas its size with the image in it; Finder-copied image files (and .psd) are imported; raw PNG/TIFF data goes through a temp file (16 bits kept); a valid size number copied as text pastes into the size field instead (CompositorApp.swift:224-226, Document/SelectionClipboard.swift:169-202)
- [x] Edit › Clipboard › Layer via Copy (⌘J with a selection): the selected pixels become a new layer in place, undo "Layer via Copy"; menu item reads "Layer via Copy" with a selection and "Duplicate Layer" without (CompositorApp.swift:353-354, Document/SelectionClipboard.swift:204-215)

### Fill and delete

- [x] Edit › Fill › Fill with Foreground Color (⌥⌫): fills the selection, or the whole layer without one, with the foreground color, one undo step "Fill"; in a text field deletes the word backward instead (CompositorApp.swift:237-243, Document/SelectionEdits.swift:50-63)
- [x] Edit › Fill › Fill with Background Color (⌘⌫): same with the background color; in a text field deletes to the line start (CompositorApp.swift:244-249, Document/SelectionEdits.swift:50-63)
- [x] Edit › Fill › Fill on a mask target: uses the palette color's gray (reveal/hide), covering the whole canvas past the mask's own area; undo "Fill Mask" (Document/SelectionEdits.swift:52, Document/SelectionEdits.swift:59-62, Document/SelectionEdits.swift:227-231)
- [x] Edit › Fill › Disabled unless one visible pixel layer (or an enabled mask; a folder only via its mask; not an adjustment layer) is targeted and the selection isn't empty (Document/SelectionEdits.swift:47-48, Document/EditorSession+Brush.swift:5-11)
- [x] Edit › Fill › Clear Selection Pixels (menu): image pixels inside the selection become transparent, undo "Clear"; on a mask fills with the background color; disabled without a selection (CompositorApp.swift:250-251, Document/SelectionEdits.swift:65-72, Document/BrushStroke.swift:732-739)
- [x] Edit › Fill › Delete/Backspace key (canvas or Layers panel): a selected effect is removed; else with a selection the pixels are cleared; else the targeted mask (single layer) or every selected layer is deleted (one undo step) (Rendering/EditorCanvas.swift:2273-2275, UI/NativeLayerList.swift:814-815, Document/SelectionEdits.swift:74-88)

### Content-Aware Fill

- [x] Edit › Content-Aware Fill › Content-Aware Fill… (⇧⌫, menu and canvas key): opens the filter panel; disabled without a non-empty selection, on a mask, a folder, a hidden layer, several layers, or while another filter/Hue-Saturation is open (CompositorApp.swift:252-253, Rendering/EditorCanvas.swift:2209-2212, Document/Filters.swift:689-696, Document/HueSaturation.swift:453-461)
- [x] Edit › Content-Aware Fill › Panel text "Fill the selection using surrounding pixels from this layer." (no settings) (UI/FilterSheet.swift:85-87)
- [x] Edit › Content-Aware Fill › Preview toggle, default on; "Limited to the selection" note (UI/FilterSheet.swift:165-172)
- [x] Edit › Content-Aware Fill › Cancel (Esc) / OK (Return); OK waits with "Working…" while the fill is computed and stays disabled on an error; "Applying…" while committing (UI/FilterSheet.swift:174-188)
- [x] Edit › Content-Aware Fill › Algorithm: multi-scale PatchMatch from the layer's unselected opaque pixels (same engine as Spot Healing's Content-Aware mode), seeded; computed at full resolution (Document/ContentFill.swift:8-27, Rendering/PatchPixels.h:12, Document/Filters.swift:622-625)
- [x] Edit › Content-Aware Fill › Extends the layer past its own edges to cover any part of the selection on the canvas beyond them (Document/Filters.swift:725-733, Document/Filters.swift:441)
- [x] Edit › Content-Aware Fill › Error "Not enough unselected, opaque image pixels to synthesize a fill. Use a smaller selection with some surrounding image." (Document/ContentFill.swift:4-7)
- [x] Edit › Content-Aware Fill › Rasterizes a 16-bit layer to 8-bit (Document/Filters.swift:914-919)
- [x] Edit › Content-Aware Fill › Not offered in the Filter menu and not repeated by Last Filter (Document/Filters.swift:29, CompositorApp.swift:336)

### Search Commands

- [x] Edit › Search Commands › Open/close: View › Search Commands…, ⌘F, opens the palette over the editor window; invoking it again while open closes it (CompositorApp.swift:106-109) (UI/CommandPaletteView.swift:81-104)
- [x] Edit › Search Commands › Panel: 460 x 290 pt borderless floating panel centered on the editor window; search field "Search commands and tools" (17 pt) focused on open; closes when it loses key focus or the app deactivates (UI/CommandPaletteView.swift:13-16,49,93-102,119-133)
- [x] Edit › Search Commands › Rows: full path title, current shortcut right-aligned, checkmark on toggles that are on, disabled commands greyed; highlighted row in accent color; "No commands match" when empty (UI/CommandPaletteView.swift:36,52-66)
- [x] Edit › Search Commands › Keyboard: Up/Down move the highlight and wrap at either end; Return runs the highlighted entry; Esc closes; typing resets highlight to the first row; list scrolls to keep the highlight visible (UI/CommandPaletteView.swift:17-20,38-40) (UI/CommandPalette.swift:236,247-252)
- [x] Edit › Search Commands › Mouse: clicking a row runs it (UI/CommandPaletteView.swift:28)
- [x] Edit › Search Commands › Run semantics: disabled entries beep and do not run; running closes the palette, re-focuses the editor window, then performs on the next main-actor turn (UI/CommandPaletteView.swift:110-117)
- [x] Edit › Search Commands › Fuzzy match: query letters (spaces ignored) must appear in order; +1 per letter, +8 at a word start, +5 when consecutive (UI/CommandPalette.swift:30-44)
- [x] Edit › Search Commands › Ranking tiers: whole phrase at a word start (5) > each typed word starting a word in order (4) > phrase anywhere (3) > phrase ignoring spaces (2) > scattered letters (1, ranked by letter score); shorter titles win within a tier; enabled before disabled; empty query lists everything in menu order, enabled first (UI/CommandPalette.swift:45-98)
- [x] Edit › Search Commands › Menu-bar entries: every actionable item of every menu (File, Edit, Select, Image, Filter, Layer, View and their submenus such as Open Recent, New Adjustment Layer, CMYK › Profile, Show, Snap To), titled by path "Menu › Submenu › Item", read afresh at each open so state-dependent titles are current (e.g. "Undo Brush Stroke", "Last Filter: …") (UI/CommandPalette.swift:101-144) (UI/CommandPaletteView.swift:87)
- [x] Edit › Search Commands › Exclusions: the app menu (About/Hide/Quit), Window, Help, Services and "Search Commands…" itself; hidden items and separators (UI/CommandPalette.swift:105-125) (UI/CommandPaletteView.swift:74-75)
- [x] Edit › Search Commands › Duplicate titles disambiguated with "(2)" etc. and re-located by path + occurrence when run; beep if the item no longer exists (UI/CommandPalette.swift:5-7,128-156)
- [x] Edit › Search Commands › Shortcut labels rendered as the menu shows them (⌃⌥⇧⌘ + key; Delete as "Delete") (UI/CommandPalette.swift:158-168)
- [x] Edit › Search Commands › Layer › Add Layer Mask (or "Add Layer Mask from Selection" when a selection exists): adds a revealing mask; enabled when the active layer can take a mask and has none (UI/CommandPalette.swift:175-181)
- [x] Edit › Search Commands › Layer › Add Layer Mask (Hide All) (or "Add Layer Mask Hiding Selection" with a selection): adds a hiding mask (UI/CommandPalette.swift:182-185)
- [x] Edit › Search Commands › Tool › Move / Transform (V) (UI/CommandPalette.swift:194)
- [x] Edit › Search Commands › Tool › Rectangular Marquee (M): selects Marquee in Rectangle mode (UI/CommandPalette.swift:195)
- [x] Edit › Search Commands › Tool › Elliptical Marquee (M): selects Marquee in Ellipse mode (UI/CommandPalette.swift:196)
- [x] Edit › Search Commands › Tool › Lasso (L): freehand mode (UI/CommandPalette.swift:197)
- [x] Edit › Search Commands › Tool › Polygonal Lasso (L): polygonal mode (UI/CommandPalette.swift:198)
- [x] Edit › Search Commands › Tool › Magic Wand (W): wand mode (UI/CommandPalette.swift:199)
- [x] Edit › Search Commands › Tool › Object Selection (W): object mode (UI/CommandPalette.swift:200)
- [x] Edit › Search Commands › Tool › Crop (C) (UI/CommandPalette.swift:201)
- [x] Edit › Search Commands › Tool › Brush (B): paint mode (UI/CommandPalette.swift:202)
- [x] Edit › Search Commands › Tool › Eraser (E): brush in erase mode (UI/CommandPalette.swift:203)
- [x] Edit › Search Commands › Tool › Spot Healing Brush (J) (UI/CommandPalette.swift:204)
- [x] Edit › Search Commands › Tool › Clone Stamp (S) (UI/CommandPalette.swift:205)
- [x] Edit › Search Commands › Tool › Liquify (R): Smear tool in liquify mode (UI/CommandPalette.swift:206)
- [x] Edit › Search Commands › Tool › Blur (R): Smear tool in blur mode (UI/CommandPalette.swift:207)
- [x] Edit › Search Commands › Tool › Smudge (R): Smear tool in smudge mode (UI/CommandPalette.swift:208)
- [x] Edit › Search Commands › Tool › Gradient (G) (UI/CommandPalette.swift:209)
- [x] Edit › Search Commands › Tool › Rectangle (U): Shape tool, rectangle (UI/CommandPalette.swift:210)
- [x] Edit › Search Commands › Tool › Ellipse (U): Shape tool, ellipse (UI/CommandPalette.swift:211)
- [x] Edit › Search Commands › Tool › Line (U): Shape tool, line (UI/CommandPalette.swift:212)
- [x] Edit › Search Commands › Tool › Type (T) (UI/CommandPalette.swift:213)
- [x] Edit › Search Commands › Tool › Eyedropper (I) (UI/CommandPalette.swift:214)
- [x] Edit › Search Commands › Tool › Hand (H) (UI/CommandPalette.swift:215)
- [x] Edit › Search Commands › Tool › Zoom (Z) (UI/CommandPalette.swift:216)
- [x] Edit › Search Commands › Tool entries disabled with no document; the mode is applied only once the tool is actually selected (UI/CommandPalette.swift:218-226)

## Keyboard shortcuts

Every entry below is one remappable definition in `ShortcutDefinition.all` unless marked "fixed". Modifier bits in the source: 1 = ⌘, 2 = ⌥, 4 = ⌃, 8 = ⇧.


### Menus group

- [x] Keyboard shortcuts › Menus › Undo: ⌘Z; menu title becomes "Undo <action name>"; in text fields or modal edits (text draft, Levels, busy, New canvas, importer, renaming, persistent transform) it forwards to the text view's undo instead (UI/KeyboardShortcuts.swift:88, CompositorApp.swift:29-35, CompositorApp.swift:43-44)
- [x] Keyboard shortcuts › Menus › Redo: ⇧⌘Z; title "Redo <action name>"; same text-field fallback as Undo (UI/KeyboardShortcuts.swift:88, CompositorApp.swift:36-41, CompositorApp.swift:45-46)
- [x] Keyboard shortcuts › Menus › New Canvas: ⌘N (UI/KeyboardShortcuts.swift:89, CompositorApp.swift:50-54)
- [x] Keyboard shortcuts › Menus › Open Project: ⌘O (UI/KeyboardShortcuts.swift:89, CompositorApp.swift:55-59)
- [x] Keyboard shortcuts › Menus › Save: ⌘S (UI/KeyboardShortcuts.swift:90, CompositorApp.swift:76-77)
- [x] Keyboard shortcuts › Menus › Save As: ⇧⌘S (UI/KeyboardShortcuts.swift:90, CompositorApp.swift:78-80)
- [x] Keyboard shortcuts › Menus › Export JPEG: ⌥⇧⌘S, opens Export As preset to JPEG (UI/KeyboardShortcuts.swift:91, CompositorApp.swift:83-85)
- [x] Keyboard shortcuts › Menus › Export PNG: ⇧⌘E (UI/KeyboardShortcuts.swift:91, CompositorApp.swift:86-88)
- [x] Keyboard shortcuts › Menus › Export As: ⌥⇧⌘W (UI/KeyboardShortcuts.swift:91, CompositorApp.swift:90-92)
- [x] Keyboard shortcuts › Menus › Close Project: ⌘W (UI/KeyboardShortcuts.swift:92, CompositorApp.swift:94-98)
- [x] Keyboard shortcuts › Menus › Fit Canvas: ⌘0; zooms a dialog's preview instead when one is open (Export As) (UI/KeyboardShortcuts.swift:92, CompositorApp.swift:118-120)
- [x] Keyboard shortcuts › Menus › Search Commands: ⌘F, toggles the command palette (UI/KeyboardShortcuts.swift:92, CompositorApp.swift:106-109)
- [x] Keyboard shortcuts › Menus › Actual Pixels: ⌘1; redirects to dialog preview when open (UI/KeyboardShortcuts.swift:93, CompositorApp.swift:121-123)
- [x] Keyboard shortcuts › Menus › Zoom In: ⌘= (also ⌘+ and keypad +, handled on keyDown with key repeat while the default is unchanged); ignored while a text field has focus (UI/KeyboardShortcuts.swift:93, CompositorApp.swift:124-128, Rendering/EditorCanvas.swift:798-815)
- [x] Keyboard shortcuts › Menus › Zoom Out: ⌘- (also keypad -, key repeat) (UI/KeyboardShortcuts.swift:94, CompositorApp.swift:129-133, Rendering/EditorCanvas.swift:808-812)
- [x] Keyboard shortcuts › Menus › Show Transform Controls: ⌘H, Move tool only (replaces macOS Hide) (UI/KeyboardShortcuts.swift:94, CompositorApp.swift:137-139)
- [ ] Keyboard shortcuts › Menus › "Hide Compositor" entry: ⌥⌘H; despite its title this definition drives the app menu's Hide Others item (matched by original chord); the real Hide Compositor item has no key (UI/KeyboardShortcuts.swift:95, CompositorApp.swift:197-201)
- [x] Keyboard shortcuts › Menus › Cut: ⌘X; text field cut when a text view has focus, else cut selected pixels, else beep (UI/KeyboardShortcuts.swift:95, CompositorApp.swift:209-214)
- [x] Keyboard shortcuts › Menus › Copy: ⌘C; pixels, or whole layer(s) when there is no selection (UI/KeyboardShortcuts.swift:96, CompositorApp.swift:215-220)
- [x] Keyboard shortcuts › Menus › Copy Merged: ⇧⌘C (UI/KeyboardShortcuts.swift:96, CompositorApp.swift:221-222)
- [ ] Keyboard shortcuts › Menus › Paste: ⌘V; order: image as new canvas on the New canvas screen, text field paste, copied layer, pixels, else beep (UI/KeyboardShortcuts.swift:97, CompositorApp.swift:223-232)
- [x] Keyboard shortcuts › Menus › Fill with Foreground: ⌥⌫; in a text field it deletes the word backward instead (UI/KeyboardShortcuts.swift:97, CompositorApp.swift:238-243)
- [x] Keyboard shortcuts › Menus › Fill with Background: ⌘⌫; in a text field it deletes to line start instead (UI/KeyboardShortcuts.swift:98, CompositorApp.swift:244-249)
- [x] Keyboard shortcuts › Menus › Content-Aware Fill: ⇧⌫ (menu and canvas keyDown) (UI/KeyboardShortcuts.swift:98, CompositorApp.swift:252-253, Rendering/EditorCanvas.swift:2209-2212)
- [x] Keyboard shortcuts › Menus › Select All: ⌘A; offered to the responder chain first so text fields keep Select All; never disabled (UI/KeyboardShortcuts.swift:99, CompositorApp.swift:259-267)
- [x] Keyboard shortcuts › Menus › Deselect: ⌘D (UI/KeyboardShortcuts.swift:99, CompositorApp.swift:268-269)
- [x] Keyboard shortcuts › Menus › Inverse Selection: ⇧⌘I (UI/KeyboardShortcuts.swift:100, CompositorApp.swift:270-272)
- [x] Keyboard shortcuts › Menus › Select Subject: ⌥⌘A (UI/KeyboardShortcuts.swift:100, CompositorApp.swift:277-279)
- [x] Keyboard shortcuts › Menus › Last Filter: ⌃⌘F (UI/KeyboardShortcuts.swift:101, CompositorApp.swift:330-334)
- [x] Keyboard shortcuts › Menus › Curves: ⌘M (UI/KeyboardShortcuts.swift:101, CompositorApp.swift:295-296)
- [x] Keyboard shortcuts › Menus › Levels: ⌘L (UI/KeyboardShortcuts.swift:101, CompositorApp.swift:297-298)
- [x] Keyboard shortcuts › Menus › Hue/Saturation: ⌘U (UI/KeyboardShortcuts.swift:102, CompositorApp.swift:299-300)
- [x] Keyboard shortcuts › Menus › Invert Pixels / Mask: ⌘I; title "Invert Mask" when the mask is the edit target (UI/KeyboardShortcuts.swift:102, CompositorApp.swift:305-307)
- [x] Keyboard shortcuts › Menus › Canvas Size: ⌥⌘C (UI/KeyboardShortcuts.swift:103, CompositorApp.swift:309-311)
- [x] Keyboard shortcuts › Menus › Image Size: ⌥⌘I (UI/KeyboardShortcuts.swift:103, CompositorApp.swift:312-314)
- [x] Keyboard shortcuts › Menus › Transform Layer / Selection: ⌘T (UI/KeyboardShortcuts.swift:104, CompositorApp.swift:351-352)
- [x] Keyboard shortcuts › Menus › Duplicate / Layer via Copy: ⌘J (UI/KeyboardShortcuts.swift:104, CompositorApp.swift:353-354)
- [x] Keyboard shortcuts › Menus › Toggle Clipping Mask: ⌥⌘G (UI/KeyboardShortcuts.swift:105, CompositorApp.swift:356-360)
- [x] Keyboard shortcuts › Menus › Group Layers: ⌘G (UI/KeyboardShortcuts.swift:105, CompositorApp.swift:362-363)
- [x] Keyboard shortcuts › Menus › Ungroup Layers: ⇧⌘G (UI/KeyboardShortcuts.swift:106, CompositorApp.swift:364-365)
- [x] Keyboard shortcuts › Menus › New Blank Layer: ⇧⌘N (UI/KeyboardShortcuts.swift:107, CompositorApp.swift:368-369)
- [x] Keyboard shortcuts › Menus › Move Layer Up: ⌘] (UI/KeyboardShortcuts.swift:107, CompositorApp.swift:376-377)
- [x] Keyboard shortcuts › Menus › Move Layer Down: ⌘[ (UI/KeyboardShortcuts.swift:108, CompositorApp.swift:378-379)
- [x] Keyboard shortcuts › Menus › Merge Layers: ⌘E; menu title follows context (Merge Down / Merge Layers / Merge Group) (UI/KeyboardShortcuts.swift:108, CompositorApp.swift:381-382)
- [x] Keyboard shortcuts › Menus › Show Grid: ⌘' (UI/KeyboardShortcuts.swift:109, CompositorApp.swift:165-166)
- [x] Keyboard shortcuts › Menus › Show Guides: ⌘; (UI/KeyboardShortcuts.swift:109, CompositorApp.swift:167-168)
- [x] Keyboard shortcuts › Menus › Show Rulers: ⌘R (UI/KeyboardShortcuts.swift:110, CompositorApp.swift:172-173)
- [x] Keyboard shortcuts › Menus › Snap: ⇧⌘; (UI/KeyboardShortcuts.swift:110, CompositorApp.swift:175-176)
- [x] Keyboard shortcuts › Menus › Lock Guides: ⌥⌘; (UI/KeyboardShortcuts.swift:111, CompositorApp.swift:189-190)
- [x] Keyboard shortcuts › Menus › CMYK Proof Colors: unassigned by default (Photoshop's ⌘Y deliberately not used); assignable in the editor (UI/KeyboardShortcuts.swift:112-113, CompositorApp.swift:144-145)
- [x] Keyboard shortcuts › Menus › CMYK Gamut Warning: unassigned by default (Photoshop's ⇧⌘Y not used); assignable (UI/KeyboardShortcuts.swift:114, CompositorApp.swift:147-149)

### Canvas & Layers group (plain keys, work wherever focus is except text fields)

- [x] Keyboard shortcuts › Canvas › Toggle Fullscreen: F (canvas alone on black; Esc also leaves); the View-menu item binds plain F directly, a text field gets an F meant for it first (UI/KeyboardShortcuts.swift:116, CompositorApp.swift:112-115, IO/CompositorApplicationDelegate.swift:55-70)
- [x] Keyboard shortcuts › Canvas › Select tool (no tool): A (UI/KeyboardShortcuts.swift:116, Rendering/EditorCanvas.swift:2313)
- [x] Keyboard shortcuts › Canvas › Move / Transform tool: V (UI/KeyboardShortcuts.swift:116, Rendering/EditorCanvas.swift:2316)
- [x] Keyboard shortcuts › Canvas › Hand tool: H (UI/KeyboardShortcuts.swift:116, Rendering/EditorCanvas.swift:2317)
- [x] Keyboard shortcuts › Canvas › Zoom tool: Z (UI/KeyboardShortcuts.swift:117, Rendering/EditorCanvas.swift:2318)
- [x] Keyboard shortcuts › Canvas › Brush tool: B, selects Brush in Paint mode (UI/KeyboardShortcuts.swift:117, Rendering/EditorCanvas.swift:2290)
- [x] Keyboard shortcuts › Canvas › Eraser: E, selects Brush in Erase mode (UI/KeyboardShortcuts.swift:117, Rendering/EditorCanvas.swift:2291)
- [x] Keyboard shortcuts › Canvas › Spot Healing: J (UI/KeyboardShortcuts.swift:117, Rendering/EditorCanvas.swift:2292)
- [x] Keyboard shortcuts › Canvas › Clone Stamp: S (UI/KeyboardShortcuts.swift:118, Rendering/EditorCanvas.swift:2293)
- [x] Keyboard shortcuts › Canvas › Type tool: T (UI/KeyboardShortcuts.swift:118, Rendering/EditorCanvas.swift:2294)
- [x] Keyboard shortcuts › Canvas › Gradient tool: G (UI/KeyboardShortcuts.swift:118, Rendering/EditorCanvas.swift:2295)
- [x] Keyboard shortcuts › Canvas › Shape tool: U (UI/KeyboardShortcuts.swift:118, Rendering/EditorCanvas.swift:2296-2298)
- [x] Keyboard shortcuts › Canvas › Eyedropper tool: I (UI/KeyboardShortcuts.swift:119, Rendering/EditorCanvas.swift:2299)
- [x] Keyboard shortcuts › Canvas › Marquee / cycle shape: M; picks the Marquee in its last shape (key repeat ignored) (UI/KeyboardShortcuts.swift:119, Rendering/EditorCanvas.swift:2302)
- [x] Keyboard shortcuts › Canvas › Magic: W (key repeat ignored) (UI/KeyboardShortcuts.swift:119, Rendering/EditorCanvas.swift:2303)
- [x] Keyboard shortcuts › Canvas › Lasso / cycle mode: L (key repeat ignored) (UI/KeyboardShortcuts.swift:120, Rendering/EditorCanvas.swift:2305)
- [x] Keyboard shortcuts › Canvas › Blur / Smudge / Liquify: R (UI/KeyboardShortcuts.swift:120, Rendering/EditorCanvas.swift:2314)
- [x] Keyboard shortcuts › Canvas › Crop tool: C (UI/KeyboardShortcuts.swift:120, Rendering/EditorCanvas.swift:2315)
- [x] Keyboard shortcuts › Canvas › Swap foreground/background: X (UI/KeyboardShortcuts.swift:121, Rendering/EditorCanvas.swift:2288)
- [x] Keyboard shortcuts › Canvas › Reset colors: D (UI/KeyboardShortcuts.swift:121, Rendering/EditorCanvas.swift:2289)
- [x] Keyboard shortcuts › Canvas › Cycle tool mode: Tab (no modifiers, not while editing text): Marquee Rectangle/Ellipse, Wand/Object, Lasso Freehand/Polygonal, Shape kind, Brush Paint/Erase, Smear mode, Spot Healing mode, Clone Stamp sample-all-layers toggle, Gradient shape; no-op for Move, Crop, Type, Eyedropper, Hand, Zoom (UI/KeyboardShortcuts.swift:121, Rendering/EditorCanvas.swift:2276-2280, Document/EditorSession.swift:422-442)
- [x] Keyboard shortcuts › Canvas › Temporary Hand tool: hold Space; released on key up of the same physical key (UI/KeyboardShortcuts.swift:122, Rendering/EditorCanvas.swift:2281-2286, Rendering/EditorCanvas.swift:2323-2329)
- [x] Keyboard shortcuts › Canvas › Delete selection / layer / effect / lasso point: Delete or Forward Delete with no ⌘⌃⌥; removes the last polygon corner while a lasso is drawn (UI/KeyboardShortcuts.swift:122, Rendering/EditorCanvas.swift:2224-2230, Rendering/EditorCanvas.swift:2273-2275, Document/SelectionEdits.swift:76)
- [x] Keyboard shortcuts › Canvas › Apply current canvas operation: Return or keypad Enter (commits Levels, lasso, gradient, crop, transform; also the default button of floating dialogs) (UI/KeyboardShortcuts.swift:123, Rendering/EditorCanvas.swift:2215, Rendering/EditorCanvas.swift:2228, Rendering/EditorCanvas.swift:2237-2252)
- [x] Keyboard shortcuts › Canvas › Cancel current canvas operation: Esc (text box, text draft, Levels, brush/warp stroke, lasso, shape draft, gradient, crop, guide drag, transform; also floating dialogs' Cancel) (UI/KeyboardShortcuts.swift:123, Rendering/EditorCanvas.swift:2204-2251)
- [x] Keyboard shortcuts › Canvas › Decrease brush size: [ ; step = max 1 px or /1.2, clamped 1...2000 px; works with focus anywhere in the window (UI/KeyboardShortcuts.swift:124, Rendering/EditorCanvas.swift:788-793, Rendering/EditorCanvas.swift:2308, Document/EditorSession+Brush.swift:261-268)
- [x] Keyboard shortcuts › Canvas › Increase brush size: ] ; step = max +1 px or x1.2 (UI/KeyboardShortcuts.swift:124, Rendering/EditorCanvas.swift:2309, Document/EditorSession+Brush.swift:261-268)
- [x] Keyboard shortcuts › Canvas › Decrease brush hardness: ⇧[ ; snaps to 25% steps 0/25/50/75/100% (UI/KeyboardShortcuts.swift:127, Rendering/EditorCanvas.swift:2311, Document/EditorSession+Brush.swift:253-260)
- [x] Keyboard shortcuts › Canvas › Increase brush hardness: ⇧] (UI/KeyboardShortcuts.swift:127, Rendering/EditorCanvas.swift:2312, Document/EditorSession+Brush.swift:253-260)
- [x] Keyboard shortcuts › Canvas › Previous blend mode: ⇧- ; active layer's blend mode steps back in menu order, wrapping, one undo step, any tool (UI/KeyboardShortcuts.swift:128, Rendering/EditorCanvas.swift:784-787, Document/LayerAppearance.swift:122-129)
- [x] Keyboard shortcuts › Canvas › Next blend mode: ⇧= / ⇧+ (UI/KeyboardShortcuts.swift:128, Rendering/EditorCanvas.swift:784-787, Document/LayerAppearance.swift:122-129)
- [x] Keyboard shortcuts › Canvas › Cycle shape kind: ⇧U while the Shape tool is active (UI/KeyboardShortcuts.swift:129, Rendering/EditorCanvas.swift:2296-2298)
- [x] Keyboard shortcuts › Canvas › Opacity digits 0-9: ten separately remappable entries; 1 = 10% ... 9 = 90%, 0 = 100%; two digits within 0.6 s set an exact value (4,5 = 45%; 0,5 = 5%; min 1%); sets brush-tool opacity (strength for Smear), gradient opacity, or with Move the selected layers' opacity; also handled in the Layers list (UI/KeyboardShortcuts.swift:130, Rendering/EditorCanvas.swift:2306-2307, Document/EditorSession+Brush.swift:231-252, UI/NativeLayerList.swift:807)
- [x] Keyboard shortcuts › Canvas › Nudge Left/Right/Up/Down 1 px: arrow keys; moves the layer with Move, or the selection outline with a selection tool (four entries) (UI/KeyboardShortcuts.swift:131-132, Rendering/EditorCanvas.swift:2262-2272)
- [x] Keyboard shortcuts › Canvas › Nudge Left/Right/Up/Down 10 px: ⇧+arrow (four entries) (UI/KeyboardShortcuts.swift:132, Rendering/EditorCanvas.swift:2262-2272)
- [x] Keyboard shortcuts › Canvas › Move selected pixels Left/Right/Up/Down 1 px: ⌘+arrow in any tool when a selection exists (four entries) (UI/KeyboardShortcuts.swift:133, Rendering/EditorCanvas.swift:2255-2261)
- [x] Keyboard shortcuts › Canvas › Move selected pixels Left/Right/Up/Down 10 px: ⇧⌘+arrow (four entries) (UI/KeyboardShortcuts.swift:133, Rendering/EditorCanvas.swift:2255-2261)
- [x] Keyboard shortcuts › Canvas › Toggle Levels preview: ⌥P while Levels is open (canvas and the Levels panel's Preview checkbox) (UI/KeyboardShortcuts.swift:141, Rendering/EditorCanvas.swift:2216-2218, UI/LevelsSheet.swift:71)

### Text Editing group (require ⌘, ⌥ or ⌃)

- [x] Keyboard shortcuts › Text Editing › Finish editing text: ⌘Return (UI/KeyboardShortcuts.swift:135)
- [x] Keyboard shortcuts › Text Editing › Decrease tracking: ⌥← (UI/KeyboardShortcuts.swift:136-138)
- [x] Keyboard shortcuts › Text Editing › Decrease tracking by 10: ⌥⇧← (UI/KeyboardShortcuts.swift:136-139)
- [x] Keyboard shortcuts › Text Editing › Increase tracking: ⌥→ (UI/KeyboardShortcuts.swift:136-138)
- [x] Keyboard shortcuts › Text Editing › Increase tracking by 10: ⌥⇧→ (UI/KeyboardShortcuts.swift:136-139)
- [x] Keyboard shortcuts › Text Editing › Decrease leading: ⌥↑ (Up decreases) (UI/KeyboardShortcuts.swift:137-138)
- [x] Keyboard shortcuts › Text Editing › Decrease leading by 10: ⌥⇧↑ (UI/KeyboardShortcuts.swift:137-139)
- [x] Keyboard shortcuts › Text Editing › Increase leading: ⌥↓ (UI/KeyboardShortcuts.swift:137-138)
- [x] Keyboard shortcuts › Text Editing › Increase leading by 10: ⌥⇧↓ (UI/KeyboardShortcuts.swift:137-139)

### Fixed keys (not in the remappable list)

- [x] Keyboard shortcuts › Fixed › Shift+letter tool keys: a tool letter with ⇧ follows the letter's (possibly remapped) assignment unless ⇧ has its own command such as ⇧U (UI/KeyboardShortcuts.swift:226-234)
- [x] Keyboard shortcuts › Fixed › Modifier and mouse gestures (Option = eyedropper in painting tools, Shift constrain/add, Option subtract/from center, ⌘-drag move pixels, ⌘⌥-drag copy, Option-drag duplicate layers/folders/effects, Option-click layer boundary toggles clipping, ⌘-click thumbnail loads selection, Control bypasses snapping, right-drag brush size) are fixed and listed as help text in the editor (UI/KeyboardShortcuts.swift:306-308)
- [x] Keyboard shortcuts › Fixed › System keys ⌘Q quit and ⌃⌘F macOS full screen stay standard; ⌘Q, ⌘, and ⌥⌘M are reserved and cannot be assigned (UI/KeyboardShortcuts.swift:207-209, UI/KeyboardShortcuts.swift:307)
- [x] Keyboard shortcuts › Fixed › Dialog Apply/Cancel buttons (Color Picker, Canvas Size, Image Size, Trim, Filter, Effects, Transform Apply/Cancel, Color Range, Hue/Saturation, Levels, Export As, Grid Settings, Selection amount, New canvas Create) follow the Return/Esc canvas assignments; RAW develop, PSD conversion and the Keyboard Shortcuts editor use the system default/cancel actions (UI/ColorPickerSheet.swift:29-31, UI/CanvasSizeSheet.swift:136-142, UI/ImageSizeSheet.swift:161-167, UI/TrimSheet.swift:48-60, UI/FilterSheet.swift:175-187, UI/EffectsSheet.swift:21-23, UI/TransformInspector.swift:54-56, UI/ColorRangeSheet.swift:41-44, UI/HueSaturationSheet.swift:66-69, UI/LevelsSheet.swift:79-83, UI/ExportAsSheet.swift:186-192, UI/GridSettingsSheet.swift:97-113, UI/LassoControls.swift:233-238, UI/NewCanvasSheet.swift:163, UI/RawDevelopSheet.swift:65-69, UI/PSDConversionSheet.swift:47-48, UI/KeyboardShortcuts.swift:321-322)

### Keyboard Shortcuts editor (Edit › Keyboard Shortcuts…)

- [x] Keyboard shortcuts › Editor › Open: Edit › Keyboard Shortcuts… opens a floating panel titled "Keyboard Shortcuts", 660 pt wide (CompositorApp.swift:236, UI/KeyboardShortcuts.swift:188-190, UI/KeyboardShortcuts.swift:326)
- [x] Keyboard shortcuts › Editor › Instructions line: "Click a shortcut, then press its new key combination, or ⊗ to remove it. Changes apply when you save." (UI/KeyboardShortcuts.swift:272)
- [x] Keyboard shortcuts › Editor › Search field: filters entries by title, case-insensitive (UI/KeyboardShortcuts.swift:274, UI/KeyboardShortcuts.swift:279)
- [x] Keyboard shortcuts › Editor › Groups: Menus, Canvas & Layers, Text Editing, each with a headline (UI/KeyboardShortcuts.swift:277-278)
- [x] Keyboard shortcuts › Editor › Recorder button: shows the chord label (⌃⌥⇧⌘ order, names Delete/Return/Esc/Tab/Space/arrows, "None" when cleared); click to record, shows "Press keys…", next key press becomes the chord; a key that types several characters beeps (UI/KeyboardShortcuts.swift:56-63, UI/KeyboardShortcuts.swift:330-364)
- [x] Keyboard shortcuts › Editor › Remove button (⊗): only on the row being recorded; sets the entry to None (UI/KeyboardShortcuts.swift:292-300)
- [x] Keyboard shortcuts › Editor › Contextual keys & mouse gestures help section (two paragraphs of fixed behaviour) (UI/KeyboardShortcuts.swift:305-308)
- [x] Keyboard shortcuts › Editor › Conflict message in orange: "Choose a single key with optional modifiers.", "Text-editing shortcuts need Command, Option, or Control so they do not replace normal typing.", "<key> is reserved by macOS." (⌘Q, ⌘,, ⌥⌘M), "<key> is assigned to both <a> and <b>." (UI/KeyboardShortcuts.swift:198-214, UI/KeyboardShortcuts.swift:312-316)
- [x] Keyboard shortcuts › Editor › Restore Defaults: clears every override in the draft (UI/KeyboardShortcuts.swift:319)
- [x] Keyboard shortcuts › Editor › Cancel (Esc) closes without saving; Save (Return) applies; Save disabled while recording or with a conflict (UI/KeyboardShortcuts.swift:321-324)
- [x] Keyboard shortcuts › Editor › Persistence: overrides saved as JSON under UserDefaults key keyboardShortcuts.v1; on load each saved chord is kept only if it still names a known command and causes no conflict (UI/KeyboardShortcuts.swift:151-168, UI/KeyboardShortcuts.swift:192-197)
- [x] Keyboard shortcuts › Editor › Remapping mechanism: canvas key events are translated to the original chord; a remapped original key is swallowed; text-editing keys translated separately inside the inline text editor (UI/KeyboardShortcuts.swift:216-247)
- [x] Keyboard shortcuts › Editor › Menu items show the current (possibly remapped) chord via configuredKeyboardShortcut; unassigned menu commands get the user's key via assignableShortcut (UI/KeyboardShortcuts.swift:250-262)

## Preferences/persisted settings

### Preferences window

- [x] Preferences/persisted settings › Preferences window › None: there is no Settings scene / Preferences window (⌘, is reserved and unused); settings live in menus, tool headers and Keyboard Shortcuts, persisted in UserDefaults (CompositorApp.swift:10-25) (UI/KeyboardShortcuts.swift:207)

### Persisted keys (UserDefaults)

- [x] Preferences/persisted settings › Persisted keys › tool.* prefix: person-level toggles kept across tabs and launches; under XCTest compiled defaults are used and nothing is written (Document/ToolDefaults.swift:3-41)
- [x] Preferences/persisted settings › Persisted keys › tool.autoSelect: Move tool Auto Select, default false (Document/EditorSession.swift:198-199)
- [x] Preferences/persisted settings › Persisted keys › tool.transformControls: Show Transform Controls (⌘H), default true (Document/EditorSession.swift:200-202)
- [x] Preferences/persisted settings › Persisted keys › tool.pixelGrid: Pixel Grid, default true (Document/EditorSession.swift:280)
- [x] Preferences/persisted settings › Persisted keys › tool.grid: Show Grid, default false (Document/EditorSession.swift:289)
- [x] Preferences/persisted settings › Persisted keys › tool.gridSpacing: default 64 (Document/EditorSession.swift:291-295)
- [x] Preferences/persisted settings › Persisted keys › tool.gridSubdivisions: default 8 (Document/EditorSession.swift:291-295)
- [x] Preferences/persisted settings › Persisted keys › tool.gridColor: preset name, default Light Gray (Document/EditorSession.swift:298-304)
- [x] Preferences/persisted settings › Persisted keys › tool.gridCustomColor: hex, default 0.7 gray (Document/EditorSession.swift:300,305)
- [x] Preferences/persisted settings › Persisted keys › tool.gridStyle: default Lines (Document/EditorSession.swift:301,306)
- [x] Preferences/persisted settings › Persisted keys › tool.gridOpacity: default 45 (Document/EditorSession.swift:302,307)
- [x] Preferences/persisted settings › Persisted keys › tool.guides: Show Guides, default true (Document/EditorSession.swift:311)
- [x] Preferences/persisted settings › Persisted keys › tool.rulers: Rulers, default false (Document/EditorSession.swift:328)
- [x] Preferences/persisted settings › Persisted keys › tool.snap: Snap master switch, default true (Document/EditorSession.swift:330-336)
- [x] Preferences/persisted settings › Persisted keys › tool.snapGuides: default true (Document/EditorSession.swift:337)
- [x] Preferences/persisted settings › Persisted keys › tool.snapGrid: default false (Document/EditorSession.swift:338)
- [x] Preferences/persisted settings › Persisted keys › tool.snapLayers: default true (Document/EditorSession.swift:339)
- [x] Preferences/persisted settings › Persisted keys › tool.snapBounds: Snap To Document Bounds, default true (Document/EditorSession.swift:340)
- [x] Preferences/persisted settings › Persisted keys › tool.lockGuides: default false (Document/EditorSession.swift:341)
- [x] Preferences/persisted settings › Persisted keys › layersPanelWidth: Layers panel width in pt, default 252, clamped to 222–352, changed by dragging the panel's left divider (ContentView.swift:5-6,124-126,374-394) (UI/LayersPanel.swift:9)
- [x] Preferences/persisted settings › Persisted keys › navigator.visible: View › Navigator, default false (CompositorApp.swift:8) (ContentView.swift:7)
- [x] Preferences/persisted settings › Persisted keys › cmykProfile: name of the chosen CMYK proof/export profile, default Generic CMYK Profile (IO/CMYK.swift:101-110)
- [ ] Preferences/persisted settings › Persisted keys › jpegExportQuality: last JPEG quality used in Export As (0–1), default 0.85 (UI/ExportAsSheet.swift:21,30-33,189) (IO/ImageExporter.swift:283-284)
- [x] Preferences/persisted settings › Persisted keys › keyboardShortcuts.v1: JSON map of user shortcut overrides (owned by Keyboard shortcuts section) (UI/KeyboardShortcuts.swift:151,156-168,192-197)
- [ ] Preferences/persisted settings › Persisted keys › CompositorCPUCanvas: hidden debug switch forcing the Core Graphics canvas, default false (Rendering/EditorCanvas.swift:2684-2685)
- [ ] Preferences/persisted settings › Persisted keys › UpdateFeedURL: DEBUG builds only, overrides the Sparkle feed and checks at launch (IO/UpdateDriver.swift:175-183) (IO/CompositorApplicationDelegate.swift:85-88)
- [ ] Preferences/persisted settings › Persisted keys › NSDisabledDictationMenuItem / NSDisabledCharacterPaletteMenuItem registered true to drop Start Dictation and Emoji & Symbols from Edit (IO/CompositorApplicationDelegate.swift:41-42)
- [ ] Preferences/persisted settings › Persisted keys › Sparkle state: automatic checks on (SUEnableAutomaticChecks), "automatically download and install" preference set from the update alert's checkbox (upstream/Config/Info.plist:63-64) (IO/UpdateDriver.swift:33-47)

### Other persisted state

- [ ] Preferences/persisted settings › Other persisted state › Recent projects: kept by macOS NSDocumentController (shared with the Dock menu), filtered to files that still exist, refreshed whenever the app becomes active (IO/RecentProjects.swift:4-33)
- [x] Preferences/persisted settings › Other persisted state › Loaded CMYK profiles copied to ~/Library/Application Support/CMYK Profiles (IO/CMYK.swift:31-36,58-59,81-83)
- [ ] Preferences/persisted settings › Other persisted state › Floating panel positions remembered per panel (levelsPanel, adjustmentPanel, selectionAmountPanel, colorRangePanel, filterPanel, effectsPanel, colorPickerPanel, keyboardShortcuts) for the app session only, not across launches (UI/FloatingPanel.swift:17-18,100-103) (ContentView.swift:12-17) (UI/ColorPickerSheet.swift:172) (UI/KeyboardShortcuts.swift:150)
- [ ] Preferences/persisted settings › Other persisted state › Window size/position restored by macOS after the first launch (CompositorApp.swift:18-22)
- [x] Preferences/persisted settings › Other persisted state › Not persisted (reset each launch): brush/tool options outside the tool.* keys, current tool (Move), Proof Colors and Gamut Warning toggles (Document/EditorSession.swift:172,203,282,285)

## App-level

### Project tabs

- [ ] App-level › Project tabs › Tab strip in the toolbar: capsule pills after the New canvas button, as wide as the toolbar allows (window width - 352 pt, min 200) (ContentView.swift:189-198) (UI/ProjectTabs.swift:50-107)
- [ ] App-level › Project tabs › Tab title: project file name without extension, else "Untitled"; new tabs take the lowest free "Untitled N" (Document/ProjectWorkspace.swift:11,37-43)
- [x] App-level › Project tabs › New tab: New Canvas (⌘N) or the toolbar + button opens a new tab (IO/ProjectController.swift:313-314) (Document/ProjectWorkspace.swift:49-55,72-76)
- [x] App-level › Project tabs › Opening a project opens it in a new tab; if it is already open its tab is selected; a lone blank tab is replaced; a failed open never leaves a broken tab (Document/ProjectWorkspace.swift:78-107)
- [ ] App-level › Project tabs › Switch tabs by clicking; blocked while a dialog, filter, Hue/Saturation, gradient, pixel move or color picker is in progress; a pending transform is committed on switch (Document/ProjectWorkspace.swift:26-30,65-71) (UI/ProjectTabs.swift:345,357)
- [ ] App-level › Project tabs › Close button (x, help "Close <title>") on each tab; hidden for the only tab when it is blank; asks to save unsaved changes; closing the last tab leaves a fresh blank one; selection moves to the neighbour at the same index (UI/ProjectTabs.swift:365-374) (Document/ProjectWorkspace.swift:44-47,108-121)
- [x] App-level › Project tabs › File › Close Project (⌘W) closes the current tab (IO/ProjectController.swift:321-324) (CompositorApp.swift:94-98)
- [ ] App-level › Project tabs › Unsaved indicator: 5 pt dot before the title of a modified tab (accessibility "Unsaved changes") (UI/ProjectTabs.swift:216-221,347-349) (Document/EditorSession.swift:649)
- [ ] App-level › Project tabs › Active tab styling: semibold title, brighter fill and border; inactive medium weight; label width 35–155 pt (UI/ProjectTabs.swift:216-226,350,377-378)
- [ ] App-level › Project tabs › Reorder by dragging a tab (>= 3 pt): the tab follows the pointer, others slide aside with a 0.15 s ease-out, drop commits; dragging selects the tab; not an undoable edit (UI/ProjectTabs.swift:21-48,140-214,362-364) (Document/ProjectWorkspace.swift:56-64)
- [ ] App-level › Project tabs › Overflow: tabs that don't fit collapse into a leftmost "N more tabs ⌄" pill (oldest first); clicking it pops up a menu of hidden tabs (• prefix if unsaved); the selected tab is never hidden (UI/ProjectTabLayout.swift:28-78) (UI/ProjectTabs.swift:271-335)
- [ ] App-level › Project tabs › Drop onto a tab: files, images or layer rows dropped on a tab are added to that project (tab highlights, help "Add to <title>") (UI/ProjectTabs.swift:377-381,413-434)
- [ ] App-level › Project tabs › "New" drop slot: appears at the end of the strip while an external file/image/layer drag is in the air; dropping there (or anywhere on the bar that isn't a tab) opens the drop in a new project, one tab per image (UI/ProjectTabs.swift:99-102,117-137,251-269) (Document/ProjectWorkspace.swift:164-184)
- [ ] App-level › Project tabs › New canvas toolbar button is also a drop target: "Drop images here for new tabs" (ContentView.swift:182-187) (UI/ProjectTabs.swift:385-395)
- [ ] App-level › Project tabs › Layer rows dragged onto another tab/canvas/new slot copy those layers (folders with contents) into that project as one undo step "Copy Layers from Project"; a new project is sized to the dragged pixels; clipped layers whose base isn't copied are baked; error when over the megapixel budget (Document/ProjectWorkspace.swift:185-199,217-289)
- [ ] App-level › Project tabs › A layer cannot be dropped back onto its own tab or canvas; Option-dragging a layer stays inside the Layers panel (duplicate) and is refused as a cross-project drop (UI/ProjectTabs.swift:397-422)
- [ ] App-level › Project tabs › Empty title-bar area beside the tabs drags the window (UI/ProjectTabs.swift:236-249,95-96)
- [ ] App-level › Project tabs › No tab context menu (tabs have click, drag, close and drop only) (UI/ProjectTabs.swift:337-383)

### Windows

- [ ] App-level › Windows › Single editor window: one SwiftUI Window scene "Compositor" (id "editor"); multiple projects live in tabs, not windows; opening files never spawns new windows (CompositorApp.swift:11-17)
- [ ] App-level › Windows › Default size 1180 x 780 pt; first launch fills the screen's visible area (not full screen); later launches restore the last size (CompositorApp.swift:14,18-22)
- [ ] App-level › Windows › Minimum content size 800 x 520 pt (ContentView.swift:147)
- [ ] App-level › Windows › Unified compact toolbar without a window title; project name is on its tab (CompositorApp.swift:23-24) (UI/ProjectWindowBridge.swift:12) (ContentView.swift:180)
- [ ] App-level › Windows › Toolbar contents: New canvas (+), tab strip, flexible space, Fit, 100%, zoom in/out (ContentView.swift:181-223)
- [x] App-level › Windows › Main layout: tool header bar (42 pt) on top, tool rail (56 pt, scrolls without scrollbars, tools then color palette) on the left, rulers, canvas, resizable Layers panel on the right, status bar at the bottom (ContentView.swift:27-78,80-136,310-343) (UI/ToolHeaderStyle.swift:5)
- [x] App-level › Windows › Layers panel resize: drag its left divider (column-resize cursor, help "Drag to resize the panel"), 222–352 pt (ContentView.swift:124-126,374-394)
- [ ] App-level › Windows › Window proxy: represented URL set to the project file and the close button shows the edited dot when modified (UI/ProjectWindowBridge.swift:8-13)
- [ ] App-level › Windows › Closing the window (red button): asks about every tab's unsaved changes (current first), then closes and leaves one fresh blank tab; reopening via Dock click (UI/ProjectWindowBridge.swift:45-55) (Document/ProjectWorkspace.swift:158-162) (IO/CompositorApplicationDelegate.swift:192-195)

### Auto update

- [ ] App-level › Auto update › Check for Updates…: app menu item after About, runs a user-initiated Sparkle check (CompositorApp.swift:102-104)
- [ ] App-level › Auto update › Sparkle updater started 1 s after launch (so its first-run prompt doesn't block the window); automatic checks enabled; feed https://raw.githubusercontent.com/robbietilton/Compositor/main/appcast.xml; EdDSA-signed; installer launcher service (IO/CompositorApplicationDelegate.swift:9-17,83-89) (upstream/Config/Info.plist:57-64)
- [ ] App-level › Auto update › Update-found alert: "A new version of Compositor is available!", "<version> is now available — you have <current>. Would you like to download it now?" (or "is ready to install" once downloaded); app icon aligned with the title (IO/UpdateDriver.swift:12-41,56-79)
- [ ] App-level › Auto update › What's new list: the appcast item's <changes> text, one bullet per line (leading bullets/dashes stripped), under a "What’s new" heading; release-notes web view not used (IO/UpdateDriver.swift:107-142,149-150) (upstream/appcast.xml:12-18)
- [ ] App-level › Auto update › Buttons: Install Update / Install and Relaunch, Remind Me Later, Skip This Version (IO/UpdateDriver.swift:30-32,48-52)
- [ ] App-level › Auto update › Checkbox "Automatically download and install updates in the future" (when allowed), reflecting and setting Sparkle's automaticallyDownloadsUpdates (IO/UpdateDriver.swift:33-37,45-47)
- [ ] App-level › Auto update › Every other update step (permission request, checking, download progress, extraction, ready to install, installing, errors, no update) uses Sparkle's standard UI (IO/UpdateDriver.swift:144-172)
- [ ] App-level › Auto update › Appcast content: version 1.5.3 (build 49), minimum macOS 26.0, DMG enclosure from GitHub Releases (upstream/appcast.xml:5-19)

### Drag and drop

- [x] App-level › Drag and drop › Drop onto the canvas: file URLs, image data and Layers-panel rows; images are added as layers centered at the drop point (in document coordinates when over the canvas); with no document the first image sets the canvas size regardless of drop point (ContentView.swift:149-165) (Document/EditorSession.swift:855-858)
- [ ] App-level › Drag and drop › Drop highlight: 3 pt accent rounded rectangle around the canvas while a valid drag hovers; not shown for a layer dragged from this same project (ContentView.swift:18-25,166-173)
- [ ] App-level › Drag and drop › Drops refused while Levels is open, the project is busy, the New canvas screen or importer is showing, or a layer is being renamed (ContentView.swift:150)
- [x] App-level › Drag and drop › Non-file image data (screenshot thumbnails, images from web pages/other apps) is copied to a temporary file keeping its name, then imported; types tried: PNG, JPEG, HEIC, HEIF, TIFF, WebP, PSD, PSB, RAW, any image (IO/ImageFileDrop.swift:21-23,35-59)
- [ ] App-level › Drag and drop › Unreadable drop message: "Some dropped items couldn’t be read. Drag JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) files from Finder." (IO/ImageFileDrop.swift:29-32)
- [x] App-level › Drag and drop › Dropped folders import the images directly inside them in name order; an empty folder reports "“<name>” has no images to import." (Document/EditorSession.swift:819-834) (ContentView.swift:283-285)
- [x] App-level › Drag and drop › Dropped .comp packages open as projects (in their own tab, or switch to the tab already showing them) (Document/ProjectWorkspace.swift:174-175,96-99)
- [ ] App-level › Drag and drop › Files opened from Finder or dropped on the Dock icon: reopen the editor window if closed, activate the app, open .comp as tabs and each image as a new project tab (IO/CompositorApplicationDelegate.swift:19-31) (Document/ProjectWorkspace.swift:164-184)

### App delegate behaviours

- [ ] App-level › App delegate behaviours › Launched by opening a file: the app sends itself a reopen event so the editor window appears (IO/CompositorApplicationDelegate.swift:25-27,33-38)
- [ ] App-level › App delegate behaviours › Dock icon click with no visible window reopens the editor (IO/CompositorApplicationDelegate.swift:192-195)
- [ ] App-level › App delegate behaviours › Quit (⌘Q): finishes text being typed, applies a pending gradient or pixel move, cancels any open dialog (filter, Levels, Hue/Saturation, adjustment, Color Range, selection amount, color picker), then asks about each tab's unsaved changes, current tab first then left to right; beeps and cancels if something must finish first (IO/CompositorApplicationDelegate.swift:197-203) (Document/ProjectWorkspace.swift:122-157)
- [ ] App-level › App delegate behaviours › Unsaved-changes alert: "Save changes to <name>?" / "Your changes will be lost if you don’t save them." with Save, Cancel, Don’t Save; waits for a running save to finish first (IO/ProjectController.swift:340-352)
- [x] App-level › App delegate behaviours › Always dark: NSApp appearance forced to Dark Aqua (alerts and panels included) (IO/CompositorApplicationDelegate.swift:43-44) (ContentView.swift:175)
- [ ] App-level › App delegate behaviours › System menu extras removed: Writing Tools, AutoFill, Start Dictation, Emoji & Symbols (Edit) and Enter Full Screen (View), re-removed whenever menus open; separators tidied (IO/CompositorApplicationDelegate.swift:41-42,50-54,73-82,156-190)
- [ ] App-level › App delegate behaviours › App menu visibility items: Hide Compositor (no shortcut, because ⌘H is Show Transform Controls), Hide Others (⌥⌘H, configured through the shortcut entry titled "Hide Compositor"), Show All (CompositorApp.swift:195-202) (UI/KeyboardShortcuts.swift:95)
- [x] App-level › App delegate behaviours › Slider track clicks installed globally at launch (see Shared controls) (IO/CompositorApplicationDelegate.swift:45-46)

### Floating panels

- [x] App-level › Floating panels › Non-modal floating panels for tool dialogs (Levels, Hue/Saturation, Color Range, selection Expand/Contract/Feather, filters, layer effects, color picker, Keyboard Shortcuts): titled, closable, never dim the editor, hide when the app deactivates (UI/FloatingPanel.swift:12-16,87-96) (ContentView.swift:228-279)
- [x] App-level › Floating panels › Placement automatic: first open centered on the canvas; reopens where last left during the session; content changes don't move an open panel (UI/FloatingPanel.swift:4-7,56-70,98-121)
- [x] App-level › Floating panels › Placement docked right (Camera Raw): full height of the editor window, 440 pt wide, flush right, following the window as it moves/resizes; its frame is not remembered (UI/FloatingPanel.swift:8-9,48-55,123-165) (ContentView.swift:275-277)
- [x] App-level › Floating panels › Closing a panel with its close button acts as Cancel (UI/FloatingPanel.swift:12-14,167-170) (ContentView.swift:231,238,245,251,265,274)
- [x] App-level › Floating panels › Panel titles: "Levels", "Color Range", "Hue/Saturation", the effect's name, "<Expand|Contract|Feather> Selection", the filter's name (ContentView.swift:232,239,246,252,266,276)
- [ ] App-level › Floating panels › Keyboard focus returns to a panel after a canvas click (refocus) (UI/FloatingPanel.swift:172-175)

### Shared controls

- [x] App-level › Shared controls › Scrubbable labels: drag a field's label (or its unit) left/right to change the value, resize cursor on hover, per-field sensitivity, optional step snapping, clamped to the field's range (UI/NumericScrub.swift:4-63) (UI/ToolHeaderStyle.swift:20-35)
- [x] App-level › Shared controls › Slider track click: clicking a slider's track puts the knob there immediately (no glide), then dragging continues; applies to every slider (UI/SliderSnap.swift:4-42)
- [x] App-level › Shared controls › Arrow-key stepping: Up/Down in a focused numeric field step the value by its step (default 1), Shift x10, only while the field is being edited (ContentView.swift:411-485)
- [x] App-level › Shared controls › Return or Escape in a property field gives focus back to the canvas so tool keys work at once (ContentView.swift:402-409)
- [x] App-level › Shared controls › Unit suffixes ("%", "px") kept tight against their fields (UI/ToolHeaderStyle.swift:10-19)
- [x] App-level › Shared controls › Tool rail scrolls when the window is too short, without showing a scrollbar (UI/IndicatorlessScrollView.swift:4-48) (ContentView.swift:310-343)
- [x] App-level › Shared controls › Capsule-shaped bordered buttons and pop-up menus app-wide (ContentView.swift:396-400)

### Busy and errors

- [x] App-level › Busy and errors › Busy gate: long operations block overlapping edits immediately; controls dim and the status bar shows a spinner with "Working…" only after 250 ms; "Importing images…" while importing (Document/EditorSession.swift:116-148) (ContentView.swift:358-363)
- [ ] App-level › Busy and errors › File requests (open, import, drops) wait until no dialog, stroke, rename or other operation is in progress, then run (Document/EditorSession.swift:151-170)

## Status bar and hints

### Status bar layout

- [x] Status bar and hints › Layout › Bar: 30 pt tall strip below the canvas and panels, 11 pt monospaced-digit secondary text, 18 pt side padding, keeps its height when the window is short; hidden in Fullscreen/canvas-only (ContentView.swift:129-134, ContentView.swift:349-371)
- [x] Status bar and hints › Layout › Zoom readout: current zoom as a percent with 0-1 decimals (e.g. 66.7%), 62 pt wide (ContentView.swift:352-353)
- [x] Status bar and hints › Layout › Canvas dimensions: "<width> × <height> px" (ContentView.swift:354)
- [x] Status bar and hints › Layout › Color mode label: fixed "sRGB · Transparent" (ContentView.swift:355)
- [x] Status bar and hints › Layout › Empty state: "Ready when you are" with no document (ContentView.swift:356)
- [x] Status bar and hints › Layout › Busy indicator: mini spinner + "Working…" once an operation has run 250 ms (ContentView.swift:358-360, Document/EditorSession.swift:130-148)
- [x] Status bar and hints › Layout › Import indicator: mini spinner + "Importing images…" (ContentView.swift:361-363)
- [x] Status bar and hints › Layout › Tool hint: right-aligned one-line hint for the active tool and mode, replaced by the busy/import indicators (ContentView.swift:364-366)

### Tool hints (exact text, ContentView.swift:365)

- [x] Status bar and hints › Hint › Marquee Rectangle: "Drag a rectangle · Shift add · Option subtract · Shift again mid-drag square · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Marquee Ellipse: "Drag an ellipse · Shift add · Option subtract · Shift again mid-drag circle · Drag inside to move · Delete clears · ⌘D deselect" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Magic Wand: "Click to select similar colors · Tab for Object · Shift add · Option subtract · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Magic Object: "Click an object to select its outline · Tab for Wand · Shift add · Option subtract · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Lasso Freehand: "Drag to select · Drag inside to move · Shift add · Option subtract · Delete clears · ⌥⌫/⌘⌫ fill · ⌘D deselect" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Lasso Polygonal: "Click corners · Click start, double-click or Enter to close · Delete removes corner · Escape cancel" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Brush Paint: "Drag to paint · [ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Brush Erase: "Drag to erase · [ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Smear Blur: "Drag to soften · [ ] size · Shift-[ ] hardness · 1–0 strength · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Smear Smudge: "Drag to smudge · [ ] size · Shift-[ ] hardness · 1–0 strength · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Smear Liquify: "Drag to push pixels · [ ] size · Shift-[ ] hardness · 1–0 strength · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Clone Stamp: "Option-click to set the source · Drag to clone · [ ] size · Shift-[ ] hardness · 1–0 opacity · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Spot Healing: "Drag over blemishes to heal · [ ] size · Shift-[ ] hardness · Escape cancel · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Type: "Drag a text box · Click text to edit · Drag box handles to resize · ⌘Return finish · Escape cancel" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Shape: "Drag to draw a shape on a new layer · Shift <45° for Line | square for Rectangle | circle otherwise> · Option from center · Shift-U or Tab for the next shape · Escape cancel · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Gradient: "Drag to draw · Drag ends to adjust · Shift 45° · 1–0 opacity · Enter apply · Escape cancel" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Crop: "Drag to crop · Enter apply · Escape cancel · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Move: "Drag to move · Handles to resize · Circle to rotate · 1–0 layer opacity · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Hand: "Drag to pan · Pinch to zoom" (ContentView.swift:365)
- [x] Status bar and hints › Hint › No tool: "No tool selected · Press a tool's key to pick one · Space to pan" (ContentView.swift:365)
- [x] Status bar and hints › Hint › Zoom (and fallback for Eyedropper): "Click to zoom in · Option-click to zoom out · Drag right or left to zoom smoothly · Space to pan"; the Eyedropper has no hint of its own and shows this text (ContentView.swift:365)

### Other on-canvas hints

- [x] Status bar and hints › Canvas badges › Foot-of-canvas badges stack (proof colors, gamut warning, mask-alone) placed above the bottom edge clear of the rotate handle (ContentView.swift:104-113)

### Help text (tooltips, captions, accessibility labels and messages not quoted in the areas above; generated by scanning every string literal)

- [x] Status bar and hints › Help text › BrushControls › "Aligned" tooltip: "Keep the source moving with the brush between strokes; off starts every stroke at the source point" (UI/BrushControls.swift:33)
- [x] Status bar and hints › Help text › BrushControls › tooltip: "Copy from the active layer only, or from every visible layer as shown" (UI/BrushControls.swift:39)
- [x] Status bar and hints › Help text › BrushControls › tooltip: "The brush trails the pointer on a string this long, so a shaky hand still draws a smooth line" (UI/BrushControls.swift:98)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Parametric lifts tonal regions. Point places anchors on the curve." (UI/CameraRawColorControls.swift:20)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "RGB changes brightness. Red, green, and blue also shift the color." (UI/CameraRawColorControls.swift:27)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Input and output of the selected curve point." (UI/CameraRawColorControls.swift:45)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Strong Contrast" tooltip: "Replaces this curve with a straight line or a contrast curve." (UI/CameraRawColorControls.swift:53)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Drag on the picture to move the curve for the tone under the pointer." (UI/CameraRawColorControls.swift:58)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "HSL lists every color. Color edits one family. Point Color adjusts a color you pick." (UI/CameraRawColorControls.swift:279)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Hue shifts the color, Saturation its strength, and Luminance its brightness." (UI/CameraRawColorControls.swift:286)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Drag a color in the picture. Nearby color families move together." (UI/CameraRawColorControls.swift:302)
- [x] Status bar and hints › Help text › CameraRawColorControls › icon button eyedropper tooltip: "Click the picture to save a color. Up to eight colors." (UI/CameraRawColorControls.swift:363)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Select this picked color." (UI/CameraRawColorControls.swift:373)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Hue Shift" tooltip: "Shifts the picked color around the color wheel." (UI/CameraRawColorControls.swift:377)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Saturation Shift" tooltip: "Makes the picked color stronger or quieter." (UI/CameraRawColorControls.swift:379)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Luminance Shift" tooltip: "Makes the picked color lighter or darker." (UI/CameraRawColorControls.swift:381)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Hue Range" tooltip: "How far in hue the adjustment reaches." (UI/CameraRawColorControls.swift:383)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Saturation Range" tooltip: "How far in saturation the adjustment reaches." (UI/CameraRawColorControls.swift:384)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Luminance Range" tooltip: "How far in brightness the adjustment reaches." (UI/CameraRawColorControls.swift:385)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Visualize Range" tooltip: "Dims the picture outside this color's range. It is not kept when you press OK." (UI/CameraRawColorControls.swift:388)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Three-Way shows shadows, midtones, and highlights. The other choices show one wheel." (UI/CameraRawColorControls.swift:441)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Drag inside the wheel. Angle sets hue, distance sets saturation." (UI/CameraRawColorControls.swift:472)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Hue and saturation of this wheel." (UI/CameraRawColorControls.swift:479)
- [x] Status bar and hints › Help text › CameraRawColorControls › "Hue and saturation of this wheel." tooltip: "Brightness added by this wheel." (UI/CameraRawColorControls.swift:481)
- [x] Status bar and hints › Help text › CameraRawColorControls › tooltip: "Drag to set hue and saturation. Double-click to reset this wheel." (UI/CameraRawColorControls.swift:534)
- [x] Status bar and hints › Help text › CameraRawControls › tooltip: "Red, green, and blue of the pixel under the pointer." (UI/CameraRawControls.swift:60)
- [x] Status bar and hints › Help text › CameraRawControls › "Contrast" tooltip: "Makes light and dark tones more or less different, mostly around the middle." (UI/CameraRawControls.swift:204)
- [x] Status bar and hints › Help text › CameraRawControls › "Highlights" tooltip: "Adjusts the bright parts of the picture. Hold Option to see clipped highlights." (UI/CameraRawControls.swift:206)
- [x] Status bar and hints › Help text › CameraRawControls › "Shadows" tooltip: "Adjusts the dark parts of the picture. Hold Option to see clipped shadows." (UI/CameraRawControls.swift:208)
- [x] Status bar and hints › Help text › CameraRawControls › "Whites" tooltip: "Sets the brightest point. Hold Option to see clipped highlights." (UI/CameraRawControls.swift:210)
- [x] Status bar and hints › Help text › CameraRawControls › "Blacks" tooltip: "Sets the darkest point. Hold Option to see clipped shadows." (UI/CameraRawControls.swift:212)
- [x] Status bar and hints › Help text › CameraRawControls › "White Balance" tooltip: "Auto balances the average color. Custom follows Temperature and Tint." (UI/CameraRawControls.swift:220)
- [x] Status bar and hints › Help text › CameraRawControls › tooltip: "Auto balances the average color. Custom follows Temperature and Tint." (UI/CameraRawControls.swift:225)
- [x] Status bar and hints › Help text › CameraRawControls › tooltip: "Click a pixel that should be neutral." (UI/CameraRawControls.swift:234)
- [x] Status bar and hints › Help text › CameraRawControls › "Temperature" tooltip: "Shifts the picture from blue to yellow." (UI/CameraRawControls.swift:242)
- [x] Status bar and hints › Help text › CameraRawControls › "Tint" tooltip: "Shifts the picture from green to mauve." (UI/CameraRawControls.swift:244)
- [x] Status bar and hints › Help text › CameraRawControls › "Vibrance" tooltip: "Strengthens quiet colors more than colors that are already strong, and protects skin tones." (UI/CameraRawControls.swift:246)
- [x] Status bar and hints › Help text › CameraRawControls › "Saturation" tooltip: "Strengthens or weakens every color by the same amount." (UI/CameraRawControls.swift:248)
- [x] Status bar and hints › Help text › CameraRawControls › "Texture" tooltip: "Adds or softens small detail." (UI/CameraRawControls.swift:255)
- [x] Status bar and hints › Help text › CameraRawControls › "Clarity" tooltip: "Adds or softens contrast along broader shapes." (UI/CameraRawControls.swift:257)
- [x] Status bar and hints › Help text › CameraRawControls › "Dehaze" tooltip: "Clears haze when raised, and adds haze when lowered." (UI/CameraRawControls.swift:259)
- [x] Status bar and hints › Help text › CameraRawControls › "Glow" tooltip: "Spreads a glow from the bright areas." (UI/CameraRawControls.swift:262)
- [x] Status bar and hints › Help text › CameraRawControls › tooltip: "Diffusion is soft and wide, Bloom is tighter, and Halation is a red fringe." (UI/CameraRawControls.swift:266)
- [x] Status bar and hints › Help text › CameraRawControls › "Range" tooltip: "Chooses how bright an area must be to glow. Has no effect until Glow is raised." (UI/CameraRawControls.swift:269)
- [x] Status bar and hints › Help text › CameraRawControls › "Spread" tooltip: "Sets how far the glow reaches. Has no effect until Glow is raised." (UI/CameraRawControls.swift:271)
- [x] Status bar and hints › Help text › CameraRawControls › "Warmth" tooltip: "Shifts the glow from cool to warm. Halation stays red. Has no effect until Glow is raised." (UI/CameraRawControls.swift:273)
- [x] Status bar and hints › Help text › CameraRawControls › "Amount" tooltip: "Darkens or lightens the edges. The center does not change." (UI/CameraRawControls.swift:278)
- [x] Status bar and hints › Help text › CameraRawControls › tooltip: "Highlight Priority protects bright edges. Color Priority also reduces color. Paint Overlay covers the edges evenly." (UI/CameraRawControls.swift:282)
- [x] Status bar and hints › Help text › CameraRawControls › "Midpoint" tooltip: "Sets where the vignette begins, from the center outward." (UI/CameraRawControls.swift:285)
- [x] Status bar and hints › Help text › CameraRawControls › "Roundness" tooltip: "Makes the vignette rounder or more square." (UI/CameraRawControls.swift:287)
- [x] Status bar and hints › Help text › CameraRawControls › "Feather" tooltip: "Softens the edge of the vignette." (UI/CameraRawControls.swift:289)
- [x] Status bar and hints › Help text › CameraRawControls › "Highlights" tooltip: "Protects bright pixels while a dark vignette is applied. Used by Highlight Priority." (UI/CameraRawControls.swift:291)
- [x] Status bar and hints › Help text › CameraRawControls › "Amount" tooltip: "Adds film grain, strongest in the middle tones." (UI/CameraRawControls.swift:296)
- [x] Status bar and hints › Help text › CameraRawControls › "Size" tooltip: "Makes the grain coarser or finer." (UI/CameraRawControls.swift:298)
- [x] Status bar and hints › Help text › CameraRawControls › "Roughness" tooltip: "Makes the grain smoother or more uneven." (UI/CameraRawControls.swift:300)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Amount" tooltip: "Controls how strong the sharpening is." (UI/CameraRawDetailOpticsControls.swift:13)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Radius" tooltip: "How far from each edge the sharpening reaches, in pixels." (UI/CameraRawDetailOpticsControls.swift:15)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Detail" tooltip: "Emphasizes fine texture over broader edges." (UI/CameraRawDetailOpticsControls.swift:17)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Masking" tooltip: "Limits sharpening to stronger edges. Hold Option to see the mask." (UI/CameraRawDetailOpticsControls.swift:19)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Luminance" tooltip: "Smooths grain and noise in brightness." (UI/CameraRawDetailOpticsControls.swift:22)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Luminance Detail" tooltip: "Preserves fine texture while luminance noise is reduced." (UI/CameraRawDetailOpticsControls.swift:25)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Luminance Contrast" tooltip: "Keeps local contrast after luminance smoothing." (UI/CameraRawDetailOpticsControls.swift:27)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Color" tooltip: "Smooths colored speckles." (UI/CameraRawDetailOpticsControls.swift:32)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Color Detail" tooltip: "Preserves colored edges while color noise is reduced." (UI/CameraRawDetailOpticsControls.swift:35)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Color Smoothness" tooltip: "Makes the color smoothing softer or tighter." (UI/CameraRawDetailOpticsControls.swift:37)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Remove Chromatic Aberration" tooltip: "Pulls red and blue fringes apart toward the center to reduce color edging." (UI/CameraRawDetailOpticsControls.swift:94)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Enable Lens Profile Corrections" tooltip: "Applies generic profile strength when camera metadata is not available." (UI/CameraRawDetailOpticsControls.swift:96)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Distortion" tooltip: "How much of the profile distortion correction is applied." (UI/CameraRawDetailOpticsControls.swift:101)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Vignetting" tooltip: "How much of the profile vignetting correction is applied." (UI/CameraRawDetailOpticsControls.swift:103)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Distortion" tooltip: "Straightens barrel or pincushion bending." (UI/CameraRawDetailOpticsControls.swift:107)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Defringe" tooltip: "Click a purple or green fringe to set its hue range." (UI/CameraRawDetailOpticsControls.swift:110)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › tooltip: "Click a purple or green fringe to set its hue range." (UI/CameraRawDetailOpticsControls.swift:119)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Purple Amount" tooltip: "Weakens purple fringes inside the purple hue range." (UI/CameraRawDetailOpticsControls.swift:126)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Purple Hue" tooltip: "Hue range where purple defringe runs." (UI/CameraRawDetailOpticsControls.swift:128)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Green Amount" tooltip: "Weakens green fringes inside the green hue range." (UI/CameraRawDetailOpticsControls.swift:130)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Green Hue" tooltip: "Hue range where green defringe runs." (UI/CameraRawDetailOpticsControls.swift:132)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Vignetting" tooltip: "Brightens or darkens the corners to counter lens falloff." (UI/CameraRawDetailOpticsControls.swift:134)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Midpoint" tooltip: "Moves the vignette correction inward or outward." (UI/CameraRawDetailOpticsControls.swift:136)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Low" label tooltip: "Start of the hue range, in degrees." (UI/CameraRawDetailOpticsControls.swift:169)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "Low" slider tooltip: "Start of the hue range, in degrees." (UI/CameraRawDetailOpticsControls.swift:171)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "High" label tooltip: "End of the hue range, in degrees." (UI/CameraRawDetailOpticsControls.swift:174)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › "High" slider tooltip: "End of the hue range, in degrees." (UI/CameraRawDetailOpticsControls.swift:176)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › tooltip: "Off leaves the picture as it is. Guided straightens from lines you draw on the picture." (UI/CameraRawGeometryCalibrationControls.swift:17)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Draw Guides" tooltip: "Draw two or more lines on the preview that should be level or vertical." (UI/CameraRawGeometryCalibrationControls.swift:25)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › tooltip: "Remove every guide line." (UI/CameraRawGeometryCalibrationControls.swift:35)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › tooltip: "Perspective allows stronger keystone. Rectilinear keeps the warp gentler." (UI/CameraRawGeometryCalibrationControls.swift:41)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Vertical" tooltip: "Straightens vertical lines toward the center." (UI/CameraRawGeometryCalibrationControls.swift:42)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Horizontal" tooltip: "Straightens horizontal lines toward the center." (UI/CameraRawGeometryCalibrationControls.swift:43)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Rotate" tooltip: "Rotates the picture around its center." (UI/CameraRawGeometryCalibrationControls.swift:44)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Aspect" tooltip: "Stretches width relative to height." (UI/CameraRawGeometryCalibrationControls.swift:45)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Scale" tooltip: "Zooms the transformed picture within the frame." (UI/CameraRawGeometryCalibrationControls.swift:46)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Offset X" tooltip: "Moves the picture left or right." (UI/CameraRawGeometryCalibrationControls.swift:47)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Offset Y" tooltip: "Moves the picture up or down." (UI/CameraRawGeometryCalibrationControls.swift:48)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Constrain Crop" tooltip: "Crops empty edges after the transform and fits the result back into the frame." (UI/CameraRawGeometryCalibrationControls.swift:50)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › tooltip: "Chooses how strongly the calibration sliders below are applied. Version 6 is the current default." (UI/CameraRawGeometryCalibrationControls.swift:100)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Tint" tooltip: "Adds green or magenta to the darkest tones." (UI/CameraRawGeometryCalibrationControls.swift:107)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Hue" tooltip: "Shifts how red is interpreted." (UI/CameraRawGeometryCalibrationControls.swift:109)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Saturation" tooltip: "Strengthens or weakens the red primary." (UI/CameraRawGeometryCalibrationControls.swift:110)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Hue" tooltip: "Shifts how green is interpreted." (UI/CameraRawGeometryCalibrationControls.swift:112)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Saturation" tooltip: "Strengthens or weakens the green primary." (UI/CameraRawGeometryCalibrationControls.swift:113)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Hue" tooltip: "Shifts how blue is interpreted." (UI/CameraRawGeometryCalibrationControls.swift:115)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › "Saturation" tooltip: "Strengthens or weakens the blue primary." (UI/CameraRawGeometryCalibrationControls.swift:116)
- [x] Status bar and hints › Help text › CanvasSizeSheet › "Extension Color" tooltip: "Color for the added canvas" (UI/CanvasSizeSheet.swift:132)
- [x] Status bar and hints › Help text › ColorPaletteControls › tooltip: "Swap foreground and background (X)" (UI/ColorPaletteControls.swift:24)
- [x] Status bar and hints › Help text › ColorPaletteControls › "Swap foreground and background (X)" accessibility label: "Swap colors" (UI/ColorPaletteControls.swift:25)
- [x] Status bar and hints › Help text › ColorPaletteControls › tooltip: "Default colors (D)" (UI/ColorPaletteControls.swift:35)
- [x] Status bar and hints › Help text › ColorPaletteControls › "Default colors (D)" accessibility label: "Default colors" (UI/ColorPaletteControls.swift:36)
- [x] Status bar and hints › Help text › ColorPickerSheet › accessibility label: "Saturation and brightness" (UI/ColorPickerSheet.swift:71)
- [x] Status bar and hints › Help text › ColorPickerSheet › accessibility label: "New color" (UI/ColorPickerSheet.swift:104)
- [x] Status bar and hints › Help text › ColorPickerSheet › accessibility label: "Hex color" (UI/ColorPickerSheet.swift:119)
- [x] Status bar and hints › Help text › ColorRangeSheet › tooltip: "How far a color may be from the picked ones and still be selected" (UI/ColorRangeSheet.swift:33)
- [x] Status bar and hints › Help text › ColorRangeSheet › "Invert" tooltip: "Select everything except those colors, such as all but a green screen" (UI/ColorRangeSheet.swift:35)
- [x] Status bar and hints › Help text › ExportAsSheet › "Fit" tooltip: "Show the whole image (⌘0)" (UI/ExportAsSheet.swift:84)
- [x] Status bar and hints › Help text › ExportAsSheet › tooltip: "Drag or scroll to move around; double-click switches between Fit and 100%" (UI/ExportAsSheet.swift:102)
- [x] Status bar and hints › Help text › ExportAsSheet › "Size" tooltip: "Width in pixels; the height follows, keeping the proportions" (UI/ExportAsSheet.swift:119)
- [x] Status bar and hints › Help text › ExportAsSheet › "Width in pixels; the height follows, keeping the proportions" tooltip: "Height in pixels; the width follows, keeping the proportions" (UI/ExportAsSheet.swift:121)
- [x] Status bar and hints › Help text › ExportAsSheet › "16 bits per channel" tooltip: "Keep the 16-bit layers' full precision, in a file about twice the size" (UI/ExportAsSheet.swift:144)
- [x] Status bar and hints › Help text › ExportAsSheet › "Load Profile…" tooltip: "Use a CMYK ICC profile, such as the one your printer gave you" (UI/ExportAsSheet.swift:156)
- [x] Status bar and hints › Help text › ExportAsSheet › tooltip: "CMYK writes a printer's inks through the profile in View › CMYK › Profile" (UI/ExportAsSheet.swift:250)
- [x] Status bar and hints › Help text › FilterSheet › "Tint" tooltip: "Color the result while keeping its tones, for a sepia or a cyanotype" (UI/FilterSheet.swift:40)
- [x] Status bar and hints › Help text › FilterSheet › "Preserve Luminosity" tooltip: "Put each pixel's brightness back afterwards, so only the color moves" (UI/FilterSheet.swift:63)
- [x] Status bar and hints › Help text › FilterSheet › tooltip: "Basic is quick; Advanced refines the mask against the layer's own detail, for hair and fur" (UI/FilterSheet.swift:76)
- [x] Status bar and hints › Help text › FilterSheet › "Refine" tooltip: "Pull the mask onto the image's own edges, which recovers hair and fur" (UI/FilterSheet.swift:79)
- [x] Status bar and hints › Help text › FilterSheet › "Contrast" tooltip: "Clear the haze that leaves background showing through thin areas" (UI/FilterSheet.swift:81)
- [x] Status bar and hints › Help text › FilterSheet › "Shift Edge" tooltip: "Shrink the mask to drop the rim of background color around the subject, or grow it" (UI/FilterSheet.swift:83)
- [x] Status bar and hints › Help text › FilterSheet › "Preserve Transparency" tooltip: "Blur only the colors, keeping the layer's outline and transparency as they are" (UI/FilterSheet.swift:91)
- [x] Status bar and hints › Help text › FilterSheet › tooltip: "Linear blurs along the line; Radial keeps the start sharp and blurs outwards" (UI/FilterSheet.swift:102)
- [x] Status bar and hints › Help text › FilterSheet › "From" tooltip: "The blur where the line starts" (UI/FilterSheet.swift:105)
- [x] Status bar and hints › Help text › FilterSheet › "To" tooltip: "The blur where the line ends, and past it" (UI/FilterSheet.swift:107)
- [x] Status bar and hints › Help text › FilterSheet › "Invert" tooltip: "Swap From and To: blur the start and sharpen toward the end" (UI/FilterSheet.swift:109)
- [x] Status bar and hints › Help text › FilterSheet › tooltip: "Choose the vignette color" (UI/FilterSheet.swift:141)
- [x] Status bar and hints › Help text › FilterSheet › "Amount" tooltip: "Blend the chosen color into the edges while keeping the center unchanged" (UI/FilterSheet.swift:145)
- [x] Status bar and hints › Help text › FilterSheet › "Highlights" tooltip: "Protect bright areas near the edge" (UI/FilterSheet.swift:150)
- [x] Status bar and hints › Help text › FilterSheet › "Pixel Size" tooltip: "Make each dithered pixel this many pixels across, for a chunky old-screen look" (UI/FilterSheet.swift:216)
- [x] Status bar and hints › Help text › FilterSheet › "Text Size" tooltip: "The height of each line of characters" (UI/FilterSheet.swift:220)
- [x] Status bar and hints › Help text › FilterSheet › tooltip: "The characters to draw with, in any order: each spot gets the one whose ink best matches its tone" (UI/FilterSheet.swift:234)
- [x] Status bar and hints › Help text › FilterSheet › "Tones" tooltip: "Tones per channel: 2 is pure black and white" (UI/FilterSheet.swift:238)
- [x] Status bar and hints › Help text › FilterSheet › "Diffusion" tooltip: "How much of each pixel's error spreads to its neighbors. Less gives flatter areas" (UI/FilterSheet.swift:242)
- [x] Status bar and hints › Help text › FilterSheet › "Density" tooltip: "More ink (darker) or less before dithering" (UI/FilterSheet.swift:245)
- [x] Status bar and hints › Help text › FilterSheet › "Dark" tooltip: "Choose the dark color" (UI/FilterSheet.swift:256)
- [x] Status bar and hints › Help text › FilterSheet › "Light" tooltip: "Choose the light color" (UI/FilterSheet.swift:258)
- [x] Status bar and hints › Help text › FilterSheet › tooltip: "Draw each chunky pixel as a solid square, or as a round dot like a dot-matrix screen" (UI/FilterSheet.swift:267)
- [x] Status bar and hints › Help text › FilterSheet › "Light on Dark" tooltip: "Draw the marks for the light tones on the dark color, like a glowing screen" (UI/FilterSheet.swift:271)
- [x] Status bar and hints › Help text › FilterSheet › "Line Spacing" tooltip: "How far apart the screen's lines are" (UI/FilterSheet.swift:278)
- [x] Status bar and hints › Help text › FilterSheet › "Thickness" tooltip: "How much of the gap a bright line fills; dimmer parts draw it thinner" (UI/FilterSheet.swift:280)
- [x] Status bar and hints › Help text › FilterSheet › "Glow" tooltip: "Light blooming around the lines, like a CRT's phosphors" (UI/FilterSheet.swift:282)
- [x] Status bar and hints › Help text › FilterSheet › "Dots" tooltip: "Break the lines into beads where the picture is darker than this, blending into solid lines where it's brighter" (UI/FilterSheet.swift:284)
- [x] Status bar and hints › Help text › FilterSheet › "Displace" tooltip: "Lift the lines where the picture is bright, or lower them when negative, so they swell into its shapes" (UI/FilterSheet.swift:286)
- [x] Status bar and hints › Help text › FilterSheet › "Smoothness" tooltip: "How far the brightness is smoothed before it displaces the lines, from sharp ridges to rounded hills" (UI/FilterSheet.swift:288)
- [x] Status bar and hints › Help text › FilterSheet › "Threshold" tooltip: "Draw no line where the picture is darker than this, leaving the screen dark" (UI/FilterSheet.swift:290)
- [x] Status bar and hints › Help text › FilterSheet › "Wobble" tooltip: "Make the lines waver sideways down the screen, like a CRT losing sync" (UI/FilterSheet.swift:292)
- [x] Status bar and hints › Help text › FilterSheet › "Color Split" tooltip: "Move the red and blue apart, for colored fringes on the lines" (UI/FilterSheet.swift:294)
- [x] Status bar and hints › Help text › FilterSheet › "Density" tooltip: "Darker or lighter before the lines are drawn" (UI/FilterSheet.swift:296)
- [x] Status bar and hints › Help text › FilterSheet › "Black Level" tooltip: "How bright the lines are where the picture is black, so they show even over black" (UI/FilterSheet.swift:299)
- [x] Status bar and hints › Help text › FilterSheet › "Dark" tooltip: "Choose the screen's color" (UI/FilterSheet.swift:307)
- [x] Status bar and hints › Help text › FilterSheet › "Light" tooltip: "Choose the lines' color" (UI/FilterSheet.swift:309)
- [x] Status bar and hints › Help text › GradientControls › tooltip: "Linear runs along the line; Radial spreads out from the start point" (UI/GradientControls.swift:15)
- [x] Status bar and hints › Help text › GridSettingsSheet › "Grid Color" tooltip: "Choose a custom grid color" (UI/GridSettingsSheet.swift:62)
- [x] Status bar and hints › Help text › HueSaturationSheet › tooltip: "Targeted adjustment: drag on the image to change that color's saturation, or its hue with Command held" (UI/HueSaturationSheet.swift:105)
- [x] Status bar and hints › Help text › KeyboardShortcuts › icon button xmark.circle.fill tooltip: "Remove this shortcut" (UI/KeyboardShortcuts.swift:299)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Press M to switch between Rectangle and Ellipse" (UI/LassoControls.swift:19)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Press Tab to switch between Wand and Object" (UI/LassoControls.swift:29)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Press L to switch between Freehand and Polygonal" (UI/LassoControls.swift:39)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Hold Shift to add or Option to subtract for one outline" (UI/LassoControls.swift:47)
- [x] Status bar and hints › Help text › LassoControls › "Feather" tooltip: "Fade the edge of the selection by this many pixels" (UI/LassoControls.swift:66)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "How far each color channel (0–255) can differ from the clicked color and still be selected" (UI/LassoControls.swift:102)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Match the clicked pixel, or the average of the pixels around it" (UI/LassoControls.swift:107)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Read colors from the active layer only, or from every visible layer as shown" (UI/LassoControls.swift:113)
- [x] Status bar and hints › Help text › LassoControls › "Contiguous" tooltip: "Select only similar pixels connected to the one you click; off selects them everywhere" (UI/LassoControls.swift:115)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Analyze the active layer only, or every visible layer as shown" (UI/LassoControls.swift:126)
- [x] Status bar and hints › Help text › LassoControls › tooltip: "Positive values tighten the detected mask inward; negative values expand it outward" (UI/LassoControls.swift:141)
- [x] Status bar and hints › Help text › LevelsSheet › tooltip: "Linear histogram with automatic vertical scaling. Tall spikes may extend beyond the graph; all tones from 0 to 255 remain included." (UI/LevelsSheet.swift:113)
- [x] Status bar and hints › Help text › NavigationToolHeader › accessibility label: "Zoom percentage" (UI/NavigationToolHeader.swift:25)
- [x] Status bar and hints › Help text › NavigationToolHeader › "Zoom percentage" tooltip: "Zoom percentage (0.1–3200%). Press Return to apply." (UI/NavigationToolHeader.swift:26)
- [x] Status bar and hints › Help text › NavigatorMinimap › "Navigator" accessibility label: "Click or drag to move the view" (UI/NavigatorMinimap.swift:53)
- [x] Status bar and hints › Help text › NewCanvasSheet › "canvasBackground" tooltip: "Units: pixels, inches, centimeters or millimeters. Click to switch." (UI/NewCanvasSheet.swift:136)
- [ ] Status bar and hints › Help text › ProjectTabs › tooltip: "Drop to open in a new canvas" (UI/ProjectTabs.swift:264)
- [ ] Status bar and hints › Help text › ProjectTabs › "Drop to open in a new canvas" accessibility label: "Drop into new canvas" (UI/ProjectTabs.swift:265)
- [x] Status bar and hints › Help text › ShapeControls › "Fill color" tooltip: "Shapes fill with the foreground color; click to change it" (UI/ShapeControls.swift:25)
- [x] Status bar and hints › Help text › ShapeControls › "px" tooltip: "Round the rectangle's corners by this many pixels; 0 keeps them square" (UI/ShapeControls.swift:55)
- [x] Status bar and hints › Help text › TransformInspector › "Auto Select" tooltip: "Select layers by clicking the canvas. Hold Command to turn it the other way while you click." (UI/TransformInspector.swift:16)
- [x] Status bar and hints › Help text › TransformInspector › "Show Controls" tooltip: "Show the transform box and handles (⌘H). When hidden, drag anywhere to move the layer." (UI/TransformInspector.swift:19)
- [x] Status bar and hints › Help text › TransformInspector › "link" tooltip: "Lock aspect ratio. Hold Shift while dragging a handle to turn it the other way." (UI/TransformInspector.swift:29)
- [x] Status bar and hints › Help text › TransformInspector › tooltip: "Scale width and height together, about the center" (UI/TransformInspector.swift:35)
- [x] Status bar and hints › Help text › TypeControls › tooltip: "Align " (UI/TypeControls.swift:66)
- [x] Status bar and hints › Help text › TypeControls › accessibility label: "Align " (UI/TypeControls.swift:67)
- [x] Status bar and hints › Help text › TypeControls › tooltip: "Line height, baseline to baseline. Empty or 0 is Auto: 120% of the font size." (UI/TypeControls.swift:87)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Drag up or down to lift or lower those tones. Drag a divider along the bottom to change which tones each region covers." (UI/CameraRawColorControls.swift:33)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Drag a point. Click to add one. Double-click a point to remove it." (UI/CameraRawColorControls.swift:34)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Lifts or lowers the brightest tones." (UI/CameraRawColorControls.swift:36)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Lifts or lowers the light tones." (UI/CameraRawColorControls.swift:37)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Lifts or lowers the dark tones." (UI/CameraRawColorControls.swift:38)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Lifts or lowers the darkest tones." (UI/CameraRawColorControls.swift:39)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "How much the curve also changes color strength. Zero matches Photoshop; lower keeps it to brightness, higher adds more color." (UI/CameraRawColorControls.swift:55)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Shifts the selected color family around the wheel." (UI/CameraRawColorControls.swift:290)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Makes the selected color family stronger or quieter." (UI/CameraRawColorControls.swift:291)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Makes the selected color family lighter or darker." (UI/CameraRawColorControls.swift:292)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Controls how much the three tonal wheels overlap." (UI/CameraRawColorControls.swift:451)
- [x] Status bar and hints › Help text › CameraRawColorControls › help text: "Shifts the wheels toward shadows or highlights." (UI/CameraRawColorControls.swift:454)
- [x] Status bar and hints › Help text › CameraRawControls › help text: "Tones from black on the left to white on the right: blacks, shadows, midtones, highlights, whites. Control-click to show the vectorscope." (UI/CameraRawControls.swift:55)
- [x] Status bar and hints › Help text › CameraRawControls › help text: "Hue around the wheel, saturation outward from the center. Control-click to show the histogram." (UI/CameraRawControls.swift:56)
- [x] Status bar and hints › Help text › CameraRawControls › help text: "Show clipped shadows in blue on the preview." (UI/CameraRawControls.swift:81)
- [x] Status bar and hints › Help text › CameraRawControls › help text: "Show clipped highlights in red on the preview." (UI/CameraRawControls.swift:81)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › caption: "No lens metadata on this layer. Profile sliders set generic correction strength." (UI/CameraRawDetailOpticsControls.swift:98)
- [x] Status bar and hints › Help text › CameraRawDetailOpticsControls › help text: "Click the fringe on the layer. Click the eyedropper again to stop." (UI/CameraRawDetailOpticsControls.swift:122)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibrationControls › caption: "Drag on the layer to place a guide. Draw at least two lines." (UI/CameraRawGeometryCalibrationControls.swift:28)
- [x] Status bar and hints › Help text › ColorRangeSheet › help text: "Click the image to select that color" (UI/ColorRangeSheet.swift:75)
- [x] Status bar and hints › Help text › ColorRangeSheet › help text: "Click the image to add that color to the selection" (UI/ColorRangeSheet.swift:76)
- [x] Status bar and hints › Help text › ColorRangeSheet › help text: "Click the image to take that color out of the selection" (UI/ColorRangeSheet.swift:77)
- [x] Status bar and hints › Help text › FilterSheet › help text: "Hide the background behind a layer mask, keeping the foreground subjects. The pixels stay, so the background can be painted back at any time." (UI/FilterSheet.swift:69)
- [x] Status bar and hints › Help text › FilterSheet › help text: "Positive straightens lines that bow outward (barrel); negative, lines that bow inward (pincushion)." (UI/FilterSheet.swift:162)
- [x] Status bar and hints › Help text › KeyboardShortcuts › help text: "Search shortcuts" (UI/KeyboardShortcuts.swift:274)
- [x] Status bar and hints › Help text › KeyboardShortcuts › help text: "Text fields keep standard macOS editing keys. Dialogs share the Apply/Cancel assignments above. Numeric fields use Up/Down, with Shift for larger steps. Standard macOS commands include ⌘Q to quit and ⌃⌘F for full screen. The shortcut editor itself always uses Return to save and Esc to cancel when not recording." (UI/KeyboardShortcuts.swift:307)
- [x] Status bar and hints › Help text › KeyboardShortcuts › help text: "Option temporarily selects the eyedropper in painting tools. Shift constrains shapes/movement or adds to a selection; Option subtracts from selections or draws from center. Command-drag moves selected pixels; Command-Option-drag copies them. Option-drag duplicates layers/folders/effects; Option-click at a layer boundary toggles clipping. Command-click a thumbnail loads its selection. Control bypasses snapping. Right-drag adjusts brush size. Modifier-and-mouse gestures are fixed." (UI/KeyboardShortcuts.swift:308)
- [x] Status bar and hints › Help text › KeyboardShortcuts › help text: "Press a shortcut" (UI/KeyboardShortcuts.swift:339)
- [x] Status bar and hints › Help text › LassoControls › help text: "Smooth the detected object outline; turn off for the raw pixel mask" (UI/LassoControls.swift:53)
- [x] Status bar and hints › Help text › LassoControls › help text: "Smooth selection edges; turn off for hard pixel edges" (UI/LassoControls.swift:53)
- [x] Status bar and hints › Help text › LayerMaskMenu › help text: "Add layer mask (Option-click for a black mask)" (UI/LayerMaskMenu.swift:12)
- [x] Status bar and hints › Help text › LayerMaskMenu › help text: "Add layer mask revealing the selection (Option-click to hide it)" (UI/LayerMaskMenu.swift:13)
- [x] Status bar and hints › Help text › LayerMaskMenu › help text: "Stop viewing the mask" (UI/LayerMaskMenu.swift:26)
- [x] Status bar and hints › Help text › LayerMaskMenu › help text: "Hide the gamut warning" (UI/LayerMaskMenu.swift:42)
- [x] Status bar and hints › Help text › LayerMaskMenu › help text: "Stop marking colors the profile can't print" (UI/LayerMaskMenu.swift:43)
- [x] Status bar and hints › Help text › LayerMaskMenu › help text: "Show the document's own colors again" (UI/LayerMaskMenu.swift:45)
- [x] Status bar and hints › Help text › LevelsSheet › caption: "Original pixels · selection and alpha-weighted histogram" (UI/LevelsSheet.swift:75)
- [ ] Status bar and hints › Help text › NativeLayerList › help text: "Show mask alone" (UI/NativeLayerList.swift:636)
- [x] Status bar and hints › Help text › NativeLayerList › help text: "Select layer; Cmd-click to select its pixels (Cmd-Shift adds, Cmd-Option subtracts)" (UI/NativeLayerList.swift:899)
- [x] Status bar and hints › Help text › NativeLayerList › help text: "Expand or collapse folder" (UI/NativeLayerList.swift:998)
- [x] Status bar and hints › Help text › NativeLayerList › help text: "Select layer mask; Option-click to view it alone; Shift-click to enable/disable; Cmd-click to select its black areas (Cmd-Shift adds, Cmd-Option subtracts)" (UI/NativeLayerList.swift:1039)
- [x] Status bar and hints › Help text › NativeLayerList › fallback label: a clipped row whose base layer is gone reads "Clipped to Missing source" (UI/NativeLayerList.swift:1053-1055)
- [ ] Status bar and hints › Help text › ProjectTabs › help text: "Open in a new project tab" (UI/ProjectTabs.swift:391)
- [ ] Status bar and hints › Help text › ProjectTabs › help text: "New canvas (⌘N) · Drop images here for new tabs" (UI/ProjectTabs.swift:391)
- [x] Status bar and hints › Help text › RawDevelopSheet › help text: "Brings back detail in bright areas the camera partly clipped" (UI/RawDevelopSheet.swift:57)
- [x] Status bar and hints › Help text › ShapeControls › help text: "Set a radius above 0 to use smooth corners." (UI/ShapeControls.swift:61)
- [x] Status bar and hints › Help text › ShapeControls › help text: "Use smooth squircle corners at 60% smoothing, matching Figma's iOS setting" (UI/ShapeControls.swift:62)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibration › Process summary caption: "Earliest response. Hue, saturation, and shadow tint move about half as far as Version 6." (Document/CameraRawGeometryCalibration.swift:197)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibration › Process summary caption: "A little stronger than Version 1. The sliders below still fall well short of the current look." (Document/CameraRawGeometryCalibration.swift:199)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibration › Process summary caption: "Firmer color than Version 2. Primary shifts stay gentler than the current process." (Document/CameraRawGeometryCalibration.swift:201)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibration › Process summary caption: "The 2012 response. Calibration reaches most of the strength used by Version 6." (Document/CameraRawGeometryCalibration.swift:203)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibration › Process summary caption: "Close to the current process, with slightly softer primary and shadow shifts." (Document/CameraRawGeometryCalibration.swift:205)
- [x] Status bar and hints › Help text › CameraRawGeometryCalibration › Process summary caption: "Current default. The calibration sliders below apply at full strength." (Document/CameraRawGeometryCalibration.swift:207)
- [x] Status bar and hints › Help text › HueSaturation › eyedropper hint: "Click the image to center this range on that color" (Document/HueSaturation.swift:148)
- [x] Status bar and hints › Help text › HueSaturation › eyedropper hint: "Click the image to widen this range to include that color" (Document/HueSaturation.swift:149)
- [x] Status bar and hints › Help text › HueSaturation › eyedropper hint: "Click the image to narrow this range to exclude that color" (Document/HueSaturation.swift:150)
- [x] Status bar and hints › Help text › ImageTrim › message: "No content remained after trimming." (Document/ImageTrim.swift:48)
- [x] Status bar and hints › Help text › ImageTrim › message: "The trimmed image dimensions are invalid." (Document/ImageTrim.swift:50)
- [x] Status bar and hints › Help text › LayerMask › undo name: "Disable Layer Mask" (Document/LayerMask.swift:283)
- [x] Status bar and hints › Help text › LayerMask › undo name: "Unlink Layer Mask" (Document/LayerMask.swift:324)
- [x] Status bar and hints › Help text › LiveLayerMask › message: "Bake keeps the current masked appearance in the dependent layers’ pixels. Remove Links reveals their pixels. You can undo either choice." (Document/LiveLayerMask.swift:110)
- [x] Status bar and hints › Help text › MagicWand › message: "There isn’t enough memory to make that selection." (Document/MagicWand.swift:29)
- [ ] Status bar and hints › Help text › ImageExporter › message: "The canvas could not be rendered. Try a smaller canvas." (IO/ImageExporter.swift:11)
- [ ] Status bar and hints › Help text › ImageExporter › message: "The image could not be encoded." (IO/ImageExporter.swift:12)

## Apple-framework dependencies

These decide how each feature is ported. References use the same convention as the checklist. Portable C kernels are listed last because they are not Apple dependencies: they can be compiled to WebAssembly unchanged.

### Vision

| Feature | Call site | Port note |
|---|---|---|
| Magic tool, Object mode (click an object to select its outline) | `VNImageRequestHandler` + `VNGenerateForegroundInstanceMaskRequest`, `generateMask(forInstances:)` (Document/ObjectSelection.swift:39-46); mask upsampled with Core Image `CIEdgePreserveUpsampleFilter` (Document/ObjectSelection.swift:71) | Needs a segmentation model (ONNX/WASM or a backend service) |
| Select › Subject (⌥⌘A) | `VNGenerateForegroundInstanceMaskRequest` + `generateScaledMaskForImage` (Document/SubjectRemoval.swift:29-38), traced to a selection (Document/SubjectRemoval.swift:119-136) | Same model as above |
| Filter › Remove Background (mask, Basic / Advanced) | `SubjectRemoval.run` (Document/Filters.swift:279), Advanced refine through the guided matte (Document/SubjectRemoval.swift:51) | Same model; guided matte is plain Swift math |

### Core Image

| Feature | Call site |
|---|---|
| GPU canvas compositor (every frame) | Metal-backed `CIContext(mtlCommandQueue:)` (Rendering/GPUCanvas.swift:52-57); blend modes as `CI*BlendMode` filters (Rendering/GPUCanvas.swift:508-520, Document/LayerAppearance.swift:54-69); Lanczos downscale (Rendering/GPUCanvas.swift:309, Rendering/GPUCanvas.swift:318); distorted layers `CIPerspectiveTransformWithExtent` (Rendering/GPUCanvas.swift:453); display dither `CIRandomGenerator` (Rendering/GPUCanvas.swift:337) |
| Live adjustment layers on the GPU path | `CIColorCurves` / `CIColorCube` / `CIMaximumComponent` (Rendering/GPUCanvas.swift:554-614); adjustment opacity `CIBlendWithMask` (Rendering/LiveMaskRenderer.swift:75) |
| Canvas display overlays | checkerboard `CIAffineTile` (Rendering/EditorCanvas.swift:2754); CMYK proof `CIColorCubeWithColorSpace` (Rendering/EditorCanvas.swift:2767); gradient-tool preview `CILinearGradient` / `CIRadialGradient` (Rendering/EditorCanvas.swift:2967-2971); mask-alone view `CIColorMatrix` (Rendering/EditorCanvas.swift:2883) |
| Filters | Gaussian Blur (Document/Filters.swift:284); Motion Blur `CIMotionBlur` (Document/Filters.swift:299); Bloom / Glow `CIBloom` (Document/Filters.swift:328); Tonal Contrast blur (Document/Filters.swift:334); Progressive Blur `CIMaskedVariableBlur` (Document/Filters.swift:405-414); Scanlines glow (Document/Scanlines.swift:87); selection-limited result `CIBlendWithMask` (Document/PixelAdjust.swift:43) |
| Free distort and Camera Raw Geometry | `CIPerspectiveTransform` (Document/Distort.swift:115, Document/CameraRawGeometryCalibration.swift:77) |
| Blur tool, selection feather, layer-effect softening | `applyingGaussianBlur` (Document/BlurTool.swift:40, Document/Selection.swift:27, Document/LayerEffects.swift:594) |
| Import orientation and 16-bit / half-float conversion | `CIContext` (IO/ImageImporter.swift:59-66) |

### Core Text and TextKit

| Feature | Call site |
|---|---|
| Type tool rendering of text layers | `NSTextStorage` + `NSLayoutManager` (TextKit 1 over Core Text) (Document/TypeTool.swift:449-462) |
| Inline multiline text editor | `CanvasTextView: NSTextView` with a custom layout manager (Rendering/InlineTextEditor.swift:8-16) |
| Font family menu | `NSFontManager.shared.availableFonts` (UI/TypeControls.swift:196, UI/TypeControls.swift:214) |
| PSD text import layout and missing-font check | `NSLayoutManager` (IO/PSD/PSDText.swift:237-238), `NSFont(name:)` (IO/PSD/PSDText.swift:30) |
| Dither filter, ASCII glyph style | `CTLineCreateWithAttributedString` / `CTLineDraw` with `NSFont.monospacedSystemFont` (Document/Dither.swift:161-177) |

### ImageIO, camera RAW and color management

| Feature | Call site |
|---|---|
| Camera RAW import and develop sheet | `CIRAWFilter(imageURL:)` (IO/RawImporter.swift:79, IO/RawImporter.swift:105, IO/RawImporter.swift:124); temperature/tint, boost, luminance noise reduction, lens correction, highlight recovery, draft-mode previews (IO/RawImporter.swift:83, IO/RawImporter.swift:106-109, IO/RawImporter.swift:140-144); pixel size via `CGImageSource` (IO/RawImporter.swift:176) |
| Image import decode (JPEG, PNG, HEIC/HEIF, TIFF, WebP, EXR, Radiance HDR) | `CGImageSourceCreateWithURL` / `CGImageSourceCreateImageAtIndex` (IO/ImageImporter.swift:93-107) |
| SVG import (rasterized once) | `NSImage(contentsOf:)` (IO/ImageImporter.swift:71-72) |
| Export PNG / JPEG / TIFF / EXR and QuickLook preview | `CGImageDestinationCreateWithData` (IO/ImageExporter.swift:169); Preview.jpg thumbnail (IO/ImageExporter.swift:199-205) |
| Export PDF (one page at print size) | `CGContext(consumer:mediaBox:)` + `beginPDFPage` (IO/ImageExporter.swift:244-245) |
| Project save and load (PNG / EXR layers) | `CGImageDestination` / `CGImageSource` (IO/ProjectStore.swift:105, IO/ProjectStore.swift:184-201) |
| CMYK proofing, CMYK TIFF/PSD color | `CGColorSpace(iccData:)`, ColorSync profile descriptions, system profile folders (IO/CMYK.swift:16, IO/CMYK.swift:29, IO/CMYK.swift:67-68) |

### Metal

| Feature | Call site |
|---|---|
| GPU canvas presentation | `CAMetalLayer` (Rendering/GPUCanvas.swift:352, Rendering/GPUCanvas.swift:371); Core Graphics fallback behind the hidden `CompositorCPUCanvas` default (Rendering/EditorCanvas.swift:2684-2685) |
| Brush coverage for every brush tool | `continuousBrush` compute kernel (Rendering/MetalBrushCoverage.swift:22-26) |
| Smudge and Liquify | warp compute kernels (Rendering/MetalWarp.swift:168-173) |
| Layer effects (Stroke, shadows, glows, overlay) | runtime-compiled compute shaders (Rendering/MetalLayerEffects.swift:38-42), CPU fallback (Document/LayerEffects.swift:460-467) |
| Add Noise and Grain on the live canvas | `add_noise` / `add_grain` kernels via `CIImageProcessorKernel` (Rendering/GPUNoise.swift:55-67) |
| Camera Raw on large previews (8,000,001 px and up) | `camera_raw_lookup` kernel (Rendering/MetalCameraRawLookup.swift:31-38, Document/Filters.swift:683) |

### Accelerate

| Feature | Call site |
|---|---|
| Invert / Invert Mask | vImage (Document/PixelInvert.swift:22-24) |
| High-quality downsampling when zoomed out | vImage Lanczos chain (Rendering/DownsampleCache.swift:100-108) |

### AppKit-only APIs

| Feature | Call site |
|---|---|
| Layers panel (rows, drag and drop, cursors, tracking loops) | `NSTableView` data source and delegate (UI/NativeLayerList.swift:41-44); mask Option-drag and eye-swipe tracking loops (UI/NativeLayerList.swift:1388, UI/NativeLayerList.swift:1433); live blend preview `NSPopUpButton` + `NSMenuDelegate` (UI/BlendModePicker.swift:4-78); bake-or-cancel `NSAlert` (Document/LiveLayerMask.swift:108-114) |
| Canvas input | custom `NSCursor`s (Rendering/EditorCanvas.swift:134-508); window-wide key monitor (Rendering/EditorCanvas.swift:774-795); trackpad magnify, precise scroll, middle button (Rendering/EditorCanvas.swift:2042-2198); right-drag brush size (Rendering/EditorCanvas.swift:1715) |
| Floating dialogs and docked Camera Raw panel | `NSPanel` controller (UI/FloatingPanel.swift:16, UI/FloatingPanel.swift:127-160) |
| Search Commands palette | reads `NSApp.mainMenu` and runs `performActionForItem` (UI/CommandPalette.swift:104-156) |
| Slider track click and Camera Raw sliders | `NSSliderCell` method swizzle (UI/SliderSnap.swift:13-23); `NSSlider` subclass with gradient tracks (UI/CameraRawSlider.swift:60-206) |
| Clipboard (pixels, layers, paste image as new canvas) | `NSPasteboard` (Document/SelectionClipboard.swift:22-25, UI/NewCanvasSheet.swift:187-202) |
| Open, Save, Export and Load Profile panels | `NSOpenPanel` / `NSSavePanel` / sheets (IO/ProjectController.swift:70-110, UI/ExportAsSheet.swift:253-260, CompositorApp.swift:399-406) |
| Open Recent | `NSDocumentController` recent documents (IO/RecentProjects.swift:23-31) |
| Fullscreen / canvas only | `NSApp.presentationOptions` + borderless window (IO/CompositorApplicationDelegate.swift:102-154) |
| Rulers | `NSView` drawing (UI/CanvasRulers.swift:41-185) |
| Tab drop detection | `NSPasteboard(name: .drag)` polling (UI/ProjectTabs.swift:125-137) |
| Keyboard Shortcuts recorder | `NSButton` subclass reading key events (UI/KeyboardShortcuts.swift:330-365) |
| Auto update | Sparkle `SPUUpdater` with a custom user driver (IO/CompositorApplicationDelegate.swift:13-14, IO/UpdateDriver.swift:10) |
| Live reload and safe writes | `DispatchSource` file watching (IO/ProjectWatcher.swift:43); `NSFileCoordinator` (IO/ProjectStore.swift:133, IO/ImageExporter.swift:268) |

### Portable C kernels (not Apple; compile to WebAssembly)

Rendering/AdjustPixels.c (Camera Raw, Levels, Curves, Hue/Saturation cubes, Gradient Map, Black & White, Color Balance, Grain, Vignette, Tonal Contrast), Rendering/BrushPixels.c (Trim bounds, brush alpha), Rendering/DeepPixels.c (16-bit / HDR layers), Rendering/DitherPixels.c (Dither), Rendering/HealPixels.c (Spot Healing), Rendering/LensPixels.c (Lens Correction), Rendering/LevelsPixels.c (Levels, histogram), Rendering/NoisePixels.c (Add Noise), Rendering/PatchPixels.c (Content-Aware Fill, PatchMatch), Rendering/WandPixels.c (Magic Wand, Color Range, outline tracing), all bridged through Compositor-Bridging-Header.h. Camera Raw also needs the bundled lookup data Resources/CameraRawTables.bin and Resources/CameraRawShadows.bin (Document/CameraRawTables.swift:4-64, Document/CameraRawShadows.swift:23-44). Selection add/subtract, Expand/Contract and Inverse use macOS 13+ `CGPath` boolean operations (Document/Selection.swift:233-244), so a web port needs a polygon clipping and offset library.

## Where the code and the README disagree

The checklist follows the code. These differences matter for parity:

- The README says "Photoshop's full set of blend modes". The code has 24; Darker Color and Lighter Color are left out (Document/LayerAppearance.swift:70-71).
- The README says PSD import supports "8-bit RGB; not CMYK". The code accepts CMYK PSDs (color mode 4) and converts them through their embedded profile (IO/PSD/PSDReader.swift:46-47).
- The README lists PNG, JPEG and PDF for Export As. The code also offers TIFF, and EXR when the document has an HDR layer (IO/ProjectController.swift:417-418).
- The README says gradients "stay editable". A gradient can be adjusted only while it is pending; Apply bakes it into pixels (Document/Gradient.swift:111). Shapes and text do stay live.
- The README's filter list omits Progressive Blur, which is in the Filter menu (Document/Filters.swift:10).
- docs/project-format.md gives a 100-million-pixel budget. The code scales the budget with the Mac's memory, up to 800 MP (Document/DocumentLimits.swift:34-37).
- The shortcut list and tool tooltips say M and L "cycle". In the code they only select the tool; Tab switches its mode (Rendering/EditorCanvas.swift:2300-2305, UI/LassoControls.swift:19, UI/LassoControls.swift:39).
- The Shape tooltip says Shift-U switches "Rectangle/Ellipse". It steps through every shape kind (Document/EditorSession.swift:99).
- The Eyedropper has no status-bar hint of its own; it shows the Zoom tool's text (ContentView.swift:365).
- The shortcut definition titled "Hide Compositor" (⌥⌘H) actually drives Hide Others (UI/KeyboardShortcuts.swift:95, CompositorApp.swift:197-201).
- Editing a Gaussian Blur adjustment layer shows a Preserve Transparency toggle that is never saved; only the radius is kept (Document/AdjustmentEditing.swift:86).
- The Camera Raw Point Color picker says "Up to eight colors", but after the first pick each click replaces the selected point (UI/CameraRawColorControls.swift:363).
- There is no Preferences window. ⌘, is reserved and does nothing; every setting persists as a UserDefaults key (see Preferences/persisted settings).

## Where the board differs on purpose

The user asked for these Photoshop habits in place of Compositor's behaviour (2026-10-20). The lines they replace are left unticked.

- Move tool: a press inside the selection that misses the transform handles cuts the active layer's selected pixels and drags them. The undo step is "Move Pixels"; with Option it copies them instead, as "Duplicate Pixels". The scissors cursor shows over the selection. Compositor's Move tool always drags the layer, and cuts only with Cmd-drag in a selection tool or Cmd-T. A press outside the selection, Cmd-click, a folder, an adjustment, live text or shape layer, a targeted mask, several selected layers and a pending transform all still drag the layer (vscode-extension/media/view.js `cutsSelectedPixels`).
- Delete key in the Layers list: deletes the targeted effect, mask or layers as the trash button does, even with a selection. On the canvas Delete still clears the selected pixels (vscode-extension/media/board.js keydown).
- Move tool, selecting several layers on the canvas. Both gestures go by the pixels a layer shows at the pointer (its mask, clipping base and folders' masks applied), not by its placed rectangle, because blank layers fill the canvas. Compositor's Auto Select, Cmd-click and Cmd-Shift-click keep its rectangle test.
  - Shift-click on a layer's pixels adds it to the layer selection, whatever Auto Select says, and the drag then moves the whole selection. Shift-clicking a layer already selected takes it out on release, unless the press dragged. Compositor's Shift-press just dragged.
  - With Auto Select on, or flipped on by Cmd, a drag that starts where no layer but a background shows pixels (or off the canvas) draws a dashed box, inside the transform box too. A background is a layer whose opaque pixels cover the whole canvas. On release, the layers the box touches become the selection, the topmost one active; Shift at the press adds them. Locked layers and backgrounds are left out. A press on a layer's pixels or on a handle still drags. A press that does not drag is the click Compositor's press was, or a Shift-click that adds or takes out the background showing there (vscode-extension/media/view.js `startsLayerBox`, board.js `layersShownIn`).
- Move tool, selecting no layer (asked for on 2026-10-28). A plain click (no modifier, no drag past 3 points) where no layer but a background shows a pixel, off the canvas included, selects no layer: the Layers list highlights none and the Move tool shows no box. A background (opaque over the whole canvas, as the layer box skips) is the page here, so clicking a white background deselects; such a layer is picked in the Layers list. Compositor always keeps a layer selected once there is one.
  - A drag that starts there does what it did: with Auto Select off it moves the selected layer, with it on it draws the layer box. A press during ⌘T, inside the selection (which cuts its pixels) or with a modifier is unchanged.
  - With no layer selected, a press on a layer's pixels (not a background's) selects that layer and drags it, Auto Select or not (Auto Select on keeps Compositor's rectangle test). Tools that need a layer say "Select a layer…" until one is picked.
  - Code: vscode-extension/media/view.js `beginTransform` (`blank`), layer-ops.js `deselectLayers`.

The user also asked for two Photoshop features Compositor does not have (2026-10-20). They add to the board and replace no checklist line.

- Layer lock (Photoshop's Lock All, ⌘/; the lock button under the Layers list, Layer › Lock Layer, the row's context menu):
  - A locked layer, and everything inside a locked folder, keeps its pixels, place, blend mode, opacity, effects, mask, clipping, live text and adjustment settings. It cannot be deleted or merged, and what a locked folder holds cannot be moved out of it.
  - Still allowed: show or hide, select, rename, reorder, duplicate (Option-drag included; the copy is not locked), canvas-level commands (crop, canvas and image size, rotate canvas) and undo.
  - Only the person's board edits are held back; Claude's tools are not.
  - The ids are kept in `<name>.comp.board.json` beside the project, so Compositor neither sees nor drops them.
  - Code: vscode-extension/media/layer-ops.js `lockRefusal`, the gates that call it, and board.js `engineLockRefusal` as the last check before an engine operation.
- Pen tool (P), after the Shape tool, two ways of drawing (Tab switches, as Photoshop's Curvature Pen and Pen):
  - Curvature, the default: each click places a point and the path curves smoothly through all of them; a double-click or Option-click places a corner; dragging a new point moves it.
  - Pen: a click places a corner point and a drag pulls out curve handles.
  - Shift keeps 45° steps. Clicking the first point closes the path, Return finishes an open one, Delete or ⌘Z takes the last point back, Escape drops the path.
  - Each path becomes a new pixel layer "Path N" (undo step "Pen Path"). Its options are Stroke (foreground color), Fill (background color, closed paths only) or both, and the stroke width.
  - Compositor opens the layer as ordinary pixels, because its shape layers only know rectangles, ellipses and lines.
  - The path is kept in `<name>.comp.board.json` with its last 20 versions. While the layer still shows one of them, the Pen reshapes it, each change one undo step "Edit Path":
    - Drag a point (a curvature path smooths itself around it), or in Pen mode a handle; Option moves one handle alone.
    - Click a segment to add a point; dragging from the segment bends it.
    - Option-click (or, on a curvature path, double-click) a point to make it a corner or smooth.
    - Delete removes the selected point.
    - The options change the path.
  - After painting, a filter, or an edit made in Compositor or by Claude, the layer is plain pixels.
  - Code: vscode-extension/media/pen-tool.js.

The user asked on 2026-10-22 for Photoshop's choice between a filled and an outlined shape. It adds to the Shape tool and replaces no checklist line, as Compositor's shapes only fill.

- Shape tool, Rectangle and Ellipse: Fill | Stroke | Stroke & Fill after the kind picker. Fill is the default, as in Compositor; a Line is always a stroke.
  - Stroke outlines the shape in the foreground color, inside the dragged box, with its own Width (1–5000 px, default 4; the Line keeps its own). Stroke & Fill also fills the inside with the background color, as the Pen does.
  - Fill makes Compositor's shape layer as before. An outlined shape is a plain pixel layer in the manifest, so Compositor never redraws it as a filled shape; its style is kept in `<name>.comp.board.json`.
  - While the layer still shows that style, scaling it on the board draws it again, so the outline keeps its width, during the drag too. A copy (Option-drag, Duplicate Layer) keeps the style. After painting, a filter, or an edit made in Compositor or by Claude, the layer is plain pixels.
  - Code: vscode-extension/media/shapes.js, layer-ops.js `liveShapeStyle`.

## Checklist line count

| Area | Lines |
|---|---:|
| Tools | 242 |
| Selections | 48 |
| Layers panel and layer operations | 92 |
| Masks and clipping | 28 |
| Adjustment layers | 112 |
| Layer effects | 34 |
| Filters | 103 |
| Camera Raw | 163 |
| Image/Canvas commands | 39 |
| Transform | 52 |
| Text | 33 |
| Color | 26 |
| View | 89 |
| File | 202 |
| Edit | 78 |
| Keyboard shortcuts | 115 |
| Preferences/persisted settings | 34 |
| App-level | 66 |
| Status bar and hints | 281 |
| **Total** | **1837** |
