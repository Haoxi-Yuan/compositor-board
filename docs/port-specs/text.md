# Compositor Type Tool and Text: Port Specification

Source: `~/Projects/compositor-board/upstream` (read-only, Compositor 1.5.3). All `file:line` references are relative
to `upstream/Compositor/` unless they start with `engine/`, `media/` (`vscode-extension/media/`), `core/`,
`CompositorTests/` or `docs/` (`upstream/docs/`). Code excerpts are verbatim. Modifier glyphs follow `ui.md`: `⌘`
Command, `⌥` Option, `⇧` Shift, `⌃` Control, `⌫` Delete, `⎋` Escape, `↩` Return.

Files read in full: `Document/TypeTool.swift` (472 lines), `UI/TypeControls.swift` (249),
`Rendering/InlineTextEditor.swift` (557), `IO/PSD/PSDText.swift` (682), `UI/NumericScrub.swift`,
`UI/ToolHeaderStyle.swift`, `UI/PSDConversionSheet.swift`, `CompositorTests/TypeToolTests.swift` (505). Read in part
(targeted): `Rendering/EditorCanvas.swift` (every `text`/`type` hit: `:20-48, 540-581, 990-1240, 1404-1415, 1455-1465,
1835-1890, 2098, 2195-2300, 2584-2597, 2985-3000, 3170-3231`), `Document/EditorSession.swift` (`:26-58, 98-99, 140-160,
230-236, 270-330, 380-400, 640-705`), `Document/ColorPalette.swift` (`:1-200`), `Document/SelectionEdits.swift`
(`:45-66`), `Document/SelectionClipboard.swift` (`addPixelLayer`), `Document/LayerTransform.swift`,
`Document/DocumentLimits.swift`, `Document/EditorSession+Projects.swift`, `IO/ProjectStore.swift` (`:200-260`),
`IO/PSD/PSDDocumentBuilder.swift` (`:25-100`), `UI/KeyboardShortcuts.swift` (`:125-245`), `UI/NativeLayerList.swift`
(`:390-405, 1000-1050`), `ContentView.swift` (`:40-50, 365, 395-480`), `CompositorApp.swift` (`:22-50, 200-262`),
`CompositorTests/PSDRoundTripTests.swift` (`:578-690`), `docs/project-format.md` (`:35-48`), and in this repo
`engine/` (all), `core/engine-client.js`, `vscode-extension/extension.js` (`:200-420`), `media/board.js`, `media/view.js`,
`media/render.js`, `media/layers.js`, `media/picker.js`, and the sibling specs `selection.md`, `manifest.md`, `ui.md`,
`shapes.md`.

**Empirical checks.** Layout numbers marked **(measured)** come from scratch Swift programs that copy
`textAttributes`, `attributedText`, `textBoxSize` and `textImage` verbatim from `Document/TypeTool.swift:403-471` and
configure an `NSTextView` exactly as `InlineTextEditor.init` does (`Rendering/InlineTextEditor.swift:98-130`). They ran
on this machine (macOS 26, Darwin 25.6, Apple Swift 6.4, the fonts installed here) and were deleted afterwards. Glyph
metrics depend on the installed fonts and OS version; treat the numbers as this Mac's ground truth, not as constants.

---

## 0. Summary of key facts

| Topic | Compositor behavior | Ref |
|---|---|---|
| Model | A text layer is an ordinary pixel layer whose record also carries `text: LayerTextStyle`. The PNG is the display and export source; the style is only used to edit and re-render | `Document/TypeTool.swift:7-62, 204-221`, `docs/project-format.md:46-48` |
| Live rule | Text is "live" only while the layer's pixels are still the exact raster made from the style (`asset.image === text.image`). Any edit that replaces the pixels silently ends it; the next save omits `text` | `Document/TypeTool.swift:216-220`, `Document/EditorSession+Projects.swift:13` |
| Style | `content`, `fontName` (PostScript name), `fontSize` px, `red/green/blue` 0-1, `alignment` Left/Center/Right, `tracking`, `leading` (0 = Auto = 120 %), optional `boxSize`, optional per-letter `colorRuns` and `fontRuns` in UTF-16 offsets. Size, tracking, leading, alignment are whole-text only | `Document/TypeTool.swift:7-34` |
| Layout | TextKit 1: `NSTextStorage` + `NSLayoutManager` + `NSTextContainer`, 12 px padding on every side, `lineFragmentPadding = 0`, word wrapping, `minimumLineHeight = maximumLineHeight = lineHeight`, `.kern = tracking` | `Document/TypeTool.swift:403-471` |
| Point vs box | Point text (no `boxSize`) sizes itself to what is typed and never wraps; box text has a fixed size, wraps by word, and hides lines that do not fit (a "+" marks overflow) | `Document/TypeTool.swift:418-429`, `Rendering/InlineTextEditor.swift:426-441` |
| Editing | A transparent `NSTextView` (glyphs `NSColor.clear`) sits over the canvas; the canvas draws the text as pixels re-rendered with `textImage` on every change, in its place among the layers | `Rendering/InlineTextEditor.swift:3-6, 193-196`, `Rendering/EditorCanvas.swift:29-37, 997-1003` |
| Commit | `applyText`: new text → `addPixelLayer` above the active layer, undo "New Text Layer"; existing → re-raster in place keeping the transformed top-left corner, scale, rotation, flips, undo "Edit Text". Whitespace-only new text makes nothing | `Document/TypeTool.swift:270-322` |
| Finish / cancel | ⌘↩ / ⌘Enter, Done, clicking elsewhere with Type, switching tool, switching layer, quitting → commit. ⎋ or Cancel → discard | `Rendering/InlineTextEditor.swift:43, 58-61, 517`, `Document/EditorSession.swift:389, 396` |
| Spacing keys | ⌥←/⌥→ tracking ∓1, ⌥↑ leading −1 (min 1), ⌥↓ leading +1, ⇧ = ×10. They replace word/paragraph navigation | `Rendering/InlineTextEditor.swift:44-57` |
| Fill | ⌥⌫/⌘⌫ with **no selection** on a live text layer recolors every letter, stays live, undo "Fill Text" | `Document/SelectionEdits.swift:56-58`, `Document/TypeTool.swift:343-359` |
| Engine | Everything above (layout, raster, commit, recolor) is in files the engine already compiles. Only `InlineTextEditor.swift` and `EditorCanvas.swift` are excluded, i.e. the editing UI | `engine/build.sh:17-25` |
| Board today | Text layers draw from their stored PNG; the Layers row says "Text · edit the text in Compositor"; the board's own strokes already delete `record.text`; Fill already goes through `selection.fill` and so already gets "Fill Text" | `media/layers.js:179`, `media/board.js:645`, `media/board.js:1017-1021` |

---

## 1. Checklist, line by line

Each row quotes the checklist line's short title (`docs/parity/features.md`), states Compositor's exact behavior, and
points to the section that details it. "Board" says what the board must do (sections 10-11).

### 1.1 Tools › Type (`features.md:302-318`)

| Line | Exact behavior | Detail |
|---|---|---|
| "Tool selection" | Key **T** (`Rendering/EditorCanvas.swift:2294`), rail tooltip **"Type (T)"** with SF Symbol `textformat` (`Document/EditorSession.swift:98-99`), cursor **I-beam** over the whole canvas (`Rendering/EditorCanvas.swift:1461`), header title **"Type"** (`UI/TypeControls.swift:18`). Status hint: **"Drag a text box · Click text to edit · Drag box handles to resize · ⌘Return finish · Escape cancel"** (`ContentView.swift:365`). Selecting another tool first commits the draft; if the commit fails the tool does not change (`Document/EditorSession.swift:396`) | 3.1 |
| "Font picker" | `NSPopUpButton` (capsule, **210 pt** wide, title truncated at the tail, one line) listing `NSFontManager.shared.availableFonts` (**PostScript names**; 528 on this Mac) **sorted** by plain string order, each item's title drawn **in its own face** at `NSFont.systemFontSize` (13 pt); a face that cannot draw every letter of its own name (symbol and non-Latin faces; 127 here) keeps the menu font. A current name that is not installed is appended before sorting. Help **"Font face, including bold and italic variants"**, accessibility label "Font" | 5.2 |
| "Font live preview" | Highlighting an item in the open menu (pointer or arrow keys) renders the draft with that face on the selected letters; closing without choosing puts the text back; choosing keeps what is shown without a flash. Only an open draft previews; a merely selected text layer is not opened for it | 5.2 |
| "Font per selection" | The chosen face applies to the selected letters; with only a caret it applies to **all** text (runs cleared). The popup shows the face of the letter before the caret, or the single face of the selection, or a non-font item **"(Multiple)"** inserted at the top when the selection spans several faces | 7.3, 5.2 |
| "Size" | Field placeholder "Size", 52 pt, `.number` format, unit **"px"** after it is the scrub handle (1 px per point, snaps to whole numbers, clamped 1...2000). While the field has focus ↑/↓ step ±1, ⇧ ±10, clamped 1...2000. A typed value outside 1...2000 is ignored. Default 72 | 5.3 |
| "Text color swatch" | 36 × 18 rounded rectangle (radius 3) filled with `typeColor`, 1 pt black 50 % border, help/label **"Text color"**. `typeColor` = while editing: the first selected letter's color, or with a caret the letter before it (letter 0 at the start); not editing: the **foreground** color. Click opens the color picker titled **"Color Picker (Text Color)"** | 6 |
| "Alignment buttons" | Three 30 × 26 icon buttons, 2 pt apart, SF `text.alignleft/center/right`, help and label "Align left/center/right"; the current one has a 14 % white rounded (4 pt) background. Default Left. Applies to the whole text | 5.3 |
| "Tracking" | Label **"Tracking"** is a scrub (1/pt, step 1, −100...1000) then a 45 pt field (placeholder "Tracking"), ↑/↓ ±1/±10 **without clamping** (out-of-range steps are ignored). Default 0. Units: points added after **every** character (the `.kern` attribute), in layer pixels | 2.4, 5.3 |
| "Leading" | Label **"Leading"** scrub (step 1, 0...5000) then a 52 pt field with prompt **"Auto"**, showing `Int(leading.rounded())` or empty when 0; applies on every keystroke; non-numeric = 0 = Auto; clamped 0...5000; ↑/↓ step from the effective line height (Auto → 120 % of size). Help **"Line height, baseline to baseline. Empty or 0 is Auto: 120% of the font size."** | 5.3 |
| "Cancel / Done buttons" | While a draft is open the header ends with **Cancel** (discard) and **Done** (commit) | 5.4 |
| "Edit Text button" | When no draft is open: **"Edit Text"**, opens the active layer's live text with the caret at the end; disabled unless the active layer is live text | 3.5 |
| "Style changes on selected text layer" | Any header change (font, size, alignment, tracking, leading) with a live text layer selected but not open **opens it** (tool stays Type) and applies the change to the draft; with no live text it changes the defaults for the next text. The color swatch is the exception: not editing, it changes the foreground/default color and never touches the selected layer | 5.5, 6 |
| "Click for point text" | A click (drag under 4 px both ways) on empty canvas starts point text whose **first baseline sits on the pointer** and whose first letter starts at it: `origin = (x − 12, y − (12 + lineHeight − abs(descender)))`. The layer grows with what is typed | 3.3 |
| "Drag for paragraph box" | Dragging draws a 1 pt accent rectangle; release starts box text exactly in that rectangle, `boxSize` = rounded size (min 16 each side); a box over the limits alerts "That text box exceeds the 30,000-pixel or 200-megapixel limit." | 3.4 |
| "Click existing text" | Press over the topmost **visible live** text layer whose box contains the point: commit any draft, select that layer, open it, and pass the press to the text view, which places the caret at the click and drag-selects | 3.5 |
| "Esc during box drag" | ⎋ while the box is being dragged drops the box draft (no text starts) | 3.4 |
| "Header disabled" | The whole Type header is disabled with no document or while `showsBusy` | 5.1 |

### 1.2 Text › Model (`features.md:1294-1308`)

| Line | Exact behavior | Detail |
|---|---|---|
| "Live text layer" | Record keeps content, font, size, color, alignment, tracking, leading, optional box (plus runs). Displayed and composited as its raster like any pixel layer | 7.4, 2 |
| "Defaults" | `content "Text"`, `Helvetica`, 72 px, black, Left, tracking 0, leading 0 (Auto). After every successful commit `textDefaults = draft.style` with both run arrays cleared (font, size, color, alignment, tracking, leading carry over; content and box are replaced when the next text starts). Per open project, not persisted | 7.5, 3.7 |
| "New text color" | New text starts in the **foreground** color, unless the layer **mask** is the edit target, in which case it keeps the default's color | 3.3 |
| "Point vs paragraph text" | Point: no `boxSize`, size = measured text + padding, never wraps. Box: fixed `boxSize`, wraps by word, lines that do not fit are not drawn. Padding 12 px on all sides in both | 2.2 |
| "Per-letter color runs" | Selected letters can take another color; typing takes the color of the letter before (the first letter's when typing at 0) | 7.3 |
| "Per-letter font runs" | Same for faces | 7.3 |
| "Limits" | content ≤ 100,000 UTF-16 units (longer edits are refused in the editor); size 1...2000; tracking −100...1000; leading 0...5000; box sides 16...30,000 and area ≤ 200,000,000; runs sorted, non-overlapping, `length > 0`, ending inside the content; run font names 1...200 characters, no newline | 7.2 |
| "Layer naming" | New layer name = content's words joined by single spaces, first 40 characters, `"Text"` if empty. Undo "New Text Layer" | 7.5, 3.7 |
| "Empty new text discarded" | Committing a **new** text whose content is only whitespace/newlines succeeds and creates nothing (no undo step). Existing text emptied is committed as is | 3.7 |
| "Editing undo step" | Committing changes to an existing layer is one undo step **"Edit Text"**; committing an unchanged style (and transform) makes no step | 3.7 |
| "Rasterize on pixel edit" | Any edit that replaces the layer's pixels (paint, erase, heal, clone, smear, fill with a selection, clear, filters, destructive adjustments, resampling Image Size, merge, moving pixels) leaves plain pixels; `text` is dropped at the next save | 7.4 |
| "Transform keeps text editable" | Move, scale, rotate, flip, masks (incl. live masks), clipping, opacity, blend, effects, duplicate, copy/paste of layers, canvas size, crop, trim, resolution-only Image Size keep it live. Re-editing keeps the transformed upper-left corner, scale, rotation and flips | 7.4, 3.7 |
| "Fill recolors live text" | Fill with Foreground/Background on a live text layer, with **no selection** and the image (not mask) targeted: every letter takes the color (runs cleared), text stays live, undo **"Fill Text"**; if the text already is that single color nothing happens | 6.3 |
| "Text as clipping mask / blending" | The raster clips, masks and blends like any layer | 7.4 |
| "Saved in project" | `text` is written to the manifest only while live (`layer.liveText?.style`); on load the stored PNG is used as is (not re-rendered) | 7.1, 7.4 |

### 1.3 Text › Inline editor and Color (`features.md:1312-1326`)

| Line | Exact behavior | Detail |
|---|---|---|
| "On-canvas native text editing" | Multiline `NSTextView` over the canvas: selection, IME/marked text, clipboard, standard Cocoa key bindings; its glyphs are clear and the canvas draws the real pixels under it, so editing looks identical to the committed result at any zoom | 4 |
| "Translucent selection" | Selection highlight = `selectedTextBackgroundColor` at alpha ≤ 0.45, focused or not | 4.3 |
| "Local undo" | ⌘Z / ⇧⌘Z undo/redo typing since the box opened, on the text view's own `UndoManager`, separate from document history (which is unavailable while a draft is open) | 4.5 |
| "Paste as plain text" | Paste always drops formatting (`pasteAsPlainText`) | 4.4 |
| "Finish" | ⌘↩ (or ⌘ keypad Enter) commits; so do a press elsewhere with the Type tool, switching tools, switching layers, Done, closing/quitting | 3.6 |
| "Cancel" | ⎋ (in the text or on the canvas) discards the draft | 3.6 |
| "Option-Left/Right tracking" | ⌥← −1, ⌥→ +1, with ⇧ ±10; out-of-range results ignored | 4.4 |
| "Option-Up/Down leading" | ⌥↑ `leading = max(1, lineHeight − step)`, ⌥↓ `leading = lineHeight + step`, step 1 or 10 with ⇧; starting from Auto's value | 4.4 |
| "Box frame and handles" | Accent 1 pt frame with 8 white 6 pt square handles; a band reaching 10 screen points either side of every edge also grabs (capped at a third of the box); cursor: rotated resize arrows in the band, I-beam inside, the Type I-beam elsewhere on the canvas, arrow off the canvas | 4.6 |
| "Resize box" | Dragging a handle or edge resizes the **box** (text reflows, never scales), min 16 px, works on rotated boxes; pressing a handle on point text first turns it into a box of its current size | 4.6 |
| "Overflow marker" | Black "+" drawn in the bottom-right handle when not every glyph fits the box | 4.6 |
| "Flipped layers" | The text surface is mirrored like the layer; the frame and handles keep their logical order | 4.7 |
| "Pointer visible while typing" | The mouse pointer is not hidden while typing | 4.8 |
| "Foreground follows text" | While a draft is open with the Type tool, any change of the foreground color (swatch, swap, reset, picker OK) recolors the selected letters, or all text with only a caret; picking a Text color also sets the foreground | 6 |
| "Live color preview" | The picker's working color previews on the draft (both the Text-color picker and the foreground picker opened while typing); Cancel restores the colors the draft had | 6 |

### 1.4 Text › PSD import (`features.md:1330-1332`; also `:1649-1652`)

| Line | Exact behavior | Detail |
|---|---|---|
| "Editable horizontal text" | Photoshop `TySh` type layers become live text: first style's font, size × matrix scale, color, tracking, leading, alignment; uniform-scale rotation and vertical flip go to the layer transform; paragraph frames become boxes | 8 |
| "Vertical / unrepresentable text rasterized" | Vertical text, shear, uneven scale, unreadable data, empty/oversized content, or an unstorable box keep Photoshop's pixels, note **"Editable Photoshop text becomes pixels and can’t be retyped."** | 8 |
| "Conversion notes" | "Only the first text style was kept.", "The Photoshop text warp was omitted.", "Faux bold or faux italic was omitted.", "Full justification was imported as left alignment.", and for a missing font "The font “…” isn’t installed, so the text was drawn with the system font." | 8 |

### 1.5 Keyboard shortcuts › Text Editing (`features.md:1935-1943`)

All live in group "Text Editing" of the Keyboard Shortcuts editor and are remappable, but a remap must keep ⌘, ⌥ or ⌃
("Text-editing shortcuts need Command, Option, or Control so they do not replace normal typing.",
`UI/KeyboardShortcuts.swift:203-206`). They are translated by `ShortcutSettings.textEvent` inside the text view
(`UI/KeyboardShortcuts.swift:236-245`, `Rendering/InlineTextEditor.swift:42`).

| Line | Default | Action |
|---|---|---|
| "Finish editing text" | ⌘↩ (`ShortcutChord("\r", 1)`, `:135`) | `finishText()`; keypad Enter with ⌘ also commits (`Rendering/InlineTextEditor.swift:58`) |
| "Decrease tracking" | ⌥← | tracking −1 |
| "Decrease tracking by 10" | ⌥⇧← | tracking −10 |
| "Increase tracking" | ⌥→ | tracking +1 |
| "Increase tracking by 10" | ⌥⇧→ | tracking +10 |
| "Decrease leading" | ⌥↑ | `leading = max(1, lineHeight − 1)` |
| "Decrease leading by 10" | ⌥⇧↑ | `leading = max(1, lineHeight − 10)` |
| "Increase leading" | ⌥↓ | `leading = lineHeight + 1` |
| "Increase leading by 10" | ⌥⇧↓ | `leading = lineHeight + 10` |

### 1.6 Related lines in other groups

| Line | Behavior relevant to text |
|---|---|
| Move tool "Double-click live text" (`features.md:76`) | Double-click with the Move tool on the topmost visible live text under the pointer: commit any pending transform, select the layer, open it (caret at end). `editActiveText` sets `tool = .type`, so the rail switches to Type (`Rendering/EditorCanvas.swift:1854-1855, 2584-2597`, `Document/TypeTool.swift:266`) |
| Layers thumbnail tooltip / icon (`:454-455`) | Live text rows show a `textformat` icon instead of a pixel thumbnail, tooltip "Editable text layer", second line **"Text · Double-click to edit"** (`UI/NativeLayerList.swift:1002, 1047`) |
| Layers double-click thumbnail (`:457`) | Double-click on a live text row's thumbnail opens it for editing (caret at end); on the name it renames (`UI/NativeLayerList.swift:392-405`) |
| Layers panel grays out (`:428`) | While a draft is open the panel looks disabled and `canEditLayers` is false, so layer commands do nothing (`Document/EditorSession.swift:692-701`) |
| Image Size (`:1172`) | Resampling rasterizes live text |
| Color picker titles / Text target (`:1348, 1360`) | "Color Picker (Text Color)" from the Type bar swatch |
| Copy / Paste / Select All in a text field (`:1757`, `CompositorApp.swift:204-260`) | With the text view focused ⌘X/⌘C/⌘V/⌘A act on the text |
| Fill keys in a text field (`:1773-1774, 1861-1862`) | ⌥⌫ = delete word backward, ⌘⌫ = delete to line start while typing |
| Undo while typing (`:1840`) | Menu Undo/Redo forward to the text view's own undo while a draft is open |
| Canvas only (`:1466`) | Fullscreen/Canvas only is disabled while text is being typed |

---

## 2. How a text layer's pixels and bounds are produced

### 2.1 Attributes (`Document/TypeTool.swift:403-443`)

```swift
nonisolated static func textAttributes(_ style: LayerTextStyle) -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = style.alignment == .left ? .left : style.alignment == .center ? .center : .right
    let font = NSFont(name: style.fontName, size: style.fontSize) ?? NSFont.systemFont(ofSize: style.fontSize)
    // Leading is the line's whole height, so the lines close up (and eventually overlap) as it comes down,
    // exactly as Photoshop's does. Auto is 120% of the size.
    _ = font
    paragraph.minimumLineHeight = style.lineHeight
    paragraph.maximumLineHeight = style.lineHeight
    paragraph.lineBreakMode = .byWordWrapping
    return [.font: NSFont(name: style.fontName, size: style.fontSize) ?? NSFont.systemFont(ofSize: style.fontSize),
            .foregroundColor: NSColor(srgbRed: style.red, green: style.green, blue: style.blue, alpha: 1),
            .paragraphStyle: paragraph, .kern: style.tracking]
}
```

`attributedText(style)` applies these to the whole string, then each valid `fontRuns` entry overrides `.font` (same
size) and each valid `colorRuns` entry overrides `.foregroundColor` (`:432-443`). A run is used only if
`length > 0 && location >= 0 && location <= total - length` (`containsTextRun`, `:445-447`). `lineHeight = leading > 0
? leading : fontSize * 1.2` (`:16-19`).

### 2.2 Size of the raster (`textBoxSize`, `:418-429`)

```swift
static func textBoxSize(_ style: LayerTextStyle) -> CGSize {
    if let boxSize = style.boxSize { return boxSize }
    let string = attributedText(style)
    let padding = LayerTextStyle.padding
    let measured = string.boundingRect(with: CGSize(width: 100_000, height: 100_000),
                                       options: [.usesLineFragmentOrigin, .usesFontLeading])
    let line = ceil(style.lineHeight)
    return CGSize(width: max(16, ceil(measured.width + padding * 2 + style.fontSize * 0.1)),
                  height: max(16, ceil(max(measured.height, line) + padding * 2)))
}
```

- **Box text**: the PNG is exactly `boxSize` (whole pixels: the box is rounded when made or resized).
- **Point text**: `width = max(16, ceil(measuredWidth + 24 + 0.1·fontSize))`,
  `height = max(16, ceil(max(measuredHeight, ceil(lineHeight)) + 24))`. The extra `0.1·fontSize` plus the ceil slack
  is why the text container is a little wider than the widest line: left-aligned text has the slack on the right,
  centered text splits it, right-aligned text has it on the left **(measured, 2.5)**.
- `measuredHeight` is `lines × lineHeight`, and a trailing newline counts as one more line (the extra line fragment)
  **(measured)**. Empty content measures 14 px high, so the `ceil(lineHeight)` floor decides: Helvetica 72 → 32 × 111.

### 2.3 Drawing (`textImage`, `:449-471`)

```swift
static func textImage(_ style: LayerTextStyle) throws -> CGImage {
    guard style.isValid else { throw ProjectError.invalid }
    let string = attributedText(style)
    let padding = LayerTextStyle.padding
    let size = textBoxSize(style)
    let width = ceil(size.width), height = ceil(size.height)
    guard width.isFinite, height.isFinite, width >= 1, height >= 1,
          width <= DocumentLimits.maxSideExtent, height <= DocumentLimits.maxSideExtent, width * height <= DocumentLimits.maxSurfaceExtent else { throw ProjectError.tooLarge }
    let context = try BrushRaster.context(width: Int(width), height: Int(height), mask: false)
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
    let storage = NSTextStorage(attributedString: string)
    let layout = NSLayoutManager()
    let container = NSTextContainer(size: CGSize(width: max(1, width - 2 * padding), height: max(1, height - 2 * padding)))
    container.lineFragmentPadding = 0
    storage.addLayoutManager(layout)
    layout.addTextContainer(container)
    let glyphs = layout.glyphRange(for: container)
    layout.drawGlyphs(forGlyphRange: glyphs, at: CGPoint(x: padding, y: padding))
    guard let image = context.makeImage() else { throw ExportError.render }
    return image
}
```

- Pixel format: 8-bit **premultiplied** RGBA, sRGB, y-down (`Document/BrushStroke.swift:36-44`). Transparent
  background, antialiased glyphs in the text's sRGB colors. No background, stroke or shadow (layer effects are separate).
- Text container = image minus 12 px on each side; glyphs drawn at (12, 12). Only glyphs inside the container are laid
  out and drawn: box lines that do not fit are **absent** from the pixels. Nothing clips glyph ink inside the image,
  but the image edge does: a small leading pushes the first line's ascenders above y = 0, where they are cut off
  **(measured: leading 30 on Helvetica 72 has ink from row 0)**.
- Errors: invalid style → `ProjectError.invalid`; a side over 30,000 or area over 200 MP → `ProjectError.tooLarge`
  ("This project exceeds the supported canvas, layer, file-size, or N-megapixel document limit.",
  `IO/ProjectStore.swift:76`). While typing, the canvas then simply shows no text (`try?`,
  `Rendering/EditorCanvas.swift:33`); at commit the alert "Couldn’t paint" shows the message and the draft stays open
  (`Document/TypeTool.swift:318-320`, `ContentView.swift:297-300`).

### 2.4 Line metrics **(measured)**

Line fragments are exactly `lineHeight` tall and stacked from the container top. The baseline sits the line's
**rounded maximum descent** above the fragment bottom, so extra leading goes above the letters and too little leading
pushes them up out of the line:

| Case (Helvetica unless noted, 72 px) | Fragment height | Baseline in fragment | Baseline in image |
|---|---|---|---|
| Auto (86.4) | 86.4 | 69.4 (= 86.4 − 17; descender 16.559 rounds to 17) | 81.4, next line 167.8 |
| leading 30 | 30 | 13 | 25, 55 |
| leading 200 | 200 | 183 | 195, 395 |
| Times-Roman 48, Auto (57.6) | 57.6 | 45.6 (descender exactly 12) | 57.6 |
| "AB CD" with "CD" in Times-Bold | 86.4 | 68.4 (Times-Bold's larger descent wins) | 80.4 |
| "Aé日本語🙂" (falls back to PingFangSC-Regular and AppleColorEmoji) | 86.4 | 62.4 | 74.4 |
| missing font "NoSuchFont-Regular" (drawn in `.AppleSystemUIFont`) | 86.4 | 71.4 | 83.4 |

Consequences for the port: the baseline depends on every font actually used on the line (including automatic
fallback fonts), so **only the engine can say where lines and carets are**.

**Tracking and kerning.** `.kern = 0` means "kerning disabled" in TextKit; any non-zero value is added **on top of**
the font's pair kerning. So tracking 0 has no pair kerning, and tracking 1 re-enables it. Measured on "Text":
tracking 0 carets `0, 43.980, 84.023, 120.023, 140.027`; tracking 50 carets `0, 86.000, 176.043, 262.043, 332.047`
(the T-e pair contributes −7.98, and the last letter also gets +50, so the measured width includes trailing tracking).

### 2.5 Layout test vectors **(measured; container coordinates = image minus the 12 px padding)**

| Style | Image | Lines (`chars` → carets x) | Notes |
|---|---|---|---|
| "Text" default | 172 × 111 | 0+4 → 0, 43.980, 84.023, 120.023, 140.027 | container 148 × 87; ink x 12...150, y 29...83 |
| "" default | 32 × 111 | none; extra fragment (0, 0, 8, 86.4) | caret at (0, 0) h 86.4 |
| "Hello\nWorld" | 220 × 197 | 0+6 → 0, 51.996, 92.039, 108.035, 124.031, 164.074; 6+5 → 0, 67.957, 108.000, 131.977, 147.973, 188.016 | |
| "abc\n" | 148 × 197 | 0+4 → 0, 40.043, 80.086, 116.086; extra fragment (0, 86.4, 124, 86.4) | caret 4 at (0, 86.4) |
| "Hi\nWorld" Center | 220 × 197 | 0+3 → 64.004, 116.000, 131.996; 3+5 → 3.992 … 192.008 | slack split |
| "Hi\nWorld" Right | 220 × 197 | 0+3 → 128.008, 180.004, 196.000; 3+5 → 7.984 … 196.000 | |
| "The quick brown fox jumps over the lazy dog", box 400 × 300 | 400 × 300 | 0+10 (…332.156), 10+10, 20+11 (…372.129); chars 31...42 not laid out | overflow: 31 of 43 laid out |
| same, box 400 × 120 | 400 × 120 | 0+10 only | overflow |
| "Aé日本語🙂" | 408 × 111 | 0+7 → indexes 0,1,2,3,4,5,7 (no stop inside the surrogate pair) | fonts Helvetica / PingFangSC-Regular / AppleColorEmoji |

---

## 3. Type tool interaction

### 3.1 Selecting the tool

`T` (also with ⇧, through the Shift+letter rule) → `selectTool(.type)`. Any tool change first runs `finishText()`; if
it returns false (commit failed) the change is refused; then pending transform/crop/gradient/lasso/shape are resolved
(`Document/EditorSession.swift:395-399`). Leaving the Type tool also drops a box being dragged
(`Rendering/EditorCanvas.swift:562`). Tab (cycle tool mode) is ignored while a draft is open (`:2276`).

### 3.2 Press dispatch (`beginTextGesture`, `Rendering/InlineTextEditor.swift:516-530`)

```swift
func beginTextGesture(at point: CGPoint, event: NSEvent) {
    guard let document = session.document, session.finishText() else { return }
    let pixel = session.viewport.documentPoint(from: point, documentSize: document.size)
    let visible = document.effectiveVisibleIDs
    if let layer = document.layers.reversed().first(where: { visible.contains($0.id) && $0.liveText != nil && $0.transform.contains(pixel) }) {
        session.selectLayer(layer.id)
        session.editActiveText()
        synchronizeInlineText()
        inlineTextEditor?.textView.mouseDown(with: event)
    } else {
        textBoxAnchor = pixel
        textBoxRect = CGRect(origin: pixel, size: .zero)
    }
    needsDisplay = true
}
```

1. A press that reaches the canvas (i.e. not inside the open editor's text area or edge band) **commits** the current
   draft first. If that fails nothing else happens.
2. Topmost (last in `layers`) effectively visible live-text layer whose rotated box contains the press (flips do not
   matter: `contains` is symmetric) → open it, caret at the press (3.5).
3. Otherwise a box drag starts at the unrounded press point.

So a click outside the box both commits and starts a new text at the click (an empty new draft is discarded silently
by the next commit).

### 3.3 Point text (`finishTextGesture`, `:539-546`; `beginText(at:newLayer:)`, `Document/TypeTool.swift:235-262`)

Release with the dragged rect under 4 px both ways → `beginText(at: rect.origin, newLayer: true)`:

```swift
var style = target?.liveText?.style ?? textDefaults
if target == nil {
    style.content = ""
    style.colorRuns = nil
    style.fontRuns = nil
    // New text starts in the foreground color, the same as every other tool that lays down color.
    if !isMaskSelected {
        style.red = foregroundColor.red; style.green = foregroundColor.green; style.blue = foregroundColor.blue
    }
    style.boxSize = nil
}
tool = .type
let descent = abs((Self.textAttributes(style)[.font] as? NSFont)?.descender ?? 0)
let baseline = LayerTextStyle.padding + style.lineHeight - descent
let origin = target?.origin ?? CGPoint(x: point.x - LayerTextStyle.padding, y: point.y - baseline)
textDraft = TextDraft(documentID: document.id, layerID: target?.id, origin: origin, transform: target?.transform, style: style)
```

- `rect.origin` is the min corner of `DragBox.rect(anchor, pointer)`, which rounds the **moving** point but not the
  anchor (`Document/Selection.swift:93-104`): for a pure click at (100.3, 200.7) the origin is (100.0, 200.7).
- The origin is **not** rounded: the new layer may sit at fractional coordinates. Test vector: default style, click
  (100, 200) → origin (88, 118.159) **(measured)**; upstream asserts the same formula (`CompositorTests/TypeToolTests.swift:22-29`).
- Because TextKit rounds the descent (2.4) while this formula uses the exact descender, the first baseline lands
  0.441 px above the pointer for Helvetica 72 (81.4 vs 81.841).
- The draft starts empty with the caret at 0; nothing is added to the document until commit.

### 3.4 Box text (`dragTextGesture`, `drawTextBoxDraft`, `beginText(in:)`)

- While dragging: `textBoxRect = DragBox.rect(from: anchor, to: pixel, square: false, fromCenter: false)`; no
  snapping, no ⇧/⌥ modifiers (`Rendering/InlineTextEditor.swift:532-537`). Drawn by the lines overlay as a 1 pt
  `controlAccentColor` rectangle (`:548-556`, `Rendering/EditorCanvas.swift:1404-1415`).
- ⎋ during the drag clears the box and starts nothing (`Rendering/EditorCanvas.swift:2204`).
- Release with either side ≥ 4 px → `beginText(in: rect)` (`Document/TypeTool.swift:332-341`):
  `boxSize = (max(16, round(w)), max(16, round(h)))`; if `!boxIsValid` → alert
  "That text box exceeds the 30,000-pixel or 200-megapixel limit." and nothing starts; otherwise a new draft as in
  3.3 whose `origin = rect.origin` (unrounded) and `boxSize` set. Text starts at the box's top-left + 12 px.

### 3.5 Opening existing text

| Entry | What happens |
|---|---|
| Type tool press on live text (3.2) | `selectLayer`, `editActiveText`, then the press goes to `NSTextView.mouseDown`: caret at the nearest insertion point, drag extends the selection, double-click selects a word, triple-click a paragraph |
| Edit Text button, Layers thumbnail double-click, Move tool double-click | `editActiveText` only: the caret goes to the **end** of the text ("Opening existing text puts the cursor after it, ready to add to it, unless a click already placed it", `Rendering/InlineTextEditor.swift:220-223`) |
| A header change with a live text layer selected | `changeTextStyle` calls `editActiveText` first (5.5) |

`editActiveText` (`Document/TypeTool.swift:264-268`) requires `canEditLayers`, no open draft, and an active live text
layer; it sets `tool = .type` and makes `TextDraft(layerID: layer.id, origin: layer.origin, transform: layer.transform,
style: text.style)`.

The draft is rendered with the fonts installed **now**: a layer whose font is missing changes look (system font) as
soon as it is opened, while the stored PNG kept the original look until then (`docs/project-format.md:48`).

### 3.6 Finishing and cancelling

| Trigger | Result | Ref |
|---|---|---|
| ⌘↩ / ⌘ keypad Enter in the text | `finishText()` | `Rendering/InlineTextEditor.swift:58-61` |
| Done | `finishText()` | `UI/TypeControls.swift:92` |
| Press on the canvas outside the editor with Type | `finishText()`, then the new gesture | `:517` |
| Tool change, layer selection change (single or multi) | `finishText()`; refused if it fails | `Document/EditorSession.swift:389, 396`, `Document/LayerGroups.swift:146` |
| Closing the window / quitting | `finishText()` for every tab with a draft | `Document/ProjectWorkspace.swift:125-130` |
| ⎋ in the text, or on the canvas with a draft | `cancelText()` | `Rendering/InlineTextEditor.swift:43`, `Rendering/EditorCanvas.swift:2205` |
| Cancel | `cancelText()` | `UI/TypeControls.swift:91` |

`cancelText()` sets `textDraft = nil` and returns focus to the canvas (`Document/TypeTool.swift:330`). The layer was
never modified during the draft, so nothing needs restoring. After a commit focus also returns to the canvas
(`canvasFocusRequest += 1`, `:316`).

### 3.7 Commit (`applyText`, `Document/TypeTool.swift:270-322`)

```swift
@discardableResult
func applyText(_ draft: TextDraft) -> Bool {
    guard document?.id == draft.documentID, draft.style.isValid else { return false }
    let pending = textDraft
    textDraft = nil
    guard canEditLayers else { textDraft = pending; return false }
    var succeeded = false
    defer { if !succeeded { textDraft = pending } }
    if draft.layerID == nil, draft.style.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        succeeded = true
        return true
    }
    do {
        let image = try Self.textImage(draft.style)
        let text = LayerText(style: draft.style, image: image)
        if let id = draft.layerID {
            guard let index = document?.layers.firstIndex(where: { $0.id == id }),
                  let layer = document?.layers[index], layer.liveText != nil, let asset = layer.asset else { return false }
            if layer.liveText?.style == draft.style && (draft.transform == nil || draft.transform == layer.transform) { succeeded = true; return true }
            let thumbnail = try PixelInvert.thumbnail(of: image)
            var transform = draft.transform ?? layer.transform
            // Keep the transformed upper-left corner and the user's scale, rotation and flips.
            let anchor = transform.point(.zero)
            if draft.transform == nil || draft.style.boxSize == nil {
                transform.size = CGSize(width: CGFloat(image.width) * transform.size.width / CGFloat(asset.image.width),
                                        height: CGFloat(image.height) * transform.size.height / CGFloat(asset.image.height))
                let moved = transform.point(.zero)
                transform.origin.x += anchor.x - moved.x
                transform.origin.y += anchor.y - moved.y
            }
            guard transform.isValid else { throw ProjectError.tooLarge }
            beginEdit("Edit Text")
            if layer.mask?.placement == nil { document?.layers[index].mask?.placement = layer.maskTransform }
            document?.layers[index].asset = ImportedImage(image: image, thumbnail: thumbnail, name: asset.name)
            document?.layers[index].text = text
            document?.layers[index].transform = transform
            endEdit()
        } else {
            addPixelLayer(image, at: draft.origin, name: Self.layerName(for: draft.style.content), editName: "New Text Layer",
                          dropsSelection: false, text: text)
        }
        succeeded = true
        textDefaults = draft.style
        textDefaults.colorRuns = nil
        textDefaults.fontRuns = nil
        textDraft = nil
        canvasFocusRequest += 1
        return true
    } catch {
        brushError = error.localizedDescription
        return false
    }
}
```

- **New**: `addPixelLayer` (`Document/SelectionClipboard.swift:296-311`) inserts the layer directly above the active
  layer (inside the active folder when the active row is a folder, otherwise in the active layer's folder; at the top
  when nothing is active), `transform = (origin, image size)`, no rotation; the selection is kept; the new layer
  becomes active; one undo step "New Text Layer".
- **Existing**: the per-axis scale the layer had (`transform.size / asset size`) is applied to the new image size for
  point text (and for box text opened without a transform change); the transformed top-left `point(.zero)` stays put,
  so a rotated layer does not swing; rotation and flips are kept. A box whose handles were dragged keeps the dragged
  transform. A mask that was following the layer's pixel grid (`placement == nil`) is pinned where it is
  (`maskTransform`) so the new raster size does not stretch it. One undo step "Edit Text".
- No change (same style and same transform) → success with no undo step.
- Upstream test: create, edit, cancel, undo, redo (`CompositorTests/TypeToolTests.swift:19-52`); box + tool switch
  commit, then cancel leaves it (`:168-183`); empty box discarded (`:185-192`); NaN size, zero box, stale document all
  refused (`:297-312`).

### 3.8 What a draft blocks

`textDraft != nil` makes `canEditLayers`, `canUseHistory` and `canStartProjectOperation` false
(`Document/EditorSession.swift:153, 652, 700`): layer commands, document undo/redo, Save-type project operations, crop,
trim and filters wait or are disabled; the Layers panel looks disabled (`:692-697`); external changes to the project
on disk are deferred until the draft closes (`IO/ProjectController+ExternalChanges.swift:49`). Canvas-only/fullscreen
is unavailable (`:321-325`). Zoom and pan keep working.

---

## 4. The inline editor

### 4.1 What is displayed

- **Pixels**: the canvas draws `EditorSession.textImage(draft.style)` (cached per style) at the editor's shown
  transform (`Rendering/EditorCanvas.swift:29-37`).
  - Existing layer: drawn **in its own place in the stack**, with its opacity, blend mode and clipping, re-rendered
    effects, but **without its layer mask** (`mask: nil`, `:997-1003, 1213-1232`).
  - New text: drawn just above the active layer, or on top when the active layer is not drawn, at full opacity,
    Normal blend (`:1166-1172, 3174-3231`).
- **Text view**: same string and attributes but `foregroundColor = .clear` (`Rendering/InlineTextEditor.swift:193-200`),
  so only its caret, selection highlight and marked text are visible. Its frame is the box inset by 12 px; its
  bounds are layer pixels and the containing view supplies zoom, rotation and flips.
- Upstream test: the canvas changes by at most 2 levels per channel when a draft is committed
  (`CompositorTests/TypeToolTests.swift:340-349`).

### 4.2 The shown transform (`synchronize`, `Rendering/InlineTextEditor.swift:133-186`)

```swift
if let boxSize = style.boxSize { logicalSize = boxSize }
else { logicalSize = EditorSession.textBoxSize(style) }          // remeasured when the style changes
var transform = draft.transform ?? LayerTransform(origin: draft.origin, size: logicalSize)
if style.boxSize == nil, draft.transform != nil, let asset = layer?.asset, asset.image.width > 0 {
    let factor = transform.size.width / CGFloat(asset.image.width)
    let anchor = transform.point(.zero)
    transform.size = CGSize(width: logicalSize.width * factor, height: logicalSize.height * factor)
    let moved = transform.point(.zero)
    transform.origin.x += anchor.x - moved.x
    transform.origin.y += anchor.y - moved.y
}
shownTransform = transform
```

Point text grows from its transformed top-left corner as it is typed (also for Right/Center alignment). While typing,
a non-uniformly scaled layer is shown with the **width** factor on both axes; the commit (3.7) uses per-axis factors,
so such a layer changes shape when committed (quirk, section 13).

### 4.3 Caret, selection and hit testing **(measured with an `NSTextView` configured as the editor's)**

All coordinates below are the text container's (image minus 12 px padding), y down.

- **Caret**: zero-width rect at the insertion point's x, top and height of the **line fragment**
  (`rectArray(forCharacterRange: (i, 0), …)`): "Hello\nWorld" caret 3 → (108.035, 0, h 86.4); caret 6 → (0, 86.4);
  caret 11 → (188.016, 86.4). After a trailing newline (and for empty text) the caret sits on the extra line
  fragment: "abc\n" caret 4 → (0, 86.4, h 86.4). Leading 30 → caret height 30. The caret is drawn by the text view in
  its own coordinate space (1 unit = 1 layer pixel), so it scales with zoom (inferred), and in the color of the letter
  before it (`updateInsertionPointColor`, `:271-275`: `style.color(at: location > 0 ? location - 1 : 0)`).
- **Selection rectangles**, one per line fragment the range touches: left = the start caret's x if the range starts on
  that line, else the fragment's left (0); right = the end caret's x if the range ends on that line, else the
  fragment's right edge (the container width). Heights are the fragment's. Vectors: "Hello\nWorld" 1+3 →
  (51.996, 0, 72.035, 86.4); 2+6 → (92.039, 0, 103.961, 86.4), (0, 86.4, 108.000, 86.4); 5+1 (just the newline) →
  (164.074, 0, 31.926, 86.4); 0+11 → (0, 0, 196, 86.4), (0, 86.4, 188.016, 86.4); centered "Hi\nWorld" 0+8 →
  (64.004, 0, 131.996, 86.4), (0, 86.4, 192.008, 86.4); wrapped 5+10 → (184.113, 0, 191.887, 86.4),
  (0, 86.4, 196.102, 86.4).
- Highlight color `NSColor.selectedTextBackgroundColor` with alpha `min(alpha, 0.45)`, also when the text view is not
  focused (`:7-14, 115-117`); it is drawn over the canvas text.
- **Hit testing** (`characterIndexForInsertion(at:)`): within a line fragment's height, the nearest insertion point on
  that line; x left of the line → line start; x right of it → the line's last insertion point (before a hard newline,
  after the trailing space of a soft-wrapped line); below the last **laid-out** line (inside the container) → the end
  of the laid-out text (31 in the overflowing box above, not 43); **above the first line (y < 0) → end of text**.
  Vectors on "Hello\nWorld" (196 × 173): (30, 40) → 1; (25.9, 40) → 0; (26, 40) → 1; (300, 40) → 5; (−50, 100) → 6;
  (100, 170) → 8; (100, 172.9) → 11; (100, −20) → 11. Wrapped box: (370, 40) → 10.
- **Soft-wrap boundary**: index 10 in the wrapped vector is both the end of line 0 and the start of line 1;
  `rectArray` places it at the end of line 0 (332.156, 0). `NSTextView` chooses with its selection affinity: upstream
  after a click to the right of the upper line, downstream after typing or arrowing (standard Cocoa behavior,
  unverified here).
- **Word and paragraph** (`NSAttributedString.doubleClick(at:)`, `NSString.paragraphRange`) on
  "one two\nthree-four five's": 1 → {0,3}; 3 (space) → {3,1}; 9 → {8,5} "three"; 13 "-" → {13,1}; 14 → {14,4};
  20 → {19,6} "five's"; paragraph of 9 → {8,17}; of 2 → {0,8} (includes the "\n").

### 4.4 Keys inside the text (`CanvasTextView.keyDown`, `:41-66`)

| Keys | Action |
|---|---|
| ⎋ | `cancelText()` |
| ⌥← / ⌥→ (⇧ = ×10) | `tracking ∓= step` via `changeTextStyle` (no clamp; invalid ignored) |
| ⌥↑ / ⌥↓ (⇧ = ×10) | `leading = max(1, lineHeight − step)` / `leading = lineHeight + step` |
| ⌘↩, ⌘ keypad Enter | `finishText()` |
| ⌘Z / ⇧⌘Z | the text view's own undo/redo (4.5); the app menu forwards to it too (`CompositorApp.swift:26-41`) |
| ⌘X / ⌘C / ⌘V / ⌘A | cut, copy, **plain-text** paste (`paste(_:)` → `pasteAsPlainText`, `:68`), select all |
| ⌥⌫ / ⌘⌫ | delete word backward / delete to line start (menu Fill items forward these, `CompositorApp.swift:236-249`) |
| everything else | standard `NSTextView` behavior: ↩ inserts a newline, Tab inserts a tab, ←/→ by composed character, ↑/↓ by visual line, ⌘←/⌘→ visual line ends, ⌘↑/⌘↓ text ends, ⇧ extends, ⌃A/⌃E/⌃K/⌃F/⌃B/⌃N/⌃P emacs bindings, ⌃⌘Space emoji |

Not available because of the overrides: ⌥-arrow word and paragraph moves, ⌥⇧-arrow word selection. Text-view
settings: rich text off, graphics off, smart quotes off, smart dashes off (`:103-114`); length limited to 100,000
UTF-16 units by refusing the change (`:245-247`). The pointer is un-hidden after every key (`:64-65`, 4.8).

### 4.5 Local undo

`CanvasTextView` owns an `UndoManager` (`:18-25`), cleared when a fresh draft opens (`:214-215`). Typing is coalesced
the Cocoa way (a run of typing is one step; moving the caret, switching between typing and deleting, paste and cut
start new steps). Header style changes are **not** on this stack. The document's Undo is unavailable while a draft is
open (`Document/EditorSession.swift:650-653`), and the Edit menu shows plain "Undo"/"Redo" that go to the text view.

### 4.6 Frame, handles, cursors, resize, overflow (`:374-491`)

- Frame: `controlAccentColor`, line width `handleSize / 6`, inset `handleSize / 12`, where
  `handleSize = max(2, 6 / max(0.01, zoomScale · transform.size.width / logicalSize.width))` in layer pixels, i.e.
  1 pt line and 6 pt handles on screen.
- Handles at `LayerTransform.handles` order: TL, T, TR, R, BR, B, BL, L (`Document/LayerTransform.swift:96-98`):
  white fill, accent stroke of **1 layer pixel** (default `NSBezierPath` width, so it thickens with zoom).
- Grab test (`handle(at:)`): `reach = min(handleSize · 10/6, min(boxW, boxH) / 3)` (10 screen points, capped); a point
  within `reach` outside or inside an edge counts; corners win over edges. Outside the band: the text area (I-beam). A
  press inside the box padding but outside both the band and the text view's frame does nothing.
- Cursor: in the band, the frame-resize cursor for that edge rotated with the box in 45° steps
  (`handleCursor`, `:374-381`); inside, I-beam; elsewhere on the canvas, the Type I-beam; leaving the canvas, the arrow.
  While a color picker is open the editor ignores the mouse so the canvas can be sampled (`:333, 410`).
- **Resize** (`mouseDown/Dragged/Up`, `:443-491`): pressing a handle on **point** text turns it into a box of its
  current measured size right away (even without dragging). Dragging moves only the grabbed edges, measured in the
  box's rotated frame:

  ```swift
  let localX = dx * cos(old.radians) + dy * sin(old.radians)
  let localY = -dx * sin(old.radians) + dy * cos(old.radians)
  let unit = LayerTransform.handles[resize.handle]
  var left: CGFloat = 0, top: CGFloat = 0, right = old.size.width, bottom = old.size.height
  let source = resize.draft.style.boxSize ?? logicalSize
  let minW = 16 * old.size.width / source.width, minH = 16 * old.size.height / source.height
  if unit.x == 0 { left = min(localX, right - minW) }
  if unit.x == 1 { right = max(left + minW, right + localX) }
  if unit.y == 0 { top = min(localY, bottom - minH) }
  if unit.y == 1 { bottom = max(top + minH, bottom + localY) }
  draft.style.boxSize = CGSize(width: ((right - left) * source.width / old.size.width).rounded(),
                               height: ((bottom - top) * source.height / old.size.height).rounded())
  ```

  then the transform's size follows the box at the layer's scale and the opposite corner stays fixed
  (`anchor = old.point(left/w, top/h)`). Invalid boxes or transforms are ignored. Release returns focus to the text.
  The resize is part of the draft (no undo step of its own).
- **Overflow marker** (`:426-441`): when `glyphRange(for: container)` ends before the last glyph, a black "+" (arms
  `0.42 · handleSize`, line width `handleSize / 6`) is drawn centered in the bottom-right handle.

### 4.7 Rotation and flips

The editor view takes the layer's rotation as its frame rotation, keeps the transformed top-left pinned
(`:165-176`), and mirrors only the text surface for `flipX`/`flipY` about its middle (`applyMirror`, `:278-309`). The
frame and handles stay in logical (unflipped) order, so handle 0 is always the box's own top-left. Caret, selection and
clicks follow the mirrored text.

### 4.8 IME, substitutions, pointer

Marked text (input methods) is handled by `NSTextView`; while marked text exists the editor does not reset attributes
(`:195`), and the draft content (and so the rendered pixels) includes the composition. The pointer is kept visible
while typing (`NSCursor.setHiddenUntilMouseMoves(false)` after every key, `:64-65, 67`).

---

## 5. Header (options bar)

### 5.1 Layout (`UI/TypeControls.swift:16-100`)

`HStack(spacing: 12)`: **"Type"** (13 pt semibold), then a horizontally scrolling `HStack(spacing: 10)` without
indicators holding, in order: font popup, Size field + "px", color swatch, three alignment buttons, "Tracking" label
+ field, "Leading" label + field; then **Cancel** + **Done** while a draft is open, otherwise **Edit Text**. Rounded
text fields, 18 pt side padding, bar height 42, 12 pt control font (`UI/ToolHeaderStyle.swift:3-8, 38-43`). Disabled
when `document == nil || showsBusy`. Every field reads `currentTextStyle` = draft style ?? active live text style ??
`textDefaults` (`Document/TypeTool.swift:361`) and writes through `changeTextStyle` (5.5).

### 5.2 Font popup (`:21-39, 103-249`)

- Closed: shows the current name, or "(Multiple)". Title source: with a draft, a caret → `fontName(at: max(0, loc − 1))`;
  a selection → `uniformFontName(in:)` or "" (→ "(Multiple)"); without a draft → `currentTextStyle.fontName`.
- Opened: items built once per control on first open (`menuNeedsUpdate`): every installed face, sorted, each with its
  styled title (built in the background when the bar first appears; "about half a second" for all faces).
- Hover/keyboard highlight → `previewFont(name)`: the first preview remembers the draft's style; each preview applies
  `setFont(name, in: draft.selection)` to that remembered style (`Document/TypeTool.swift:363-381`). Choosing →
  `keepFontPreview()` then sets the font (same result, no flash). Closing without a choice → `endFontPreview()` puts
  the remembered style back (deferred one run loop turn so a late choice wins). Highlighting "(Multiple)" or nothing
  leaves the last preview showing.
- Choosing "(Multiple)" or the current name does nothing. Choosing a face → `changeTextStyle { $0.setFont(name, in:
  selection) }`.
- When focus leaves the text for the popup with letters selected, the selection is remembered (`holdsSelection`,
  `Rendering/InlineTextEditor.swift:19-36, 258-270`) so the face applies to those letters.

### 5.3 Size, color, alignment, tracking, leading

| Control | Exact behavior |
|---|---|
| Size | `TextField("Size", value: fontSize, format: .number)` 52 pt; commit on ↩ or focus loss; out-of-range ignored. "px" scrub: `start + dragX · 1`, rounded to 1, clamped 1...2000. ↑/↓ while focused: `min(2000, max(1, v ± step))`, step 1 or 10 with ⇧ (`ContentView.swift:410-436`) |
| Color | see 6 |
| Alignment | `changeTextStyle { $0.alignment = … }` |
| Tracking | label scrub `start + dragX`, step 1, −100...1000; field `value: tracking` 45 pt (commit on ↩/focus loss, out-of-range ignored); ↑/↓ `tracking ± step` unclamped (invalid ignored) |
| Leading | label scrub on the **stored** `leading` (0 when Auto), step 1, 0...5000; field (text binding, applies every keystroke): `Double(trimmed) ?? 0`, clamped 0...5000, displays `""` for 0 else `String(Int(leading.rounded()))`; ↑/↓ start from `lineHeight`: `leading = max(0, lineHeight ± step)` (Auto 72 px + ↑ → 87.4, displayed "87"); ↑ **opens** the lines here while ⌥↑ in the text closes them |

### 5.4 Buttons

Cancel → `cancelText()`; Done → `finishText()`; Edit Text → `editActiveText()`, disabled unless `activeLayer?.liveText != nil`.

### 5.5 `changeTextStyle` (`Document/TypeTool.swift:383-394`)

```swift
func changeTextStyle(_ change: (inout LayerTextStyle) -> Void) {
    if textDraft == nil, activeLayer?.liveText != nil { editActiveText() }
    if var draft = textDraft {
        change(&draft.style)
        guard draft.style.isValid else { return }
        textDraft = draft
    } else {
        var style = textDefaults
        change(&style)
        if style.isValid { textDefaults = style }
    }
}
```

A font change on a merely selected layer opens it with `selection = (0, 0)`, so it changes the **whole** text. An
invalid result (size 0, tracking 2000, …) is dropped silently.

---

## 6. Color

### 6.1 Foreground follows text (`Document/ColorPalette.swift:30-56`)

`setPaletteColor(color, background: false)` with the Type tool and a draft open also runs
`setDraftTextColor(color)` = `changeTextStyle { $0.setColor(color, in: draft.selection) }`. That covers the rail
swatch's picker OK, Swap (X) and Default colors (D) buttons. With only a caret the **whole** text is recolored and its
runs dropped (not "the next letters typed"). The background color never touches text. A selected but closed text
layer never follows.

### 6.2 Pickers

| Opened from | Original color | Preview while open | OK | Cancel |
|---|---|---|---|---|
| Type bar swatch, draft open (`openTextColorPicker`, `:77-82`) | `typeColor` | working color on the selected letters (or all) via `previewTextColor` (`:158-169`, wired at `UI/TypeControls.swift:99`) | `setDraftTextColor`, and foreground = color (unless the mask is selected) | `restoreDraftTextColors`: base color back, runs back if the content is unchanged else none (`:88-94`) |
| Type bar swatch, no draft | foreground | none | `textDefaults` color and foreground = color; the selected layer is untouched | nothing |
| Rail foreground swatch, Type tool with a draft (`openColorPicker`, `:58-66`) | foreground | same preview on the draft | `setPaletteColor` → foreground and draft recolor | restore as above |

The Type bar picker requires the Type tool (`tool == .type`) and no other picker open. Closing any picker returns
keyboard focus to the open draft (`:137-138`). Upstream test: preview, cancel restores, OK sets both
(`CompositorTests/TypeToolTests.swift:54-76`).

### 6.3 Fill Text (`Document/SelectionEdits.swift:53-62`, `Document/TypeTool.swift:343-359`)

```swift
if !isMaskSelected, selection == nil, layer.liveText != nil, recolorText(layer.id, to: value) { return }
```

`recolorText`: if the style is already that single color with no runs, return true (nothing happens, no undo step);
else `setColor(color, in: (0, 0))`, re-render, `finishOpacityEdit()`, one undo step **"Fill Text"**. If the re-render
fails it returns false and the normal pixel fill runs (rasterizing). With a selection, Fill paints pixels and the text
stops being live.

---

## 7. The text layer data model (manifest)

### 7.1 Record

A text layer record is a normal pixel layer record (`imageFile` required, not a folder, no `adjustment`) plus `text`
(`IO/ProjectStore.swift:226-232`; `manifest.md` 7.3). Synthesized `Codable`, keys sorted on save, nil optionals
omitted, `boxSize` as `[w, h]`.

```json
{
  "id" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
  "imageFile" : "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png",
  "isGroup" : false,
  "isVisible" : true,
  "name" : "Hello world",
  "opacity" : 1,
  "blendMode" : "Normal",
  "text" : {
    "alignment" : "Left",
    "blue" : 0,
    "boxSize" : [400, 300],
    "colorRuns" : [ { "blue" : 0, "green" : 0, "length" : 5, "location" : 6, "red" : 1 } ],
    "content" : "Hello world",
    "fontName" : "Helvetica",
    "fontRuns" : [ { "fontName" : "Courier", "length" : 2, "location" : 0 } ],
    "fontSize" : 72,
    "green" : 0,
    "leading" : 0,
    "red" : 0,
    "tracking" : 0
  },
  "transform" : { "flipX" : false, "flipY" : false, "origin" : [88, 118.159], "rotation" : 0,
                  "sampling" : "High quality", "size" : [400, 300] }
}
```

(Illustrative values; key order and number formatting as `manifest.md` 8.1. The fractional origin is normal for
text: 3.3.)

| Key | Type | Required | Meaning |
|---|---|---|---|
| `content` | string | yes | UTF-16 ≤ 100,000; `\n` separates paragraphs |
| `fontName` | string | yes | PostScript name of the base face; may name a face that is not installed (drawn with the system font) |
| `fontSize` | number | yes | px, 1...2000 |
| `red`, `green`, `blue` | number | yes | base sRGB color 0...1 |
| `alignment` | `"Left"` / `"Center"` / `"Right"` | yes | whole text |
| `tracking` | number | yes | px added after every character, −100...1000; 0 also disables pair kerning |
| `leading` | number | yes | baseline-to-baseline px, 0 = Auto (120 % of size), 0...5000 |
| `boxSize` | `[w, h]` | no | absent = point text; sides 16...30,000, area ≤ 200,000,000 |
| `colorRuns` | `[{location, length, red, green, blue}]` | no (v10+) | letters not in the base color |
| `fontRuns` | `[{location, length, fontName}]` | no (v11+) | letters not in the base face |

Runs: UTF-16 offsets into `content`, sorted, non-overlapping, `length > 0`, ending ≤ `content` length, array never
empty (absent instead). Letters outside every run use the base color/face. The manifest version must be ≥ 10 for
`colorRuns`, ≥ 11 for `fontRuns` (`IO/ProjectStore.swift:226-232`); the app writes `current` (14).

### 7.2 Validity (`Document/TypeTool.swift:25-62`) — port verbatim

```js
// JS strings index UTF-16 code units, the same units as NSRange.
const NEWLINE = /[\n\v\f\r\u0085  ]/;           // Character.isNewline
function boxIsValid(s) {
    if (!s.boxSize) return true;
    const [w, h] = s.boxSize;
    return Number.isFinite(w) && Number.isFinite(h) && w >= 16 && w <= 30000 && h >= 16 && h <= 30000 && w * h <= 200000000;
}
function runsValid(runs, n, extra) {
    if (!runs) return true;
    let end = 0;
    for (const r of runs) {
        if (!(r.location >= end && r.length > 0 && extra(r))) return false;
        end = r.location + r.length;
    }
    return runs.length > 0 && end <= n;
}
const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
function isValid(s) {
    const n = s.content.length;
    return n <= 100000 && boxIsValid(s)
        && Number.isFinite(s.fontSize) && s.fontSize >= 1 && s.fontSize <= 2000
        && [s.red, s.green, s.blue].every(unit)
        && Number.isFinite(s.tracking) && s.tracking >= -100 && s.tracking <= 1000
        && Number.isFinite(s.leading) && s.leading >= 0 && s.leading <= 5000
        && runsValid(s.colorRuns, n, (r) => [r.red, r.green, r.blue].every(unit))
        // Swift counts Characters (grapheme clusters); PostScript names are ASCII, so length is the same there.
        && runsValid(s.fontRuns, n, (r) => r.fontName && r.fontName.length <= 200 && !NEWLINE.test(r.fontName));
}
```

### 7.3 Per-letter runs (`Document/TypeTool.swift:64-187`) — port verbatim

```js
const lineHeight = (s) => (s.leading > 0 ? s.leading : s.fontSize * 1.2);
const clampRange = (s, loc, len) => {
    const n = s.content.length, a = Math.max(0, Math.min(loc, n)), b = Math.max(a, Math.min(loc + len, n));
    return [a, b];
};
const sameColor = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function unitColors(s) {
    const base = [s.red, s.green, s.blue], colors = Array(s.content.length).fill(base);
    for (const r of s.colorRuns || []) for (let i = Math.max(0, r.location); i < Math.min(colors.length, r.location + r.length); i++) colors[i] = [r.red, r.green, r.blue];
    return colors;
}
function setUnitColors(s, colors) {
    const base = [s.red, s.green, s.blue], runs = [];
    colors.forEach((c, i) => {
        if (sameColor(c, base)) return;
        const last = runs[runs.length - 1];
        if (last && last.location + last.length === i && sameColor([last.red, last.green, last.blue], c)) last.length += 1;
        else runs.push({ location: i, length: 1, red: c[0], green: c[1], blue: c[2] });
    });
    s.colorRuns = runs.length ? runs : undefined;
}
function colorAt(s, i) {
    const r = (s.colorRuns || []).find((r) => r.location <= i && i < r.location + r.length);
    return r ? [r.red, r.green, r.blue] : [s.red, s.green, s.blue];
}
function setColor(s, color, loc, len) {                    // empty range, or the whole text: recolor all
    const [a, b] = clampRange(s, loc, len), n = s.content.length;
    if (a === b || (a === 0 && b === n)) { [s.red, s.green, s.blue] = color; s.colorRuns = undefined; return; }
    const colors = unitColors(s);
    for (let i = a; i < b; i++) colors[i] = color;
    setUnitColors(s, colors);
}
function unitFonts(s) {
    const fonts = Array(s.content.length).fill(s.fontName);
    for (const r of s.fontRuns || []) for (let i = Math.max(0, r.location); i < Math.min(fonts.length, r.location + r.length); i++) fonts[i] = r.fontName;
    return fonts;
}
function setUnitFonts(s, fonts) {
    if (fonts.length && fonts.every((f) => f === fonts[0])) { s.fontName = fonts[0]; s.fontRuns = undefined; return; }
    const runs = [];
    fonts.forEach((f, i) => {
        if (f === s.fontName) return;
        const last = runs[runs.length - 1];
        if (last && last.location + last.length === i && last.fontName === f) last.length += 1;
        else runs.push({ location: i, length: 1, fontName: f });
    });
    s.fontRuns = runs.length ? runs : undefined;
}
const fontAt = (s, i) => ((s.fontRuns || []).find((r) => r.location <= i && i < r.location + r.length) || { fontName: s.fontName }).fontName;
function uniformFontName(s, loc, len) {                    // null when empty or mixed
    const [a, b] = clampRange(s, loc, len);
    if (b <= a) return null;
    const face = fontAt(s, a);
    for (let i = a; i < b; i++) if (fontAt(s, i) !== face) return null;
    return face;
}
function setFont(s, name, loc, len) {
    if (!name || name.length > 200 || NEWLINE.test(name)) return;
    const [a, b] = clampRange(s, loc, len), n = s.content.length;
    if (a === b || (a === 0 && b === n)) { s.fontName = name; s.fontRuns = undefined; return; }
    const fonts = unitFonts(s);
    for (let i = a; i < b; i++) fonts[i] = name;
    setUnitFonts(s, fonts);
}
// Call BEFORE content changes: `loc,len` is replaced by `newLength` units that inherit from the letter before
// (or the first replaced letter, or the first letter, when there is none before).
function replaceCharacters(s, loc, len, newLength) {
    const [a, b] = clampRange(s, loc, len);
    if (s.colorRuns) {
        const colors = unitColors(s);
        const inherited = a > 0 ? colors[a - 1] : b > a ? colors[a] : colors[0] || [s.red, s.green, s.blue];
        colors.splice(a, b - a, ...Array(Math.max(0, newLength)).fill(inherited));
        setUnitColors(s, colors);
    }
    if (s.fontRuns) {
        const fonts = unitFonts(s);
        const inherited = a > 0 ? fonts[a - 1] : b > a ? fonts[a] : fonts[0] || s.fontName;
        fonts.splice(a, b - a, ...Array(Math.max(0, newLength)).fill(inherited));
        setUnitFonts(s, fonts);
    }
}
```

`uniformFontName` above is the straightforward equivalent of upstream's run walk (`:89-104`); both answer "the single
face of every letter in the range, else none". `PaletteColor` equality is exact on the doubles. If, after an edit the
editor could not describe, the style is invalid, upstream drops both run arrays (`Rendering/InlineTextEditor.swift:237`).

Test vectors (from `CompositorTests/TypeToolTests.swift:354-374, 450-469`):

| Steps | Expected |
|---|---|
| "Hello world", `setColor(red, 6, 5)` | `colorRuns = [{6,5,red}]`, `colorAt(5) = black`, `colorAt(6) = red` |
| then `setColor(red, 5, 1)` | one run starting at 5 (joined) |
| then `replaceCharacters(11, 0, 1)` and append "!" | valid, `colorAt(11) = red` |
| then `replaceCharacters(0, 2, 0)` and drop 2 letters | run `{3, 7}` |
| then `setColor(red, 4, 0)` | `colorRuns` absent, base red |
| "Hello", base Helvetica, `setFont("Courier", 0, 2)` | `fontRuns = [{0,2,Courier}]`, base still Helvetica; `uniformFontName(0,2) = Courier`, `(0,5) = null` |
| `setFont("Courier", 0, 5)` | runs absent, base Courier |
| `setFont("Helvetica", 0, 2)` | `[{0,2,Helvetica}]` |
| `setFont("Courier", 0, 0)` | runs absent, base Courier |
| `setFont("Helvetica", 1, 3)`, `replaceCharacters(5, 0, 1)`, append "!" | `fontAt(5) = Courier` |
| runs `[{2,3}]` on "Text"; overlapping `[{0,2},{1,2}]`; color 2 | all invalid |

### 7.4 Live, and what "becomes pixels" means

`liveText` returns the style only while `layer.asset.image === layer.text.image` (`Document/TypeTool.swift:216-220`).
Upstream never clears `text` explicitly: any edit that installs a new image makes the identity test fail, the layer
behaves as plain pixels (no Edit Text, no Type-tool hit, no "Fill Text", thumbnail becomes a pixel thumbnail), and the
next save writes `text: nil` (`Document/EditorSession+Projects.swift:13`). On load, `LayerText.loaded` pairs the style
with the PNG just read, so a saved `text` is always live (`:82-86`). `docs/project-format.md:48`: "Transforms,
duplication, masks, canvas-size changes, crop, trim and resolution-only image-size changes preserve it; destructive
pixel operations, resampling included, rasterize text and omit the metadata on the next save."

For the board this means: **a manifest record with `text` is live**; every board operation that rewrites the layer's
PNG must `delete record.text` (as `commitStroke` already does, `media/board.js:645`); operations that touch only the
record (transform, opacity, blend, visibility, mask, clipping, effects, rename, reorder, duplicate) must keep `text`
verbatim. Engine operations need no care: the engine saves through `projectSnapshot`, which applies the same rule.

### 7.5 Defaults and layer naming

`LayerTextStyle()` defaults: `content "Text"`, `fontName "Helvetica"`, `fontSize 72`, black, Left, tracking 0, leading
0, no box, no runs (`:7-34`). `textDefaults` is per session (per open project), starts at these, and becomes the last
committed style without runs (3.7). Layer name (`:396-401`):

```js
function layerName(content) {
    const flattened = content.split(/\s+/u).filter(Boolean).join(' ');   // Character.isWhitespace includes newlines
    return flattened ? Array.from(new Intl.Segmenter().segment(flattened), (g) => g.segment).slice(0, 40).join('') : 'Text';
}
```

---

## 8. PSD text import (user-visible; `IO/PSD/PSDText.swift`, `IO/PSD/PSDDocumentBuilder.swift:32-41, 88-94`)

Runs inside the engine already (IO/PSD is compiled); the board only needs a PSD open/import flow (File spec) that
shows the conversion notes. Text rules:

1. `TySh` (or `tySh`) ≤ 8 MB, version 1, a 2 × 3 matrix of finite numbers, text descriptor version 50
   (`:34-41`). Anything else → the layer keeps Photoshop's pixels with the note **"Editable Photoshop text becomes
   pixels and can’t be retyped."**
2. `Ornt == Vrtc` (vertical) → pixels + that note (`:42`).
3. Matrix: rotation + uniform scale + optional vertical flip only. Shear or a scale difference over 2 % of the larger
   scale → pixels + note (`:111-132`). Rotation and `flipY` go to the layer transform.
4. Warp style other than `warpNone`/`none` → stays live, note **"The Photoshop text warp was omitted."** (`:46-49`).
5. Content from `Txt ` (or EngineDict.Editor.Text): BOM/NULs trimmed, CRLF and CR → LF; empty or > 100,000 → pixels
   (`:51-54, 262-268`).
6. Style from the first style run (`:134-179`): size = FontSize × matrix scale, clamped 1...2000 (document PPI is
   ignored); font = `ResourceDict.FontSet[Font].Name` (PostScript); color = FillColor values (4 values ARGB → RGB, 3
   values RGB, 1 gray; values > 1 are 0-255); tracking = Tracking/1000 × size clamped −100...1000; leading = Leading ×
   scale only when AutoLeading is false (else Auto); FauxBold/FauxItalic → note **"Faux bold or faux italic was
   omitted."**; any later run that differs in font, size, tracking, leading, auto-leading, horizontal/vertical scale,
   faux style or color → note **"Only the first text style was kept."**; justification 0 Left, 1 Right, 2 Center,
   anything else Left + note **"Full justification was imported as left alignment."**
7. Paragraph text: when `bounds` is more than 4 px larger than `boundingBox` in both dimensions → box text with
   `boxSize = bounds × scale + 24` both ways, anchored at the frame's top-left; an invalid box → pixels + note
   (`:67-80`).
8. The layer is **re-rendered with Compositor's layout** (`textImage`), not Photoshop's pixels. Point text is placed so
   its alignment anchor (12 px, the middle, or width − 12 px) and first baseline land on the matrix's (tx, ty)
   (`:86-97, 226-260`).
9. Font not installed → still live, drawn with the system font, note **"The font “NAME” isn’t installed, so the text
   was drawn with the system font."** (`:29-32`).

Test vectors (`CompositorTests/PSDRoundTripTests.swift:582-690`): "Hello" Helvetica 24 at identity → live, size 24,
black, Left, no notes; matrix ×2 → 48; 25 × 2 → 50; red, justification 2, tracking 1000, leading 30, second run size
48 → Center, tracking 24, leading 30, red, size 24, note "Only the first…"; bounds (0,0,200,80) vs glyphs
(0,−10,40,10), tx 10, ty 30 → box 224 × 104 at (10, 30); bounds 40,000 wide → pixels; faux bold + warp → live with
both notes; vertical, 2-byte junk, or xx 2 / yy 1 → pixels.

---

## 9. What the engine already provides

| Need | Upstream function (compiled in the engine) |
|---|---|
| Raster | `EditorSession.textImage(_:)` |
| Size | `EditorSession.textBoxSize(_:)` |
| Attributed string (fonts, fallback, runs) | `EditorSession.attributedText(_:)` |
| Begin math | `EditorSession.textAttributes(_:)[.font]` descender |
| Commit | `EditorSession.applyText(_:)` with a `TextDraft` |
| Fill Text | `EditorSession.fillSelection(with:)` → `recolorText` (already reachable through `selection.fill`, `engine/Sources/SelectionOps.swift:43-45`) |
| Layer name | `EditorSession.layerName(for:)` |
| PSD | `PSDReader`, `PSDDocumentBuilder.makeImport`, `PSDText` |

Missing: anything that exposes layout geometry (the app reads it from `NSTextView`), the font list, and request
entry points (section 11).

---

## 10. Board design

### 10.1 Shape of the solution

```
 webview (board)                                   extension host                  compositor-engine (2nd process, "text lane")
 ─────────────────────────────────────────         ───────────────                 ───────────────────────────────────────────
 TextDraft {layerID, origin, transform,      ──►   textLayout(msg)          ──►    text.layout  style → PNG + line geometry
   style, selection, rev}                    ◄──   bytes + JSON             ◄──    (stateless, no project load, ~1-15 ms)
 hidden <textarea> (input, IME, clipboard)
 overlay canvas: caret, selection, frame,
   handles, composition underline, "+"
 renderer override: draft PNG in place       ──►   runEngine('text.commit') ──►    compositor-engine (main process)
 header: font list, size, color…             ◄──   pushExternal(editName)   ◄──    load project → applyText → save
```

The board owns the draft and every interaction; the engine is the only thing that measures or draws glyphs. The
board never lays text out itself, so caret and selection positions are TextKit's own.

### 10.2 Draft state (JS)

```js
draft = {
    id,                       // fresh per open; local undo resets when it changes
    layerID,                  // null for new text
    origin: {x, y},           // document px (3.3, 3.4)
    transform: null | T,      // the layer's transform, or the box-resize result
    style,                    // LayerTextStyle as in the manifest (section 7)
    selection: {start, end, direction, affinity},   // UTF-16; affinity 'up'|'down' for soft-wrap carets
    rev,                      // bumped on every style/content change
    layout: null | {rev, size, lines, extra, laidOut, overflow, baseDescender, image /* ImageBitmap */},
    composition: null | {start, length},             // IME marked range
    goalX: null,              // remembered x for ↑/↓
    previewOriginal: null,    // font-menu preview (5.2)
}
textDefaults = { ...LayerTextStyle defaults }        // per board; kept in vscode.setState
```

Shown transform and display: port 4.2 verbatim (`imageWidth` = the committed layer bitmap's width,
`media/document.js` entry). The renderer gets an override for the edited layer:
`renderer.overrides.set(id, { canvas: layout.image, toDocument: Transform.pixelToDocument(shown, w, h), transform:
shown, noMask: true })` — `noMask` is new: upstream draws the edited layer without its mask (4.1). New text is drawn
like `shapeDraft` (`media/board.js:746-788`): right after the active layer, or last, Normal, full opacity.

### 10.3 Input surface: a hidden textarea

A `<textarea>` owned by the overlay is the keyboard and IME target. Its `value` mirrors `style.content`,
`selectionStart/End` mirror `draft.selection` (both UTF-16, the same units as NSRange).

- Attributes: `spellcheck=false autocomplete=off autocorrect=off autocapitalize=off wrap=off`, `white-space: pre`,
  transparent text and caret, no border/padding, `resize: none`.
- Placement: absolutely positioned at the caret's screen rect (height = line height × zoom) so the IME candidate
  window opens at the caret; `opacity: 0` is fine for focus and composition in Chromium (verify).
- Edits: on `beforeinput` record `inputType` and the pre-edit selection; on `input` derive the replaced range and
  the new length, call `replaceCharacters` **before** assigning the new content (runs follow the text exactly as
  upstream's `shouldChangeTextIn`), then `content = value`, bump `rev`, request a layout.
  - insert types (`insertText`, `insertLineBreak`, `insertParagraph`, `insertFromPaste`, `insertReplacementText`):
    range = pre-edit selection, `newLength = value.length − (old.length − (end − start))`.
  - delete types: removed = `old.length − value.length`; non-empty pre-edit selection → that range; else backward
    `[caret − removed, caret)`, forward `[caret, caret + removed)`.
  - composition (`compositionstart/update/end`, `insertCompositionText`): range = the previous composition range
    (`{start, length}` tracked from `compositionstart`'s selection and each update's data length).
  - fallback: common prefix/suffix diff clamped so the change contains the pre-edit caret.
  - Refuse (restore value and selection) any edit that would exceed 100,000 units.
- Native behavior kept: character-wise ←/→ (with ⇧), ⌫/⌦, ⌥⌫ (word back), ⌘⌫ (line start), ⌘A, clipboard (VS Code
  re-dispatches ⌘C/⌘V/⌘X into the focused element), plain-text paste (a textarea is plain by nature), dead keys,
  emoji picker, IME.
- Intercepted (`preventDefault` + `stopPropagation`): see 10.9. Vertical moves and line ends are computed from engine
  geometry because the textarea's own wrapping differs from TextKit's.

### 10.4 Overlay drawing (on `view.overlay`, every frame the draft or view changes)

Map container coordinates to screen as `toScreen(pixelToDocument(shown, imageW, imageH)(x + 12, y + 12))`, which
applies rotation, scale **and flips** (caret, selection, composition underline, hit testing). Use the rotation-only
mapping (`LayerTransform.point`, ignoring flips) for the frame, the handles and the resize math (4.6-4.7).

- Selection: rects from 4.3, filled with the selection color at α ≤ 0.45 (accent-based; Compositor uses the dark
  appearance's `selectedTextBackgroundColor`), drawn whether or not the textarea is focused.
- Caret (collapsed selection, textarea focused, not overflowed): line-fragment-tall, `max(1 CSS px, 1 layer px on
  screen)` wide, colored `colorAt(loc > 0 ? loc − 1 : 0)`, blinking (on 0.53 s / off 0.53 s is a reasonable stand-in for
  the system rate). Choose the line for a soft-wrap index by `affinity`.
- Composition: 1-2 px underline under the composition range (Compositor's marked text is drawn by `NSTextView`; its
  default underline takes the clear glyph color, so draw one explicitly).
- Frame, 8 handles, overflow "+" as 4.6 (1 CSS px frame; 6 CSS px handles; a 1 CSS px handle stroke is an acceptable
  deviation from upstream's 1-layer-pixel stroke).
- New box being dragged: 1 CSS px accent rectangle.
- Pending layout: keep drawing the last layout's geometry and image until the new one arrives (10.5).

### 10.5 Engine round trips and keeping typing responsive

Measured costs on this Mac (scratch copy of the upstream code): `textImage` 0.06 ms for a one-line title (804 × 111),
~1 ms for a 1,140-character 1500 × 1500 box; PNG encoding 0.9 ms and 12.6 ms for those. The rest is IPC (JSON line,
temp file or inline bytes, `postMessage`, `createImageBitmap`): expect 5-30 ms per keystroke.

1. **A second engine process for text.** `compositor-engine` answers one request at a time on its main actor
   (`engine/Sources/EngineMain.swift:1-4, 21-31`). A filter render or a save on the shared process would stall
   typing. Spawn another `EngineClient` with the same binary (`core/engine-client.js`) and route `text.layout` and
   `text.fonts` to it; `text.commit` stays on the main process (it loads and saves the project).
2. **Do not go through `runEngine`'s flush path** for `text.layout`: it never reads the project. A dedicated
   `textLayout` message (no `flush`, no `selectionOut`, no `engineBusy`, no "Working…" status) keeps it cheap.
3. **Coalesce**: at most one `text.layout` in flight per draft; each carries `rev`; when an answer arrives, apply it
   only if no newer one is pending; if `rev` moved on meanwhile, send the latest style immediately. Hover previews in
   the font menu go through the same queue, so fast scrubbing renders only the last face.
4. **Apply answers atomically**: image, size, lines and shown transform switch together, so caret and pixels never
   disagree.
5. **Optional prediction** (only if measured latency is noticeable): for a plain insertion on one line, advance the
   caret by `measureText` of the inserted characters in a CSS face loaded with `@font-face { src: local("<PostScript
   name>") }`, with `font-kerning: none` when tracking is 0 and `letter-spacing: <tracking>px`. Replace with the
   engine's numbers when they arrive. Never use the prediction for pixels.
6. **Big boxes**: add `format: "raw"` (premultiplied RGBA bytes plus width/height) if PNG encoding of large boxes
   becomes the bottleneck; un-premultiply in JS before `putImageData`.
7. **Too large**: when `text.layout` reports `imageError: "tooLarge"`, keep the geometry (frame, caret) and show no
   pixels, as upstream (2.3).

### 10.6 Interaction flows

- **Type tool press** (port 3.2): if the press is inside the open box's text area → caret/selection handling (below);
  in the edge band → resize (4.6). Otherwise: `await commit()`; if it fails, stop. Then hit-test layers top-down for
  `record.text && effectivelyVisible(record) && contains(transform, point)`: open that layer (10.2) with
  `layerID`, `origin = transform.origin`, `transform`, the record's `text`; request a layout; when it arrives, hit-test
  the original press point in the new geometry (4.3) and apply any pointer moves made meanwhile as a drag selection.
  Else start a box drag (3.4); on release open a new draft (3.3: request a layout of the empty style, compute
  `origin` from the returned `baseDescender` and `lineHeight`, then show).
- **Mouse in the text**: single press → caret (`affinity = 'up'` when the press is right of a soft-wrapped line's end,
  else `'down'`); ⇧-press extends; drag extends; double press → word (`Intl.Segmenter` granularity `word`, which
  matches the 4.3 vectors; a whitespace run selects itself); triple press → paragraph including its newline. Hit test
  in screen space → document → layer pixel (inverse of the full mapping) → container.
- **Commit** (`commit()`): if `draft.layerID === null` and the content trims to empty → close, no request. Otherwise
  `runEngine('text.commit', …)` (11.3). Keep the draft's image as the layer override until the extension's
  `pushExternal` delivers the new layer (no flicker), then close the draft, set `textDefaults = {...style, colorRuns:
  undefined, fontRuns: undefined}`, focus the canvas. On error: toast/alert with the engine's message and keep the
  draft open (upstream's "Couldn’t paint" alert).
- **Cancel**: drop the draft and override, focus the canvas.
- **Commit triggers** to wire: Done, ⌘↩, Type press outside, `selectTool` (await; refuse the switch on failure), layer
  selection in the Layers panel (same), board close/dispose (best effort), Move-tool double-click into another text.
- **While a draft is open**: disable layer-panel actions, document undo/redo (10.9), menu items that edit layers or
  pixels, filters; keep zoom/pan; defer `pushExternal` of external disk changes until the draft closes (as
  `ProjectController+ExternalChanges.swift:49`), except the update produced by our own commit.
- **Move tool double-click** on live text: commit a pending floating transform, select the layer, switch the tool to
  Type, open the draft with the caret at the end. **Layers panel**: double-click on a text row's thumbnail opens it;
  subtitle "Text · Double-click to edit", tooltip "Editable text layer" (replace `media/layers.js:179`).
- **Header changes with a text layer selected but closed** (5.5): open it first (caret at end, selection (0,0) at the
  moment of the change), then apply.

### 10.7 Local undo

Keep a draft-local stack of `{content, colorRuns, fontRuns, selectionBefore, selectionAfter}` snapshots, coalescing
consecutive same-kind typing (insert vs delete) until the caret is moved by the user, a paste/cut happens, or a
composition ends. ⌘Z/⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y elsewhere) and `beforeinput` `historyUndo`/`historyRedo` use
it. Header style changes are not recorded (as upstream). Snapshots also restore runs, which upstream's `NSTextView`
undo may not do exactly (adaptation).

### 10.8 Font popup

- List from `text.fonts` (11.2), fetched once per board session and cached; sorted by plain code-unit order (JS
  default `sort()`, which equals Swift's `<` on ASCII PostScript names); add the current name if missing.
- Rendering each name in its own face: use the engine sprite (11.2) — exact and independent of Chromium's font
  matching. Rows with `ownFace: false` are plain text in the UI font. (Alternative: `@font-face { src: local(…) }`
  per visible row; requires verifying Chromium's PostScript-name matching on macOS.)
- A virtualized dropdown, 210 px wide control with tail ellipsis, opening scrolled to the current item; "(Multiple)"
  as a non-font first item when `uniformFontName` is null for a non-empty selection.
- Hover and arrow-key highlight → preview (5.2) through the layout queue; leaving the list keeps the last preview;
  closing without a choice → restore `previewOriginal` (its layout is cached, no request); a choice keeps the preview.
- Opening the popup must not collapse the textarea selection: keep `draft.selection` as the source of truth and
  re-apply it when the textarea is focused again (upstream's `holdsSelection`).

### 10.9 Keys

Inside the textarea (handler on the textarea, `preventDefault` + `stopPropagation` so neither the browser nor VS Code
acts; see `ui.md` 12.1):

| Key (`metaKey` on macOS, `ctrlKey` elsewhere for ⌘) | Board action |
|---|---|
| `Escape` | cancel |
| ⌘ + `Enter`/`NumpadEnter` | commit |
| ⌥ + `ArrowLeft/Right` (± ⇧) | tracking ∓1/∓10 (rejected if invalid) |
| ⌥ + `ArrowUp/Down` (± ⇧) | leading as 4.4 |
| `ArrowUp/Down` (± ⇧), ⌃P/⌃N, `PageUp/PageDown` | vertical move by engine lines with `goalX` |
| ⌘ + `ArrowLeft/Right`, `Home/End`, ⌃A/⌃E (± ⇧) | visual line start/end from engine lines (end of a soft-wrapped line: `affinity 'up'`) |
| ⌘ + `ArrowUp/Down` (± ⇧) | text start/end |
| ⌘Z / ⇧⌘Z | local undo/redo (10.7) — must never reach VS Code's undo while a draft is open |
| `Tab` | insert `"\t"` (NSTextView does); ⇧Tab ignored |

Let everything else through to the textarea. The board's global handler already ignores keys aimed at a TEXTAREA
(`media/board.js:1233-1235`), so single-letter tool keys cannot fire while typing. On the canvas (textarea not focused)
with a draft open: ⎋ cancels; Tab does not cycle modes. Add `KeyT` → Type to the tool keys (`media/board.js:1310`) and
a rail button "Type (T)" (Lucide `type`).

VS Code's own Edit › Undo (menu bar or command palette) cannot be refused by a webview: VS Code pops its stack and calls
the custom editor's undo, which posts `undo` to the board (`vscode-extension/extension.js:393-403`). While a draft is
open the board should run the local text undo for that message too (Compositor forwards Undo to the text view); the
cost is that VS Code's stack is then one step off. Consuming ⌘Z in the textarea makes this path rare.

### 10.10 Header (board `renderOptions` for `type`)

Port 5.1-5.4 control for control: font popup (10.8), Size field + "px" scrub, swatch (opens
`picker.open({ title: 'Color Picker (Text Color)', … })`), three alignment buttons, Tracking label scrub + field, Leading
label scrub + field (placeholder "Auto"), then Cancel/Done or Edit Text. Fields' ↑/↓ steppers as 5.3. Every change goes
through a JS `changeTextStyle` (5.5) that validates with `isValid` and requests a layout. Disable the header without a
document or while the board is busy.

`media/picker.js` needs two hooks for 6.2: `onChange(rgb)` for the live preview and `onCancel()` for restoring; today
it has only `onCommit` (`media/picker.js:98-100`). The rail's foreground setter must also call `setDraftTextColor`
while a Type draft is open (6.1), including Swap and Default colors.

### 10.11 Fill and other existing operations

- Fill (`media/board.js:1017-1021`) already calls `selection.fill`, which runs `fillSelection` and therefore
  `recolorText`: no selection + image target on a live text layer → "Fill Text", still live (verify the board sends
  `isMaskSelected`). With a draft open, ⌥⌫/⌘⌫ land in the textarea and delete; the menu's Fill items should do the
  same (or be disabled) while a draft is open.
- Board pixel operations already drop `text` (`commitStroke`); audit the others (fills done in JS, if any, transform
  baking, crop) against 7.4.

---

## 11. Engine API to add (`engine/Sources/TextOps.swift`, wired from `EngineOperations.run`)

Styles travel in the manifest's JSON form and are decoded with `JSONDecoder().decode(LayerTextStyle.self, …)`, the
same pattern as `transform(_:)` in `engine/Sources/SelectionOps.swift:87-90`. Coordinates in answers are **image**
pixels (container + 12).

### 11.1 `text.layout` (stateless; text lane)

Request: `{ style, out?: "<png path>", format?: "png" | "raw" }`.

Answer (comments for this spec only):

```jsonc
{
  "size": [172, 111],                 // image size = textBoxSize, also the box for box text
  "padding": 12,
  "container": [148, 87],
  "laidOut": 4,                       // UTF-16 units laid out; < content length means overflow
  "overflow": false,
  "lineHeight": 86.4,
  "baseDescender": 16.559,            // |descender| of NSFont(name: fontName, size) ?? system font, for 3.3
  "lines": [
    { "range": [0, 4],                // character range of the line fragment
      "rect": [12, 12, 148, 86.4],    // line fragment rect
      "used": [12, 12, 140.027, 86.4],
      "baseline": 81.4,
      "carets": [[0, 12], [1, 55.98], [2, 96.023], [3, 132.023], [4, 152.027]],   // [index, x] insertion points
      "hardBreak": false }            // the line ends in "\n"
  ],
  "extra": null,                      // extra line fragment rect for "" or a trailing "\n": {"rect": [...]}
  "fonts": [[0, 4, "Helvetica"]],     // fonts actually used after fallback, per run
  "missingFonts": [],                 // style/run faces NSFont(name:) cannot load
  "imageError": null                  // "tooLarge" when textImage throws; geometry still present
}
```

Implementation sketch (same container set-up as `textImage`, so geometry and pixels agree):

```swift
func textLayout(_ args: [String: Any]) throws -> Any {
    let style = try textStyle(args["style"])
    guard style.isValid else { throw EngineError.bad("That text style is not valid.") }
    let padding = LayerTextStyle.padding
    let size = EditorSession.textBoxSize(style)
    let width = ceil(size.width), height = ceil(size.height)
    let storage = NSTextStorage(attributedString: EditorSession.attributedText(style))
    let layout = NSLayoutManager()
    let container = NSTextContainer(size: CGSize(width: max(1, width - 2 * padding), height: max(1, height - 2 * padding)))
    container.lineFragmentPadding = 0
    storage.addLayoutManager(layout)
    layout.addTextContainer(container)
    let glyphs = layout.glyphRange(for: container)
    var lines: [[String: Any]] = []
    layout.enumerateLineFragments(forGlyphRange: glyphs) { rect, used, _, glyphRange, _ in
        let chars = layout.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
        var positions = [CGFloat](repeating: 0, count: chars.length + 2)
        var indexes = [Int](repeating: 0, count: chars.length + 2)
        let count = layout.getLineFragmentInsertionPoints(forCharacterAt: chars.location, alternatePositions: false,
                                                          inDisplayOrder: false, positions: &positions, characterIndexes: &indexes)
        let baseline = rect.minY + layout.location(forGlyphAt: glyphRange.location).y
        lines.append(["range": [chars.location, chars.length],
                      "rect": [rect.minX + padding, rect.minY + padding, rect.width, rect.height],
                      "used": [used.minX + padding, used.minY + padding, used.width, used.height],
                      "baseline": baseline + padding,
                      "carets": (0..<count).map { [indexes[$0], positions[$0] + padding] }])
    }
    // extra line fragment, fonts after fallback (enumerate .font on `storage` after layout), missing faces, then:
    // if let out = args["out"] as? String { try writePNG(try EditorSession.textImage(style), to: out) }  (tooLarge → imageError)
    ...
}
```

`hardBreak` = the line's range ends with a `\n`; `laidOut` = `layout.characterRange(forGlyphRange: glyphs, …)` end.
Verify on a few styles that the answer reproduces the vectors in 2.5 and 4.3.

### 11.2 `text.fonts` (stateless; text lane)

Request: `{ sprite?: { out: "<png path>", scale: devicePixelRatio, width: 210 } }`.

Answer: `{ fonts: [{ name, ownFace }], sprite?: { rowHeight, scale, width, rows } }` where `fonts` is
`NSFontManager.shared.availableFonts.sorted()` and `ownFace` is the `makeStyledName` test
(`UI/TypeControls.swift:204-209`: the face loads at 13 pt and covers every alphabetic scalar of its name). The sprite
draws row *i* = the *i*-th name at `NSFont.systemFontSize` in its own face (or the system font when `!ownFace`),
left-aligned, vertically centered in `rowHeight` points, at `scale`, truncated to `width`. Cache per process.

### 11.3 `text.commit` (project; main process, through `runEngine` with a label)

Request: `{ project, activeLayerID, isMaskSelected, layerID: string|null, origin: [x, y], transform: object|null,
style }`.

```swift
case "text.commit": return try await withSession(args) { session in
    guard let document = session.document else { return }
    let draft = TextDraft(documentID: document.id, layerID: self.uuid(args["layerID"]),
                          origin: try self.pointValue(args["origin"]),
                          transform: try (args["transform"] as? [String: Any]).map { try self.transform($0) },
                          style: try self.textStyle(args["style"]))
    if !session.applyText(draft), session.brushError == nil {
        session.brushError = "The text could not be applied."
    }
}
```

Answer: `withSession`'s outcome: `saved`, `editName` ("New Text Layer" / "Edit Text"), `activeLayerID` (the new
layer for new text), `selection` (unchanged), `error`. Unchanged or whitespace-only new text → `saved: false`, nothing
recorded. The engine computes the commit transform, the layer name, the insertion point and the mask pin (3.7), so the
board does not port them.

### 11.4 Existing operations to rely on

- `selection.fill` → "Fill Text" (6.3). Add an engine test: live text layer, no selection, foreground red → record
  still has `text`, base color red, no runs, `editName` "Fill Text".
- PSD: a future `psd.inspect` / `psd.import` (File spec) that returns `PSDImport.conversions` — text notes come for
  free.

---

## 12. Not applicable in VS Code / adaptations

| Compositor | Board |
|---|---|
| `NSTextView` editing surface with clear glyphs | Hidden textarea for input + overlay drawing from engine geometry (10.3-10.4) |
| Marked text drawn by `NSTextView` | Composition range tracked from composition events; underline drawn by the overlay; candidate window placed by moving the textarea to the caret |
| Pointer stays visible while typing | Chromium/Electron may hide the pointer while typing on macOS; a webview cannot prevent it |
| `UndoManager` with Cocoa typing coalescing | Draft-local snapshot stack (10.7); VS Code-menu Undo cannot be refused (10.9) |
| Cocoa key bindings, emacs keys, services, Look Up, Writing Tools, spelling/grammar, text replacement, Transformations, drag-and-drop of selected text inside the view, the text view's context menu | Not available beyond what a Chromium textarea does; no drag-move of selected text; suppress the context menu or show Cut/Copy/Paste only |
| Remappable Text Editing shortcuts (Keyboard Shortcuts window) | Defaults hard-coded (the board has no shortcut editor) |
| `NSPopUpButton` font menu with styled items and hover tracking | HTML virtualized dropdown + engine sprite (10.8) |
| `controlAccentColor`, `selectedTextBackgroundColor`, system caret blink | `--vscode-focusBorder` or `#0A84FF`; accent-based highlight at α ≤ 0.45; fixed blink |
| Synchronous commit inside `finishText()` | Async engine commit; tool/layer switches await it and are refused on failure |
| `textDefaults` per session | Per board, persisted with `vscode.setState` (harmless extension) |
| Fonts | Engine-only; the Type tool needs macOS (the engine is macOS-only anyway) |
| Draft effects re-rendered live | The board does not render layer effects today; show the draft without them |

---

## 13. Upstream quirks a faithful port inherits

1. Tracking 0 disables pair kerning; any non-zero tracking turns it back on (2.4).
2. A click puts the first baseline 0.44 px (Helvetica 72) above the pointer: exact descender vs TextKit's rounded one
   (3.3). New point and box layers sit at fractional origins.
3. Right- and center-aligned point text grows to the right (top-left anchored), and the `0.1·fontSize` slack shifts
   lines inside the layer (2.2, 2.5).
4. Small leading cuts off the first line's ascenders at the top edge of the raster (2.3).
5. Editing a non-uniformly scaled text layer shows it uniformly scaled; the commit restores per-axis scale (4.2).
6. The edited layer is shown without its mask while the draft is open (4.1).
7. Pressing a resize handle on point text converts it to a box even without dragging (4.6).
8. The Leading **field** ↑ opens the lines; ⌥↑ in the text closes them. The Leading label scrub starts from 0 when
   Auto; arrows from Auto give fractional values shown rounded (5.3).
9. A caret-only color or font change applies to the whole text, not to the next letters typed (6.1, 5.5).
10. Out-of-range typed values and steps (size, tracking, leading > 5000) are ignored silently (5.5).
11. A press outside the box both commits and starts a new text at the press (3.2).
12. Opening closed text with a Type-tool press in its **top padding** (the layer box reaches 12 px beyond the text, and
    that press is forwarded to the text view, 3.2) puts the caret at the end of the text, because any y above the first
    line maps to the end (4.3). A press in the left/right padding maps to that line's start/end. During a drag
    selection the same mapping applies when the pointer goes above the text.
13. Handle strokes are 1 layer pixel and thicken with zoom (4.6).
14. A text box drag does not snap (unlike shapes) and ignores ⇧/⌥ (3.4).
15. With the mask selected, new text keeps the default color instead of the foreground (3.3).
16. Opening text whose font is missing re-renders it with the system font immediately (3.5).
17. Fill recolors text only without a selection; with one it rasterizes (6.3).

---

## 14. Risks and open questions

| Risk | Why it matters | Mitigation |
|---|---|---|
| Engine queueing | One request at a time per process; a filter or save would freeze typing | Second engine process for `text.layout`/`text.fonts` (10.5) |
| Typing latency | Every keystroke is an engine round trip | Coalescing, atomic apply, optional caret prediction; measure before adding prediction |
| Textarea ↔ runs mapping | Runs follow edits only if the replaced range is exact (IME, autocorrect-like replacements, paste) | `beforeinput` + pre-edit selection + composition tracking, diff fallback; test with Japanese/Chinese IME and dead keys |
| VS Code undo routing | VS Code's Edit menu Undo pops its stack during a draft | Consume ⌘Z in the textarea; treat stray `undo` messages as local undo (10.9) |
| Unverified Cocoa details | Caret affinity at soft wraps; whether `NSTextView.mouseDown` uses the same mapping as `characterIndexForInsertion` for presses in the top padding (quirk 12) | Check in the real app before finalizing those rules |
| Font names in the webview | Chromium's `local()` matching by PostScript name is not verified | Use the engine sprite; `local()` only for optional prediction |
| Fidelity across machines | Layout depends on installed fonts and OS; the stored PNG may have been made elsewhere | Expected (upstream has the same property); vectors in 2.5/4.3 are this Mac's |
| External changes during a draft | An agent or Compositor itself rewriting the layer under the draft | Defer `pushExternal` while drafting (10.6) |
| Mask pin on commit | `applyText` pins a grid-following mask (`placement`), which the board must pick up | Arrives through `pushExternal` with the commit; verify the board reloads `maskPlacement` |
