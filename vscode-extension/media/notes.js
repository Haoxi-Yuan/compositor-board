'use strict';
// Notes: short messages pinned to a rectangle or point of the canvas, so the person can point Claude at something and
// Claude can answer in place. They live beside the project in <name>.comp.notes.json (Compositor's own save would
// drop anything inside the package) and never touch the layers.

(function () {
    const CB = (window.CB = window.CB || {});

    const COLORS = { user: '#f97316', claude: '#8b5cf6' };

    function newID() {
        return crypto.randomUUID().toUpperCase();
    }

    function normalize(rect) {
        const x = Math.min(rect.x, rect.x + rect.width), y = Math.min(rect.y, rect.y + rect.height);
        return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
    }

    class Notes {
        // onChange(notes) persists the list; it is called after every edit made on the board.
        constructor(onChange) {
            this.list = [];
            this.onChange = onChange;
            this.showResolved = false;
            this.selectedID = null;
        }

        set(list) {
            this.list = Array.isArray(list) ? list : [];
        }

        visible() {
            return this.list.filter((n) => this.showResolved || !n.resolved);
        }

        // Numbering follows creation order, so "note 3" means the same note to the person and to Claude.
        number(note) {
            return this.list.indexOf(note) + 1;
        }

        add({ x, y, width = 0, height = 0, text, replyTo }) {
            const rect = normalize({ x, y, width, height });
            const note = {
                id: newID(), author: 'user', text: text.trim(), ...rect,
                replyTo: replyTo || undefined, resolved: false, createdAt: new Date().toISOString(),
            };
            this.list.push(note);
            this.onChange(this.list);
            return note;
        }

        update(id, changes) {
            const note = this.list.find((n) => n.id === id);
            if (!note) return;
            Object.assign(note, changes);
            this.onChange(this.list);
        }

        remove(id) {
            this.list = this.list.filter((n) => n.id !== id && n.replyTo !== id);
            if (this.selectedID === id) this.selectedID = null;
            this.onChange(this.list);
        }

        // The topmost visible note whose numbered badge or dashed outline is under a document point. The inside of a
        // box is left free, so a new note can be pinned within an older one. `ppp` is screen points per document pixel.
        hit(point, ppp) {
            const notes = this.visible().filter((n) => !n.replyTo);
            const badge = 11 / ppp, edge = 4 / ppp;
            for (let i = notes.length - 1; i >= 0; i--) {
                const n = notes[i];
                if (Math.hypot(point.x - n.x, point.y - n.y) <= badge) return n;
                const near = point.x >= n.x - edge && point.x <= n.x + n.width + edge && point.y >= n.y - edge && point.y <= n.y + n.height + edge;
                const inside = point.x > n.x + edge && point.x < n.x + n.width - edge && point.y > n.y + edge && point.y < n.y + n.height - edge;
                if (near && !inside) return n;
            }
            return null;
        }

        // Dashed boxes with numbered badges. `toScreen` maps document points to the target canvas's pixels.
        draw(ctx, toScreen, { pixelRatio = 1, draft = null } = {}) {
            const items = this.visible().filter((n) => !n.replyTo);
            if (draft) items.push({ ...normalize(draft), author: 'user', draft: true });
            ctx.save();
            ctx.font = `600 ${11 * pixelRatio}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
            ctx.textBaseline = 'middle';
            for (const n of items) {
                const color = COLORS[n.author] || COLORS.user;
                const a = toScreen({ x: n.x, y: n.y }), b = toScreen({ x: n.x + n.width, y: n.y + n.height });
                const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
                const selected = n.id && n.id === this.selectedID;
                ctx.globalAlpha = n.resolved ? 0.45 : 1;
                if (w >= 2 || h >= 2) {
                    ctx.setLineDash([6 * pixelRatio, 4 * pixelRatio]);
                    ctx.lineWidth = (selected ? 3 : 2) * pixelRatio;
                    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                    ctx.strokeRect(x, y, w, h);
                    ctx.lineDashOffset = 5 * pixelRatio;
                    ctx.strokeStyle = color;
                    ctx.strokeRect(x, y, w, h);
                    ctx.lineDashOffset = 0;
                    ctx.setLineDash([]);
                }
                if (n.draft) continue;
                const label = String(this.number(n));
                const radius = 9 * pixelRatio;
                const cx = x, cy = y;
                ctx.beginPath();
                ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.lineWidth = 1.5 * pixelRatio;
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.fillText(label, cx, cy + 0.5 * pixelRatio);
            }
            ctx.restore();
        }

        // The notes as Claude reads them, threads nested under the note they answer.
        summary() {
            return this.list.filter((n) => !n.replyTo).map((n) => ({
                number: this.number(n), id: n.id, author: n.author, text: n.text, resolved: n.resolved, target: n.target,
                rect: { x: n.x, y: n.y, width: n.width, height: n.height },
                replies: this.list.filter((r) => r.replyTo === n.id).map((r) => ({ id: r.id, author: r.author, text: r.text })),
            }));
        }
    }

    CB.Notes = Notes;
    CB.NOTE_COLORS = COLORS;
})();
