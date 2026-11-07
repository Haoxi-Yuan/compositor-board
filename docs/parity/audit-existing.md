# Audit of features built before the parity checklist

Audit date 2026-10-20. Each line of `docs/parity/features.md` listed below was compared with the upstream code it cites (`upstream/Compositor/`, read-only) and with the board's code in `vscode-extension/media/`. No code was changed.

## Rules used

- **DONE**: everything the line states is reproduced; the evidence column gives the port's file:line. The line can be ticked.
- **PARTIAL**: something the port could already do is missing or different (text, range, default, tooltip, undo name, cursor, order). The gap is stated precisely.
- **MISSING**: nothing of the line exists in the port, and it could be built now.
- **N/A-YET**: the line cannot be completed until a feature the port does not have yet (masks, clipping UI, folder creation, multi-selection, effects, adjustments, deep pixels, Type, Crop, Gradient, Clone Stamp, Smear, Spot Healing, guides UI, fullscreen, Keyboard Shortcuts editor, Export As) arrives. The evidence column notes when the part that can be done today is already done. Such a line is not tickable yet.
- A parenthetical such as "(all brush tools)" or "applies to Brush, Spot Healing, Clone Stamp…" does not block DONE in the Brush section: the other tools have their own lines.
- Port-only additions (Note tool, notes chips, save-state chip, "Open in Compositor" items) are not counted as gaps unless they change an upstream string.
- Lines already ticked (`[x]`) were not re-audited; they are marked "ticked".

Upstream paths are relative to `upstream/Compositor/`. Port paths are relative to `vscode-extension/media/`.

## Counts

| Section | DONE | PARTIAL | MISSING | N/A-YET |
|---|---|---|---|---|
| Tool rail and tool switching (52-66) | 3 | 6 | 1 | 4 |
| Move / Transform (70-80) | 1 | 4 | 0 | 6 |
| Brush (183-217) | 11 | 12 | 1 | 10 |
| Shape (283-298) | 9 | 7 | 0 | 0 |
| Eyedropper (322-326) | 2 | 3 | 0 | 0 |
| Hand (330-331) | 2 | 0 | 0 | 0 |
| Zoom tool (335-339) | 1 | 4 | 0 | 0 |
| Layers panel and layer operations (424-536) | 16 | 23 | 11 | 41 |
| Color › Foreground / background swatches (1338-1344) | 5 | 1 | 0 | 1 |
| View › Zoom (1372-1390) | 11 | 6 | 1 | 1 |
| Status bar layout (2109-2116) | 2 | 3 | 1 | 2 |
| Tool hints (2126-2140) | 3 | 3 | 1 | 8 |
| Help text (2146-2399, UI the port has) | 4 | 3 | 14 | 13 |
| **Total (261 lines)** | **70** | **75** | **30** | **86** |

Ticked lines inside the audited ranges (58, 197, 456, 2120-2125, 2373) are listed but not counted. Help text for the selection UI (already verified) and for UI the port lacks (Camera Raw, filters, export, Levels, Type, Gradient, project tabs, and so on) is out of scope.

---

## Tools › Tool rail and tool switching (50-66)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 52 | "Rail layout" | PARTIAL | 56 px rail, 36x36 buttons, 10 px gap, 16/12 px padding, selected = white 12 % fill + 14 % border (board.css:210-233; board.js:133-146); the ported tools keep upstream order (board.js:11-22). Gap: `.rail { overflow-y: auto }` (board.css:219) shows a scrollbar when the window is short; upstream scrolls without indicators (ContentView.swift:312). Unported tools and the Toggle Fullscreen hiding are N/A-YET. |
| 53 | "Tooltips/accessibility labels" | PARTIAL | Move, Marquee, Lasso, Magic, Eyedropper, Hand, Zoom match (board.js:12-21). Shape reads "Shape (U) · Shift-U switches Rectangle/Ellipse/Line" (board.js:17); upstream "Shape (U) · Shift-U switches Rectangle/Ellipse" (Document/EditorSession.swift:99). In Erase mode the Brush button retitles itself "Eraser (E) · Brush (B)" (board.js:192); upstream's label never changes. Buttons carry `title` only, no `aria-label`. |
| 54 | "Mode-following icons" | N/A-YET | Brush→eraser, Marquee→dashed ellipse, Lasso→polygonal, Magic→object follow the mode (board.js:180-194). Gradient and Clone Stamp icons wait for those tools. |
| 55 | "Color palette under the tools" | DONE | board.js:135-140; board.css:235-256. |
| 56 | "Single-key tool selection" | PARTIAL | V M L W B (Paint) E (Erase) U I H Z (board.js:1310-1318). Gaps: `A` (No tool) is not handled (listed for v1 in docs/port-specs/ui.md:298); every focused `<input>` counts as typing (board.js:1233), so after clicking a checkbox or slider (Auto Select, Hardness, Sample Ring) the letters do nothing, whereas upstream only blocks while a text field edits (Rendering/EditorCanvas.swift:776-783). C J S R G T and remapping: N/A-YET. |
| 57 | "Shift+letter also selects the tool" | DONE | Key codes match with or without Shift; Shift-U keeps its own command (board.js:1310-1318). |
| 58 | "M / W / L ignore key repeat" | ticked | |
| 59 | "Tab cycles the current tool's mode" | PARTIAL | Brush, Shape, Marquee, Lasso, Magic cycle (board.js:472-480); ignored during a stroke (board.js:1251). Gap: Shift-Tab also cycles (board.js:1319); upstream requires no modifiers (Rendering/EditorCanvas.swift:2276). Other tools N/A-YET. |
| 60 | "Switching tools finishes any text being edited first" | PARTIAL | Refused during a stroke / transform / shape drag (`view.busy`, board.js:451); commits a floating transform, cancels selection and shape drafts (board.js:452-457). Gap: not refused while an engine operation runs (`working > 0`); upstream refuses while `isProjectBusy` (Document/EditorSession.swift:396). Text, Levels, crop, gradient: N/A-YET. |
| 61 | "Brush-tip families" | N/A-YET | Needs Clone Stamp and Smear. |
| 62 | "Default tool at launch/new session is Move" | DONE | board.js:34; the tool is not saved (board.js:82-84). |
| 63 | "Temporary Hand" | N/A-YET | Space pans in any tool, grab/grabbing cursor, released on keyup (board.js:1311, 1376; view.js:256, 292-296). Only "remappable" waits for the Keyboard Shortcuts editor. |
| 64 | "Temporary Eyedropper" | PARTIAL | Option-click/drag with Brush samples (view.js:326-329). Gaps: cursor is CSS `copy` (view.js:258), not the eyedropper cursor (Rendering/EditorCanvas.swift:428-458); Option pressed mid-stroke still swaps the cursor and hides the brush circle (view.js:214, 258), upstream does not pick during a stroke (Rendering/EditorCanvas.swift:93). |
| 65 | "Tool header bar" | N/A-YET | 42 px header row, 13 px semibold title, 12 px controls (board.css:40, 132, 31). Only the Toggle Fullscreen hiding is missing. |
| 66 | "Held-modifier indicator" | MISSING | Auto Select and the ratio lock never show the Cmd/Shift-flipped state (board.js:219, 225; upstream UI/HeldModifiers.swift:4-38, UI/TransformInspector.swift:13-15, 27-29). |

## Tools › Move / Transform (68-80)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 70 | "Header title" | N/A-YET | "Transform" (board.js:218). "Transform Mask" needs mask targeting. |
| 71 | "Auto Select toggle" | PARTIAL | Default off, Cmd flips it for the press, picks the topmost layer (board.js:39, 278; view.js:679-686). Gaps: the checkbox does not show the flipped state while Cmd is held (UI/TransformInspector.swift:13-15); no tooltip (see 2328); saved only in this board's webview state (`vscode.setState`, board.js:82-84), upstream app-wide in UserDefaults `tool.autoSelect` (Document/EditorSession.swift:198-199). |
| 72 | "Show Controls toggle" | PARTIAL | Default on; hidden, a drag anywhere moves the layer; a floating ⌘T box still shows (board.js:39, 279; view.js:157-167). Gaps: no View › "Show Transform Controls" item or ⌘H (CompositorApp.swift:137-139; board.js:1119-1124); no tooltip (2329); per-board persistence only. |
| 73 | "Press-to-drag target" | DONE | view.js:670-687 and board.js:569-582 reproduce transformPressLayer (Rendering/EditorCanvas.swift:1679-1711): active layer even on empty canvas; with Auto Select the topmost layer under the press when it is above the active one. |
| 74 | "Cmd-click picks the layer under the pointer" | N/A-YET | Cmd-click picks (view.js:679-686). Cmd-Shift-click needs multi-selection. |
| 75 | "Option-drag duplicates" | PARTIAL | The first movement duplicates and drags the copy (view.js:703-710). Gaps: two undo steps, "Duplicate Layer" (board.js:1580) then "Transform Layer" (view.js:746), instead of one "Duplicate Layer" (Document/EditorSession.swift:465-483, 446-451); Escape mid-drag cancels only the move and the copy stays, still in history (view.js:749-757), upstream removes the copies and restores the selection (Document/EditorSession.swift:526-537); folders are refused (board.js:1578). Multi-layer copies N/A-YET. |
| 76 | "Double-click live text with the Move tool" | N/A-YET | Type tool. |
| 77 | "Dragging an existing guide with the Move tool" | N/A-YET | Guides UI. |
| 78 | "Cursors" | PARTIAL | Four-arrow `move`, oriented resize cursors (transform.js:133-138), locked for the drag (view.js:269, 696). Gaps: Option shows CSS `copy` (view.js:272) instead of the double-arrow duplicate cursor (CB.SelectionCursors.duplicate already exists, select-tools.js:899); the rotation handle shows `alias` (view.js:270) instead of the circular-arrows rotate cursor (Rendering/EditorCanvas.swift:412-427); "arrow when nothing would move" is missing, the port always shows `move` (view.js:272; upstream Rendering/EditorCanvas.swift:1664-1665). Distort and guide cursors N/A-YET. |
| 79 | "Opacity digit keys" | N/A-YET | Active layer or folder, 1-9/0, two digits within 0.6 s, one "Layer Opacity" step (board.js:1329-1337; brush.js:476-479; board.js:1627-1647). Needs multi-selection to finish. |
| 80 | "Arrow-key nudge of the layer" | N/A-YET | 1 px / 10 px, one "Transform Layer" step per press (board.js:1357-1365). Folder and multi-layer nudge N/A-YET. |

## Tools › Brush (Paint / Erase) (181-217)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 183 | "Tool selection" | PARTIAL | B Paint, E Erase (board.js:1313-1314), eraser icon (board.js:191), header "Brush"/"Eraser" (board.js:235). Gap: rail label becomes "Eraser (E) · Brush (B)" in Erase mode (board.js:192); upstream always "Brush (B) · Eraser (E)". |
| 184 | "Mode picker" | PARTIAL | Segmented Paint / Erase, default Paint (board.js:35, 236). Gap: help "Paint with the foreground color (B), or erase pixels away (E)" missing (UI/BrushControls.swift:15). |
| 185 | "Tab cycles mode" | DONE | board.js:472-473, 1319 (the Shift-Tab issue is counted at line 59). |
| 186 | "Size" | PARTIAL | Scrub 1 px per point (board.js:325), 1-2000, default 40, ↑/↓ 1, Shift 10 (board.js:299, 336-345; brush.js:24). Gaps: the field shows decimals after a sub-pixel scrub (board.js:350 via `number()`), upstream formats with 0 decimals (UI/BrushControls.swift:42); text that is not a number reverts instead of falling back to 40 (board.js:298 vs UI/BrushControls.swift:41); an emptied field becomes 1. |
| 187 | "Hardness" | DONE | board.js:238, 302, 328; default 100 % (brush.js:24). |
| 188 | "Opacity" | DONE | board.js:239, 301, 327; one opacity over the whole stroke (brush.js:372); help string matches. |
| 189 | "Smoothing" | DONE | board.js:240, 300, 326; lazy string in zoom-device units as upstream (brush.js:451-459; view.js:583-590); catches up on release (view.js:629). |
| 190 | "Color swatch" | PARTIAL | Shows and edits the foreground (board.js:215, 241, 277). Gaps: not disabled while the engine works (upstream `.disabled(!canEditPalette)`, UI/BrushControls.swift:115); help "Foreground color" reads "Foreground color: click to change" (board.js:215; UI/BrushControls.swift:116-117). Mask / Clone / Smear cases N/A-YET. |
| 191 | "Mask paint picker" | N/A-YET | Masks. |
| 192 | "Paint stroke" | DONE | brush.js:37-69 (centripetal Catmull-Rom), 103-111 (Gaussian falloff), 335-376; view.js:533-580. |
| 193 | "Erase stroke" | N/A-YET | destination-out at the brush opacity (brush.js:372-373). Mask branch needs masks. |
| 194 | "Paint past layer edges" | DONE | brush.js:263-288, 420-443; board.js:640-670. |
| 195 | "Paint on mask" | N/A-YET | Masks. |
| 196 | "Paint on folder mask" | N/A-YET | Masks. |
| 197 | "Selection clip" | ticked | |
| 198 | "16-bit layers" | N/A-YET | Deep layers are refused (document.js:164). |
| 199 | "Live layer effects while painting" | N/A-YET | Effects are not rendered. |
| 200 | "Shift-click straight line" | DONE | view.js:562-573 (same layer; through smoothing as upstream). |
| 201 | "Shift-drag axis lock" | PARTIAL | Axis settled after 3 px, released Shift resumes freehand (view.js:596-607). Difference: on mouse-up upstream appends the raw, unlocked release point (Rendering/EditorCanvas.swift:2121-2125 → continueBrush), the port keeps the locked point (view.js:629-630). Mirror it or record it as a deliberate deviation. |
| 202 | "[ and ] size keys" | PARTIAL | Step rule matches (brush.js:464-467; board.js:1322-1328). Gap: ignored whenever any input has focus (board.js:1233-1235), e.g. right after dragging the Hardness slider; upstream works with focus anywhere but a text field (Rendering/EditorCanvas.swift:776-797). |
| 203 | "Shift-[ / Shift-] hardness keys" | DONE | brush.js:469-473; board.js:1324. |
| 204 | "Digit opacity keys" | DONE | board.js:1329-1333; brush.js:476-479. |
| 205 | "Right-drag tip resize" | DONE | view.js:320-322, 514-528, 216, 230. |
| 206 | "Option temporary eyedropper" | PARTIAL | Samples the composite into the foreground with the ring (view.js:326-329, 501-512). Gap: cursor `copy` instead of the eyedropper (view.js:258). |
| 207 | "Brush outline cursor" | PARTIAL | White 2.5 / black 1 circle at the tip's screen diameter (view.js:213-232). Gaps: still drawn while the Color Picker is open and during a ⌘/⌃-middle-drag zoom (view.js:214-215); upstream hides it whenever it is picking or middle-navigating (Rendering/EditorCanvas.swift:1510). |
| 208 | "Escape cancels stroke" | DONE | board.js:1240-1245; view.js:460-472. |
| 209 | "Commit on release" | N/A-YET | One step "Brush Stroke" / "Erase" (view.js:635). "Paint Mask" needs masks; the other names need their tools. |
| 210 | "Refusal alert: several layers selected" | N/A-YET | Multi-selection. |
| 211 | "Refusal alert: folder target without its mask selected" | PARTIAL | Port toast "This is a folder. Select a layer inside it to paint." (document.js:161); upstream alert "Couldn’t paint" with "“<name>” is a folder, which has no pixels of its own. Paint on a layer inside it, or on the folder’s mask." (Document/EditorSession+Brush.swift:17; ContentView.swift:297-300). |
| 212 | "Refusal alert: hidden layer or inside a hidden folder" | PARTIAL | Port "This layer is hidden. Show it to paint on it." (board.js:551); upstream "“<name>” is hidden, or inside a hidden folder. Show it to paint on it." (Document/EditorSession+Brush.swift:20). The port also checks folder/adjustment before visibility (board.js:549-551), upstream visibility first. |
| 213 | "Refusal alert: mask turned off" | N/A-YET | Masks. |
| 214 | "Refusal alert: adjustment layer pixels" | PARTIAL | Port "This is an adjustment layer; it has no pixels to paint." (document.js:162); upstream "“<name>” is an adjustment layer, with no pixels to paint. Paint on its mask instead." (Document/EditorSession+Brush.swift:26). |
| 215 | "Pixel budget" | PARTIAL | Growth is capped (brush.js:315-319) with toast "This stroke would make the layer larger than Compositor allows."; upstream alert text is ProjectError.tooLarge, "This project exceeds the supported canvas, layer, file-size, or <N>-megapixel document limit." (Document/BrushStroke.swift:668; IO/ProjectStore.swift:76). The port's budget is a fixed 200 MP (board.js:23) instead of min(800 MP, max(200 MP, RAM/16)) (Document/DocumentLimits.swift:35-36). |
| 216 | "Shared tip" | N/A-YET | Needs Spot Healing, Clone Stamp, Smear. |
| 217 | "Header disabled while busy" | MISSING | Only selection-tool headers dim while the engine works (board.js:419); upstream disables the brush header once an operation has run 250 ms (UI/BrushControls.swift:133; Document/EditorSession.swift:130-148). |

## Tools › Shape (281-298)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 283 | "Tool selection" | PARTIAL | U (board.js:1315-1318), header "Shape" (board.js:244). Rail label wrong (board.js:17; see 53). |
| 284 | "Kind picker" | PARTIAL | Segmented Rectangle / Ellipse / Line, default Rectangle, a change cancels a draft (board.js:245, 283; shapes.js:14). Gap: help "Shift-U (or Tab) steps through Rectangle, Ellipse and Line" missing (UI/ShapeControls.swift:16). |
| 285 | "Shift-U / Tab cycles kind" | DONE | board.js:475-478, 1315-1316. |
| 286 | "Fill color swatch" | DONE | board.js:246, 277; shapes.js:198 (tooltip counted at 2326). |
| 287 | "Line Width" | PARTIAL | Line only, slider 1-100, field 1-5000, default 4, non-finite → 4 (board.js:247, 307; shapes.js:14). Gap: the "Width" label does not scrub (no `data-scrub`, board.js:247, 320-332), although CSS gives it the ew-resize cursor (board.css:135); upstream scrubs 1 per point over 1-5000 (UI/ShapeControls.swift:28). |
| 288 | "Corner Radius" | PARTIAL | Rectangle only, slider 0-200, field 0-5000, default 0, capped at half the shorter side (board.js:248, 308; shapes.js:85). Gap: the "Radius" label does not scrub (UI/ShapeControls.swift:43). |
| 289 | "Smooth Corners" | DONE | board.js:249, 284; shapes.js:35-66, 87. |
| 290 | "Drag to draw" | PARTIAL | Live draft in the foreground (board.js:744-753), new layer above the active one, "Rectangle 1"…, one step named after the kind, selection kept (board.js:1697-1710; shapes.js:173-208). Gap (edge): with a folder active the port puts the layer at the folder's top (board.js:608-624); upstream's addPixelLayer inserts at array index(folder)+1 with the folder as parent (Document/SelectionClipboard.swift:302-306), which for a folder made by Group lands at its bottom. |
| 291 | "Shift constrain" | DONE | shapes.js:129-139, 155-166; view.js:779. |
| 292 | "Option from center" | DONE | shapes.js:136-137; view.js:779. |
| 293 | "Snapping" | DONE | view.js:762-766; board.js:584-589 (edges, no centers; Control bypasses). View › Snap To toggles are not ported; behaviour equals their defaults. |
| 294 | "Line geometry" | DONE | shapes.js:183-192, 113-118. |
| 295 | "Click or cancel" | DONE | shapes.js:193; view.js:466. |
| 296 | "Size limit" | PARTIAL | Port "That shape is too large. A shape can be at most 30000 pixels on a side." (shapes.js:195-197); upstream "That shape is too large. A shape can cover up to 200 megapixels." with an area test only (Document/ShapeTool.swift:172-173). |
| 297 | "Live shape on resize" | PARTIAL | Redrawn at the new size on commit (board.js:705-714; shapes.js:211-216). Gap: rounded rectangles stretch during the drag; upstream redraws them live up to 2048 px (Document/ShapeTool.swift:218-238; Document/EditorSession.swift:512-523). |
| 298 | "Becomes pixels once edited" | DONE | Painting drops `shape` (board.js:645-646); style kept in the manifest while live. |

## Tools › Eyedropper (320-326)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 322 | "Header" | PARTIAL | Title + "Sample Ring" default on (board.js:251). Gap: the port saves Sample Ring (board.js:39, 280); upstream does not persist it (Document/EditorSession.swift:107). |
| 323 | "Click or drag samples the composited color" | DONE | view.js:501-512 (one pixel of the composite, nothing outside or over alpha 0). |
| 324 | "Sample ring" | PARTIAL | New sample on top, earlier color below, gray backing, hidden on release, honours the toggle (view.js:234-247, 430). Gaps: ring radius 31 pt (view.js:238, `58 - 15 - 12`); upstream strokes an oval inset 15 in the 116 pt box, radius 43 (Rendering/SampleRingOverlay.swift:16-19). No ring is shown when the press is over a transparent pixel (view.js:506), upstream still shows it (Rendering/EditorCanvas.swift:2529-2533); with the picker open the "before" half should be the picker's color, not the foreground (view.js:300). |
| 325 | "With the color picker open, sampling writes into the picker" | DONE | view.js:299-302; picker.js:182-186. |
| 326 | "Eyedropper cursor over the canvas" | PARTIAL | CSS `copy` (view.js:259); the port already draws an eyedropper cursor for Color Range (`CB.SelectionCursors.eyedropper`, select-tools.js:904-910). |

## Tools › Hand (328-331)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 330 | "Header" | DONE | "Pan", no controls (board.js:254-255). |
| 331 | "Drag pans the view" | DONE | view.js:256, 292-296, 350-356. |

## Tools › Zoom (333-339)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 335 | "Header" | PARTIAL | "Zoom" + 72 px field, clamped 0.1-3200 %, Return applies and refocuses the canvas (board.js:256-257, 315-318, 338). Gaps: the value is rounded to one decimal then printed with `toFixed(2)` ("66.70", board.js:25, 359); upstream "%.2f" with trailing zeros trimmed ("66.67") (UI/NavigationToolHeader.swift:59-63). Escape reverts (board.js:339); upstream Escape applies (UI/NavigationToolHeader.swift:21, 46-49). Text with "%" is rejected (`Number('50%')` is NaN); upstream strips "%" (:53-54). Not disabled while busy (:27). |
| 336 | "Zoom field stepping" | PARTIAL | ↑/↓ ±1 %, Shift ±10 % (board.js:340-344). Gap: the "%" suffix is not a scrub handle (UI/NavigationToolHeader.swift:28-30). |
| 337 | "Click zooms in 2x about the click point" | DONE | view.js:325, 426-428. |
| 338 | "Scrubby zoom" | PARTIAL | 2^(dx/100) about the press (view.js:360-365). Gap: the 3 pt dead zone is re-tested on every move, so within 3 pt of the start the zoom freezes instead of returning to the starting zoom; upstream latches `moved` once (Rendering/EditorCanvas.swift:1885-1899). |
| 339 | "Cursor" | PARTIAL | zoom-in, zoom-out with Option (view.js:257). Gap: does not switch to zoom-out while dragging left (Rendering/EditorCanvas.swift:1887-1893). |

## Layers panel and layer operations (420-536)

### Panel layout

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 424 | "Docked panel on the right of the canvas" | PARTIAL | 222-352, default 252 (board.js:40, 126; board.css:19). Gaps: saved per board in webview state (board.js:83), upstream app-wide `layersPanelWidth` (ContentView.swift:6); a restored width is not clamped (board.js:40; upstream ContentView.swift:123-126). Fullscreen N/A-YET. |
| 425 | "Resize edge" | PARTIAL | 8 px strip, col-resize cursor, clamped (board.css:269; board.js:121-130). Gaps: tooltip "Drag to resize" (board.js:97) vs "Drag to resize the panel" (ContentView.swift:390); width not rounded to whole points (board.js:126; ContentView.swift:386). |
| 426 | "Header" | PARTIAL | "Layers" + count of every record (layers.js:21, 157). Gap: " · N notes" is appended to the count (layers.js:157). |
| 427 | "Empty state" | PARTIAL | Icon + "No layers yet" (layers.js:161). Gap: second line "Add a blank layer with +." vs "Import an image or add a blank layer." (UI/LayersPanel.swift:27). |
| 428 | "Whole panel grays out (layersLookEditable)" | MISSING | Nothing dims while a filter panel, Color Range, a floating transform or an engine operation is open (upstream Document/EditorSession.swift:692-697). |
| 429 | "Blend mode pop-up" | N/A-YET | "Blend" row, disabled for folders, capsule (layers.js:23-24, 144; board.css:198-204). Multi-selection rule pending. |
| 430 | "Blend mode list, 24 modes in 6 groups" | DONE | blend.js:11-20; layers.js:65. |
| 431 | "Blend mode live preview" | PARTIAL | Choosing commits one "Layer Blend Mode" step (layers.js:66; board.js:1620-1624). Gap: a native `<select>` cannot preview on hover or restore on close (UI/BlendModePicker.swift:46-76). |
| 432 | "Blend mode cycling" | DONE | board.js:1339-1342; blend.js:62-65. |
| 433 | "Opacity slider" | DONE | layers.js:26, 70-71, 146; board.js:1627-1647. |
| 434 | "Opacity percent field" | DONE | layers.js:27, 72-89. |
| 435 | "Opacity label scrub" | DONE | layers.js:91-99; board.css:289. |
| 436 | "Footer button New blank layer" | DONE | layers.js:31, 44. |
| 437 | "Footer button New folder" | N/A-YET | Folder creation. |
| 438 | "Footer button Add layer mask" | N/A-YET | Masks. |
| 439 | "Footer menu New adjustment layer" | N/A-YET | Adjustment layers. |
| 440 | "Footer menu Add layer effect" | N/A-YET | Effects. |
| 441 | "Footer trash button" | PARTIAL | Deletes the active layer (layers.js:33, 45). Gap: tooltip "Delete selected layer (⌫)" vs "Delete selected layer" (UI/LayersPanel.swift:58-59). Effect / mask / several-layers titles N/A-YET. |
| 442 | "Footer icons dim to quarter-strength white" | PARTIAL | Disabled icons are 35 % of an 86 % white ≈ 30 % (board.css:184, 187), upstream 25 %; hit area 26x24 px (board.css:178-179) instead of the icon plus 8 pt / 12 pt padding (UI/LayersPanel.swift:94-99). |

### Rows

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 446 | "Native list, top layer first, row height 52 pt" | PARTIAL | Top first, 52 px rows, 2 px spacing (layers.js:103-123; board.css:294-304). Gap: the hairline is 1 CSS px, 2 device px on Retina (board.css:304); upstream draws one device pixel. Effect sub-rows N/A-YET. |
| 447 | "Click selects on mouse-down" | N/A-YET | Selects on pointerdown (layers.js:301-313). Shift/Cmd multi-selection pending. |
| 448 | "A newly selected layer … is scrolled into view" | MISSING | `board.select` only toggles classes (board.js:522-529; layers.js:132-136); no scroll, collapsed ancestors stay closed (Document/LayerGroups.swift:156-165; UI/NativeLayerList.swift:95-97). |
| 449 | "Visibility eye button" | DONE | layers.js:191, 281-285; "Show Layer"/"Hide Layer" (board.js:1616-1618). |
| 450 | "Eye swipe" | MISSING | No drag across eyes (UI/NativeLayerList.swift:1420-1441; Document/EditorSession.swift:771-783). |
| 451 | "Rows of layers hidden through a hidden parent folder draw at 35% opacity" | PARTIAL | 35 % on everything but the eye (board.css:307); upstream sets the whole row's alpha, eye included (UI/NativeLayerList.swift:1063). |
| 452 | "Folder disclosure chevron" | PARTIAL | Collapses/expands (layers.js:286-295). Gaps: collapsing a folder that holds the active layer does not select the folder (Document/LayerGroups.swift:283-290); no "Expand or collapse folder" label (2374). |
| 453 | "Indentation" | N/A-YET | 24 per level capped at 8, +24 when clipped (layers.js:173). Effect sub-rows pending. |
| 454 | "Layer thumbnail (36 pt box)" | PARTIAL | Canvas-shaped, 6 pt checker #383838/#525252, layer placed (layers.js:229-257); folder and text icons (layers.js:189). Gap: every adjustment kind shows one generic icon instead of its kind's symbol, Curves rotated (UI/NativeLayerList.swift:1009-1012). |
| 455 | "Layer thumbnail click targets the layer's pixels" | PARTIAL | 2 px accent outline on the active row's thumbnail (board.css:312). Gap: tooltip is "Select layer; Cmd-click to select its pixels…" (layers.js:194); upstream overwrites that in configure() with "Select image pixels" / "Editable text layer" (UI/NativeLayerList.swift:1038). |
| 456 | "Cmd-click layer thumbnail loads the layer's visible pixels" | ticked | |
| 457 | "Double-click on a row's thumbnail opens what it holds" | N/A-YET | Double-click on the name renames (layers.js:55-60); text / adjustment editing pending. |
| 458 | "Clicking the row's name while its mask is targeted" | N/A-YET | Mask targeting. |
| 459 | "Name label" | DONE | One line, truncating (board.css:318); "↳ " prefix (layers.js:197). |
| 460 | "Subtitle line" | PARTIAL | Gaps: size is the pixel size (layers.js:181-183) but upstream shows the placed size, transform.size rounded, plus the % (UI/NativeLayerList.swift:1474-1481; Document/EditorSession.swift:27); blank layers read "Empty" (layers.js:184) instead of their size; "Text · edit the text in Compositor" and "Adjustment · <kind>" (layers.js:178-179) instead of "Text · Double-click to edit" / "Adjustment · Double-click to edit"; fallback "a missing layer" instead of "Missing source"; no tooltip "Clipping mask based on <name>. Option-click the bottom of its row to release." (UI/NativeLayerList.swift:1053-1057). |
| 461 | "Depth tag pill" | PARTIAL | "16-Bit"/"HDR" (layers.js:186). Gaps: no tooltips "16-bit layer: keeps 16 bits a channel" / "HDR layer: keeps light brighter than white, shown as white"; shown on clipped rows too (upstream hides, UI/NativeLayerList.swift:1048-1052); extra port tags (shape kind, "not shown here") sit in the same spot. |
| 462 | "Inline rename" | PARTIAL | Field with all text selected, Return/click-away keeps, Esc restores, trimmed, blank ignored, "Rename Layer" (layers.js:333-357; board.js:1612-1614). Gap: focus goes to the canvas (layers.js:348), upstream back to the list (UI/NativeLayerList.swift:1124-1127). |
| 463 | "Middle-mouse drag anywhere in the list scrolls it" | MISSING | layers.js:302 ignores non-primary buttons. |
| 464 | "Cmd-A with the list focused selects the whole canvas" | DONE | board.js:1285 (document-level). |
| 465 | "List keeps canvas keys working while focused" | DONE | The keyboard handler is document-wide and the list is not an input (board.js:66, 1231-1373; layers.js:29). |
| 466 | "Arrow keys in the list nudge the selected layer" | DONE | board.js:1351-1365. |
| 467 | "Option held over a row shows the duplicate cursor" | MISSING | No row cursors (duplicate cursor available as CB.SelectionCursors.duplicate). Clipping-strip and mask-eye cursors N/A-YET. |

### Drag and drop

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 471 | "Drag rows to reorder" | N/A-YET | Single row with drop line, above the row under the line in its folder, "Move Layer" (layers.js:361-407; board.js:1650-1680). Several rows pending. |
| 472 | "Drop onto a folder row nests the layer(s) inside it" | PARTIAL | Lands on top of the folder's contents (board.js:1668-1672). Gap: a collapsed target folder is not expanded (Document/LayerGroups.swift:316). |
| 473 | "Dragging a folder carries its whole subtree" | DONE | Children follow through parentID; dropping into itself or a descendant is refused (board.js:1654-1662). |
| 474 | "Option-drag duplicates instead of moving" | MISSING | layers.js:399-404 always moves. |
| 475 | "A layer dropped into the middle of a clipping stack is clipped" | MISSING | moveLayerTo leaves maskSourceID alone (board.js:1663-1679); upstream runs adoptClipping and releaseDetachedClipping (Document/LiveLayerMask.swift:42-51, 232-244; Document/LayerGroups.swift:311-312). Documents from Compositor with clipping stacks change appearance after a reorder. |
| 476 | "Option-drag an effect sub-row" | N/A-YET | Effects. |
| 477 | "Option-drag a mask thumbnail" | N/A-YET | Masks. |

### Context menu

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 481 | "Right-click a row" | N/A-YET | Selects the row, then shows the menu (layers.js:315-330). Mask / effect targets pending. Note: the menu adds port items (Select Layer's Pixels, Select Mask's Black Areas, Open in Compositor). |
| 482 | "Duplicate Layer" | N/A-YET | Single layer (layers.js:319); folder and multi duplication pending. |
| 483 | "Rename…" | DONE | layers.js:320. |
| 484 | "Delete Layer / Delete Selected Layers / Delete Mask" | N/A-YET | "Delete Layer" (layers.js:321); other titles pending. |
| 485 | "Create Clipping Mask / Release Clipping Mask" | N/A-YET | Clipping UI. |
| 486 | "Group Selected Layers" | N/A-YET | Folder creation. |
| 487 | "Ungroup Layers" | N/A-YET | Folder operations. |
| 488 | "Move Out of Folder" | N/A-YET | Folder operations. |
| 489 | "Merge Down / Merge Layers / Merge Group" | MISSING | No merge item. Merge Down can be built on the engine; Merge Layers / Group stay N/A-YET. |
| 490 | "Convert to 16-Bit / Convert to 8-Bit" | N/A-YET | Deep layers. |
| 491 | "Add Mask › Reveal All / Hide All" | N/A-YET | Masks. |
| 492 | "Enable Mask / Disable Mask" | N/A-YET | Masks. |
| 493 | "Delete Mask" | N/A-YET | Masks. |
| 494 | "Link Mask / Unlink Mask" | N/A-YET | Masks. |
| 495 | "Hide Layer / Show Layer" | DONE | layers.js:323. |

### Layer menu commands

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 499 | "New Blank Layer ⇧⌘N" | PARTIAL | "Layer N", canvas-sized, pixels on first paint, above the active layer or at the folder's top, "New Blank Layer" (board.js:1539-1550, 608-624, 1094, 1281). Gap: a collapsed parent folder is not expanded (Document/EditorSession.swift:709). |
| 500 | "Duplicate Layer ⌘J (no selection)" | PARTIAL | "<name> copy" just above, becomes active (board.js:1576-1610). Gap: no refusal past 10,000 layers (Document/SelectionClipboard.swift:263). Folders, several layers, deep pixels N/A-YET. |
| 501 | "Layer via Copy ⌘J (with a selection)" | PARTIAL | Runs upstream's own layerViaCopy in the engine (board.js:1056-1059; engine/Sources/SelectionOps.swift:52). Gap: the menu title follows "pixels selected" (board.js:1095) instead of `selection == nil` (CompositorApp.swift:353), so an explicitly empty selection is titled "Duplicate Layer". Mask target N/A-YET. |
| 502 | "Edit Adjustment…" | N/A-YET | Adjustments. |
| 503 | "Create/Release Clipping Mask ⌥⌘G" | N/A-YET | Clipping UI. |
| 504 | "Group Selected Layers ⌘G" | N/A-YET | Folder creation. |
| 505 | "Ungroup Layers ⇧⌘G" | N/A-YET | Folder operations. |
| 506 | "Move Out of Folder" | N/A-YET | Folder operations. |
| 507 | "Rename Layer…" | MISSING | Not in the Layer menu (board.js:1093-1104). |
| 508 | "Show Layer / Hide Layer" | DONE | board.js:1103. |
| 509 | "Move Layer Up ⌘] / Move Layer Down ⌘[" | PARTIAL | Swaps with the sibling, "Reorder Layers" (board.js:1683-1694, 1100-1101, 1283-1284). Gap: both items stay enabled at the ends (board.js:1100-1101); upstream disables them (CompositorApp.swift:378-381; Document/EditorSession.swift:788-793). |
| 510 | "Merge Down ⌘E (one layer)" | MISSING | |
| 511 | "Merge Layers ⌘E (several selected)" | N/A-YET | Multi-selection. |
| 512 | "Merge Group ⌘E (a folder active)" | N/A-YET | Folder operations. |
| 513 | "Merge result" | MISSING | Comes with Merge Down. |
| 514 | "Delete Layer / Delete Layers / Delete Layer Mask / Delete <Effect>" | N/A-YET | "Delete Layer", folder with contents, one step, the layer at the same index becomes active (board.js:1096, 1558-1573 = finishDeletingLayer). Other titles pending. |
| 515 | "Delete key (no pixel selection)" | N/A-YET | Same rule as deleteKeyPressed for layers (board.js:1366-1371). Effect / mask branches pending. |
| 516 | "Deleting a layer that is the base of clipped layers which stay" | PARTIAL | The port always does "Remove Links and Delete" silently (board.js:1569); no alert, no Bake and Delete, no Cancel (Document/LiveLayerMask.swift:100-130). |

### Folders, deep layers, limits

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 520 | "Folders are pass-through" | DONE | render.js:47, 28-33. |
| 521 | "Folders take opacity and a mask but no blend mode…" | N/A-YET | Blend disabled (layers.js:144), painting refused (document.js:161), nesting ≤ 64 (render.js:29). Folder masks pending. |
| 522 | "New layers and adjustment layers created with a folder active go inside it" | PARTIAL | New layers go inside (board.js:608-624). Gap: a collapsed folder is not expanded. Adjustment layers N/A-YET. |
| 526 | "16-bit layers in 8-bit documents" | N/A-YET | Deep layers. |
| 527 | "HDR layers" | N/A-YET | Deep layers. |
| 528 | "Convert to 16-Bit (8-bit layer)" | N/A-YET | Deep layers. |
| 529 | "Convert to 8-Bit" | N/A-YET | Deep layers. |
| 530 | "HDR Convert to 16-Bit" | N/A-YET | Deep layers. |
| 531 | "Conversion unavailable for text, adjustment and folder layers" | N/A-YET | Deep layers. |
| 532 | "Painting on a 16-bit layer keeps the base at full depth" | N/A-YET | Deep layers. |
| 536 | "At most 10,000 layers…" | PARTIAL | 30,000 px side and 200 MP per surface for shapes and strokes (shapes.js:12-13; brush.js:17, 315). Gaps: no 10,000-layer cap; document budget fixed at 200 MP (board.js:23) instead of RAM-scaled 200-800 MP (Document/DocumentLimits.swift:35-36). |

## Color › Foreground / background swatches (1336-1344)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 1338 | "Tool-rail swatches" | DONE | 24 px, offset 12, defaults black/white (board.js:38, 134-140; board.css:235-256). |
| 1339 | "Click opens picker" | DONE | board.js:142-143, 502-508. |
| 1340 | "Swap" | DONE | board.js:138, 144, 488-493, 1320. |
| 1341 | "Reset" | DONE | board.js:139, 145, 495-500, 1321. |
| 1342 | "Mask mode" | N/A-YET | Masks. |
| 1343 | "Disabled while busy" | PARTIAL | X / D / buttons are ignored during a drag (board.js:489, 496). Gap: nothing is blocked while the engine works (board.js:929-937); upstream `canEditPalette = !isProjectBusy && brushStroke == nil` (Document/ColorPalette.swift:25; UI/ColorPaletteControls.swift:39). |
| 1344 | "No swatch library" | DONE | None exists. |

## View › Zoom (1370-1390)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 1372 | "Fit Canvas" | DONE | 48 px a side, pan reset, followsFit (view.js:76-84); menu ⌘0 (board.js:1122, 1279). Note: no `max(1, …)` guard for a view under 96 pt (Rendering/CanvasViewport.swift:36-37). |
| 1373 | "Fit follows window resizes" | PARTIAL | ResizeObserver refits while followsFit (view.js:29, 43-51). Gap: a devicePixelRatio change (another display) neither refits nor resizes the canvases. |
| 1374 | "Actual Pixels" | DONE | view.js:41; board.js:1123, 1280. |
| 1375 | "Zoom In" | DONE | view.js:99-103; board.js:1120, 1277-1278 (⌘= and ⌘+), ignored while typing (board.js:1235). |
| 1376 | "Zoom Out" | DONE | Same code paths. |
| 1377 | "Keyboard zoom levels" | DONE | view.js:10. |
| 1378 | "Zoom range clamp" | DONE | view.js:11, 80, 88. |
| 1379 | "Toolbar Fit button" | DONE | board.js:207. |
| 1380 | "Toolbar 100% button" | DONE | board.js:208. |
| 1381 | "Toolbar zoom in / zoom out magnifier buttons" | PARTIAL | Zoom-in help "Zoom in (⌘=)" (board.js:210) vs "Zoom in (⌘+)" (ContentView.swift:215); order is out-then-in (board.js:209-210), upstream in-then-out (ContentView.swift:212-219). |
| 1382 | "Pinch to zoom" | DONE | view.js:482, 485-487. |
| 1383 | "⌘ or ⌥ + scroll wheel zooms at the pointer" | PARTIAL | exp(-Δy·0.015) at the pointer (view.js:488-489), but line-mode deltas are multiplied by 12 first (view.js:484); upstream applies the 12x only to panning (Rendering/EditorCanvas.swift:2182-2193). |
| 1384 | "Scroll to pan" | DONE | view.js:482, 484, 490-494. |
| 1385 | "Middle mouse button drag pans from any tool" | PARTIAL | Pans (view.js:292-296). Gap: the cursor is `grabbing` only for Space or Hand (view.js:256); upstream shows the closed hand for any middle pan (Rendering/EditorCanvas.swift:2045-2051). |
| 1386 | "⌘ or ⌃ + middle mouse drag zooms" | PARTIAL | Up in, down out, 2x per 100 pt about the press (view.js:293, 357-358). Gap: no zoom-in / zoom-out cursor following the direction (Rendering/EditorCanvas.swift:2045-2066). |
| 1387 | "Preview-zoom redirect" | N/A-YET | Export As. |
| 1388 | "Moving between displays keeps the document point at the view center" | MISSING | No devicePixelRatio listener; pan is not rescaled (Rendering/CanvasViewport.swift:43-54). |
| 1389 | "High-quality downsampling when zoomed out" | PARTIAL | Relies on Canvas `imageSmoothingQuality = 'high'` (view.js:146-148); no cached chain of 2x Lanczos halvings or edge padding (Rendering/DownsampleCache.swift:5-111). |
| 1390 | "Crisp pixels from 200%" | DONE | view.js:11, 146. |

## Status bar and hints

### Status bar layout (2107-2116)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 2109 | "Bar" | N/A-YET | 30 px, 11 px tabular digits, secondary text, 18 px padding, fixed row (board.css:40, 376-388). Fullscreen hiding pending. |
| 2110 | "Zoom readout" | PARTIAL | 62 px wide (board.css:388). Gap: `number()` prints one-decimal values with two decimals, "66.70%" / "12.50%" (board.js:25, 433, 437); upstream `.percent` with 0-1 decimals, "66.7%", with locale grouping ("1,600%") (ContentView.swift:352). |
| 2111 | "Canvas dimensions" | DONE | board.js:438. |
| 2112 | "Color mode label" | DONE | board.js:439. |
| 2113 | "Empty state" | MISSING | With no document the bar is empty (board.js:417 returns early); upstream "Ready when you are" (ContentView.swift:356). |
| 2114 | "Busy indicator" | PARTIAL | A "Working…" chip on the left as soon as an engine call starts (board.js:442). Gap: upstream shows a mini spinner + "Working…" in the hint's place only after 250 ms (ContentView.swift:358-360; Document/EditorSession.swift:130-148). |
| 2115 | "Import indicator" | N/A-YET | Image import. |
| 2116 | "Tool hint" | PARTIAL | Right-aligned (board.js:443-444). Gap: not replaced by the busy indicator (ContentView.swift:364-366). |

### Tool hints (2118-2140)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 2120-2125 | Marquee / Magic / Lasso hints | ticked | |
| 2126 | "Brush Paint" | PARTIAL | Port adds " · Option-click to sample" (board.js:423). |
| 2127 | "Brush Erase" | PARTIAL | Same extra phrase (board.js:423). |
| 2128 | "Smear Blur" | N/A-YET | |
| 2129 | "Smear Smudge" | N/A-YET | |
| 2130 | "Smear Liquify" | N/A-YET | |
| 2131 | "Clone Stamp" | N/A-YET | |
| 2132 | "Spot Healing" | N/A-YET | |
| 2133 | "Type" | N/A-YET | |
| 2134 | "Shape" | DONE | board.js:424. |
| 2135 | "Gradient" | N/A-YET | |
| 2136 | "Crop" | N/A-YET | |
| 2137 | "Move" | DONE | board.js:422. |
| 2138 | "Hand" | DONE | board.js:427. |
| 2139 | "No tool" | MISSING | No-tool mode (A) is not ported (see 56). |
| 2140 | "Zoom (and fallback for Eyedropper)" | PARTIAL | Zoom text matches (board.js:428). Gap: the Eyedropper has its own hint "Click to sample · Option-click in Brush samples too" (board.js:425); upstream shows the Zoom text for it (ContentView.swift:365). |

## Help text belonging to UI the port has (2146-2399)

| Line | Title | Status | Evidence / gap |
|---|---|---|---|
| 2148 | BrushControls › "Aligned" tooltip | N/A-YET | Clone Stamp. |
| 2149 | BrushControls › "Copy from the active layer only, or from every visible layer as shown" | N/A-YET | Clone Stamp. |
| 2150 | BrushControls › "The brush trails the pointer on a string this long…" | MISSING | Smoothing has no title (board.js:240). |
| 2251 | ColorPaletteControls › "Swap foreground and background (X)" | DONE | board.js:138. |
| 2252 | ColorPaletteControls › accessibility label "Swap colors" | MISSING | No aria-label (board.js:138). |
| 2253 | ColorPaletteControls › "Default colors (D)" | DONE | board.js:139. |
| 2254 | ColorPaletteControls › accessibility label "Default colors" | MISSING | board.js:139. |
| 2255 | ColorPickerSheet › "Saturation and brightness" | MISSING | picker.js:107. |
| 2256 | ColorPickerSheet › "New color" | MISSING | picker.js:110. |
| 2257 | ColorPickerSheet › "Hex color" | MISSING | picker.js:115. |
| 2320 | NavigationToolHeader › accessibility label "Zoom percentage" | MISSING | board.js:257. |
| 2321 | NavigationToolHeader › "Zoom percentage (0.1–3200%). Press Return to apply." | MISSING | board.js:257. |
| 2326 | ShapeControls › "Fill color" tooltip "Shapes fill with the foreground color; click to change it" | PARTIAL | The shared swatch says "Foreground color: click to change" (board.js:215, 246); accessibility label "Fill color" missing. |
| 2327 | ShapeControls › "px" tooltip "Round the rectangle's corners by this many pixels; 0 keeps them square" | MISSING | board.js:248. |
| 2328 | TransformInspector › "Auto Select" tooltip | MISSING | board.js:219. |
| 2329 | TransformInspector › "Show Controls" tooltip | MISSING | board.js:220. |
| 2330 | TransformInspector › "link" tooltip | PARTIAL | "Keep proportions (Shift flips it while dragging)" (board.js:225) vs "Lock aspect ratio. Hold Shift while dragging a handle to turn it the other way." |
| 2331 | TransformInspector › "Scale width and height together, about the center" | MISSING | board.js:227. |
| 2361 | KeyboardShortcuts › modifier help text | N/A-YET | Keyboard Shortcuts editor. |
| 2365-2370 | LayerMaskMenu › six help texts | N/A-YET (6) | Masks, mask-alone view, CMYK proofing. |
| 2372 | NativeLayerList › "Show mask alone" | N/A-YET | Masks. |
| 2373 | NativeLayerList › "Select layer; Cmd-click…" | ticked | See note below. |
| 2374 | NativeLayerList › "Expand or collapse folder" | MISSING | layers.js:193. |
| 2375 | NativeLayerList › mask thumbnail help | N/A-YET | Mentions Option/Shift-click mask features not ported; the port shows "Layer mask" (layers.js:195). |
| 2376 | NativeLayerList › "Clipped to Missing source" | PARTIAL | Port fallback "Clipped to a missing layer" (layers.js:180). |
| 2380 | ShapeControls › "Set a radius above 0 to use smooth corners." | DONE | board.js:249. |
| 2381 | ShapeControls › "Use smooth squircle corners at 60% smoothing, matching Figma's iOS setting" | DONE | board.js:249. |
| 2393 | LayerMask › undo name "Disable Layer Mask" | N/A-YET | Masks. |
| 2394 | LayerMask › undo name "Unlink Layer Mask" | N/A-YET | Masks. |
| 2395 | LiveLayerMask › "Bake keeps the current masked appearance…" | MISSING | Goes with the delete alert (line 516). |

### Note on a ticked line

Line 2373 ("Select layer; Cmd-click to select its pixels (Cmd-Shift adds, Cmd-Option subtracts)") is a real string literal (UI/NativeLayerList.swift:899), but `configure()` overwrites the thumbnail's tooltip on every row with "Select image pixels" or "Editable text layer" (UI/NativeLayerList.swift:1038), so upstream never shows it. The port shows it (layers.js:194). Consider unticking 2373 and fixing 455.

---

## Fix list

Everything below can be done in the board without porting a new big feature. Ordered by importance: wrong edits or wrong pictures first, then keyboard and status behaviour, then cursors, strings, polish.

1. **Option-drag duplicate is one undo step and Escape removes the copy** (75). In `actions` (board.js:1576-1610) split the copy into `makeDuplicate(id)` that changes the manifest and pixels without `board.edit` and returns `{ copyID, metaBefore, pixels }`. In `view.continueTransform` (view.js:703-710) call it and keep the result on `drag.copy`. In `finishTransform` (view.js:736-747), when `drag.copy` exists, apply the transform and push one history entry labelled "Duplicate Layer" with `metaBefore = drag.copy.metaBefore`, `metaAfter = doc.snapshot()`, `pixels = drag.copy.pixels`. In `cancelTransform` (view.js:749-757) remove the copy's record and entry and `board.select(original id)`; no history entry. Allow folders when folder duplication lands.
2. **Clipping rules when rows are dropped** (475). In `actions.moveLayerTo` (board.js:1663-1679), after splicing, port `adoptClipping(id, layers)` and `releaseDetachedClipping(layers)` from Document/LiveLayerMask.swift:42-51 and 232-244 (siblings grouped by parentID in array order; a layer with maskSourceID whose source is not the running base loses maskSourceID).
3. **Deleting a clipping base asks first** (516, 2395). In `actions.deleteLayer` (board.js:1558-1573), when a kept layer has `maskSourceID` in the deleted set, show a modal titled "This layer supplies a live mask" ("These layers supply live masks" for several) with the message "Bake keeps the current masked appearance in the dependent layers’ pixels. Remove Links reveals their pixels. You can undo either choice." and buttons "Bake and Delete", "Cancel", "Remove Links and Delete". Remove Links = today's code. Bake = draw each dependent through `renderer.drawLeaf` with its clip into a new image (or call the engine), then delete, in one "Delete Layer" step.
4. **Keys work after clicking header controls** (56, 202). board.js:1233 and 1389: treat as typing only `TEXTAREA`, `contentEditable`, `SELECT`, and `INPUT` whose type is text-like (`!['checkbox','radio','range','button','color'].includes(target.type)`).
5. **Number formats** (2110, 335, 186). board.js:437: `new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(zoom * 100) + '%'`. board.js:359: `(zoom * 100).toFixed(2).replace(/\.?0+$/, '')`. board.js:350: show `Math.round(diameter)`. board.js:298: a non-finite Size falls back to 40.
6. **Status bar behaviour** (2113, 2114, 2116). In `updateStatus` (board.js:416-445): with no manifest render `Ready when you are`; when `working` goes 0→1 start a 250 ms timer, and once it fires replace the `.hint` span with a small spinner + "Working…"; drop the left-hand "Working…" chip.
7. **Busy dimming** (217, 1343, 190). board.js:419: set `optionsEl.classList.toggle('busy', showsBusy)` for every tool, using the same 250 ms flag. Return early from `swapColors`, `defaultColors`, `pickColor` (board.js:488-508) while `working > 0`.
8. **Hint and rail strings** (2126, 2127, 2140, 53, 183, 283). board.js:423: drop " · Option-click to sample". board.js:425: delete the `eyedropper` entry and use the Zoom text for it. board.js:17: "Shape (U) · Shift-U switches Rectangle/Ellipse". board.js:192: keep `title` = "Brush (B) · Eraser (E)" in both modes. Add `aria-label` equal to the title on each rail button (board.js:134).
9. **Cursors** (64, 206, 326, 78, 339, 1385, 1386). In `view.cursor` (view.js:253-275): any `drag.kind === 'pan'` → `grabbing` first; eyedropper tool and Brush+Option when no stroke → `CB.SelectionCursors.eyedropper('Sample')`; Move with Option → `CB.SelectionCursors.duplicate`; rotation handle → an SVG of circular arrows (white outline, black glyph, hot spot 12 12); Move with no movable target → `default` (run the target choice of view.js:677-686 without selecting). Zoom-tool and ⌘-middle drags: store the last movement direction on the drag and show `zoom-in`/`zoom-out` from it.
10. **Sample ring** (324). view.js:238: radius `58 - 15` (43). view.js:504-506: still set `sampleRing` when the pixel is outside or transparent (now = current color). view.js:300: `before` = the picker's color when the picker is open.
11. **Tooltips and accessibility labels** (2150, 2252-2257, 2320-2331, 2374, 455, 460, 461, 2376, 425, 441, 184, 284, 190, 1381). Exact strings:
    - board.js:219 Auto Select: "Select layers by clicking the canvas. Hold Command to turn it the other way while you click."
    - board.js:220 Show Controls: "Show the transform box and handles (⌘H). When hidden, drag anywhere to move the layer."
    - board.js:225 lock: "Lock aspect ratio. Hold Shift while dragging a handle to turn it the other way."
    - board.js:227 Scale group: "Scale width and height together, about the center"
    - board.js:236 mode picker: "Paint with the foreground color (B), or erase pixels away (E)"
    - board.js:240 Smoothing group: "The brush trails the pointer on a string this long, so a shaky hand still draws a smooth line"
    - board.js:215 brush swatch: title and aria-label "Foreground color"; shape swatch (own markup at board.js:246): title "Shapes fill with the foreground color; click to change it", aria-label "Fill color"
    - board.js:245 kind picker: "Shift-U (or Tab) steps through Rectangle, Ellipse and Line"
    - board.js:248 Radius group: "Round the rectangle's corners by this many pixels; 0 keeps them square"
    - board.js:257 zoom field: aria-label "Zoom percentage", title "Zoom percentage (0.1–3200%). Press Return to apply."
    - board.js:136-137 rail swatches: "Background color" / "Foreground color" (title and aria-label); board.js:138-139 aria-labels "Swap colors" / "Default colors"
    - picker.js:107, 110, 115: aria-labels "Saturation and brightness", "New color", "Hex color" (and "Hue" on the strip)
    - layers.js:193: aria-label and title "Expand or collapse folder"
    - layers.js:194: "Select image pixels" ("Editable text layer" for text)
    - layers.js:186: "16-bit layer: keeps 16 bits a channel" / "HDR layer: keeps light brighter than white, shown as white"; no tag on clipped rows
    - layers.js:180: fallback "Missing source"; title "Clipping mask based on <name>. Option-click the bottom of its row to release."
    - board.js:97: "Drag to resize the panel"; layers.js:33: "Delete selected layer"; board.js:209-210: zoom-in first, "Zoom in (⌘+)".
12. **Refusal and limit messages** (211, 212, 214, 215, 296). document.js:161-162 and board.js:551: use upstream texts with the layer name in curly quotes ("“<name>” is a folder, which has no pixels of its own. Paint on a layer inside it, or on the folder’s mask.", "“<name>” is hidden, or inside a hidden folder. Show it to paint on it.", "“<name>” is an adjustment layer, with no pixels to paint. Paint on its mask instead."), test visibility before adjustment, and show them in a modal titled "Couldn’t paint". brush.js:316: "This project exceeds the supported canvas, layer, file-size, or 200-megapixel document limit." shapes.js:195-197: "That shape is too large. A shape can cover up to 200 megapixels." with the area test only.
13. **Held-modifier indicator** (66, 71). In `selectTools.heldModifiers` (select-tools.js:118-126), when the tool is Move, set `.auto-select.checked = settings.autoSelect !== heldCommand` and the lock icon from `lockRatio !== heldShift`; in the checkbox handler (board.js:278) store `e.target.checked !== heldCommand`.
14. **Show Transform Controls menu item** (72). Add to the View menu (board.js:1119-1124) `{ label: 'Show Transform Controls', shortcut: '⌘H', checked: () => settings.showControls, enabled: () => tool === 'move', run: toggle }` and handle Meta+KeyH in keydown (macOS may take ⌘H before the webview; the menu item still works).
15. **Reveal and expand in the Layers panel** (448, 452, 472, 499, 522). `board.select` (board.js:522-529): delete every ancestor from `layers.collapsed`, re-render if one changed, then `row.scrollIntoView({ block: 'nearest' })`. `newLayer`, `addShapeLayer`, `moveLayerTo` (`into`): delete the parent folder from `collapsed`. Disclosure click (layers.js:289-294): when collapsing a folder that contains the active layer, `board.select(folder.id)`.
16. **Gray the Layers panel while a dialog-like state is open** (428). Toggle a `locked` class on `.panel` when `filters.isOpen || selectTools.floating || selectTools.colorRange || openPanel || showsBusy`; style it like upstream's disabled look and disable footer buttons and row pointer handlers.
17. **Zoom field** (335, 336). board.js:339: Escape dispatches `change` before `focusCanvas()` (applies). board.js:315-318: strip `%` and spaces before `Number()`. Make the "%" unit a scrub handle (1 % per point, clamp 0.1-3200, `view.zoomTo`). Disable it while busy.
18. **Shape label scrub** (287, 288). Give "Width" and "Radius" `data-scrub` handling for `this.shape` (sensitivity 1, ranges 1-5000 and 0-5000, no rounding), reusing the brush scrub code at board.js:320-332.
19. **Scrubby zoom latch** (338). view.js:361: `if (drag.moved || Math.abs(p.x - drag.start.x) >= 3) { drag.moved = true; this.zoomTo(…) }`.
20. **Row subtitle** (460). layers.js:177-184: size from the transform, `Math.round(t.width) × Math.round(t.height) px`, for blank layers too; keep the % (measured on the image width); "Text · Double-click to edit"; "Adjustment · Double-click to edit".
21. **Eye swipe** (450). On pointerdown on an eye, take `doc.snapshot()`, set the new state on that layer, and while the button is held give every eye the pointer passes the same state (autoscroll near the list edges); on pointerup push one history entry labelled "Show Layer" or "Hide Layer".
22. **Option-drag rows duplicates** (474, 467). In `beginDrag` (layers.js:361-407), when Option is held at the drop, duplicate the dragged layer and place the copy at the target in one "Duplicate Layer" step; show `CB.SelectionCursors.duplicate` over rows while Option is held.
23. **Layer menu details** (507, 509, 501, 500, 536). Add "Rename Layer…" (starts `layers.rename` on the active row). Enable Move Layer Up/Down only when a sibling exists in that direction. Title ⌘J as `this.selection ? 'Layer via Copy' : 'Duplicate Layer'`. Refuse New Blank Layer and Duplicate past 10,000 layers.
24. **Merge Down** (510, 513, 489). Add an engine op that calls upstream `session.mergeLayers()` (as SelectionOps does for layerViaCopy), a Layer menu item titled from `session.mergeTitle` with ⌘E, and the same item in the row menu.
25. **Live rounded-rectangle preview while scaling a shape layer** (297). In `view.continueTransform`, when the layer has `shape.kind === 'Rectangle'` and `cornerRadius > 0` and the draft size differs by ≥ 0.5 px, draw `Shapes.shapeImage` at `min(1, 2048 / max(w, h))` of the draft size (radius scaled by the same factor) and set it as the override canvas with the draft transform.
26. **Blend mode hover preview** (431). Replace the `<select>` with a custom menu: on item hover set a renderer override for the active layer's blend mode, restore on close, commit on click with `actions.setBlend`.
27. **Display changes** (1373, 1388). Listen to `matchMedia(\`(resolution: ${dpr}dppx)\`)`; on change, if `followsFit` call `fit()`, else multiply `pan` by `newPPP / oldPPP`; then `resize()` and re-register the listener.
28. **Tab, No tool, busy switching** (59, 56, 2139, 60). board.js:1319: `code === 'Tab' && !e.shiftKey`. Add KeyA → a `none` tool: no rail highlight, header "Select a tool", hint "No tool selected · Press a tool's key to pick one · Space to pan", arrow cursor, canvas clicks ignored except Space pan. `selectTool` (board.js:450-451) returns while `working > 0`.
29. **Settings persistence** (71, 72, 322, 424, 425). Send `autoSelect`, `showControls`, `panelWidth` to the extension and keep them in `globalState`, passed back with `load`; stop persisting `sampleRing`; clamp a restored `panelWidth` to 222-352; round the width while dragging (board.js:126).
30. **Brush circle visibility** (207, 64). view.js:214-215: also hide when `board.picker.isOpen` or `drag.kind === 'zoom-drag'`; treat Option as picking only when no stroke is running.
31. **Middle-mouse scroll in the list** (463). layers.js:302: on button 1 capture the pointer and scroll `list.scrollTop` by the vertical movement with a `grabbing` cursor, without selecting.
32. **Smaller polish** (426, 427, 442, 446, 451, 454, 462, 1383, 290, 201, 1389). Count without the notes suffix (layers.js:157); empty text "Import an image or add a blank layer." (layers.js:161); footer disabled icons at 25 % white and 8/12 pt padding hit areas; a one-device-pixel hairline; dim the whole hidden row, eye included (board.css:307); one icon per adjustment kind; return focus to the list after rename; no 12x multiplier on ⌘/⌥-wheel zoom (view.js:489); shapes into an active folder at index(folder)+1 as upstream; decide whether to mirror upstream's unlocked release point for Shift strokes; a cached 2x-halving downsample chain for zoom below 50 %.
