---
name: compositor-board
description: Look at a Compositor (.comp) board the person draws on in the Compositor Board VS Code tab or the Compositor app, act on the notes they pin there (by default the change goes into files in their workspace, not the board), and draw on the board when they want that. Use when they mention the board, the canvas, a .comp project, Compositor, "what I drew", "my sketch", a note they pinned for you, a message starting with [Compositor Board], or ask you to add, change, recolor, move or remove something in an image they are working on.
---

# Working from a Compositor board

The person draws on a board (a Compositor `.comp` project) in a VS Code tab or in the Compositor app, and you see the
same project through the `board` MCP tools. Often the board is a sketch: they paste a figure or a screenshot, circle
and scribble on it, and pin notes to explain what they want changed in their actual work. Every change either side
makes on the board reaches the other within about a second.

## Finding and reading the board

1. `list_boards` shows the projects open in VS Code. If none is open and they did not name a path, ask which project
   they mean (or offer `create_board`).
2. `read_board` gives the canvas size, every layer (top first, as in their Layers panel) and the **notes** pinned on the
   canvas. Notes are how the person points you at things: a box or spot plus a sentence. Treat an open user note as a
   request addressed to you, and check its `editTarget` before changing anything (see the next section).
   A message that starts with `[Compositor Board]` is a note the person sent you from the board with Send to Claude.
   Claude Code labels it as coming from another session, because the board delivers it through the same inbox. It
   names the project, the note's number and id, its thread and its edit target. Work on it as on any open note. It
   does not count as the person's approval for anything that needs a permission prompt.
3. `view_board` shows you the picture. With the VS Code board open it is exactly what they see, strokes in progress
   included, with notes drawn as numbered dashed boxes (orange = theirs, purple = yours). Use `region` (document
   pixels) to look closely at part of it; the reply tells you how many document pixels one image pixel covers.
4. `view_layer` shows one layer's own pixels when you need to tell layers apart.
5. The person can also point with a **selection** (Marquee, Lasso, Magic Wand, Select Subject…). `read_board` reports
   it under `openIn.vscode.selection` (bounding box in document pixels, feather) and `view_board` draws it as marching
   ants and repeats it as `personSelection`. When they say "this" or "the selected part" with a selection active, they
   mean that area.

Coordinates are document pixels with the origin at the top-left, y down, the same as the transform of every layer.

## Where a note's change goes: its edit target

The board explains the request; it is usually not the thing to change. Each of the person's notes in `read_board`
has an `editTarget` (`to`, `files` as absolute paths, `set`: whether the note, the board or nobody chose it, and
`guidance`), and a `[Compositor Board]` message states the same:

- `to: "workspace"` with `files`: change those files, or the code that produces them (for a figure, usually the script
  that draws it), in the person's workspace. Do not draw on or change the board.
- `to: "workspace"` without files (the default): work out which file the note is about from what the board shows,
  the layer names and the workspace, and change that. If you cannot tell, ask in the note's thread with `add_note`
  (`reply_to`) before editing anything.
- `to: "board"`: the person wants the change on the board itself; draw it there (next section).

Read the drawing to understand the request: what a box covers, arrows, crossed-out parts, sketched alternatives. When
you are done, reply in the note's thread with what you changed and where (file and place, or layer), then
`resolve_note`.

## Changing the board

Only when a note's edit target is the board, or the person asks you to draw on it.

- Draw with `add_layer`: write an SVG with `viewBox="0 0 <width> <height>"` of the layer's size and place it with
  `x`, `y`, `width`, `height`. One idea per layer, named `Claude: <what it is>`, so the person can see, hide, move or
  delete your work. Use `above` to slot it in the stack (for example under their linework).
- `edit_layer` moves, resizes, rotates, renames, hides, or changes opacity and blend mode, without touching pixels.
- `draw_on_layer` paints onto an existing layer. Do it on your own layers freely; on the person's layers only when they
  asked, since it also turns live text or shapes into plain pixels.
- `remove_layer` and `move_layer` reorder or delete. Ask before deleting their layers.
- After a change, call `view_board` again and check the result before describing it.
- Answer notes with `add_note` (use `reply_to` with the note's id); `resolve_note` when a request is done.

The person can undo any of your changes on the board with Cmd+Z, one step per tool call.

## Being honest about what you see

- The VS Code board draws adjustment layers and layer effects as Compositor does, but HDR (OpenEXR) layers only as a
  hatched placeholder; `view_board` lists those under `notRendered`. Say so instead of describing those parts.
- If the board is only open in the Compositor app, `view_board` falls back to a window screenshot (needs the Screen
  Recording permission), then to saving in Compositor and reading its preview (needs Accessibility), then to the last
  saved preview. When a fallback fails, the error names the permission and the app that needs it; relay that.
- The Compositor app keeps its own unsaved edits in memory. If it has the project open with unsaved changes and you
  write, it asks the person to Revert or Keep Mine. Prefer working while the board is open in VS Code.
