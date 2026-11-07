'use strict';
// Undo history for the board. VS Code owns the undo stack (Cmd+Z reaches the extension, which posts `undo` back),
// so every entry pushed here is announced to the extension exactly once and the two stacks stay in step.
//
// An entry holds what it changed, both ways: the manifest before and after (small JSON), and for pixels either the
// changed rectangle of a layer's image (canvases before and after, copied exactly, unlike ImageData) or a whole
// bitmap swapped for another.
// The board applies an entry with `CB.applyState`, so undo, redo and the first application share one code path.

(function () {
    const CB = (window.CB = window.CB || {});
    // DocumentHistory (Document/DocumentHistory.swift:25-31, 97-126): at most 100 steps, and 256 MiB of pixels that only
    // the history holds (images the document still shows are not counted); the oldest steps go first.
    const BUDGET_BYTES = 256 * 1024 * 1024;
    const MAX_STEPS = 100;

    const area = (canvas) => (canvas ? canvas.width * canvas.height * 4 : 0);

    function entryBytes(entry) {
        let bytes = 0;
        for (const p of entry.pixels) bytes += area(p.before) + area(p.after) + area(p.beforeBitmap) + area(p.afterBitmap);
        return bytes + (entry.metaBefore ? entry.metaBefore.length + entry.metaAfter.length : 0);
    }

    class History {
        constructor(onPush, isLive = () => false) {
            this.done = [];
            this.undone = [];
            this.bytes = 0;
            this.onPush = onPush;
            // `isLive(bitmap)`: whether the document shows this image or mask right now.
            this.isLive = isLive;
        }

        // Bytes held only by history: each bitmap once, live ones not at all.
        retainedBytes() {
            const seen = new Set();
            let bytes = 0;
            const count = (b, size) => { if (b && !seen.has(b) && !this.isLive(b)) { seen.add(b); bytes += size; } };
            for (const e of [...this.done, ...this.undone]) {
                for (const p of e.pixels) {
                    count(p.before, area(p.before)); count(p.after, area(p.after));
                    count(p.beforeBitmap, area(p.beforeBitmap)); count(p.afterBitmap, area(p.afterBitmap));
                    count(p.beforeMask, p.beforeMask ? p.beforeMask.width * p.beforeMask.height : 0);
                    count(p.afterMask, p.afterMask ? p.afterMask.width * p.afterMask.height : 0);
                }
            }
            return bytes;
        }

        trim() {
            while (this.done.length + this.undone.length > MAX_STEPS || (this.done.length + this.undone.length > 1 && this.retainedBytes() > BUDGET_BYTES)) {
                if (this.done.length) this.done.shift();
                else this.undone.shift();
            }
        }

        // `entry`: { label, metaBefore?, metaAfter? (JSON strings), pixels: [{ layerID, kind: 'image'|'mask',
        // rect, before, after (canvases of the rect) | beforeBitmap, afterBitmap (whole images, null = none)}] }.
        // The change has already been made; this only records it.
        // `silent` records a change the extension already knows about (one that came from disk).
        push(entry, { silent = false } = {}) {
            entry.pixels = entry.pixels || [];
            entry.bytes = entryBytes(entry);
            this.done.push(entry);
            this.undone = [];
            this.trim();
            if (!silent) this.onPush(entry.label);
        }

        undo() {
            const entry = this.done.pop();
            if (!entry) return null;
            this.undone.push(entry);
            CB.applyState(entry, 'before');
            this.trim();
            return entry;
        }

        redo() {
            const entry = this.undone.pop();
            if (!entry) return null;
            this.done.push(entry);
            CB.applyState(entry, 'after');
            this.trim();
            return entry;
        }
    }

    CB.History = History;
})();
