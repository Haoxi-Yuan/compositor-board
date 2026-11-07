# Compositor Board

Opens a [Compositor](https://github.com/robbietilton/Compositor) project (`.comp`) as a drawing board in a VS Code
tab, with Compositor's tools, menus, panels and keyboard shortcuts: layers, folders, masks and clipping; brush,
eraser, Spot Healing, Clone Stamp, Smear, Gradient, shapes and type; selections (Marquee, Lasso, Magic Wand, Object
and Subject, Color Range); transform and free distort, crop, Image Size, Canvas Size, Trim; adjustment layers, every
filter, Camera Raw and layer effects; rulers, guides, grid, Navigator, CMYK proof, Search Commands; new canvas,
import (PSD and RAW included) and export. Interactive tools run in the webview with Compositor's own algorithms;
everything else runs in compositor-engine, built from Compositor's own source (macOS 14 or later for Object and
Subject selection). Edits save to the project within a second, so the Compositor app and Claude (through the
Compositor Board Claude Code plugin) see them live, and their changes appear on the board.

- Open: right-click a `.comp` folder › *Open Board in Editor* or *Open Board in Side Bar*, open its `manifest.json`,
  File › New Canvas…, or *Compositor Board: New Board*. The board icon in the Activity Bar shows the side bar board;
  the button next to Fit moves a board between the side bar and a tab. Narrow boards switch to a compact layout.
- Undo/redo: ⌘Z / ⇧⌘Z, including changes Claude or Compositor made.
- Photoshop habits in place of Compositor's: the Move tool cuts and drags the selected pixels when pressed inside the
  selection (⌥ copies them); Delete in the Layers list deletes the layer even while something is selected; and the
  Move tool selects several layers on the canvas, by Shift-click or, with Auto Select on or ⌘ held, by dragging a box
  from an empty spot. A click on an empty spot, or outside the canvas, selects no layer.
- Photoshop features Compositor lacks: the Pen (`P`), whose paths become layers it can reshape later; the layer lock
  (⌘/), which keeps a layer or folder from being painted, moved, restyled or deleted on the board; and outlined
  shapes (the Shape tool's Stroke and Stroke & Fill).
- Shortcuts: Compositor's, remappable in Edit › Keyboard Shortcuts…; View › Search Commands… (⌘F) finds the rest.
- Notes (`N`): pin a question or instruction to a spot for Claude. Send to Claude on a note (or ⌘Return while
  writing one) puts its thread into a running Claude Code session that has the Compositor Board plugin; the arrow
  beside it sends to another chat once. The Send to row under the notes shows the chat by its tab title, following
  the Claude chat tab in front in this window; click it to pin another chat. The line above Notes for Claude drags the notes list taller or shorter. Edit target
  says where Claude makes the change: your workspace files by default (the board is your sketch), files you choose,
  or the board itself; a note's Target… button overrides it for that note.

Settings: `compositorBoard.autosaveDelay` (ms, 0 = save with ⌘S), `compositorBoard.bridge` (let the Claude Code
plugin read the live board over 127.0.0.1), `compositorBoard.checkerboard`, `compositorBoard.canvasOnly.workbench`
(what View › Toggle Fullscreen does around the board).

HDR (OpenEXR) layers are kept and saved but shown as a placeholder.
