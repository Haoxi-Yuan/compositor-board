'use strict';
// Tools written as modules of their own (paint tools, crop, type) register here. While one is the current tool the
// board hands it the options bar, the status hint, keys, Tab, pointer input on the canvas, the overlay and the cursor,
// and asks it before switching tools, undoing or changing layers.
//
// CB.registerTool({
//     id,                 // the board's tool id ('gradient'); upstream NavigationTool names otherwise
//     title,              // rail tooltip and accessibility label, verbatim ("Gradient (G)")
//     key,                // KeyboardEvent.code of its single-key shortcut ('KeyG'), or null
//     icon(board),        // rail icon: a name in CB.iconPaths, following the tool's mode
//     brushTool,          // true for the brush family (size, hardness, opacity, the brush circle, [ ] keys)
//     create(board),      // the instance; every method below is optional
// });
//
// Instance methods, called only while the tool is current unless noted:
//     optionsHTML() -> the options bar body (its title first); bindOptions(el); refreshOptions(el)
//     hint() -> the status bar hint
//     activate(previous); deactivate(next) -> false refuses the switch (text that cannot finish)
//     cycle() -> Tab; true when it changed something
//     keydown(e) -> true when it used the key (Return, Escape, arrows...); escape() -> true when Escape did something
//     opacityDigit(percent) -> digit keys (1-9, 0) for tools that are not brush tools
//     down(doc, screen, e) -> true when it takes the press; it may start a stroke with view.startStroke instead of a
//         drag of its own; then move(doc, screen, e), up(doc, screen, e), cancel() for that drag
//     hover(doc, screen, e) -> pointer moves without a press
//     drawOverlay(ctx) -> CSS pixels; under the brush circle for brush tools
//     cursor() -> a CSS cursor, or null for the board's own
//     busy() -> whether its drag owns pixels (blocks wheel zoom and history); default true while it has a drag
//     interceptUndo() -> any instance, current or not: true when ⌘Z only discards something pending (a gradient)
//     resolve() -> any instance: apply what is pending (before layer switches, filters, saving); may return a Promise
//     restored() -> any instance: an undo or redo is about to restore a step; drop what is pending (a gradient line)

(function () {
    const CB = (window.CB = window.CB || {});
    const registry = new Map();
    CB.registerTool = (spec) => registry.set(spec.id, spec);
    CB.toolSpecs = registry;

    // A field that takes typing; checkboxes, sliders and buttons do not, so tool keys keep working after a click on one.
    const NOT_TYPING = new Set(['checkbox', 'radio', 'range', 'button', 'color', 'submit', 'reset']);
    CB.isTyping = (t) => Boolean(t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
        || (t.tagName === 'INPUT' && !NOT_TYPING.has(t.type))));
})();
