# Compositor Board

Draw in a VS Code tab while Claude reads and draws on the same image.

This project brings [Compositor](https://github.com/robbietilton/Compositor), the open-source Photoshop alternative for
Mac, into VS Code. Compositor is a native Swift/Metal app, so it cannot run inside an editor tab as it is. Two parts
replace it there: the interactive tools and the live picture (brush and paint-tool previews, shapes, transform and
distort previews, selection tools, compositing, adjustment layers, layer effects) are ported to JavaScript so they
respond at once, and everything else runs in **compositor-engine**, a headless program compiled from Compositor's own
Swift sources (selections, Apple Vision, fills, healing, cloning, smear and gradient commits, filters, Camera Raw,
layer structure, canvas and image commands, text layout, CMYK proofing), so those results are Compositor's exactly.
Everything reads and writes Compositor's own `.comp` format, so the same project can be open in three places at once:

```
you, in the VS Code board tab ──┐
                                ├── the same .comp folder ── the Compositor app (reloads within half a second)
Claude, through the MCP tools ──┘
         └── and the live board over a local connection, strokes not yet saved included
```

| Part | Folder | What it is |
|---|---|---|
| Compositor Board | `vscode-extension/` | VS Code extension: the board tab (custom editor for `*.comp/manifest.json`), autosave, undo/redo on VS Code's stack, file watching, and the local bridge |
| compositor-board plugin | `claude-plugin/` | Claude Code plugin: a skill plus the `board` MCP server (13 tools) |
| shared core | `core/` | Reading, validating and atomically writing `.comp` projects; copied into both packages by `scripts/sync-core.sh` |
| compositor-engine | `engine/` | Compositor's Document, Rendering and IO sources built headless (`engine/build.sh`, Command Line Tools only); JSON lines over stdio |
| parity checklist | `docs/parity/features.md` | Every user-facing Compositor feature (1837 lines); a line is ticked once the board does it |
| port specs | `docs/port-specs/` | The upstream behavior each port follows, with file:line references into `upstream/` |
| upstream | `upstream/` | Git submodule: Compositor at 365b574 (1.5.3), read only; the engine is built from it |

## Requirements

- A Mac with Apple silicon and macOS 26 or later. compositor-engine is built for the same target as Compositor itself.
- The Xcode Command Line Tools for macOS 26 (`xcode-select --install`). Xcode itself is not needed.
- Node.js 20.9 or later, VS Code 1.90 or later, and [Claude Code](https://claude.com/claude-code) for the plugin.
- Optional: the Compositor app (`brew install --cask robbietilton-compositor`). The board works without it.

## Install

```sh
git clone --recurse-submodules https://github.com/Haoxi-Yuan/compositor-board.git
cd compositor-board
engine/build.sh            # about 75 s; compiles compositor-engine from upstream/
./scripts/sync-core.sh     # copies core/ and the engine into both packages
(cd claude-plugin/server && npm install)
(cd vscode-extension && npx --yes @vscode/vsce package --allow-missing-repository --skip-license -o ../dist/)
code --install-extension dist/compositor-board-0.6.6.vsix
claude plugin marketplace add "$PWD"
claude plugin install compositor-board@compositor-board-local
```

- If you cloned without `--recurse-submodules`, run `git submodule update --init` before building.
- If `code` is not found, run *Shell Command: Install 'code' command in PATH* from VS Code's Command Palette.
- The plugin loads from this folder in place, so edits to `claude-plugin/` take effect after `/reload-plugins` in
  Claude Code. After changing `core/` or the engine, run `scripts/sync-core.sh` again and repackage the extension.

## Use

- **Open a board**: right-click a `.comp` folder in the Explorer and choose *Open Board in Editor* or *Open Board in
  Side Bar*, open its `manifest.json`, or run *Compositor Board: New Board* from the Command Palette.
- **Side bar**: the board icon in the Activity Bar opens the board in the side bar, which remembers the last project
  and lists recent ones. The button next to Fit moves a board between the side bar and an editor tab (a project is
  open in one place at a time). Narrower than 560 px the board switches to a compact layout: tools in a row, layers and
  notes in a drawer under the canvas (the chevron folds it). In the side bar ⌘Z, ⇧⌘Z and ⌘S are handled by the board
  itself and it always autosaves.
- **Tools** (keys as in Compositor, remappable in Edit › Keyboard Shortcuts…): Move/Transform `V`, Marquee `M`, Lasso
  `L`, Magic `W`, Crop `C`, Brush `B`, Eraser `E`, Spot Healing `J`, Clone Stamp `S` (Option-click sets the source),
  Smear `R` (Liquify, Blur, Smudge), Gradient `G`, Shape `U`, Pen `P`, Type `T`, Eyedropper `I`, Note for Claude `N`,
  Hand `H` or Space, Zoom `Z`, no tool `A`. Tab switches a tool's mode. `[` `]` size, Shift-`[` `]` hardness, `1`-`0`
  opacity, `X` swap colors, `D` default colors.
- **Pen** (`P`, a board addition: Compositor has no pen). Tab switches its two ways of drawing:
  - Curvature (the default): click points and the path curves smoothly through them; double-click or Option-click
    for a corner.
  - Pen: click for corners (a polyline), drag out handles for curves.
  - Click the first point to close the path, or press Return to finish an open one.
  - Each path becomes a layer "Path N", stroked with the foreground color and/or, when closed, filled with the
    background color.
  - Reshape it later with the Pen: drag points, click a segment to add a point and drag to bend it, Option-click a
    point to make it a corner or smooth (handles show in Pen mode). This works until the layer is painted on or
    filtered.
- **Shape** (`U`): a Rectangle or Ellipse can be filled (as in Compositor), outlined, or both: Fill, Stroke or
  Stroke & Fill in the options bar (the outline is a board addition, as in Photoshop). The outline lies inside the
  shape in the foreground color, with its own Width; with both, the inside takes the background color. Scaling an
  outlined shape on the board keeps the outline's width until the layer is painted on or filtered.
- **Lock** (⌘/, the lock button under the Layers list, a board addition): a locked layer, or anything in a locked
  folder, can't be painted, moved, restyled, deleted or merged; it can still be hidden, renamed, reordered and
  duplicated. Claude's tools are not held back by it.
- **Menus**: File, Edit, View, Select, Image, Filter and Layer sit above the options bar (one ☰ button on a compact
  board); View › Search Commands… (⌘F) finds any command or tool by a few letters, as in Compositor.
- **Painting and retouching**: Brush and Eraser run in the webview with Compositor's own algorithm; Spot Healing
  (Content-Aware, Create Texture, Proximity Match), Clone Stamp, Smear and Gradient preview in the webview and commit
  through compositor-engine, so the result is Compositor's. 16-bit layers can be painted and stay 16-bit.
- **Transform and canvas**: ⌘T free transform with distort, several layers or a folder at once, the Move bar fields;
  Crop with ratios and snapping; Image › Image Size…, Canvas Size…, Trim…, rotate and flip the canvas, Flip Layer.
- **Selecting several layers on the canvas** (Move tool, Photoshop habits, a board addition; it goes by the pixels you
  see, not the layer's rectangle): Shift-click a layer's pixels to add it, or to take it out again. With Auto Select
  on, or while holding ⌘, drag from an empty spot (over the background or from outside the canvas works too) to box
  the layers you want; Shift adds to the selection. Locked layers and an opaque full-canvas background are left out
  of the box. Then drag any of their pixels, or press ⌘T, to transform them together. A click on an empty spot, or
  outside the canvas, selects no layer; with nothing selected, a press on a layer's pixels picks that layer.
- **Type**: click for point text or drag a box, edit in place on the canvas, fonts with live preview, size, color,
  alignment, tracking and leading; text stays editable in Compositor.
- **Adjustments, filters and effects**: adjustment layers (Hue/Saturation, Levels, Curves, Exposure, Gradient Map,
  Grain, Add Noise, Gaussian and Motion Blur, Invert, Black & White, Color Balance) drawn live and edited in their
  panels; every Filter-menu filter and the Image-menu adjustments with preview; Camera Raw in its docked panel; layer
  effects (Stroke, Drop Shadow, Color Overlay, Inner Shadow, Outer Glow, Inner Glow) from the Layers panel's sparkle
  button, drawn live, also while painting.
- **View**: rulers ⌘R (drag a guide out), guides ⌘;, grid ⌘' with Grid Settings…, Snap ⇧⌘; and Snap To, the Navigator
  at 300 % and above, the pixel grid at 800 %, Toggle Fullscreen `F` (the canvas alone on black), CMYK proof and gamut
  warning through any installed ICC profile.
- **File**: New Canvas… (sizes, units, presets, clipboard size), Open Project…, Open Recent, Save As…, Import Images…
  (PNG, JPEG, HEIC, TIFF, WebP, SVG, Photoshop PSD/PSB with Compositor's conversion notes, camera RAW through its
  develop sheet), Export PNG, Export As… and Export JPEG (PNG, JPEG, TIFF, PDF, EXR; 16-bit and CMYK) with a live
  preview. Images dropped on the canvas become layers (from VS Code's Explorer, or Shift-drag from Finder); the
  Explorer's right-click menu has New Board from Images and Import into Board.
- **Selections**, as in Compositor: Marquee (Rectangle/Ellipse), Lasso (Freehand/Polygonal), Magic (Wand/Object),
  Select › Subject ⌥⌘A, Color Range…, Layer's Pixels, Mask's Black Areas, ⌘-click a layer or mask thumbnail; Shift
  adds, Option subtracts; ⌘A all, ⌘D deselect, ⇧⌘I inverse, Expand/Contract/Feather. With a selection: ⌫ clears (in
  the Layers list it deletes the layer, as the trash button does), ⌥⌫ / ⌘⌫ fill with the foreground / background
  color, ⇧⌫ Content-Aware Fill (with preview), ⌘C / ⇧⌘C / ⌘X / ⌘V (layers copied with no selection paste whole, also
  into another board), ⌘J layer via copy, ⌘I invert, ⌘-drag moves the pixels (⌘⌥ duplicates), and so does a Move-tool
  drag inside the selection (⌥ duplicates; Photoshop's habit, not Compositor's, where the Move tool always drags the
  layer), ⌘-arrows nudge them, arrows nudge the outline, ⌘T transforms them (Return applies, Escape cancels). The
  brush paints only inside the selection. Each of these is one undo step; the selection itself is undone and redone
  too but, as in Compositor, never saved.
- **Layers**, as in Compositor's Layers panel: folders (⌘G group, ⇧⌘G ungroup, ⌥⌘G clipping mask), drag to reorder
  or into a folder (Option-drag copies, also on the canvas), Shift/⌘-click to select several, swipe across the eyes to
  hide several, double-click to rename, the blend menu previews on hover, `1`-`0` with the Move tool set the opacity of
  every selected layer. Merge Down / Merge Layers / Merge Group ⌘E, duplicate ⌘J, delete (with Compositor's alert for
  masks linked to other layers), convert 8-bit / 16-bit, and the right-click menu. **Masks**: the mask button adds a
  white mask (Option: black; from the selection when there is one); click the mask thumbnail to paint it with the
  brush or fill it, Option-click shows it alone, Shift-click turns it off, the chain links or unlinks it, dragging it
  to another layer copies it. Layer structure edits run through compositor-engine, so the results are Compositor's.
- **Talk to Claude about it**: pin a note with `N` (drag a box or click a spot, then type; a new note can go inside an
  older one, whose number or outline opens it). Then press **Send to Claude** on the note's card, or **Pin & send**
  (⌘Return) while writing it. The thread goes into a running Claude Code session that has this plugin, as a
  cross-session message ("Another Claude session sent a message: [Compositor Board] …"), and an idle session starts
  working on it. The **Send to** row under Notes for Claude shows which chat that is, by the title on its Claude Code
  tab, and whether it is busy. It follows the Claude chat tab in front in this VS Code window (else this window's chat
  that last worked on the board, else the latest started; chats of other windows come last). Click the row to pin
  another chat for this board, kept until that chat ends, or to follow the tab in front again; the arrow next to the
  button sends one note to another chat. Chats of other windows are under *Other VS Code Windows*. You can also just ask Claude, for example "look at my board and do what my note says". The line above
  Notes for Claude in the panel drags the notes list taller or shorter; a double-click gives the automatic height back.
- **Edit target** (under Notes for Claude): where Claude makes the change a note asks for. By default it is your
  workspace: the board is your sketch, and Claude changes the file the note is about (the figure, document or the
  code that draws it), asking in the note's thread when it can't tell which. *Choose Files…* names the files, and
  *This Board* has Claude draw on the board instead. A note's *Target…* button sets its own target; otherwise it
  follows the board's. The target goes with Send to Claude and shows in `read_board`; the board's is kept in
  `<name>.comp.board.json`, a note's in the notes file. Claude answers
  with notes of its own (purple) and draws on layers named `Claude: …`, which you can hide, move or undo with ⌘Z like
  any edit. A sent note is Claude's to read and act on, but it does not count as your approval for anything Claude
  Code asks permission for.
- **Open in Compositor** (the arrow button, top right) at any time: both stay in sync through the files.

## What Claude can see

`view_board` uses the best source available:

1. the VS Code board, live (no permission needed);
2. a screenshot of the Compositor window (Screen Recording permission for the app running Claude Code);
3. ⌘S in Compositor and its saved preview (Accessibility and Automation permissions);
4. the preview from Compositor's last save.

When the person has a selection on a VS Code board, `view_board` draws it as marching ants and `read_board` gives its
bounding box, so "fill the selected part" means something to Claude too.

## Limits of this version

- HDR (OpenEXR) layers are kept and saved but shown as a hatched placeholder and cannot be painted on the board.
- What only a macOS app has stays with VS Code: project tabs are VS Code's editor tabs, windows, updates and the
  native menu bar are VS Code's (the board's menus sit inside it). `docs/parity/features.md` lists every Compositor
  feature and ticks what the board does.
- The selection port needs macOS 14 or later for Object selection and Select Subject (Apple Vision), as Compositor does.
- The brush has no pressure, as in Compositor itself.

Brush, shapes, blending, adjustment kernels, layer effects, Smudge and Liquify, the 16-bit display dither, CMYK
lookups and the command search follow Compositor's own algorithms; the test vectors in the port specs match exactly
(the blurs within a level or two).

## License

MIT, see [LICENSE](LICENSE). The parts ported from [Compositor](https://github.com/robbietilton/Compositor) keep its
MIT notice, which LICENSE repeats.
