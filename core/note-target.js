'use strict';
// Where a note asks Claude to make its change (a board choice, not Compositor's). Notes are the person's hand-drawn
// explanations; the board is where they sketch, and what they want changed is usually a file in their workspace (a
// figure, a document, the code that draws it). A target is { to: 'workspace' | 'board', files }: the board keeps a
// default in <name>.comp.board.json (noteTarget), a note may carry its own (note.target). Files are stored relative to
// the folder holding the project, so the two move together, and handed to Claude as absolute paths.

const path = require('path');

const DEFAULT = { to: 'workspace', files: [] };

// A stored target, or null when it is missing or malformed.
function normalize(value) {
    if (!value || typeof value !== 'object' || (value.to !== 'workspace' && value.to !== 'board')) return null;
    const files = value.to === 'workspace' && Array.isArray(value.files) ? value.files.filter((f) => typeof f === 'string' && f) : [];
    return { to: value.to, files: [...new Set(files)] };
}

// The target a note follows, with absolute paths and where it was set: 'note', 'board' or 'default'.
function effective(root, note, boardTarget) {
    const own = normalize(note && note.target);
    const board = normalize(boardTarget);
    const target = own || board || DEFAULT;
    const folder = path.dirname(root);
    return { to: target.to, files: target.files.map((f) => path.resolve(folder, f)), set: own ? 'note' : board ? 'board' : 'default' };
}

// What Claude is to do with a note that has this (effective) target.
function guidance(target) {
    if (target.to === 'board') {
        return 'Edit target: this board. Make the change on the board itself (add_layer, draw_on_layer, edit_layer), as the note asks.';
    }
    const lead = 'The board is the person\'s sketch to explain the idea; do not draw on or change the board unless the note asks for that.';
    if (target.files.length) {
        return `Edit target: the person's workspace, ${target.files.length === 1 ? 'this file' : 'these files'}: ${target.files.join(', ')}. ${lead} Make the change in ${target.files.length === 1 ? 'that file' : 'those files'}, or in the code that produces ${target.files.length === 1 ? 'it' : 'them'}.`;
    }
    return `Edit target: the person's workspace (no file chosen). ${lead} Find the file the note is about (the figure, document or code behind what the board shows) and change that. If you cannot tell which file, ask in the note's thread (add_note with reply_to) before editing anything.`;
}

module.exports = { DEFAULT, normalize, effective, guidance };
